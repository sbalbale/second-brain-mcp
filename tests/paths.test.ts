import { expect, test, describe } from 'vitest';
import { safeJoin, toVaultRel, PathSafetyError, slugify } from '../src/vault/paths.js';
import path from 'node:path';

describe('Paths safety', () => {
  test('safeJoin prevents directory traversal', () => {
    const root = path.resolve('/my/vault');
    expect(safeJoin(root, 'foo/bar')).toBe(path.resolve(root, 'foo/bar'));
    expect(() => safeJoin(root, '../outside')).toThrow(PathSafetyError);
    expect(() => safeJoin(root, 'foo/../../outside')).toThrow(PathSafetyError);
  });

  test('safeJoin rejects empty, absolute, and drive-letter paths', () => {
    const root = path.resolve('/my/vault');
    expect(() => safeJoin(root, '')).toThrow(PathSafetyError);
    expect(() => safeJoin(root, '/tmp/outside')).toThrow(PathSafetyError);
    expect(() => safeJoin(root, 'C:\\tmp\\outside')).toThrow(PathSafetyError);
  });

  test('toVaultRel creates correct relative paths', () => {
    const root = '/my/vault';
    expect(toVaultRel(root, '/my/vault/foo/bar.md')).toBe('foo/bar.md');
  });

  test('toVaultRel always returns posix-style separators', () => {
    // Build inputs with the host platform's separator (so path.relative can parse
    // them on any OS), then assert the result is normalized to forward slashes.
    // On Windows this exercises backslash->slash; on posix it confirms passthrough.
    const root = path.resolve(path.join('my', 'vault'));
    const absPath = path.join(root, 'foo', 'bar.md');
    const rel = toVaultRel(root, absPath);
    expect(rel).toBe('foo/bar.md');
    expect(rel.includes('\\')).toBe(false);
  });

  test('slugify strips punctuation and diacritics with a stable fallback', () => {
    expect(slugify('Café "LLM" Notes!')).toBe('cafe-llm-notes');
    expect(slugify('---')).toBe('untitled');
  });
});
