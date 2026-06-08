import { expect, test, describe } from 'vitest';
import {
  buildLinkResolver,
  buildBacklinksByPath,
  extractWikilinks,
  rewriteWikilinks,
  scanWikiPages,
  type PageInfo,
} from '../src/vault/links.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function page(relPath: string, title: string, slug: string, outlinks: string[] = []): PageInfo {
  return { relPath, title, slug, category: 'concepts', outlinks, frontmatter: {} };
}

describe('buildLinkResolver', () => {
  const pages = [
    page('wiki/concepts/foo.md', 'Foo', 'foo'),
    page('wiki/entities/bar.md', 'Bar', 'bar'),
    page('wiki/a/dup.md', 'Dup A', 'dup'),
    page('wiki/b/dup.md', 'Dup B', 'dup'),
  ];
  const resolver = buildLinkResolver(pages);

  test('resolves by slug, title, and both path forms (case-insensitive)', () => {
    expect(resolver.resolve('foo').page?.relPath).toBe('wiki/concepts/foo.md');
    expect(resolver.resolve('Foo').page?.relPath).toBe('wiki/concepts/foo.md');
    expect(resolver.resolve('wiki/concepts/foo.md').page?.relPath).toBe('wiki/concepts/foo.md');
    expect(resolver.resolve('wiki/concepts/foo').page?.relPath).toBe('wiki/concepts/foo.md');
  });

  test('strips #anchor and |alias before resolving', () => {
    expect(resolver.resolve('foo#section').page?.slug).toBe('foo');
    expect(resolver.resolve('foo|Display').page?.slug).toBe('foo');
  });

  test('preserves ambiguity for duplicate basenames', () => {
    const r = resolver.resolve('dup');
    expect(r.page).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.candidates).toHaveLength(2);
  });

  test('returns not-found (not ambiguous) for missing targets', () => {
    const r = resolver.resolve('nope');
    expect(r.page).toBeNull();
    expect(r.ambiguous).toBe(false);
    expect(r.candidates).toHaveLength(0);
  });
});

describe('buildBacklinksByPath', () => {
  test('keys backlinks by resolved page path, dedups, ignores unresolved', () => {
    const pages = [
      page('a.md', 'A', 'a', ['B', 'b', 'ghost']), // links to B by title and slug, plus a broken one
      page('b.md', 'B', 'b', []),
    ];
    const resolver = buildLinkResolver(pages);
    const bl = buildBacklinksByPath(pages, resolver);
    expect(bl.get('b.md')).toEqual(['a.md']); // counted once despite two link forms
    expect(bl.get('a.md')).toBeUndefined();   // orphan
  });
});

describe('extractWikilinks', () => {
  test('extracts unique bare targets while preserving title, slug, path, and url forms', () => {
    const body = [
      '[[Foo]] and [[Foo#section]] are the same target.',
      '[[bar|Bar Alias]] links by slug.',
      '[[wiki/concepts/baz.md|Baz]] links by path.',
      '[[https://example.com|External]] is preserved for callers to classify.',
    ].join('\n');
    expect(extractWikilinks(body)).toEqual([
      'Foo',
      'bar',
      'wiki/concepts/baz.md',
      'https://example.com',
    ]);
  });
});

describe('scanWikiPages', () => {
  test('recurses wiki subdirs, reads frontmatter, derives titles, and ignores non-markdown files', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'sbm-links-'));
    try {
      mkdirSync(path.join(root, 'wiki', 'concepts', 'nested'), { recursive: true });
      mkdirSync(path.join(root, 'wiki', 'entities'), { recursive: true });
      writeFileSync(
        path.join(root, 'wiki', 'concepts', 'nested', 'alpha.md'),
        [
          '---',
          'type: concept',
          'title: Alpha FM',
          '---',
          '# Alpha Heading',
          'Links to [[beta-note]] and [[Missing]].',
        ].join('\n'),
      );
      writeFileSync(path.join(root, 'wiki', 'entities', 'beta-note.md'), 'No heading here.\n');
      writeFileSync(path.join(root, 'wiki', 'entities', 'ignore.txt'), '[[not-a-page]]\n');

      const index = await scanWikiPages(root);
      expect(index.pages).toHaveLength(2);

      const alpha = index.pages.find((p) => p.relPath === 'wiki/concepts/nested/alpha.md');
      expect(alpha).toMatchObject({
        title: 'Alpha Heading',
        slug: 'alpha',
        category: 'concepts',
        outlinks: ['beta-note', 'Missing'],
        frontmatter: { type: 'concept', title: 'Alpha FM' },
      });

      const beta = index.pages.find((p) => p.relPath === 'wiki/entities/beta-note.md');
      expect(beta).toMatchObject({
        title: 'Beta Note',
        slug: 'beta-note',
        category: 'entities',
        outlinks: [],
        frontmatter: {},
      });
      expect(index.bySlug.get('alpha')?.relPath).toBe('wiki/concepts/nested/alpha.md');
      expect(index.backlinks.get('beta-note')).toEqual(['wiki/concepts/nested/alpha.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('rewriteWikilinks', () => {
  test('rewrites matched targets, preserves #anchor and |alias, leaves others', () => {
    const body = '[[foo]] [[foo#sec]] [[foo|Disp]] [[wiki/concepts/foo.md|Foo]] [[bar]]';
    const replacer = (t: string) => (t.toLowerCase() === 'foo' ? 'baz' : null);
    const { body: out, count } = rewriteWikilinks(body, replacer);
    expect(out).toContain('[[baz]]');
    expect(out).toContain('[[baz#sec]]');
    expect(out).toContain('[[baz|Disp]]');
    expect(out).toContain('[[wiki/concepts/foo.md|Foo]]'); // path-form target not matched -> untouched
    expect(out).toContain('[[bar]]');
    expect(count).toBe(3);
  });

  test('count is zero when nothing matches', () => {
    const { body, count } = rewriteWikilinks('[[x]] [[y]]', () => null);
    expect(count).toBe(0);
    expect(body).toBe('[[x]] [[y]]');
  });
});
