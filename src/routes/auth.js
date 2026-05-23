/**
 * auth.js — Unified authentication route
 * Merges pharma ERP signup fields (company_address, pan_no, etc.)
 * with accounting engine's CoA seeding + permissions setup
 */
const router  = require('express').Router()
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const { v4: uuid } = require('uuid')
const db      = require('../db/knex')
const AuditLogger  = require('../utils/auditLogger')
const { authenticate } = require('../middleware/index')

class AppError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status }
}

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' })
}
function signRefresh(userId) {
  return jwt.sign({ userId, type: 'refresh' }, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET, { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' })
}

/* ── POST /auth/register ─────────────────────────────────────────────────── */
router.post('/register', async (req, res, next) => {
  try {
    const {
      name, email, password, phone,
      company_name, company_address, company_phone,
      pan_no, registration_no, date_system, invoice_prefix, currency,
    } = req.body

    if (!name?.trim())         throw new AppError('Name is required', 400)
    if (!email?.trim())        throw new AppError('Email is required', 400)
    if (!password)             throw new AppError('Password is required', 400)
    if (password.length < 8)  throw new AppError('Password must be at least 8 characters', 400)
    if (!company_name?.trim()) throw new AppError('Company name is required', 400)

    const existing = await db('users').where({ email: email.toLowerCase().trim() }).first()
    if (existing) throw new AppError('An account with this email already exists', 409)

    const password_hash = await bcrypt.hash(password, 12)

    await db.transaction(async trx => {
      // Create company
      const companyId = uuid()
      await trx('companies').insert({
        id:             companyId,
        name:           company_name.trim(),
        address:        company_address?.trim() || null,
        phone:          company_phone?.trim()   || null,
        pan_no:         pan_no?.trim()          || null,
        registration_no: registration_no?.trim() || null,
        date_system:    date_system || 'BS',
        invoice_prefix: (invoice_prefix || 'INV').toUpperCase().slice(0, 6),
        currency:       currency || 'NPR',
        vat_percent:    13,
      })

      // Seed default chart of accounts
      const accountIds = await seedDefaultAccounts(trx, companyId)

      // Seed default accounting period
      const year = new Date().getFullYear()
      await trx('accounting_periods').insert({
        id:         uuid(),
        company_id: companyId,
        name:       `FY ${year}`,
        start_date: `${year}-01-01`,
        end_date:   `${year}-12-31`,
      })

      // Seed default invoice template
      await trx('invoice_templates').insert({
        id:         uuid(),
        company_id: companyId,
        name:       'Default A4',
        config:     JSON.stringify({ _name:'Default A4', layout:'a4', show_logo:true, accent:'#2563eb', font_size:12 }),
        is_default: true,
      })

      // Create owner user
      const userId = uuid()
      await trx('users').insert({
        id:                   userId,
        company_id:           companyId,
        name:                 name.trim(),
        email:                email.toLowerCase().trim(),
        password_hash,
        phone:                phone?.trim() || null,
        role:                 'owner',
        can_post_vouchers:    true,
        can_approve_vouchers: true,
        can_lock_periods:     true,
        can_reverse_entries:  true,
        is_active:            true,
      })

      const user    = await trx('users').where({ id: userId }).first()
      const company = await trx('companies').where({ id: companyId }).first()
      const token   = signToken({ userId, email: user.email, role: user.role, companyId })
      const refresh_token = signRefresh(userId)
      const { password_hash: _, ...safeUser } = user

      return res.status(201).json({ success: true, message: 'Account created', data: { token, refresh_token, user: safeUser, company } })
    })
  } catch (err) { next(err) }
})

/* ── POST /auth/login ────────────────────────────────────────────────────── */
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body
    if (!email || !password) throw new AppError('Email and password required', 400)

    const user = await db('users').where({ email: email.toLowerCase().trim() }).first()
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      throw new AppError('Invalid email or password', 401)
    }
    if (!user.is_active) throw new AppError('Account is disabled', 403)

    await db('users').where({ id: user.id }).update({ last_login_at: new Date() })
    const company = await db('companies').where({ id: user.company_id }).first()
    const token   = signToken({ userId: user.id, email: user.email, role: user.role, companyId: user.company_id })
    const refresh_token = signRefresh(user.id)
    const { password_hash: _, ...safeUser } = user

    await AuditLogger.log(db, { companyId: user.company_id, userId: user.id, action: 'LOGIN', entityType: 'auth', entityId: user.id, ipAddress: req.ip })
    return res.json({ success: true, data: { token, refresh_token, user: safeUser, company } })
  } catch (err) { next(err) }
})

/* ── POST /auth/logout ───────────────────────────────────────────────────── */
router.post('/logout', authenticate, async (req, res) => {
  await AuditLogger.log(db, { companyId: req.companyId, userId: req.user.id, action: 'LOGOUT', entityType: 'auth', entityId: req.user.id, ipAddress: req.ip })
  return res.json({ success: true, message: 'Logged out' })
})

/* ── GET /auth/me ────────────────────────────────────────────────────────── */
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user    = await db('users').where({ id: req.user.id }).first()
    const company = await db('companies').where({ id: req.companyId }).first()
    if (!user) throw new AppError('User not found', 404)
    const { password_hash: _, ...safeUser } = user
    return res.json({ success: true, data: { user: safeUser, company } })
  } catch (err) { next(err) }
})

/* ── POST /auth/refresh ──────────────────────────────────────────────────── */
router.post('/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body
    if (!refresh_token) throw new AppError('Refresh token required', 400)
    const payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET)
    if (payload.type !== 'refresh') throw new AppError('Invalid refresh token', 401)
    const user = await db('users').where({ id: payload.userId }).first()
    if (!user || !user.is_active) throw new AppError('User not found or disabled', 401)
    const token = signToken({ userId: user.id, email: user.email, role: user.role, companyId: user.company_id })
    return res.json({ success: true, data: { token } })
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' })
    }
    next(err)
  }
})

/* ── PUT /auth/change-password ───────────────────────────────────────────── */
router.put('/change-password', authenticate, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body
    if (!current_password || !new_password) throw new AppError('Both passwords required', 400)
    if (new_password.length < 8) throw new AppError('New password must be at least 8 characters', 400)
    const user  = await db('users').where({ id: req.user.id }).first()
    const valid = await bcrypt.compare(current_password, user.password_hash)
    if (!valid) throw new AppError('Current password is incorrect', 400)
    await db('users').where({ id: req.user.id }).update({ password_hash: await bcrypt.hash(new_password, 12) })
    await AuditLogger.log(db, { companyId: req.companyId, userId: req.user.id, action: 'CHANGE_PASSWORD', entityType: 'auth', entityId: req.user.id, ipAddress: req.ip })
    return res.json({ success: true, message: 'Password changed successfully' })
  } catch (err) { next(err) }
})

/* ── Default Chart of Accounts seeder ───────────────────────────────────── */
async function seedDefaultAccounts(trx, companyId) {
  const ids = {}
  const accounts = [
    { key:'G_ASSET',   code:'1000', name:'Current Assets',       type:'asset',     sub_type:null,          normal_balance:'debit',  is_group:true,  is_system:true  },
    { key:'CASH',      code:'1001', name:'Cash in Hand',          type:'asset',     sub_type:'cash',        normal_balance:'debit',  is_group:false, is_system:true  },
    { key:'BANK',      code:'1002', name:'Bank Account',          type:'asset',     sub_type:'bank',        normal_balance:'debit',  is_group:false, is_system:true  },
    { key:'AR',        code:'1100', name:'Accounts Receivable',   type:'asset',     sub_type:'receivable',  normal_balance:'debit',  is_group:false, is_system:true  },
    { key:'INVENTORY', code:'1200', name:'Inventory / Stock',     type:'asset',     sub_type:'inventory',   normal_balance:'debit',  is_group:false, is_system:true  },
    { key:'TAX_IN',    code:'1300', name:'VAT Input (Receivable)',type:'asset',     sub_type:'tax_input',   normal_balance:'debit',  is_group:false, is_system:true  },
    { key:'G_LIAB',    code:'2000', name:'Current Liabilities',   type:'liability', sub_type:null,          normal_balance:'credit', is_group:true,  is_system:true  },
    { key:'AP',        code:'2001', name:'Accounts Payable',      type:'liability', sub_type:'payable',     normal_balance:'credit', is_group:false, is_system:true  },
    { key:'TAX_OUT',   code:'2100', name:'VAT Output (Payable)',  type:'liability', sub_type:'tax_payable', normal_balance:'credit', is_group:false, is_system:true  },
    { key:'G_EQUITY',  code:'3000', name:"Owner's Equity",        type:'equity',    sub_type:null,          normal_balance:'credit', is_group:true,  is_system:true  },
    { key:'CAPITAL',   code:'3001', name:'Capital Account',       type:'equity',    sub_type:'capital',     normal_balance:'credit', is_group:false, is_system:true  },
    { key:'RETAINED',  code:'3100', name:'Retained Earnings',     type:'equity',    sub_type:'retained',    normal_balance:'credit', is_group:false, is_system:true  },
    { key:'G_INCOME',  code:'4000', name:'Revenue',               type:'income',    sub_type:null,          normal_balance:'credit', is_group:true,  is_system:true  },
    { key:'SALES',     code:'4001', name:'Sales Revenue',         type:'income',    sub_type:'sales',       normal_balance:'credit', is_group:false, is_system:true  },
    { key:'OTHER_INC', code:'4100', name:'Other Income',          type:'income',    sub_type:'other',       normal_balance:'credit', is_group:false, is_system:false },
    { key:'G_EXP',     code:'5000', name:'Operating Expenses',    type:'expense',   sub_type:'operating',   normal_balance:'debit',  is_group:true,  is_system:true  },
    { key:'COGS',      code:'5001', name:'Cost of Goods Sold',    type:'expense',   sub_type:'cogs',        normal_balance:'debit',  is_group:false, is_system:true  },
    { key:'PURCHASE',  code:'5100', name:'Purchase Expense',      type:'expense',   sub_type:'purchase',    normal_balance:'debit',  is_group:false, is_system:true  },
    { key:'SALARY',    code:'5101', name:'Salary Expense',        type:'expense',   sub_type:'operating',   normal_balance:'debit',  is_group:false, is_system:false },
    { key:'RENT',      code:'5102', name:'Rent Expense',          type:'expense',   sub_type:'operating',   normal_balance:'debit',  is_group:false, is_system:false },
    { key:'UTILITY',   code:'5103', name:'Utility Expense',       type:'expense',   sub_type:'operating',   normal_balance:'debit',  is_group:false, is_system:false },
  ]
  for (const { key, ...acc } of accounts) {
    const id = uuid()
    ids[key] = id
    await trx('accounts').insert({ id, company_id: companyId, is_active: true, ...acc })
  }
  // Wire parent_id
  const parentMap = {
    CASH:'G_ASSET', BANK:'G_ASSET', AR:'G_ASSET', INVENTORY:'G_ASSET', TAX_IN:'G_ASSET',
    AP:'G_LIAB', TAX_OUT:'G_LIAB',
    CAPITAL:'G_EQUITY', RETAINED:'G_EQUITY',
    SALES:'G_INCOME', OTHER_INC:'G_INCOME',
    COGS:'G_EXP', PURCHASE:'G_EXP', SALARY:'G_EXP', RENT:'G_EXP', UTILITY:'G_EXP',
  }
  for (const [child, parent] of Object.entries(parentMap)) {
    if (ids[child] && ids[parent]) await trx('accounts').where({ id: ids[child] }).update({ parent_id: ids[parent] })
  }
  return ids
}

module.exports = router
module.exports.seedDefaultAccounts = seedDefaultAccounts
