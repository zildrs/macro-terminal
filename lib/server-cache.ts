// Server-only in-memory cache for upstream data pulls (FRED, Yahoo).

interface Entry<T> {
  data: T | null;
  at: number;
  failedAt: number;
  error: string | null;
  inflight: Promise<T | null> | null;
}

const RETRY_MS = 60_000; // default back-off after a failed pull

// On globalThis so dev hot-reloads don't drop the cache and refetch everything each time.
const g = globalThis as typeof globalThis & { __pullCaches?: Map<string, Entry<unknown>> };
const caches = (g.__pullCaches ??= new Map());

/**
 * Runs `pull` at most once per `ttlMs`. Returns null when the upstream can't be reached and
 * nothing is cached (callers fall back to the simulation); a failed refresh keeps serving the
 * last good pull. Concurrent callers share one request.
 */
export async function cached<T>(name: string, ttlMs: number, pull: () => Promise<T>, retryMs = RETRY_MS): Promise<T | null> {
  let c = caches.get(name) as Entry<T> | undefined;
  if (!c) caches.set(name, (c = { data: null, at: 0, failedAt: 0, error: null, inflight: null }));
  const entry = c;
  const now = Date.now();
  if (entry.data && now - entry.at < ttlMs) return entry.data;
  if (now - entry.failedAt < retryMs) return entry.data;
  entry.inflight ??= pull()
    .then((data) => {
      entry.data = data;
      entry.at = Date.now();
      entry.error = null;
      return data as T | null;
    })
    .catch((err: unknown) => {
      entry.failedAt = Date.now();
      entry.error = err instanceof Error ? err.message : "unknown error";
      console.warn(`[data:${name}] ${entry.error}${entry.data ? " — serving last good pull" : " — falling back to simulated data"}`);
      return entry.data;
    })
    .finally(() => {
      entry.inflight = null;
    });
  return entry.inflight;
}
