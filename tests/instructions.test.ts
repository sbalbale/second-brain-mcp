import { expect, test, describe } from 'vitest';
import { SERVER_INSTRUCTIONS } from '../src/instructions.js';

describe('SERVER_INSTRUCTIONS', () => {
  test('points every client at the vault rulebook', () => {
    expect(SERVER_INSTRUCTIONS).toContain('AGENTS.md');
    expect(SERVER_INSTRUCTIONS).toContain('next_offset');
    expect(SERVER_INSTRUCTIONS).toContain('wiki_sync');
  });
  test('stays short enough to sit in every client context', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2500);
  });
});
