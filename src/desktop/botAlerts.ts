// The order-flow bots' trades on the phone: each entry, the moment a trade is
// safe, each exit with its result, a bot stopping, and failures — in the bots'
// own plain words. Watching and let-go lines stay in the bot's log, so the
// phone stays quiet. The Luno lane has its own alerts.
import type { AmtBot, AmtEvent } from './bridge';
import { desktop } from './bridge';
import { onAmtEvent } from './amt';
import { alertHere } from '../alerts/here';
import { isLaneBot } from '../luno/lane';
import { escapeHtml } from '../shared/telegram';
import { getSettings } from '../store/settings';

const SENT = new Set(['entry', 'manage', 'exit', 'stopped']);

/** What goes out for one bot event, or null for what stays in the log. */
export function botAlert(e: Pick<AmtEvent, 'kind' | 'text' | 'data'>, bot: Pick<AmtBot, 'name' | 'mode' | 'exchangeId'>): { title: string; html: string; toast: string; tone: 'buy' | 'sell' | 'info' } | null {
  const where = `${bot.name} · ${bot.exchangeId}${bot.mode === 'live' ? ' · LIVE' : ' · paper'}`;
  if (e.kind === 'error') return { title: `${bot.name}: problem`, html: `⚠️ <b>${escapeHtml(where)}</b>\n${escapeHtml(e.text)}`, toast: e.text, tone: 'info' };
  if (e.kind !== 'story' || !SENT.has(String(e.data?.story))) return null;
  const [head, ...rest] = e.text.split('\n');
  const story = e.data?.story;
  const tone = story === 'entry' ? 'buy' : story === 'exit' ? (e.data?.outcome === 'loss' ? 'sell' : 'buy') : 'info';
  return { title: head.slice(0, 80), html: `<b>${escapeHtml(head)}</b>${rest.length ? `\n${escapeHtml(rest.join('\n'))}` : ''}\n<i>${escapeHtml(where)}</i>`, toast: head, tone };
}

let bots = new Map<string, AmtBot>();
let on = false;

async function reload() {
  if (!desktop) return;
  try {
    bots = new Map((await desktop.amt.list()).filter((b) => !isLaneBot(b)).map((b) => [b.id, b]));
  } catch {
    /* keep what we had */
  }
}

export function startBotAlerts() {
  if (!desktop || on) return;
  on = true;
  void reload();
  onAmtEvent((e) => {
    if (e.kind === 'started') void reload();
    const b = bots.get(e.id);
    if (!b) return;
    const a = botAlert(e, b);
    if (!a) return;
    const s = getSettings();
    if (e.kind === 'error' || e.data?.story === 'entry' || e.data?.story === 'exit') alertHere(a.title, a.toast, a.tone);
    if (s.telegramBots && s.telegramSecretId) void desktop!.swarm.notify(s.telegramSecretId, a.html).catch(() => undefined);
  });
}
