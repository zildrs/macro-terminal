"use client";

/** Shared Recharts theme for the terminal. */

export const SERIES = {
  s1: "#3987e5",
  s2: "#d95926",
  s3: "#199e70",
  bench: "#d4d4d8",
  up: "#22c55e",
  down: "#ef4444",
  warn: "#f59e0b",
} as const;

export const GRID_STROKE = "#27272a";

export const axisProps = {
  tick: { fill: "#71717a", fontSize: 10, fontFamily: "var(--font-mono), monospace" },
  axisLine: { stroke: "#27272a" },
  tickLine: false,
} as const;

/**
 * Evenly spaced axis ticks on multiples of `step` that cover `values`; the step doubles until
 * at most `maxTicks` intervals remain. Use the first/last as the axis domain.
 */
export function stepTicks(values: number[], step: number, maxTicks = 5): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  let s = step;
  while ((Math.ceil(max / s) - Math.floor(min / s)) > maxTicks) s *= 2;
  const lo = Math.floor(min / s);
  const hi = Math.max(Math.ceil(max / s), lo + 1);
  return Array.from({ length: hi - lo + 1 }, (_, i) => Math.round((lo + i) * s * 1e6) / 1e6);
}

export const cursorProps = { stroke: "#52525b", strokeWidth: 1 } as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-11" → "Nov '26" */
export function monthTick(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} '${iso.slice(2, 4)}`;
}

/** "2026-11-11" → "11 Nov 2026" */
export function longDate(iso: string): string {
  return `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

/** "2026-11-11" → "Nov 11" */
export function shortDate(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(8, 10)}`;
}

interface TipEntry {
  name?: string | number;
  value?: number | string | (number | string)[];
  color?: string;
  dataKey?: string | number;
}

interface ChartTipProps {
  active?: boolean;
  payload?: TipEntry[];
  label?: string | number;
  labelFormat?: (l: string) => string;
  valueFormat?: (v: number, key: string) => string;
}

/** Dark tooltip: the swatch carries series colour, text stays in ink tokens. */
export function ChartTip({ active, payload, label, labelFormat, valueFormat }: ChartTipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-sm border border-line-strong bg-base/95 px-2 py-1.5 shadow-lg">
      <div className="num mb-1 text-2xs text-ink-3">{labelFormat ? labelFormat(String(label)) : label}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2 text-2xs">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-[1px]" style={{ background: p.color }} />
          <span className="text-ink-2">{p.name}</span>
          <span className="num ml-auto pl-3 text-ink">
            {typeof p.value === "number" && valueFormat ? valueFormat(p.value, String(p.dataKey)) : String(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
}
