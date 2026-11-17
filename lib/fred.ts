// Server-only: pulls real macro series from FRED (Federal Reserve Bank of St. Louis).
// Import this from route handlers only — it reads process.env and must not reach the client bundle.
//
// Transport:
//   FRED_API_KEY set  → official JSON API (api.stlouisfed.org), 120 requests/min per key.
//   no key            → the public "download CSV" endpoint on fred.stlouisfed.org (same data, no SLA).
//
// Units as published by FRED (checked 2026-11-12):
//   WALCL      Fed total assets, Wednesday level        — millions of USD
//   WTREGEN    Treasury General Account, week average   — millions of USD
//   RRPONTSYD  Overnight reverse repo, daily            — billions of USD
//   DGS*       Treasury constant-maturity yields, daily — percent
//   SP500, NASDAQCOM, CBBTCUSD      index / price levels, daily
//   DEXUSAL (USD per AUD), DEXJPUS (JPY per USD)   — multiplied to get AUD/JPY
//   VIXCLS     CBOE VIX close                           — index points
//   BAMLH0A0HYM2  ICE BofA US high-yield OAS            — percent (shown as bp)
//   DTWEXBGS   Nominal broad US dollar index, daily
//   STLFSI4    St. Louis Fed financial stress index, weekly (0 = average stress)

import type { CurvePoint, LiquidityPoint, MacroSeries, SpreadPoint } from "./types";
import { netLiquidity } from "./macro";
import type { RiskInputs, RiskKey } from "./risk";
import { cached } from "./server-cache";
import { dailyCloses } from "./prices";

const TTL_MS = 30 * 60_000; // weekly/daily data — no point refetching more often
const TIMEOUT_MS = 15_000;
const DAY = 86400_000;

const CURVE_TENORS: { tenor: string; id: string }[] = [
  { tenor: "1M", id: "DGS1MO" },
  { tenor: "3M", id: "DGS3MO" },
  { tenor: "6M", id: "DGS6MO" },
  { tenor: "1Y", id: "DGS1" },
  { tenor: "2Y", id: "DGS2" },
  { tenor: "5Y", id: "DGS5" },
  { tenor: "10Y", id: "DGS10" },
  { tenor: "30Y", id: "DGS30" },
];

export interface Obs {
  date: string; // YYYY-MM-DD
  value: number;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100; // yields are published to 2dp

export function parseFredCsv(text: string): Obs[] {
  const out: Obs[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [date, raw] = line.split(",");
    if (!date || raw === undefined || raw.trim() === "" || raw.trim() === ".") continue; // holidays are blank
    const value = Number(raw);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(value)) out.push({ date, value });
  }
  return out;
}

export function parseFredJson(body: unknown): Obs[] {
  const rows = (body as { observations?: { date: string; value: string }[] }).observations;
  if (!Array.isArray(rows)) throw new Error("FRED: unexpected response shape");
  const out: Obs[] = [];
  for (const r of rows) {
    const value = Number(r.value);
    if (r.value !== "." && Number.isFinite(value)) out.push({ date: r.date, value });
  }
  return out;
}

// At most 6 requests in flight, so two cold pulls together don't open 20 connections to FRED.
let active = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 6) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export const fetchObservations = (id: string, start: string, end: string) => slot(() => fetchOne(id, start, end));

async function fetchOne(id: string, start: string, end: string): Promise<Obs[]> {
  const key = process.env.FRED_API_KEY?.trim();
  const url = key
    ? `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${encodeURIComponent(key)}&file_type=json&observation_start=${start}&observation_end=${end}`
    : `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}&coed=${end}`;
  // Errors below name the series only — never the URL, which may carry the key.
  let res: Response | undefined;
  let last = "network error";
  for (let attempt = 0; attempt < 3 && !res?.ok; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 500 * attempt));
    try {
      res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
      last = `HTTP ${res.status}`;
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      last = (err as { cause?: { code?: string } }).cause?.code ?? "network error";
    }
  }
  if (!res?.ok) throw new Error(`FRED ${id}: ${last}`);
  const obs = key ? parseFredJson(await res.json()) : parseFredCsv(await res.text());
  if (!obs.length) throw new Error(`FRED ${id}: no observations`);
  return obs;
}

/** For each date in `dates` (ascending), the latest observation on or before it. */
export function asOf(obs: Obs[], dates: string[]): (number | undefined)[] {
  let j = -1;
  return dates.map((d) => {
    while (j + 1 < obs.length && obs[j + 1].date <= d) j++;
    return j >= 0 ? obs[j].value : undefined;
  });
}

async function pullMacro(): Promise<MacroSeries> {
  const now = Date.now();
  const end = isoDay(now);
  const start = isoDay(now - Math.round(3.4 * 365) * DAY);
  const ids = ["WALCL", "WTREGEN", "RRPONTSYD", ...CURVE_TENORS.map((t) => t.id)];
  const results = await Promise.all(ids.map((id) => fetchObservations(id, start, end)));
  const by = Object.fromEntries(ids.map((id, i) => [id, results[i]])) as Record<string, Obs[]>;

  // Net liquidity, weekly on the H.4.1 Wednesday dates. Everything converted to USD trillions.
  const weeks = by.WALCL.map((o) => o.date);
  const tga = asOf(by.WTREGEN, weeks);
  const rrp = asOf(by.RRPONTSYD, weeks);
  const liquidity: LiquidityPoint[] = [];
  by.WALCL.forEach((w, i) => {
    const t = tga[i];
    const r = rrp[i];
    if (t === undefined || r === undefined) return;
    const fed = w.value / 1e6;
    const tgaT = t / 1e6;
    const rrpT = r / 1e3;
    liquidity.push({ date: w.date, fed, tga: tgaT, rrp: rrpT, net: netLiquidity(fed, tgaT, rrpT) });
  });

  // Spreads, daily, last two years, on days where all three yields printed.
  const days = by.DGS10.map((o) => o.date);
  const y2 = new Map(by.DGS2.map((o) => [o.date, o.value]));
  const m3 = new Map(by.DGS3MO.map((o) => [o.date, o.value]));
  const spreads: SpreadPoint[] = [];
  for (const o of by.DGS10) {
    const a = y2.get(o.date);
    const b = m3.get(o.date);
    if (a !== undefined && b !== undefined) spreads.push({ date: o.date, s10y2y: r2(o.value - a), s10y3m: r2(o.value - b) });
  }

  // Curve: latest close vs the same curve a year earlier.
  const latest = days[days.length - 1];
  const yearAgo = `${Number(latest.slice(0, 4)) - 1}${latest.slice(4)}`;
  const curve: CurvePoint[] = CURVE_TENORS.map(({ tenor, id }) => {
    const [prev, cur] = asOf(by[id], [yearAgo, latest]);
    if (cur === undefined || prev === undefined) throw new Error(`FRED ${id}: curve point missing`);
    return { tenor, now: cur, yearAgo: prev };
  });

  if (liquidity.length < 60 || spreads.length < 60) throw new Error("FRED: history too short");

  return {
    source: "FRED",
    transport: process.env.FRED_API_KEY?.trim() ? "api" : "csv",
    fetchedAt: new Date(now).toISOString(),
    liquidity: liquidity.slice(-160),
    spreads: spreads.slice(-504),
    curve,
    liquidityAsOf: liquidity[liquidity.length - 1].date,
    yieldsAsOf: latest,
  };
}

// ---------------------------------------------------------------- Risk-on / risk-off inputs

const RISK_IDS = ["NASDAQCOM", "CBBTCUSD", "DEXUSAL", "DEXJPUS", "VIXCLS", "BAMLH0A0HYM2", "DTWEXBGS", "STLFSI4"] as const;

/** Daily inputs for lib/risk.ts, aligned on S&P 500 trading dates (slower series carry forward). */
async function pullRisk(): Promise<RiskInputs & { fetchedAt: string }> {
  const now = Date.now();
  const end = isoDay(now);
  const start = isoDay(now - Math.round(2.45 * 365) * DAY); // 1y of scores, each with a 1y look-back
  const results = await Promise.all(RISK_IDS.map((id) => fetchObservations(id, start, end)));
  const by = Object.fromEntries(RISK_IDS.map((id, i) => [id, results[i]])) as Record<(typeof RISK_IDS)[number], Obs[]>;
  // FRED carries only a year of S&P 500 history, so the SPY ETF stands in (Twelve Data, else Yahoo).
  const spx = (await dailyCloses("SPY", 650)).filter((o) => o.date >= start);

  const dates = spx.map((o) => o.date);
  const on = (id: (typeof RISK_IDS)[number]) => asOf(by[id], dates);
  const aud = on("DEXUSAL");
  const jpy = on("DEXJPUS");
  const cols: Record<RiskKey, (number | undefined)[]> = {
    SPX: spx.map((o) => o.value),
    NDX: on("NASDAQCOM"),
    BTC: on("CBBTCUSD"),
    AUDJPY: aud.map((a, i) => (a === undefined || jpy[i] === undefined ? undefined : a * (jpy[i] as number))),
    VIX: on("VIXCLS"),
    HY: on("BAMLH0A0HYM2").map((v) => (v === undefined ? undefined : v * 100)), // percent → bp
    USD: on("DTWEXBGS"),
    STRESS: on("STLFSI4"),
  };
  // Drop the leading days on which a slower series has not printed yet.
  const keys = Object.keys(cols) as RiskKey[];
  const first = dates.findIndex((_, i) => keys.every((k) => cols[k][i] !== undefined));
  if (first < 0 || dates.length - first < 300) throw new Error("FRED: risk history too short");
  const series = Object.fromEntries(keys.map((k) => [k, cols[k].slice(first) as number[]])) as Record<RiskKey, number[]>;
  const lastOf = (...ids: (typeof RISK_IDS)[number][]) => ids.map((id) => by[id][by[id].length - 1].date).sort()[0];
  const lastDates: Record<RiskKey, string> = {
    SPX: spx[spx.length - 1].date,
    NDX: lastOf("NASDAQCOM"),
    BTC: lastOf("CBBTCUSD"),
    AUDJPY: lastOf("DEXUSAL", "DEXJPUS"),
    VIX: lastOf("VIXCLS"),
    HY: lastOf("BAMLH0A0HYM2"),
    USD: lastOf("DTWEXBGS"),
    STRESS: lastOf("STLFSI4"),
  };
  return { dates: dates.slice(first), series, lastDates, fetchedAt: new Date(now).toISOString() };
}

// ---------------------------------------------------------------- Cached entry points

const off = () => process.env.FRED_DISABLED === "1";

/** Liquidity, spreads and curve history. Null when FRED is unreachable. */
export const getFredSeries = async () => (off() ? null : cached("fred:macro", TTL_MS, pullMacro));
/** Inputs for the risk-on / risk-off score. Null when FRED is unreachable. */
export const getFredRisk = async () => (off() ? null : cached("fred:risk", TTL_MS, pullRisk));
