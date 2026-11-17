"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LegendDot, PaneNotice, Panel, Segmented, SourceTag } from "@/components/ui/panel";
import { axisProps, ChartTip, cursorProps, GRID_STROKE, longDate, monthTick, SERIES, shortDate, stepTicks } from "@/components/ui/chart";
import { useTerminal } from "@/lib/store";
import { cn, dirClass, fmt, fmtSigned } from "@/lib/utils";

// ---------------------------------------------------------------- Net liquidity index

const RANGES = { "6M": 26, "1Y": 52, "3Y": 156 } as const;
type Range = keyof typeof RANGES;

function Stat({ label, value, sub, op }: { label: string; value: string; sub?: React.ReactNode; op?: string }) {
  return (
    <div className="flex min-w-0 items-end gap-1.5">
      {op && <span className="num pb-0.5 text-sm text-ink-3">{op}</span>}
      <div className="min-w-0">
        <div className="truncate text-2xs uppercase tracking-wide text-ink-3">{label}</div>
        <div className="num whitespace-nowrap text-sm text-ink">
          {value}
          {sub}
        </div>
      </div>
    </div>
  );
}

export function NetLiquidityChart() {
  const nl = useTerminal((s) => s.macro?.netLiquidity);
  const series = useTerminal((s) => s.series);
  const down = useTerminal((s) => !!s.down.macro);
  const nonce = useTerminal((s) => s.cursorNonce);
  const [range, setRange] = useState<Range>("1Y");

  const data = useMemo(
    () => (series?.liquidity ?? []).slice(-RANGES[range]).map((p) => ({ date: p.date, net: p.net, fed: p.fed, tga: p.tga, rrp: p.rrp })),
    [range, series],
  );
  const netTicks = useMemo(() => (data.length ? stepTicks(data.map((p) => p.net), 0.05) : [0, 1]), [data]);

  if (!nl || !series || !data.length) {
    return (
      <Panel title="Net Liquidity Index" tag="M2">
        <PaneNotice down={down} what="Net liquidity" />
      </Panel>
    );
  }
  const real = true;
  const first = data[0].net;
  const chgRange = (nl.valueTrillionsUSD / first - 1) * 100;
  // FRED liquidity is weekly, so the short-window change is week-over-week rather than 24h.
  const chgShort = nl.change24hPct ?? nl.change1wPct ?? 0;
  const chgShortLabel = nl.change24hPct === null ? "1w" : "24h";

  return (
    <Panel
      title="Net Liquidity Index"
      tag="M2"
      right={
        <>
          <SourceTag source={series.source} asOf={series.liquidityAsOf} />
          <Segmented label="Range" value={range} options={Object.keys(RANGES) as Range[]} onChange={setRange} />
        </>
      }
    >
      <div className="mb-1.5 flex flex-wrap items-end gap-x-4 gap-y-1">
        <div>
          <div className="text-2xs uppercase tracking-wide text-ink-3">
            Net liquidity{real && <span className="num normal-case tracking-normal"> · wk to {shortDate(series.liquidityAsOf)}</span>}
          </div>
          <div className="flex items-baseline gap-2">
            <span className="num text-xl font-semibold leading-6 text-ink">${fmt(nl.valueTrillionsUSD, 3)}T</span>
            <span className={cn("num text-xs", dirClass(chgShort))}>
              {fmtSigned(chgShort, 2, "%")} {chgShortLabel}
            </span>
            <span className={cn("num text-xs", dirClass(chgRange))}>
              {fmtSigned(chgRange, 2, "%")} {range}
            </span>
          </div>
        </div>
        <div className="ml-auto flex items-end gap-3" title="Net Liquidity = Fed Total Assets − TGA − RRP">
          <Stat op="=" label="Fed assets" value={fmt(nl.fedAssets, 3)} />
          <Stat op="−" label="TGA" value={fmt(nl.tgaBalance, 3)} />
          <Stat op="−" label="RRP" value={fmt(nl.rrpBalance, 3)} />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart key={nonce} data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="netliq-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={SERIES.s1} stopOpacity={0.28} />
                <stop offset="100%" stopColor={SERIES.s1} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="date" {...axisProps} tickFormatter={monthTick} minTickGap={52} />
            <YAxis
              {...axisProps}
              width={38}
              domain={[netTicks[0], netTicks[netTicks.length - 1]]}
              ticks={netTicks}
              tickFormatter={(v: number) => fmt(v, 2)}
            />
            <Tooltip
              cursor={cursorProps}
              isAnimationActive={false}
              content={<ChartTip labelFormat={(l) => `Week to ${longDate(l)}`} valueFormat={(v) => `$${fmt(v, 3)}T`} />}
            />
            <Area dataKey="net" name="Net liquidity" stroke={SERIES.s1} strokeWidth={2} fill="url(#netliq-fill)" dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- Yield curve inversion radar

function SpreadTile({ label, pct }: { label: string; pct: number }) {
  const inverted = pct < 0;
  return (
    <div className={cn("flex-1 rounded-sm border px-2 py-1", inverted ? "border-down/40 bg-down/[0.07]" : "border-line bg-base/40")}>
      <div className="flex items-center justify-between">
        <span className="num text-2xs text-ink-3">{label}</span>
        <span className={cn("flex items-center gap-1 text-2xs font-semibold", inverted ? "text-down" : "text-up")}>
          {inverted ? <AlertTriangle size={10} aria-hidden /> : <Check size={10} aria-hidden />}
          {inverted ? "INVERTED" : "NORMAL"}
        </span>
      </div>
      <div className="num text-base font-semibold leading-5 text-ink">
        {fmtSigned(pct * 100, 1)}
        <span className="ml-1 text-2xs font-normal text-ink-3">bp</span>
      </div>
    </div>
  );
}

type CurveMode = "SPREAD" | "CURVE";

export function YieldCurveRadar() {
  const y = useTerminal((s) => s.macro?.yieldSpreads);
  const series = useTerminal((s) => s.series);
  const down = useTerminal((s) => !!s.down.macro);
  const nonce = useTerminal((s) => s.cursorNonce);
  const [mode, setMode] = useState<CurveMode>("SPREAD");

  const spreadData = useMemo(() => (series?.spreads ?? []).map((p) => ({ date: p.date, s10y2y: p.s10y2y * 100, s10y3m: p.s10y3m * 100 })), [series]);
  const spreadTicks = useMemo(() => stepTicks([0, ...spreadData.flatMap((p) => [p.s10y2y, p.s10y3m])], 25), [spreadData]);
  const curveTicks = useMemo(() => (series ? stepTicks(series.curve.flatMap((p) => [p.now, p.yearAgo]), 0.25) : [0, 1]), [series]);

  if (!y || !series) {
    return (
      <Panel title="Yield Curve Radar" tag="M2">
        <PaneNotice down={down} what="Treasury yields" />
      </Panel>
    );
  }
  const real = true;

  return (
    <Panel
      title="Yield Curve Radar"
      tag="M2"
      right={
        <>
          {y.isInverted && (
            <span className="flex items-center gap-1 rounded-sm border border-down/40 bg-down/10 px-1 text-2xs font-semibold leading-[14px] text-down">
              <AlertTriangle size={10} aria-hidden /> INVERSION
            </span>
          )}
          <SourceTag source={series.source} asOf={series.yieldsAsOf} />
          <Segmented label="Chart" value={mode} options={["SPREAD", "CURVE"] as const} onChange={setMode} />
        </>
      }
    >
      <div className="mb-1.5 flex gap-1.5">
        <SpreadTile label="10Y − 2Y" pct={y.us10y2y} />
        <SpreadTile label="10Y − 3M" pct={y.us10y3m} />
      </div>
      <div className="mb-0.5 flex items-center gap-3">
        {mode === "SPREAD" ? (
          <>
            <LegendDot color={SERIES.s1} label="10Y−2Y" />
            <LegendDot color={SERIES.s2} label="10Y−3M" />
            <span className="ml-auto text-2xs text-ink-3">bp · shaded = inverted{real && ` · ${shortDate(series.yieldsAsOf)} close`}</span>
          </>
        ) : (
          <>
            <LegendDot color={SERIES.s1} label="Today" />
            <LegendDot color="#71717a" label="1Y ago" dashed />
            <span className="ml-auto text-2xs text-ink-3">UST yield, %{real && ` · ${shortDate(series.yieldsAsOf)} close`}</span>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          {mode === "SPREAD" ? (
            <LineChart key={`s${nonce}`} data={spreadData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="date" {...axisProps} tickFormatter={monthTick} minTickGap={48} />
              <YAxis {...axisProps} width={34} domain={[spreadTicks[0], spreadTicks[spreadTicks.length - 1]]} ticks={spreadTicks} />
              <ReferenceArea y2={0} fill={SERIES.down} fillOpacity={0.07} ifOverflow="hidden" />
              <ReferenceLine y={0} stroke={SERIES.down} strokeOpacity={0.6} strokeDasharray="3 3" />
              <Tooltip cursor={cursorProps} isAnimationActive={false} content={<ChartTip labelFormat={longDate} valueFormat={(v) => `${fmtSigned(v, 1)} bp`} />} />
              <Line dataKey="s10y2y" name="10Y−2Y" stroke={SERIES.s1} strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line dataKey="s10y3m" name="10Y−3M" stroke={SERIES.s2} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          ) : (
            <LineChart key={`c${nonce}`} data={series.curve} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="tenor" {...axisProps} interval={0} />
              <YAxis
                {...axisProps}
                width={34}
                domain={[curveTicks[0], curveTicks[curveTicks.length - 1]]}
                ticks={curveTicks}
                tickFormatter={(v: number) => fmt(v, curveTicks[1] - curveTicks[0] < 0.5 ? 2 : 1)}
              />
              <Tooltip cursor={cursorProps} isAnimationActive={false} content={<ChartTip valueFormat={(v) => `${fmt(v, 2)}%`} />} />
              <Line dataKey="yearAgo" name="1Y ago" stroke="#71717a" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
              <Line dataKey="now" name="Today" stroke={SERIES.s1} strokeWidth={2} dot={{ r: 2.5, fill: SERIES.s1, strokeWidth: 0 }} isAnimationActive={false} />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- Capital flow matrix

const CLASS_ABBR: Record<string, string> = { FX: "FX", Commodities: "CMD", Equities: "EQ", "Fixed Income": "FI" };

/** Diverging scale: red (outflow) ↔ neutral zinc ↔ green (inflow). */
function flowColor(z: number): string {
  const a = Math.min(1, Math.abs(z) / 3);
  if (a < 0.08) return "#27272a";
  const alpha = 0.14 + a * 0.62;
  return z > 0 ? `rgba(34,197,94,${alpha.toFixed(3)})` : `rgba(239,68,68,${alpha.toFixed(3)})`;
}

const FLOW_WINDOWS = ["1D", "1W", "1M", "3M"] as const;

export function CapitalFlowMatrix() {
  const flows = useTerminal((s) => s.flows);
  const down = useTerminal((s) => !!s.down.flows);
  const cols = "grid grid-cols-[24px_minmax(52px,1.4fr)_repeat(4,minmax(0,1fr))] gap-px";
  if (!flows) {
    return (
      <Panel title="Capital Flow Matrix" tag="M2">
        <PaneNotice down={down} what="Flow proxy" />
      </Panel>
    );
  }
  const CAPITAL_FLOWS = flows.rows;
  return (
    <Panel
      title="Capital Flow Matrix"
      tag="M2"
      right={<SourceTag source="ETF" title={`Flow proxy from ETF closes (Yahoo Finance), as of ${flows.asOf}. There is no free public fund-flow feed.`} />}
    >
      <div className={cn(cols, "mb-px shrink-0 text-2xs text-ink-3")}>
        <span />
        <span />
        {FLOW_WINDOWS.map((w) => (
          <span key={w} className="num text-center">
            {w}
          </span>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-hidden" role="table" aria-label="ETF return z-scores by asset bucket and window, a proxy for capital flows">
        {CAPITAL_FLOWS.map((row, i) => {
          const firstOfClass = i === 0 || CAPITAL_FLOWS[i - 1].cls !== row.cls;
          return (
            <div key={row.name} role="row" className={cn(cols, "min-h-[12px] flex-1", firstOfClass && i > 0 && "mt-0.5")}>
              <span className="num flex items-center text-[9px] font-semibold text-ink-3">{firstOfClass ? CLASS_ABBR[row.cls] : ""}</span>
              <span role="rowheader" className="flex items-center truncate text-2xs text-ink-2">
                {row.name}
              </span>
              {row.z.map((z, j) => (
                <span
                  key={j}
                  role="cell"
                  title={`${row.cls} · ${row.name} (${row.etf}) · ${FLOW_WINDOWS[j]} return: ${fmtSigned(z, 2)}σ vs its own volatility — ${z > 0 ? "buying" : "selling"} pressure`}
                  className="num flex items-center justify-center rounded-[1px] text-2xs leading-none text-ink"
                  style={{ background: flowColor(z) }}
                >
                  {fmtSigned(z, 1)}
                </span>
              ))}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex shrink-0 items-center gap-2 text-2xs text-ink-3">
        <span title="Proxy: each bucket's ETF return over the window, in units of its own typical move">Selling −3σ</span>
        <span aria-hidden className="h-1.5 flex-1 rounded-[1px]" style={{ background: "linear-gradient(90deg, rgba(239,68,68,0.76), #27272a 50%, rgba(34,197,94,0.76))" }} />
        <span>+3σ Buying · ETF proxy</span>
      </div>
    </Panel>
  );
}
