// Did the Telegram messages arrive? Every message Novus Ordo sends (the background engine's
// check-ins and warnings, the swarm's trade cards, offers, replies) passes through here, so a
// failure — a bot token revoked, a chat that changed, Telegram unreachable — is seen in the
// terminal instead of the phone simply going quiet.

const KEEP = 30;

/** the first words of a message, for the record (no formatting, nothing long) */
export const gist = (html) =>
  String(html ?? '')
    .replace(/<[^<>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((x) => x.trim())
    .find(Boolean)
    ?.slice(0, 70) ?? '';

/** what a Telegram error means, in plain words */
export function plainWhy(err) {
  const m = String(err?.message ?? err);
  if (/unauthorized|401/i.test(m)) return 'Telegram does not accept the bot token any more — it may have been revoked in @BotFather. Paste the new token in Keys.';
  if (/chat not found/i.test(m)) return 'Telegram cannot find the chat — detect the chat again on the Telegram panel.';
  if (/bot was blocked|blocked by the user/i.test(m)) return 'The bot is blocked in Telegram — open the bot in Telegram and press Unblock (or Start).';
  if (/kicked|not a member|have no rights/i.test(m)) return 'The bot is no longer in that chat — add it back, then detect the chat again.';
  if (/too many requests|429/i.test(m)) return 'Telegram asked to slow down for a moment — the next messages will go through.';
  if (/no chat id/i.test(m)) return 'No chat linked yet — detect the chat on the Telegram panel.';
  if (/fetch failed|network|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|socket/i.test(m)) return 'Telegram could not be reached from this computer (no internet, or a firewall or VPN blocking api.telegram.org).';
  return m.slice(0, 200);
}

export class Delivery {
  constructor(o = {}) {
    this.now = o.now ?? Date.now;
    this.db = null;
    this.st = { lastOkAt: 0, lastOkWhat: '', lastFailAt: 0, lastFailWhat: '', lastWhy: '', failsInRow: 0, recent: [] };
  }

  /** the record is kept in the database from the moment it is open */
  attach(db) {
    this.db = db;
    const saved = db.get('tg:delivery');
    if (saved) this.st = { ...this.st, ...saved, recent: [...(saved.recent ?? []), ...this.st.recent].slice(-KEEP) };
    this.save();
  }

  save() {
    try {
      this.db?.set('tg:delivery', this.st);
    } catch {
      /* the record is a convenience */
    }
  }

  ok(what) {
    const t = this.now();
    this.st = { ...this.st, lastOkAt: t, lastOkWhat: gist(what), failsInRow: 0, recent: [...this.st.recent, { t, ok: true, what: gist(what) }].slice(-KEEP) };
    this.save();
  }

  fail(what, err) {
    const t = this.now();
    const why = plainWhy(err);
    this.st = { ...this.st, lastFailAt: t, lastFailWhat: gist(what), lastWhy: why, failsInRow: this.st.failsInRow + 1, recent: [...this.st.recent, { t, ok: false, what: gist(what), why }].slice(-KEEP) };
    this.save();
  }

  /** send through `fn`, recording how it went (the error still reaches the caller) */
  async track(what, fn) {
    try {
      const r = await fn();
      this.ok(what);
      return r;
    } catch (e) {
      this.fail(what, e);
      throw e;
    }
  }

  /** for the screen: is Telegram getting the messages? */
  state() {
    const s = this.st;
    return { ...s, failing: s.failsInRow >= 2 };
  }
}
