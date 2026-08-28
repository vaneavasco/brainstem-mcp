import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { VaultError } from '../storage/types.ts';
import {
  formatInVaultZone,
  parseDateArg,
  renderDailyTemplate,
  resolveDailyNotePath,
} from '../vault/daily-notes.ts';
import { APPEND_ONLY, READ_ONLY } from './annotations.ts';
import { type ToolContext, touch } from './register.ts';
import { clampText, guarded, okJson } from './results.ts';

const DateArg = z
  .string()
  .optional()
  .describe('Calendar day as YYYY-MM-DD in the vault timezone. Defaults to today.');

export function registerDailyTools(server: McpServer, tc: ToolContext): void {
  const { adapter, settings, now } = tc.runtime;
  const daily = settings.dailyNotes;

  function resolve(dateArg: string | undefined): { path: string; date: string; when: Date } {
    const when = parseDateArg(dateArg, now(), daily.timezone);
    return {
      path: resolveDailyNotePath(daily, when),
      date: formatInVaultZone(when, 'yyyy-MM-dd', daily.timezone),
      when,
    };
  }

  server.registerTool(
    'vault_daily_note_path',
    {
      title: 'Daily note path',
      description:
        'Resolve the path of the daily note for a date (default today, vault timezone) and whether it exists.',
      inputSchema: z.object({ date: DateArg }),
      outputSchema: z.object({ path: z.string(), date: z.string(), exists: z.boolean() }),
      annotations: READ_ONLY,
    },
    ({ date }) =>
      guarded(tc.log, async () => {
        const { path, date: day } = resolve(date);
        let exists = true;
        try {
          await adapter.read(path);
        } catch (error) {
          if (error instanceof VaultError && error.code === 'NOT_FOUND') exists = false;
          else throw error;
        }
        return okJson({ path, date: day, exists });
      }),
  );

  server.registerTool(
    'vault_daily_note_read',
    {
      title: 'Read daily note',
      description:
        'Read the daily note for a date (default today). Fails with NOT_FOUND when it does not exist — it never creates one; use vault_daily_note_append to create.',
      inputSchema: z.object({ date: DateArg }),
      outputSchema: z.object({
        path: z.string(),
        date: z.string(),
        frontmatter: z.record(z.string(), z.unknown()),
        truncated: z.boolean(),
      }),
      annotations: READ_ONLY,
    },
    ({ date }) =>
      guarded(tc.log, async () => {
        const { path, date: day } = resolve(date);
        const note = await adapter.read(path);
        const clamped = clampText(note.content);
        return okJson(
          { path, date: day, frontmatter: note.frontmatter, truncated: clamped.truncated },
          clamped.text,
        );
      }),
  );

  server.registerTool(
    'vault_daily_note_append',
    {
      title: 'Append to daily note',
      description:
        'Append text to the daily note for a date (default today), creating it from the configured template when missing.',
      inputSchema: z.object({ content: z.string().min(1), date: DateArg }),
      outputSchema: z.object({ path: z.string(), created: z.boolean() }),
      annotations: APPEND_ONLY,
    },
    ({ content, date }) =>
      guarded(tc.log, async () => {
        const { path, when } = resolve(date);
        let created = false;
        try {
          await adapter.read(path);
        } catch (error) {
          if (!(error instanceof VaultError && error.code === 'NOT_FOUND')) throw error;
          created = true;
          await adapter.write(
            path,
            daily.template ? renderDailyTemplate(daily.template, when, daily) : '',
          );
        }
        await adapter.append(path, content);
        await touch(tc, path);
        return okJson(
          { path, created },
          `${created ? 'Created and appended to' : 'Appended to'} ${path}.`,
        );
      }),
  );
}
