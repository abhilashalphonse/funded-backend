// Explicit admin policy. Only emails in ADMIN_EMAILS can enter the admin API.
// Role assignments narrow permissions, never grant access by themselves.
export const ADMIN_ROLES = Object.freeze(["SUPER_ADMIN", "SUPPORT", "RISK", "FINANCE", "VIEWER"]);
const ADMIN_ACTION_CAPABILITIES = Object.freeze({
  SUPPORT: ["SUPPORT_WRITE"],
  RISK: ["RISK_WRITE"],
  FINANCE: ["FINANCE_WRITE"],
  VIEWER: [],
});

export function parseAdminRoleAssignments(raw = "") {
  const roles = {};
  for (const token of String(raw).split(",").map(value => value.trim()).filter(Boolean)) {
    const separator = token.lastIndexOf(":");
    const email = token.slice(0, separator).trim().toLowerCase();
    const role = token.slice(separator + 1).trim().toUpperCase();
    if (separator <= 0 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !ADMIN_ROLES.includes(role)) {
      throw new Error("ADMIN_ROLE_ASSIGNMENTS must contain email:SUPER_ADMIN|SUPPORT|RISK|FINANCE|VIEWER entries.");
    }
    if (Object.hasOwn(roles, email)) throw new Error("Duplicate admin role assignment.");
    roles[email] = role;
  }
  return roles;
}

export function adminCan(role, capability) {
  const normalized = String(role || "").toUpperCase();
  return normalized === "SUPER_ADMIN" || (ADMIN_ACTION_CAPABILITIES[normalized] || []).includes(capability);
}

// The caller MUST verify the bearer token using Supabase /auth/v1/user first.
// We only read AAL after Supabase has confirmed that the token belongs to this user.
export function verifiedAdminAal(token, authenticatedUserId) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1] || "", "base64url").toString("utf8"));
    if (!authenticatedUserId || String(payload.sub || "") !== String(authenticatedUserId)) return null;
    return payload.aal === "aal2" ? "aal2" : "aal1";
  } catch { return null; }
}
