//**/**
 * Lyra Banque - Express server with improved withdrawals, balance refresh and Render optimization
 * Endpoints:
 *  - GET  /api/balance                 -> fetch wallet info
 *  - POST /api/retrait/74              -> Airtel USSD
 *  - POST /api/retrait/62              -> Moov USSD
 *  - POST /api/retrait/singpay         -> generic payout
 */

const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// --- Variables d’environnement
const GATEWAY_BASE = process.env.GATEWAY_BASE || 'https://gateway.singpay.ga/v1';
const WALLET_ID = process.env.WALLET_ID || '68fbef1277c46023214afd6d';
const MERCHANT_MOOV = process.env.MERCHANT_MOOV || '24162601406';
const ENABLE_WITHDRAWAL = (process.env.ENABLE_WITHDRAWAL || 'true') === 'true';
const APP_NAME = process.env.APP_NAME || 'Lyra Banque';

// --- Cache mémoire simple pour accélérer le /api/balance
let walletCache = null;
let lastFetch = 0;
const CACHE_DURATION = 30000; // 30 secondes

// --- Build headers for Singpay API
function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${WALLET_ID}`,
    'X-Merchant-Id': MERCHANT_MOOV,
    'X-App-Name': APP_NAME
  };
}

// --- Normalize phone number
function normalizePhone(phone) {
  if (!phone) return null;
  return String(phone).trim().replace(/\s+/g, '');
}

// --- Fetch wallet info (avec cache)
async function fetchWalletInfo(force = false) {
  const now = Date.now();
  if (!force && walletCache && now - lastFetch < CACHE_DURATION) {
    return walletCache; // retourne le cache si récent
  }

  const endpoint = `${GATEWAY_BASE}/portefeuille/api/${WALLET_ID}`;
  try {
    const r = await fetch(endpoint, { method: 'GET', headers: buildHeaders(), timeout: 15000 });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error('Failed to fetch wallet info: ' + (j && j.message ? j.message : r.status));
    walletCache = j;
    lastFetch = now;
    return j;
  } catch (err) {
    console.error('Erreur fetch wallet info:', err.message);
    throw err;
  }
}

// ------------------ USSD Helper ------------------
async function launchUSSDWithLogs(code, amount, phone) {
  const payload = {
    amount: Number(amount),
    currency: 'XAF',
    phone,
    merchant: MERCHANT_MOOV,
    wallet_id: WALLET_ID,
    reference: `lyra_ussd_${Date.now()}`,
    note: `${APP_NAME} - USSD ${code}`
  };

  console.log(`💡 Lancement USSD code ${code} avec payload:`, payload);

  const endpoint = `${GATEWAY_BASE}/${code}/paiement`;
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(payload),
    timeout: 30000
  });

  const j = await r.json().catch(() => null);
  console.log(`📥 Réponse USSD code ${code}:`, j);

  return { ok: r.ok, status: r.status, body: j };
}

// ------------------ Routes ------------------

// GET /api/balance
app.get('/api/balance', async (req, res) => {
  try {
    const info = await fetchWalletInfo();
    let balance = info.balance || info.solde || info.montant || info.availableBalance || null;
    res.json({ wallet: info, balance });
  } catch (err) {
    console.error('Balance error', err);
    res.status(502).json({ message: 'failed to fetch balance', error: err.message });
  }
});

// POST /api/retrait/74 (Airtel)
app.post('/api/retrait/74', async (req, res) => {
  if (!ENABLE_WITHDRAWAL) return res.status(403).json({ message: 'withdrawals disabled' });
  try {
    const { amount, phone } = req.body;
    const p = normalizePhone(phone);
    if (!amount || !p) return res.status(400).json({ message: 'amount and phone required' });

    const result = await launchUSSDWithLogs('74', amount, p);

    if (!result.ok) {
      return res.status(result.status || 500).json({ message: 'psp ussd error', psp: result.body });
    }

    try {
      const walletInfo = await fetchWalletInfo(true); // force refresh
      let balance = walletInfo.balance || walletInfo.solde || walletInfo.montant || walletInfo.availableBalance || null;
      return res.json({ message: 'ussd launched', psp: result.body, balance, wallet: walletInfo });
    } catch (e) {
      return res.json({ message: 'ussd launched, but failed to refresh balance', psp: result.body, error: e.message });
    }

  } catch (err) {
    console.error('retrait 74 error', err);
    res.status(500).json({ message: 'internal error', error: err.message });
  }
});

// POST /api/retrait/62 (Moov)
app.post('/api/retrait/62', async (req, res) => {
  if (!ENABLE_WITHDRAWAL) return res.status(403).json({ message: 'withdrawals disabled' });
  try {
    const { amount, phone } = req.body;
    const p = normalizePhone(phone);
    if (!amount || !p) return res.status(400).json({ message: 'amount and phone required' });

    const result = await launchUSSDWithLogs('62', amount, p);

    if (!result.ok) {
      return res.status(result.status || 500).json({ message: 'psp ussd error', psp: result.body });
    }

    try {
      const walletInfo = await fetchWalletInfo(true);
      let balance = walletInfo.balance || walletInfo.solde || walletInfo.montant || walletInfo.availableBalance || null;
      return res.json({ message: 'ussd launched', psp: result.body, balance, wallet: walletInfo });
    } catch (e) {
      return res.json({ message: 'ussd launched, but failed to refresh balance', psp: result.body, error: e.message });
    }

  } catch (err) {
    console.error('retrait 62 error', err);
    res.status(500).json({ message: 'internal error', error: err.message });
  }
});

// POST /api/retrait/singpay (generic)
app.post('/api/retrait/singpay', async (req, res) => {
  if (!ENABLE_WITHDRAWAL) return res.status(403).json({ message: 'withdrawals disabled' });
  try {
    const { amount, phone } = req.body;
    const p = normalizePhone(phone);
    if (!amount || !p) return res.status(400).json({ message: 'amount and phone required' });

    const payload = {
      amount: Number(amount),
      currency: 'XAF',
      wallet_id: WALLET_ID,
      merchant_reference: `lyra_${Date.now()}`,
      destination: { phone: p },
      note: `${APP_NAME} - retrait`
    };

    console.log('💡 Envoi du retrait à Singpay:', payload);

    const endpoint = `${GATEWAY_BASE}/payouts`;
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify(payload),
      timeout: 30000
    });

    const j = await r.json().catch(() => null);
    console.log('📥 Réponse Singpay:', j);

    if (!r.ok || !j || j.status !== 'success') {
      return res.status(r.status || 400).json({ message: 'psp payout error', details: j });
    }

    try {
      const walletInfo = await fetchWalletInfo(true);
      let balance = walletInfo.balance || walletInfo.solde || walletInfo.montant || walletInfo.availableBalance || null;
      return res.json({ message: 'payout initiated', psp: j, balance, wallet: walletInfo });
    } catch (e) {
      return res.json({ message: 'payout initiated but failed to refresh balance', psp: j, error: e.message });
    }

  } catch (err) {
    console.error('singpay payout error', err);
    res.status(500).json({ message: 'internal error', error: err.message });
  }
});

// Status route
app.get('/api/status', (req, res) => {
  res.json({ app: APP_NAME, withdrawals_enabled: ENABLE_WITHDRAWAL, gateway: GATEWAY_BASE });
});

// Test route
app.get('/api/test', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: '✅ Lyra Banque API is connected successfully to Render',
    timestamp: new Date().toISOString()
  });
});

// --- Ping automatique pour éviter l'hibernation Render
if (process.env.RENDER === "true" && process.env.RENDER_EXTERNAL_HOSTNAME) {
  setInterval(() => {
    fetch(`https://${process.env.RENDER_EXTERNAL_HOSTNAME}`).catch(() => {});
  }, 13 * 60 * 1000);
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Lyra Banque server running on port ${PORT}`));
