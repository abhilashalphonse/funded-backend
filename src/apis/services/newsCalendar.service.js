import Account from "../../accounts/account.model.js";
import { FinanceCalendarProvider } from "../../economic-calendar/finance-calendar.provider.js";

const provider = new FinanceCalendarProvider();
const cache = new Map();
const CURRENT_RANGE_CACHE_TTL_MS = 60 * 1000;
const FUTURE_RANGE_CACHE_TTL_MS = 10 * 60 * 1000;
const STALE_TTL_MS = 6 * 60 * 60 * 1000;
const SUPPORTED_CURRENCIES = new Set(["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"]);

function ownershipQuery(customer) {
  const customerIds = [...new Set([customer.customerId, ...(customer.customerIds || [])].filter(Boolean))];
  const legacyRefs = [...new Set([customer.id, customer.email, ...customerIds].filter(Boolean))];
  return {
    $or: [
      { customerId: { $in: customerIds } },
      { ownerExternalRef: { $in: legacyRefs } },
    ],
  };
}

export async function getCustomerNewsCalendar(customer, input = {}) {
  const from = validDate(input.from, "from");
  const to = validDate(input.to, "to");
  validateRange(from, to);

  const currencies = normalizeCurrencies(input.currencies);
  const key = `${from}:${to}`;
  const now = Date.now();
  let cached = cache.get(key);
  let status = "LIVE";

  if (!cached || now - cached.fetchedAt > cacheTtlMs(from, to, now)) {
    try {
      const result = await provider.highImpact({ from, to });
      cached = { ...result, fetchedAt: now };
      cache.set(key, cached);
    } catch (error) {
      if (!cached || now - cached.fetchedAt > STALE_TTL_MS) throw providerUnavailable(error);
      status = "STALE";
    }
  }

  const account = input.accountId
    ? await Account.findOne({ accountId: String(input.accountId), ...ownershipQuery(customer) }).lean()
    : null;

  const events = (cached.events || [])
    .filter(event => !currencies.length || (event.currency && currencies.includes(event.currency)))
    .sort((a, b) => eventTime(a) - eventTime(b))
    .map(event => ({
      ...event,
      affectedMarkets: affectedMarketsFor(event),
      restriction: restrictionFor(account, event, status),
    }));

  return {
    from,
    to,
    impact: "HIGH",
    dataStatus: status,
    fetchedAt: new Date(cached.fetchedAt).toISOString(),
    accountId: account?.accountId || null,
    currencies,
    events,
    attribution: cached.attribution || {
      source: "financecalendar.com",
      url: "https://www.financecalendar.com",
    },
  };
}

export function restrictionFor(account, event, dataStatus = "LIVE") {
  if (!account) return { status: "NO_ACCOUNT", applies: false };

  // Historical accounts with no explicit value are permissive by product decision.
  const configured = account.commercialTerms?.newsTrading;
  if (configured !== false) return { status: "ALLOWED", applies: false };

  const window = {
    beforeMinutes: beforeMinutes(),
    afterMinutes: afterMinutes(),
    blockedFrom: null,
    blockedUntil: null,
  };

  // Cached/stale or unscheduled news may still be displayed, but is never an
  // authoritative basis for restricting execution.
  if (dataStatus !== "LIVE") return { status: "DATA_STALE", applies: false, wouldApply: true, ...window };
  if (!event.timestamp || event.allDay) return { status: "TIME_UNAVAILABLE", applies: false, wouldApply: true, ...window };

  const time = new Date(event.timestamp).getTime();
  if (!Number.isFinite(time)) return { status: "TIME_UNAVAILABLE", applies: false, wouldApply: true, ...window };

  return {
    status: "CONFIGURED",
    applies: false,
    wouldApply: true,
    enforcementSource: "ACG_TRADER",
    ...window,
    blockedFrom: new Date(time - window.beforeMinutes * 60_000).toISOString(),
    blockedUntil: new Date(time + window.afterMinutes * 60_000).toISOString(),
  };
}

export function affectedMarketsFor(event) {
  const currency = String(event?.currency || "").toUpperCase();
  const title = String(event?.title || "").toLowerCase();

  // Inventory releases are mapped as commodity-specific events rather than a
  // blanket USD restriction simply because the provider tags them USD.
  if (/crude|petroleum|oil inventories|eia/.test(title)) {
    return { currency: currency || null, groups: ["USOIL", "UKOIL"] };
  }

  const groups = [];
  if (SUPPORTED_CURRENCIES.has(currency)) groups.push(currency + " FX pairs");
  if (currency === "USD") groups.push("Gold (XAUUSD)", "US indices", "DXY");
  return { currency: currency || null, groups: [...new Set(groups)] };
}

export function cacheTtlMs(from, to, nowMs = Date.now()) {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  return from <= today && today <= to ? CURRENT_RANGE_CACHE_TTL_MS : FUTURE_RANGE_CACHE_TTL_MS;
}

function beforeMinutes() {
  const value = Number(process.env.NEWS_RESTRICTION_BEFORE_MINUTES ?? 5);
  return Number.isFinite(value) && value >= 0 ? Math.min(120, Math.round(value)) : 5;
}

function afterMinutes() {
  const value = Number(process.env.NEWS_RESTRICTION_AFTER_MINUTES ?? 5);
  return Number.isFinite(value) && value >= 0 ? Math.min(120, Math.round(value)) : 5;
}

function normalizeCurrencies(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(list.map(item => String(item).trim().toUpperCase()).filter(item => SUPPORTED_CURRENCIES.has(item)))];
}

function validDate(value, field) {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(new Date(`${date}T00:00:00Z`).getTime())) {
    const error = new Error(`${field} must be a valid YYYY-MM-DD date.`);
    error.status = 400;
    throw error;
  }
  return date;
}

function validateRange(from, to) {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  const days = Math.round((end - start) / 86_400_000);
  if (end < start || days > 8) {
    const error = new Error("News calendar range must be between 0 and 8 days.");
    error.status = 400;
    throw error;
  }
}

function eventTime(event) {
  if (event.timestamp) return new Date(event.timestamp).getTime();
  return new Date(`${event.date}T23:59:59Z`).getTime();
}

function providerUnavailable(cause) {
  const error = new Error("Economic calendar is temporarily unavailable.");
  error.status = 503;
  error.code = "NEWS_CALENDAR_UNAVAILABLE";
  error.cause = cause;
  return error;
}
