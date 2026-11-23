// Server-only: brings the risk inputs up to the minute with Hyperliquid prices.
//
// The z-scores still run on a year of official daily closes (lib/fred.ts). For the indicators that
// Hyperliquid tracks, the latest value is "nowcast": the last official close moved by the
// Hyperliquid market's change since that close —
//     live = close × (Hyperliquid price now ÷ Hyperliquid price at the close time)
// — so the level stays on the official series' scale while moving tick by tick.
//
//   S&P 500 (SPY close, 16:00 New York)   ← xyz:SP500
//   Nasdaq (FRED close, 16:00 New York)   ← xyz:XYZ100
//   Bitcoin (Coinbase daily, 00:00 UTC)   ← BTC
//   USD broad (FRED, ~12:00 New York)     ← EUR, JPY and GBP vs USD (xyz), ICE DXY weights renormalised
//
// VIX, high-yield spreads, AUD/JPY and the stress index have no live Hyperliquid market (xyz:VIX
// and xyz:DXY exist but do not trade), so they stay on their daily prints.

import { hlMarks, hlPriceAt } from "./hyperliquid";
import type { RiskInputs, RiskKey } from "./risk";

export const LIVE_KEYS = ["SPX", "NDX", "BTC", "USD"] as const;
type LiveKey = (typeof LIVE_KEYS)[number];

/** UTC ms of hh:mm New York time on an ISO date (DST-aware). */
function nyTime(date: string, hh: number, mm = 0): number {
  const [y, m, d] = date.split("-").map(Number);
  let guess = Date.UTC(y, m - 1, d, hh + 5, mm); // EST first guess
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(guess);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const mi = Number(parts.find((p) => p.type === "minute")?.value);
    guess -= ((h - hh) * 60 + (mi - mm)) * 60_000;
  }
  return guess;
}

/** Today's date in New York and whether it is a weekday. */
function nyToday(now: number): { date: string; weekday: boolean } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, weekday: !["Sat", "Sun"].includes(get("weekday")) };
}

const closeTime = (key: LiveKey, date: string): number =>
  key === "BTC" ? Date.parse(`${date}T00:00:00Z`) + 86400_000 : key === "USD" ? nyTime(date, 12) : nyTime(date, 16);

// ICE DXY weights for the three currencies Hyperliquid quotes; sign = USD strength when the pair rises.
const USD_LEGS = [
  { coin: "xyz:EUR", w: 0.576, sign: -1 }, // EUR/USD
  { coin: "xyz:JPY", w: 0.136, sign: 1 }, // USD/JPY
  { coin: "xyz:GBP", w: 0.119, sign: -1 }, // GBP/USD
];
const LEG_SUM = USD_LEGS.reduce((s, l) => s + l.w, 0);

/** Ratio (now ÷ at close) for one live indicator, or null if Hyperliquid can't price it. */
async function liveRatio(key: LiveKey, at: number, px: Record<string, number>): Promise<number | null> {
  if (key === "USD") {
    let logChg = 0;
    for (const leg of USD_LEGS) {
      const then = await hlPriceAt(leg.coin, at);
      const now = px[leg.coin];
      if (!then || !now) return null;
      logChg += (leg.sign * leg.w * Math.log(now / then)) / LEG_SUM;
    }
    return Math.exp(logChg);
  }
  const coin = key === "SPX" ? "xyz:SP500" : key === "NDX" ? "xyz:XYZ100" : "BTC";
  const then = await hlPriceAt(coin, at);
  const now = px[coin];
  return then && now ? now / then : null;
}

export interface LiveRisk {
  inputs: RiskInputs;
  /** Indicators that carry a live value. */
  liveKeys: RiskKey[];
  /** When the Hyperliquid prices were taken. */
  at: number;
}

/**
 * The inputs with a live final row. On a New York weekday after the last official date a new row
 * is appended (slower series carry forward); otherwise the latest row is updated in place.
 * Returns null when Hyperliquid can't be reached, so the caller falls back to the daily data.
 */
export async function withLivePrices(x: RiskInputs, now = Date.now()): Promise<LiveRisk | null> {
  const marks = await hlMarks();
  if (!marks) return null;
  const n = x.dates.length;
  const lastDate = x.dates[n - 1];
  const today = nyToday(now);
  const append = today.weekday && today.date > lastDate;

  const values: Partial<Record<RiskKey, number>> = {};
  const results = await Promise.allSettled(
    LIVE_KEYS.map(async (key) => {
      const own = x.lastDates?.[key] ?? lastDate;
      let j = n - 1;
      while (j > 0 && x.dates[j] > own) j--;
      const at = closeTime(key, x.dates[j]);
      if (at > now) return; // the official close is still in the future: nothing to nowcast yet
      const ratio = await liveRatio(key, at, marks.px);
      if (ratio && Number.isFinite(ratio)) values[key] = x.series[key][j] * ratio;
    }),
  );
  for (const r of results) if (r.status === "rejected") console.warn(`[risk:live] ${r.reason instanceof Error ? r.reason.message : r.reason}`);
  const liveKeys = Object.keys(values) as RiskKey[];
  if (!liveKeys.length) return null;

  const rowDate = append ? today.date : lastDate;
  const series = Object.fromEntries(
    (Object.keys(x.series) as RiskKey[]).map((k) => {
      const arr = append ? [...x.series[k], x.series[k][n - 1]] : [...x.series[k]];
      if (values[k] !== undefined) arr[arr.length - 1] = values[k] as number;
      return [k, arr];
    }),
  ) as Record<RiskKey, number[]>;
  const lastDates = { ...x.lastDates };
  // A carried-forward value must keep its own date, or its 1D change would read as zero.
  if (append) for (const k of Object.keys(x.series) as RiskKey[]) lastDates[k] ??= lastDate;
  for (const k of liveKeys) lastDates[k] = rowDate;

  return { inputs: { dates: append ? [...x.dates, today.date] : x.dates, series, lastDates }, liveKeys, at: marks.at };
}
