import type { FedMeeting, MacroPayload, MacroSeries, RegimeCode } from "./types";
import { clamp } from "./utils";

// Calculations only — every input comes from a real feed (lib/fred.ts, lib/live.ts).

export type Benchmark = "SPY" | "GLD" | "BTC";

/** Net Liquidity = Fed Total Assets − TGA − RRP (USD trillions). */
export function netLiquidity(fed: number, tga: number, rrp: number): number {
  return fed - tga - rrp;
}

// ---------------------------------------------------------------- Fed funds futures → meeting probabilities

/** Outcome distribution for one meeting given the rate the market implies after it. */
export function meetingFromRate(effr: number, f: { date: string; contract: string; price: number }, impliedRate: number): FedMeeting {
  {
    const steps = (effr - impliedRate) / 0.25; // +ve = cuts priced
    const k = Math.floor(steps);
    const frac = steps - k;
    const dist = [
      { moveBps: -25 * k, prob: 1 - frac },
      { moveBps: -25 * (k + 1), prob: frac },
    ]
      .map((d) => ({ moveBps: d.moveBps === 0 ? 0 : d.moveBps, prob: d.prob }))
      .filter((d) => d.prob > 0.0005)
      .sort((x, y) => x.moveBps - y.moveBps);
    const sum = (pred: (m: number) => boolean) => dist.filter((d) => pred(d.moveBps)).reduce((s, d) => s + d.prob, 0);
    return {
      date: f.date,
      contract: f.contract,
      futuresPrice: f.price,
      impliedRate,
      dist,
      cutProb: sum((m) => m < 0),
      holdProb: sum((m) => m === 0),
      hikeProb: sum((m) => m > 0),
    };
  }
}

// ---------------------------------------------------------------- Macro regime classifier

export interface RegimeInputs {
  /** 13-week % change in net liquidity. */
  liq13wPct: number;
  us10y2y: number;
  /** Market-implied probability of a cut at the next FOMC (0–1). */
  cutProb: number;
  coreCpi: number;
}

export const REGIME_LABELS: Record<RegimeCode, string> = {
  LIQUIDITY_EXPANSION: "Risk-On / Dovish Bias",
  NEUTRAL: "Transition / Mixed Signals",
  STAGFLATION: "Stagflationary Pressure",
  TIGHTENING: "Tightening / Risk-Off",
};

export function classifyRegime(x: RegimeInputs): MacroPayload["macroRegime"] {
  const score =
    50 +
    25 * Math.tanh(x.liq13wPct / 2) + // liquidity impulse dominates
    12 * (x.cutProb - 0.5) * 2 + // policy bias
    6 * Math.tanh(x.us10y2y * 2); // curve steepening = easing transmitted
  const riskScore = Math.round(clamp(score, 0, 100));
  let current: RegimeCode;
  if (riskScore >= 60) current = "LIQUIDITY_EXPANSION";
  else if (riskScore >= 40) current = "NEUTRAL";
  else current = x.coreCpi >= 3.5 ? "STAGFLATION" : "TIGHTENING";
  return { current, riskScore, label: REGIME_LABELS[current] };
}

// ---------------------------------------------------------------- API payload (spec §5)

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Spec §5 payload from real history. Liquidity is weekly, so the change reported is week-over-week
 * and `change24hPct` is null. The regime score takes liquidity and curve inputs from FRED plus the
 * next-meeting odds from fed funds futures and core CPI; without those two it is scored on a
 * neutral policy input and flagged "MIXED".
 */
export function payloadFromSeries(series: MacroSeries, nowMs: number, policy?: { cutProb: number; hikeProb: number; coreCpi: number }): MacroPayload {
  const liq = series.liquidity;
  const last = liq[liq.length - 1];
  const prev = liq[liq.length - 2];
  const q = liq[Math.max(0, liq.length - 14)];
  const sp = series.spreads[series.spreads.length - 1];
  return {
    timestamp: new Date(nowMs).toISOString(),
    macroRegime: classifyRegime({
      liq13wPct: (last.net / q.net - 1) * 100,
      us10y2y: sp.s10y2y,
      // Net easing bias priced for the next FOMC: P(cut) − P(hike), mapped back onto 0–1.
      cutProb: policy ? 0.5 + (policy.cutProb - policy.hikeProb) / 2 : 0.5,
      coreCpi: policy?.coreCpi ?? 3,
    }),
    netLiquidity: {
      valueTrillionsUSD: round(last.net),
      change24hPct: null,
      change1wPct: round((last.net / prev.net - 1) * 100, 2),
      fedAssets: round(last.fed),
      tgaBalance: round(last.tga),
      rrpBalance: round(last.rrp),
      asOf: last.date,
    },
    yieldSpreads: {
      us10y2y: round(sp.s10y2y),
      us10y3m: round(sp.s10y3m),
      isInverted: sp.s10y2y < 0 || sp.s10y3m < 0,
      asOf: sp.date,
    },
    sources: { netLiquidity: "FRED", yieldSpreads: "FRED", macroRegime: policy ? "FRED" : "MIXED" },
  };
}
