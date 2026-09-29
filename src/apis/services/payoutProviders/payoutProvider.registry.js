export const PAYOUT_EXECUTION_PROVIDERS = Object.freeze([
  Object.freeze({
    id: "manual",
    label: "Manual Operations",
    implemented: true,
    automatic: false,
    methods: Object.freeze(["UPI", "BANK", "USDT"]),
    configured: () => true,
  }),
  Object.freeze({
    id: "sunpay",
    label: "Sunpay",
    implemented: false,
    automatic: true,
    methods: Object.freeze(["UPI", "BANK"]),
    configured: () => false,
  }),
  Object.freeze({
    id: "crypto",
    label: "Crypto Payout Provider",
    implemented: false,
    automatic: true,
    methods: Object.freeze(["USDT"]),
    configured: () => false,
  }),
]);

export function listPayoutExecutionProviders() {
  return PAYOUT_EXECUTION_PROVIDERS.map(provider => {
    const configured = provider.implemented && provider.configured();
    return {
      id: provider.id,
      label: provider.label,
      implemented: provider.implemented,
      configured,
      automatic: provider.automatic,
      methods: [...provider.methods],
      status: !provider.implemented
        ? "NOT_INTEGRATED"
        : provider.automatic && configured
          ? "READY"
          : "MANUAL",
    };
  });
}

export function automaticPayoutExecutionAvailable() {
  return listPayoutExecutionProviders().some(provider => provider.automatic && provider.configured);
}
