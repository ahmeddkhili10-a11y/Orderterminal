import { describe, expect, it } from 'vitest';
import { ISLAND_THEME_IDS, ISLAND_THEMES, islandTheme } from './themes';

const HEX = /^#[0-9a-f]{6}$/i;
// every colour in a theme, wherever it sits
function colours(x: unknown): string[] {
  if (typeof x === 'string') return x.startsWith('#') ? [x] : [];
  if (Array.isArray(x)) return x.flatMap(colours);
  if (x && typeof x === 'object') return Object.values(x).flatMap(colours);
  return [];
}

describe('island themes', () => {
  it('offers night, matrix, neo, chrome and gold', () => {
    expect(ISLAND_THEME_IDS).toEqual(['night', 'matrix', 'neo', 'chrome', 'gold']);
  });
  it('gives every theme the same parts, with valid colours', () => {
    const keys = Object.keys(ISLAND_THEMES.night).sort();
    for (const id of ISLAND_THEME_IDS) {
      const t = ISLAND_THEMES[id];
      expect(Object.keys(t).sort()).toEqual(keys);
      for (const c of colours(t)) expect(c).toMatch(HEX);
      expect(t.valley[0][0]).toBe(0);
      expect(t.valley[t.valley.length - 1][0]).toBe(1);
      for (let i = 1; i < t.valley.length; i++) expect(t.valley[i][0]).toBeGreaterThan(t.valley[i - 1][0]);
    }
  });
  it('falls back to night for an unknown theme', () => {
    expect(islandTheme('nope').id).toBe('night');
    expect(islandTheme(undefined).id).toBe('night');
    expect(islandTheme('gold').id).toBe('gold');
  });
});
