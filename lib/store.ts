"use client";

import { create } from "zustand";
import type {
  BookPayload,
  CalendarEvent,
  FlowRow,
  MacroPayload,
  MacroSeries,
  NewsItem,
  PolicyPayload,
  Quote,
  QuotesPayload,
  RiskSnapshot,
  Timeframe,
  ViewId,
} from "./types";

/** Feeds the terminal polls. A key is in `down` while its last request failed. */
export type FeedKey = "quotes" | "macro" | "risk" | "policy" | "calendar" | "news" | "flows" | "book";

interface TerminalState {
  // layout / navigation
  view: ViewId;
  activeSymbol: string;
  timeframe: Timeframe;
  paletteOpen: boolean;
  /** Bumped on Esc so charts can drop their crosshair/tooltip. */
  cursorNonce: number;
  tapePaused: boolean;

  // Real data. Everything is null (or empty) until its feed answers — nothing is ever made up.
  quotes: Record<string, Quote>;
  /** Unix seconds of the freshest quote; 0 until the first response. */
  pricesAsOf: number;
  macro: MacroPayload | null;
  series: MacroSeries | null;
  risk: RiskSnapshot | null;
  policy: PolicyPayload | null;
  calendar: CalendarEvent[] | null;
  news: NewsItem[] | null;
  flows: { rows: FlowRow[]; asOf: string } | null;
  book: BookPayload | null;
  down: Partial<Record<FeedKey, boolean>>;
  /** Wall clock, refreshed every few seconds, for "x minutes ago" labels. 0 during SSR. */
  now: number;

  setView: (v: ViewId) => void;
  setSymbol: (s: string) => void;
  setTimeframe: (t: Timeframe) => void;
  setPaletteOpen: (o: boolean) => void;
  togglePalette: () => void;
  toggleTape: () => void;
  clearCursor: () => void;
  touch: () => void;
  fetchQuotes: () => Promise<void>;
  fetchMacro: () => Promise<void>;
  fetchRisk: () => Promise<void>;
  fetchPolicy: () => Promise<void>;
  fetchCalendar: () => Promise<void>;
  fetchNews: () => Promise<void>;
  fetchFlows: () => Promise<void>;
  fetchBook: () => Promise<void>;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

export const useTerminal = create<TerminalState>((set, get) => {
  const mark = (key: FeedKey, failed: boolean) => {
    if (!!get().down[key] !== failed) set({ down: { ...get().down, [key]: failed } });
  };
  /** Fetch one feed into one store field; on failure keep the last good value and flag the feed. */
  const feed = <K extends "risk" | "policy" | "calendar" | "news" | "flows" | "book">(key: K, url: string) => async () => {
    try {
      set({ [key]: await getJson<TerminalState[K]>(url) } as Pick<TerminalState, K>);
      mark(key, false);
    } catch {
      mark(key, true);
    }
  };

  return {
    view: "overview",
    activeSymbol: "SPY",
    timeframe: "1D",
    paletteOpen: false,
    cursorNonce: 0,
    tapePaused: false,

    quotes: {},
    pricesAsOf: 0,
    macro: null,
    series: null,
    risk: null,
    policy: null,
    calendar: null,
    news: null,
    flows: null,
    book: null,
    down: {},
    now: 0,

    setView: (view) => set({ view }),
    setSymbol: (activeSymbol) => set({ activeSymbol }),
    setTimeframe: (timeframe) => set({ timeframe }),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
    toggleTape: () => set((s) => ({ tapePaused: !s.tapePaused })),
    clearCursor: () => set((s) => ({ cursorNonce: s.cursorNonce + 1 })),
    touch: () => set({ now: Date.now() }),

    fetchQuotes: async () => {
      try {
        const payload = await getJson<QuotesPayload>("/api/quotes");
        const prev = get().quotes;
        const quotes: Record<string, Quote> = {};
        let asOf = 0;
        for (const [symbol, r] of Object.entries(payload.quotes)) {
          const q = prev[symbol];
          asOf = Math.max(asOf, r.time);
          const moved = !!q && r.price !== q.price;
          quotes[symbol] = {
            symbol,
            price: r.price,
            prevClose: r.prevClose,
            change: r.price - r.prevClose,
            changePct: (r.price / r.prevClose - 1) * 100,
            dir: moved ? (r.price > q.price ? 1 : -1) : 0,
            seq: moved ? q.seq + 1 : (q?.seq ?? 0),
          };
        }
        set({ quotes, pricesAsOf: asOf });
        mark("quotes", false);
      } catch {
        mark("quotes", true);
      }
    },

    fetchMacro: async () => {
      try {
        const macro = await getJson<MacroPayload>("/api/macro");
        // Refetch the history only when the payload moved on from it (a new observation),
        // and commit both together so stat rows and charts never disagree.
        const cur = get().series;
        const moved = !cur || macro.netLiquidity.asOf !== cur.liquidityAsOf || macro.yieldSpreads.asOf !== cur.yieldsAsOf;
        if (moved) set({ macro, series: await getJson<MacroSeries>("/api/macro/series") });
        else set({ macro });
        mark("macro", false);
      } catch {
        mark("macro", true);
      }
    },

    fetchRisk: feed("risk", "/api/risk"),
    fetchPolicy: feed("policy", "/api/policy"),
    fetchCalendar: feed("calendar", "/api/calendar"),
    fetchNews: feed("news", "/api/news"),
    fetchFlows: feed("flows", "/api/flows"),
    fetchBook: feed("book", "/api/orderbook"),
  };
});
