"use client";

import { useEffect, useRef } from "react";
import { Command } from "cmdk";
import { CandlestickChart, Clock, LayoutGrid, Pause, RefreshCw, Search } from "lucide-react";
import { INSTRUMENTS, TIMEFRAMES } from "@/lib/instruments";
import { useTerminal } from "@/lib/store";
import { VIEWS } from "@/lib/views";
import { cn, dirClass, fmt, fmtSigned } from "@/lib/utils";

const itemCls =
  "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-ink-2 data-[selected=true]:bg-line data-[selected=true]:text-ink";
const groupCls =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-ink-3";

function Hint({ children }: { children: React.ReactNode }) {
  return <kbd className="num ml-auto rounded-[2px] border border-line-strong px-1 text-[9px] leading-[13px] text-ink-3">{children}</kbd>;
}

export function CommandPalette() {
  const open = useTerminal((s) => s.paletteOpen);
  const setOpen = useTerminal((s) => s.setPaletteOpen);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Remember what had focus, give it back on close.
  useEffect(() => {
    if (open) restoreRef.current = document.activeElement as HTMLElement | null;
    else restoreRef.current?.focus?.();
  }, [open]);

  if (!open) return null;

  const run = (fn: () => void) => () => {
    fn();
    setOpen(false);
  };
  const s = useTerminal.getState();

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-base/70 px-4 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <Command
        label="Command palette"
        loop
        // Substring matching (not fuzzy) so "gold" finds GOLD, not "Global Liquidity…".
        filter={(value, search) => {
          const v = value.toLowerCase();
          const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
          if (!words.length) return 1;
          if (!words.every((w) => v.includes(w))) return 0;
          if (v.startsWith(`asset ${words[0]}`)) return 1;
          return v.split(" ").some((t) => t.startsWith(words[0])) ? 0.8 : 0.5;
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className="w-full max-w-[560px] overflow-hidden rounded-md border border-line-strong bg-panel shadow-2xl shadow-black/60"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search size={13} className="shrink-0 text-ink-3" aria-hidden />
          <Command.Input
            autoFocus
            placeholder="Search assets, modules, timeframes…"
            className="h-10 w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
          />
          <kbd className="num shrink-0 rounded-[2px] border border-line-strong px-1 text-[9px] leading-[13px] text-ink-3">ESC</kbd>
        </div>
        <Command.List className="max-h-[52vh] overflow-auto p-1">
          <Command.Empty className="px-2 py-6 text-center text-xs text-ink-3">No matching command.</Command.Empty>

          <Command.Group heading="Modules" className={groupCls}>
            {VIEWS.map((v) => (
              <Command.Item key={v.id} value={`module ${v.label} ${v.short}`} onSelect={run(() => s.setView(v.id))} className={itemCls}>
                <LayoutGrid size={12} aria-hidden />
                {v.label}
                <Hint>{v.key}</Hint>
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="Assets" className={groupCls}>
            {INSTRUMENTS.map((i) => {
              const q = s.quotes[i.symbol];
              return (
                <Command.Item
                  key={i.symbol}
                  value={`asset ${i.symbol} ${i.name} ${i.group}`}
                  onSelect={run(() => {
                    s.setSymbol(i.symbol);
                    // Make sure the chart is on screen.
                    if (useTerminal.getState().view !== "overview") s.setView("cross");
                  })}
                  className={itemCls}
                >
                  <CandlestickChart size={12} aria-hidden />
                  <span className="num w-16 shrink-0 font-semibold text-ink">{i.symbol}</span>
                  <span className="truncate">{i.name}</span>
                  {q && (
                    <>
                      <span className="num ml-auto shrink-0 text-ink">{fmt(q.price, i.decimals)}</span>
                      <span className={cn("num w-14 shrink-0 text-right", dirClass(q.changePct))}>{fmtSigned(q.changePct, 2, "%")}</span>
                    </>
                  )}
                </Command.Item>
              );
            })}
          </Command.Group>

          <Command.Group heading="Timeframe" className={groupCls}>
            {TIMEFRAMES.map((t) => (
              <Command.Item key={t} value={`timeframe ${t} chart interval`} onSelect={run(() => s.setTimeframe(t))} className={itemCls}>
                <Clock size={12} aria-hidden />
                Chart timeframe {t}
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="Actions" className={groupCls}>
            <Command.Item value="action pause resume ticker tape" onSelect={run(s.toggleTape)} className={itemCls}>
              <Pause size={12} aria-hidden />
              {s.tapePaused ? "Resume" : "Pause"} ticker tape
            </Command.Item>
            <Command.Item
              value="action refresh reload all data feeds"
              onSelect={run(() => [s.fetchQuotes, s.fetchMacro, s.fetchRisk, s.fetchPolicy, s.fetchCalendar, s.fetchNews, s.fetchFlows].forEach((f) => void f()))}
              className={itemCls}
            >
              <RefreshCw size={12} aria-hidden />
              Refresh all data feeds
            </Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
