"use client";

import { Activity, ShieldAlert, TrendingUp } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { LegendDot, Panel, SourceTag } from "@/components/ui/panel";
import { axisProps, ChartTip, cursorProps, GRID_STROKE, longDate, monthTick, SERIES } from "@/components/ui/chart";
import { RISK_OFF_AT, RISK_ON_AT } from "@/lib/risk";
import { useTerminal } from "@/lib/store";
import type { RiskIndicator, RiskPillar, RiskStatus, Tone } from "@/lib/types";
import { cn, dirClass, fmt, fmtSigned } from "@/lib/utils";

export const RISK_STYLE: Record<RiskStatus, { cls: string; Icon: typeof TrendingUp; label: string }> = {
  RISK_ON: { cls: "border-up/50 bg-up/10 text-up", Icon: TrendingUp, label: "Risk-On" },
  NEUTRAL: { cls: "border-warn/50 bg-warn/10 text-warn", Icon: Activity, label: "Neutral" },
  RISK_OFF: { cls: "border-down/50 bg-down/10 text-down", Icon: ShieldAlert, label: "Risk-Off" },
};

const TONE_DOT: Record<Tone, string> = { on: "bg-up", off: "bg-down", neutral: "bg-ink-3" };
const TONE_WORD: Record<Tone, string> = { on: "risk-on", off: "risk-off", neutral: "neutral" };

// ---------------------------------------------------------------- Score meter

function ScoreMeter({ score }: { score: number }) {
  return (
    <div className="min-w-[72px] flex-1" role="img" aria-label={`Risk score ${score} of 100. Risk-off at ${RISK_OFF_AT} or below, risk-on at ${RISK_ON_AT} or above.`}>
      <div className="relative h-2">
        <div className="absolute inset-0 flex gap-px overflow-hidden rounded-[2px]">
          <div className="bg-down/30" style={{ width: `${RISK_OFF_AT}%` }} />
          <div className="bg-line-strong" style={{ width: `${RISK_ON_AT - RISK_OFF_AT}%` }} />
          <div className="flex-1 bg-up/30" />
        </div>
        <div className="absolute -inset-y-[3px] w-[3px] rounded-full bg-ink ring-1 ring-panel" style={{ left: `calc(${score}% - 1.5px)` }} />
      </div>
      <div className="num mt-1 flex justify-between text-[9px] leading-none text-ink-3">
        <span>RISK-OFF</span>
        <span>NEUTRAL</span>
        <span>RISK-ON</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Regime pillars

function Pillar({ p }: { p: RiskPillar }) {
  return (
    <div className="min-w-0" title={`${p.label}: ${p.state} (${TONE_WORD[p.tone]}) — ${p.detail}`}>
      <div className="flex items-center gap-1 text-2xs leading-[15px]">
        <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[p.tone])} />
        <span className="shrink-0 text-ink-3">{p.label}</span>
        <span className="truncate font-semibold text-ink">{p.state}</span>
      </div>
      <div className="cq-tall num truncate pl-2.5 text-[9px] leading-[11px] text-ink-3">{p.detail}</div>
    </div>
  );
}

// ---------------------------------------------------------------- Indicator tables

/** Green = a move in the risk-on direction, whichever way the number itself went. */
function Chg({ v, ind, className }: { v: number | null; ind: RiskIndicator; className?: string }) {
  if (v === null) return <span className={cn("num w-12 shrink-0 text-right text-ink-3", className)}>—</span>;
  const riskMove = ind.side === "ON" ? v : -v;
  const text = ind.chgKind === "pct" ? fmtSigned(v, 2, "%") : fmtSigned(v, ind.decimals);
  return <span className={cn("num w-12 shrink-0 text-right", dirClass(Math.abs(v) < 1e-9 ? 0 : riskMove), className)}>{text}</span>;
}

function SignalBar({ signal }: { signal: number }) {
  const w = Math.min(1, Math.abs(signal) / 3) * 50;
  return (
    <span className="relative h-1.5 w-12 shrink-0 rounded-[1px] bg-line/80" aria-hidden>
      {w > 1 && (
        <span
          className={cn("absolute inset-y-0 rounded-[1px]", signal > 0 ? "bg-up" : "bg-down")}
          style={signal > 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
        />
      )}
      <span className="absolute -inset-y-px left-1/2 w-px bg-ink-3" />
    </span>
  );
}

function IndicatorTable({ title, rows }: { title: string; rows: RiskIndicator[] }) {
  return (
    <div role="table" aria-label={title}>
      <div role="row" className="flex h-3 items-center gap-2 text-[9px] uppercase leading-none tracking-wide text-ink-3">
        <span role="columnheader" className="min-w-0 flex-1 truncate font-semibold text-ink-2">
          {title}
        </span>
        <span role="columnheader" className="w-14 shrink-0 text-right">Last</span>
        <span role="columnheader" className="cq-wide w-12 shrink-0 text-right">1D</span>
        <span role="columnheader" className="cq-wide w-12 shrink-0 text-right">1W</span>
        <span role="columnheader" className="w-12 shrink-0 text-right">1M</span>
        <span role="columnheader" className="w-12 shrink-0 text-center">Signal</span>
        <span role="columnheader" className="cq-wide w-9 shrink-0 text-right">σ</span>
      </div>
      {rows.map((r) => (
        <div
          key={r.key}
          role="row"
          title={`${r.label}: ${fmtSigned(r.z, 2)}σ vs its 1-year average → ${TONE_WORD[r.tone]} signal (${fmtSigned(r.signal, 2)}). Latest ${r.asOf}.`}
          className="flex h-[14px] items-center gap-2 text-2xs leading-none hover:bg-raised"
        >
          <span role="rowheader" className="min-w-0 flex-1 truncate text-ink-2">
            {r.label}
          </span>
          <span role="cell" className="num w-14 shrink-0 text-right text-ink">
            {fmt(r.value, r.decimals)}
            {r.unit && <span className="text-ink-3">{r.unit}</span>}
          </span>
          <Chg v={r.chg1d} ind={r} className="cq-wide" />
          <Chg v={r.chg1w} ind={r} className="cq-wide" />
          <Chg v={r.chg1m} ind={r} />
          <span role="cell" className="flex w-12 shrink-0 items-center">
            <SignalBar signal={r.signal} />
            <span className="sr-only">
              {fmtSigned(r.signal, 1)} sigma, {TONE_WORD[r.tone]}
            </span>
          </span>
          <span role="cell" className="cq-wide num w-9 shrink-0 text-right text-ink-2">
            {fmtSigned(r.signal, 1)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Pane

const SCORE_TICKS = [0, 20, 40, 60, 80, 100];

export function RiskRegime() {
  const risk = useTerminal((s) => s.risk);
  const nonce = useTerminal((s) => s.cursorNonce);

  if (!risk) {
    return (
      <Panel title="Risk-On / Risk-Off" tag="M3">
        <div className="flex flex-1 items-center justify-center text-2xs text-ink-3">Loading risk indicators…</div>
      </Panel>
    );
  }

  const st = RISK_STYLE[risk.status];
  const neutralCount = risk.indicators.length - risk.onCount - risk.offCount;

  return (
    <Panel title="Risk-On / Risk-Off" tag="M3" right={<SourceTag source={risk.source} asOf={risk.asOf} />} bodyClassName="cq-size gap-1.5">
      {/* Market regime status: headline */}
      <div className="flex shrink-0 items-center gap-2.5">
        <div
          className={cn("flex h-6 shrink-0 items-center gap-1.5 rounded-sm border px-2", st.cls)}
          title={`Market regime: ${st.label}. Score ${risk.score}/100 — ${risk.onCount} indicators risk-on, ${risk.offCount} risk-off, ${neutralCount} neutral.`}
        >
          <st.Icon size={13} strokeWidth={2.5} aria-hidden />
          <span className="text-xs font-bold uppercase tracking-wide">{st.label}</span>
        </div>
        <div className="shrink-0 leading-none">
          <span className="num text-xl font-semibold leading-6 text-ink">{risk.score}</span>
          <span className="num text-2xs text-ink-3">/100</span>
        </div>
        <span className={cn("num shrink-0 text-2xs", dirClass(risk.scoreChg1w))} title="Change in score over the last 5 sessions">
          {fmtSigned(risk.scoreChg1w, 0)} 1w
        </span>
        <ScoreMeter score={risk.score} />
      </div>

      {/* Market regime status: pillars */}
      <div className="grid shrink-0 grid-cols-3 gap-x-3 gap-y-0.5 border-y border-line/70 py-1" aria-label="Market regime status by pillar">
        {risk.pillars.map((p) => (
          <Pillar key={p.key} p={p} />
        ))}
      </div>

      {/* Risk-on vs risk-off data */}
      <div className="cq-cols2 min-h-0 shrink gap-y-1 overflow-auto">
        <IndicatorTable title="Risk-on assets" rows={risk.indicators.filter((i) => i.side === "ON")} />
        <IndicatorTable title="Risk-off gauges" rows={risk.indicators.filter((i) => i.side === "OFF")} />
      </div>

      {/* Score history — only when the pane is tall enough */}
      <div className="cq-xtall flex min-h-[72px] flex-1 flex-col">
        <div className="mb-0.5 flex items-center gap-3">
          <LegendDot color={SERIES.s1} label="Risk score, 1Y" />
          <span className="ml-auto text-2xs text-ink-3">
            {risk.onCount} on · {risk.offCount} off · {neutralCount} neutral
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart key={nonce} data={risk.history} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID_STROKE} vertical={false} />
              <XAxis dataKey="date" {...axisProps} tickFormatter={monthTick} minTickGap={48} />
              <YAxis {...axisProps} width={26} domain={[0, 100]} ticks={SCORE_TICKS} interval={0} />
              <ReferenceArea y1={RISK_ON_AT} y2={100} fill={SERIES.up} fillOpacity={0.07} />
              <ReferenceArea y1={0} y2={RISK_OFF_AT} fill={SERIES.down} fillOpacity={0.07} />
              <ReferenceLine y={RISK_ON_AT} stroke={SERIES.up} strokeOpacity={0.5} strokeDasharray="3 3" />
              <ReferenceLine y={RISK_OFF_AT} stroke={SERIES.down} strokeOpacity={0.5} strokeDasharray="3 3" />
              <Tooltip cursor={cursorProps} isAnimationActive={false} content={<ChartTip labelFormat={longDate} valueFormat={(v) => `${fmt(v, 0)} / 100`} />} />
              <Line dataKey="score" name="Risk score" stroke={SERIES.s1} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-0.5 shrink-0 text-[9px] leading-[11px] text-ink-3">
          Signal = level vs its own 1-year average (σ), sign flipped for risk-off gauges. Green = risk-on, red = risk-off.
        </p>
      </div>
    </Panel>
  );
}
