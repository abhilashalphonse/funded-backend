# ACG Funded admin authorization and release checklist

All admin endpoints first verify a Supabase bearer token against the auth provider, then compare the verified user's email to `ADMIN_EMAILS`. BLOCKED customers cannot access admin endpoints.

## Scoped roles

Only existing `ADMIN_EMAILS` can become admins. Optional `ADMIN_ROLE_ASSIGNMENTS` **narrows** authority per allowlisted email. Example:

```dotenv
ADMIN_EMAILS=owner@example.com,finance@example.com,support@example.com
ADMIN_ROLE_ASSIGNMENTS=owner@example.com:SUPER_ADMIN,finance@example.com:FINANCE,support@example.com:SUPPORT
```

Roles: SUPER_ADMIN (all mutations), FINANCE (payout, payment, gateway changes), RISK (account actions), SUPPORT (support replies, close/return), VIEWER (read-only). Customer blocking/reactivation, acceptance fixtures, and system changes are owner-only. Direct sensitive payout-destination GET access requires FINANCE or SUPER_ADMIN. Read-only responses still contain customer information: only allowlist trusted operators.

## MFA cutover

`ADMIN_REQUIRE_MFA=false` by default prevents unexpectedly locking out the existing administrator. **MFA is not enforced until explicitly enabled.**

1. Enroll all privileged admins in Supabase TOTP (or another AAL2 supported factor). Confirm their access JWT's `aal` becomes `aal2` after verification.
2. Validate mutation denial with an AAL1 user and success with AAL2 in staging; ensure a separate break-glass recovery path exists.
3. Set `ADMIN_REQUIRE_MFA=true` in production and monitor 403 `ADMIN_MFA_REQUIRED`.
4. Do not treat frontend button hiding as authorization; backend middleware enforces every mutation.

## Risk data

`GET /api/admin/risk` returns complete `counts` and up to 100 latest rows per category. `?breached=today` restricts breaches to the current UTC day. Count totals and rows must not be confused.

## Before merging the frontend

Deploy and verify this additive backend change first; the frontend expects `counts`, `/me.role`, and `?breached=today`. Run backend tests/CI and confirm an existing authorized admin can still sign in and view the command center.
