"use client";

import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { LegendDot, PaneNotice, Panel, SourceTag } from "@/components/ui/panel";
import { axisProps, ChartTip, cursorProps, GRID_STROKE, longDate, monthTick, SERIES, shortDate, stepTicks } from "@/components/ui/chart";
import { useTerminal } from "@/lib/store";
import type { FundingStat } from "@/lib/types";
import { cn, fmt, fmtSigned } from "@/lib/utils";

// ---------------------------------------------------------------- Status thresholds

type Tone = "up" | "warn" | "down" | "flat";

const TONE: Record<Tone, string> = {
  up: "border-up/40 bg-up/10 text-up",
  warn: "border-warn/40 bg-warn/10 text-warn",
  down: "border-down/40 bg-down/10 text-down",
  flat: "border-line-strong bg-raised text-ink-2",
};

/** NFCI: 0 is average conditions. Above 0 is tighter than average, past 0.5 markedly so. */
const nfciStatus = (v: number): { label: string; tone: Tone } => (v > 0.5 ? { label: "TIGHT", tone: "down" } : v > 0 ? { label: "TIGHT", tone: "warn" } : { label: "LOOSE", tone: "up" });

/** 5Y TIPS yield: above 2% restrains growth, below 0.5% is easy money. */
const realRegime = (v: number): { label: string; tone: Tone } =>
  v >= 2 ? { label: "RESTRICTIVE", tone: "warn" } : v < 0.5 ? { label: "ACCOMMODATIVE", tone: "up" } : { label: "NEUTRAL", tone: "flat" };

/** 2Y yield vs EFFR: more than 15bp either side means the market prices moves in the next two years. */
const twoYearSignal = (bp: number): { label: string; tone: Tone } =>
  bp > 15 ? { label: "HIKES PRICED", tone: "down" } : bp < -15 ? { label: "CUTS PRICED", tone: "up" } : { label: "ON HOLD", tone: "flat" };

/** SOFR vs EFFR: repo trading 5bp or more over fed funds signals strained reserves. */
const sofrStatus = (bp: number): { label: string; tone: Tone } => (bp >= 5 ? { label: "STRESS", tone: "down" } : { label: "NORMAL", tone: "up" });

function Pill({ label, tone }: { label: string; tone: Tone }) {
  return <span className={cn("num inline-block whitespace-nowrap rounded-sm border px-1 text-2xs font-semibold leading-[14px]", TONE[tone])}>{label}</span>;
}

/** 1W change, in ink (direction is in the sign, not the colour). */
function Chg({ v, unit = "bp", digits = 0 }: { v: number | null; unit?: string; digits?: number }) {
  if (v === null) return <span className="text-ink-3">—</span>;
  return (
    <span className="text-ink-2">
      {fmtSigned(v, digits)}
      <span className="ml-0.5 text-ink-3">{unit}</span>
    </span>
  );
}

function Kpi({ label, children, sub }: { label: string; children: React.ReactNode; sub: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1 rounded-sm border border-line bg-base/40 px-2 py-0.5">
      <div className="num truncate text-2xs text-ink-3">{label}</div>
      <div className="flex items-baseline justify-between gap-1.5">
        <span className="num text-base font-semibold leading-5 text-ink">{children}</span>
        <span className="num truncate text-2xs">{sub}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Panel

export function RealYieldsPanel() {
  const f = useTerminal((s) => s.funding);
  const down = useTerminal((s) => !!s.down.funding);
  const nonce = useTerminal((s) => s.cursorNonce);
  const ticks = useMemo(() => (f ? stepTicks(f.history.flatMap((p) => [p.real, p.breakeven]), 0.25) : [0, 1]), [f]);

  if (!f) {
    return (
      <Panel title="Real Yields & Funding" tag="M1">
        <PaneNotice down={down} what="Real yields" />
      </Panel>
    );
  }

  const nfci = nfciStatus(f.nfci.value);
  const rows: { name: string; stat: FundingStat; value: string; status: { label: string; tone: Tone }; note: string }[] = [
    { name: "5Y Real Yield (TIPS)", stat: f.real5, value: `${fmt(f.real5.value, 2)}%`, status: realRegime(f.real5.value), note: "DFII5" },
    { name: "2Y − EFFR Spread", stat: f.twoYearVsEffr, value: `${fmtSigned(f.twoYearVsEffr.value, 0)} bp`, status: twoYearSignal(f.twoYearVsEffr.value), note: "DGS2 − EFFR" },
    { name: "SOFR − EFFR Spread", stat: f.sofrVsEffr, value: `${fmtSigned(f.sofrVsEffr.value, 0)} bp`, status: sofrStatus(f.sofrVsEffr.value), note: "SOFR − EFFR" },
  ];

  return (
    <Panel
      title="Real Yields & Funding"
      tag="M1"
      right={<SourceTag source="FRED" asOf={f.real10.date} title={`FRED: DFII10, DFII5, T10YIE, DGS2, SOFR, EFFR (daily, latest ${f.real10.date}); NFCI (weekly, ${f.nfci.date})`} />}
      bodyClassName="cq gap-1.5"
    >
      {/* KPI strip */}
      <div className="flex shrink-0 gap-1.5">
        <Kpi label="10Y REAL" sub={<Chg v={f.real10.chg1w} />}>
          {fmt(f.real10.value, 2)}
          <span className="ml-0.5 text-2xs font-normal text-ink-3">%</span>
        </Kpi>
        <Kpi label="10Y BREAKEVEN" sub={<Chg v={f.breakeven10.chg1w} />}>
          {fmt(f.breakeven10.value, 2)}
          <span className="ml-0.5 text-2xs font-normal text-ink-3">%</span>
        </Kpi>
        <Kpi label="FIN. COND (NFCI)" sub={<Pill {...nfci} />}>
          {fmtSigned(f.nfci.value, 2)}
        </Kpi>
      </div>

      {/* 1Y real yield vs breakeven */}
      <div className="flex shrink-0 items-center gap-3">
        <LegendDot color={SERIES.s1} label="10Y real" />
        <LegendDot color={SERIES.s2} label="10Y breakeven" />
        <span className="ml-auto text-2xs text-ink-3">%, 1Y · {shortDate(f.real10.date)} close</span>
      </div>
      <div className="min-h-[70px] flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart key={nonce} data={f.history} margin={{ top: 4, right: 0, bottom: 0, left: 4 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="date" {...axisProps} tickFormatter={monthTick} minTickGap={48} />
            <YAxis
              {...axisProps}
              orientation="right"
              width={34}
              domain={[ticks[0], ticks[ticks.length - 1]]}
              ticks={ticks}
              tickFormatter={(v: number) => fmt(v, 2)}
            />
            <Tooltip cursor={cursorProps} isAnimationActive={false} content={<ChartTip labelFormat={longDate} valueFormat={(v) => `${fmt(v, 2)}%`} />} />
            <Line dataKey="real" name="10Y real" stroke={SERIES.s1} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="breakeven" name="10Y breakeven" stroke={SERIES.s2} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Funding & curve stress */}
      <table className="w-full shrink-0 border-collapse text-xs">
        <thead>
          <tr className="text-2xs uppercase tracking-wide text-ink-3 [&>th]:border-b [&>th]:border-line [&>th]:pb-0.5 [&>th]:font-medium">
            <th className="text-left">Funding & curve</th>
            <th className="text-right">Level</th>
            <th className="text-right">1W</th>
            <th className="w-24 pl-3 text-right">Signal</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-b border-line/60 last:border-b-0 [&>td]:py-px">
              <td className="truncate text-ink-2" title={`${r.note}, ${r.stat.date}`}>
                {r.name}
              </td>
              <td className="num text-right text-ink">{r.value}</td>
              <td className="num text-right">
                <Chg v={r.stat.chg1w} />
              </td>
              <td className="pl-3 text-right">
                <Pill {...r.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="cq-wide shrink-0 text-2xs text-ink-3">
        NFCI above 0 = tighter than average. 2Y − EFFR beyond ±15bp = moves priced. SOFR ≥ EFFR + 5bp = repo stress. 5Y real ≥ 2% restrictive, &lt; 0.5% easy.
      </p>
    </Panel>
  );
}
