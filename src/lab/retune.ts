// The re-tuner: a deployed strategy's settings, checked again on the latest candles.
//
// Each setting of each rule is tried at the other values of its published grid, one change at
// a time, on the recent history before the newest stretch. The choice is the centre of a
// stable area — the version whose own result and its neighbours' are best together — never the
// single best peak, which is usually luck. The newest stretch (the last 15 %) is kept apart:
// the new settings are only offered if they beat the current ones there too, without a much
// deeper drop. Pure: runs in the Lab's worker thread.
import { backtest, COSTS, type Costs, type RuleRef, type StrategySpec } from './backtest';
import { barsPerYear, ctxOf, FILTER_MAP, SIGNAL_MAP, type Market, type Params } from './library';
import { withBench } from './research';
import { perf } from './stats';

export interface RetuneStat {
  sharpe: number;
  ret: number;
  maxDD: number;
  trades: number;
}
export interface RetuneResult {
  changed: boolean;
  /** why it was or was not changed, in words */
  why: string;
  /** on the newest stretch neither version was chosen on */
  current: RetuneStat | null;
  proposed?: RetuneStat;
  spec?: StrategySpec;
  /** each change, e.g. "Ride the trend: look-back 72 → 120" */
  changes?: string[];
  tried: number;
}

type Slot = { rule: number; key: string; grid: number[]; at: number };

const rulesOf = (s: StrategySpec): RuleRef[] => [s.signal, ...(s.also ?? []), ...s.filters];
const defOf = (s: StrategySpec, i: number) => (i <= (s.also?.length ?? 0) ? SIGNAL_MAP[rulesOf(s)[i].id] : FILTER_MAP[rulesOf(s)[i].id]);

function withParam(s: StrategySpec, rule: number, key: string, v: number): StrategySpec {
  const rs = rulesOf(s).map((r, i) => (i === rule ? { ...r, p: { ...r.p, [key]: v } as Params } : r));
  const nA = s.also?.length ?? 0;
  return { ...s, signal: rs[0], also: s.also ? rs.slice(1, 1 + nA) : undefined, filters: rs.slice(1 + nA) };
}

export function retune(markets: Market[], spec: StrategySpec, o: { hold?: number; costs?: Costs; maxTries?: number } = {}): RetuneResult {
  const hold = o.hold ?? 0.15;
  const costs = o.costs ?? COSTS;
  const base = withBench(markets).filter((m) => m.bars.length >= 400);
  if (!base.length) return { changed: false, why: 'not enough candles to check it', current: null, tried: 0 };
  // the rules learn (where they learn) on the first part; settings are chosen on the stretch before the newest
  const ctxs = base.map((m, k) => ctxOf(m, Math.floor(m.bars.length * 0.35), 42 + k));
  const bpy = barsPerYear(base[0].tfH);
  const run = (s: StrategySpec, part: 'choose' | 'hold'): RetuneStat => {
    const per = ctxs.map((c) => {
      const n = c.m.bars.length;
      const h = Math.floor(n * (1 - hold));
      return part === 'choose' ? backtest(c, s, c.trainEnd, h, costs) : backtest(c, s, h, n, costs);
    });
    const acc = new Map<number, [number, number]>();
    for (const bt of per)
      for (let i = 0; i < bt.rets.length; i++) {
        const a = acc.get(bt.times[i]) ?? [0, 0];
        a[0] += bt.rets[i];
        a[1]++;
        acc.set(bt.times[i], a);
      }
    const times = [...acc.keys()].filter(Boolean).sort((a, b) => a - b);
    const rets = times.map((t) => acc.get(t)![0] / acc.get(t)![1]);
    const trades = per.flatMap((b) => b.trades);
    const p = perf(rets, trades, bpy, 0);
    return { sharpe: Number.isFinite(p.sharpe) ? p.sharpe : 0, ret: p.totalReturn, maxDD: p.maxDD, trades: trades.length };
  };
  // the settings that can move: every rule's parameters that have a grid
  const slots: Slot[] = [];
  rulesOf(spec).forEach((r, i) => {
    const def = defOf(spec, i);
    if (!def) return;
    for (const [key, grid] of Object.entries(def.grid as Record<string, number[]>)) {
      if (grid.length < 2 || !(key in r.p)) continue;
      const at = grid.indexOf(r.p[key]);
      slots.push({ rule: i, key, grid, at });
    }
  });
  const cur = run(spec, 'choose');
  if (!slots.length) return { changed: false, why: 'it has no settings to tune', current: run(spec, 'hold'), tried: 1 };
  // one change at a time, each grid value
  type V = { slot: number; gi: number; spec: StrategySpec; st: RetuneStat };
  const vs: V[] = [];
  const max = o.maxTries ?? 48;
  for (let si = 0; si < slots.length && vs.length < max; si++) {
    const sl = slots[si];
    sl.grid.forEach((v, gi) => {
      if (gi === sl.at || vs.length >= max) return;
      const s = withParam(spec, sl.rule, sl.key, v);
      vs.push({ slot: si, gi, spec: s, st: run(s, 'choose') });
    });
  }
  // stability: a version's result with its neighbours' (one grid step either side on the same setting, or the current one)
  const sharpeAt = (si: number, gi: number) => (gi === slots[si].at ? cur.sharpe : vs.find((v) => v.slot === si && v.gi === gi)?.st.sharpe);
  const robust = (v: V) => {
    const xs = [v.st.sharpe, sharpeAt(v.slot, v.gi - 1), sharpeAt(v.slot, v.gi + 1)].filter((x): x is number => Number.isFinite(x));
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  const curRobust = (() => {
    const xs = [cur.sharpe, ...slots.flatMap((sl, si) => [sharpeAt(si, sl.at - 1), sharpeAt(si, sl.at + 1)])].filter((x): x is number => Number.isFinite(x as number));
    return xs.reduce((a, b) => a + (b as number), 0) / xs.length;
  })();
  const best = vs.filter((v) => v.st.trades >= 10).sort((a, b) => robust(b) - robust(a))[0];
  const curHold = run(spec, 'hold');
  if (!best || robust(best) <= curRobust + 0.1) return { changed: false, why: 'its current settings are still the steadiest on the latest candles', current: curHold, tried: vs.length + 1 };
  const newHold = run(best.spec, 'hold');
  const sl = slots[best.slot];
  const def = defOf(spec, sl.rule);
  const change = `${def?.name ?? rulesOf(spec)[sl.rule].id}: ${sl.key} ${sl.at >= 0 ? sl.grid[sl.at] : rulesOf(spec)[sl.rule].p[sl.key]} → ${sl.grid[best.gi]}`;
  const better = newHold.sharpe >= curHold.sharpe + 0.25 && newHold.ret > curHold.ret && newHold.maxDD <= Math.max(curHold.maxDD * 1.5, curHold.maxDD + 0.05) && newHold.trades >= 5;
  if (!better)
    return { changed: false, why: `a steadier setting (${change}) did not also do better on the newest candles, which neither was chosen on — the current settings stay`, current: curHold, proposed: newHold, tried: vs.length + 1 };
  return { changed: true, why: `steadier on the recent history and better on the newest candles, which neither was chosen on`, current: curHold, proposed: newHold, spec: best.spec, changes: [change], tried: vs.length + 1 };
}
