/**
 * `/health` client shared by the `up`/`url`/`status` commands. Failures of
 * any kind (network error, non-200, bad JSON, missing fields) collapse to
 * `null` — callers only need to know "is it up and does it look right".
 */

export interface HealthInfo {
  publicUrl: string;
  mcpUrl: string;
  tunnelMode: string;
  notes: number;
}

function toHealthInfo(body: unknown): HealthInfo | null {
  if (typeof body !== 'object' || body === null) return null;
  const rec = body as Record<string, unknown>;
  if (typeof rec.publicUrl !== 'string' || typeof rec.mcpUrl !== 'string') return null;
  const vault = rec.vault as Record<string, unknown> | undefined;
  const notes = typeof vault?.notes === 'number' ? vault.notes : 0;
  return {
    publicUrl: rec.publicUrl,
    mcpUrl: rec.mcpUrl,
    tunnelMode: typeof rec.tunnelMode === 'string' ? rec.tunnelMode : 'none',
    notes,
  };
}

/** Fetches and minimally validates `url`'s `/health` response; `null` on any failure. */
export async function fetchHealth(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HealthInfo | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return toHealthInfo(body);
  } catch {
    return null;
  }
}

const POLL_INTERVAL_MS = 2000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `url` every 2s (via the injected `sleep`, so tests can stub it out
 * instantly) until it answers healthy or `timeoutMs` of simulated time has
 * elapsed; returns `null` on timeout. The elapsed clock advances only by
 * what's actually slept, not wall time, so a no-op `sleep` makes this
 * resolve immediately in tests regardless of `timeoutMs`.
 */
export async function waitForHealth(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<HealthInfo | null> {
  let elapsedMs = 0;
  for (;;) {
    const health = await fetchHealth(url, fetchImpl);
    if (health) return health;
    if (elapsedMs >= timeoutMs) return null;
    await sleep(POLL_INTERVAL_MS);
    elapsedMs += POLL_INTERVAL_MS;
  }
}
