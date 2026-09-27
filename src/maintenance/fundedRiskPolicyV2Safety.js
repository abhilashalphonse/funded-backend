export function resolveMigrationEnvironment(env = process.env) {
  return String(
    env.RAILWAY_ENVIRONMENT_NAME
    || env.RAILWAY_ENVIRONMENT
    || env.ACG_ENVIRONMENT
    || env.NODE_ENV
    || "unknown",
  ).trim().toLowerCase();
}

export function validateV2MigrationSafety({
  apply = false,
  fundedAccountId = null,
  platformAccountId = null,
  allowBulk = false,
  allowProduction = false,
  environmentName = resolveMigrationEnvironment(),
} = {}) {
  const funded = optional(fundedAccountId);
  const platform = optional(platformAccountId);

  if (funded && platform) {
    throw migrationSafetyError(
      "Use only one exact V2 migration selector: --funded-account-id or --platform-account-id.",
      "ACG_FUNDED_V2_SELECTOR_CONFLICT",
    );
  }

  const targeted = Boolean(funded || platform);
  const normalizedEnvironment = String(environmentName || "unknown").trim().toLowerCase();
  const production = normalizedEnvironment === "production"
    || normalizedEnvironment === "prod"
    || normalizedEnvironment.startsWith("production-");

  if (apply && !targeted && allowBulk !== true) {
    throw migrationSafetyError(
      "V2 apply requires an exact account selector. Use --allow-bulk only for an explicitly approved bulk rollout.",
      "ACG_FUNDED_V2_APPLY_REQUIRES_TARGET",
    );
  }

  if (apply && production && allowProduction !== true) {
    throw migrationSafetyError(
      "V2 apply is blocked in production without --allow-production.",
      "ACG_FUNDED_V2_PRODUCTION_APPLY_BLOCKED",
    );
  }

  return {
    apply: Boolean(apply),
    fundedAccountId: funded,
    platformAccountId: platform,
    targeted,
    allowBulk: allowBulk === true,
    allowProduction: allowProduction === true,
    environmentName: normalizedEnvironment,
    production,
  };
}

function optional(value) {
  const result = String(value || "").trim();
  return result || null;
}

function migrationSafetyError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
