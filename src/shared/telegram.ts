/**
 * Minimal Telegram Bot API connector: send messages, discover the chat id
 * from the latest message sent to the bot, and answer a few read-only
 * commands. Commands are only answered in the configured chat.
 */

type FetchLike = typeof fetch;

export interface TelegramChat {
  id: string;
  title: string;
}

function checkToken(token: string) {
  if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error('That does not look like a bot token (expected 123456:ABC… from @BotFather)');
}

export async function tgApi<T = any>(token: string, method: string, params: Record<string, unknown> = {}, fetchImpl: FetchLike = fetch): Promise<T> {
  checkToken(token);
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.description ?? `Telegram ${method} failed`);
  return j.result as T;
}

export async function tgMe(token: string, fetchImpl?: FetchLike) {
  const me = await tgApi<{ username: string; first_name: string }>(token, 'getMe', {}, fetchImpl);
  return { username: me.username, name: me.first_name };
}

/** The chat of the most recent message sent to the bot (send it "/start" first). */
export async function tgDetectChat(token: string, fetchImpl?: FetchLike): Promise<TelegramChat> {
  const updates = await tgApi<any[]>(token, 'getUpdates', { limit: 100, timeout: 0 }, fetchImpl);
  for (let i = updates.length - 1; i >= 0; i--) {
    const chat = updates[i].message?.chat ?? updates[i].channel_post?.chat ?? updates[i].my_chat_member?.chat;
    if (chat) return { id: String(chat.id), title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id) };
  }
  throw new Error('No messages yet — open your bot in Telegram, press Start (or send any message), then try again.');
}

export function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TG_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'span', 'tg-spoiler', 'a', 'tg-emoji', 'code', 'pre', 'blockquote']);
const STYLE = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'span', 'tg-spoiler']);

/**
 * Why Telegram would refuse this HTML, or null when it is fine. Telegram drops the whole
 * message on any of these (Bot API, "Formatting options"): a tag it does not know, a stray
 * < or &, a tag left open or closed twice, a table (pre) or code inside anything but itself,
 * anything inside a table or code, a quote inside a quote, or a quote or link holding a
 * table, code, link or quote.
 */
export function tgHtmlProblem(html: string): string | null {
  const stack: string[] = [];
  const re = /<(\/?)([a-z-]+)([^<>]*)>|<|>|&(?!(?:lt|gt|amp|quot|#\d+|#x[0-9a-f]+);)/gi;
  for (const m of html.matchAll(re)) {
    if (m[0] === '<' || m[0] === '>') return `a stray "${m[0]}" (write &lt; or &gt;)`;
    if (m[0] === '&') return 'a stray "&" (write &amp;)';
    const name = m[2].toLowerCase();
    if (!TG_TAGS.has(name)) return `<${name}> is not a tag Telegram knows`;
    if (m[1]) {
      if (stack[stack.length - 1] !== name) return `</${name}> does not close the last tag opened (${stack[stack.length - 1] ?? 'none'})`;
      stack.pop();
      continue;
    }
    const parent = stack[stack.length - 1];
    if (parent === 'code' || (parent === 'pre' && name !== 'code')) return `<${name}> inside <${parent}>`;
    if ((name === 'pre' || name === 'code') && stack.some((t) => STYLE.has(t) || t === 'blockquote' || t === 'a')) return `<${name}> inside <${stack.find((t) => STYLE.has(t) || t === 'blockquote' || t === 'a')}>`;
    if (name === 'blockquote' && stack.some((t) => t === 'blockquote' || t === 'a')) return '<blockquote> inside a quote or a link';
    if (name === 'a' && stack.some((t) => t === 'a' || t === 'blockquote')) return '<a> inside a link or a quote';
    stack.push(name);
  }
  return stack.length ? `<${stack[stack.length - 1]}> is never closed` : null;
}

/** the message as plain text (for when Telegram will not take its formatting): tags out, characters back */
export function tgPlain(html: string): string {
  return html
    .replace(/<[^<>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Telegram refused the formatting (as opposed to a wrong token, chat or network) */
export const isParseError = (e: unknown) => /can't parse|parse entities|unsupported start tag|unexpected end tag|can't find end|entity/i.test(String((e as Error)?.message ?? e));

export async function tgSend(token: string, chatId: string, html: string, fetchImpl?: FetchLike) {
  if (!chatId) throw new Error('No chat id yet — use “Detect chat” first');
  // formatting Telegram would refuse is sent as plain text: the words arrive either way
  if (tgHtmlProblem(html)) return void (await tgApi(token, 'sendMessage', { chat_id: chatId, text: tgPlain(html), disable_web_page_preview: true }, fetchImpl));
  try {
    await tgApi(token, 'sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }, fetchImpl);
  } catch (e) {
    if (!isParseError(e)) throw e;
    await tgApi(token, 'sendMessage', { chat_id: chatId, text: tgPlain(html), disable_web_page_preview: true }, fetchImpl);
  }
}

/** Telegram caps messages at 4096 characters: split on line breaks. */
/**
 * A long message in parts Telegram accepts (4,096 characters each), split at line ends — never
 * inside a tag. A table, quote or bold run that spans the split is closed at the end of one part
 * and opened again at the start of the next, so every part is valid on its own.
 */
export function splitHtml(html: string, max = 3800): string[] {
  const out: string[] = [];
  let cur = '';
  let open: string[] = [];
  const closeAll = (tags: string[]) => [...tags].reverse().map((t) => `</${t.split(/[\s>]/)[0]}>`).join('');
  const openAll = (tags: string[]) => tags.map((t) => `<${t}>`).join('');
  const track = (line: string) => {
    for (const m of line.matchAll(/<(\/?)([a-z-]+)([^>]*)>/gi)) {
      const name = m[2].toLowerCase();
      if (!['b', 'i', 'u', 's', 'code', 'pre', 'blockquote', 'a', 'tg-spoiler'].includes(name)) continue;
      if (m[1]) {
        const k = open.map((t) => t.split(/[\s>]/)[0]).lastIndexOf(name);
        if (k >= 0) open.splice(k, 1);
      } else open.push(`${name}${m[3]}`);
    }
  };
  for (const line of html.split('\n')) {
    if (cur && cur.length + line.length + 1 + closeAll(open).length > max) {
      out.push(cur + closeAll(open));
      cur = openAll(open);
    }
    cur = cur ? `${cur}${cur.endsWith('>') && cur === openAll(open) ? '' : '\n'}${line}` : line.slice(0, max);
    track(line);
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export async function tgSendLong(token: string, chatId: string, html: string, fetchImpl?: FetchLike) {
  for (const part of splitHtml(html)) await tgSend(token, chatId, part, fetchImpl);
}

/** PNG with an HTML caption (captions are limited to 1024 characters). */
export async function tgSendPhoto(token: string, chatId: string, png: Uint8Array, captionHtml: string, fetchImpl: FetchLike = fetch) {
  checkToken(token);
  if (!chatId) throw new Error('No chat id yet — use “Detect chat” first');
  const post = async (html: boolean) => {
    const form = new FormData();
    form.append('chat_id', chatId);
    const plain = tgPlain(captionHtml);
    form.append('caption', html ? captionHtml : plain.length > 1024 ? `${plain.slice(0, 1020)}…` : plain);
    if (html) form.append('parse_mode', 'HTML');
    form.append('photo', new Blob([png as BlobPart], { type: 'image/png' }), 'chart.png');
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    const j = await res.json();
    if (!j.ok) throw new Error(j.description ?? 'Telegram sendPhoto failed');
  };
  const html = captionHtml.length <= 1024 && !tgHtmlProblem(captionHtml);
  try {
    await post(html);
  } catch (e) {
    // the caption's formatting refused: the picture goes with plain words
    if (!html || !isParseError(e)) throw e;
    await post(false);
  }
}

export const HELP_TEXT = [
  '🧭 <b>Novus Ordo — what you can send</b>',
  '',
  '<b>📋 Your trading</b>',
  '/positions — the account and every open trade',
  '/pause — no new trades (open ones still managed)',
  '/resume — take new trades again',
  '/stop — close everything and stop <i>(asks first)</i>',
  '/startswarm — start the crypto swarm <i>(asks first)</i>',
  '',
  '<b>🔬 The edge finder</b>',
  '/stars — proven strategies over 200 % a year, to deploy',
  '/teams — proven teams of three, to deploy',
  '',
  '<b>📡 Market</b>',
  '/price — the main instrument’s price',
  '/status — price, funding, open interest and feeds',
  '/wallet — the swarm wallet address',
  '',
  '<i>/help — this list</i>',
].join('\n');

/** a button under a message: its text, and what comes back when it is tapped (at most 64 bytes) */
export type TgButton = { text: string; callback_data: string };

/** a message with buttons under it; returns its message id */
export async function tgSendKeyboard(token: string, chatId: string, html: string, keyboard: TgButton[][], fetchImpl?: FetchLike): Promise<number> {
  if (!chatId) throw new Error('No chat id yet — use “Detect chat” first');
  const send = (text: string, html: boolean) =>
    tgApi<{ message_id: number }>(token, 'sendMessage', { chat_id: chatId, text, ...(html ? { parse_mode: 'HTML' } : {}), disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } }, fetchImpl);
  const part = splitHtml(html, 4000)[0] ?? '';
  if (tgHtmlProblem(part)) return (await send(tgPlain(part), false)).message_id;
  try {
    return (await send(part, true)).message_id;
  } catch (e) {
    if (!isParseError(e)) throw e;
    return (await send(tgPlain(part), false)).message_id;
  }
}

/** what the poller does besides the read-only commands */
export interface TelegramHandlers {
  /** answer /price, /status, /wallet (the Telegram panel's tick-box); /teams and buttons are always answered */
  answerBasics?: () => boolean;
  /** a command the app answers itself (e.g. /teams): a reply, with buttons if any, or null */
  command?: (cmd: string) => Promise<{ html: string; keyboard?: TgButton[][] }[] | null>;
  /** a button was tapped: the reply to send, or null */
  callback?: (data: string) => Promise<string | null>;
}

/**
 * Long-polls getUpdates and answers /price, /status and /help using the
 * latest snapshot from `status()`. Messages from any other chat are ignored.
 */
export class TelegramCommands {
  private stopped = false;
  private offset = 0;

  constructor(
    private token: string,
    private chatId: string,
    private status: () => { price: string; status: string; wallet?: string },
    private fetchImpl: FetchLike = fetch,
    private onError: (e: unknown) => void = () => undefined,
    private handlers: TelegramHandlers = {},
  ) {}

  /** Handle one batch of updates; returns the replies sent (for tests). */
  async handle(updates: any[]): Promise<string[]> {
    const replies: string[] = [];
    for (const u of updates) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      // a button tapped under one of our messages: only in the configured chat
      const q = u.callback_query;
      if (q) {
        if (String(q.message?.chat?.id) !== this.chatId || !this.handlers.callback) continue;
        let reply: string | null = null;
        try {
          reply = await this.handlers.callback(String(q.data ?? ''));
        } catch (e) {
          reply = `⚠️ ${escapeHtml(String((e as Error)?.message ?? e))}`;
        }
        await tgApi(this.token, 'answerCallbackQuery', { callback_query_id: q.id, text: reply ? 'Done' : '' }, this.fetchImpl).catch(() => undefined);
        // the buttons go once used: a second tap cannot deploy twice
        if (q.message?.message_id) await tgApi(this.token, 'editMessageReplyMarkup', { chat_id: this.chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }, this.fetchImpl).catch(() => undefined);
        if (reply) {
          await tgSend(this.token, this.chatId, reply, this.fetchImpl);
          replies.push(reply);
        }
        continue;
      }
      const msg = u.message;
      if (!msg?.text || String(msg.chat?.id) !== this.chatId) continue;
      const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase();
      const own: { html: string; keyboard?: TgButton[][] }[] | null = this.handlers.command ? await this.handlers.command(cmd).catch((e) => [{ html: `⚠️ ${escapeHtml(String((e as Error)?.message ?? e))}` }]) : null;
      if (own) {
        for (const r of own) {
          if (r.keyboard?.length) await tgSendKeyboard(this.token, this.chatId, r.html, r.keyboard, this.fetchImpl);
          else await tgSend(this.token, this.chatId, r.html, this.fetchImpl);
          replies.push(r.html);
        }
        continue;
      }
      if (this.handlers.answerBasics && !this.handlers.answerBasics() && cmd !== '/help' && cmd !== '/start') continue;
      const snap = this.status();
      const reply = cmd === '/price' ? snap.price : cmd === '/status' ? snap.status : (cmd === '/wallet' || cmd === '/address') && snap.wallet ? snap.wallet : cmd === '/help' || cmd === '/start' ? HELP_TEXT : null;
      if (!reply) continue;
      await tgSend(this.token, this.chatId, reply, this.fetchImpl);
      replies.push(reply);
    }
    return replies;
  }

  async run() {
    // skip the backlog so old commands are not answered on start
    try {
      const old = await tgApi<any[]>(this.token, 'getUpdates', { offset: -1, timeout: 0 }, this.fetchImpl);
      if (old.length) this.offset = old[old.length - 1].update_id + 1;
    } catch (e) {
      this.onError(e);
    }
    while (!this.stopped) {
      try {
        const updates = await tgApi<any[]>(this.token, 'getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, this.fetchImpl);
        if (!this.stopped) await this.handle(updates);
      } catch (e) {
        if (this.stopped) return;
        this.onError(e);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stop() {
    this.stopped = true;
  }
}
