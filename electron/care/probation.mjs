// Probation and the automatic pause. Every newly deployed strategy trades at a quarter of its
// size until its first live trades (paper or live) show it doing what its test said; then it
// trades at full size. One that falls behind its test goes back to a quarter. One whose trades
// are clearly worse than tested (more than bad luck, see health.mjs) is paused — no new trades,
// open ones still managed — and you are asked on the phone whether to resume it or retire it.
// Reads the strategy health the care service works out every 30 minutes; does nothing heavy.
import { randomBytes } from 'node:crypto';
import { escapeHtml as e } from '../../src/shared/telegram.ts';
import { bullets, card, head, note, section, table } from '../../src/shared/tgcard.ts';

const pc = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—');
const r2 = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}R` : '—');
/** its live record against its test, as a small table */
const record = (h) =>
  table(
    [
      ['Trades', String(h.trades ?? 0), '—'],
      ['Win rate', pc(h.winRate), pc(h.tested?.winRate)],
      ['Avg trade', r2(h.avgR), r2(h.tested?.avgR)],
    ],
    { header: ['', 'Live', 'Tested'] },
  );

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
        messages.push({
          html: card([
            head('⏸', 'Strategy paused', `<b>${name}</b>`),
            section('Why', [`Its live trades are clearly worse than its test — more than bad luck explains.`, record(h)]),
            section('What it means', bullets(['No new trades from it', 'Any open trade is still managed and keeps its stop'])),
            section('Your call', bullets(['<b>Resume</b> — back on probation at ¼ size', '<b>Retire</b> — remove it from the swarm', '<b>Keep paused</b> — decide later under DEPL'])),
          ]),
          keyboard: this.make(d.id, d.spec?.name ?? h.name),
        });
      } else if (d.on && scale < 1 && h.status === 'ok' && h.trades >= GRADUATE_TRADES) {
        lab.setScale(d.id, 1, '');
        handled.push(d.id);
        messages.push({
          html: card([
            head('🎓', 'Off probation — full size', `<b>${name}</b>`),
            section('Its live record', [record(h)]),
            note('It did what its test said, so it now trades at full size. The swarm’s risk rules still size every trade.'),
          ]),
        });
      } else if (d.on && scale >= 1 && h.status === 'behind') {
        lab.setScale(d.id, PROBATION_SCALE, 'fell behind its test');
        handled.push(d.id);
        messages.push({
          html: card([
            head('↘️', 'Back on probation — ¼ size', `<b>${name}</b>`),
            section('Its live record', [record(h)]),
            note('It has fallen behind its test, so it trades at ¼ size until it is back on track. If it gets clearly worse it is paused and you are asked.'),
          ]),
        });
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
    if (!o) return card([head('⌛', 'That message has lapsed'), note('Look under DEPL in Novus Ordo.')]);
    if (o.done) return card([head('ℹ️', 'Already answered', e(o.done))]);
    const lab = this.labFn();
    const d = lab?.deployedList.find((x) => x.id === o.id);
    if (!d) {
      o.done = 'no longer deployed';
      this.db.set('probation:offers', all);
      return card([head('ℹ️', 'No longer deployed', `<b>${e(o.name)}</b>`)]);
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
    if (m[2] === 'r') return card([head('▶️', 'Resumed', `<b>${e(o.name)}</b>`), note('Back on probation at ¼ size — full size once 12 live trades are on track.')]);
    if (m[2] === 'x') return card([head('🗑', 'Retired', `<b>${e(o.name)}</b>`), note('It is no longer deployed. Any open trade it took is still managed to its stop.')]);
    return card([head('⏸', 'Kept paused', `<b>${e(o.name)}</b>`), note('Switch it back on under DEPL whenever you like.')]);
  }
}
