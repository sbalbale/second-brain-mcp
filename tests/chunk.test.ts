import { expect, test, describe } from 'vitest';
import { sliceBody } from '../src/vault/chunk.js';

describe('sliceBody', () => {
  test('returns the whole body with next=null when it fits', () => {
    const r = sliceBody('short body', 0, 1000);
    expect(r).toEqual({ body: 'short body', offset: 0, next: null, total: 10 });
  });

  test('chunks a long body and the chunks reassemble exactly', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(i % 37)}`);
    const body = lines.join('\n');
    let offset: number | null = 0;
    let rebuilt = '';
    let calls = 0;
    while (offset !== null) {
      const r = sliceBody(body, offset, 5000);
      expect(r.body.length).toBeLessThanOrEqual(5000);
      expect(r.total).toBe(body.length);
      rebuilt += r.body;
      offset = r.next;
      calls++;
    }
    expect(rebuilt).toBe(body);
    expect(calls).toBeGreaterThan(1);
  });

  test('prefers to end a chunk on a line break', () => {
    const body = 'a'.repeat(900) + '\n' + 'b'.repeat(500);
    const r = sliceBody(body, 0, 1000);
    expect(r.body.endsWith('\n')).toBe(true);
    expect(r.next).toBe(901);
  });

  test('does a hard cut when there is no nearby line break', () => {
    const body = 'z'.repeat(3000);
    const r = sliceBody(body, 0, 1000);
    expect(r.body.length).toBe(1000);
    expect(r.next).toBe(1000);
  });

  test('clamps out-of-range offsets', () => {
    const r = sliceBody('abc', 99, 10);
    expect(r).toEqual({ body: '', offset: 3, next: null, total: 3 });
  });
});
