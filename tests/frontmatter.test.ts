import { expect, test, describe } from 'vitest';
import { parseMarkdown, mergeFrontmatter, buildMarkdown } from '../src/vault/frontmatter.js';

describe('Frontmatter handling', () => {
  test('parseMarkdown parses basic frontmatter', () => {
    const md = '---\ntitle: Hello\ntags: [a, b]\n---\n# Body\ntext here.';
    const parsed = parseMarkdown(md);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.frontmatter.title).toBe('Hello');
    expect(parsed.body).toBe('# Body\ntext here.');
  });

  test('parseMarkdown handles files without frontmatter', () => {
    const parsed = parseMarkdown('# Body\ntext here.');
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.body).toBe('# Body\ntext here.');
  });

  test('mergeFrontmatter appends arrays uniquely', () => {
    const existing = '---\ntags: [a, b]\n---\n# Body';
    const merged = mergeFrontmatter(existing, { tags: ['b', 'c'] });
    const parsed = parseMarkdown(merged);
    expect(parsed.frontmatter.tags).toEqual(['a', 'b', 'c']);
  });

  test('mergeFrontmatter can replace arrays', () => {
    const existing = '---\ntags: [a, b]\n---\n# Body';
    const merged = mergeFrontmatter(existing, { tags: ['c'] }, { arrayStrategy: 'replace' });
    const parsed = parseMarkdown(merged);
    expect(parsed.frontmatter.tags).toEqual(['c']);
  });

  test('mergeFrontmatter dedupes object arrays by value', () => {
    const existing = [
      '---',
      'items:',
      '  - id: 1',
      '    label: one',
      '  - id: 2',
      '    label: two',
      '---',
      '# Body',
    ].join('\n');
    const merged = mergeFrontmatter(existing, {
      items: [
        { id: 2, label: 'two' },
        { id: 3, label: 'three' },
      ],
    });
    const parsed = parseMarkdown(merged);
    expect(parsed.frontmatter.items).toEqual([
      { id: 1, label: 'one' },
      { id: 2, label: 'two' },
      { id: 3, label: 'three' },
    ]);
  });

  test('buildMarkdown creates a valid file', () => {
    const generated = buildMarkdown({ title: 'New' }, '# Content');
    const parsed = parseMarkdown(generated);
    expect(parsed.frontmatter.title).toBe('New');
    expect(parsed.body).toBe('# Content\n');
  });
});
