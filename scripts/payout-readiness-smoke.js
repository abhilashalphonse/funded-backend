#!/usr/bin/env node
import "dotenv/config";
import env from "../src/config/env.js";
import {
  payoutDestinationEncryptionConfigured,
} from "../src/apis/services/payoutDestination.service.js";
import {
  payoutQuoteConfigured,
} from "../src/apis/services/payoutQuote.service.js";
import {
  PAYOUT_PROVIDER_FEE_POLICY,
} from "../src/apis/services/payoutPolicy.js";
import {
  automaticPayoutExecutionAvailable,
  listPayoutExecutionProviders,
} from "../src/apis/services/payoutProviders/payoutProvider.registry.js";
import {
  getSunpayPayoutBalance,
  isSunpayPayoutConfigured,
} from "../src/apis/services/payoutProviders/sunpayPayout.service.js";

const args = new Set(process.argv.slice(2));
const probeSunpay = args.has("--probe-sunpay");
const requireSunpay = args.has("--require-sunpay");

async function main() {
  const security = {
    destinationEncryption: payoutDestinationEncryptionConfigured(),
    signedQuotes: payoutQuoteConfigured(),
    sunpayWebhookSecret: Boolean(env.SUNPAY_WEBHOOK_SECRET),
  };
  const providers = listPayoutExecutionProviders();
  const sunpay = providers.find(provider => provider.id === "sunpay") || null;
  const callbackUrl = env.SUNPAY_PAYOUT_CALLBACK_URL || null;

  let balanceProbe = null;
  if (probeSunpay) {
    if (!isSunpayPayoutConfigured()) {
      balanceProbe = {
        ok: false,
        skipped: true,
        reason: "SUNPAY_PAYOUT_API_KEY / SUNPAY_PAYOUT_API_SECRET / SUNPAY_PAYOUT_CALLBACK_URL / SUNPAY_WEBHOOK_SECRET are not fully configured.",
      };
    } else {
      try {
        const balance = await getSunpayPayoutBalance("INR");
        balanceProbe = {
          ok: true,
          skipped: false,
          currency: balance.currency,
          balance: balance.balance,
          upstreamBalance: balance.upstreamBalance,
        };
      } catch (error) {
        balanceProbe = {
          ok: false,
          skipped: false,
          code: error?.code || "SUNPAY_PAYOUT_BALANCE_PROBE_FAILED",
          message: error?.message || "Sunpay payout balance probe failed.",
        };
      }
    }
  }

  const summary = {
    mode: "READ_ONLY",
    moneyMovement: false,
    security,
    feePolicy: PAYOUT_PROVIDER_FEE_POLICY,
    callbackUrl,
    callbackHttps: Boolean(callbackUrl && callbackUrl.startsWith("https://")),
    sunpayCredentialsConfigured: isSunpayPayoutConfigured(),
    automaticExecutionReady: automaticPayoutExecutionAvailable(),
    manualSettlementReady: Boolean(
      security.destinationEncryption
      && security.signedQuotes
      && security.sunpayWebhookSecret
      && callbackUrl
      && callbackUrl.startsWith("https://")
    ),
    sunpayProvider: sunpay,
    balanceProbe,
  };

  console.log(JSON.stringify(summary, null, 2));

  const securityReady = summary.manualSettlementReady;
  const sunpayReady = summary.sunpayCredentialsConfigured
    && (!probeSunpay || balanceProbe?.ok === true);

  if (!securityReady || (requireSunpay && !sunpayReady)) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(JSON.stringify({
    mode: "READ_ONLY",
    moneyMovement: false,
    ok: false,
    code: error?.code || "PAYOUT_READINESS_SMOKE_FAILED",
    message: error?.message || String(error),
  }, null, 2));
  process.exitCode = 1;
});
