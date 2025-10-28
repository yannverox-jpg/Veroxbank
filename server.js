/**
 * server.js — Lyra Banque (production-ready base)
 * - Wallet interne (1 quadrillion) : source de vérité locale
 * - Singpay used as PSP (bridge) for Airtel/Moov payouts
 * - Double auth: Lordverox10 -> Roseeden7
 * - Sessions secure (read secret from /run/secrets or env)
 * - Keep-alive ping every 13 minutes
 * - Minimal session-local history
 *
 * Requirements on Render:
 * - set SESSION_SECRET env or create /run/secrets/session_secret.txt
 * - set GATEWAY_BASE (ex: https://gateway.singpay.ga/v1) or use default
 * - set PSP_AUTH (if applicable) or WALLET_ID used as Bearer token (per your PSP)
 * - set WALLET_ID (if used as bearer / wallet identifier)
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------ Helper: read secret file or env ------------------ */
function readSecretFileSafe(filename) {
  try {
    const secretPath = path.join('/run/secrets', filename);
    if (fs.existsSync(secretPath)) {
      return fs.readFileSync(secretPath, 'utf8').trim();
    }
  } catch (e) {
    console.error('Error reading secret file', filename, e.message);
  }
  // fallback to env
  const key = filename.replace(/\.[^.]+$/, '').toUpperCase(); // session_secret.txt -> SESSION_SECRET
  if (process.env[key]) return process.env[key].trim();
  if (process.env[filename.toUpperCase()]) return process.env[filename.toUpperCase()].trim();
  return null;
}

/* ------------------ Config / Secrets ------------------ */
const SESSION_SECRET = readSecretFileSafe('session_secret.txt') || process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET missing. Create session_secret.txt or set SESSION_SECRET env var.');
  process.exit(1);
}

const GATEWAY_BASE = process.env.GATEWAY_BASE || 'https://gateway.singpay.ga/v1';
const WALLET_ID = readSecretFileSafe('wallet_id.txt') || process.env.WALLET_ID || '';
// Some PSPs require merchant id header
const MERCHANT_ID = readSecretFileSafe('merchant_id.txt') || process.env.MERCHANT_ID || '';
const APP_NAME = process.env.APP_NAME || 'Lyra Banque';
const ENABLE_WITHDRAWAL = (process.env.ENABLE_WITHDRAWAL || 'true') === 'true';

/* ------------------ App & middleware ------------------ */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
  }
}));

// serve static public
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------ Wallet internal (source of truth) ------------------ */
/* NOTE: in-memory representation — for single-user personal usage this is fine.
   If you later want persistence, replace this with DB or file store. */
let walletBalance = 1_000_000_000_000_000; // 1 quadrillion
const WALLET_CURRENCY = process.env.WALLET_CURRENCY || 'EUR'; // display currency

/* ------------------ Session-local minimal history ------------------ */
const MAX_HISTORY_PER_SESSION = 200;
function pushHistory(req, entry) {
  if (!req.session) return;
  if (!req.session.history) req.session.history = [];
  req.session.history.unshift(entry);
  if (req.session.history.length > MAX_HISTORY_PER_SESSION) req.session.history.pop();
}

/* ------------------ Utility functions ------------------ */
function buildHeaders() {
  // If PSP expects Bearer token = WALLET_ID (as in your code), use it.
  const headers = { 'Content-Type': 'application/json' };
  if (WALLET_ID) headers['Authorization'] = `Bearer ${WALLET_ID}`;
  if (MERCHANT_ID) headers['X-Merchant-Id'] = MERCHANT_ID;
  headers['X-App-Name'] = APP_NAME;
  return headers;
}

function normalizePhone(phone) {
  if (!phone) return null;
  return String(phone).trim().replace(/\s+/g, '');
}

/* ------------------ Keep-alive ping (13 minutes) ------------------ */
setInterval(() => {
  console.log('🟢 Keep-alive ping at', new Date().toISOString());
  // no external call necessary — simple log keeps process active for many free hosts
}, 13 * 60 * 1000);

/* ------------------ Auth: double-step ------------------ */
/* We'll expose simple forms/pages in public/ for login2.html and panel.html.
   API routes are protected via session.authenticated. */
app.post('/login', (req, res) => {
  const { pass1 } = req.body;
  if (pass1 === (process.env.PASSWORD1 || 'Lordverox10')) {
    req.session.step1 = true;
    return res.json({ ok: true, next: '/login2.html' });
  }
  return res.status(401).json({ ok: false, message: 'wrong password' });
});

app.post('/login2', (req, res) => {
  const { pass2 } = req.body;
  if (req.session.step1 && pass2 === (process.env.PASSWORD2 || 'Roseeden7')) {
    req.session.authenticated = true;
    delete req.session.step1;
    return res.json({ ok: true, next: '/panel.html' });
  }
  return res.status(401).json({ ok: false, message: 'wrong password' });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

/* Middleware protecting API and panel routes */
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ ok: false, message: 'unauthorized' });
}

/* ------------------ API: balance (reads local wallet) ------------------ */
app.get('/api/balance', requireAuth, (req, res) => {
  // Return controlled representation, not raw internal object
  res.json({ balance: walletBalance, currency: WALLET_CURRENCY });
});

/* ------------------ Helper: call PSP endpoints (Singpay) ------------------ */
async function callPSP(endpointPath, payload, timeoutMs = 30000) {
  const url = `${GATEWAY_BASE.replace(/\/$/, '')}/${endpointPath.replace(/^\//, '')}`;
  const headers = buildHeaders();
  try {
    const resp = await axios.post(url, payload, { headers, timeout: timeoutMs });
    return { ok: true, status: resp.status, data: resp.data };
  } catch (err) {
    const status = err.response ? err.response.status : 500;
    const data = err.response ? err.response.data : { message: err.message };
    return { ok: false, status, data };
  }
}

/* ------------------ Routes: USSD and payout wrappers ------------------ */

/* Airtel USSD /api/retrait/74 */
app.post('/api/retrait/74', requireAuth, async (req, res) => {
  if (!ENABLE_WITHDRAWAL) return res.status(403).json({ message: 'withdrawals disabled' });
  try {
    const { amount, phone } = req.body;
    const p = normalizePhone(phone);
    if (!amount || !p) return res.status(400).json({ message: 'amount and phone required' });
    const numeric = Number(amount);
    if (isNaN(numeric) || numeric <= 0) return res.status(400).json({ message: 'invalid amount' });
    if (numeric > walletBalance) return res.status(400).json({ message: 'insufficient balance' });

    // debit immediately (source of truth)
    walletBalance -= numeric;
    const localTx = `LYRA-ATM-74-${Date.now()}`;

    // build payload similar to previous code
    const payload = {
      amount: numeric,
      currency: 'XAF',
      phone: p,
      merchant: MERCHANT_ID || undefined,
      wallet_id: WALLET_ID || undefined,
      reference: `lyra_ussd_${Date.now()}`,
      note: `${APP_NAME} - USSD 74`
    };

    console.log('→ Calling PSP USSD 74 with', payload);
    const result = await callPSP('74/paiement', payload);

    if (!result.ok) {
      // rollback
      walletBalance += numeric;
      pushHistory(req, { tx: localTx, amount: numeric, operator: 'Airtel', status: 'error', details: result.data });
      console.error('PSP USSD 74 error', result);
      return res.status(result.status || 500).json({ message: 'psp ussd error', details: result.data });
    }

    // success
    pushHistory(req, { tx: localTx, amount: numeric, operator: 'Airtel', status: 'success', psp: result.data, date: new Date().toISOString() });
    // try to refresh wallet balance via PSP (optional): here we keep local wallet as source of truth
    return res.json({ message: 'ussd launched', psp: result.data, balance: walletBalance });
  } catch (err) {
    console.error('retrait 74 internal error', err);
    return res.status(500).json({ message: 'internal error', error: err.message });
  }
});

/* Moov USSD /api/retrait/62 */
app.post('/api/retrait/62', requireAuth, async (req, res) => {
  if (!ENABLE_WITHDRAWAL) return res.status(403).json({ message: 'withdrawals disabled' });
  try {
    const { amount, phone } = req.body;
    const p = normalizePhone(phone);
    if (!amount || !p) return res.status(400).json({ message: 'amount and phone required' });
    const numeric = Number(amount);
    if (isNaN(numeric) || numeric <= 0) return res.status(400).json({ message: 'invalid amount' });
    if (numeric > walletBalance) return res.status(400).json({ message: 'insufficient balance' });

    walletBalance -= numeric;
    const localTx = `LYRA-ATM-62-${Date.now()}`;

    const payload = {
      amount: numeric,
      currency: 'XAF',
      phone: p,
      merchant: MERCHANT_ID || undefined,
      wallet_id: WALLET_ID || undefined,
      reference: `lyra_ussd_${Date.now()}`,
      note: `${APP_NAME} - USSD 62`
    };

    console.log('→ Calling PSP USSD 62 with', payload);
    const result = await callPSP('62/paiement', payload);

    if (!result.ok) {
      walletBalance += numeric;
      pushHistory(req, { tx: localTx, amount: numeric, operator: 'Moov', status: 'error', details: result.data });
      console.error('PSP USSD 62 error', result);
      return res.status(result.status || 500).json({ message: 'psp ussd error', details: result.data });
    }

    pushHistory(req, { tx: localTx, amount: numeric, operator: 'Moov', status: 'success', psp: result.data, date: new Date().toISOString() });
    return res.json({ message: 'ussd launched', psp: result.data, balance: walletBalance });
  } catch (err) {
    console.error('retrait 62 internal error', err);
    return res.status(500).json({ message: 'internal error', error: err.message });
  }
});

/* Generic payout /api/retrait/singpay */
app.post('/api/retrait/singpay', requireAuth, async (req, res) => {
  if (!ENABLE_WITHDRAWAL) return res.status(403).json({ message: 'withdrawals disabled' });
  try {
    const { amount, phone } = req.body;
    const p = normalizePhone(phone);
    if (!amount || !p) return res.status(400).json({ message: 'amount and phone required' });
    const numeric = Number(amount);
    if (isNaN(numeric) || numeric <= 0) return res.status(400).json({ message: 'invalid amount' });
    if (numeric > walletBalance) return res.status(400).json({ message: 'insufficient balance' });

    walletBalance -= numeric;
    const localTx = `LYRA-PAYOUT-${Date.now()}`;

    const payload = {
      amount: numeric,
      currency: 'XAF',
      wallet_id: WALLET_ID || undefined,
      merchant_reference: `lyra_${Date.now()}`,
      destination: { phone: p },
      note: `${APP_NAME} - retrait`
    };

    console.log('→ Calling Singpay payout with', payload);
    const result = await callPSP('payouts', payload);

    if (!result.ok) {
      walletBalance += numeric;
      pushHistory(req, { tx: localTx, amount: numeric, operator: 'Singpay', status: 'error', details: result.data });
      console.error('Singpay payout error', result);
      return res.status(result.status || 500).json({ message: 'psp payout error', details: result.data });
    }

    pushHistory(req, { tx: localTx, amount: numeric, operator: 'Singpay', status: 'success', psp: result.data, date: new Date().toISOString() });
    return res.json({ message: 'payout initiated', psp: result.data, balance: walletBalance });
  } catch (err) {
    console.error('singpay payout internal error', err);
    return res.status(500).json({ message: 'internal error', error: err.message });
  }
});

/* ------------------ History & status endpoints ------------------ */
app.get('/api/history', requireAuth, (req, res) => {
  res.json(req.session.history || []);
});

app.get('/api/status', (req, res) => {
  res.json({ app: APP_NAME, withdrawals_enabled: ENABLE_WITHDRAWAL, gateway: GATEWAY_BASE, wallet_local_balance: walletBalance });
});

/* ------------------ Health check ------------------ */
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

/* ------------------ Start server ------------------ */
app.listen(PORT, () => {
  console.log(`Lyra Banque server running on port ${PORT}`);
});
