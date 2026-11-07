// BOT — the bot builder: a crypto bot as a workflow of blocks on a canvas,
// like n8n. Click a block to open it in the inspector on the right and pick
// one or more options — two strategies, several market filters, second
// opinions, the neural network and the decision forest paired, two sizing
// rules. Every pick is checked against the others as it is made (clash,
// overlap, pairs well); then the bot is backtested on years of history and
// the test measures it: each strategy alone and together, how often they
// agree, what each filter adds, each AI decision maker. Read the result, then
// decide whether to deploy it to the crypto swarm — and who decides its
// trades there. The blocks are the Strategy Lab's and the Quant desk's own
// models (lab/flow.ts) — nothing new to trust, just easier to put together.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { desktop } from '../desktop/bridge';
import {
  blockTone,
  buildSpec,
  checkFlow,
  COMBINES,
  DECIDERS,
  FLOW_DEFAULT,
  FORECASTS,
  forStyle,
  HOLDS,
  migrateFlow,
  MODELS,
  pairWords,
  pickName,
  PORTFOLIOS,
  RISKS,
  SIDES,
  STOP_WIDTHS,
  STRATEGIES,
  STYLE_MAP,
  STYLES,
  TAKE_PROFIT,
  verdictWords,
  type BlockId,
  type Finding,
  type Flow,
  type Option,
} from '../lab/flow';
import { ncdf } from '../lab/stats';
import { startLabLink, useLab, type LabTest } from '../lab/store';
import { Check, type PanelProps } from '../ui/controls';
import { LineChart } from './charts';

export type BotConfig = Flow & { explain: boolean };
export const BOT_DEFAULTS: BotConfig = { ...FLOW_DEFAULT, explain: true };

const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');

// ---------- the canvas geometry (logical units; the canvas scales to the panel) ----------

const NW = 206;
const NH = 124;
const GX = 54;
const GY = 74;
const PAD = 26;
const CW = PAD * 2 + 4 * NW + 3 * GX;
const CH = PAD * 2 + 2 * NH + GY;
const at = (i: number) => ({ x: PAD + (i % 4) * (NW + GX), y: PAD + Math.floor(i / 4) * (NH + GY) });

interface BlockDef {
  id: BlockId;
  title: string;
  color: string;
  icon: ReactNode;
  /** what the block does, in a line */
  role: string;
}

const I = (d: string) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const BLOCKS: BlockDef[] = [
  { id: 'style', title: 'Trading style', color: '#ffd200', icon: I('M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'), role: 'How long trades last. It sets the candles, the look-backs, the holding time and the stop for every other block.' },
  { id: 'strategy', title: 'Strategies', color: '#ff7a1a', icon: I('M3 17l6-6 4 4 8-8M15 7h6v6'), role: 'When to enter. Pick one or several; several are joined — all must agree, a majority, or any one.' },
  { id: 'model', title: 'Market models', color: '#2cf0b0', icon: I('M12 2a10 10 0 1 0 10 10M12 6a6 6 0 1 0 6 6M12 10a2 2 0 1 0 2 2'), role: 'When it is allowed to trade: trend, regime, volatility, activity, funding. Every filter picked must agree.' },
  { id: 'forecast', title: 'Forecasts & AI', color: '#b58cff', icon: I('M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4zM19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z'), role: 'Second opinions that must agree, and an AI decision maker — the neural network, the decision forest, or both paired — that learns which signals to skip.' },
  { id: 'risk', title: 'Risk management', color: '#ff4d6d', icon: I('M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'), role: 'How big each trade is, where the stop goes, hedging, and how the money is split across coins.' },
  { id: 'rules', title: 'Rules of engagement', color: '#38e1ff', icon: I('M12 3v18M5 8l-3 6h6zM19 8l-3 6h6zM5 8h14M8 21h8'), role: 'Long, short or both; when to take profit; how long to hold; whether an opposite signal closes the trade.' },
  { id: 'test', title: 'Backtest', color: '#4f8ff0', icon: I('M6 4l14 8-14 8z'), role: 'Tests the bot on years of history: built on the first 70 %, judged on the last 30 % it never saw, with fees and slippage.' },
  { id: 'deploy', title: 'Deploy', color: '#a0d468', icon: I('M5 12h14M13 6l6 6-6 6'), role: 'Only after a backtest. Sends the bot to the crypto swarm, and sets who decides its trades there.' },
];

const TONE_MARK: Record<Finding['tone'], string> = { clash: '✕', overlap: '≈', pair: '+', info: 'i' };
const TONE_WORD: Record<Finding['tone'], string> = { clash: 'Clash', overlap: 'Overlap', pair: 'Pairs well', info: 'Note' };
const RANK: Record<Finding['tone'], number> = { clash: 3, overlap: 2, pair: 1, info: 0 };

/** the wires: straight along a row, an orthogonal rounded return from the end of row one to the start of row two */
function wirePath(i: number): string {
  const a = at(i);
  const b = at(i + 1);
  const x1 = a.x + NW;
  const y1 = a.y + NH / 2;
  const x2 = b.x;
  const y2 = b.y + NH / 2;
  if (a.y === b.y) return `M${x1} ${y1} C${x1 + GX / 2} ${y1} ${x2 - GX / 2} ${y2} ${x2} ${y2}`;
  const r = 12;
  const xr = x1 + 20;
  const ym = a.y + NH + GY / 2;
  const xl = x2 - 20;
  return `M${x1} ${y1} H${xr - r} Q${xr} ${y1} ${xr} ${y1 + r} V${ym - r} Q${xr} ${ym} ${xr - r} ${ym} H${xl + r} Q${xl} ${ym} ${xl} ${ym + r} V${y2 - r} Q${xl} ${y2} ${xl + r} ${y2} H${x2}`;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(CW);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// ---------- the inspector's lists ----------

function OptionRow({ on, name, plain, explain, badges, onClick, radio, id }: { on: boolean; name: string; plain?: string; explain: boolean; badges?: ReactNode; onClick: () => void; radio?: boolean; id: string }) {
  return (
    <button className={`bb2-opt${on ? ' on' : ''}`} onClick={onClick} data-opt={id} role={radio ? 'radio' : 'checkbox'} aria-checked={on}>
      <span className={`bb2-box${radio ? ' radio' : ''}`}>{on ? (radio ? '●' : '✓') : ''}</span>
      <span className="bb2-opt-main">
        <span className="bb2-opt-name">
          {name}
          {badges}
        </span>
        {explain && plain && <span className="bb2-opt-plain">{plain}</span>}
      </span>
    </button>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bb2-group">
      <div className="bb2-group-title">{title}</div>
      {children}
    </div>
  );
}

export function BotBuilder({ config: raw, setConfig }: PanelProps<BotConfig>) {
  useEffect(() => startLabLink(), []);
  const c = useMemo(() => ({ ...migrateFlow(raw as BotConfig & Record<string, unknown>), explain: raw.explain ?? true }), [raw]);
  const status = useLab((s) => s.status);
  const [res, setRes] = useState<LabTest | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [deployed, setDeployed] = useState(false);
  const [sel, setSel] = useState<BlockId>('strategy');
  const [q, setQ] = useState('');
  const [coinsText, setCoinsText] = useState(c.coins);
  const [wrapRef, wrapW] = useWidth<HTMLDivElement>();
  const style = STYLE_MAP[c.style] ?? STYLES[2];
  const built = useMemo(() => buildSpec(c), [c]);
  const findings = useMemo(() => checkFlow(c).sort((a, b) => RANK[b.tone] - RANK[a.tone]), [c]);
  const blocked = findings.some((f) => f.tone === 'clash' && f.blocks.includes('style'));
  const set = (p: Partial<Flow>) => {
    setConfig(p as Partial<BotConfig>);
    setRes(null);
    setMsg('');
    setDeployed(false);
  };
  const toggle = (key: 'strategies' | 'models' | 'forecasts' | 'risks', id: string) => {
    const cur = c[key];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    if (key === 'strategies' && !next.length) return;
    set({ [key]: next } as Partial<Flow>);
  };
  useEffect(() => setQ(''), [sel]);
  if (!desktop?.lab) return <div className="pro-empty">The bot builder runs in the desktop app (it backtests on years of history).</div>;

  const needsFunding = [built.spec.signal, ...(built.spec.also ?? [])].some((r) => r.id === 'carry') || built.spec.filters.some((f) => f.id === 'crowd');
  const run = () => {
    setBusy(true);
    setErr('');
    setMsg('');
    setDeployed(false);
    desktop!.lab
      .test(built.spec, { timeframe: built.timeframe, years: built.years, coins: built.coins, funding: needsFunding })
      .then((r) => {
        setRes(r);
        setSel('test');
      })
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };
  const v = res ? verdictWords(res.oos.sharpe, res.oos.t, res.oos.trades) : null;
  const deploy = () => {
    if (!res || !v) return;
    if (v.tone === 'bad' && !confirm('This bot did not hold up on data it never saw. Deploy it anyway?')) return;
    const spec = res.spec ?? built.spec;
    void desktop!.lab
      .deploy({ spec: { ...spec, name: built.spec.name }, tfH: style.tfH, stats: { sharpe: res.oos.sharpe, t: res.oos.t, dsr: res.oos.psr, trades: res.oos.trades, verdict: `bot builder · ${v.tone === 'good' ? 'strong' : v.tone === 'ok' ? 'promising' : 'weak'}` }, authority: c.authority }, { crypto: true, meme: false }, built.coins)
      .then(() => {
        setDeployed(true);
        setMsg(c.authority === 'tested' ? 'Deployed to the crypto swarm, to trade as tested: the council advises, only Guardian and Risk can stop a trade. Switch it on or off, or change who decides, in the swarm view (⇢ Deploy) or in DEPL.' : 'Deployed to the crypto swarm. It proposes when its rules fire; the council, the forest and the risk manager decide every trade. Switch it on or off, or change who decides, in the swarm view (⇢ Deploy) or in DEPL.');
      })
      .catch((e) => setMsg(String(e?.message ?? e)));
  };
  const pLuck = res && res.oos.t > 0 ? 1 - ncdf(res.oos.t) : NaN;
  const splitIdx = res && res.split ? res.curve.findIndex((p) => p.t >= res.split!) : -1;
  const scale = Math.max(0.55, Math.min(1.2, (wrapW - 4) / CW));
  const counts = { clash: findings.filter((f) => f.tone === 'clash').length, overlap: findings.filter((f) => f.tone === 'overlap').length, pair: findings.filter((f) => f.tone === 'pair').length };
  const state = busy ? 'testing' : deployed ? 'deployed' : res ? 'tested' : 'draft';

  // what a block shows on the canvas: a subtitle and its picks
  const face = (b: BlockId): { sub: string; chips: string[] } => {
    switch (b) {
      case 'style':
        return { sub: `${style.timeframe} candles · ${style.years} years`, chips: [style.name.split(' — ')[0]] };
      case 'strategy':
        return { sub: c.strategies.length > 1 ? `${c.strategies.length} joined · ${COMBINES.find((x) => x.id === c.combine)!.name.toLowerCase()}` : '1 strategy', chips: c.strategies.map(pickName.strategy) };
      case 'model':
        return { sub: c.models.length ? `${c.models.length} filter${c.models.length > 1 ? 's' : ''} · all must allow` : 'trades in any market', chips: c.models.map(pickName.model) };
      case 'forecast':
        return { sub: c.decider === 'none' ? `${c.forecasts.length} second opinion${c.forecasts.length === 1 ? '' : 's'}` : `AI: ${DECIDERS.find((d) => d.id === c.decider)!.name.toLowerCase()}`, chips: [...c.forecasts.map(pickName.forecast), ...(c.decider !== 'none' ? [DECIDERS.find((d) => d.id === c.decider)!.name] : [])] };
      case 'risk':
        return { sub: `${STOP_WIDTHS.find((s) => s.id === c.stopWidth)?.name ?? ''} · ${PORTFOLIOS.find((p) => p.id === c.portfolio)!.name.split(' (')[0].toLowerCase()}`, chips: c.risks.length ? c.risks.map(pickName.risk) : ['Fixed size'] };
      case 'rules':
        return { sub: SIDES.find((s) => s.id === c.sides)!.name, chips: [TAKE_PROFIT.find((t) => t.id === c.takeProfit)!.name.split(' (')[0], HOLDS.find((h) => h.id === c.hold)!.name, ...(c.flip ? ['Exit on opposite signal'] : [])] };
      case 'test':
        return { sub: busy ? (status?.progress?.stage ?? 'testing…') : res ? `Sharpe ${num(res.oos.sharpe)} on unseen data` : 'not run yet', chips: built.coins };
      case 'deploy':
        return { sub: deployed ? 'deployed' : res ? 'ready' : 'backtest first', chips: [c.authority === 'tested' ? 'Trade as tested' : 'Council decides'] };
    }
  };
  // what adding an option would do, against the picks already made
  const preview = (key: 'strategies' | 'models' | 'forecasts' | 'risks', id: string): Finding['tone'] | null => {
    if (c[key].includes(id)) return null;
    const before = new Set(findings.map((f) => f.text));
    const after = checkFlow({ ...c, [key]: [...c[key], id] }).filter((f) => f.picks.includes(id) && !before.has(f.text) && f.tone !== 'info');
    return after.length ? after.sort((a, b) => RANK[b.tone] - RANK[a.tone])[0].tone : null;
  };
  const badges = (fits: boolean | undefined, tone: Finding['tone'] | null) => (
    <>
      {fits && <em className="bb2-tag fit">✓ suits {style.name.split(' — ')[0].toLowerCase()}</em>}
      {tone && <em className={`bb2-tag ${tone}`}>{tone === 'clash' ? '✕ clashes' : tone === 'overlap' ? '≈ overlaps' : '+ pairs well'}</em>}
    </>
  );
  const match = (o: { name: string; plain: string; group?: string }) => !q || `${o.name} ${o.plain} ${o.group ?? ''}`.toLowerCase().includes(q.toLowerCase());
  const multi = <T extends Option>(key: 'strategies' | 'models' | 'forecasts' | 'risks', xs: T[]) => {
    const list = forStyle(xs, c.style).filter(match);
    const groups = [...new Set(list.map((o) => o.group))];
    return groups.map((g) => (
      <Group key={g} title={g}>
        {list
          .filter((o) => o.group === g)
          .map((o) => (
            <OptionRow key={o.id} id={o.id} on={c[key].includes(o.id)} name={o.name} plain={o.plain} explain={c.explain} badges={badges(o.suits ? o.fits : undefined, preview(key, o.id))} onClick={() => toggle(key, o.id)} />
          ))}
      </Group>
    ));
  };
  const radio = <T extends { id: string; name: string; plain: string }>(title: string, xs: readonly T[], value: string, onPick: (id: string) => void) => (
    <Group title={title}>
      {xs.map((o) => (
        <OptionRow key={o.id} id={o.id} radio on={value === o.id} name={o.name} plain={o.plain} explain={c.explain} onClick={() => onPick(o.id)} />
      ))}
    </Group>
  );
  const mine = (b: BlockId) => findings.filter((f) => f.blocks.includes(b));
  const blockDef = BLOCKS.find((b) => b.id === sel)!;

  const inspector = () => {
    switch (sel) {
      case 'style':
        return (
          <Group title="How long trades last">
            {STYLES.map((s) => (
              <OptionRow key={s.id} id={s.id} radio on={c.style === s.id} name={s.name} plain={`${s.plain} ${s.timeframe} candles, ${s.years} year${s.years > 1 ? 's' : ''} of history.${s.note ? ` ${s.note}` : ''}`} explain={c.explain} onClick={() => set({ style: s.id })} />
            ))}
          </Group>
        );
      case 'strategy':
        return (
          <>
            {c.strategies.length > 1 && radio('How the strategies are joined', COMBINES, c.combine, (id) => set({ combine: id as Flow['combine'] }))}
            {multi('strategies', STRATEGIES)}
          </>
        );
      case 'model':
        return multi('models', MODELS);
      case 'forecast':
        return (
          <>
            {radio('AI decision maker (learns which signals to skip)', DECIDERS, c.decider, (id) => set({ decider: id as Flow['decider'] }))}
            <div className="bb2-group-title">Second opinions (each must agree)</div>
            {multi('forecasts', FORECASTS)}
          </>
        );
      case 'risk':
        return (
          <>
            {multi('risks', RISKS)}
            {radio('Stop width', STOP_WIDTHS, c.stopWidth, (id) => set({ stopWidth: id }))}
            {radio('Split across coins', PORTFOLIOS, c.portfolio, (id) => set({ portfolio: id as Flow['portfolio'] }))}
          </>
        );
      case 'rules':
        return (
          <>
            {radio('Direction', SIDES, c.sides, (id) => set({ sides: id as Flow['sides'] }))}
            {radio('Taking profit', TAKE_PROFIT, c.takeProfit, (id) => set({ takeProfit: id }))}
            {radio('Holding time', HOLDS, c.hold, (id) => set({ hold: id }))}
            <Group title="Opposite signal">
              <OptionRow id="flip" on={c.flip} name="An opposite signal closes the trade" plain="If the strategies turn the other way, get out — even before the stop or the target." explain={c.explain} onClick={() => set({ flip: !c.flip })} />
            </Group>
          </>
        );
      case 'test':
        return (
          <Group title="Test on">
            <label className="bb2-field">
              <span>Coins (up to 8)</span>
              <input className="ctl mono bb-coins" value={coinsText} onChange={(e) => setCoinsText(e.target.value.toUpperCase())} onBlur={() => set({ coins: coinsText })} onKeyDown={(e) => e.key === 'Enter' && set({ coins: coinsText })} title="Coins to test on, separated by spaces" />
            </label>
            <div className="bb2-opt-plain">
              {style.years} year{style.years > 1 ? 's' : ''} of {style.timeframe} candles from the exchange · built on the first 70 %, judged on the last 30 % · fees 4.5 bps and slippage 2 bps a side{needsFunding ? ' · with funding' : ''}.
            </div>
            <button className="btn bb-run bb2-primary" disabled={busy || blocked} onClick={run}>
              {busy ? 'Testing…' : res ? '↻ Test again' : '▶ Run backtest'}
            </button>
            {blocked && <div className="bb2-opt-plain down">Fix the clash with the trading style first.</div>}
            {busy && <div className="bb2-opt-plain">{status?.progress?.stage ?? 'Downloading history and testing…'}</div>}
          </Group>
        );
      case 'deploy':
        return (
          <>
            <Group title="Who decides its trades in the swarm">
              <OptionRow id="council" radio on={c.authority === 'council'} name="Council decides" plain="The bot proposes; the swarm’s council (trend, tape, crowd, forest) votes and can block a signal. Safer while a bot is unproven — but the council was not part of the test, so it changes which trades happen." explain={c.explain} onClick={() => setConfig({ authority: 'council' })} />
              <OptionRow id="tested" radio on={c.authority === 'tested'} name="Trade as tested" plain="The bot takes every signal it was tested on; the council’s votes are recorded as advice. Guardian (spreads, volatility spikes) and Risk (daily loss, drawdown, the size of every trade) can still stop any trade. For bots that held up on unseen data." explain={c.explain} onClick={() => setConfig({ authority: 'tested' })} />
            </Group>
            <button className={`btn bb-deploy bb2-primary${v ? ` t-${v.tone}` : ''}`} disabled={!res} onClick={deploy} title={res ? 'Deploy to the crypto swarm' : 'Run the backtest first'}>
              {deployed ? '✓ Deployed' : res ? 'Deploy to the crypto swarm' : 'Backtest first'}
            </button>
          </>
        );
    }
  };

  return (
    <div className="pro-panel bb bb2">
      <div className="bb2-head">
        <span className="bb2-logo">{BLOCKS[1].icon}</span>
        <div className="bb2-head-title">
          <b>Bot builder</b>
          <span className="muted" title={built.spec.name}>
            {built.spec.name}
          </span>
        </div>
        <span className={`bb2-state s-${state}`}>{state === 'testing' ? 'Testing…' : state === 'deployed' ? 'Deployed' : state === 'tested' ? `Tested · ${v?.tone === 'good' ? 'looks good' : v?.tone === 'ok' ? 'maybe' : 'not yet'}` : 'Draft'}</span>
        <span className="grow" />
        <span className="bb2-counts" title="The compatibility check: picks that clash, overlap or pair well">
          <i className="clash">✕ {counts.clash}</i>
          <i className="overlap">≈ {counts.overlap}</i>
          <i className="pair">+ {counts.pair}</i>
        </span>
        <Check checked={c.explain} onChange={(explain) => setConfig({ explain })}>
          Explain
        </Check>
        <button className="btn ghost" onClick={() => confirm('Start again from the default bot?') && set({ ...FLOW_DEFAULT })} title="Back to the default bot">
          Reset
        </button>
        <button className="btn bb2-primary" disabled={busy || blocked} onClick={run}>
          {busy ? 'Testing…' : '▶ Test bot'}
        </button>
      </div>
      <div className="pro-scroll">
        <div className="bb2-body">
          <div className="bb2-canvas-wrap" ref={wrapRef} style={{ height: CH * scale }}>
            <div className="bb-canvas bb2-canvas" style={{ width: CW, height: CH, transform: `scale(${scale})` }}>
              <svg className="bb2-wires" width={CW} height={CH} aria-hidden>
                {BLOCKS.slice(0, -1).map((b, i) => {
                  const t = blockTone(findings, b.id) === 'clash' || blockTone(findings, BLOCKS[i + 1].id) === 'clash';
                  return (
                    <g key={b.id}>
                      <path d={wirePath(i)} className={`bb2-wire${res ? ' done' : ''}${t ? ' clash' : ''}`} />
                      {busy && <path d={wirePath(i)} className="bb2-wire flow" />}
                    </g>
                  );
                })}
              </svg>
              {BLOCKS.map((b, i) => {
                const p = at(i);
                const f = face(b.id);
                const tone = blockTone(findings, b.id);
                const done = b.id === 'test' ? !!res : b.id === 'deploy' ? deployed : true;
                return (
                  <div key={b.id} className={`bb-node bb2-node${sel === b.id ? ' sel' : ''}${done ? ' done' : ''}${tone ? ` has-${tone}` : ''}`} data-block={b.id} style={{ left: p.x, top: p.y, width: NW, height: NH, ['--t' as string]: b.color }} onClick={() => setSel(b.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSel(b.id)} aria-label={b.title}>
                    <span className="bb-port in" />
                    <span className="bb-port out" />
                    <div className="bb2-node-head">
                      <span className="bb2-ico">{b.icon}</span>
                      <div className="bb2-node-title">
                        <b>
                          <span className="bb2-n">{i + 1}</span>
                          {b.title}
                        </b>
                        <small>{f.sub}</small>
                      </div>
                      {tone && tone !== 'info' && (
                        <span className={`bb2-badge ${tone}`} title={TONE_WORD[tone]}>
                          {TONE_MARK[tone]}
                        </span>
                      )}
                    </div>
                    <div className="bb2-chips">
                      {f.chips.slice(0, 3).map((x) => (
                        <span key={x} className="bb2-chip">
                          {x}
                        </span>
                      ))}
                      {f.chips.length > 3 && <span className="bb2-chip more">+{f.chips.length - 3}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <aside className="bb2-inspector" aria-label={`${blockDef.title} settings`}>
            <div className="bb2-insp-head" style={{ ['--t' as string]: blockDef.color }}>
              <span className="bb2-ico">{blockDef.icon}</span>
              <div>
                <b>{blockDef.title}</b>
                <small>{blockDef.role}</small>
              </div>
            </div>
            {mine(sel).some((f) => f.tone === 'clash' || f.tone === 'overlap') && (
              <div className="bb2-insp-checks">
                {mine(sel)
                  .filter((f) => f.tone === 'clash' || f.tone === 'overlap')
                  .map((f) => (
                    <div key={f.text} className={`bb2-finding ${f.tone}`} title={f.text}>
                      <b>{TONE_MARK[f.tone]}</b>
                      <span>{f.text}</span>
                    </div>
                  ))}
              </div>
            )}
            {['strategy', 'model', 'forecast', 'risk'].includes(sel) && <input className="ctl bb2-search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the options" />}
            <div className="bb2-insp-body">{inspector()}</div>
          </aside>
        </div>

        {err && <div className="lab-error">{err}</div>}
        {msg && <div className="lab-note">{msg}</div>}

        <div className="bb2-row">
          <div className="bb2-col">
            <div className="pro-section">THE COMPATIBILITY CHECK — DO THE PICKS WORK TOGETHER?</div>
            {findings.length ? (
              findings.map((f) => (
                <button key={f.text} className={`bb2-finding ${f.tone}`} onClick={() => setSel(f.blocks[f.blocks.length - 1])}>
                  <b>{TONE_MARK[f.tone]}</b>
                  <span>
                    <em>{TONE_WORD[f.tone]}</em> {f.text}
                  </span>
                </button>
              ))
            ) : (
              <div className="lab-line muted">Nothing to flag: the picks neither fight nor repeat each other.</div>
            )}
          </div>
          <div className="bb2-col">
            <div className="pro-section">THE BOT IN WORDS</div>
            {built.summary.map((x) => (
              <div key={x} className="lab-line">
                {x}
              </div>
            ))}
          </div>
        </div>

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

            <Measured res={res} c={c} />

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
                    {res.spec?.coinWeights && <th>MONEY</th>}
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
                      {res.spec?.coinWeights && <td className="mono">{pct(res.spec.coinWeights[p.coin] ?? 0, 0)}</td>}
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

/** what the test measured about the parts: each strategy alone, how they relate, what each filter adds, each AI decision maker */
function Measured({ res, c }: { res: LabTest; c: BotConfig }) {
  const p = res.parts;
  const ds = res.deciders ?? [];
  const help = (with_: number, without: number) => (with_ > without + 0.1 ? 'helps' : with_ < without - 0.1 ? 'hurts' : 'little effect');
  if (!p && !ds.length && !res.kelly) return null;
  return (
    <div className="bb2-measured">
      <div className="pro-section">MEASURED ON THE DATA — HOW THE PICKS ACTUALLY WORKED TOGETHER (UNSEEN 30 %)</div>
      {p && p.rules.length > 1 && (
        <table className="pro-table compact">
          <thead>
            <tr>
              <th className="l">STRATEGY</th>
              <th>RETURN A YEAR</th>
              <th>SHARPE</th>
              <th>TRADES</th>
              <th>WORST DROP</th>
            </tr>
          </thead>
          <tbody>
            {p.rules.map((r) => (
              <tr key={r.id}>
                <td className="l">{STRATEGIES.find((s) => s.signal === r.id)?.name ?? r.name} — alone</td>
                <td className={`mono ${r.oos.cagr >= 0 ? 'up' : 'down'}`}>{pct(r.oos.cagr)}</td>
                <td className="mono">{num(r.oos.sharpe)}</td>
                <td className="mono">{r.oos.trades}</td>
                <td className="mono down">{pct(-r.oos.maxDD)}</td>
              </tr>
            ))}
            <tr className="bb2-together">
              <td className="l b">Together ({COMBINES.find((x) => x.id === c.combine)!.name.toLowerCase()})</td>
              <td className={`mono ${res.oos.cagr >= 0 ? 'up' : 'down'}`}>{pct(res.oos.cagr)}</td>
              <td className="mono b">{num(res.oos.sharpe)}</td>
              <td className="mono">{res.oos.trades}</td>
              <td className="mono down">{pct(-res.oos.maxDD)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {p?.pairs.map((x) => {
        const a = p.rules[x.a] ?? { name: '' };
        const b = p.rules[x.b] ?? { name: '' };
        const na = STRATEGIES.find((s) => s.signal === (a as { id?: string }).id)?.name ?? a.name;
        const nb = STRATEGIES.find((s) => s.signal === (b as { id?: string }).id)?.name ?? b.name;
        const tone = x.verdict === 'clash' ? 'clash' : x.verdict === 'redundant' ? 'overlap' : 'pair';
        return (
          <div key={`${x.a}-${x.b}`} className={`bb2-finding ${tone}`}>
            <b>{TONE_MARK[tone]}</b>
            <span>
              <em>
                {na} × {nb}:
              </em>{' '}
              {pairWords(x.verdict, x.corr, x.agree)}
            </span>
          </div>
        );
      })}
      {p && p.filters.length > 0 && (
        <table className="pro-table compact">
          <thead>
            <tr>
              <th className="l">FILTER</th>
              <th title="Share of the unseen candles it let the bot trade">LETS IT TRADE</th>
              <th>SHARPE WITHOUT IT</th>
              <th>WITH IT</th>
              <th className="l">VERDICT</th>
            </tr>
          </thead>
          <tbody>
            {p.filters.map((f, i) => {
              const h = help(res.oos.sharpe, f.without.sharpe);
              return (
                <tr key={`${f.id}${i}`}>
                  <td className="l">{f.name}</td>
                  <td className="mono">{pct(f.pass, 0)}</td>
                  <td className="mono">{num(f.without.sharpe)}</td>
                  <td className="mono">{num(res.oos.sharpe)}</td>
                  <td className={`l ${h === 'helps' ? 'up' : h === 'hurts' ? 'down' : 'muted'}`}>{h}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {ds.length > 0 && res.meta && (
        <>
          <table className="pro-table compact">
            <thead>
              <tr>
                <th className="l">AI DECISION MAKER</th>
                <th>SHARPE WITHOUT</th>
                <th>WITH IT</th>
                <th>TRADES KEPT</th>
                <th className="l" />
              </tr>
            </thead>
            <tbody>
              {ds.map((d) => (
                <tr key={d.kind} className={d.kind === res.meta!.kind ? 'bb2-together' : ''}>
                  <td className="l">{d.kind === 'forest' ? 'Decision forest' : d.kind === 'nn' ? 'Neural network' : 'Both paired'}</td>
                  <td className="mono">{num(d.before)}</td>
                  <td className={`mono ${d.after > d.before ? 'up' : 'down'}`}>{num(d.after)}</td>
                  <td className="mono">{d.trades}</td>
                  <td className="l">{d.kind === res.meta!.kind ? (res.meta!.used ? '✓ your pick — kept' : 'your pick — dropped (did not help)') : 'for comparison'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="lab-line muted">The decision makers learned from {res.meta.trainedOn} trades in the first 70 %. Only your pick can be kept, and only if it lifted the unseen-data Sharpe — the others are shown for comparison, not chosen after the fact.</div>
        </>
      )}
      {res.meta && !ds.length && <div className="lab-line">AI decision maker: not enough past trades to learn from ({res.meta.trainedOn} — it needs 40).</div>}
      {res.kelly && (
        <div className="lab-line">
          Kelly: {res.kelly.f > 0 ? `the training years’ trades say risk ${pct(res.kelly.f)} of the account per trade for the fastest growth; half of that, ${pct(res.kelly.target, 2)}, was used.` : `the training years’ trades show no edge (Kelly ${pct(res.kelly.f)}), so the smallest size — ${pct(res.kelly.target, 2)} a trade — was used.`}
        </div>
      )}
      {res.spec?.coinWeights && (
        <div className="lab-line">
          Split ({PORTFOLIOS.find((x) => x.id === c.portfolio)?.name.toLowerCase()}): {Object.entries(res.spec.coinWeights).map(([k, w]) => `${k} ${pct(w, 0)}`).join(' · ')}
        </div>
      )}
    </div>
  );
}
