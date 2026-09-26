import Account from "../accounts/account.model.js";
import { getTradingConnector } from "../connectors/trading/registry.js";
import {
  ACG_FUNDED_EXECUTION_POLICY,
  ACG_FUNDED_RISK_POLICY_VERSION,
} from "../connectors/trading/account-provisioning.js";

export const ACG_FUNDED_RISK_POLICY_KEYS = Object.freeze(Object.keys(ACG_FUNDED_EXECUTION_POLICY));

export async function auditAndMigrateFundedRiskPolicyV1({
  accountModel = Account,
  connector = getTradingConnector("acg-trader"),
  apply = false,
} = {}) {
  const accounts = await accountModel.find({ platform: "acg-trader" })
    .select("accountId status currentPhase platformAccountId platformAccounts")
    .lean();

  const targets = collectTraderTargets(accounts);
  const records = [];

  for (const target of targets) {
    const before = await inspectTarget(connector, target);
    let after = before;
    let migrated = false;

    if (apply && needsMigration(before)) {
      await connector.syncChallenge({
        platformAccountId: target.platformAccountId,
        riskPolicy: { ...ACG_FUNDED_EXECUTION_POLICY },
        riskPolicyVersion: ACG_FUNDED_RISK_POLICY_VERSION,
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
    version: ACG_FUNDED_RISK_POLICY_VERSION,
    apply,
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

  for (const [key, expected] of Object.entries(ACG_FUNDED_EXECUTION_POLICY)) {
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
  return Boolean(
    record.missing?.length
    || record.mismatches?.length
    || String(record.riskPolicyVersion || "") !== ACG_FUNDED_RISK_POLICY_VERSION
  );
}

async function inspectTarget(connector, target) {
  const observability = await connector.adminObservability({
    platformAccountId: target.platformAccountId,
    limit: 200,
  });
  const remoteAccount = observability?.account || {};
  const comparison = compareExecutionPolicy(remoteAccount.riskPolicy || {});
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
    riskPolicyVersion: remoteAccount?.challenge?.riskPolicyVersion || null,
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
    accountsWithVersionMismatchBefore: before.filter(record => String(record.riskPolicyVersion || "") !== ACG_FUNDED_RISK_POLICY_VERSION).length,
    accountsMigrated: records.filter(record => record.migrated).length,
    accountsWithPolicyMismatchAfter: records.filter(record => record.missing?.length || record.mismatches?.length).length,
    accountsWithVersionMismatchAfter: records.filter(record => String(record.riskPolicyVersion || "") !== ACG_FUNDED_RISK_POLICY_VERSION).length,
    accountsWithOpenPositionsWithoutStopLoss: records.filter(record => record.openWithoutStopLoss?.length).length,
    openPositionsWithoutStopLoss: records.reduce((sum, record) => sum + Number(record.openWithoutStopLoss?.length || 0), 0),
  };
}

function scalar(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value?.toString ? value.toString() : value);
}
