// The optimizer under a bot's test result: what the test shows, in words; how
// regular the result was, period by period; and the one-step changes worth
// making — each measured on the training years only, so the unseen data stays
// unseen until a change is applied and tested.
import { useMemo, useState } from 'react';
import { desktop } from '../desktop/bridge';
import { advise, EXIT_WORDS, GOALS, rankVariants, specsOf, specVariants, triesWords, variantsOf, type Goal, type SpecVariant, type Variant } from '../lab/advisor';
import type { StrategySpec } from '../lab/backtest';
import { buildSpec, type Flow } from '../lab/flow';
import { specNeeds } from '../lab/live';
import type { VariantScore } from '../lab/research';
import { deflatedSharpe } from '../lab/stats';
import { useLab, type LabTest } from '../lab/store';
import { Bars } from './charts';

const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const KIND: Record<Variant['kind'], string> = { stop: 'stop', exit: 'exit', hold: 'holding time', side: 'direction', filter: 'market filter', opinion: 'second opinion', size: 'sizing', pace: 'pace', setting: 'setting', join: 'joining', coins: 'coins' };

export function Optimizer({ flow, test, tries, busy, onApply }: { flow: Flow; test: LabTest; tries: number; busy: boolean; onApply: (flow: Flow, label: string) => void }) {
  const status = useLab((s) => s.status);
  const [goal, setGoal] = useState<Goal>('sharpe');
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState('');
  const [found, setFound] = useState<{ variants: Variant[]; scores: VariantScore[] } | null>(null);
  const advice = useMemo(() => advise(test.diag, test.periods, flow), [test, flow]);
  const result = useMemo(() => (found ? rankVariants(found.variants, found.scores, goal) : null), [found, goal]);
  // the kinds of change the diagnosis points at come first among equals
  const wanted = useMemo(() => new Set(advice.flatMap((a) => a.kinds)), [advice]);
  const rows = useMemo(() => (result ? [...result.ranked].sort((a, b) => Number(b.consistent) - Number(a.consistent) || Number(wanted.has(b.variant.kind)) - Number(wanted.has(a.variant.kind)) || b.gain - a.gain).slice(0, 8) : []), [result, wanted]);
  const find = () => {
    if (!desktop?.lab?.optimize) return;
    const variants = variantsOf(flow, test.diag);
    const built = buildSpec(flow);
    const specs = specsOf(flow, variants);
    setRunning(true);
    setErr('');
    desktop.lab
      .optimize(specs, { timeframe: built.timeframe, years: built.years, coins: built.coins, funding: specs.some((s) => specNeeds(s.spec).funding) })
      .then((scores) => setFound({ variants, scores }))
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setRunning(false));
  };
  const p = test.periods;
  const d = test.diag;
  // the chance the result is real, allowing for every version tried on this unseen data
  const dsr = test.oos.bars > 0 ? deflatedSharpe(test.oos, Math.max(1, tries), (1 + 0.5 * test.oos.srBar ** 2) / Math.max(1, test.oos.bars)) : NaN;
  return (
    <div className="opt" data-optimizer>
      <div className="pro-section">OPTIMIZE — WHAT THE TEST SHOWS, AND WHAT TO TRY NEXT</div>
      <div className="opt-advice">
        {advice.map((a) => (
          <div key={a.title} className={`opt-card t-${a.tone}`}>
            <b>{a.title}</b>
            <span>{a.text}</span>
          </div>
        ))}
      </div>
      <div className="lab-grid2">
        <div>
          <div className="pro-section">
            {p ? `${p.unit === 'week' ? 'WEEK BY WEEK' : 'MONTH BY MONTH'} ON THE UNSEEN DATA — ${pct(p.up, 0)} MADE MONEY` : 'MONTH BY MONTH'}
          </div>
          {p && p.list.length ? (
            <>
              <Bars rows={p.list.slice(-18).map((x) => ({ label: new Date(x.t).toLocaleDateString('en-GB', p.unit === 'week' ? { day: '2-digit', month: 'short', timeZone: 'UTC' } : { month: 'short', year: '2-digit', timeZone: 'UTC' }), value: x.ret }))} format={(v) => pct(v, 1)} />
              <div className="lab-line mono">
                average {p.unit} {pct(p.avg, 1)} · worst {pct(p.worst, 1)} · {p.list.filter((x) => x.ret > 0).length} of {p.list.length} positive
              </div>
            </>
          ) : (
            <div className="lab-line muted">Not enough unseen data to split by month.</div>
          )}
        </div>
        <div>
          <div className="pro-section">HOW ITS TRADES ENDED — ON THE TRAINING YEARS</div>
          {d && d.trades > 0 ? (
            <>
              <table className="pro-table compact">
                <thead>
                  <tr>
                    <th className="l">TRADES THAT ENDED</th>
                    <th>SHARE</th>
                    <th>AVERAGE RESULT</th>
                  </tr>
                </thead>
                <tbody>
                  {d.exits.map((e) => (
                    <tr key={e.reason}>
                      <td className="l">{EXIT_WORDS[e.reason] ?? e.reason}</td>
                      <td className="mono">{pct(e.n / d.trades, 0)}</td>
                      <td className={`mono ${e.avgR >= 0 ? 'up' : 'down'}`}>{num(e.avgR)}R</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="l">long trades ({d.long.n})</td>
                    <td className="mono">{pct(d.long.win, 0)} won</td>
                    <td className={`mono ${d.long.avgR >= 0 ? 'up' : 'down'}`}>{num(d.long.avgR)}R</td>
                  </tr>
                  <tr>
                    <td className="l">short trades ({d.short.n})</td>
                    <td className="mono">{pct(d.short.win, 0)} won</td>
                    <td className={`mono ${d.short.avgR >= 0 ? 'up' : 'down'}`}>{num(d.short.avgR)}R</td>
                  </tr>
                </tbody>
              </table>
              <div className="lab-line mono">
                {num(d.tradesPerMonth, 1)} trades a month per coin · in a trade {pct(d.exposure, 0)} of the time · fees and slippage took {Number.isFinite(d.costShare) ? pct(Math.min(1, d.costShare), 0) : 'all'} of the profit before costs
              </div>
            </>
          ) : (
            <div className="lab-line muted">No trades on the training years.</div>
          )}
        </div>
      </div>

      <div className="pro-section">TRY CHANGES — MEASURED ON THE TRAINING YEARS ONLY, SO THE UNSEEN DATA STAYS UNSEEN</div>
      <div className="opt-bar">
        <span className="muted">Optimize for</span>
        {GOALS.map((g) => (
          <button key={g.id} className={`chip${goal === g.id ? ' active' : ''}`} onClick={() => setGoal(g.id)} title={g.plain} data-goal={g.id}>
            {g.name}
          </button>
        ))}
        <span className="grow" />
        <button className="btn bb2-primary opt-find" disabled={running || busy || !desktop?.lab?.optimize} onClick={find}>
          {running ? (status?.progress?.stage ? `${status.progress.stage} ${status.progress.done}/${status.progress.total}` : 'Trying changes…') : found ? '↻ Find improvements again' : '🔍 Find improvements'}
        </button>
      </div>
      {err && <div className="lab-error">{err}</div>}
      {!found && !running && (
        <div className="lab-line muted">
          The optimizer makes every sensible one-step change to this bot — a wider or tighter stop, another exit, long only, each market filter added or removed, a second opinion, volatility-based sizing, each strategy’s settings one step up and down, another pace — and measures each one on a stretch of the training years the models were not fitted on. It never reads the unseen data, so a change you apply can still be tested honestly.
        </div>
      )}
      {result && (
        <>
          {rows.length ? (
            <div className="opt-rows">
              {rows.map((r) => (
                <div key={r.variant.id} className="opt-row" data-variant={r.variant.id}>
                  <div className="opt-row-main">
                    <b>
                      {r.variant.label}
                      <em className="bb2-tag">{KIND[r.variant.kind]}</em>
                      {r.consistent ? <em className="bb2-tag pair">✓ also better on the earlier years</em> : <em className="bb2-tag overlap">only on the latest stretch</em>}
                    </b>
                    <span>{r.variant.why}</span>
                    <span className="mono">{r.text}</span>
                  </div>
                  <button className="btn" disabled={busy} onClick={() => onApply(r.variant.flow, r.variant.label)} title="Make this change to the bot and test it on the unseen data">
                    Apply &amp; test
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="lab-note">
              None of the {result.tried} changes tried beat this bot by enough to matter on the training years ({GOALS.find((g) => g.id === goal)!.name.toLowerCase()}). It is already close to what these building blocks can do — a bigger step is needed: a strategy of another kind, other coins, or another pace. Try another goal above too.
            </div>
          )}
          <div className="lab-line muted">
            {result.tried} changes measured against the bot as it is (Sharpe {num(result.base?.sharpe ?? NaN)}, {result.base?.trades ?? 0} trades, {pct(result.base?.weeksUp ?? NaN, 0)} winning weeks on the validation stretch). “Also better on the earlier years” means the change helped in both halves of the training data — the ones to trust first. Apply one change at a time.
          </div>
        </>
      )}
      <div className={`lab-line opt-tries${tries > 3 ? ' warn' : ''}`}>
        {triesWords(tries)}
        {tries > 1 && Number.isFinite(dsr) && (
          <>
            {' '}
            Chance the result is real after {tries} tries: <b className={dsr > 0.95 ? 'up' : dsr < 0.6 ? 'down' : ''}>{pct(dsr, 0)}</b> (95 % or more is convincing).
          </>
        )}
      </div>
    </div>
  );
}

// ---------- the same for a strategy that was not built in the bot builder: a research result ----------


/**
 * Under a research result: try one-step changes to the strategy on the
 * training years, test one on the unseen data, and deploy that version.
 */
export function SpecOptimizer({ spec, tfH }: { spec: StrategySpec; tfH: number }) {
  const status = useLab((s) => s.status);
  const [goal, setGoal] = useState<Goal>('sharpe');
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState('');
  const [found, setFound] = useState<{ variants: SpecVariant[]; scores: VariantScore[] } | null>(null);
  const [tested, setTested] = useState<{ id: string; label: string; spec: StrategySpec; res: LabTest } | null>(null);
  const [testing, setTesting] = useState('');
  const [tries, setTries] = useState(0);
  const [msg, setMsg] = useState('');
  const result = useMemo(() => (found ? rankVariants(found.variants, found.scores, goal) : null), [found, goal]);
  const rows = result ? result.ranked.slice(0, 6) : [];
  if (!desktop?.lab?.optimize) return null;
  const find = () => {
    const variants = specVariants(spec);
    setRunning(true);
    setErr('');
    setTested(null);
    desktop!.lab.optimize!([{ id: 'base', spec }, ...variants.map((v) => ({ id: v.id, spec: v.spec }))], { funding: [{ spec }, ...variants].some((v) => specNeeds(v.spec).funding) })
      .then((scores) => setFound({ variants, scores }))
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setRunning(false));
  };
  const test = (v: SpecVariant) => {
    setTesting(v.id);
    setErr('');
    setMsg('');
    desktop!.lab
      .test({ ...v.spec, name: `${spec.name} · ${v.label}`.slice(0, 120) }, { funding: specNeeds(v.spec).funding })
      .then((res) => {
        setTested({ id: v.id, label: v.label, spec: res.spec ?? v.spec, res });
        setTries((n) => n + 1);
      })
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setTesting(''));
  };
  const deploy = () => {
    if (!tested) return;
    const o = tested.res.oos;
    void desktop!.lab
      .deploy({ spec: { ...tested.spec, name: `${spec.name} · ${tested.label}`.slice(0, 120) }, tfH, stats: { sharpe: o.sharpe, t: o.t, dsr: o.psr, trades: o.trades, verdict: 'optimized · tested on unseen data' } }, { crypto: true, meme: false })
      .then(() => setMsg('Deployed to the crypto swarm. Switch it on or off, and set who decides its trades, in DEPL or the swarm’s deploy gate.'))
      .catch((e) => setMsg(String(e?.message ?? e)));
  };
  const dsr = tested && tested.res.oos.bars > 0 ? deflatedSharpe(tested.res.oos, tries + 1, (1 + 0.5 * tested.res.oos.srBar ** 2) / Math.max(1, tested.res.oos.bars)) : NaN;
  return (
    <div className="opt" data-spec-optimizer>
      <div className="pro-section">OPTIMIZE THIS STRATEGY — CHANGES TRIED ON THE TRAINING YEARS ONLY</div>
      <div className="opt-bar">
        <span className="muted">Optimize for</span>
        {GOALS.map((g) => (
          <button key={g.id} className={`chip${goal === g.id ? ' active' : ''}`} onClick={() => setGoal(g.id)} title={g.plain}>
            {g.name}
          </button>
        ))}
        <span className="grow" />
        <button className="btn opt-find" disabled={running || !!testing || status?.running} onClick={find}>
          {running ? (status?.progress?.stage ? `${status.progress.stage} ${status.progress.done}/${status.progress.total}` : 'Trying changes…') : found ? '↻ Find improvements again' : '🔍 Find improvements'}
        </button>
      </div>
      {err && <div className="lab-error">{err}</div>}
      {!found && !running && <div className="lab-line muted">Tries each one-step change to this strategy — its rule’s settings, its stop and exits, long only, each filter added or taken away, volatility sizing — on a stretch of the training years, without reading the unseen data. Then test the one you like and deploy that version.</div>}
      {result &&
        (rows.length ? (
          <div className="opt-rows">
            {rows.map((r) => (
              <div key={r.variant.id} className="opt-row">
                <div className="opt-row-main">
                  <b>
                    {r.variant.label}
                    <em className="bb2-tag">{KIND[r.variant.kind]}</em>
                    {r.consistent ? <em className="bb2-tag pair">✓ also better on the earlier years</em> : <em className="bb2-tag overlap">only on the latest stretch</em>}
                  </b>
                  <span className="mono">{r.text}</span>
                </div>
                <button className="btn" disabled={!!testing || running} onClick={() => test(r.variant)}>
                  {testing === r.variant.id ? 'Testing…' : 'Test this version'}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="lab-note">None of the {result.tried} changes tried beat this strategy by enough to matter on the training years. The research run already searched its neighbourhood — a better result needs a different idea, not a different setting.</div>
        ))}
      {tested && (
        <div className={`bb-verdict t-${tested.res.oos.sharpe > 1 && tested.res.oos.t > 2 ? 'good' : tested.res.oos.sharpe > 0 ? 'ok' : 'bad'}`}>
          <b>“{tested.label}” on the unseen data:</b> Sharpe {num(tested.res.oos.sharpe)} · {pct(tested.res.oos.cagr)} a year · worst drop {pct(tested.res.oos.maxDD)} · {tested.res.oos.trades} trades
          {tested.res.periods ? ` · ${pct(tested.res.periods.up, 0)} of ${tested.res.periods.unit}s positive` : ''}.{' '}
          {Number.isFinite(dsr) && (
            <>
              Chance it is real after {tries + 1} versions tried on this data (the research’s and yours): <b>{pct(dsr, 0)}</b>.{' '}
            </>
          )}
          <button className="btn" onClick={deploy} style={{ marginLeft: 8 }}>
            ⇢ Deploy this version
          </button>
        </div>
      )}
      {msg && <div className="lab-note">{msg}</div>}
    </div>
  );
}
