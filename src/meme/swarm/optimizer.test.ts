import { describe, expect, it } from 'vitest';
import type { Position } from './book';
import { convictionTilt, edgeOf, optimize, OPTIMIZER_DEFAULTS, sharedNarrative, trimShare, updateBook, type RiskBook } from './optimizer';

const T = new Date(2026, 10, 1, 12).getTime();
const trade = (mult: number) => ({ closedAt: T, costSol: 0.05, realizedSol: 0.05 * mult }) as Position;
const book = (o: Partial<RiskBook> = {}): RiskBook => ({ startSol: 0.28, peakSol: 0.28, day: '2026-11-01', dayStartSol: 0.28, ...o });
const cfg = OPTIMIZER_DEFAULTS;

describe('Optimizer — the record', () => {
  it('win rate, payoff and Kelly from closed trades', () => {
    // 3 of 10 won at 4× (+300 %), 7 lost 35 %: an edge
    const e = edgeOf([...Array(3)].map(() => trade(4)).concat([...Array(7)].map(() => trade(0.65))))!;
    expect(e.trades).toBe(10);
    expect(e.winRate).toBeCloseTo(0.3);
    expect(e.payoff).toBeCloseTo(3 / 0.35);
    expect(e.kelly).toBeCloseTo(0.3 - 0.7 / (3 / 0.35));
    expect(edgeOf([])).toBeNull();
  });

  it('tracks the start, the high and the start of each day', () => {
    let b = updateBook(undefined, 0.28, T);
    expect(b).toMatchObject({ startSol: 0.28, peakSol: 0.28, dayStartSol: 0.28 });
    b = updateBook(b, 0.4, T + 3_600_000);
    expect(b).toMatchObject({ startSol: 0.28, peakSol: 0.4, dayStartSol: 0.28 });
    b = updateBook(b, 0.35, T + 24 * 3_600_000);
    expect(b).toMatchObject({ peakSol: 0.4, dayStartSol: 0.35, day: '2026-11-02' });
  });
});

describe('Optimizer — sizing', () => {
  it('normal size while learning; half size when the record shows no edge; more when it does', () => {
    expect(optimize(cfg, book(), 0.28, [trade(0.65)], [], 0.14, 0.2).sizeMult).toBe(1);
    const losing = [...Array(10)].map((_, i) => trade(i < 2 ? 1.5 : 0.65));
    const r = optimize(cfg, book(), 0.28, losing, [], 0.14, 0.2);
    expect(r.sizeMult).toBe(0.5);
    expect(r.notes[0]).toMatch(/^no edge yet over 10 trades/);
    // half of 5 in 10 winning at 6×: Kelly 0.465 → 0.23 of the account, 1.16× the normal fifth
    const good = [...Array(10)].map((_, i) => trade(i < 5 ? 6 : 0.65));
    expect(optimize(cfg, book(), 0.28, good, [], 0.14, 0.2).sizeMult).toBeCloseTo(1.1625, 3);
    // never more than 1.25×, however good the record
    const great = [...Array(10)].map((_, i) => trade(i < 7 ? 6 : 0.65));
    expect(optimize(cfg, book(), 0.28, great, [], 0.14, 0.2).sizeMult).toBe(1.25);
  });

  it('cuts size in a drawdown, and after a big day', () => {
    expect(optimize(cfg, book({ peakSol: 0.4 }), 0.33, [], [], 0, 0.2).sizeMult).toBe(0.75);
    expect(optimize(cfg, book({ peakSol: 0.4 }), 0.29, [], [], 0, 0.2).sizeMult).toBe(0.5);
    const day = optimize(cfg, book({ peakSol: 0.4, dayStartSol: 0.28 }), 0.4, [], [], 0, 0.2);
    expect(day.sizeMult).toBe(0.5);
    expect(day.notes).toContain('up 43% today — half size to keep the day');
  });

  it('tilts by conviction: 0.85× at the minimum, 1.15× at 100', () => {
    expect(convictionTilt(80, 80)).toBe(0.85);
    expect(convictionTilt(100, 80)).toBe(1.15);
    expect(convictionTilt(90, 80)).toBeCloseTo(1);
  });

  it('off: plain sizes, the Manager floor, no gates', () => {
    expect(optimize({ ...cfg, enabled: false }, book({ peakSol: 1 }), 0.2, [], [{ costSol: 0.1, valueSol: 0 }], 0.14, 0.2)).toMatchObject({ sizeMult: 1, floorSol: 0.14, gate: null });
  });
});

describe('Optimizer — staying in the green', () => {
  it('once the account reached 1.5× its start, the floor rises to lock the profit in', () => {
    const r = optimize(cfg, book({ peakSol: 0.5 }), 0.45, [], [], 0.14, 0.2);
    expect(r.floorSol).toBeCloseTo(0.35);
    expect(r.gate).toBeNull();
    const fell = optimize(cfg, book({ peakSol: 0.5 }), 0.34, [], [], 0.14, 0.2);
    expect(fell.gate).toBe('the account (0.340 SOL) fell to its locked-in profit floor of 0.350 SOL — buying stopped to stay in the green');
    // not yet 1.5×: the Manager's floor
    expect(optimize(cfg, book({ peakSol: 0.4 }), 0.4, [], [], 0.14, 0.2).floorSol).toBe(0.14);
  });

  it('no new trade while the open coins are down more than 12 % of the account together', () => {
    const r = optimize(cfg, book(), 0.28, [], [{ costSol: 0.06, valueSol: 0.03 }, { costSol: 0.06, valueSol: 0.05 }], 0, 0.2);
    expect(r.heat).toBeCloseTo(0.04 / 0.28);
    expect(r.gate).toMatch(/^the open coins are down 14% of the account together/);
    expect(optimize(cfg, book(), 0.28, [], [{ costSol: 0.06, valueSol: 0.05 }], 0, 0.2).gate).toBeNull();
  });

  it('one coin per narrative', () => {
    expect(sharedNarrative('Frog King', 'FROGK', [{ name: 'Frog Coin', symbol: 'FROG' }])).toBe('frog');
    expect(sharedNarrative('Moon Cat', 'MCAT', [{ name: 'Frog Coin', symbol: 'FROG' }])).toBeNull();
  });

  it('trims a winner grown past half the account back to 35 %', () => {
    expect(trimShare(0.4, 0.6, 8, cfg)).toBeCloseTo(1 - (0.35 * 0.6) / 0.4);
    expect(trimShare(0.25, 0.6, 8, cfg)).toBeNull();
    // a big position that is not a winner is the stop loss's job
    expect(trimShare(0.4, 0.6, 1.2, cfg)).toBeNull();
  });
});
