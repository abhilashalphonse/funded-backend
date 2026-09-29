import test from "node:test";
import assert from "node:assert/strict";
import { retrieveReceivedEmail } from "../src/email/resendSupport.service.js";

test("retrieveReceivedEmail uses Resend receiving endpoint", async () => {
  const previousFetch = globalThis.fetch;
  const previousApiKey = process.env.RESEND_API_KEY;
  const calls = [];

  process.env.RESEND_API_KEY = "re_test_key";
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({
      id: "inbound_email_123",
      from: "Trader <trader@example.com>",
      to: ["support@acgfunded.com"],
      subject: "Help",
      text: "Hello",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = await retrieveReceivedEmail("inbound_email_123");

    assert.equal(result.id, "inbound_email_123");
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://api.resend.com/emails/receiving/inbound_email_123",
    );
    assert.equal(calls[0].options.headers.Authorization, "Bearer re_test_key");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousApiKey;
  }
});
