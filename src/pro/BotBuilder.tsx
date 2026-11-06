// BOT — the bot builder: a crypto bot as a chain of blocks (like n8n), each a
// drop-down in plain English. Pick a style, a strategy, a market model, a
// forecast, the risk management and the rules; backtest it on years of
// history; read the results in words; then decide whether to deploy it to the
// crypto swarm. The blocks are the Strategy Lab's and the Quant desk's own
// models (see lab/flow.ts) — nothing new to trust, just easier to put together.
import { useEffect, useMemo, useState } from 'react';
import { desktop } from '../desktop/bridge';
import { buildSpec, FLOW_DEFAULT, FORECASTS, forStyle, HOLDS, MODELS, RISKS, SIDES, STOP_WIDTHS, STRATEGIES, STYLE_MAP, STYLES, TAKE_PROFIT, verdictWords, type Flow, type Option } from '../lab/flow';
import { SIGNAL_MAP } from '../lab/library';
import { ncdf } from '../lab/stats';
import { startLabLink, useLab, type LabTest } from '../lab/store';
import { Check, type PanelProps } from '../ui/controls';
import { LineChart } from './charts';

export type BotConfig = Flow & { explain: boolean };
export const BOT_DEFAULTS: BotConfig = { ...FLOW_DEFAULT, explain: true };

const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');

/** a drop-down of options, grouped, the ones that suit the style first (✓) */
function Pick<T extends Option & { fits?: boolean }>({ value, options, onChange, label }: { value: string; options: T[]; onChange: (id: string) => void; label: string }) {
  const groups = [...new Set(options.map((o) => o.group))];
  return (
    <select className="bb-select" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {options
            .filter((o) => o.group === g)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.fits === false ? '' : o.suits ? '✓ ' : ''}
                {o.name}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

function Simple<T extends { id: string; name: string }>({ value, options, onChange, label }: { value: string; options: readonly T[]; onChange: (id: string) => void; label: string }) {
  return (
    <select className="bb-select small" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

function Node({ n, icon, title, tone, done, children, plain, explain }: { n: number; icon: string; title: string; tone: string; done?: boolean; children: React.ReactNode; plain?: string; explain: boolean }) {
  return (
    <div className={`bb-node t-${tone}${done ? ' done' : ''}`}>
      <div className="bb-node-head">
        <span className="bb-icon">{icon}</span>
        <span className="bb-step">{n}</span>
        <b>{title}</b>
      </div>
      <div className="bb-node-body">{children}</div>
      {explain && plain && <div className="bb-plain">{plain}</div>}
      <span className="bb-port in" />
      <span className="bb-port out" />
    </div>
  );
}

const Wire = ({ live }: { live: boolean }) => (
  <div className={`bb-wire${live ? ' live' : ''}`} aria-hidden>
    <i />
  </div>
);

export function BotBuilder({ config: c, setConfig }: PanelProps<BotConfig>) {
  useEffect(() => startLabLink(), []);
  const status = useLab((s) => s.status);
  const [res, setRes] = useState<LabTest | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [coinsText, setCoinsText] = useState(c.coins);
  const style = STYLE_MAP[c.style] ?? STYLES[2];
  const built = useMemo(() => buildSpec(c), [c]);
  const set = (p: Partial<BotConfig>) => {
    setConfig(p);
    setRes(null);
    setMsg('');
  };
  const strat = STRATEGIES.find((s) => s.id === c.strategy) ?? STRATEGIES[0];
  const sig = SIGNAL_MAP[strat.signal];
  const warn = sig.intraday && style.tfH >= 24 ? 'This strategy needs candles shorter than a day: pick scalping, intraday, swing or one-week.' : '';
  const needsFunding = sig.needsFunding || built.spec.filters.some((f) => f.id === 'crowd');
  const opt = <T extends Option>(xs: T[], id: string) => xs.find((x) => x.id === id);
  if (!desktop?.lab) return <div className="pro-empty">The bot builder runs in the desktop app (it backtests on years of history).</div>;

  const run = () => {
    setBusy(true);
    setErr('');
    setMsg('');
    desktop!.lab
      .test(built.spec, { timeframe: built.timeframe, years: built.years, coins: built.coins, funding: needsFunding })
      .then(setRes)
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };
  const v = res ? verdictWords(res.oos.sharpe, res.oos.t, res.oos.trades) : null;
  const deploy = () => {
    if (!res || !v) return;
    if (v.tone === 'bad' && !confirm('This bot did not hold up on data it never saw. Deploy it anyway?')) return;
    const spec = res.spec ?? built.spec;
    void desktop!.lab
      .deploy({ spec: { ...spec, name: built.spec.name }, tfH: style.tfH, stats: { sharpe: res.oos.sharpe, t: res.oos.t, dsr: res.oos.psr, trades: res.oos.trades, verdict: `bot builder · ${v.tone === 'good' ? 'strong' : v.tone === 'ok' ? 'promising' : 'weak'}` } }, { crypto: true, meme: false }, built.coins)
      .then(() => setMsg('Deployed to the crypto swarm. It proposes when its rules fire; the swarm’s council, forest and risk manager decide every trade. Switch it on or off in the swarm view (⇢ Deploy) or in DEPL.'))
      .catch((e) => setMsg(String(e?.message ?? e)));
  };
  // one-sided: how often pure chance would look at least this good (only meaningful when it made money)
  const pLuck = res && res.oos.t > 0 ? 1 - ncdf(res.oos.t) : NaN;
  const splitIdx = res && res.split ? res.curve.findIndex((p) => p.t >= res.split!) : -1;
  return (
    <div className="pro-panel bb">
      <div className="bb-top">
        <div>
          <b className="bb-title">Bot builder</b>
          <span className="muted"> — pick one option in each block, left to right. Backtest it, read the result, then decide whether to deploy.</span>
        </div>
        <Check checked={c.explain} onChange={(explain) => setConfig({ explain })}>
          Explain every choice
        </Check>
      </div>
      <div className="pro-scroll">
        <div className="bb-canvas">
          <Node n={1} icon="⏱" title="TRADING STYLE" tone="a" done explain={c.explain} plain={`${style.plain}${style.note ? ` ${style.note}` : ''}`}>
            <Simple value={c.style} options={STYLES} onChange={(id) => set({ style: id as BotConfig['style'] })} label="Trading style" />
          </Node>
          <Wire live={!!res} />
          <Node n={2} icon="↗" title="STRATEGY" tone="b" done explain={c.explain} plain={`${strat.plain}${warn ? ` ⚠ ${warn}` : ''}`}>
            <Pick value={c.strategy} options={forStyle(STRATEGIES, c.style)} onChange={(id) => set({ strategy: id })} label="Strategy" />
          </Node>
          <Wire live={!!res} />
          <Node n={3} icon="◎" title="MARKET MODEL" tone="c" done explain={c.explain} plain={`${opt(MODELS, c.model)?.plain ?? ''}${c.model2 !== 'none' ? ` + ${opt(MODELS, c.model2)?.plain ?? ''}` : ''}`}>
            <Pick value={c.model} options={forStyle(MODELS, c.style)} onChange={(id) => set({ model: id })} label="Market model" />
            <Pick value={c.model2} options={forStyle(MODELS, c.style).map((m) => (m.id === 'none' ? { ...m, name: 'No second filter' } : m))} onChange={(id) => set({ model2: id })} label="Second market model" />
          </Node>
          <Wire live={!!res} />
          <Node n={4} icon="✦" title="FORECAST" tone="d" done explain={c.explain} plain={opt(FORECASTS, c.forecast)?.plain}>
            <Pick value={c.forecast} options={forStyle(FORECASTS, c.style)} onChange={(id) => set({ forecast: id })} label="Forecast" />
          </Node>
          <Wire live={!!res} />
          <Node n={5} icon="⛨" title="RISK MANAGEMENT" tone="e" done explain={c.explain} plain={`${opt(RISKS, c.risk)?.plain ?? ''} ${STOP_WIDTHS.find((s) => s.id === c.stopWidth)?.plain ?? ''}`}>
            <Pick value={c.risk} options={forStyle(RISKS, c.style)} onChange={(id) => set({ risk: id })} label="Risk management" />
            <Simple value={c.stopWidth} options={STOP_WIDTHS} onChange={(id) => set({ stopWidth: id })} label="Stop width" />
          </Node>
          <Wire live={!!res} />
          <Node n={6} icon="⚖" title="RULES OF ENGAGEMENT" tone="f" done explain={c.explain} plain={`${SIDES.find((s) => s.id === c.sides)?.plain ?? ''} ${TAKE_PROFIT.find((t) => t.id === c.takeProfit)?.plain ?? ''} ${HOLDS.find((h) => h.id === c.hold)?.plain ?? ''}`}>
            <Simple value={c.sides} options={SIDES} onChange={(id) => set({ sides: id as BotConfig['sides'] })} label="Direction" />
            <Simple value={c.takeProfit} options={TAKE_PROFIT} onChange={(id) => set({ takeProfit: id })} label="Take profit" />
            <Simple value={c.hold} options={HOLDS} onChange={(id) => set({ hold: id })} label="Holding time" />
            <Check checked={c.flip} onChange={(flip) => set({ flip })}>
              Exit on an opposite signal
            </Check>
          </Node>
          <Wire live={!!res} />
          <Node n={7} icon="▶" title="BACKTEST" tone="g" done={!!res} explain={c.explain} plain={`Tests on ${style.years} year${style.years > 1 ? 's' : ''} of ${style.timeframe} candles: it is built on the first 70 % and judged on the last 30 % it never saw, with fees and slippage.`}>
            <input className="ctl mono bb-coins" value={coinsText} onChange={(e) => setCoinsText(e.target.value.toUpperCase())} onBlur={() => set({ coins: coinsText })} title="Coins to test on, separated by spaces" />
            <button className="btn bb-run" disabled={busy || !!warn} onClick={run}>
              {busy ? 'Testing…' : '▶ Run backtest'}
            </button>
            {busy && <span className="muted bb-status">{status?.progress?.stage ?? 'Downloading history and testing…'}</span>}
          </Node>
          <Wire live={!!res} />
          <Node n={8} icon="⇢" title="DEPLOY" tone="h" done={!!msg} explain={c.explain} plain="Only after a backtest. The bot then proposes trades to the crypto swarm; its council, forest and risk manager still decide every one.">
            <button className={`btn bb-deploy${v ? ` t-${v.tone}` : ''}`} disabled={!res} onClick={deploy} title={res ? 'Deploy to the crypto swarm' : 'Run the backtest first'}>
              {res ? 'Deploy to the crypto swarm' : 'Backtest first'}
            </button>
          </Node>
        </div>

        {err && <div className="lab-error">{err}</div>}
        {msg && <div className="lab-note">{msg}</div>}

        <div className="pro-section">THE BOT IN WORDS</div>
        {built.summary.map((x) => (
          <div key={x} className="lab-line">
            {x}
          </div>
        ))}

        {res && v && (
          <>
            <div className={`bb-verdict t-${v.tone}`}>
              <b>{v.tone === 'good' ? 'Looks good' : v.tone === 'ok' ? 'Maybe' : 'Not yet'}</b> — {v.text}
            </div>
            <div className="bb-tiles">
              {[
                ['Return a year', pct(res.oos.cagr), 'On the data it never saw (the last 30 %).', res.oos.cagr >= 0 ? 'up' : 'down'],
                ['Buy-and-hold', res.bh ? pct(res.bh.cagr) : '—', 'Just holding the same coins over the same period.', ''],
                ['Worst drop', pct(-res.oos.maxDD), 'The biggest fall from a high, before recovering.', 'down'],
                ['Win rate', pct(res.oos.winRate, 0), 'Share of trades that made money.', ''],
                ['Trades', String(res.oos.trades), 'How many trades it took on the unseen data.', ''],
                ['Sharpe ratio', num(res.oos.sharpe), 'Return for the risk taken: above 1 is good, above 2 excellent.', res.oos.sharpe > 1 ? 'up' : res.oos.sharpe < 0 ? 'down' : ''],
                ['Chance it’s luck', Number.isFinite(pLuck) ? pct(pLuck, 0) : 'n/a', Number.isFinite(pLuck) ? 'How often pure chance would look this good (lower is better; under 5 % is convincing).' : 'It did not make money on unseen data, so there is no edge to test.', pLuck < 0.05 ? 'up' : pLuck > 0.3 ? 'down' : ''],
                ['Chance of a losing run', res.mc ? pct(res.mc.pLoss, 0) : '—', 'Shuffling its trades 2,000 times at 1 % risk each: how often the account ends lower.', res.mc && res.mc.pLoss < 0.2 ? 'up' : 'down'],
              ].map(([k, val, hint, tone]) => (
                <div key={k} className="bb-tile" title={hint}>
                  <span className="muted">{k}</span>
                  <b className={`mono ${tone}`}>{val}</b>
                  {c.explain && <small className="muted">{hint}</small>}
                </div>
              ))}
            </div>
            <div className="lab-line">
              Built on the first 70 %: Sharpe {num(res.is.sharpe)} · judged on the last 30 %: Sharpe {num(res.oos.sharpe)}.{' '}
              {res.is.sharpe > 1 && res.oos.sharpe < res.is.sharpe * 0.4 ? 'It did much better on the data it was built on than on new data — a sign of over-fitting.' : res.oos.sharpe >= res.is.sharpe * 0.6 ? 'It held up on new data about as well as on the data it was built on — a good sign.' : ''}
            </div>
            {res.meta && (
              <div className="lab-line">
                AI trade filter: {res.meta.used ? `kept — it lifted the unseen-data Sharpe from ${num(res.meta.before)} to ${num(res.meta.after)}.` : res.meta.trainedOn < 40 ? `not enough past trades to learn from (${res.meta.trainedOn}).` : `dropped — it did not help on unseen data (${num(res.meta.before)} → ${num(res.meta.after)}).`}
              </div>
            )}
            <div className="pro-section">THE BOT AGAINST BUY-AND-HOLD (DASHED LINE = WHERE THE UNSEEN DATA STARTS)</div>
            <LineChart
              height={170}
              marker={splitIdx > 0 ? splitIdx : undefined}
              series={[
                { values: res.curve.map((p) => p.bh), color: 'var(--muted)', width: 1, dash: '3 2' },
                { values: res.curve.map((p) => p.eq), color: 'var(--pro-head, #ffd200)', width: 1.7 },
              ]}
              labels={
                <>
                  <span style={{ color: 'var(--pro-head, #ffd200)' }}>the bot</span> · <span className="muted">buy-and-hold</span>
                </>
              }
            />
            {res.perCoin && res.perCoin.length > 1 && (
              <table className="pro-table compact">
                <thead>
                  <tr>
                    <th className="l">COIN</th>
                    <th>RETURN A YEAR</th>
                    <th>WORST DROP</th>
                    <th>TRADES</th>
                    <th>SHARPE</th>
                  </tr>
                </thead>
                <tbody>
                  {res.perCoin.map((p) => (
                    <tr key={p.coin}>
                      <td className="l b">{p.coin}</td>
                      <td className={`mono ${p.oos.cagr >= 0 ? 'up' : 'down'}`}>{pct(p.oos.cagr)}</td>
                      <td className="mono down">{pct(-p.oos.maxDD)}</td>
                      <td className="mono">{p.oos.trades}</td>
                      <td className="mono">{num(p.oos.sharpe)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}
