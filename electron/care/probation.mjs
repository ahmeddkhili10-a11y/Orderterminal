// Probation and the automatic pause. Every newly deployed strategy trades at a quarter of its
// size until its first live trades (paper or live) show it doing what its test said; then it
// trades at full size. One that falls behind its test goes back to a quarter. One whose trades
// are clearly worse than tested (more than bad luck, see health.mjs) is paused — no new trades,
// open ones still managed — and you are asked on the phone whether to resume it or retire it.
// Reads the strategy health the care service works out every 30 minutes; does nothing heavy.
import { randomBytes } from 'node:crypto';
import { escapeHtml as e } from '../../src/shared/telegram.ts';

/** live trades on track before a strategy leaves probation */
export const GRADUATE_TRADES = 12;
/** a strategy's size on probation */
export const PROBATION_SCALE = 0.25;
const DAY = 86_400_000;

export class Probation {
  /** @param o {{ db: { get(k), set(k, v) }, lab: () => any, now?: () => number }} */
  constructor(o) {
    this.db = o.db;
    this.labFn = o.lab;
    this.now = o.now ?? Date.now;
  }

  /**
   * After each health check: graduate, demote or pause. Returns the messages to send (with
   * buttons where there is a decision) and the strategies they cover (their plain health
   * message is not sent as well).
   */
  review(health) {
    const lab = this.labFn();
    if (!lab) return { messages: [], handled: [] };
    const messages = [];
    const handled = [];
    for (const h of health ?? []) {
      const d = lab.deployedList.find((x) => x.id === h.id);
      if (!d) continue;
      const scale = Number.isFinite(d.scale) ? d.scale : 1;
      const name = e(d.spec?.name ?? h.name);
      if (d.on && h.status === 'stopped') {
        lab.toggle(d.id, false, 'health');
        handled.push(d.id);
        messages.push({ html: `⏸ <b>Paused: ${name}</b>\n${e(h.words)}\nIt takes no new trades; any open trade is still managed and keeps its stop.\nResume it (back on probation at ¼ size), or retire it?`, keyboard: this.make(d.id, d.spec?.name ?? h.name) });
      } else if (d.on && scale < 1 && h.status === 'ok' && h.trades >= GRADUATE_TRADES) {
        lab.setScale(d.id, 1, '');
        handled.push(d.id);
        messages.push({ html: `🎓 <b>Off probation: ${name}</b>\n${h.trades} trades since it was deployed, ${e(h.words)}\nIt now trades at full size (the swarm's risk rules still size every trade).` });
      } else if (d.on && scale >= 1 && h.status === 'behind') {
        lab.setScale(d.id, PROBATION_SCALE, 'fell behind its test');
        handled.push(d.id);
        messages.push({ html: `↘ <b>Back on probation: ${name}</b>\n${e(h.words)}\nIt trades at ¼ size again until it is back on track; if it gets clearly worse it is paused and you are asked.` });
      }
    }
    return { messages, handled };
  }

  offers() {
    const all = this.db.get('probation:offers') ?? {};
    for (const [k, v] of Object.entries(all)) if (this.now() - v.at > 14 * DAY) delete all[k];
    return all;
  }

  make(id, name) {
    const all = this.offers();
    const token = randomBytes(6).toString('hex');
    all[token] = { id, name, at: this.now() };
    this.db.set('probation:offers', all);
    return [[{ text: '▶ Resume (¼ size)', callback_data: `pb:${token}:r` }], [{ text: '🗑 Retire it', callback_data: `pb:${token}:x` }], [{ text: '⏸ Keep paused', callback_data: `pb:${token}:k` }]];
  }

  /** a button under a pause message */
  tap(data) {
    const m = /^pb:([0-9a-f]{12}):([rxk])$/.exec(String(data));
    if (!m) return null;
    const all = this.offers();
    const o = all[m[1]];
    if (!o) return 'That message has lapsed — look under DEPL in Novus Ordo.';
    if (o.done) return `Already answered (${o.done}).`;
    const lab = this.labFn();
    const d = lab?.deployedList.find((x) => x.id === o.id);
    if (!d) {
      o.done = 'no longer deployed';
      this.db.set('probation:offers', all);
      return `${e(o.name)} is no longer deployed.`;
    }
    if (m[2] === 'r') {
      lab.setScale(d.id, PROBATION_SCALE, 'resumed after a pause');
      lab.toggle(d.id, true);
      o.done = 'resumed';
    } else if (m[2] === 'x') {
      lab.undeploy(d.id);
      o.done = 'retired';
    } else o.done = 'kept paused';
    this.db.set('probation:offers', all);
    return m[2] === 'r' ? `▶ <b>${e(o.name)}</b> resumed, on probation at ¼ size.` : m[2] === 'x' ? `🗑 <b>${e(o.name)}</b> retired — it is no longer deployed.` : `⏸ <b>${e(o.name)}</b> stays paused. Switch it back on under DEPL whenever you like.`;
  }
}
