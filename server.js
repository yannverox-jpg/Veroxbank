/**
 * server.js — Lyra Banque (Node 20 ready)
 * - Interface web (Login -> Panel)
 * - Login via ADMIN_USER / ADMIN_PASS (env)
 * - Sessions (SESSION_SECRET)
 * - Wallet local (1 quadrillion) = source of truth
 * - Retraits via PSP (Airtel 74 / Moov 62 / singpay payouts)
 * - Keep-alive ping 13 minutes
 *
 * IMPORTANT: set secrets in Render Env (see instructions)
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

/* ----------- Config / env ----------- */
const SESSION_SECRET = process.env.SESSION_SECRET || 'CHANGE_THIS_SECRET';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'change_me';
const GATEWAY_BASE = process.env.GATEWAY_BASE || 'https://gateway.singpay.ga/v1';
const WALLET_ID = process.env.WALLET_ID || '';
const MERCHANT_AIRTEL = process.env.MERCHANT_AIRTEL || '';
const MERCHANT_MOOV = process.env.MERCHANT_MOOV || '';
const ENABLE_WITHDRAWAL = (process.env.ENABLE_WITHDRAWAL || 'true') === 'true';
const APP_NAME = process.env.APP_NAME || 'Lyra Banque';
const WALLET_CURRENCY = process.env.WALLET_CURRENCY || 'XAF';

/* ----------- Middlewares ----------- */
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
  }
}));

// static files
app.use(express.static(path.join(__dirname, 'public')));

/* ----------- Wallet (local source of truth) ----------- */
let walletBalance = 1_000_000_000_000_000; // 1 quadrillion
const MAX_HISTORY = 200;
function pushHistory(req, entry) {
  if (!req.session) return;
  if (!req.session.history) req.session.history = [];
  req.session.history.unshift(entry);
  if (req.session.history.length > MAX_HISTORY) req.session.history.pop();
}

/* ----------- Helpers ----------- */
function buildHeaders() {
  const h = { 'Content-Type': 'application/json', 'X-App-Name': APP_NAME };
  if (WALLET_ID) h['Authorization'] = `Bearer ${WALLET_ID}`;
  if (MERCHANT_MOOV) h['X-Merchant-Moov'] = MERCHANT_MOOV;
  if (MERCHANT_AIRTEL) h['X-Merchant-Airtel'] = MERCHANT_AIRTEL;
  return h;
}
function normalizePhone(phone) {
  if (!phone) return null;
  return String(phone).trim().replace(/\s+/g, '');
}
async function callPSP(pathSuffix, payload, timeout = 30000) {
  const url = `${GATEWAY_BASE.replace(/\/$/, '')}/${pathSuffix.replace(/^\//,'')}`;
  try {
    const resp = await axios.post(url, payload, { headers: buildHeaders(), timeout });
    return { ok: true, status: resp.status, data: resp.data };
  } catch (err) {
    return { ok: false, status: err.response ? err.response.status : 500, data: err.response ? err.response.data : { message: err.message } };
  }
}

/* ----------- Keep-alive (13 minutes) ----------- */
setInterval(() => {
  console.log('🟢 Keep-alive ping at', new Date().toISOString());
}, 13 * 60 * 1000);

/* ----------- Auth routes & middleware ----------- */
// GET / -> show login page by default
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// POST /login -> checks ADMIN_USER / ADMIN_PASS, sets session
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.authenticated = true;
    return res.redirect('/panel.html');
  }
  // stay on login with simple message (client handles)
  return res.status(401).send('Invalid credentials');
});

// logout
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// middleware protect
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  // if request expects JSON, return 401 json
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, message: 'unauthorized' });
  return res.redirect('/');
}

/* ----------- Protected panel route (static file) ----------- */
app.get('/panel.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'panel.html'));
});

/* ----------- APIs ----------- */

// GET /api/balance
app.get('/api/balance', requireAuth, (req, res) => {
  return res.json({ balance: walletBalance, currency: WALLET_CURRENCY });
});

// POST /api/retrait/:operator  (operator: 74, 62, singpay)
app.post('/api/retrait/:operator', requireAuth, async (req, res) => {
  if (!ENABLE_WITHDRAWAL) return res.status(403).json({ message: 'withdrawals disabled' });
  try {
    const { operator } = req.params;
    const { amount, phone } = req.body;
    const p = normalizePhone(phone);
    if (!amount || !p) return res.status(400).json({ message: 'amount and phone required' });
    const numeric = Number(amount);
    if (isNaN(numeric) || numeric <= 0) return res.status(400).json({ message: 'invalid amount' });
    if (numeric > walletBalance) return res.status(400).json({ message: 'insufficient balance' });

    // debit local wallet immediately (source of truth)
    walletBalance -= numeric;
    const localTx = `LYRA-${operator}-${Date.now()}`;

    // prepare payload depending on operator
    let pathSuffix;
    let payload;
    if (operator === '74' || operator === '62') {
      // USSD style endpoints used previously
      pathSuffix = `${operator}/paiement`;
      payload = {
        amount: numeric,
        currency: WALLET_CURRENCY,
        phone: p,
        wallet_id: WALLET_ID || undefined,
        merchant: operator === '74' ? MERCHANT_AIRTEL : MERCHANT_MOOV,
        reference: localTx,
        note: `${APP_NAME} - USSD ${operator}`
      };
    } else if (operator === 'singpay') {
      pathSuffix = 'payouts';
      payload = {
        amount: numeric,
        currency: WALLET_CURRENCY,
        wallet_id: WALLET_ID || undefined,
        merchant_reference: localTx,
        destination: { phone: p },
        note: `${APP_NAME} - payout`
      };
    } else {
      // unsupported
      walletBalance += numeric; // rollback
      return res.status(400).json({ message: 'unsupported operator' });
    }

    console.log('→ calling PSP', pathSuffix, payload);
    const result = await callPSP(pathSuffix, payload);

    if (!result.ok) {
      // rollback
      walletBalance += numeric;
      pushHistory(req, { tx: localTx, amount: numeric, operator, status: 'error', details: result.data, date: new Date().toISOString() });
      console.error('PSP error', result);
      return res.status(result.status || 500).json({ message: 'psp error', details: result.data });
    }

    // success
    pushHistory(req, { tx: localTx, amount: numeric, operator, status: 'success', psp: result.data, date: new Date().toISOString() });
    return res.json({ message: 'withdrawal initiated', psp: result.data, balance: walletBalance });

  } catch (err) {
    console.error('withdraw internal error', err);
    return res.status(500).json({ message: 'internal error', error: err.message });
  }
});

// GET /api/history
app.get('/api/history', requireAuth, (req, res) => {
  res.json(req.session.history || []);
});

// Status & test
app.get('/api/status', (req, res) => res.json({ app: APP_NAME, withdrawals_enabled: ENABLE_WITHDRAWAL, gateway: GATEWAY_BASE, local_balance: walletBalance }));
app.get('/api/test', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

/* ----------- Start server ----------- */
app.listen(PORT, () => console.log(`Lyra Banque server running on port ${PORT}`));
