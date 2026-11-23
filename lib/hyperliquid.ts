// Server-only: Hyperliquid's public info API (https://hyperliquid.gitbook.io/hyperliquid-docs).
// No key, no account, answers in well under a second from anywhere, and trades 24/7 — so it is
// the live price layer for the risk score. Builder-deployed perps on the "xyz" dex track equity
// indices and FX via oracles (xyz:SP500, xyz:XYZ100, xyz:EUR, …); BTC is on the main dex.

import { cached } from "./server-cache";

const INFO = "https://api.hyperliquid.xyz/info";
const TIMEOUT_MS = 6_000;

async function info<T>(body: unknown, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "macro-terminal/0.1" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    throw new Error(`Hyperliquid ${what}: ${err instanceof Error ? err.message : "network error"}${cause ? ` (${cause})` : ""}`);
  }
  if (!res.ok) throw new Error(`Hyperliquid ${what}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface AssetCtx {
  markPx?: string;
  dayNtlVlm?: string;
}
type MetaAndCtxs = [{ universe: { name: string }[] }, AssetCtx[]];

export interface HlMarks {
  /** Mark price by coin name as Hyperliquid spells it, e.g. "BTC", "xyz:SP500". */
  px: Record<string, number>;
  at: number;
}

async function pullMarks(): Promise<HlMarks> {
  const [main, xyz] = await Promise.all([
    info<MetaAndCtxs>({ type: "metaAndAssetCtxs" }, "marks"),
    info<MetaAndCtxs>({ type: "metaAndAssetCtxs", dex: "xyz" }, "xyz marks"),
  ]);
  const px: Record<string, number> = {};
  for (const [meta, ctxs] of [main, xyz]) {
    meta.universe.forEach((a, i) => {
      const p = Number(ctxs[i]?.markPx);
      if (p > 0) px[a.name] = p;
    });
  }
  return { px, at: Date.now() };
}

/** Live mark prices for every main-dex and xyz perp. Refreshed at most every 5 seconds. */
export const hlMarks = () => cached("hl:marks", 5_000, pullMarks, 5_000, { live: true });

interface Candle {
  t: number;
  T: number;
  o: string;
  c: string;
}

const g = globalThis as typeof globalThis & { __hlAnchors?: Map<string, number> };
const anchors = (g.__hlAnchors ??= new Map());

/**
 * Price of `coin` at `ms` from hourly candles: the open of the hour that starts at (or contains)
 * `ms`, else the close of the last hour before it. Settled hours never change, so they are kept.
 */
export async function hlPriceAt(coin: string, ms: number): Promise<number | null> {
  const key = `${coin}@${ms}`;
  const hit = anchors.get(key);
  if (hit !== undefined) return hit;
  const candles = await info<Candle[]>({ type: "candleSnapshot", req: { coin, interval: "1h", startTime: ms - 8 * 3600_000, endTime: ms + 3600_000 } }, `candles ${coin}`);
  if (!Array.isArray(candles) || !candles.length) return null;
  const within = candles.find((c) => c.t <= ms && ms <= c.T);
  const before = candles.filter((c) => c.T < ms).pop();
  const px = within ? Number(within.o) : before ? Number(before.c) : NaN;
  if (!(px > 0)) return null;
  if (ms < Date.now() - 3600_000) anchors.set(key, px);
  return px;
}
