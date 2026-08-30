import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { baseName, normalizeVaultPath, parentDir } from '../storage/path-policy.ts';
import { VaultError } from '../storage/types.ts';
import { uniquePrefix as buildUniquePrefix, renderTemplate } from '../vault/templates.ts';
import { APPEND_ONLY } from './annotations.ts';
import { locked, type ToolContext, touch } from './register.ts';
import { guarded, okJson } from './results.ts';

const PathArg = z.string().describe('Vault-relative path, e.g. "00-inbox/idea.md".');

/** The target's basename without a trailing ".md" (case-insensitive), Obsidian's own default for
 *  a freshly created note's {{title}}. Non-".md" targets (e.g. a template producing a ".base" or
 *  ".canvas" file) keep the full basename. */
function defaultTitle(targetPath: string): string {
  const base = baseName(targetPath);
  return base.toLowerCase().endsWith('.md') ? base.slice(0, -3) : base;
}

export function registerTemplateTools(server: McpServer, tc: ToolContext): void {
  const { adapter, settings, now } = tc.runtime;

  server.registerTool(
    'vault_create_from_template',
    {
      title: 'Create note from template',
      description:
        "Create a note by rendering an existing template note's Obsidian core-Templates " +
        'placeholders: {{title}}, {{date}}, {{date:FMT}}, {{time}}, {{time:FMT}} (Moment tokens, ' +
        'vault timezone), and {{anyVar}} from vars. Placeholders with no value (unknown vars) are ' +
        'left verbatim and listed in the result. Fails with ALREADY_EXISTS if targetPath already ' +
        'exists — this never overwrites. With uniquePrefix=true, "YYYYMMDDHHmm " (vault timezone) ' +
        "is prepended to the target's basename, like the Unique Note core plugin.",
      inputSchema: z.object({
        templatePath: PathArg.describe('Vault-relative path of the template note to render.'),
        targetPath: PathArg.describe('Vault-relative path of the note to create.'),
        vars: z
          .record(z.string(), z.string())
          .optional()
          .describe('Values for {{name}} placeholders the template uses beyond title/date/time.'),
        uniquePrefix: z
          .boolean()
          .optional()
          .describe('Prepend "YYYYMMDDHHmm " (vault timezone) to the target basename.'),
        title: z
          .string()
          .optional()
          .describe('{{title}} value. Defaults to the target basename without ".md".'),
      }),
      outputSchema: z.object({
        path: z.string(),
        hash: z.string(),
        unresolved: z.array(z.string()),
      }),
      // Creates a new file and never touches an existing one (ALREADY_EXISTS guards that), so
      // this is closer to vault_daily_note_append (also creates-from-template) than to the
      // overwrite-capable vault_write: not destructive, not idempotent (running it twice with
      // the same arguments succeeds once and fails ALREADY_EXISTS the second time).
      annotations: APPEND_ONLY,
    },
    ({ templatePath, targetPath, vars, uniquePrefix, title }) =>
      guarded(tc.log, async () => {
        const templateP = normalizeVaultPath(templatePath);
        const requestedTarget = normalizeVaultPath(targetPath);
        const resolvedTitle = title ?? defaultTitle(requestedTarget);
        let targetP = requestedTarget;
        if (uniquePrefix) {
          const dir = parentDir(requestedTarget);
          const base = baseName(requestedTarget);
          const prefixed = `${buildUniquePrefix(now(), settings.dailyNotes.timezone)}${base}`;
          targetP = normalizeVaultPath(dir === '' ? prefixed : `${dir}/${prefixed}`);
        }
        return locked(tc, [templateP, targetP], async () => {
          if ((await adapter.hashOf(targetP)) !== null) {
            throw new VaultError('ALREADY_EXISTS', `${targetP} already exists.`);
          }
          const templateNote = await adapter.read(templateP);
          const { text, unresolved } = renderTemplate(templateNote.content, {
            title: resolvedTitle,
            now: now(),
            timezone: settings.dailyNotes.timezone,
            vars,
          });
          await adapter.write(targetP, text);
          await touch(tc, targetP);
          const hash = (await adapter.read(targetP)).hash;
          return okJson(
            { path: targetP, hash, unresolved },
            `Created ${targetP} from ${templateP}.`,
          );
        });
      }),
  );
}
