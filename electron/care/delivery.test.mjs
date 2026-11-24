// Telegram going quiet is seen in the terminal: every message is recorded as delivered or not,
// with the reason in plain words; formatting Telegram refuses is sent again as plain text; and
// stars held back because they do not fit the account are told about, never offered.
import { describe, expect, it } from 'vitest';
import { Delivery, gist, plainWhy } from './delivery.mjs';
import { Approvals, heldText } from './approve.mjs';
import { tgHtmlProblem, tgPlain, tgSend, tgSendKeyboard } from '../../src/shared/telegram.ts';

const TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const memDb = () => {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
};
/** a fake Telegram: refuses HTML when told to, records what it was sent */
const fakeTg = ({ refuseHtml = false, fail = null } = {}) => {
  const sent = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (fail) return { json: async () => ({ ok: false, description: fail }) };
    if (refuseHtml && body.parse_mode === 'HTML') return { json: async () => ({ ok: false, description: "Bad Request: can't parse entities: unsupported start tag \"x\" at byte offset 3" }) };
    sent.push(body);
    return { json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  };
  return { sent, fetch };
};

describe('Telegram delivery', () => {
  it('records each message as delivered, or failed with the reason in plain words', async () => {
    const d = new Delivery({ now: () => 1000 });
    await d.track('<b>Daily check-in</b>\nall fine', async () => 'ok');
    expect(d.state()).toMatchObject({ lastOkAt: 1000, lastOkWhat: 'Daily check-in', failsInRow: 0, failing: false });
    await expect(d.track('⚠️ <b>Swarm stopped</b>', async () => Promise.reject(new Error('Unauthorized')))).rejects.toThrow();
    expect(d.state().failing).toBe(false);
    await expect(d.track('trade card', async () => Promise.reject(new Error('Unauthorized')))).rejects.toThrow();
    const st = d.state();
    expect(st.failing).toBe(true);
    expect(st.failsInRow).toBe(2);
    expect(st.lastWhy).toMatch(/does not accept the bot token/);
    // one that arrives clears it
    await d.track('next', async () => 'ok');
    expect(d.state().failing).toBe(false);
    // kept in the database
    const db = memDb();
    d.attach(db);
    const again = new Delivery();
    again.attach(db);
    expect(again.state().lastOkWhat).toBe('next');
    expect(again.state().recent.length).toBeGreaterThan(3);
  });

  it('says what each Telegram error means', () => {
    expect(plainWhy(new Error('Forbidden: bot was blocked by the user'))).toMatch(/Unblock/);
    expect(plainWhy(new Error('Bad Request: chat not found'))).toMatch(/detect the chat again/);
    expect(plainWhy(new Error('fetch failed'))).toMatch(/could not be reached/);
    expect(gist('<b>⭐ Star</b> &amp; more\nsecond line')).toBe('⭐ Star & more');
  });

  it('formatting Telegram refuses is sent again as plain text, so the words still arrive', async () => {
    const t = fakeTg({ refuseHtml: true });
    await tgSend(TOKEN, '42', '<b>Bold</b> &amp; <i>more</i>', t.fetch);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].parse_mode).toBeUndefined();
    expect(t.sent[0].text).toBe('Bold & more');
    // with buttons too
    const k = fakeTg({ refuseHtml: true });
    await tgSendKeyboard(TOKEN, '42', '<b>Deploy?</b>', [[{ text: 'Yes', callback_data: 'x' }]], k.fetch);
    expect(k.sent[0].text).toBe('Deploy?');
    expect(k.sent[0].reply_markup.inline_keyboard).toHaveLength(1);
    // a real failure (not formatting) is not hidden
    await expect(tgSend(TOKEN, '42', '<b>x</b>', fakeTg({ fail: 'Unauthorized' }).fetch)).rejects.toThrow(/Unauthorized/);
  });

  it('checks formatting the way Telegram does', () => {
    expect(tgHtmlProblem('<b>ok</b> <i>fine</i>\n<pre>a  1</pre>\n<blockquote expandable>small <b>print</b></blockquote>')).toBeNull();
    expect(tgHtmlProblem('<blockquote><pre>x</pre></blockquote>')).toMatch(/pre/);
    expect(tgHtmlProblem('<b>open')).toMatch(/never closed/);
    expect(tgHtmlProblem('a < b')).toMatch(/stray/);
    expect(tgHtmlProblem('R&D')).toMatch(/stray "&"/);
    expect(tgHtmlProblem('<div>x</div>')).toMatch(/not a tag/);
    expect(tgPlain('a &lt;b&gt; &amp; <b>c</b>')).toBe('a <b> & c');
  });
});

describe('stars too wide for the account', () => {
  const fit = { usd: 55, zar: 1000, share: 0.4, fits: false, needUsd: 180, risk: 0.02, stop: 0.08 };
  const held = [
    { id: 'a', name: 'Donchian breakout · Bitcoin trend', style: 'swing', ret: 2.6, fit },
    { id: 'b', name: 'Weekly reversal · calm', style: 'position', ret: 2.2, fit },
  ];
  it('are told about once (at most one message a day), never offered with buttons', () => {
    let t = 1e12;
    let pool = held;
    const db = memDb();
    const a = new Approvals({ db, teams: () => [], stars: () => [], held: () => pool, deployed: () => [], deploy: async () => undefined, now: () => t });
    const first = a.check();
    expect(first).toHaveLength(1);
    expect(first[0].keyboard).toBeUndefined();
    expect(first[0].html).toMatch(/2 new stars held back/);
    expect(first[0].html).toMatch(/R1,000 \(\$55\)/);
    expect(first[0].html).toMatch(/needs R3,300/);
    // the same ones again: nothing
    t += 2 * 86_400_000;
    expect(a.check()).toHaveLength(0);
    // a new one, but within a day of the last message: waits
    pool = [...held, { id: 'c', name: 'Turtle', style: 'swing', ret: 3, fit }];
    t += 1000;
    expect(a.check()).toHaveLength(1);
    pool = [...pool, { id: 'd', name: 'Another', style: 'swing', ret: 3, fit }];
    t += 1000;
    expect(a.check()).toHaveLength(0);
    // /stars says why nothing is offered
    expect(a.starPool()[0].html).toMatch(/No star fits your account yet/);
  });
  it('the message is valid Telegram formatting', () => {
    expect(tgHtmlProblem(heldText(held))).toBeNull();
    expect(tgHtmlProblem(heldText(held, { all: true }))).toBeNull();
  });
});
