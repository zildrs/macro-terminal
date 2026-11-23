// Server-only cache for upstream data pulls (FRED, Twelve Data, CFTC, …).
//
// Speed rules:
//   - Stale-while-revalidate: once something is cached, requests never wait on an upstream. An
//     expired entry is served as-is while one background pull refreshes it.
//   - Persisted to disk (CACHE_DIR, default ~/.cache/macro-terminal): a restart or deploy starts
//     from the last good data instead of empty panes, and doesn't burn API budgets refilling.
// Live feeds opt out of both with { live: true } — callers wait for a fresh pull once the TTL ends.

import { mkdirSync, readFileSync, writeFile } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Entry<T> {
  data: T | null;
  at: number;
  failedAt: number;
  error: string | null;
  inflight: Promise<T | null> | null;
}

interface Options {
  /** Live data: no disk copy, and an expired entry is refetched before answering. */
  live?: boolean;
}

const RETRY_MS = 60_000; // default back-off after a failed pull
/** Bump when a cached payload's shape changes, so old disk copies are ignored after a deploy. */
const SCHEMA = 1;

// On globalThis so dev hot-reloads don't drop the cache and refetch everything each time.
const g = globalThis as typeof globalThis & { __pullCaches?: Map<string, Entry<unknown>> };
const caches = (g.__pullCaches ??= new Map());

const DIR = process.env.CACHE_DIR || join(homedir(), ".cache", "macro-terminal");
const fileOf = (name: string) => join(DIR, `${name.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

function readDisk<T>(name: string): { data: T; at: number } | null {
  try {
    const saved = JSON.parse(readFileSync(fileOf(name), "utf8")) as { v?: number; at?: number; data?: T };
    return saved.v === SCHEMA && typeof saved.at === "number" && saved.data != null ? { data: saved.data, at: saved.at } : null;
  } catch {
    return null; // no copy yet, or unreadable: start empty
  }
}

let dirReady = false;
function writeDisk(name: string, data: unknown, at: number): void {
  try {
    if (!dirReady) mkdirSync(DIR, { recursive: true, mode: 0o700 });
    dirReady = true;
    writeFile(fileOf(name), JSON.stringify({ v: SCHEMA, at, data }), { mode: 0o600 }, (err) => {
      if (err) console.warn(`[cache] could not save ${name}: ${err.message}`);
    });
  } catch (err) {
    console.warn(`[cache] could not save ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Runs `pull` at most once per `ttlMs`. Returns null when the upstream can't be reached and
 * nothing is cached (the API route then answers 503); a failed refresh keeps serving the
 * last good pull. Concurrent callers share one request.
 */
export async function cached<T>(name: string, ttlMs: number, pull: () => Promise<T>, retryMs = RETRY_MS, opts: Options = {}): Promise<T | null> {
  let c = caches.get(name) as Entry<T> | undefined;
  if (!c) {
    const disk = opts.live ? null : readDisk<T>(name);
    caches.set(name, (c = { data: disk?.data ?? null, at: disk?.at ?? 0, failedAt: 0, error: null, inflight: null }));
  }
  const entry = c;
  const now = Date.now();
  if (entry.data && now - entry.at < ttlMs) return entry.data;
  if (now - entry.failedAt < retryMs) return entry.data;
  entry.inflight ??= pull()
    .then((data) => {
      entry.data = data;
      entry.at = Date.now();
      entry.error = null;
      if (!opts.live) writeDisk(name, data, entry.at);
      return data as T | null;
    })
    .catch((err: unknown) => {
      entry.failedAt = Date.now();
      entry.error = err instanceof Error ? err.message : "unknown error";
      console.warn(`[data:${name}] ${entry.error}${entry.data ? " — serving last good pull" : " — nothing cached yet, the pane will show it as unavailable"}`);
      return entry.data;
    })
    .finally(() => {
      entry.inflight = null;
    });
  // Something to show already: answer now, let the refresh land for the next request.
  if (entry.data && !opts.live) return entry.data;
  return entry.inflight;
}
