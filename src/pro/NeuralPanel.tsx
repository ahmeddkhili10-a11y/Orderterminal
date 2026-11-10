// NNET — the neural-network lab on the QUANT desk.
//
// Train a small neural network (two hidden layers) on a coin's candles to
// forecast whether price is higher a few candles from now, watch it learn
// (the loss falls epoch by epoch; it stops when the latest training data stops
// improving), then judge it on the last 30 % of candles it never saw — next to
// a random forest trained on the same inputs, and the two paired (their odds
// averaged). The same network is in the Strategy Lab as a rule, a second
// opinion and an AI trade filter; the bot builder offers all three.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { VenueId } from '../core/types';
import { ADAPTERS } from '../exchanges';
import { ctxOf, features, FEATURES, type Market } from '../lab/library';
import { fitForest, mlpImportance, mlpTrainer, predictForest, predictMLP, type ForestModel, type MLP } from '../lab/ml';
import { useSettings } from '../store/settings';
import { Check, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';
import { Bars, LineChart } from './charts';
import { USES } from './botUses';
import { UseInBot } from './UseInBot';
import { BOARD_VENUES, useBoardVenue, useKlines } from './data';

export interface NeuralConfig {
  venue: VenueId | 'auto';
  coin: string;
  tf: '1h' | '4h' | '1d';
  /** forecast this many candles ahead */
  ahead: number;
  size: 'small' | 'medium' | 'large';
  explain: boolean;
}
export const NEURAL_DEFAULTS: NeuralConfig = { venue: 'auto', coin: '', tf: '4h', ahead: 6, size: 'medium', explain: true };

const SIZES: Record<NeuralConfig['size'], { hidden: [number, number]; label: string }> = {
  small: { hidden: [8, 4], label: 'Small (8 → 4)' },
  medium: { hidden: [16, 8], label: 'Medium (16 → 8)' },
  large: { hidden: [32, 16], label: 'Large (32 → 16)' },
};
const TF_H: Record<NeuralConfig['tf'], number> = { '1h': 1, '4h': 4, '1d': 24 };
const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');

/** what each input means, in plain words */
const PLAIN: Record<string, string> = {
  'ret 1h': 'last hour’s move',
  'ret 4h': 'last 4 hours’ move',
  'ret 1d': 'last day’s move',
  'ret 1w': 'last week’s move',
  'price / 1w MA': 'price against its weekly average',
  'RSI 14': 'RSI (overbought / oversold)',
  'ADX 14': 'trend strength (ADX)',
  'vol 1d / vol 30d': 'today’s jumpiness against the month’s',
  'volume z': 'volume against normal',
  'hour (sin)': 'time of day',
  'hour (cos)': 'time of day',
  weekday: 'day of the week',
  'funding (a year)': 'funding rate',
  'GARCH σ next bar': 'GARCH volatility forecast',
  'GARCH σ / long run': 'volatility against its long-run level',
  body: 'candle body size',
  'upper wick': 'upper wick',
  'lower wick': 'lower wick',
  'close location': 'where the candle closed in its range',
  'range / ATR': 'candle size against normal',
  'gap / ATR': 'gap from the last close',
  'candle run': 'candles in a row the same colour',
  engulfing: 'engulfing pattern',
  doji: 'doji (indecision)',
  'hammer / star': 'hammer / shooting star',
  'Kalman slope t': 'Kalman trend strength',
  'OU s-score (1w)': 'stretch from fair value (OU)',
  'variance ratio (2w)': 'do moves keep going? (variance ratio)',
  'P(turbulent regime)': 'odds of a stormy market (HMM)',
  'Yang–Zhang / GARCH σ': 'measured against forecast volatility',
};

interface Data {
  X: number[][];
  y: number[];
  /** the bar index of each row and of the split */
  idx: number[];
  split: number;
  /** the return from each row's close to `ahead` candles later */
  fwd: number[];
  last: number[] | null;
  closes: number[];
}

function prepare(m: Market, ahead: number): Data | null {
  const n = m.bars.length;
  if (n < 400) return null;
  const trainEnd = Math.floor(n * 0.7);
  const c = ctxOf(m, trainEnd, 7);
  const F = features(c);
  const X: number[][] = [];
  const y: number[] = [];
  const idx: number[] = [];
  const fwd: number[] = [];
  for (let i = 0; i + ahead < n; i++) {
    const r = Array.from(F[i]);
    if (!r.every(Number.isFinite)) continue;
    const f = m.bars[i + ahead].close / m.bars[i].close - 1;
    X.push(r);
    y.push(f > 0 ? 1 : 0);
    idx.push(i);
    fwd.push(f);
  }
  const lastRow = Array.from(F[n - 1]);
  const split = idx.findIndex((i) => i + ahead >= trainEnd);
  if (split < 150 || X.length - split < 40) return null;
  return { X, y, idx, split, fwd, last: lastRow.every(Number.isFinite) ? lastRow : null, closes: m.bars.map((b) => b.close) };
}

interface Judged {
  acc: number;
  /** trading only the confident calls on the unseen candles */
  calls: number;
  hit: number;
  ret: number;
  curve: number[];
}

function judge(d: Data, p: (row: number[]) => number, edge: number, ahead: number): Judged {
  let right = 0;
  let calls = 0;
  let hits = 0;
  let eq = 1;
  const curve: number[] = [];
  const n = d.X.length - d.split;
  // the confident calls, each held for the forecast horizon, one at a time (no overlapping bets); 0.13 % costs a round trip
  let freeAt = -1;
  for (let k = d.split; k < d.X.length; k++) {
    const q = p(d.X[k]);
    if (q >= 0.5 === (d.y[k] === 1)) right++;
    if (d.idx[k] >= freeAt && Math.abs(q - 0.5) > edge) {
      const side = q > 0.5 ? 1 : -1;
      calls++;
      if (side * d.fwd[k] > 0) hits++;
      eq *= 1 + side * d.fwd[k] - 0.0013;
      freeAt = d.idx[k] + ahead;
    }
    curve.push(eq);
  }
  return { acc: n ? right / n : NaN, calls, hit: calls ? hits / calls : NaN, ret: eq - 1, curve };
}

export function NeuralPanel({ config: c, setConfig }: PanelProps<NeuralConfig>) {
  const board = useBoardVenue();
  const venue = c.venue === 'auto' ? board : c.venue;
  const base = useSettings((s) => s.base);
  const coin = (c.coin || base || 'BTC').toUpperCase();
  const k = useKlines(venue, [coin], c.tf, 1000);
  const kl = k.data[coin];
  const data = useMemo(() => {
    if (!kl || kl.length < 400) return null;
    const m: Market = { coin, tfH: TF_H[c.tf], bars: kl.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })), funding: null };
    return prepare(m, c.ahead);
  }, [kl, c.tf, c.ahead, coin]);
  const [epoch, setEpoch] = useState(0);
  const [loss, setLoss] = useState<{ tr: number[]; va: number[] }>({ tr: [], va: [] });
  const [model, setModel] = useState<MLP | null>(null);
  const [forest, setForest] = useState<ForestModel | null>(null);
  const [training, setTraining] = useState(false);
  const stop = useRef(false);
  // a new coin, timeframe, horizon or size: the old network no longer applies
  useEffect(() => {
    stop.current = true;
    setModel(null);
    setForest(null);
    setLoss({ tr: [], va: [] });
    setEpoch(0);
    setTraining(false);
  }, [data, c.size]);
  useEffect(() => () => void (stop.current = true), []);

  const train = () => {
    if (!data) return;
    stop.current = false;
    setTraining(true);
    setModel(null);
    setForest(null);
    const Xtr = data.X.slice(0, data.split);
    const ytr = data.y.slice(0, data.split);
    const t = mlpTrainer(Xtr, ytr, { hidden: SIZES[c.size].hidden, epochs: 120, patience: 12, l2: 1e-3, seed: 11 });
    // one epoch a frame, so the loss is drawn as it falls and the terminal stays smooth
    const tick = () => {
      if (stop.current) return;
      const done = t.step();
      const r = t.result();
      setEpoch(t.epoch);
      setLoss({ tr: r.trainLoss, va: r.valLoss });
      if (done) {
        setModel(r);
        setForest(fitForest(Xtr, ytr, { trees: 60, maxDepth: 5, minLeaf: 20, seed: 11 }));
        setTraining(false);
      } else setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
  };

  const res = useMemo(() => {
    if (!data || !model || !forest) return null;
    const edge = 0.04;
    const nn = judge(data, (r) => predictMLP(model, r), edge, c.ahead);
    const rf = judge(data, (r) => predictForest(forest, r), edge, c.ahead);
    const both = judge(data, (r) => (predictMLP(model, r) + predictForest(forest, r)) / 2, edge, c.ahead);
    const up = data.y.slice(data.split).reduce((a, b) => a + b, 0) / (data.X.length - data.split);
    const baseRate = Math.max(up, 1 - up);
    const first = data.closes[data.idx[data.split]];
    const lastC = data.closes[data.closes.length - 1];
    const bh = lastC / first - 1;
    // calibration: when it says x %, how often was it right?
    const bins = [0.35, 0.45, 0.5, 0.55, 0.65].map((lo, i, a) => ({ lo, hi: a[i + 1] ?? 1, n: 0, up: 0 }));
    bins.unshift({ lo: 0, hi: 0.35, n: 0, up: 0 });
    for (let k = data.split; k < data.X.length; k++) {
      const q = predictMLP(model, data.X[k]);
      const b = bins.find((x) => q >= x.lo && q < x.hi);
      if (b) {
        b.n++;
        b.up += data.y[k];
      }
    }
    const imp = mlpImportance(model, data.X.slice(data.split), data.y.slice(data.split));
    const top = imp
      .map((v, j) => ({ name: FEATURES[j], v }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 8);
    const now = data.last ? { nn: predictMLP(model, data.last), rf: predictForest(forest, data.last) } : null;
    return { nn, rf, both, baseRate, bh, bins, top, now };
  }, [data, model, forest, c.ahead]);

  const hrs = c.ahead * TF_H[c.tf];
  const horizon = hrs >= 48 ? `${Math.round(hrs / 24)} days` : `${hrs} hours`;
  const verdict = (j: Judged) => (j.acc > (res?.baseRate ?? 1) + 0.02 ? 'up' : j.acc < (res?.baseRate ?? 0) - 0.01 ? 'down' : '');
  return (
    <div className="pro-panel nn-panel">
      <Toolbar>
        <input className="ctl mono" value={c.coin || coin} onChange={(e) => setConfig({ coin: e.target.value.toUpperCase().trim() })} style={{ width: 64 }} title="Coin" />
        <Select value={c.tf} options={[{ value: '1h' as const, label: '1-hour candles' }, { value: '4h' as const, label: '4-hour candles' }, { value: '1d' as const, label: 'Daily candles' }]} onChange={(tf) => setConfig({ tf })} />
        <Select value={c.ahead} options={[1, 3, 6, 12, 24].map((v) => ({ value: v, label: `forecast ${v} candle${v > 1 ? 's' : ''} ahead` }))} onChange={(ahead) => setConfig({ ahead })} />
        <Select value={c.size} options={(Object.keys(SIZES) as NeuralConfig['size'][]).map((v) => ({ value: v, label: SIZES[v].label }))} onChange={(size) => setConfig({ size })} />
        <Select value={c.venue} options={[{ value: 'auto' as const, label: 'Primary venue' }, ...BOARD_VENUES.map((v) => ({ value: v, label: ADAPTERS[v].name }))]} onChange={(venue) => setConfig({ venue })} />
        <button className="btn nn-train" disabled={!data || training} onClick={train}>
          {training ? `Training… epoch ${epoch}` : model ? '↻ Retrain' : '▶ Train the network'}
        </button>
        <UseInBot from="NNET" options={USES.nnet({ coin, tfH: TF_H[c.tf], ahead: c.ahead, hidden: SIZES[c.size].hidden })} title="Run this network inside a strategy: as the bot’s strategy, a second opinion, or its decision maker — with this size, horizon and candle" />
        <Spacer />
        <Check checked={c.explain} onChange={(explain) => setConfig({ explain })}>
          Explain
        </Check>
      </Toolbar>
      <div className="pro-scroll">
        {!data ? (
          <div className="pro-empty">{k.loading ? 'Loading candles…' : k.errors[coin] ? `No candles for ${coin}: ${k.errors[coin]}` : 'Not enough candles to train on (needs 400).'}</div>
        ) : (
          <>
            {c.explain && (
              <div className="lab-note">
                A neural network reads {FEATURES.length} market readings at each candle (moves, volatility, volume, candle shapes, trend and regime models) and learns the odds that {coin} is higher {horizon} later. It trains on the first 70 % of {data.closes.length} candles — the last part of those held back to tell it when to stop learning — and is then judged on the final 30 % it never saw, next to a random forest trained on the same readings, and the two paired.
              </div>
            )}
            <div className="pro-section">LEARNING — THE ERROR FALLING, EPOCH BY EPOCH (LOWER IS BETTER; IT STOPS WHEN THE HELD-BACK DATA STOPS IMPROVING)</div>
            {loss.tr.length ? (
              <LineChart
                height={140}
                log={false}
                marker={model ? model.best - 1 : undefined}
                format={(v) => v.toFixed(3)}
                series={[
                  { values: loss.tr, color: 'var(--pro-head, #ffd200)', width: 1.6 },
                  { values: loss.va, color: '#4f8ff0', width: 1.6 },
                ]}
                labels={
                  <>
                    <span style={{ color: 'var(--pro-head, #ffd200)' }}>training data</span> · <span style={{ color: '#4f8ff0' }}>held-back data</span>
                    {model ? ` · kept the network from epoch ${model.best} (the dashed line)` : ''}
                  </>
                }
              />
            ) : (
              <div className="pro-empty">Press ▶ Train the network.</div>
            )}
            {res && model && (
              <>
                {res.now && (
                  <div className={`bb-verdict t-${Math.abs(res.now.nn - 0.5) < 0.04 ? 'ok' : res.now.nn > 0.5 ? 'good' : 'bad'}`}>
                    <b>Now:</b> the network gives {coin} a {pct(res.now.nn, 0)} chance of being higher in {horizon} · the forest {pct(res.now.rf, 0)} · paired {pct((res.now.nn + res.now.rf) / 2, 0)}.{' '}
                    {Math.abs(res.now.nn - 0.5) < 0.04 ? 'Close to a coin flip — no call.' : 'Only a forecast: read it with how it did on unseen data below.'}
                  </div>
                )}
                <div className="pro-section">ON THE 30 % IT NEVER SAW</div>
                <table className="pro-table">
                  <thead>
                    <tr>
                      <th className="l">MODEL</th>
                      <th title="Share of candles where it called the direction right">RIGHT</th>
                      <th title="Always guessing the more common direction">GUESSING</th>
                      <th title="Confident calls only (odds beyond 54 % or under 46 %), one at a time">CALLS</th>
                      <th>HIT RATE</th>
                      <th title="Trading only the confident calls, after costs">RETURN</th>
                      <th>BUY &amp; HOLD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ['Neural network', res.nn],
                        ['Random forest', res.rf],
                        ['Both paired', res.both],
                      ] as const
                    ).map(([name, j]) => (
                      <tr key={name}>
                        <td className="l b">{name}</td>
                        <td className={`mono ${verdict(j)}`}>{pct(j.acc)}</td>
                        <td className="mono muted">{pct(res.baseRate)}</td>
                        <td className="mono">{j.calls}</td>
                        <td className="mono">{pct(j.hit, 0)}</td>
                        <td className={`mono ${j.ret >= 0 ? 'up' : 'down'}`}>{pct(j.ret)}</td>
                        <td className={`mono ${res.bh >= 0 ? 'up' : 'down'}`}>{pct(res.bh)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {c.explain && (
                  <div className="lab-line muted">
                    “Right” must beat “guessing” to mean anything — markets are close to a coin flip, so a couple of points above it is already a real edge, and below it means the model learned noise. 1,000 candles is a short history for a network; the bot builder (BOT) tests the same network on years of data.
                  </div>
                )}
                <div className="pro-section">THE CONFIDENT CALLS AS A TRADING RECORD (UNSEEN DATA)</div>
                <LineChart
                  height={130}
                  series={[
                    { values: res.rf.curve, color: '#2cf0b0', width: 1.1 },
                    { values: res.both.curve, color: '#c0508a', width: 1.1 },
                    { values: res.nn.curve, color: 'var(--pro-head, #ffd200)', width: 1.7 },
                  ]}
                  labels={
                    <>
                      <span style={{ color: 'var(--pro-head, #ffd200)' }}>network</span> · <span style={{ color: '#2cf0b0' }}>forest</span> · <span style={{ color: '#c0508a' }}>both paired</span>
                    </>
                  }
                />
                <div className="nn-cols">
                  <div>
                    <div className="pro-section">WHAT IT LOOKS AT MOST</div>
                    <Bars rows={res.top.map((t) => ({ label: PLAIN[t.name] ?? t.name, value: t.v, tone: 'up' as const }))} format={(v) => pct(v, 0)} />
                  </div>
                  <div>
                    <div className="pro-section">WHEN IT SAYS X %, HOW OFTEN WAS IT UP?</div>
                    <table className="pro-table compact">
                      <thead>
                        <tr>
                          <th className="l">IT SAID</th>
                          <th>TIMES</th>
                          <th>WAS UP</th>
                        </tr>
                      </thead>
                      <tbody>
                        {res.bins.map((b) => (
                          <tr key={b.lo}>
                            <td className="l mono">
                              {pct(b.lo, 0)}–{pct(b.hi, 0)}
                            </td>
                            <td className="mono">{b.n}</td>
                            <td className="mono">{b.n ? pct(b.up / b.n, 0) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="lab-line muted">
                  Network: {FEATURES.length} inputs → {SIZES[c.size].hidden.join(' → ')} hidden units (tanh) → odds (sigmoid); Adam, L2 penalty, early stopping on the latest training data; kept epoch {model.best} of {model.trainLoss.length}. To run this network inside a strategy, press “⇢ Use in a bot” above: it goes into the bot builder with this size, horizon and candle — as the bot’s strategy, a second opinion, or its decision maker. The Lab then fits it on the training years only and judges the whole bot on data it never saw.
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
