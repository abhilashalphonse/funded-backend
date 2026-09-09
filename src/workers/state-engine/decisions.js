export function resolveDecision(account, rules) {
  if (["BREACHED", "CLOSED", "FUNDED"].includes(account.status)) {
    return { shouldUpdate: false, newStatus: account.status, command: null };
  }

  let newStatus = account.status;
  let command = null;

  // 🔴 HIGHEST PRIORITY: BREACH
  // (Fails the account immediately, regardless of profit or days)
  if (rules.dailyLossBreached || rules.maxLossBreached) {
    newStatus = "BREACHED";
    command = "LOCK_ACCOUNT";
  }

  // 🟢 SUCCESS FLOW: Profit Target + Minimum Days
  else if (rules.profitTargetHit && rules.minimumDaysMet) {
    
    // 🔴 FIX #6: Use the correct schema property (currentPhase instead of phase)
    if (account.currentPhase === 1) {
      newStatus = "PASSED"; 
      // 🔴 FIX #7: Use a command the worker actually understands
      command = "CREATE_PHASE_2_ACCOUNT";
    } 
    
    else if (account.currentPhase === 2) {
      newStatus = "FUNDED_REVIEW";
      // 🔴 FIX #8: Fallback to email since the worker doesn't have a FUND_ACCOUNT directive
      // Alerts the admin/trader to begin the manual live-funding and contract process.
      command = "SEND_EMAIL_NOTIFICATION"; 
    }
  }

  // ⚪ NO CHANGE
  const shouldUpdate = newStatus !== account.status || command !== null;

  return {
    shouldUpdate,
    newStatus,
    command
  };
}
