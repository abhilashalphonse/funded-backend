import { pathToFileURL } from "node:url";

const TARGET = Object.freeze({
  projectId: "b1855fe2-326b-47e4-889a-1c5a620d6ac5",
  environmentId: "9bf760f4-11d3-4c47-8181-0ec369251283",
  serviceId: "59694cbf-60fb-4cb1-ba60-eaccce86cdb9",
  trader: "https://discerning-presence-staging.up.railway.app",
  confirmation: "RELIANCE-STAGING-FIXTURE-ONLY",
});

export function assertStage6FixtureEnvironment(env = process.env) {
  const checks = [
    ["RAILWAY_PROJECT_ID", TARGET.projectId],
    ["RAILWAY_ENVIRONMENT_ID", TARGET.environmentId],
    ["RAILWAY_SERVICE_ID", TARGET.serviceId],
    ["STAGE6_FIXTURE_ONE_SHOT_CONFIRM", TARGET.confirmation],
  ];
  for (const [key, value] of checks) {
    if (String(env[key] || "").trim() !== value) throw new Error("STAGE6_GUARD: incorrect " + key);
  }
  if (String(env.RAILWAY_ENVIRONMENT_NAME || "").toUpperCase() !== "STAGING") {
    throw new Error("STAGE6_GUARD: require STAGING");
  }
  if (String(env.ACG_TRADER_BASE_URL || "").replace(/\/+$/, "") !== TARGET.trader) {
    throw new Error("STAGE6_GUARD: require pinned Trader staging");
  }
  if (!/^stage6-[a-z0-9-]{8,60}$/i.test(String(env.STAGE6_FIXTURE_ONCE_ID || ""))) {
    throw new Error("STAGE6_GUARD: named one-shot idempotency key required");
  }
  if (String(env.ACG_FUNDED_RISK_POLICY_VERSION || "").toUpperCase() !== "ACG_FUNDED_V2"
    || String(env.TRADING_PROVIDER || "").toLowerCase() !== "acg-trader") {
    throw new Error("STAGE6_GUARD: V2 and Trader provider required");
  }
  return true;
}

async function requestJson(route, { method = "GET", body, bearer } = {}) {
  const response = await fetch(TARGET.trader + route, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(bearer ? { authorization: "Bearer " + bearer } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Trader staging " + method + " " + route + " returned HTTP " + response.status);
  return response.json();
}

export async function runStage6FixturePreflight(env = process.env) {
  // Refuse all non-staging contexts before importing app services or accessing DB.
  assertStage6FixtureEnvironment(env);
  const mongoose = (await import("mongoose")).default;
  const { connectDatabase } = await import("../src/config/database.js");
  const { createAcceptanceFixture, getAcceptanceRun } = await import("../src/maintenance/adminLaunchReadiness.js");
  const { createCustomerTradingLaunch } = await import("../src/apis/services/tradingLaunch.service.js");

  const operationId = String(env.STAGE6_FIXTURE_ONCE_ID);
  let runId = null;
  try {
    await connectDatabase();
    const journal = mongoose.connection.db.collection("stage6AutonomousFixtureRuns");
    const claim = await journal.updateOne(
      { _id: operationId },
      { $setOnInsert: { status: "CLAIMED", createdAt: new Date(), scope: "FUNDED_STAGING_ONLY" } },
      { upsert: true },
    );
    let record = await journal.findOne({ _id: operationId });
    if (claim.upsertedCount === 0 && !record?.runId) {
      throw new Error("STAGE6_ALREADY_CLAIMED: refusing duplicate fixture creation");
    }

    if (!record?.runId) {
      const created = await createAcceptanceFixture({
        createdBy: "stage6-railway-staging-operator@acgfunded.test",
        symbol: "RELIANCE",
        volume: "0.001",
      });
      runId = created.runId;
      await journal.updateOne({ _id: operationId }, {
        $set: { runId, status: "FIXTURE_CREATED", fixtureCreatedAt: new Date() },
      });
      record = await journal.findOne({ _id: operationId });
    }

    runId = String(record.runId);
    const run = await getAcceptanceRun(runId);
    const fixture = run.fixture || {};
    if (run.status !== "READY" || run.symbol !== "RELIANCE"
        || !/^acceptance\+.*@acgfunded\.test$/i.test(String(fixture.email || ""))
        || !/^[a-f0-9]{24}$/i.test(String(fixture.challengeAPlatformAccountId || ""))) {
      throw new Error("Stage 6 fixture is not a fresh active acceptance account");
    }
    const context = {
      id: fixture.customerId,
      customerId: fixture.customerId,
      customerIds: [fixture.customerId],
      email: fixture.email,
      status: "ACTIVE",
      metadata: { acceptanceFixture: true },
    };
    const launch = await createCustomerTradingLaunch(context, fixture.challengeAId);
    const ticket = new URL(launch.launchUrl).searchParams.get("ticket");
    if (!ticket) throw new Error("Staging trading launch has no federation ticket");

    const exchange = await requestJson("/v1/auth/federated/exchange", {
      method: "POST", body: { ticket },
    });
    const token = String(exchange.accessToken || "");
    if (!token) throw new Error("Trader federation exchange failed");

    const grants = await requestJson("/v1/auth/accounts", { bearer: token });
    if (!(grants.accounts || []).some(item =>
      String(item.id || item._id || item.accountId || "") === String(fixture.challengeAPlatformAccountId))) {
      throw new Error("Federation session does not grant dedicated test account");
    }
    const [valuation, instrumentResult] = await Promise.all([
      requestJson("/v1/trading/accounts/" + fixture.challengeAPlatformAccountId + "/valuation", { bearer: token }),
      requestJson("/v1/instruments/RELIANCE"),
    ]);
    if (valuation.complete !== true || Number(valuation.positionCount) !== 0
        || Number(valuation.usedMargin || 0) !== 0) {
      throw new Error("Acceptance account valuation must be complete and flat");
    }
    const spec = instrumentResult?.instrument;
    if (spec?.symbol !== "RELIANCE" || spec.quoteCurrency !== "INR"
        || Number(spec.defaultLeverage) !== 10 || Number(spec.leveragePolicyVersion) !== 2
        || spec.corporateActionPolicy !== "UNSUPPORTED") {
      throw new Error("Staging RELIANCE policy mismatch");
    }

    const result = {
      status: "PREFLIGHT_PASS",
      environment: "FUNDED_STAGING_ONLY",
      runId,
      challengeId: fixture.challengeAId,
      platformAccountId: fixture.challengeAPlatformAccountId,
      flatValuation: true,
      federationGranted: true,
      pilotExecutionEnabled: spec.executionEnabled === true,
      nseSessionOpen: spec.sessionOpen === true,
    };
    // Print no JWT, no ticket, no DB URI, no API keys.
    console.log("STAGE6_FIXTURE_RESULT " + JSON.stringify(result));
    await journal.updateOne({ _id: operationId }, {
      $set: { status: "PREFLIGHT_PASS", preflightAt: new Date(), result },
    });
    return result;
  } catch (error) {
    // The error string is deliberately generic; no credential-bearing response bodies.
    console.error("STAGE6_FIXTURE_ERROR " + JSON.stringify({
      status: "BLOCKED", runId, errorType: String(error?.code || error?.name || "Error"),
    }));
    throw new Error("Stage 6 fixture preflight failed; consult staging operator logs");
  } finally {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStage6FixturePreflight().catch(() => { process.exitCode = 1; });
}
