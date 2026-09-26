import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const appUrl = new URL("../src/app.js", import.meta.url);
const legacyRouteUrl = new URL("../src/apis/routes/tradeWebhook.routes.js", import.meta.url);
const legacyControllerUrl = new URL("../src/apis/controllers/tradeWebhook.controller.js", import.meta.url);
const signedRouteUrl = new URL("../src/apis/routes/acgTraderWebhook.routes.js", import.meta.url);

test("legacy public trade webhook is not mounted or present", () => {
  const appSource = readFileSync(appUrl, "utf8");

  assert.doesNotMatch(appSource, /tradeWebhookRoutes/);
  assert.doesNotMatch(appSource, /trade-webhook/);
  assert.equal(existsSync(legacyRouteUrl), false);
  assert.equal(existsSync(legacyControllerUrl), false);
});

test("signed ACG Trader webhook remains mounted", () => {
  const appSource = readFileSync(appUrl, "utf8");
  const routeSource = readFileSync(signedRouteUrl, "utf8");

  assert.match(appSource, /app\.use\("\/api", acgTraderWebhookRoutes\)/);
  assert.match(routeSource, /\/webhooks\/acg-trader/);
});
