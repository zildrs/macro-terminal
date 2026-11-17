"use client";

import { shortDate } from "@/components/ui/chart";
import { useTerminal, type FeedKey } from "@/lib/store";
import { cn } from "@/lib/utils";

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="num rounded-[2px] border border-line-strong px-1 text-[9px] leading-[13px] text-ink-2">{children}</kbd>;
}

const FEEDS: { key: FeedKey; label: string; what: string }[] = [
  { key: "quotes", label: "YAHOO", what: "Prices and candles — Yahoo Finance, delayed about 15 minutes" },
  { key: "macro", label: "FRED", what: "Net liquidity and Treasury yields — FRED" },
  { key: "risk", label: "RISK", what: "Risk-on / risk-off inputs — FRED and Yahoo Finance" },
  { key: "policy", label: "BIS", what: "Policy rates and CPI — BIS; Fed range, balance sheets — FRED; fed funds futures — Yahoo Finance" },
  { key: "flows", label: "ETF", what: "Flow proxy — ETF returns from Yahoo Finance" },
  { key: "calendar", label: "FF", what: "Economic calendar — Forex Factory weekly export" },
  { key: "news", label: "RSS", what: "Headlines — Fed, ECB, BoJ and CNBC feeds" },
];

export function StatusBar() {
  const s = useTerminal();
  const loaded: Record<FeedKey, boolean> = {
    quotes: s.pricesAsOf > 0,
    macro: !!s.macro,
    risk: !!s.risk,
    policy: !!s.policy,
    flows: !!s.flows,
    calendar: !!s.calendar,
    news: !!s.news,
    book: !!s.book,
  };
  const downCount = FEEDS.filter((f) => s.down[f.key]).length;
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel px-2.5 text-2xs text-ink-3">
      <span
        className={cn("num rounded-sm border px-1 leading-[14px]", downCount ? "border-warn/40 bg-warn/10 text-warn" : "border-up/40 bg-up/10 text-up")}
        title="Every number on screen comes from a public data feed. Nothing is simulated; a pane whose feed is down says so."
      >
        {downCount ? `${downCount} FEED${downCount > 1 ? "S" : ""} DOWN` : "REAL DATA"}
      </span>
      <span className="flex items-center gap-2.5 overflow-hidden">
        {FEEDS.map((f) => {
          const down = !!s.down[f.key];
          const state = down ? (loaded[f.key] ? "stale, retrying" : "unavailable, retrying") : loaded[f.key] ? "live" : "loading";
          return (
            <span key={f.key} className="flex shrink-0 items-center gap-1" title={`${f.what} (${state})`}>
              <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", down ? "bg-warn" : loaded[f.key] ? "bg-up" : "bg-ink-3")} />
              <span className={cn("num", down && "text-warn")}>{f.label}</span>
              <span className="sr-only">{state}</span>
            </span>
          );
        })}
      </span>
      <span className="num hidden shrink-0 xl:inline">
        {s.series && `liquidity ${shortDate(s.series.liquidityAsOf)} · yields ${shortDate(s.series.yieldsAsOf)}`}
        {s.risk && ` · risk ${shortDate(s.risk.asOf)}`}
        {s.pricesAsOf > 0 && ` · prices ${new Date(s.pricesAsOf * 1000).toISOString().slice(11, 16)}Z`}
      </span>
      <span className="ml-auto hidden shrink-0 items-center gap-3 lg:flex">
        <span className="flex items-center gap-1"><Key>⌘K</Key> / <Key>/</Key> command</span>
        <span className="flex items-center gap-1"><Key>1</Key>–<Key>5</Key> module</span>
        <span className="flex items-center gap-1"><Key>Esc</Key> clear cursor</span>
      </span>
    </footer>
  );
}
