// Care: Novus Ordo looking after itself while you are away.
//
// Runs in the desktop process (not the window), once a minute:
//   • the daily "still alive" message on Telegram, at the hour you choose
//   • a warning as soon as something stops — the swarm, a price feed, the edge
//     finder, the window — and the all-clear when it is back
//   • a message when Novus Ordo starts again after being closed (or the
//     computer was off), saying for how long
//   • the strategy health checks: a message when a deployed strategy falls
//     behind its test (it never switches one off)
//   • the weekly report card
// It sends only after the terminal has been unlocked with the ledger key in
// this session, through the Telegram bot chosen on the Telegram panel.
import { measureCosts, costsForTests } from './costs.mjs';
import { strategyHealth, worsened } from './health.mjs';
import { backText, clearedText, dailyText, healthText, problemsOf, warningText, weeklyText } from './reports.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const REWARN = 6 * HOUR;

export const CARE_DEFAULTS = { secretId: '', daily: true, dailyHour: 8, weekly: true, weekday: 0, weeklyHour: 18, warnings: true, health: true, offers: true, wakeNotice: true };

export class Care {
  /**
   * @param o {{ db: { get(k), set(k, v) }, journal: import('./journal.mjs').TradeJournal,
   *   send: (secretId: string, html: string) => Promise<unknown>,
   *   swarm: () => any, lab: () => any, bots: () => any[], screen: () => 'ok'|'frozen'|'gone',
   *   assumedCosts?: () => { feeBps: number, slipBps: number },
   *   now?: () => number, log?: (level: string, msg: string) => void }}
   */
  constructor(o) {
    this.db = o.db;
    this.journal = o.journal;
    this.sendFn = o.send;
    this.swarmFn = o.swarm;
    this.labFn = o.lab;
    this.botsFn = o.bots;
    /** after each health check: probation and the automatic pause (returns the strategies it told you about itself) */
    this.onHealth = o.onHealth ?? null;
    this.screenFn = o.screen ?? (() => 'ok');
    this.assumed = o.assumedCosts ?? (() => ({ feeBps: 4.5, slipBps: 2 }));
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    /** did the Telegram messages arrive (care/delivery.mjs) */
    this.deliveryFn = o.delivery ?? null;
    this.cfg = { ...CARE_DEFAULTS, ...(this.db.get('care:cfg') ?? {}) };
    this.st = { lastDaily: '', lastWeekly: '', warned: {}, health: {}, ...(this.db.get('care:state') ?? {}) };
    this.wanted = { swarm: false, ...(this.db.get('care:wanted') ?? {}) };
    this.seen = new Map();
    this.errors = [];
    this.timer = null;
    this.ticking = false;
  }

  // ---------- settings and hooks ----------

  setConfig(patch) {
    const c = { ...this.cfg, ...(patch ?? {}) };
    c.secretId = String(c.secretId ?? '');
    c.dailyHour = clampInt(c.dailyHour, 0, 23, 8);
    c.weeklyHour = clampInt(c.weeklyHour, 0, 23, 18);
    c.weekday = clampInt(c.weekday, 0, 6, 0);
    for (const k of ['daily', 'weekly', 'warnings', 'health', 'offers', 'wakeNotice']) c[k] = c[k] !== false;
    this.cfg = c;
    this.db.set('care:cfg', c);
    return this.status();
  }

  /** the swarm was started or stopped by you: only a stop you did not ask for is a warning */
  setWanted(part, on) {
    this.wanted[part] = !!on;
    this.db.set('care:wanted', this.wanted);
  }

  /** a failure worth telling at once (an exit that failed, an order refused) */
  error(key, text) {
    // the same failure over and over is told once an hour
    const k = String(key).slice(0, 60);
    this.errSeen ??= new Map();
    if (this.now() - (this.errSeen.get(k) ?? -Infinity) < 3_600_000) return;
    this.errSeen.set(k, this.now());
    this.errors.push({ key: k, text: String(text).slice(0, 400), t: this.now() });
    if (this.errors.length > 20) this.errors.shift();
    if (this.running) void this.tick();
  }

  /** start: once the terminal is unlocked this session */
  start() {
    if (this.running) return;
    this.running = true;
    const last = this.db.get('care:lastSeen');
    const now = this.now();
    // closed (or the computer off) for more than ten minutes: say so, once it is back
    if (Number.isFinite(last) && now - last > 10 * MIN) void this.send(backText(last, now), 'back');
    this.db.set('care:lastSeen', now);
    this.timer = setInterval(() => void this.tick(), MIN);
    this.timer.unref?.();
    setTimeout(() => void this.tick(), 20_000).unref?.();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- the minute ----------

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      this.db.set('care:lastSeen', now);
      this.snapEquity(now);
      const s = this.snapshot(now);
      await this.warnings(s);
      if (this.cfg.health && now - (this.st.healthAt ?? 0) >= 30 * MIN) await this.healthCheck(s);
      if (this.cfg.daily && this.dueDaily(now)) await this.daily(s);
      if (this.cfg.weekly && this.dueWeekly(now)) await this.weekly(s);
    } catch (err) {
      this.log('warn', `care: ${err?.message ?? err}`);
    } finally {
      this.ticking = false;
    }
  }

  snapshot(now = this.now()) {
    let swarm = null;
    let lab = null;
    let bots = [];
    try {
      swarm = this.swarmFn();
    } catch {
      /* the exchange services are still starting */
    }
    try {
      lab = this.labFn();
    } catch {
      /* the same */
    }
    try {
      bots = this.botsFn() ?? [];
    } catch {
      /* the same */
    }
    return { now, swarm, farm: lab?.farm ?? null, deployed: lab?.deployed ?? [], bots, wanted: this.wanted, screen: this.screenFn(), errors: this.errors.splice(0) };
  }

  /** the swarm's account once an hour, for the "in 24 hours" and the week's change */
  snapEquity(now) {
    let sw = null;
    try {
      sw = this.swarmFn();
    } catch {
      return;
    }
    if (!sw || !Number.isFinite(sw.equity)) return;
    const xs = this.db.get('care:equity') ?? [];
    if (xs.length && now - xs[xs.length - 1].t < HOUR) return;
    xs.push({ t: now, mode: sw.mode, equity: sw.equity });
    this.db.set('care:equity', xs.slice(-24 * 40));
  }

  equityAt(t, mode) {
    const xs = (this.db.get('care:equity') ?? []).filter((x) => x.mode === mode);
    let best = null;
    for (const x of xs) if (x.t <= t + 30 * MIN) best = x;
    return best?.equity ?? xs[0]?.equity ?? null;
  }

  // ---------- warnings ----------

  async warnings(s) {
    const probs = problemsOf(s);
    const now = s.now;
    const live = new Set();
    for (const p of probs) {
      if (!this.seen.has(p.key)) this.seen.set(p.key, now);
      if (now - this.seen.get(p.key) < p.after) continue;
      live.add(p.key);
      const told = this.st.warned[p.key];
      if (!this.cfg.warnings) continue;
      if (!told || (!p.info && now - told >= REWARN)) {
        this.st.warned[p.key] = now;
        await this.send(warningText(p, s), `warn ${p.key}`);
      }
    }
    for (const k of [...this.seen.keys()]) if (!probs.some((p) => p.key === k)) this.seen.delete(k);
    // told before, now gone: the all-clear (one message for everything that came back)
    const back = Object.keys(this.st.warned).filter((k) => !live.has(k) && !probs.some((p) => p.key === k));
    if (back.length) {
      for (const k of back) delete this.st.warned[k];
      const msg = clearedText(back.filter((k) => !k.startsWith('err:') && k !== 'swarm-paused'), s);
      if (msg && this.cfg.warnings) await this.send(msg, 'cleared');
    }
    this.save();
    this.lastProblems = probs.filter((p) => live.has(p.key));
  }

  // ---------- strategy health ----------

  health(now = this.now()) {
    const lab = this.labFn();
    const deployed = lab?.deployed ?? [];
    const rows = this.journal.list({ source: 'lab' });
    const byId = {};
    for (const r of rows) if (r.strategy_id && r.closed >= 0) (byId[r.strategy_id] ??= []).push(r);
    // only what it did after it was deployed counts (a re-deploy starts afresh)
    for (const d of deployed) byId[d.id] = (byId[d.id] ?? []).filter((r) => !d.deployedAt || r.opened === null || r.opened >= d.deployedAt - MIN);
    return strategyHealth(deployed, byId, lab?.labBook ?? {}, now);
  }

  async healthCheck(s) {
    this.st.healthAt = s.now;
    let hs;
    try {
      hs = this.health(s.now);
    } catch {
      return;
    }
    let handled = [];
    try {
      handled = (await this.onHealth?.(hs)) ?? [];
    } catch (err) {
      this.log('warn', `probation: ${err?.message ?? err}`);
    }
    for (const h of worsened(this.st.health, hs)) if (!handled.includes(h.id)) await this.send(healthText(h), `health ${h.name}`);
    this.st.health = Object.fromEntries(hs.map((h) => [h.id, h.status]));
    this.save();
  }

  // ---------- costs ----------

  costs() {
    const rows = this.journal.list({ mode: 'live' });
    const measured = measureCosts(rows, { assumedFeeBps: this.assumed().feeBps });
    return { measured, forTests: costsForTests(measured, this.assumed()) };
  }

  // ---------- the daily message ----------

  dueDaily(now) {
    const d = new Date(now);
    return d.getHours() >= this.cfg.dailyHour && this.st.lastDaily !== localDay(now);
  }

  nextDaily(now) {
    const d = new Date(now);
    d.setHours(this.cfg.dailyHour, 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  dailyMessage(s) {
    const now = s.now;
    let health = [];
    try {
      health = this.health(now);
    } catch {
      /* no Lab yet */
    }
    return dailyText({ ...s, problems: this.lastProblems ?? problemsOf(s).filter((p) => !p.after), day: this.journal.list({ from: now - DAY, to: now }), health, equityDayAgo: s.swarm ? this.equityAt(now - DAY, s.swarm.mode) : null, nextAt: this.nextDaily(now + MIN) });
  }

  async daily(s) {
    this.st.lastDaily = localDay(s.now);
    this.save();
    await this.send(this.dailyMessage(s), 'daily');
  }

  // ---------- the weekly report ----------

  dueWeekly(now) {
    const d = new Date(now);
    return d.getDay() === this.cfg.weekday && d.getHours() >= this.cfg.weeklyHour && this.st.lastWeekly !== localDay(now);
  }

  weeklyMessage(s) {
    const now = s.now;
    const from = now - 7 * DAY;
    let health = [];
    try {
      health = this.health(now);
    } catch {
      /* no Lab yet */
    }
    const mode = s.swarm?.mode ?? 'paper';
    const farm = s.farm;
    const triedBefore = this.st.farmTried;
    const farmWeek = farm && Number.isFinite(triedBefore) && farm.tried >= triedBefore ? farm.tried - triedBefore : null;
    let costs = null;
    try {
      costs = this.costs().forTests;
    } catch {
      /* no journal */
    }
    return weeklyText({ now, from, rows: this.journal.list({ from, to: now }), health, mode, equityStart: this.equityAt(from, mode), equityNow: s.swarm?.equity ?? null, costs, farm, farmWeek });
  }

  async weekly(s) {
    this.st.lastWeekly = localDay(s.now);
    const msg = this.weeklyMessage(s);
    if (s.farm && Number.isFinite(s.farm.tried)) this.st.farmTried = s.farm.tried;
    this.save();
    await this.send(msg, 'weekly');
  }

  // ---------- sending ----------

  async send(html, what) {
    const id = this.cfg.secretId;
    if (!id || !html) return false;
    try {
      await this.sendFn(id, html);
      this.st.sentAt = this.now();
      return true;
    } catch (err) {
      this.log('warn', `care: could not send the ${what} message: ${err?.message ?? err}`);
      return false;
    }
  }

  /** send one of the messages now (the Telegram panel's "Send now" buttons) */
  async sendNow(kind) {
    const s = this.snapshot();
    if (kind === 'weekly') return this.send(this.weeklyMessage(s), 'weekly');
    return this.send(this.dailyMessage(s), 'daily');
  }

  save() {
    this.db.set('care:state', this.st);
  }

  status() {
    return { delivery: this.deliveryFn?.() ?? null, cfg: this.cfg, running: !!this.running, lastDaily: this.st.lastDaily, lastWeekly: this.st.lastWeekly, sentAt: this.st.sentAt ?? null, nextDaily: this.nextDaily(this.now()), problems: (this.lastProblems ?? []).map((p) => ({ key: p.key, text: p.text.replace(/<[^>]+>/g, '') })) };
  }
}

const clampInt = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
/** the day on this computer's clock, YYYY-MM-DD */
export const localDay = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
