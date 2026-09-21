export function resolveDecision(account, rules) {
  // Transitional/final states do not emit duplicate commands on every snapshot.
  if (["BREACHED", "LOCKED", "PASSED", "FUNDED_REVIEW", "CLOSED", "FUNDED"].includes(account.status)) {
    return { shouldUpdate: false, newStatus: account.status, command: null };
  }

  let newStatus = account.status;
  let command = null;

  if (rules.dailyLossBreached || rules.maxLossBreached) {
    newStatus = "BREACHED";
    command = "LOCK_ACCOUNT";
    const triggeredRules = [];
    if (rules.dailyLossBreached) triggeredRules.push("DAILY_DRAWDOWN");
    if (rules.maxLossBreached) triggeredRules.push("MAX_DRAWDOWN");
    return {
      shouldUpdate: true,
      newStatus,
      command,
      primaryReason: rules.maxLossBreached ? "MAX_DRAWDOWN" : "DAILY_DRAWDOWN",
      triggeredRules,
    };
  } else if (rules.profitTargetHit && rules.minimumDaysMet) {
    if (account.currentPhase === 1 && account.challengeType === "TWO_STEP") {
      newStatus = "PASSED";
      command = "CREATE_PHASE_2_ACCOUNT";
    } else {
      newStatus = "FUNDED_REVIEW";
      command = "ENTER_FUNDED_REVIEW";
    }
  }

  const shouldUpdate = newStatus !== account.status || command !== null;
  return { shouldUpdate, newStatus, command };
}
