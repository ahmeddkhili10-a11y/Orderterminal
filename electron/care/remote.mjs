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

const MIN = 60_000;
const CONFIRM_TTL = 10 * MIN;
const AGENT = { auction: 'Auctioneer', trend: 'Trend', lab: 'Lab', tape: 'Tape', crowd: 'Crowd', scalper: 'Scalper' };

const usd = (v) => `${v < 0 ? '−' : ''}$${Math.abs(v ?? 0).toFixed(2)}`;
const signed = (v) => `${v >= 0 ? '+' : '−'}$${Math.abs(v ?? 0).toFixed(2)}`;
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
    if (!sw) return 'The crypto swarm is still starting up — try again in a moment.';
    const st = sw.state();
    const L = [`📋 <b>Crypto swarm</b> · ${st.running ? (st.holding ? '⏸ paused for new trades' : '▶ running') : '■ stopped'} · ${st.mode === 'live' ? '<b>LIVE</b>' : 'paper'}${Number.isFinite(st.equity) ? ` · account ${usd(st.equity)}` : ''}`];
    if (!st.open.length) L.push('No open trades.');
    for (const p of st.open) {
      const now = p.price ?? p.entry;
      const r = p.riskUsd > 0 ? p.upnl / p.riskUsd : 0;
      L.push(`• <b>${e(p.coin)} ${p.side === 'buy' ? 'LONG' : 'SHORT'}</b> — ${e(p.agentName ?? AGENT[p.agent] ?? p.agent)}${p.labId ? '' : ''}\n   ${px(p.entry)} → ${px(now)} · <b>${signed(p.upnl)}</b> (${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R) · stop ${px(p.stop)} · target ${px(p.target)} · ${ago(this.now() - p.openedAt)}`);
    }
    if (st.closed?.length) {
      const today = st.closed.filter((p) => this.now() - (p.closedAt ?? 0) < 86_400_000);
      if (today.length) L.push(`Last 24 hours: ${today.length} closed, ${signed(today.reduce((a, p) => a + (p.pnl ?? 0), 0))}`);
    }
    const bots = (this.botsFn()?.list() ?? []).filter((b) => b.running);
    if (bots.length) L.push(`Bots running: ${bots.map((b) => `${e(b.name)} (${b.mode === 'live' ? 'live' : 'paper'})`).join(', ')}`);
    L.push('<i>/pause · /resume · /stop · /startswarm</i>');
    return L.join('\n');
  }

  /** a command from your chat: the reply (with buttons when it asks to confirm), or null when it is not one of these */
  async command(cmd) {
    const sw = this.swarmFn();
    if (cmd === '/positions' || cmd === '/pos') return [{ html: this.positions() }];
    if (cmd === '/pause') {
      if (!sw) return [{ html: 'The crypto swarm is still starting up — try again in a moment.' }];
      sw.hold(true);
      return [{ html: `⏸ <b>Paused for new trades.</b> ${sw.open().length ? `The ${sw.open().length} open trade${sw.open().length > 1 ? 's are' : ' is'} still managed to ${sw.open().length > 1 ? 'their' : 'its'} stop and target.` : 'Nothing is open.'} Send /resume to trade again, /stop to close everything.` }];
    }
    if (cmd === '/resume') {
      if (!sw) return [{ html: 'The crypto swarm is still starting up — try again in a moment.' }];
      sw.hold(false);
      if (!sw.running) return [{ html: '▶ New trades are allowed again — but the swarm itself is <b>stopped</b>.', keyboard: this.startKeys(sw) }];
      return [{ html: '▶ <b>Resumed</b> — the swarm takes new trades again.' }];
    }
    if (cmd === '/stop') {
      const n = sw?.open().length ?? 0;
      const bots = (this.botsFn()?.list() ?? []).filter((b) => b.running).length;
      const token = this.ask('stopall');
      return [
        {
          html: `⛔ <b>Close everything and stop?</b>\nThis closes ${n ? `the ${n} open swarm trade${n > 1 ? 's' : ''}` : 'any open swarm trade'} at market${sw?.mode === 'live' ? ' (<b>LIVE</b>, real money)' : ''}, stops the crypto swarm${bots ? ` and the ${bots} running bot${bots > 1 ? 's' : ''} (their positions closed too)` : ''}. Deployed strategies stay deployed; start again with /startswarm.`,
          keyboard: [[{ text: '⛔ Yes — close everything and stop', callback_data: `rc:${token}:y` }], [{ text: 'Cancel', callback_data: `rc:${token}:n` }]],
        },
      ];
    }
    if (cmd === '/startswarm' || cmd === '/start_swarm') {
      if (!sw) return [{ html: 'The crypto swarm is still starting up — try again in a moment.' }];
      if (sw.running) return [{ html: `The swarm is already running (${sw.mode === 'live' ? 'LIVE' : 'paper'})${sw.holding ? ', paused for new trades — /resume to trade again' : ''}.` }];
      return [{ html: `▶ <b>Start the crypto swarm?</b> It starts in <b>${sw.mode === 'live' ? 'LIVE mode — real money' : 'paper mode'}</b>, with its deployed strategies.`, keyboard: this.startKeys(sw) }];
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
    if (!a) return 'That request has lapsed — send the command again.';
    delete all[m[1]];
    this.db.set('remote:asks', all);
    if (this.now() - a.at > CONFIRM_TTL) return 'That request is more than ten minutes old and has lapsed — send the command again.';
    if (m[2] === 'n') return 'Cancelled — nothing changed.';
    const sw = this.swarmFn();
    if (a.action === 'start') {
      if (!sw) return 'The crypto swarm is still starting up — try again in a moment.';
      if (sw.running) return 'The swarm is already running.';
      await sw.start();
      this.wanted(true);
      return `▶ <b>The crypto swarm is running</b> (${sw.mode === 'live' ? 'LIVE' : 'paper'})${sw.holding ? ' — but paused for new trades: /resume to trade' : ''}.`;
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
      return `⛔ <b>Stopped.</b> ${closed.length ? `Closed ${closed.length} trade${closed.length > 1 ? 's' : ''}: ${signed(closed.reduce((s, p) => s + (p.pnl ?? 0), 0))}.` : 'No swarm trade was open.'}${left ? ` ⚠️ ${left} could not be closed — check the exchange.` : ''}${stoppedBots ? ` ${stoppedBots} bot${stoppedBots > 1 ? 's' : ''} stopped and flattened.` : ''} Send /startswarm to begin again.`;
    }
    return null;
  }
}
