// The heat map's layout: tiles that fill a rectangle exactly, whatever its shape, each with an
// area in proportion to its weight and kept as close to square as the shape allows
// (the squarified treemap: Bruls, Huizing & van Wijk, 2000).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** one rectangle per value, in the order given; zero or missing values get an empty rectangle */
export function squarify(values: readonly number[], r: Rect): Rect[] {
  const out: Rect[] = values.map(() => ({ x: r.x, y: r.y, w: 0, h: 0 }));
  const idx = values
    .map((_, i) => i)
    .filter((i) => values[i] > 0 && Number.isFinite(values[i]))
    .sort((a, b) => values[b] - values[a]);
  const total = idx.reduce((s, i) => s + values[i], 0);
  if (!total || r.w <= 0 || r.h <= 0) return out;
  const scale = (r.w * r.h) / total;
  let { x, y, w, h } = r;
  let i = 0;
  while (i < idx.length) {
    const side = Math.min(w, h);
    const row: number[] = [];
    let sum = 0;
    let worst = Infinity;
    // add tiles to this strip while that makes its worst tile more square
    while (i < idx.length) {
      const a = values[idx[i]] * scale;
      const s = sum + a;
      const big = row.length ? row[0] : a;
      const ratio = Math.max((side * side * big) / (s * s), (s * s) / (side * side * a));
      if (row.length && ratio > worst) break;
      row.push(a);
      sum = s;
      worst = ratio;
      i++;
    }
    // the strip runs along the shorter side
    const last = i >= idx.length;
    const thick = last ? (w >= h ? w : h) : sum / side;
    let off = 0;
    row.forEach((a, k) => {
      const len = k === row.length - 1 ? side - off : a / thick;
      out[idx[i - row.length + k]] = w >= h ? { x, y: y + off, w: thick, h: len } : { x: x + off, y, w: len, h: thick };
      off += len;
    });
    if (w >= h) {
      x += thick;
      w -= thick;
    } else {
      y += thick;
      h -= thick;
    }
  }
  return out;
}

/**
 * The text a heat map tile can hold: the largest size at which the name, then the change, then
 * the volume fit inside it without being cut off (sizes in em of the name; mono digits ≈ 0.62em).
 */
export function tileText(name: string, w: number, h: number): { fs: number; lines: 0 | 1 | 2 | 3 } {
  // bold capitals: M and W are the widest, I and 1 the narrowest
  const nameW = Math.max(1.5, [...name].reduce((a, c) => a + (/[MW]/.test(c) ? 0.95 : /[I1]/.test(c) ? 0.4 : /[0-9]/.test(c) ? 0.62 : 0.74), 0));
  const pctW = 6.5 * 0.72 * 0.62; // "+12.34%"
  const volW = 7 * 0.55 * 0.62; // "$302.5M"
  const pad = 0.9;
  const fit = (emW: number, emH: number, min: number) => {
    const fs = Math.min(48, (w - 2) / (emW + pad), (h - 2) / emH);
    return fs >= min ? fs : 0;
  };
  const three = fit(Math.max(nameW, pctW, volW), 1.05 + 0.76 + 0.58 + 0.4, 11);
  if (three) return { fs: three, lines: 3 };
  const two = fit(Math.max(nameW, pctW), 1.05 + 0.76 + 0.3, 9);
  if (two) return { fs: two, lines: 2 };
  const one = fit(nameW, 1.3, 7);
  return one ? { fs: one, lines: 1 } : { fs: 0, lines: 0 };
}
