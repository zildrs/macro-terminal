export type ViewId = "overview" | "cb" | "liquidity" | "cross" | "intel";

export type AssetGroup = "FX" | "Commodities" | "Indices" | "Rates" | "Crypto";

export type Timeframe = "1H" | "4H" | "1D" | "1W";

export interface Instrument {
  symbol: string;
  name: string;
  group: AssetGroup;
  decimals: number;
  unit?: string;
}

export interface Quote {
  symbol: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  /** Direction of the last tick; `seq` changes whenever it re-fires. */
  dir: -1 | 0 | 1;
  seq: number;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type RegimeCode = "LIQUIDITY_EXPANSION" | "NEUTRAL" | "STAGFLATION" | "TIGHTENING";

export type DataSource = "FRED" | "YAHOO" | "TWELVEDATA" | "BIS" | "CFTC" | "KRAKEN" | "FF" | "RSS" | "KALSHI";

/** A real (delayed) quote for one terminal instrument. */
export interface RealQuote {
  price: number;
  prevClose: number;
  /** Unix seconds of the last trade or quote the source reports. */
  time: number;
}

/** GET /api/quotes */
export interface QuotesPayload {
  source: DataSource;
  fetchedAt?: string;
  quotes: Record<string, RealQuote>;
}

/** GET /api/candles?symbol=&tf= */
export interface CandlesPayload {
  source: DataSource;
  symbol: string;
  tf: Timeframe;
  candles: Candle[];
}

/** API contract from spec §5, plus optional provenance fields (`sources`, `asOf`, `change1wPct`). */
export interface MacroPayload {
  timestamp: string;
  macroRegime: {
    current: RegimeCode;
    riskScore: number;
    label: string;
  };
  netLiquidity: {
    valueTrillionsUSD: number;
    /** Null when the source is weekly (FRED): there is no 24-hour change to report. */
    change24hPct: number | null;
    /** Week-over-week change; present when the source is FRED. */
    change1wPct?: number;
    fedAssets: number;
    tgaBalance: number;
    rrpBalance: number;
    /** Date of the latest observation (YYYY-MM-DD). */
    asOf?: string;
  };
  yieldSpreads: {
    us10y2y: number;
    us10y3m: number;
    isInverted: boolean;
    asOf?: string;
  };
  sources?: {
    netLiquidity: DataSource;
    yieldSpreads: DataSource;
    /** MIXED = real liquidity and curve inputs, simulated policy-path inputs. */
    macroRegime: DataSource | "MIXED";
  };
}

export interface LiquidityPoint {
  date: string;
  /** USD trillions. */
  fed: number;
  tga: number;
  rrp: number;
  net: number;
}

export interface SpreadPoint {
  date: string;
  /** Percentage points. */
  s10y2y: number;
  s10y3m: number;
}

export interface CurvePoint {
  tenor: string;
  now: number;
  yearAgo: number;
}

/** History behind the liquidity and yield-curve panes (GET /api/macro/series). */
export interface MacroSeries {
  source: DataSource;
  transport?: "api" | "csv";
  fetchedAt?: string;
  liquidity: LiquidityPoint[];
  spreads: SpreadPoint[];
  curve: CurvePoint[];
  liquidityAsOf: string;
  yieldsAsOf: string;
}

// ---- Risk-on / risk-off (market regime)

export type RiskStatus = "RISK_ON" | "NEUTRAL" | "RISK_OFF";
export type Tone = "on" | "off" | "neutral";

export interface RiskIndicator {
  key: string;
  label: string;
  /** ON = an asset that rallies when risk appetite is strong. OFF = a haven or stress gauge. */
  side: "ON" | "OFF";
  value: number;
  decimals: number;
  unit: string;
  /** How the changes are expressed: percent for prices, absolute for vol / spread / index gauges. */
  chgKind: "pct" | "abs";
  /** Null for series that only print weekly. */
  chg1d: number | null;
  chg1w: number;
  chg1m: number;
  /** Date of this indicator's own latest observation — some series lag the others by a few days. */
  asOf: string;
  /** Level vs its own trailing 1-year mean, in standard deviations. */
  z: number;
  /** `z` capped at ±3 and signed so that positive always means risk-on. */
  signal: number;
  tone: Tone;
}

export interface RiskPillar {
  key: string;
  label: string;
  state: string;
  detail: string;
  tone: Tone;
}

/** GET /api/risk */
export interface RiskSnapshot {
  source: DataSource;
  asOf: string;
  fetchedAt?: string;
  /** 0 = extreme risk-off, 50 = neutral, 100 = extreme risk-on. */
  score: number;
  scoreChg1w: number;
  status: RiskStatus;
  label: string;
  onCount: number;
  offCount: number;
  indicators: RiskIndicator[];
  /** Market regime status, one line per pillar. */
  pillars: RiskPillar[];
  history: { date: string; score: number }[];
}

export type Bias = "Hawkish" | "Dovish" | "Neutral";

export interface CentralBankRow {
  code: string;
  bank: string;
  ccy: string;
  rateLabel: string;
  rate: number;
  /** Size of the most recent change; 0 when the rate has not moved in the look-back window. */
  lastMoveBps: number;
  lastMoveDate: string;
  /** Headline CPI, % y/y, and the month it refers to (YYYY-MM). */
  cpi: number;
  cpiAsOf: string;
  /** Derived from the direction of the last move in the past nine months. */
  bias: Bias;
}

export interface FedMeeting {
  date: string;
  /** CME: the ZQ contract, e.g. "ZQZ6". Kalshi: the event, e.g. "26DEC". */
  contract: string;
  /** ZQ futures price; absent for Kalshi. */
  futuresPrice?: number;
  /** Expected fed funds rate after this meeting. */
  impliedRate: number;
  /**
   * Outcome probabilities in bps. CME: cumulative move from today's rate. Kalshi: this meeting's
   * own decision. `atLeast` marks Kalshi's open-ended ">25bp" buckets (shown as 50+).
   */
  dist: { moveBps: number; prob: number; atLeast?: boolean }[];
  cutProb: number;
  holdProb: number;
  hikeProb: number;
}

export interface CalendarEvent {
  id: string;
  /** ISO timestamp of the release. */
  time: string;
  ccy: string;
  event: string;
  impact: 1 | 2 | 3;
  /** As published by the feed, e.g. "0.3%" or "224K"; empty when there is no consensus. */
  forecast: string;
  previous: string;
}

export interface NewsItem {
  id: string;
  /** Publication time, ms since epoch. */
  time: number;
  category: string;
  headline: string;
  url: string;
  sentiment: Bias;
}

export interface BookLevel {
  px: number;
  sz: number;
}

export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface BalanceSheetPoint {
  date: string;
  /** Total assets, USD trillions (ECB and BoJ converted at that month's exchange rate). */
  fed: number;
  ecb: number;
  boj: number;
  SPY: number;
  GLD: number;
  BTC: number;
}

/** GET /api/policy */
export interface PolicyPayload {
  fetchedAt: string;
  banks: CentralBankRow[];
  fed: { lower: number; upper: number; effr: number; effrAsOf: string; coreCpi: number };
  meetings: FedMeeting[];
  /** Where `meetings` came from: CME fed funds futures (via Yahoo) or Kalshi's FOMC decision markets. */
  meetingsSource: "CME" | "KALSHI" | null;
  balance: BalanceSheetPoint[];
}

export interface CotPoint {
  date: string;
  /** Net contracts (long − short), thousands. */
  a: number;
  b: number;
}

/** GET /api/cot?key= */
export interface CotPayload {
  key: string;
  market: string;
  report: string;
  labels: [string, string];
  points: CotPoint[];
}

export interface FlowRow {
  cls: string;
  name: string;
  etf: string;
  /** Return z-scores per window, clamped to ±3. */
  z: number[];
}

/** GET /api/orderbook */
export interface BookPayload {
  symbol: string;
  venue: string;
  asOf: number;
  book: OrderBook;
  /** Net taker volume (buy − sell) per minute, oldest first, in base units. */
  deltas: number[];
}
