// The monthly re-tuner, on the phone. Once a month for each deployed strategy (one at a time,
// only while the Lab is idle) its settings are checked again on the latest candles in the Lab's
// worker (src/lab/retune.ts). When steadier settings also did better on the newest candles —
// which neither version was chosen on — you are offered the change with two buttons; nothing
// changes until you tap Apply, and the new settings start on probation (¼ size).
import { randomBytes } from 'node:crypto';
import { escapeHtml as e } from '../../src/shared/telegram.ts';

const DAY = 86_400_000;
export const RETUNE_EVERY = 30 * DAY;
const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs((x ?? 0) * 100).toFixed(1)}%`;
const num = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');

export class Retuner {
  /** @param o {{ db: { get(k), set(k, v) }, lab: () => any, now?: () => number, log?: (lvl, msg) => void }} */
  constructor(o) {
    this.db = o.db;
    this.labFn = o.lab;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    this.busy = false;
  }

  /** the deployed strategy most overdue for its monthly check, or null */
  due() {
    const lab = this.labFn();
    if (!lab) return null;
    const checked = this.db.get('retune:checked') ?? {};
    const now = this.now();
    return lab.deployedList.filter((d) => d.on && now - (checked[d.id] ?? d.deployedAt ?? 0) >= RETUNE_EVERY).sort((a, b) => (checked[a.id] ?? a.deployedAt ?? 0) - (checked[b.id] ?? b.deployedAt ?? 0))[0] ?? null;
  }

  /** check one strategy if one is due and the Lab is idle; returns a message with buttons when there is a change to offer */
  async check() {
    const lab = this.labFn();
    const d = this.due();
    if (!lab || !d || this.busy || !lab.idle()) return null;
    this.busy = true;
    try {
      const r = await lab.retune(d);
      const checked = this.db.get('retune:checked') ?? {};
      checked[d.id] = this.now();
      this.db.set('retune:checked', checked);
      this.log('info', `re-tuner: ${d.spec.name} — ${r.changed ? `offered ${r.changes?.join(', ')}` : r.why}`);
      if (!r.changed) return null;
      return { html: this.text(d, r), keyboard: this.make(d, r) };
    } catch (err) {
      this.log('warn', `re-tuner: ${err?.message ?? err}`);
      return null;
    } finally {
      this.busy = false;
    }
  }

  text(d, r) {
    const c = r.current;
    const p = r.proposed;
    return [
      `🔧 <b>Better settings found for ${e(d.spec.name)}</b>`,
      `Change: ${e(r.changes.join('; '))}`,
      `On the newest candles (neither version was chosen on them): Sharpe ${num(c.sharpe)} → <b>${num(p.sharpe)}</b> · return ${pct(c.ret)} → <b>${pct(p.ret)}</b> · worst drop ${pct(-c.maxDD)} → ${pct(-p.maxDD)} · ${p.trades} trades`,
      `Chosen as the centre of a stable area of settings (${r.tried} versions tried), not the single best one.`,
      '<i>Apply: the new settings, back on probation at ¼ size until 12 live trades are on track. Keep: nothing changes.</i>',
    ].join('\n');
  }

  offers() {
    const all = this.db.get('retune:offers') ?? {};
    for (const [k, v] of Object.entries(all)) if (this.now() - v.at > 14 * DAY) delete all[k];
    return all;
  }

  make(d, r) {
    const all = this.offers();
    const token = randomBytes(6).toString('hex');
    all[token] = { id: d.id, name: d.spec.name, at: this.now(), spec: r.spec, note: r.changes.join('; ') };
    this.db.set('retune:offers', all);
    return [[{ text: '✅ Apply the new settings', callback_data: `rt:${token}:a` }], [{ text: '✖ Keep the current ones', callback_data: `rt:${token}:k` }]];
  }

  tap(data) {
    const m = /^rt:([0-9a-f]{12}):([ak])$/.exec(String(data));
    if (!m) return null;
    const all = this.offers();
    const o = all[m[1]];
    if (!o) return 'That offer has lapsed.';
    if (o.done) return `Already answered (${o.done}).`;
    const lab = this.labFn();
    const d = lab?.deployedList.find((x) => x.id === o.id);
    if (!d) {
      o.done = 'no longer deployed';
      this.db.set('retune:offers', all);
      return `${e(o.name)} is no longer deployed.`;
    }
    if (m[2] === 'a') {
      lab.setSpec(d.id, { ...o.spec, name: d.spec.name }, o.note);
      lab.setScale(d.id, 0.25, 'new settings');
      o.done = 'applied';
    } else o.done = 'kept';
    this.db.set('retune:offers', all);
    return m[2] === 'a' ? `🔧 <b>${e(o.name)}</b>: new settings applied (${e(o.note)}), on probation at ¼ size.` : `OK — <b>${e(o.name)}</b> keeps its settings.`;
  }
}
