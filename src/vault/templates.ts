import { DEFAULT_TIME_FORMAT, formatInVaultZone } from './daily-notes.ts';

export interface TemplateContext {
  title: string;
  now: Date;
  timezone: string;
  vars?: Record<string, string>;
}

export interface RenderedTemplate {
  text: string;
  /** Placeholder names (not the `{{…}}` text) that were not `title`/`date`/`time` and had no
   *  matching key in `vars`. Left verbatim in `text`. Deduplicated by name, in first-seen order —
   *  a placeholder repeated in the template (e.g. two `{{author}}`) is reported once. Also
   *  includes the (trimmed, before-':') text of `{{…}}` blocks whose name the grammar cannot
   *  parse (space- or digit-led), likewise left verbatim; grammar-parsed names come first. */
  unresolved: string[];
}

/** Obsidian core Templates default when `{{date}}` is used bare (no `:FMT`). */
const DEFAULT_DATE_FORMAT = 'yyyy-MM-dd';

// Matches `{{name}}` or `{{name:FMT}}` the way Obsidian's core Templates plugin does. `name`
// allows letters, digits, '_', '-' and '.' (covers both simple vars like `author` and
// dotted/hyphenated ones like `project-id` or `client.name`) so an unresolved custom var is
// reported instead of silently ignored. FMT may contain spaces (e.g. "MMMM Do, YYYY") — only the
// literal '}' ends it — and surrounding whitespace right after the colon/name is trimmed.
const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*(?::\s*([^}]*?)\s*)?\}\}/g;

// Anchored single-placeholder version of PLACEHOLDER, for re-testing one extracted block.
const PLACEHOLDER_GRAMMAR = /^\{\{\s*([A-Za-z_][\w.-]*)\s*(?::\s*([^}]*?)\s*)?\}\}$/;
// Any {{...}} block at all, grammar-valid or not, for the unresolved sweep in renderTemplate.
const ANY_PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/**
 * Renders Obsidian core-Templates-style placeholders against a fixed `now`/`timezone` (the vault
 * clock, not the machine's): `{{title}}`, `{{date}}`/`{{date:FMT}}`, `{{time}}`/`{{time:FMT}}`
 * (FMT is Moment tokens, converted the same way the daily-notes renderer does), and `{{anyVar}}`
 * resolved from `vars`. A placeholder that isn't one of the three built-ins and has no matching
 * key in `vars` is left verbatim in the output and its name is collected into `unresolved` —
 * reported, not fatal (the caller decides what to do with a template that expects a var that
 * wasn't supplied).
 */
export function renderTemplate(template: string, ctx: TemplateContext): RenderedTemplate {
  const unresolvedSeen = new Set<string>();
  const text = template.replace(PLACEHOLDER, (whole, name: string, fmt: string | undefined) => {
    if (name === 'title') return ctx.title;
    if (name === 'date') {
      return formatInVaultZone(
        ctx.now,
        fmt && fmt !== '' ? fmt : DEFAULT_DATE_FORMAT,
        ctx.timezone,
      );
    }
    if (name === 'time') {
      return formatInVaultZone(
        ctx.now,
        fmt && fmt !== '' ? fmt : DEFAULT_TIME_FORMAT,
        ctx.timezone,
      );
    }
    if (ctx.vars && Object.hasOwn(ctx.vars, name)) return ctx.vars[name] as string;
    unresolvedSeen.add(name);
    return whole;
  });
  // {{…}} blocks the grammar cannot even parse (space- or digit-led names, e.g. "{{my var}}" or
  // "{{2nd}}") are left verbatim like any unknown var — so they belong in `unresolved` too,
  // instead of silently passing through. Grammar-parsed names were handled by the replace above.
  for (const [, inner] of template.matchAll(ANY_PLACEHOLDER)) {
    const raw = (inner ?? '').trim();
    if (raw === '' || PLACEHOLDER_GRAMMAR.test(`{{${raw}}}`)) continue;
    const name = (raw.split(':')[0] ?? '').trim();
    if (name !== '') unresolvedSeen.add(name);
  }
  return { text, unresolved: [...unresolvedSeen] };
}

/**
 * `YYYYMMDDHHmm ` (trailing space) formatted in the vault timezone, matching the Unique-note core
 * plugin's filename prefix. `YYYYMMDDHHmm` happens to translate token-for-token to the date-fns
 * equivalents `yyyy`/`MM`/`dd`/`HH`/`mm` through the same Moment-token conversion
 * `formatInVaultZone` already applies, so no separate format table is needed here.
 */
export function uniquePrefix(now: Date, timezone: string): string {
  return `${formatInVaultZone(now, 'YYYYMMDDHHmm', timezone)} `;
}
