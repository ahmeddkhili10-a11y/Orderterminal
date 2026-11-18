// Deploying from your phone. When the edge finder's team pool has a team that
// is READY — every member a proven edge (significant on the unseen data AND
// proven on fresh data), and the team strong together —
// it is sent to your Telegram chat with its numbers and three buttons:
//
//   ✅ Deploy · council decides     ✅ Deploy · trade as tested     ✖ Not now
//
// Nothing is deployed until you tap: the decision stays yours. /teams in the
// chat lists the whole pool, each team with the same buttons. Taps are only
// taken from your own chat, each offer works once, and an offer lapses after
// three days (the pool moves on). At the moment of the tap the team is checked
// again: if any member is no longer a proven edge, nothing is deployed. Teams
// that are not ready are never offered with buttons.
import { randomBytes } from 'node:crypto';
import { escapeHtml as e } from '../../src/shared/telegram.ts';
import { paceIdOf, sizedUp } from '../../src/lab/farm.ts';

const DAY = 86_400_000;
export const OFFER_TTL = 3 * DAY;
const PACE = { scalp: 'Scalping', intraday: 'Intraday', swing: 'Swing', position: 'Position' };

const pct = (x, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs((x ?? 0) * 100).toFixed(d)}%`;
const num = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');

/** a team in words, for the phone */
export function teamText(t, { title, swarm } = {}) {
  const L = [title ?? `🧩 <b>A proven team is ready to deploy</b>`];
  L.push(`Together: Sharpe <b>${num(t.sharpe)}</b> · ${pct(t.ret, 0)} a year at 1× · worst drop ${pct(-t.maxDD)} · read on ${Math.round(t.days)} days`);
  // the same edge sized up to a 15 % worst drop (at most 5×): what the steady ones are really worth — losses grow by the same multiple
  const lev = Math.max(0, Math.min(5, 0.15 / Math.max(t.maxDD, 0.005)));
  L.push(`Sized up to a ${pct(-t.maxDD * lev, 0)} worst drop (${lev.toFixed(1)}×): <b>${pct(t.ret * lev, 0)} a year</b>`);
  for (const m of t.members) {
    const f = m.fresh;
    L.push(`• <b>${PACE[m.pace] ?? m.pace}</b> — ${e(m.name)}\n   fresh data ${f ? `${pct(f.ret)} over ${f.trades} trades (worst drop ${pct(-f.maxDD)})` : 'none yet'} · Sharpe ${num(m.sharpe)} alone · ${Math.round(m.weight * 100)}% of the risk`);
  }
  if (swarm) L.push(`The crypto swarm is ${swarm.running ? `running (${swarm.mode === 'live' ? '<b>LIVE</b>' : 'paper'})` : '<b>stopped</b> — start it in Novus Ordo to trade what you deploy'}.`);
  L.push('<i>Council decides: the council can block its signals. Trade as tested: only Guardian and Risk can stop a trade. Past results do not promise future ones.</i>');
  return L.join('\n');
}

/** a strategy proven on fresh data and over 200 % a year, in words, for the phone */
export function starText(s, { title, swarm } = {}) {
  const o = s.oos ?? {};
  const z = sizedUp(o.cagr ?? 0, o.maxDD ?? 0);
  const f = s.forward;
  const pace = PACE[paceIdOf(s.style)] ?? paceIdOf(s.style);
  const L = [title ?? '⭐ <b>A proven strategy over 200 % a year</b>'];
  L.push(`<b>${e(s.name)}</b> · ${pace} · ${e((s.coins ?? []).join(' '))}`);
  L.push(`On data it never saw: <b>${pct(o.cagr, 0)} a year</b> at 1× · Sharpe ${num(o.sharpe)} · worst drop ${pct(-(o.maxDD ?? 0))} · ${o.trades ?? 0} trades`);
  L.push(`Sized up to a ${pct(-z.maxDD, 0)} worst drop (${z.lev.toFixed(1)}×): <b>${pct(z.ret, 0)} a year</b> — losses grow by the same multiple`);
  if (f) L.push(`Fresh data (since it was found): ${pct(f.ret)} over ${f.trades} trades, Sharpe ${num(f.sharpe)}, worst drop ${pct(-f.maxDD)}${s.provenAt ? ` · proven since ${new Date(s.provenAt).toISOString().slice(0, 10)}` : ''}`);
  L.push(s.sig ? '✓ Also significant on the unseen data after allowing for every bot tried.' : '⚠ Proven on fresh data, but not significant on the unseen data once every bot tried is allowed for — weigh that before deploying.');
  if (swarm) L.push(`The crypto swarm is ${swarm.running ? `running (${swarm.mode === 'live' ? '<b>LIVE</b>' : 'paper'})` : '<b>stopped</b> — start it in Novus Ordo to trade what you deploy'}.`);
  L.push('<i>Council decides: the council can block its signals. Trade as tested: only Guardian and Risk can stop a trade. The swarm sizes each trade by its own risk rules, not at the sized-up multiple. Past results do not promise future ones.</i>');
  return L.join('\n');
}

const memberOf = (m) => ({ id: m.id, name: m.name, pace: m.pace ?? paceIdOf(m.style), flow: m.flow, tfH: m.tfH, coins: m.coins, oos: m.oos, dsr: m.dsr, stage: m.stage });

export class Approvals {
  /**
   * @param o {{ db: { get(k), set(k, v) }, teams: () => any[], deployed: () => string[],
   *   deploy: (member: any, authority: 'council'|'tested') => Promise<unknown>,
   *   swarm?: () => ({ running: boolean, mode: string } | null), now?: () => number }}
   */
  constructor(o) {
    this.db = o.db;
    this.teamsFn = o.teams;
    this.deployedFn = o.deployed;
    this.deployFn = o.deploy;
    this.swarmFn = o.swarm ?? (() => null);
    /** while no team is ready: each pace's proven edges and its closest candidate */
    this.waitFn = o.waiting ?? (() => []);
    /** proven strategies over 200 % a year: each offered on its own */
    this.starsFn = o.stars ?? (() => []);
    this.now = o.now ?? Date.now;
  }

  offers() {
    const all = this.db.get('approve:offers') ?? {};
    // lapsed offers are cleared away after a week
    for (const [k, v] of Object.entries(all)) if (this.now() - v.at > 7 * DAY) delete all[k];
    return all;
  }

  save(all) {
    this.db.set('approve:offers', all);
  }

  /** an offer for a team: its buttons */
  make(team) {
    const all = this.offers();
    const token = randomBytes(6).toString('hex');
    all[token] = { kind: 'team', key: team.key, at: this.now(), members: team.members.map(memberOf), stats: { sharpe: team.sharpe, ret: team.ret, maxDD: team.maxDD } };
    this.save(all);
    return this.buttons(token);
  }

  /** an offer for one strategy (a star): the same three buttons */
  makeStar(s) {
    const all = this.offers();
    const token = randomBytes(6).toString('hex');
    all[token] = { kind: 'star', key: s.id, at: this.now(), members: [{ ...memberOf(s), via: 'star' }] };
    this.save(all);
    return this.buttons(token);
  }

  buttons(token) {
    return [
      [{ text: '✅ Deploy · council decides', callback_data: `nd:${token}:c` }],
      [{ text: '✅ Deploy · trade as tested', callback_data: `nd:${token}:t` }],
      [{ text: '✖ Not now', callback_data: `nd:${token}:x` }],
    ];
  }

  /** the ready teams not offered yet (one team is offered once a week at most; three offers a day at most) */
  due() {
    const sent = this.db.get('approve:sent') ?? {};
    const now = this.now();
    const today = Object.values(sent).filter((t) => now - t < DAY).length;
    if (today >= 3) return [];
    const deployed = new Set(this.deployedFn());
    return (this.teamsFn() ?? []).filter((t) => t.ready && !(sent[t.key] && now - sent[t.key] < 7 * DAY) && t.members.some((m) => !deployed.has(m.name))).slice(0, 3 - today);
  }

  /** the stars not offered yet (each once a week at most, three a day at most, never one already deployed) */
  starsDue() {
    const sent = this.db.get('approve:starSent') ?? {};
    const now = this.now();
    const today = Object.values(sent).filter((t) => now - t < DAY).length;
    if (today >= 3) return [];
    const deployed = new Set(this.deployedFn());
    return (this.starsFn() ?? []).filter((s) => !(sent[s.id] && now - sent[s.id] < 7 * DAY) && !deployed.has(s.name)).slice(0, 3 - today);
  }

  /** /stars: every star, each with its buttons — or what is missing */
  starPool() {
    const stars = this.starsFn() ?? [];
    if (!stars.length) return [{ html: '⭐ <b>No strategy is over 200 % a year and proven yet.</b>\nOne is offered here, with Deploy buttons, the moment one is: proven on fresh data (25+ trades, in profit, Sharpe 0.75+) and over 200 % a year on data it never saw — at 1× or sized up to a 15 % worst drop.' }];
    const swarm = this.swarmFn();
    return stars.map((s, i) => ({ html: starText(s, { title: `⭐ <b>Star ${i + 1} of ${stars.length}</b> · proven, over 200 % a year`, swarm: i === 0 ? swarm : null }), keyboard: this.makeStar(s) }));
  }

  /** the messages to send now: each ready team with its buttons, and each new star */
  check() {
    const out = [];
    const starSent = this.db.get('approve:starSent') ?? {};
    for (const s of this.starsDue()) {
      out.push({ html: starText(s, { swarm: this.swarmFn() }), keyboard: this.makeStar(s) });
      starSent[s.id] = this.now();
    }
    if (out.length) this.db.set('approve:starSent', starSent);
    const sent = this.db.get('approve:sent') ?? {};
    for (const t of this.due()) {
      out.push({ html: teamText(t, { swarm: this.swarmFn() }), keyboard: this.make(t) });
      sent[t.key] = this.now();
    }
    if (out.length) this.db.set('approve:sent', sent);
    return out;
  }

  /** what is still missing before a team can be offered */
  waitText() {
    const L = ['🧩 <b>No proven team yet — nothing to deploy.</b>', 'A team is offered only when its scalping, intraday and swing strategies are each a proven edge: significant on the unseen data, AND 25+ trades on fresh data, in profit, Sharpe 0.75+.'];
    for (const w of this.waitFn() ?? []) {
      const b = w.best;
      L.push(`• <b>${PACE[w.pace] ?? w.pace}</b>: ${w.proven ? `${w.proven} proven edge${w.proven === 1 ? '' : 's'} ✓` : 'none proven yet'}${!w.proven && b ? ` — closest: ${e(b.name.split(' · ')[0])} (${b.missing.join('; ')})` : !w.proven ? ' — nothing standing yet' : ''}`);
    }
    L.push('<i>Leave the edge finder running: you will get a message the moment a team is ready.</i>');
    return L.join('\n');
  }

  /** /teams: the ready teams, each with its buttons — or what is still missing */
  pool() {
    const teams = (this.teamsFn() ?? []).filter((t) => t.ready);
    if (!teams.length) return [{ html: this.waitText() }];
    const swarm = this.swarmFn();
    return teams.map((t, i) => ({ html: teamText(t, { title: `🧩 <b>Team ${i + 1} of ${teams.length}</b> · ✓ every member a proven edge`, swarm: i === 0 ? swarm : null }), keyboard: this.make(t) }));
  }

  /** a button was tapped: deploy (or not), and say what was done */
  async tap(data) {
    const m = /^nd:([0-9a-f]{12}):([ctx])$/.exec(String(data));
    if (!m) return null;
    const [, token, what] = m;
    const all = this.offers();
    const o = all[token];
    if (!o) return 'That offer has lapsed. Send /teams for the current pool.';
    if (o.done) return `That offer was already answered (${o.done}).`;
    if (this.now() - o.at > OFFER_TTL) return 'That offer is more than three days old and has lapsed — the pool has moved on. Send /teams for the current pool.';
    if (what === 'x') {
      o.done = 'not now';
      this.save(all);
      return 'OK — not deployed. Send /teams to see the pool again.';
    }
    // checked again now: a team's members must still be proven edges in today's pool; a star must still be proven and over 200 %
    const star = o.kind === 'star';
    const standing = new Set(star ? (this.starsFn() ?? []).map((s) => s.id) : (this.teamsFn() ?? []).filter((t) => t.ready).flatMap((t) => t.members.map((mm) => mm.id)));
    const lapsed = o.members.filter((mm) => !standing.has(mm.id));
    if (lapsed.length) {
      o.done = 'refused: no longer proven';
      this.save(all);
      if (star) return `⛔ <b>Not deployed.</b> ${e(o.members[0].name.split(' · ')[0])} is no longer proven and over 200 % a year on the latest candles. Send /stars for the ones that are.`;
      return `⛔ <b>Not deployed.</b> ${lapsed.map((mm) => e(mm.name.split(' · ')[0])).join(', ')} ${lapsed.length === 1 ? 'is' : 'are'} no longer a proven edge in the pool, so this team no longer qualifies. Send /teams for the teams that do.`;
    }
    const authority = what === 't' ? 'tested' : 'council';
    const deployed = new Set(this.deployedFn());
    const left = o.members.filter((mm) => !deployed.has(mm.name));
    for (const mm of left) await this.deployFn(mm, authority);
    o.done = `deployed, ${authority === 'tested' ? 'trade as tested' : 'council decides'}`;
    this.save(all);
    const sw = this.swarmFn();
    const names = o.members.map((mm) => `• ${PACE[mm.pace] ?? mm.pace} — ${e(mm.name)}${left.includes(mm) ? '' : ' (already deployed)'}`).join('\n');
    return `✅ <b>Deployed to the crypto swarm</b> (${authority === 'tested' ? 'trade as tested' : 'council decides'})\n${names}\n${sw?.running ? `The swarm is running (${sw.mode === 'live' ? 'LIVE' : 'paper'}): they trade from their next signal.` : 'The swarm is <b>stopped</b>: start it in Novus Ordo for them to trade.'}\nSwitch any of them off under DEPL.`;
  }
}
