// Server-only: low-level client for Yahoo Finance's public chart endpoints. lib/prices.ts decides
// when it is used (no Twelve Data key configured); lib/live.ts uses it for fed funds futures.
//
// These endpoints are unofficial: no key, no SLA. Yahoo blocks many cloud-provider IP ranges
// outright (every request answers 429), so on a VPS expect this client to fail.
// Set YAHOO_DISABLED=1 to skip Yahoo entirely.

import type { Candle, RealQuote, Timeframe } from "./types";

// Two interchangeable hosts; a retry switches to the other one in case the first fails to resolve.
const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const HEADERS = { "User-Agent": "macro-terminal/0.1", Accept: "application/json" };
const TIMEOUT_MS = 15_000;

export const yahooOff = () => process.env.YAHOO_DISABLED === "1";

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

/** Latest price and previous close per Yahoo ticker. Throws if any ticker is missing. */
export async function yahooQuotes(tickers: string[]): Promise<Record<string, RealQuote>> {
  if (yahooOff()) throw new Error("Yahoo disabled");
  const url = `/v7/finance/spark?symbols=${tickers.map(encodeURIComponent).join(",")}&range=5d&interval=1d`;
  const body = (await getJson(url, "quotes")) as { spark?: { result?: { symbol: string; response?: YSeries[] }[] } };
  const byTicker = new Map((body.spark?.result ?? []).map((r) => [r.symbol, r.response?.[0]]));
  const out: Record<string, RealQuote> = {};
  for (const ticker of tickers) {
    const s = byTicker.get(ticker);
    const price = s?.meta.regularMarketPrice;
    if (!s || typeof price !== "number" || !(price > 0)) throw new Error(`Yahoo quotes: no price for ${ticker}`);
    // Previous close from Yahoo's own day change; otherwise the prior daily close in the series.
    const pct = s.meta.regularMarketChangePercent;
    const closes = (s.indicators?.quote?.[0]?.close ?? []).filter((c): c is number => typeof c === "number");
    const prevClose = typeof pct === "number" && pct > -100 ? price / (1 + pct / 100) : (closes[closes.length - 2] ?? price);
    out[ticker] = { price, prevClose, time: s.meta.regularMarketTime ?? 0 };
  }
  return out;
}

// ---------------------------------------------------------------- Candles

const TF: Record<Timeframe, { range: string; interval: string; sec: number; keep: number }> = {
  "1H": { range: "1mo", interval: "60m", sec: 3600, keep: 500 },
  "4H": { range: "3mo", interval: "60m", sec: 3600, keep: 400 }, // built from hourly bars
  "1D": { range: "2y", interval: "1d", sec: 86400, keep: 520 },
  "1W": { range: "5y", interval: "1wk", sec: 7 * 86400, keep: 270 },
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

/** OHLCV history for one Yahoo ticker and timeframe. */
export async function yahooCandles(ticker: string, tf: Timeframe): Promise<Candle[]> {
  if (yahooOff()) throw new Error("Yahoo disabled");
  const { range, interval } = TF[tf];
  const url = `/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`;
  const body = (await getJson(url, `candles ${ticker}`)) as { chart?: { result?: YSeries[]; error?: { description?: string } | null } };
  const series = body.chart?.result?.[0];
  if (!series) throw new Error(`Yahoo candles ${ticker}: ${body.chart?.error?.description ?? "empty response"}`);
  const candles = parseCandles(series, tf);
  if (candles.length < 20) throw new Error(`Yahoo candles ${ticker} ${tf}: only ${candles.length} bars`);
  return candles;
}

/** Closing prices keyed by exchange-local date, straight from Yahoo (not cached — callers cache). */
export async function yahooCloses(ticker: string, range: string, interval: string): Promise<{ date: string; value: number }[]> {
  if (yahooOff()) throw new Error("Yahoo disabled");
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
