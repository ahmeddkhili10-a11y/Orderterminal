import { fmtDuration, fmtPct, fmtPrice, fmtUsd } from '../core/format';
import { hub } from '../market/hub';
import { card, section, table } from '../shared/tgcard';
import { escapeHtml, TelegramCommands, tgDetectChat, tgMe, tgSendLong, tgSendPhoto } from '../shared/telegram';
import { getSettings, useSettings } from '../store/settings';
import { desktop } from './bridge';
import { vault } from './vault';

/**
 * Telegram facade. Desktop: the bot token stays in the main process. Browser:
 * the token is decrypted from the browser vault and the Bot API is called
 * directly.
 */

async function webCreds(id: string) {
  const f = await vault.webFields(id);
  if (!f.token) throw new Error('This key has no bot token');
  return { token: f.token, chatId: f.chatId ?? '' };
}

export const telegram = {
  async me(id: string) {
    if (desktop) return desktop.telegram.me(id);
    return tgMe((await webCreds(id)).token);
  },
  async detect(id: string) {
    if (desktop) return desktop.telegram.detect(id);
    const c = await webCreds(id);
    const chat = await tgDetectChat(c.token);
    const rec = (await vault.list()).find((r) => r.id === id)!;
    await vault.save({ id, label: rec.label, kind: 'telegram', fields: { chatId: chat.id } });
    return chat;
  },
  async send(id: string, html: string) {
    if (desktop) return desktop.telegram.send(id, html);
    const c = await webCreds(id);
    return tgSendLong(c.token, c.chatId, html);
  },
  async sendPhoto(id: string, png: Uint8Array, caption: string) {
    if (desktop) return desktop.telegram.sendPhoto(id, png, caption);
    const c = await webCreds(id);
    return tgSendPhoto(c.token, c.chatId, png, caption);
  },
};

/** Plain-text snapshot used to answer /price and /status. */
export function statusSnapshot() {
  const H = hub();
  const f = H.primary;
  const p = f.lastPrice();
  const s = f.stats;
  const title = `📈 <b>${escapeHtml(f.inst.symbol)}</b> · ${escapeHtml(f.adapter.name)}`;
  const price = `${title}\n<b>${fmtPrice(p)}</b>${s.change24hPct !== undefined ? `  ${s.change24hPct >= 0 ? '🟢' : '🔴'} ${fmtPct(s.change24hPct)} in 24 h` : ''}`;
  const rows: [string, string][] = [];
  if (s.fundingRate !== undefined) rows.push(['Funding', `${(s.fundingRate * 100).toFixed(4)}%${s.nextFundingTime ? ` · in ${fmtDuration(s.nextFundingTime - Date.now())}` : ''}`]);
  if (s.openInterestUsd) rows.push(['Open interest', fmtUsd(s.openInterestUsd)]);
  if (s.markPrice && s.indexPrice) rows.push(['Basis', `${(((s.markPrice - s.indexPrice) / s.indexPrice) * 1e4).toFixed(1)} bps`]);
  const feeds = H.aggregate.map((x) => `${escapeHtml(x.adapter.short)} ${x.status.state === 'open' ? '✅' : '❌'}`).join('   ');
  return { price, status: card([price, rows.length ? table(rows) : null, section('📡 Feeds', [feeds])]) };
}

let webPoller: TelegramCommands | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;

/** Start/stop command replies to follow settings; call once at app start. */
export function startTelegramService() {
  const apply = async () => {
    const s = getSettings();
    const on = s.telegramCommands && s.telegramSecretId;
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
    webPoller?.stop();
    webPoller = null;
    try {
      if (desktop) {
        // the bot chosen here is the one the background engine sends with (check-ins, warnings, offers),
        // whether or not the bot answers /price — before, it only learnt of it with that box ticked
        await desktop.care?.bot?.(s.telegramSecretId || null).catch(() => undefined);
        await desktop.telegram.commands(on ? s.telegramSecretId : null);
        if (on) statusTimer = setInterval(() => void desktop!.telegram.setStatus(statusSnapshot()), 5000);
      } else if (on) {
        const c = await webCreds(s.telegramSecretId);
        if (!c.chatId) return;
        webPoller = new TelegramCommands(c.token, c.chatId, statusSnapshot);
        void webPoller.run();
      }
    } catch (e) {
      console.warn('telegram commands', e);
    }
  };
  void apply();
  useSettings.subscribe((s, prev) => {
    if (s.telegramCommands !== prev.telegramCommands || s.telegramSecretId !== prev.telegramSecretId) void apply();
  });
}
