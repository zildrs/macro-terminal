// Server-only: where every instrument's price and history comes from.
//
//   ETFs and FX   Twelve Data when TWELVE_DATA_API_KEY is set (works from cloud servers),
//                 otherwise Yahoo Finance (keyless, but blocked from most cloud IP ranges)
//   DXY           computed from six FX rates with ICE's published index formula
//   US10Y         FRED DGS10 (daily close)
//   BTC/USD       Kraken
//
// Quotes are fetched per group and cached with a market-hours-aware lifetime, so the free Twelve
// Data plan (800 credits/day) covers a full day: FX every 30 min on weekdays, ETFs every 20 min
// during the US session. If one group fails the others are still served.

import type { Candle, RealQuote, Timeframe } from "./types";
import { fetchObservations, type Obs } from "./fred";
import { cached } from "./server-cache";
import { tdCandles, tdEnabled, tdQuotes, tdSeries } from "./twelvedata";
import { yahooCandles, yahooCloses, yahooQuotes } from "./yahoo";

const MIN = 60_000;
const HOUR = 60 * MIN;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type PriceProvider = "TWELVEDATA" | "YAHOO";
export const priceProvider = (): PriceProvider => (tdEnabled() ? "TWELVEDATA" : "YAHOO");

/** Terminal FX symbol → Yahoo ticker (Twelve Data uses the terminal symbol as is). */
const YAHOO_FX: Record<string, string> = {
  "EUR/USD": "EURUSD=X",
  "USD/JPY": "JPY=X",
  "GBP/USD": "GBPUSD=X",
  "USD/IDR": "IDR=X",
  "USD/CAD": "CAD=X",
  "USD/SEK": "SEK=X",
  "USD/CHF": "CHF=X",
};
const yahooTicker = (sym: string) => YAHOO_FX[sym] ?? sym;

/** The FX group includes the three DXY components the terminal does not display. */
const FX_GROUP = ["EUR/USD", "USD/JPY", "GBP/USD", "USD/IDR", "USD/CAD", "USD/SEK", "USD/CHF"];
const ETF_GROUP = ["SPY", "QQQ", "EWJ", "EWG", "GLD", "SLV", "USO", "CPER"];

// ---------------------------------------------------------------- Market-hours-aware cache lifetimes

function usSessionOpen(now = new Date()): boolean {
  const d = now.getUTCDay();
  const m = now.getUTCHours() * 60 + now.getUTCMinutes();
  return d >= 1 && d <= 5 && m >= 13 * 60 + 25 && m <= 21 * 60 + 5; // covers both EST and EDT
}
function fxOpen(now = new Date()): boolean {
  const d = now.getUTCDay();
  const h = now.getUTCHours();
  return !(d === 6 || (d === 0 && h < 21) || (d === 5 && h >= 22));
}
const fxTtl = () => (fxOpen() ? 30 * MIN : 6 * HOUR);
const etfTtl = () => (usSessionOpen() ? 20 * MIN : 3 * HOUR);

// ---------------------------------------------------------------- Groups

async function groupQuotes(symbols: string[]): Promise<Record<string, RealQuote>> {
  if (tdEnabled()) return tdQuotes(symbols);
  const raw = await yahooQuotes(symbols.map(yahooTicker));
  return Object.fromEntries(symbols.map((s) => [s, raw[yahooTicker(s)]]));
}

/** ICE U.S. Dollar Index: 50.14348112 × EURUSD^−0.576 × USDJPY^0.136 × GBPUSD^−0.119 × USDCAD^0.091 × USDSEK^0.042 × USDCHF^0.036 */
export function dxyFrom(fx: Record<string, number>): number {
  return (
    50.14348112 *
    fx["EUR/USD"] ** -0.576 *
    fx["USD/JPY"] ** 0.136 *
    fx["GBP/USD"] ** -0.119 *
    fx["USD/CAD"] ** 0.091 *
    fx["USD/SEK"] ** 0.042 *
    fx["USD/CHF"] ** 0.036
  );
}

async function us10y(): Promise<RealQuote> {
  const obs = await fetchObservations("DGS10", isoDay(Date.now() - 20 * 86400_000), isoDay(Date.now()));
  if (obs.length < 2) throw new Error("FRED DGS10: not enough observations");
  const [prev, last] = obs.slice(-2);
  return { price: last.value, prevClose: prev.value, time: Date.parse(`${last.date}T21:00:00Z`) / 1000 };
}

async function kraken(path: string, what: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.kraken.com/0/public/${path}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  const body = (await res.json().catch(() => null)) as { error?: string[]; result?: Record<string, unknown> } | null;
  if (!res.ok || !body?.result) throw new Error(`Kraken ${what}: ${body?.error?.join("; ") || `HTTP ${res.status}`}`);
  return body.result;
}

async function btc(): Promise<RealQuote> {
  const r = await kraken("Ticker?pair=XBTUSD", "ticker");
  const t = Object.values(r)[0] as { c: [string]; o: string };
  // `o` is the price at 00:00 UTC, the closest thing a 24/7 market has to a previous close.
  return { price: Number(t.c[0]), prevClose: Number(t.o), time: Math.floor(Date.now() / 1000) };
}

const GROUP_RETRY = 30_000;

/** Every available quote. Parts that fail are left out rather than failing the whole response. */
export async function getQuotes(): Promise<{ quotes: Record<string, RealQuote>; provider: PriceProvider; fetchedAt: string } | null> {
  const p = priceProvider();
  const [fx, etf, ten, coin] = await Promise.all([
    cached(`prices:${p}:fx`, fxTtl(), () => groupQuotes(FX_GROUP), GROUP_RETRY),
    cached(`prices:${p}:etf`, etfTtl(), () => groupQuotes(ETF_GROUP), GROUP_RETRY),
    cached("prices:us10y", 30 * MIN, us10y, GROUP_RETRY),
    cached("prices:btc", 15_000, btc, 5_000),
  ]);
  const quotes: Record<string, RealQuote> = {};
  if (fx) {
    for (const s of ["EUR/USD", "USD/JPY", "GBP/USD", "USD/IDR"]) quotes[s] = fx[s];
    const now = Object.fromEntries(FX_GROUP.map((s) => [s, fx[s].price]));
    const prev = Object.fromEntries(FX_GROUP.map((s) => [s, fx[s].prevClose]));
    quotes.DXY = { price: dxyFrom(now), prevClose: dxyFrom(prev), time: Math.max(...FX_GROUP.map((s) => fx[s].time)) };
  }
  if (etf) Object.assign(quotes, etf);
  if (ten) quotes.US10Y = ten;
  if (coin) quotes["BTC/USD"] = coin;
  if (!Object.keys(quotes).length) return null;
  return { quotes, provider: p, fetchedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- Candles

/** Raised for combinations that cannot exist (e.g. an hourly chart of a daily-only series). */
export class Unsupported extends Error {}

const CANDLE_TTL: Record<Timeframe, number> = { "1H": 15 * MIN, "4H": 30 * MIN, "1D": HOUR, "1W": 6 * HOUR };

const flat = (time: number, v: number): Candle => ({ time, open: v, high: v, low: v, close: v, volume: 0 });

async function us10yCandles(tf: Timeframe): Promise<Candle[]> {
  if (tf === "1H" || tf === "4H") throw new Unsupported("US 10-year yield is a daily series (FRED); pick 1D or 1W");
  const obs = await fetchObservations("DGS10", isoDay(Date.now() - (tf === "1D" ? 760 : 1900) * 86400_000), isoDay(Date.now()));
  if (tf === "1D") return obs.map((o) => flat(Date.parse(`${o.date}T00:00:00Z`) / 1000, o.value));
  // Weekly: last close of each Monday-based week.
  const byWeek = new Map<number, Obs>();
  for (const o of obs) {
    const t = Date.parse(`${o.date}T00:00:00Z`);
    const monday = t / 1000 - ((new Date(t).getUTCDay() + 6) % 7) * 86400;
    byWeek.set(monday, o);
  }
  return [...byWeek].map(([t, o]) => flat(t, o.value));
}

async function btcCandles(tf: Timeframe): Promise<Candle[]> {
  const interval = { "1H": 60, "4H": 240, "1D": 1440, "1W": 10080 }[tf];
  const r = await kraken(`OHLC?pair=XBTUSD&interval=${interval}`, "OHLC");
  const rows = Object.entries(r).find(([k]) => k !== "last")?.[1] as [number, string, string, string, string, string, string][];
  return rows.map(([t, o, h, l, c, , v]) => ({ time: t, open: +o, high: +h, low: +l, close: +c, volume: +v }));
}

async function seriesFor(symbol: string, tf: Timeframe): Promise<Candle[]> {
  return tdEnabled() ? tdCandles(symbol, tf) : yahooCandles(yahooTicker(symbol), tf);
}

/** DXY bars from the six component series. High/low are bounded by open and close: the index's true intrabar range is not recoverable. */
async function dxyCandles(tf: Timeframe): Promise<Candle[]> {
  const parts = FX_GROUP.filter((s) => s !== "USD/IDR");
  const series = [];
  for (const s of parts) series.push(await seriesFor(s, tf)); // sequential: keeps within the per-minute credit window
  const maps = series.map((bars) => new Map(bars.map((b) => [b.time, b])));
  const out: Candle[] = [];
  for (const b of series[0]) {
    const row = maps.map((m) => m.get(b.time));
    if (row.some((x) => !x)) continue;
    const at = (k: "open" | "close") => dxyFrom(Object.fromEntries(parts.map((s, i) => [s, row[i]![k]])));
    const open = at("open");
    const close = at("close");
    out.push({ time: b.time, open, close, high: Math.max(open, close), low: Math.min(open, close), volume: 0 });
  }
  return out;
}

async function pullCandles(symbol: string, tf: Timeframe): Promise<Candle[]> {
  const bars =
    symbol === "US10Y" ? await us10yCandles(tf) : symbol === "BTC/USD" ? await btcCandles(tf) : symbol === "DXY" ? await dxyCandles(tf) : await seriesFor(symbol, tf);
  if (bars.length < 20) throw new Error(`${symbol} ${tf}: only ${bars.length} bars`);
  return bars;
}

/** OHLCV history for one instrument, or null when its source is unreachable. Throws Unsupported for impossible requests. */
export async function getCandles(symbol: string, tf: Timeframe): Promise<{ candles: Candle[]; source: string } | null> {
  if (symbol === "US10Y" && (tf === "1H" || tf === "4H")) await us10yCandles(tf); // throws Unsupported
  const source = symbol === "US10Y" ? "FRED" : symbol === "BTC/USD" ? "KRAKEN" : priceProvider();
  const candles = await cached(`candles:${source}:${symbol}:${tf}`, CANDLE_TTL[tf], () => pullCandles(symbol, tf), GROUP_RETRY);
  return candles ? { candles, source } : null;
}

// ---------------------------------------------------------------- Close histories for the risk, flow and balance-sheet panes

/** Daily closes for an ETF (or FX pair), oldest first, about `days` trading days. Not cached — callers cache. */
export async function dailyCloses(symbol: string, days: number): Promise<Obs[]> {
  if (tdEnabled()) {
    const bars = await tdSeries(symbol, "1day", days);
    return bars.map((b) => ({ date: isoDay(b.time * 1000), value: b.close }));
  }
  const range = days > 520 ? "5y" : days > 260 ? "2y" : "1y";
  return (await yahooCloses(yahooTicker(symbol), range, "1d")).slice(-days);
}

/** Month-end closes, oldest first, dated the first of the month. Not cached — callers cache. */
export async function monthlyCloses(symbol: string, months: number): Promise<Obs[]> {
  if (symbol === "BTC/USD") {
    const weekly = await btcCandles("1W");
    const byMonth = new Map<string, number>();
    for (const b of weekly) byMonth.set(`${isoDay(b.time * 1000).slice(0, 7)}-01`, b.close);
    return [...byMonth].map(([date, value]) => ({ date, value })).slice(-months);
  }
  if (tdEnabled()) {
    const bars = await tdSeries(symbol, "1month", months);
    return bars.map((b) => ({ date: `${isoDay(b.time * 1000).slice(0, 7)}-01`, value: b.close }));
  }
  return (await yahooCloses(yahooTicker(symbol), "5y", "1mo")).map((o) => ({ date: `${o.date.slice(0, 7)}-01`, value: o.value })).slice(-months);
}
