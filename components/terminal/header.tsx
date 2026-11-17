"use client";

import { useEffect, useState } from "react";
import { Activity, AlertTriangle, Search, TrendingDown, TrendingUp } from "lucide-react";
import { RISK_STYLE } from "@/components/modules/risk";
import { useTerminal } from "@/lib/store";
import { getInstrument, INSTRUMENTS, TAPE_SYMBOLS } from "@/lib/instruments";
import { VIEWS } from "@/lib/views";
import type { RegimeCode } from "@/lib/types";
import { cn, dirClass, fmt, fmtSigned } from "@/lib/utils";

// ---------------------------------------------------------------- Ticker cells

function TickerCell({ symbol, compact }: { symbol: string; compact?: boolean }) {
  const q = useTerminal((s) => s.quotes[symbol]);
  const active = useTerminal((s) => s.activeSymbol === symbol);
  const setSymbol = useTerminal((s) => s.setSymbol);
  const inst = getInstrument(symbol);
  return (
    <button
      type="button"
      onClick={() => setSymbol(symbol)}
      title={`${inst.name} — set as active chart`}
      className={cn(
        "flex h-full shrink-0 items-center gap-2 border-r border-line px-2.5 text-left transition-colors hover:bg-raised",
        active && !compact && "bg-raised",
      )}
    >
      <span className={cn("num text-2xs font-semibold tracking-wide", active ? "text-warn" : "text-ink-2")}>{symbol}</span>
      {q ? (
        <>
          <span
            key={q.seq}
            className={cn(
              "num rounded-[1px] px-0.5 text-xs text-ink",
              q.dir > 0 && "animate-flash-up",
              q.dir < 0 && "animate-flash-down",
            )}
          >
            {fmt(q.price, inst.decimals)}
            {inst.unit ?? ""}
          </span>
          <span className={cn("num text-2xs", dirClass(q.changePct))}>{fmtSigned(q.changePct, 2, "%")}</span>
        </>
      ) : (
        <span className="num text-xs text-ink-3">···</span>
      )}
    </button>
  );
}

const SCROLL_SYMBOLS = INSTRUMENTS.map((i) => i.symbol).filter((s) => !TAPE_SYMBOLS.includes(s));

function TickerTape() {
  const paused = useTerminal((s) => s.tapePaused);
  return (
    <div className="flex h-7 shrink-0 items-stretch border-b border-line bg-panel">
      {/* Fixed benchmarks */}
      <div className="flex shrink-0 items-stretch overflow-x-auto">
        {TAPE_SYMBOLS.map((s) => (
          <TickerCell key={s} symbol={s} />
        ))}
      </div>
      {/* Scrolling tape for everything else */}
      <div className="relative hidden min-w-0 flex-1 overflow-hidden lg:block" aria-label="Scrolling ticker tape">
        <div
          className="tape-track flex h-full w-max animate-tape items-stretch"
          style={paused ? { animationPlayState: "paused" } : undefined}
        >
          {[0, 1].map((copy) => (
            <div key={copy} className="flex items-stretch" aria-hidden={copy === 1}>
              {SCROLL_SYMBOLS.map((s) => (
                <TickerCell key={s} symbol={s} compact />
              ))}
            </div>
          ))}
        </div>
        <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-panel to-transparent" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Regime badge

const REGIME_STYLE: Record<RegimeCode, { cls: string; Icon: typeof TrendingUp; short: string }> = {
  LIQUIDITY_EXPANSION: { cls: "border-up/50 bg-up/10 text-up", Icon: TrendingUp, short: "Liquidity Expansion" },
  NEUTRAL: { cls: "border-warn/50 bg-warn/10 text-warn", Icon: Activity, short: "Neutral" },
  STAGFLATION: { cls: "border-warn/50 bg-warn/10 text-warn", Icon: AlertTriangle, short: "Stagflation" },
  TIGHTENING: { cls: "border-down/50 bg-down/10 text-down", Icon: TrendingDown, short: "Tightening" },
};

function RegimeBadge() {
  const regime = useTerminal((s) => s.macro?.macroRegime);
  if (!regime) return null;
  const { cls, Icon, short } = REGIME_STYLE[regime.current];
  return (
    <div
      className={cn("flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5", cls)}
      title={`Macro regime: ${short}. Score ${regime.riskScore}/100 from the liquidity impulse (FRED), fed funds futures pricing and curve shape.`}
    >
      <span className="num hidden text-[9px] tracking-wide opacity-70 lg:block">MACRO</span>
      <Icon size={12} strokeWidth={2.5} aria-hidden />
      <span className="text-2xs font-semibold uppercase tracking-wide">{regime.label}</span>
      <span className="hidden h-3 w-px bg-current opacity-30 sm:block" />
      <span className="num hidden text-2xs sm:block">{regime.riskScore}</span>
    </div>
  );
}

/** Market regime status: risk-on / neutral / risk-off from the cross-asset risk score. */
function MarketBadge() {
  const risk = useTerminal((s) => s.risk);
  const setView = useTerminal((s) => s.setView);
  if (!risk) return null;
  const { cls, Icon, label } = RISK_STYLE[risk.status];
  return (
    <button
      type="button"
      onClick={() => setView("cross")}
      className={cn("flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 transition-opacity hover:opacity-80", cls)}
      title={`Market regime: ${label}. Risk score ${risk.score}/100 (${risk.onCount} indicators risk-on, ${risk.offCount} risk-off), as of ${risk.asOf}. Click for detail.`}
    >
      <span className="num hidden text-[9px] tracking-wide opacity-70 lg:block">MARKET</span>
      <Icon size={12} strokeWidth={2.5} aria-hidden />
      <span className="text-2xs font-semibold uppercase tracking-wide">{label}</span>
      <span className="hidden h-3 w-px bg-current opacity-30 sm:block" />
      <span className="num hidden text-2xs sm:block">{risk.score}</span>
    </button>
  );
}

// ---------------------------------------------------------------- Clocks (client-only)

const ZONES: [string, string][] = [
  ["NY", "America/New_York"],
  ["LDN", "Europe/London"],
  ["JKT", "Asia/Jakarta"],
];

function Clocks() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const hm = (tz: string, withSec = false) =>
    now
      ? now.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: withSec ? "2-digit" : undefined })
      : withSec
        ? "--:--:--"
        : "--:--";
  return (
    <div className="hidden items-center gap-3 2xl:flex">
      {ZONES.map(([label, tz]) => (
        <span key={label} className="num text-2xs text-ink-3">
          {label} <span className="text-ink-2">{hm(tz)}</span>
        </span>
      ))}
      <span className="num text-2xs text-ink-3">
        UTC <span className="text-ink">{hm("UTC", true)}</span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- Header

export function Header() {
  const view = useTerminal((s) => s.view);
  const setView = useTerminal((s) => s.setView);
  const setPaletteOpen = useTerminal((s) => s.setPaletteOpen);
  return (
    <header className="shrink-0">
      <div className="flex h-9 items-center gap-3 border-b border-line bg-panel px-2.5">
        <div className="flex shrink-0 items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 animate-pulse2 rounded-full bg-up" />
          <span className="num text-xs font-bold tracking-[0.14em] text-ink">
            MACRO<span className="text-warn">//</span>TERMINAL
          </span>
        </div>

        <nav aria-label="Modules" className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setView(v.id)}
              aria-current={view === v.id ? "page" : undefined}
              title={`${v.label} (press ${v.key})`}
              className={cn(
                "flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-2 text-2xs font-semibold tracking-wide transition-colors",
                view === v.id ? "bg-line-strong text-ink" : "text-ink-3 hover:bg-raised hover:text-ink-2",
              )}
            >
              <kbd className={cn("num rounded-[2px] border px-1 text-[9px] leading-[13px]", view === v.id ? "border-warn/60 text-warn" : "border-line-strong")}>
                {v.key}
              </kbd>
              {v.short}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          <RegimeBadge />
          <MarketBadge />
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-6 items-center gap-2 rounded-sm border border-line bg-base px-2 text-2xs text-ink-3 transition-colors hover:border-line-strong hover:text-ink-2"
          >
            <Search size={11} aria-hidden />
            <span className="hidden md:inline">Search assets, modules…</span>
            <kbd className="num rounded-[2px] border border-line-strong px-1 text-[9px] leading-[13px]">⌘K</kbd>
          </button>
          <Clocks />
        </div>
      </div>
      <TickerTape />
    </header>
  );
}
