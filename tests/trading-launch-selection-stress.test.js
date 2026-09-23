import test from "node:test";
import assert from "node:assert/strict";

import { currentPlatformAccount } from "../src/apis/services/tradingLaunch.service.js";

function lifecycleAccount(id, overrides = {}) {
  return {
    accountId: id,
    status: "ACTIVE",
    enabled: true,
    currentPhase: 1,
    platform: "acg-trader",
    platformAccountId: id + "-p1",
    platformAccounts: [
      { phase: 1, accountType: "CHALLENGE", platformAccountId: id + "-p1", status: "ACTIVE" },
    ],
    ...overrides,
  };
}

test("current platform account advances Phase 1 -> Phase 2 -> Master and never falls back", () => {
  const account = lifecycleAccount("challenge-1");

  assert.equal(currentPlatformAccount(account)?.platformAccountId, "challenge-1-p1");

  account.currentPhase = 2;
  account.status = "PHASE_2";
  account.platformAccountId = "challenge-1-p2";
  account.platformAccounts = [
    { phase: 1, accountType: "CHALLENGE", platformAccountId: "challenge-1-p1", status: "COMPLETED" },
    { phase: 2, accountType: "CHALLENGE", platformAccountId: "challenge-1-p2", status: "ACTIVE" },
  ];
  assert.equal(currentPlatformAccount(account)?.platformAccountId, "challenge-1-p2");

  account.status = "FUNDED_REVIEW";
  account.enabled = false;
  account.platformAccounts[1].status = "COMPLETED";
  assert.equal(currentPlatformAccount(account), null);

  account.platformAccounts.push({
    phase: 2,
    accountType: "FUNDED",
    platformAccountId: "challenge-1-master",
    status: "PAUSED",
  });
  assert.equal(currentPlatformAccount(account), null);

  account.status = "FUNDED";
  account.enabled = true;
  account.platformAccountId = "challenge-1-master";
  account.platformAccounts[2].status = "ACTIVE";
  assert.equal(currentPlatformAccount(account)?.platformAccountId, "challenge-1-master");
});

test("parallel customer accounts resolve independently under lifecycle stress", () => {
  const accounts = Array.from({ length: 40 }, (_, index) => lifecycleAccount("challenge-" + (index + 1)));

  for (let cycle = 0; cycle < 25; cycle += 1) {
    for (const account of accounts) {
      assert.equal(currentPlatformAccount(account)?.platformAccountId, account.accountId + "-p1");
    }
  }

  for (const account of accounts) {
    account.currentPhase = 2;
    account.status = "PHASE_2";
    account.platformAccountId = account.accountId + "-p2";
    account.platformAccounts[0].status = "COMPLETED";
    account.platformAccounts.push({
      phase: 2,
      accountType: "CHALLENGE",
      platformAccountId: account.accountId + "-p2",
      status: "ACTIVE",
    });
  }

  for (let cycle = 0; cycle < 25; cycle += 1) {
    for (const account of accounts) {
      assert.equal(currentPlatformAccount(account)?.platformAccountId, account.accountId + "-p2");
    }
  }

  for (const account of accounts) {
    account.status = "FUNDED_REVIEW";
    account.enabled = false;
    account.platformAccounts[1].status = "COMPLETED";
    account.platformAccounts.push({
      phase: 2,
      accountType: "FUNDED",
      platformAccountId: account.accountId + "-master",
      status: "ACTIVE",
    });
  }

  for (const account of accounts) {
    assert.equal(currentPlatformAccount(account), null);
  }

  for (const account of accounts) {
    account.status = "FUNDED";
    account.enabled = true;
    account.platformAccountId = account.accountId + "-master";
  }

  for (let cycle = 0; cycle < 25; cycle += 1) {
    for (const account of accounts) {
      assert.equal(currentPlatformAccount(account)?.platformAccountId, account.accountId + "-master");
    }
  }
});

test("superseded or paused records are never selected as the current launch account", () => {
  const account = lifecycleAccount("challenge-x", {
    currentPhase: 2,
    status: "PHASE_2",
    platformAccountId: "challenge-x-p2",
    platformAccounts: [
      { phase: 1, accountType: "CHALLENGE", platformAccountId: "challenge-x-p1", status: "ACTIVE" },
      { phase: 2, accountType: "CHALLENGE", platformAccountId: "challenge-x-p2", status: "PAUSED" },
      { phase: 2, accountType: "FUNDED", platformAccountId: "challenge-x-master", status: "ACTIVE" },
    ],
  });

  assert.equal(currentPlatformAccount(account), null);
});
