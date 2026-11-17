import type { DataSource } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PanelProps {
  title: string;
  /** Module tag, e.g. "M2". */
  tag?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function Panel({ title, tag, right, children, className, bodyClassName }: PanelProps) {
  return (
    <section className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-sm border border-line bg-panel", className)}>
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2">
        {tag && <span className="num rounded-sm bg-raised px-1 text-2xs text-ink-3">{tag}</span>}
        <h2 className="truncate text-2xs font-semibold uppercase tracking-[0.08em] text-ink-2">{title}</h2>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">{right}</div>
      </header>
      <div className={cn("flex min-h-0 flex-1 flex-col p-2", bodyClassName)}>{children}</div>
    </section>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  options: readonly T[] | { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
}

export function Segmented<T extends string>({ value, options, onChange, label, className }: SegmentedProps<T>) {
  const opts = (options as (T | { value: T; label: string })[]).map((o) =>
    typeof o === "string" ? { value: o, label: o as string } : o,
  );
  return (
    <div role="group" aria-label={label} className={cn("flex items-center rounded-sm border border-line", className)}>
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "num h-[18px] px-1.5 text-2xs leading-none transition-colors",
            o.value === value ? "bg-line-strong text-ink" : "text-ink-3 hover:text-ink-2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const BIAS_STYLE = {
  Hawkish: "border-down/40 bg-down/10 text-down",
  Dovish: "border-up/40 bg-up/10 text-up",
  Neutral: "border-warn/40 bg-warn/10 text-warn",
} as const;

export function BiasBadge({ bias, className }: { bias: keyof typeof BIAS_STYLE; className?: string }) {
  return (
    <span className={cn("num inline-block rounded-sm border px-1 text-2xs uppercase leading-[14px]", BIAS_STYLE[bias], className)}>
      {bias}
    </span>
  );
}

/** Names the real feed behind a pane. */
export function SourceTag({ source, asOf, title }: { source: DataSource | string; asOf?: string; title?: string }) {
  return (
    <span
      title={title ?? `Source: ${source}${asOf ? `, latest observation ${asOf}` : ""}`}
      className="num rounded-sm border border-up/40 bg-up/10 px-1 text-2xs leading-[14px] text-up"
    >
      {source}
    </span>
  );
}

/** Body shown while a pane has no data: still loading, or its source is down and being retried. */
export function PaneNotice({ down, what }: { down?: boolean; what: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-3 text-center text-2xs text-ink-3" role="status">
      {down ? `${what} unavailable — source not responding, retrying…` : `Loading ${what.toLowerCase()}…`}
    </div>
  );
}

export function LegendDot({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1 text-2xs text-ink-2">
      <span
        aria-hidden
        className="inline-block h-0 w-3 border-t-2"
        style={{ borderColor: color, borderTopStyle: dashed ? "dashed" : "solid" }}
      />
      {label}
    </span>
  );
}
