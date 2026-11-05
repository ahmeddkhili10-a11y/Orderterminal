import { describe, expect, it } from 'vitest';
import { stanceOf } from './island3d';

describe('the council on the island', () => {
  it('reads how each agent voted from the mark its line starts with', () => {
    expect(stanceOf('✓ aggressive flow with it (delta 0.31)')).toBe('for');
    expect(stanceOf('✗ longs pay 38% a year to hold: crowded')).toBe('against');
    expect(stanceOf('⛔ spread 12 bps: no trade')).toBe('veto');
    expect(stanceOf('– odds 51% win')).toBe('abstain');
    expect(stanceOf('  ✓ padded')).toBe('for');
  });
});
