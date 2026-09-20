function requiredEmailConfig() {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.TRADING_EMAIL_FROM || "").trim();
  if (!apiKey || !from) {
    const error = new Error("Transactional email is not configured.");
    error.code = "EMAIL_NOT_CONFIGURED";
    throw error;
  }
  return { apiKey, from };
}

export async function sendTradingCredentialsEmail({
  to,
  login,
  password,
  accountId,
  accountSize,
  accountMode,
  challengeType,
  leverage = 100,
  tenantId = null,
}) {
  const { apiKey, from } = requiredEmailConfig();
  const recipient = String(to || "").trim().toLowerCase();
  if (!recipient) throw new Error("Credential email recipient is required.");

  const traderUrl = String(process.env.ACG_TRADER_FRONTEND_URL || "").trim();
  const tenant = String(tenantId || process.env.ACG_TRADER_TENANT || "acg-funded").trim();
  const isTrial = String(accountMode || "").toUpperCase() === "DEMO";
  const subject = isTrial
    ? "Your ACG Trader free trial is ready"
    : "Your ACG Trader account is ready";

  const label = isTrial
    ? "Free Trial"
    : String(challengeType || "").toUpperCase() === "TWO_STEP" ? "2-Step Evaluation" : "1-Step Evaluation";

  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#050505;color:#f5f5f5;font-family:Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;padding:36px 20px">
      <div style="font-size:20px;font-weight:800;letter-spacing:-.02em">ACG Trader</div>
      <h1 style="font-size:24px;line-height:1.2;margin:28px 0 8px">Your trading account is ready</h1>
      <p style="color:#a3a3a3;font-size:14px;line-height:1.6;margin:0 0 24px">Use these credentials when opening ACG Trader directly. You can still use the Open ACG Trader button in your ACG Funded dashboard for one-click access.</p>
      <div style="border:1px solid #262626;border-radius:12px;background:#0a0a0a;padding:20px">
        <div style="font-size:12px;color:#737373;margin-bottom:5px">Account</div>
        <div style="font-size:15px;font-weight:700;margin-bottom:16px">${escapeHtml(accountId)}</div>
        <div style="font-size:12px;color:#737373;margin-bottom:5px">Program</div>
        <div style="font-size:15px;font-weight:700;margin-bottom:16px">${escapeHtml(label)} · $${Number(accountSize || 0).toLocaleString("en-US")}</div>
        <div style="font-size:12px;color:#737373;margin-bottom:5px">Tenant ID</div>
        <div style="font-family:monospace;font-size:15px;font-weight:800;margin-bottom:16px">${escapeHtml(tenant)}</div>
        <div style="font-size:12px;color:#737373;margin-bottom:5px">Trading login</div>
        <div style="font-family:monospace;font-size:18px;font-weight:800;margin-bottom:16px">${escapeHtml(login)}</div>
        <div style="font-size:12px;color:#737373;margin-bottom:5px">Password</div>
        <div style="font-family:monospace;font-size:18px;font-weight:800;margin-bottom:16px">${escapeHtml(password)}</div>
        <div style="font-size:12px;color:#737373;margin-bottom:5px">Leverage</div>
        <div style="font-size:15px;font-weight:700">1:${Number(leverage || 100)}</div>
      </div>
      ${traderUrl ? `<a href="${escapeHtml(traderUrl)}" style="display:block;text-align:center;margin-top:20px;background:#fff;color:#000;text-decoration:none;font-size:14px;font-weight:800;padding:13px 18px;border-radius:9px">Open ACG Trader</a>` : ""}
      <p style="color:#626262;font-size:11px;line-height:1.5;margin-top:24px">Keep your trading password private. You can reveal or reset it from your authenticated ACG Funded dashboard.</p>
    </div>
  </body>
</html>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [recipient], subject, html }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.message || `Email provider failed (${response.status}).`);
    error.code = "EMAIL_SEND_FAILED";
    error.status = response.status;
    throw error;
  }
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
