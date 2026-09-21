import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { STOPPING_INDEX_WAIT_MS } from '../storage/limits.ts';
import type { Note } from '../storage/types.ts';
import type { IndexState, VaultRuntime } from '../vault/runtime.ts';
import { registerAnalyticsTools } from './analytics.ts';
import { registerCanvasTools } from './canvas.ts';
import { registerDailyTools } from './daily.ts';
import { registerGraphTools } from './graph.ts';
import { registerManageTools } from './manage.ts';
import { registerQueryTools } from './query.ts';
import { registerReadTools } from './read.ts';
import { fail } from './results.ts';
import { registerSearchTools } from './search.ts';
import { registerTemplateTools } from './template.ts';
import { registerTxTools } from './tx.ts';
import { registerWriteTools } from './write.ts';

export interface ToolContext {
  runtime: VaultRuntime;
  log: (e: unknown) => void;
}

/** Re-reads `paths` into the index. Markdown-only (refreshPath skips anything else) — a mutation
 *  that already holds the post-write Note should call `applyNote` instead (no disk read), and
 *  non-markdown mutations apply the returned Note or `index.addAsset` at the call site. */
export async function touch(tc: ToolContext, ...paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => tc.runtime.index.refreshPath(tc.runtime.adapter, p)));
}

/** Applies an already-in-hand post-write Note to the index — the no-disk-read sibling of touch(). */
export function applyNote(tc: ToolContext, note: Note): void {
  tc.runtime.index.applyNote(note);
}

/** Runs `fn` inside the runtime's WriteGate, holding all `paths` for the duration of the call. */
export function locked<T>(tc: ToolContext, paths: string[], fn: () => Promise<T>): Promise<T> {
  return tc.runtime.gate.withLock(paths, fn);
}

/** Re-exported for compatibility: the shared argument fragments now live in the leaf module
 *  `args.ts`, so a tool module can read them at module scope without touching this file (and its
 *  import cycle). New code should import them from `./args.ts` directly. */
export { DetailedPathArg, ExpectedHashArg, PathArg } from './args.ts';

/**
 * Vault tools that answer without reading the frontmatter index, so they are exempt from the
 * index-readiness gate below: they work from the first second of a deferred boot
 * (`createLocalRuntime({ deferIndex: true })`, the stdio entrypoint) instead of waiting on an
 * index they never touch. `brainstem_ping`/`brainstem_guide` need no entry here — they are
 * registered directly on the server in src/mcp/factory.ts, before `registerVaultTools` runs (and
 * so before the gate below is even installed).
 */
const INDEX_GATE_EXEMPT: ReadonlySet<string> = new Set([
  'vault_read',
  'vault_daily_note_read',
  'vault_daily_note_path',
  'vault_canvas_read',
]);

function indexNotReadyResult(state: IndexState): CallToolResult {
  return state.error
    ? fail(
        'INDEX_ERROR: the vault index could not be built and this tool needs it to run safely; ' +
          'check the server logs (stderr) and restart the server.',
      )
    : fail(
        `INDEX_BUILDING: the vault index is still being built (${state.done} of ${state.total} ` +
          'notes indexed so far). Try again in a moment.',
      );
}

/**
 * Waits for `tc.runtime.indexReady`, up to `tc.runtime.indexWaitMs`, unless the index is already
 * ready or has permanently failed (in which case there is nothing to wait for). Returns `null`
 * when the caller may proceed, or the `CallToolResult` to return instead of running the tool.
 */
async function waitForIndex(tc: ToolContext): Promise<CallToolResult | null> {
  const runtime = tc.runtime;
  const state = runtime.indexState();
  if (state.ready) return null;
  if (state.error) return indexNotReadyResult(state);
  const timers: NodeJS.Timeout[] = [];
  const after = (ms: number) =>
    new Promise<void>((resolve) => timers.push(setTimeout(resolve, ms)));
  await Promise.race([
    runtime.indexReady,
    after(runtime.indexWaitMs),
    // a stopping server gives the index a last short while, then answers instead of vanishing
    runtime.calls.closing.then(() => after(STOPPING_INDEX_WAIT_MS)),
  ]);
  for (const timer of timers) clearTimeout(timer);
  const now = runtime.indexState();
  if (now.ready) return null;
  return runtime.calls.stopping ? shuttingDownResult() : indexNotReadyResult(now);
}

function shuttingDownResult(): CallToolResult {
  return fail('SHUTTING_DOWN: the server is stopping; this call was not started.');
}

/** Runs a tool — its wait for the index included — inside the runtime's call tracker, so a
 *  stopping server waits for it and answers it; refuses to start one once the server is
 *  stopping (the client that asked is, as a rule, already gone). */
function tracked(tc: ToolContext, fn: () => unknown): unknown {
  const calls = tc.runtime.calls;
  return calls.closed ? shuttingDownResult() : calls.run(fn);
}

/** The shape every `registerTool` handler actually has here: every vault tool declares an
 *  `inputSchema`, so its callback is always `(args, ctx) => CallToolResult | Promise<...>` — this
 *  local type says only as much as the gate needs (it never inspects `args`/`ctx`, just forwards
 *  them), instead of fighting `McpServer.registerTool`'s overloaded generic signature. */
type ToolHandler = (...args: unknown[]) => unknown;

/**
 * Wraps every `server.registerTool` call made from here on (except `INDEX_GATE_EXEMPT`) so its
 * handler waits for the index — via `waitForIndex` — before running. One gate where tools are
 * registered, not thirty edits to the tool files themselves: this mutates `server.registerTool`
 * in place, so `registerReadTools`, `registerWriteTools`, etc. (which only ever call
 * `server.registerTool`, unchanged) pick it up automatically for every tool they register below.
 */
function withIndexGate(server: McpServer, tc: ToolContext): void {
  const original = server.registerTool.bind(server) as unknown as (
    name: string,
    config: unknown,
    cb: ToolHandler,
  ) => unknown;
  const gated = (name: string, config: unknown, cb: ToolHandler): unknown => {
    if (INDEX_GATE_EXEMPT.has(name)) {
      return original(name, config, (...args: unknown[]) => tracked(tc, () => cb(...args)));
    }
    const handler: ToolHandler = (...args: unknown[]) =>
      tracked(tc, async () => (await waitForIndex(tc)) ?? cb(...args));
    return original(name, config, handler);
  };
  server.registerTool = gated as unknown as McpServer['registerTool'];
}

export function registerVaultTools(server: McpServer, tc: ToolContext): void {
  withIndexGate(server, tc);
  registerReadTools(server, tc);
  registerWriteTools(server, tc);
  registerSearchTools(server, tc);
  registerManageTools(server, tc);
  registerCanvasTools(server, tc);
  registerDailyTools(server, tc);
  registerAnalyticsTools(server, tc);
  registerGraphTools(server, tc);
  registerQueryTools(server, tc);
  registerTxTools(server, tc);
  registerTemplateTools(server, tc);
}
