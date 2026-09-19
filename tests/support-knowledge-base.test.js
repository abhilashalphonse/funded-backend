import test from "node:test";
import assert from "node:assert/strict";
import { scoreKnowledgeArticle } from "../src/support/knowledgeBase.service.js";

test("knowledge retrieval strongly matches exact support topics", () => {
  const payment = {
    title: "Payments",
    summary: "Supported checkout methods and payment-state handling.",
    content: "BTC and USDT payment status.",
    keywords: ["payment", "btc", "usdt", "invoice"],
    category: "PAYMENT",
  };
  const payout = {
    title: "Payouts",
    summary: "Payout terms.",
    content: "Profit split and payout frequency.",
    keywords: ["payout", "reward"],
    category: "PAYOUT",
  };

  const paymentScore = scoreKnowledgeArticle(payment, "My BTC payment is still confirming", "PAYMENT");
  const payoutScore = scoreKnowledgeArticle(payout, "My BTC payment is still confirming", "PAYMENT");

  assert.ok(paymentScore > payoutScore);
});

test("challenge category boosts risk and phase knowledge", () => {
  const risk = {
    title: "Daily and maximum drawdown",
    summary: "Risk limits.",
    content: "Daily loss and maximum loss.",
    keywords: ["drawdown", "daily loss"],
    category: "RISK",
  };

  assert.ok(scoreKnowledgeArticle(risk, "How is my drawdown calculated?", "CHALLENGE") > 5);
});
