// Running the swarm from your phone, in your own Telegram chat:
//
//   /positions   the account, every open trade (entry, now, profit or loss, stop, target)
//   /pause       no new trades; open trades are still managed to their stops and targets
//   /resume      new trades again
//   /stop        close every open trade at market and stop the swarm and the bots — asks first
//   /startswarm  start the crypto swarm again (in the mode it is set to) — asks first
//
// Only your chat is answered (the poller checks), the two that change the
// account ask for a tap to confirm, and each confirmation works once, within
// ten minutes.
import { randomBytes } from 'node:crypto';
import { escapeHtml as e } from '../../src/shared/telegram.ts';
import { bullets, card, head, note, section, signedUsd as signed, table, usd } from '../../src/shared/tgcard.ts';

const STARTING = card([head('⏳', 'Still starting up'), note('The crypto swarm is getting ready — try again in a moment.')]);

const MIN = 60_000;
const CONFIRM_TTL = 10 * MIN;
const AGENT = { auction: 'Auctioneer', trend: 'Trend', lab: 'Lab', tape: 'Tape', crowd: 'Crowd', scalper: 'Scalper' };

const px = (p) => (Number.isFinite(p) ? p.toLocaleString('en-US', { maximumFractionDigits: Math.abs(p) >= 1000 ? 1 : Math.abs(p) >= 10 ? 2 : 4 }) : '—');
const ago = (ms) => (ms < 90 * MIN ? `${Math.round(ms / MIN)} min` : ms < 48 * 60 * MIN ? `${(ms / 3_600_000).toFixed(1)} h` : `${(ms / 86_400_000).toFixed(1)} days`);

export class Remote {
  /**
   * @param o {{ db: { get(k), set(k, v) }, swarm: () => any, bots: () => any,
   *   wanted?: (on: boolean) => void, now?: () => number }}
   */
  constructor(o) {
    this.db = o.db;
    this.swarmFn = o.swarm;
    this.botsFn = o.bots;
    this.wanted = o.wanted ?? (() => {});
    this.now = o.now ?? Date.now;
  }

  ask(action) {
    const all = this.db.get('remote:asks') ?? {};
    for (const [k, v] of Object.entries(all)) if (this.now() - v.at > CONFIRM_TTL) delete all[k];
    const token = randomBytes(6).toString('hex');
    all[token] = { action, at: this.now() };
    this.db.set('remote:asks', all);
    return token;
  }

  positions() {
    const sw = this.swarmFn();
    if (!sw) return STARTING;
    const st = sw.state();
    const state = st.running ? (st.holding ? '⏸ paused for new trades' : '🟢 running') : '🔴 stopped';
    const today = (st.closed ?? []).filter((p) => this.now() - (p.closedAt ?? 0) < 86_400_000);
    const trades = st.open.map((p) => {
      const now = p.price ?? p.entry;
      const r = p.riskUsd > 0 ? p.upnl / p.riskUsd : 0;
      return section(`${p.upnl >= 0 ? '🟢' : '🔴'} ${e(p.coin)} ${p.side === 'buy' ? 'LONG' : 'SHORT'} · ${signed(p.upnl)} (${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R)`, [
        note(`${e(p.agentName ?? AGENT[p.agent] ?? p.agent)} · open ${ago(this.now() - p.openedAt)}`),
        table([
          ['Entry', px(p.entry)],
          ['Now', px(now)],
          ['Stop', px(p.stop)],
          ['Target', px(p.target)],
        ]),
      ]);
    });
    const bots = (this.botsFn()?.list() ?? []).filter((b) => b.running);
    return card([
      head('📋', 'Crypto swarm', `${state} · ${st.mode === 'live' ? '<b>LIVE</b>' : 'paper'}`),
      table([
        ...(Number.isFinite(st.equity) ? [['Account', usd(st.equity)]] : []),
        ['Open trades', String(st.open.length)],
        ...(today.length ? [['Closed today', `${today.length} · ${signed(today.reduce((a, p) => a + (p.pnl ?? 0), 0))}`]] : []),
      ]),
      ...trades,
      bots.length ? section('⚙️ Bots running', bots.map((b) => `• ${e(b.name)} · ${b.mode === 'live' ? 'live' : 'paper'}`)) : null,
      note('/pause · /resume · /stop · /startswarm'),
    ]);
  }

  /** a command from your chat: the reply (with buttons when it asks to confirm), or null when it is not one of these */
  async command(cmd) {
    const sw = this.swarmFn();
    if (cmd === '/positions' || cmd === '/pos') return [{ html: this.positions() }];
    if (cmd === '/pause') {
      if (!sw) return [{ html: STARTING }];
      sw.hold(true);
      const k = sw.open().length;
      return [{ html: card([head('⏸', 'Paused for new trades'), k ? `The <b>${k}</b> open trade${k > 1 ? 's are' : ' is'} still managed to ${k > 1 ? 'their' : 'its'} stop and target.` : 'Nothing is open.', note('/resume to trade again · /stop to close everything')]) }];
    }
    if (cmd === '/resume') {
      if (!sw) return [{ html: STARTING }];
      sw.hold(false);
      if (!sw.running) return [{ html: card([head('▶️', 'New trades allowed again'), 'But the swarm itself is <b>stopped</b> — start it below.']), keyboard: this.startKeys(sw) }];
      return [{ html: card([head('▶️', 'Resumed'), note('The swarm takes new trades again.')]) }];
    }
    if (cmd === '/stop') {
      const n = sw?.open().length ?? 0;
      const bots = (this.botsFn()?.list() ?? []).filter((b) => b.running).length;
      const token = this.ask('stopall');
      return [
        {
          html: card([
            head('⛔', 'Close everything and stop?', sw?.mode === 'live' ? '<b>LIVE — real money</b>' : 'paper'),
            section('This will', bullets([`Close ${n ? `the <b>${n}</b> open swarm trade${n > 1 ? 's' : ''}` : 'any open swarm trade'} at market`, 'Stop the crypto swarm', bots ? `Stop the <b>${bots}</b> running bot${bots > 1 ? 's' : ''} and close their positions` : null])),
            note('Deployed strategies stay deployed. Start again any time with /startswarm.'),
          ]),
          keyboard: [[{ text: '⛔ Yes — close everything and stop', callback_data: `rc:${token}:y` }], [{ text: 'Cancel', callback_data: `rc:${token}:n` }]],
        },
      ];
    }
    if (cmd === '/startswarm' || cmd === '/start_swarm') {
      if (!sw) return [{ html: STARTING }];
      if (sw.running) return [{ html: card([head('🟢', 'Already running', sw.mode === 'live' ? '<b>LIVE</b>' : 'paper'), sw.holding ? note('Paused for new trades — /resume to trade again.') : null]) }];
      return [{ html: card([head('▶️', 'Start the crypto swarm?', sw.mode === 'live' ? '<b>LIVE mode — real money</b>' : 'paper mode'), note('It starts with its deployed strategies.')]), keyboard: this.startKeys(sw) }];
    }
    return null;
  }

  startKeys(sw) {
    const token = this.ask('start');
    return [[{ text: `▶ Start the swarm (${sw.mode === 'live' ? 'LIVE' : 'paper'})`, callback_data: `rc:${token}:y` }], [{ text: 'Cancel', callback_data: `rc:${token}:n` }]];
  }

  /** a confirmation tapped */
  async tap(data) {
    const m = /^rc:([0-9a-f]{12}):([yn])$/.exec(String(data));
    if (!m) return null;
    const all = this.db.get('remote:asks') ?? {};
    const a = all[m[1]];
    if (!a) return card([head('⌛', 'That request has lapsed'), note('Send the command again.')]);
    delete all[m[1]];
    this.db.set('remote:asks', all);
    if (this.now() - a.at > CONFIRM_TTL) return card([head('⌛', 'That request has lapsed', 'It is more than ten minutes old.'), note('Send the command again.')]);
    if (m[2] === 'n') return card([head('✖️', 'Cancelled'), note('Nothing changed.')]);
    const sw = this.swarmFn();
    if (a.action === 'start') {
      if (!sw) return STARTING;
      if (sw.running) return card([head('🟢', 'Already running')]);
      await sw.start();
      this.wanted(true);
      return card([head('🟢', 'The crypto swarm is running', sw.mode === 'live' ? '<b>LIVE</b>' : 'paper'), sw.holding ? note('Paused for new trades — /resume to trade.') : null]);
    }
    if (a.action === 'stopall') {
      const open = sw?.open() ?? [];
      const before = open.map((p) => p.id);
      this.wanted(false);
      if (sw) await sw.stop({ flatten: true });
      const closed = (sw?.positions ?? []).filter((p) => before.includes(p.id) && p.closedAt);
      const left = (sw?.open() ?? []).length;
      const B = this.botsFn();
      let stoppedBots = 0;
      for (const b of (B?.list() ?? []).filter((x) => x.running)) {
        await B.stop(b.id, { flatten: true, reason: 'closed and stopped from Telegram' }).catch(() => undefined);
        stoppedBots++;
      }
      return card([
        head('⛔', 'Stopped'),
        table([
          ['Trades closed', closed.length ? `${closed.length} · ${signed(closed.reduce((s, p) => s + (p.pnl ?? 0), 0))}` : 'none open'],
          ...(stoppedBots ? [['Bots stopped', String(stoppedBots)]] : []),
        ]),
        left ? `⚠️ <b>${left} could not be closed</b> — check the exchange.` : null,
        note('Send /startswarm to begin again.'),
      ]);
    }
    return null;
  }
}
