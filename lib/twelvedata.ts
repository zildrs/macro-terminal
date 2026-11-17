// Server-only: Twelve Data REST client (https://twelvedata.com/docs), used when
// TWELVE_DATA_API_KEY is set. The key is read from the environment (~/app/.env on the VPS) and is
// never sent to the browser or written to logs.
//
// Free "Basic" plan: US stocks and ETFs, forex and crypto; 8 API credits a minute, 800 a day.
// Each symbol in a request costs one credit. This client enforces both limits itself so the app
// never trips the provider's: requests wait for room in the minute window, and once the daily
// budget (TWELVE_DATA_DAILY_CREDITS, default 760 — a little headroom) is spent, calls fail until
// 00:00 UTC and the panes keep their last data. Paid plans can raise both via the env variables.

import type { Candle, RealQuote, Timeframe } from "./types";

const BASE = "https://api.twelvedata.com";
const TIMEOUT_MS = 20_000;
const PER_MINUTE = () => Number(process.env.TWELVE_DATA_CREDITS_PER_MINUTE) || 8;
const PER_DAY = () => Number(process.env.TWELVE_DATA_DAILY_CREDITS) || 760;

export const tdKey = () => process.env.TWELVE_DATA_API_KEY?.trim() || "";
export const tdEnabled = () => tdKey().length > 0;

// ---------------------------------------------------------------- Credit budget

interface Budget {
  /** Timestamps (ms) of every credit spent in the last minute. */
  recent: number[];
  day: string;
  usedToday: number;
  chain: Promise<void>;
}
const g = globalThis as typeof globalThis & { __tdBudget?: Budget };
const budget: Budget = (g.__tdBudget ??= { recent: [], day: "", usedToday: 0, chain: Promise.resolve() });

/** Credits spent so far today (UTC), for the status endpoint. */
export function tdUsage() {
  const day = new Date().toISOString().slice(0, 10);
  return { day, used: budget.day === day ? budget.usedToday : 0, limit: PER_DAY() };
}

/** Reserve `credits`, waiting for room in the per-minute window. Calls are served in order. */
function reserve(credits: number): Promise<void> {
  const run = async () => {
    const today = new Date().toISOString().slice(0, 10);
    if (budget.day !== today) {
      budget.day = today;
      budget.usedToday = 0;
    }
    if (budget.usedToday + credits > PER_DAY()) throw new Error(`Twelve Data: daily credit budget (${PER_DAY()}) used up until 00:00 UTC`);
    if (credits > PER_MINUTE()) throw new Error(`Twelve Data: a ${credits}-credit request exceeds the per-minute limit`);
    for (;;) {
      const now = Date.now();
      budget.recent = budget.recent.filter((t) => now - t < 61_000);
      if (budget.recent.length + credits <= PER_MINUTE()) break;
      await new Promise((r) => setTimeout(r, budget.recent[0] + 61_000 - now));
    }
    const now = Date.now();
    for (let i = 0; i < credits; i++) budget.recent.push(now);
    budget.usedToday += credits;
  };
  const p = budget.chain.then(run);
  budget.chain = p.catch(() => undefined);
  return p;
}

interface TdError {
  status?: string;
  code?: number;
  message?: string;
}

async function tdGet(path: string, params: Record<string, string>, credits: number, what: string): Promise<unknown> {
  if (!tdEnabled()) throw new Error("Twelve Data: no API key configured");
  await reserve(credits);
  const qs = new URLSearchParams({ ...params, apikey: tdKey() });
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}?${qs}`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    // Never include the URL: it carries the key.
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    throw new Error(`Twelve Data ${what}: ${err instanceof Error ? err.message : "network error"}${cause ? ` (${cause})` : ""}`);
  }
  const body = (await res.json().catch(() => null)) as (TdError & Record<string, unknown>) | null;
  if (!res.ok || !body || body.status === "error") {
    const msg = (body?.message ?? `HTTP ${res.status}`).replace(tdKey(), "***");
    throw new Error(`Twelve Data ${what}: ${body?.code ?? res.status} ${msg}`);
  }
  return body;
}

// ---------------------------------------------------------------- Quotes

interface TdQuote extends TdError {
  symbol?: string;
  close?: string;
  previous_close?: string;
  timestamp?: number;
  last_quote_at?: number;
}

/** Latest price and previous close for up to 8 symbols in one request (one credit each). */
export async function tdQuotes(symbols: string[]): Promise<Record<string, RealQuote>> {
  const body = (await tdGet("/quote", { symbol: symbols.join(",") }, symbols.length, "quote")) as TdQuote | Record<string, TdQuote>;
  // One symbol → a bare object; several → keyed by symbol.
  const bySym: Record<string, TdQuote> = symbols.length === 1 ? { [symbols[0]]: body as TdQuote } : (body as Record<string, TdQuote>);
  const out: Record<string, RealQuote> = {};
  for (const sym of symbols) {
    const q = bySym[sym];
    const price = Number(q?.close);
    const prev = Number(q?.previous_close);
    if (!q || q.status === "error" || !(price > 0)) throw new Error(`Twelve Data quote ${sym}: ${q?.message ?? "no price"}`);
    out[sym] = { price, prevClose: prev > 0 ? prev : price, time: q.last_quote_at ?? q.timestamp ?? 0 };
  }
  return out;
}

// ---------------------------------------------------------------- Time series

const INTERVAL: Record<Timeframe, { interval: string; size: number }> = {
  "1H": { interval: "1h", size: 500 },
  "4H": { interval: "4h", size: 400 },
  "1D": { interval: "1day", size: 520 },
  "1W": { interval: "1week", size: 270 },
};

interface TdValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

/** "2026-11-17" or "2026-11-17 13:00:00" (UTC) → unix seconds. Daily and weekly bars land on UTC midnight. */
const toUnix = (dt: string) => Date.parse(dt.length === 10 ? `${dt}T00:00:00Z` : `${dt.replace(" ", "T")}Z`) / 1000;

/** Bars for one symbol, oldest first. `interval` is a Twelve Data interval such as "1day" or "1month". */
export async function tdSeries(symbol: string, interval: string, size: number): Promise<Candle[]> {
  const body = (await tdGet("/time_series", { symbol, interval, outputsize: String(size), timezone: "UTC", order: "ASC" }, 1, `series ${symbol}`)) as {
    values?: TdValue[];
  };
  const out: Candle[] = [];
  for (const v of body.values ?? []) {
    const bar = { time: toUnix(v.datetime), open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close), volume: Number(v.volume ?? 0) || 0 };
    if ([bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) out.push(bar);
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

export const tdCandles = (symbol: string, tf: Timeframe) => tdSeries(symbol, INTERVAL[tf].interval, INTERVAL[tf].size);
