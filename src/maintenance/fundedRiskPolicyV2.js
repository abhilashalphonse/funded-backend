import crypto from "node:crypto";
import Account from "../accounts/account.model.js";
import { getTradingConnector } from "../connectors/trading/registry.js";
import {
  ACG_FUNDED_RISK_POLICY_V1_VERSION,
  ACG_FUNDED_RISK_POLICY_V2_VERSION,
  ACG_FUNDED_V2_EXECUTION_POLICY,
} from "../connectors/trading/account-provisioning.js";
import { collectTraderTargets } from "./fundedRiskPolicyV1.js";

export const ACG_FUNDED_V2_MIGRATION_ID = "ACG_FUNDED_V2_ROLLOUT_2026_09";
export const ACG_FUNDED_V2_DISABLED_LIMITS = Object.freeze([
  "maxRiskPerTradePercent",
  "maxAggregateRiskPercent",
  "maxMarginUsagePercent",
  "maxSingleOrderMarginPercentOfFree",
  "maxSymbolMarginPercentOfPermitted",
]);
export const ACG_FUNDED_V2_TRANSITION_POLICY = Object.freeze(
  Object.fromEntries(ACG_FUNDED_V2_DISABLED_LIMITS.map(key => [key, null])),
);

const ELIGIBLE_ACCOUNT_TYPES = new Set(["DEMO", "CHALLENGE", "FUNDED"]);

export async function auditAndMigrateFundedRiskPolicyV2({
  accountModel = Account,
  connector = getTradingConnector("acg-trader"),
  apply = false,
  migrationId = ACG_FUNDED_V2_MIGRATION_ID,
  fundedAccountId = null,
  platformAccountId = null,
  afterPlatformAccountId = null,
  limit = null,
} = {}) {
  const rolloutId = normalizeMigrationId(migrationId);
  const accounts = await accountModel.find({ platform: "acg-trader" })
    .select("accountId status currentPhase accountMode platformAccountId platformAccounts")
    .lean();

  let targets = collectTraderTargets(accounts)
    .sort((left, right) => String(left.platformAccountId).localeCompare(String(right.platformAccountId)));

  const exactFundedAccountId = optionalSelector(fundedAccountId);
  const exactPlatformAccountId = optionalSelector(platformAccountId);
  if (exactFundedAccountId && exactPlatformAccountId) {
    const error = new Error("Use only one exact V2 migration selector: fundedAccountId or platformAccountId.");
    error.code = "ACG_FUNDED_V2_SELECTOR_CONFLICT";
    throw error;
  }
  if (exactFundedAccountId) {
    targets = targets.filter(target => String(target.fundedAccountId) === exactFundedAccountId);
  }
  if (exactPlatformAccountId) {
    targets = targets.filter(target => String(target.platformAccountId) === exactPlatformAccountId);
  }

  if (afterPlatformAccountId) {
    const cursor = String(afterPlatformAccountId);
    targets = targets.filter(target => String(target.platformAccountId).localeCompare(cursor) > 0);
  }
  if (Number.isInteger(limit) && limit > 0) targets = targets.slice(0, limit);

  const records = [];
  for (const target of targets) {
    const targetMigrationId = accountMigrationId(rolloutId, target.platformAccountId);
    const before = await inspectV2Target(connector, target, targetMigrationId);

    if (before.alreadyV2) {
      records.push({
        ...before,
        action: "ALREADY_V2",
        migrated: false,
        verified: verifyExistingV2(before, targetMigrationId),
        before,
      });
      continue;
    }

    if (!before.eligible) {
      records.push({
        ...before,
        action: "MANUAL_REVIEW",
        migrated: false,
        verified: false,
        before,
      });
      continue;
    }

    if (!apply) {
      records.push({
        ...before,
        action: "WOULD_MIGRATE",
        migrated: false,
        verified: false,
        before,
      });
      continue;
    }

    const transitionResult = await connector.transitionRiskPolicy({
      platformAccountId: target.platformAccountId,
      migrationId: targetMigrationId,
      fromVersion: ACG_FUNDED_RISK_POLICY_V1_VERSION,
      toVersion: ACG_FUNDED_RISK_POLICY_V2_VERSION,
      riskPolicy: { ...ACG_FUNDED_V2_TRANSITION_POLICY },
    });

    const after = await inspectV2Target(connector, target, targetMigrationId);
    const verification = verifyMigration({ before, after, transitionResult, targetMigrationId });

    if (!verification.verified) {
      const error = new Error(`V2 policy migration verification failed for Trader account ${target.platformAccountId}.`);
      error.code = "ACG_FUNDED_RISK_POLICY_V2_VERIFICATION_FAILED";
      error.details = {
        fundedAccountId: target.fundedAccountId,
        platformAccountId: target.platformAccountId,
        migrationId: targetMigrationId,
        verification,
      };
      throw error;
    }

    records.push({
      ...after,
      action: transitionResult?.idempotentReplay ? "RESUMED_VERIFIED" : "MIGRATED",
      migrated: true,
      idempotentReplay: Boolean(transitionResult?.idempotentReplay),
      verified: true,
      verification,
      before,
    });
  }

  return {
    version: ACG_FUNDED_RISK_POLICY_V2_VERSION,
    fromVersion: ACG_FUNDED_RISK_POLICY_V1_VERSION,
    migrationId: rolloutId,
    apply,
    fundedAccountId: exactFundedAccountId,
    platformAccountId: exactPlatformAccountId,
    afterPlatformAccountId: afterPlatformAccountId || null,
    limit: Number.isInteger(limit) && limit > 0 ? limit : null,
    nextCursor: records.length ? records.at(-1).platformAccountId : null,
    summary: summarizeV2(records),
    records,
  };
}

export function compareV2DisabledExecutionPolicy(remotePolicy = {}) {
  const missing = [];
  const mismatches = [];

  for (const key of ACG_FUNDED_V2_DISABLED_LIMITS) {
    if (!Object.prototype.hasOwnProperty.call(remotePolicy || {}, key)) {
      missing.push({ key, expected: null, actual: "MISSING" });
      continue;
    }
    const actual = remotePolicy[key];
    if (actual !== null && actual !== undefined) {
      mismatches.push({ key, expected: null, actual: scalar(actual) });
    }
  }
  return { missing, mismatches };
}

export function preservedPolicySnapshot(policy = {}) {
  const snapshot = {};
  for (const [key, value] of Object.entries(policy || {})) {
    if (ACG_FUNDED_V2_DISABLED_LIMITS.includes(key)) continue;
    snapshot[key] = normalizeJsonValue(value);
  }
  return stableObject(snapshot);
}

export function migrationObservationSnapshot(observability = {}) {
  const account = observability?.account || {};
  const state = account?.state || {};
  const openPositions = Array.isArray(observability?.openPositions) ? observability.openPositions : [];
  const orders = Array.isArray(observability?.orders) ? observability.orders : [];

  return {
    account: {
      accountType: account.accountType || null,
      status: account.status || null,
      tradingEnabled: Boolean(account.tradingEnabled),
      federationEnabled: account.federationEnabled !== false,
      provisioningContractHash: account.provisioningContractHash || null,
      financialRevision: Number(account.financialRevision || 0),
      riskDayKey: account.riskDayKey || null,
      riskTimezone: account.riskTimezone || "UTC",
      riskProcessingState: account.riskProcessingState || "RESOLVED",
      riskUnresolvedReason: account.riskUnresolvedReason || null,
      marginStopOut: normalizeJsonValue(account.marginStopOut || null),
      state: stableObject({
        initialBalance: scalar(state.initialBalance),
        balance: scalar(state.balance),
        equity: scalar(state.equity),
        floatingPnl: scalar(state.floatingPnl),
        realizedPnlToday: scalar(state.realizedPnlToday),
        usedMargin: scalar(state.usedMargin),
        freeMargin: scalar(state.freeMargin),
        marginLevel: scalar(state.marginLevel),
        dailyStartEquity: scalar(state.dailyStartEquity),
      }),
      preservedPolicy: preservedPolicySnapshot(account.riskPolicy || {}),
    },
    openPositions: openPositions
      .map(position => stableObject({
        id: String(position?.id || position?.positionId || ""),
        positionId: String(position?.positionId || position?.id || ""),
        symbol: String(position?.symbol || ""),
        side: String(position?.side || ""),
        status: String(position?.status || ""),
        openVolume: scalar(position?.openVolume),
        entryPrice: scalar(position?.entryPrice),
        margin: scalar(position?.margin),
        stopLoss: scalar(position?.stopLoss),
        takeProfit: scalar(position?.takeProfit),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    pendingOrders: orders
      .filter(order => ["PENDING", "TRIGGERED"].includes(String(order?.status || "").toUpperCase()))
      .map(order => stableObject({
        id: String(order?.id || order?.orderId || ""),
        orderId: String(order?.orderId || order?.id || ""),
        symbol: String(order?.symbol || ""),
        side: String(order?.side || ""),
        type: String(order?.type || ""),
        status: String(order?.status || ""),
        requestedVolume: scalar(order?.requestedVolume),
        limitPrice: scalar(order?.limitPrice),
        stopPrice: scalar(order?.stopPrice),
        stopLoss: scalar(order?.stopLoss),
        takeProfit: scalar(order?.takeProfit),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}

export function compareMigrationInvariants(beforeSnapshot, afterSnapshot, effectiveFinancialRevision = null) {
  const beforeRevision = Number(beforeSnapshot?.account?.financialRevision || 0);
  const afterRevision = Number(afterSnapshot?.account?.financialRevision || 0);
  const effectiveRevision = effectiveFinancialRevision == null ? null : Number(effectiveFinancialRevision);
  const concurrentFinancialChange = (
    beforeRevision !== afterRevision
    || (effectiveRevision != null && (beforeRevision !== effectiveRevision || afterRevision !== effectiveRevision))
  );

  const accountBefore = {
    ...beforeSnapshot?.account,
    financialRevision: undefined,
  };
  const accountAfter = {
    ...afterSnapshot?.account,
    financialRevision: undefined,
  };
  delete accountBefore.financialRevision;
  delete accountAfter.financialRevision;

  return {
    concurrentFinancialChange,
    accountStateUnchanged: canonicalJson(accountBefore) === canonicalJson(accountAfter),
    positionsUnchanged: canonicalJson(beforeSnapshot?.openPositions || []) === canonicalJson(afterSnapshot?.openPositions || []),
    pendingOrdersUnchanged: canonicalJson(beforeSnapshot?.pendingOrders || []) === canonicalJson(afterSnapshot?.pendingOrders || []),
  };
}

function verifyMigration({ before, after, transitionResult, targetMigrationId }) {
  const transition = findTransition(after.policyTransitions, targetMigrationId)
    || transitionResult?.transition
    || null;
  const invariantComparison = compareMigrationInvariants(
    before.snapshot,
    after.snapshot,
    transition?.effectiveFinancialRevision,
  );

  const versionVerified = after.riskPolicyVersion === ACG_FUNDED_RISK_POLICY_V2_VERSION;
  const policyVerified = after.missing.length === 0 && after.mismatches.length === 0;
  const capabilitiesVerified = after.capabilities?.fundedV2Confirmed === true
    && after.capabilities?.optionalStopLoss === true
    && after.capabilities?.manualLotWithoutStopLoss === true;
  const transitionVerified = Boolean(
    transition
    && transition.migrationId === targetMigrationId
    && transition.fromVersion === ACG_FUNDED_RISK_POLICY_V1_VERSION
    && transition.toVersion === ACG_FUNDED_RISK_POLICY_V2_VERSION
    && transition.status === "COMPLETED"
    && transition.preservedStateHashBefore
    && transition.preservedStateHashBefore === transition.preservedStateHashAfter
    && transition.originalProvisioningContractHash === before.snapshot.account.provisioningContractHash
  );

  // If execution changed concurrently, Trader's in-transaction preserved-state
  // hashes are authoritative. In staging we expect no concurrent change.
  const observedCollectionsVerified = invariantComparison.concurrentFinancialChange
    ? transitionVerified
    : invariantComparison.accountStateUnchanged
      && invariantComparison.positionsUnchanged
      && invariantComparison.pendingOrdersUnchanged;

  return {
    verified: versionVerified
      && policyVerified
      && capabilitiesVerified
      && transitionVerified
      && observedCollectionsVerified,
    versionVerified,
    policyVerified,
    capabilitiesVerified,
    transitionVerified,
    observedCollectionsVerified,
    ...invariantComparison,
  };
}

function verifyExistingV2(record, targetMigrationId) {
  if (!record.alreadyV2) return false;
  const transition = findTransition(record.policyTransitions, targetMigrationId)
    || (record.policyTransitions || []).find(item =>
      item?.fromVersion === ACG_FUNDED_RISK_POLICY_V1_VERSION
      && item?.toVersion === ACG_FUNDED_RISK_POLICY_V2_VERSION
      && item?.status === "COMPLETED"
      && item?.preservedStateHashBefore
      && item?.preservedStateHashBefore === item?.preservedStateHashAfter
    );
  // Fresh V2 provisioning has no V1->V2 transition and is valid because its
  // immutable provisioning contract was V2 from creation.
  const freshV2Provision = Boolean(
    record.capabilities?.fundedV2Confirmed
    && record.missing.length === 0
    && record.mismatches.length === 0
    && !record.policyTransitions?.length
  );
  return Boolean(transition || freshV2Provision);
}

async function inspectV2Target(connector, target, targetMigrationId) {
  const observability = await connector.adminObservability({
    platformAccountId: target.platformAccountId,
    limit: 200,
  });
  const remoteAccount = observability?.account || {};
  const comparison = compareV2DisabledExecutionPolicy(remoteAccount.riskPolicy || {});
  const riskPolicyVersion = remoteAccount?.challenge?.riskPolicyVersion || null;
  const accountType = String(remoteAccount?.accountType || target.accountType || "").toUpperCase() || null;
  const policyTransitions = Array.isArray(observability?.policyTransitions) ? observability.policyTransitions : [];
  const alreadyV2 = riskPolicyVersion === ACG_FUNDED_RISK_POLICY_V2_VERSION
    && comparison.missing.length === 0
    && comparison.mismatches.length === 0
    && remoteAccount?.capabilities?.fundedV2Confirmed === true;
  const eligible = riskPolicyVersion === ACG_FUNDED_RISK_POLICY_V1_VERSION
    && ELIGIBLE_ACCOUNT_TYPES.has(accountType);

  let ineligibleReason = null;
  if (!ELIGIBLE_ACCOUNT_TYPES.has(accountType)) ineligibleReason = "ACCOUNT_TYPE_NOT_ELIGIBLE";
  else if (
    riskPolicyVersion !== ACG_FUNDED_RISK_POLICY_V1_VERSION
    && riskPolicyVersion !== ACG_FUNDED_RISK_POLICY_V2_VERSION
  ) ineligibleReason = "SOURCE_POLICY_VERSION_NOT_V1";
  else if (riskPolicyVersion === ACG_FUNDED_RISK_POLICY_V2_VERSION && !alreadyV2) {
    ineligibleReason = "V2_POLICY_NOT_CONFIRMED";
  }

  return {
    ...target,
    accountType,
    traderStatus: String(remoteAccount?.status || "").toUpperCase(),
    tradingEnabled: Boolean(remoteAccount?.tradingEnabled),
    riskPolicyVersion,
    capabilities: remoteAccount?.capabilities || null,
    missing: comparison.missing,
    mismatches: comparison.mismatches,
    eligible,
    alreadyV2,
    ineligibleReason,
    policyTransitions,
    transitionForMigration: findTransition(policyTransitions, targetMigrationId),
    snapshot: migrationObservationSnapshot(observability),
  };
}

function findTransition(transitions = [], migrationId) {
  return (transitions || []).find(item => String(item?.migrationId || "") === String(migrationId || "")) || null;
}

function summarizeV2(records) {
  return {
    tradingAccountsAudited: records.length,
    eligibleV1Accounts: records.filter(record => record.before?.eligible || record.eligible).length,
    alreadyV2Accounts: records.filter(record => record.action === "ALREADY_V2").length,
    accountsWouldMigrate: records.filter(record => record.action === "WOULD_MIGRATE").length,
    accountsMigrated: records.filter(record => record.action === "MIGRATED").length,
    accountsResumedAndVerified: records.filter(record => record.action === "RESUMED_VERIFIED").length,
    accountsVerified: records.filter(record => record.verified === true).length,
    accountsNeedingManualReview: records.filter(record => record.action === "MANUAL_REVIEW").length,
    accountsWithConcurrentFinancialChange: records.filter(record => record.verification?.concurrentFinancialChange).length,
    accountsWithVerificationFailure: records.filter(record =>
      record.migrated && record.verified !== true
    ).length,
  };
}

function accountMigrationId(rolloutId, platformAccountId) {
  const raw = `${normalizeMigrationId(rolloutId)}:${String(platformAccountId || "").trim()}`;
  if (raw.length <= 256) return raw;
  const digest = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
  return `${normalizeMigrationId(rolloutId).slice(0, 220)}:${digest}`;
}

function optionalSelector(value) {
  const result = String(value || "").trim();
  return result || null;
}

function normalizeMigrationId(value) {
  const result = String(value || "").trim();
  if (!result) {
    const error = new Error("migrationId is required.");
    error.code = "ACG_FUNDED_V2_MIGRATION_ID_REQUIRED";
    throw error;
  }
  return result;
}

function scalar(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value?.toString ? value.toString() : value);
}

function normalizeJsonValue(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value?.toString ? value.toString() : value;
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (value instanceof Map) return stableObject(Object.fromEntries(value));
  return stableObject(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeJsonValue(item)])));
}

function stableObject(value = {}) {
  return Object.fromEntries(
    Object.keys(value || {}).sort().map(key => [key, normalizeJsonValue(value[key])]),
  );
}

function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
