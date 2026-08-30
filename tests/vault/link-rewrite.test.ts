import { describe, expect, it } from 'vitest';
import { newTargetText, rewriteLinks, type TargetRewrite } from '../../src/vault/link-rewrite.ts';
import { type LinkRef, parseNote } from '../../src/vault/note-parse.ts';

function parse(content: string): LinkRef[] {
  return parseNote(content, {}, content).links;
}

/** Convenience: rewrite the single link `content` is expected to contain, moving `b` -> `notes/c.md`. */
function rewriteSingle(
  content: string,
  opts: { newPath?: string; fromPath?: string; basenameUnique?: boolean },
): string {
  const links = parse(content);
  expect(links).toHaveLength(1);
  const link = links[0] as LinkRef;
  const newPath = opts.newPath ?? 'notes/c.md';
  const newTarget = newTargetText(link, newPath, {
    fromPath: opts.fromPath ?? 'a.md',
    basenameUnique: opts.basenameUnique ?? true,
  });
  return rewriteLinks(content, [{ link, newTarget }]);
}

describe('newTargetText / rewriteLinks — wiki links', () => {
  it('rewrites a bare wikilink to the new bare basename when unique', () => {
    expect(rewriteSingle('[[b]]', { basenameUnique: true })).toBe('[[c]]');
  });

  it('rewrites a bare wikilink to the full vault path when the new basename is not unique', () => {
    expect(rewriteSingle('[[b]]', { basenameUnique: false })).toBe('[[notes/c]]');
  });

  it('keeps the full vault path when the old target already had a slash, even if unique', () => {
    const content = '[[folder/b]]';
    const links = parse(content);
    const link = links[0] as LinkRef;
    const newTarget = newTargetText(link, 'archive/folder/b.md', {
      fromPath: 'a.md',
      basenameUnique: true,
    });
    expect(newTarget).toBe('archive/folder/b');
    expect(rewriteLinks(content, [{ link, newTarget }])).toBe('[[archive/folder/b]]');
  });

  it('preserves the alias', () => {
    expect(rewriteSingle('[[b|Al]]', { basenameUnique: true })).toBe('[[c|Al]]');
  });

  it('preserves a heading anchor', () => {
    expect(rewriteSingle('[[b#Sec]]', { basenameUnique: true })).toBe('[[c#Sec]]');
  });

  it('preserves a block anchor', () => {
    expect(rewriteSingle('[[b#^blk]]', { basenameUnique: true })).toBe('[[c#^blk]]');
  });

  it('preserves heading anchor and alias together', () => {
    expect(rewriteSingle('[[b#Sec|Al]]', { basenameUnique: true })).toBe('[[c#Sec|Al]]');
  });

  it('preserves the embed marker', () => {
    expect(rewriteSingle('![[b]]', { basenameUnique: true })).toBe('![[c]]');
  });

  it('keeps an asset target extension and full path when not unique', () => {
    const content = '[[img]]';
    const links = parse(content);
    const link = links[0] as LinkRef;
    const newTarget = newTargetText(link, 'assets/img.png', {
      fromPath: 'a.md',
      basenameUnique: false,
    });
    expect(newTarget).toBe('assets/img.png');
    expect(rewriteLinks(content, [{ link, newTarget }])).toBe('[[assets/img.png]]');
  });

  it('keeps an asset target extension when written bare and unique', () => {
    const content = '[[img.png]]';
    const links = parse(content);
    const link = links[0] as LinkRef;
    const newTarget = newTargetText(link, 'assets/img.png', {
      fromPath: 'a.md',
      basenameUnique: true,
    });
    expect(newTarget).toBe('img.png');
    expect(rewriteLinks(content, [{ link, newTarget }])).toBe('[[img.png]]');
  });
});

describe('newTargetText / rewriteLinks — markdown links', () => {
  it('rewrites to a relative path from the linking note folder, keeping .md', () => {
    const content = '[t](b.md)';
    const links = parse(content);
    const link = links[0] as LinkRef;
    const newTarget = newTargetText(link, 'notes/c.md', {
      fromPath: 'x/y.md',
      basenameUnique: false,
    });
    expect(newTarget).toBe('../notes/c.md');
    expect(rewriteLinks(content, [{ link, newTarget }])).toBe('[t](../notes/c.md)');
  });

  it('rewrites an angle-bracket target with an anchor, keeping the anchor and brackets', () => {
    const content = '[t](<b.md#S>)';
    const links = parse(content);
    const link = links[0] as LinkRef;
    const newTarget = newTargetText(link, 'notes/c.md', {
      fromPath: 'x/y.md',
      basenameUnique: false,
    });
    expect(rewriteLinks(content, [{ link, newTarget }])).toBe('[t](<../notes/c.md#S>)');
  });

  it('wraps the new target in <...> when it contains a space, plain otherwise', () => {
    const content = '[t](b.md)';
    const links = parse(content);
    const link = links[0] as LinkRef;
    const newTarget = newTargetText(link, 'notes/my note.md', {
      fromPath: 'a.md',
      basenameUnique: false,
    });
    expect(newTarget).toBe('notes/my note.md');
    expect(rewriteLinks(content, [{ link, newTarget }])).toBe('[t](<notes/my note.md>)');
  });

  it('stays in the same folder without a leading ./ when source and target share a directory', () => {
    const content = '[t](b.md)';
    const links = parse(content);
    const link = links[0] as LinkRef;
    const newTarget = newTargetText(link, 'x/c.md', { fromPath: 'x/y.md', basenameUnique: false });
    expect(newTarget).toBe('c.md');
    expect(rewriteLinks(content, [{ link, newTarget }])).toBe('[t](c.md)');
  });

  it('preserves the embed marker on markdown embeds', () => {
    const content = '![c](b.md)';
    const links = parse(content);
    const link = links[0] as LinkRef;
    const newTarget = newTargetText(link, 'notes/c.md', {
      fromPath: 'a.md',
      basenameUnique: false,
    });
    expect(rewriteLinks(content, [{ link, newTarget }])).toBe('![c](notes/c.md)');
  });
});

describe('rewriteLinks — untouched text and multi-link ordering', () => {
  it('leaves surrounding text byte-identical', () => {
    const content = 'before [[b]] after\nsecond line unaffected\n';
    const links = parse(content);
    const link = links[0] as LinkRef;
    const newTarget = newTargetText(link, 'notes/c.md', { fromPath: 'a.md', basenameUnique: true });
    expect(rewriteLinks(content, [{ link, newTarget }])).toBe(
      'before [[c]] after\nsecond line unaffected\n',
    );
  });

  it('leaves content with no rewrites byte-identical', () => {
    const content = 'no links here at all\n[[unrelated]]\n';
    expect(rewriteLinks(content, [])).toBe(content);
  });

  it('rewrites multiple links on one line right-to-left so earlier offsets stay valid', () => {
    const content = '[[b]] middle [[b|Al]] end [[b#Sec]]';
    const links = parse(content);
    expect(links).toHaveLength(3);
    const rewrites: TargetRewrite[] = links.map((link) => ({
      link,
      newTarget: newTargetText(link, 'notes/c.md', { fromPath: 'a.md', basenameUnique: true }),
    }));
    expect(rewriteLinks(content, rewrites)).toBe('[[c]] middle [[c|Al]] end [[c#Sec]]');
  });

  it('rewrites a mix of wiki and markdown links across lines, leaving unrelated links alone', () => {
    const content = '[[b]]\n[t](b.md)\n[[other]]\n';
    const links = parse(content);
    expect(links).toHaveLength(3);
    const rewrites: TargetRewrite[] = links
      .filter((l) => l.target === 'b' || l.target === 'b.md')
      .map((link) => ({
        link,
        newTarget: newTargetText(link, 'notes/c.md', { fromPath: 'a.md', basenameUnique: true }),
      }));
    expect(rewriteLinks(content, rewrites)).toBe('[[c]]\n[t](notes/c.md)\n[[other]]\n');
  });
});
