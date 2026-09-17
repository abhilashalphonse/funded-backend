import { TradingProviderConnector } from "../trading/provider.js";
import simulatorEngine from "../../simulator/engine.js";

export class SimulatorConnector extends TradingProviderConnector {
  constructor({ engine = simulatorEngine } = {}) {
    super("simulator");
    this.engine = engine;
  }

  async provisionAccount(input) {
    const account = await this.engine.provisionAccount({
      accountId: String(input.externalRef),
      balance: Number(input.initialBalance),
      leverage: Number(input.leverage || 100),
    });
    return {
      provider: this.name,
      platformAccountId: String(account.login),
      accountCode: String(account.login),
      login: String(account.login),
      idempotentReplay: false,
      state: { balance: String(account.balance), equity: String(account.equity) },
      raw: account,
    };
  }

  async getAccount({ externalRef }) {
    const account = this.engine.getAccount(String(externalRef));
    return account ? { provider: this.name, platformAccountId: String(account.login), raw: account } : null;
  }

  async breachAccount({ externalRef }) { return this.engine.lockAccount(String(externalRef)); }
  async disableAccount({ externalRef }) { return this.engine.lockAccount(String(externalRef)); }
  async closeAccount({ externalRef }) { return this.engine.lockAccount(String(externalRef)); }

  async createTradingSession({ platformAccountIds = [] }) {
    return { provider: this.name, type: "SIMULATOR", accountIds: platformAccountIds.map(String) };
  }
}
