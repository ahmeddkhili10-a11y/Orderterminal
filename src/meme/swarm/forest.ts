// The swarm's statistics: a decision forest that turns a coin's numbers (see
// features.ts) into the odds of what happens in the next hour —
//
//   dead  fell to a fifth of the price or less, or stopped trading
//   flat  never reached 2×
//   2×    reached 2× but not 5×
//   5×    reached 5× or more
//
// Each tree is a CART classification tree (Gini splits) grown on a bootstrap
// sample of the coins the swarm has followed, trying a random few features at
// each split; the forest's answer is the trees' average. The coins a tree did
// not see score it honestly (out-of-bag), which gives the accuracy shown.
//
// Until there is enough of its own data, the forest leans on a prior: a small
// hand-written tree with base rates from the published research (most coins
// die; under 1 % graduate). The learned forest takes over as data comes in:
// weight n / (n + 60) for n followed coins.
import { FEATURES } from './features';

export const CLASSES = ['dead', 'flat', '2×', '5×'] as const;
export type Probs = [number, number, number, number];

/** What a class pays, roughly, under the Manager's exits: stop −35 % with slippage, a fade, a 2–5× run with the trail, a 5×+ run with the ladder. */
export const PAYOFF: Probs = [0.55, 0.85, 1.8, 4.0];
/** round-trip fees and price impact, as a share of the trade */
export const COSTS = 0.03;

export interface Sample {
  x: number[];
  y: number;
}

type Node = { leaf: true; p: Probs; n: number } | { leaf: false; f: number; t: number; l: Node; r: Node };

export interface ForestConfig {
  trees: number;
  maxDepth: number;
  minLeaf: number;
  /** features tried at each split (0 = √ of the count) */
  mtry: number;
  seed: number;
}
export const FOREST_DEFAULTS: ForestConfig = { trees: 40, maxDepth: 6, minLeaf: 5, mtry: 0, seed: 7 };

const rngOf = (seed: number) => {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
};
const counts = (rows: Sample[], idx: number[]) => {
  const c = [0, 0, 0, 0];
  for (const i of idx) c[rows[i].y]++;
  return c;
};
const gini = (c: number[], n: number) => (n ? 1 - c.reduce((a, k) => a + (k / n) ** 2, 0) : 0);
// leaf odds, lightly smoothed so a pure leaf of 5 coins does not say "certain"
const leafProbs = (c: number[], n: number): Probs => c.map((k) => (k + 0.5) / (n + 2)) as Probs;

function grow(rows: Sample[], idx: number[], depth: number, cfg: ForestConfig, rnd: () => number, nf: number): Node {
  const c = counts(rows, idx);
  const n = idx.length;
  if (depth >= cfg.maxDepth || n < cfg.minLeaf * 2 || c.filter((k) => k > 0).length < 2) return { leaf: true, p: leafProbs(c, n), n };
  const mtry = cfg.mtry || Math.max(1, Math.round(Math.sqrt(nf)));
  const pool = [...Array(nf).keys()];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const parent = gini(c, n);
  let best: { f: number; t: number; gain: number } | null = null;
  for (const f of pool.slice(0, mtry)) {
    const vals = idx.map((i) => rows[i].x[f]).sort((a, b) => a - b);
    // up to 16 candidate thresholds at quantiles
    const cands = new Set<number>();
    for (let q = 1; q < 16; q++) {
      const k = Math.floor((q / 16) * vals.length);
      if (k > 0 && k < vals.length && vals[k] !== vals[k - 1]) cands.add((vals[k] + vals[k - 1]) / 2);
    }
    for (const t of cands) {
      const lc = [0, 0, 0, 0];
      let ln = 0;
      for (const i of idx) if (rows[i].x[f] <= t) lc[rows[i].y]++, ln++;
      const rn = n - ln;
      if (ln < cfg.minLeaf || rn < cfg.minLeaf) continue;
      const rc = c.map((k, j) => k - lc[j]);
      const gain = parent - (ln / n) * gini(lc, ln) - (rn / n) * gini(rc, rn);
      if (!best || gain > best.gain) best = { f, t, gain };
    }
  }
  if (!best || best.gain <= 1e-9) return { leaf: true, p: leafProbs(c, n), n };
  const L = idx.filter((i) => rows[i].x[best!.f] <= best!.t);
  const R = idx.filter((i) => rows[i].x[best!.f] > best!.t);
  return { leaf: false, f: best.f, t: best.t, l: grow(rows, L, depth + 1, cfg, rnd, nf), r: grow(rows, R, depth + 1, cfg, rnd, nf) };
}

function predictTree(node: Node, x: number[]): Probs {
  while (!node.leaf) node = x[node.f] <= node.t ? node.l : node.r;
  return node.p;
}

export interface ForestStats {
  /** coins it learned from */
  n: number;
  /** out-of-bag: share of coins whose class it got right, against always guessing the commonest class */
  accuracy: number | null;
  baseline: number | null;
  /** out-of-bag Brier score (lower is better; 0.75 is a coin toss over four classes) */
  brier: number | null;
  /** how often each feature was used to split, normalised */
  importance: number[];
  trainedAt: number;
}

export class Forest {
  constructor(
    private trees: Node[],
    readonly stats: ForestStats,
  ) {}

  /** Grow the forest (async: yields between trees so the terminal keeps drawing). */
  static async train(rows: Sample[], cfg: ForestConfig = FOREST_DEFAULTS, now = Date.now(), yieldEvery = 5): Promise<Forest> {
    const rnd = rngOf(cfg.seed + rows.length);
    const nf = rows[0]?.x.length ?? FEATURES.length;
    const trees: Node[] = [];
    const oob: { sum: number[]; k: number }[] = rows.map(() => ({ sum: [0, 0, 0, 0], k: 0 }));
    const used = new Array(nf).fill(0);
    const count = (node: Node) => {
      if (node.leaf) return;
      used[node.f]++;
      count(node.l);
      count(node.r);
    };
    for (let t = 0; t < cfg.trees && rows.length >= cfg.minLeaf * 2; t++) {
      const inBag = new Uint8Array(rows.length);
      const idx = rows.map(() => {
        const i = Math.floor(rnd() * rows.length);
        inBag[i] = 1;
        return i;
      });
      const tree = grow(rows, idx, 0, cfg, rnd, nf);
      trees.push(tree);
      count(tree);
      for (let i = 0; i < rows.length; i++) {
        if (inBag[i]) continue;
        const p = predictTree(tree, rows[i].x);
        for (let j = 0; j < 4; j++) oob[i].sum[j] += p[j];
        oob[i].k++;
      }
      if (yieldEvery && t % yieldEvery === yieldEvery - 1) await new Promise((r) => setTimeout(r, 0));
    }
    let right = 0;
    let brier = 0;
    let m = 0;
    for (let i = 0; i < rows.length; i++) {
      if (!oob[i].k) continue;
      const p = oob[i].sum.map((s) => s / oob[i].k);
      if (p.indexOf(Math.max(...p)) === rows[i].y) right++;
      brier += p.reduce((a, pj, j) => a + (pj - (j === rows[i].y ? 1 : 0)) ** 2, 0);
      m++;
    }
    const cls = counts(rows, rows.map((_, i) => i));
    const total = used.reduce((a, b) => a + b, 0) || 1;
    return new Forest(trees, {
      n: rows.length,
      accuracy: m ? right / m : null,
      baseline: rows.length ? Math.max(...cls) / rows.length : null,
      brier: m ? brier / m : null,
      importance: used.map((u) => u / total),
      trainedAt: now,
    });
  }

  get size() {
    return this.trees.length;
  }

  predict(x: number[]): Probs {
    if (!this.trees.length) return priorTree(x);
    const s = [0, 0, 0, 0];
    for (const t of this.trees) {
      const p = predictTree(t, x);
      for (let j = 0; j < 4; j++) s[j] += p[j];
    }
    return s.map((v) => v / this.trees.length) as Probs;
  }
}

/**
 * The prior: what the swarm assumes before it has its own data. A starting
 * guess from base rates (most launches die within the day; a pick that passes
 * every rule does better; quiet insider buying better still) — not a finding.
 */
export function priorTree(x: number[]): Probs {
  const [heat, virality, viability, insider] = x;
  if (viability < 50) return [0.7, 0.27, 0.025, 0.005];
  if (insider >= 65) return [0.35, 0.35, 0.18, 0.12];
  if (heat >= 55 && virality >= 45) return viability >= 80 ? [0.3, 0.42, 0.17, 0.11] : [0.36, 0.4, 0.15, 0.09];
  if (heat >= 40) return [0.45, 0.43, 0.09, 0.03];
  return [0.55, 0.4, 0.04, 0.01];
}

/** how many followed coins it takes for the learned forest to count as much as the prior */
export const PRIOR_WEIGHT = 60;

export interface Odds {
  probs: Probs;
  /** P(reaches 2× or more), P(5× or more), P(dies) */
  p2: number;
  p5: number;
  pDead: number;
  /** what a trade is expected to come back as, fees out (1 = break even) */
  expMult: number;
  /** 0–1: how much of the answer is the forest's own learning rather than the prior */
  trust: number;
}

/** The odds for a coin: the learned forest blended with the prior by how much data it has. */
export function oddsOf(x: number[], forest: Forest | null): Odds {
  const prior = priorTree(x);
  const trust = forest && forest.size ? forest.stats.n / (forest.stats.n + PRIOR_WEIGHT) : 0;
  const learned = forest && forest.size ? forest.predict(x) : prior;
  const probs = prior.map((p, j) => (1 - trust) * p + trust * learned[j]) as Probs;
  const expMult = probs.reduce((a, p, j) => a + p * PAYOFF[j], 0) - COSTS;
  return { probs, p2: probs[2] + probs[3], p5: probs[3], pDead: probs[0], expMult, trust };
}

/** The class a followed coin ended in. */
export function classOf(peak: number, last: number, lost = false): number {
  if (peak >= 5) return 3;
  if (peak >= 2) return 2;
  if (last <= 0.2 || lost) return 0;
  return 1;
}
