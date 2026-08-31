import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { MAX_GRAPH_ITEMS, MAX_UNLINKED_MENTIONS } from '../storage/limits.ts';
import { normalizeVaultPath } from '../storage/path-policy.ts';
import { VaultError } from '../storage/types.ts';
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

const OutgoingLink = z.object({
  target: z.string(),
  kind: z.enum(['wiki', 'md']),
  line: z.number(),
  embed: z.boolean(),
  resolvedPath: z.string().nullable(),
  status: z.enum(['resolved', 'ambiguous', 'unresolved']),
  candidates: z.array(z.string()).optional(),
  anchorFound: z.boolean().optional(),
});

const ContextHit = z.object({ path: z.string(), line: z.number(), context: z.string() });

const TagInfoSchema = z.object({
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
  z.object({
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

export function registerGraphTools(server: McpServer, tc: ToolContext): void {
  const { adapter, index, graph } = tc.runtime;

  server.registerTool(
    'vault_links',
    {
      title: 'Note links',
      description: `Outgoing links, backlinks and embeds for one note, from the in-memory index (no ripgrep pass). Add "unlinkedMentions" to include (off by default) to also find plain-text mentions of the note's basename or aliases in notes that do not already link to it. Caps: ${MAX_GRAPH_ITEMS} outgoing/backlinks/embeds, ${MAX_UNLINKED_MENTIONS} unlinked mentions.`,
      inputSchema: z.object({ path: DetailedPathArg, include: z.array(LinkInclude).optional() }),
      outputSchema: z.object({
        path: z.string(),
        outgoing: z.array(OutgoingLink),
        backlinks: z.array(ContextHit),
        embeds: z.array(ContextHit),
        unlinkedMentions: z.array(ContextHit),
        truncated: z.object({
          outgoing: z.boolean(),
          backlinks: z.boolean(),
          embeds: z.boolean(),
          unlinkedMentions: z.boolean(),
        }),
      }),
      annotations: READ_ONLY,
    },
    ({ path, include }) =>
      guarded(tc.log, async () => {
        const p = normalizeVaultPath(path);
        const entry = index.get(p);
        if (!entry) throw new VaultError('NOT_FOUND', `${p} does not exist.`);
        const want = new Set<LinkIncludeT>(include ?? DEFAULT_INCLUDE);

        const outgoingAll = want.has('outgoing') ? graph.outgoing(p).map(toOutgoingLink) : [];
        const outgoingTruncated = outgoingAll.length > MAX_GRAPH_ITEMS;
        const outgoing = outgoingTruncated ? outgoingAll.slice(0, MAX_GRAPH_ITEMS) : outgoingAll;

        const backlinksAll = want.has('backlinks') ? graph.backlinks(p) : [];
        const backlinksTruncated = backlinksAll.length > MAX_GRAPH_ITEMS;
        const backlinksCapped = backlinksTruncated
          ? backlinksAll.slice(0, MAX_GRAPH_ITEMS)
          : backlinksAll;

        const embedsAll = want.has('embeds') ? graph.embedsOf(p) : [];
        const embedsTruncated = embedsAll.length > MAX_GRAPH_ITEMS;
        const embedsCapped = embedsTruncated ? embedsAll.slice(0, MAX_GRAPH_ITEMS) : embedsAll;

        const contextFor = await contextByLine(adapter, [
          ...backlinksCapped.map((b) => ({ source: b.source, line: b.link.line })),
          ...embedsCapped.map((b) => ({ source: b.source, line: b.link.line })),
        ]);

        const backlinks = backlinksCapped.map((b) => toContextHit(b, contextFor));
        const embeds = embedsCapped.map((b) => toContextHit(b, contextFor));

        let unlinkedMentions: { path: string; line: number; context: string }[] = [];
        let unlinkedTruncated = false;
        if (want.has('unlinkedMentions')) {
          const backlinkSources = new Set(graph.backlinks(p).map((b) => b.source));
          const found = await findUnlinkedMentions(adapter, p, entry.frontmatter, backlinkSources);
          unlinkedMentions = found.mentions;
          unlinkedTruncated = found.truncated;
        }

        return okJson({
          path: p,
          outgoing,
          backlinks,
          embeds,
          unlinkedMentions,
          truncated: {
            outgoing: outgoingTruncated,
            backlinks: backlinksTruncated,
            embeds: embedsTruncated,
            unlinkedMentions: unlinkedTruncated,
          },
        });
      }),
  );

  server.registerTool(
    'vault_tags',
    {
      title: 'Tags',
      description: `List every tag in the vault with note counts, or the notes carrying one tag (with includeNested, default true, rolling up nested children like "project/alpha" into "project"). Filter the tag list with prefix (case-insensitive). Caps notes at ${MAX_GRAPH_ITEMS} for a given tag.`,
      inputSchema: z.object({
        tag: z.string().optional(),
        prefix: z.string().optional(),
        includeNested: z.boolean().optional(),
      }),
      outputSchema: z.object({
        tags: z.array(TagInfoSchema).optional(),
        tag: z.string().optional(),
        notes: z
          .array(
            z.object({ path: z.string(), sources: z.array(z.enum(['frontmatter', 'inline'])) }),
          )
          .optional(),
        total: z.number(),
        truncated: z.boolean().optional(),
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
          return okJson({ tags: filtered, total: filtered.length });
        }
        const all = graph.notesWithTag(tag, includeNested ?? true);
        const truncated = all.length > MAX_GRAPH_ITEMS;
        const notes = truncated ? all.slice(0, MAX_GRAPH_ITEMS) : all;
        return okJson({ tag, notes, total: all.length, truncated });
      }),
  );

  server.registerTool(
    'vault_outline',
    {
      title: 'Note outline',
      description:
        'Structural summary of one note from the in-memory index: frontmatter keys, tags, a heading tree, block IDs, word count, and link/backlink counts. Never reads the file from disk.',
      inputSchema: z.object({ path: DetailedPathArg }),
      outputSchema: z.object({
        path: z.string(),
        hash: z.string(),
        modifiedAt: z.string(),
        size: z.number(),
        wordCount: z.number(),
        frontmatterKeys: z.array(z.string()),
        tags: z.array(z.string()),
        headings: z.array(HeadingNodeSchema),
        blockIds: z.array(z.object({ id: z.string(), line: z.number() })),
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
