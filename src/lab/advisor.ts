// The optimizer for a bot: read what a test showed, say it in words, list the
// one-step changes worth trying, and rank them once they have been measured.
//
// Nothing here looks at the unseen data to choose anything. The diagnosis
// (advise) reads how the trades went on the TRAINING years; the changes
// (variantsOf) are measured on a validation stretch inside the training years
// (research.ts scoreVariants); only a change the user applies is then tested
// on the unseen data — and every such test is counted, because each one makes
// it a little likelier that the best-looking version is luck.
import { buildSpec, checkFlow, FORECASTS, HOLDS, migrateFlow, MODELS, RISKS, SIDES, STOP_WIDTHS, STRATEGIES, STYLE_MAP, STYLES, TAKE_PROFIT, type Flow } from './flow';
import { EXIT_DEFAULT, FILTER_MAP, FILTERS, gridOf, SIGNAL_MAP, type Params } from './library';
import type { Diag, Periods, VariantScore } from './research';
import type { StrategySpec } from './backtest';

export interface Variant {
  id: string;
  /** what changes, in a few words */
  label: string;
  /** why it might help */
  why: string;
  /** which part of the bot it touches */
  kind: 'stop' | 'exit' | 'hold' | 'side' | 'filter' | 'opinion' | 'size' | 'pace' | 'setting' | 'join' | 'coins';
  flow: Flow;
}

const name = (xs: readonly { id: string; name: string }[], id: string) => xs.find((x) => x.id === id)?.name ?? id;
const coinsOf = (f: Flow) => f.coins.toUpperCase().split(/[\s,]+/).filter(Boolean);
const clashes = (f: Flow) => checkFlow(f).some((x) => x.tone === 'clash');

/** the one-step changes to a bot worth measuring (each differs from it in one thing, and none clashes) */
export function variantsOf(flow0: Flow, diag?: Diag | null): Variant[] {
  const f = migrateFlow(flow0 as Flow & Record<string, unknown>);
  const style = STYLE_MAP[f.style] ?? STYLE_MAP.swing;
  const out: Variant[] = [];
  const add = (id: string, kind: Variant['kind'], label: string, why: string, patch: Partial<Flow>) => {
    const flow = migrateFlow({ ...f, ...patch } as Flow & Record<string, unknown>);
    if (!clashes(flow)) out.push({ id, kind, label, why, flow });
  };
  // stops, profit taking, holding time, the opposite signal, the sides
  for (const w of STOP_WIDTHS) if (w.id !== f.stopWidth) add(`stop:${w.id}`, 'stop', w.name, w.id === 'wide' ? 'Fewer trades are shaken out by ordinary noise before the move comes.' : w.id === 'tight' ? 'Losers are cut sooner, so each loss is smaller.' : 'The style’s usual room.', { stopWidth: w.id });
  for (const t of TAKE_PROFIT) if (t.id !== f.takeProfit) add(`tp:${t.id}`, 'exit', t.name, t.trail ? 'Winners are allowed to run while the stop follows them.' : t.targetR ? 'Gains are banked at a fixed multiple of the risk instead of being given back.' : 'Trades end only on the stop, the time limit or an opposite signal.', { takeProfit: t.id });
  for (const h of HOLDS) if (h.id !== f.hold) add(`hold:${h.id}`, 'hold', h.name, h.k > 1 ? 'Trades that were still working when time ran out get to finish.' : 'Money is freed sooner from trades that are going nowhere.', { hold: h.id });
  add(`flip:${f.flip ? 'off' : 'on'}`, 'exit', f.flip ? 'Ignore opposite signals' : 'Exit on an opposite signal', f.flip ? 'Trades are not cut short by a brief change of mind.' : 'A trade is closed as soon as the strategy turns the other way.', { flip: !f.flip });
  for (const s of SIDES) if (s.id !== f.sides) add(`side:${s.id}`, 'side', s.name, s.id === 'long' ? 'Crypto has drifted up over time; short trades fight that drift.' : s.id === 'short' ? 'Only bets on falls.' : 'Both directions: more trades, and falls can pay too.', { sides: s.id });
  // market models: take one away, or add one
  for (const id of f.models) add(`model-:${id}`, 'filter', `Remove “${name(MODELS, id)}”`, 'A filter that removes good trades with the bad costs more than it saves.', { models: f.models.filter((x) => x !== id) });
  for (const m of MODELS) if (!f.models.includes(m.id) && f.models.length < 3) add(`model+:${m.id}`, 'filter', `Add “${m.name}”`, m.plain, { models: [...f.models, m.id] });
  // second opinions
  for (const id of f.forecasts) add(`fc-:${id}`, 'opinion', `Remove “${name(FORECASTS, id)}”`, 'One less condition: more trades.', { forecasts: f.forecasts.filter((x) => x !== id) });
  for (const fc of FORECASTS) if (!f.forecasts.includes(fc.id) && !f.strategies.includes(fc.same ?? '') && f.forecasts.length < 2) add(`fc+:${fc.id}`, 'opinion', `Add “${fc.name}”`, fc.plain, { forecasts: [...f.forecasts, fc.id] });
  // sizing and stops that follow volatility (Kelly is found from the bot's own trades by the test, so it is not tried here)
  for (const id of f.risks) if (id !== 'kelly') add(`risk-:${id}`, 'size', `Remove “${name(RISKS, id)}”`, 'Plain, equal-sized trades.', { risks: f.risks.filter((x) => x !== id) });
  for (const r of RISKS) {
    if (f.risks.includes(r.id) || r.id === 'kelly') continue;
    if (r.hedge && coinsOf(f).every((c) => c === 'BTC')) continue;
    if (r.sizing && f.risks.filter((id) => RISKS.find((x) => x.id === id)?.sizing).length >= 2) continue;
    add(`risk+:${r.id}`, 'size', `Add “${r.name}”`, r.plain, { risks: [...f.risks, r.id] });
  }
  // how several strategies are joined
  if (f.strategies.length > 1) for (const c of ['all', 'majority', 'any'] as const) if (c !== f.combine) add(`join:${c}`, 'join', c === 'all' ? 'All strategies must agree' : c === 'majority' ? 'A majority of the strategies' : 'Any one strategy', c === 'all' ? 'Fewer, better-confirmed trades.' : 'More trades from the same strategies.', { combine: c });
  // the pace, without changing the candles (so the same history serves)
  for (const s of STYLES) if (s.id !== f.style && s.tfH === style.tfH) add(`style:${s.id}`, 'pace', `Trade it as “${s.name.split(' — ')[0].toLowerCase()}” (${s.timeframe} candles, up to ${s.holdH >= 48 ? `${Math.round(s.holdH / 24)} days` : `${s.holdH} hours`})`, 'The same idea at a different pace: longer look-backs and holds, or shorter.', { style: s.id });
  // each strategy's own settings: the next value up and down its published grid
  for (const id of f.strategies) {
    const opt = STRATEGIES.find((s) => s.id === id);
    const sig = opt && SIGNAL_MAP[opt.signal];
    if (!opt || !sig) continue;
    const now: Params = { ...opt.params(style), ...(f.tunes?.[`strategy:${id}`] ?? {}) };
    for (const [key, grid] of Object.entries(sig.grid)) {
      if (grid.length < 2 || !(key in now)) continue;
      const sorted = [...grid].sort((a, b) => a - b);
      const below = sorted.filter((v) => v < now[key]).pop();
      const above = sorted.find((v) => v > now[key]);
      for (const v of [below, above]) {
        if (v === undefined) continue;
        const p = { ...now, [key]: v };
        add(`set:${id}:${key}:${v}`, 'setting', `${opt.name}: ${sig.describe(p)}`, `Its ${key === 'lookback' || key === 'n' || key === 'window' ? 'look-back' : key === 'k' || key === 'band' || key === 'edge' ? 'threshold' : 'setting'} moved one step ${v > now[key] ? 'up' : 'down'} the values the research used.`, { tunes: { ...(f.tunes ?? {}), [`strategy:${id}`]: { ...(f.tunes?.[`strategy:${id}`] ?? {}), [key]: v } } });
      }
    }
  }
  // a coin that lost on the training years while the others made money
  if (diag && diag.coins.length > 1) {
    const good = diag.coins.filter((c) => c.sharpe > 0).length;
    for (const c of diag.coins) if (c.sharpe < 0 && good >= 1 && coinsOf(f).length > 1 && !(c.coin === 'BTC' && (f.risks.includes('hedged') || f.strategies.some((s) => STRATEGIES.find((o) => o.id === s)?.needsBtc)))) add(`coin-:${c.coin}`, 'coins', `Leave ${c.coin} out`, `${c.coin} lost with these rules on the training years while other coins made money.`, { coins: coinsOf(f).filter((x) => x !== c.coin).join(' ') });
  }
  return out;
}

/** the specs the scorer measures: the bot as it is (id "base") and every variant on the same candles */
export function specsOf(flow: Flow, variants: Variant[]): { id: string; spec: StrategySpec }[] {
  const base = buildSpec(flow);
  return [{ id: 'base', spec: base.spec }, ...variants.filter((v) => buildSpec(v.flow).timeframe === base.timeframe).map((v) => ({ id: v.id, spec: buildSpec(v.flow).spec }))];
}

/** a one-step change to a strategy that was not built in the bot builder (a research result) */
export interface SpecVariant extends AnyVariant {
  spec: StrategySpec;
}

/** the one-step changes to any strategy: its rule's settings, its exits, its sides, each filter taken away or added, its sizing */
export function specVariants(spec: StrategySpec): SpecVariant[] {
  const out: SpecVariant[] = [];
  const ex = { ...EXIT_DEFAULT, ...spec.exit };
  const add = (id: string, kind: Variant['kind'], label: string, why: string, patch: Partial<StrategySpec>) => out.push({ id, kind, label, why, spec: { ...spec, ...patch } });
  const sig = SIGNAL_MAP[spec.signal.id];
  if (sig)
    for (const [key, grid] of Object.entries(sig.grid)) {
      if (grid.length < 2 || !(key in spec.signal.p)) continue;
      const sorted = [...grid].sort((a, b) => a - b);
      for (const v of [sorted.filter((x) => x < spec.signal.p[key]).pop(), sorted.find((x) => x > spec.signal.p[key])]) {
        if (v === undefined) continue;
        const p = { ...spec.signal.p, [key]: v };
        add(`set:${key}:${v}`, 'setting', sig.describe(p), `The rule’s ${key} one step ${v > spec.signal.p[key] ? 'up' : 'down'} the values the research used.`, { signal: { id: spec.signal.id, p } });
      }
    }
  const r1 = (x: number) => Math.round(x * 10) / 10;
  add('stop:wide', 'stop', `Wider stop (${r1(ex.stopAtr * 1.5)} ATR)`, 'Fewer trades are shaken out by ordinary noise.', { exit: { ...ex, stopAtr: r1(ex.stopAtr * 1.5), trailAtr: ex.trailAtr ? Math.max(1.5, r1(ex.stopAtr * 1.5)) : 0 } });
  add('stop:tight', 'stop', `Tighter stop (${r1(ex.stopAtr * 0.7)} ATR)`, 'Losers are cut sooner.', { exit: { ...ex, stopAtr: r1(ex.stopAtr * 0.7) } });
  if (!ex.stopVol) add('stop:garch', 'stop', 'Stops that follow GARCH volatility', 'The stop widens before a storm, not after.', { exit: { ...ex, stopVol: Math.max(2, Math.round(ex.stopAtr * 1.3)) } });
  else add('stop:atr', 'stop', 'Plain ATR stops', 'The stop no longer moves with the volatility forecast.', { exit: { ...ex, stopVol: 0 } });
  for (const t of [0, 1.5, 2, 3]) if (t !== ex.targetR) add(`tp:${t}`, 'exit', t ? `Take profit at ${t}× the risk` : 'No profit target', t ? 'Gains are banked at a fixed multiple of the risk.' : 'Trades end on the stop, the time limit or an opposite signal.', { exit: { ...ex, targetR: t } });
  add(`trail:${ex.trailAtr ? 'off' : 'on'}`, 'exit', ex.trailAtr ? 'No trailing stop' : 'Trail the stop once a trade is 1R ahead', ex.trailAtr ? 'Trades are given back their room.' : 'Winners run while the stop follows them.', { exit: { ...ex, trailAtr: ex.trailAtr ? 0 : Math.max(1.5, ex.stopAtr) } });
  add('hold:long', 'hold', `Hold up to ${ex.maxBars * 2} candles`, 'Trades still working when time ran out get to finish.', { exit: { ...ex, maxBars: ex.maxBars * 2 } });
  if (ex.maxBars >= 2) add('hold:short', 'hold', `Hold up to ${Math.max(1, Math.round(ex.maxBars / 2))} candles`, 'Money is freed sooner from trades going nowhere.', { exit: { ...ex, maxBars: Math.max(1, Math.round(ex.maxBars / 2)) } });
  add(`flip:${ex.onFlip ? 'off' : 'on'}`, 'exit', ex.onFlip ? 'Ignore opposite signals' : 'Exit on an opposite signal', ex.onFlip ? 'Trades are not cut short by a brief change of mind.' : 'A trade closes as soon as the rule turns the other way.', { exit: { ...ex, onFlip: !ex.onFlip } });
  for (const sd of ['both', 'long', 'short'] as const) if (sd !== spec.sides) add(`side:${sd}`, 'side', sd === 'both' ? 'Long and short' : sd === 'long' ? 'Long only' : 'Short only', sd === 'long' ? 'Crypto has drifted up over time; short trades fight that drift.' : sd === 'short' ? 'Only bets on falls.' : 'Both directions.', { sides: sd });
  spec.filters.forEach((f, k) => add(`filter-:${k}`, 'filter', `Remove the filter “${FILTER_MAP[f.id]?.name ?? f.id}”`, 'A filter that removes good trades with the bad costs more than it saves.', { filters: spec.filters.filter((_, j) => j !== k) }));
  if (spec.filters.length < 3)
    for (const f of FILTERS) {
      if (f.needsFunding || spec.filters.some((x) => x.id === f.id)) continue;
      for (const p of gridOf(f.grid).slice(0, f.id === 'agree' ? 5 : 2)) add(`filter+:${f.id}:${Object.values(p).join('_')}`, f.id === 'agree' ? 'opinion' : 'filter', `Add: ${f.describe(p)}`, f.rationale, { filters: [...spec.filters, { id: f.id, p }] });
    }
  if (!spec.sizing || spec.sizing.mode === 'unit') add('size:vol', 'size', 'Volatility targeting', 'Smaller positions when the market is wild, bigger when calm.', { sizing: { mode: 'vol', target: 0.6 } });
  else add('size:unit', 'size', 'Plain, equal-sized trades', 'No sizing rule.', { sizing: undefined, sizing2: undefined });
  return out;
}

export type Goal = 'sharpe' | 'steady' | 'drawdown';
export const GOALS: { id: Goal; name: string; plain: string }[] = [
  { id: 'sharpe', name: 'More return for the risk', plain: 'Ranks changes by the Sharpe ratio: return against how bumpy the ride is.' },
  { id: 'steady', name: 'Steadier — more winning weeks', plain: 'Ranks changes by how many weeks make money and how bad the worst week is, for a result that arrives regularly rather than in a few big moves.' },
  { id: 'drawdown', name: 'Smaller drawdowns', plain: 'Ranks changes by the deepest fall from a high, for a bot that is easier to stay with.' },
];

/** what ranking needs of a change: an id and the part of the strategy it touches */
export interface AnyVariant {
  id: string;
  label: string;
  why: string;
  kind: Variant['kind'];
}

export interface Ranked<V extends AnyVariant = Variant> {
  variant: V;
  score: VariantScore;
  base: VariantScore;
  /** how much better on the goal, in the goal's own units */
  gain: number;
  /** it also beat the bot on the earlier training years: the improvement is not one stretch's luck */
  consistent: boolean;
  /** the change in words: what got better, and what it cost */
  text: string;
}

const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)} %`;

/** the measured changes that beat the bot on the chosen goal, best first */
export function rankVariants<V extends AnyVariant>(variants: V[], scores: VariantScore[], goal: Goal): { base: VariantScore | null; ranked: Ranked<V>[]; tried: number } {
  const by = new Map(scores.map((s) => [s.id, s]));
  const base = by.get('base') ?? null;
  if (!base) return { base: null, ranked: [], tried: 0 };
  const ranked: Ranked<V>[] = [];
  let tried = 0;
  for (const v of variants) {
    const s = by.get(v.id);
    if (!s || s.error || !Number.isFinite(s.sharpe)) continue;
    tried++;
    // too few trades to say anything, or far fewer than the bot makes
    if (s.trades < 8 || s.trades < base.trades * 0.25) continue;
    const gain = goal === 'sharpe' ? s.sharpe - base.sharpe : goal === 'drawdown' ? base.maxDD - s.maxDD : s.weeksUp - base.weeksUp + (s.worstWeek - base.worstWeek);
    const worthIt = goal === 'sharpe' ? gain > 0.15 : goal === 'drawdown' ? gain > 0.01 && s.sharpe > base.sharpe - 0.3 : gain > 0.03 && s.sharpe > base.sharpe - 0.3;
    if (!worthIt) continue;
    const bits = [`Sharpe ${base.sharpe.toFixed(2)} → ${s.sharpe.toFixed(2)}`, `winning weeks ${pct(base.weeksUp)} → ${pct(s.weeksUp)}`, `deepest drop ${pct(base.maxDD)} → ${pct(s.maxDD)}`, `${base.trades} → ${s.trades} trades`];
    ranked.push({ variant: v, score: s, base, gain, consistent: s.early >= base.early - 0.05, text: bits.join(' · ') });
  }
  ranked.sort((a, b) => Number(b.consistent) - Number(a.consistent) || b.gain - a.gain);
  return { base, ranked, tried };
}

export interface Advice {
  tone: 'good' | 'warn' | 'bad';
  title: string;
  text: string;
  /** the kinds of change that answer it (the optimizer's results of these kinds are shown first) */
  kinds: Variant['kind'][];
}

/** how a trade ended, in words */
export const EXIT_WORDS: Record<string, string> = { stop: 'at the stop', target: 'at the profit target', trail: 'on the trailing stop', time: 'when time ran out', flip: 'on an opposite signal', end: 'at the end of the data' };

/**
 * What a test showed, in words: how the bot's trades went on the training
 * years (what ended them, each side, each coin, what trading cost) and how
 * regular the result was on the unseen data.
 */
export function advise(diag: Diag | null | undefined, periods: Periods | null | undefined, flow: Flow): Advice[] {
  const out: Advice[] = [];
  if (!diag || diag.trades < 10) return [{ tone: 'bad', title: 'Too few trades to read', text: `Only ${diag?.trades ?? 0} trades on the training years: there is nothing to optimize yet. Add coins, loosen or remove a filter, join strategies by “any one”, or choose a faster style.`, kinds: ['filter', 'join', 'pace', 'opinion'] }];
  const style = STYLE_MAP[flow.style] ?? STYLE_MAP.swing;
  const share = (n: number) => n / diag.trades;
  const ex = Object.fromEntries(diag.exits.map((e) => [e.reason, e]));
  // what ends its trades
  const stop = ex.stop;
  if (stop && share(stop.n) > 0.55) out.push({ tone: 'warn', title: `${pct(share(stop.n))} of trades end at the stop`, text: `More than half the trades are stopped out (losing ${Math.abs(stop.avgR).toFixed(1)}R each on average). Either the entries are early, or the stop sits inside the market’s ordinary noise: try a wider stop or stops that follow GARCH volatility, or a filter that waits for a clearer market.`, kinds: ['stop', 'size', 'filter'] });
  const time = ex.time;
  if (time && share(time.n) > 0.4)
    out.push(time.avgR > 0.15 ? { tone: 'warn', title: `${pct(share(time.n))} of trades run out of time while ahead`, text: `Trades closed by the time limit were making ${time.avgR.toFixed(2)}R on average when they were cut: the move was not finished. Try a longer hold, or let winners run on a trailing stop.`, kinds: ['hold', 'exit', 'pace'] } : { tone: 'warn', title: `${pct(share(time.n))} of trades go nowhere and time out`, text: `Trades closed by the time limit made ${time.avgR.toFixed(2)}R on average: the signal is often not followed by a move. A shorter hold frees the money sooner; a filter (trend, volatility, volume) can skip the dead periods.`, kinds: ['hold', 'filter'] });
  const tgt = ex.target;
  if (tgt && share(tgt.n) > 0.45 && flow.takeProfit !== 'trail') out.push({ tone: 'good', title: `${pct(share(tgt.n))} of trades reach the profit target`, text: 'Most trades hit the target — the entries are good and the target may be leaving money behind. Try a further target, or let winners run.', kinds: ['exit'] });
  // the two sides
  const { long, short } = diag;
  if (long.n >= 12 && short.n >= 12) {
    if (long.avgR > 0.05 && short.avgR < -0.05) out.push({ tone: 'warn', title: 'The short trades lose', text: `Longs made ${long.avgR.toFixed(2)}R a trade on the training years (${long.n} trades); shorts lost ${Math.abs(short.avgR).toFixed(2)}R (${short.n}). Crypto’s long-run drift is up and short squeezes are violent: try long only.`, kinds: ['side'] });
    else if (short.avgR > 0.05 && long.avgR < -0.05) out.push({ tone: 'warn', title: 'The long trades lose', text: `Shorts made ${short.avgR.toFixed(2)}R a trade (${short.n}); longs lost ${Math.abs(long.avgR).toFixed(2)}R (${long.n}). Unusual, and often one bear market’s doing — test short only, but trust it less.`, kinds: ['side'] });
  }
  // winners cut short, losers held
  if (Number.isFinite(diag.heldWin) && Number.isFinite(diag.heldLoss) && diag.heldLoss > diag.heldWin * 1.6) out.push({ tone: 'warn', title: 'Losers are held longer than winners', text: `Losing trades last ${diag.heldLoss.toFixed(0)} candles on average, winners ${diag.heldWin.toFixed(0)}. Cut losers sooner (a tighter stop, a shorter hold) or let winners run (a trailing stop).`, kinds: ['stop', 'hold', 'exit'] });
  // what trading costs
  if (diag.costShare > 0.5) out.push({ tone: 'bad', title: diag.costShare >= 1 ? 'Fees and slippage eat all the profit' : `Fees and slippage eat ${pct(diag.costShare)} of the profit`, text: `Before costs the rules made money; after them ${diag.costShare >= 1 ? 'nothing is left' : 'less than half is'}. The idea trades too often for the size of its edge${style.tfH < 1 ? ' — the usual fate of 15-minute rules' : ''}: try a slower pace, a wider profit target, a stricter filter, or all strategies agreeing.`, kinds: ['pace', 'filter', 'exit', 'join'] });
  // coins
  const losers = diag.coins.filter((c) => c.sharpe < -0.2 && c.trades >= 5);
  if (diag.coins.length > 1 && losers.length && losers.length < diag.coins.length) out.push({ tone: 'warn', title: `It loses on ${losers.map((c) => c.coin).join(', ')}`, text: `The same rules made money on ${diag.coins.filter((c) => c.sharpe > 0).map((c) => c.coin).join(', ') || 'no coin'} and lost on ${losers.map((c) => c.coin).join(', ')}. A rule that works on some coins only is weaker evidence — but leaving a persistent loser out is fair.`, kinds: ['coins'] });
  // how regular the result is (the unseen data, described — not used to choose anything)
  if (periods && periods.list.length >= 4) {
    const u = periods.unit;
    out.push(
      periods.up >= 0.6
        ? { tone: 'good', title: `${pct(periods.up)} of ${u}s made money on the unseen data`, text: `${periods.list.filter((p) => p.ret > 0).length} of ${periods.list.length} ${u}s were positive; the worst lost ${pct(Math.abs(periods.worst), 1)}, the average made ${pct(periods.avg, 1)}. That is a fairly regular result.`, kinds: [] }
        : { tone: 'warn', title: `Only ${pct(periods.up)} of ${u}s made money on the unseen data`, text: `${periods.list.filter((p) => p.ret > 0).length} of ${periods.list.length} ${u}s were positive; the worst lost ${pct(Math.abs(periods.worst), 1)}. The yearly figure comes from a few good ${u}s. For a steadier result set the optimizer’s goal to “steadier”: volatility targeting, more coins, and a second strategy of a different kind (a dip rule beside a trend rule) are what usually smooth it.`, kinds: ['size', 'filter', 'join'] },
    );
  }
  if (diag.tradesPerMonth < 2) out.push({ tone: 'warn', title: 'Fewer than two trades a month per coin', text: 'A return every month needs trades every month. Choose a faster style (the 15-minute ones trade many times a day), add coins, or loosen a filter.', kinds: ['pace', 'filter', 'join'] });
  if (!out.length) out.push({ tone: 'good', title: 'Nothing stands out as broken', text: 'Stops, targets, the two sides and costs all look balanced on the training years. What is left is fine-tuning — run the optimizer and see whether any single change is worth its trade-off.', kinds: [] });
  return out;
}

/**
 * How much to believe a result after trying several versions on the same
 * unseen data: the chance the best of N tries is this good by luck alone.
 */
export const triesWords = (n: number) => (n <= 1 ? 'This is the first version tested on this unseen data.' : `This is version ${n} tested on the same unseen data. Every extra version makes it likelier that the best one looks good by luck — the “after ${n} tries” figure allows for that.`);
