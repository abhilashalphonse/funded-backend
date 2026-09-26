export function pgBossSupervisionEnabled(runtimeRole) {
  const role = String(runtimeRole || "").trim().toLowerCase();
  return role === "all" || role === "worker";
}
