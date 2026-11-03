import { describe, expect, it } from 'vitest';
import { THEME_IDS, THEMES } from './theme';

describe('Swarm themes', () => {
  it('every theme carries a full swarm look: core lights, metal, ten distinct gauge colours', () => {
    expect(THEME_IDS).toEqual(expect.arrayContaining(['void', 'solana', 'gold', 'arctic', 'crimson', 'synthwave']));
    for (const id of THEME_IDS) {
      const s = THEMES[id].swarm;
      for (const c of [s.a, s.b, s.metal, s.up]) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
      expect(s.gauges).toHaveLength(10);
      expect(new Set(s.gauges.map((g) => g.toLowerCase())).size).toBe(10);
      for (const g of s.gauges) expect(g).toMatch(/^#[0-9a-f]{6}$/i);
      expect(Object.keys(s.chrome)).toEqual(['--chrome-1', '--chrome-2', '--chrome-3', '--chrome-4', '--chrome-5', '--chrome-glow', '--chrome-halo', '--chrome-text']);
    }
  });
});
