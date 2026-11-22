// The order-flow bots' trades on the phone: each entry, the moment a trade is
// safe, each exit with its result, a bot stopping, and failures — in the bots'
// own plain words. Watching and let-go lines stay in the bot's log, so the
// phone stays quiet. The Luno lane has its own alerts.
import type { AmtBot, AmtEvent } from './bridge';
import { desktop } from './bridge';
import { onAmtEvent } from './amt';
import { alertHere } from '../alerts/here';
import { isLaneBot } from '../luno/lane';
import { bullets, card, head } from '../shared/tgcard';
import { escapeHtml } from '../shared/telegram';
import { getSettings } from '../store/settings';

const SENT = new Set(['entry', 'manage', 'exit', 'stopped']);

/** What goes out for one bot event, or null for what stays in the log. */
export function botAlert(e: Pick<AmtEvent, 'kind' | 'text' | 'data'>, bot: Pick<AmtBot, 'name' | 'mode' | 'exchangeId'>): { title: string; html: string; toast: string; tone: 'buy' | 'sell' | 'info' } | null {
  const where = `${bot.name} · ${bot.exchangeId}${bot.mode === 'live' ? ' · LIVE' : ' · paper'}`;
  if (e.kind === 'error') return { title: `${bot.name}: problem`, html: card([head('⚠️', `${escapeHtml(bot.name)} — needs a look`, escapeHtml(where)), escapeHtml(e.text)]), toast: e.text, tone: 'info' };
  if (e.kind !== 'story' || !SENT.has(String(e.data?.story))) return null;
  const [first, ...rest] = e.text.split('\n');
  const story = e.data?.story;
  const tone = story === 'entry' ? 'buy' : story === 'exit' ? (e.data?.outcome === 'loss' ? 'sell' : 'buy') : 'info';
  // the bot's own first line may start with its emoji: it becomes the icon (never two)
  const own = /^(\p{Extended_Pictographic}\uFE0F?)\s*/u.exec(first);
  const icon = own ? own[1] : story === 'entry' ? '🔵' : story === 'exit' ? (e.data?.outcome === 'loss' ? '🔴' : '🟢') : 'ℹ️';
  const line = own ? first.slice(own[0].length) : first;
  return { title: first.slice(0, 80), html: card([head(icon, escapeHtml(line), escapeHtml(where)), rest.length ? bullets(rest.filter((x) => x.trim()).map((x) => escapeHtml(x.replace(/^[•\-]\s*/, '')))).join('\n') : null]), toast: first, tone };
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
