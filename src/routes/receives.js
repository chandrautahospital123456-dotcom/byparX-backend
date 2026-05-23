/**
 * receives.js — FIXED
 *
 * Original line → bug → fix:
 *
 * L46: trx('stock_batches').insert({
 *   company_id, product_id, batch_no, expiry,
 *   qty_in: Number(item.qty),
 *   qty_out: 0,
 *   qty_available: Number(item.qty),
 *   purchase_rate: Number(item.rate) || 0,
 *   date_ad: date
 * })
 * → trx('inventory_batches').insert({
 *     company_id, product_id, batch_no, expiry, expiry_date,
 *     receipt_date, qty_received, qty_remaining, unit_cost, total_cost
 *   })
 *
 * Columns that do NOT exist in inventory_batches:
 *   qty_in, qty_out, qty_available, purchase_rate, date_ad
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate }  = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')
const { adToBS, todayBS, auditLog } = require('../utils/helpers')

router.use(authenticate)

const T   = 'inventory_batches'
const QTY = 'qty_remaining'

/* ── GET /receives ─────────────────────────────────────────────────────────── */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const [{ count }] = await db('receives').where({ company_id: req.companyId }).count('id as count')
    const data = await db('receives').where({ company_id: req.companyId }).orderBy('created_at', 'desc').limit(limit).offset(offset)
    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── GET /receives/:id ─────────────────────────────────────────────────────── */
router.get('/:id', async (req, res, next) => {
  try {
    const receive = await db('receives').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!receive) return res.status(404).json({ success: false, message: 'Receive not found' })
    const items = await db('receive_items').where({ receive_id: receive.id })
    return successResponse(res, { ...receive, items })
  } catch (err) { next(err) }
})

/* ── POST /receives ────────────────────────────────────────────────────────── */
router.post('/', async (req, res, next) => {
  const trx = await db.transaction()
  try {
    const { date_ad, notes, items } = req.body
    if (!items?.length) { await trx.rollback(); return res.status(400).json({ success: false, message: 'At least one item required' }) }

    const date    = date_ad || new Date().toISOString().split('T')[0]
    const date_bs = adToBS(date) || todayBS()
    const cntRow  = await trx('receives').where({ company_id: req.companyId }).count('id as c').first()
    const receive_no = `RCV-${(todayBS() || '2081').split('-')[0]}-${String(Number(cntRow?.c || 0) + 1).padStart(3, '0')}`

    const [receive] = await trx('receives').insert({
      company_id: req.companyId, created_by: req.user.id,
      receive_no, date_ad: date, date_bs, notes: notes || null,
    }).returning('*')

    for (const item of items) {
      const qty  = Number(item.qty)  || 0
      const rate = Number(item.rate) || 0
      if (qty <= 0) continue

      await trx('receive_items').insert({
        receive_id: receive.id, product_id: item.product_id || null,
        product_name: item.product_name || '', batch_no: item.batch_no || null,
        expiry: item.expiry || null, qty, rate,
      })

      // L46 FIX: was trx('stock_batches').insert({
      //   qty_in: Number(item.qty),
      //   qty_out: 0,
      //   qty_available: Number(item.qty),
      //   purchase_rate: Number(item.rate) || 0,
      //   date_ad: date                         ← column name (wrong)
      // })
      // Correct columns from migration 002:
      //   qty_received, qty_remaining, unit_cost, total_cost, receipt_date
      if (item.product_id) {
        await trx(T).insert({
          company_id:    req.companyId,
          product_id:    item.product_id,
          batch_no:      item.batch_no || 'ADJ',
          expiry:        item.expiry   || null,
          expiry_date:   parseExpiryToDate(item.expiry),
          receipt_date:  date,                              // FIX: was date_ad (column key)
          qty_received:  qty,                               // FIX: was qty_in
          qty_remaining: qty,                               // FIX: was qty_available
          // qty_out: 0 — column does not exist, removed
          unit_cost:     rate,                              // FIX: was purchase_rate
          total_cost:    Math.round(qty * rate * 100) / 100,
        })
      }
    }

    await trx.commit()
    auditLog(req.companyId, req.user.id, 'CREATE', 'receives', receive.id, { receive_no }, req.ip)
    return successResponse(res, receive, 'Receive recorded', 201)
  } catch (err) { await trx.rollback(); next(err) }
})

/* ── DELETE /receives/:id ──────────────────────────────────────────────────── */
router.delete('/:id', async (req, res, next) => {
  try {
    const receive = await db('receives').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!receive) return res.status(404).json({ success: false, message: 'Receive not found' })
    await db('receive_items').where({ receive_id: req.params.id }).del()
    await db('receives').where({ id: req.params.id }).del()
    return successResponse(res, null, 'Receive deleted')
  } catch (err) { next(err) }
})

function parseExpiryToDate(expiry) {
  if (!expiry) return null
  try {
    const [mm, yy] = String(expiry).split('/')
    if (!mm || !yy) return null
    const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy)
    const month = Number(mm)
    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) return null
    return `${year}-${String(month).padStart(2,'0')}-${String(new Date(year, month, 0).getDate()).padStart(2,'0')}`
  } catch { return null }
}

module.exports = router
