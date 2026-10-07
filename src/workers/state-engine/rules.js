import {
  addDecimal,
  compareDecimal,
  normalizeDecimal,
  percentageOf,
  subtractDecimal,
} from "../../utils/decimal.js";

export function evaluateRules(account) {
  const initial = account.initialDeposit;
  const rule = account.rules;

  if (!initial || !rule) {
    throw new Error(`Account ${account.accountId} is missing challenge rules or an initial deposit.`);
  }

  const activePhase = rule.phases.find(
    p => p.phase === account.currentPhase
  );

  if (!activePhase) {
    throw new Error(`Phase ${account.currentPhase} not found in account rules.`);
  }

  const exact = exactFinancialState(account);
  if (exact) {
    const initialExact = normalizeDecimal(exact.initialBalance ?? String(initial));
    const equity = normalizeDecimal(exact.equity);
    const balance = normalizeDecimal(exact.balance);
    const dailyStart = normalizeDecimal(exact.dailyStartEquity ?? initialExact);
    const dailyLoss = positiveLoss(dailyStart, equity);
    const totalLoss = positiveLoss(initialExact, equity);
    const dailyLossLimit = percentageOf(initialExact, String(rule.dailyDrawdown || 0));
    const maxLossLimit = percentageOf(initialExact, String(rule.maxDrawdown || 0));
    const profitTarget = percentageOf(initialExact, String(activePhase.profitTarget || 0));
    const targetBalance = addDecimal(initialExact, profitTarget);

    return {
      // Boundary decisions for ACG Trader snapshots use lossless decimal
      // strings from the versioned financial contract. Dashboard projections
      // remain numeric for compatibility, but do not decide challenge limits.
      dailyLossBreached: compareDecimal(dailyLoss, dailyLossLimit) >= 0,
      maxLossBreached: compareDecimal(totalLoss, maxLossLimit) >= 0,
      profitTargetHit:
        compareDecimal(balance, targetBalance) >= 0
        && compareDecimal(equity, targetBalance) >= 0,
      minimumDaysMet: account.projections.tradingDays >= rule.minimumTradingDays,
    };
  }

  // Legacy/non-Trader accounts retain the existing numeric path until they
  // receive the versioned ACG Trader financial contract.
  const dailyLossLimit = initial * (rule.dailyDrawdown / 100);
  const maxLossLimit = initial * (rule.maxDrawdown / 100);

  return {
    dailyLossBreached: account.projections.dailyLoss >= dailyLossLimit,
    maxLossBreached: account.projections.totalLoss >= maxLossLimit,
    profitTargetHit:
      Number(account.balance) >= initial + initial * (activePhase.profitTarget / 100)
      && Number(account.equity) >= initial + initial * (activePhase.profitTarget / 100),
    minimumDaysMet: account.projections.tradingDays >= rule.minimumTradingDays,
  };
}

function exactFinancialState(account) {
  const financial = account?.platformFinancial;
  if (Number(financial?.contractVersion || 0) < 1) return null;
  if (!financial?.balance || !financial?.equity) return null;
  return financial;
}

function positiveLoss(reference, equity) {
  const loss = subtractDecimal(reference, equity);
  return compareDecimal(loss, "0") > 0 ? loss : "0";
}
