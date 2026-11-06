// Candle forecasting: what the next candle is likely to look like, and which
// inputs matter for it.
//
//   shape     each candle as numbers: body, wicks, where it closed in its range,
//             its range against the ATR, the gap from the last close, the run of
//             same-coloured candles, and classic patterns (engulfing, doji,
//             hammer / shooting star) — Nison (1991); tested on stocks by
//             Marshall, Young & Rose (2006) and Lu, Shiu & Liu (2012),
//             on price patterns by Caginalp & Laurent (1998)
//   direction a random forest's odds that the next candle closes up
//   range     ridge regressions of how far the next candle reaches above and
//             below the last close, with GARCH volatility among the inputs
//
// Trained on the bars before `trainEnd` and scored on the bars after it,
// against the base rate (direction) and against GARCH alone and last
// candle's range (range). Permutation importance — how much worse the
// forecast gets when one input is shuffled — says which inputs matter.
import { ctxOf, features, FEATURES, garchSigma, type Market } from './library';
import { fitForest, fitRidge, predictForest, predictRidge, rngOf, type ForestModel, type Ridge } from './ml';
export { CANDLE_FEATURES, candleShape } from './shape';

export interface CandleModel {
  dir: ForestModel;
  hi: Ridge;
  lo: Ridge;
}

export interface CandleEval {
  /** out-of-sample bars scored */
  n: number;
  /** direction: share called right, the base rate (always the commoner side), Brier scores and skill */
  hit: number;
  base: number;
  brier: number;
  brierBase: number;
  skill: number;
  /** range: mean absolute error of the next candle's high-to-low range (log), by method */
  rangeMae: { model: number; garch: number; naive: number };
  /** permutation importance: rise in Brier (direction) and in range error when each input is shuffled */
  importance: { feature: string; dir: number; range: number }[];
}

export interface NextCandle {
  /** the candle being forecast opens where the last one closed */
  open: number;
  high: number;
  low: number;
  /** a central guess for the close (odds-weighted typical move) */
  close: number;
  pUp: number;
  /** GARCH volatility of the next bar (log return) */
  sigma: number;
  time: number;
}

export interface CandleReport {
  coin: string;
  tfH: number;
  eval: CandleEval | null;
  next: NextCandle | null;
}

const finite = (r: ArrayLike<number>) => Array.prototype.every.call(r, Number.isFinite);

/** fit the candle models on bars before trainEnd and score them on the rest */
export function candleForecast(m: Market, trainEnd = Math.floor(m.bars.length * 0.7), seed = 9): CandleReport {
  const b = m.bars;
  const n = b.length;
  const c = ctxOf(m, trainEnd, seed);
  const X = features(c);
  const sig = garchSigma(c);
  const row = (i: number) => Array.from(X[i]);
  const tr: number[] = [];
  const te: number[] = [];
  for (let i = 1; i + 1 < n; i++) {
    if (!finite(X[i])) continue;
    if (i + 1 < trainEnd) tr.push(i);
    else if (i >= trainEnd) te.push(i);
  }
  if (tr.length < 200) return { coin: m.coin, tfH: m.tfH, eval: null, next: null };
  const step = Math.max(1, Math.floor(tr.length / 3000));
  const fitIdx = tr.filter((_, k) => k % step === 0);
  const up = (i: number) => (b[i + 1].close > b[i].close ? 1 : 0);
  const hiT = (i: number) => Math.log(b[i + 1].high / b[i].close);
  const loT = (i: number) => Math.log(b[i].close / b[i + 1].low);
  const model: CandleModel = {
    dir: fitForest(fitIdx.map(row), fitIdx.map(up), { trees: 40, maxDepth: 5, minLeaf: 20, seed }),
    hi: fitRidge(fitIdx.map(row), fitIdx.map(hiT), 0.01),
    lo: fitRidge(fitIdx.map(row), fitIdx.map(loT), 0.01),
  };
  // GARCH alone: the range is a calibrated multiple of next-bar volatility
  const kG = fitIdx.reduce((a, i) => a + hiT(i) + loT(i), 0) / Math.max(1e-12, fitIdx.reduce((a, i) => a + sig[i], 0));
  const pUpTrain = fitIdx.reduce((a, i) => a + up(i), 0) / fitIdx.length;

  let ev: CandleEval | null = null;
  if (te.length >= 50) {
    const score = (rows: number[][]) => {
      let br = 0;
      let hit = 0;
      let mae = 0;
      rows.forEach((x, k) => {
        const i = te[k];
        const p = predictForest(model.dir, x);
        const y = up(i);
        br += (p - y) ** 2;
        if ((p >= 0.5 ? 1 : 0) === y) hit++;
        mae += Math.abs(predictRidge(model.hi, x) + predictRidge(model.lo, x) - (hiT(i) + loT(i)));
      });
      return { brier: br / rows.length, hit: hit / rows.length, mae: mae / rows.length };
    };
    const base = te.map(row);
    const s0 = score(base);
    const yRate = te.reduce((a, i) => a + up(i), 0) / te.length;
    const brierBase = te.reduce((a, i) => a + (pUpTrain - up(i)) ** 2, 0) / te.length;
    let maeG = 0;
    let maeN = 0;
    for (const i of te) {
      const act = hiT(i) + loT(i);
      maeG += Math.abs(kG * sig[i] - act);
      maeN += Math.abs(Math.log(b[i].high / b[i].low) - act);
    }
    const rnd = rngOf(seed + 1);
    const names = [...FEATURES];
    const importance = names.map((feature, j) => {
      const col = base.map((x) => x[j]);
      for (let k = col.length - 1; k > 0; k--) {
        const r = Math.floor(rnd() * (k + 1));
        [col[k], col[r]] = [col[r], col[k]];
      }
      const s = score(base.map((x, k) => x.map((v, jj) => (jj === j ? col[k] : v))));
      return { feature, dir: s.brier - s0.brier, range: s.mae - s0.mae };
    });
    ev = {
      n: te.length,
      hit: s0.hit,
      base: Math.max(yRate, 1 - yRate),
      brier: s0.brier,
      brierBase,
      skill: brierBase > 0 ? 1 - s0.brier / brierBase : 0,
      rangeMae: { model: s0.mae, garch: maeG / te.length, naive: maeN / te.length },
      importance: importance.sort((a, z) => z.dir + z.range * 10 - (a.dir + a.range * 10)),
    };
  }

  // the next candle, from the last closed one
  let next: NextCandle | null = null;
  const last = n - 1;
  if (finite(X[last])) {
    const x = row(last);
    const pUp = predictForest(model.dir, x);
    const px = b[last].close;
    const hi = Math.max(0, predictRidge(model.hi, x));
    const lo = Math.max(0, predictRidge(model.lo, x));
    const move = Math.min(hi, lo) * 0.8;
    next = { open: px, high: px * Math.exp(hi), low: px * Math.exp(-lo), close: px * Math.exp((2 * pUp - 1) * move), pUp, sigma: sig[last], time: b[last].time + m.tfH * 3_600_000 };
  }
  return { coin: m.coin, tfH: m.tfH, eval: ev, next };
}
