/**
 * helpers.js — FIXED
 *
 * BUG 1 (line 103): auditLog() inserted wrong column names:
 *   resource, resource_id, changes
 *   → CORRECT: entity_type, entity_id, payload_after  (migration 001 schema)
 *
 * BUG 2 (line 73): nextVoucherNo() queried ghost table 'accounting_entries'
 *   → CORRECT: db('vouchers')  (the real table)
 */
const db = require('../db/knex')

// ─── BS date tables ───────────────────────────────────────────────────────────
const BS_YEAR_START_AD = {
  2078: '2021-04-14', 2079: '2022-04-14', 2080: '2023-04-14',
  2081: '2024-07-16', 2082: '2025-04-14', 2083: '2026-04-14',
  2084: '2027-04-14', 2085: '2028-04-13',
}
const BS_DAYS = {
  2078: [31,31,32,32,31,30,30,29,30,30,29,31],
  2079: [31,31,32,31,31,30,30,30,30,29,30,31],
  2080: [31,32,31,32,31,30,30,30,29,30,29,31],
  2081: [31,31,32,32,31,30,30,30,29,29,30,31],
  2082: [31,31,32,31,31,30,30,30,29,30,29,31],
  2083: [31,32,31,31,32,30,30,30,29,29,30,31],
}

function adToBS(dateStr) {
  try {
    const ad = new Date(dateStr)
    let bsYear = 2081
    for (const [y, startStr] of Object.entries(BS_YEAR_START_AD).sort((a,b) => Number(b[0])-Number(a[0]))) {
      if (ad >= new Date(startStr)) { bsYear = Number(y); break }
    }
    const yearStart = new Date(BS_YEAR_START_AD[bsYear] || '2024-07-16')
    let daysDiff = Math.floor((ad - yearStart) / 86400000)
    const days = BS_DAYS[bsYear] || [31,31,32,32,31,30,30,30,29,29,30,31]
    let bsMonth = 1
    for (const d of days) {
      if (daysDiff < d) break
      daysDiff -= d; bsMonth++
    }
    return `${bsYear}-${String(bsMonth).padStart(2,'0')}-${String(daysDiff+1).padStart(2,'0')}`
  } catch { return null }
}

function todayBS() { return adToBS(new Date().toISOString().split('T')[0]) }

// ─── Sequence generators ──────────────────────────────────────────────────────
async function nextInvoiceNo(companyId, prefix = 'INV') {
  const bs   = todayBS() || '2081-04-01'
  const year = bs.split('-')[0]
  const row  = await db('sales').where({ company_id: companyId }).whereLike('invoice_no', `${prefix}-${year}-%`).orderBy('invoice_no', 'desc').first()
  const last = row ? parseInt(row.invoice_no.split('-').pop()) || 0 : 0
  return `${prefix}-${year}-${String(last + 1).padStart(3, '0')}`
}

async function nextBillNo(companyId) {
  const year = (todayBS() || '2081-04-01').split('-')[0]
  const row  = await db('purchases').where({ company_id: companyId }).whereLike('bill_no', `PUR-${year}-%`).orderBy('bill_no', 'desc').first()
  const last = row ? parseInt(row.bill_no.split('-').pop()) || 0 : 0
  return `PUR-${year}-${String(last + 1).padStart(3, '0')}`
}

// FIX BUG 2 (line 73): was db('accounting_entries') — table does not exist.
// Correct table is 'vouchers'.
async function nextVoucherNo(companyId, type) {
  const map  = { receipt:'REC', payment:'PAY', journal:'JV', contra:'CON' }
  const pfx  = map[type] || 'VCH'
  const year = (todayBS() || '2081-04-01').split('-')[0]
  const row  = await db('vouchers')                         // FIXED: was 'accounting_entries'
    .where({ company_id: companyId })
    .whereLike('voucher_no', `${pfx}-${year}-%`)
    .orderBy('voucher_no', 'desc')
    .first()
  const last = row ? parseInt((row.voucher_no || '').split('-').pop()) || 0 : 0
  return `${pfx}-${year}-${String(last + 1).padStart(3, '0')}`
}

async function nextPartyCode(companyId, type) {
  const prefix = type === 'customer' ? 'CUS' : 'SUP'
  const row = await db('parties').where({ company_id: companyId, type }).orderBy('code', 'desc').first()
  const last = row?.code ? parseInt(row.code.split('-').pop()) || 0 : 0
  return `${prefix}-${String(last + 1).padStart(3, '0')}`
}

async function nextItemCode(companyId) {
  const row = await db('products').where({ company_id: companyId }).orderBy('item_code', 'desc').first()
  const last = row?.item_code ? parseInt(row.item_code.split('-').pop()) || 0 : 0
  return `MED-${String(last + 1).padStart(3, '0')}`
}

// ─── Audit logger — FIXED column names ───────────────────────────────────────
// FIX BUG 1 (line 103): columns 'resource', 'resource_id', 'changes' do not exist.
// Correct column names per migration 001:
//   entity_type  (was: resource)
//   entity_id    (was: resource_id)
//   payload_after(was: changes)
// entity_id must be a UUID or null — never an empty string (UUID column constraint).
// Entire function is try/catch — NEVER crashes parent request.
async function auditLog(companyId, userId, action, entityType, entityId, payloadAfter, ip) {
  try {
    const safeEntityId = entityId && /^[0-9a-f-]{36}$/i.test(String(entityId)) ? entityId : null
    await db('audit_log').insert({
      company_id:    companyId   || null,
      user_id:       userId      || null,
      action:        action      || 'UNKNOWN',
      entity_type:   entityType  || null,              // FIXED: was resource
      entity_id:     safeEntityId,                     // FIXED: was resource_id
      payload_after: payloadAfter                      // FIXED: was changes
        ? JSON.stringify(payloadAfter) : null,
      ip_address:    ip || null,
      is_suspicious: false,
    })
  } catch (err) {
    console.error('[AUDIT] Non-fatal write failure:', err.message, { action, entityType, entityId })
  }
}

module.exports = { adToBS, todayBS, nextInvoiceNo, nextBillNo, nextVoucherNo, nextPartyCode, nextItemCode, auditLog }
