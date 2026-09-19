export const DEFAULT_KNOWLEDGE_BASE = [
  {
    slug: "challenge-rules",
    title: "Challenge rules",
    category: "CHALLENGE",
    summary: "How ACG Funded challenge rules are determined and where the exact values come from.",
    keywords: ["challenge", "rules", "target", "evaluation", "one step", "two step", "minimum days"],
    content: `ACG Funded challenges are configurable. A customer's exact profit target, daily loss limit, maximum loss limit, minimum trading days, account size, phase count, profit split, payout frequency, news-trading option and weekend-holding option must be taken from that customer's purchased account configuration.

Do not assume a generic rule set when an authenticated account is available. For unauthenticated pre-sale questions, explain that available configurations can vary and direct the customer to the challenge builder for the exact selected terms.

The current product supports 1-Step and 2-Step evaluations. Account sizes are configurable within the ranges exposed by the challenge builder. A rule breach is determined by the backend risk engine, not by the AI assistant.`,
  },
  {
    slug: "daily-and-maximum-drawdown",
    title: "Daily and maximum drawdown",
    category: "RISK",
    summary: "How the risk engine evaluates daily loss and maximum loss.",
    keywords: ["daily loss", "drawdown", "maximum loss", "max loss", "daily drawdown", "breach", "risk"],
    content: `Daily loss is equity-based. The daily loss threshold is calculated as the account's initial balance multiplied by the account's configured daily-drawdown percentage. The daily baseline resets on UTC boundaries.

Maximum loss is measured from the initial account balance. The maximum-loss threshold is the initial balance multiplied by the configured maximum-drawdown percentage.

If either the daily-loss or maximum-loss threshold is reached or exceeded, the account is marked BREACHED and the trading account is locked by the state engine.

Always use the customer's live account rules and projections when explaining a specific breach. Do not calculate from guessed values.`,
  },
  {
    slug: "phase-progression",
    title: "Phase progression",
    category: "PHASE",
    summary: "What happens when profit targets and minimum trading days are completed.",
    keywords: ["phase", "phase 1", "phase 2", "pass", "passed", "funded review", "profit target"],
    content: `A phase is completed only when both conditions are true: the active phase profit target has been reached and the configured minimum trading days requirement has been met.

For a 2-Step challenge, completing Phase 1 moves the account into the transition that creates Phase 2. Completing the final phase moves the account to FUNDED_REVIEW.

For a 1-Step challenge, completing its only evaluation phase moves the account to FUNDED_REVIEW.

FUNDED_REVIEW is a review state; the AI must not promise that an account is funded until the backend account status actually shows FUNDED.`,
  },
  {
    slug: "free-trials",
    title: "Free trials",
    category: "FREE_TRIAL",
    summary: "How ACG Funded free-trial challenge accounts work.",
    keywords: ["free trial", "trial", "demo", "demo account", "try", "practice"],
    content: `Customers may create ACG Funded free trials repeatedly, but only one free trial may be active at a time.

There is no lifetime free-trial limit and no cooldown encoded in the current product. A customer who already has an active trial must finish or close that trial before creating another.

Free trials use configurable challenge definitions and are provisioned to the connected trading platform. They are demonstrations of the evaluation experience and are not paid funded accounts.`,
  },
  {
    slug: "acg-trader-support",
    title: "ACG Trader issues",
    category: "ACG_TRADER",
    summary: "How to handle ACG Trader access, provisioning and platform problems.",
    keywords: ["acg trader", "platform", "terminal", "login", "launch", "provisioning", "trade", "chart", "order"],
    content: `ACG Trader is the connected trading platform used by ACG Funded.

For authenticated customers, support should check the account's enabled status, platform, provisioning status and latest account state before answering access questions.

If the account is not provisioned, is disabled, or the launch endpoint cannot produce a valid trading session, explain the observed status without guessing the cause. Platform outages, missing federation tickets, provisioning failures, execution disputes or data discrepancies require human/technical review.

Never ask the customer for passwords, API keys, recovery codes or private keys.`,
  },
  {
    slug: "payments",
    title: "Payments",
    category: "PAYMENT",
    summary: "Supported checkout methods and payment-state handling.",
    keywords: ["payment", "crypto", "btc", "bitcoin", "usdt", "tron", "invoice", "paid", "confirming", "underpaid", "expired"],
    content: `ACG Funded's current crypto checkout supports BTC and USDT on TRON (TRC20) through NOWPayments.

The system records payment states including CREATED, WAITING, CONFIRMING, PAID, FAILED, EXPIRED, UNDERPAID and REFUNDED. The provider status is authoritative for provider-side processing, while the ACG payment record is authoritative for whether the challenge activation has completed.

When a payment becomes PAID, ACG Funded attempts to create and activate the purchased challenge account. Activation has its own status: NOT_STARTED, PENDING, ACTIVE or FAILED.

For authenticated customers, answer payment-status questions from their recent payment record. Never claim a payment is complete merely because the customer says funds were sent.`,
  },
  {
    slug: "payouts",
    title: "Payouts",
    category: "PAYOUT",
    summary: "How support should discuss payout terms and payout eligibility.",
    keywords: ["payout", "reward", "profit split", "withdraw", "withdrawal", "eligible", "frequency"],
    content: `A customer's commercial terms may include a profit split and payout frequency selected with the challenge. Those exact purchased terms should be read from the customer's account configuration.

The current challenge configuration can expose payout-frequency options such as Monthly, Biweekly, Weekly and On Demand, but support must use the customer's actual purchased term rather than assuming an option.

The AI may explain recorded payout terms and any deterministic eligibility information exposed by the backend. It must not approve a payout, promise a payout date, invent KYC/compliance status, or state that funds have been sent unless a backend payout record explicitly confirms it.

If a customer disputes a payout, reports a missing/late payout, or asks for an exception, escalate to human support.`,
  },
  {
    slug: "refunds",
    title: "Refunds",
    category: "REFUND",
    summary: "Safe handling of refund requests until a formal refund policy is configured.",
    keywords: ["refund", "money back", "cancel purchase", "chargeback", "reversal"],
    content: `The AI assistant is not authorized to approve, deny or promise refunds.

The backend can record a provider payment as REFUNDED when the payment provider reports that state, but this does not define ACG Funded's complete commercial refund policy.

For a refund request, collect no sensitive payment credentials. Confirm the order/payment context that is already available to the authenticated customer, explain any recorded payment state, and escalate the request to human support for a policy decision.

Chargeback threats, unauthorized-payment reports and refund disputes must always be escalated.`,
  },
  {
    slug: "prohibited-strategies",
    title: "Prohibited strategies",
    category: "PROHIBITED_STRATEGIES",
    summary: "How to answer strategy-restriction questions without inventing trading rules.",
    keywords: ["prohibited", "strategy", "strategies", "ea", "expert advisor", "copy trading", "hedging", "arbitrage", "hft", "latency"],
    content: `No complete prohibited-strategy policy is currently encoded in the ACG Funded backend knowledge source.

The AI must not invent restrictions on EAs, copy trading, hedging, arbitrage, HFT, news trading, scalping or other strategies. If a purchased account explicitly includes a commercial option such as news trading or weekend holding, the AI may report that recorded option.

For any question about whether a specific strategy is permitted, prohibited, abusive or grounds for account action, escalate to human support until an approved strategy policy is added to the knowledge base.`,
  },
  {
    slug: "account-access",
    title: "Account access",
    category: "ACCOUNT",
    summary: "Safe support for sign-in, identity and challenge ownership.",
    keywords: ["account", "login", "sign in", "email", "password", "ownership", "access", "profile", "authentication"],
    content: `ACG Funded customer authentication uses the account identity associated with the customer's sign-in.

Support may help with ordinary sign-in guidance and may read the authenticated customer's own workspace. The assistant must never request passwords, recovery codes, private keys, seed phrases or full payment credentials.

A challenge purchased with an email is not silently transferred to a different authenticated email. Cross-email ownership claims, email changes affecting ownership, compromised-account reports, identity disputes and account-transfer requests require a secure human review process.

Never expose another customer's account, payment or challenge data.`,
  },
];
