/**
 * products.js — FIXED
 *
 * Exact original line numbers and fixes:
 *
 * L26:  db('stock_batches')                     → db('inventory_batches')
 * L27:  .sum('qty_available as total_stock')    → .sum('qty_remaining as total_stock')
 * L49:  db('stock_batches')...where('qty_available', '>', 0)
 *       → db('inventory_batches')...where('qty_remaining', '>', 0)
 * L50:  b.qty_available                         → b.qty_remaining (+ alias for frontend)
 * L58:  db('stock_batches')                     → db('inventory_batches')
 * L61:  b.qty_available                         → b.qty_remaining (+ alias)
 * L125: db('stock_batches').where(...).del()    → db('inventory_batches').where(...).del()
 * L138-142: db('stock_batches').insert({
 *             qty_in, qty_out:0, qty_available, purchase_rate, date_ad
 *           })
 *       → db('inventory_batches').insert({
 *             qty_received, qty_remaining, unit_cost, total_cost, receipt_date
 *           })
 */
const router = require('express').Router()
const db     = require('../db/knex')
const { authenticate } = require('../middleware/index')
const { parsePagination, paginatedResponse, successResponse } = require('../middleware/helpers')
const { nextItemCode, auditLog } = require('../utils/helpers')

router.use(authenticate)

const T   = 'inventory_batches'   // real table — migration 002
const QTY = 'qty_remaining'       // real column — migration 002

/* ── GET /products ─────────────────────────────────────────────────────────── */
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query)
    const { search, category, is_active } = req.query

    let q = db('products').where({ company_id: req.companyId })
    if (search)    q = q.where(b => b.whereILike('name', `%${search}%`).orWhereILike('item_code', `%${search}%`).orWhereILike('generic_name', `%${search}%`).orWhereILike('company_name', `%${search}%`))
    if (category)  q = q.where({ category })
    if (is_active !== undefined) q = q.where({ is_active: is_active === 'true' })

    const [{ count }] = await q.clone().count('id as count')
    const data = await q.orderBy('name').limit(limit).offset(offset)

    // L26-27 FIX: stock_batches → inventory_batches, qty_available → qty_remaining
    const ids = data.map(p => p.id)
    const stocks = ids.length
      ? await db(T)
          .whereIn('product_id', ids)
          .where({ company_id: req.companyId })
          .groupBy('product_id')
          .select('product_id')
          .sum(`${QTY} as total_stock`)
      : []

    const stockMap = Object.fromEntries(stocks.map(s => [s.product_id, Number(s.total_stock)]))
    const enriched = data.map(p => ({
      ...p,
      current_stock: stockMap[p.id] || 0,
      low_stock:    (stockMap[p.id] || 0) < (p.min_stock || 0),
    }))
    return paginatedResponse(res, { data: enriched, total: Number(count), page, limit })
  } catch (err) { next(err) }
})

/* ── GET /products/categories ──────────────────────────────────────────────── */
router.get('/categories', async (req, res, next) => {
  try {
    const rows = await db('products').where({ company_id: req.companyId }).whereNotNull('category').distinct('category').orderBy('category')
    return successResponse(res, rows.map(r => r.category))
  } catch (err) { next(err) }
})

/* ── GET /products/:id ─────────────────────────────────────────────────────── */
router.get('/:id', async (req, res, next) => {
  try {
    const product = await db('products').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' })

    // L49-50 FIX: stock_batches → inventory_batches, qty_available → qty_remaining
    const batches = await db(T)
      .where({ product_id: product.id, company_id: req.companyId })
      .where(QTY, '>', 0)
      .orderBy('expiry_date', 'asc')
      .select('*', db.raw(`${QTY} AS qty_available`))  // alias for frontend compat

    const current_stock = batches.reduce((s, b) => s + Number(b[QTY]), 0)
    return successResponse(res, { ...product, current_stock, low_stock: current_stock < (product.min_stock || 0), batches })
  } catch (err) { next(err) }
})

/* ── GET /products/:id/stock ───────────────────────────────────────────────── */
router.get('/:id/stock', async (req, res, next) => {
  try {
    // L58+L61 FIX: stock_batches → inventory_batches, b.qty_available → b.qty_remaining
    const batches = await db(T)
      .where({ product_id: req.params.id, company_id: req.companyId })
      .orderBy('expiry_date', 'asc')
      .select('*', db.raw(`${QTY} AS qty_available`))  // alias for frontend compat

    const total_stock = batches.reduce((s, b) => s + Number(b[QTY]), 0)
    return successResponse(res, { batches, total_stock })
  } catch (err) { next(err) }
})

/* ── POST /products ────────────────────────────────────────────────────────── */
router.post('/', async (req, res, next) => {
  try {
    const { name, generic_name, company_name, category, unit, purchase_rate, sales_rate, mrp, cc_percent, min_stock } = req.body
    if (!name?.trim()) return res.status(400).json({ success: false, message: 'Product name is required' })
    if (sales_rate == null || isNaN(Number(sales_rate))) return res.status(400).json({ success: false, message: 'Sales rate is required' })

    const item_code = await nextItemCode(req.companyId)
    const [product] = await db('products').insert({
      company_id: req.companyId, item_code,
      name: name.trim(), generic_name: generic_name?.trim() || null,
      company_name: company_name?.trim() || null, category: category?.trim() || null,
      unit: unit || 'Strip', purchase_rate: Number(purchase_rate) || 0,
      sales_rate: Number(sales_rate), mrp: Number(mrp) || 0,
      cc_percent: Math.min(100, Math.max(0, Number(cc_percent) || 0)),
      min_stock: Number(min_stock) || 50, is_active: true,
    }).returning('*')

    await auditLog(req.companyId, req.user.id, 'CREATE', 'products', product.id, { name }, req.ip)
    return successResponse(res, product, 'Product created', 201)
  } catch (err) { next(err) }
})

/* ── PUT /products/:id ─────────────────────────────────────────────────────── */
router.put('/:id', async (req, res, next) => {
  try {
    const existing = await db('products').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!existing) return res.status(404).json({ success: false, message: 'Product not found' })

    const allowed = ['name','generic_name','company_name','category','unit','purchase_rate','sales_rate','mrp','cc_percent','min_stock','is_active']
    const updates = {}
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        updates[k] = ['purchase_rate','sales_rate','mrp','min_stock'].includes(k) ? Number(req.body[k])
          : k === 'cc_percent' ? Math.min(100, Math.max(0, Number(req.body[k]) || 0))
          : req.body[k]
      }
    }
    const [updated] = await db('products').where({ id: req.params.id }).update({ ...updates, updated_at: new Date() }).returning('*')
    await auditLog(req.companyId, req.user.id, 'UPDATE', 'products', req.params.id, updates, req.ip)
    return successResponse(res, updated)
  } catch (err) { next(err) }
})

/* ── DELETE /products/:id ──────────────────────────────────────────────────── */
router.delete('/:id', async (req, res, next) => {
  try {
    const product = await db('products').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' })

    const [{ count }] = await db('sale_items').where({ product_id: req.params.id }).count('id as count')
    if (Number(count) > 0) return res.status(400).json({ success: false, message: `Cannot delete — ${count} sale transaction(s) exist. Deactivate instead.` })

    // L125 FIX: was db('stock_batches').del()
    await db(T).where({ product_id: req.params.id }).del()
    await db('products').where({ id: req.params.id }).del()

    await auditLog(req.companyId, req.user.id, 'DELETE', 'products', req.params.id, { name: product.name }, req.ip)
    return successResponse(res, null, 'Product deleted')
  } catch (err) { next(err) }
})

/* ── POST /products/:id/adjust ─────────────────────────────────────────────── */
router.post('/:id/adjust', async (req, res, next) => {
  try {
    const { qty, batch_no, expiry, purchase_rate, reason } = req.body
    if (!qty || isNaN(Number(qty))) return res.status(400).json({ success: false, message: 'Quantity is required' })

    const product = await db('products').where({ id: req.params.id, company_id: req.companyId }).first()
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' })

    const qtyNum  = Number(qty)
    const rateNum = Number(purchase_rate) || Number(product.purchase_rate) || 0

    // L138-142 FIX: was db('stock_batches').insert({
    //   qty_in, qty_out:0, qty_available, purchase_rate, date_ad
    // })
    // Columns that exist in inventory_batches (migration 002):
    //   qty_received, qty_remaining, unit_cost, total_cost, receipt_date
    await db(T).insert({
      company_id:    req.companyId,
      product_id:    req.params.id,
      batch_no:      batch_no || 'ADJ',
      expiry:        expiry   || null,
      expiry_date:   parseExpiryToDate(expiry),
      receipt_date:  new Date().toISOString().split('T')[0],  // FIX: was date_ad (column)
      qty_received:  Math.abs(qtyNum),                        // FIX: was qty_in
      qty_remaining: Math.abs(qtyNum),                        // FIX: was qty_available
      // qty_out — column does not exist, removed
      unit_cost:     rateNum,                                 // FIX: was purchase_rate
      total_cost:    Math.round(Math.abs(qtyNum) * rateNum * 100) / 100,
    })

    await auditLog(req.companyId, req.user.id, 'ADJUST_STOCK', 'products', req.params.id, { qty, reason }, req.ip)
    return successResponse(res, null, 'Stock adjusted')
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
