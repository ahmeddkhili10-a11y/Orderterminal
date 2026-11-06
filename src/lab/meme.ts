// The Strategy Lab's deployed strategies, read on a meme coin's own chart for
// the meme swarm's council. A meme coin's market-cap history becomes candles;
// only rules that make sense on a short, wild chart (momentum, trend,
// breakouts, volume) are asked, and only with enough history to read.
import type { MemeToken } from '../meme/token';
import { SIGNAL_MAP, type Market } from './library';
import { liveDirection } from './live';
import { useLab } from './store';
import type { Bar } from './series';

const READABLE = new Set(['momentum', 'trend', 'breakout', 'volume']);

/** a coin's market-cap samples as candles (each sample closes a bar) */
export function memeBars(history: { t: number; mcapSol: number }[]): { bars: Bar[]; tfH: number } | null {
  const h = [...history].sort((a, b) => a.t - b.t).filter((x) => x.mcapSol > 0);
  if (h.length < 60) return null;
  const gaps = h.slice(1).map((x, i) => x.t - h[i].t).sort((a, b) => a - b);
  const tfH = Math.max(1 / 60, gaps[Math.floor(gaps.length / 2)] / 3_600_000);
  const bars = h.map((x, i) => {
    const o = i ? h[i - 1].mcapSol : x.mcapSol;
    return { time: x.t, open: o, high: Math.max(o, x.mcapSol), low: Math.min(o, x.mcapSol), close: x.mcapSol, volume: 1 };
  });
  return { bars, tfH };
}

export function memeLabVotes(tok: MemeToken): { name: string; dir: number | null }[] | undefined {
  const deployed = useLab.getState().status?.deployed.filter((d) => d.on && d.targets.meme && READABLE.has(SIGNAL_MAP[d.spec.signal.id]?.family ?? '')) ?? [];
  if (!deployed.length) return undefined;
  const b = tok.history ? memeBars(tok.history) : null;
  return deployed.map((d) => {
    if (!b) return { name: d.name, dir: null };
    const m: Market = { coin: tok.symbol, tfH: b.tfH, bars: b.bars, funding: null };
    return { name: d.name, dir: liveDirection(d.spec, m) };
  });
}
