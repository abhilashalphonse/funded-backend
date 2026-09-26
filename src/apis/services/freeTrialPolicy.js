export const FREE_TRIAL_DURATION_DAYS = 14;
export const ACTIVE_DEMO_STATUSES = Object.freeze(["NEW", "ACTIVE", "PHASE_2"]);
export const TRIAL_TRANSITION_COMMANDS = Object.freeze(["CREATE_PHASE_2_ACCOUNT", "COMPLETE_TRIAL"]);
export const TRIAL_RESULTS = Object.freeze(["PASSED", "BREACHED", "EXPIRED", "CANCELLED"]);

export function activeDemoLifecycleStateQuery() {
  return {
    $or: [
      { status: { $in: [...ACTIVE_DEMO_STATUSES] } },
      { status: "PASSED", commandPending: { $in: [...TRIAL_TRANSITION_COMMANDS] } },
    ],
  };
}

export function activeDemoAccountQuery(ownerFilter = {}) {
  return {
    $and: [
      ownerFilter,
      { accountMode: "DEMO" },
      activeDemoLifecycleStateQuery(),
    ],
  };
}

export function isActiveDemoLifecycleState(account = {}) {
  const status = String(account?.status || "").toUpperCase();
  const commandPending = String(account?.commandPending || "").toUpperCase();
  return ACTIVE_DEMO_STATUSES.includes(status)
    || (status === "PASSED" && TRIAL_TRANSITION_COMMANDS.includes(commandPending));
}

export function freeTrialExpiry(startedAt = new Date()) {
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) throw new Error("A valid trial start time is required.");
  return new Date(start.getTime() + FREE_TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);
}

export function trialMetadata(account, result = null, completedAt = null) {
  const current = account?.trial?.toObject?.() || account?.trial || {};
  const startedAt = validDate(current.startedAt)
    || validDate(account?.createdAt)
    || new Date();
  const expiresAt = validDate(current.expiresAt) || freeTrialExpiry(startedAt);
  const normalizedResult = result == null ? (current.result || null) : String(result).toUpperCase();

  if (normalizedResult && !TRIAL_RESULTS.includes(normalizedResult)) {
    throw new Error(`Unknown trial result: ${normalizedResult}`);
  }

  return {
    startedAt,
    expiresAt,
    completedAt: validDate(completedAt) || validDate(current.completedAt) || null,
    cancelledAt: validDate(current.cancelledAt) || null,
    result: normalizedResult,
  };
}

export function trialResultForStatus(status, commandPending = null) {
  const normalized = String(status || "").toUpperCase();
  const pending = String(commandPending || "").toUpperCase();
  if (normalized === "PASSED" && TRIAL_TRANSITION_COMMANDS.includes(pending)) return null;
  return ["PASSED", "BREACHED", "EXPIRED"].includes(normalized) ? normalized : null;
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

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
