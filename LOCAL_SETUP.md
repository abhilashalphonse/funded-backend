# ACG local stack

Use four terminals and these fixed ports:

- ACG Funded frontend: http://localhost:5173
- ACG Funded backend: http://localhost:3000
- ACG Trader frontend: http://localhost:5174
- ACG Trader backend: http://localhost:4000

## 1. Start local infrastructure

From `funded-backend`:

```powershell
docker compose -f docker-compose.local.yml up -d
```

This starts:

- MongoDB on 27017 in replica-set mode (`rs0`)
- Postgres on 5432 for pg-boss

## 2. Create local env files

In each repository:

```powershell
Copy-Item .env.example .env
```

Repositories:

```text
funded-backend
funded-frontend
acg-trader-backend
acg-trader-frontend
```

Replace the placeholders in the copied `.env` files.

Never commit `.env`.

## 3. Configure Supabase

Use the same Supabase project in:

`funded-frontend/.env`

```env
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

and:

`funded-backend/.env`

```env
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
```

## 4. Prepare ACG Trader

In `acg-trader-backend`:

```powershell
npm ci
npm run tenant:create
```

The script prints a service API key. Copy that key into:

`funded-backend/.env`

```env
ACG_TRADER_CLIENT_ID=acg-funded-local
ACG_TRADER_API_KEY=<key printed by tenant:create>
```

The API key is shown when created; treat it as a secret.

## 5. Market data

For account/auth/lifecycle testing you can leave:

```env
MARKET_GATEWAY_ENABLED=false
```

For actual local trading:

```env
MARKET_GATEWAY_ENABLED=true
TWELVE_DATA_API_KEY=<your Twelve Data key>
```

## 6. Payments

NOWPayments is not required for ordinary local dashboard/trader testing.

For real payment-flow testing, fill these in `funded-backend/.env`:

```env
NOWPAYMENTS_API_KEY=...
NOWPAYMENTS_IPN_SECRET=...
NOWPAYMENTS_IPN_URL=<public HTTPS tunnel>/api/payments/crypto/ipn
```

A localhost IPN URL cannot receive callbacks from NOWPayments. Use a temporary HTTPS tunnel for payment webhook testing.

## 7. Start the four apps

Terminal 1:

```powershell
cd acg-trader-backend
npm ci
npm run dev
```

Terminal 2:

```powershell
cd funded-backend
npm ci
npm run dev
```

Terminal 3:

```powershell
cd acg-trader-frontend
npm ci
npm run dev
```

Terminal 4:

```powershell
cd funded-frontend
npm ci
npm run dev
```

## 8. Smoke test

Open:

```text
http://localhost:5173
```

Then test:

```text
register/login
→ create challenge
→ dashboard
→ Open ACG Trader
→ federation login
→ account visible in Trader
```

If market data is enabled, continue:

```text
place trade
→ live equity update
→ Funded dashboard update
→ breach/pass lifecycle
```

## 9. Before pushing

Backends:

```powershell
npm run check
npm test
```

Trader frontend:

```powershell
npm run lint
npm test
npm run build
```

Funded frontend:

```powershell
npm run lint
npm run build
```

Then commit and push. GitHub Actions runs automatically.
