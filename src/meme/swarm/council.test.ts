import { describe, expect, it } from 'vitest';
import { useMeme } from '../scanner';
import type { Decision, Viability, Virality } from './agents';
import { council } from './council';
import { FEATURES } from './features';
import { Forest, oddsOf, type Odds } from './forest';
import { runner } from './fixtures';
import { swarm, useSwarm } from './swarm';

const pass = { verdict: 'pass', score: 90, reasons: [], early: { wallets: 0, share: 0 } } as Viability;
const viral = { score: 60, reasons: ['12 new buyers a minute'], narrative: null } as Virality;
const quiet = { score: 20, reasons: [], narrative: null } as Virality;
const enter: Decision = { enter: true, conviction: 84, why: 'rules met' };
const odds = (o: Partial<Odds>): Odds => ({ probs: [0.3, 0.4, 0.2, 0.1], p2: 0.3, p5: 0.1, pDead: 0.3, expMult: 1.3, trust: 0.5, ...o });
const base = { viability: pass, virality: viral, minVirality: 45, decision: enter, odds: odds({}), optimizerGate: null, sizeMult: 1 };

describe('The council', () => {
  it('buys when every bot agrees, and says so', () => {
    const v = council(base);
    expect(v.buy).toBe(true);
    expect(v.votes.map((b) => [b.bot, b.stance])).toEqual([['sentinel', 'for'], ['herald', 'for'], ['strategist', 'for'], ['forest', 'for'], ['optimizer', 'for']]);
    expect(v.summary).toBe('BUY — 5 for, 0 against (score 5.5)');
  });

  it('a trusted forest that expects a loss, or a likely death, vetoes; an untrusted one only votes against', () => {
    expect(council({ ...base, odds: odds({ expMult: 0.8 }) })).toMatchObject({ buy: false, summary: 'vetoed by the Forest' });
    expect(council({ ...base, odds: odds({ pDead: 0.7 }) }).buy).toBe(false);
    const learning = council({ ...base, odds: odds({ expMult: 0.8, trust: 0.1 }) });
    expect(learning.votes.find((b) => b.bot === 'forest')).toMatchObject({ stance: 'against' });
    expect(learning.votes.find((b) => b.bot === 'forest')!.why).toMatch(/mostly the prior: still learning/);
    expect(learning.buy).toBe(true);
  });

  it('the Sentinel and the Optimizer can veto; the Strategist must be for', () => {
    expect(council({ ...base, viability: { ...pass, verdict: 'reject', reasons: ['duplicate of $FROG launched 4 min earlier — a copy'] } })).toMatchObject({ buy: false, summary: 'vetoed by the Sentinel' });
    expect(council({ ...base, optimizerGate: 'the open coins are down 14% of the account together' })).toMatchObject({ buy: false, summary: 'vetoed by the Optimizer' });
    expect(council({ ...base, decision: { enter: false, conviction: 70, why: 'conviction 70 < 80' } }).buy).toBe(false);
  });

  it('too many against: no buy; the insider lane does not need the Herald', () => {
    const cold = council({ ...base, virality: quiet, odds: odds({ expMult: 1.05, trust: 0.1 }), sizeMult: 0.5 });
    expect(cold.votes.find((b) => b.bot === 'herald')).toMatchObject({ stance: 'against' });
    const ins = council({ ...base, virality: quiet, decision: { ...enter, insiders: ['W1', 'W2', 'W3'] } });
    expect(ins.votes.find((b) => b.bot === 'herald')).toMatchObject({ stance: 'abstain' });
    expect(ins.buy).toBe(true);
  });
});

describe('The forest in the swarm', () => {
  it('a forest that has learned such coins die stops the buy, and the call is still followed', async () => {
    const { tok, now } = runner(8);
    tok.meta = { twitter: 'x', telegram: 't', fetchedAt: now };
    useMeme.setState({ tokens: { [tok.mint]: tok }, solUsd: 150 });
    useSwarm.setState({ mode: 'paper', positions: [], outcomes: [], log: [], risk: {} });
    // 300 followed coins, every one of them dead within the hour
    swarm.forest = await Forest.train(Array.from({ length: 300 }, (_, i) => ({ x: FEATURES.map((_, j) => (i * 7 + j * 13) % 100), y: 0 })), undefined, 0, 0);
    expect(oddsOf(FEATURES.map(() => 50), swarm.forest).pDead).toBeGreaterThan(0.7);
    swarm.tick(now);
    const s = useSwarm.getState();
    expect(s.positions).toHaveLength(0);
    expect(s.log.map((l) => l.text)).toContain(`${tok.symbol}: council — vetoed by the Forest`);
    expect(s.outcomes.find((o) => o.mint === tok.mint)).toMatchObject({ kind: 'pick', voted: 'no' });
    expect(s.outcomes.find((o) => o.mint === tok.mint)!.x).toHaveLength(FEATURES.length);
    swarm.forest = null;
  });
});
