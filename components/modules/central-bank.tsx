"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BiasBadge, LegendDot, PaneNotice, Panel, Segmented, SourceTag } from "@/components/ui/panel";
import { axisProps, ChartTip, cursorProps, GRID_STROKE, longDate, monthTick, SERIES, shortDate, stepTicks } from "@/components/ui/chart";
import type { Benchmark } from "@/lib/macro";
import { useTerminal } from "@/lib/store";
import { cn, dirClass, fmt, fmtSigned } from "@/lib/utils";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09" → "Sep" */
const monthName = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1];

// ---------------------------------------------------------------- Rate target matrix

export function RateMatrix() {
  const policy = useTerminal((s) => s.policy);
  const down = useTerminal((s) => !!s.down.policy);
  if (!policy) {
    return (
      <Panel title="Rate Target Matrix" tag="M1">
        <PaneNotice down={down} what="Policy rates" />
      </Panel>
    );
  }
  return (
    <Panel title="Rate Target Matrix" tag="M1" right={<SourceTag source="BIS" title="Policy rates and CPI: BIS. Fed target range: FRED." />} bodyClassName="cq p-0">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-panel">
            <tr className="text-2xs uppercase tracking-wide text-ink-3 [&>th]:border-b [&>th]:border-line [&>th]:px-2 [&>th]:py-1 [&>th]:font-medium">
              <th className="text-left">Bank</th>
              <th className="text-right">Rate</th>
              <th className="text-right">Last move</th>
              <th className="text-right">CPI y/y</th>
              <th className="text-right">Real</th>
              <th className="text-right" title="From the direction of the last move, if it was within the past nine months">Stance</th>
            </tr>
          </thead>
          <tbody>
            {policy.banks.map((b) => {
              const real = b.rate - b.cpi;
              return (
                <tr key={b.code} className="border-b border-line/60 hover:bg-raised [&>td]:px-2 [&>td]:py-[5px]">
                  <td>
                    <span className="num font-semibold text-ink">{b.code}</span>
                    <span className="cq-wide ml-2 text-ink-3">{b.bank}</span>
                  </td>
                  <td className="num whitespace-nowrap text-right text-ink">{b.rateLabel}%</td>
                  <td className="num whitespace-nowrap text-right" title={`Last change took effect ${b.lastMoveDate}`}>
                    <span className={dirClass(-b.lastMoveBps)}>{b.lastMoveBps === 0 ? "NONE" : `${fmtSigned(b.lastMoveBps, 0)}bp`}</span>
                    <span className="ml-1.5 text-ink-3">{b.lastMoveBps === 0 ? "2y" : shortDate(b.lastMoveDate)}</span>
                  </td>
                  <td className="num whitespace-nowrap text-right text-ink-2">
                    {fmt(b.cpi, 1)}%<span className="cq-wide ml-1.5 text-ink-3">{monthName(b.cpiAsOf)}</span>
                  </td>
                  <td className={cn("num text-right", real >= 0 ? "text-ink" : "text-warn")}>{fmtSigned(real, 2)}</td>
                  <td className="text-right">
                    <BiasBadge bias={b.bias} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="shrink-0 border-t border-line px-2 py-1 text-2xs text-ink-3">
        Real = policy rate − CPI y/y. Fed shown at upper bound. Move colour: green = easing, red = tightening. Stance follows the last move.
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------- Fed cut/hike probability

const moveLabel = (bps: number) => (bps === 0 ? "HOLD" : bps < 0 ? `CUT ${-bps}` : `HIKE ${bps}`);
const moveColor = (bps: number) => (bps === 0 ? "#71717a" : bps < 0 ? SERIES.up : SERIES.down);

export function FedProbability() {
  const policy = useTerminal((s) => s.policy);
  const down = useTerminal((s) => !!s.down.policy);
  const now = useTerminal((s) => s.now);
  if (!policy) {
    return (
      <Panel title="Fed Rate Probability" tag="M1">
        <PaneNotice down={down} what="Fed funds futures" />
      </Panel>
    );
  }
  const FED_TARGET = policy.fed;
  const FED_MEETINGS = policy.meetings;
  const daysUntil = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - (now || Date.now())) / 86400_000));
  const next = FED_MEETINGS[0];
  const lead = next.cutProb >= next.hikeProb ? { label: "CUT", p: next.cutProb, cls: "text-up" } : { label: "HIKE", p: next.hikeProb, cls: "text-down" };
  return (
    <Panel title="Fed Rate Probability" tag="M1" right={<SourceTag source="CME" title={`30-day fed funds futures (CBOT ZQ) via Yahoo Finance; EFFR ${policy.fed.effrAsOf} from FRED`} />} bodyClassName="cq gap-2">
      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="num text-2xs text-ink-3">
            FOMC {shortDate(next.date).toUpperCase()} · {daysUntil(next.date)}D
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className={cn("num text-2xl font-semibold leading-7", lead.cls)}>{fmt(lead.p * 100, 0)}%</span>
            <span className="text-2xs font-semibold text-ink-2">P({lead.label})</span>
          </div>
        </div>
        <div className="num text-right text-2xs leading-4 text-ink-3">
          <div>
            TGT <span className="text-ink-2">{fmt(FED_TARGET.lower, 2)}–{fmt(FED_TARGET.upper, 2)}</span>
          </div>
          <div>
            EFFR <span className="text-ink-2">{fmt(FED_TARGET.effr, 2)}</span>
          </div>
        </div>
      </div>

      {/* Outcome meter for the next meeting */}
      <div>
        <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-[2px]" role="img" aria-label={next.dist.map((d) => `${moveLabel(d.moveBps)} ${Math.round(d.prob * 100)}%`).join(", ")}>
          {next.dist.map((d) => (
            <div key={d.moveBps} style={{ width: `${d.prob * 100}%`, background: moveColor(d.moveBps) }} title={`${moveLabel(d.moveBps)}bp — ${fmt(d.prob * 100, 1)}%`} />
          ))}
        </div>
        <div className="mt-1 flex justify-between">
          {next.dist.map((d) => (
            <span key={d.moveBps} className="num flex items-center gap-1 text-2xs text-ink-2">
              <span aria-hidden className="h-1.5 w-1.5 rounded-[1px]" style={{ background: moveColor(d.moveBps) }} />
              {moveLabel(d.moveBps)} <span className="text-ink">{fmt(d.prob * 100, 0)}%</span>
            </span>
          ))}
        </div>
      </div>

      {/* Implied path */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-2xs uppercase tracking-wide text-ink-3 [&>th]:border-b [&>th]:border-line [&>th]:py-0.5 [&>th]:font-medium">
              <th className="text-left">Meeting</th>
              <th className="cq-wide text-right">Contract</th>
              <th className="text-right">Implied</th>
              <th className="text-right">Δ bp</th>
              <th className="cq-wide w-28 pl-3 text-left">Most likely</th>
            </tr>
          </thead>
          <tbody>
            {FED_MEETINGS.map((m) => {
              const top = [...m.dist].sort((a, b) => b.prob - a.prob)[0];
              const delta = (m.impliedRate - FED_TARGET.effr) * 100;
              return (
                <tr key={m.date} className="border-b border-line/60 [&>td]:py-[3px]">
                  <td className="num text-ink-2">{shortDate(m.date)}</td>
                  <td className="cq-wide num text-right text-ink-3">{m.contract} {fmt(m.futuresPrice, 3)}</td>
                  <td className="num text-right text-ink">{fmt(m.impliedRate, 2)}</td>
                  <td className={cn("num text-right", dirClass(-delta))}>{fmtSigned(delta, 0)}</td>
                  <td className="cq-wide num pl-3 text-ink-2">
                    {moveLabel(top.moveBps)} <span className="text-ink-3">{fmt(top.prob * 100, 0)}%</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="cq-wide shrink-0 text-2xs text-ink-3">Post-meeting rate solved from each contract's monthly average (100 − price); gap to EFFR split across adjacent 25bp outcomes.</p>
    </Panel>
  );
}

// ---------------------------------------------------------------- Balance sheet visualizer

const BENCHMARKS: Benchmark[] = ["SPX", "GOLD", "BTC"];
type Mode = "DUAL" | "INDEX";

export function BalanceSheetChart() {
  const [bench, setBench] = useState<Benchmark>("SPX");
  const [mode, setMode] = useState<Mode>("DUAL");
  const nonce = useTerminal((s) => s.cursorNonce);
  const balance = useTerminal((s) => s.policy?.balance);
  const down = useTerminal((s) => !!s.down.policy);
  const BALANCE_SHEET_SERIES = useMemo(() => balance ?? [], [balance]);

  const data = useMemo(() => {
    if (!BALANCE_SHEET_SERIES.length) return [];
    if (mode === "DUAL") return BALANCE_SHEET_SERIES.map((p) => ({ date: p.date, fed: p.fed, ecb: p.ecb, boj: p.boj, bench: p[bench] }));
    const b = BALANCE_SHEET_SERIES[0];
    return BALANCE_SHEET_SERIES.map((p) => ({
      date: p.date,
      fed: (p.fed / b.fed) * 100,
      ecb: (p.ecb / b.ecb) * 100,
      boj: (p.boj / b.boj) * 100,
      bench: (p[bench] / b[bench]) * 100,
    }));
  }, [bench, mode, BALANCE_SHEET_SERIES]);
  const leftTicks = useMemo(() => (data.length ? stepTicks(data.flatMap((p) => [p.fed, p.ecb, p.boj]), mode === "DUAL" ? 1 : 10) : [0, 1]), [data, mode]);

  if (!data.length) {
    return (
      <Panel title="CB Balance Sheets" tag="M1">
        <PaneNotice down={down} what="Balance sheets" />
      </Panel>
    );
  }

  const valueFormat = (v: number, key: string) =>
    mode === "INDEX" ? fmt(v, 1) : key === "bench" ? fmt(v, bench === "BTC" ? 0 : 1) : `$${fmt(v, 2)}T`;

  return (
    <Panel
      title="CB Balance Sheets"
      tag="M1"
      right={
        <>
          <SourceTag source="FRED" title="Total assets: FRED (WALCL, ECBASSETSW, JPNASSETS), ECB and BoJ converted to USD at each month's rate. Benchmarks: Yahoo Finance month-end closes." />
          <Segmented label="Benchmark" value={bench} options={BENCHMARKS} onChange={setBench} />
          <Segmented label="Scale mode" value={mode} options={["DUAL", "INDEX"] as const} onChange={setMode} />
        </>
      }
    >
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <LegendDot color={SERIES.s1} label="Fed" />
        <LegendDot color={SERIES.s2} label="ECB" />
        <LegendDot color={SERIES.s3} label="BoJ" />
        <LegendDot color={SERIES.bench} label={`${bench}${mode === "DUAL" ? " (right axis)" : ""}`} dashed />
        <span className="ml-auto text-2xs text-ink-3">{mode === "DUAL" ? "Total assets, USD trn" : `Rebased, ${monthTick(data[0].date)} = 100`}</span>
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart key={nonce} data={data} margin={{ top: 4, right: mode === "DUAL" ? 0 : 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} vertical={false} />
            <XAxis dataKey="date" {...axisProps} tickFormatter={monthTick} minTickGap={48} />
            <YAxis
              yAxisId="l"
              {...axisProps}
              width={34}
              domain={mode === "DUAL" ? [leftTicks[0], leftTicks[leftTicks.length - 1]] : ["auto", "auto"]}
              ticks={mode === "DUAL" ? leftTicks : undefined}
              tickFormatter={(v: number) => fmt(v, 0)}
            />
            {mode === "DUAL" && (
              <YAxis
                yAxisId="r"
                orientation="right"
                {...axisProps}
                width={44}
                domain={["auto", "auto"]}
                tickFormatter={(v: number) => (v >= 10000 ? `${fmt(v / 1000, 0)}k` : fmt(v, 0))}
              />
            )}
            <Tooltip cursor={cursorProps} isAnimationActive={false} content={<ChartTip labelFormat={longDate} valueFormat={valueFormat} />} />
            <Line yAxisId="l" dataKey="fed" name="Fed" stroke={SERIES.s1} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line yAxisId="l" dataKey="ecb" name="ECB" stroke={SERIES.s2} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line yAxisId="l" dataKey="boj" name="BoJ" stroke={SERIES.s3} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line
              yAxisId={mode === "DUAL" ? "r" : "l"}
              dataKey="bench"
              name={bench}
              stroke={SERIES.bench}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}
