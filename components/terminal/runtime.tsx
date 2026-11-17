"use client";

import { useEffect } from "react";
import { useTerminal } from "@/lib/store";
import { VIEW_BY_KEY } from "@/lib/views";

const SEC = 1000;
const MIN = 60 * SEC;

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

/** Headless: polls the data APIs and owns global hotkeys. */
export function Runtime() {
  useEffect(() => {
    const s = useTerminal.getState();
    // [fetcher, refresh interval]. Upstream data is cached server-side, so these are cheap.
    const feeds: [() => void, number][] = [
      [s.fetchQuotes, 30 * SEC],
      [s.fetchMacro, MIN],
      [s.fetchRisk, 5 * MIN],
      [s.fetchPolicy, 10 * MIN],
      [s.fetchCalendar, 30 * MIN],
      [s.fetchNews, 2 * MIN],
      [s.fetchFlows, 10 * MIN],
      [s.touch, 15 * SEC],
    ];
    feeds.forEach(([run]) => run());
    const ids = feeds.map(([run, every]) => setInterval(run, every));
    // A feed that failed is retried every 10 seconds until it answers.
    const retry: Record<string, () => void> = {
      quotes: s.fetchQuotes, macro: s.fetchMacro, risk: s.fetchRisk, policy: s.fetchPolicy,
      calendar: s.fetchCalendar, news: s.fetchNews, flows: s.fetchFlows,
    };
    ids.push(
      setInterval(() => {
        const { down } = useTerminal.getState();
        for (const [key, run] of Object.entries(retry)) if (down[key as keyof typeof down]) run();
      }, 10 * SEC),
    );
    return () => ids.forEach(clearInterval);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useTerminal.getState();

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.togglePalette();
        return;
      }
      if (s.paletteOpen) return; // palette handles its own keys (incl. Esc)

      if (e.key === "Escape") {
        s.clearCursor();
        (document.activeElement as HTMLElement | null)?.blur?.();
        return;
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "/") {
        e.preventDefault();
        s.setPaletteOpen(true);
        return;
      }
      const view = VIEW_BY_KEY[e.key];
      if (view) s.setView(view);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return null;
}
