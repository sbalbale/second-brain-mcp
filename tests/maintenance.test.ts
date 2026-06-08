import { expect, test, describe } from 'vitest';
import {
  scanLint,
  resolveBrokenLink,
  extractInlineTags,
  extractTemplateVars,
  formatIndexBody,
  categoryToType,
} from '../src/vault/maintenance.js';
import { buildLinkResolver, buildBacklinksByPath, type PageInfo } from '../src/vault/links.js';
import { mergeFrontmatterIntoWins, parseMarkdown } from '../src/vault/frontmatter.js';

function page(
  relPath: string,
  title: string,
  slug: string,
  outlinks: string[] = [],
  frontmatter: Record<string, unknown> = {},
  category: PageInfo['category'] = 'concepts',
): PageInfo {
  return { relPath, title, slug, category, outlinks, frontmatter };
}

describe('categoryToType', () => {
  test('maps known categories, defaults to note', () => {
    expect(categoryToType('sources')).toBe('source');
    expect(categoryToType('entities')).toBe('entity');
    expect(categoryToType('concepts')).toBe('concept');
    expect(categoryToType('synthesis')).toBe('synthesis');
    expect(categoryToType('other')).toBe('note');
  });
});

describe('extractInlineTags', () => {
  test('captures #tags, ignores headings/code, drops pure numbers, dedups', () => {
    const body = [
      'Some #tag and #nested/child text.',
      '# Heading is not a tag',
      'inline `#code` ignored',
      '```',
      '#fenced ignored',
      '```',
      '#tag again, and #123 numeric',
    ].join('\n');
    const tags = extractInlineTags(body);
    expect(tags).toContain('tag');
    expect(tags).toContain('nested/child');
    expect(tags).not.toContain('Heading');
    expect(tags).not.toContain('code');
    expect(tags).not.toContain('fenced');
    expect(tags).not.toContain('123');
    expect(tags.filter((t) => t === 'tag')).toHaveLength(1);
  });
});

describe('extractTemplateVars', () => {
  test('extracts unique {{vars}} ignoring surrounding whitespace', () => {
    expect(extractTemplateVars('{{date}} x {{ title }} y {{date}}')).toEqual(['date', 'title']);
  });
});

describe('formatIndexBody', () => {
  test('groups by type, sorts pages by path, emits path-form links', () => {
    const body = formatIndexBody([
      { path: 'wiki/concepts/b.md', title: 'B', type: 'concept' },
      { path: 'wiki/concepts/a.md', title: 'A', type: 'concept' },
      { path: 'wiki/entities/x.md', title: 'X', type: 'entity' },
    ]);
    expect(body).toContain('## Concept');
    expect(body).toContain('## Entity');
    expect(body.indexOf('[[wiki/concepts/a.md|A]]')).toBeLessThan(body.indexOf('[[wiki/concepts/b.md|B]]'));
  });
});

describe('mergeFrontmatterIntoWins', () => {
  test('base scalars win, arrays union, source-only keys taken', () => {
    const base = '---\ntitle: Into\ncreated: "2020"\ntags:\n  - a\n  - b\n---\nbody';
    const merged = mergeFrontmatterIntoWins(base, { title: 'From', created: '2024', tags: ['b', 'c'], type: 'note' });
    const { frontmatter, body } = parseMarkdown(merged);
    expect(frontmatter.title).toBe('Into');     // base scalar preserved
    expect(frontmatter.created).toBe('2020');   // base scalar preserved
    expect(frontmatter.tags).toEqual(['a', 'b', 'c']); // arrays unioned
    expect(frontmatter.type).toBe('note');      // source-only key taken
    expect(body.trim()).toBe('body');           // body untouched
  });
});

describe('resolveBrokenLink', () => {
  const pages = [
    page('wiki/concepts/foo-bar.md', 'Foo Bar', 'foo-bar'),
    page('wiki/a/dup.md', 'Dup', 'dup'),
    page('wiki/b/dup.md', 'Dup', 'dup'),
  ];
  const resolver = buildLinkResolver(pages);

  test('canonicalizes a punctuation variant to the real slug', () => {
    expect(resolveBrokenLink('Foo_Bar', resolver)).toBe('foo-bar');
  });
  test('returns null when the target already resolves (not broken)', () => {
    expect(resolveBrokenLink('Foo Bar', resolver)).toBeNull();
  });
  test('returns null for genuinely missing targets', () => {
    expect(resolveBrokenLink('totally missing', resolver)).toBeNull();
  });
  test('returns null when the slugified target is ambiguous', () => {
    expect(resolveBrokenLink('Dup!', resolver)).toBeNull();
  });
});

describe('scanLint', () => {
  test('detects orphan, broken-link, and missing-frontmatter', () => {
    const pages = [
      page('a.md', 'A', 'a', ['b', 'ghost'], { type: 'x', title: 'A' }),
      page('b.md', 'B', 'b', [], { type: 'x' }), // missing title
    ];
    const resolver = buildLinkResolver(pages);
    const backlinks = buildBacklinksByPath(pages, resolver);
    const issues = scanLint(pages, resolver, backlinks, ['type', 'title']);

    expect(issues).toContainEqual({ type: 'orphan', page: 'a.md' });
    expect(issues).toContainEqual({ type: 'broken-link', page: 'a.md', target: 'ghost' });
    expect(issues).toContainEqual({ type: 'missing-frontmatter', page: 'b.md', missing: ['title'] });
    // b is linked from a, so it is not an orphan
    expect(issues.find((i) => i.type === 'orphan' && i.page === 'b.md')).toBeUndefined();
  });

  test('flags ambiguous links distinctly from broken links', () => {
    const pages = [
      page('src.md', 'Src', 'src', ['dup'], { type: 'x', title: 'Src' }),
      page('wiki/a/dup.md', 'Dup', 'dup', [], { type: 'x', title: 'Dup' }),
      page('wiki/b/dup.md', 'Dup', 'dup', [], { type: 'x', title: 'Dup' }),
    ];
    const resolver = buildLinkResolver(pages);
    const backlinks = buildBacklinksByPath(pages, resolver);
    const issues = scanLint(pages, resolver, backlinks, ['type', 'title']);
    const ambiguous = issues.find((i) => i.type === 'ambiguous-link');
    expect(ambiguous).toBeDefined();
    expect(ambiguous).toMatchObject({ type: 'ambiguous-link', page: 'src.md', target: 'dup' });
  });

  test('ignores http links', () => {
    const pages = [page('a.md', 'A', 'a', ['https://example.com'], { type: 'x', title: 'A' })];
    const resolver = buildLinkResolver(pages);
    const backlinks = buildBacklinksByPath(pages, resolver);
    const issues = scanLint(pages, resolver, backlinks, ['type', 'title']);
    expect(issues.find((i) => i.type === 'broken-link')).toBeUndefined();
  });
});
