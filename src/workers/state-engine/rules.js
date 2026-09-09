export function evaluateRules(account) {
  const initial = account.initialDeposit;
  const rule = account.rules;

  if (!initial || !rule) {
    throw new Error(`Account ${account.accountId} is missing challenge rules or an initial deposit.`);
  }

  // 🔴 FIX #3: Match the phase number to the actual phase object
  const activePhase = rule.phases.find(
    p => p.phase === account.currentPhase
  );

  // Quick safety net in case the phase number is invalid
  if (!activePhase) {
    throw new Error(`Phase ${account.currentPhase} not found in account rules.`);
  }

  const dailyLossLimit = initial * (rule.dailyDrawdown / 100);
  const maxLossLimit = initial * (rule.maxDrawdown / 100);

  return {
    // Baseline policy: UTC reset, equity-based daily loss, initial-balance max loss.
    dailyLossBreached: account.projections.dailyLoss >= dailyLossLimit,
    maxLossBreached: account.projections.totalLoss >= maxLossLimit,
    profitTargetHit: account.projections.profit >= initial * (activePhase.profitTarget / 100),
    minimumDaysMet: account.projections.tradingDays >= rule.minimumTradingDays
  };
}
