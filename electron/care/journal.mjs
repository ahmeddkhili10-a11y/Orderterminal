// The trade journal: every finished trade — the crypto swarm's agents, the
// strategies deployed into it, the order-flow bots and the Luno lane — in one
// permanent table, with why it was taken, how it went, and what it really cost.
// The swarm keeps only its last few hundred positions; this keeps them all.
// The weekly report, the strategy health checks, the real-cost measurements and
// the tax export all read from here.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS journal (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  who TEXT,
  strategy_id TEXT,
  mode TEXT NOT NULL,
  venue TEXT,
  symbol TEXT,
  coin TEXT,
  quote TEXT,
  side TEXT,
  qty REAL,
  entry REAL,
  exit REAL,
  ask_entry REAL,
  ask_exit REAL,
  fees REAL,
  fee_real INTEGER NOT NULL DEFAULT 0,
  fills_real INTEGER NOT NULL DEFAULT 0,
  pnl REAL,
  r REAL,
  risk_usd REAL,
  opened INTEGER,
  closed INTEGER NOT NULL,
  reason TEXT,
  why TEXT,
  detail TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS journal_closed ON journal(closed);
CREATE INDEX IF NOT EXISTS journal_strategy ON journal(strategy_id, closed);
`;

const COLS = ['id', 'source', 'who', 'strategy_id', 'mode', 'venue', 'symbol', 'coin', 'quote', 'side', 'qty', 'entry', 'exit', 'ask_entry', 'ask_exit', 'fees', 'fee_real', 'fills_real', 'pnl', 'r', 'risk_usd', 'opened', 'closed', 'reason', 'why', 'detail'];
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** the coin and the currency it is priced in, from a market symbol: BTC/USDC:USDC → BTC, USDC; BTC/ZAR → BTC, ZAR */
export function splitSymbol(symbol) {
  const s = String(symbol ?? '');
  const [base, rest = ''] = s.split('/');
  const quote = rest.split(':')[0] || 'USD';
  return { coin: base || s, quote: quote.toUpperCase() };
}

/** dollar-like currencies count as US dollars (for the rand conversion) */
export const isUsdLike = (q) => /^(USD|USDT|USDC|BUSD|FDUSD|DAI|TUSD|USDE)$/i.test(String(q ?? ''));

/** A row for a crypto swarm position that has just closed (agents, and deployed Lab strategies). */
export function fromSwarm(p, o = {}) {
  const { coin, quote } = splitSymbol(p.symbol ?? `${p.coin}/USDC:USDC`);
  const lab = !!p.labId;
  return {
    id: `swarm:${p.id}`,
    source: lab ? 'lab' : 'swarm',
    who: lab ? (o.labName ?? 'Lab strategy') : (o.agentName ?? p.agentName ?? p.agent),
    strategy_id: p.labId ?? null,
    mode: p.mode === 'live' ? 'live' : 'paper',
    venue: p.mode === 'live' ? (o.venue ?? 'hyperliquid') : 'paper',
    symbol: p.symbol ?? null,
    coin: p.coin ?? coin,
    quote,
    side: p.side,
    qty: num(p.qty),
    entry: num(p.entry),
    exit: num(p.exit),
    ask_entry: num(p.askEntry),
    ask_exit: num(p.askExit),
    fees: num(p.fees) ?? 0,
    fee_real: p.feeReal ? 1 : 0,
    fills_real: p.fillsReal ? 1 : 0,
    pnl: num(p.pnl) ?? 0,
    r: num(p.r),
    risk_usd: num(p.riskUsd),
    opened: num(p.openedAt),
    closed: num(p.closedAt) ?? Date.now(),
    reason: p.reason ?? null,
    why: [p.setup, p.why].filter(Boolean).join(' — ') || null,
    detail: JSON.stringify({ summary: p.summary ?? null, votes: (p.votes ?? []).map((v) => ({ bot: v.bot, stance: v.stance, why: v.why })), odds: p.odds ?? null, mgmt: (p.mgmt ?? []).map((m) => m.text), stop: p.stop0 ?? null, target: p.target0 ?? null, agent: p.agent }),
  };
}

/** A row for an order-flow bot's (or the Luno lane's) closed trade. */
export function fromBot(t, b) {
  const { coin, quote } = splitSymbol(b.symbol);
  return {
    id: `bot:${b.id}:${t.opened ?? 0}:${t.closed}`,
    source: b.lane ? 'lane' : 'bot',
    who: b.name ?? b.id,
    strategy_id: null,
    mode: b.mode === 'live' ? 'live' : 'paper',
    venue: b.mode === 'live' ? (b.exchangeId ?? null) : 'paper',
    symbol: b.symbol ?? null,
    coin,
    quote,
    side: t.side,
    qty: num(t.qty),
    entry: num(t.entry),
    exit: num(t.exit),
    ask_entry: num(t.askEntry),
    ask_exit: num(t.askExit),
    fees: num(t.fees) ?? 0,
    fee_real: 0,
    fills_real: t.fillsReal ? 1 : 0,
    pnl: num(t.pnl) ?? 0,
    r: t.risk > 0 && t.qty > 0 ? t.pnl / (t.risk * t.qty) : null,
    risk_usd: t.risk > 0 && t.qty > 0 ? t.risk * t.qty : null,
    opened: num(t.opened),
    closed: num(t.closed) ?? Date.now(),
    reason: t.reason ?? null,
    why: [t.setup, t.why].filter(Boolean).join(' — ') || null,
    detail: JSON.stringify({ stop: t.stop0 ?? null, target: t.target0 ?? null }),
  };
}

export class TradeJournal {
  /** @param sql a node:sqlite DatabaseSync */
  constructor(sql) {
    this.sql = sql;
    sql.exec(SCHEMA);
    const set = COLS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
    this.put = sql.prepare(`INSERT INTO journal (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')}) ON CONFLICT(id) DO UPDATE SET ${set}`);
    this.listeners = new Set();
  }

  /** keep one finished trade (the same id again updates it; a note written on it stays) */
  record(row) {
    if (!row?.id || !Number.isFinite(row.closed)) return;
    this.put.run(...COLS.map((c) => (row[c] === undefined ? null : row[c])));
    for (const f of this.listeners) {
      try {
        f(row);
      } catch {
        /* a listener's problem stays its own */
      }
    }
  }

  onRecord(f) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** trades closed between from and to (newest last), optionally one mode, source or strategy */
  list({ from = 0, to = 8.64e15, mode = null, source = null, strategy = null, limit = 20_000 } = {}) {
    const where = ['closed >= ?', 'closed <= ?'];
    const args = [from, to];
    if (mode) {
      where.push('mode = ?');
      args.push(mode);
    }
    if (source) {
      where.push('source = ?');
      args.push(source);
    }
    if (strategy) {
      where.push('strategy_id = ?');
      args.push(strategy);
    }
    const rows = this.sql.prepare(`SELECT * FROM (SELECT * FROM journal WHERE ${where.join(' AND ')} ORDER BY closed DESC LIMIT ?) ORDER BY closed`).all(...args, limit);
    return rows.map((r) => ({ ...r }));
  }

  count() {
    return Number(this.sql.prepare('SELECT COUNT(*) AS n FROM journal').get().n);
  }

  /** your own words on a trade */
  setNote(id, note) {
    this.sql.prepare('UPDATE journal SET note = ? WHERE id = ?').run(String(note ?? '').slice(0, 4000) || null, String(id));
  }

  /**
   * The trades from before the journal existed: the swarm's kept positions and
   * the bots' trade log. Run once; the same trade is never kept twice.
   */
  importOld({ positions = [], amtRows = [], labName = () => null, venueOf = () => null, botOf = () => null }) {
    const ins = this.sql.prepare(`INSERT OR IGNORE INTO journal (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`);
    let n = 0;
    for (const p of positions) {
      if (!p.closedAt) continue;
      const row = fromSwarm(p, { labName: p.labId ? labName(p.labId) : null, venue: venueOf(p) });
      n += Number(ins.run(...COLS.map((c) => (row[c] === undefined ? null : row[c]))).changes);
    }
    for (const a of amtRows) {
      const b = botOf(a) ?? {};
      const row = fromBot({ side: a.side, setup: a.setup, entry: a.entry, exit: a.exit, qty: a.qty, pnl: a.pnl, fees: a.fees, opened: a.opened, closed: a.closed, reason: a.reason }, { id: a.bot_id, name: a.bot_name, symbol: a.symbol, mode: a.mode, exchangeId: b.exchangeId ?? null, lane: b.lane ?? /\/ZAR$/i.test(String(a.symbol ?? '')) });
      n += Number(ins.run(...COLS.map((c) => (row[c] === undefined ? null : row[c]))).changes);
    }
    return n;
  }

  /** everything, for a backup */
  dump() {
    return this.sql.prepare('SELECT * FROM journal ORDER BY closed').all().map((r) => ({ ...r }));
  }

  /** put a backup's trades back (the ones already here are kept, with their notes) */
  restore(rows) {
    const cols = [...COLS, 'note'];
    const ins = this.sql.prepare(`INSERT OR IGNORE INTO journal (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    let n = 0;
    for (const r of rows ?? []) if (r?.id && Number.isFinite(r.closed)) n += Number(ins.run(...cols.map((c) => (r[c] === undefined ? null : r[c]))).changes);
    return n;
  }
}
