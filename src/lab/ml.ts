// The Lab's learners.
//
//   ridge   ordinary least squares with a small ridge penalty (standardised
//           features), for return forecasts and for alpha/beta regressions
//   forest  a random forest of CART classification trees (Gini splits,
//           bootstrap samples, a random √p features per split; Breiman 2001),
//           for direction forecasts and meta-labelling (López de Prado 2018)
//
// Both are deterministic for a given seed, small, and serialise to JSON so a
// deployed strategy carries its trained model with it.

export const rngOf = (seed: number) => {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
};

// ---------- ridge regression ----------

export interface Ridge {
  /** per-feature mean and spread used to standardise */
  mu: number[];
  sd: number[];
  /** intercept and coefficients on the standardised features */
  b0: number;
  b: number[];
}

/** Solve A x = y for a small symmetric positive-definite A (Gaussian elimination with partial pivoting). */
export function solve(A: number[][], y: number[]): number[] {
  const n = y.length;
  const M = A.map((r, i) => [...r, y[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}

export function fitRidge(X: number[][], y: number[], lambda = 1e-3): Ridge {
  const p = X[0]?.length ?? 0;
  const n = X.length;
  const mu = new Array(p).fill(0);
  const sd = new Array(p).fill(0);
  for (const r of X) for (let j = 0; j < p; j++) mu[j] += r[j] / n;
  for (const r of X) for (let j = 0; j < p; j++) sd[j] += (r[j] - mu[j]) ** 2 / n;
  for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const ym = y.reduce((a, b) => a + b, 0) / (n || 1);
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const v = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const z = X[i].map((x, j) => (x - mu[j]) / sd[j]);
    for (let a = 0; a < p; a++) {
      v[a] += z[a] * (y[i] - ym);
      for (let c = 0; c < p; c++) A[a][c] += z[a] * z[c];
    }
  }
  for (let a = 0; a < p; a++) A[a][a] += lambda * n;
  const b = p ? solve(A, v) : [];
  return { mu, sd, b0: ym, b };
}

export const predictRidge = (m: Ridge, x: number[]) => m.b0 + x.reduce((s, xi, j) => s + m.b[j] * ((xi - m.mu[j]) / m.sd[j]), 0);

/** OLS of y on x (one regressor) with Newey–West standard errors: alpha, beta and their t-statistics. */
export function regress(y: ArrayLike<number>, x: ArrayLike<number>, lags?: number) {
  const n = Math.min(y.length, x.length);
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i] / n;
    my += y[i] / n;
  }
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  const beta = sxx > 0 ? sxy / sxx : 0;
  const alpha = my - beta * mx;
  const e = new Float64Array(n);
  let sse = 0;
  for (let i = 0; i < n; i++) {
    e[i] = y[i] - alpha - beta * x[i];
    sse += e[i] ** 2;
  }
  // Newey–West (Bartlett) covariance of [alpha, beta]
  const L = lags ?? Math.floor(4 * (n / 100) ** (2 / 9));
  const g = (i: number) => [e[i], e[i] * (x[i] - mx)];
  const S = [
    [0, 0],
    [0, 0],
  ];
  for (let i = 0; i < n; i++) {
    const a = g(i);
    S[0][0] += a[0] * a[0];
    S[0][1] += a[0] * a[1];
    S[1][1] += a[1] * a[1];
  }
  for (let l = 1; l <= L; l++) {
    const w = 1 - l / (L + 1);
    for (let i = l; i < n; i++) {
      const a = g(i);
      const b = g(i - l);
      S[0][0] += w * 2 * a[0] * b[0];
      S[0][1] += w * (a[0] * b[1] + a[1] * b[0]);
      S[1][1] += w * 2 * a[1] * b[1];
    }
  }
  // with centred x: var(beta) = S11 / sxx², var(alpha) ≈ S00 / n² (+ the mean-of-x term)
  const vb = sxx > 0 ? S[1][1] / sxx ** 2 : 0;
  const va = S[0][0] / (n * n) + mx * mx * vb;
  const r2 = 1 - sse / Math.max(1e-30, Array.from({ length: n }, (_, i) => (y[i] - my) ** 2).reduce((a, b) => a + b, 0));
  return { alpha, beta, tAlpha: va > 0 ? alpha / Math.sqrt(va) : 0, tBeta: vb > 0 ? beta / Math.sqrt(vb) : 0, r2, n };
}

// ---------- random forest (binary) ----------

type TNode = { p: number; n: number } | { f: number; t: number; l: TNode; r: TNode };
export interface ForestModel {
  trees: TNode[];
  /** mean decrease in impurity per feature, normalised to sum 1 */
  importance: number[];
  /** out-of-bag accuracy and the base rate it should beat */
  oob: number | null;
  base: number;
}
export interface ForestOpts {
  trees: number;
  maxDepth: number;
  minLeaf: number;
  seed: number;
}
export const FOREST_OPTS: ForestOpts = { trees: 60, maxDepth: 5, minLeaf: 8, seed: 11 };

function growTree(X: number[][], y: number[], idx: number[], depth: number, o: ForestOpts, rnd: () => number, imp: number[]): TNode {
  const n = idx.length;
  let pos = 0;
  for (const i of idx) pos += y[i];
  const p = (pos + 0.5) / (n + 1);
  if (depth >= o.maxDepth || n < 2 * o.minLeaf || pos === 0 || pos === n) return { p, n };
  const nf = X[0].length;
  const tryN = Math.max(1, Math.round(Math.sqrt(nf)));
  const feats: number[] = [];
  while (feats.length < tryN) {
    const f = Math.floor(rnd() * nf);
    if (!feats.includes(f)) feats.push(f);
  }
  const g0 = 1 - (pos / n) ** 2 - (1 - pos / n) ** 2;
  let best = { gain: 0, f: -1, t: 0 };
  for (const f of feats) {
    const s = [...idx].sort((a, b) => X[a][f] - X[b][f]);
    let lp = 0;
    for (let k = 0; k < n - 1; k++) {
      lp += y[s[k]];
      const nl = k + 1;
      if (nl < o.minLeaf || n - nl < o.minLeaf) continue;
      const a = X[s[k]][f];
      const b = X[s[k + 1]][f];
      if (a === b) continue;
      const rp = pos - lp;
      const gl = 1 - (lp / nl) ** 2 - (1 - lp / nl) ** 2;
      const gr = 1 - (rp / (n - nl)) ** 2 - (1 - rp / (n - nl)) ** 2;
      const gain = g0 - (nl / n) * gl - ((n - nl) / n) * gr;
      if (gain > best.gain) best = { gain, f, t: (a + b) / 2 };
    }
  }
  if (best.f < 0) return { p, n };
  imp[best.f] += best.gain * n;
  const L = idx.filter((i) => X[i][best.f] <= best.t);
  const R = idx.filter((i) => X[i][best.f] > best.t);
  return { f: best.f, t: best.t, l: growTree(X, y, L, depth + 1, o, rnd, imp), r: growTree(X, y, R, depth + 1, o, rnd, imp) };
}

const leafOf = (t: TNode, x: number[]): number => ('p' in t ? t.p : x[t.f] <= t.t ? leafOf(t.l, x) : leafOf(t.r, x));

export function fitForest(X: number[][], y: number[], opts: Partial<ForestOpts> = {}): ForestModel {
  const o = { ...FOREST_OPTS, ...opts };
  const rnd = rngOf(o.seed);
  const n = X.length;
  const nf = X[0]?.length ?? 0;
  const imp = new Array(nf).fill(0);
  const trees: TNode[] = [];
  const oobSum = new Float64Array(n);
  const oobCnt = new Uint16Array(n);
  for (let k = 0; k < o.trees; k++) {
    const idx: number[] = [];
    const inBag = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rnd() * n);
      idx.push(j);
      inBag[j] = 1;
    }
    const t = growTree(X, y, idx, 0, o, rnd, imp);
    trees.push(t);
    for (let i = 0; i < n; i++)
      if (!inBag[i]) {
        oobSum[i] += leafOf(t, X[i]);
        oobCnt[i]++;
      }
  }
  let right = 0;
  let seen = 0;
  for (let i = 0; i < n; i++)
    if (oobCnt[i]) {
      seen++;
      if (oobSum[i] / oobCnt[i] >= 0.5 === (y[i] === 1)) right++;
    }
  const tot = imp.reduce((a, b) => a + b, 0) || 1;
  const pos = y.reduce((a, b) => a + b, 0) / (n || 1);
  return { trees, importance: imp.map((v) => v / tot), oob: seen ? right / seen : null, base: Math.max(pos, 1 - pos) };
}

export const predictForest = (m: ForestModel, x: number[]) => m.trees.reduce((s, t) => s + leafOf(t, x), 0) / (m.trees.length || 1);
