import type { McpRequestContext } from '@modelcontextprotocol/server';
import { LocalFSAdapter } from '../storage/local-fs.ts';
import type { StorageAdapter, Unsubscribe } from '../storage/types.ts';
import type { AnalyticsReport } from './analytics.ts';
import { type DailyNoteSettings, DEFAULT_DAILY_NOTE_SETTINGS } from './daily-notes.ts';
import { FrontmatterIndex } from './frontmatter-index.ts';

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
  settings: VaultSettings;
  now: () => Date;
  caches: { analytics?: { at: number; report: AnalyticsReport } };
  close(): Promise<void>;
}

export type RuntimeResolver = (ctx: McpRequestContext) => Promise<VaultRuntime>;

export interface LocalRuntimeOptions {
  vaultPath: string;
  settings?: { dailyNotes?: Partial<DailyNoteSettings>; requiredFrontmatter?: string[] };
  ripgrepPath?: string | null;
  now?: () => Date;
}

export function mergeSettings(overrides: LocalRuntimeOptions['settings']): VaultSettings {
  return {
    dailyNotes: { ...DEFAULT_DAILY_NOTE_SETTINGS, ...(overrides?.dailyNotes ?? {}) },
    requiredFrontmatter: overrides?.requiredFrontmatter ?? [],
  };
}

export async function createLocalRuntime(opts: LocalRuntimeOptions): Promise<VaultRuntime> {
  const adapter = await LocalFSAdapter.create(opts.vaultPath, { ripgrepPath: opts.ripgrepPath });
  const index = await FrontmatterIndex.build(adapter);
  const detach: Unsubscribe = index.attach(adapter);
  return {
    adapter,
    index,
    settings: mergeSettings(opts.settings),
    now: opts.now ?? (() => new Date()),
    caches: {},
    async close() {
      detach();
    },
  };
}
