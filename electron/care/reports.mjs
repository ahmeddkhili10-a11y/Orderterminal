// The words Novus Ordo sends while you are away: the daily "still alive"
// message, the warnings when something stops, and the weekly report card.
// Pure functions of a snapshot, so each message can be tested as written.
import { escapeHtml as e } from '../../src/shared/telegram.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AGENT = { auction: 'Auctioneer', trend: 'Trend', tape: 'Tape', crowd: 'Crowd', lab: 'Lab', scalper: 'Scalper' };
const SOURCE = { swarm: 'Crypto swarm', lab: 'Deployed strategies', bot: 'Order-flow bots', lane: 'Luno lane' };
const DOT = { ok: '🟢', early: '⚪', quiet: '🔵', behind: '🟠', stopped: '🔴' };

export const usd = (v) => `${v < 0 ? '−' : ''}$${Math.abs(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const money = (v, q = 'USD') => (String(q).toUpperCase() === 'ZAR' ? `${v < 0 ? '−' : ''}R${Math.abs(v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : usd(v));
const signed = (v, q) => `${v >= 0 ? '+' : ''}${money(v, q)}`;
const signedR = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v ?? 0).toFixed(2)}R`;
const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayName = (t) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const ago = (ms) => (ms < 90_000 ? 'just now' : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min ago` : ms < 2 * DAY ? `${Math.round(ms / HOUR)} h ago` : `${Math.round(ms / DAY)} days ago`);
const n = (x) => Math.round(x ?? 0).toLocaleString('en-US');

/** dollars and rands kept apart (the Luno lane trades in rands) */
function totalsByQuote(rows) {
  const by = {};
  for (const r of rows) {
    const q = String(r.quote ?? 'USD').toUpperCase() === 'ZAR' ? 'ZAR' : 'USD';
    const t = (by[q] ??= { n: 0, wins: 0, pnl: 0, fees: 0 });
    t.n++;
    if (r.pnl > 0) t.wins++;
    t.pnl += r.pnl ?? 0;
    t.fees += r.fees ?? 0;
  }
  return by;
}
const totalsWords = (rows) =>
  Object.entries(totalsByQuote(rows))
    .map(([q, t]) => `${t.n} trade${t.n === 1 ? '' : 's'}, ${t.wins} won, <b>${signed(t.pnl, q)}</b>`)
    .join(' · ') || 'no trades';

/**
 * What needs a look now. Each problem has a key (told once, then again only if
 * it lasts six hours) and the age it must reach before it counts, so a blip of
 * a second is never a warning.
 */
export function problemsOf(s) {
  const out = [];
  const sw = s.swarm;
  if (s.wanted?.swarm && sw && !sw.running) out.push({ key: 'swarm-stopped', after: 3 * 60_000, text: `The crypto swarm is <b>not running</b> — it was before${sw.open?.length ? `. ${sw.open.length} open trade${sw.open.length > 1 ? 's' : ''} ${sw.mode === 'live' ? 'keep their exchange stops' : 'wait for it'}` : ''}. Open Novus Ordo and start it again.` });
  if (sw?.running)
    for (const c of sw.coins ?? [])
      if (c.feed !== 'open') out.push({ key: `feed:${c.coin}`, after: 5 * 60_000, text: `No live prices for <b>${e(c.coin)}</b> (${e(c.feed ?? 'no feed')}${c.feedError ? `: ${e(String(c.feedError).slice(0, 120))}` : ''}). The swarm cannot trade it until the feed is back; it keeps reconnecting.` });
  if (sw?.running && sw.book?.pausedUntil > s.now) out.push({ key: 'swarm-paused', after: 0, info: true, text: `The swarm's risk rules have <b>paused new trades until ${clock(sw.book.pausedUntil)}</b> (a daily loss limit or a losing streak). Open trades are still managed.` });
  const f = s.farm;
  if (f?.wanted && !f.running && !f.starting) out.push({ key: 'farm-down', after: 15 * 60_000, text: `The edge finder is <b>not running</b>${f.error ? ` (${e(String(f.error).slice(0, 140))})` : ''}. It restarts itself; if this stays, open FARM and press Start.` });
  if (f?.running && f.data && f.data.ok === false) out.push({ key: 'farm-data', after: 6 * HOUR, text: `The edge finder's candles are <b>out of date</b> (last good download ${f.data.lastOkAt ? ago(s.now - f.data.lastOkAt) : 'never'}). It keeps trying every exchange, and keeps testing on what it has.` });
  if (s.screen && s.screen !== 'ok') out.push({ key: 'screen', after: 2 * 60_000, text: s.screen === 'gone' ? 'The terminal\'s window <b>crashed</b>. Trading goes on in the background; open Novus Ordo to bring the window back.' : 'The terminal\'s window has <b>stopped responding</b>. Trading goes on in the background.' });
  for (const err of s.errors ?? []) out.push({ key: `err:${err.key}`, after: 0, text: `⛔ ${e(err.text)}` });
  return out;
}

/** the daily "still alive" message */
export function dailyText(s) {
  const lines = [];
  const probs = s.problems ?? [];
  lines.push(probs.length ? `🟠 <b>Novus Ordo — running, ${probs.length} thing${probs.length > 1 ? 's' : ''} to look at</b> · ${dayName(s.now)}` : `🟢 <b>Novus Ordo — all running</b> · ${dayName(s.now)}, ${clock(s.now)}`);
  for (const p of probs) lines.push(`• ${p.text}`);
  const sw = s.swarm;
  if (sw) {
    const eq = sw.equity;
    const d = s.equityDayAgo;
    const change = Number.isFinite(eq) && Number.isFinite(d) && d > 0 ? ` (${eq - d >= 0 ? '+' : '−'}${usd(Math.abs(eq - d)).replace(/^−/, '')} in 24 h)` : '';
    lines.push('');
    lines.push(`<b>Crypto swarm:</b> ${sw.running ? 'running' : 'stopped'} · ${sw.mode === 'live' ? 'LIVE' : 'paper'}${Number.isFinite(eq) ? ` · account ${usd(eq)}${change}` : ''}`);
    if (sw.open?.length) lines.push(`Open: ${sw.open.map((p) => `${e(p.coin)} ${p.side === 'buy' ? 'long' : 'short'} ${signed(p.upnl ?? 0)}`).join(' · ')}`);
    else lines.push('No open trades.');
  }
  lines.push(`<b>Last 24 hours:</b> ${totalsWords(s.day ?? [])}`);
  if (s.health?.length) {
    const c = {};
    for (const h of s.health) c[h.status] = (c[h.status] ?? 0) + 1;
    const words = { ok: 'on track', early: 'too early to tell', quiet: 'quiet', behind: 'behind', stopped: 'may have stopped working' };
    lines.push(`<b>Deployed strategies:</b> ${s.health.length} — ${Object.entries(c).map(([k, v]) => `${v} ${words[k]}`).join(', ')}`);
  }
  const f = s.farm;
  if (f) lines.push(`<b>Edge finder:</b> ${f.running ? 'running' : f.wanted ? 'starting' : 'stopped'} · ${n(f.tried)} bots tried · ${f.survivors ?? 0} survivors${f.data ? ` · data ${f.data.ok ? 'up to date' : 'out of date'}${f.data.lastOkAt ? ` (${ago(s.now - f.data.lastOkAt)})` : ''}` : ''}`);
  const bots = (s.bots ?? []).filter((b) => b.running);
  if (bots.length) lines.push(`<b>Bots:</b> ${bots.map((b) => `${e(b.name)} (${b.mode === 'live' ? 'live' : 'paper'}${b.feed && b.feed !== 'open' ? `, feed ${e(b.feed)}` : ''})`).join(' · ')}`);
  if (sw?.coins?.length) lines.push(`<b>Prices:</b> ${sw.coins.map((c) => `${e(c.coin)} ${c.feed === 'open' ? '✓' : '✗'}`).join(' · ')}`);
  lines.push('');
  lines.push(`<i>Next check-in ${s.nextAt ? `${dayName(s.nextAt)} at ${clock(s.nextAt)}` : 'tomorrow'}. You will hear sooner if anything stops.</i>`);
  return lines.join('\n');
}

/** a warning, or the all-clear after one */
export function warningText(p, s) {
  return p.info ? `ℹ️ <b>Novus Ordo</b> · ${clock(s.now)}\n${p.text}` : `⚠️ <b>Novus Ordo needs a look</b> · ${clock(s.now)}\n${p.text}`;
}
export function clearedText(keys, s) {
  const what = { 'swarm-stopped': 'the crypto swarm is running again', 'farm-down': 'the edge finder is running again', 'farm-data': "the edge finder's candles are up to date again", screen: 'the window is responding again' };
  const words = keys.map((k) => what[k] ?? (k.startsWith('feed:') ? `prices for ${k.slice(5)} are back` : null)).filter(Boolean);
  return words.length ? `✅ <b>Back to normal</b> · ${clock(s.now)}\n${words.map((w) => `• ${w[0].toUpperCase()}${w.slice(1)}`).join('\n')}` : '';
}

/** the app was closed (or the computer off) and is back */
export function backText(offFrom, now) {
  return `▶️ <b>Novus Ordo is running again</b>\nIt was off from ${dayName(offFrom)} ${clock(offFrom)} to ${clock(now)} (${ago(now - offFrom).replace(' ago', '')}). Nothing traded in that time; open live trades kept their exchange stops. Start the swarm again if it does not start by itself.`;
}

/** a strategy's health got worse */
export function healthText(h) {
  return `${DOT[h.status]} <b>${e(h.name)}</b> — ${h.status === 'stopped' ? 'may have stopped working' : h.status === 'behind' ? 'is behind its test' : 'has gone quiet'}\n${e(h.words)}\n<i>Nothing has been changed: switching it off is your decision (DEPL).</i>`;
}

/**
 * The weekly report card.
 * @param s {{ now, from, rows, health, equityStart, equityNow, mode, costs, farm, farmWeek }}
 */
export function weeklyText(s) {
  const rows = s.rows ?? [];
  const L = [];
  L.push(`📊 <b>Novus Ordo — your week</b> · ${dayName(s.from)} to ${dayName(s.now)}`);
  for (const mode of ['live', 'paper']) {
    const m = rows.filter((r) => r.mode === mode);
    if (!m.length) continue;
    L.push(`<b>${mode === 'live' ? 'Live' : 'Paper'}:</b> ${totalsWords(m)}${totalsByQuote(m).USD ? ` after ${usd(totalsByQuote(m).USD.fees)} fees` : ''}`);
  }
  if (!rows.length) L.push('No trades closed this week.');
  if (Number.isFinite(s.equityStart) && Number.isFinite(s.equityNow) && s.equityStart > 0) L.push(`Swarm account (${s.mode === 'live' ? 'live' : 'paper'}): ${usd(s.equityStart)} → <b>${usd(s.equityNow)}</b> (${s.equityNow >= s.equityStart ? '+' : '−'}${Math.abs(((s.equityNow - s.equityStart) / s.equityStart) * 100).toFixed(1)}%)`);

  // the swarm's own agents: what they expected at entry against what they got
  const agents = {};
  for (const r of rows.filter((x) => x.source === 'swarm')) {
    let d = {};
    try {
      d = JSON.parse(r.detail ?? '{}');
    } catch {
      /* no detail */
    }
    const a = (agents[r.who ?? d.agent ?? '?'] ??= { n: 0, wins: 0, pnl: 0, r: 0, exp: 0, expN: 0 });
    a.n++;
    if (r.pnl > 0) a.wins++;
    a.pnl += r.pnl ?? 0;
    a.r += r.r ?? 0;
    if (Number.isFinite(d.odds?.expR)) {
      a.exp += d.odds.expR;
      a.expN++;
    }
  }
  if (Object.keys(agents).length) {
    L.push('');
    L.push('<b>Crypto swarm agents</b>');
    for (const [name, a] of Object.entries(agents).sort((x, y) => y[1].pnl - x[1].pnl)) {
      const got = a.r / a.n;
      const exp = a.expN ? a.exp / a.expN : null;
      const verdict = exp === null ? '' : got >= exp - 0.15 ? ' — as expected or better' : got >= 0 ? ' — below what it expected' : ' — losing, against an expected gain';
      L.push(`• ${e(AGENT[name] ?? name)}: ${a.n} trade${a.n === 1 ? '' : 's'}, ${a.wins} won, ${signed(a.pnl)}, ${signedR(got)} a trade${exp !== null ? ` (expected ${signedR(exp)})` : ''}${verdict}`);
    }
  }
  // deployed strategies: this week, and their health over everything since they were deployed
  if (s.health?.length) {
    L.push('');
    L.push('<b>Deployed strategies</b>');
    for (const h of s.health) {
      const wk = rows.filter((r) => r.strategy_id === h.id);
      L.push(`${DOT[h.status]} ${e(h.name)}${h.on ? '' : ' (switched off)'}: ${wk.length ? `${totalsWords(wk)} this week` : 'no trades this week'} — ${e(h.words)}`);
    }
  }
  for (const src of ['bot', 'lane']) {
    const m = rows.filter((r) => r.source === src);
    if (!m.length) continue;
    L.push('');
    L.push(`<b>${SOURCE[src]}</b>`);
    const by = {};
    for (const r of m) (by[r.who ?? '?'] ??= []).push(r);
    for (const [who, xs] of Object.entries(by)) L.push(`• ${e(who)}: ${totalsWords(xs)}`);
  }
  if (rows.length >= 2) {
    const best = rows.reduce((a, b) => (b.pnl > a.pnl ? b : a));
    const worst = rows.reduce((a, b) => (b.pnl < a.pnl ? b : a));
    const name = (r) => `${e(r.coin)} ${r.side === 'buy' ? 'long' : 'short'} (${e(AGENT[r.who] ?? r.who ?? '')}${r.mode === 'paper' ? ', paper' : ''})`;
    L.push('');
    L.push(`Best: ${name(best)} ${signed(best.pnl, best.quote)} · Worst: ${name(worst)} ${signed(worst.pnl, worst.quote)}`);
  }
  if (s.costs) L.push(`<b>Real costs:</b> ${e(s.costs.why)}`);
  const f = s.farm;
  if (f) {
    const tops = (f.tops ?? []).map((b) => (b.rows?.[0] ? `${e(b.name ?? b.id)}: ${e(b.rows[0].name)}` : null)).filter(Boolean);
    L.push(`<b>Edge finder:</b> ${s.farmWeek !== null && s.farmWeek !== undefined ? `${n(s.farmWeek)} bots tried this week` : `${n(f.tried)} bots tried`} · ${f.survivors ?? 0} survivors${tops.length ? `\nBest of each pace — ${tops.join(' · ')}` : ''}`);
  }
  L.push('');
  L.push('<i>Paper trades are practice on real prices; live trades are real money. Nothing here is a reason to change anything by itself — the decisions stay yours.</i>');
  return L.join('\n');
}

export { AGENT };
