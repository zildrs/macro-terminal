// Server-only: the real feeds behind the policy, positioning, calendar, news, order-flow and flow
// panes. Import from route handlers only. Every source here is public and keyless:
//
//   BIS (stats.bis.org)            central bank policy rates, headline CPI y/y
//   FRED                           Fed target range, EFFR, core CPI, Fed / ECB / BoJ total assets, FX
//   Yahoo Finance                  30-day fed funds futures (ZQ) — optional, blocked on most cloud IPs
//   lib/prices.ts                  ETF closes for the flow proxy and balance-sheet benchmarks
//   CFTC (cftc.gov file archive)  Commitments of Traders: TFF and disaggregated reports
//   Kraken                         BTC/USD order book and recent trades
//   Forex Factory weekly export    economic calendar (forecast and previous; it carries no actuals)
//   Fed / ECB / BoJ / CNBC RSS     headlines
//
// Each getter returns null when its source is unreachable; panes then say so instead of inventing data.

import { connect } from "node:http2";
import { inflateRawSync } from "node:zlib";
import type {
  BalanceSheetPoint,
  Bias,
  BookPayload,
  CalendarEvent,
  CentralBankRow,
  CotPayload,
  FedMeeting,
  FlowRow,
  NewsItem,
  PolicyPayload,
} from "./types";
import { classifySentiment } from "./content";
import { asOf, fetchObservations, type Obs } from "./fred";
import { meetingFromRate } from "./macro";
import { cached } from "./server-cache";
import { dailyCloses, monthlyCloses } from "./prices";
import { getJson as yahooJson, type YSeries } from "./yahoo";

const UA = { "User-Agent": "macro-terminal/0.1" };
const DAY = 86400_000;
const MIN = 60_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function get(url: string, what: string, accept = "application/json"): Promise<Response> {
  let last = "unknown error";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 600));
    try {
      const res = await fetch(url, { headers: { ...UA, Accept: accept }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (res.ok) return res;
      last = `HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      last = `${err instanceof Error ? err.message : "network error"}${cause ? ` (${cause})` : ""}`;
    }
  }
  throw new Error(`${what}: ${last}`);
}

// ---------------------------------------------------------------- BIS: policy rates and CPI

/** RFC-4180 CSV → rows of fields (BIS metadata columns contain commas, quotes and line breaks). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function bisSeries(flow: string, key: string, query: string): Promise<Map<string, Obs[]>> {
  const res = await get(`https://stats.bis.org/api/v2/data/dataflow/BIS/${flow}/1.0/${key}?${query}&format=csv`, `BIS ${flow}`, "text/csv");
  const rows = parseCsv(await res.text());
  const head = rows[0] ?? [];
  const [iArea, iTime, iVal] = ["REF_AREA", "TIME_PERIOD", "OBS_VALUE"].map((h) => head.indexOf(h));
  if (iArea < 0 || iTime < 0 || iVal < 0) throw new Error(`BIS ${flow}: unexpected columns`);
  const out = new Map<string, Obs[]>();
  for (const r of rows.slice(1)) {
    const value = Number(r[iVal]);
    if (!r[iArea] || r[iVal] === "" || !Number.isFinite(value)) continue;
    if (!out.has(r[iArea])) out.set(r[iArea], []);
    out.get(r[iArea])!.push({ date: r[iTime], value });
  }
  for (const obs of out.values()) obs.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

const BANKS: { area: string; code: string; bank: string; ccy: string }[] = [
  { area: "US", code: "FED", bank: "Federal Reserve", ccy: "USD" },
  { area: "XM", code: "ECB", bank: "European Central Bank", ccy: "EUR" },
  { area: "GB", code: "BOE", bank: "Bank of England", ccy: "GBP" },
  { area: "JP", code: "BOJ", bank: "Bank of Japan", ccy: "JPY" },
  { area: "ID", code: "BI", bank: "Bank Indonesia", ccy: "IDR" },
];

/** Most recent change in a step series: size in bp and the date it took effect. */
function lastMove(obs: Obs[]): { bps: number; date: string } {
  for (let i = obs.length - 1; i > 0; i--) {
    if (Math.abs(obs[i].value - obs[i - 1].value) > 1e-9) return { bps: Math.round((obs[i].value - obs[i - 1].value) * 100), date: obs[i].date };
  }
  return { bps: 0, date: obs[0].date };
}

const biasOf = (move: { bps: number; date: string }, now: number): Bias =>
  move.bps === 0 || now - Date.parse(move.date) > 270 * DAY ? "Neutral" : move.bps < 0 ? "Dovish" : "Hawkish";

// ---------------------------------------------------------------- Fed funds futures → meeting probabilities

/** FOMC decision days (second day of each meeting), from federalreserve.gov/monetarypolicy/fomccalendars.htm. */
const FOMC_DECISIONS = [
  "2026-12-09",
  "2027-01-27",
  "2027-03-17",
  "2027-04-28",
  "2027-06-09",
  "2027-07-28",
  "2027-09-15",
  "2027-10-27",
];
const MONTH_CODES = "FGHJKMNQUVXZ";

/**
 * FedWatch-style chain. A ZQ contract settles on the month's average effective rate, so in a
 * meeting month:  avg = (pre × d + post × (N − d)) / N  →  solve for `post`. Months without a
 * meeting re-anchor the running rate to that month's average.
 */
async function fedMeetingsFromFutures(effr: number, now: number): Promise<FedMeeting[]> {
  const upcoming = FOMC_DECISIONS.filter((d) => Date.parse(d) + DAY > now).slice(0, 6);
  if (!upcoming.length) throw new Error("FOMC calendar: no upcoming meetings listed — update FOMC_DECISIONS");
  const start = new Date(now);
  const months: { ym: string; ticker: string; contract: string; y: number; m: number }[] = [];
  const lastYm = upcoming[upcoming.length - 1].slice(0, 7);
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); ; m === 11 ? (y++, (m = 0)) : m++) {
    const ym = `${y}-${String(m + 1).padStart(2, "0")}`;
    const contract = `ZQ${MONTH_CODES[m]}${String(y).slice(3)}`;
    months.push({ ym, ticker: `ZQ${MONTH_CODES[m]}${String(y).slice(2)}.CBT`, contract, y, m });
    if (ym >= lastYm || months.length > 14) break;
  }
  const body = (await yahooJson(
    `/v7/finance/spark?symbols=${months.map((x) => encodeURIComponent(x.ticker)).join(",")}&range=5d&interval=1d`,
    "fed funds futures",
  )) as { spark?: { result?: { symbol: string; response?: YSeries[] }[] } };
  const price = new Map((body.spark?.result ?? []).map((r) => [r.symbol, r.response?.[0]?.meta.regularMarketPrice]));

  const out: FedMeeting[] = [];
  let rate = effr;
  for (const mo of months) {
    const px = price.get(mo.ticker);
    if (typeof px !== "number" || !(px > 80)) break; // contract not listed yet: stop the chain here
    const avg = 100 - px;
    const meeting = upcoming.find((d) => d.startsWith(mo.ym));
    if (!meeting) {
      rate = avg;
      continue;
    }
    const n = new Date(Date.UTC(mo.y, mo.m + 1, 0)).getUTCDate();
    const d = Number(meeting.slice(8, 10)); // the new rate applies from the following day
    // With only a few days left in the month the division blows up noise; fall back to the average.
    const post = n - d >= 5 ? (avg * n - rate * d) / (n - d) : avg;
    out.push(meetingFromRate(effr, { date: meeting, contract: mo.contract, price: px }, post));
    rate = post;
  }
  if (!out.length) throw new Error("fed funds futures: no usable contracts");
  return out;
}

// ---------------------------------------------------------------- Kalshi FOMC markets → meeting probabilities

// Kalshi (a CFTC-regulated exchange) lists a market per FOMC decision with five outcomes. Its
// public market-data API needs no key and, unlike Yahoo, answers cloud servers. Prices are in
// dollars per $1 contract, i.e. probabilities.
const KALSHI_EVENTS = "https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXFEDDECISION&status=open&with_nested_markets=true&limit=20";
const KALSHI_OUTCOME: Record<string, { bps: number; atLeast?: boolean }> = {
  C26: { bps: -50, atLeast: true },
  C25: { bps: -25 },
  H0: { bps: 0 },
  H25: { bps: 25 },
  H26: { bps: 50, atLeast: true },
};

interface KalshiMarket {
  ticker: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
}

/** Mid of a two-sided quote; else the last trade. */
function kalshiPrice(m: KalshiMarket): number | null {
  const bid = Number(m.yes_bid_dollars);
  const ask = Number(m.yes_ask_dollars);
  if (bid > 0 && ask > 0 && ask >= bid) return (bid + ask) / 2;
  const last = Number(m.last_price_dollars);
  return Number.isFinite(last) && last >= 0 ? last : null;
}

/**
 * Next six meetings. Probabilities are normalised to sum to 1 (bid/ask mids rarely do exactly).
 * The implied path adds each meeting's expected move to EFFR — expectations add up whatever the
 * correlation between meetings; ">25bp" outcomes count as 50bp, so it is a slight understatement
 * when those carry weight.
 */
async function fedMeetingsFromKalshi(effr: number, now: number): Promise<FedMeeting[]> {
  const res = await fetch(KALSHI_EVENTS, { headers: { "User-Agent": "macro-terminal/0.1", Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Kalshi FOMC markets: HTTP ${res.status}`);
  const body = (await res.json()) as { events?: { event_ticker: string; strike_date?: string; markets?: KalshiMarket[] }[] };
  const events = (body.events ?? [])
    .filter((e) => e.strike_date && Date.parse(e.strike_date) > now - 6 * 3600_000)
    .sort((a, b) => Date.parse(a.strike_date!) - Date.parse(b.strike_date!))
    .slice(0, 6);
  const out: FedMeeting[] = [];
  let rate = effr;
  for (const e of events) {
    const dist: FedMeeting["dist"] = [];
    for (const m of e.markets ?? []) {
      const o = KALSHI_OUTCOME[m.ticker.split("-").pop() ?? ""];
      const p = kalshiPrice(m);
      if (o && p !== null) dist.push({ moveBps: o.bps, prob: p, ...(o.atLeast ? { atLeast: true } : {}) });
    }
    const total = dist.reduce((s, d) => s + d.prob, 0);
    if (dist.length < 3 || !(total > 0.5)) break; // thin or broken book: stop the path here
    for (const d of dist) d.prob /= total;
    dist.sort((a, b) => a.moveBps - b.moveBps);
    const sum = (pred: (m: number) => boolean) => dist.filter((d) => pred(d.moveBps)).reduce((s, d) => s + d.prob, 0);
    rate += dist.reduce((s, d) => s + (d.prob * d.moveBps) / 100, 0);
    out.push({
      date: e.strike_date!.slice(0, 10),
      contract: e.event_ticker.split("-").pop() ?? e.event_ticker,
      impliedRate: rate,
      dist: dist.filter((d) => d.prob > 0.0005),
      cutProb: sum((m) => m < 0),
      holdProb: sum((m) => m === 0),
      hikeProb: sum((m) => m > 0),
    });
  }
  if (!out.length) throw new Error("Kalshi FOMC markets: no open meetings with prices");
  return out;
}

/** CME futures when Yahoo answers (it blocks most cloud servers); Kalshi otherwise. */
async function fedMeetings(effr: number, now: number): Promise<{ meetings: FedMeeting[]; source: "CME" | "KALSHI" }> {
  try {
    return { meetings: await fedMeetingsFromFutures(effr, now), source: "CME" };
  } catch (err) {
    try {
      return { meetings: await fedMeetingsFromKalshi(effr, now), source: "KALSHI" };
    } catch (err2) {
      throw new Error(`${err instanceof Error ? err.message : err}; ${err2 instanceof Error ? err2.message : err2}`);
    }
  }
}

// ---------------------------------------------------------------- Balance sheets (monthly, USD trillions)

async function balanceSheets(now: number): Promise<BalanceSheetPoint[]> {
  const end = isoDay(now);
  const start = isoDay(now - Math.round(5.3 * 365) * DAY);
  const [walcl, ecb, boj, eur, jpy, spx, gold, btc] = await Promise.all([
    fetchObservations("WALCL", start, end), // USD millions
    fetchObservations("ECBASSETSW", start, end), // EUR millions
    fetchObservations("JPNASSETS", start, end), // JPY 100 millions
    fetchObservations("DEXUSEU", start, end), // USD per EUR
    fetchObservations("DEXJPUS", start, end), // JPY per USD
    monthlyCloses("SPY", 66),
    monthlyCloses("GLD", 66),
    monthlyCloses("BTC/USD", 66),
  ]);
  // Month-end grid: the last 60 completed-or-current months, each read "as of" its final day.
  const ends: string[] = [];
  const d = new Date(now);
  for (let k = 59; k >= 0; k--) {
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k + 1, 0));
    ends.push(isoDay(Math.min(last.getTime(), now)));
  }
  const col = (o: Obs[]) => asOf(o, ends);
  const [f, e, b, fxE, fxJ, s, g, c] = [walcl, ecb, boj, eur, jpy, spx, gold, btc].map(col);
  const out: BalanceSheetPoint[] = [];
  ends.forEach((date, i) => {
    const v = [f[i], e[i], b[i], fxE[i], fxJ[i], s[i], g[i], c[i]];
    if (v.some((x) => x === undefined)) return;
    const [fed, ecbEur, bojJpy, eurusd, usdjpy, SPY, GLD, BTC] = v as number[];
    out.push({
      date: `${date.slice(0, 7)}-01`,
      fed: fed / 1e6,
      ecb: (ecbEur * eurusd) / 1e6,
      boj: bojJpy / usdjpy / 1e4, // (v × 1e8 JPY) / usdjpy / 1e12
      SPY,
      GLD,
      BTC,
    });
  });
  if (out.length < 24) throw new Error("balance sheets: history too short");
  return out;
}

// ---------------------------------------------------------------- Policy bundle

async function pullPolicy(): Promise<PolicyPayload> {
  const now = Date.now();
  const end = isoDay(now);
  const start2y = isoDay(now - 2 * 365 * DAY);
  const [rates, cpi, upper, lower, effrObs, core] = await Promise.all([
    bisSeries("WS_CBPOL", `D.${BANKS.map((b) => b.area).join("+")}`, `startPeriod=${start2y}`),
    bisSeries("WS_LONG_CPI", `M.${BANKS.map((b) => b.area).join("+")}.771`, "lastNObservations=1"),
    fetchObservations("DFEDTARU", start2y, end),
    fetchObservations("DFEDTARL", start2y, end),
    fetchObservations("EFFR", isoDay(now - 30 * DAY), end),
    fetchObservations("CPILFESL", isoDay(now - 500 * DAY), end),
  ]);

  const banks: CentralBankRow[] = BANKS.map((b) => {
    const obs = rates.get(b.area);
    const c = cpi.get(b.area)?.at(-1);
    if (!obs?.length || !c) throw new Error(`BIS: no data for ${b.area}`);
    // The Fed sets a range; BIS reports its midpoint, so take the bounds from FRED instead.
    const isFed = b.code === "FED";
    const series = isFed ? upper : obs;
    const rate = series[series.length - 1].value;
    const move = lastMove(series);
    return {
      code: b.code,
      bank: b.bank,
      ccy: b.ccy,
      rate,
      rateLabel: isFed ? `${lower[lower.length - 1].value.toFixed(2)}–${rate.toFixed(2)}` : rate.toFixed(2),
      lastMoveBps: move.bps,
      lastMoveDate: move.date,
      cpi: c.value,
      cpiAsOf: c.date,
      bias: biasOf(move, now),
    };
  });

  const effr = effrObs[effrObs.length - 1];
  const coreNow = core[core.length - 1];
  // Year-ago index level; if that month was never published, use the one before and annualise.
  const target = `${Number(coreNow.date.slice(0, 4)) - 1}${coreNow.date.slice(4)}`;
  const coreYearAgo = [...core].reverse().find((o) => o.date <= target);
  if (!coreYearAgo) throw new Error("FRED CPILFESL: year-ago observation missing");
  const monthsApart = (Date.parse(coreNow.date) - Date.parse(coreYearAgo.date)) / (30.4375 * DAY);
  const coreYoY = ((coreNow.value / coreYearAgo.value) ** (12 / monthsApart) - 1) * 100;

  return {
    fetchedAt: new Date(now).toISOString(),
    banks,
    fed: {
      lower: lower[lower.length - 1].value,
      upper: upper[upper.length - 1].value,
      effr: effr.value,
      effrAsOf: effr.date,
      coreCpi: Math.round(coreYoY * 10) / 10,
    },
    meetings: [],
    meetingsSource: null,
    balance: [],
  };
}

const policyCore = () => cached("live:policy", 15 * MIN, pullPolicy, 20_000);
const fedPath = (effr: number) => cached("live:fedpath", 15 * MIN, () => fedMeetings(effr, Date.now()), 60_000);
const balanceHistory = () => cached("live:balance", 6 * 60 * MIN, () => balanceSheets(Date.now()), 60_000);

/**
 * Rates, CPI and the Fed range (BIS + FRED) are the core; meeting probabilities (CME futures via
 * Yahoo, else Kalshi) and the balance-sheet history are attached when available, so a failure in
 * either leaves the rest of the policy panes working.
 */
export async function getPolicy(): Promise<PolicyPayload | null> {
  const core = await policyCore();
  if (!core) return null;
  const [path, balance] = await Promise.all([fedPath(core.fed.effr), balanceHistory()]);
  return { ...core, meetings: path?.meetings ?? [], meetingsSource: path?.source ?? null, balance: balance ?? [] };
}

// ---------------------------------------------------------------- CFTC Commitments of Traders

type CotDef = { key: string; label: string; code: string; report: "TFF" | "DISAGG" };
export const COT_DEFS: CotDef[] = [
  { key: "ES", label: "S&P 500", code: "13874A", report: "TFF" },
  { key: "GC", label: "Gold", code: "088691", report: "DISAGG" },
  { key: "CL", label: "WTI", code: "067651", report: "DISAGG" },
  { key: "6E", label: "EUR", code: "099741", report: "TFF" },
  { key: "6J", label: "JPY", code: "097741", report: "TFF" },
  { key: "ZN", label: "UST 10Y", code: "043602", report: "TFF" },
];

const COT_SHAPE = {
  // Traders in Financial Futures: real-money institutions vs hedge funds / CTAs.
  TFF: {
    file: "fut_fin_txt",
    name: "Traders in Financial Futures",
    labels: ["Asset managers", "Leveraged funds"] as [string, string],
    a: ["Asset_Mgr_Positions_Long_All", "Asset_Mgr_Positions_Short_All"],
    b: ["Lev_Money_Positions_Long_All", "Lev_Money_Positions_Short_All"],
  },
  // Disaggregated report for physical commodities: commercial hedgers vs speculative funds.
  DISAGG: {
    file: "fut_disagg_txt",
    name: "Disaggregated",
    labels: ["Producers / merchants", "Managed money"] as [string, string],
    a: ["Prod_Merc_Positions_Long_All", "Prod_Merc_Positions_Short_All"],
    b: ["M_Money_Positions_Long_All", "M_Money_Positions_Short_All"],
  },
};

/** The single file inside a zip archive (CFTC's yearly archives hold one deflated .txt). */
export function unzipSingle(buf: Buffer): Buffer {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: end of central directory not found");
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error("zip: bad central directory");
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  if (method === 0) return data;
  if (method === 8) return inflateRawSync(data);
  throw new Error(`zip: unsupported compression method ${method}`);
}

/**
 * One year of a CFTC report, parsed. Fetched from the cftc.gov file archive rather than the
 * publicreporting.cftc.gov API, which refuses many cloud-provider IP ranges.
 */
/**
 * GET over HTTP/2. cftc.gov's CDN refuses Node's HTTP/1.1 clients (fetch and https) with a 403
 * while accepting the same request, same User-Agent, over HTTP/2 — as curl sends it.
 */
function getH2(url: string, what: string, timeoutMs = 60_000): Promise<Buffer> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const session = connect(u.origin);
    const fail = (err: Error) => {
      session.destroy();
      reject(new Error(`${what}: ${err.message}`));
    };
    const timer = setTimeout(() => fail(new Error("timeout")), timeoutMs);
    session.on("error", fail);
    const req = session.request({ ":method": "GET", ":path": u.pathname + u.search, "user-agent": UA["User-Agent"] });
    const chunks: Buffer[] = [];
    req.on("response", (h) => {
      const status = Number(h[":status"]);
      if (status !== 200) {
        clearTimeout(timer);
        fail(new Error(`HTTP ${status}`));
      }
    });
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      clearTimeout(timer);
      session.close();
      resolve(Buffer.concat(chunks));
    });
    req.on("error", fail);
    req.end();
  });
}

async function cftcYear(file: string, year: number): Promise<{ head: string[]; rows: string[][] }> {
  const zip = await getH2(`https://www.cftc.gov/files/dea/history/${file}_${year}.zip`, `CFTC ${file} ${year}`);
  const rows = parseCsv(unzipSingle(zip).toString("latin1")).filter((r) => r.length > 3);
  return { head: rows[0].map((h) => h.trim()), rows: rows.slice(1) };
}

const cftcFile = (file: string, year: number) => cached(`live:cftc:${file}:${year}`, 6 * 60 * MIN, () => cftcYear(file, year), 60_000);

async function pullCot(def: CotDef): Promise<CotPayload> {
  const shape = COT_SHAPE[def.report];
  const year = new Date().getUTCFullYear();
  const years = await Promise.all([year - 2, year - 1, year].map((y) => cftcFile(shape.file, y)));
  const points: CotPayload["points"] = [];
  let market = "";
  for (const y of years) {
    if (!y) continue; // e.g. this year's archive not published yet in early January
    const col = (name: string) => {
      const i = y.head.indexOf(name);
      if (i < 0) throw new Error(`CFTC ${shape.file}: column ${name} missing`);
      return i;
    };
    const [iCode, iDate, iName] = [col("CFTC_Contract_Market_Code"), col("Report_Date_as_YYYY-MM-DD"), col("Market_and_Exchange_Names")];
    const [al, as, bl, bs] = [...shape.a, ...shape.b].map(col);
    for (const r of y.rows) {
      if (r[iCode]?.trim() !== def.code) continue;
      const a = (Number(r[al]) - Number(r[as])) / 1000;
      const b = (Number(r[bl]) - Number(r[bs])) / 1000;
      if (Number.isFinite(a) && Number.isFinite(b)) points.push({ date: r[iDate].slice(0, 10), a, b });
      market ||= r[iName].trim();
    }
  }
  points.sort((x, y) => (x.date < y.date ? -1 : 1));
  const dedup = points.filter((p, i) => i === 0 || p.date !== points[i - 1].date).slice(-104);
  if (dedup.length < 8) throw new Error(`CFTC ${def.key}: only ${dedup.length} reports`);
  return { key: def.key, market, report: shape.name, labels: shape.labels, points: dedup };
}

export const getCot = (key: string) => {
  const def = COT_DEFS.find((d) => d.key === key);
  return def ? cached(`live:cot:${key}`, 60 * MIN, () => pullCot(def), 20_000) : Promise.resolve(null);
};

// ---------------------------------------------------------------- Economic calendar

const IMPACT: Record<string, 1 | 2 | 3> = { High: 3, Medium: 2, Low: 1 };

async function pullCalendar(): Promise<CalendarEvent[]> {
  const res = await get("https://nfs.faireconomy.media/ff_calendar_thisweek.json", "calendar");
  const rows = (await res.json()) as { title: string; country: string; date: string; impact: string; forecast?: string; previous?: string }[];
  const out = rows
    .filter((r) => IMPACT[r.impact] && r.country !== "All" && !Number.isNaN(Date.parse(r.date)))
    .map((r, i) => ({
      id: `ff${i}`,
      time: new Date(r.date).toISOString(),
      ccy: r.country,
      event: r.title,
      impact: IMPACT[r.impact],
      forecast: r.forecast ?? "",
      previous: r.previous ?? "",
    }))
    .sort((a, b) => (a.time < b.time ? -1 : 1));
  if (!out.length) throw new Error("calendar: empty feed");
  return out;
}

// The publisher asks for no more than a couple of requests every five minutes; one an hour is plenty.
export const getCalendar = () => cached("live:calendar", 60 * MIN, pullCalendar, 5 * MIN);

// ---------------------------------------------------------------- Headlines

const FEEDS: { category: string; url: string }[] = [
  { category: "FED", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
  { category: "ECB", url: "https://www.ecb.europa.eu/rss/press.html" },
  { category: "BOJ", url: "https://www.boj.or.jp/en/rss/whatsnew.xml" },
  { category: "CNBC ECONOMY", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258" },
];

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();

export function parseRss(xml: string, category: string): NewsItem[] {
  const tag = (block: string, name: string) => block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"))?.[1];
  const out: NewsItem[] = [];
  for (const block of xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []) {
    const headline = decode(tag(block, "title") ?? "");
    const url = decode(tag(block, "link") ?? "").replace(/([^:])\/{2,}/g, "$1/");
    const time = Date.parse(decode(tag(block, "pubDate") ?? tag(block, "dc:date") ?? ""));
    if (!headline || !/^https?:\/\//.test(url) || Number.isNaN(time)) continue;
    out.push({ id: `${category}:${url}`, time, category, headline, url, sentiment: classifySentiment(headline) });
  }
  return out;
}

async function pullNews(): Promise<NewsItem[]> {
  const results = await Promise.allSettled(
    FEEDS.map(async (f) => parseRss(await (await get(f.url, `news ${f.category}`, "application/rss+xml, application/xml, text/xml")).text(), f.category)),
  );
  const items = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (!items.length) throw new Error("news: every feed failed");
  const seen = new Set<string>();
  return items
    .filter((n) => n.time <= Date.now() + 5 * MIN && !seen.has(n.id) && seen.add(n.id))
    .sort((a, b) => b.time - a.time)
    .slice(0, 50);
}

export const getNews = () => cached("live:news", 3 * MIN, pullNews, 30_000);

// ---------------------------------------------------------------- Order book and trade flow (Kraken BTC/USD)

async function pullBook(): Promise<BookPayload> {
  const [depthRes, tradesRes] = await Promise.all([
    get("https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=25", "Kraken depth"),
    get("https://api.kraken.com/0/public/Trades?pair=XBTUSD&count=1000", "Kraken trades"),
  ]);
  const depth = (await depthRes.json()) as { error: string[]; result?: Record<string, { asks: [string, string, number][]; bids: [string, string, number][] }> };
  const trades = (await tradesRes.json()) as { error: string[]; result?: Record<string, unknown> };
  const book = depth.result && Object.values(depth.result)[0];
  const prints = trades.result && (Object.values(trades.result).find(Array.isArray) as [string, string, number, string][] | undefined);
  if (!book || !prints) throw new Error(`Kraken: ${[...depth.error, ...trades.error].join("; ") || "empty response"}`);
  const levels = (side: [string, string, number][]) => side.map(([px, sz]) => ({ px: Number(px), sz: Number(sz) }));

  // Net taker volume per minute: "b" = a market buy lifted the offer, "s" = a market sell hit the bid.
  const perMin = new Map<number, number>();
  for (const [, vol, time, side] of prints) {
    const m = Math.floor(time / 60);
    perMin.set(m, (perMin.get(m) ?? 0) + (side === "b" ? 1 : -1) * Number(vol));
  }
  const lastMin = Math.floor(Date.now() / 60_000);
  const firstMin = Math.max(lastMin - 39, Math.min(...perMin.keys()));
  const deltas: number[] = [];
  for (let m = firstMin; m <= lastMin; m++) deltas.push(Math.round((perMin.get(m) ?? 0) * 1000) / 1000);

  return { symbol: "BTC/USD", venue: "Kraken", asOf: Date.now(), book: { asks: levels(book.asks), bids: levels(book.bids) }, deltas };
}

export const getBook = () => cached("live:book", 2_000, pullBook, 5_000, { live: true });

// ---------------------------------------------------------------- Flow proxy: ETF return z-scores

const FLOW_ETFS: [cls: string, name: string, etf: string][] = [
  ["FX", "USD", "UUP"],
  ["FX", "EUR", "FXE"],
  ["FX", "JPY", "FXY"],
  ["FX", "EM FX", "CEW"],
  ["Commodities", "Gold", "GLD"],
  ["Commodities", "Energy", "XLE"],
  ["Commodities", "Ind. Metals", "DBB"],
  ["Equities", "US", "SPY"],
  ["Equities", "Europe", "VGK"],
  ["Equities", "EM", "EEM"],
  ["Fixed Income", "UST", "IEF"],
  ["Fixed Income", "Credit", "LQD"],
  ["Fixed Income", "EM Debt", "EMB"],
];
export const FLOW_DAYS = [1, 5, 21, 63];

/**
 * There is no free, public fund-flow feed, so this is a proxy: each bucket's ETF return over the
 * window, divided by what its own daily volatility (trailing year) would make a typical move of
 * that length. +2 means an unusually strong bid for the bucket, −2 unusually strong selling.
 */
async function pullFlows(): Promise<{ rows: FlowRow[]; asOf: string }> {
  let asOf = "";
  const rows: FlowRow[] = [];
  // Sequential: each ETF is one Twelve Data credit, and the client paces them under the per-minute limit.
  for (const [cls, name, etf] of FLOW_ETFS) {
    const obs = await dailyCloses(etf, 260);
    const px = obs.map((o) => o.value).filter((v) => v > 0);
    if (px.length < 120) throw new Error(`flow ETFs: no history for ${etf}`);
    if (obs[obs.length - 1].date > asOf) asOf = obs[obs.length - 1].date;
    const rets = px.slice(1).map((p, i) => Math.log(p / px[i]));
    const mean = rets.reduce((a, r) => a + r, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length) || 1e-9;
    const z = FLOW_DAYS.map((w) => {
      const r = Math.log(px[px.length - 1] / px[px.length - 1 - w]);
      return Math.round(Math.max(-3, Math.min(3, r / (sd * Math.sqrt(w)))) * 100) / 100;
    });
    rows.push({ cls, name, etf, z });
  }
  return { rows, asOf };
}

// Daily data: refreshed every 6 hours (13 credits each time on Twelve Data).
export const getFlows = () => cached("live:flows", 6 * 60 * MIN, pullFlows, 2 * MIN);
