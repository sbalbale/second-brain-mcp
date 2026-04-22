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

  test('mergeFrontmatter appends arrays uniquely', () => {
    const existing = '---\ntags: [a, b]\n---\n# Body';
    const merged = mergeFrontmatter(existing, { tags: ['b', 'c'] });
    const parsed = parseMarkdown(merged);
    expect(parsed.frontmatter.tags).toEqual(['a', 'b', 'c']);
  });

  test('buildMarkdown creates a valid file', () => {
    const generated = buildMarkdown({ title: 'New' }, '# Content');
    const parsed = parseMarkdown(generated);
    expect(parsed.frontmatter.title).toBe('New');
    expect(parsed.body).toBe('# Content\n');
  });
});
