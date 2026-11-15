import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { fromBot, fromSwarm, splitSymbol, TradeJournal } from './journal.mjs';
import { costsForTests, legBps, measureCosts, MIN_COST_TRADES } from './costs.mjs';
import { drawdownR, healthOf, strategyHealth, worsened } from './health.mjs';
import { rateOn, ratesFromChart, taxCsv, taxYearOf, taxYearRange } from './tax.mjs';
import { backText, clearedText, dailyText, problemsOf, weeklyText } from './reports.mjs';
import { Care, localDay } from './care.mjs';
import { collectBackup, openBackup, passwordProblem, peekBackup, restoreBackup, sealBackup } from './backup.mjs';

const DAY = 86_400_000;
const memDb = () => {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, JSON.parse(JSON.stringify(v))) };
};
const swarmPos = (o = {}) => ({ id: 'p1', mode: 'paper', coin: 'BTC', symbol: 'BTC/USDC:USDC', agent: 'auction', side: 'buy', setup: 'Value area low', why: 'auction rejected lower prices', entry: 100, exit: 102, qty: 1, fees: 0.1, pnl: 1.9, r: 0.95, riskUsd: 2, openedAt: 1_000, closedAt: 2_000, reason: 'target', votes: [{ bot: 'tape', stance: 'for', why: 'flow with it' }], summary: 'TRADE', odds: { pWin: 0.6, expR: 0.3 }, mgmt: [{ text: 'stop to break-even' }], ...o });

describe('trade journal', () => {
  it('keeps swarm, Lab, bot and lane trades in one table, with notes that survive updates', () => {
    const j = new TradeJournal(new DatabaseSync(':memory:'));
    j.record(fromSwarm(swarmPos()));
    j.record(fromSwarm(swarmPos({ id: 'p2', labId: 'L1', mode: 'live', closedAt: 3_000 }), { labName: 'Ride the trend', venue: 'hyperliquid' }));
    j.record(fromBot({ side: 'sell', setup: 'fade', entry: 50, exit: 49, qty: 2, pnl: 1.9, fees: 0.1, opened: 10, closed: 4_000, reason: 'target', risk: 1 }, { id: 'b1', name: 'Luno lane · BTC', symbol: 'BTC/ZAR', mode: 'live', exchangeId: 'luno', lane: true }));
    const rows = j.list();
    expect(rows.map((r) => r.source)).toEqual(['swarm', 'lab', 'lane']);
    expect(rows[1]).toMatchObject({ who: 'Ride the trend', strategy_id: 'L1', venue: 'hyperliquid', mode: 'live', quote: 'USDC' });
    expect(rows[2]).toMatchObject({ quote: 'ZAR', venue: 'luno', r: 1.9 / 2 });
    expect(JSON.parse(rows[0].detail).votes[0].bot).toBe('tape');
    j.setNote('swarm:p1', 'good read');
    j.record(fromSwarm(swarmPos({ pnl: 2.5 })));
    const again = j.list({ source: 'swarm' })[0];
    expect(again.pnl).toBe(2.5);
    expect(again.note).toBe('good read');
    expect(j.list({ strategy: 'L1' })).toHaveLength(1);
    expect(j.list({ mode: 'live' })).toHaveLength(2);
  });
  it('brings in the trades from before it existed, once', () => {
    const j = new TradeJournal(new DatabaseSync(':memory:'));
    const old = { positions: [swarmPos(), swarmPos({ id: 'open', closedAt: undefined })], amtRows: [{ bot_id: 'b', bot_name: 'Scalper', symbol: 'ETH/USDT:USDT', mode: 'paper', side: 'buy', entry: 1, exit: 2, qty: 1, pnl: 1, fees: 0, opened: 1, closed: 5 }] };
    expect(j.importOld(old)).toBe(2);
    expect(j.importOld(old)).toBe(0);
    expect(splitSymbol('SOL/USDC:USDC')).toEqual({ coin: 'SOL', quote: 'USDC' });
  });
});

describe('real costs', () => {
  it('measures slippage against the decision price, both legs, live trades with real fills only', () => {
    expect(legBps('buy', 100, 100.02, 'entry')).toBeCloseTo(2);
    expect(legBps('buy', 100, 99.99, 'exit')).toBeCloseTo(1);
    expect(legBps('sell', 100, 99.97, 'entry')).toBeCloseTo(3);
    expect(legBps('buy', 100, 110, 'entry')).toBeNull();
    const rows = [];
    for (let i = 0; i < 12; i++) rows.push({ mode: 'live', venue: 'hyperliquid', side: 'buy', ask_entry: 100, entry: 100.05, ask_exit: 101, exit: 100.97, qty: 1, fees: 0.12, fee_real: 1, fills_real: 1 });
    rows.push({ mode: 'paper', venue: 'paper', side: 'buy', ask_entry: 100, entry: 110, fills_real: 1 });
    const m = measureCosts(rows);
    expect(m.paper).toBeUndefined();
    expect(m.hyperliquid.n).toBe(12);
    expect(m.hyperliquid.slips).toBe(24);
    expect(m.hyperliquid.feeBps).toBeCloseTo((0.12 / 201.97) * 1e4, 1);
    const t = costsForTests(m, { feeBps: 4.5, slipBps: 2 });
    expect(t.measured).toBe(true);
    expect(t.slipBps).toBeGreaterThan(2);
    expect(t.feeBps).toBeGreaterThanOrEqual(4.5);
  });
  it('never makes tests cheaper than assumed, and waits for enough trades', () => {
    const cheap = measureCosts(Array.from({ length: 20 }, () => ({ mode: 'live', venue: 'x', side: 'buy', ask_entry: 100, entry: 100, ask_exit: 100, exit: 100, qty: 1, fees: 0.01, fee_real: 1, fills_real: 1 })));
    expect(costsForTests(cheap, { feeBps: 4.5, slipBps: 2 })).toMatchObject({ feeBps: 4.5, slipBps: 2, measured: true });
    const few = measureCosts(Array.from({ length: 3 }, () => ({ mode: 'live', venue: 'x', side: 'buy', ask_entry: 100, entry: 101, ask_exit: 100, exit: 99, qty: 1, fills_real: 1 })));
    expect(costsForTests(few, { feeBps: 4.5, slipBps: 2 })).toMatchObject({ feeBps: 4.5, slipBps: 2, measured: false });
    expect(MIN_COST_TRADES).toBe(10);
  });
});

describe('strategy health', () => {
  const d = { id: 's', name: 'Trend', deployedAt: 0, on: true, stats: { winRate: 0.55, avgR: 0.3, perYear: 50 } };
  const rows = (rs) => rs.map((r, i) => ({ r, pnl: r * 10, closed: (i + 1) * DAY }));
  it('says too early, on track, behind and stopped as the evidence grows', () => {
    expect(healthOf(d, rows([1, -1, 1]), null, 4 * DAY).status).toBe('early');
    expect(healthOf(d, rows([1, -1, 1.2, 0.8, -1, 1.1, -1, 1.5, 0.9, -1]), null, 11 * DAY).status).toBe('ok');
    const bad = rows(Array.from({ length: 14 }, (_, i) => (i % 5 === 0 ? 1 : -1)));
    const h = healthOf(d, bad, null, 15 * DAY);
    expect(h.status).toBe('stopped');
    expect(h.words).toMatch(/consider switching it off/);
    expect(healthOf(d, rows([-1, -1, 1, -1, -1, 0.5, -1, -1, 1, -1]), null, 11 * DAY).status).toBe('behind');
  });
  it('notices a strategy that has gone quiet, and tells each worsening once', () => {
    expect(healthOf(d, [], null, 30 * DAY).status).toBe('quiet');
    const hs = strategyHealth([d, { ...d, id: 't', name: 'B' }], { s: rows(Array.from({ length: 14 }, (_, i) => (i % 5 === 0 ? 1 : -1))) }, {}, 15 * DAY);
    expect(hs[0].status).toBe('stopped');
    expect(hs[1].status).toBe('early');
    expect(worsened({}, hs).map((h) => h.id)).toEqual(['s']);
    expect(worsened({ s: 'stopped' }, hs)).toEqual([]);
    expect(drawdownR([1, -2, -1, 3])).toBe(3);
  });
});

describe('tax export', () => {
  it('uses the South African tax year and the rand rate of each trade’s day', () => {
    expect(taxYearOf(Date.UTC(2026, 1, 28, 12))).toBe(2026);
    expect(taxYearOf(Date.UTC(2026, 2, 1, 12))).toBe(2027);
    // 23:30 UTC on 28 Feb is already 1 March in South Africa
    expect(taxYearOf(Date.UTC(2026, 1, 28, 23, 30))).toBe(2027);
    const [from, to] = taxYearRange(2026);
    expect(new Date(from).toISOString()).toBe('2025-02-28T22:00:00.000Z');
    expect(to - from).toBe(365 * DAY);
    const rates = { '2025-06-13': 18 };
    expect(rateOn(rates, Date.UTC(2025, 5, 15, 10))).toBe(18);
    const rows = [
      { mode: 'live', source: 'lab', who: 'Trend', venue: 'hyperliquid', symbol: 'BTC/USDC:USDC', quote: 'USDC', side: 'buy', qty: 1, entry: 1, exit: 2, fees: 1, pnl: 10, closed: Date.UTC(2025, 5, 13, 10), opened: Date.UTC(2025, 5, 12) },
      { mode: 'live', source: 'lane', who: 'Luno lane · BTC', venue: 'luno', symbol: 'BTC/ZAR', quote: 'ZAR', side: 'buy', qty: 1, entry: 1, exit: 2, fees: 5, pnl: -100, closed: Date.UTC(2025, 6, 1), note: 'a "quoted", note' },
      { mode: 'paper', source: 'swarm', pnl: 999, fees: 0, closed: Date.UTC(2025, 6, 1) },
      { mode: 'live', source: 'swarm', pnl: 50, fees: 0, quote: 'USDC', closed: Date.UTC(2026, 3, 1) },
    ];
    const out = taxCsv(rows, rates, 2026);
    expect(out.trades).toBe(2);
    expect(out.totals).toEqual({ gainsZar: 180, lossesZar: 100, feesZar: 23, netZar: 80 });
    expect(out.csv).toContain('"a ""quoted"", note"');
    expect(out.csv).toMatch(/Not tax advice/);
    expect(out.missingRates).toBe(0);
    expect(ratesFromChart({ chart: { result: [{ timestamp: [Date.UTC(2025, 5, 13) / 1000], indicators: { quote: [{ close: [18.2] }] } }] } })).toEqual({ '2025-06-13': 18.2 });
  });
});

describe('messages', () => {
  const now = Date.UTC(2026, 10, 15, 6);
  const swarm = { running: true, mode: 'paper', equity: 1041.2, open: [{ coin: 'BTC', side: 'buy', upnl: 4.1 }], coins: [{ coin: 'BTC', feed: 'open' }, { coin: 'ETH', feed: 'reconnecting', feedError: 'socket closed' }], book: {} };
  it('finds what needs a look, and only what does', () => {
    const p = problemsOf({ now, swarm, wanted: { swarm: true }, farm: { wanted: true, running: false }, screen: 'frozen', errors: [{ key: 'x', text: 'EXIT FAILED' }] });
    expect(p.map((x) => x.key)).toEqual(['feed:ETH', 'farm-down', 'screen', 'err:x']);
    expect(problemsOf({ now, swarm: { ...swarm, running: false }, wanted: { swarm: false } })).toEqual([]);
    expect(problemsOf({ now, swarm: { ...swarm, running: false }, wanted: { swarm: true } })[0].key).toBe('swarm-stopped');
  });
  it('writes the daily message, the all-clear and the weekly report in plain words', () => {
    const t = dailyText({ now, swarm, problems: [], day: [{ pnl: 5, quote: 'USDC' }, { pnl: -2, quote: 'USDC' }, { pnl: 100, quote: 'ZAR' }], health: [{ status: 'ok' }, { status: 'early' }], farm: { running: true, tried: 41230, survivors: 7, data: { ok: true, lastOkAt: now - 600_000 } }, equityDayAgo: 1030, nextAt: now + DAY });
    expect(t).toMatch(/all running/);
    expect(t).toMatch(/\$1,041\.20/);
    expect(t).toMatch(/2 trades, 1 won, <b>\+\$3\.00<\/b> · 1 trade, 1 won, <b>\+R100\.00<\/b>/);
    expect(t).toMatch(/41,230 bots tried/);
    expect(t).toMatch(/BTC ✓ · ETH ✗/);
    expect(clearedText(['feed:ETH', 'swarm-stopped'], { now })).toMatch(/Prices for ETH are back[\s\S]*crypto swarm is running again/);
    expect(backText(now - 3 * 3_600_000, now)).toMatch(/3 h/);
    const w = weeklyText({ now, from: now - 7 * DAY, mode: 'paper', equityStart: 1000, equityNow: 1041.2, rows: [{ source: 'swarm', who: 'auction', mode: 'paper', pnl: 5, r: 0.5, fees: 0.2, quote: 'USDC', coin: 'BTC', side: 'buy', detail: JSON.stringify({ odds: { expR: 0.3 } }) }, { source: 'lab', strategy_id: 's', who: 'Trend', mode: 'paper', pnl: -2, r: -1, fees: 0.1, quote: 'USDC', coin: 'ETH', side: 'sell' }], health: [{ id: 's', name: 'Trend', on: true, status: 'early', words: '1 of 8 trades — too early to tell' }], costs: { why: 'no live trades yet — the assumed costs' }, farm: { tried: 100, survivors: 2, tops: [{ id: 'swing', name: 'Swing', rows: [{ name: 'Breakout' }] }] }, farmWeek: 60 });
    expect(w).toMatch(/your week/);
    expect(w).toMatch(/Auctioneer: 1 trade, 1 won, \+\$5\.00, \+0\.50R a trade \(expected \+0\.30R\) — as expected or better/);
    expect(w).toMatch(/\$1,000\.00 → <b>\$1,041\.20<\/b> \(\+4\.1%\)/);
    expect(w).toMatch(/⚪ Trend: 1 trade, 0 won/);
    expect(w).toMatch(/60 bots tried this week/);
    expect(w).toMatch(/Swing: Breakout/);
  });
});

describe('care service', () => {
  const setup = (o = {}) => {
    let t = new Date(2026, 10, 15, 7, 59).getTime();
    const sent = [];
    const db = memDb();
    const journal = new TradeJournal(new DatabaseSync(':memory:'));
    const state = { swarm: { running: true, mode: 'paper', equity: 1000, open: [], coins: [{ coin: 'BTC', feed: 'open' }], book: {} } };
    const care = new Care({ db, journal, send: async (id, html) => sent.push({ id, html }), swarm: () => state.swarm, lab: () => ({ farm: null, deployed: o.deployed ?? [], labBook: {} }), bots: () => [], now: () => t });
    care.setConfig({ secretId: 'tg1' });
    return { care, sent, db, journal, state, at: (ms) => (t = ms), get t() {
      return t;
    } };
  };
  it('sends the daily message once a day at its hour', async () => {
    const s = setup();
    s.care.start();
    s.care.stop();
    await s.care.tick();
    expect(s.sent).toHaveLength(0);
    s.at(new Date(2026, 10, 15, 8, 1).getTime());
    await s.care.tick();
    await s.care.tick();
    expect(s.sent.filter((m) => /all running/.test(m.html))).toHaveLength(1);
    expect(s.db.get('care:state').lastDaily).toBe(localDay(s.t));
  });
  it('warns when the swarm stops on its own (not when you stop it), and says when it is back', async () => {
    const s = setup();
    s.care.setConfig({ daily: false, weekly: false });
    s.care.setWanted('swarm', true);
    s.state.swarm = { ...s.state.swarm, running: false };
    await s.care.tick();
    expect(s.sent).toHaveLength(0);
    s.at(s.t + 4 * 60_000);
    await s.care.tick();
    expect(s.sent.at(-1).html).toMatch(/not running/);
    s.at(s.t + 60_000);
    await s.care.tick();
    expect(s.sent).toHaveLength(1);
    s.state.swarm = { ...s.state.swarm, running: true };
    await s.care.tick();
    expect(s.sent.at(-1).html).toMatch(/Back to normal[\s\S]*running again/);
    s.care.setWanted('swarm', false);
    s.state.swarm = { ...s.state.swarm, running: false };
    s.at(s.t + 10 * 60_000);
    await s.care.tick();
    expect(s.sent).toHaveLength(2);
  });
  it('says how long it was off, and tells a failed exit at once', async () => {
    const s = setup();
    s.db.set('care:lastSeen', s.t - 5 * 3_600_000);
    s.care.setConfig({ daily: false });
    s.care.start();
    s.care.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.sent[0].html).toMatch(/running again[\s\S]*5 h/);
    s.care.error('risk:x', 'BTC: EXIT FAILED — timeout');
    await s.care.tick();
    expect(s.sent.at(-1).html).toMatch(/EXIT FAILED/);
  });
  it('tells a strategy that falls behind its test, once', async () => {
    const s = setup({ deployed: [{ id: 'L', name: 'Trend', deployedAt: 0, on: true, stats: { winRate: 0.6 } }] });
    s.care.setConfig({ daily: false, weekly: false });
    for (let i = 0; i < 14; i++) s.journal.record(fromSwarm(swarmPos({ id: `x${i}`, labId: 'L', pnl: i % 5 ? -1 : 1, r: i % 5 ? -1 : 1, openedAt: 10 + i, closedAt: 100 + i })));
    await s.care.tick();
    expect(s.sent.filter((m) => /Trend<\/b> — may have stopped working/.test(m.html))).toHaveLength(1);
    s.at(s.t + 3_600_000);
    await s.care.tick();
    expect(s.sent.filter((m) => /may have stopped working/.test(m.html))).toHaveLength(1);
    expect(s.sent.at(-1).html).toMatch(/your decision/);
  });
  it('sends the weekly report on its day', async () => {
    const s = setup();
    s.care.setConfig({ daily: false, weekday: 0, weeklyHour: 18 });
    s.at(new Date(2026, 10, 15, 18, 5).getTime());
    expect(new Date(s.t).getDay()).toBe(0);
    await s.care.tick();
    expect(s.sent.at(-1).html).toMatch(/your week/);
    await s.care.tick();
    expect(s.sent.filter((m) => /your week/.test(m.html))).toHaveLength(1);
  });
  it('sends nothing without a Telegram bot', async () => {
    const s = setup();
    s.care.setConfig({ secretId: '' });
    s.at(new Date(2026, 10, 15, 9).getTime());
    await s.care.tick();
    expect(s.sent).toHaveLength(0);
  });
});

describe('backups', () => {
  it('round-trips everything under a password, and refuses a wrong one', () => {
    const sql = new DatabaseSync(':memory:');
    sql.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL); CREATE TABLE wallets (address TEXT PRIMARY KEY, chain TEXT NOT NULL, label TEXT, verified INTEGER NOT NULL, connected_at INTEGER NOT NULL); CREATE TABLE amt_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, bot_name TEXT, symbol TEXT, mode TEXT, setup TEXT, side TEXT, entry REAL, exit REAL, qty REAL, pnl REAL, fees REAL, opened INTEGER, closed INTEGER NOT NULL, reason TEXT); CREATE TABLE orders_log (id INTEGER PRIMARY KEY, t INTEGER);');
    sql.prepare('INSERT INTO kv VALUES (?, ?)').run('cswarm:cfg', JSON.stringify({ risk: 1 }));
    sql.prepare('INSERT INTO kv VALUES (?, ?)').run('care:lastSeen', '1');
    sql.prepare("INSERT INTO amt_trades (bot_id, closed, pnl) VALUES ('b', 5, 1)").run();
    const journal = new TradeJournal(sql);
    journal.record(fromSwarm(swarmPos()));
    const saved = new Map([['k1', { label: 'Hyperliquid', kind: 'exchange', exchange: 'hyperliquid', fields: { apiKey: 'AK', secret: 'SECRET' } }]]);
    const vault = { list: () => [...saved.keys()].map((id) => ({ id })), reveal: (id) => saved.get(id), save: (r) => saved.set(r.id, r) };
    const { contents, summary } = collectBackup({ sql, vault, journal, labFiles: { 'deployed.json': [{ id: 'L' }] }, storage: { 'novus-settings': '{"theme":"gold"}' } });
    expect(summary).toEqual({ keys: 1, trades: 1, strategies: 1, settings: 1 });
    expect(contents.kv['care:lastSeen']).toBeUndefined();
    const file = sealBackup(contents, 'correct horse battery', { app: '1.0.0', summary, created: 5 });
    expect(file).not.toContain('SECRET');
    expect(peekBackup(file)).toMatchObject({ created: 5, summary });
    expect(() => openBackup(file, 'wrong password!!')).toThrow(/Wrong password/);
    const tampered = JSON.parse(file);
    tampered.summary = { keys: 0 };
    expect(() => openBackup(JSON.stringify(tampered), 'correct horse battery')).toThrow(/Wrong password|changed/);
    const back = openBackup(file, 'correct horse battery').contents;
    // a fresh computer
    const sql2 = new DatabaseSync(':memory:');
    sql2.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL); CREATE TABLE wallets (address TEXT PRIMARY KEY, chain TEXT NOT NULL, label TEXT, verified INTEGER NOT NULL, connected_at INTEGER NOT NULL); CREATE TABLE amt_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, bot_name TEXT, symbol TEXT, mode TEXT, setup TEXT, side TEXT, entry REAL, exit REAL, qty REAL, pnl REAL, fees REAL, opened INTEGER, closed INTEGER NOT NULL, reason TEXT);');
    const j2 = new TradeJournal(sql2);
    const saved2 = new Map();
    const lab = {};
    const r = restoreBackup(back, { sql: sql2, vault: { save: (x) => saved2.set(x.id, x) }, journal: j2, writeLab: (n, v) => (lab[n] = v) });
    expect(r).toMatchObject({ keys: 1, trades: 1, files: 1, storage: { 'novus-settings': '{"theme":"gold"}' } });
    expect(saved2.get('k1').fields.secret).toBe('SECRET');
    expect(JSON.parse(sql2.prepare("SELECT v FROM kv WHERE k = 'cswarm:cfg'").get().v)).toEqual({ risk: 1 });
    expect(sql2.prepare('SELECT COUNT(*) AS n FROM amt_trades').get().n).toBe(1);
    restoreBackup(back, { sql: sql2, vault: { save: () => 0 }, journal: j2, writeLab: () => 0 });
    expect(sql2.prepare('SELECT COUNT(*) AS n FROM amt_trades').get().n).toBe(1);
    expect(lab['deployed.json']).toEqual([{ id: 'L' }]);
  });
  it('asks for a password that is hard to guess', () => {
    expect(passwordProblem('short')).toMatch(/10 characters/);
    expect(passwordProblem('aaaaaaaaaaaa')).toMatch(/too easy/);
    expect(passwordProblem('my own long phrase')).toBeNull();
    expect(() => sealBackup({}, 'short')).toThrow();
    expect(() => peekBackup('{"x":1}')).toThrow(/not a Novus Ordo backup/);
  });
});
