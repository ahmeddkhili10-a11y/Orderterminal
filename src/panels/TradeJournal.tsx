// JRNL — the trade journal: every finished trade (crypto swarm, deployed
// strategies, order-flow bots, the Luno lane) with why it was taken, how it went,
// your own notes on it, what trading really costs, and the exports: the whole
// journal as a spreadsheet, and a tax year's live trades in rands for SARS.
import { useEffect, useMemo, useState } from 'react';
import { desktop, type JournalRow, type MeasuredCosts, type TestCosts } from '../desktop/bridge';
import { Empty, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';

export type TradeJournalConfig = { mode: 'all' | 'live' | 'paper'; source: 'all' | JournalRow['source'] };
export const TRADE_JOURNAL_DEFAULTS: TradeJournalConfig = { mode: 'all', source: 'all' };

const SOURCE: Record<JournalRow['source'], string> = { swarm: 'Swarm', lab: 'Strategy', bot: 'Bot', lane: 'Luno lane' };
const AGENT: Record<string, string> = { auction: 'Auctioneer', trend: 'Trend', tape: 'Tape', crowd: 'Crowd', lab: 'Lab', scalper: 'Scalper' };

const money = (v: number, q: string | null) => `${v < 0 ? '−' : v > 0 ? '+' : ''}${String(q).toUpperCase() === 'ZAR' ? 'R' : '$'}${Math.abs(v).toFixed(2)}`;
const px = (p: number | null) => (p === null ? '—' : p.toLocaleString('en-US', { maximumFractionDigits: Math.abs(p) >= 1000 ? 1 : Math.abs(p) >= 10 ? 2 : 4 }));
const when = (t: number | null) => (t ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).replace(',', '') : '—');
const held = (r: JournalRow) => {
  if (!r.opened) return '';
  const m = Math.round((r.closed - r.opened) / 60_000);
  return m < 90 ? `${m} min` : m < 2880 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} days`;
};

export function TradeJournal({ config, setConfig: onConfig }: PanelProps<TradeJournalConfig>) {
  const [rows, setRows] = useState<JournalRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [costs, setCosts] = useState<{ measured: Record<string, MeasuredCosts>; forTests: TestCosts } | null>(null);
  const [years, setYears] = useState<number[]>([]);
  const [year, setYear] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const load = () => {
    if (!desktop?.journal) return;
    void desktop.journal
      .list({ limit: 3000, ...(config.mode !== 'all' ? { mode: config.mode } : {}), ...(config.source !== 'all' ? { source: config.source } : {}) })
      .then((r) => setRows(r.reverse()))
      .catch((e) => setMsg(String(e?.message ?? e)));
    void desktop.care.costs().then(setCosts).catch(() => undefined);
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.mode, config.source]);
  useEffect(() => {
    void desktop?.journal.taxYears().then((ys) => {
      setYears(ys);
      setYear((y) => y ?? ys[0] ?? null);
    });
  }, []);
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => !k || [r.coin, r.who, r.why, r.note, r.reason, r.venue].some((x) => String(x ?? '').toLowerCase().includes(k)));
  }, [rows, q]);
  const totals = useMemo(() => {
    const by: Record<string, { n: number; wins: number; pnl: number; fees: number }> = {};
    for (const r of shown) {
      const cur = String(r.quote).toUpperCase() === 'ZAR' ? 'ZAR' : 'USD';
      const t = (by[`${r.mode} ${cur}`] ??= { n: 0, wins: 0, pnl: 0, fees: 0 });
      t.n++;
      if (r.pnl > 0) t.wins++;
      t.pnl += r.pnl;
      t.fees += r.fees ?? 0;
    }
    return by;
  }, [shown]);

  if (!desktop?.journal) return <Empty>The trade journal is part of the desktop app.</Empty>;
  const exportAll = () =>
    void desktop!.journal
      .exportCsv()
      .then((p) => p && setMsg(`Saved ${p}`))
      .catch((e) => setMsg(String(e?.message ?? e)));
  const tax = () => {
    if (!year) return;
    setMsg('Getting the dollar’s rand rate for each day…');
    void desktop!.journal
      .tax(year)
      .then((r) => {
        if (!r) return setMsg('');
        const t = r.totals;
        setMsg(`Saved ${r.path} — ${r.trades} live trades · profits R${t.gainsZar.toFixed(2)} · losses R${t.lossesZar.toFixed(2)} · net R${t.netZar.toFixed(2)}${r.missingRates ? ` · ${r.missingRates} trades without a rand rate${r.fxError ? ` (${r.fxError})` : ''}` : ''}`);
      })
      .catch((e) => setMsg(String(e?.message ?? e)));
  };
  const note = (r: JournalRow, text: string) => void desktop!.journal.note(r.id, text).then(load);
  const ft = costs?.forTests;
  return (
    <div className="panel" data-journal>
      <Toolbar>
        <Select value={config.mode} options={[{ value: 'all', label: 'Live and paper' }, { value: 'live', label: 'Live only' }, { value: 'paper', label: 'Paper only' }]} onChange={(mode) => onConfig({ mode })} width={120} />
        <Select value={config.source} options={[{ value: 'all', label: 'Everything' }, { value: 'swarm', label: 'Swarm agents' }, { value: 'lab', label: 'Deployed strategies' }, { value: 'bot', label: 'Order-flow bots' }, { value: 'lane', label: 'Luno lane' }]} onChange={(source) => onConfig({ source })} width={140} />
        <input className="ctl" placeholder="Search coin, reason, note…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 170 }} />
        <Spacer />
        <button className="chip" onClick={exportAll} title="Every trade, paper and live, as a spreadsheet">
          ⇩ Journal (CSV)
        </button>
        <Select value={String(year ?? '')} options={years.map((y) => ({ value: String(y), label: `${y - 1}/${String(y).slice(2)} tax year` }))} onChange={(v) => setYear(Number(v))} width={130} title="South Africa's tax year runs 1 March to the end of February" />
        <button className="chip primary-chip" onClick={tax} disabled={!year} data-tax title="The tax year's live trades, with profit, loss and fees in rands at each day's dollar rate, and a summary">
          ⇩ Tax export (ZAR)
        </button>
      </Toolbar>
      <div className="journal-head">
        {Object.entries(totals).map(([k, t]) => (
          <span key={k} className="journal-tot">
            <b>{k.startsWith('live') ? 'Live' : 'Paper'}</b> {t.n} trades · {t.wins} won ({t.n ? Math.round((t.wins / t.n) * 100) : 0}%) · <span className={t.pnl >= 0 ? 'up' : 'down'}>{money(t.pnl, k.endsWith('ZAR') ? 'ZAR' : 'USD')}</span> after {money(t.fees, k.endsWith('ZAR') ? 'ZAR' : 'USD').replace(/^[+−]/, '')} fees
          </span>
        ))}
        {ft && (
          <span className="journal-tot" data-costs title="The Strategy Lab, the bot builder and the edge finder test with these costs">
            <b>Real costs</b> {ft.why}
            {ft.measured && ` (tests use ${ft.feeBps} bps fees + ${ft.slipBps} bps slippage a fill)`}
          </span>
        )}
      </div>
      {msg && <div className="journal-msg">{msg}</div>}
      <div className="pro-scroll">
        {rows === null ? (
          <Empty>Loading…</Empty>
        ) : !shown.length ? (
          <Empty>No finished trades yet. Every trade the swarm, a deployed strategy, a bot or the Luno lane closes is kept here for good.</Empty>
        ) : (
          <table className="pro-table journal-table">
            <colgroup>
              <col style={{ width: 112 }} />
              <col style={{ width: '24%' }} />
              <col style={{ width: 92 }} />
              <col style={{ width: 118 }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th className="l">CLOSED</th>
                <th className="l">WHO</th>
                <th className="l">TRADE</th>
                <th>RESULT</th>
                <th className="l">WHY · HOW IT CLOSED</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <JournalLine key={r.id} r={r} open={open === r.id} onOpen={() => setOpen(open === r.id ? null : r.id)} onNote={(text) => note(r, text)} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function JournalLine({ r, open, onOpen, onNote }: { r: JournalRow; open: boolean; onOpen: () => void; onNote: (text: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  let d: { summary?: string; votes?: { bot: string; stance: string; why: string }[]; odds?: { pWin?: number; expR?: number }; mgmt?: string[] } = {};
  try {
    d = JSON.parse(r.detail ?? '{}');
  } catch {
    /* no detail */
  }
  const slip = (ask: number | null, fill: number | null, leg: 'entry' | 'exit') => {
    if (!r.fills_real || !ask || !fill) return null;
    const buy = leg === 'entry' ? r.side === 'buy' : r.side !== 'buy';
    return (((buy ? fill - ask : ask - fill) / ask) * 1e4).toFixed(1);
  };
  return (
    <>
      <tr className={`clickable${open ? ' sel' : ''}`} onClick={onOpen} data-row={r.id}>
        <td className="l mono journal-cut">{when(r.closed)}</td>
        <td className="l journal-cut" title={`${r.who ?? ''} · ${SOURCE[r.source]}${r.mode === 'paper' ? ' · paper' : ' · live'}`}>
          {r.who ? (AGENT[r.who] ?? r.who) : '—'} <span className="muted">· {SOURCE[r.source]}{r.mode === 'paper' ? ' · paper' : ''}</span>
        </td>
        <td className="l">
          {r.coin} <span className={r.side === 'buy' ? 'up' : 'down'}>{r.side === 'buy' ? 'long' : 'short'}</span>
        </td>
        <td className={`mono ${r.pnl >= 0 ? 'up' : 'down'}`}>
          {money(r.pnl, r.quote)}
          <span className="muted"> {r.r === null ? '' : `${r.r >= 0 ? '+' : ''}${r.r.toFixed(2)}R`}</span>
        </td>
        <td className="l journal-cut muted" title={r.why ?? ''}>
          {r.note ? <span title={r.note}>📝 </span> : null}
          {r.reason ? <b className="journal-reason">{r.reason}</b> : null} {r.why ?? '—'}
        </td>
      </tr>
      {open && (
        <tr className="journal-detail">
          <td colSpan={5}>
            <div className="journal-detail-grid">
              <div>
                <b>Why it was taken</b>
                <p>{r.why ?? '—'}</p>
                {d.summary && <p className="muted">{d.summary}</p>}
                {d.votes?.length ? (
                  <ul>
                    {d.votes.map((v, i) => (
                      <li key={i}>
                        {v.stance === 'for' ? '✓' : v.stance === 'against' ? '✗' : v.stance === 'veto' ? '⛔' : '–'} <i>{AGENT[v.bot] ?? v.bot}:</i> {v.why}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div>
                <b>How it went</b>
                <p>
                  {r.side === 'buy' ? 'Long' : 'Short'} from {px(r.entry)} to {px(r.exit)}. Opened {when(r.opened)}, held {held(r)}, closed by {r.reason ?? '—'}. {r.qty ?? '—'} {r.coin} on {r.venue ?? '—'}; fees {money(r.fees, r.quote).replace(/^[+−]/, '')}
                  {r.fee_real ? ' (the exchange’s own)' : ' (estimated)'}.
                </p>
                {d.odds && Number.isFinite(d.odds.expR) && (
                  <p>
                    It expected {d.odds.expR! >= 0 ? '+' : ''}
                    {d.odds.expR!.toFixed(2)}R{Number.isFinite(d.odds.pWin) ? ` with a ${Math.round(d.odds.pWin! * 100)}% chance to win` : ''}; it made {r.r === null ? '—' : `${r.r >= 0 ? '+' : ''}${r.r.toFixed(2)}R`}.
                  </p>
                )}
                {d.mgmt?.length ? (
                  <ul>
                    {d.mgmt.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                ) : null}
                {r.fills_real ? (
                  <p className="muted">
                    Slippage: entry {slip(r.ask_entry, r.entry, 'entry')} bps, exit {slip(r.ask_exit, r.exit, 'exit')} bps against the decision price.
                  </p>
                ) : null}
              </div>
              <div>
                <b>Your note</b>
                {draft === null ? (
                  <>
                    <p>{r.note ?? <span className="muted">none yet</span>}</p>
                    <button className="chip" onClick={() => setDraft(r.note ?? '')}>
                      ✎ {r.note ? 'Edit note' : 'Add a note'}
                    </button>
                  </>
                ) : (
                  <>
                    <textarea className="ctl journal-note" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} placeholder="What you think of this trade — kept with it, and in the exports" />
                    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                      <button
                        className="chip primary-chip"
                        onClick={() => {
                          onNote(draft);
                          setDraft(null);
                        }}
                      >
                        Save note
                      </button>
                      <button className="chip" onClick={() => setDraft(null)}>
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
