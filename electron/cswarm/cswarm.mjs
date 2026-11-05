// The crypto swarm: a team of agents trading crypto perpetuals on Hyperliquid,
// beside (and independent of) the meme swarm. It has its own account (the
// Hyperliquid wallet), its own paper book, its own record and its own forest.
//
// Per coin there is one market feed (trades, book, liquidations, funding),
// shared by every agent on it:
//   Scalper     an AMT engine in the adaptive (order-flow) style
//   Auctioneer  an AMT engine in the intraday (value area, IB) style
//   Trend       hourly breakouts in the daily trend's direction (agents.mjs)
// Each proposal goes to the council (brain.mjs) with the Tape, Crowd, Guardian,
// Forest and Risk votes. One position per coin, a few at most in all, sized by
// the compounding risk manager (risk.mjs). The engine that proposed a trade
// manages it (break-even, trails, its own judgement); the Trend agent manages
// its own. Every decision is logged in plain words, and the three moments of a
// trade — the setup, how it is being managed, the result — are sent to the
// app to draw and send to Telegram.
//
// Trades the council turned down are followed anyway (the shadow book), so the
// forest learns from paper, live and refused trades alike.
import { randomUUID } from 'node:crypto';
import { ADAPTIVE_PRESET, AmtEngine, INTRADAY_PRESET } from '../amt/engine.mjs';
import { AGENT_NAME, CCOUNCIL_DEFAULTS, councilR, dirOf, features, MARK, oddsR, PROPOSERS, rClass, trainForest } from './brain.mjs';
import { newBook, recordClose, RISK_DEFAULTS, riskGate, shiftBook, sizeTrade, updateBook } from './risk.mjs';
import { atrOf, dailyTrendOf, manageTrend, Shadow, TREND_AGENT_DEFAULTS, trendCandidate } from './agents.mjs';

const MIN = 60_000;
const HOUR = 3_600_000;

export const CSWARM_DEFAULTS = {
  exchangeId: 'hyperliquid',
  coins: ['BTC', 'ETH', 'SOL'],
  agents: { scalper: true, auction: true, trend: true },
  /** the paper account starts with this (USDC) */
  paperStartUsd: 30,
  /** taker fee and slippage per side, bps (Hyperliquid base tier: 4.5 bps taker) */
  feeBps: 4.5,
  slippageBps: 2,
  risk: { ...RISK_DEFAULTS },
  council: { ...CCOUNCIL_DEFAULTS },
};

export function mergeCfg(p = {}) {
  const c = { ...CSWARM_DEFAULTS, ...(p ?? {}) };
  c.agents = { ...CSWARM_DEFAULTS.agents, ...(p?.agents ?? {}) };
  c.risk = { ...RISK_DEFAULTS, ...(p?.risk ?? {}) };
  c.council = { ...CCOUNCIL_DEFAULTS, ...(p?.council ?? {}) };
  c.coins = Array.isArray(p?.coins) && p.coins.length ? p.coins.map((x) => String(x).toUpperCase().trim()).filter(Boolean).slice(0, 8) : CSWARM_DEFAULTS.coins;
  return c;
}

export const symbolFor = (coin, exchangeId = 'hyperliquid') => (exchangeId === 'hyperliquid' ? `${coin}/USDC:USDC` : `${coin}/USDT:USDT`);
const tidy = (v) => (Number.isFinite(v) ? Number(v.toPrecision(6)) : v);
const usd = (v) => `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;

export class CryptoSwarm {
  /**
   * @param o.ccxt CcxtService (subscribe, unsubscribe, ohlcv, placeOrder, cancelOrder, marketInfo, accountBalance, prepareMargin, positionContracts)
   * @param o.db { get(key), set(key, value) }
   * @param o.emit (channel, payload) => void — 'state' and 'event' to the app
   */
  constructor({ ccxt, db, emit = () => {}, now = Date.now, log = () => {} }) {
    this.ccxt = ccxt;
    this.db = db;
    this.emitFn = emit;
    this.now = now;
    this.logFn = log;
    this.cfg = mergeCfg(db.get('cswarm:cfg'));
    const m = db.get('cswarm:mode') ?? {};
    this.mode = m.mode === 'live' ? 'live' : 'paper';
    this.secretId = m.secretId ?? null;
    this.paper = db.get('cswarm:paper') ?? { cash: this.cfg.paperStartUsd, book: newBook(this.cfg.paperStartUsd, now()) };
    this.liveBook = db.get('cswarm:liveBook') ?? null;
    this.positions = db.get('cswarm:positions') ?? [];
    this.samples = db.get('cswarm:samples') ?? [];
    this.lines = [];
    this.running = false;
    this.coins = new Map();
    this.forest = null;
    this.trainedN = 0;
    this.shadow = new Shadow();
    this.liveEquity = NaN;
    this.sandbox = false;
    this.lastSaid = new Map();
    this.lastState = 0;
    // anything left open from before a restart is managed by the swarm itself
    for (const p of this.positions) if (!p.closedAt) p.owner = 'swarm';
  }

  // ---------- the books ----------

  book() {
    return this.mode === 'live' ? this.liveBook ?? newBook(this.liveEquity > 0 ? this.liveEquity : 0, this.now()) : this.paper.book;
  }
  setBook(b) {
    if (this.mode === 'live') this.liveBook = b;
    else this.paper.book = b;
  }
  open(mode = this.mode) {
    return this.positions.filter((p) => !p.closedAt && p.mode === mode);
  }
  openOn(coin) {
    return this.open().find((p) => p.coin === coin) ?? null;
  }
  upnl(p) {
    const px = this.coins.get(p.coin)?.price;
    return Number.isFinite(px) ? (px - p.entry) * p.qty * dirOf(p.side) : 0;
  }
  equity() {
    if (this.mode === 'live') return this.liveEquity;
    return this.paper.cash + this.open('paper').reduce((a, p) => a + this.upnl(p), 0);
  }

  // ---------- control ----------

  setConfig(patch) {
    if (this.running) throw new Error('stop the crypto swarm before changing its settings');
    this.cfg = mergeCfg({ ...this.cfg, ...patch, agents: { ...this.cfg.agents, ...(patch?.agents ?? {}) }, risk: { ...this.cfg.risk, ...(patch?.risk ?? {}) }, council: { ...this.cfg.council, ...(patch?.council ?? {}) } });
    this.db.set('cswarm:cfg', this.cfg);
    this.pushState(true);
    return this.cfg;
  }

  setMode(mode, secretId = null) {
    if (this.running) throw new Error('stop the crypto swarm before switching between paper and live');
    this.mode = mode === 'live' ? 'live' : 'paper';
    this.secretId = this.mode === 'live' ? secretId : this.secretId;
    if (this.mode === 'live' && !this.secretId) throw new Error('choose your Hyperliquid key for live trading');
    this.db.set('cswarm:mode', { mode: this.mode, secretId: this.secretId });
    this.pushState(true);
  }

  resetPaper() {
    if (this.running && this.mode === 'paper') throw new Error('stop the crypto swarm first');
    this.paper = { cash: this.cfg.paperStartUsd, book: newBook(this.cfg.paperStartUsd, this.now()) };
    this.positions = this.positions.filter((p) => p.mode !== 'paper');
    this.persist();
    this.say('risk', `paper account reset to ${usd(this.cfg.paperStartUsd)} — the forest keeps what it learned`);
  }

  async start() {
    if (this.running) return true;
    const c = this.cfg;
    if (this.mode === 'live') {
      if (!this.secretId) throw new Error('choose your Hyperliquid key for live trading');
      const info = await this.ccxt.marketInfo(this.secretId, symbolFor(c.coins[0], c.exchangeId));
      if (!info.trading) throw new Error('Trading is off for this key — tick “Allow trading” on it under 🔌 Connect');
      if (!info.contract) throw new Error('the crypto swarm trades perpetual futures — choose a Hyperliquid key');
      this.sandbox = Boolean(info.sandbox);
      await this.refreshEquity();
      if (!(this.liveEquity > 0)) throw new Error('no USDC on the Hyperliquid account yet — deposit first (at least 5 USDC)');
      if (!this.liveBook || !(this.liveBook.start > 0)) this.liveBook = newBook(this.liveEquity, this.now());
      for (const coin of c.coins) {
        const notes = await this.ccxt.prepareMargin(this.secretId, symbolFor(coin, c.exchangeId), c.risk.perCoinLeverage).catch((e) => [String(e?.message ?? e)]);
        for (const n of notes) this.say('risk', `${coin}: ${n}`, 'warn');
      }
    } else this.sandbox = false;
    this.running = true;
    this.startedAt = this.now();
    for (const coin of c.coins) this.setupCoin(coin);
    this.timer = setInterval(() => this.tick(), 1000);
    this.slowTimer = setInterval(() => void this.slow(), MIN);
    void this.slow();
    void this.retrain(true);
    const agents = PROPOSERS.filter((a) => c.agents[a]).map((a) => AGENT_NAME[a]).join(', ');
    this.say('swarm', `${this.mode === 'live' ? `LIVE${this.sandbox ? ' (testnet)' : ''}` : 'Paper'} — ${c.coins.join(', ')} on ${c.exchangeId}; ${agents} propose, the council decides. Account ${usd(this.equity())}.`);
    this.pushState(true);
    return true;
  }

  async stop({ flatten = false } = {}) {
    if (!this.running) return false;
    if (flatten) for (const p of this.open()) await this.close(p, 'stopped by you', this.coins.get(p.coin)?.price);
    this.running = false;
    clearInterval(this.timer);
    clearInterval(this.slowTimer);
    for (const cs of this.coins.values()) this.ccxt.unsubscribe(cs.sid);
    this.coins.clear();
    const left = this.open().length;
    this.say('swarm', `Stopped${left ? ` — ${left} position${left > 1 ? 's' : ''} left open${this.mode === 'live' ? ' with the exchange stop in place' : ''}; the swarm manages ${left > 1 ? 'them' : 'it'} again when started` : ''}.`);
    this.persist();
    this.pushState(true);
    return true;
  }

  setupCoin(coin) {
    const c = this.cfg;
    const cs = { coin, symbol: symbolFor(coin, c.exchangeId), sid: `cswarm-${coin}`, price: NaN, funding: null, daily: null, dailyAt: 0, hourly: [], hourlyAt: 0, lastBar: 0, engines: {}, busy: false, feed: 'connecting', feedError: null };
    const eq = this.equity() > 0 ? this.equity() : c.paperStartUsd;
    for (const agent of ['scalper', 'auction']) {
      if (!c.agents[agent]) continue;
      const base = agent === 'scalper' ? ADAPTIVE_PRESET : INTRADAY_PRESET;
      const e = new AmtEngine({ ...base, orderMode: 'taker', sizing: 'balance', accountUsd: eq, feeBps: c.feeBps, slippageBps: c.slippageBps, minNotionalUsd: 0, maxLeverage: c.risk.perCoinLeverage, dailyLossPct: 100, maxDrawdownPct: 100, lossStreak: 0, trendFilter: true });
      e.liveBalance = eq;
      cs.engines[agent] = e;
    }
    this.coins.set(coin, cs);
    this.ccxt.subscribe(cs.sid, c.exchangeId, cs.symbol, (m) => this.onMessage(coin, m), { sandbox: this.sandbox, liquidations: true });
  }

  // ---------- market data ----------

  onMessage(coin, m) {
    const cs = this.coins.get(coin);
    if (!cs || !this.running) return;
    if (m.kind === 'status') {
      cs.feed = m.state;
      cs.feedError = m.error ?? null;
      if (m.state === 'error') this.sayOnce(`feed:${coin}`, 'guardian', `${coin} market data: ${m.error}`, 'warn', 5 * MIN);
      return;
    }
    if (m.kind === 'stats') {
      if (Number.isFinite(m.stats?.fundingRate)) cs.funding = m.stats.fundingRate;
      return;
    }
    for (const [agent, e] of Object.entries(cs.engines)) {
      if (m.kind === 'book') e.onBook(m.bids, m.asks);
      else if (m.kind === 'liquidations') e.onLiquidations(m.items);
      else if (m.kind === 'trades') {
        for (const t of m.trades) this.handle(coin, agent, e.onTrade(t));
      }
    }
    if (m.kind === 'trades' && m.trades.length) {
      const t = m.trades[m.trades.length - 1];
      cs.price = t.p;
      this.onPrice(coin, t.p, t.t);
    }
  }

  /** Every price: the shadow book, the Trend agent's management, decisions on engine-managed trades. */
  onPrice(coin, p, t) {
    for (const s of this.shadow.onPrice(coin, p, t)) this.learn(s.x, s.r, 'shadow', s.agent);
    const pos = this.openOn(coin);
    if (!pos || pos.closing) return;
    const cs = this.coins.get(coin);
    if (pos.owner === 'swarm') {
      const r = manageTrend(pos, p, t, { ...TREND_AGENT_DEFAULTS, maxHoldH: pos.agent === 'trend' ? TREND_AGENT_DEFAULTS.maxHoldH : 12 });
      if (r?.note) this.decision(pos, r.note);
      if (r?.exit) void this.close(pos, r.exit, p);
    } else {
      const e = cs?.engines[pos.agent];
      const ep = e?.pos;
      if (ep && Math.abs(ep.stop - pos.stop) > pos.risk * 0.05) {
        const why = ep.trailed && !pos.trailed ? `trailing the stop to the session's point of control (${tidy(ep.stop)})` : ep.be && !pos.be ? `stop to break-even plus costs (${tidy(ep.stop)}): this trade can no longer lose` : `stop moved to ${tidy(ep.stop)}`;
        pos.stop = ep.stop;
        pos.be = Boolean(ep.be);
        pos.trailed = Boolean(ep.trailed);
        this.decision(pos, why);
      }
    }
    // no decision yet, but halfway to the target: say why it is held
    const dir = dirOf(pos.side);
    const prog = ((p - pos.entry) * dir) / Math.abs(pos.target - pos.entry);
    if (!pos.notified?.manage && prog >= 0.5) this.decision(pos, `halfway to the target (${tidy(pos.target)}), up ${(((p - pos.entry) * dir) / pos.risk).toFixed(1)}R — holding: the reason for the trade still stands, stop at ${tidy(pos.stop)}`);
    if (this.mode === 'live') void this.syncStop(pos);
  }

  /** A management decision on an open trade: logged, and the first one goes to the phone. */
  decision(pos, text) {
    pos.mgmt = [...(pos.mgmt ?? []), { t: this.now(), text }].slice(-12);
    this.say(pos.agent, `${pos.coin}: ${text}`);
    if (!pos.notified?.manage) {
      pos.notified = { ...pos.notified, manage: true };
      this.notify('manage', pos);
    }
    this.persist();
  }

  tick() {
    if (!this.running) return;
    const now = this.now();
    for (const [coin, cs] of this.coins) for (const [agent, e] of Object.entries(cs.engines)) this.handle(coin, agent, e.tick(now));
    if (now - this.lastState >= 1000) this.pushState();
  }

  /** Every minute: candles, the Trend agent, the account, the books, learning. */
  async slow() {
    if (!this.running) return;
    const now = this.now();
    const c = this.cfg;
    for (const cs of this.coins.values()) {
      try {
        if (now - cs.dailyAt >= 6 * HOUR) {
          const rows = await this.ccxt.ohlcv(c.exchangeId, cs.symbol, '1d', 200);
          const closed = rows.filter((r) => r.time + 24 * HOUR <= now);
          cs.daily = dailyTrendOf(closed);
          for (const e of Object.values(cs.engines)) e.setDaily(rows);
          cs.dailyAt = now;
        }
        if (c.agents.trend && now - cs.hourlyAt >= 15 * MIN) {
          cs.hourly = await this.ccxt.ohlcv(c.exchangeId, cs.symbol, '1h', 60);
          cs.hourlyAt = now;
        }
        if (c.agents.trend && cs.hourly.length) {
          const cand = trendCandidate(cs.hourly, cs.daily, TREND_AGENT_DEFAULTS, now);
          if (cand && cand.bar > cs.lastBar) {
            cs.lastBar = cand.bar;
            const price = Number.isFinite(cs.price) ? cs.price : cand.price;
            const shift = price - cand.price;
            this.propose(cs.coin, 'trend', { ...cand, price, stop: cand.stop + shift, target: cand.target + shift });
          }
        }
      } catch (err) {
        this.sayOnce(`candles:${cs.coin}`, 'trend', `${cs.coin}: candles unavailable (${err?.message ?? err}) — trying again`, 'warn', 30 * MIN);
      }
    }
    if (this.mode === 'live') await this.refreshEquity();
    const eq = this.equity();
    if (eq > 0) {
      this.setBook(updateBook(this.book(), eq, c.risk, now));
      for (const cs of this.coins.values()) for (const e of Object.values(cs.engines)) e.liveBalance = eq;
    }
    if (now - (this.trainedAt ?? 0) >= 10 * MIN) await this.retrain();
    this.persist();
  }

  async refreshEquity() {
    try {
      const prev = this.liveEquity;
      const v = await this.ccxt.accountBalance(this.secretId, symbolFor(this.cfg.coins[0], this.cfg.exchangeId));
      if (!(v >= 0)) return;
      this.liveEquity = v;
      // a change no trade explains is a deposit or a withdrawal: the record moves with it
      if (prev > 0 && this.liveBook && !this.open('live').length && !this.inFlight) {
        const moved = v - prev - (this.liveFlow ?? 0);
        if (Math.abs(moved) >= Math.max(1, prev * 0.05)) {
          this.liveBook = shiftBook(this.liveBook, moved);
          this.say('risk', `${moved > 0 ? 'deposit' : 'withdrawal'} of ${usd(Math.abs(moved))} noticed — counted as money moved, not as a ${moved > 0 ? 'gain' : 'loss'}`);
        }
      }
      this.liveFlow = 0;
    } catch (err) {
      this.sayOnce('equity', 'risk', `account value unavailable: ${err?.message ?? err}`, 'warn', 10 * MIN);
    }
  }

  // ---------- decisions ----------

  handle(coin, agent, intents) {
    const cs = this.coins.get(coin);
    const e = cs?.engines[agent];
    if (!e) return;
    if (e.brain) {
      const pos = this.openOn(coin);
      for (const th of e.brain.drain()) if (pos && pos.owner === 'engine' && pos.agent === agent && /cut|stall|trail|bank|run|steam|stop/i.test(th.text)) this.decision(pos, th.text);
    }
    for (const it of intents) {
      if (it.type === 'enter') this.propose(coin, agent, { side: it.side, price: it.price, stop: it.stop, target: it.target, setup: it.setup, why: it.reason });
      else if (it.type === 'exit') {
        const pos = this.openOn(coin);
        if (pos && pos.owner === 'engine' && pos.agent === agent) void this.close(pos, it.reason, it.price);
        else e.failed('no open swarm position');
      }
    }
  }

  ctxOf(cs, agent) {
    const e = cs.engines[agent] ?? cs.engines.scalper ?? cs.engines.auction ?? null;
    const flow = e ? e.flowStats() : null;
    const book = e ? e.bookStats() : null;
    const k = e?.candles?.slice(-16) ?? [];
    let tr = 0;
    for (let i = 1; i < k.length; i++) tr += Math.max(k[i][2] - k[i][3], Math.abs(k[i][2] - k[i - 1][4]), Math.abs(k[i][3] - k[i - 1][4]));
    const volBps = k.length > 2 && cs.price > 0 ? (tr / (k.length - 1) / cs.price) * 1e4 : null;
    const mine = this.positions.filter((p) => p.closedAt && p.agent === agent).slice(-20);
    return {
      daily: cs.daily ? { dir: cs.daily.dir, up: cs.daily.up } : null,
      flow: flow && flow.buy + flow.sell > 0 ? { deltaRatio: flow.deltaRatio, intensity: flow.intensity } : null,
      book: book ? { imbalance: book.imbalance, spreadBps: book.spreadBps } : null,
      funding: Number.isFinite(cs.funding) ? cs.funding : null,
      volBps,
      va: e?.sessionVa ?? e?.va ?? null,
      agentWin: mine.length >= 5 ? mine.filter((p) => p.pnl > 0).length / mine.length : 0.5,
    };
  }

  /** A strategy agent proposes; the council decides; the risk manager sizes; it is executed. */
  propose(coin, agent, p) {
    const cs = this.coins.get(coin);
    const e = cs?.engines[agent] ?? null;
    const c = this.cfg;
    if (!cs || !this.running || cs.busy || this.openOn(coin)) {
      e?.failed(cs?.busy || this.openOn(coin) ? `the swarm already holds ${coin}` : 'stopped');
      return;
    }
    const t = this.now();
    const cand = { agent, coin, symbol: cs.symbol, side: p.side, price: p.price, stop: p.stop, target: p.target, setup: p.setup, why: p.why, t, ctx: this.ctxOf(cs, agent) };
    const x = features(cand);
    const costBps = 2 * (c.feeBps + c.slippageBps);
    const odds = oddsR(x, this.forest, costBps);
    const equity = this.equity();
    const book = this.book();
    const open = this.open();
    const gate = riskGate(book, equity, open.length, c.risk, t);
    const size = gate ? null : sizeTrade({ price: p.price, stop: p.stop, side: p.side, equity, book, openNotional: open.reduce((a, q) => a + q.notional, 0), expR: odds.expR, maxLev: c.risk.perCoinLeverage }, c.risk);
    const sizeNote = size && !size.skip ? `risking ${size.riskPct.toFixed(2)}% of the account (${usd(size.riskUsd)}) on a ${usd(size.notional)} position, ${size.lev.toFixed(1)}× the account${size.why ? ` — ${size.why}` : ''}` : '';
    const v = councilR({ cand, odds, riskGate: gate ?? size?.skip ?? null, sizeNote }, c.council);
    this.discuss(cand, v);
    if (!v.trade) {
      e?.failed(`council: ${v.summary}`);
      this.shadow.add({ coin, side: p.side, entry: p.price, stop: p.stop, target: p.target, t, maxHoldMs: agent === 'trend' ? 72 * HOUR : agent === 'auction' ? 8 * HOUR : 15 * MIN, x, agent, costR: odds.costR });
      return;
    }
    const risk = Math.abs(p.price - p.stop);
    const pos = {
      id: randomUUID(),
      mode: this.mode,
      coin,
      symbol: cs.symbol,
      agent,
      owner: agent === 'trend' ? 'swarm' : 'engine',
      side: p.side,
      setup: p.setup,
      why: p.why,
      entry: p.price,
      qty: size.qty,
      notional: size.notional,
      stop: p.stop,
      target: p.target,
      stop0: p.stop,
      target0: p.target,
      risk,
      riskUsd: size.riskUsd,
      riskPct: size.riskPct,
      lev: size.lev,
      atr: p.atr ?? risk / 2,
      openedAt: t,
      fees: 0,
      votes: v.votes,
      summary: v.summary,
      odds: { pWin: odds.pWin, pLoss: odds.pLoss, expR: odds.expR, trust: odds.trust },
      x,
      mgmt: [],
      notified: {},
      be: false,
      trailed: false,
      equityAtEntry: equity,
    };
    cs.busy = true;
    const exec = this.mode === 'live' ? this.openLive(pos) : Promise.resolve(this.openPaper(pos));
    this.inFlight = true;
    exec
      .then(() => {
        cs.busy = false;
        this.inFlight = false;
        if (!this.running && this.mode === 'live') this.say('risk', `${coin}: entry filled as the swarm stopped — the position stays open with its exchange stop`, 'warn');
        e?.filled({ price: pos.entry, qty: pos.qty, fee: pos.fees });
        this.positions.push(pos);
        this.positions = this.positions.slice(-400);
        this.say(agent, `${coin}: ${pos.side === 'buy' ? 'LONG' : 'SHORT'} ${tidy(pos.qty)} @ ${tidy(pos.entry)} — stop ${tidy(pos.stop)}, target ${tidy(pos.target)}, risking ${usd(pos.riskUsd)} to make ${usd(this.potential(pos))}`, 'trade');
        this.notify('setup', pos);
        this.persist();
      })
      .catch((err) => {
        cs.busy = false;
        this.inFlight = false;
        e?.failed(err);
        this.say('risk', `${coin}: entry order failed — ${err?.message ?? err}`, 'error');
      });
  }

  /** The fill: the stop and target stay at their levels (structure, not distance); the risk is re-measured from the fill. */
  filledAt(pos, fill) {
    pos.entry = fill;
    pos.notional = fill * pos.qty;
    pos.fees = (pos.notional * this.cfg.feeBps) / 1e4;
    pos.risk = Math.abs(fill - pos.stop) || pos.risk;
    pos.riskUsd = pos.risk * pos.qty;
  }

  /** What the trade makes at its target, fees out. */
  potential(pos) {
    const gross = Math.abs(pos.target - pos.entry) * pos.qty;
    return gross - pos.notional * (2 * this.cfg.feeBps) / 1e4;
  }

  openPaper(pos) {
    const c = this.cfg;
    const dir = dirOf(pos.side);
    this.filledAt(pos, pos.entry * (1 + (dir * c.slippageBps) / 1e4));
    this.paper.cash -= pos.fees;
  }

  async openLive(pos) {
    const c = this.cfg;
    const dir = dirOf(pos.side);
    const r = await this.ccxt.placeOrder(this.secretId, { symbol: pos.symbol, side: pos.side, type: 'market', sizeMode: 'base', size: pos.qty });
    pos.qty = r.baseQty ?? pos.qty;
    pos.amount = r.amount ?? pos.qty;
    this.filledAt(pos, r.price ?? pos.entry);
    this.liveFlow = (this.liveFlow ?? 0) - pos.fees;
    // the exchange-side disaster stop, half a risk unit beyond the swarm's own stop
    pos.stopTrigger = pos.stop - dir * 0.5 * pos.risk;
    try {
      const s = await this.ccxt.placeOrder(this.secretId, { symbol: pos.symbol, side: dir > 0 ? 'sell' : 'buy', type: 'stop-market', sizeMode: 'contracts', size: pos.amount, triggerPrice: pos.stopTrigger, reduceOnly: true });
      pos.stopOrderId = s.id;
    } catch (err) {
      this.say('risk', `${pos.coin}: protective stop not placed on the exchange (${err?.message ?? err}) — the swarm's own stop still applies`, 'warn');
    }
  }

  /** Live: the exchange stop follows the swarm's stop (at most every 30 s, only for a real move). */
  async syncStop(pos) {
    if (!pos.stopOrderId || pos.closing || pos.syncing) return;
    const dir = dirOf(pos.side);
    const want = pos.stop - dir * 0.5 * pos.risk * (pos.be ? 0.2 : 1);
    if ((want - pos.stopTrigger) * dir <= pos.risk * 0.2 || this.now() - (pos.stopSyncedAt ?? 0) < 30_000) return;
    pos.syncing = true;
    try {
      await this.ccxt.cancelOrder(this.secretId, pos.stopOrderId, pos.symbol);
      const s = await this.ccxt.placeOrder(this.secretId, { symbol: pos.symbol, side: dir > 0 ? 'sell' : 'buy', type: 'stop-market', sizeMode: 'contracts', size: pos.amount, triggerPrice: want, reduceOnly: true });
      pos.stopOrderId = s.id;
      pos.stopTrigger = want;
      pos.stopSyncedAt = this.now();
    } catch (err) {
      this.sayOnce(`stop:${pos.id}`, 'risk', `${pos.coin}: could not move the exchange stop (${err?.message ?? err})`, 'warn', 10 * MIN);
    } finally {
      pos.syncing = false;
    }
  }

  async close(pos, reason, price) {
    if (pos.closing || pos.closedAt) return;
    pos.closing = true;
    const c = this.cfg;
    const dir = dirOf(pos.side);
    const cs = this.coins.get(pos.coin);
    const e = pos.owner === 'engine' ? cs?.engines[pos.agent] : null;
    let exit = Number.isFinite(price) ? price : cs?.price ?? pos.entry;
    try {
      if (pos.mode === 'live') {
        try {
          const r = await this.ccxt.placeOrder(this.secretId, { symbol: pos.symbol, side: dir > 0 ? 'sell' : 'buy', type: 'market', sizeMode: 'contracts', size: pos.amount, reduceOnly: true });
          exit = r.price ?? exit;
        } catch (err) {
          // the exchange stop may already have closed it
          const left = await this.ccxt.positionContracts(this.secretId, pos.symbol).catch(() => null);
          if (left !== 0) throw err;
          exit = pos.stopTrigger ?? exit;
          reason = 'exchange stop';
          pos.stopOrderId = null;
        }
        if (pos.stopOrderId) await this.ccxt.cancelOrder(this.secretId, pos.stopOrderId, pos.symbol).catch((err) => this.say('risk', `${pos.coin}: could not cancel the exchange stop: ${err?.message ?? err}`, 'warn'));
      } else exit = exit * (1 - (dir * c.slippageBps) / 1e4);
    } catch (err) {
      pos.closing = false;
      e?.failed(err);
      this.say('risk', `${pos.coin}: EXIT FAILED — ${err?.message ?? err}. Check the position on Hyperliquid.`, 'error');
      return;
    }
    const gross = (exit - pos.entry) * pos.qty * dir;
    const exitFee = (exit * pos.qty * c.feeBps) / 1e4;
    pos.fees += exitFee;
    pos.exit = exit;
    pos.pnl = gross - pos.fees;
    pos.r = pos.riskUsd > 0 ? pos.pnl / pos.riskUsd : 0;
    pos.reason = reason;
    pos.closedAt = this.now();
    pos.closing = false;
    if (pos.mode === 'paper') this.paper.cash += gross - exitFee;
    else this.liveFlow = (this.liveFlow ?? 0) + gross - exitFee;
    if (e) {
      if (!e.pending) e.pending = { kind: 'exit', reason };
      if (e.pos) e.filled({ price: exit, qty: pos.qty, fee: exitFee });
    }
    if (pos.mode === this.mode) this.setBook(recordClose(this.book(), pos.r, c.risk, this.now()));
    this.learn(pos.x, pos.r, pos.mode, pos.agent);
    this.say(pos.agent, `${pos.coin}: closed (${reason}) @ ${tidy(exit)} — ${pos.pnl >= 0 ? '+' : '−'}${usd(Math.abs(pos.pnl))} (${pos.r >= 0 ? '+' : ''}${pos.r.toFixed(2)}R)`, pos.pnl >= 0 ? 'win' : 'loss');
    this.notify('result', pos);
    if (pos.mode === 'live') void this.refreshEquity();
    this.persist();
  }

  // ---------- learning ----------

  learn(x, r, src, agent) {
    if (!Array.isArray(x)) return;
    this.samples.push({ x, y: rClass(r), r, src, agent, t: this.now() });
    if (this.samples.length > 3000) this.samples = this.samples.slice(-3000);
  }

  async retrain(force = false) {
    this.trainedAt = this.now();
    if (this.samples.length < 30 || (!force && this.samples.length === this.trainedN)) return;
    try {
      this.forest = await trainForest(this.samples, this.now());
      this.trainedN = this.samples.length;
      const s = this.forest.stats;
      this.say('forest', `retrained on ${s.n} trades (paper, live and the ones refused): ${s.accuracy !== null ? `${Math.round(s.accuracy * 100)}% right out of sample against ${Math.round((s.baseline ?? 0) * 100)}% for always guessing the commonest outcome` : 'not enough for an honest score yet'}`);
    } catch (err) {
      this.say('forest', `training failed: ${err?.message ?? err}`, 'warn');
    }
  }

  // ---------- talk ----------

  discuss(cand, v) {
    // the same proposal turned down again within 10 minutes stays quiet
    const key = `${cand.coin}:${cand.agent}:${cand.setup}:${cand.side}:${v.trade}:${v.summary.split(' ')[0]}`;
    if (!v.trade && this.now() - (this.lastSaid.get(key) ?? 0) < 10 * MIN) return;
    this.lastSaid.set(key, this.now());
    this.say(cand.agent, `${cand.coin}: proposes a ${cand.side === 'buy' ? 'LONG' : 'SHORT'} @ ${tidy(cand.price)} — ${cand.setup}: ${cand.why}`, 'propose');
    for (const vt of v.votes.slice(1)) this.say(vt.bot, `${MARK[vt.stance]} ${vt.why}`, 'vote');
    this.say('council', `${cand.coin}: ${v.summary}`, v.trade ? 'trade' : 'pass');
  }

  say(agent, text, kind = 'info') {
    const line = { t: this.now(), agent, text, kind };
    this.lines.push(line);
    if (this.lines.length > 300) this.lines.shift();
    this.emitFn('event', { kind: 'line', line });
    this.logFn(kind === 'error' ? 'warn' : 'info', `cswarm ${agent}: ${text}`);
  }

  sayOnce(key, agent, text, kind, everyMs) {
    if (this.now() - (this.lastSaid.get(key) ?? 0) < everyMs) return;
    this.lastSaid.set(key, this.now());
    this.say(agent, text, kind);
  }

  /** The three moments of a trade, with what the app needs to draw its chart. */
  notify(stage, pos) {
    const cs = this.coins.get(pos.coin);
    const e = cs?.engines[pos.agent] ?? cs?.engines.scalper ?? cs?.engines.auction ?? null;
    const minute = (e?.candles ?? []).slice(-90).map(([t, o, h, l, c]) => [t, o, h, l, c]);
    const hourly = (cs?.hourly ?? []).slice(-60).map((r) => [r.time, r.open, r.high, r.low, r.close]);
    const candles = pos.agent === 'trend' || minute.length < 20 ? hourly : minute;
    const va = e?.sessionVa ?? e?.va ?? null;
    const { x: _x, ...p } = pos;
    this.emitFn('event', { kind: 'notify', stage, mode: pos.mode, position: { ...p, potential: this.potential(pos), price: cs?.price ?? null, agentName: AGENT_NAME[pos.agent] }, candles, timeframe: candles === hourly ? '1h' : '1m', va, equity: this.equity() });
  }

  // ---------- state ----------

  persist() {
    this.db.set('cswarm:paper', this.paper);
    if (this.liveBook) this.db.set('cswarm:liveBook', this.liveBook);
    this.db.set('cswarm:positions', this.positions.map(({ closing: _c, syncing: _s, ...p }) => p));
    this.db.set('cswarm:samples', this.samples);
  }

  state() {
    const eq = this.equity();
    const book = this.book();
    const all = this.positions.filter((p) => p.mode === this.mode);
    const closed = all.filter((p) => p.closedAt);
    const byAgent = {};
    for (const a of PROPOSERS) {
      const mine = closed.filter((p) => p.agent === a);
      byAgent[a] = { trades: mine.length, wins: mine.filter((p) => p.pnl > 0).length, pnl: mine.reduce((s, p) => s + p.pnl, 0), avgR: mine.length ? mine.reduce((s, p) => s + p.r, 0) / mine.length : null };
    }
    const coins = [...this.coins.values()].map((cs) => ({
      coin: cs.coin,
      symbol: cs.symbol,
      price: cs.price,
      feed: cs.feed,
      feedError: cs.feedError,
      funding: cs.funding,
      daily: cs.daily ? { dir: cs.daily.dir, up: cs.daily.up } : null,
      engines: Object.fromEntries(Object.entries(cs.engines).map(([a, e]) => [a, { state: e.state, warm: e.state !== 'warmup', lastSkip: e.lastSkip, lastSignal: e.lastSignal ? { setup: e.lastSignal.setup, side: e.lastSignal.side, t: e.lastSignal.t } : null }])),
    }));
    const fs = this.forest?.stats;
    return {
      running: this.running,
      mode: this.mode,
      secretId: this.secretId,
      sandbox: this.sandbox,
      cfg: this.cfg,
      equity: Number.isFinite(eq) ? eq : null,
      book: { start: book.start, peak: book.peak, floor: book.floor, dayStart: book.dayStart, streak: book.streak, pausedUntil: book.pausedUntil },
      open: this.open().map(({ x: _x, closing: _c, syncing: _s, ...p }) => ({ ...p, upnl: this.upnl(p), price: this.coins.get(p.coin)?.price ?? null })),
      closed: closed.slice(-40).reverse().map(({ x: _x, ...p }) => p),
      totals: { trades: closed.length, wins: closed.filter((p) => p.pnl > 0).length, pnl: closed.reduce((s, p) => s + p.pnl, 0) },
      byAgent,
      coins,
      lines: this.lines.slice(-150),
      forest: { samples: this.samples.length, trained: fs ? { n: fs.n, accuracy: fs.accuracy, baseline: fs.baseline, trainedAt: fs.trainedAt } : null, shadowOpen: this.shadow.open.length },
    };
  }

  pushState(force = false) {
    if (!force && this.now() - this.lastState < 1000) return;
    this.lastState = this.now();
    this.emitFn('state', this.state());
  }
}
