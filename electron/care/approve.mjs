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
import { flowWords } from '../../src/lab/flowWords.ts';
import { bullets, card, date, drop, fine, head, note, num, pct, section, table } from '../../src/shared/tgcard.ts';

const DAY = 86_400_000;
export const OFFER_TTL = 3 * DAY;
const PACE = { scalp: 'Scalping', intraday: 'Intraday', swing: 'Swing', position: 'Position' };

const C = { scalp: '⚡', intraday: '🕐', swing: '🌊', position: '🏔' };

/** what a strategy is built from, as short lines (entries, conditions, exits) */
function builtFrom(flow) {
  const w = flowWords(flow);
  if (!w) return [];
  return bullets([
    `<b>Enters on:</b> ${e(w.entries.join(' + '))}${w.join ? ` <i>(${e(w.join)})</i>` : ''}`,
    w.filters.length ? `<b>Only when:</b> ${e(w.filters.join(' · '))}` : null,
    w.ai.length ? `<b>Forecast must agree:</b> ${e(w.ai.join(' · '))}` : null,
    `<b>Exits:</b> ${e(w.exits.join(' · '))}`,
    `<b>Trades:</b> ${e(w.sides)} · ${e(w.candles)}`,
  ]);
}

/** what deploying means, as a small table */
function deployRows(c) {
  if (!c) return null;
  return table([
    ...(Number.isFinite(c.perWeek) ? [['Trades a week', c.perWeek >= 1 ? `≈ ${c.perWeek.toFixed(1)}` : `1 per ${Math.max(1, Math.round(7 / Math.max(c.perWeek, 0.01)))} days`]] : []),
    ...(Number.isFinite(c.dd95) ? [['Bad run (1 in 20)', drop(c.dd95, 0)]] : []),
    ...(Number.isFinite(c.recoverDays) ? [['Longest dip', `${c.recoverDays} day${c.recoverDays === 1 ? '' : 's'}`]] : []),
    ['Starting size', '¼ (probation)'],
  ]);
}

/** the swarm's state, one line */
const swarmLine = (swarm) => (swarm ? (swarm.running ? `🟢 Crypto swarm running (${swarm.mode === 'live' ? '<b>LIVE</b>' : 'paper'}) — it trades what you deploy from the next signal.` : '🔴 Crypto swarm <b>stopped</b> — start it in Novus Ordo to trade what you deploy.') : null);

const AUTHORITY_FINE = '<b>Bad run:</b> the worst drop in 95 of 100 shuffled orders of its trades, at 1 % risk a trade. <b>Longest dip:</b> the longest it spent below its previous best on data it never saw. <b>Council decides:</b> the swarm’s council can block a signal it disagrees with. <b>Trade as tested:</b> only Guardian and Risk can stop a trade. Every deployment starts on probation at ¼ size and moves to full size once 12 live trades are on track. Sized up is the same edge scaled until its worst drop would be 15 % (at most 5×) — the swarm sizes each trade by its own risk rules, not at that multiple. Past results do not promise future ones.';

/** a team, for the phone */
export function teamText(t, { title, swarm } = {}) {
  const lev = Math.max(0, Math.min(5, 0.15 / Math.max(t.maxDD, 0.005)));
  const members = t.members.map((m) => {
    const f = m.fresh;
    const w = flowWords(m.flow);
    const c = m.card;
    return section(`${C[m.pace] ?? '•'} ${PACE[m.pace] ?? m.pace}`, [
      `<b>${e(w ? w.entries.join(' + ') : m.name.split(' · ')[0])}</b>`,
      w?.filters.length ? note(`only when: ${e(w.filters.join(' · '))}`) : null,
      table([
        ['Fresh data', f ? pct(f.ret) : 'none yet'],
        ...(f ? [['Fresh trades', String(f.trades)]] : []),
        ['Sharpe alone', num(m.sharpe)],
        ['Share of risk', `${Math.round(m.weight * 100)}%`],
        ...(c && Number.isFinite(c.perWeek) ? [['Trades a week', `≈ ${c.perWeek.toFixed(1)}`]] : []),
        ...(c && Number.isFinite(c.dd95) ? [['Bad run (1 in 20)', drop(c.dd95, 0)]] : []),
      ]),
    ]);
  });
  return card([
    head('🧩', title ?? 'A proven team is ready to deploy', 'One scalping, one intraday and one swing strategy — each a proven edge — sized to work as one.'),
    section(`📈 Together <i>(the ${Math.round(t.days)} days they all traded)</i>`, [
      table([
        ['A year (1×)', pct(t.ret, 0)],
        [`Sized up ${lev.toFixed(1)}×`, pct(t.ret * lev, 0)],
        ['Sharpe', num(t.sharpe)],
        ['Worst drop', drop(t.maxDD)],
      ]),
    ]),
    ...members,
    swarmLine(swarm),
    fine(AUTHORITY_FINE),
  ]);
}

/** a strategy proven on fresh data and over 200 % a year, for the phone */
export function starText(s, { title, swarm } = {}) {
  const o = s.oos ?? {};
  const z = sizedUp(o.cagr ?? 0, o.maxDD ?? 0);
  const f = s.forward;
  const pid = paceIdOf(s.style);
  const w = flowWords(s.flow);
  const c = s.confirm;
  const proof = [
    f ? `✅ <b>Proven on fresh data</b> — ${f.trades} trades, ${pct(f.ret)}, Sharpe ${num(f.sharpe)}${s.provenAt ? ` <i>(since ${date(s.provenAt)})</i>` : ''}` : null,
    s.sig ? '✅ <b>Significant</b> on the unseen data, allowing for every bot tried' : null,
    s.confirmed && c ? `✅ <b>Confirmed on new coins</b> — in profit on ${c.up} of ${c.coins.length} (${e(c.coins.join(', '))}), ${c.trades} trades` : null,
    !s.sig && !s.confirmed ? `⚠️ <b>Not yet significant</b>, nor confirmed on new coins${c ? ` (in profit on ${c.up} of ${c.coins.length})` : ''} — weigh that before deploying` : null,
  ];
  return card([
    head('⭐', title ?? 'Star strategy — proven, over 200 % a year', `<b>${e((w?.entries ?? [s.name.split(' · ')[0]]).join(' + '))}</b>\n${C[pid] ?? ''} ${PACE[pid] ?? pid} · ${e((s.coins ?? []).join(' · '))}`),
    section('🧩 How it trades', builtFrom(s.flow)),
    section('📈 On data it never saw', [
      table([
        ['A year (1×)', pct(o.cagr, 0)],
        [`Sized up ${z.lev.toFixed(1)}×`, pct(z.ret, 0)],
        ['Sharpe', num(o.sharpe)],
        ['Worst drop', drop(o.maxDD)],
        ['Trades', String(o.trades ?? 0)],
      ]),
    ]),
    section('🔍 Proof', proof),
    section('🧭 If you deploy it', deployRows(s.card)),
    swarmLine(swarm),
    fine(AUTHORITY_FINE),
  ]);
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
    if (!stars.length)
      return [
        {
          html: card([
            head('⭐', 'No star strategy yet', 'Nothing is both proven and over 200 % a year right now.'),
            section('What makes a star', bullets(['Proven on fresh data: 25+ trades, in profit, Sharpe 0.75+', 'Over 200 % a year on data it never saw — at 1× or sized up to a 15 % worst drop'])),
            note('One is sent here with its Deploy buttons the moment it qualifies.'),
          ]),
        },
      ];
    const swarm = this.swarmFn();
    return stars.map((s, i) => ({ html: starText(s, { title: `Star ${i + 1} of ${stars.length} — proven, over 200 % a year`, swarm: i === 0 ? swarm : null }), keyboard: this.makeStar(s) }));
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
    const rows = (this.waitFn() ?? []).map((w) => {
      const b = w.best;
      const name = `${C[w.pace] ?? '•'} <b>${PACE[w.pace] ?? w.pace}</b>`;
      if (w.proven) return `✅ ${name} — ${w.proven} proven edge${w.proven === 1 ? '' : 's'}`;
      if (!b) return `⏳ ${name} — nothing standing yet`;
      return `⏳ ${name} — closest: ${e(b.name.split(' · ')[0])}\n      <i>needs: ${e(b.missing.join('; '))}</i>`;
    });
    return card([
      head('🧩', 'No proven team yet', 'Nothing to deploy as a team for now.'),
      section('Where each pace stands', rows),
      section('What a team needs', bullets(['A scalping, an intraday and a swing strategy', 'Each proven on fresh data: 25+ trades, in profit, Sharpe 0.75+', 'Each significant on the unseen data, or confirmed on coins it never saw'])),
      note('Leave the edge finder running — the team is sent here the moment it is ready.'),
    ]);
  }

  /** /teams: the ready teams, each with its buttons — or what is still missing */
  pool() {
    const teams = (this.teamsFn() ?? []).filter((t) => t.ready);
    if (!teams.length) return [{ html: this.waitText() }];
    const swarm = this.swarmFn();
    return teams.map((t, i) => ({ html: teamText(t, { title: `Team ${i + 1} of ${teams.length} — every member a proven edge`, swarm: i === 0 ? swarm : null }), keyboard: this.make(t) }));
  }

  /** a button was tapped: deploy (or not), and say what was done */
  async tap(data) {
    const m = /^nd:([0-9a-f]{12}):([ctx])$/.exec(String(data));
    if (!m) return null;
    const [, token, what] = m;
    const all = this.offers();
    const o = all[token];
    const again = o?.kind === 'star' ? '/stars' : '/teams';
    if (!o) return card([head('⌛', 'That offer has lapsed'), note('Send /teams or /stars for what qualifies now.')]);
    if (o.done) return card([head('ℹ️', 'Already answered', e(o.done))]);
    if (this.now() - o.at > OFFER_TTL) return card([head('⌛', 'That offer has lapsed', 'It is more than three days old — the edge finder has moved on.'), note(`Send ${again} for what qualifies now.`)]);
    if (what === 'x') {
      o.done = 'not now';
      this.save(all);
      return card([head('✖️', 'Not deployed'), note(`Nothing changed. Send ${again} to see it again.`)]);
    }
    // checked again now: a team's members must still be proven edges in today's pool; a star must still be proven and over 200 %
    const star = o.kind === 'star';
    const standing = new Set(star ? (this.starsFn() ?? []).map((s) => s.id) : (this.teamsFn() ?? []).filter((t) => t.ready).flatMap((t) => t.members.map((mm) => mm.id)));
    const lapsed = o.members.filter((mm) => !standing.has(mm.id));
    if (lapsed.length) {
      o.done = 'refused: no longer proven';
      this.save(all);
      if (star) return card([head('⛔', 'Not deployed', `<b>${e(o.members[0].name.split(' · ')[0])}</b> is no longer proven and over 200 % a year on the latest candles.`), note('Send /stars for the ones that are.')]);
      return card([head('⛔', 'Not deployed', `${lapsed.map((mm) => `<b>${e(mm.name.split(' · ')[0])}</b>`).join(', ')} ${lapsed.length === 1 ? 'is' : 'are'} no longer a proven edge, so this team no longer qualifies.`), note('Send /teams for the teams that do.')]);
    }
    const authority = what === 't' ? 'tested' : 'council';
    const deployed = new Set(this.deployedFn());
    const left = o.members.filter((mm) => !deployed.has(mm.name));
    for (const mm of left) await this.deployFn(mm, authority);
    o.done = `deployed, ${authority === 'tested' ? 'trade as tested' : 'council decides'}`;
    this.save(all);
    const sw = this.swarmFn();
    return card([
      head('✅', 'Deployed to the crypto swarm', `Who decides: <b>${authority === 'tested' ? 'the strategy, as tested' : 'the council'}</b>`),
      section('What was deployed', o.members.map((mm) => `${C[mm.pace] ?? '•'} ${PACE[mm.pace] ?? mm.pace} — ${e(mm.name.split(' · ')[0])}${left.includes(mm) ? '' : ' <i>(already deployed)</i>'}`)),
      section('What happens now', bullets([sw?.running ? `The swarm is running (${sw.mode === 'live' ? '<b>LIVE</b>' : 'paper'}) — trades start from the next signal` : 'The swarm is <b>stopped</b> — start it in Novus Ordo for these to trade', 'Each starts on probation at ¼ size; full size after 12 live trades on track', 'Switch any of them off under DEPL'])),
    ]);
  }
}
