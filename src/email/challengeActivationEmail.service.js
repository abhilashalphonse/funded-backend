import process from "node:process";

function config() {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.SUPPORT_EMAIL_FROM || process.env.TRADING_EMAIL_FROM || "").trim();
  if (!apiKey || !from) {
    const error = new Error("Challenge activation email is not configured.");
    error.code = "EMAIL_NOT_CONFIGURED";
    throw error;
  }
  return { apiKey, from };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function percent(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? \`\${numeric}%\` : "—";
}

function paymentMethodLabel(value) {
  const method = String(value || "").toUpperCase();
  if (method === "UPI") return "UPI";
  if (method === "BTC") return "Bitcoin (BTC)";
  if (method === "USDT_TRX") return "USDT · TRC20";
  return method || "—";
}

function programLabel(definition = {}) {
  return String(definition?.step || "").toLowerCase() === "2step" ? "2-Step Challenge" : "1-Step Challenge";
}

function appUrl(path = "/") {
  const base = String(process.env.FRONTEND_URL || "").trim().replace(/\/$/, "");
  if (!base) return "";
  return \`\${base}\${path.startsWith("/") ? path : \`/\${path}\`}\`;
}

export async function sendChallengeActivationEmail({ to, payment, registered = false }) {
  const { apiKey, from } = config();
  const recipient = String(to || "").trim().toLowerCase();
  if (!recipient) throw new Error("Challenge activation email recipient is required.");
  if (!payment?.accountId) throw new Error("Challenge activation email requires an activated account.");

  const definition = payment.challengeDefinition || {};
  const commercial = payment.commercialConfig || {};
  const rules = definition.rules || {};
  const accountSize = Number(definition.accountSize || 0);
  const program = programLabel(definition);
  const isTwoStep = String(definition.step || "").toLowerCase() === "2step";
  const phase1Target = rules.phase1ProfitTarget ?? rules.profitTarget;
  const paidAt = payment.paidAt || payment.activatedAt || new Date();
  const purchaseDate = new Date(paidAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const paymentId = String(payment._id || "");
  const accountId = String(payment.accountId);
  const email = String(payment.email || recipient).toLowerCase();

  const params = new URLSearchParams({
    postPurchase: registered ? "dashboard" : "claim",
    accountId,
    email,
  });
  const primaryUrl = appUrl(\`/?\${params.toString()}\`);
  const rulesUrl = appUrl("/rules");
  const primaryLabel = registered ? "Open My Dashboard" : "Set Up My ACG Funded Account";

  const ruleRows = [
    ["Phase 1 Target", percent(phase1Target)],
    ...(isTwoStep ? [["Phase 2 Target", percent(rules.phase2ProfitTarget)]] : []),
    ["Daily Loss", percent(rules.dailyLoss)],
    ["Maximum Loss", percent(rules.maxLoss)],
    ["Minimum Trading Days", Number.isFinite(Number(rules.minTradingDays)) ? String(rules.minTradingDays) : "—"],
    ["Profit Split", percent(commercial.profitSplit)],
    ["Leverage", "1:100"],
    ["Payout Cycle", String(commercial.payoutFrequency || "—")],
    ["News Trading", commercial.newsTrading === true ? "Allowed" : commercial.newsTrading === false ? "Not allowed" : "—"],
    ["Weekend Holding", commercial.weekendHolding === true ? "Allowed" : commercial.weekendHolding === false ? "Not allowed" : "—"],
  ];

  const ruleHtml = ruleRows.map(([label, value]) => \`
    <tr>
      <td style="padding:8px 0;color:#8a8a8a;font-size:13px">\${escapeHtml(label)}</td>
      <td style="padding:8px 0;text-align:right;color:#f5f5f5;font-size:13px;font-weight:700">\${escapeHtml(value)}</td>
    </tr>
  \`).join("");

  const html = \`<!doctype html>
<html>
  <body style="margin:0;background:#050505;color:#f5f5f5;font-family:Arial,sans-serif">
    <div style="max-width:600px;margin:0 auto;padding:36px 20px">
      <div style="font-size:20px;font-weight:800;letter-spacing:-.02em">ACG Funded</div>
      <h1 style="font-size:27px;line-height:1.2;margin:30px 0 10px">Congratulations — your challenge is ready</h1>
      <p style="color:#a3a3a3;font-size:14px;line-height:1.65;margin:0 0 24px">Your ACG Funded Challenge has been activated and your ACG Trader account is ready.</p>

      <div style="border:1px solid #262626;border-radius:14px;background:#0a0a0a;padding:20px;margin-bottom:18px">
        <div style="font-size:28px;font-weight:800;margin-bottom:4px">$\${accountSize.toLocaleString("en-US")}</div>
        <div style="color:#a3a3a3;font-size:14px;margin-bottom:18px">\${escapeHtml(program)}</div>
        <div style="font-size:12px;color:#737373;margin-bottom:5px">Account ID</div>
        <div style="font-family:monospace;font-size:16px;font-weight:800;margin-bottom:14px">\${escapeHtml(accountId)}</div>
        <div style="font-size:12px;color:#737373;margin-bottom:5px">Platform</div>
        <div style="font-size:14px;font-weight:700">ACG Trader · Active</div>
      </div>

      <div style="border:1px solid #262626;border-radius:14px;background:#0a0a0a;padding:20px;margin-bottom:18px">
        <div style="font-size:14px;font-weight:800;margin-bottom:10px">Challenge Rules</div>
        <table style="width:100%;border-collapse:collapse">\${ruleHtml}</table>
      </div>

      <div style="border:1px solid #262626;border-radius:14px;background:#0a0a0a;padding:20px">
        <div style="font-size:14px;font-weight:800;margin-bottom:10px">Purchase</div>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#8a8a8a;font-size:13px">Challenge Fee</td><td style="padding:8px 0;text-align:right;font-size:13px;font-weight:700">$\${Number(payment.amount || 0).toFixed(2)}</td></tr>
          <tr><td style="padding:8px 0;color:#8a8a8a;font-size:13px">Payment Method</td><td style="padding:8px 0;text-align:right;font-size:13px;font-weight:700">\${escapeHtml(paymentMethodLabel(payment.paymentMethod))}</td></tr>
          <tr><td style="padding:8px 0;color:#8a8a8a;font-size:13px">Payment Date</td><td style="padding:8px 0;text-align:right;font-size:13px;font-weight:700">\${escapeHtml(purchaseDate)}</td></tr>
          <tr><td style="padding:8px 0;color:#8a8a8a;font-size:13px">Payment Reference</td><td style="padding:8px 0;text-align:right;font-family:monospace;font-size:12px;font-weight:700">\${escapeHtml(paymentId)}</td></tr>
        </table>
      </div>

      \${!registered ? \`<p style="color:#a3a3a3;font-size:13px;line-height:1.6;margin:22px 0 0">Your purchase is secured to <strong style="color:#f5f5f5">\${escapeHtml(email)}</strong>. Set up your ACG Funded account using this email to access the Challenge.</p>\` : ""}

      \${primaryUrl ? \`<a href="\${escapeHtml(primaryUrl)}" style="display:block;text-align:center;margin-top:22px;background:#fff;color:#000;text-decoration:none;font-size:14px;font-weight:800;padding:14px 18px;border-radius:9px">\${escapeHtml(primaryLabel)}</a>\` : ""}
      \${rulesUrl ? \`<a href="\${escapeHtml(rulesUrl)}" style="display:block;text-align:center;margin-top:10px;color:#b5b5b5;text-decoration:none;font-size:12px;font-weight:700;padding:10px">View Challenge Rules</a>\` : ""}

      <p style="color:#626262;font-size:11px;line-height:1.6;margin-top:26px">Need help? Contact support@acgfunded.com. Keep your trading credentials private.</p>
    </div>
  </body>
</html>\`;

  const subject = \`Congratulations — your $\${accountSize.toLocaleString("en-US")} \${program} is ready\`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${apiKey}\`,
      "Content-Type": "application/json",
      "Idempotency-Key": \`challenge-activation-\${paymentId}\`,
    },
    body: JSON.stringify({ from, to: [recipient], subject, html }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.message || \`Email provider failed (\${response.status}).\`);
    error.code = "EMAIL_SEND_FAILED";
    error.status = response.status;
    throw error;
  }
  return payload;
}
