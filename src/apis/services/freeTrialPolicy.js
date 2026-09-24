const ACTIVE_DEMO_STATUSES = Object.freeze(["NEW", "ACTIVE", "PHASE_2"]);

export function activeDemoAccountQuery(ownerFilter = {}) {
  return {
    ...ownerFilter,
    accountMode: "DEMO",
    status: { $in: [...ACTIVE_DEMO_STATUSES] },
    enabled: true,
  };
}

export function customerFacingTrialProvisioningError(error) {
  const status = Number(error?.status);
  const code = String(error?.code || "");
  const providerFailure = error?.provider === "acg-trader"
    || code.startsWith("TRADING_PROVIDER_")
    || [502, 503, 504].includes(status);

  if (!providerFailure) return error;

  const unavailable = new Error(
    "Trading services are temporarily unavailable. Please try again shortly.",
    { cause: error },
  );
  unavailable.status = 503;
  unavailable.code = "TRIAL_PROVISIONING_UNAVAILABLE";
  unavailable.retryable = true;
  return unavailable;
}

export { ACTIVE_DEMO_STATUSES };
