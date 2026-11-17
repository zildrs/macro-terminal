"use client";

import { Fragment, useState } from "react";
import { BiasBadge, PaneNotice, Panel, Segmented, SourceTag } from "@/components/ui/panel";
import { useTerminal } from "@/lib/store";
import type { Bias } from "@/lib/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------- Economic event stream

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${iso.slice(8, 10)} ${MON[d.getUTCMonth()]}`;
}

const IMPACT = {
  3: { label: "High impact", cls: "bg-down" },
  2: { label: "Medium impact", cls: "bg-warn" },
  1: { label: "Low impact", cls: "bg-ink-3" },
} as const;

function Impact({ level }: { level: 1 | 2 | 3 }) {
  return (
    <span className="inline-flex items-end gap-px" role="img" aria-label={IMPACT[level].label} title={IMPACT[level].label}>
      {[1, 2, 3].map((i) => (
        <span key={i} className={cn("w-[3px] rounded-[1px]", i <= level ? IMPACT[level].cls : "bg-line-strong")} style={{ height: 3 + i * 2 }} />
      ))}
    </span>
  );
}

type EventFilter = "ALL" | "HIGH";

export function EventStream() {
  const calendar = useTerminal((s) => s.calendar);
  const down = useTerminal((s) => !!s.down.calendar);
  const now = useTerminal((s) => s.now);
  const [filter, setFilter] = useState<EventFilter>("ALL");

  if (!calendar) {
    return (
      <Panel title="Economic Calendar" tag="M4">
        <PaneNotice down={down} what="Economic calendar" />
      </Panel>
    );
  }
  const nowIso = new Date(now || Date.now()).toISOString();
  const today = nowIso.slice(0, 10);
  // From today onward (all UTC); earlier days of the week are dropped to keep what matters on screen.
  const events = calendar.filter((e) => e.time.slice(0, 10) >= today && (filter === "ALL" || e.impact === 3));
  const nextId = events.find((e) => e.time > nowIso)?.id;
  const days = Array.from(new Set(events.map((e) => e.time.slice(0, 10))));

  return (
    <Panel
      title="Economic Calendar"
      tag="M4"
      right={
        <>
          <span className="cq-wide text-2xs text-ink-3">UTC</span>
          <SourceTag source="FF" title="Forex Factory weekly calendar export: consensus forecast and previous reading. The export does not include actual results." />
          <Segmented label="Impact filter" value={filter} options={["ALL", "HIGH"] as const} onChange={setFilter} />
        </>
      }
      bodyClassName="cq p-0"
    >
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr className="text-2xs uppercase tracking-wide text-ink-3 [&>th]:border-b [&>th]:border-line [&>th]:px-1.5 [&>th]:py-1 [&>th]:font-medium">
              <th className="text-left">Time</th>
              <th className="text-left">Ccy</th>
              <th aria-label="Impact" />
              <th className="w-full text-left">Event</th>
              <th className="text-right">Fcst</th>
              <th className="text-right">Prev</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <Fragment key={day}>
                <tr>
                  <td colSpan={6} className="border-b border-line/60 bg-base/50 px-1.5 py-0.5">
                    <span className="num text-2xs font-semibold tracking-wide text-ink-2">{dayLabel(day)}</span>
                    {day === today && <span className="num ml-2 text-2xs text-warn">TODAY</span>}
                  </td>
                </tr>
                {events
                  .filter((e) => e.time.slice(0, 10) === day)
                  .map((e) => {
                    const past = e.time <= nowIso;
                    return (
                      <tr key={e.id} className={cn("border-b border-line/60 hover:bg-raised [&>td]:px-1.5 [&>td]:py-[3px]", e.id === nextId && "bg-warn/[0.06]", past && "opacity-55")}>
                        <td className="num whitespace-nowrap text-ink-2">{e.time.slice(11, 16)}</td>
                        <td className="num font-semibold text-ink">{e.ccy}</td>
                        <td>
                          <Impact level={e.impact} />
                        </td>
                        <td className="max-w-0 truncate text-ink" title={e.event}>
                          {e.id === nextId && <span className="num mr-1.5 rounded-sm border border-warn/40 px-1 text-[9px] leading-[13px] text-warn">NEXT</span>}
                          {e.event}
                        </td>
                        <td className="num whitespace-nowrap text-right text-ink">{e.forecast || "—"}</td>
                        <td className="num whitespace-nowrap text-right text-ink-3">{e.previous || "—"}</td>
                      </tr>
                    );
                  })}
              </Fragment>
            ))}
            {events.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-3 text-xs text-ink-3">
                  No {filter === "HIGH" ? "high-impact " : ""}releases left this week.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="shrink-0 border-t border-line px-2 py-1 text-2xs text-ink-3">Consensus forecast and previous reading. This feed does not publish actuals; released rows are dimmed.</p>
    </Panel>
  );
}

// ---------------------------------------------------------------- Macro news feed

type NewsFilter = "ALL" | Bias;
const NEWS_FILTERS: { value: NewsFilter; label: string }[] = [
  { value: "ALL", label: "ALL" },
  { value: "Hawkish", label: "HAWK" },
  { value: "Dovish", label: "DOVE" },
  { value: "Neutral", label: "NEUT" },
];

function age(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

export function NewsFeed() {
  const news = useTerminal((s) => s.news);
  const down = useTerminal((s) => !!s.down.news);
  const now = useTerminal((s) => s.now);
  const [filter, setFilter] = useState<NewsFilter>("ALL");

  if (!news) {
    return (
      <Panel title="Macro News Feed" tag="M4">
        <PaneNotice down={down} what="Headlines" />
      </Panel>
    );
  }
  const items = news.filter((n) => filter === "ALL" || n.sentiment === filter);

  return (
    <Panel
      title="Macro News Feed"
      tag="M4"
      right={
        <>
          <SourceTag source="RSS" title="Official Fed, ECB and BoJ feeds plus CNBC Economy. Hawkish / dovish tags come from a keyword rule, not a language model." />
          <Segmented label="Sentiment filter" value={filter} options={NEWS_FILTERS} onChange={setFilter} />
        </>
      }
      bodyClassName="p-0"
    >
      <ul className="min-h-0 flex-1 overflow-auto">
        {items.map((n) => {
          const a = now ? age(now - n.time) : "";
          const fresh = now > 0 && now - n.time < 30 * 60_000;
          return (
            <li key={n.id} className={cn("flex gap-2 border-b border-line/60 px-2 py-1 hover:bg-raised", fresh && "border-l-2 border-l-warn bg-warn/[0.05]")}>
              <span className={cn("num w-7 shrink-0 pt-px text-2xs", fresh ? "text-warn" : "text-ink-3")}>{a}</span>
              <div className="min-w-0 flex-1">
                <a href={n.url} target="_blank" rel="noopener noreferrer" className="text-xs leading-4 text-ink hover:underline">
                  {n.headline}
                </a>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <BiasBadge bias={n.sentiment} />
                  <span className="num text-2xs tracking-wide text-ink-3">{n.category}</span>
                </div>
              </div>
            </li>
          );
        })}
        {items.length === 0 && <li className="px-2 py-3 text-xs text-ink-3">No headlines match this filter.</li>}
      </ul>
    </Panel>
  );
}
