import Account from "../../accounts/account.model.js";
import { FinanceCalendarProvider } from "../../economic-calendar/finance-calendar.provider.js";

const provider = new FinanceCalendarProvider();
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
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

  if (!cached || now - cached.fetchedAt > CACHE_TTL_MS) {
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
      restriction: restrictionFor(account, event),
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

function restrictionFor(account, event) {
  if (!account) return { status: "NO_ACCOUNT", applies: false };

  const configured = account.commercialTerms?.newsTrading;
  if (configured === true) return { status: "ALLOWED", applies: false };
  if (configured !== false) return { status: "NOT_SPECIFIED", applies: false };

  if (!event.timestamp || event.allDay) {
    return { status: "RESTRICTED", applies: true, beforeMinutes: beforeMinutes(), afterMinutes: afterMinutes(), blockedFrom: null, blockedUntil: null };
  }

  const time = new Date(event.timestamp).getTime();
  return {
    status: "RESTRICTED",
    applies: true,
    beforeMinutes: beforeMinutes(),
    afterMinutes: afterMinutes(),
    blockedFrom: new Date(time - beforeMinutes() * 60_000).toISOString(),
    blockedUntil: new Date(time + afterMinutes() * 60_000).toISOString(),
  };
}

function beforeMinutes() {
  const value = Number(process.env.NEWS_RESTRICTION_BEFORE_MINUTES ?? 2);
  return Number.isFinite(value) && value >= 0 ? Math.min(120, Math.round(value)) : 2;
}

function afterMinutes() {
  const value = Number(process.env.NEWS_RESTRICTION_AFTER_MINUTES ?? 2);
  return Number.isFinite(value) && value >= 0 ? Math.min(120, Math.round(value)) : 2;
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
