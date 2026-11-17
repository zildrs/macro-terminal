"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ColorType, createChart, CrosshairMode, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PaneNotice, Panel, Segmented, SourceTag } from "@/components/ui/panel";
import { axisProps, ChartTip, cursorProps, GRID_STROKE, longDate, monthTick, SERIES } from "@/components/ui/chart";
import { CHART_GROUPS, getInstrument, INSTRUMENTS, TIMEFRAMES } from "@/lib/instruments";
import { useTerminal } from "@/lib/store";
import type { AssetGroup, Candle, CandlesPayload, CotPayload, DataSource, Timeframe } from "@/lib/types";
import { cn, dirClass, fmt, fmtSigned } from "@/lib/utils";

// ---------------------------------------------------------------- Multi-asset chart

type ChartKind = "CANDLE" | "LINE";
const VISIBLE_BARS = 110;

interface Loaded {
  key: string;
  source: DataSource;
  candles: Candle[];
}

const CANDLE_TTL_MS = 5 * 60_000;
const candleCache = new Map<string, { at: number; promise: Promise<Loaded> }>();

const RETRY_MS = 6_000;

/** Real history from /api/candles, cached for 5 min. Rejects when the feed has nothing for us. */
function loadCandles(symbol: string, tf: Timeframe): Promise<Loaded> {
  const key = `${symbol}:${tf}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < CANDLE_TTL_MS) return hit.promise;
  const promise = fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${tf}`, { cache: "no-store" })
    .then(async (res) => {
      if (res.ok) return res.json() as Promise<CandlesPayload>;
      const body = (await res.json().catch(() => ({}))) as { error?: string; unsupported?: boolean };
      throw Object.assign(new Error(body.error ?? String(res.status)), { unsupported: !!body.unsupported });
    })
    .then((body): Loaded => {
      if (!body.candles.length) throw new Error("no history");
      return { key, source: body.source, candles: body.candles };
    });
  candleCache.set(key, { at: Date.now(), promise });
  promise.catch(() => candleCache.delete(key)); // don't cache failures
  return promise;
}

export function AssetChart() {
  const symbol = useTerminal((s) => s.activeSymbol);
  const tf = useTerminal((s) => s.timeframe);
  const setSymbol = useTerminal((s) => s.setSymbol);
  const setTimeframe = useTerminal((s) => s.setTimeframe);
  const nonce = useTerminal((s) => s.cursorNonce);
  const quote = useTerminal((s) => s.quotes[symbol]);
  const inst = getInstrument(symbol);

  const [group, setGroup] = useState<AssetGroup>(inst.group);
  const [kind, setKind] = useState<ChartKind>("CANDLE");
  const [hover, setHover] = useState<Candle | null>(null);
  const [lastBar, setLastBar] = useState<Candle | null>(null);
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = `${symbol}:${tf}`;
  const loading = loaded?.key !== key;
  /** Key whose history failed to load; cleared on success. */
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failMsg, setFailMsg] = useState<string | null>(null);

  useEffect(() => setGroup(inst.group), [inst.group]);

  // Fetch history; the previous chart stays up (dimmed) meanwhile.
  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    loadCandles(symbol, tf).then(
      (res) => {
        if (!alive) return;
        setFailed(null);
        setLoaded(res);
      },
      (err: Error & { unsupported?: boolean }) => {
        if (!alive) return;
        setFailed(`${symbol}:${tf}`);
        setFailMsg(err.unsupported ? err.message : null);
        if (!err.unsupported) retry = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS);
      },
    );
    return () => {
      alive = false;
      clearTimeout(retry);
    };
  }, [symbol, tf, attempt]);

  useEffect(() => {
    const el = elRef.current;
    if (!el || !loaded) return;
    const [symbol, tf] = loaded.key.split(":") as [string, Timeframe];
    const { decimals } = getInstrument(symbol);
    const candles = loaded.candles.slice();
    const last = { ...candles[candles.length - 1] };
    const sync = (price: number) => {
      last.close = price;
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
    };
    // The forming bar follows the quote feed.
    const q0 = useTerminal.getState().quotes[symbol];
    if (q0) sync(q0.price);
    candles[candles.length - 1] = last;
    setLastBar({ ...last });
    setHover(null);

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#71717a",
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        fontSize: 10,
      },
      grid: { vertLines: { color: "#1f1f23" }, horzLines: { color: "#1f1f23" } },
      rightPriceScale: { borderColor: "#27272a" },
      timeScale: { borderColor: "#27272a", timeVisible: tf === "1H" || tf === "4H", secondsVisible: false },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#52525b", labelBackgroundColor: "#3f3f46" },
        horzLine: { color: "#52525b", labelBackgroundColor: "#3f3f46" },
      },
    });
    chartRef.current = chart;

    const priceFormat = { type: "price" as const, precision: decimals, minMove: 10 ** -decimals };
    const t = (c: Candle) => c.time as UTCTimestamp;

    const volume = chart.addHistogramSeries({ priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
    volume.setData(candles.map((c) => ({ time: t(c), value: c.volume, color: c.close >= c.open ? "rgba(34,197,94,0.28)" : "rgba(239,68,68,0.28)" })));

    let push: (c: Candle) => void;
    let main;
    if (kind === "CANDLE") {
      const s = chart.addCandlestickSeries({
        upColor: "#22c55e",
        downColor: "#ef4444",
        wickUpColor: "#22c55e",
        wickDownColor: "#ef4444",
        borderVisible: false,
        priceFormat,
      });
      s.setData(candles.map((c) => ({ time: t(c), open: c.open, high: c.high, low: c.low, close: c.close })));
      push = (c) => s.update({ time: t(c), open: c.open, high: c.high, low: c.low, close: c.close });
      main = s;
    } else {
      const s = chart.addAreaSeries({
        lineColor: SERIES.s1,
        lineWidth: 2,
        topColor: "rgba(57,135,229,0.25)",
        bottomColor: "rgba(57,135,229,0)",
        priceFormat,
      });
      s.setData(candles.map((c) => ({ time: t(c), value: c.close })));
      push = (c) => s.update({ time: t(c), value: c.close });
      main = s;
    }
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, candles.length - VISIBLE_BARS), to: candles.length + 3 });

    const byTime = new Map(candles.map((c) => [c.time, c]));
    chart.subscribeCrosshairMove((param) => {
      const c = typeof param.time === "number" ? byTime.get(param.time) : undefined;
      setHover(c && param.seriesData.has(main) ? c : null);
    });

    // Live ticks update the forming bar without re-rendering React.
    const unsub = useTerminal.subscribe((state) => {
      const p = state.quotes[symbol]?.price;
      if (p === undefined || p === last.close) return;
      sync(p);
      push(last);
      setLastBar({ ...last });
    });

    return () => {
      unsub();
      chart.remove();
      chartRef.current = null;
    };
  }, [loaded, kind]);

  // Esc clears the crosshair.
  useEffect(() => {
    chartRef.current?.clearCrosshairPosition();
    setHover(null);
  }, [nonce]);

  const bar = hover ?? lastBar;
  const symbols = INSTRUMENTS.filter((i) => i.group === group);

  return (
    <Panel
      title="Multi-Asset Chart"
      tag="M3"
      right={
        <>
          {loaded && <SourceTag source={loaded.source} />}
          <Segmented label="Chart type" value={kind} options={["CANDLE", "LINE"] as const} onChange={setKind} />
          <Segmented label="Timeframe" value={tf} options={TIMEFRAMES} onChange={setTimeframe} />
        </>
      }
    >
      <div className="mb-1 flex items-center gap-2 overflow-x-auto">
        <Segmented label="Asset class" value={group} options={CHART_GROUPS.map((g) => ({ value: g.group, label: g.label }))} onChange={setGroup} className="shrink-0" />
        <div className="flex shrink-0 items-center gap-0.5">
          {symbols.map((i) => (
            <button
              key={i.symbol}
              type="button"
              onClick={() => setSymbol(i.symbol)}
              aria-pressed={i.symbol === symbol}
              title={i.name}
              className={cn(
                "num h-[18px] rounded-sm px-1.5 text-2xs leading-none transition-colors",
                i.symbol === symbol ? "bg-warn/15 text-warn" : "text-ink-3 hover:bg-raised hover:text-ink-2",
              )}
            >
              {i.symbol}
            </button>
          ))}
        </div>
      </div>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0">
        <span className="num text-sm font-semibold text-ink">{symbol}</span>
        {quote && (
          <>
            <span className="num text-sm text-ink">
              {fmt(quote.price, inst.decimals)}
              {inst.unit ?? ""}
            </span>
            <span className={cn("num text-xs", dirClass(quote.changePct))}>
              {fmtSigned(quote.change, inst.decimals)} ({fmtSigned(quote.changePct, 2, "%")})
            </span>
          </>
        )}
        {bar && !loading && (
          <span className="num ml-auto flex gap-2 text-2xs text-ink-3">
            <span>O <span className="text-ink-2">{fmt(bar.open, inst.decimals)}</span></span>
            <span>H <span className="text-ink-2">{fmt(bar.high, inst.decimals)}</span></span>
            <span>L <span className="text-ink-2">{fmt(bar.low, inst.decimals)}</span></span>
            <span>C <span className={bar.close >= bar.open ? "text-up" : "text-down"}>{fmt(bar.close, inst.decimals)}</span></span>
          </span>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={elRef}
          className={cn("absolute inset-0 transition-opacity", loading && "opacity-30")}
          role="img"
          aria-label={`${inst.name} ${tf} price chart`}
        />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-2xs text-ink-3" role="status">
            {failed === key ? (failMsg ?? `Price history for ${symbol} ${tf} is unavailable — retrying…`) : `Loading ${symbol} ${tf}…`}
          </div>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- COT tracker

const COT_CONTRACTS = [
  { key: "ES", label: "S&P 500" },
  { key: "GC", label: "Gold" },
  { key: "CL", label: "WTI" },
  { key: "6E", label: "EUR" },
  { key: "6J", label: "JPY" },
  { key: "ZN", label: "UST 10Y" },
] as const;
type CotKey = (typeof COT_CONTRACTS)[number]["key"];

const cotCache = new Map<string, Promise<CotPayload>>();
function loadCot(key: string): Promise<CotPayload> {
  let p = cotCache.get(key);
  if (!p) {
    p = fetch(`/api/cot?key=${key}`, { cache: "no-store" }).then((res) => (res.ok ? (res.json() as Promise<CotPayload>) : Promise.reject(new Error(String(res.status)))));
    cotCache.set(key, p);
    p.catch(() => cotCache.delete(key));
  }
  return p;
}

export function CotTracker() {
  const [key, setKey] = useState<CotKey>("ES");
  const nonce = useTerminal((s) => s.cursorNonce);
  const [cot, setCot] = useState<CotPayload | null>(null);
  const [down, setDown] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    loadCot(key).then(
      (res) => {
        if (!alive) return;
        setDown(false);
        setCot(res);
      },
      () => {
        if (!alive) return;
        setDown(true);
        retry = setTimeout(() => setAttempt((n) => n + 1), 10_000);
      },
    );
    return () => {
      alive = false;
      clearTimeout(retry);
    };
  }, [key, attempt]);

  const ready = cot?.key === key;
  const data = ready ? cot.points.slice(-52) : [];
  const last = data[data.length - 1];
  const prev = data[data.length - 2];
  const def = COT_CONTRACTS.find((c) => c.key === key)!;

  const Row = ({ color, label, v, d }: { color: string; label: string; v: number; d: number }) => (
    <div className="flex items-center gap-1.5 text-2xs">
      <span aria-hidden className="h-0 w-3 shrink-0 border-t-2" style={{ borderColor: color }} />
      <span className="truncate text-ink-2">{label}</span>
      <span className="num ml-auto text-ink">{fmtSigned(v, 0)}K</span>
      <span className={cn("num w-9 text-right", dirClass(d))} title="Change on the week, thousand contracts">{fmtSigned(d, 0)}</span>
    </div>
  );

  return (
    <Panel
      title="COT Positioning"
      tag="M3"
      right={ready && <SourceTag source="CFTC" asOf={last.date} title={`CFTC ${cot.report} report — ${cot.market}. Positions as of ${last.date}.`} />}
      bodyClassName="cq"
    >
      <div className="mb-1 flex items-center gap-0.5 overflow-x-auto">
        {COT_CONTRACTS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setKey(c.key)}
            aria-pressed={c.key === key}
            title={c.label}
            className={cn(
              "num h-[18px] shrink-0 rounded-sm px-1.5 text-2xs leading-none transition-colors",
              c.key === key ? "bg-line-strong text-ink" : "text-ink-3 hover:bg-raised hover:text-ink-2",
            )}
          >
            {c.key}
          </button>
        ))}
        <span className="ml-auto shrink-0 pl-2 text-2xs text-ink-3">
          {def.label}
          <span className="cq-wide"> · net contracts, weekly{ready && ` · as of ${shortDay(last.date)}`}</span>
        </span>
      </div>
      {!ready || !last || !prev ? (
        <PaneNotice down={down} what={`${def.label} positioning`} />
      ) : (
        <>
          <div className="mb-1 space-y-0.5">
            <Row color={SERIES.s1} label={cot.labels[0]} v={last.a} d={last.a - prev.a} />
            <Row color={SERIES.s2} label={cot.labels[1]} v={last.b} d={last.b - prev.b} />
          </div>
          <div className="min-h-0 flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart key={nonce} data={data} margin={{ top: 4, right: 6, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={GRID_STROKE} vertical={false} />
                <XAxis dataKey="date" {...axisProps} tickFormatter={monthTick} minTickGap={44} />
                <YAxis {...axisProps} width={38} tickFormatter={(v: number) => fmt(v, 0)} />
                <ReferenceLine y={0} stroke="#52525b" />
                <Tooltip
                  cursor={cursorProps}
                  isAnimationActive={false}
                  content={<ChartTip labelFormat={(l) => `As of ${longDate(l)}`} valueFormat={(v) => `${fmtSigned(v, 1)}K`} />}
                />
                <Line dataKey="a" name={cot.labels[0]} stroke={SERIES.s1} strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line dataKey="b" name={cot.labels[1]} stroke={SERIES.s2} strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </Panel>
  );
}

const shortDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

// ---------------------------------------------------------------- Orderflow & imbalance radar

function LadderRow({ px, sz, max, side }: { px: number; sz: number; max: number; side: "bid" | "ask" }) {
  return (
    <div className="relative flex h-[13px] shrink-0 items-center justify-between px-1">
      <span
        aria-hidden
        className={cn("absolute inset-y-0 right-0", side === "bid" ? "bg-up/15" : "bg-down/15")}
        style={{ width: `${(sz / max) * 100}%` }}
      />
      <span className={cn("num relative text-2xs leading-none", side === "bid" ? "text-up" : "text-down")}>{fmt(px, 1)}</span>
      <span className="num relative text-2xs leading-none text-ink-2">{fmt(sz, 3)}</span>
    </div>
  );
}

const BOOK_POLL_MS = 3_000;

/**
 * Real level-2 book and taker flow. Public order books only exist for crypto, so this pane is
 * always BTC/USD on Kraken, whatever instrument the chart is showing.
 */
export function OrderflowRadar() {
  const active = useTerminal((s) => s.activeSymbol);
  const data = useTerminal((s) => s.book);
  const down = useTerminal((s) => !!s.down.book);

  useEffect(() => {
    const { fetchBook } = useTerminal.getState();
    fetchBook();
    const id = setInterval(fetchBook, BOOK_POLL_MS);
    return () => clearInterval(id);
  }, []);

  if (!data) {
    return (
      <Panel title="Orderflow Radar" tag="M3" right={<span className="num text-2xs text-warn">BTC/USD</span>}>
        <PaneNotice down={down} what="Order book" />
      </Panel>
    );
  }

  const { book, deltas } = data;
  const bidVol = book.bids.reduce((s, l) => s + l.sz, 0);
  const askVol = book.asks.reduce((s, l) => s + l.sz, 0);
  const total = bidVol + askVol || 1;
  const bidPct = (bidVol / total) * 100;
  const imbalance = (bidVol - askVol) / total;
  const maxSz = Math.max(...book.bids.map((l) => l.sz), ...book.asks.map((l) => l.sz));
  const spread = book.asks[0].px - book.bids[0].px;
  const mid = (book.asks[0].px + book.bids[0].px) / 2;

  const maxDelta = Math.max(1e-9, ...deltas.map(Math.abs));
  const cumDelta = deltas.reduce((s, d) => s + d, 0);
  const state = imbalance > 0.08 ? { label: "BUY PRESSURE", cls: "text-up" } : imbalance < -0.08 ? { label: "SELL PRESSURE", cls: "text-down" } : { label: "BALANCED", cls: "text-ink-2" };

  return (
    <Panel
      title="Orderflow Radar"
      tag="M3"
      right={
        <>
          <span className="num text-2xs text-warn">BTC/USD</span>
          <SourceTag source="KRAKEN" title="Live level-2 order book and trades from Kraken, refreshed every 3 seconds" />
        </>
      }
    >
      {active !== "BTC/USD" && (
        <p className="mb-1 shrink-0 truncate text-[9px] leading-[11px] text-ink-3" title="Exchanges do not publish free order books for indices, FX, rates or futures">
          No public order book for {active} — showing BTC/USD.
        </p>
      )}
      {/* Book imbalance meter */}
      <div className="shrink-0">
        <div className="flex items-center justify-between text-2xs">
          <span className="num text-ink-2">BID {fmt(bidPct, 0)}%</span>
          <span className={cn("font-semibold", state.cls)}>{state.label}</span>
          <span className="num text-ink-2">ASK {fmt(100 - bidPct, 0)}%</span>
        </div>
        <div className="mt-0.5 flex h-1.5 gap-0.5 overflow-hidden rounded-[1px]" role="img" aria-label={`Book imbalance over the top ${book.bids.length} levels: ${fmt(bidPct, 0)}% bid, ${fmt(100 - bidPct, 0)}% ask`}>
          <div className="bg-up transition-[width] duration-500" style={{ width: `${bidPct}%` }} />
          <div className="flex-1 bg-down" />
        </div>
      </div>

      {/* Ladder: far levels clip first, so it adapts to the pane height */}
      <div className="my-1.5 flex min-h-0 flex-1 flex-col border-y border-line/60">
        <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden">
          {[...book.asks].reverse().map((l) => <LadderRow key={l.px} {...l} max={maxSz} side="ask" />)}
        </div>
        <div className="flex h-4 shrink-0 items-center justify-between bg-raised px-1">
          <span className="num text-xs font-semibold text-ink">{fmt(mid, 1)}</span>
          <span className="num text-2xs text-ink-3">spread {fmt(spread, 1)} · size BTC</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {book.bids.map((l) => <LadderRow key={l.px} {...l} max={maxSz} side="bid" />)}
        </div>
      </div>

      {/* Net buy/sell volume */}
      <div className="shrink-0">
        <div className="flex items-center justify-between text-2xs text-ink-3">
          <span>Net taker volume / min</span>
          <span className="num">
            {deltas.length}m <span className={dirClass(cumDelta)}>{fmtSigned(cumDelta, 2)} BTC</span>
          </span>
        </div>
        <div className="relative mt-0.5 flex h-9 items-stretch gap-px" role="img" aria-label={`Net taker buy minus sell volume per minute, last ${deltas.length} minutes; cumulative ${fmtSigned(cumDelta, 2)} BTC`}>
          <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-line-strong" />
          {deltas.map((d, i) => (
            <span key={i} className="relative flex-1" title={`${fmtSigned(d, 3)} BTC`}>
              <span
                className={cn("absolute inset-x-0 rounded-[1px]", d >= 0 ? "bottom-1/2 bg-up" : "top-1/2 bg-down")}
                style={{ height: `${(Math.abs(d) / maxDelta) * 50}%` }}
              />
            </span>
          ))}
        </div>
      </div>
    </Panel>
  );
}
