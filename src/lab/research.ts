// The Strategy Lab's research run: from a library of published rules to a
// ranked shortlist with an honest verdict on each.
//
//   1. split each coin's history: the first part trains and selects ("in
//      sample"), the last part is never looked at until the end ("out of
//      sample")
//   2. the library, as published: every rule over its parameter grid, in
//      sample, so the papers can be compared on the same data
//   3. mix and match: the best rules combined with filters from other papers
//      and different exits — hundreds of new strategies, still in sample
//   4. the finalists meet the out-of-sample data. Each is judged by its
//      Sharpe there, the Newey–West t-statistic, the deflated Sharpe ratio
//      for the number of strategies tried, a random-entry Monte Carlo null,
//      a trade-sequence Monte Carlo, a regression on buy-and-hold (is it more
//      than market beta?), and — for the group — the probability of backtest
//      overfitting. A random forest learns which of its signals to skip
//      (meta-labelling) and is kept only if it helps out of sample.
//   5. the top five, each with a verdict: an edge, promising, or no edge.
//
// Every strategy runs on all coins with the same rules: a rule that only works
// on one coin is more likely luck.
import { backtest, COSTS, type BTResult, type Costs, type StrategySpec, type Trade } from './backtest';
import { barsPerYear, ctxOf, EXIT_DEFAULT, features, FEATURES, FILTER_MAP, FILTERS, gridOf, SIGNAL_MAP, SIGNALS, type Ctx, type ExitSpec, type Market, type Params, type SignalDef } from './library';
import { fitForest, predictForest, regress, rngOf, type ForestModel } from './ml';
import { deflatedSharpe, monteCarlo, pbo, perf, randomEntryTest, type MonteCarlo, type Perf } from './stats';

export interface ResearchCfg {
  /** share of each coin's history used for training and selection */
  isShare: number;
  /** how many mix-and-match strategies to try */
  combos: number;
  /** how many go on to the out-of-sample test */
  finalists: number;
  top: number;
  /** fewest trades (all coins together) to count */
  minTrades: number;
  costs: Costs;
  sides: 'both' | 'long';
  /** try a random-forest meta-labeller on each finalist */
  meta: boolean;
  seed: number;
}
export const RESEARCH_DEFAULTS: ResearchCfg = { isShare: 0.7, combos: 400, finalists: 24, top: 5, minTrades: 30, costs: COSTS, sides: 'both', meta: true, seed: 42 };

export type Verdict = 'edge' | 'promising' | 'no edge';

export interface MetaInfo {
  used: boolean;
  threshold: number;
  oosSharpeBefore: number;
  oosSharpeAfter: number;
  tradesAfter: number;
  oob: number | null;
  base: number;
  importance: [string, number][];
  model: ForestModel | null;
}

export interface Ranked {
  rank: number;
  spec: StrategySpec;
  /** the rules in words */
  rules: string[];
  papers: string[];
  rationale: string[];
  family: string;
  is: Perf;
  oos: Perf;
  perCoin: { coin: string; oos: Perf }[];
  dsr: number;
  reg: { alphaAnn: number; beta: number; tAlpha: number; r2: number };
  mc: MonteCarlo | null;
  nullTest: { p: number; actual: number; nullMean: number } | null;
  meta: MetaInfo | null;
  /** equity of the strategy and of buy-and-hold (equal weight across coins), with the split marked */
  curve: { t: number; eq: number; bh: number }[];
  split: number;
  verdict: Verdict;
  checks: { name: string; pass: boolean; value: string }[];
  score: number;
}

export interface LibraryRow {
  id: string;
  name: string;
  family: string;
  papers: string[];
  params: Params;
  is: Perf | null;
  oos: Perf | null;
  tried: number;
  skipped?: string;
}

export interface ResearchResult {
  at: number;
  tfH: number;
  markets: { coin: string; bars: number; from: number; to: number; split: number; funding: boolean }[];
  trials: number;
  library: LibraryRow[];
  top: Ranked[];
  pbo: number | null;
  notes: string[];
  cfg: ResearchCfg;
}

export interface Progress {
  stage: string;
  done: number;
  total: number;
}

// ---------- running one strategy on all coins ----------

interface Run {
  per: { m: Market; c: Ctx; bt: BTResult }[];
  rets: Float64Array;
  times: number[];
  trades: Trade[];
  exposure: number;
}

/** average the coins' bar returns by time (an equal-weight portfolio of the strategy on each coin) */
function pool(per: { bt: BTResult }[]): { rets: Float64Array; times: number[] } {
  const acc = new Map<number, [number, number]>();
  for (const { bt } of per)
    for (let i = 0; i < bt.rets.length; i++) {
      const t = bt.times[i];
      if (!t) continue;
      const a = acc.get(t) ?? [0, 0];
      a[0] += bt.rets[i];
      a[1]++;
      acc.set(t, a);
    }
  const times = [...acc.keys()].sort((a, b) => a - b);
  return { rets: Float64Array.from(times, (t) => acc.get(t)![0] / acc.get(t)![1]), times };
}

function runAll(ctxs: Ctx[], spec: StrategySpec, part: 'is' | 'oos' | 'all', costs: Costs, gate?: (c: Ctx, i: number, side: 1 | -1) => boolean): Run {
  const per = ctxs.map((c) => {
    const n = c.m.bars.length;
    const from = part === 'oos' ? c.trainEnd : 50;
    const to = part === 'is' ? c.trainEnd : n;
    return { m: c.m, c, bt: backtest(c, spec, from, to, costs, gate ? (i, s) => gate(c, i, s) : undefined) };
  });
  const p = pool(per);
  return { per, ...p, trades: per.flatMap((x) => x.bt.trades), exposure: per.reduce((a, x) => a + x.bt.exposure, 0) / (per.length || 1) };
}

const keyOf = (s: StrategySpec) => JSON.stringify([s.signal, s.filters, s.exit, s.sides]);

function describeExit(e: ExitSpec, tfH: number): string {
  const parts = [`stop ${e.stopAtr} ATR`];
  if (e.targetR > 0) parts.push(`target ${e.targetR}R`);
  if (e.trailAtr > 0) parts.push(`trail ${e.trailAtr} ATR from +1R`);
  const h = e.maxBars * tfH;
  parts.push(`close after ${h >= 48 ? `${Math.round(h / 24)} days` : `${h} hours`}`);
  if (e.onFlip) parts.push('an opposite signal closes it');
  return parts.join(', ');
}

export function rulesOf(s: StrategySpec, tfH: number): string[] {
  const sig = SIGNAL_MAP[s.signal.id];
  return [
    `Entry: ${sig.describe(s.signal.p)}${s.sides === 'long' ? ' (longs only)' : s.sides === 'short' ? ' (shorts only)' : ''}`,
    ...s.filters.map((f) => `Filter: ${FILTER_MAP[f.id].describe(f.p)}`),
    `Exit: ${describeExit(s.exit, tfH)}`,
  ];
}

export function nameOf(s: StrategySpec): string {
  const sig = SIGNAL_MAP[s.signal.id];
  const f = s.filters.map((x) => FILTER_MAP[x.id].name.split(' ')[0].toLowerCase());
  return f.length ? `${sig.name} + ${f.join(' + ')}` : sig.name;
}

// ---------- the run ----------

export async function research(markets: Market[], cfg0: Partial<ResearchCfg> = {}, onProgress?: (p: Progress) => void): Promise<ResearchResult> {
  const cfg = { ...RESEARCH_DEFAULTS, ...cfg0 };
  const notes: string[] = [];
  const ms = markets.filter((m) => m.bars.length >= 600);
  if (!ms.length) throw new Error('not enough history: each coin needs at least 600 candles');
  if (ms.length < markets.length) notes.push(`skipped ${markets.length - ms.length} coin(s) with fewer than 600 candles`);
  const tfH = ms[0].tfH;
  const bpy = barsPerYear(tfH);
  const ctxs = ms.map((m, k) => ctxOf(m, Math.floor(m.bars.length * cfg.isShare), cfg.seed + k));
  const hasFunding = ms.some((m) => m.funding && m.funding.some((x) => x !== 0));
  if (!hasFunding) notes.push('no funding history: the carry signal and the crowding filter were skipped');
  const usable = (s: SignalDef) => (s.needsFunding && !hasFunding ? 'needs funding history' : s.intraday && tfH >= 24 ? 'needs bars shorter than a day' : null);
  const filters = FILTERS.filter((f) => !(f.needsFunding && !hasFunding));
  const rnd = rngOf(cfg.seed);
  const tick = async (p: Progress) => {
    onProgress?.(p);
    // let the host breathe (and a worker post its messages)
    if (p.done % 8 === 0) await new Promise((r) => setTimeout(r, 0));
  };

  const trials = new Map<string, { spec: StrategySpec; is: Perf; score: number }>();
  const srBars: number[] = [];
  const evalIS = (spec: StrategySpec) => {
    const k = keyOf(spec);
    const had = trials.get(k);
    if (had) return had;
    const r = runAll(ctxs, spec, 'is', cfg.costs);
    const p = perf(r.rets, r.trades, bpy, r.exposure);
    // the same rules on every coin: reward consistency, not one lucky coin
    const coinsUp = r.per.filter((x) => x.bt.rets.reduce((a, b) => a + b, 0) > 0).length / r.per.length;
    const score = p.trades < cfg.minTrades ? -Infinity : p.sharpe * (0.5 + 0.5 * coinsUp);
    const t = { spec, is: p, score };
    trials.set(k, t);
    srBars.push(p.srBar);
    return t;
  };
  const exitFor = (sig: SignalDef, over: Partial<ExitSpec> = {}): ExitSpec => {
    const e = { ...EXIT_DEFAULT, ...sig.exit, ...over };
    return { ...e, maxBars: Math.max(1, Math.round((e.maxBars * 1) / tfH)) };
  };

  // 2) the library as published
  const library: LibraryRow[] = [];
  const baseTotal = SIGNALS.reduce((a, s) => a + Math.min(12, gridOf(s.grid).length), 0);
  let done = 0;
  const best: { sig: SignalDef; spec: StrategySpec; score: number }[] = [];
  for (const sig of SIGNALS) {
    const why = usable(sig);
    if (why) {
      library.push({ id: sig.id, name: sig.name, family: sig.family, papers: sig.papers, params: {}, is: null, oos: null, tried: 0, skipped: why });
      continue;
    }
    let grid = gridOf(sig.grid);
    if (grid.length > 12) grid = grid.filter((_, i) => i % Math.ceil(grid.length / 12) === 0);
    let top: { spec: StrategySpec; is: Perf; score: number } | null = null;
    for (const p of grid) {
      const spec: StrategySpec = { name: sig.name, signal: { id: sig.id, p }, filters: [], exit: exitFor(sig), sides: cfg.sides };
      const t = evalIS(spec);
      if (!top || t.score > top.score) top = t;
      await tick({ stage: `Testing the library: ${sig.name}`, done: ++done, total: baseTotal });
    }
    if (!top) continue;
    const oosRun = runAll(ctxs, top.spec, 'oos', cfg.costs);
    library.push({ id: sig.id, name: sig.name, family: sig.family, papers: sig.papers, params: top.spec.signal.p, is: top.is, oos: perf(oosRun.rets, oosRun.trades, bpy, oosRun.exposure), tried: grid.length });
    for (const t of [...trials.values()].filter((x) => x.spec.signal.id === sig.id).sort((a, b) => b.score - a.score).slice(0, 2)) best.push({ sig, spec: t.spec, score: t.score });
  }

  // 3) mix and match: the strongest rules with other papers' filters and exits
  const seeds = best.filter((b) => Number.isFinite(b.score)).sort((a, b) => b.score - a.score).slice(0, 10);
  if (!seeds.length) notes.push('no library rule traded often enough in sample to build on');
  const stops = [1.5, 2, 3];
  const targets = [0, 1.5, 2, 3];
  const trails = [0, 2, 3];
  const holds = [12, 24, 72, 168, 480];
  for (let k = 0; k < cfg.combos && seeds.length; k++) {
    const s = seeds[Math.floor(rnd() * seeds.length)];
    const nf = Math.floor(rnd() * 3);
    const fs: StrategySpec['filters'] = [];
    for (let j = 0; j < nf; j++) {
      const f = filters[Math.floor(rnd() * filters.length)];
      if (fs.some((x) => x.id === f.id)) continue;
      const g = gridOf(f.grid);
      fs.push({ id: f.id, p: g[Math.floor(rnd() * g.length)] });
    }
    const exit = exitFor(s.sig, {
      stopAtr: stops[Math.floor(rnd() * stops.length)],
      targetR: targets[Math.floor(rnd() * targets.length)],
      trailAtr: trails[Math.floor(rnd() * trails.length)],
      maxBars: holds[Math.floor(rnd() * holds.length)],
      onFlip: rnd() < 0.5,
    });
    const spec: StrategySpec = { name: '', signal: s.spec.signal, filters: fs, exit, sides: cfg.sides };
    spec.name = nameOf(spec);
    evalIS(spec);
    await tick({ stage: 'Mixing and matching rules', done: k + 1, total: cfg.combos });
  }

  // 4) the finalists meet the data they have never seen
  const all = [...trials.values()].filter((t) => Number.isFinite(t.score));
  const nTrials = trials.size;
  const perSignal = new Map<string, number>();
  const finalists = all
    .sort((a, b) => b.score - a.score)
    .filter((t) => {
      // keep the shortlist varied: at most 4 per rule
      const n = perSignal.get(t.spec.signal.id) ?? 0;
      perSignal.set(t.spec.signal.id, n + 1);
      return n < 4;
    })
    .slice(0, cfg.finalists);

  const logCloses = ctxs.map((c) => Float64Array.from(c.m.bars, (b) => Math.log(b.close)));
  const bhAll = pool(ctxs.map((c) => ({ bt: bhReturns(c, 50, c.m.bars.length) })));
  const bhOos = pool(ctxs.map((c) => ({ bt: bhReturns(c, c.trainEnd, c.m.bars.length) })));
  const ranked: Ranked[] = [];
  const blocks: number[][] = [];
  let fi = 0;
  for (const t of finalists) {
    await tick({ stage: 'Testing the finalists out of sample', done: ++fi, total: finalists.length });
    const spec = { ...t.spec, name: t.spec.name || nameOf(t.spec) };
    let oosRun = runAll(ctxs, spec, 'oos', cfg.costs);
    let oos = perf(oosRun.rets, oosRun.trades, bpy, oosRun.exposure);
    const fullRun = runAll(ctxs, spec, 'all', cfg.costs);
    // per-block mean returns over the whole period, for the overfitting estimate
    const S = 10;
    const len = fullRun.rets.length;
    blocks.push(Array.from({ length: S }, (_, s) => {
      const a = Math.floor((s * len) / S);
      const b = Math.floor(((s + 1) * len) / S);
      let sum = 0;
      for (let i = a; i < b; i++) sum += fullRun.rets[i];
      return b > a ? sum / (b - a) : 0;
    }));

    // meta-labelling: a forest learns, in sample, which signals to skip
    let meta: MetaInfo | null = null;
    if (cfg.meta) {
      const isRun = runAll(ctxs, spec, 'is', cfg.costs);
      const X: number[][] = [];
      const y: number[] = [];
      for (const { c, bt } of isRun.per) {
        const F = features(c);
        for (const tr of bt.trades) {
          const row = [...F[tr.sig], tr.side];
          if (!row.every(Number.isFinite)) continue;
          X.push(row);
          y.push(tr.r > 0 ? 1 : 0);
        }
      }
      if (X.length >= 40) {
        const model = fitForest(X, y, { trees: 60, maxDepth: 4, minLeaf: Math.max(5, Math.floor(X.length / 40)), seed: cfg.seed });
        const threshold = 0.5;
        const gate = (c: Ctx, i: number, side: 1 | -1) => {
          const row = [...features(c)[i], side];
          return !row.every(Number.isFinite) || predictForest(model, row) >= threshold;
        };
        const gated = runAll(ctxs, spec, 'oos', cfg.costs, gate);
        const after = perf(gated.rets, gated.trades, bpy, gated.exposure);
        const used = after.sharpe > oos.sharpe + 0.1 && after.trades >= Math.max(10, oos.trades * 0.3);
        meta = {
          used,
          threshold,
          oosSharpeBefore: oos.sharpe,
          oosSharpeAfter: after.sharpe,
          tradesAfter: after.trades,
          oob: model.oob,
          base: model.base,
          importance: [...FEATURES, 'side'].map((f, k) => [f, model.importance[k]] as [string, number]).sort((a, b) => b[1] - a[1]).slice(0, 6),
          model: used ? model : null,
        };
        if (used) {
          oosRun = gated;
          oos = after;
        }
      }
    }

    // deflated for the choice made out of sample: the best of the finalists, against the
    // spread of Sharpe ratios luck alone gives over this many bars (Bailey & López de Prado 2014).
    // The in-sample search does not bias these data: the finalists never saw them.
    const dsr = deflatedSharpe(oos, finalists.length, (1 + 0.5 * oos.srBar ** 2) / Math.max(1, oos.bars));
    // is it more than the market? regress its returns on buy-and-hold's
    const bhMap = new Map(bhOos.times.map((tt, i) => [tt, bhOos.rets[i]]));
    const xs: number[] = [];
    const ys: number[] = [];
    oosRun.times.forEach((tt, i) => {
      const x = bhMap.get(tt);
      if (x !== undefined) {
        xs.push(x);
        ys.push(oosRun.rets[i]);
      }
    });
    const rg = regress(ys, xs);
    const mc = monteCarlo(oosRun.trades.map((x) => x.r), 2000, 0.01, cfg.seed);
    const nullTest = randomEntryTest(
      oosRun.per.map((x, k) => ({ logClose: logCloses[k], trades: x.bt.trades, from: x.c.trainEnd, to: x.c.m.bars.length })),
      (2 * (cfg.costs.feeBps + cfg.costs.slipBps)) / 1e4,
      500,
      cfg.seed,
    );
    const checks = [
      { name: 'Out-of-sample Sharpe above 0.5', pass: oos.sharpe > 0.5, value: oos.sharpe.toFixed(2) },
      { name: 'Newey–West t-statistic above 2', pass: oos.t > 2, value: oos.t.toFixed(2) },
      { name: 'Deflated Sharpe above 95 %', pass: dsr > 0.95, value: `${(dsr * 100).toFixed(0)} %` },
      { name: 'Beats random entries (p < 5 %)', pass: !!nullTest && nullTest.p < 0.05, value: nullTest ? `p = ${nullTest.p.toFixed(3)}` : 'too few trades' },
      { name: 'Monte Carlo: under 20 % chance of a loss', pass: !!mc && mc.pLoss < 0.2, value: mc ? `${(mc.pLoss * 100).toFixed(0)} %` : 'too few trades' },
      { name: 'At least 20 out-of-sample trades', pass: oos.trades >= 20, value: String(oos.trades) },
      { name: 'Positive alpha over buy-and-hold', pass: rg.alpha > 0 && rg.tAlpha > 1.5, value: `t = ${rg.tAlpha.toFixed(2)}` },
    ];
    const passes = checks.filter((c) => c.pass).length;
    const verdict: Verdict = passes >= 6 && checks[0].pass && checks[2].pass ? 'edge' : oos.sharpe > 0.5 && oos.t > 1.5 && dsr > 0.5 ? 'promising' : 'no edge';
    const sig = SIGNAL_MAP[spec.signal.id];
    const papers = [...new Set([...sig.papers, ...spec.filters.flatMap((f) => FILTER_MAP[f.id].papers)])];
    const curve = equityCurve(fullRun, bhAll);
    ranked.push({
      rank: 0,
      spec: meta?.used && meta.model ? { ...spec, meta: { model: meta.model, threshold: meta.threshold } } : spec,
      rules: rulesOf(spec, tfH),
      papers,
      rationale: [sig.rationale, ...spec.filters.map((f) => FILTER_MAP[f.id].rationale)],
      family: sig.family,
      is: t.is,
      oos,
      perCoin: oosRun.per.map((x) => ({ coin: x.m.coin, oos: perf(x.bt.rets, x.bt.trades, bpy, x.bt.exposure) })),
      dsr,
      reg: { alphaAnn: rg.alpha * bpy, beta: rg.beta, tAlpha: rg.tAlpha, r2: rg.r2 },
      mc,
      nullTest,
      meta,
      curve,
      split: Math.min(...ctxs.map((c) => c.m.bars[c.trainEnd]?.time ?? Infinity)),
      verdict,
      checks,
      score: oos.sharpe * Math.min(1, oos.trades / 20) * (0.5 + 0.5 * dsr) + passes * 0.05,
    });
  }
  const order: Record<Verdict, number> = { edge: 0, promising: 1, 'no edge': 2 };
  const top = ranked.sort((a, b) => order[a.verdict] - order[b.verdict] || b.score - a.score).slice(0, cfg.top);
  top.forEach((r, i) => (r.rank = i + 1));
  if (!top.some((r) => r.verdict === 'edge')) notes.push('No strategy passed every test out of sample. The top five are the best found, but none has a proven edge yet — more history, other coins or another timeframe may change that.');
  return {
    at: Date.now(),
    tfH,
    markets: ctxs.map((c) => ({ coin: c.m.coin, bars: c.m.bars.length, from: c.m.bars[0].time, to: c.m.bars[c.m.bars.length - 1].time, split: c.m.bars[c.trainEnd]?.time ?? 0, funding: !!c.m.funding })),
    trials: nTrials,
    library,
    top,
    pbo: pbo(blocks),
    notes,
    cfg,
  };
}

function bhReturns(c: Ctx, from: number, to: number): BTResult {
  const n = Math.max(0, to - from);
  const rets = new Float64Array(n);
  const times = new Float64Array(n);
  for (let i = Math.max(from, 1); i < to; i++) {
    rets[i - from] = c.m.bars[i].close / c.m.bars[i - 1].close - 1;
    times[i - from] = c.m.bars[i].time;
  }
  return { trades: [], rets, times, exposure: 1 };
}

function equityCurve(run: { rets: Float64Array; times: number[] }, bh: { rets: Float64Array; times: number[] }) {
  const bhMap = new Map(bh.times.map((t, i) => [t, bh.rets[i]]));
  const pts: { t: number; eq: number; bh: number }[] = [];
  let eq = 1;
  let b = 1;
  const step = Math.max(1, Math.floor(run.rets.length / 300));
  run.times.forEach((t, i) => {
    eq *= 1 + run.rets[i];
    b *= 1 + (bhMap.get(t) ?? 0);
    if (i % step === 0 || i === run.rets.length - 1) pts.push({ t, eq, bh: b });
  });
  return pts;
}

/** one strategy's full test, on demand (the Backtest screen) */
export function evaluate(markets: Market[], spec: StrategySpec, isShare = 0.7, costs: Costs = COSTS) {
  const ctxs = markets.map((m, k) => ctxOf(m, Math.floor(m.bars.length * isShare), 42 + k));
  const bpy = barsPerYear(markets[0].tfH);
  const is = runAll(ctxs, spec, 'is', costs);
  const oos = runAll(ctxs, spec, 'oos', costs);
  const full = runAll(ctxs, spec, 'all', costs);
  const bhAll = pool(ctxs.map((c) => ({ bt: bhReturns(c, 50, c.m.bars.length) })));
  return {
    is: perf(is.rets, is.trades, bpy, is.exposure),
    oos: perf(oos.rets, oos.trades, bpy, oos.exposure),
    curve: equityCurve(full, bhAll),
    trades: oos.trades.length,
    mc: monteCarlo(oos.trades.map((t) => t.r)),
  };
}

