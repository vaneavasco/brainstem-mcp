import { baseName, isMarkdownPath } from '../storage/path-policy.ts';
import type { FrontmatterIndex } from './frontmatter-index.ts';
import { frontmatterTags, type LinkRef } from './note-parse.ts';
import { compareCaseInsensitive } from './tags.ts';

export type Resolution =
  | { status: 'resolved'; path: string; anchorFound?: boolean }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'unresolved' };

export interface ResolvedLink {
  link: LinkRef;
  resolution: Resolution;
}

export interface Backlink {
  source: string;
  link: LinkRef;
}

export interface TagInfo {
  tag: string;
  count: number;
  nested: boolean;
  frontmatter: number;
  inline: number;
}

/** Notes contributing a single, exact (leaf) tag string — never rolled up into a parent. */
interface TagBucket {
  display: string;
  frontmatterNotes: Set<string>;
  inlineNotes: Set<string>;
}

interface TagKeyInfo {
  display: string;
  nested: boolean;
}

type Anchor = { heading?: string; block?: string };

function norm(p: string): string {
  return p.toLowerCase();
}

function stripMd(p: string): string {
  return p.toLowerCase().endsWith('.md') ? p.slice(0, -3) : p;
}

/** Extension of a bare (no-slash) target, lowercased, including the dot; null when there is none. */
function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : null;
}

/**
 * Derives the vault's link/backlink/tag graph from a `FrontmatterIndex`. Every public method calls
 * `ensureFresh()`, which recomputes the derived maps only when `index.version` has changed since the
 * last build — cheap to call repeatedly, and always consistent with the live index.
 */
export class VaultGraph {
  private readonly index: FrontmatterIndex;
  private builtVersion = -1;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: read only via a test-only cast to spy on rebuild count.
  private rebuilds = 0;

  private notesByPath = new Map<string, string>();
  private notesByBase = new Map<string, string[]>();
  private assetsByPath = new Map<string, string>();
  private assetsByBase = new Map<string, string[]>();
  private outgoingByPath = new Map<string, ResolvedLink[]>();
  private backlinksByPath = new Map<string, Backlink[]>();
  /** Exact-tag contributions only, keyed by lowercase tag; never includes rolled-up children. */
  private directTagBuckets = new Map<string, TagBucket>();
  /** Every tag key that can be reported by tags()/notesWithTag(): direct tags plus every ancestor
   *  prefix a nested tag implies (so a parent with no literal occurrence of its own still shows up). */
  private tagKeyRegistry = new Map<string, TagKeyInfo>();
  /** entry paths in index.all() order, cached per rebuild so orphans()/hubs() don't re-copy. */
  private entryPaths: string[] = [];
  /** notesForKey(includeNested=true) precomputed per registry key — O(T·depth) built once per
   *  rebuild instead of an O(T²) scan of every direct bucket on every tags() call. */
  private rolledTagBuckets = new Map<
    string,
    { frontmatterNotes: Set<string>; inlineNotes: Set<string> }
  >();

  constructor(index: FrontmatterIndex) {
    this.index = index;
  }

  resolve(target: string, fromPath: string, anchor?: Anchor): Resolution {
    this.ensureFresh();
    return this.resolveCore(target, fromPath, anchor);
  }

  outgoing(path: string): ResolvedLink[] {
    this.ensureFresh();
    return this.outgoingByPath.get(path) ?? [];
  }

  backlinks(path: string): Backlink[] {
    this.ensureFresh();
    return this.backlinksByPath.get(path) ?? [];
  }

  embedsOf(path: string): Backlink[] {
    this.ensureFresh();
    return (this.backlinksByPath.get(path) ?? []).filter((b) => b.link.embed);
  }

  tags(): TagInfo[] {
    this.ensureFresh();
    return [...this.tagKeyRegistry.entries()]
      .map(([key, info]) => {
        const { frontmatterNotes, inlineNotes } = this.notesForKey(key, true);
        return {
          tag: info.display,
          count: new Set([...frontmatterNotes, ...inlineNotes]).size,
          nested: info.nested,
          frontmatter: frontmatterNotes.size,
          inline: inlineNotes.size,
        };
      })
      .sort((a, b) => b.count - a.count || compareCaseInsensitive(a.tag, b.tag));
  }

  notesWithTag(
    tag: string,
    includeNested = true,
  ): { path: string; sources: ('frontmatter' | 'inline')[] }[] {
    this.ensureFresh();
    const key = norm(tag);
    const { frontmatterNotes, inlineNotes } = this.notesForKey(key, includeNested);
    const perNote = new Map<string, Set<'frontmatter' | 'inline'>>();
    for (const p of frontmatterNotes) {
      if (!perNote.has(p)) perNote.set(p, new Set());
      perNote.get(p)?.add('frontmatter');
    }
    for (const p of inlineNotes) {
      if (!perNote.has(p)) perNote.set(p, new Set());
      perNote.get(p)?.add('inline');
    }
    return [...perNote.entries()]
      .map(([path, sources]) => ({ path, sources: [...sources].sort() }))
      .sort((a, b) => compareCaseInsensitive(a.path, b.path));
  }

  /** Notes contributing to `key`: the precomputed rollup (with every descendant) or the direct
   *  bucket alone. Returns internal sets — callers only read, never mutate. */
  private notesForKey(
    key: string,
    includeNested: boolean,
  ): { frontmatterNotes: ReadonlySet<string>; inlineNotes: ReadonlySet<string> } {
    const bucket = includeNested ? this.rolledTagBuckets.get(key) : this.directTagBuckets.get(key);
    return bucket ?? { frontmatterNotes: new Set(), inlineNotes: new Set() };
  }

  /**
   * Notes with neither a resolved outgoing link nor a backlink. A link that resolves to its own
   * source — `[[#Heading]]`/`[[^block]]` (target ''), or a by-name link to the note itself —
   * connects the note to nothing, so it counts as neither: it must not rescue a note from
   * orphanhood, nor inflate its rank in `hubs()`.
   */
  orphans(exclude?: (path: string) => boolean): string[] {
    this.ensureFresh();
    const result: string[] = [];
    for (const path of this.entryPaths) {
      if (!isMarkdownPath(path)) continue;
      const hasResolvedOut = (this.outgoingByPath.get(path) ?? []).some(
        (rl) => rl.resolution.status === 'resolved' && rl.resolution.path !== path,
      );
      const hasBacklinks = this.foreignBacklinkCount(path) > 0;
      if (hasResolvedOut || hasBacklinks) continue;
      if (exclude?.(path)) continue;
      result.push(path);
    }
    return result.sort(compareCaseInsensitive);
  }

  /** Backlinks from *other* notes only — see `orphans()` for why self-links do not count. */
  private foreignBacklinkCount(path: string): number {
    let count = 0;
    for (const b of this.backlinksByPath.get(path) ?? []) if (b.source !== path) count += 1;
    return count;
  }

  /** Most-linked-to notes first. Self-links are excluded, exactly as in `orphans()`. */
  hubs(limit?: number): { path: string; backlinks: number }[] {
    this.ensureFresh();
    const all = this.entryPaths
      .map((path) => ({ path, backlinks: this.foreignBacklinkCount(path) }))
      .filter((h) => h.backlinks > 0)
      .sort((a, b) => b.backlinks - a.backlinks || compareCaseInsensitive(a.path, b.path));
    return typeof limit === 'number' ? all.slice(0, limit) : all;
  }

  unresolved(): { source: string; link: LinkRef }[] {
    this.ensureFresh();
    const result: { source: string; link: LinkRef }[] = [];
    for (const [source, links] of this.outgoingByPath) {
      for (const rl of links) {
        if (rl.resolution.status === 'unresolved') result.push({ source, link: rl.link });
      }
    }
    return result;
  }

  ambiguous(): { source: string; link: LinkRef; candidates: string[] }[] {
    this.ensureFresh();
    const result: { source: string; link: LinkRef; candidates: string[] }[] = [];
    for (const [source, links] of this.outgoingByPath) {
      for (const rl of links) {
        if (rl.resolution.status === 'ambiguous') {
          result.push({ source, link: rl.link, candidates: rl.resolution.candidates });
        }
      }
    }
    return result;
  }

  private ensureFresh(): void {
    if (this.builtVersion === this.index.version) return;
    this.rebuild();
    this.builtVersion = this.index.version;
    this.rebuilds += 1;
  }

  private rebuild(): void {
    const entries = this.index.all();
    this.entryPaths = entries.map((e) => e.path);

    this.notesByPath = new Map();
    this.notesByBase = new Map();
    for (const entry of entries) {
      this.notesByPath.set(norm(stripMd(entry.path)), entry.path);
      const baseKey = norm(stripMd(baseName(entry.path)));
      const list = this.notesByBase.get(baseKey) ?? [];
      list.push(entry.path);
      this.notesByBase.set(baseKey, list);
    }

    this.assetsByPath = new Map();
    this.assetsByBase = new Map();
    for (const assetPath of this.index.assets()) {
      this.assetsByPath.set(norm(assetPath), assetPath);
      const baseKey = norm(baseName(assetPath));
      const list = this.assetsByBase.get(baseKey) ?? [];
      list.push(assetPath);
      this.assetsByBase.set(baseKey, list);
    }

    this.outgoingByPath = new Map();
    this.backlinksByPath = new Map();
    for (const entry of entries) {
      const resolved = entry.links.map((link) => ({
        link,
        resolution: this.resolveCore(link.target, entry.path, {
          heading: link.heading,
          block: link.block,
        }),
      }));
      this.outgoingByPath.set(entry.path, resolved);
      for (const rl of resolved) {
        if (rl.resolution.status !== 'resolved') continue;
        const list = this.backlinksByPath.get(rl.resolution.path) ?? [];
        list.push({ source: entry.path, link: rl.link });
        this.backlinksByPath.set(rl.resolution.path, list);
      }
    }

    this.directTagBuckets = new Map();
    for (const entry of entries) {
      const fmTags = new Set(frontmatterTags(entry.frontmatter));
      for (const tag of entry.tags) {
        const key = norm(tag);
        const source: 'frontmatter' | 'inline' = fmTags.has(tag) ? 'frontmatter' : 'inline';
        let bucket = this.directTagBuckets.get(key);
        if (!bucket) {
          bucket = { display: tag, frontmatterNotes: new Set(), inlineNotes: new Set() };
          this.directTagBuckets.set(key, bucket);
        }
        if (source === 'frontmatter') bucket.frontmatterNotes.add(entry.path);
        else bucket.inlineNotes.add(entry.path);
      }
    }

    // Every direct tag key plus its ancestor prefixes (e.g. 'a/b/c' also registers 'a' and 'a/b'),
    // so a parent with no literal occurrence of its own still appears in tags(). Display casing is
    // the first spelling seen, in the same entries/tags iteration order as directTagBuckets above.
    this.tagKeyRegistry = new Map();
    for (const bucket of this.directTagBuckets.values()) {
      const segments = bucket.display.split('/');
      for (let i = 1; i <= segments.length; i += 1) {
        const display = segments.slice(0, i).join('/');
        const key = norm(display);
        if (!this.tagKeyRegistry.has(key)) this.tagKeyRegistry.set(key, { display, nested: i > 1 });
      }
    }

    // Roll every direct bucket up into each of its ancestor prefixes once, at rebuild time, so
    // tags()/notesWithTag() are O(keys) lookups instead of re-scanning every direct bucket per
    // call (which made tags() O(T²) in the number of tag keys).
    this.rolledTagBuckets = new Map();
    for (const key of this.tagKeyRegistry.keys()) {
      this.rolledTagBuckets.set(key, { frontmatterNotes: new Set(), inlineNotes: new Set() });
    }
    for (const [dkey, bucket] of this.directTagBuckets) {
      const segments = dkey.split('/');
      for (let i = 1; i <= segments.length; i += 1) {
        const rolled = this.rolledTagBuckets.get(segments.slice(0, i).join('/'));
        if (!rolled) continue;
        for (const p of bucket.frontmatterNotes) rolled.frontmatterNotes.add(p);
        for (const p of bucket.inlineNotes) rolled.inlineNotes.add(p);
      }
    }
  }

  /** Resolution logic against the already-fresh lookup maps; never triggers a rebuild itself. */
  private resolveCore(target: string, fromPath: string, anchor?: Anchor): Resolution {
    const t = target.trim();
    if (t === '') return this.withAnchor(fromPath, anchor);

    let candidates: string[];
    if (t.includes('/')) {
      const stripped = t.startsWith('./') ? t.slice(2) : t;
      const notePath = this.notesByPath.get(norm(stripMd(stripped)));
      if (notePath) {
        candidates = [notePath];
      } else {
        const assetPath = this.assetsByPath.get(norm(stripped));
        candidates = assetPath ? [assetPath] : [];
      }
    } else {
      const noteMatches = this.notesByBase.get(norm(stripMd(t))) ?? [];
      const ext = extensionOf(t);
      const assetMatches = ext && ext !== '.md' ? (this.assetsByBase.get(norm(t)) ?? []) : [];
      candidates = [...noteMatches, ...assetMatches];
    }
    const [first, ...rest] = [...new Set(candidates)].sort();
    if (!first) return { status: 'unresolved' };
    if (rest.length > 0) return { status: 'ambiguous', candidates: [first, ...rest] };
    return this.withAnchor(first, anchor);
  }

  private withAnchor(
    path: string,
    anchor?: Anchor,
  ): { status: 'resolved'; path: string; anchorFound?: boolean } {
    if (!anchor || (!anchor.heading && !anchor.block)) return { status: 'resolved', path };
    const entry = this.index.get(path);
    if (!entry) return { status: 'resolved', path };
    let found: boolean;
    if (anchor.heading) {
      const want = (anchor.heading.split('#').at(-1) ?? '').toLowerCase();
      found = entry.headings.some((h) => h.text.toLowerCase() === want);
    } else {
      const want = (anchor.block ?? '').toLowerCase();
      found = entry.blockIds.some((b) => b.id.toLowerCase() === want);
    }
    return { status: 'resolved', path, anchorFound: found };
  }
}
