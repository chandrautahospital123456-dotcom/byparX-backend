require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

// ── Route modules ────────────────────────────────────────────────────────
const authRouter       = require('./routes/auth');
const productsRouter   = require('./routes/products');
const partiesRouter    = require('./routes/parties');
const salesRouter      = require('./routes/sales');
const purchasesRouter   = require('./routes/purchases');
const accountingRouter  = require('./routes/accounting');
const reportsRouter    = require('./routes/reports');
const settingsRouter   = require('./routes/settings');
const receivesRouter   = require('./routes/receives');
const stockRouter      = require('./routes/stock');
const returnsRouter    = require('./routes/returns');

const { errorHandler } = require('./middleware/index');
const db = require('./db/knex');

const app = express();
const PORT = process.env.PORT || 5000;

/* ── Security & logging ─────────────────────────────────────────────────── */
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(
  morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev')
);

/* ── CORS ───────────────────────────────────────────────────────────────── */
app.use(
  cors({
    origin: (process.env.CORS_ORIGIN || 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

/* ── Body parsing ───────────────────────────────────────────────────────── */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/* ── Static uploads ─────────────────────────────────────────────────────── */
app.use(
  '/uploads',
  express.static(path.join(__dirname, '..', 'uploads'))
);

/* ── Health check (safe DB check) ───────────────────────────────────────── */
app.get('/health', async (req, res) => {
  try {
    await db.raw('SELECT 1');

    res.json({
      status: 'ok',
      db: 'connected',
      version: '2.0.0',
      env: process.env.NODE_ENV,
      time: new Date().toISOString(),
      name: 'MediERP Unified Backend',
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      db: 'disconnected',
      error: err.message,
    });
  }
});

/* ── API Routes ─────────────────────────────────────────────────────────── */
const API = '/api/v1';

// Auth
app.use(`${API}/auth`, authRouter);

// ERP modules
app.use(`${API}/products`, productsRouter);
app.use(`${API}/parties`, partiesRouter);
app.use(`${API}/sales`, salesRouter);
app.use(`${API}/purchases`, purchasesRouter);
app.use(`${API}/receives`, receivesRouter);
app.use(`${API}/stock`, stockRouter);
app.use(`${API}/returns`, returnsRouter);
app.use(`${API}/settings`, settingsRouter);

// Accounting
app.use(`${API}/accounting`, accountingRouter);

// Reports
app.use(`${API}/reports`, reportsRouter);

/* ── Date utilities ─────────────────────────────────────────────────────── */
app.get(`${API}/date/today`, (req, res) => {
  const { todayBS } = require('./utils/helpers');
  const today = new Date().toISOString().split('T')[0];

  res.json({
    success: true,
    data: {
      ad: today,
      bs: todayBS(),
    },
  });
});

app.get(`${API}/date/ad-to-bs`, (req, res) => {
  const { adToBS } = require('./utils/helpers');
  const { date } = req.query;

  if (!date) {
    return res.status(400).json({
      success: false,
      message: 'date query param required',
    });
  }

  res.json({
    success: true,
    data: {
      ad: date,
      bs: adToBS(date),
    },
  });
});

/* ── 404 handler ─────────────────────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

/* ── Global error handler ────────────────────────────────────────────────── */
app.use(errorHandler);

/* ── START SERVER (FIXED - NO CRASH) ─────────────────────────────────────── */
async function start() {
  try {
    await db.raw('SELECT 1');
    console.log('✅ PostgreSQL connected');
  } catch (err) {
    console.error('❌ PostgreSQL connection failed:', err.message);
    console.log('⚠️ Server will still start without DB connection');
  }

  app.listen(PORT, () => {
    console.log(`\n🏦 MediERP Unified Backend v2.0`);
    console.log(`   API:    http://localhost:${PORT}/api/v1`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   Env:    ${process.env.NODE_ENV || 'development'}\n`);
  });
}

start();

module.exports = app;