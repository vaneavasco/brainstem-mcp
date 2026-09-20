import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  CLIENT_SAFE_RESULT_CHARS,
  MAX_GRAPH_ITEMS,
  MAX_UNLINKED_MENTIONS,
} from '../storage/limits.ts';
import { normalizeVaultPath } from '../storage/path-policy.ts';
import { VaultError } from '../storage/types.ts';
import { fitListsWithinBudget, fitWithinBudget, roomBeside } from '../vault/budget.ts';
import type { Backlink, ResolvedLink } from '../vault/graph.ts';
import { contextByLine, findUnlinkedMentions } from '../vault/mentions.ts';
import type { Heading } from '../vault/note-parse.ts';
import { READ_ONLY } from './annotations.ts';
import { DetailedPathArg } from './args.ts';
import type { ToolContext } from './register.ts';
import { guarded, okJson } from './results.ts';

const LinkInclude = z.enum(['outgoing', 'backlinks', 'embeds', 'unlinkedMentions']);
type LinkIncludeT = z.infer<typeof LinkInclude>;
const DEFAULT_INCLUDE: LinkIncludeT[] = ['outgoing', 'backlinks', 'embeds'];

const OutgoingLink = z.looseObject({
  target: z.string(),
  kind: z.enum(['wiki', 'md']),
  line: z.number(),
  embed: z.boolean(),
  resolvedPath: z.string().nullable(),
  status: z.enum(['resolved', 'ambiguous', 'unresolved']),
  candidates: z.array(z.string()).optional(),
  anchorFound: z.boolean().optional(),
});

const ContextHit = z.looseObject({ path: z.string(), line: z.number(), context: z.string() });

const TagInfoSchema = z.looseObject({
  tag: z.string(),
  count: z.number(),
  nested: z.boolean(),
  frontmatter: z.number(),
  inline: z.number(),
});

interface HeadingNode {
  level: number;
  text: string;
  line: number;
  children: HeadingNode[];
}

const HeadingNodeSchema: z.ZodType<HeadingNode> = z.lazy(() =>
  z.looseObject({
    level: z.number(),
    text: z.string(),
    line: z.number(),
    children: z.array(HeadingNodeSchema),
  }),
);

function toOutgoingLink(rl: ResolvedLink): z.infer<typeof OutgoingLink> {
  const { link, resolution } = rl;
  const base = {
    target: link.target,
    kind: link.kind,
    line: link.line,
    embed: link.embed,
    resolvedPath: resolution.status === 'resolved' ? resolution.path : null,
    status: resolution.status,
  };
  if (resolution.status === 'ambiguous') return { ...base, candidates: resolution.candidates };
  if (resolution.status === 'resolved' && resolution.anchorFound !== undefined) {
    return { ...base, anchorFound: resolution.anchorFound };
  }
  return base;
}

function toContextHit(
  b: Backlink,
  contextFor: Map<string, string>,
): { path: string; line: number; context: string } {
  return {
    path: b.source,
    line: b.link.line,
    context: contextFor.get(`${b.source}:${b.link.line}`) ?? '',
  };
}

function buildHeadingTree(headings: Heading[]): HeadingNode[] {
  const root: HeadingNode[] = [];
  const stack: HeadingNode[] = [];
  for (const h of headings) {
    const node: HeadingNode = { level: h.level, text: h.text, line: h.line, children: [] };
    while (stack.length > 0 && (stack.at(-1) as HeadingNode).level >= h.level) stack.pop();
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else root.push(node);
    stack.push(node);
  }
  return root;
}

const LINKS_CUT_HINT =
  'Lists were cut to fit ("truncated" says which; "total" has the full counts): ask for one kind with "include", one folder at a time with "filter.pathPrefix", or only the counts with countOnly.';

export function registerGraphTools(server: McpServer, tc: ToolContext): void {
  const { adapter, index, graph } = tc.runtime;

  server.registerTool(
    'vault_links',
    {
      title: 'Note links',
      description: `Outgoing links, backlinks and embeds for one note, from the in-memory index (no ripgrep pass). Add "unlinkedMentions" to include (off by default) for plain-text mentions of the note's basename or aliases in notes that don't already link to it. "filter.pathPrefix" (vault-relative, case-sensitive) keeps only backlinks/embeds/unlinkedMentions whose source starts with it, applied before the caps (check one folder at a time); "total" reports the filtered, pre-cap counts. Caps: ${MAX_GRAPH_ITEMS} outgoing/backlinks/embeds, ${MAX_UNLINKED_MENTIONS} unlinked mentions. countOnly:true returns just total, no lists.`,
      inputSchema: z.strictObject({
        path: DetailedPathArg,
        include: z.array(LinkInclude).optional(),
        filter: z
          .strictObject({
            pathPrefix: z
              .string()
              .optional()
              .describe(
                'Vault-relative, case-sensitive prefix (e.g. "projects/") applied to the source path of backlinks, embeds and unlinked mentions before the caps.',
              ),
          })
          .optional(),
        countOnly: z
          .boolean()
          .optional()
          .describe('Return just "total" (the per-kind counts) with every link list empty.'),
      }),
      outputSchema: z.looseObject({
        path: z.string(),
        outgoing: z.array(OutgoingLink),
        backlinks: z.array(ContextHit),
        embeds: z.array(ContextHit),
        unlinkedMentions: z.array(ContextHit),
        truncated: z.looseObject({
          outgoing: z.boolean(),
          backlinks: z.boolean(),
          embeds: z.boolean(),
          unlinkedMentions: z.boolean(),
        }),
        hint: z.string().optional(),
        total: z.looseObject({
          outgoing: z.number(),
          backlinks: z.number(),
          embeds: z.number(),
          unlinkedMentions: z.number(),
        }),
      }),
      annotations: READ_ONLY,
    },
    ({ path, include, filter, countOnly }) =>
      guarded(tc.log, async () => {
        const p = normalizeVaultPath(path);
        const entry = index.get(p);
        if (!entry) throw new VaultError('NOT_FOUND', `${p} does not exist.`);
        const want = new Set<LinkIncludeT>(include ?? DEFAULT_INCLUDE);
        const pathPrefix = filter?.pathPrefix;
        const bySource = (b: Backlink): boolean =>
          pathPrefix === undefined || b.source.startsWith(pathPrefix);

        const outgoingAll = want.has('outgoing') ? graph.outgoing(p).map(toOutgoingLink) : [];
        const outgoingTruncated = outgoingAll.length > MAX_GRAPH_ITEMS;
        const outgoing = countOnly
          ? []
          : outgoingTruncated
            ? outgoingAll.slice(0, MAX_GRAPH_ITEMS)
            : outgoingAll;

        const backlinksAll = want.has('backlinks') ? graph.backlinks(p).filter(bySource) : [];
        const backlinksTruncated = backlinksAll.length > MAX_GRAPH_ITEMS;
        const backlinksCapped = backlinksTruncated
          ? backlinksAll.slice(0, MAX_GRAPH_ITEMS)
          : backlinksAll;

        const embedsAll = want.has('embeds') ? graph.embedsOf(p).filter(bySource) : [];
        const embedsTruncated = embedsAll.length > MAX_GRAPH_ITEMS;
        const embedsCapped = embedsTruncated ? embedsAll.slice(0, MAX_GRAPH_ITEMS) : embedsAll;

        // countOnly never needs the source-line context text — skip the disk reads for it.
        const contextFor = countOnly
          ? new Map<string, string>()
          : await contextByLine(adapter, [
              ...backlinksCapped.map((b) => ({ source: b.source, line: b.link.line })),
              ...embedsCapped.map((b) => ({ source: b.source, line: b.link.line })),
            ]);

        const backlinks = countOnly ? [] : backlinksCapped.map((b) => toContextHit(b, contextFor));
        const embeds = countOnly ? [] : embedsCapped.map((b) => toContextHit(b, contextFor));

        let unlinkedMentions: { path: string; line: number; context: string }[] = [];
        let unlinkedTruncated = false;
        let unlinkedTotal = 0;
        if (want.has('unlinkedMentions')) {
          // Which notes "already link" is unaffected by the filter — only which results are shown.
          const backlinkSources = new Set(graph.backlinks(p).map((b) => b.source));
          const found = await findUnlinkedMentions(adapter, p, entry.frontmatter, backlinkSources, {
            pathPrefix,
          });
          unlinkedMentions = countOnly ? [] : found.mentions;
          unlinkedTruncated = found.truncated;
          unlinkedTotal = found.total;
        }

        // The caps above bound the counts; a hub's 500 links with their context still outgrow
        // what a client accepts, so the four lists share what is left once the rest of the result
        // (path, flags, totals, hint) is paid for.
        const total = {
          outgoing: outgoingAll.length,
          backlinks: backlinksAll.length,
          embeds: embedsAll.length,
          unlinkedMentions: unlinkedTotal,
        };
        const allTrue = { outgoing: true, backlinks: true, embeds: true, unlinkedMentions: true };
        const fitted = fitListsWithinBudget<unknown>(
          [outgoing, backlinks, embeds, unlinkedMentions],
          roomBeside(
            {
              path: p,
              outgoing: [],
              backlinks: [],
              embeds: [],
              unlinkedMentions: [],
              truncated: allTrue,
              total,
              hint: LINKS_CUT_HINT,
            },
            CLIENT_SAFE_RESULT_CHARS,
          ),
        );
        return okJson({
          path: p,
          outgoing: fitted.kept[0],
          backlinks: fitted.kept[1],
          embeds: fitted.kept[2],
          unlinkedMentions: fitted.kept[3],
          truncated: {
            outgoing: outgoingTruncated || fitted.cut[0] === true,
            backlinks: backlinksTruncated || fitted.cut[1] === true,
            embeds: embedsTruncated || fitted.cut[2] === true,
            unlinkedMentions: unlinkedTruncated || fitted.cut[3] === true,
          },
          ...(fitted.cut.some(Boolean) ? { hint: LINKS_CUT_HINT } : {}),
          total,
        });
      }),
  );

  server.registerTool(
    'vault_tags',
    {
      title: 'Tags',
      description: `List every tag in the vault with note counts, or the notes carrying one tag (with includeNested, default true, rolling up nested children like "project/alpha" into "project"). Filter the tag list with prefix (case-insensitive). Caps notes at ${MAX_GRAPH_ITEMS} for a given tag. Long lists are cut to what a client accepts (truncated + hint).`,
      inputSchema: z.strictObject({
        tag: z.string().optional(),
        prefix: z.string().optional(),
        includeNested: z.boolean().optional(),
      }),
      outputSchema: z.looseObject({
        tags: z.array(TagInfoSchema).optional(),
        tag: z.string().optional(),
        notes: z
          .array(
            z.looseObject({
              path: z.string(),
              sources: z.array(z.enum(['frontmatter', 'inline'])),
            }),
          )
          .optional(),
        total: z.number(),
        truncated: z.boolean().optional(),
        hint: z.string().optional(),
      }),
      annotations: READ_ONLY,
    },
    ({ tag, prefix, includeNested }) =>
      guarded(tc.log, async () => {
        if (tag === undefined) {
          const all = graph.tags();
          const filtered =
            prefix !== undefined
              ? all.filter((t) => t.tag.toLowerCase().startsWith(prefix.toLowerCase()))
              : all;
          const hintFor = (shown: number) =>
            `${shown} of ${filtered.length} tags shown: narrow with "prefix", or look one tag up with "tag".`;
          const { kept, cut } = fitWithinBudget(
            filtered,
            roomBeside(
              { tags: [], total: filtered.length, truncated: true, hint: hintFor(filtered.length) },
              CLIENT_SAFE_RESULT_CHARS,
            ),
          );
          return okJson({
            tags: kept,
            total: filtered.length,
            ...(cut ? { truncated: true, hint: hintFor(kept.length) } : {}),
          });
        }
        const all = graph.notesWithTag(tag, includeNested ?? true);
        const hintFor = (shown: number) =>
          `${shown} of ${all.length} notes shown: list them with vault_query { tags: { any: [tag] } } and a pathPrefix, or count them with countOnly.`;
        const fittedNotes = fitWithinBudget(
          all.slice(0, MAX_GRAPH_ITEMS),
          roomBeside(
            { tag, notes: [], total: all.length, truncated: true, hint: hintFor(all.length) },
            CLIENT_SAFE_RESULT_CHARS,
          ),
        );
        const truncated = fittedNotes.cut || all.length > MAX_GRAPH_ITEMS;
        return okJson({
          tag,
          notes: fittedNotes.kept,
          total: all.length,
          truncated,
          ...(truncated ? { hint: hintFor(fittedNotes.kept.length) } : {}),
        });
      }),
  );

  server.registerTool(
    'vault_outline',
    {
      title: 'Note outline',
      description:
        'Structural summary of one note from the in-memory index: frontmatter keys, tags, a heading tree, block IDs, word count, and link/backlink counts. Never reads the file from disk.',
      inputSchema: z.strictObject({ path: DetailedPathArg }),
      outputSchema: z.looseObject({
        path: z.string(),
        hash: z.string(),
        modifiedAt: z.string(),
        size: z.number(),
        wordCount: z.number(),
        frontmatterKeys: z.array(z.string()),
        tags: z.array(z.string()),
        headings: z.array(HeadingNodeSchema),
        blockIds: z.array(z.looseObject({ id: z.string(), line: z.number() })),
        linkCount: z.number(),
        backlinkCount: z.number(),
      }),
      annotations: READ_ONLY,
    },
    ({ path }) =>
      guarded(tc.log, async () => {
        const p = normalizeVaultPath(path);
        const entry = index.get(p);
        if (!entry) throw new VaultError('NOT_FOUND', `${p} does not exist.`);
        return okJson({
          path: p,
          hash: entry.hash,
          modifiedAt: entry.modifiedAt,
          size: entry.size,
          wordCount: entry.wordCount,
          frontmatterKeys: Object.keys(entry.frontmatter),
          tags: entry.tags,
          headings: buildHeadingTree(entry.headings),
          blockIds: entry.blockIds,
          linkCount: entry.links.length,
          backlinkCount: graph.backlinks(p).length,
        });
      }),
  );
}
