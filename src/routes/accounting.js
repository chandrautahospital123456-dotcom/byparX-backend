/**
 * accounting.js — Bank-grade double-entry accounting routes
 * Vouchers, ledger, reports, periods, audit, integrity
 */
const router = require('express').Router()
const db     = require('../db/knex')
const PostingEngine   = require('../engines/postingEngine')
const VoucherService  = require('../services/voucherService')
const ReportingEngine = require('../engines/reportingEngine')
const { verifyJournalChain } = require('../utils/hashing')
const AuditLogger     = require('../utils/auditLogger')
const { authenticate, requireRole, requirePermission, ok, paginated } = require('../middleware/index')
const { AppError } = require('../engines/postingEngine')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')

router.use(authenticate)

// ═══════════════════════════════════════════════════════════════════════════
// VOUCHERS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/vouchers', async (req, res, next) => {
  try {
    const { page=1, limit=20, voucher_type, status, party_id, date_from, date_to, search } = req.query
    const result = await VoucherService.list(req.companyId, {
      page: Number(page), limit: Number(limit),
      voucherType: voucher_type, status, partyId: party_id,
      dateFrom: date_from, dateTo: date_to, search,
    })
    return paginated(res, result)
  } catch (err) { next(err) }
})

router.post('/vouchers', requirePermission('post_vouchers'), async (req, res, next) => {
  try {
    const { voucher_type, voucher_date, party_id, period_id, lines, narration, reference_no, notes, metadata, currency, due_date } = req.body
    if (!voucher_type) throw new AppError('voucher_type is required', 400)
    if (!voucher_date) throw new AppError('voucher_date is required', 400)
    const result = await VoucherService.create({
      companyId: req.companyId, userId: req.user.id,
      voucherType: voucher_type, voucherDate: voucher_date,
      partyId: party_id, periodId: period_id, lines, narration,
      referenceNo: reference_no, notes, metadata, currency, dueDate: due_date,
    }, req.ip)
    return ok(res, result, 'Voucher created', 201)
  } catch (err) { next(err) }
})

router.get('/vouchers/:id', async (req, res, next) => {
  try {
    const result = await VoucherService.get(req.params.id, req.companyId)
    return ok(res, result)
  } catch (err) { next(err) }
})

router.post('/vouchers/:id/post', requirePermission('post_vouchers'), async (req, res, next) => {
  try {
    const result = await PostingEngine.post(req.params.id, req.user.id, req.ip)
    if (result.alreadyPosted) return ok(res, result, 'Already posted (idempotent)')
    return ok(res, result, 'Voucher posted successfully')
  } catch (err) { next(err) }
})

router.post('/vouchers/:id/reverse', requirePermission('reverse_entries'), async (req, res, next) => {
  try {
    const { reason } = req.body
    if (!reason?.trim()) throw new AppError('Reversal reason is required', 400)
    const result = await PostingEngine.reverse(req.params.id, req.user.id, reason, req.ip)
    return ok(res, result, 'Voucher reversed successfully')
  } catch (err) { next(err) }
})

router.post('/vouchers/:id/cancel', async (req, res, next) => {
  try {
    const { reason } = req.body
    if (!reason?.trim()) throw new AppError('Cancellation reason is required', 400)
    const result = await VoucherService.cancel(req.params.id, req.user.id, reason, req.ip)
    return ok(res, result, 'Voucher cancelled')
  } catch (err) { next(err) }
})

// ═══════════════════════════════════════════════════════════════════════════
// CHART OF ACCOUNTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/accounts', async (req, res, next) => {
  try {
    const { type, sub_type, is_group, search } = req.query
    let q = db('accounts').where({ company_id: req.companyId, is_active: true })
    if (type)     q = q.where('type', type)
    if (sub_type) q = q.where('sub_type', sub_type)
    if (is_group !== undefined) q = q.where('is_group', is_group === 'true')
    if (search)   q = q.where(b => b.whereILike('name', `%${search}%`).orWhereILike('code', `%${search}%`))
    const data = await q.orderBy('code')
    return ok(res, data)
  } catch (err) { next(err) }
})

router.post('/accounts', requireRole('owner','admin','accountant'), async (req, res, next) => {
  try {
    const { code, name, type, sub_type, normal_balance, parent_id, is_group, description } = req.body
    if (!code || !name || !type) throw new AppError('code, name, type are required', 400)
    const exists = await db('accounts').where({ company_id: req.companyId, code }).first()
    if (exists) throw new AppError(`Account code ${code} already exists`, 409)
    const [account] = await db('accounts').insert({
      company_id:     req.companyId, code, name, type,
      sub_type:       sub_type || null,
      normal_balance: normal_balance || (['asset','expense'].includes(type) ? 'debit' : 'credit'),
      parent_id:      parent_id || null,
      is_group:       !!is_group,
      description:    description || null,
      is_system:      false, is_active: true,
    }).returning('*')
    await AuditLogger.log(db, { companyId: req.companyId, userId: req.user.id, action: 'CREATE_ACCOUNT', entityType: 'account', entityId: account.id, payloadAfter: { code, name, type }, ipAddress: req.ip })
    return ok(res, account, 'Account created', 201)
  } catch (err) { next(err) }
})

router.put('/accounts/:id', requireRole('owner','admin','accountant'), async (req, res, next) => {
  try {
    const account = await db('accounts').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!account)          throw new AppError('Account not found', 404)
    if (account.is_system) throw new AppError('System accounts cannot be modified', 400)
    const allowed = ['name','sub_type','description','is_active']
    const updates = {}
    for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k] }
    const [updated] = await db('accounts').where({ id: req.params.id }).update({ ...updates, updated_at: new Date() }).returning('*')
    return ok(res, updated)
  } catch (err) { next(err) }
})

// ═══════════════════════════════════════════════════════════════════════════
// LEDGER & REPORTS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/ledger/:account_id', async (req, res, next) => {
  try {
    const { date_from, date_to, page, limit } = req.query
    const result = await ReportingEngine.ledger(req.params.account_id, req.companyId, {
      dateFrom: date_from, dateTo: date_to, page: Number(page||1), limit: Number(limit||100),
    })
    return ok(res, result)
  } catch (err) { next(err) }
})

router.get('/reports/trial-balance', async (req, res, next) => {
  try {
    const result = await ReportingEngine.trialBalance(req.companyId, {
      asOfDate: req.query.as_of_date, dateFrom: req.query.date_from, periodId: req.query.period_id,
    })
    return ok(res, result)
  } catch (err) { next(err) }
})

router.get('/reports/pnl', async (req, res, next) => {
  try {
    const result = await ReportingEngine.profitAndLoss(req.companyId, {
      dateFrom: req.query.date_from, dateTo: req.query.date_to,
      compareFrom: req.query.compare_from, compareTo: req.query.compare_to,
    })
    return ok(res, result)
  } catch (err) { next(err) }
})

router.get('/reports/balance-sheet', async (req, res, next) => {
  try {
    const result = await ReportingEngine.balanceSheet(req.companyId, { asOfDate: req.query.as_of_date })
    return ok(res, result)
  } catch (err) { next(err) }
})

router.get('/reports/cash-flow', async (req, res, next) => {
  try {
    const result = await ReportingEngine.cashFlow(req.companyId, { dateFrom: req.query.date_from, dateTo: req.query.date_to })
    return ok(res, result)
  } catch (err) { next(err) }
})

// ═══════════════════════════════════════════════════════════════════════════
// ACCOUNTING ENTRIES (receipts/payments/journal for simple use)
// ═══════════════════════════════════════════════════════════════════════════

router.get('/entries', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const { type } = req.query
    let q = db('journal_entries as je').where('je.company_id', req.companyId)
    if (type) {
      const vouchers = await db('vouchers').where({ company_id: req.companyId, voucher_type: type.toUpperCase() }).select('id')
      q = q.whereIn('je.voucher_id', vouchers.map(v => v.id))
    }
    const [{ count }] = await q.clone().count('je.id as count')
    const data = await q.orderBy('je.entry_date','desc').limit(limit).offset(offset)
    return paginatedResponse(res, { data, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

// Convenience: create + immediately post a simple payment/receipt
router.post('/create-payment', requirePermission('post_vouchers'), async (req, res, next) => {
  try {
    const { party_id, amount, account_id, payment_mode, reference_no, narration, date_ad } = req.body
    if (!amount || Number(amount) <= 0) throw new AppError('Valid amount required', 400)
    if (!account_id) throw new AppError('account_id required', 400)

    // Get payable account for party
    const party = await db('parties').where({ id: party_id, company_id: req.companyId }).first()
    const payableAccount = party?.control_account_id ||
      (await db('accounts').where({ company_id: req.companyId, sub_type: 'payable' }).first())?.id

    const date = date_ad || new Date().toISOString().split('T')[0]
    const created = await VoucherService.create({
      companyId: req.companyId, userId: req.user.id,
      voucherType: 'PAYMENT', voucherDate: date, partyId: party_id,
      narration: narration || `Payment - ${reference_no || ''}`,
      lines: [
        { account_id: payableAccount, debit: Number(amount), credit: 0, description: narration, party_id },
        { account_id, debit: 0, credit: Number(amount), description: `Payment via ${payment_mode||'bank'}` },
      ],
    }, req.ip)

    const posted = await PostingEngine.post(created.voucher.id, req.user.id, req.ip)
    return ok(res, { voucher: created.voucher, journal_entry: posted.journal_entry }, 'Payment recorded', 201)
  } catch (err) { next(err) }
})

// ═══════════════════════════════════════════════════════════════════════════
// ACCOUNTING PERIODS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/periods', async (req, res, next) => {
  try {
    const data = await db('accounting_periods').where({ company_id: req.companyId }).orderBy('start_date','desc')
    return ok(res, data)
  } catch (err) { next(err) }
})

router.post('/periods', requirePermission('lock_periods'), async (req, res, next) => {
  try {
    const { name, start_date, end_date } = req.body
    if (!name || !start_date || !end_date) throw new AppError('name, start_date, end_date required', 400)
    const [period] = await db('accounting_periods').insert({ company_id: req.companyId, name, start_date, end_date }).returning('*')
    return ok(res, period, 'Period created', 201)
  } catch (err) { next(err) }
})

router.post('/periods/:id/lock', requirePermission('lock_periods'), async (req, res, next) => {
  try {
    const period = await db('accounting_periods').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!period)         throw new AppError('Period not found', 404)
    if (period.is_locked) throw new AppError('Period already locked', 409)
    const [updated] = await db('accounting_periods').where({ id: req.params.id }).update({ is_locked: true, locked_by: req.user.id, locked_at: new Date() }).returning('*')
    await AuditLogger.log(db, { companyId: req.companyId, userId: req.user.id, action: 'LOCK_PERIOD', entityType: 'period', entityId: req.params.id, payloadAfter: { name: period.name }, ipAddress: req.ip })
    return ok(res, updated, 'Period locked')
  } catch (err) { next(err) }
})

router.post('/periods/:id/unlock', requireRole('owner'), async (req, res, next) => {
  try {
    const [updated] = await db('accounting_periods').where({ id: req.params.id, company_id: req.companyId }).update({ is_locked: false, locked_by: null, locked_at: null }).returning('*')
    await AuditLogger.log(db, { companyId: req.companyId, userId: req.user.id, action: 'UNLOCK_PERIOD', entityType: 'period', entityId: req.params.id, ipAddress: req.ip })
    return ok(res, updated, 'Period unlocked')
  } catch (err) { next(err) }
})

// ═══════════════════════════════════════════════════════════════════════════
// AUDIT & INTEGRITY
// ═══════════════════════════════════════════════════════════════════════════

router.get('/audit', requireRole('owner','admin','auditor'), async (req, res, next) => {
  try {
    const { action, entity_type, entity_id, user_id, limit=100, offset=0 } = req.query
    const data = await AuditLogger.query(db, req.companyId, { action, entityType: entity_type, entityId: entity_id, userId: user_id, limit: Number(limit), offset: Number(offset) })
    return ok(res, data)
  } catch (err) { next(err) }
})

router.get('/integrity/verify', requireRole('owner','auditor'), async (req, res, next) => {
  try {
    const result = await verifyJournalChain(db, req.companyId)
    return ok(res, result, result.valid ? 'Ledger integrity verified' : 'INTEGRITY VIOLATION DETECTED')
  } catch (err) { next(err) }
})


// ═══════════════════════════════════════════════════════════════════════════
// RECEIPTS — GET /accounting/receipts  POST /accounting/receipts
// PAYMENTS — GET /accounting/payments  POST /accounting/payments
//
// These are convenience wrappers over the vouchers table.
// Frontend calls /accounting/receipts and /accounting/payments directly.
// Both map to vouchers WHERE voucher_type = 'RECEIPT' / 'PAYMENT'.
// No separate 'receipts' or 'payments' table exists in the schema.
// ═══════════════════════════════════════════════════════════════════════════

function voucherTypeRouter(voucherType) {
  return {
    list: async (req, res, next) => {
      try {
        const { page, limit, offset } = parsePagination(req.query)
        const { party_id, date_from, date_to, status } = req.query

        let q = db('vouchers as v')
          .leftJoin('parties as p', 'v.party_id', 'p.id')
          .where('v.company_id', req.companyId)
          .where('v.voucher_type', voucherType)
          .select(
            'v.id', 'v.voucher_no', 'v.voucher_type', 'v.voucher_date',
            'v.narration', 'v.total_amount',
            'v.status', 'v.created_at',
            'p.name as party_name',
          )

        if (party_id)  q = q.where('v.party_id', party_id)
        if (status)    q = q.where('v.status', status.toUpperCase())
        if (date_from) q = q.where('v.voucher_date', '>=', date_from)
        if (date_to)   q = q.where('v.voucher_date', '<=', date_to)

        const [{ count }] = await db('vouchers')
          .where({ company_id: req.companyId, voucher_type: voucherType })
          .count('id as count')

        const data = await q.orderBy('v.voucher_date', 'desc').limit(limit).offset(offset)
        return paginatedResponse(res, { data, total: Number(count), page, limit })
      } catch (err) { next(err) }
    },

    create: async (req, res, next) => {
      try {
        const { party_id, date, amount, account_id, narration, payment_mode } = req.body
        if (!amount || Number(amount) <= 0) throw new AppError('Valid amount required', 400)
        if (!account_id)                    throw new AppError('account_id is required', 400)

        const date_ad = date || new Date().toISOString().split('T')[0]

        // Get the control account for the party (AR for receipts, AP for payments)
        const subType  = voucherType === 'RECEIPT' ? 'receivable' : 'payable'
        const ctrlAcct = party_id
          ? (await db('parties').where({ id: party_id, company_id: req.companyId }).first())?.control_account_id
          : null
        const contraAcct = ctrlAcct ||
          (await db('accounts').where({ company_id: req.companyId, sub_type: subType }).first())?.id

        if (!contraAcct) throw new AppError(`No ${subType} account configured`, 400)

        // Double-entry lines:
        //   RECEIPT:  Dr Cash/Bank account  |  Cr AR (receivable)
        //   PAYMENT:  Dr AP (payable)        |  Cr Cash/Bank account
        const lines = voucherType === 'RECEIPT'
          ? [
              { account_id,    debit: Number(amount), credit: 0,             description: narration },
              { account_id: contraAcct, debit: 0, credit: Number(amount),    description: narration, party_id },
            ]
          : [
              { account_id: contraAcct, debit: Number(amount), credit: 0,    description: narration, party_id },
              { account_id,    debit: 0,             credit: Number(amount), description: narration },
            ]

        const created = await VoucherService.create({
          companyId:   req.companyId,
          userId:      req.user.id,
          voucherType,
          voucherDate: date_ad,
          partyId:     party_id  || null,
          narration:   narration || `${voucherType === 'RECEIPT' ? 'Receipt' : 'Payment'}`,
          referenceNo: payment_mode || null,
          lines,
        }, req.ip)

        const posted = await PostingEngine.post(created.voucher.id, req.user.id, req.ip)
        return ok(res, { ...created.voucher, journal_entry: posted.journal_entry },
          `${voucherType === 'RECEIPT' ? 'Receipt' : 'Payment'} recorded`, 201)
      } catch (err) { next(err) }
    },
  }
}

const receiptHandler = voucherTypeRouter('RECEIPT')
const paymentHandler = voucherTypeRouter('PAYMENT')

router.get('/receipts',  receiptHandler.list)
router.post('/receipts', requirePermission('post_vouchers'), receiptHandler.create)

router.get('/payments',  paymentHandler.list)
router.post('/payments', requirePermission('post_vouchers'), paymentHandler.create)

module.exports = router
