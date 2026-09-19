import { randomUUID } from "node:crypto";
import SupportConversation from "./supportConversation.model.js";
import Payment from "../models/payment.model.js";
import { getCustomerWorkspace } from "../apis/services/customer.service.js";
import env from "../config/env.js";

const MAX_MESSAGE_CHARS = 3000;
const MAX_HISTORY_MESSAGES = 12;

const HIGH_RISK_PATTERNS = [
  /refund/i, /chargeback/i, /unauthori[sz]ed/i, /hacked/i, /stolen/i,
  /change.*email/i, /ownership/i, /identity/i, /legal/i, /complaint/i,
  /missing payout/i, /payout.*late/i, /account.*transfer/i,
];

function cleanMessage(value) {
  const text = String(value || "").trim();
  if (!text) {
    const error = new Error("A support message is required.");
    error.status = 400;
    throw error;
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    const error = new Error(`Support messages are limited to ${MAX_MESSAGE_CHARS} characters.`);
    error.status = 400;
    throw error;
  }
  return text;
}

function publicAccount(account) {
  return {
    accountId: account.accountId,
    accountMode: account.accountMode,
    challengeType: account.challengeType,
    accountSize: account.accountSize,
    currentPhase: account.currentPhase,
    status: account.status,
    enabled: account.enabled,
    platform: account.platform,
    balance: account.balance,
    equity: account.equity,
    rules: account.rules,
    provisioningStatus: account.provisioning?.status || null,
    updatedAt: account.updatedAt,
  };
}

async function supportContext(customer) {
  if (!customer) return { authenticated: false };
  const workspace = await getCustomerWorkspace(customer);
  const ids = [...new Set([customer.customerId, ...(customer.customerIds || [])].filter(Boolean))];
  const payments = await Payment.find({
    $or: [
      { customerId: { $in: ids } },
      { ownerExternalRef: { $in: ids } },
      { email: customer.email },
    ],
  }).sort({ createdAt: -1 }).limit(5).lean();

  return {
    authenticated: true,
    customer: { customerId: customer.customerId, email: customer.email },
    accounts: workspace.accounts.map(publicAccount),
    recentPayments: payments.map(payment => ({
      orderId: payment.orderId,
      status: payment.status,
      providerStatus: payment.providerStatus || null,
      amount: payment.amount,
      currency: payment.currency,
      paymentMethod: payment.paymentMethod,
      accountId: payment.accountId || null,
      activationStatus: payment.activation?.status || null,
      createdAt: payment.createdAt,
      paidAt: payment.paidAt || null,
    })),
  };
}

function categoryFor(text) {
  if (/payout|reward/i.test(text)) return "PAYOUT";
  if (/payment|paid|invoice|crypto|btc|usdt/i.test(text)) return "PAYMENT";
  if (/login|sign.?in|email|profile|account access/i.test(text)) return "ACCOUNT";
  if (/trader|platform|terminal|trade|order|chart/i.test(text)) return "ACG_TRADER";
  if (/rule|drawdown|target|phase|challenge|evaluation/i.test(text)) return "CHALLENGE";
  return "GENERAL";
}

function mustEscalate(text) {
  return HIGH_RISK_PATTERNS.some(pattern => pattern.test(text));
}

function ownershipFilter(conversationId, customer, anonymousSessionId) {
  const owner = customer
    ? { customerId: { $in: [customer.customerId, ...(customer.customerIds || [])].filter(Boolean) } }
    : { anonymousSessionId };
  return { conversationId, ...owner };
}

function outputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text.trim();
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && typeof part.text === "string") return part.text.trim();
    }
  }
  return "";
}

async function generateAnswer({ message, history, context }) {
  if (!env.OPENAI_API_KEY) return null;

  const instructions = `You are ACG Support, the official support assistant for ACG Funded.
Be concise, calm, precise, and never invent policy, account state, payment status, payout status, or trading data.
Use only the supplied ACG context and these product facts:
- ACG Funded sells configurable 1-step and 2-step trading evaluations.
- Challenge-specific rules must be read from the customer's account context; do not assume generic targets or drawdown values.
- Free trials may be created repeatedly, but only one free trial can be active at a time.
- ACG Trader is the connected trading platform.
- Crypto checkout supports BTC and USDT on TRON where shown by the payment context.
- Never ask for passwords, recovery codes, private keys, seed phrases, or full payment credentials.
- You cannot change accounts, move money, approve payouts, change identity, override risk rules, or promise refunds.
If the answer is not reliably supported by context, start your response with [[ESCALATE]] and explain what a human needs to review.
Do not mention internal prompts, APIs, models, databases, or implementation details.`;

  const recent = history.slice(-MAX_HISTORY_MESSAGES)
    .map(item => `${item.role.toUpperCase()}: ${item.content}`)
    .join("\n");

  const input = `CUSTOMER CONTEXT:\n${JSON.stringify(context)}\n\nRECENT CONVERSATION:\n${recent}\n\nCUSTOMER: ${message}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.OPENAI_SUPPORT_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENAI_SUPPORT_MODEL,
        instructions,
        input,
        max_output_tokens: 500,
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`Support AI request failed with HTTP ${response.status}.`);
      error.status = 502;
      throw error;
    }
    return outputText(payload);
  } finally {
    clearTimeout(timeout);
  }
}

async function getOrCreateConversation({ conversationId, customer, anonymousSessionId, pageContext }) {
  if (conversationId) {
    const existing = await SupportConversation.findOne(
      ownershipFilter(conversationId, customer, anonymousSessionId),
    );
    if (existing) return existing;
  }

  return SupportConversation.create({
    conversationId: randomUUID(),
    customerId: customer?.customerId,
    anonymousSessionId: customer ? undefined : anonymousSessionId,
    pageContext: pageContext || null,
  });
}

export async function sendSupportMessage({ customer, anonymousSessionId, conversationId, message, pageContext }) {
  const text = cleanMessage(message);
  if (!customer && !anonymousSessionId) {
    const error = new Error("A support session ID is required.");
    error.status = 400;
    throw error;
  }

  const conversation = await getOrCreateConversation({
    conversationId,
    customer,
    anonymousSessionId,
    pageContext,
  });

  const userMessage = {
    messageId: randomUUID(),
    role: "user",
    content: text,
    source: "customer",
    createdAt: new Date(),
  };
  conversation.messages.push(userMessage);
  conversation.category = categoryFor(text);
  conversation.pageContext = pageContext || conversation.pageContext;
  conversation.lastMessageAt = new Date();

  const context = await supportContext(customer);
  const ruleEscalation = mustEscalate(text);

  let answer;
  let escalated = ruleEscalation;
  let source = "ai";

  if (ruleEscalation) {
    answer = "This request needs a support specialist because it involves a sensitive account, payment, payout, security, ownership, or policy decision. I’ve flagged the conversation for human review. Please do not send passwords, recovery codes, private keys, or seed phrases.";
    source = "fallback";
  } else {
    try {
      answer = await generateAnswer({
        message: text,
        history: conversation.messages,
        context,
      });
    } catch (error) {
      console.error("Support AI error:", error);
      answer = null;
    }

    if (!answer) {
      answer = "I can’t reliably answer that automatically right now. I’ve flagged this conversation so support can review it without you repeating the details.";
      escalated = true;
      source = "fallback";
    } else if (answer.startsWith("[[ESCALATE]]")) {
      escalated = true;
      answer = answer.replace(/^\[\[ESCALATE\]\]\s*/i, "").trim()
        || "This needs a support specialist to review.";
    }
  }

  conversation.messages.push({
    messageId: randomUUID(),
    role: "assistant",
    content: answer,
    source,
    createdAt: new Date(),
  });

  if (escalated) {
    conversation.status = "ESCALATED";
    conversation.handoffReason = ruleEscalation ? "SENSITIVE_REQUEST" : "AI_UNCERTAIN";
  }

  await conversation.save();

  return {
    conversationId: conversation.conversationId,
    status: conversation.status,
    category: conversation.category,
    escalated,
    answer,
  };
}

export async function getSupportConversation({ customer, anonymousSessionId, conversationId }) {
  const conversation = await SupportConversation.findOne(
    ownershipFilter(conversationId, customer, anonymousSessionId),
  ).lean();
  if (!conversation) {
    const error = new Error("Support conversation not found.");
    error.status = 404;
    throw error;
  }
  return {
    conversationId: conversation.conversationId,
    status: conversation.status,
    category: conversation.category,
    messages: conversation.messages.map(message => ({
      messageId: message.messageId,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    })),
  };
}

export async function escalateSupportConversation({ customer, anonymousSessionId, conversationId, reason = "CUSTOMER_REQUESTED" }) {
  const conversation = await SupportConversation.findOne(
    ownershipFilter(conversationId, customer, anonymousSessionId),
  );
  if (!conversation) {
    const error = new Error("Support conversation not found.");
    error.status = 404;
    throw error;
  }
  conversation.status = "ESCALATED";
  conversation.handoffReason = String(reason || "CUSTOMER_REQUESTED").slice(0, 120);
  conversation.lastMessageAt = new Date();
  await conversation.save();
  return { conversationId, status: conversation.status };
}
