# ACG Funded — deploy gates and payment-to-activation acceptance

## Backend release gate (Railway)

1. Open Railway → project **fortunate-delight** → **funded-backend** → **Settings** → **Source**.
2. Enable **Wait for CI** for the linked `abhilashalphonse/funded-backend` GitHub `main` branch.
3. Accept Railway's additional GitHub Checks permissions if requested.
4. Confirm source config now shows `checkSuites: true` (previously `false`).
5. Require GitHub `Funded Backend CI / test` for merge to `main` in branch protection/rulesets where permitted. Railway waits for GitHub Actions **workflow conclusions** on `main`, not for manual PR approvals.
6. Only then merge the backend release PR. Check that Railway enters **WAITING** until the matching `main` CI run succeeds. A deliberately failed check in a safe nonproduction environment must never deploy.
7. Check Railway deployment commit SHA, startup logs, and HTTP error rate.

Do not disable Wait for CI as a shortcut for a failed check. Roll back the deployment (not saved customer payments or challenges) if the matching post-merge health audit fails.

## Frontend release gate (Firebase)

- `.github/workflows/firebase-hosting-live.yml` calls the exact-commit reusable `ci.yml` validation and only then starts deployment.
- Reusable validation checks out the paired backend pricing source, runs **unskipped parity**, the complete frontend test suite and Vite build.
- The preview workflow has the same dependency; the existing provider/deployment step only runs after validation passes.
- A failing/missing parity test must fail the reusable workflow, therefore block Firebase deploy.

## Payment-to-activation integration acceptance

`node --test tests/payment-activation-integration.test.js` runs without a database, network service or real payment:
- sign valid and invalid NOWPayments IPNs
- reject tampered invoice amounts, then transition to PAID after signed settlement
- enqueue exactly once despite duplicate callbacks
- provision purchased 1-Step and 2-Step rules with correct risk limits and purchased news/weekend permissions
- preserve frozen commercial terms rather than recalculating a legacy purchase
- activate exactly once, even if worker retries
- reject malformed paid records that lack required permission selections

Test adapters replace only external providers, queue delivery, persistence and analytics. The real payment handler, activation code path, trading risk mapping and persisted configuration mapper execute.

For provider end-to-end validation, use separate sandbox credentials, an isolated test payment, and a dedicated temporary trading account. **Do not use production funds or alter purchased challenges for acceptance.**
