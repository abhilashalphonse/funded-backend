const DEFAULT_BASE_URL = "https://www.financecalendar.com/wp-json/fc/v1";

const COUNTRY_TO_CURRENCY = new Map([
  ["united states", "USD"], ["us", "USD"], ["usa", "USD"],
  ["euro area", "EUR"], ["eurozone", "EUR"], ["european union", "EUR"],
  ["united kingdom", "GBP"], ["uk", "GBP"], ["great britain", "GBP"],
  ["japan", "JPY"], ["canada", "CAD"], ["australia", "AUD"],
  ["new zealand", "NZD"], ["switzerland", "CHF"],
]);

export class FinanceCalendarProvider {
  constructor({ baseUrl = process.env.FINANCE_CALENDAR_BASE_URL || DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.timeoutMs = Number(timeoutMs) || 8000;
    if (typeof this.fetch !== "function") throw new Error("Finance calendar fetch implementation is required.");
  }

  async highImpact({ from, to, limit = 500 }) {
    const url = new URL(`${this.baseUrl}/calendar`);
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    url.searchParams.set("impact", "high");
    url.searchParams.set("limit", String(Math.min(500, Math.max(1, Number(limit) || 500))));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "ACG-Funded/1.0" },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`FinanceCalendar request failed (${response.status}).`);
        error.status = response.status;
        error.code = "NEWS_CALENDAR_PROVIDER_ERROR";
        throw error;
      }
      const payload = await response.json();
      const rawEvents = Array.isArray(payload) ? payload : Array.isArray(payload?.events) ? payload.events : [];
      return {
        events: rawEvents.map(normalizeFinanceCalendarEvent).filter(Boolean),
        attribution: normalizeAttribution(payload?.attribution),
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeout = new Error("FinanceCalendar request timed out.");
        timeout.code = "NEWS_CALENDAR_PROVIDER_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function normalizeFinanceCalendarEvent(raw = {}) {
  const timestamp = parseTimestamp(raw.time_utc || raw.timestamp || raw.datetime || raw.date_time || raw.start);
  const date = normalizeDate(raw.date, timestamp);
  if (!timestamp && !date) return null;

  const impact = String(raw.impact || raw.importance || "").trim().toUpperCase();
  if (impact && impact !== "HIGH") return null;

  const title = String(raw.title || raw.name || raw.event || "Economic event").trim();
  const country = String(raw.country || raw.region || raw.area || "").trim() || null;
  const currency = normalizeCurrency(raw.currency) || inferCurrency(country, title);

  return {
    id: stableId(raw, timestamp || date, title),
    timestamp,
    date,
    allDay: Boolean(raw.all_day),
    country,
    currency,
    title,
    name: raw.name ? String(raw.name) : null,
    impact: "HIGH",
    category: raw.category ? String(raw.category) : null,
    actual: valueOrNull(raw.actual),
    forecast: valueOrNull(raw.consensus ?? raw.forecast),
    previous: valueOrNull(raw.prior ?? raw.previous),
    sourceUrl: safeFinanceCalendarUrl(raw.url),
  };
}

function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function normalizeDate(value, timestamp) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return timestamp ? timestamp.slice(0, 10) : null;
}

function normalizeCurrency(value) {
  const currency = String(value || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function inferCurrency(country, title) {
  const countryCurrency = COUNTRY_TO_CURRENCY.get(String(country || "").trim().toLowerCase());
  if (countryCurrency) return countryCurrency;

  const text = String(title || "").toUpperCase();
  const rules = [
    [/\b(US|U\.S\.|FED|FOMC|NON[- ]?FARM|NFP)\b/, "USD"],
    [/\b(EUROZONE|EURO AREA|ECB)\b/, "EUR"],
    [/\b(UK|BOE|BANK OF ENGLAND)\b/, "GBP"],
    [/\b(JAPAN|BOJ)\b/, "JPY"],
    [/\b(CANADA|BOC|BANK OF CANADA)\b/, "CAD"],
    [/\b(AUSTRALIA|RBA)\b/, "AUD"],
    [/\b(NEW ZEALAND|RBNZ)\b/, "NZD"],
    [/\b(SWITZERLAND|SNB)\b/, "CHF"],
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] || null;
}

function valueOrNull(value) {
  if (value == null || value === "") return null;
  return String(value);
}

function stableId(raw, time, title) {
  const explicit = raw.id || raw.event_id || raw.slug;
  if (explicit) return String(explicit);
  return `${String(time || "unknown").replace(/[^0-9]/g, "")}-${String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80)}`;
}

function safeFinanceCalendarUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return /(^|\.)financecalendar\.com$/i.test(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeAttribution(value) {
  return {
    source: String(value?.source || "financecalendar.com"),
    url: "https://www.financecalendar.com",
  };
}
