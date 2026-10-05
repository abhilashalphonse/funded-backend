export function compareTradingPermissions(expected = {}, expectedVersion = 0, actual = {}, actualVersion = 0) {
  const diff = [];
  for (const key of ["newsTrading", "weekendHolding"]) {
    if (Boolean(actual?.[key]) !== Boolean(expected?.[key])) {
      diff.push({ field: key, expected: Boolean(expected?.[key]), actual: Boolean(actual?.[key]) });
    }
  }
  if (Number(actualVersion) !== Number(expectedVersion)) {
    diff.push({ field: "tradingPermissionsVersion", expected: Number(expectedVersion), actual: Number(actualVersion) });
  }
  return diff;
}
