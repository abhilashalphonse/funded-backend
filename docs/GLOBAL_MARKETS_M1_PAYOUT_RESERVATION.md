# GLOBAL-MARKETS-M1 — Funded ↔ Trader payout reservation

Status: development/staging contract. Do not activate on production until full
integration and financial-recovery tests pass.

## Authority

- Trader is authoritative for USD account balance, realized profit, ledger and
  immediate risk. Funded never reconverts native INR trading results.
- Funded owns payout eligibility, profit split, payout cycle, payment provider
  execution, and customer-visible payout status.

## Workflow

1. Trader account must be paused, flat (no positions or pending orders), risk
   processing resolved, and USD ledger reconciled. No forced liquidation is
   performed to satisfy payout eligibility.
2. Funded requests the transactional Trader settlement checkpoint. It rejects
   an old or mismatched financial revision and computes entitlement using exact
   decimal arithmetic.
3. Trader reserves the specific `payoutId` and USD amount with the financial
   revision and checkpoint hash. Its account-level hold blocks other balance
   mutations, reactivation and competing payout reservations.
4. Funded persists the reservation receipt while moving the payout to APPROVED.
   If this write fails, retry the SAME approval; Trader reservation creation is
   idempotent by payout ID. Do not submit another payout to work around failure.
5. A provider-reported PAID status is verified against beneficiary settlement
   accounting. Funded calls Trader settlement, which writes exactly one
   immutable negative USD WITHDRAWAL entry, then records PAID. If Funded's
   database update fails, retry reconciliation; Trader's `settle` is idempotent.
6. A provider-confirmed FAILED result releases the Trader reservation BEFORE
   Funded clears the active payout slot. If release is unconfirmed, Funded
   remains PROCESSING and alerts/retries rather than allowing another payout.
   For admin REJECT/CANCEL, Funded claims a non-payable REJECTING/CANCELLING
   intermediate status first, then asks Trader to RELEASE an existing hold or
   persist a CANCELLED tombstone when no hold exists, and only then finalizes.
   An outage leaves Funded in the intermediate state with its activeKey intact.
   This also prevents an in-flight approval on another process from reserving
   the same payout ID after it was rejected.
7. Admin FAIL is not sufficient evidence that an in-flight provider transfer
   never settled. It cannot release an M1 Trader hold without verification.
8. Trader remains PAUSED after payout. Its risk-day baseline requires explicit
   post-withdrawal review; activation and resume stay blocked until reviewed.

## Recovery and migration

- A timeout from Trader reserve/settle/release is an **unknown outcome**, not
  proof of failure. Retry the same `payoutId`; never create a replacement.
- Once Trader has SETTLED a reservation, it cannot be RELEASED or deducted
  again. Never mutate a historical ledger or original trade.
- New Trader payout requests carry `requiresTraderSettlement=true`. Existing
  payouts that acquire an M1 Trader reservation during approval also require
  settlement, even if the old record does not have the flag.
- Only Trader-settled paid payouts are restored to cumulative earned-profit
  calculations, to avoid double subtraction. Legacy payouts retain legacy
  treatment. Funded must process the post-settlement financial revision before
  allowing another customer payout.
- Before switching existing historical payouts to the M1 regime, audit each
  payout's provider status, Trader withdrawal ledger, and Funded projection.
- Real Mongo transaction failover, multi-writer account fencing, and provider
  webhook races remain staging release gates.

## No automatic account reactivation

The implementation does not decide commercial risk-baseline adjustments or
alter daily/max-loss terms implicitly after a payout. An operator-approved
risk-baseline reconciliation contract is required before reactivation.
