// Server-only: real, delayed market prices from Yahoo Finance's public chart endpoints.
// Import from route handlers only.
//
// These endpoints are unofficial: no key, no SLA, and Yahoo can change or throttle them at any
// time. Quotes are typically delayed ~15 minutes for indices and futures. If a pull fails the
// routes answer 503 and the panes show a retrying notice.
// Set YAHOO_DISABLED=1 to skip Yahoo entirely.

import type { Candle, RealQuote, Timeframe } from "./types";
import { cached } from "./server-cache";

/** Terminal symbol → Yahoo ticker. Gold, silver and copper are the front COMEX futures, not spot. */
export const YAHOO_SYMBOLS: Record<string, string> = {
  US10Y: "^TNX",
  DXY: "DX-Y.NYB",
  SPX: "^GSPC",
  GOLD: "GC=F",
  "BTC/USD": "BTC-USD",
  WTI: "CL=F",
  "EUR/USD": "EURUSD=X",
  "USD/JPY": "JPY=X",
  "GBP/USD": "GBPUSD=X",
  "USD/IDR": "IDR=X",
  SILVER: "SI=F",
  COPPER: "HG=F",
  ES: "ES=F",
  NQ: "NQ=F",
  NKY: "^N225",
  DAX: "^GDAXI",
};

// Two interchangeable hosts; a retry switches to the other one in case the first fails to resolve.
const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const HEADERS = { "User-Agent": "macro-terminal/0.1", Accept: "application/json" };
const TIMEOUT_MS = 15_000;
const QUOTE_TTL_MS = 30_000;
const RETRY_MS = 5_000; // after a failed pull, how soon the next request may try again

export const off = () => process.env.YAHOO_DISABLED === "1";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One GET with up to two retries: Yahoo drops the odd connection and briefly throttles bursts. */
export async function getJson(path: string, what: string): Promise<unknown> {
  let last = "unknown error";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(400 * attempt * attempt);
    try {
      const res = await fetch(HOSTS[attempt % HOSTS.length] + path, { headers: HEADERS, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) break; // a 4xx won't get better on retry
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      last = `${err instanceof Error ? err.message : "network error"}${cause ? ` (${cause})` : ""}`;
    }
  }
  throw new Error(`Yahoo ${what}: ${last}`);
}

// ---------------------------------------------------------------- Quotes

interface YMeta {
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  regularMarketTime?: number;
  gmtoffset?: number;
}
export interface YSeries {
  meta: YMeta;
  timestamp?: number[];
  indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] };
}

async function pullQuotes(): Promise<{ quotes: Record<string, RealQuote>; fetchedAt: string }> {
  const tickers = Object.values(YAHOO_SYMBOLS);
  const url = `/v7/finance/spark?symbols=${tickers.map(encodeURIComponent).join(",")}&range=5d&interval=1d`;
  const body = (await getJson(url, "quotes")) as { spark?: { result?: { symbol: string; response?: YSeries[] }[] } };
  const byTicker = new Map((body.spark?.result ?? []).map((r) => [r.symbol, r.response?.[0]]));

  const quotes: Record<string, RealQuote> = {};
  for (const [symbol, ticker] of Object.entries(YAHOO_SYMBOLS)) {
    const s = byTicker.get(ticker);
    const price = s?.meta.regularMarketPrice;
    if (!s || typeof price !== "number" || !(price > 0)) throw new Error(`Yahoo quotes: no price for ${ticker}`);
    // Previous close from Yahoo's own day change; otherwise the prior daily close in the series.
    const pct = s.meta.regularMarketChangePercent;
    const closes = (s.indicators?.quote?.[0]?.close ?? []).filter((c): c is number => typeof c === "number");
    const prevClose = typeof pct === "number" && pct > -100 ? price / (1 + pct / 100) : (closes[closes.length - 2] ?? price);
    quotes[symbol] = { price, prevClose, time: s.meta.regularMarketTime ?? 0 };
  }
  return { quotes, fetchedAt: new Date().toISOString() };
}

/** Latest price and previous close for every instrument, or null when Yahoo is unreachable. */
export const getQuotes = async () => (off() ? null : cached("yahoo:quotes", QUOTE_TTL_MS, pullQuotes, RETRY_MS));

// ---------------------------------------------------------------- Candles

const TF: Record<Timeframe, { range: string; interval: string; sec: number; ttl: number; keep: number }> = {
  "1H": { range: "1mo", interval: "60m", sec: 3600, ttl: 5 * 60_000, keep: 500 },
  "4H": { range: "3mo", interval: "60m", sec: 3600, ttl: 5 * 60_000, keep: 400 }, // built from hourly bars
  "1D": { range: "2y", interval: "1d", sec: 86400, ttl: 10 * 60_000, keep: 520 },
  "1W": { range: "5y", interval: "1wk", sec: 7 * 86400, ttl: 10 * 60_000, keep: 270 },
};

/** Fold `b` into the forming bar `a` (same period). */
function merge(a: Candle, b: Candle, addVolume: boolean): void {
  a.high = Math.max(a.high, b.high);
  a.low = Math.min(a.low, b.low);
  a.close = b.close;
  if (addVolume) a.volume += b.volume;
}

export function parseCandles(series: YSeries, tf: Timeframe): Candle[] {
  const { sec, keep } = TF[tf];
  const ts = series.timestamp ?? [];
  const q = series.indicators?.quote?.[0];
  if (!q) return [];
  const bars: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (typeof o !== "number" || typeof h !== "number" || typeof l !== "number" || typeof c !== "number") continue; // gaps come back as null
    const bar = { time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 };
    const prev = bars[bars.length - 1];
    // Yahoo appends a live snapshot stamped inside the current period: fold it into that bar.
    // (Intraday only — daily and weekly bars are bucketed by calendar period below, which is DST-safe.)
    if (prev && sec === 3600 && bar.time - prev.time < sec) merge(prev, bar, false);
    else bars.push(bar);
  }

  let out = bars;
  if (tf === "4H") {
    out = [];
    for (const b of bars) {
      const bucket = Math.floor(b.time / 14400) * 14400;
      const prev = out[out.length - 1];
      if (prev && prev.time === bucket) merge(prev, b, true);
      else out.push({ ...b, time: bucket });
    }
  } else if (tf === "1D" || tf === "1W") {
    // Stamp daily/weekly bars with the exchange-local calendar date (as UTC midnight) so the axis
    // reads right; weekly bars snap to that week's Monday. A second bar in the same period is the
    // live snapshot and folds into the first.
    const offset = series.meta.gmtoffset ?? 0;
    out = [];
    for (const b of bars) {
      let period = Math.floor((b.time + offset) / 86400) * 86400;
      if (tf === "1W") period -= ((new Date(period * 1000).getUTCDay() + 6) % 7) * 86400;
      const prev = out[out.length - 1];
      if (prev && period <= prev.time) merge(prev, b, false);
      else out.push({ ...b, time: period });
    }
  }
  return out.slice(-keep);
}

async function pullCandles(symbol: string, tf: Timeframe): Promise<Candle[]> {
  const ticker = YAHOO_SYMBOLS[symbol];
  const { range, interval } = TF[tf];
  const url = `/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`;
  const body = (await getJson(url, `candles ${ticker}`)) as { chart?: { result?: YSeries[]; error?: { description?: string } | null } };
  const series = body.chart?.result?.[0];
  if (!series) throw new Error(`Yahoo candles ${ticker}: ${body.chart?.error?.description ?? "empty response"}`);
  const candles = parseCandles(series, tf);
  if (candles.length < 20) throw new Error(`Yahoo candles ${ticker} ${tf}: only ${candles.length} bars`);
  return candles;
}

/** OHLCV history for one instrument and timeframe, or null when Yahoo is unreachable. */
export const getCandles = async (symbol: string, tf: Timeframe) =>
  off() || !YAHOO_SYMBOLS[symbol] ? null : cached(`yahoo:candles:${symbol}:${tf}`, TF[tf].ttl, () => pullCandles(symbol, tf), RETRY_MS);

/** Closing prices keyed by exchange-local date, straight from Yahoo (not cached — callers cache). */
export async function yahooCloses(ticker: string, range: string, interval: string): Promise<{ date: string; value: number }[]> {
  const body = (await getJson(`/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`, `closes ${ticker}`)) as {
    chart?: { result?: YSeries[] };
  };
  const s = body.chart?.result?.[0];
  const closes = s?.indicators?.quote?.[0]?.close ?? [];
  const byDate = new Map<string, number>();
  (s?.timestamp ?? []).forEach((t, i) => {
    const c = closes[i];
    if (typeof c === "number") byDate.set(new Date((t + (s?.meta.gmtoffset ?? 0)) * 1000).toISOString().slice(0, 10), c);
  });
  return [...byDate].map(([date, value]) => ({ date, value }));
}
