import test from "node:test";
import assert from "node:assert/strict";
import SupportConversation from "../src/support/supportConversation.model.js";
import { sendSupportMessage } from "../src/support/support.service.js";

test("human-owned support case records customer message without an AI reply", async () => {
  const originalFindOne = SupportConversation.findOne;
  let saveCount = 0;

  const conversation = {
    conversationId: "case-human-owned",
    customerId: null,
    anonymousSessionId: "session-1",
    status: "ESCALATED",
    category: "GENERAL",
    pageContext: "/dashboard",
    messages: [],
    lastMessageAt: new Date(0),
    async save() {
      saveCount += 1;
      return this;
    },
  };

  SupportConversation.findOne = async () => conversation;

  try {
    const result = await sendSupportMessage({
      customer: null,
      anonymousSessionId: "session-1",
      conversationId: conversation.conversationId,
      message: "I have another detail for the support specialist.",
      pageContext: "/dashboard",
    });

    assert.equal(result.status, "ESCALATED");
    assert.equal(result.handler, "HUMAN");
    assert.equal(result.humanOwned, true);
    assert.equal(result.answer, null);
    assert.equal(saveCount, 1);
    assert.equal(conversation.messages.length, 1);
    assert.equal(conversation.messages[0].role, "user");
    assert.equal(conversation.messages[0].source, "customer");
  } finally {
    SupportConversation.findOne = originalFindOne;
  }
});
