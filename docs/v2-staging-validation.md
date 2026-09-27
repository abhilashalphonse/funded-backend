# ACG Funded V2 staging validation

Use this procedure only against an isolated staging Funded + Trader deployment with isolated MongoDB/Postgres data.

## Preconditions

- Trader and Funded staging services run the same commits intended for production.
- Staging does not share production MongoDB or Postgres databases.
- The Funded staging service points only to the Trader staging base URL.
- A dedicated staging Trial/Challenge/Master fixture exists.
- V1 remains the default provisioning policy until the V2 canary is explicitly migrated.

## 1. Targeted dry run

Use one exact selector. Dry run does not mutate Trader:

```bash
npm run maintenance:risk-policy-v2:dry-run -- \
  --platform-account-id=<TRADER_ACCOUNT_ID> \
  --migration-id=ACG_FUNDED_V2_STAGING_CANARY_2026_09
```

The report must show exactly one audited target, action `WOULD_MIGRATE`, source policy `ACG_FUNDED_V1`, no manual review, and no unexpected policy-version mismatch.

## 2. Targeted staging apply

```bash
npm run maintenance:risk-policy-v2:apply -- \
  --platform-account-id=<TRADER_ACCOUNT_ID> \
  --migration-id=ACG_FUNDED_V2_STAGING_CANARY_2026_09
```

The apply command is fail-closed:
- it requires an exact account selector unless `--allow-bulk` is supplied;
- production additionally requires `--allow-production`;
- selector conflicts are rejected before Trader inspection.

The result must report `MIGRATED` or `ALREADY_V2` with `verified: true`.

## 3. V2 trading acceptance

For the migrated staging account verify:

- Trader account capability reports `policyVersion=ACG_FUNDED_V2`, `fundedV2Confirmed=true`, `manualLotWithoutStopLoss=true`, `optionalStopLoss=true`.
- A manual-lot market order with no SL is accepted when normal margin/leverage/instrument constraints pass.
- Risk-percent sizing in the frontend still requires a stop distance.
- Market fill response returns authoritative `execution.resultingAccount`.
- Account/valuation `financialRevision` stays coherent after the fill.
- Existing Challenge daily/max-loss logic remains active.
- Margin stop-out triggers at `marginLevel <= 50%`, blocks new exposure while active, performs the minimum deterministic partial close needed to get strictly above 50%, and does not mark the Challenge `BREACHED`.
- A simultaneous Challenge breach supersedes the stop-out path.
- Manual close remains available during stop-out.
- A completed stop-out can be followed by a later independent stop-out episode.

## 4. Rerun / restart safety

Repeat the same migration command with the same migration id. It must be idempotent and verify the durable policy transition without rewriting financial state.

Restart the Trader service with a stop-out job in a retry/leased state and confirm the durable job resumes without duplicate fills or fees.

## 5. Production gate

Do not use `--allow-production` until the staging canary passes all checks above. Production rollout should start with one exact account selector, then a small reviewed batch. Bulk production migration remains a separate explicit action.
