import {
  isSunpayPayoutConfigured,
} from "./sunpayPayout.service.js";
import {
  PAYOUT_PROVIDER_FEE_POLICY,
} from "../payoutPolicy.js";

export const PAYOUT_EXECUTION_PROVIDERS = Object.freeze([
  Object.freeze({
    id: "manual",
    label: "Manual Operations",
    implemented: true,
    automatic: false,
    methods: Object.freeze(["UPI", "BANK", "USDT"]),
    configured: () => true,
    automaticReady: () => false,
  }),
  Object.freeze({
    id: "sunpay",
    label: "Sunpay",
    implemented: true,
    automatic: true,
    methods: Object.freeze(["UPI", "BANK"]),
    configured: () => isSunpayPayoutConfigured(),
    // ACG covers provider fees. Sunpay's public payout response exposes fee/net
    // only after submission, and the docs do not define a pre-submit gross-up
    // mechanism. Keep auto-execution closed until that guarantee exists.
    automaticReady: () => false,
  }),
  Object.freeze({
    id: "crypto",
    label: "Crypto Payout Provider",
    implemented: false,
    automatic: true,
    methods: Object.freeze(["USDT"]),
    configured: () => false,
    automaticReady: () => false,
  }),
]);

export function listPayoutExecutionProviders() {
  return PAYOUT_EXECUTION_PROVIDERS.map(provider => {
    const configured = provider.implemented && provider.configured();
    const automaticReady = configured && provider.automatic && provider.automaticReady();
    const status = !provider.implemented
      ? "NOT_INTEGRATED"
      : !configured
        ? "NOT_CONFIGURED"
        : provider.automatic
          ? automaticReady
            ? "READY"
            : provider.id === "sunpay" && PAYOUT_PROVIDER_FEE_POLICY === "ACG_COVERS"
              ? "FEE_GROSS_UP_REQUIRED"
              : "NOT_READY"
          : "MANUAL";

    return {
      id: provider.id,
      label: provider.label,
      implemented: provider.implemented,
      configured,
      automatic: provider.automatic,
      automaticReady,
      methods: [...provider.methods],
      feePolicy: provider.id === "sunpay" ? PAYOUT_PROVIDER_FEE_POLICY : null,
      status,
    };
  });
}

export function getAutomaticPayoutProvider(method) {
  const normalizedMethod = String(method || "").trim().toUpperCase();
  return PAYOUT_EXECUTION_PROVIDERS.find(provider =>
    provider.automatic
    && provider.implemented
    && provider.configured()
    && provider.automaticReady()
    && provider.methods.includes(normalizedMethod)
  ) || null;
}

export function assertAutomaticPayoutExecutionAllowed(method, providerId = "sunpay") {
  const normalizedMethod = String(method || "").trim().toUpperCase();
  const normalizedProviderId = String(providerId || "").trim().toLowerCase();
  const provider = PAYOUT_EXECUTION_PROVIDERS.find(candidate =>
    candidate.id === normalizedProviderId
    && candidate.automatic
    && candidate.methods.includes(normalizedMethod)
  );

  const ready = Boolean(
    provider
    && provider.implemented
    && provider.configured()
    && provider.automaticReady()
  );

  if (!ready) {
    const error = new Error(
      normalizedProviderId === "sunpay" && PAYOUT_PROVIDER_FEE_POLICY === "ACG_COVERS"
        ? "Automatic Sunpay payout execution is disabled until provider fee handling can guarantee the trader receives the exact quoted amount."
        : "Automatic payout execution is not available for this method.",
    );
    error.status = 409;
    error.code = "PAYOUT_AUTOMATIC_EXECUTION_DISABLED";
    error.provider = normalizedProviderId || null;
    error.method = normalizedMethod || null;
    throw error;
  }

  return provider;
}

export function automaticPayoutExecutionAvailable() {
  return PAYOUT_EXECUTION_PROVIDERS.some(provider =>
    provider.automatic
    && provider.implemented
    && provider.configured()
    && provider.automaticReady()
  );
}
