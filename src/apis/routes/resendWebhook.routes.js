import { Router } from "express";
import Customer from "../../customers/customer.model.js";
import SupportConversation from "../../support/supportConversation.model.js";
import {
  escalateSupportConversation,
  sendSupportMessage,
} from "../../support/support.service.js";
import {
  extractEmailAddress,
  normalizeEmailSubject,
  replySubject,
  retrieveReceivedEmail,
  sendSupportEmail,
  verifyResendWebhook,
} from "../../email/resendSupport.service.js";

const router = Router();

const HUMAN_REVIEW_PATTERNS = [
  /refund/i,
  /chargeback/i,
  /unauthori[sz]ed/i,
  /hacked/i,
  /stolen/i,
  /identity/i,
  /legal/i,
  /complaint/i,
  /missing payout/i,
  /payout.*late/i,
  /account.*transfer/i,
  /execution dispute/i,
  /wrong (fill|price|execution)/i,
  /breach.*wrong/i,
];

function needsHumanReview(text) {
  return HUMAN_REVIEW_PATTERNS.some(pattern => pattern.test(String(text || "")));
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function trimQuotedReply(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  const markers = [
    /^On .+wrote:$/im,
    /^From:\s.+$/im,
    /^-----Original Message-----$/im,
  ];
  let cut = value.length;
  for (const marker of markers) {
    const match = marker.exec(value);
    if (match && match.index < cut) cut = match.index;
  }
  return value.slice(0, cut).trim().slice(0, 3000);
}

async function resolveCustomer(email) {
  if (!email) return null;
  const customer = await Customer.findOne({
    $or: [
      { primaryEmail: email },
      { emailAliases: email },
    ],
    status: { $ne: "MERGED" },
  }).lean();
  if (!customer) return null;
  return {
    customerId: customer.customerId,
    customerIds: [customer.customerId],
    email: customer.primaryEmail,
  };
}

async function notifyHuman(conversation, inboundText) {
  const humanEmail = String(process.env.SUPPORT_HUMAN_EMAIL || "").trim().toLowerCase();
  if (!humanEmail) return;

  const adminUrl = String(process.env.FRONTEND_URL || "").replace(/\/$/, "");
  const url = adminUrl
    ? `${adminUrl}/admin?page=support&case=${encodeURIComponent(conversation.conversationId)}`
    : "";

  const subject = `[ACG Support] Human review: ${conversation.email?.subject || conversation.category || "Support case"}`;
  const text = [
    "A support case needs human review.",
    "",
    `Case: ${conversation.conversationId}`,
    `Customer: ${conversation.email?.customerEmail || conversation.customerId || "Unknown"}`,
    `Category: ${conversation.category || "GENERAL"}`,
    `Reason: ${conversation.handoffReason || "HUMAN_REVIEW"}`,
    "",
    "Latest message:",
    String(inboundText || "").slice(0, 2000),
    url ? `\nOpen admin: ${url}` : "",
  ].join("\n");

  await sendSupportEmail({
    to: humanEmail,
    subject,
    text,
    idempotencyKey: `support-human/${conversation.conversationId}/${conversation.email?.lastInboundResendId || Date.now()}`,
  });
}

router.post("/", async (req, res, next) => {
  try {
    const event = verifyResendWebhook(req.body, req.headers);
    if (event?.type !== "email.received") {
      return res.json({ success: true, ignored: true });
    }

    const metadata = event.data || {};
    const resendEmailId = String(metadata.email_id || "").trim();
    if (!resendEmailId) return res.status(400).json({ success: false, message: "Missing received email ID." });

    const duplicate = await SupportConversation.findOne({ "email.resendInboundIds": resendEmailId }).lean();
    if (duplicate) return res.json({ success: true, duplicate: true, conversationId: duplicate.conversationId });

    const received = await retrieveReceivedEmail(resendEmailId);
    const sender = extractEmailAddress(received?.from || metadata.from);
    if (!sender) return res.status(400).json({ success: false, message: "Unable to determine sender email." });

    const configuredSenders = [
      process.env.SUPPORT_EMAIL_FROM,
      process.env.TRADING_EMAIL_FROM,
    ].map(extractEmailAddress).filter(Boolean);
    if (configuredSenders.includes(sender)) {
      return res.json({ success: true, ignored: true, reason: "self_sender" });
    }

    const to = Array.isArray(received?.to) ? received.to : (metadata.to || []);
    const inboundAddress = extractEmailAddress(to[0] || "");
    const subject = String(received?.subject || metadata.subject || "Support request").trim().slice(0, 240);
    const threadKey = normalizeEmailSubject(subject) || "support request";
    const body = trimQuotedReply(received?.text || htmlToText(received?.html));
    if (!body) {
      return res.status(422).json({ success: false, message: "Received email has no readable text body." });
    }

    const customer = await resolveCustomer(sender);
    const anonymousSessionId = customer ? "" : `email:${sender}`;

    const existing = await SupportConversation.findOne({
      channel: "EMAIL",
      "email.customerEmail": sender,
      "email.threadKey": threadKey,
      status: { $ne: "CLOSED" },
    }).sort({ lastMessageAt: -1 }).lean();

    const result = await sendSupportMessage({
      customer,
      anonymousSessionId,
      conversationId: existing?.conversationId,
      message: body,
      pageContext: "email",
    });

    const conversation = await SupportConversation.findOne({ conversationId: result.conversationId });
    if (!conversation) throw new Error("Support conversation was not created.");

    conversation.channel = "EMAIL";
    conversation.email = {
      ...(conversation.email?.toObject?.() || conversation.email || {}),
      customerEmail: sender,
      subject,
      threadKey,
      inboundAddress: inboundAddress || conversation.email?.inboundAddress || null,
      lastInboundMessageId: String(received?.message_id || metadata.message_id || "") || null,
      lastInboundResendId: resendEmailId,
      resendInboundIds: [
        ...new Set([...(conversation.email?.resendInboundIds || []), resendEmailId]),
      ].slice(-100),
    };

    const shouldEscalate = needsHumanReview(body)
      || !process.env.OPENAI_API_KEY
      || /can.?t reliably answer|support specialist|human review/i.test(result.answer || "");

    let outboundAnswer = result.answer;
    if (shouldEscalate) {
      conversation.status = "ESCALATED";
      conversation.handoffReason = needsHumanReview(body) ? "SENSITIVE_REQUEST" : "AI_UNCERTAIN";
      outboundAnswer = "Thanks for contacting ACG Funded Support. I’ve attached your message to a support case for human review. You do not need to resend the details. A support specialist will reply to this email thread.";
    }

    await conversation.save();

    const sent = await sendSupportEmail({
      to: sender,
      subject: replySubject(subject),
      text: outboundAnswer,
      inReplyTo: conversation.email?.lastInboundMessageId || undefined,
      references: conversation.email?.lastInboundMessageId || undefined,
      replyTo: conversation.email?.inboundAddress || undefined,
      idempotencyKey: `support-auto/${resendEmailId}`,
    });

    conversation.email.lastOutboundResendId = sent?.id || null;
    conversation.lastMessageAt = new Date();
    await conversation.save();

    if (shouldEscalate) {
      await notifyHuman(conversation, body).catch(error => {
        console.error("support_human_notification_failed", error?.message || error);
      });
    }

    return res.json({
      success: true,
      conversationId: conversation.conversationId,
      status: conversation.status,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
