import { expect, test, describe, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  exists,
  globToRegExp,
  listDir,
  listTrash,
  moveInside,
  readText,
  restoreFromTrash,
  softDelete,
  writeTextAtomic,
} from '../src/vault/fs.js';

describe('globToRegExp', () => {
  test('handles *, **, ?, and regex metacharacters', () => {
    expect(globToRegExp('wiki/*.md').test('wiki/a.md')).toBe(true);
    expect(globToRegExp('wiki/*.md').test('wiki/nested/a.md')).toBe(false);
    expect(globToRegExp('wiki/**/*.md').test('wiki/nested/a.md')).toBe(true);
    expect(globToRegExp('file?.md').test('file1.md')).toBe(true);
    expect(globToRegExp('file?.md').test('file10.md')).toBe(false);
    expect(globToRegExp('literal.+.md').test('literal.+.md')).toBe(true);
    expect(globToRegExp('literal.+.md').test('literal-xx-md')).toBe(false);
  });
});

describe('vault fs helpers', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'sbm-fs-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('writeTextAtomic, readText, exists, moveInside, and softDelete compose safely', async () => {
    const written = await writeTextAtomic(root, 'notes/a.md', 'hello', { createParents: true });
    expect(written.relPath).toBe('notes/a.md');
    expect(written.bytes).toBe(5);
    expect(await exists(root, 'notes/a.md')).toBe(true);
    expect(await readText(root, 'notes/a.md')).toBe('hello');

    const moved = await moveInside(root, 'notes/a.md', 'archive/b.md', { createParents: true });
    expect(moved).toEqual({ from: 'notes/a.md', to: 'archive/b.md' });
    expect(await exists(root, 'notes/a.md')).toBe(false);
    expect(await readText(root, 'archive/b.md')).toBe('hello');

    await writeTextAtomic(root, 'archive/c.md', 'occupied', { createParents: true });
    await expect(moveInside(root, 'archive/b.md', 'archive/c.md')).rejects.toThrow('Destination already exists');

    const deleted = await softDelete(root, 'archive/b.md');
    expect(deleted.originalPath).toBe('archive/b.md');
    expect(deleted.trashPath).toMatch(/^\.trash\/archive\/b\.md\./);
    expect(await exists(root, 'archive/b.md')).toBe(false);
    expect(await readText(root, deleted.trashPath)).toBe('hello');
  });

  test('softDelete -> listTrash -> restoreFromTrash round-trips a file', async () => {
    await writeTextAtomic(root, 'wiki/concepts/foo.md', 'content', { createParents: true });
    const deleted = await softDelete(root, 'wiki/concepts/foo.md');
    expect(await exists(root, 'wiki/concepts/foo.md')).toBe(false);

    const trash = await listTrash(root);
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({
      trashPath: deleted.trashPath,
      originalPath: 'wiki/concepts/foo.md',
      type: 'file',
    });
    expect(trash[0]!.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const restored = await restoreFromTrash(root, deleted.trashPath, {});
    expect(restored.restoredPath).toBe('wiki/concepts/foo.md');
    expect(await readText(root, 'wiki/concepts/foo.md')).toBe('content');
    expect(await listTrash(root)).toHaveLength(0);
  });

  test('restoreFromTrash refuses to clobber unless overwrite, and rejects non-trash paths', async () => {
    await writeTextAtomic(root, 'a.md', 'v1', { createParents: true });
    const deleted = await softDelete(root, 'a.md');
    await writeTextAtomic(root, 'a.md', 'v2-new', { createParents: true }); // original path reoccupied

    await expect(restoreFromTrash(root, deleted.trashPath, {})).rejects.toThrow('already exists');
    const restored = await restoreFromTrash(root, deleted.trashPath, { overwrite: true });
    expect(restored.restoredPath).toBe('a.md');
    expect(await readText(root, 'a.md')).toBe('v1');

    await expect(restoreFromTrash(root, 'not/in/trash.md', {})).rejects.toThrow('Not a valid trash entry');
  });

  test('listDir honors depth, includeDirs, sorting, and default hidden-vault skips', async () => {
    mkdirSync(path.join(root, 'b', 'nested'), { recursive: true });
    mkdirSync(path.join(root, '.git'), { recursive: true });
    mkdirSync(path.join(root, '.trash'), { recursive: true });
    writeFileSync(path.join(root, 'a.md'), 'a');
    writeFileSync(path.join(root, 'b', 'b.md'), 'b');
    writeFileSync(path.join(root, 'b', 'nested', 'c.md'), 'c');
    writeFileSync(path.join(root, '.git', 'config'), 'git');
    writeFileSync(path.join(root, '.trash', 'old.md'), 'trash');

    const top = await listDir(root, '.', { depth: 0 });
    expect(top.map((e) => e.path)).toEqual(['a.md', 'b']);

    const files = await listDir(root, '.', { depth: 1, includeDirs: false });
    expect(files.map((e) => e.path)).toEqual(['a.md', 'b/b.md']);

    const trash = await listDir(root, '.', { depth: 1, includeDirs: false, globFilter: '.trash/**' });
    expect(trash.map((e) => e.path)).toEqual(['.trash/old.md']);
  });
});
