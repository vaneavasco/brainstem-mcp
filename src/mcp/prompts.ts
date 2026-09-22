import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

/**
 * One-click entry points for someone new to Obsidian: Claude Desktop lists these in the
 * conversation's "+" menu under the extension (MCP prompts, `prompts/list` + `prompts/get`).
 * The single registry — `registerVaultPrompts` (below, consumed by `src/mcp/factory.ts`) and
 * `scripts/bundle-manifest.ts` (the Claude Desktop bundle's `manifest.json`) both read from
 * `VAULT_PROMPTS` so the two can never drift apart.
 */
export interface VaultPromptArg {
  name: string;
  description: string;
  required: boolean;
}

export interface VaultPrompt {
  name: string;
  title: string;
  description: string;
  args: VaultPromptArg[];
  /** Prompts that only read the vault are also registered in read-only mode. */
  readOnly: boolean;
  text: (args: Record<string, string | undefined>) => string;
}

function captureText(args: Record<string, string | undefined>): string {
  return (
    "Turn the text below into a note in this vault. Search first (vault_search, vault_query) for notes it relates to; if it clearly belongs inside an existing note, append it there with vault_append instead of creating one. Otherwise pick the folder and a plain-words title from this vault's conventions, add the usual frontmatter, link related notes with [[wikilinks]], and tell me where it went and what you linked.\n\n" +
    `Text:\n${args.text ?? ''}`
  );
}

function dailyNoteText(args: Record<string, string | undefined>): string {
  const base =
    "Open today's daily note with vault_daily_note_read (create it if it does not exist yet) and tell me in two or three lines what is already there. Then add the entry below as a dated line under the right heading, using vault_daily_note_append, and confirm what you wrote. If there is no entry, just show me the day.";
  if (!args.entry) return base;
  return `${base}\n\nEntry:\n${args.entry}`;
}

function weeklyReviewText(args: Record<string, string | undefined>): string {
  const days = args.days ?? '7';
  return `Review the last ${days} days of this vault. Use vault_recent for what changed, read the changed notes by section (vault_outline, then vault_read with sections) for open items and decisions, and vault_analytics_findings for broken links and orphan notes. Give me a short review: what moved, what is open, what needs a decision from me, and what you propose to tidy. Do not change anything in this review; ask first.`;
}

export const VAULT_PROMPTS: readonly VaultPrompt[] = [
  {
    name: 'get_started',
    title: 'Get started with this vault',
    description:
      'A plain-words tour of what is in the vault and what Claude can do here; proposes a simple layout if it is empty.',
    args: [],
    readOnly: true,
    text: () =>
      'Call brainstem_guide, then look around: vault_list on the root and vault_analytics_summary. Tell me in plain words, without Obsidian jargon, what is in this vault and what you can do for me here: finding and summarising notes, capturing new ones, keeping a daily journal, reviewing what changed, keeping things linked and tidy. If the vault is empty or nearly so, propose a simple layout and ask me two or three questions about what I want to keep here before creating anything.',
  },
  {
    name: 'capture',
    title: 'Capture a note',
    description:
      'Turns a thought, a paste or a meeting into a well-placed note, linked to what it relates to.',
    args: [
      {
        name: 'text',
        description:
          'What to capture: a thought, a pasted email, meeting notes, a link with a comment',
        required: true,
      },
    ],
    readOnly: false,
    text: captureText,
  },
  {
    name: 'daily_note',
    title: "Today's daily note",
    description: "Opens today's journal, sums up what is there and adds what you tell it.",
    args: [
      {
        name: 'entry',
        description: 'What to add today; leave empty to just read',
        required: false,
      },
    ],
    readOnly: false,
    text: dailyNoteText,
  },
  {
    name: 'weekly_review',
    title: 'Weekly review',
    description:
      'What changed in the last week, what is open, what needs a decision, what to tidy.',
    args: [
      {
        name: 'days',
        description: 'How many days back; default 7',
        required: false,
      },
    ],
    readOnly: true,
    text: weeklyReviewText,
  },
  {
    name: 'tidy_up',
    title: 'Tidy the vault',
    description:
      'Finds broken links, notes without frontmatter or tags, near-duplicate tags and orphans; fixes what you confirm.',
    args: [],
    readOnly: false,
    text: () =>
      "Run vault_analytics_findings and vault_tags. List what you found in plain words: broken links, notes without frontmatter or tags, tags that mean the same thing spelled differently, orphan notes that should link somewhere. Propose the fixes as a short numbered list and wait for my answer. Apply only what I confirm; when several notes change together, use one vault_transaction so it is all or nothing, and pass each note's hash as expectedHash.",
  },
];

/** Registers `VAULT_PROMPTS` on a freshly built server; in read-only mode, only the prompts
 *  that only read the vault (`readOnly: true`) are offered — the same split `readOnlyHint`
 *  makes for tools (`src/tools/register.ts`). */
export function registerVaultPrompts(server: McpServer, opts: { readOnly: boolean }): void {
  for (const prompt of VAULT_PROMPTS) {
    if (opts.readOnly && !prompt.readOnly) continue;
    // Typed as ZodString | ZodOptional<ZodString>, not the broader ZodTypeAny — the parsed args
    // TypeScript infers for the callback below must stay `string | undefined` per field (what
    // `VaultPrompt['text']` takes), not `unknown`.
    const shape: Record<string, z.ZodString | z.ZodOptional<z.ZodString>> = {};
    for (const arg of prompt.args) {
      const field = z.string().describe(arg.description);
      shape[arg.name] = arg.required ? field : field.optional();
    }
    const meta = { title: prompt.title, description: prompt.description };
    // A client that has nothing to pass (get_started, tidy_up: no args at all; daily_note,
    // weekly_review: their one argument is optional) is allowed to omit `arguments` entirely —
    // the whole object must then itself be optional, or the SDK's own validation rejects the
    // `undefined` it receives before the callback ever sees it. A prompt with a required
    // argument (capture) keeps the object itself required. Two separate calls (rather than one
    // shared, pre-typed callback variable) so the overload picks up each concrete Zod type and
    // infers the callback's argument type from it, the way the SDK's own example does.
    if (prompt.args.some((arg) => arg.required)) {
      server.registerPrompt(prompt.name, { ...meta, argsSchema: z.object(shape) }, (args) => ({
        messages: [
          { role: 'user' as const, content: { type: 'text' as const, text: prompt.text(args) } },
        ],
      }));
    } else {
      server.registerPrompt(
        prompt.name,
        { ...meta, argsSchema: z.object(shape).optional() },
        (args) => ({
          messages: [
            {
              role: 'user' as const,
              content: { type: 'text' as const, text: prompt.text(args ?? {}) },
            },
          ],
        }),
      );
    }
  }
}
