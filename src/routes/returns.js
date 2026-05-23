/**
 * returns.js — FIXED
 *
 * GET  /returns         → list SALE_RETURN + PURCHASE_RETURN vouchers
 * POST /returns/sales   → create SALE_RETURN voucher (persisted to vouchers table)
 * POST /returns/purchase→ create PURCHASE_RETURN voucher (persisted to vouchers table)
 *
 * FIXES:
 *  1. POST routes now actually INSERT into vouchers table (were only console.info before)
 *  2. GET route SELECT maps voucher fields to names the frontend expects:
 *     voucher_no → return_no, voucher_date → date, voucher_type → type,
 *     total_amount → amount, narration → description
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate }  = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')
const { adToBS, todayBS, auditLog, nextVoucherNo } = require('../utils/helpers')

router.use(authenticate)

const T   = 'inventory_batches'
const QTY = 'qty_remaining'

/* ── GET /returns ──────────────────────────────────────────────────────────── */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const { type } = req.query

    const typeFilter = type === 'sales'
      ? ['SALE_RETURN']
      : type === 'purchase'
        ? ['PURCHASE_RETURN']
        : ['SALE_RETURN', 'PURCHASE_RETURN']

    const [{ count }] = await db('vouchers as v')
      .where('v.company_id', req.companyId)
      .whereIn('v.voucher_type', typeFilter)
      .count('v.id as count')

    const data = await db('vouchers as v')
      .leftJoin('parties as p', 'v.party_id', 'p.id')
      .where('v.company_id', req.companyId)
      .whereIn('v.voucher_type', typeFilter)
      .select(
        'v.id',
        'v.voucher_no   as return_no',         // frontend reads return_no
        'v.voucher_date as date',               // frontend reads date
        'v.voucher_type as type',               // frontend reads type
        'v.narration    as description',
        'v.reference_no as original_invoice_no',// frontend reads original_invoice_no
        'v.total_amount as amount',             // frontend reads amount
        'v.status',
        'p.name         as party_name',
      )
      .orderBy('v.voucher_date', 'desc')
      .limit(limit)
      .offset(offset)

    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── POST /returns/sales ───────────────────────────────────────────────────── */
router.post('/sales', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const { sale_id, party_id, items, narration, date_ad } = req.body
    if (!items?.length) {
      await trx.rollback()
      return res.status(400).json({ success: false, message: 'Items required' })
    }

    const date    = date_ad || new Date().toISOString().split('T')[0]
    const date_bs = adToBS(date) || todayBS()

    // Find the original sale for reference_no
    let originalInvoiceNo = null
    if (sale_id) {
      const sale = await trx('sales').where({ id: sale_id, company_id: req.companyId }).first()
      originalInvoiceNo = sale?.invoice_no || null
    }

    let total = 0
    for (const item of items) {
      const qty  = Number(item.qty)  || 0
      const rate = Number(item.rate) || 0
      if (qty <= 0) continue
      total += qty * rate

      // Return stock back to inventory
      if (item.product_id) {
        await trx(T).insert({
          company_id:    req.companyId,
          product_id:    item.product_id,
          batch_no:      item.batch_no || 'RETURN',
          expiry:        item.expiry   || null,
          expiry_date:   null,
          receipt_date:  date,
          qty_received:  qty,
          qty_remaining: qty,
          unit_cost:     rate,
          total_cost:    Math.round(qty * rate * 100) / 100,
        })
      }
    }
    total = Math.round(total * 100) / 100

    // Generate return voucher number
    const voucher_no = await nextVoucherNo(req.companyId, 'sale_return')

    // Persist to vouchers table
    const [voucher] = await trx('vouchers').insert({
      company_id:    req.companyId,
      created_by:    req.user.id,
      voucher_no,
      voucher_type:  'SALE_RETURN',
      voucher_date:  date,
      party_id:      party_id || null,
      reference_no:  originalInvoiceNo,
      narration:     narration || 'Sales Return',
      total_amount:  total,
      status:        'POSTED',
    }).returning('*')

    await trx.commit()
    auditLog(req.companyId, req.user.id, 'SALE_RETURN', 'vouchers', voucher.id,
      { voucher_no, total, original: originalInvoiceNo }, req.ip)

    return successResponse(res, {
      ...voucher,
      return_no:           voucher.voucher_no,
      original_invoice_no: originalInvoiceNo,
      amount:              total,
    }, 'Sales return recorded', 201)
  } catch (err) {
    await trx.rollback()
    next(err)
  }
})

/* ── POST /returns/purchase ────────────────────────────────────────────────── */
router.post('/purchase', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const { purchase_id, party_id, items, narration, date_ad } = req.body
    if (!items?.length) {
      await trx.rollback()
      return res.status(400).json({ success: false, message: 'Items required' })
    }

    const date    = date_ad || new Date().toISOString().split('T')[0]
    const date_bs = adToBS(date) || todayBS()

    let originalBillNo = null
    if (purchase_id) {
      const purchase = await trx('purchases').where({ id: purchase_id, company_id: req.companyId }).first()
      originalBillNo = purchase?.bill_no || null
    }

    let total = 0
    for (const item of items) {
      const qty  = Number(item.qty)  || 0
      const rate = Number(item.rate) || 0
      if (qty <= 0) continue
      total += qty * rate

      // Deduct returned stock from inventory
      if (item.product_id) {
        const batch = await trx(T)
          .where({ product_id: item.product_id, company_id: req.companyId })
          .where(QTY, '>', 0)
          .orderBy('created_at', 'desc')
          .first()
        if (batch) {
          await trx(T).where({ id: batch.id }).update({
            [QTY]: Math.max(0, Number(batch[QTY]) - qty),
          })
        }
      }
    }
    total = Math.round(total * 100) / 100

    const voucher_no = await nextVoucherNo(req.companyId, 'purchase_return')

    const [voucher] = await trx('vouchers').insert({
      company_id:    req.companyId,
      created_by:    req.user.id,
      voucher_no,
      voucher_type:  'PURCHASE_RETURN',
      voucher_date:  date,
      party_id:      party_id || null,
      reference_no:  originalBillNo,
      narration:     narration || 'Purchase Return',
      total_amount:  total,
      status:        'POSTED',
    }).returning('*')

    await trx.commit()
    auditLog(req.companyId, req.user.id, 'PURCHASE_RETURN', 'vouchers', voucher.id,
      { voucher_no, total, original: originalBillNo }, req.ip)

    return successResponse(res, {
      ...voucher,
      return_no:           voucher.voucher_no,
      original_invoice_no: originalBillNo,
      amount:              total,
    }, 'Purchase return recorded', 201)
  } catch (err) {
    await trx.rollback()
    next(err)
  }
})

module.exports = router
