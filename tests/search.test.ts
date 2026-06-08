import { expect, test, describe, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchText } from '../src/vault/search.js';

describe('searchText', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'sbm-search-'));
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    mkdirSync(path.join(root, 'other'), { recursive: true });
    mkdirSync(path.join(root, '.git'), { recursive: true });
    mkdirSync(path.join(root, '.trash'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'a.md'), 'Alpha\nneedle one\nNeedle two\n');
    writeFileSync(path.join(root, 'docs', 'b.txt'), 'needle three\n');
    writeFileSync(path.join(root, 'other', 'c.md'), 'needle outside\n');
    writeFileSync(path.join(root, '.git', 'config'), 'needle hidden git\n');
    writeFileSync(path.join(root, '.trash', 'old.md'), 'needle hidden trash\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('literal search is case-insensitive by default and can be scoped by path', async () => {
    const matches = await searchText(root, 'needle', { path: 'docs', maxResults: 20 });
    expect(matches.map((m) => `${m.path}:${m.line}:${m.text}`).sort()).toEqual([
      'docs/a.md:2:needle one',
      'docs/a.md:3:Needle two',
      'docs/b.txt:1:needle three',
    ]);
  });

  test('caseSensitive only returns exact-case literal matches', async () => {
    const matches = await searchText(root, 'Needle', { path: 'docs', caseSensitive: true });
    expect(matches).toEqual([{ path: 'docs/a.md', line: 3, text: 'Needle two' }]);
  });

  test('regex mode and maxResults are honored', async () => {
    const regexMatches = await searchText(root, 'needle (one|three)', { regex: true, path: 'docs', maxResults: 10 });
    expect(regexMatches.map((m) => m.text).sort()).toEqual(['needle one', 'needle three']);

    const limited = await searchText(root, 'needle', { maxResults: 1 });
    expect(limited).toHaveLength(1);
  });

  test('default search skips .git and .trash content', async () => {
    const matches = await searchText(root, 'hidden');
    expect(matches).toEqual([]);
  });
});
