// Risk-on / risk-off scoring and market regime status. Pure functions over real inputs (lib/fred.ts).
//
// Method
//   1. Eight daily indicators, four per side:
//        risk-on assets   S&P 500, Nasdaq Composite, Bitcoin, AUD/JPY
//        risk-off gauges  VIX, high-yield credit spread, broad US dollar, financial stress index
//   2. Each one is z-scored against its own trailing year (252 sessions), capped at ±3σ, and the
//      sign is flipped for the risk-off gauges, so positive always means "risk-on".
//   3. Score = 50 + 20 × the average signal, clamped to 0–100.
//      ≥ 60 Risk-On · ≤ 40 Risk-Off · otherwise Neutral.
//   4. The regime pillars (trend, volatility, credit, liquidity, curve, dollar) use fixed thresholds,
//      listed in `buildPillars`. They are judgement calls, not an industry standard.

import type { DataSource, MacroSeries, RiskIndicator, RiskPillar, RiskSnapshot, RiskStatus, Tone } from "./types";
import { clamp } from "./utils";

export type RiskKey = "SPX" | "NDX" | "BTC" | "AUDJPY" | "VIX" | "HY" | "USD" | "STRESS";

interface RiskDef {
  key: RiskKey;
  label: string;
  side: "ON" | "OFF";
  decimals: number;
  unit: string;
  chgKind: "pct" | "abs";
  weekly?: boolean;
}

export const RISK_DEFS: RiskDef[] = [
  { key: "SPX", label: "S&P 500 (SPY)", side: "ON", decimals: 0, unit: "", chgKind: "pct" },
  { key: "NDX", label: "Nasdaq", side: "ON", decimals: 0, unit: "", chgKind: "pct" },
  { key: "BTC", label: "Bitcoin", side: "ON", decimals: 0, unit: "", chgKind: "pct" },
  { key: "AUDJPY", label: "AUD/JPY", side: "ON", decimals: 2, unit: "", chgKind: "pct" },
  { key: "VIX", label: "VIX", side: "OFF", decimals: 2, unit: "", chgKind: "abs" },
  { key: "HY", label: "HY spread", side: "OFF", decimals: 0, unit: "bp", chgKind: "abs" },
  { key: "USD", label: "USD broad", side: "OFF", decimals: 2, unit: "", chgKind: "pct" },
  { key: "STRESS", label: "Fin. stress", side: "OFF", decimals: 2, unit: "", chgKind: "abs", weekly: true },
];

/** Daily series aligned on one grid of trading dates, oldest first. */
export interface RiskInputs {
  dates: string[];
  series: Record<RiskKey, number[]>;
  /** Each series' own latest observation date, where it lags the grid (values carry forward). */
  lastDates?: Partial<Record<RiskKey, string>>;
}

export const RISK_ON_AT = 60;
export const RISK_OFF_AT = 40;
const WINDOW = 252;
const HISTORY = 252;

const STATUS_LABEL: Record<RiskStatus, string> = { RISK_ON: "Risk-On", NEUTRAL: "Neutral", RISK_OFF: "Risk-Off" };

export function riskStatus(score: number): RiskStatus {
  return score >= RISK_ON_AT ? "RISK_ON" : score <= RISK_OFF_AT ? "RISK_OFF" : "NEUTRAL";
}

/** z-score of arr[i] against the trailing window that ends at i. */
function zAt(arr: number[], i: number): number {
  const from = Math.max(0, i - WINDOW + 1);
  const n = i - from + 1;
  let sum = 0;
  for (let k = from; k <= i; k++) sum += arr[k];
  const mean = sum / n;
  let ss = 0;
  for (let k = from; k <= i; k++) ss += (arr[k] - mean) ** 2;
  const sd = Math.sqrt(ss / n);
  return sd > 1e-12 ? (arr[i] - mean) / sd : 0;
}

const signalOf = (def: RiskDef, z: number) => clamp(z, -3, 3) * (def.side === "ON" ? 1 : -1);
const toneOf = (signal: number): Tone => (signal > 0.5 ? "on" : signal < -0.5 ? "off" : "neutral");
const scoreOf = (meanSignal: number) => Math.round(clamp(50 + 20 * meanSignal, 0, 100));
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const signed = (n: number, d: number, suffix = "") => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(d)}${suffix}`;

function buildPillars(x: RiskInputs, macro: MacroSeries): RiskPillar[] {
  const n = x.dates.length;
  const last = (k: RiskKey) => x.series[k][n - 1];

  // Trend — S&P 500 against its 200-day average, ±2% dead band.
  const spx = x.series.SPX;
  const maN = Math.min(200, n);
  const ma = spx.slice(n - maN).reduce((s, v) => s + v, 0) / maN;
  const gap = (last("SPX") / ma - 1) * 100;

  // Volatility — VIX: <16 calm, 16–22 normal, 22–30 elevated, ≥30 stress.
  const vix = last("VIX");
  // Credit — high-yield spread: <350bp tight, 350–500bp normal, ≥500bp stressed.
  const hy = last("HY");
  // Liquidity — 13-week change in net liquidity, ±1% dead band.
  const liq = macro.liquidity;
  const liq13 = (liq[liq.length - 1].net / liq[Math.max(0, liq.length - 14)].net - 1) * 100;
  // Curve — 10Y−2Y: inverted below zero, flat under 25bp.
  const curve = macro.spreads[macro.spreads.length - 1].s10y2y * 100;
  // Dollar — 1-month change in the broad dollar index, ±1% dead band. A rising dollar tightens conditions.
  const usd = x.series.USD;
  const usd1m = (last("USD") / usd[Math.max(0, n - 22)] - 1) * 100;

  return [
    {
      key: "trend",
      label: "Trend",
      state: gap > 2 ? "Uptrend" : gap < -2 ? "Downtrend" : "At 200d",
      detail: `SPY ${signed(gap, 1, "%")} vs 200d`,
      tone: gap > 2 ? "on" : gap < -2 ? "off" : "neutral",
    },
    {
      key: "vol",
      label: "Volatility",
      state: vix < 16 ? "Calm" : vix < 22 ? "Normal" : vix < 30 ? "Elevated" : "Stress",
      detail: `VIX ${vix.toFixed(1)}`,
      tone: vix < 16 ? "on" : vix < 22 ? "neutral" : "off",
    },
    {
      key: "credit",
      label: "Credit",
      state: hy < 350 ? "Tight" : hy < 500 ? "Normal" : "Stressed",
      detail: `HY ${hy.toFixed(0)}bp`,
      tone: hy < 350 ? "on" : hy < 500 ? "neutral" : "off",
    },
    {
      key: "liquidity",
      label: "Liquidity",
      state: liq13 > 1 ? "Expanding" : liq13 < -1 ? "Draining" : "Flat",
      detail: `${signed(liq13, 1, "%")} 13w`,
      tone: liq13 > 1 ? "on" : liq13 < -1 ? "off" : "neutral",
    },
    {
      key: "curve",
      label: "Curve",
      state: curve < 0 ? "Inverted" : curve < 25 ? "Flat" : "Normal",
      detail: `10Y−2Y ${signed(curve, 0, "bp")}`,
      tone: curve < 0 ? "off" : curve < 25 ? "neutral" : "on",
    },
    {
      key: "dollar",
      label: "Dollar",
      state: usd1m > 1 ? "Rising" : usd1m < -1 ? "Falling" : "Stable",
      detail: `USD ${signed(usd1m, 1, "%")} 1m`,
      tone: usd1m > 1 ? "off" : usd1m < -1 ? "on" : "neutral",
    },
  ];
}

export function computeRisk(x: RiskInputs, macro: MacroSeries, source: DataSource, fetchedAt?: string): RiskSnapshot {
  const n = x.dates.length;
  if (n < 30) throw new Error("risk: not enough history");
  const i = n - 1;

  const indicators: RiskIndicator[] = RISK_DEFS.map((def) => {
    const arr = x.series[def.key];
    // Changes are measured back from the indicator's own latest print, not from a carried-forward value.
    const own = x.lastDates?.[def.key] ?? x.dates[i];
    let j = i;
    while (j > 0 && x.dates[j] > own) j--;
    const back = (k: number) => arr[Math.max(0, j - k)];
    const chg = (k: number) => (def.chgKind === "pct" ? (arr[j] / back(k) - 1) * 100 : arr[j] - back(k));
    const z = zAt(arr, i);
    const signal = signalOf(def, z);
    return {
      key: def.key,
      label: def.label,
      side: def.side,
      value: arr[i],
      decimals: def.decimals,
      unit: def.unit,
      chgKind: def.chgKind,
      chg1d: def.weekly ? null : round(chg(1), 3),
      chg1w: round(chg(5), 3),
      chg1m: round(chg(21), 3),
      z: round(z),
      signal: round(signal),
      tone: toneOf(signal),
      asOf: x.dates[j],
    };
  });

  const compositeAt = (j: number) => RISK_DEFS.reduce((s, def) => s + signalOf(def, zAt(x.series[def.key], j)), 0) / RISK_DEFS.length;
  // Only score days that have a reasonably full look-back window behind them.
  const start = Math.max(n - HISTORY, Math.min(WINDOW - 1, n - 1));
  const history = [];
  for (let j = start; j < n; j++) history.push({ date: x.dates[j], score: scoreOf(compositeAt(j)) });

  const score = history[history.length - 1].score;
  const status = riskStatus(score);
  return {
    source,
    asOf: x.dates[i],
    fetchedAt,
    score,
    scoreChg1w: score - history[Math.max(0, history.length - 6)].score,
    status,
    label: STATUS_LABEL[status],
    onCount: indicators.filter((d) => d.tone === "on").length,
    offCount: indicators.filter((d) => d.tone === "off").length,
    indicators,
    pillars: buildPillars(x, macro),
    history,
  };
}
