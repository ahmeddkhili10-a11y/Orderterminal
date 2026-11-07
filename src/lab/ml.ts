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

// ---------- neural network (a small multilayer perceptron) ----------
//
// Two hidden layers of tanh units and a sigmoid output, trained on binary
// cross-entropy with Adam (Kingma & Ba 2015) in mini-batches, an L2 penalty,
// and early stopping on a validation slice taken from the END of the training
// data (time order kept, so it never validates on the past of what it trained
// on). The best weights on the validation slice are kept. Features are
// standardised and clipped at ±5 so one wild reading cannot saturate it.
// Deterministic for a seed; plain arrays, so it serialises with a strategy.

export interface MLP {
  mu: number[];
  sd: number[];
  /** layer weights: W1 [h1][nf], W2 [h2][h1], w3 [h2] */
  W1: number[][];
  b1: number[];
  W2: number[][];
  b2: number[];
  w3: number[];
  b3: number;
  /** loss by epoch on the training and the validation rows */
  trainLoss: number[];
  valLoss: number[];
  /** accuracy on the validation rows (best epoch), and the base rate it should beat */
  valAcc: number | null;
  base: number;
  /** the epoch whose weights were kept */
  best: number;
}
export interface MLPOpts {
  hidden: [number, number];
  epochs: number;
  lr: number;
  l2: number;
  batch: number;
  seed: number;
  /** share of the rows (the latest) held out for early stopping */
  valShare: number;
  /** stop after this many epochs without a better validation loss */
  patience: number;
}
export const MLP_OPTS: MLPOpts = { hidden: [16, 8], epochs: 60, lr: 0.01, l2: 1e-4, batch: 64, seed: 11, valShare: 0.2, patience: 8 };

const sigm = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
const zrow = (m: { mu: number[]; sd: number[] }, x: ArrayLike<number>) => Array.from({ length: m.mu.length }, (_, j) => Math.max(-5, Math.min(5, ((Number.isFinite(x[j]) ? x[j] : m.mu[j]) - m.mu[j]) / m.sd[j])));

/** the network's odds (0–1) that the label is 1 */
export function predictMLP(m: MLP, x: ArrayLike<number>): number {
  const z = zrow(m, x);
  const a1 = m.W1.map((w, i) => Math.tanh(w.reduce((s, wj, j) => s + wj * z[j], m.b1[i])));
  const a2 = m.W2.map((w, i) => Math.tanh(w.reduce((s, wj, j) => s + wj * a1[j], m.b2[i])));
  return sigm(m.w3.reduce((s, w, j) => s + w * a2[j], m.b3));
}

const logLoss = (p: number, y: number) => -(y ? Math.log(Math.max(1e-9, p)) : Math.log(Math.max(1e-9, 1 - p)));

/**
 * A trainer that runs one epoch per step() — so a panel can train it a little
 * at a time and draw the loss as it falls. fitMLP runs it to the end.
 */
export function mlpTrainer(X: number[][], y: number[], opts: Partial<MLPOpts> = {}) {
  const o = { ...MLP_OPTS, ...opts };
  const rnd = rngOf(o.seed);
  const n = X.length;
  const nf = X[0]?.length ?? 0;
  const nVal = Math.max(0, Math.min(n - 20, Math.floor(n * o.valShare)));
  const nTr = n - nVal;
  // standardise on the training rows only
  const mu = new Array(nf).fill(0);
  const sd = new Array(nf).fill(0);
  for (let i = 0; i < nTr; i++) for (let j = 0; j < nf; j++) mu[j] += (Number.isFinite(X[i][j]) ? X[i][j] : 0) / nTr;
  for (let i = 0; i < nTr; i++) for (let j = 0; j < nf; j++) sd[j] += ((Number.isFinite(X[i][j]) ? X[i][j] : 0) - mu[j]) ** 2 / nTr;
  for (let j = 0; j < nf; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const Z = X.map((r) => zrow({ mu, sd }, r));
  const [h1, h2] = o.hidden;
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd());
  // Glorot initialisation
  const init = (rows: number, cols: number) => Array.from({ length: rows }, () => Array.from({ length: cols }, () => gauss() * Math.sqrt(2 / (rows + cols))));
  const P = { W1: init(h1, nf), b1: new Array(h1).fill(0), W2: init(h2, h1), b2: new Array(h2).fill(0), w3: init(1, h2)[0], b3: 0 };
  // Adam moments, one flat vector over all parameters
  const flat = () => [...P.W1.flat(), ...P.b1, ...P.W2.flat(), ...P.b2, ...P.w3, P.b3];
  const np = flat().length;
  const m1 = new Float64Array(np);
  const v1 = new Float64Array(np);
  let tStep = 0;
  const base = y.slice(0, nTr).reduce((a, b) => a + b, 0) / (nTr || 1);
  const model = (): MLP => ({ mu, sd, W1: P.W1.map((r) => [...r]), b1: [...P.b1], W2: P.W2.map((r) => [...r]), b2: [...P.b2], w3: [...P.w3], b3: P.b3, trainLoss: [], valLoss: [], valAcc: null, base: Math.max(base, 1 - base), best: 0 });
  const trainLoss: number[] = [];
  const valLoss: number[] = [];
  let best: MLP = model();
  let bestLoss = Infinity;
  let bestAcc: number | null = null;
  let bestEpoch = 0;
  let since = 0;
  let epoch = 0;
  let done = n < 40 || nf === 0;
  const order = Array.from({ length: nTr }, (_, i) => i);
  const forward = (z: number[]) => {
    const a1 = P.W1.map((w, i) => Math.tanh(w.reduce((s, wj, j) => s + wj * z[j], P.b1[i])));
    const a2 = P.W2.map((w, i) => Math.tanh(w.reduce((s, wj, j) => s + wj * a1[j], P.b2[i])));
    return { a1, a2, p: sigm(P.w3.reduce((s, w, j) => s + w * a2[j], P.b3)) };
  };
  const step = (): boolean => {
    if (done) return true;
    // shuffle the training rows
    for (let i = nTr - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let lossSum = 0;
    for (let s = 0; s < nTr; s += o.batch) {
      const idx = order.slice(s, s + o.batch);
      const g = { W1: P.W1.map((r) => r.map(() => 0)), b1: P.b1.map(() => 0), W2: P.W2.map((r) => r.map(() => 0)), b2: P.b2.map(() => 0), w3: P.w3.map(() => 0), b3: 0 };
      for (const i of idx) {
        const z = Z[i];
        const { a1, a2, p } = forward(z);
        lossSum += logLoss(p, y[i]);
        // backpropagation: d(loss)/d(logit) = p − y
        const d3 = p - y[i];
        g.b3 += d3;
        const d2 = a2.map((a, j) => {
          g.w3[j] += d3 * a;
          return d3 * P.w3[j] * (1 - a * a);
        });
        const d1 = a1.map((a, j) => {
          let s2 = 0;
          for (let k = 0; k < h2; k++) s2 += d2[k] * P.W2[k][j];
          return s2 * (1 - a * a);
        });
        for (let k = 0; k < h2; k++) {
          g.b2[k] += d2[k];
          for (let j = 0; j < h1; j++) g.W2[k][j] += d2[k] * a1[j];
        }
        for (let k = 0; k < h1; k++) {
          g.b1[k] += d1[k];
          const row = g.W1[k];
          for (let j = 0; j < nf; j++) row[j] += d1[k] * z[j];
        }
      }
      // Adam on the averaged gradient (+ L2 on the weights, not the biases)
      const b = idx.length || 1;
      const grads = [...g.W1.flatMap((r, k) => r.map((x, j) => x / b + o.l2 * P.W1[k][j])), ...g.b1.map((x) => x / b), ...g.W2.flatMap((r, k) => r.map((x, j) => x / b + o.l2 * P.W2[k][j])), ...g.b2.map((x) => x / b), ...g.w3.map((x, j) => x / b + o.l2 * P.w3[j]), g.b3 / b];
      tStep++;
      const c1 = 1 - 0.9 ** tStep;
      const c2 = 1 - 0.999 ** tStep;
      const upd = new Float64Array(np);
      for (let q = 0; q < np; q++) {
        m1[q] = 0.9 * m1[q] + 0.1 * grads[q];
        v1[q] = 0.999 * v1[q] + 0.001 * grads[q] * grads[q];
        upd[q] = (o.lr * (m1[q] / c1)) / (Math.sqrt(v1[q] / c2) + 1e-8);
      }
      let q = 0;
      for (let k = 0; k < h1; k++) for (let j = 0; j < nf; j++) P.W1[k][j] -= upd[q++];
      for (let k = 0; k < h1; k++) P.b1[k] -= upd[q++];
      for (let k = 0; k < h2; k++) for (let j = 0; j < h1; j++) P.W2[k][j] -= upd[q++];
      for (let k = 0; k < h2; k++) P.b2[k] -= upd[q++];
      for (let j = 0; j < h2; j++) P.w3[j] -= upd[q++];
      P.b3 -= upd[q++];
    }
    trainLoss.push(lossSum / (nTr || 1));
    // the validation slice: the latest rows, never trained on
    let vl = 0;
    let right = 0;
    for (let i = nTr; i < n; i++) {
      const p = forward(Z[i]).p;
      vl += logLoss(p, y[i]);
      if (p >= 0.5 === (y[i] === 1)) right++;
    }
    const vLoss = nVal ? vl / nVal : trainLoss[trainLoss.length - 1];
    valLoss.push(vLoss);
    epoch++;
    if (vLoss < bestLoss - 1e-5) {
      bestLoss = vLoss;
      best = model();
      bestAcc = nVal ? right / nVal : null;
      bestEpoch = epoch;
      since = 0;
    } else since++;
    if (epoch >= o.epochs || since >= o.patience) done = true;
    return done;
  };
  return {
    step,
    get epoch() {
      return epoch;
    },
    get done() {
      return done;
    },
    epochs: o.epochs,
    /** the best network so far, with the loss history */
    result: (): MLP => ({ ...best, trainLoss: [...trainLoss], valLoss: [...valLoss], valAcc: bestAcc, best: bestEpoch }),
  };
}

export function fitMLP(X: number[][], y: number[], opts: Partial<MLPOpts> = {}): MLP {
  const t = mlpTrainer(X, y, opts);
  while (!t.step());
  return t.result();
}

/**
 * Which inputs the network leans on: how much worse its log-loss gets when
 * one input is shuffled (permutation importance), normalised to sum 1.
 */
export function mlpImportance(m: MLP, X: number[][], y: number[], seed = 3): number[] {
  const nf = m.mu.length;
  const rnd = rngOf(seed);
  const loss = (rows: number[][]) => rows.reduce((s, r, i) => s + logLoss(predictMLP(m, r), y[i]), 0) / (rows.length || 1);
  const base = loss(X);
  const out = new Array(nf).fill(0);
  for (let j = 0; j < nf; j++) {
    const col = X.map((r) => r[j]);
    for (let i = col.length - 1; i > 0; i--) {
      const k = Math.floor(rnd() * (i + 1));
      [col[i], col[k]] = [col[k], col[i]];
    }
    out[j] = Math.max(0, loss(X.map((r, i) => r.map((x, q) => (q === j ? col[i] : x)))) - base);
  }
  const tot = out.reduce((a, b) => a + b, 0) || 1;
  return out.map((v) => v / tot);
}

// ---------- the AI trade filter: a forest, a network, or both ----------

/** a meta-labeller: decides which of a strategy's signals to take (nf: how many inputs it was trained on) */
export interface MetaModel {
  model?: ForestModel;
  nn?: MLP;
  threshold: number;
  nf?: number;
}
/** the meta-labeller's odds that a signal wins: the forest, the network, or the average of both */
export function metaOdds(meta: MetaModel, row: ArrayLike<number>): number {
  const ps: number[] = [];
  if (meta.model) ps.push(predictForest(meta.model, Array.from(row)));
  if (meta.nn) ps.push(predictMLP(meta.nn, row));
  return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 1;
}
