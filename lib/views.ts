import type { ViewId } from "./types";

export type WidgetId =
  | "rates"
  | "fedprob"
  | "balance"
  | "netliq"
  | "yield"
  | "flows"
  | "chart"
  | "cot"
  | "orderflow"
  | "events"
  | "news"
  | "risk";

export const VIEWS: { id: ViewId; key: string; label: string; short: string }[] = [
  { id: "cb", key: "1", label: "Central Bank & Monetary Policy", short: "POLICY" },
  { id: "liquidity", key: "2", label: "Global Liquidity & Capital Flows", short: "LIQUIDITY" },
  { id: "cross", key: "3", label: "Cross-Asset & Positioning", short: "X-ASSET" },
  { id: "intel", key: "4", label: "Calendar & Macro Intelligence", short: "INTEL" },
  { id: "overview", key: "5", label: "Overview — all modules", short: "ALL" },
];

export const VIEW_BY_KEY: Record<string, ViewId> = Object.fromEntries(VIEWS.map((v) => [v.key, v.id]));

/**
 * Pane placement on the xl 12-column × 6-row grid. Class strings are written out in full
 * so Tailwind's scanner picks them up.
 */
export const LAYOUTS: Record<ViewId, { id: WidgetId; cls: string }[]> = {
  overview: [
    { id: "risk", cls: "xl:col-start-10 xl:col-span-3 xl:row-start-1 xl:row-span-2" },
    { id: "netliq", cls: "xl:col-start-1 xl:col-span-4 xl:row-start-1 xl:row-span-2" },
    { id: "chart", cls: "xl:col-start-5 xl:col-span-5 xl:row-start-1 xl:row-span-2" },
    { id: "events", cls: "xl:col-start-10 xl:col-span-3 xl:row-start-3 xl:row-span-2" },
    { id: "rates", cls: "xl:col-start-1 xl:col-span-4 xl:row-start-3 xl:row-span-2" },
    { id: "fedprob", cls: "xl:col-start-5 xl:col-span-2 xl:row-start-3 xl:row-span-2" },
    { id: "yield", cls: "xl:col-start-7 xl:col-span-3 xl:row-start-3 xl:row-span-2" },
    { id: "news", cls: "xl:col-start-10 xl:col-span-3 xl:row-start-5 xl:row-span-2" },
    { id: "balance", cls: "xl:col-start-1 xl:col-span-3 xl:row-start-5 xl:row-span-2" },
    { id: "flows", cls: "xl:col-start-4 xl:col-span-2 xl:row-start-5 xl:row-span-2" },
    { id: "cot", cls: "xl:col-start-6 xl:col-span-2 xl:row-start-5 xl:row-span-2" },
    { id: "orderflow", cls: "xl:col-start-8 xl:col-span-2 xl:row-start-5 xl:row-span-2" },
  ],
  cb: [
    { id: "rates", cls: "xl:col-start-1 xl:col-span-7 xl:row-start-1 xl:row-span-3" },
    { id: "fedprob", cls: "xl:col-start-8 xl:col-span-5 xl:row-start-1 xl:row-span-3" },
    { id: "balance", cls: "xl:col-start-1 xl:col-span-12 xl:row-start-4 xl:row-span-3" },
  ],
  liquidity: [
    { id: "netliq", cls: "xl:col-start-1 xl:col-span-8 xl:row-start-1 xl:row-span-6" },
    { id: "yield", cls: "xl:col-start-9 xl:col-span-4 xl:row-start-1 xl:row-span-3" },
    { id: "flows", cls: "xl:col-start-9 xl:col-span-4 xl:row-start-4 xl:row-span-3" },
  ],
  cross: [
    { id: "chart", cls: "xl:col-start-1 xl:col-span-8 xl:row-start-1 xl:row-span-4" },
    { id: "risk", cls: "xl:col-start-9 xl:col-span-4 xl:row-start-1 xl:row-span-3" },
    { id: "orderflow", cls: "xl:col-start-9 xl:col-span-4 xl:row-start-4 xl:row-span-3" },
    { id: "cot", cls: "xl:col-start-1 xl:col-span-8 xl:row-start-5 xl:row-span-2" },
  ],
  intel: [
    { id: "events", cls: "xl:col-start-1 xl:col-span-7 xl:row-start-1 xl:row-span-6" },
    { id: "news", cls: "xl:col-start-8 xl:col-span-5 xl:row-start-1 xl:row-span-6" },
  ],
};
