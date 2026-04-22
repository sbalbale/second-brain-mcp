import { expect, test, describe } from 'vitest';
import { safeJoin, assertRealPathInside, toVaultRel, PathSafetyError } from '../src/vault/paths.js';
import path from 'node:path';

describe('Paths safety', () => {
  test('safeJoin prevents directory traversal', () => {
    const root = path.resolve('/my/vault');
    expect(safeJoin(root, 'foo/bar')).toBe(path.resolve(root, 'foo/bar'));
    expect(() => safeJoin(root, '../outside')).toThrow(PathSafetyError);
    expect(() => safeJoin(root, 'foo/../../outside')).toThrow(PathSafetyError);
  });

  test('toVaultRel creates correct relative paths', () => {
    const root = '/my/vault';
    expect(toVaultRel(root, '/my/vault/foo/bar.md')).toBe('foo/bar.md');
  });

  test('toVaultRel normalizes slashes to posix format', () => {
    const root = 'C:\\my\\vault';
    // When absolute path is passed, if we're on windows it would have backslashes
    // Assuming root is treated as posix for this simple test, we mock windows behavior
    const absPath = 'C:\\my\\vault\\foo\\bar.md';
    expect(toVaultRel(root, absPath)).toBe('foo/bar.md');
  });
});
