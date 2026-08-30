import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';

/**
 * What every connecting client learns about this server before its first tool
 * call — the MCP `instructions` field of the initialize result. Kept short: it
 * is sent on every connection and competes with the conversation for context.
 */
export const DEFAULT_INSTRUCTIONS = `brainstem-mcp gives you read/write access to the owner's personal Obsidian vault (markdown notes, canvases, bases, attachments).
- Paths are vault-relative, forward slashes, with extension (\`projects/alpha.md\`).
- Find, don't scan: vault_search / vault_search_frontmatter, vault_query for structured filters over frontmatter, vault_recent for what changed lately, vault_tags for tag lookups, vault_links for a note's backlinks and outgoing links.
- Understand before you edit: vault_outline for headings/tags/word count, vault_read with a \`section\` for just one heading. vault_batch_read reads several notes at once.
- Edit surgically: vault_edit (exact text replacement) or vault_append (optionally at a \`heading\`) instead of rewriting with vault_write; vault_frontmatter_update and vault_batch_frontmatter_update change metadata only.
- Concurrency: reads return a \`hash\`. Pass it back as \`expectedHash\` on the write; a stale hash fails with CONFLICT (and the current hash) instead of overwriting silently, so re-read and retry. Changing several notes together: vault_transaction applies every op, or none.
- Notes start with YAML frontmatter; keep existing keys. Link with [[wikilinks]]. vault_move rewrites every link that points at the moved note, by default.
- \`.base\` and \`.canvas\` files are plain YAML/JSON; edit \`.canvas\` structurally with vault_canvas_read, vault_canvas_add_node, vault_canvas_update_node, vault_canvas_remove; edit \`.base\` as text.
- vault_create_from_template renders {{title}}/{{date}}/{{time}}/{{var}} placeholders into a new note.
- Daily notes: vault_daily_note_read and vault_daily_note_append (vault_daily_note_path for the file name).
- Deleting needs confirm=true and only moves the note to .trash/ — say so when you do it.
- _brainstem/ is the server's own folder and is invisible to every tool; never try to write there.
- Owner instructions below, if any, describe how this particular vault is organised — follow them over general habits.`;

/** Heading under which the owner's own text is appended to the defaults. */
export const OWNER_INSTRUCTIONS_HEADING = '## Owner instructions';

/** The owner's file, inside the reserved `_brainstem/` state dir. */
export const INSTRUCTIONS_FILE = 'instructions.md';

/**
 * Upper bound on the owner text that is forwarded. A vault-conventions note
 * longer than this is documentation, not instructions, and would crowd the
 * model's context on every connection.
 */
export const MAX_OWNER_INSTRUCTIONS_CHARS = 8_000;

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * The note seeded at first boot. Everything explanatory lives in frontmatter
 * and HTML comments, both of which `stripPrivateParts` removes — so until the
 * owner writes something, Claude receives the defaults alone.
 */
export function renderInstructionsTemplate(): string {
  return `---
type: brainstem-instructions
description: How Claude should work in this vault. Sent to Claude on every connection.
---
<!--
Write, in plain markdown, how you want Claude to work in this vault:
where things live, which frontmatter keys you use, naming rules,
what it must never touch. Keep it short — this text is sent on every
connection. HTML comments like this one and the frontmatter above are
NOT sent. Changes apply to the next connection; no restart needed.

Example:
- Projects live in 10-projects/<slug>/README.md; people in 20-people/.
- Every new note gets frontmatter: type, status (draft|active|done), created.
- Never edit anything under 90-archive/.
-->
`;
}

/** Owner text minus frontmatter and HTML comments, trimmed. */
export function stripPrivateParts(text: string): string {
  return text.replace(FRONTMATTER_RE, '').replace(HTML_COMMENT_RE, '').trim();
}

export interface InstructionsProvider {
  /** Defaults, plus the owner's text when the file has any. Never throws. */
  get(): Promise<string>;
  /** How many times the file body was actually read — for tests. */
  readonly reads: number;
}

export interface InstructionsProviderOptions {
  stat?: (p: string) => Promise<Pick<Stats, 'mtimeMs' | 'size'>>;
  readFile?: (p: string) => Promise<string>;
}

/**
 * Reads `<stateDir>/instructions.md` with an mtime+size cache. A server is
 * built per request, so `get()` runs often; one `stat` per call is the price
 * of the owner's edits in Obsidian applying without a restart.
 */
export function createInstructionsProvider(
  stateDir: string,
  opts: InstructionsProviderOptions = {},
): InstructionsProvider {
  const file = path.join(stateDir, INSTRUCTIONS_FILE);
  const stat = opts.stat ?? ((p: string) => fs.stat(p));
  const readFile = opts.readFile ?? ((p: string) => fs.readFile(p, 'utf8'));
  let cachedKey: string | null = null;
  let cachedText = DEFAULT_INSTRUCTIONS;
  let reads = 0;

  return {
    get reads() {
      return reads;
    },
    async get() {
      let key: string;
      try {
        const s = await stat(file);
        key = `${s.mtimeMs}:${s.size}`;
      } catch {
        // Missing (the usual case) or unreadable: defaults only, and forget any
        // earlier owner text so a deleted file also takes effect.
        cachedKey = null;
        cachedText = DEFAULT_INSTRUCTIONS;
        return cachedText;
      }
      if (key === cachedKey) return cachedText;
      let owner: string;
      try {
        reads++;
        owner = stripPrivateParts(await readFile(file));
      } catch {
        return cachedText;
      }
      cachedKey = key;
      cachedText = compose(owner);
      return cachedText;
    },
  };
}

function compose(owner: string): string {
  if (owner === '') return DEFAULT_INSTRUCTIONS;
  // Code points, not UTF-16 units: a cut inside a surrogate pair would send a lone surrogate.
  const chars = Array.from(owner);
  const body =
    chars.length > MAX_OWNER_INSTRUCTIONS_CHARS
      ? `${chars.slice(0, MAX_OWNER_INSTRUCTIONS_CHARS).join('')}\n\n[owner instructions truncated at ${MAX_OWNER_INSTRUCTIONS_CHARS} characters]`
      : owner;
  return `${DEFAULT_INSTRUCTIONS}\n\n${OWNER_INSTRUCTIONS_HEADING}\n${body}`;
}

/**
 * Seeds the template at first boot so the owner discovers the feature in
 * Obsidian next to `connection.md`. `wx` makes create-if-missing atomic: an
 * existing file — the owner's text — is never touched. Returns whether it wrote.
 */
export async function writeInstructionsTemplateIfMissing(stateDir: string): Promise<boolean> {
  await fs.mkdir(stateDir, { recursive: true });
  try {
    await fs.writeFile(path.join(stateDir, INSTRUCTIONS_FILE), renderInstructionsTemplate(), {
      flag: 'wx',
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}
