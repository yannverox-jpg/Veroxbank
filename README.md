# Lyra Banque - Singpay deployable project (with live balance refresh)

## Quick start
1. Copy `.env.example` to `.env` and fill values (DO NOT commit `.env`).
2. `npm install`
3. `npm start`
4. Open `http://localhost:3000`

## Endpoints
- GET `/api/balance`
- POST `/api/retrait/74`  body `{ amount, phone }`  (Airtel USSD 74)
- POST `/api/retrait/62`  body `{ amount, phone }`  (Moov USSD 62)
- POST `/api/retrait/singpay` body `{ amount, phone }` (generic payout)
- GET `/api/status`

## Notes
- After successful USSD/payout responses, the server fetches the wallet info from SingPay
  (`/portefeuille/api/{wallet_id}`) and returns the updated balance in the response.
- Ensure your `.env` contains the correct `WALLET_ID` and `MERCHANT_MOOV`.
