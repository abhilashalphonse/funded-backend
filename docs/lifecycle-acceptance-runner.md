# Deployed lifecycle acceptance runner

This runner validates the live ACG Funded ↔ ACG Trader lifecycle contract against deployed APIs. It is intentionally destructive and must only be used with dedicated acceptance fixtures.

## What it covers

1. Funded + Trader health and fixture identity checks.
2. Concurrent free-Trial creation; exactly one active Trial may survive.
3. One federated Trader session grants the current Trial and multiple Challenge accounts.
4. Repeated account switching at the API boundary; every open/close order and history row must match the selected platform account.
5. One-step Trial target completion; Trial becomes PASSED and cannot relaunch.
6. Paid two-step Challenge Phase 1 → distinct Phase 2; old Phase 1 rejects new exposure.
7. Profit-target/breach race; BREACHED must win and no active successor may survive.
8. Phase 2 → FUNDED_REVIEW; review remains non-tradable and no Master is federation-visible.
9. Two concurrent APPROVE_FUNDED requests; exactly one Master activation may succeed.
10. Master order routing plus optional restart/reconciliation verification.

The runner uses the existing Trader service-authenticated ledger adjustment endpoint to move balance/equity to exact target thresholds. This keeps the pass path deterministic while still exercising the real valuation webhook, Funded state engine, command worker, staged provisioning, federation, and activation flow.

## Fixture requirements

Use a dedicated Supabase customer whose email contains `acceptance` by default. The identity guard can only be bypassed explicitly.

Prepare two fresh paid **two-step** Challenges belonging to that customer:

- both start in Phase 1,
- both are ACTIVE and enabled,
- both use ACG Trader,
- both have `minimumTradingDays = 0`.

Challenge A is consumed through Phase 1 → Phase 2 → Funded Review → Master.

Challenge B is intentionally breached during the promotion-race scenario.

A full run therefore consumes both fixtures. Do not point the runner at customer accounts you care about.

## Required environment

```bash
export ACCEPTANCE_FUNDED_BASE_URL="https://funded-backend-production.up.railway.app"
export ACCEPTANCE_TRADER_BASE_URL="https://<acg-trader-backend>"

export ACCEPTANCE_CUSTOMER_ID="<dedicated acceptance customer id>"
export ACCEPTANCE_CUSTOMER_BEARER="<Supabase access token for that customer>"
export ACCEPTANCE_ADMIN_BEARER="<Supabase access token for an ADMIN_EMAILS admin>"

export ACCEPTANCE_TRADER_SERVICE_KEY="<ACG Trader service API key>"
export ACCEPTANCE_TRADER_CLIENT_ID="acg-funded-backend"

export ACCEPTANCE_CHALLENGE_A_ID="<fresh paid two-step challenge>"
export ACCEPTANCE_CHALLENGE_B_ID="<second fresh paid two-step challenge>"
export ACCEPTANCE_CONFIRM_ACCOUNT_IDS="<challenge A id>,<challenge B id>"

export ACCEPTANCE_ALLOW_DESTRUCTIVE="YES_I_UNDERSTAND"
```

Optional:

```bash
export ACCEPTANCE_SYMBOL="EURUSD"
export ACCEPTANCE_VOLUME="0.01"
export ACCEPTANCE_TIMEOUT_MS="90000"
export ACCEPTANCE_POLL_MS="250"
export ACCEPTANCE_RACE_BREACH_DELAY_MS="4500"
export ACCEPTANCE_CLEANUP_EXISTING_TRIAL="YES"
export ACCEPTANCE_TEST_EMAIL_PATTERN="acceptance"
export ACCEPTANCE_REPORT_DIR="artifacts"
```

If the dedicated customer already has an active Trial, the runner refuses to continue unless `ACCEPTANCE_CLEANUP_EXISTING_TRIAL=YES`. Cleanup only closes active Trial accounts for the acceptance customer.

## Dry run

Always run preflight first:

```bash
npm run acceptance:lifecycle:dry-run
```

Dry-run performs health, authentication, identity, ownership, Challenge-state, provider, and minimum-trading-days checks. It does not mutate lifecycle state.

## Full run

```bash
npm run acceptance:lifecycle
```

The process exits non-zero if a required scenario fails or is skipped.

Two reports are written:

```text
artifacts/lifecycle-acceptance-<run-id>.json
artifacts/lifecycle-acceptance-<run-id>.md
```

## Restart / reconciliation scenario

The runner deliberately does **not** embed Railway credentials.

For a fully automated scenario 10, configure a secure operator-controlled restart hook:

```bash
export ACCEPTANCE_RESTART_HOOK_URL="https://<your-secure-restart-hook>"
export ACCEPTANCE_RESTART_HOOK_BEARER="<hook token>"
```

The hook receives:

```json
{
  "runId": "...",
  "service": "funded-backend",
  "reason": "lifecycle-acceptance-reconciliation"
}
```

and should trigger one Funded backend restart/redeploy, then return HTTP 200/201/202/204.

If no hook is configured, scenario 10 records the Master routing evidence but marks restart verification SKIP. By default a skipped required scenario makes the overall report FAIL. Use `--allow-skip` only when intentionally running a partial acceptance pass.

## Safety barriers

The runner refuses mutation unless all of these hold:

- `ACCEPTANCE_ALLOW_DESTRUCTIVE=YES_I_UNDERSTAND`;
- the customer identity matches `ACCEPTANCE_TEST_EMAIL_PATTERN` (default: `acceptance`);
- Challenge A and Challenge B are distinct;
- `ACCEPTANCE_CONFIRM_ACCOUNT_IDS` exactly matches the two configured Challenge IDs;
- both Challenges belong to the configured customer;
- both are fresh Phase-1 ACG Trader two-step accounts;
- both have zero minimum trading days.

The runner never prints bearer tokens or service keys into its report.
