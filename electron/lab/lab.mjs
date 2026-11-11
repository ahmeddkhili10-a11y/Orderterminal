// The Strategy Lab in the desktop process: candle history, research runs (in
// a worker thread so the terminal never freezes), the latest result, and the
// strategies deployed into the swarms.
//
// History comes from public exchange data through CCXT — Binance spot first
// (the longest history), then OKX, Bybit and Hyperliquid — and is cached on
// disk so the next run only fetches what is new. Funding history (for the
// carry rule and the crowding filter) is best-effort: Binance USDⓈ-M, then
// Hyperliquid.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STYLE_MAP } from '../../src/lab/flow.ts';
import { FARM_DEFAULTS } from '../../src/lab/farm.ts';

export const LAB_DEFAULTS = {
  coins: ['BTC', 'ETH', 'SOL'],
  timeframe: '1h',
  years: 3,
  source: 'auto',
  isShare: 0.7,
  combos: 400,
  sides: 'both',
  feeBps: 4.5,
  slipBps: 2,
  meta: true,
  funding: true,
};
export const TF_H = { '15m': 0.25, '1h': 1, '4h': 4, '1d': 24 };
/** the most history worth downloading per timeframe, in years (a year of 15-minute candles is 35,000 of them) */
export const MAX_YEARS = { '15m': 1 };
const SOURCES = ['binance', 'okx', 'bybit', 'hyperliquid'];
const HOUR = 3_600_000;

export const spotSymbol = (id, coin) => (id === 'hyperliquid' ? `${coin}/USDC:USDC` : `${coin}/USDT`);

/** funding per interval → funding per bar, aligned with the bars (the last known rate, scaled to the bar length) */
export function alignFunding(bars, rows, tfH) {
  if (!rows.length) return null;
  const out = new Array(bars.length).fill(0);
  let j = 0;
  // each exchange's funding interval, from the data itself
  const gaps = rows.slice(1, 50).map((r, i) => r.time - rows[i].time).filter((g) => g > 0).sort((a, b) => a - b);
  const intervalH = gaps.length ? Math.max(1, Math.round(gaps[Math.floor(gaps.length / 2)] / HOUR)) : 8;
  for (let i = 0; i < bars.length; i++) {
    while (j + 1 < rows.length && rows[j + 1].time <= bars[i].time) j++;
    if (rows[j].time <= bars[i].time) out[i] = (rows[j].rate * tfH) / intervalH;
  }
  return out;
}

/** markets as plain arrays, for a worker */
const plainMarkets = (byTf) => Object.fromEntries(Object.entries(byTf).map(([tf, ms]) => [tf, ms.map((m) => ({ ...m, funding: m.funding ? Array.from(m.funding) : null }))]));

export class LabService {
  /**
   * @param o {{ ccxt, dir: string, emit: (ch, msg) => void, makeWorker: () => import('node:worker_threads').Worker, makeFarmWorker?: () => import('node:worker_threads').Worker, now?: () => number }}
   */
  constructor(o) {
    this.ccxt = o.ccxt;
    this.dir = o.dir;
    this.emit = o.emit;
    this.makeWorker = o.makeWorker;
    this.now = o.now ?? Date.now;
    mkdirSync(join(this.dir, 'cache'), { recursive: true });
    this.cfg = { ...LAB_DEFAULTS, ...this.read('config.json', {}) };
    this.deployedList = this.read('deployed.json', []);
    this.worker = null;
    this.progress = null;
    this.error = null;
    // the edge finder: its own long-lived thread, its last state, and whether it should be running
    this.makeFarmWorker = o.makeFarmWorker ?? null;
    const farm = this.read('farm.json', null);
    this.farmSaved = farm?.save ?? null;
    this.farmWanted = farm ? farm.wanted !== false : true;
    this.farmCfg = { ...FARM_DEFAULTS, ...(farm?.cfg ?? {}) };
    this.farmSnap = farm?.state ? { ...farm.state, running: false } : null;
    this.farmW = null;
    this.farmTimer = null;
    this.farmNote = '';
    this.farmErr = '';
  }

  // ---------- the edge finder ----------

  /** what the edge finder shows when asked: its live state, or the last one saved */
  farmState() {
    const base = this.farmSnap ?? { running: false, cfg: this.farmCfg, startedAt: 0, gen: 0, tried: 0, rate: 0, population: 0, funnel: { bred: 0, trained: 0, holdout: 0, random: 0, nudge: 0, shuffle: 0, proof: 0 }, ladder: { new: 0, incubating: 0, proving: 0, proven: 0, faded: 0 }, top: [], watch: [], survivors: 0, recent: [], fleet: [], dataTo: 0, dataAt: 0, note: '', error: '' };
    return { ...base, running: !!this.farmW, starting: this.farmStarting ?? false, wanted: this.farmWanted, cfg: this.farmCfg, note: this.farmNote || base.note, error: this.farmErr || base.error };
  }

  farmPush() {
    this.emit('lab:farm', this.farmState());
  }

  farmPersist(save) {
    if (save) this.farmSaved = save;
    this.write('farm.json', { wanted: this.farmWanted, cfg: this.farmCfg, save: this.farmSaved, state: this.farmSnap });
  }

  /** the candles the edge finder breeds on: for each pace's timeframe, the longest history any of its paces wants */
  async farmMarkets(cfg) {
    const years = {};
    for (const id of cfg.styles) {
      const st = STYLE_MAP[id];
      if (st) years[st.timeframe] = Math.max(years[st.timeframe] ?? 0, st.years);
    }
    const out = {};
    for (const [tf, yrs] of Object.entries(years)) {
      const ms = [];
      for (const coin of cfg.coins) {
        this.farmNote = `Loading ${coin} ${tf} history…`;
        this.farmPush();
        try {
          const { bars } = await this.candles(coin, tf, yrs, this.cfg.source);
          let funding = null;
          if (this.cfg.funding && tf !== '1d') {
            try {
              funding = alignFunding(bars, await this.funding(coin, bars[0].time), TF_H[tf]);
            } catch {
              /* the funding rules sit this one out */
            }
          }
          ms.push({ coin, tfH: TF_H[tf], bars, funding });
        } catch (err) {
          this.farmErr = String(err?.message ?? err).slice(0, 200);
        }
      }
      if (ms.length) out[tf] = ms;
    }
    this.farmNote = '';
    return out;
  }

  fleetOf() {
    return this.deployedList.map((d) => ({ id: d.id, name: d.spec.name, spec: d.spec, tfH: d.tfH, coins: d.coins, deployedAt: d.deployedAt, stats: d.stats }));
  }

  /** start the edge finder (it carries on from where it was); settings that change its candles start it over on them */
  async farmStart(patch = {}) {
    const next = { ...this.farmCfg, ...patch };
    if (Array.isArray(next.coins)) next.coins = [...new Set(next.coins.map((c) => String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean))].slice(0, 8);
    next.styles = (next.styles ?? []).filter((s) => STYLE_MAP[s]);
    if (!next.coins.length || !next.styles.length) throw new Error('choose at least one coin and one pace');
    if (this.farmW || this.farmStarting) await this.farmStop(false);
    // other coins or paces: the old survivors were tested on other candles — they are kept, the counters too
    this.farmCfg = next;
    this.farmWanted = true;
    this.farmErr = '';
    this.farmStarting = true;
    this.farmPersist();
    this.farmPush();
    try {
      const markets = await this.farmMarkets(next);
      if (!Object.keys(markets).length) throw new Error(this.farmErr || 'no history for these coins');
      if (!this.makeFarmWorker) throw new Error('the edge finder needs the desktop app');
      const w = this.makeFarmWorker();
      this.farmW = w;
      w.on('message', (m) => {
        if (m.type === 'state' || m.type === 'save') {
          this.farmSnap = m.state;
          if (m.type === 'save') this.farmPersist(m.save);
          this.farmPush();
        } else if (m.type === 'stopped') {
          this.farmDone?.();
        } else if (m.type === 'error') {
          this.farmErr = m.error;
          this.farmPush();
        }
      });
      w.on('error', (err) => {
        this.farmErr = String(err?.message ?? err);
        this.farmW = null;
        this.farmPush();
      });
      w.postMessage({ type: 'start', cfg: next, save: this.farmSaved, markets: plainMarkets(markets), deployed: this.fleetOf() });
      // fresher candles every so often: the survivors' and the fleet's forward tests move on
      const every = next.styles.some((s) => STYLE_MAP[s]?.tfH < 1) ? 30 * 60_000 : 2 * 3_600_000;
      clearInterval(this.farmTimer);
      this.farmTimer = setInterval(() => void this.farmRefresh(), every);
      this.farmTimer.unref?.();
    } catch (err) {
      this.farmErr = String(err?.message ?? err).slice(0, 200);
      throw err;
    } finally {
      this.farmStarting = false;
      this.farmPush();
    }
    return this.farmState();
  }

  async farmRefresh() {
    if (!this.farmW) return;
    const markets = await this.farmMarkets(this.farmCfg);
    if (this.farmW && Object.keys(markets).length) this.farmW.postMessage({ type: 'markets', markets: plainMarkets(markets) });
  }

  /** stop the edge finder; its survivors and counters are kept for next time (wanted = false: it stays stopped when the terminal opens) */
  async farmStop(user = true) {
    if (user) this.farmWanted = false;
    clearInterval(this.farmTimer);
    this.farmTimer = null;
    const w = this.farmW;
    if (w) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 15_000);
        this.farmDone = () => {
          clearTimeout(t);
          resolve();
        };
        w.postMessage({ type: 'stop' });
      });
      this.farmDone = null;
      void w.terminate();
      this.farmW = null;
    }
    this.farmPersist();
    this.farmPush();
    return this.farmState();
  }

  /** when the terminal opens: carry on, unless it was stopped */
  farmAuto(delayMs = 90_000) {
    if (!this.farmWanted || !this.makeFarmWorker) return;
    const t = setTimeout(() => {
      if (this.farmWanted && !this.farmW) this.farmStart().catch(() => {
        // no history yet (no connection): try again in ten minutes
        const again = setTimeout(() => this.farmAuto(0), 10 * 60_000);
        again.unref?.();
      });
    }, delayMs);
    t.unref?.();
  }

  /** the swarm's deployed strategies changed: the edge finder watches them */
  farmFleet() {
    this.farmW?.postMessage({ type: 'fleet', deployed: this.fleetOf() });
  }

  shutdownFarm() {
    clearInterval(this.farmTimer);
    if (this.farmW) void this.farmW.terminate();
    this.farmW = null;
  }

  read(name, fallback) {
    try {
      const p = join(this.dir, name);
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
    } catch {
      return fallback;
    }
  }
  write(name, v) {
    try {
      writeFileSync(join(this.dir, name), JSON.stringify(v));
    } catch {
      /* the Lab keeps going without its cache */
    }
  }

  status() {
    const last = this.read('result.json', null);
    return {
      running: !!this.worker,
      progress: this.progress,
      error: this.error,
      cfg: this.cfg,
      deployed: this.deployedList.map(({ spec, ...d }) => ({ ...d, name: spec.name, spec: { ...spec, meta: spec.meta ? { threshold: spec.meta.threshold, trees: spec.meta.model?.trees.length ?? 0, nn: !!spec.meta.nn } : undefined } })),
      last: last ? { at: last.at, trials: last.trials, top: last.top.length, verdicts: last.top.map((t) => t.verdict) } : null,
    };
  }

  /** the full last result (without the trained models, which stay here) */
  result() {
    const r = this.read('result.json', null);
    if (!r) return null;
    return { ...r, top: r.top.map((t) => ({ ...t, spec: { ...t.spec, meta: t.spec.meta ? { threshold: t.spec.meta.threshold, trees: t.spec.meta.model?.trees.length ?? 0, nn: !!t.spec.meta.nn } : undefined } })) };
  }

  setConfig(patch) {
    this.cfg = { ...this.cfg, ...patch };
    this.write('config.json', this.cfg);
    this.push();
    return this.cfg;
  }

  push() {
    this.emit('lab:state', this.status());
  }

  note(text) {
    this.progress = { ...(this.progress ?? { done: 0, total: 1 }), stage: text };
    this.push();
  }

  /** candles for one coin: from the cache, topped up from the exchange */
  async candles(coin, tf, years0, source) {
    const tfH = TF_H[tf];
    const years = Math.min(years0, MAX_YEARS[tf] ?? years0);
    const since = this.now() - years * 365 * 24 * HOUR;
    const need = Math.ceil((years * 365 * 24) / tfH);
    const tried = [];
    for (const id of source === 'auto' ? SOURCES : [source]) {
      const key = `cache/${id}-${coin}-${tf}.json`;
      try {
        const cached = this.read(key, []);
        const have = cached.filter((b) => b.time >= since);
        const from = have.length && have[0].time <= since + 7 * 24 * HOUR ? have[have.length - 1].time + tfH * HOUR : since;
        const fresh = from < this.now() - tfH * HOUR ? await this.ccxt.history(id, spotSymbol(id, coin), tf, from, need + 50) : [];
        const bars = [...(from === since ? [] : have), ...fresh.filter((b) => !have.length || b.time > have[have.length - 1].time)];
        // only closed candles
        const closed = bars.filter((b) => b.time + tfH * HOUR <= this.now());
        if (closed.length < 600) throw new Error(`only ${closed.length} candles`);
        // the cache keeps the older candles too: a shorter request must not throw away history a longer one will want
        const older = cached.filter((b) => b.time < closed[0].time);
        this.write(key, older.length ? [...older, ...closed] : closed);
        return { bars: closed, source: id };
      } catch (err) {
        tried.push(`${id}: ${err?.message ?? err}`);
      }
    }
    throw new Error(`no history for ${coin} — ${tried.join('; ')}`);
  }

  async funding(coin, since) {
    for (const [id, sym] of [
      ['binanceusdm', `${coin}/USDT:USDT`],
      ['hyperliquid', `${coin}/USDC:USDC`],
    ]) {
      try {
        const rows = await this.ccxt.fundingHistory(id, sym, since);
        if (rows.length > 20) return rows;
      } catch {
        /* next source */
      }
    }
    return [];
  }

  async markets(cfg) {
    const tfH = TF_H[cfg.timeframe] ?? 1;
    const out = [];
    const notes = [];
    for (const coin of cfg.coins) {
      this.note(`Downloading ${coin} history (${cfg.years} years of ${cfg.timeframe} candles)…`);
      try {
        const { bars, source } = await this.candles(coin, cfg.timeframe, cfg.years, cfg.source);
        let funding = null;
        if (cfg.funding) {
          this.note(`Downloading ${coin} funding history…`);
          const rows = await this.funding(coin, bars[0].time);
          funding = alignFunding(bars, rows, tfH);
          if (!funding) notes.push(`${coin}: no funding history`);
        }
        out.push({ coin, tfH, bars, funding, source });
      } catch (err) {
        notes.push(String(err?.message ?? err));
      }
    }
    return { markets: out, notes };
  }

  /** run the research in a worker; resolves with the result summary */
  async run(patch = {}) {
    if (this.worker) throw new Error('a research run is already going');
    const cfg = this.setConfig(patch);
    this.error = null;
    this.progress = { stage: 'Starting…', done: 0, total: 1 };
    this.push();
    try {
      const { markets, notes } = await this.markets(cfg);
      if (!markets.length) throw new Error(notes.join(' · ') || 'no history downloaded');
      const result = await this.inWorker({
        type: 'research',
        markets: markets.map((m) => ({ ...m, funding: m.funding ? Float64Array.from(m.funding) : null })),
        cfg: { isShare: cfg.isShare, combos: cfg.combos, sides: cfg.sides, meta: cfg.meta, costs: { feeBps: cfg.feeBps, slipBps: cfg.slipBps } },
      });
      result.notes = [...notes, ...result.notes];
      result.sources = markets.map((m) => ({ coin: m.coin, source: m.source }));
      this.write('result.json', result);
      this.progress = null;
      this.push();
      this.emit('lab:event', { kind: 'done', at: result.at });
      return this.status().last;
    } catch (err) {
      this.error = String(err?.message ?? err);
      this.progress = null;
      this.push();
      throw err;
    }
  }

  /** backtest one strategy (built by hand in the Lab) on the configured coins */
  async test(spec, patch = {}) {
    const cfg = { ...this.cfg, ...patch };
    const { markets } = await this.markets(cfg);
    if (!markets.length) throw new Error('no history downloaded');
    this.progress = null;
    this.push();
    return this.inWorker({ type: 'evaluate', markets: markets.map((m) => ({ ...m, funding: m.funding ? Float64Array.from(m.funding) : null })), spec, isShare: cfg.isShare, costs: { feeBps: cfg.feeBps, slipBps: cfg.slipBps } });
  }

  /**
   * The optimizer: measure versions of a strategy (the bot as it is, and each one-step change) on the
   * validation stretch inside the training years — the unseen data is not read.
   */
  async optimize(specs, patch = {}) {
    if (!Array.isArray(specs) || !specs.length) throw new Error('nothing to try');
    const cfg = { ...this.cfg, ...patch };
    const { markets } = await this.markets(cfg);
    if (!markets.length) throw new Error('no history downloaded');
    try {
      return await this.inWorker({ type: 'score', markets: markets.map((m) => ({ ...m, funding: m.funding ? Float64Array.from(m.funding) : null })), specs: specs.slice(0, 120), isShare: cfg.isShare, costs: { feeBps: cfg.feeBps, slipBps: cfg.slipBps } });
    } finally {
      this.progress = null;
      this.push();
    }
  }

  inWorker(msg) {
    return new Promise((resolve, reject) => {
      const w = this.makeWorker();
      this.worker = w;
      const done = (fn, v) => {
        this.worker = null;
        void w.terminate();
        fn(v);
      };
      w.on('message', (m) => {
        if (m.type === 'progress') {
          this.progress = m.progress;
          const t = this.now();
          if (!this.lastPush || t - this.lastPush > 250) {
            this.lastPush = t;
            this.push();
          }
        } else if (m.type === 'result') done(resolve, m.result);
        else if (m.type === 'error') done(reject, new Error(m.error));
      });
      w.on('error', (e) => done(reject, e));
      w.on('exit', (code) => {
        if (this.worker === w) done(reject, new Error(code ? `the research stopped (code ${code})` : 'cancelled'));
      });
      w.postMessage(msg);
    });
  }

  cancel() {
    if (this.worker) void this.worker.terminate();
  }

  // ---------- deployment ----------

  /** deploy one of the last result's top five (by rank), or a hand-built spec */
  deploy({ rank, spec, tfH, stats, authority }, targets = { crypto: true, meme: false }, coins) {
    let s = spec;
    let st = stats;
    let tf = tfH;
    if (rank) {
      const r = this.read('result.json', null);
      const t = r?.top.find((x) => x.rank === rank);
      if (!t) throw new Error('no such strategy in the last research');
      s = t.spec;
      tf = r.tfH;
      st = { sharpe: t.oos.sharpe, t: t.oos.t, dsr: t.dsr, trades: t.oos.trades, verdict: t.verdict };
    }
    if (!s) throw new Error('nothing to deploy');
    const d = { id: randomUUID(), spec: s, tfH: tf ?? 1, coins: coins ?? this.cfg.coins, targets, stats: st ?? { sharpe: 0, t: 0, dsr: 0, trades: 0, verdict: 'untested' }, deployedAt: this.now(), on: true, authority: authority === 'tested' ? 'tested' : 'council' };
    this.deployedList = [...this.deployedList, d];
    this.write('deployed.json', this.deployedList);
    this.push();
    this.farmFleet();
    this.emit('lab:event', { kind: 'deployed', id: d.id, name: s.name });
    return d.id;
  }

  undeploy(id) {
    this.deployedList = this.deployedList.filter((d) => d.id !== id);
    this.write('deployed.json', this.deployedList);
    this.push();
    this.farmFleet();
  }

  /** who decides a deployed strategy's trades: the swarm's council (it can block a signal), or the strategy as tested (only the safety bots can) */
  setAuthority(id, authority) {
    this.deployedList = this.deployedList.map((d) => (d.id === id ? { ...d, authority: authority === 'tested' ? 'tested' : 'council' } : d));
    this.write('deployed.json', this.deployedList);
    this.push();
  }

  toggle(id, on) {
    this.deployedList = this.deployedList.map((d) => (d.id === id ? { ...d, on } : d));
    this.write('deployed.json', this.deployedList);
    this.push();
  }

  /** the strategies live in a swarm */
  deployed(target = 'crypto') {
    return this.deployedList.filter((d) => d.on && d.targets[target]);
  }
}
