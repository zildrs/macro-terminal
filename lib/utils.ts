import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Fixed-locale number formatting so server and client render identically. */
export function fmt(n: number, decimals = 2): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtSigned(n: number, decimals = 2, suffix = ""): string {
  const s = fmt(Math.abs(n), decimals);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${s}${suffix}`;
}

export function fmtCompact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${fmt(n / 1e6, 2)}M`;
  if (a >= 1e3) return `${fmt(n / 1e3, 1)}K`;
  return fmt(n, 0);
}

export function dirClass(n: number): string {
  return n > 0 ? "text-up" : n < 0 ? "text-down" : "text-ink-2";
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ---- Seeded randomness: deterministic series so SSR and client agree ----

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-9);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Ramp the tail of a series so its final value lands exactly on `target`. */
export function pinEnd(arr: number[], target: number, ramp = 12): number[] {
  const diff = target - arr[arr.length - 1];
  const start = Math.max(0, arr.length - ramp);
  return arr.map((v, i) => (i < start ? v : v + (diff * (i - start + 1)) / (arr.length - start)));
}
