# Versioned trading permissions

New non-demo provisioning sends explicit `newsTrading`, `weekendHolding` and a positive `tradingPermissionsVersion`. Payment activation rejects absent purchased selections. Funded carries the version through Phase 1, Phase 2 and Master provisioning. Trader rejects older versions and same-version conflicting contents.

Historical provisioning with missing selections is permissive only when `TRADING_PERMISSION_LEGACY_BEFORE` is explicitly configured and the account predates it. Supply an approved UTC cutoff based on purchase records. This variable does not retroactively repair incomplete new purchases.

## Resumable migration

`scripts/sync-trading-permissions.js` defaults to dry-run. `--limit` is now a page size (1–1,000), not a total-account cap. It scans all matching accounts through the run's fixed creation cutoff. Run metadata and per-account outcomes persist in Mongo; dry-run writes only this audit/progress data, not account permissions or Trader state.

```text
node scripts/sync-trading-permissions.js --run-id=review-001 --limit=200
node scripts/sync-trading-permissions.js --run-id=apply-001 --account-id=ACG-EXAMPLE --apply
```

Bulk apply still requires `--allow-bulk`; production apply still requires `--allow-production`. Neither has been executed during implementation. Missing historical permissions additionally require `--legacy-before=<approved ISO UTC timestamp>`; this command option is independent of the provisioning environment variable.

Resume using the same run ID and original mode/account/cutoff/environment options. A dry-run cannot be converted into apply under the same run ID: create a new apply run. Run configuration is immutable. Each account's versioned payload is saved before syncing. Failed/pending records retry before cursor traversal resumes; successful records do not sync again. Inspect `PermissionMigrationResult` for individual failures. Source changes are flagged for review rather than silently overwriting a newer contract.

A database-backed regression processed 205 accounts over three pages, isolated one connector failure and retried only that account on resume. Run it with a disposable local replica set database named `acg_permission_test` in `TEST_MONGODB_URI`; the test rejects other database names and drops this test database on completion:

```text
node --test tests/permission-migration.test.js
```

## Release dependencies

- Coordinate the new Funded and Trader backend schemas; old Trader rejects the new field, while new Trader requires it. Use a provisioning pause/drain or a separate schema-only compatibility rollout.
- Password recovery reuses the existing `/auth/callback` Supabase redirect. The frontend detects recovery tokens/events and displays the reset form. No additional redirect allowlist entry or Supabase setting change is required.
- Funded calendar windows are labeled configured/informational. Trader's effective policy status remains the execution authority.
- Payment activation and activation-email recovery now paginate and recur every minute, with per-record failure isolation. Live payment/email provider delivery and graceful shutdown under deployment interruption still require staging acceptance.
