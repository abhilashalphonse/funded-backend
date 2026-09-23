import "dotenv/config";
import mongoose from "mongoose";
import Account from "../src/accounts/account.model.js";
import Event from "../src/events/event.model.js";
import { createCustomerTradingLaunch } from "../src/apis/services/tradingLaunch.service.js";

const ACCOUNT_ID = String(process.env.LAUNCH_READINESS_SMOKE_ACCOUNT_ID || "").trim();
const EVENT_IDS = String(process.env.LAUNCH_READINESS_EVENT_IDS || "")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

if (!ACCOUNT_ID) throw new Error("LAUNCH_READINESS_SMOKE_ACCOUNT_ID is required.");
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required.");
if (!process.env.ACG_TRADER_BASE_URL) throw new Error("ACG_TRADER_BASE_URL is required.");

const traderBaseUrl = String(process.env.ACG_TRADER_BASE_URL).replace(/\/+$/, "");
const timeoutMs = Math.max(1000, Number(process.env.ACG_TRADER_TIMEOUT_MS) || 10000);

function eventEnvelopeId(raw) {
  return String(raw).startsWith("acg-trader:") ? String(raw) : `acg-trader:${raw}`;
}

async function request(path, { method = "GET", body, accessToken, cookie, refresh = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${traderBaseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(refresh ? { "X-ACG-Refresh": "1" } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `Trader smoke request failed (${response.status}) at ${path}`);
      error.status = response.status;
      error.code = payload?.error?.code || "SMOKE_HTTP_ERROR";
      throw error;
    }
    return { response, payload };
  } finally {
    clearTimeout(timer);
  }
}

function refreshCookie(response) {
  const raw = response.headers.get("set-cookie") || "";
  const match = /(?:^|,\s*)acg_trader_refresh=([^;]+)/i.exec(raw);
  if (!match) throw new Error("Trader exchange/refresh did not return the refresh cookie.");
  return `acg_trader_refresh=${match[1]}`;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const prefixedIds = EVENT_IDS.map(eventEnvelopeId);
  const existingEvents = prefixedIds.length
    ? await Event.find({ eventId: { $in: prefixedIds } })
      .select("eventId aggregateId eventType occurredAt")
      .lean()
    : [];
  const existingById = new Map(existingEvents.map(item => [String(item.eventId), item]));
  const eventAudit = prefixedIds.map(eventId => ({
    eventId,
    exists: existingById.has(eventId),
    aggregateId: existingById.get(eventId)?.aggregateId || null,
    eventType: existingById.get(eventId)?.eventType || null,
  }));
  console.log("[launch-readiness] immutable-event-audit", JSON.stringify(eventAudit));

  const account = await Account.findOne({ accountId: ACCOUNT_ID }).lean();
  if (!account) throw new Error(`Smoke account ${ACCOUNT_ID} not found.`);
  if (account.platform !== "acg-trader") throw new Error(`Smoke account ${ACCOUNT_ID} is not on ACG Trader.`);
  if (!account.enabled || !["ACTIVE", "PHASE_2", "FUNDED"].includes(String(account.status || "").toUpperCase())) {
    throw new Error(`Smoke account ${ACCOUNT_ID} is not currently launchable (status=${account.status}, enabled=${account.enabled}).`);
  }

  const stableCustomerId = String(account.customerId || account.ownerExternalRef || "").trim();
  if (!stableCustomerId) throw new Error("Smoke account does not have a usable owner/customer identity.");
  const customer = {
    customerId: stableCustomerId,
    customerIds: [stableCustomerId],
    id: String(account.ownerExternalRef || stableCustomerId),
    email: "",
  };

  const launch = await createCustomerTradingLaunch(customer, ACCOUNT_ID);
  const launchUrl = new URL(launch.launchUrl);
  const ticket = launchUrl.searchParams.get("ticket");
  if (!ticket) throw new Error("Funded launch response did not contain a federation ticket.");

  const exchanged = await request("/v1/auth/federated/exchange", {
    method: "POST",
    body: { ticket },
  });
  const firstAccessToken = exchanged.payload?.accessToken;
  if (!firstAccessToken) throw new Error("Federation exchange did not return an access token.");
  const firstCookie = refreshCookie(exchanged.response);

  const firstAccounts = await request("/v1/auth/accounts", { accessToken: firstAccessToken });
  const accountIds = (firstAccounts.payload?.accounts || []).map(item => String(item?.id || "")).filter(Boolean);
  const selectedId = String(firstAccounts.payload?.selectedAccountId || "");
  if (!accountIds.includes(String(launch.selectedPlatformAccountId))) {
    throw new Error("Granted accounts do not contain the Funded-selected platform account.");
  }
  if (selectedId !== String(launch.selectedPlatformAccountId)) {
    throw new Error("Trader selected account does not match Funded launch selection.");
  }

  const refreshed = await request("/v1/auth/refresh", {
    method: "POST",
    accessToken: firstAccessToken,
    cookie: firstCookie,
    refresh: true,
  });
  const secondAccessToken = refreshed.payload?.accessToken;
  if (!secondAccessToken || secondAccessToken === firstAccessToken) {
    throw new Error("Trader refresh did not rotate the access token.");
  }
  const secondCookie = refreshCookie(refreshed.response);

  const secondAccounts = await request("/v1/auth/accounts", { accessToken: secondAccessToken });
  const refreshedIds = (secondAccounts.payload?.accounts || []).map(item => String(item?.id || "")).filter(Boolean);
  if (!refreshedIds.includes(String(launch.selectedPlatformAccountId))) {
    throw new Error("Refreshed session lost the selected platform account grant.");
  }

  await request("/v1/auth/logout", {
    method: "POST",
    accessToken: secondAccessToken,
    cookie: secondCookie,
    refresh: true,
  });

  console.log("[launch-readiness] auth-smoke PASS", JSON.stringify({
    fundedAccountId: ACCOUNT_ID,
    selectedPlatformAccountId: launch.selectedPlatformAccountId,
    grantedAccounts: accountIds.length,
    exchange: "PASS",
    accounts: "PASS",
    refresh: "PASS",
    postRefreshAccounts: "PASS",
    logout: "PASS",
  }));
}

main()
  .catch(error => {
    console.error("[launch-readiness] FAIL", JSON.stringify({
      message: error?.message || String(error),
      code: error?.code || null,
      status: error?.status || null,
    }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
