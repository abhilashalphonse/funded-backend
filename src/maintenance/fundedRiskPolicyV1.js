import Account from "../accounts/account.model.js";
import { getTradingConnector } from "../connectors/trading/registry.js";
import {
  ACG_FUNDED_RISK_POLICY_V1_VERSION,
  ACG_FUNDED_RISK_POLICY_V2_VERSION,
  ACG_FUNDED_V1_EXECUTION_POLICY,
} from "../connectors/trading/account-provisioning.js";

export const ACG_FUNDED_RISK_POLICY_KEYS = Object.freeze(Object.keys(ACG_FUNDED_V1_EXECUTION_POLICY));

export async function auditAndMigrateFundedRiskPolicyV1({
  accountModel = Account,
  connector = getTradingConnector("acg-trader"),
  apply = false,
  fundedAccountId = null,
  platformAccountId = null,
} = {}) {
  const accounts = await accountModel.find({ platform: "acg-trader" })
    .select("accountId status currentPhase platformAccountId platformAccounts")
    .lean();

  let targets = collectTraderTargets(accounts);

  const exactFundedAccountId = optionalSelector(fundedAccountId);
  const exactPlatformAccountId = optionalSelector(platformAccountId);
  if (exactFundedAccountId && exactPlatformAccountId) {
    const error = new Error("Use only one exact V1 repair selector: fundedAccountId or platformAccountId.");
    error.code = "ACG_FUNDED_V1_SELECTOR_CONFLICT";
    throw error;
  }
  if (exactFundedAccountId) {
    targets = targets.filter(target => String(target.fundedAccountId) === exactFundedAccountId);
  }
  if (exactPlatformAccountId) {
    targets = targets.filter(target => String(target.platformAccountId) === exactPlatformAccountId);
  }

  const records = [];

  for (const target of targets) {
    const before = await inspectTarget(connector, target);
    let after = before;
    let migrated = false;

    if (apply && before.protectedV2) {
      records.push({ ...before, migrated: false, before });
      continue;
    }

    if (apply && needsMigration(before)) {
      await connector.syncChallenge({
        platformAccountId: target.platformAccountId,
        riskPolicy: { ...ACG_FUNDED_V1_EXECUTION_POLICY },
        riskPolicyVersion: ACG_FUNDED_RISK_POLICY_V1_VERSION,
      });
      migrated = true;
      after = await inspectTarget(connector, target);

      if (needsMigration(after)) {
        const error = new Error(`Risk-policy migration verification failed for Trader account ${target.platformAccountId}.`);
        error.code = "ACG_FUNDED_RISK_POLICY_V1_VERIFICATION_FAILED";
        error.details = {
          fundedAccountId: target.fundedAccountId,
          platformAccountId: target.platformAccountId,
          missing: after.missing,
          mismatches: after.mismatches,
          riskPolicyVersion: after.riskPolicyVersion,
        };
        throw error;
      }
    }

    records.push({ ...after, migrated, before });
  }

  return {
    version: ACG_FUNDED_RISK_POLICY_V1_VERSION,
    apply,
    fundedAccountId: exactFundedAccountId,
    platformAccountId: exactPlatformAccountId,
    summary: summarize(records),
    records,
  };
}

export function collectTraderTargets(accounts = []) {
  const seen = new Set();
  const targets = [];

  for (const account of accounts || []) {
    const fundedAccountId = String(account?.accountId || "").trim();
    const entries = Array.isArray(account?.platformAccounts) ? account.platformAccounts : [];

    for (const entry of entries) {
      const platformAccountId = String(entry?.platformAccountId || "").trim();
      if (!platformAccountId || seen.has(platformAccountId)) continue;
      seen.add(platformAccountId);
      targets.push({
        fundedAccountId,
        fundedStatus: String(account?.status || "").toUpperCase(),
        platformAccountId,
        phase: Number(entry?.phase || 0) || null,
        accountType: String(entry?.accountType || "").toUpperCase() || null,
        platformStatus: String(entry?.status || "").toUpperCase() || null,
      });
    }

    const currentPlatformAccountId = String(account?.platformAccountId || "").trim();
    if (currentPlatformAccountId && !seen.has(currentPlatformAccountId)) {
      seen.add(currentPlatformAccountId);
      targets.push({
        fundedAccountId,
        fundedStatus: String(account?.status || "").toUpperCase(),
        platformAccountId: currentPlatformAccountId,
        phase: Number(account?.currentPhase || 0) || null,
        accountType: null,
        platformStatus: null,
      });
    }
  }

  return targets;
}

export function compareExecutionPolicy(remotePolicy = {}) {
  const missing = [];
  const mismatches = [];

  for (const [key, expected] of Object.entries(ACG_FUNDED_V1_EXECUTION_POLICY)) {
    const actual = scalar(remotePolicy?.[key]);
    if (actual == null) {
      missing.push({ key, expected: String(expected), actual: null });
      continue;
    }
    if (actual !== String(expected)) {
      mismatches.push({ key, expected: String(expected), actual });
    }
  }

  return { missing, mismatches };
}

export function needsMigration(record = {}) {
  if (record.protectedV2) return false;
  return Boolean(
    record.missing?.length
    || record.mismatches?.length
    || String(record.riskPolicyVersion || "") !== ACG_FUNDED_RISK_POLICY_V1_VERSION
  );
}

async function inspectTarget(connector, target) {
  const observability = await connector.adminObservability({
    platformAccountId: target.platformAccountId,
    limit: 200,
  });
  const remoteAccount = observability?.account || {};
  const riskPolicyVersion = remoteAccount?.challenge?.riskPolicyVersion || null;
  const protectedV2 = String(riskPolicyVersion || "") === ACG_FUNDED_RISK_POLICY_V2_VERSION;
  const comparison = protectedV2
    ? { missing: [], mismatches: [] }
    : compareExecutionPolicy(remoteAccount.riskPolicy || {});
  const openPositions = Array.isArray(observability?.openPositions) ? observability.openPositions : [];
  const openWithoutStopLoss = openPositions
    .filter(position => position?.stopLoss === null || position?.stopLoss === undefined || position?.stopLoss === "")
    .map(position => ({
      positionId: String(position?.positionId || position?.id || ""),
      symbol: String(position?.symbol || "").toUpperCase(),
      side: String(position?.side || "").toUpperCase(),
      openVolume: scalar(position?.openVolume),
    }));

  return {
    ...target,
    traderStatus: String(remoteAccount?.status || "").toUpperCase(),
    riskPolicyVersion,
    protectedV2,
    missing: comparison.missing,
    mismatches: comparison.mismatches,
    openPositionCount: openPositions.length,
    openWithoutStopLoss,
  };
}

function summarize(records) {
  const before = records.map(record => record.before || record);
  return {
    tradingAccountsAudited: records.length,
    accountsWithMissingPolicyFieldsBefore: before.filter(record => record.missing?.length).length,
    accountsWithNonNullPolicyMismatchBefore: before.filter(record => record.mismatches?.length).length,
    accountsWithVersionMismatchBefore: before.filter(record => !record.protectedV2 && String(record.riskPolicyVersion || "") !== ACG_FUNDED_RISK_POLICY_V1_VERSION).length,
    accountsProtectedV2: records.filter(record => record.protectedV2).length,
    accountsMigrated: records.filter(record => record.migrated).length,
    accountsWithPolicyMismatchAfter: records.filter(record => !record.protectedV2 && (record.missing?.length || record.mismatches?.length)).length,
    accountsWithVersionMismatchAfter: records.filter(record => !record.protectedV2 && String(record.riskPolicyVersion || "") !== ACG_FUNDED_RISK_POLICY_V1_VERSION).length,
    accountsWithOpenPositionsWithoutStopLoss: records.filter(record => record.openWithoutStopLoss?.length).length,
    openPositionsWithoutStopLoss: records.reduce((sum, record) => sum + Number(record.openWithoutStopLoss?.length || 0), 0),
  };
}

export function validateV1RepairSafety({
  apply = false,
  fundedAccountId = null,
  platformAccountId = null,
  allowProduction = false,
  environmentName = "unknown",
} = {}) {
  const funded = optionalSelector(fundedAccountId);
  const platform = optionalSelector(platformAccountId);

  if (funded && platform) {
    const error = new Error("Use only one exact V1 repair selector: --funded-account-id or --platform-account-id.");
    error.code = "ACG_FUNDED_V1_SELECTOR_CONFLICT";
    throw error;
  }

  const targeted = Boolean(funded || platform);
  const normalizedEnvironment = String(environmentName || "unknown").trim().toLowerCase();
  const production = normalizedEnvironment === "production"
    || normalizedEnvironment === "prod"
    || normalizedEnvironment.startsWith("production-");

  if (apply && !targeted) {
    const error = new Error("V1 repair apply requires an exact account selector.");
    error.code = "ACG_FUNDED_V1_APPLY_REQUIRES_TARGET";
    throw error;
  }

  if (apply && production && allowProduction !== true) {
    const error = new Error("V1 repair apply is blocked in production without --allow-production.");
    error.code = "ACG_FUNDED_V1_PRODUCTION_APPLY_BLOCKED";
    throw error;
  }

  return {
    apply: Boolean(apply),
    fundedAccountId: funded,
    platformAccountId: platform,
    targeted,
    allowProduction: allowProduction === true,
    environmentName: normalizedEnvironment,
    production,
  };
}

function optionalSelector(value) {
  const result = String(value || "").trim();
  return result || null;
}

function scalar(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value?.toString ? value.toString() : value);
}
