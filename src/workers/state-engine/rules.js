export function evaluateRules(account) {
  const initial = account.initialDeposit || 10000;
  const rule = account.rules;

  // 🔴 FIX #3: Match the phase number to the actual phase object
  const activePhase = rule.phases.find(
    p => p.phase === account.currentPhase
  );

  // Quick safety net in case the phase number is invalid
  if (!activePhase) {
    throw new Error(`Phase ${account.currentPhase} not found in account rules.`);
  }

  // 🔴 FIX #1: Calculate the actual equity thresholds for drawdowns
  const dailyLimit = initial - (initial * (rule.dailyDrawdown / 100));
  const maxLimit = initial - (initial * (rule.maxDrawdown / 100));

  return {
    dailyLossBreached: account.equity <= dailyLimit,
    maxLossBreached: account.equity <= maxLimit,
    
    // 🔴 FIX #2 & #3 combined: Correct profit math using the actual phase object
    profitTargetHit: account.profit !== undefined
      ? account.profit >= initial * (activePhase.profitTarget / 100)
      : account.equity >= initial + (initial * (activePhase.profitTarget / 100))
  };
}