import { TradingProviderConnector } from "../trading/provider.js";
import { ACGTraderClient } from "./client.js";

export class ACGTraderConnector extends TradingProviderConnector {
  constructor(config = {}) {
    super("acg-trader");
    this.frontendUrl = String(config.frontendUrl || "").replace(/\/+$/, "");
    this.client = config.client || new ACGTraderClient(config);
  }

  async provisionAccount(input) {
    const command = {
      externalRef: required(input.externalRef, "externalRef"),
      ownerExternalRef: required(input.ownerExternalRef, "ownerExternalRef"),
      accountType: input.accountType || "CHALLENGE",
      currency: input.currency || "USD",
      leverage: Number(input.leverage || 100),
      initialBalance: String(input.initialBalance),
      ...(input.accountCode ? { accountCode: String(input.accountCode) } : {}),
      ...(input.riskPolicy ? { riskPolicy: input.riskPolicy } : {}),
      ...(input.riskTimezone ? { riskTimezone: input.riskTimezone } : {}),
      ...(input.metadata ? { metadata: primitiveMetadata(input.metadata) } : {}),
    };

    const result = await this.client.provisionAccount(command);
    const account = result?.account;
    if (!account?.id) throw invalidResponse("Provision response did not contain account.id.");

    return {
      provider: this.name,
      platformAccountId: String(account.id),
      accountCode: account.accountCode || null,
      login: null,
      idempotentReplay: Boolean(result.idempotentReplay),
      state: account.state || null,
      raw: account,
    };
  }

  async getAccount({ platformAccountId }) {
    const result = await this.client.getAccount(required(platformAccountId, "platformAccountId"));
    return { provider: this.name, platformAccountId: String(result.account.id), raw: result.account };
  }

  async pauseAccount({ platformAccountId, reason = "ACG_FUNDED_PAUSE", cancelPending = false }) {
    return this.client.pauseAccount(required(platformAccountId, "platformAccountId"), { reason, cancelPending });
  }

  async resumeAccount({ platformAccountId, reason = "ACG_FUNDED_RESUME" }) {
    return this.client.resumeAccount(required(platformAccountId, "platformAccountId"), { reason });
  }

  async breachAccount({ platformAccountId, reason = "RISK_BREACH", action = "LIQUIDATE_AND_LOCK" }) {
    return this.client.breachAccount(required(platformAccountId, "platformAccountId"), { reason, action });
  }

  async flattenAccount({ platformAccountId, reason = "ACCOUNT_FLATTENED_FOR_REVIEW" }) {
    return this.client.flattenAccount(required(platformAccountId, "platformAccountId"), { reason });
  }

  async disableAccount({ platformAccountId, reason = "ACCOUNT_DISABLED", liquidate = false, cancelPending = true }) {
    return this.client.disableAccount(required(platformAccountId, "platformAccountId"), { reason, liquidate, cancelPending });
  }

  async closeAccount({ platformAccountId, reason = "ACCOUNT_CLOSED", liquidate = true }) {
    return this.client.closeAccount(required(platformAccountId, "platformAccountId"), { reason, liquidate });
  }

  async createTradingSession({ ownerExternalRef, ownerExternalRefs = [], platformAccountIds, selectedAccountId = null, metadata = {} }) {
    const accountIds = [...new Set((platformAccountIds || []).map(String).filter(Boolean))];
    const owners = [...new Set([ownerExternalRef, ...ownerExternalRefs].map(value => String(value || "").trim()).filter(Boolean))];
    const result = await this.client.createFederationTicket({
      ownerExternalRef: required(ownerExternalRef, "ownerExternalRef"),
      ownerExternalRefs: owners,
      accountIds,
      ...(selectedAccountId ? { selectedAccountId: String(selectedAccountId) } : {}),
      metadata: primitiveMetadata(metadata),
    });
    return {
      provider: this.name,
      type: "FEDERATED",
      ticket: result.ticket,
      expiresAt: result.expiresAt,
      selectedAccountId: result.selectedAccountId || selectedAccountId || accountIds[0] || null,
      launchUrl: this.frontendUrl || null,
    };
  }

  async createNativeCredential({ platformAccountId, rotate = false, login, password, mustChangePassword = false }) {
    const result = await this.client.createNativeCredential(required(platformAccountId, "platformAccountId"), {
      ...(login ? { login } : {}),
      ...(password ? { password } : {}),
      mustChangePassword: Boolean(mustChangePassword),
      rotate: Boolean(rotate),
    });
    return {
      provider: this.name,
      type: "CREDENTIALS",
      login: result?.credential?.login || null,
      temporaryPassword: result?.temporaryPassword || null,
      credential: result?.credential || null,
    };
  }
}

function required(value, field) {
  const result = String(value || "").trim();
  if (!result) {
    const error = new Error(`${field} is required for ACG Trader.`);
    error.code = "TRADING_PROVIDER_INVALID_COMMAND";
    throw error;
  }
  return result;
}

function primitiveMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .map(([key, value]) => [String(key), value]),
  );
}

function invalidResponse(message) {
  const error = new Error(message);
  error.code = "TRADING_PROVIDER_INVALID_RESPONSE";
  error.provider = "acg-trader";
  return error;
}
