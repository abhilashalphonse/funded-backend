import { EventEmitter } from "events";

class SimulatorEngine extends EventEmitter {
  constructor() {
    super();
    this.accounts = new Map();
    this.nextLogin = 100000;
  }

  async provisionAccount({ accountId, balance, leverage = 100 }) {
    const existing = this.accounts.get(accountId);
    if (existing) return existing;

    const account = {
      accountId,
      login: ++this.nextLogin,
      balance,
      equity: balance,
      margin: 0,
      openPositions: 0,
      leverage,
      enabled: true,
      sequence: 0
    };
    this.accounts.set(accountId, account);
    return account;
  }

  getAccount(accountId) {
    return this.accounts.get(accountId) ?? null;
  }

  async lockAccount(accountId) {
    const account = this.getAccount(accountId);
    if (!account) return { success: true, alreadyMissing: true };
    account.enabled = false;
    return { success: true, login: account.login };
  }

  async recordSnapshot(accountId, snapshot) {
    const account = this.getAccount(accountId);
    if (!account) throw new Error(`Simulator account ${accountId} not found`);
    if (!account.enabled) throw new Error(`Simulator account ${accountId} is locked`);

    for (const key of ["balance", "equity", "margin", "openPositions"]) {
      if (snapshot[key] !== undefined) account[key] = Number(snapshot[key]);
    }
    account.sequence += 1;

    const event = {
      eventId: `sim:${account.login}:snapshot:${account.sequence}`,
      eventType: "ACCOUNT_SNAPSHOT",
      aggregateId: accountId,
      timestamp: new Date(),
      payload: {
        ticket: snapshot.ticket ?? `snapshot-${account.sequence}`,
        balance: account.balance,
        equity: account.equity,
        margin: account.margin,
        openPositions: account.openPositions
      }
    };
    this.emit("snapshot", event);
    return account;
  }
}

export default new SimulatorEngine();
