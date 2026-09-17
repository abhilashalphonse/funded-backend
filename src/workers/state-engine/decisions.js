export function resolveDecision(account, rules) {
  if (["BREACHED", "CLOSED", "FUNDED"].includes(account.status)) {
    return { shouldUpdate: false, newStatus: account.status, command: null };
  }

  let newStatus = account.status;
  let command = null;

  if (rules.dailyLossBreached || rules.maxLossBreached) {
    newStatus = "BREACHED";
    command = "LOCK_ACCOUNT";
  } else if (rules.profitTargetHit && rules.minimumDaysMet) {
    if (account.currentPhase === 1 && account.challengeType === "TWO_STEP") {
      newStatus = "PASSED";
      command = "CREATE_PHASE_2_ACCOUNT";
    } else {
      newStatus = "FUNDED_REVIEW";
      command = "SEND_EMAIL_NOTIFICATION";
    }
  }

  const shouldUpdate = newStatus !== account.status || command !== null;
  return { shouldUpdate, newStatus, command };
}
