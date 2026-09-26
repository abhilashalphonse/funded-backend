function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function phaseTargetAmount(account, phase = account?.currentPhase || 1) {
  const initial = finite(account?.initialDeposit || account?.accountSize);
  const rule = account?.rules?.phases?.find(item => Number(item.phase) === Number(phase));
  const percent = finite(rule?.profitTarget, NaN);
  if (!(initial > 0) || !Number.isFinite(percent)) return null;
  return initial * percent / 100;
}

export function phaseCompletionState(account, state = {}, phase = account?.currentPhase || 1) {
  const initial = finite(account?.initialDeposit || account?.accountSize);
  const targetAmount = phaseTargetAmount(account, phase);
  const targetBalance = targetAmount == null ? null : initial + targetAmount;
  const balance = finite(state?.balance, NaN);
  const equity = finite(state?.equity, NaN);
  const minimumTradingDays = finite(account?.rules?.minimumTradingDays);
  const tradingDays = finite(account?.projections?.tradingDays);

  const balanceTargetMet = targetBalance != null && Number.isFinite(balance) && balance >= targetBalance;
  const equityTargetMet = targetBalance != null && Number.isFinite(equity) && equity >= targetBalance;
  const minimumDaysMet = tradingDays >= minimumTradingDays;

  return {
    passed: balanceTargetMet && equityTargetMet && minimumDaysMet,
    initialBalance: initial,
    targetAmount,
    targetBalance,
    balance,
    equity,
    balanceTargetMet,
    equityTargetMet,
    minimumTradingDays,
    tradingDays,
    minimumDaysMet,
  };
}

export function applyPlatformAccountState(account, rawAccount = {}) {
  const state = rawAccount?.state || rawAccount?.account?.state || {};
  const initial = finite(account?.initialDeposit || account?.accountSize);
  const balance = finite(state.balance, finite(account?.balance));
  const equity = finite(state.equity, balance);
  const dailyStartEquity = finite(state.dailyStartEquity, initial);

  account.balance = balance;
  account.equity = equity;
  account.floatingProfit = finite(state.floatingPnl, equity - balance);
  account.margin = finite(state.usedMargin, 0);
  account.marginFree = finite(state.freeMargin, Math.max(0, equity - account.margin));
  account.dailyStartEquity = dailyStartEquity;
  account.projections = account.projections || {};
  account.projections.profit = balance - initial;
  account.projections.dailyLoss = Math.max(0, dailyStartEquity - equity);
  account.projections.totalLoss = Math.max(0, initial - equity);
  account.projections.highestBalance = Math.max(finite(account.projections.highestBalance, initial), balance);
  account.projections.highestEquity = Math.max(finite(account.projections.highestEquity, initial), equity);
  return account;
}

function resetPerformance(account, now = new Date()) {
  const startingBalance = finite(account?.initialDeposit || account?.accountSize);
  account.balance = startingBalance;
  account.equity = startingBalance;
  account.margin = 0;
  account.marginFree = startingBalance;
  account.marginLevel = 0;
  account.floatingProfit = 0;
  account.dailyStartEquity = startingBalance;
  account.dailyResetAt = now;
  account.riskDayKey = null;
  account.lastActiveDay = null;
  account.lastTradingDay = null;
  account.lastPlatformSnapshotAt = null;
  account.lastPlatformSnapshotSequence = null;
  account.totalTrades = 0;
  account.winningTrades = 0;
  account.losingTrades = 0;
  account.breach = null;
  account.projections = {
    highestBalance: startingBalance,
    highestEquity: startingBalance,
    profit: 0,
    dailyLoss: 0,
    totalLoss: 0,
    dailyStartBalance: startingBalance,
    tradingDays: 0,
  };
  return account;
}

export function resetAccountForPhaseTwo(account, now = new Date()) {
  account.currentPhase = 2;
  account.status = "PHASE_2";
  account.enabled = true;
  account.commandPending = null;
  return resetPerformance(account, now);
}

export function resetAccountForMaster(account, now = new Date()) {
  account.status = "FUNDED";
  account.enabled = true;
  account.commandPending = null;
  return resetPerformance(account, now);
}

export function hasCompletedCurrentChallenge(account) {
  const phase = Number(account?.currentPhase || 1);
  return (account?.platformAccounts || []).some(item =>
    Number(item?.phase) === phase
    && String(item?.accountType || "").toUpperCase() === "CHALLENGE"
    && String(item?.status || "").toUpperCase() === "COMPLETED"
  );
}

export function masterApprovalClaimFilter(account) {
  const phase = Number(account?.currentPhase || 1);
  return {
    accountId: account?.accountId,
    status: "FUNDED_REVIEW",
    currentPhase: phase,
    commandPending: null,
    platformAccounts: {
      $elemMatch: {
        phase,
        accountType: "CHALLENGE",
        status: "COMPLETED",
      },
    },
    $or: [
      { lifecycleOperationId: null },
      { lifecycleOperationId: { $exists: false } },
    ],
  };
}

export function tradablePhaseStatus(account, phase = account?.currentPhase || 1) {
  return Number(phase) === 2 && String(account?.challengeType || "").toUpperCase() === "TWO_STEP"
    ? "PHASE_2"
    : "ACTIVE";
}
