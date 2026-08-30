import path from 'node:path';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import { LocalFSAdapter } from '../storage/local-fs.ts';
import { RESERVED_DIR } from '../storage/path-policy.ts';
import type { StorageAdapter, Unsubscribe } from '../storage/types.ts';
import { WriteGate } from '../storage/write-gate.ts';
import type { AnalyticsReport } from './analytics.ts';
import { type DailyNoteSettings, DEFAULT_DAILY_NOTE_SETTINGS } from './daily-notes.ts';
import { FrontmatterIndex } from './frontmatter-index.ts';
import { VaultGraph } from './graph.ts';

export interface VaultSettings {
  dailyNotes: DailyNoteSettings;
  requiredFrontmatter: string[];
}

export const DEFAULT_VAULT_SETTINGS: VaultSettings = {
  dailyNotes: DEFAULT_DAILY_NOTE_SETTINGS,
  requiredFrontmatter: [],
};

export interface VaultRuntime {
  adapter: StorageAdapter;
  index: FrontmatterIndex;
  graph: VaultGraph;
  settings: VaultSettings;
  now: () => Date;
  caches: { analytics?: { at: number; report: AnalyticsReport } };
  /** Keyed write lock every mutating tool call runs inside (see src/storage/write-gate.ts). */
  gate: WriteGate;
  /**
   * Absolute filesystem paths the vault tools need outside the adapter's reach: `vaultRoot` for
   * raw byte copies (transaction pre-images), `stateDir` for the reserved `_brainstem/` folder
   * the adapter deliberately refuses to touch.
   */
  paths: { vaultRoot: string; stateDir: string };
  close(): Promise<void>;
}

export type RuntimeResolver = (ctx: McpRequestContext) => Promise<VaultRuntime>;

export interface LocalRuntimeOptions {
  vaultPath: string;
  settings?: { dailyNotes?: Partial<DailyNoteSettings>; requiredFrontmatter?: string[] };
  ripgrepPath?: string | null;
  watchPollMs?: number | null;
  /** Defaults to `<vaultRoot>/_brainstem`. */
  stateDir?: string;
  now?: () => Date;
}

export function mergeSettings(overrides: LocalRuntimeOptions['settings']): VaultSettings {
  return {
    dailyNotes: { ...DEFAULT_DAILY_NOTE_SETTINGS, ...(overrides?.dailyNotes ?? {}) },
    requiredFrontmatter: overrides?.requiredFrontmatter ?? [],
  };
}

export async function createLocalRuntime(opts: LocalRuntimeOptions): Promise<VaultRuntime> {
  const adapter = await LocalFSAdapter.create(opts.vaultPath, {
    ripgrepPath: opts.ripgrepPath,
    watchPollMs: opts.watchPollMs ?? null,
  });
  const index = await FrontmatterIndex.build(adapter);
  const detach: Unsubscribe = index.attach(adapter);
  // adapter.root is the realpath'd vault root, so pre-image copies and the adapter always agree
  // on where a vault-relative path actually lives.
  const stateDir = opts.stateDir ?? path.join(adapter.root, RESERVED_DIR);
  return {
    adapter,
    index,
    graph: new VaultGraph(index),
    settings: mergeSettings(opts.settings),
    now: opts.now ?? (() => new Date()),
    caches: {},
    gate: new WriteGate(),
    paths: { vaultRoot: adapter.root, stateDir },
    async close() {
      detach();
    },
  };
}
