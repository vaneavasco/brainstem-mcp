import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/** Matches the URL cloudflared prints for a quick (`trycloudflare.com`) tunnel. */
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export const DEFAULT_PUBLIC_URL_FILE = '/vault/_brainstem/public-url';

/** Backoff resets to the first step once a child has run this long without exiting. */
const HEALTHY_UPTIME_MS = 60_000;
const MIN_RESTART_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 30_000;

export interface ChildLike {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(ev: 'exit', cb: (code: number | null) => void): unknown;
  kill(): void;
}

export interface SupervisorOptions {
  mode: 'quick' | 'cloudflare';
  token?: string;
  target: string;
  urlFile?: string;
  spawn: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => ChildLike;
  log: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Extracts the quick-tunnel URL from a single line of cloudflared output, if present. */
export function extractTunnelUrl(line: string): string | null {
  const match = TUNNEL_URL_RE.exec(line);
  return match ? match[0] : null;
}

/**
 * Builds the cloudflared CLI arguments for the given mode. `quick` starts an
 * ephemeral tunnel to `target` with a URL cloudflared picks; `cloudflare`
 * runs a named tunnel identified by the token, whose URL is fixed at creation
 * time and never changes. The token itself is never an argument — cloudflared
 * reads it from `TUNNEL_TOKEN` (see `childEnv` below), keeping it out of `ps`
 * output and `docker inspect`.
 */
export function cloudflaredArgs(o: Pick<SupervisorOptions, 'mode' | 'token' | 'target'>): string[] {
  if (o.mode === 'quick') {
    return ['tunnel', '--no-autoupdate', '--url', o.target];
  }
  if (!o.token) {
    throw new Error('cloudflare mode requires a token');
  }
  return ['tunnel', '--no-autoupdate', 'run'];
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Atomic tmp-write + rename, matching `src/vault/connection-note.ts`'s
 * `writeAtomic`: a unique per-write tmp name (pid + random suffix) so a
 * concurrent reader (the app polling this same file) never observes a
 * partially-written line.
 */
async function writeUrlFileAtomic(filePath: string, url: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${url}\n`, 'utf8');
  await fs.rename(tmp, filePath);
}

/**
 * Removes a stale quick-tunnel URL file. Every `cloudflared` start hands out a
 * brand-new `*.trycloudflare.com` hostname, so the file on disk is wrong the
 * moment we (re)spawn the child: clearing it first makes the app wait for the
 * new URL instead of booting on the previous one (and then restarting itself
 * seconds later when the real URL lands). A missing file is the normal case.
 */
export async function clearUrlFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Resolves once `signal` fires (or immediately if it already has). */
function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function watchLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return;
  readline.createInterface({ input: stream }).on('line', onLine);
}

/**
 * Runs cloudflared under supervision, restarting it with exponential
 * backoff (1s → 30s, capped) whenever it exits, until `signal` aborts. In
 * `quick` mode, the URL cloudflared prints is parsed from its stdout/stderr
 * and written atomically to `urlFile` whenever it changes; `cloudflare`
 * mode never writes the file since its URL is fixed by the token.
 */
export async function runSupervisor(o: SupervisorOptions, signal: AbortSignal): Promise<void> {
  const sleep = o.sleep ?? defaultSleep;
  const urlFile = o.urlFile ?? DEFAULT_PUBLIC_URL_FILE;
  let attempt = 0;
  let lastUrl: string | null = null;
  // Merged into the child's environment by the caller's `spawn` (see
  // `supervisor-main.ts`); `undefined` means "inherit ours unchanged".
  const childEnv = o.mode === 'cloudflare' && o.token ? { TUNNEL_TOKEN: o.token } : undefined;

  while (!signal.aborted) {
    if (o.mode === 'quick') {
      // Before *every* spawn, not just the first: a restart rotates the URL too.
      try {
        await clearUrlFile(urlFile);
      } catch (err: unknown) {
        o.log(
          `failed to remove stale public URL file: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      lastUrl = null;
    }
    const args = cloudflaredArgs(o);
    const child = o.spawn('cloudflared', args, { env: childEnv });
    const spawnedAt = Date.now();
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });

    const handleLine = (line: string): void => {
      o.log(line);
      if (o.mode !== 'quick') return;
      const url = extractTunnelUrl(line);
      if (!url || url === lastUrl) return;
      lastUrl = url;
      void writeUrlFileAtomic(urlFile, url).catch((err: unknown) => {
        o.log(
          `failed to write public URL file: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    };
    watchLines(child.stdout, handleLine);
    watchLines(child.stderr, handleLine);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', resolve);
    });
    signal.removeEventListener('abort', onAbort);

    if (signal.aborted) break;

    const livedMs = Date.now() - spawnedAt;
    if (livedMs > HEALTHY_UPTIME_MS) attempt = 0;
    const delay = Math.min(MAX_RESTART_DELAY_MS, MIN_RESTART_DELAY_MS * 2 ** attempt);
    attempt += 1;
    o.log(`cloudflared exited (code ${exitCode ?? 'null'}) — restarting in ${delay}ms`);

    await Promise.race([sleep(delay), whenAborted(signal)]);
  }
}
