// ASK — the instrument report. Type "ASK SOL", "ask about bitcoin" or a coin's
// name in the search box, and the whole picture of that coin comes up: is it
// bullish or bearish (for the next hours to days, and for the coming weeks)
// and why, how it has performed, where GARCH expects it tomorrow and in a
// week, the levels either side, its trend and regime, its volatility and
// risk, how it moves against bitcoin, how traders are positioned, the order
// flow of the last hour, liquidations, the news, and the Lab's strategies
// that trade it. The analysis is src/market/report.ts; this screen gathers
// the data and lays it out.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { fmtAgo, fmtPrice, fmtUsd } from '../core/format';
import type { Kline } from '../core/types';
import { ADAPTERS } from '../exchanges';
import { candleForecast, type CandleReport } from '../lab/candles';
import type { Bar } from '../lab/series';
import { useLab } from '../lab/store';
import { coinOf } from '../market/coinNames';
import { hub } from '../market/hub';
import { releaseNews, retainNews, useNews } from '../market/news';
import { buildReport, toneOf, type FlowWindow, type InstrumentReport, type LiqWindow, type LiveStats, type Range, type Signal, type Verdict } from '../market/report';
import { useSettings } from '../store/settings';
import { Chip, Spacer, Toolbar, type PanelProps } from '../ui/controls';
import { LineChart } from './charts';
import { useBoardVenue, useKlines, useTickers } from './data';
import { openFunction } from './ProBar';

export interface ReportConfig {
  explain: boolean;
}
export const REPORT_DEFAULTS: ReportConfig = { explain: true };

const QUICK = ['BTC', 'ETH', 'SOL', 'AVAX', 'XRP', 'DOGE', 'LINK', 'SUI'];
const fin = Number.isFinite;
const pct = (x: number, d = 1) => (fin(x) ? `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—');
const pctU = (x: number, d = 0) => (fin(x) ? `${(x * 100).toFixed(d)}%` : '—');
const tone = (x: number) => (fin(x) ? (x > 0 ? 'up' : x < 0 ? 'down' : '') : '');
const barsOf = (k: Kline[] | undefined): Bar[] => (k ?? []).map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));

/** the live feed's numbers for a coin: stats from the primary feed, flow and liquidations across every venue the terminal follows */
function liveOf(base: string, now: number): { live: LiveStats | null; flow: FlowWindow | null; liqs: LiqWindow | null } {
  const H = hub();
  const feeds = H.aggregate.filter((f) => f.inst.base === base);
  const p = H.primary.inst.base === base ? H.primary : feeds[0];
  if (!p) return { live: null, flow: null, liqs: null };
  const s = p.stats;
  const oi = p.oi.items.filter((x) => x.time >= now - 86_400_000 && x.value > 0);
  const oiChange = oi.length > 1 ? oi[oi.length - 1].value / oi[0].value - 1 : NaN;
  const live: LiveStats = {
    last: p.lastPrice(),
    change24hPct: s.change24hPct,
    high24h: s.high24h,
    low24h: s.low24h,
    volume24hUsd: s.volume24hUsd,
    fundingRate: s.fundingRate,
    fundingIntervalH: s.fundingIntervalH,
    openInterestUsd: s.openInterestUsd,
    oiChange,
    oiChangeHours: oi.length > 1 ? (oi[oi.length - 1].time - oi[0].time) / 3_600_000 : 0,
    longShortRatio: s.longShortRatio,
    longAccount: s.longAccount,
    markPrice: s.markPrice,
    indexPrice: s.indexPrice,
    venue: p.adapter.name,
    perp: p.adapter.kind === 'perp',
  };
  let buyUsd = 0;
  let sellUsd = 0;
  let trades = 0;
  let from = now;
  for (const f of feeds) {
    const st = f.store;
    if (!st.length) continue;
    from = Math.min(from, Math.max(now - 3_600_000, st.firstTime()));
    st.forEach(st.indexAtTime(now - 3_600_000), st.end, (price, qty, buy) => {
      const u = price * qty;
      if (buy) buyUsd += u;
      else sellUsd += u;
      trades++;
    });
  }
  const minutes = Math.max(1, Math.round((now - from) / 60_000));
  const flow = trades >= 20 ? { buyUsd, sellUsd, trades, minutes } : null;
  let longUsd = 0;
  let shortUsd = 0;
  for (const f of feeds)
    for (const l of f.liqs.items)
      if (l.time >= now - 86_400_000) {
        if (l.position === 'long') longUsd += l.price * l.qty;
        else shortUsd += l.price * l.qty;
      }
  return { live, flow, liqs: longUsd + shortUsd > 0 ? { longUsd, shortUsd, hours: 24 } : null };
}

function Card({ title, children, cls }: { title: string; children: ReactNode; cls?: string }) {
  return (
    <section className={`ask-card ${cls ?? ''}`}>
      <div className="ask-card-title">{title}</div>
      {children}
    </section>
  );
}

function Gauge({ v }: { v: Verdict }) {
  const x = ((Math.max(-1, Math.min(1, v.score)) + 1) / 2) * 100;
  return (
    <div className="ask-gauge" role="img" aria-label={`${v.lean}, score ${Math.round(v.score * 100)}`}>
      <div className="ask-gauge-track">
        <i style={{ left: `${x}%` }} />
      </div>
      <div className="ask-gauge-scale">
        <span>Bearish</span>
        <span>Neutral</span>
        <span>Bullish</span>
      </div>
    </div>
  );
}

const leanCls = (l: string) => (l.includes('ullish') ? 'up' : l.includes('earish') ? 'down' : 'flat');

function VerdictCard({ v, title }: { v: Verdict; title: string }) {
  return (
    <div className={`ask-verdict ${leanCls(v.lean)}`}>
      <small>{title}</small>
      <b>{v.lean}</b>
      <Gauge v={v} />
      <span className="muted">
        score {v.score >= 0 ? '+' : ''}
        {Math.round(v.score * 100)} · {v.signals.length} signals{v.agreement > 0 ? ` · ${pctU(v.agreement)} of the weight agrees` : ''}
      </span>
    </div>
  );
}

function SignalRows({ rows, explain }: { rows: Signal[]; explain: boolean }) {
  return (
    <div className="ask-signals">
      {rows.map((s) => (
        <div key={s.id} className="ask-signal">
          <span className="ask-sig-name">{s.name}</span>
          <span className="mono ask-sig-val">{s.value}</span>
          <span className="ask-vote" title={`vote ${s.vote.toFixed(2)}, weight ${s.weight}`}>
            <i className={s.vote > 0 ? 'up' : s.vote < 0 ? 'down' : ''} style={{ width: `${Math.abs(s.vote) * 50}%`, [s.vote >= 0 ? 'left' : 'right']: '50%' }} />
          </span>
          <span className={`ask-sig-word ${tone(s.vote)}`}>{s.vote > 0.1 ? 'bullish' : s.vote < -0.1 ? 'bearish' : 'neutral'}</span>
          {explain && <span className="ask-sig-why">{s.why}</span>}
        </div>
      ))}
    </div>
  );
}

function RangeBar({ r, price, label }: { r: Range; price: number; label: string }) {
  const lo = r.lo95 * 0.995;
  const hi = r.hi95 * 1.005;
  const x = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  const w = (a: number, b: number) => `${((b - a) / (hi - lo)) * 100}%`;
  return (
    <div className="ask-range">
      <div className="ask-range-head">
        <span>{label}</span>
        <span className="muted mono">±{pctU(r.sd, 1)} (1 sd)</span>
      </div>
      <div className="ask-range-bar">
        <span className="b95" style={{ left: x(r.lo95), width: w(r.lo95, r.hi95) }} />
        <span className="b68" style={{ left: x(r.lo68), width: w(r.lo68, r.hi68) }} />
        <i style={{ left: x(price) }} />
      </div>
      <div className="ask-range-nums mono">
        <span className="down">{fmtPrice(r.lo95)}</span>
        <span className="down">{fmtPrice(r.lo68)}</span>
        <span>{fmtPrice(price)}</span>
        <span className="up">{fmtPrice(r.hi68)}</span>
        <span className="up">{fmtPrice(r.hi95)}</span>
      </div>
    </div>
  );
}

function KV({ rows }: { rows: [string, ReactNode, string?][] }) {
  return (
    <table className="pro-table compact ask-kv">
      <tbody>
        {rows.map(([k, v, c], i) => (
          <tr key={i}>
            <td className="l">{k}</td>
            <td className={`mono ${c ?? ''}`}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ReportPanel({ config: c, setConfig }: PanelProps<ReportConfig>) {
  const base = useSettings((s) => s.base);
  const primaryVenue = useSettings((s) => s.primaryVenue);
  const setPrimary = useSettings((s) => s.setPrimary);
  const venue = useBoardVenue();
  const daily = useKlines(venue, [base], '1d', 500);
  const hourly = useKlines(venue, [base], '1h', 1000);
  const btc = useKlines(venue, ['BTC'], '1d', 500);
  const tickers = useTickers(venue);
  const news = useNews((s) => s.items);
  const lab = useLab();
  const [q, setQ] = useState('');
  const [tick, setTick] = useState(0);
  const [candle, setCandle] = useState<{ coin: string; at: number; rep: CandleReport | null } | null>(null);
  useEffect(() => {
    retainNews();
    return releaseNews;
  }, []);
  // the live numbers (funding, flow, liquidations) are read again every 20 seconds
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 20_000);
    return () => clearInterval(t);
  }, []);
  const D = useMemo(() => barsOf(daily.data[base]), [daily.data, base]);
  const Hh = useMemo(() => barsOf(hourly.data[base]), [hourly.data, base]);
  const B = useMemo(() => barsOf(btc.data.BTC), [btc.data]);
  const lastH = Hh.length ? Hh[Hh.length - 1].time : 0;
  // the next-candle forest: fitted once per new hourly candle, after the screen is drawn
  useEffect(() => {
    if (Hh.length < 400) return;
    if (candle && candle.coin === base && candle.at === lastH) return;
    const t = setTimeout(() => {
      let rep: CandleReport | null = null;
      try {
        rep = candleForecast({ coin: base, tfH: 1, bars: Hh.slice(-1000), funding: null });
      } catch {
        rep = null;
      }
      setCandle({ coin: base, at: lastH, rep });
    }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, lastH, Hh.length]);
  const rep: InstrumentReport | null = useMemo(() => {
    if (D.length < 10 && Hh.length < 10) return null;
    const now = Date.now();
    const { live, flow, liqs } = liveOf(base, now);
    try {
      return buildReport({ coin: base, daily: D, hourly: Hh, btcDaily: base === 'BTC' ? null : B, live, flow, liqs, news, now, candle: candle?.coin === base ? candle.rep : null });
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, D, Hh, B, news.length, tick, candle]);

  const go = (text: string) => {
    const coin = coinOf(text.trim().split(/\s+/).pop() ?? '');
    if (!coin) return;
    setQ('');
    if (coin !== base) setPrimary(coin, primaryVenue);
  };
  const listed = useMemo(() => Array.from(new Set(tickers.rows.map((t) => t.base))).sort(), [tickers.rows]);
  const err = daily.errors[base] || hourly.errors[base];
  const farmHits = (lab.farm?.top ?? []).filter((s) => s.coins.includes(base));
  const deployed = (lab.status?.deployed ?? []).filter((d) => d.coins.includes(base));
  const loading = (daily.loading || hourly.loading) && !rep;

  return (
    <div className="pro-panel ask-panel">
      <Toolbar>
        <b className="pro-title">{base} — instrument report</b>
        <form
          className="ask-search"
          onSubmit={(e) => {
            e.preventDefault();
            go(q);
          }}
        >
          <input className="mono" list="ask-coins" value={q} placeholder="Search a coin — BTC, solana, avax…" onChange={(e) => setQ(e.target.value)} aria-label="Search a coin" />
          <datalist id="ask-coins">
            {listed.slice(0, 400).map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </form>
        {QUICK.map((k) => (
          <Chip key={k} active={k === base} onClick={() => go(k)}>
            {k}
          </Chip>
        ))}
        <Spacer />
        <Chip active={c.explain} onClick={() => setConfig({ explain: !c.explain })} title="Explain every number in plain English">
          Explain
        </Chip>
        <span className="pro-status">{ADAPTERS[venue]?.name ?? venue} candles · live feed · news</span>
      </Toolbar>
      <div className="pro-scroll">
        {!rep ? (
          <div className="pro-empty">{err ? `Could not load ${base}: ${err}. Try its ticker (e.g. AVAX) or another coin.` : loading ? `Gathering ${base}: a year and a half of daily candles, six weeks of hourly ones, the live feed and the news…` : `No candles for ${base}.`}</div>
        ) : (
          <Report rep={rep} D={D} explain={c.explain} fitting={Hh.length >= 400 && candle?.coin !== base} farmHits={farmHits} deployed={deployed} />
        )}
      </div>
    </div>
  );
}

function Report({ rep, D, explain, fitting, farmHits, deployed }: { rep: InstrumentReport; D: Bar[]; explain: boolean; fitting: boolean; farmHits: { id: string; name: string; oos: { sharpe: number; cagr: number; maxDD: number }; stage: string }[]; deployed: { id: string; name: string; on: boolean; stats: { sharpe: number } }[] }) {
  const r = rep;
  const ch24 = r.perf[1].pct;
  const shown = D.slice(-240);
  const closesAll = D.map((b) => b.close);
  const ma = (n: number) => closesAll.map((_, i) => (i + 1 >= n ? closesAll.slice(i + 1 - n, i + 1).reduce((a, b) => a + b, 0) / n : NaN)).slice(-shown.length);
  const series = useMemo(
    () => [
      { values: shown.map((b) => b.close), color: 'var(--text)', width: 1.6 },
      { values: ma(50), color: 'var(--accent)', width: 1.2 },
      { values: ma(200), color: 'var(--warn)', width: 1.2, dash: '4 3' },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [D.length, D[D.length - 1]?.close],
  );
  const cd = r.forecast.candle;
  const P = r.positioning;
  return (
    <div className="ask-body">
      {/* the headline: price, the two verdicts, the summary */}
      <div className="ask-hero">
        <div className="ask-price">
          <small>{r.coin}</small>
          <b className="mono">{fmtPrice(r.price)}</b>
          <span className={`mono ${tone(ch24)}`}>{pct(ch24, 2)} 24h</span>
        </div>
        <VerdictCard v={r.short} title="SHORT TERM · hours to days" />
        <VerdictCard v={r.medium} title="MEDIUM TERM · the coming weeks" />
      </div>
      <div className="ask-summary">
        {r.summary.map((s, i) => (
          <p key={i}>{s}</p>
        ))}
        <p className="muted ask-note">Signals are tendencies measured on past data, not promises — a lean, not a guarantee. Not financial advice.</p>
      </div>

      <div className="ask-perf">
        {r.perf.map((p) => (
          <div key={p.label} className="ask-perf-cell">
            <small>{p.label}</small>
            <b className={`mono ${tone(p.pct)}`}>{pct(p.pct)}</b>
          </div>
        ))}
        {r.range52 && (
          <div className="ask-perf-cell ask-52">
            <small>52-week range · {pctU(r.range52.pos)} of the way up</small>
            <div className="ask-52-bar">
              <i style={{ left: `${(r.range52.pos || 0) * 100}%` }} />
            </div>
            <span className="mono muted">
              {fmtPrice(r.range52.lo)} — {fmtPrice(r.range52.hi)} · {pct(r.range52.fromHi)} from the high
            </span>
          </div>
        )}
      </div>

      <div className="ask-grid">
        <Card title="PRICE · 240 DAYS" cls="ask-chart">
          <LineChart
            series={series}
            height={190}
            format={(v) => fmtPrice(v)}
            labels={
              <>
                <span>— price</span>
                <span style={{ color: 'var(--accent)' }}>— 50-day average</span>
                <span style={{ color: 'var(--warn)' }}>- - 200-day average</span>
              </>
            }
          />
        </Card>

        <Card title="WHERE IT COULD BE · GARCH FORECAST">
          {r.forecast.day && <RangeBar r={r.forecast.day} price={r.price} label="By this time tomorrow" />}
          {r.forecast.week && <RangeBar r={r.forecast.week} price={r.price} label="In a week" />}
          {!r.forecast.day && <div className="pro-empty">Needs 200+ daily candles.</div>}
          {explain && r.forecast.day && <p className="ask-why">The inner band holds the price 2 times in 3, the outer band 19 times in 20 — the coin’s own volatility model (GJR-GARCH with fat tails), which widens the bands after big moves and narrows them in calm spells.</p>}
          <div className="ask-sub">NEXT HOURLY CANDLE</div>
          {cd?.next ? (
            <KV
              rows={[
                ['Odds it closes up', pctU(cd.next.pUp), cd.next.pUp >= 0.5 ? 'up' : 'down'],
                ['Expected high / low', `${fmtPrice(cd.next.high)} / ${fmtPrice(cd.next.low)}`],
                ['Its record on unseen candles', cd.eval ? `${pctU(cd.eval.hit, 1)} right of ${cd.eval.n} (always guessing the commoner side: ${pctU(cd.eval.base, 1)})` : '—'],
              ]}
            />
          ) : (
            <div className="muted ask-why">{fitting ? 'Fitting the candle model…' : 'Not enough hourly history from this venue for the candle model (it needs about 600 hours).'}</div>
          )}
          {explain && cd?.eval && <p className="ask-why">{cd.eval.skill > 0.005 ? 'It has beaten a coin toss on candles it never saw, so it gets a small vote.' : 'Its direction calls have been close to a coin toss, so it gets no vote — its high/low range is the useful part.'}</p>}
        </Card>

        <Card title="WHY · SHORT TERM">
          <SignalRows rows={r.short.signals} explain={explain} />
          <p className="ask-why">{r.short.text}</p>
        </Card>
        <Card title="WHY · MEDIUM TERM">
          <SignalRows rows={r.medium.signals} explain={explain} />
          <p className="ask-why">{r.medium.text}</p>
        </Card>

        <Card title="KEY LEVELS">
          <div className="ask-levels">
            {[...r.levels.above].reverse().map((l, i) => (
              <div key={`a${i}`} className="ask-level up">
                <span className="mono">{fmtPrice(l.price)}</span>
                <span className="mono">{pct(l.dist)}</span>
                <span>{l.kind}</span>
              </div>
            ))}
            <div className="ask-level now">
              <span className="mono">{fmtPrice(r.price)}</span>
              <span />
              <span>price now</span>
            </div>
            {r.levels.below.map((l, i) => (
              <div key={`b${i}`} className="ask-level down">
                <span className="mono">{fmtPrice(l.price)}</span>
                <span className="mono">{pct(l.dist)}</span>
                <span>{l.kind}</span>
              </div>
            ))}
          </div>
          {r.levels.pivot && (
            <KV
              rows={[
                ['Pivots (yesterday) R2 · R1', `${fmtPrice(r.levels.pivot.r2)} · ${fmtPrice(r.levels.pivot.r1)}`, 'up'],
                ['Pivot', fmtPrice(r.levels.pivot.p)],
                ['S1 · S2', `${fmtPrice(r.levels.pivot.s1)} · ${fmtPrice(r.levels.pivot.s2)}`, 'down'],
                ['Value area (30 days)', `${fmtPrice(r.levels.val)} – ${fmtPrice(r.levels.vah)} · POC ${fmtPrice(r.levels.poc)}`],
                ['7-day VWAP', fmtPrice(r.levels.vwap7)],
              ]}
            />
          )}
          {explain && <p className="ask-why">Levels above are where selling has met the price before (resistance), below where buying has (support): swing highs and lows of the last four months, the 52-week extremes, the long averages, and the volume profile — the price traded most over 30 days (the point of control) and the band holding 70 % of the volume (the value area).</p>}
        </Card>

        <Card title="TREND & REGIME">
          <KV
            rows={[
              ['50-day / 200-day average', `${fmtPrice(r.trend.ma50)} / ${fmtPrice(r.trend.ma200)}`],
              ['ADX (trend strength)', fin(r.trend.adx) ? r.trend.adx.toFixed(0) : '—'],
              ['RSI daily / hourly', `${fin(r.trend.rsiD) ? r.trend.rsiD.toFixed(0) : '—'} / ${fin(r.trend.rsiH) ? r.trend.rsiH.toFixed(0) : '—'}`],
              ['Trend vote daily / hourly', `${fin(r.trend.scoreD) ? Math.round(r.trend.scoreD * 100) : '—'} % / ${fin(r.trend.scoreH) ? Math.round(r.trend.scoreH * 100) : '—'} %`, tone(r.trend.scoreD)],
              ['90-day trend t-statistic', fin(r.trend.tStat) ? r.trend.tStat.toFixed(1) : '—', tone(r.trend.tStat)],
              ['Regime', r.regime.label],
              ['Hurst · variance ratio', `${fin(r.regime.hurst) ? r.regime.hurst.toFixed(2) : '—'} · ${fin(r.regime.vr) ? r.regime.vr.toFixed(2) : '—'}`],
            ]}
          />
          {explain && (
            <>
              <p className="ask-why">{r.trend.words}</p>
              <p className="ask-why">{r.regime.words}</p>
            </>
          )}
        </Card>

        <Card title="VOLATILITY & RISK">
          {r.vol ? (
            <>
              <KV
                rows={[
                  ['GARCH now / long run (a year)', `${pctU(r.vol.nowAnn)} / ${pctU(r.vol.longAnn)}`, r.vol.nowAnn > r.vol.longAnn ? 'down' : 'up'],
                  ['Realised 7 / 30 days', `${pctU(r.vol.rv7)} / ${pctU(r.vol.rv30)}`],
                  ['30-day volatility rank (year)', fin(r.vol.rank) ? `${Math.round(r.vol.rank * 100)}th percentile` : '—'],
                  ['A typical day', `±${pctU(r.vol.dayMove, 1)}`],
                  ['1-day value at risk 95 % / 99 %', `${pctU(r.vol.var95, 1)} / ${pctU(r.vol.var99, 1)}`, 'down'],
                  ['Volatility shock half-life', fin(r.vol.halfLife) ? `${r.vol.halfLife.toFixed(0)} days` : '—'],
                ]}
              />
              {explain && <p className="ask-why">{r.vol.words}</p>}
            </>
          ) : (
            <div className="pro-empty">Needs 200+ daily candles.</div>
          )}
        </Card>

        <Card title="AGAINST BITCOIN">
          {r.vsBtc ? (
            <>
              <KV
                rows={[
                  ['Beta (moves per 1 % of BTC)', r.vsBtc.beta.toFixed(2)],
                  ['Correlation · R²', `${r.vsBtc.corr.toFixed(2)} · ${pctU(r.vsBtc.r2)}`],
                  ['30 / 90 days vs bitcoin', `${pct(r.vsBtc.rel30)} / ${pct(r.vsBtc.rel90)}`, tone(r.vsBtc.rel30)],
                  ['Alpha (a year, beyond its beta)', pct(r.vsBtc.alphaAnn, 0), tone(r.vsBtc.alphaAnn)],
                ]}
              />
              {explain && <p className="ask-why">{r.vsBtc.words}</p>}
            </>
          ) : (
            <div className="muted ask-why">{r.coin === 'BTC' ? 'This is bitcoin — the benchmark every other coin is measured against.' : 'Needs 60+ days of both coins.'}</div>
          )}
        </Card>

        <Card title="POSITIONING & ORDER FLOW">
          {P ? (
            <>
              <KV
                rows={[
                  ['Funding · a year', fin(P.fundingPct) ? `${P.fundingPct.toFixed(4)}% · ${P.fundingApr.toFixed(1)}%` : '—', P.fundingApr > 20 ? 'down' : P.fundingApr < 0 ? 'up' : ''],
                  ['Open interest', `${fmtUsd(P.oiUsd)}${fin(P.oiChange) && P.oiChangeHours ? ` · ${pct(P.oiChange)} in ${Math.round(P.oiChangeHours)}h` : ''}`],
                  ['Accounts long · L/S ratio', `${pctU(P.longAccount)} · ${fin(P.longShort) ? P.longShort.toFixed(2) : '—'}`],
                  ['Basis (mark vs index)', fin(P.basisBps) ? `${P.basisBps.toFixed(1)} bp` : '—'],
                  [P.flow && P.flow.minutes < 60 ? `Last ${P.flow.minutes} min: bought / sold` : 'Last hour: bought / sold', P.flow ? `${fmtUsd(P.flow.buyUsd, 0)} / ${fmtUsd(P.flow.sellUsd, 0)}` : 'watching the tape…', P.flow ? tone(P.flow.buyUsd - P.flow.sellUsd) : ''],
                  ['Liquidated (24h) longs / shorts', P.liqs ? `${fmtUsd(P.liqs.longUsd, 0)} / ${fmtUsd(P.liqs.shortUsd, 0)}` : 'none seen yet'],
                ]}
              />
              {explain && <p className="ask-why">{P.words}</p>}
            </>
          ) : (
            <div className="muted ask-why">The live feed is still connecting to {r.coin}.</div>
          )}
        </Card>

        <Card title={`NEWS · ${r.news.items.length} IN 3 DAYS`} cls="ask-news">
          {explain && <p className="ask-why">{r.news.words}</p>}
          <div className="ask-news-list">
            {r.news.items.slice(0, 12).map((n) => {
              const t = toneOf(n.title);
              return (
                <div key={n.id} className="ask-news-row">
                  <i className={t > 0 ? 'up' : t < 0 ? 'down' : ''} />
                  <span className="muted mono">{fmtAgo(n.time)}</span>
                  {n.url ? (
                    <a href={n.url} target="_blank" rel="noreferrer noopener">
                      {n.title}
                    </a>
                  ) : (
                    <span>{n.title}</span>
                  )}
                  <span className="muted">{n.source}</span>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="IN THE STRATEGY LAB">
          {farmHits.length || deployed.length ? (
            <div className="ask-lab">
              {farmHits.map((s) => (
                <div key={s.id} className="ask-lab-row">
                  <span>Edge finder · {s.stage}</span>
                  <b>{s.name}</b>
                  <span className="mono">Sharpe {s.oos.sharpe.toFixed(2)} unseen · {pct(s.oos.cagr, 0)} a year · worst fall {pctU(s.oos.maxDD)}</span>
                </div>
              ))}
              {deployed.map((d) => (
                <div key={d.id} className="ask-lab-row">
                  <span>Deployed{d.on ? '' : ' (off)'}</span>
                  <b>{d.name}</b>
                  <span className="mono">Sharpe {d.stats.sharpe.toFixed(2)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted ask-why">No tested strategy trades {r.coin} yet. The edge finder can search for one — add {r.coin} to its coins.</p>
          )}
          <div className="ask-actions">
            <button className="btn" onClick={() => openFunction('labfarm', 'lab')}>
              Open the edge finder
            </button>
            <button className="btn" onClick={() => openFunction('historical', 'markets')}>
              Chart (GP)
            </button>
            <button className="btn" onClick={() => openFunction('fcst', 'markets')}>
              Candle forecast (FCST)
            </button>
          </div>
        </Card>
      </div>
      {r.gaps.length > 0 && <p className="muted ask-note">Not shown: {r.gaps.join('; ')}.</p>}
      <p className="muted ask-note">
        Built from {r.days} daily candles at {new Date(r.asOf).toUTCString().slice(17, 22)} UTC.
      </p>
    </div>
  );
}
