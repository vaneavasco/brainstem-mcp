import { promises as fs } from 'node:fs';

/**
 * The quick-tunnel supervisor (Task 12) writes the current public URL as the
 * first line of `<vault>/_brainstem/public-url`. Trim it and accept it only
 * if it parses as an http(s) URL — anything else (empty file, a supervisor
 * log line, a half-written line) is treated as "not ready yet".
 */
export function parsePublicUrlFile(text: string): string | null {
  const line = (text.split('\n')[0] ?? '').trim();
  if (!line) return null;
  let url: URL;
  try {
    url = new URL(line);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return line;
}

async function readPublicUrl(file: string): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return parsePublicUrlFile(text);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits (by polling — no filesystem watch, since the file may live on a
 * bind-mounted volume) for the tunnel supervisor to publish a URL, up to
 * `timeoutMs`. Deliberately does not `.unref()` its wait loop: this runs at
 * boot before anything else (server, timers) exists to keep the process
 * alive, and it always terminates on its own via the timeout below.
 */
export async function waitForPublicUrl(
  file: string,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const url = await readPublicUrl(file);
    if (url) return url;
    if (Date.now() - start >= opts.timeoutMs) {
      throw new Error('tunnel did not come up — run `./brainstem logs tunnel`');
    }
    await sleep(opts.intervalMs);
  }
}

/**
 * Polls the public-url file forever (until `stop()` is called) and fires
 * `onChange` once per transition away from the last-seen value — not
 * continuously for as long as the content differs from the original
 * `current` argument. The timer is `.unref()`'d: this only ever runs after
 * the server is already listening, so it must never by itself keep the
 * process alive past a shutdown that forgot to call `stop()`.
 */
export function watchPublicUrl(
  file: string,
  current: string,
  onChange: (next: string) => void,
  intervalMs: number,
): () => void {
  let last = current;
  const timer = setInterval(() => {
    void readPublicUrl(file).then(
      (next) => {
        if (next && next !== last) {
          last = next;
          onChange(next);
        }
      },
      () => {
        // Transient read error (e.g. the supervisor is mid-rewrite) — try again next tick.
      },
    );
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
