// The decision chain end to end: the Sentinel (rugs and fakes), the Herald, the
// Strategist (rules and the insider lane), the forest, the council, the
// Optimizer and the Manager's gates must agree, and nothing passing may block
// a good trade for good.
import { describe, expect, it } from 'vitest';
import { useMeme } from '../scanner';
import { applyTrade, type MemeToken } from '../token';
import type { Position } from './book';
import { FEATURES } from './features';
import { coin, runner, trade } from './fixtures';
import { Forest, oddsOf, priorTree } from './forest';
import { swarm, useSwarm } from './swarm';
import { sentinel } from './agents';
import { COUNCIL_DEFAULTS } from './council';

const keepAlive = (tok: MemeToken, from: number, to: number) => {
  let w = 0;
  for (let t = from; t < to; t += 3_000) applyTrade(tok, trade(tok, 'buy', `K${tok.mint.slice(0, 4)}${w++}`, 0.15, t));
};
const paperBook = (over: Partial<ReturnType<typeof useSwarm.getState>> = {}) =>
  useSwarm.setState((s) => ({ mode: 'paper', positions: [], outcomes: [], log: [], risk: {}, manager: { ...s.manager, maxOpen: 4, sizeSol: 0.1 }, ...over }));
const texts = () => useSwarm.getState().log.map((l) => l.text);

describe('Decision chain — no bottlenecks', () => {
  it('a pick turned away because every slot is full is bought once a slot frees, a minute later', () => {
    const { tok, now } = runner(8);
    tok.meta = { twitter: 'x', telegram: 't', fetchedAt: now };
    useMeme.setState({ tokens: { [tok.mint]: tok }, solUsd: 150 });
    const other = { id: 'held', mint: 'HeldMint', symbol: 'HELD', openedAt: now - 60_000, costSol: 0.1, entryPx: 1, tokens: 1, left: 1, realizedSol: 0, peakMult: 1, peakAt: now, tpDone: 0, fills: [], why: '', conviction: 80 } as Position;
    paperBook({ positions: [other], manager: { ...useSwarm.getState().manager, maxOpen: 1, sizeSol: 0.1 } });
    swarm.tick(now);
    expect(useSwarm.getState().positions.filter((p) => p.mint === tok.mint)).toHaveLength(0);
    expect(texts()).toContain(`${tok.symbol}: not bought — 1 positions already open; the council sits again in 1 min if it still qualifies (try 1 of 4)`);
    // the slot frees; within the minute nothing happens, after it the council sits again and buys
    useSwarm.setState((s) => ({ positions: s.positions.map((p) => (p.id === 'held' ? { ...p, closedAt: now + 1000, left: 0, realizedSol: 0.12 } : p)) }));
    keepAlive(tok, now + 1000, now + 62_000);
    swarm.tick(now + 30_000);
    expect(useSwarm.getState().positions.filter((p) => p.mint === tok.mint)).toHaveLength(0);
    swarm.tick(now + 62_000);
    expect(useSwarm.getState().positions.filter((p) => p.mint === tok.mint)).toHaveLength(1);
    expect(texts()).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^${tok.symbol}: PICK \\(conviction \\d+\\) — again, try 2 of 4`))]));
    // one research record for the coin, however often the council sat
    expect(useSwarm.getState().outcomes.filter((o) => o.mint === tok.mint && o.kind === 'pick')).toHaveLength(1);
  });

  it('gives up cleanly after four tries, and says so', () => {
    const { tok, now } = runner(8);
    tok.meta = { twitter: 'x', telegram: 't', fetchedAt: now };
    useMeme.setState({ tokens: { [tok.mint]: tok }, solUsd: 150 });
    const other = { id: 'held2', mint: 'HeldMint2', symbol: 'HELD', openedAt: now - 60_000, costSol: 0.1, entryPx: 1, tokens: 1, left: 1, realizedSol: 0, peakMult: 1, peakAt: now, tpDone: 0, fills: [], why: '', conviction: 80 } as Position;
    paperBook({ positions: [other], manager: { ...useSwarm.getState().manager, maxOpen: 1, sizeSol: 0.1 } });
    keepAlive(tok, now, now + 4 * 62_000);
    for (let k = 0; k < 6; k++) swarm.tick(now + k * 62_000);
    expect(texts().filter((t) => t.startsWith(`${tok.symbol}: PICK`))).toHaveLength(4);
    expect(texts()).toContain(`${tok.symbol}: not bought — 1 positions already open; that was the last of 4 tries`);
  });

  it('a fake never reaches the council, whatever its buying looks like', () => {
    const { tok, now } = runner(8);
    tok.symbol = 'BONK';
    tok.name = 'Bonk';
    // its own creator: a faker is remembered, and the other test coins share one
    tok.creator = 'FakerDev';
    tok.meta = { twitter: 'x', telegram: 't', fetchedAt: now };
    useMeme.setState({ tokens: { [tok.mint]: tok }, solUsd: 150 });
    paperBook();
    swarm.tick(now);
    expect(texts().some((t) => t.startsWith('BONK: PICK') || t.startsWith('BONK · council'))).toBe(false);
    expect(useSwarm.getState().reads.find((r) => r.mint === tok.mint)?.decision).toMatch(/^rejected: impersonates \$BONK/);
  });
});

describe('Decision chain — safety checks', () => {
  it('a failed on-chain check never passes a coin: it waits, and trades once a good check comes back', () => {
    const { tok, now } = runner(8);
    tok.creator = 'SafetyDev';
    tok.meta = { twitter: 'x', telegram: 't', fetchedAt: now };
    tok.safety = { checkedAt: now, mintRevoked: null, freezeRevoked: null, top10: null, top1: null, error: 'RPC 429' };
    expect(sentinel(tok, now)).toMatchObject({ verdict: 'watch', reasons: ['the on-chain check failed — trying again'] });
    useMeme.setState({ tokens: { [tok.mint]: tok }, solUsd: 150 });
    paperBook();
    swarm.tick(now);
    expect(useSwarm.getState().positions.some((p) => p.mint === tok.mint)).toBe(false);
    expect(texts().some((t) => t.startsWith(`${tok.symbol}: PICK`))).toBe(false);
    // the check comes back clean: the same coin goes through
    tok.safety = { checkedAt: now + 1000, mintRevoked: true, freezeRevoked: true, top10: 0.2, top1: 0.05 };
    swarm.tick(now + 2000);
    expect(useSwarm.getState().positions.some((p) => p.mint === tok.mint)).toBe(true);
  });
});

describe('Decision chain — the forest agrees with the rules', () => {
  it('the prior never vetoes a coin that passes every entry rule, nor an insider pick', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2000; i++) {
      const x = FEATURES.map(() => rnd() * 100);
      // what the Strategist demands: viability 60+, heat 55+, virality 45+ (or the insider lane: Sentinel pass and insider 65+)
      const insider = i % 2 === 1;
      x[0] = insider ? rnd() * 100 : 55 + rnd() * 45;
      x[1] = insider ? rnd() * 100 : 45 + rnd() * 55;
      x[2] = insider ? 50 + rnd() * 50 : 60 + rnd() * 40;
      x[3] = insider ? 65 + rnd() * 35 : rnd() * 64;
      const o = oddsOf(x, null);
      expect(o.expMult).toBeGreaterThanOrEqual(COUNCIL_DEFAULTS.minExpMult);
      expect(o.pDead).toBeLessThanOrEqual(COUNCIL_DEFAULTS.maxDeath);
      expect(priorTree(x).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    }
  });

  it('size never runs away: a perfect record, top conviction and a confident forest still stop at 1.25× the normal trade', async () => {
    const { tok, now } = runner(8);
    tok.meta = { twitter: 'x', telegram: 't', fetchedAt: now };
    useMeme.setState({ tokens: { [tok.mint]: tok }, solUsd: 150 });
    // ten closed paper trades, all won at 6×: the Optimizer's edge sizing is at its 1.25× top
    const won = Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, mint: `Won${i}`, symbol: `W${i}`, openedAt: now - 3_600_000, closedAt: now - 3_000_000 + i, costSol: 0.1, entryPx: 1, tokens: 1, left: 0, realizedSol: 0.6, peakMult: 6, peakAt: now, tpDone: 2, fills: [], why: '', conviction: 90 }) as Position);
    paperBook({ positions: won });
    // a forest that has only ever seen 5× runners: it trusts itself and expects a lot
    swarm.forest = await Forest.train(Array.from({ length: 300 }, (_, i) => ({ x: FEATURES.map((_, j) => (i * 7 + j * 13) % 100), y: 3 })), undefined, 0, 0);
    swarm.tick(now);
    const p = useSwarm.getState().positions.find((q) => q.mint === tok.mint)!;
    expect(p).toBeDefined();
    expect(p.costSol).toBeLessThanOrEqual(0.125 + 1e-9);
    swarm.forest = null;
  });

  it('an insider pick goes through the council too: the Herald stands aside, the others agree, it is bought', () => {
    const tok = coin({ symbol: 'QUIET', name: 'Quiet Money' });
    tok.creator = 'QuietDev';
    let t = tok.createdAt + 40_000;
    for (let k = 0; k < 8; k++) applyTrade(tok, trade(tok, 'buy', `small${k}`, 0.3, (t += 20_000)));
    for (let k = 0; k < 5; k++) applyTrade(tok, trade(tok, 'buy', `Whale${k}`, 2, (t += 15_000)));
    tok.safety = { checkedAt: t, mintRevoked: true, freezeRevoked: true, top10: 0.2, top1: 0.05 };
    useMeme.setState({ tokens: { [tok.mint]: tok }, solUsd: 150 });
    paperBook();
    swarm.tick(t + 1000);
    expect(texts()).toEqual(expect.arrayContaining([expect.stringMatching(/^QUIET: INSIDER PICK/), expect.stringMatching(/^QUIET · council – quiet so far/), 'QUIET: council — BUY — 4 for, 0 against (score 4.0)']));
    expect(useSwarm.getState().positions.find((p) => p.mint === tok.mint)?.insiders).toHaveLength(5);
  });
});
