// The heat map's tiles fill their window exactly, whatever its shape and however many tiles.
import { describe, expect, it } from 'vitest';
import { squarify, tileText, type Rect } from './treemap';

const area = (r: Rect) => r.w * r.h;
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

describe('the heat map layout', () => {
  const shapes: Rect[] = [
    { x: 0, y: 0, w: 1920, h: 1080 }, // full screen
    { x: 0, y: 0, w: 960, h: 1080 }, // half
    { x: 0, y: 0, w: 960, h: 540 }, // quarter
    { x: 0, y: 0, w: 640, h: 1080 }, // a third
    { x: 0, y: 0, w: 1920, h: 300 }, // a wide strip
  ];
  for (const n of [24, 48, 96])
    for (const s of shapes)
      it(`${n} tiles fill ${s.w}×${s.h} with no gaps or overlaps`, () => {
        // skewed like real volumes
        const v = Array.from({ length: n }, (_, i) => Math.sqrt(1e10 / (i + 1) ** 1.6));
        const r = squarify(v, s);
        const total = r.reduce((a, x) => a + area(x), 0);
        expect(total).toBeCloseTo(s.w * s.h, 3);
        for (const x of r) {
          expect(x.x).toBeGreaterThanOrEqual(-1e-6);
          expect(x.y).toBeGreaterThanOrEqual(-1e-6);
          expect(x.x + x.w).toBeLessThanOrEqual(s.w + 1e-6);
          expect(x.y + x.h).toBeLessThanOrEqual(s.h + 1e-6);
          expect(x.w).toBeGreaterThan(0);
          expect(x.h).toBeGreaterThan(0);
        }
        for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) expect(overlap(r[i], r[j])).toBeLessThan(1e-3);
        // bigger weight, bigger tile
        expect(area(r[0])).toBeGreaterThan(area(r[n - 1]));
      });

  it('keeps tiles close to square', () => {
    const r = squarify(Array(36).fill(1), { x: 0, y: 0, w: 600, h: 600 });
    for (const x of r) expect(Math.max(x.w / x.h, x.h / x.w)).toBeLessThan(2.5);
  });

  it('copes with nothing to show', () => {
    expect(squarify([], { x: 0, y: 0, w: 100, h: 100 })).toEqual([]);
    expect(squarify([1, 2], { x: 0, y: 0, w: 0, h: 100 }).every((x) => x.w === 0)).toBe(true);
  });
});

describe('the text on a heat map tile', () => {
  it('shows name, change and volume on a big tile, fewer lines as it shrinks, nothing on a sliver', () => {
    expect(tileText('BTC', 360, 500).lines).toBe(3);
    expect(tileText('BTC', 360, 500).fs).toBe(48);
    expect(tileText('MANA', 70, 40).lines).toBe(3);
    expect(tileText('MANA', 70, 26).lines).toBe(2);
    expect(tileText('PENDLE', 40, 14).lines).toBe(1);
    expect(tileText('PENDLE', 8, 8).lines).toBe(0);
  });
  it('fits the widest line inside the tile', () => {
    for (const [name, w, h] of [['MANA', 110, 120], ['WMW', 60, 60], ['1INCH', 90, 80], ['ETH', 300, 90]] as const) {
      const { fs, lines } = tileText(name, w, h);
      const em = [...name].reduce((a, c) => a + (/[MW]/.test(c) ? 0.95 : /[I1]/.test(c) ? 0.4 : 0.74), 0);
      const width = Math.max(em, lines >= 2 ? 6.5 * 0.72 * 0.62 : 0) * fs;
      expect(width).toBeLessThanOrEqual(w + 1e-6);
    }
  });
});
