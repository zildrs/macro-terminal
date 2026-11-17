// Server-only: the real feeds behind the policy, positioning, calendar, news, order-flow and flow
// panes. Import from route handlers only. Every source here is public and keyless:
//
//   BIS (stats.bis.org)            central bank policy rates, headline CPI y/y
//   FRED                           Fed target range, EFFR, core CPI, Fed / ECB / BoJ total assets, FX
//   Yahoo Finance                  30-day fed funds futures (ZQ), monthly benchmarks, flow-proxy ETFs
//   CFTC (publicreporting.cftc.gov) Commitments of Traders: TFF and disaggregated reports
//   Kraken                         BTC/USD order book and recent trades
//   Forex Factory weekly export    economic calendar (forecast and previous; it carries no actuals)
//   Fed / ECB / BoJ / CNBC RSS     headlines
//
// Each getter returns null when its source is unreachable; panes then say so instead of inventing data.

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
import { getJson as yahooJson, yahooCloses, type YSeries } from "./yahoo";

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
    yahooCloses("^GSPC", "5y", "1mo"),
    yahooCloses("GC=F", "5y", "1mo"),
    yahooCloses("BTC-USD", "5y", "1mo"),
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
    const [fed, ecbEur, bojJpy, eurusd, usdjpy, SPX, GOLD, BTC] = v as number[];
    out.push({
      date: `${date.slice(0, 7)}-01`,
      fed: fed / 1e6,
      ecb: (ecbEur * eurusd) / 1e6,
      boj: bojJpy / usdjpy / 1e4, // (v × 1e8 JPY) / usdjpy / 1e12
      SPX,
      GOLD,
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
  const [rates, cpi, upper, lower, effrObs, core, balance] = await Promise.all([
    bisSeries("WS_CBPOL", `D.${BANKS.map((b) => b.area).join("+")}`, `startPeriod=${start2y}`),
    bisSeries("WS_LONG_CPI", `M.${BANKS.map((b) => b.area).join("+")}.771`, "lastNObservations=1"),
    fetchObservations("DFEDTARU", start2y, end),
    fetchObservations("DFEDTARL", start2y, end),
    fetchObservations("EFFR", isoDay(now - 30 * DAY), end),
    fetchObservations("CPILFESL", isoDay(now - 500 * DAY), end),
    balanceSheets(now),
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
    meetings: await fedMeetingsFromFutures(effr.value, now),
    balance,
  };
}

export const getPolicy = () => cached("live:policy", 15 * MIN, pullPolicy, 20_000);

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
    dataset: "gpe5-46if",
    name: "Traders in Financial Futures",
    labels: ["Asset managers", "Leveraged funds"] as [string, string],
    a: ["asset_mgr_positions_long", "asset_mgr_positions_short"],
    b: ["lev_money_positions_long", "lev_money_positions_short"],
  },
  // Disaggregated report for physical commodities: commercial hedgers vs speculative funds.
  DISAGG: {
    dataset: "72hh-3qpy",
    name: "Disaggregated",
    labels: ["Producers / merchants", "Managed money"] as [string, string],
    a: ["prod_merc_positions_long", "prod_merc_positions_short"],
    b: ["m_money_positions_long_all", "m_money_positions_short_all"],
  },
};

async function pullCot(def: CotDef): Promise<CotPayload> {
  const shape = COT_SHAPE[def.report];
  const q = new URLSearchParams({
    $select: ["report_date_as_yyyy_mm_dd", "market_and_exchange_names", ...shape.a, ...shape.b].join(","),
    $where: `cftc_contract_market_code='${def.code}'`,
    $order: "report_date_as_yyyy_mm_dd DESC",
    $limit: "104",
  });
  const res = await get(`https://publicreporting.cftc.gov/resource/${shape.dataset}.json?${q}`, `CFTC ${def.key}`);
  const rows = (await res.json()) as Record<string, string>[];
  const net = (r: Record<string, string>, [l, s]: string[]) => (Number(r[l]) - Number(r[s])) / 1000;
  const points = rows
    .map((r) => ({ date: r.report_date_as_yyyy_mm_dd.slice(0, 10), a: net(r, shape.a), b: net(r, shape.b) }))
    .filter((p) => Number.isFinite(p.a) && Number.isFinite(p.b))
    .reverse();
  if (points.length < 8) throw new Error(`CFTC ${def.key}: only ${points.length} reports`);
  return { key: def.key, market: rows[0].market_and_exchange_names, report: shape.name, labels: shape.labels, points };
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

export const getBook = () => cached("live:book", 2_000, pullBook, 5_000);

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
  const body = (await yahooJson(
    `/v7/finance/spark?symbols=${FLOW_ETFS.map((f) => f[2]).join(",")}&range=1y&interval=1d`,
    "flow ETFs",
  )) as { spark?: { result?: { symbol: string; response?: YSeries[] }[] } };
  const bySym = new Map((body.spark?.result ?? []).map((r) => [r.symbol, r.response?.[0]]));
  let asOfTs = 0;
  const rows = FLOW_ETFS.map(([cls, name, etf]) => {
    const s = bySym.get(etf);
    const px = (s?.indicators?.quote?.[0]?.close ?? []).filter((c): c is number => typeof c === "number" && c > 0);
    if (px.length < 120) throw new Error(`flow ETFs: no history for ${etf}`);
    asOfTs = Math.max(asOfTs, s?.timestamp?.at(-1) ?? 0);
    const rets = px.slice(1).map((p, i) => Math.log(p / px[i]));
    const mean = rets.reduce((a, r) => a + r, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length) || 1e-9;
    const z = FLOW_DAYS.map((w) => {
      const r = Math.log(px[px.length - 1] / px[px.length - 1 - w]);
      return Math.round(Math.max(-3, Math.min(3, r / (sd * Math.sqrt(w)))) * 100) / 100;
    });
    return { cls, name, etf, z };
  });
  return { rows, asOf: isoDay(asOfTs * 1000) };
}

export const getFlows = () => cached("live:flows", 10 * MIN, pullFlows, 20_000);
