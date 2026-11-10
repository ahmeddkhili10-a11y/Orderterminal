// Three Quant desk functions for finding and sizing an edge:
//
//   PAIR  pairs and cointegration — which coins are tied to bitcoin (or to
//         each other), the hedge ratio, whether the gap between them keeps
//         closing (Engle–Granger), how fast, where the gap stands now, and
//         who moves first
//   SEAS  seasonality — the average return by hour of the day and by weekday,
//         each with its t-statistic, on a year of hourly candles
//   MC    Monte Carlo on a strategy's trades — the account's possible paths,
//         drawdowns, losing streaks and the odds of ruin, by risk per trade
//
// PAIR and SEAS send what they find into the bot builder ("Use in a bot");
// MC takes the bot builder's last test the other way.
import { useEffect, useMemo, useState } from 'react';
import type { Kline, VenueId } from '../core/types';
import { desktop } from '../desktop/bridge';
import { ADAPTERS } from '../exchanges';
import { cointegration, EG_CRIT, kellyBet, leadLag, ruinSim, seasonality, tradesFrom } from '../lab/quant';
import { useSettings } from '../store/settings';
import { NumberInput, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';
import { Bars, Fan, LineChart } from './charts';
import { USES } from './botUses';
import { BOARD_VENUES, useBoardVenue, useKlines } from './data';
import { UseInBot } from './UseInBot';

const venueOpts = () => [{ value: 'auto' as const, label: 'Primary venue' }, ...BOARD_VENUES.map((v) => ({ value: v, label: ADAPTERS[v].name }))];
const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const coinsOf = (s: string) => s.toUpperCase().split(/[\s,]+/).filter(Boolean).slice(0, 12);
const TF_H = { '1h': 1, '4h': 4, '1d': 24 } as const;
const span = (bars: number, tfH: number) => {
  const h = bars * tfH;
  return !Number.isFinite(h) ? 'never' : h >= 72 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(h < 10 ? 1 : 0)} hours`;
};

function CoinsInput({ value, onCommit, width = 260 }: { value: string; onCommit: (v: string) => void; width?: number }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return <input className="ctl mono" value={text} onChange={(e) => setText(e.target.value.toUpperCase())} onBlur={() => onCommit(text)} onKeyDown={(e) => e.key === 'Enter' && onCommit(text)} style={{ width }} title="Coins, separated by spaces" />;
}

// ======================================================================
// PAIR — pairs and cointegration
// ======================================================================

export interface PairConfig {
  venue: VenueId | 'auto';
  coins: string;
  /** the other side of every pair */
  against: string;
  tf: '1h' | '4h' | '1d';
  /** the pairs rule's window, in hours, and its entry threshold in standard deviations */
  window: number;
  k: number;
  sel: string;
}
export const PAIR_DEFAULTS: PairConfig = { venue: 'auto', coins: 'ETH SOL BNB XRP DOGE AVAX LINK ADA', against: 'BTC', tf: '1h', window: 168, k: 2, sel: '' };

/** two coins' log prices on the candles both have */
function alignedLogs(a: Kline[] | undefined, b: Kline[] | undefined): { y: number[]; x: number[]; t: number[] } | null {
  if (!a?.length || !b?.length) return null;
  const at = new Map(b.map((k) => [k.time, k.close]));
  const y: number[] = [];
  const x: number[] = [];
  const t: number[] = [];
  for (const k of a) {
    const o = at.get(k.time);
    if (o && o > 0 && k.close > 0) {
      y.push(Math.log(k.close));
      x.push(Math.log(o));
      t.push(k.time);
    }
  }
  return y.length >= 100 ? { y, x, t } : null;
}
const diffs = (v: number[]) => v.slice(1).map((p, i) => p - v[i]);

export function PairPanel({ config: c, setConfig }: PanelProps<PairConfig>) {
  const board = useBoardVenue();
  const venue = c.venue === 'auto' ? board : c.venue;
  const against = (c.against || 'BTC').toUpperCase();
  const coins = coinsOf(c.coins).filter((x) => x !== against);
  const tfH = TF_H[c.tf];
  const k = useKlines(venue, [against, ...coins], c.tf, 1000);
  const rows = useMemo(
    () =>
      coins
        .map((coin) => {
          const al = alignedLogs(k.data[coin], k.data[against]);
          if (!al) return null;
          const all = cointegration(al.y, al.x);
          // the rule's own reading: the same fit over its window only
          const w = Math.max(30, Math.round(c.window / tfH));
          const recent = al.y.length > w ? cointegration(al.y.slice(-w), al.x.slice(-w)) : null;
          if (!all) return null;
          return { coin, n: al.y.length, all, recent, al };
        })
        .filter((r): r is NonNullable<typeof r> => !!r),
    [k.data, coins.join(), against, c.window, tfH],
  );
  const pick = rows.find((r) => r.coin === c.sel) ?? rows[0];
  const lags = useMemo(() => (pick ? leadLag(diffs(pick.al.x), diffs(pick.al.y), 5) : []), [pick]);
  const peak = lags.filter((l) => l.lag !== 0 && Number.isFinite(l.corr)).sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr))[0];
  const zNow = pick?.recent?.z ?? NaN;
  const call = !pick?.recent ? '' : zNow < -c.k ? `${pick.coin} is ${num(-zNow, 1)} standard deviations cheap against ${against}: the pairs rule would buy ${pick.coin} and sell ${against}.` : zNow > c.k ? `${pick.coin} is ${num(zNow, 1)} standard deviations rich against ${against}: the pairs rule would sell ${pick.coin} and buy ${against}.` : `The gap is ${num(Math.abs(zNow), 1)} standard deviations ${zNow < 0 ? 'cheap' : 'rich'} — inside ±${c.k}: no trade.`;
  const verdict = (lv: 1 | 5 | 10 | null) => (lv === 1 ? 'tied (1 % level)' : lv === 5 ? 'tied (5 % level)' : lv === 10 ? 'weakly tied (10 %)' : 'not tied');
  return (
    <div className="pro-panel pair-panel">
      <Toolbar>
        <CoinsInput value={c.coins} onCommit={(coins) => setConfig({ coins })} />
        <span className="pro-status">against</span>
        <input className="ctl mono" value={against} onChange={(e) => setConfig({ against: e.target.value.toUpperCase().trim() })} style={{ width: 56 }} title="The other side of every pair" />
        <Select value={c.tf} options={[{ value: '1h' as const, label: '1-hour candles' }, { value: '4h' as const, label: '4-hour candles' }, { value: '1d' as const, label: 'Daily candles' }]} onChange={(tf) => setConfig({ tf })} />
        <Select value={c.window} options={[72, 168, 336, 720].map((v) => ({ value: v, label: `${v >= 48 ? `${v / 24}-day` : `${v}-hour`} window` }))} onChange={(window) => setConfig({ window })} />
        <NumberInput value={c.k} step={0.25} min={0.5} width={56} onChange={(k2) => setConfig({ k: Math.min(4, k2) })} title="Enter when the gap is this many standard deviations wide" suffix="σ" />
        <Select value={c.venue} options={venueOpts()} onChange={(venue) => setConfig({ venue })} />
        {pick && against === 'BTC' && <UseInBot from="PAIR" options={USES.pair({ coin: pick.coin, windowH: c.window, k: c.k, tfH })} />}
        <Spacer />
        <span className="pro-status">{k.loading ? 'loading…' : 'Engle & Granger (1987); Gatev, Goetzmann & Rouwenhorst (2006); Fil & Kristoufek (2020)'}</span>
      </Toolbar>
      <div className="pro-scroll">
        {!rows.length ? (
          <div className="pro-empty">{k.loading ? 'Loading candles…' : `Not enough candles shared with ${against}.`}</div>
        ) : (
          <>
            <div className="pro-section">
              WHICH COINS ARE TIED TO {against}? — {rows[0].n} {c.tf.toUpperCase()} CANDLES · CLICK A ROW
            </div>
            <table className="pro-table pair-table">
              <thead>
                <tr>
                  <th className="l">COIN</th>
                  <th title={`How much of the coin's moves ${against}'s moves explain`}>R²</th>
                  <th title={`The hedge ratio: the % the coin tends to move for 1 % in ${against}`}>BETA</th>
                  <th title={`The Engle–Granger test: below ${EG_CRIT[5]} the gap between the two keeps closing (5 % level); below ${EG_CRIT[1]}, at the 1 % level`}>ADF</th>
                  <th className="l">TIED?</th>
                  <th title="How long half of a gap takes to close">HALF-LIFE</th>
                  <th title={`The gap now, in standard deviations, over the ${c.window}-hour window the pairs rule uses`}>GAP NOW</th>
                  <th className="l">THE PAIRS RULE</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const z = r.recent?.z ?? NaN;
                  return (
                    <tr key={r.coin} className={pick?.coin === r.coin ? 'sel' : ''} onClick={() => setConfig({ sel: r.coin })}>
                      <td className="l b">{r.coin}</td>
                      <td className="mono">{num(r.all.r2)}</td>
                      <td className="mono">{num(r.all.beta)}</td>
                      <td className={`mono ${r.all.level ? 'up' : 'muted'}`}>{num(r.all.adf)}</td>
                      <td className={`l ${r.all.level && r.all.level <= 5 ? 'up' : 'muted'}`}>{verdict(r.all.level)}</td>
                      <td className="mono">{span(r.all.halfLife, tfH)}</td>
                      <td className={`mono b ${z < -c.k ? 'up' : z > c.k ? 'down' : ''}`}>{Number.isFinite(z) ? `${z > 0 ? '+' : ''}${num(z, 1)}σ` : '—'}</td>
                      <td className="l muted">{!Number.isFinite(z) ? '—' : z < -c.k ? `buy ${r.coin}, sell ${against}` : z > c.k ? `sell ${r.coin}, buy ${against}` : 'no trade'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {pick && (
              <>
                <div className="pro-section">
                  {pick.coin} AGAINST {against} — THE GAP BETWEEN THEM, IN STANDARD DEVIATIONS ({pick.n} CANDLES)
                </div>
                <LineChart
                  log={false}
                  height={170}
                  format={(v) => `${v.toFixed(1)}σ`}
                  series={[
                    { values: pick.all.resid.map((e) => e / (pick.all.sd || 1)), color: 'var(--pro-head, #ffd200)', width: 1.4 },
                    { values: pick.all.resid.map(() => c.k), color: 'var(--sell)', width: 1, dash: '4 4' },
                    { values: pick.all.resid.map(() => -c.k), color: 'var(--buy)', width: 1, dash: '4 4' },
                    { values: pick.all.resid.map(() => 0), color: 'var(--muted)', width: 1, dash: '2 5' },
                  ]}
                  labels={
                    <>
                      above the red line {pick.coin} is rich against {against}, below the green line cheap · {pick.coin} = {num(Math.exp(pick.all.alpha), 4)} × {against}
                      <sup>{num(pick.all.beta)}</sup>
                    </>
                  }
                />
                <div className="lab-line">
                  <b>Now:</b> {call}
                </div>
                <div className="lab-grid2">
                  <div>
                    <div className="pro-section">IS THE GAP REAL? — THE ENGLE–GRANGER TEST</div>
                    <div className="lab-kv mono">
                      <span>ADF {num(pick.all.adf)}</span>
                      <span>needs under {EG_CRIT[5]} (5 %) · {EG_CRIT[1]} (1 %)</span>
                      <span className={pick.all.level && pick.all.level <= 5 ? 'up' : 'down'}>{verdict(pick.all.level)}</span>
                    </div>
                    <div className="lab-line muted">
                      {pick.all.level && pick.all.level <= 5
                        ? `Over these candles the gap between ${pick.coin} and ${against} kept closing — half of a gap in about ${span(pick.all.halfLife, tfH)}. A pairs trade has something to lean on; the stop still matters, because ties between coins break.`
                        : `Over these candles the gap did not reliably close: the two wander apart for long stretches. A pairs trade here is a bet on a tie the data does not show — try another coin, shorter candles (the effect is strongest intraday), or leave it.`}
                    </div>
                  </div>
                  <div>
                    <div className="pro-section">
                      WHO MOVES FIRST? — {against}’S MOVE AGAINST {pick.coin}’S, A FEW CANDLES APART
                    </div>
                    <Bars rows={lags.map((l) => ({ label: l.lag === 0 ? 'same candle' : l.lag > 0 ? `${against} ${l.lag} earlier` : `${pick.coin} ${-l.lag} earlier`, value: Number.isFinite(l.corr) ? l.corr : 0 }))} max={1} format={(v) => v.toFixed(2)} />
                    <div className="lab-line muted">
                      {peak && Math.abs(peak.corr) > 3 / Math.sqrt(pick.n)
                        ? `${peak.lag > 0 ? against : pick.coin} tends to move ${Math.abs(peak.lag)} candle${Math.abs(peak.lag) > 1 ? 's' : ''} before ${peak.lag > 0 ? pick.coin : against} (correlation ${num(peak.corr)}) — small, as leads at this candle size are; the “bitcoin leads” rule tests whether it pays after costs.`
                        : `No lead worth trading at this candle size: the two move within the same candle. Published leads last minutes, not hours.`}
                    </div>
                  </div>
                </div>
              </>
            )}
            <div className="lab-line muted">
              Two coins are “tied” (cointegrated) when a mix of them — one coin less beta times the other — keeps returning to its average, however far each wanders alone. The test is stricter than an ordinary one because the mix was chosen to look stable. In crypto, pairs reverted on 5-minute and hourly candles and not on daily ones (Fil &amp; Kristoufek 2020). “Use in a bot” sends this coin, window and threshold to the bot builder as a hedged pairs trade; the Strategy Lab then tests it on data it never saw.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ======================================================================
// SEAS — seasonality: hour of the day, day of the week
// ======================================================================

export interface SeasonConfig {
  venue: VenueId | 'auto';
  coin: string;
  /** the hour picked on the map (UTC), or −1 */
  hour: number;
}
export const SEASON_DEFAULTS: SeasonConfig = { venue: 'auto', coin: '', hour: -1 };

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
type Bar = { time: number; open: number; close: number };

export function SeasonPanel({ config: c, setConfig }: PanelProps<SeasonConfig>) {
  const board = useBoardVenue();
  const venue = c.venue === 'auto' ? board : c.venue;
  const base = useSettings((s) => s.base);
  const coin = (c.coin || base || 'BTC').toUpperCase();
  // a year of hourly candles from the Lab's history (desktop); the exchange's last 1,000 otherwise
  const k = useKlines(venue, [coin], '1h', 1000);
  const [long, setLong] = useState<{ coin: string; bars: Bar[]; source: string } | null>(null);
  const [longErr, setLongErr] = useState('');
  useEffect(() => {
    let alive = true;
    setLongErr('');
    if (!desktop?.lab?.bars) return;
    desktop.lab
      .bars(coin, '1h', 1)
      .then((r) => alive && setLong({ coin, bars: r.bars, source: r.source }))
      .catch((e) => alive && setLongErr(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [coin]);
  const bars: Bar[] = long?.coin === coin && long.bars.length > 1000 ? long.bars : (k.data[coin] ?? []);
  const res = useMemo(() => {
    if (bars.length < 400) return null;
    const s = seasonality(bars.map((b) => b.time), bars.map((b) => Math.log(b.close / b.open)));
    const scale = Math.max(1e-9, ...s.grid.flat().filter(Number.isFinite).map(Math.abs));
    const best = s.hours.map((h, i) => ({ ...h, hour: i })).filter((h) => Number.isFinite(h.t)).sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
    return { s, scale, best, days: (bars[bars.length - 1].time - bars[0].time) / 86_400_000 };
  }, [bars]);
  const hour = c.hour >= 0 && c.hour < 24 ? c.hour : null;
  const cell = (v: number, scale: number) => (Number.isFinite(v) ? `color-mix(in srgb, ${v >= 0 ? 'var(--buy)' : 'var(--sell)'} ${Math.round(Math.min(1, Math.abs(v) / scale) * 85)}%, transparent)` : 'transparent');
  const standing = res ? res.best.filter((h) => Math.abs(h.t) > res.s.tBar) : [];
  const evening = res ? res.s.hours[21].mean + res.s.hours[22].mean : NaN;
  return (
    <div className="pro-panel seas-panel">
      <Toolbar>
        <input className="ctl mono" value={c.coin || coin} onChange={(e) => setConfig({ coin: e.target.value.toUpperCase().trim() })} style={{ width: 64 }} title="Coin" />
        <Select value={c.venue} options={venueOpts()} onChange={(venue) => setConfig({ venue })} />
        <UseInBot from="SEAS" options={USES.seasons({ coin, hour })} />
        <Spacer />
        <span className="pro-status">{k.loading && !res ? 'loading…' : 'Baur, Cahill, Godfrey & Liu (2019); Padyšák & Vojtko (2022); Kinateder & Papavassiliou (2021)'}</span>
      </Toolbar>
      <div className="pro-scroll">
        {!res ? (
          <div className="pro-empty">{k.loading ? 'Loading hourly candles…' : 'Not enough hourly candles.'}</div>
        ) : (
          <>
            <div className="pro-section">
              {coin} — AVERAGE RETURN BY HOUR OF THE DAY (UTC) AND WEEKDAY · {Math.round(res.days)} DAYS OF HOURLY CANDLES{long?.coin === coin && long.bars.length > 1000 ? ` (${long.source})` : ''} · CLICK AN HOUR
            </div>
            <div className="seas-grid" role="table">
              <span />
              {Array.from({ length: 24 }, (_, h) => (
                <button key={h} className={`seas-h${hour === h ? ' on' : ''}`} onClick={() => setConfig({ hour: hour === h ? -1 : h })} title={`Hour ${h}:00–${h + 1}:00 UTC`}>
                  {h}
                </button>
              ))}
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <div key={d} className="seas-row" style={{ display: 'contents' }}>
                  <span className="seas-d">{DAY[d]}</span>
                  {res.s.grid[d].map((v, h) => (
                    <i key={h} className={hour === h ? 'on' : ''} style={{ background: cell(v, res.scale) }} title={`${DAY[d]} ${h}:00 UTC — average ${Number.isFinite(v) ? pct(v, 3) : '—'}`} onClick={() => setConfig({ hour: hour === h ? -1 : h })} />
                  ))}
                </div>
              ))}
            </div>
            <div className="lab-line muted">green: the hour rose on average · red: it fell · the stronger the colour, the bigger the average move (up to {pct(res.scale, 2)} an hour)</div>
            <div className="lab-grid2">
              <div>
                <div className="pro-section">BY HOUR — THE AVERAGE HOUR’S RETURN AND HOW SURE IT IS</div>
                <table className="pro-table compact seas-table">
                  <thead>
                    <tr>
                      <th className="l">HOUR (UTC)</th>
                      <th>AVERAGE</th>
                      <th title="The average against its own scatter; past ±3.08 it stands out even among 24 hours tried">T</th>
                      <th>ROSE</th>
                      <th>HOURS</th>
                      <th className="l" />
                    </tr>
                  </thead>
                  <tbody>
                    {(hour !== null ? [{ ...res.s.hours[hour], hour }, ...res.best.filter((h) => h.hour !== hour)] : res.best).slice(0, 8).map((h) => (
                      <tr key={h.hour} className={hour === h.hour ? 'sel' : ''} onClick={() => setConfig({ hour: hour === h.hour ? -1 : h.hour })}>
                        <td className="l b">
                          {h.hour}:00–{(h.hour + 1) % 24}:00
                        </td>
                        <td className={`mono ${h.mean >= 0 ? 'up' : 'down'}`}>{pct(h.mean, 3)}</td>
                        <td className="mono b">{num(h.t, 1)}</td>
                        <td className="mono">{pct(h.up, 0)}</td>
                        <td className="mono">{h.n}</td>
                        <td className="l muted">{Math.abs(h.t) > res.s.tBar ? 'stands out' : Math.abs(h.t) > 2 ? 'suggestive — could be luck among 24' : 'noise'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="pro-section">BY WEEKDAY — THE AVERAGE HOUR’S RETURN</div>
                <Bars rows={[1, 2, 3, 4, 5, 6, 0].map((d) => ({ label: `${DAY[d]}  t ${num(res.s.days[d].t, 1)}`, value: res.s.days[d].mean }))} format={(v) => pct(v, 3)} />
                <div className="lab-line mono">
                  21:00–23:00 UTC (the published window): {pct(evening, 3)} for the two hours · t {num(res.s.hours[21].t, 1)} and {num(res.s.hours[22].t, 1)}
                </div>
              </div>
            </div>
            <div className="lab-line">
              <b>Reading:</b>{' '}
              {standing.length
                ? `${standing.map((h) => `${h.hour}:00`).join(', ')} UTC stand${standing.length > 1 ? '' : 's'} out even after allowing for 24 hours tried (|t| above ${res.s.tBar}). That is worth a proper test — send the hour to the bot builder and let the Lab judge it on data it never saw, with costs.`
                : `No hour stands out once you allow for having looked at 24 of them (|t| above ${res.s.tBar} is the bar): what the map shows is within what luck draws. The published patterns faded after they were published — a calendar rule needs the Lab’s unseen-data test before it is believed.`}
            </div>
            {longErr && !long && <div className="lab-line muted">A year of history is unavailable ({longErr}); showing the exchange’s last 1,000 hours.</div>}
            <div className="lab-line muted">
              Each cell is the average return of the hourly candles that start in that hour (UTC). A t-statistic near 2 looks significant for one hour chosen in advance — but among 24 hours one that large is expected by chance, so the bar here is {res.s.tBar}. Bitcoin’s published calendar effects: gains concentrated at 21:00–23:00 UTC in 2015–2021, weaker after; lower risk at weekends; more volatility at the start of the week.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ======================================================================
// MC — Monte Carlo on a strategy's trades
// ======================================================================

export interface McConfig {
  source: 'manual' | 'bot';
  win: number;
  payoff: number;
  /** risk per trade, % of the account */
  risk: number;
  trades: number;
  /** the goal, as a multiple of the account, and the drawdown counted as ruin, % */
  target: number;
  ruin: number;
  /** keep runs of this many trades together (streaks as they came) */
  block: number;
}
export const MC_DEFAULTS: McConfig = { source: 'manual', win: 45, payoff: 2, risk: 1, trades: 200, target: 2, ruin: 50, block: 1 };

const LAST_KEY = 'novus-lab-last-trades';
function lastBotTrades(): { name: string; rs: number[]; at: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null');
    return v && Array.isArray(v.rs) && v.rs.length >= 5 ? { name: String(v.name ?? 'the last bot tested'), rs: v.rs.filter((x: unknown) => typeof x === 'number' && Number.isFinite(x)), at: Number(v.at) || 0 } : null;
  } catch {
    return null;
  }
}

export function MonteCarloPanel({ config: c, setConfig }: PanelProps<McConfig>) {
  const [bot, setBot] = useState(lastBotTrades);
  useEffect(() => {
    const on = (e: StorageEvent) => e.key === LAST_KEY && setBot(lastBotTrades());
    window.addEventListener('storage', on);
    return () => window.removeEventListener('storage', on);
  }, []);
  const fromBot = c.source === 'bot' && !!bot;
  const rs = useMemo(() => (fromBot ? bot!.rs : tradesFrom(c.win / 100, c.payoff, 1, 400)), [fromBot, bot, c.win, c.payoff]);
  const stats = useMemo(() => {
    const wins = rs.filter((r) => r > 0);
    const losses = rs.filter((r) => r <= 0);
    const p = wins.length / rs.length;
    const w = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const l = losses.length ? -losses.reduce((a, b) => a + b, 0) / losses.length : 1;
    return { p, w, l, exp: rs.reduce((a, b) => a + b, 0) / rs.length, kelly: l > 0 && w > 0 ? kellyBet(p, w, l) : 0 };
  }, [rs]);
  const opt = { trades: c.trades, target: c.target, ruin: c.ruin / 100, block: c.block, paths: 2000, seed: 11 };
  const sim = useMemo(() => ruinSim(rs, { ...opt, risk: c.risk / 100 }), [rs, c.risk, c.trades, c.target, c.ruin, c.block]);
  const ladder = useMemo(() => [0.25, 0.5, 1, 2, 3, 5, 10].map((r) => ({ r, s: ruinSim(rs, { ...opt, risk: r / 100, paths: 1000 }) })), [rs, c.trades, c.target, c.ruin, c.block]);
  const safe = ladder.filter((x) => x.s && x.s.pRuin < 0.05);
  const most = safe.length ? safe[safe.length - 1].r : null;
  return (
    <div className="pro-panel mc-panel">
      <Toolbar>
        <Select value={c.source} options={[{ value: 'manual' as const, label: 'From a win rate and payoff' }, { value: 'bot' as const, label: bot ? `From my last bot test (${bot.rs.length} trades)` : 'From my last bot test (none yet)' }]} onChange={(source) => setConfig({ source })} />
        {!fromBot && (
          <>
            <NumberInput value={c.win} step={1} min={1} width={60} onChange={(win) => setConfig({ win: Math.min(99, win) })} title="Win rate" suffix="%" />
            <NumberInput value={c.payoff} step={0.1} min={0.1} width={60} onChange={(payoff) => setConfig({ payoff })} title="Average win, in R (a loss is 1R)" suffix="R" />
          </>
        )}
        <NumberInput value={c.risk} step={0.25} min={0.05} width={64} onChange={(risk) => setConfig({ risk: Math.min(25, risk) })} title="Risk per trade, % of the account" suffix="%" />
        <NumberInput value={c.trades} step={50} min={10} width={70} onChange={(trades) => setConfig({ trades: Math.min(5000, Math.round(trades)) })} title="How many trades ahead to simulate" />
        <NumberInput value={c.target} step={0.5} min={1.1} width={60} onChange={(target) => setConfig({ target })} title="The goal: this multiple of the account" suffix="×" />
        <NumberInput value={c.ruin} step={5} min={5} width={60} onChange={(ruin) => setConfig({ ruin: Math.min(95, ruin) })} title="A drawdown this deep counts as ruin" suffix="%" />
        <Select value={c.block} options={[{ value: 1, label: 'trades shuffled' }, { value: 5, label: 'streaks kept (runs of 5)' }, { value: 10, label: 'streaks kept (runs of 10)' }]} onChange={(block) => setConfig({ block })} />
        <Spacer />
        <span className="pro-status">2,000 simulated futures</span>
      </Toolbar>
      <div className="pro-scroll">
        {c.source === 'bot' && !bot && <div className="lab-note">No bot test yet: test a bot in the Strategy Lab’s bot builder (BOT) and its unseen-data trades appear here. Showing the win rate and payoff instead.</div>}
        {!sim ? (
          <div className="pro-empty">Too few trades to simulate (five at least).</div>
        ) : (
          <>
            <div className="pro-section">
              {fromBot ? `${bot!.name.toUpperCase()} — ITS ${rs.length} UNSEEN-DATA TRADES, RESAMPLED` : `A STRATEGY WINNING ${c.win} % OF THE TIME AT ${c.payoff}R`} · {c.trades} TRADES AT {c.risk} % RISK EACH
            </div>
            <div className="lab-kv mono">
              <span>win rate {pct(stats.p, 0)}</span>
              <span>
                avg win {num(stats.w)}R · avg loss {num(stats.l)}R
              </span>
              <span className={stats.exp > 0 ? 'up' : 'down'}>expectancy {num(stats.exp)}R a trade</span>
              <span>
                full Kelly {pct(Math.max(0, stats.kelly), 1)} · half {pct(Math.max(0, stats.kelly) / 2, 1)}
              </span>
            </div>
            <Fan fan={sim.fan} height={170} />
            <div className="lab-line muted">The account as a multiple of where it starts: the middle line is the median future, the inner band half of all futures, the outer band nine in ten.</div>
            <table className="pro-table compact mc-table">
              <thead>
                <tr>
                  <th className="l">AFTER {c.trades} TRADES</th>
                  <th>UNLUCKY (1 IN 20)</th>
                  <th>MEDIAN</th>
                  <th>LUCKY (1 IN 20)</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="l">The account ends at</td>
                  <td className={`mono ${sim.p5 >= 1 ? 'up' : 'down'}`}>{num(sim.p5)}×</td>
                  <td className={`mono b ${sim.p50 >= 1 ? 'up' : 'down'}`}>{num(sim.p50)}×</td>
                  <td className="mono up">{num(sim.p95)}×</td>
                </tr>
                <tr>
                  <td className="l">Deepest drawdown on the way</td>
                  <td className="mono down">{pct(sim.dd95, 0)}</td>
                  <td className="mono">{pct(sim.ddMed, 0)}</td>
                  <td className="mono muted">—</td>
                </tr>
                <tr>
                  <td className="l">Longest losing streak</td>
                  <td className="mono down">{sim.streak95} in a row</td>
                  <td className="mono">{sim.streakMed} in a row</td>
                  <td className="mono muted">—</td>
                </tr>
              </tbody>
            </table>
            <div className="lab-kv mono">
              <span className={sim.pLoss < 0.2 ? 'up' : 'down'}>ends below the start: {pct(sim.pLoss, 0)} of futures</span>
              <span className="up">
                reaches {c.target}×: {pct(sim.pTarget, 0)}
              </span>
              <span className={sim.pRuin < 0.05 ? 'up' : 'down'}>
                a {c.ruin} % drawdown (ruin): {pct(sim.pRuin, 1)}
              </span>
            </div>
            <div className="pro-section">HOW MUCH TO RISK A TRADE — THE SAME TRADES AT EACH RISK LEVEL</div>
            <table className="pro-table compact mc-ladder">
              <thead>
                <tr>
                  <th className="l">RISK A TRADE</th>
                  <th>MEDIAN RESULT</th>
                  <th>UNLUCKY RESULT</th>
                  <th title="The deepest drawdown in the unlucky one-in-twenty future">BAD DRAWDOWN</th>
                  <th>REACHES {c.target}×</th>
                  <th title={`The chance of a ${c.ruin} % drawdown at some point`}>RUIN</th>
                  <th className="l" />
                </tr>
              </thead>
              <tbody>
                {ladder.map(
                  ({ r, s }) =>
                    s && (
                      <tr key={r} className={r === c.risk ? 'sel' : ''} onClick={() => setConfig({ risk: r })}>
                        <td className="l b">{r} %</td>
                        <td className={`mono ${s.p50 >= 1 ? 'up' : 'down'}`}>{num(s.p50)}×</td>
                        <td className={`mono ${s.p5 >= 1 ? 'up' : 'down'}`}>{num(s.p5)}×</td>
                        <td className="mono">{pct(s.dd95, 0)}</td>
                        <td className="mono">{pct(s.pTarget, 0)}</td>
                        <td className={`mono b ${s.pRuin < 0.05 ? 'up' : s.pRuin < 0.25 ? '' : 'down'}`}>{pct(s.pRuin, 1)}</td>
                        <td className="l muted">{s.pRuin >= 0.25 ? 'too much: ruin is likely' : s.pRuin >= 0.05 ? 'aggressive' : r === most ? 'the most that keeps ruin under 5 %' : 'safe'}</td>
                      </tr>
                    ),
                )}
              </tbody>
            </table>
            <div className="lab-line">
              <b>Reading:</b>{' '}
              {stats.exp <= 0
                ? 'These trades lose on average: no risk level saves a strategy with no edge. More risk only loses faster.'
                : most === null
                  ? `Even at 0.25 % a trade, a ${c.ruin} % drawdown is more than a one-in-twenty event with these trades — the edge is too thin for the swings, or the ruin level is set very tight.`
                  : `With these trades, up to ${most} % of the account a trade keeps the chance of a ${c.ruin} % drawdown under one in twenty. Past that, the median result still rises for a while but the bad futures get much worse — the growth is not worth the ruin. Half Kelly here is ${pct(Math.max(0, stats.kelly) / 2, 1)}.`}
            </div>
            <div className="lab-line muted">
              The simulation draws trades at random from the list (with “streaks kept”, in runs, so winning and losing spells stay together) and compounds the account. It assumes the future resembles these trades — a strategy that stops working is not in the picture, which is why the crypto swarm keeps its own daily loss limit and floor. Test a bot in the bot builder and choose “From my last bot test” to run this on its real unseen-data trades.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
