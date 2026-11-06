// The council: before any buy, every bot says what it thinks of the coin and
// why, and the decision is taken on the votes — not by one rule firing.
//
//   Sentinel    for if it passed the on-chain and fake checks; a reject is a veto
//   Herald      for if it is catching on (or, on X, being posted about); against if not
//   Strategist  for if its entry rules (or the insider lane) say buy
//   Forest      the statistics: the odds of 2×, 5× and dying in the next hour, and
//               what a trade is expected to come back as. Once it has learned
//               from enough coins (trust 30 %+), an expected loss or a likely
//               death is a veto
//   Optimizer   for at the size it would allow; a portfolio gate is a veto
//   Lab         strategies deployed from the Strategy Lab read the coin's own
//               chart: for while one says long, against while one says short.
//               Tested on major coins, not meme coins, so it votes but never vetoes
//
// Buy only with no veto, the Strategist for, and the weighted votes for minus
// against at 1.5 or more.
import type { Decision, Viability, Virality } from './agents';
import type { Odds } from './forest';

export type CouncilBot = 'sentinel' | 'herald' | 'strategist' | 'forest' | 'optimizer' | 'lab';
export interface Vote {
  bot: CouncilBot;
  stance: 'for' | 'against' | 'abstain' | 'veto';
  weight: number;
  why: string;
}
export interface Verdict {
  buy: boolean;
  /** weighted votes for minus against */
  score: number;
  votes: Vote[];
  summary: string;
}

export interface CouncilConfig {
  /** weighted votes for minus against needed to buy */
  minScore: number;
  /** the forest's trust from which its veto counts */
  forestVetoTrust: number;
  /** the forest's veto: expected multiple under this, or odds of dying over this */
  minExpMult: number;
  maxDeath: number;
}
export const COUNCIL_DEFAULTS: CouncilConfig = { minScore: 1.5, forestVetoTrust: 0.3, minExpMult: 1.0, maxDeath: 0.55 };

const pct = (x: number) => `${Math.round(x * 100)}%`;

export interface CouncilInput {
  viability: Viability;
  virality: Virality;
  minVirality: number;
  decision: Decision;
  odds: Odds;
  /** the Optimizer's reason not to trade now, or null; and the size it would give */
  optimizerGate: string | null;
  sizeMult: number;
  social?: { posts: number; authors: number } | null;
  /** the Strategy Lab's deployed strategies on this coin's chart: +1 long, −1 short, 0 nothing, null too little history */
  lab?: { name: string; dir: number | null }[];
}

export function council(inp: CouncilInput, cfg: CouncilConfig = COUNCIL_DEFAULTS): Verdict {
  const votes: Vote[] = [];
  const { viability: v, virality: x, decision: d, odds: o } = inp;
  // Sentinel
  if (v.verdict === 'reject') votes.push({ bot: 'sentinel', stance: 'veto', weight: 0, why: v.reasons[0] ?? 'rejected' });
  else if (v.verdict === 'watch') votes.push({ bot: 'sentinel', stance: 'against', weight: 1, why: `not cleared yet — ${v.reasons[0] ?? 'checks pending'}` });
  else votes.push({ bot: 'sentinel', stance: 'for', weight: 1, why: `clean — viability ${v.score}${v.reasons.length ? `, though ${v.reasons[0]}` : ', authorities revoked, no fakes, no bundles'}` });
  // Herald
  const xs = inp.social && inp.social.posts > 0 ? ` · ${inp.social.posts} posts from ${inp.social.authors} accounts on X` : '';
  if (x.score >= inp.minVirality) votes.push({ bot: 'herald', stance: 'for', weight: 1, why: `catching on — virality ${x.score}${x.reasons[0] ? `: ${x.reasons[0]}` : ''}${xs}` });
  else if (d.insiders) votes.push({ bot: 'herald', stance: 'abstain', weight: 0, why: `quiet so far (virality ${x.score}) — as insiders like it${xs}` });
  else votes.push({ bot: 'herald', stance: 'against', weight: 1, why: `not catching on — virality ${x.score} under ${inp.minVirality}${xs}` });
  // Strategist
  votes.push(d.enter ? { bot: 'strategist', stance: 'for', weight: 1.5, why: d.insiders ? 'insider lane: proven or quiet big wallets are in early' : `entry rules met — conviction ${d.conviction}` } : { bot: 'strategist', stance: 'against', weight: 1.5, why: d.why });
  // Forest
  const odds = `P(2×) ${pct(o.p2)} · P(5×) ${pct(o.p5)} · P(dies) ${pct(o.pDead)} · expects ${o.expMult.toFixed(2)}× · trust ${pct(o.trust)}`;
  const bad = o.expMult < cfg.minExpMult || o.pDead > cfg.maxDeath;
  const good = o.expMult >= cfg.minExpMult + 0.15 && o.pDead <= cfg.maxDeath;
  if (bad && o.trust >= cfg.forestVetoTrust) votes.push({ bot: 'forest', stance: 'veto', weight: 0, why: `${odds} — the numbers say no` });
  else if (bad) votes.push({ bot: 'forest', stance: 'against', weight: 0.5 + o.trust, why: `${odds}${o.trust < 0.15 ? ' (mostly the prior: still learning)' : ''}` });
  else if (good) votes.push({ bot: 'forest', stance: 'for', weight: 0.5 + o.trust, why: `${odds}${o.trust < 0.15 ? ' (mostly the prior: still learning)' : ''}` });
  else votes.push({ bot: 'forest', stance: 'abstain', weight: 0, why: `${odds} — on the fence` });
  // Optimizer
  votes.push(inp.optimizerGate ? { bot: 'optimizer', stance: 'veto', weight: 0, why: inp.optimizerGate } : { bot: 'optimizer', stance: 'for', weight: 1, why: `the book can take it — size ${inp.sizeMult.toFixed(2)}×` });
  if (inp.lab?.length) {
    const read = inp.lab.filter((l) => l.dir !== null);
    const longs = read.filter((l) => l.dir! > 0);
    const shorts = read.filter((l) => l.dir! < 0);
    if (!read.length) votes.push({ bot: 'lab', stance: 'abstain', weight: 0, why: 'too little chart history for the Lab’s strategies' });
    else if (longs.length > shorts.length) votes.push({ bot: 'lab', stance: 'for', weight: Math.min(1, 0.5 * longs.length), why: `${longs.map((l) => l.name).join(', ')} ${longs.length > 1 ? 'say' : 'says'} long on this chart` });
    else if (shorts.length > longs.length) votes.push({ bot: 'lab', stance: 'against', weight: Math.min(1, 0.5 * shorts.length), why: `${shorts.map((l) => l.name).join(', ')} ${shorts.length > 1 ? 'say' : 'says'} short on this chart` });
    else votes.push({ bot: 'lab', stance: 'abstain', weight: 0, why: 'the Lab’s strategies have no signal on this chart' });
  }

  const score = votes.reduce((a, b) => a + (b.stance === 'for' ? b.weight : b.stance === 'against' ? -b.weight : 0), 0);
  const veto = votes.find((b) => b.stance === 'veto');
  const strat = votes.find((b) => b.bot === 'strategist')!.stance === 'for';
  const buy = !veto && strat && score >= cfg.minScore - 1e-9;
  const fors = votes.filter((b) => b.stance === 'for').length;
  const against = votes.filter((b) => b.stance === 'against').length;
  const summary = veto ? `vetoed by the ${veto.bot[0].toUpperCase() + veto.bot.slice(1)}` : buy ? `BUY — ${fors} for, ${against} against (score ${score.toFixed(1)})` : `no — ${fors} for, ${against} against (score ${score.toFixed(1)}, needs ${cfg.minScore})`;
  return { buy, score, votes, summary };
}

/** One line per vote, for the live feed and Telegram. */
export const MARK = { for: '✓', against: '✗', abstain: '–', veto: '⛔' } as const;
