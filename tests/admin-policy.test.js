import test from "node:test";
import assert from "node:assert/strict";
import { adminCan, parseAdminRoleAssignments, verifiedAdminAal } from "../src/auth/adminPolicy.js";

test("role assignments must be valid, explicit and unique", () => {
  assert.deepEqual(parseAdminRoleAssignments("Owner@example.com:SUPER_ADMIN,help@example.com:support"), {
    "owner@example.com": "SUPER_ADMIN", "help@example.com": "SUPPORT"
  });
  assert.throws(() => parseAdminRoleAssignments("no-email:FINANCE"), /ADMIN_ROLE_ASSIGNMENTS/);
  assert.throws(() => parseAdminRoleAssignments("operator@example.com:ROOT"), /ADMIN_ROLE_ASSIGNMENTS/);
  assert.throws(() => parseAdminRoleAssignments("owner@example.com:RISK,owner@example.com:VIEWER"), /Duplicate/);
});

test("restricted operators cannot perform unauthorized financial or account actions", () => {
  for (const capability of ["SUPPORT_WRITE", "RISK_WRITE", "FINANCE_WRITE", "CUSTOMERS_WRITE", "SYSTEM_WRITE"]) {
    assert.equal(adminCan("SUPER_ADMIN", capability), true);
    assert.equal(adminCan("VIEWER", capability), false);
  }
  assert.equal(adminCan("SUPPORT", "SUPPORT_WRITE"), true);
  assert.equal(adminCan("SUPPORT", "FINANCE_WRITE"), false);
  assert.equal(adminCan("RISK", "RISK_WRITE"), true);
  assert.equal(adminCan("RISK", "CUSTOMERS_WRITE"), false);
  assert.equal(adminCan("FINANCE", "FINANCE_WRITE"), true);
  assert.equal(adminCan("FINANCE", "RISK_WRITE"), false);
  assert.equal(adminCan("UNKNOWN", "SUPPORT_WRITE"), false);
});

test("AAL2 is honored only for a JWT belonging to the verified Supabase user", () => {
  const makeToken = payload => "header." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".signature";
  const token = makeToken({ sub: "owner-123", aal: "aal2" });
  assert.equal(verifiedAdminAal(token, "owner-123"), "aal2");
  assert.equal(verifiedAdminAal(token, "different-user"), null);
  assert.equal(verifiedAdminAal(makeToken({ sub: "owner-123" }), "owner-123"), "aal1");
  assert.equal(verifiedAdminAal("bad-token", "owner-123"), null);
});
