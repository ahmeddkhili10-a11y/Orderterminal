// The crypto terminal is the island. Its places — the Exchange (order book),
// the Fields (volume profile), the Harbor (the tape), the Lighthouse
// (volatility), the Council (the swarm, as minions debating on its plaza) and
// the river of price — are all on it, a click away: the camera flies there and
// the reading floats beside it. On screen otherwise: a small market card and
// the balances.
import { useEffect, useMemo, useRef, useState } from 'react';
import { hub } from '../market/hub';
import { useSettings } from '../store/settings';
import { useCSwarm } from '../cswarm/store';
import { desktop, type CSwarmLine } from '../desktop/bridge';
import { ADAPTERS } from '../exchanges';
import { bookBars, gauges, lights, priceWindow, profileRidge, terrain, volWave, type GaugeRead, type Window } from './model';
import { Island as Island3D, PLACE_NAME, PLACE_ROLE, webglOk, type IslandFrame, type IslandSay, type Peek, type Place } from './island3d';
import type { Trade } from '../core/types';

const SPAN = 15 * 60_000;
const NAME: Record<string, string> = { scalper: 'Scalper', auction: 'Auctioneer', trend: 'Trend', tape: 'Tape', crowd: 'Crowd', guardian: 'Guardian', forest: 'Forest', risk: 'Risk', council: 'Council', swarm: 'Swarm' };
const ROLE: Record<string, string> = {
  scalper: 'Order-flow scalps on the 1-minute tape: absorption, sweeps, aggressive delta with the book behind it. Proposes trades.',
  auction: 'Intraday auction market theory: the value area, first-hour breakouts, the 80% rule back into value. Proposes trades.',
  trend: 'Daily momentum (20/60/120 days); hourly breakouts in its direction, ATR stops, break-even at 1R, trails from 2R. Proposes trades.',
  tape: 'Reads the last seconds of aggressive buying and selling and the book. Votes.',
  crowd: 'Funding: when one side pays a lot to hold, it is crowded. Votes.',
  guardian: 'Vetoes a wide spread or a volatility spike.',
  forest: 'The statistics, learned from every paper, live and refused trade. Votes; vetoes once it trusts itself.',
  risk: 'Compounding size from the account as it is now; daily limit, drawdown cuts, the floor. Vetoes.',
};
const fmt = (p: number | null | undefined) => (p === null || p === undefined || !Number.isFinite(p) ? '—' : p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 1 : p >= 10 ? 2 : 4 }));
const usd = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;
const signed = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** The primary market's recent trades (this venue only, so the lights sit on its own prices). */
function recentTrades(since: number, max = 4000): Trade[] {
  const f = hub().primary;
  const s = f.store;
  if (!s.length) return [];
  const from = Math.max(s.indexAtTime(since), s.end - max);
  const out: Trade[] = [];
  s.forEach(from, s.end, (price, qty, buy, time) => out.push({ venue: f.inst.venue, price, qty, side: buy ? 'buy' : 'sell', time }));
  return out;
}

interface Info {
  price: number | null;
  change: number | null;
  window: Window | null;
  spread: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  bidDepth: number;
  askDepth: number;
  poc: number | null;
  vol15: number;
  buy15: number | null;
  realized: number | null;
  rets: number[];
  perMin: number;
  buy1: number | null;
  biggest: Trade | null;
  avgUsd: number | null;
}

export function Island() {
  const host = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const leader = useRef<SVGLineElement>(null);
  const engine = useRef<Island3D | null>(null);
  const win = useRef<Window | null>(null);
  const winKey = useRef('');
  const seen = useRef(0);
  const lastTrade = useRef(0);
  const [peek, setPeek] = useState<Peek | null>(null);
  const [sel, setSel] = useState<Place | null>(null);
  const [gl] = useState(webglOk);
  const [g, setG] = useState<GaugeRead[]>([]);
  const [info, setInfo] = useState<Info | null>(null);
  const [hint, setHint] = useState(true);
  const base = useSettings((s) => s.base);
  const venue = useSettings((s) => s.primaryVenue);
  const { lines } = useCSwarm();

  useEffect(() => {
    const t = setTimeout(() => setHint(false), 10000);
    return () => clearTimeout(t);
  }, []);

  // the 3D world
  useEffect(() => {
    if (!gl || !host.current) return;
    try {
      const e = new Island3D(host.current, setPeek, setSel);
      e.detail = card.current;
      e.leader = leader.current;
      engine.current = e;
      return () => {
        e.dispose();
        engine.current = null;
      };
    } catch {
      /* no WebGL after all */
    }
  }, [gl]);
  useEffect(() => {
    if (engine.current) {
      engine.current.detail = card.current;
      engine.current.leader = leader.current;
    }
  });

  // the data, once a second
  useEffect(() => {
    const build = () => {
      const H = hub();
      const f = H.primary;
      const now = Date.now();
      const mid = f.book.mid() || f.lastPrice();
      if (!(mid > 0)) return;
      const snaps = H.heatmap.snapshots;
      const res = snaps[snaps.length - 1]?.res ?? 0;
      const w0 = win.current;
      const half = w0 ? (w0.hi - w0.lo) / 2 : 0;
      if (!w0 || Math.abs(mid - (w0.lo + half)) > half * 0.45 || f.key !== winKey.current) {
        win.current = { ...priceWindow(mid, res), t0: now - SPAN, t1: now };
        winKey.current = f.key;
      }
      const t0 = Math.min(now - 60_000, Math.max(now - SPAN, snaps[0]?.time ?? now));
      const w: Window = { ...win.current!, t0, t1: now };
      const trades = recentTrades(now - SPAN);
      const last60 = trades.filter((t) => t.time >= now - 60_000);
      const vol = (ts: Trade[], buy?: boolean) => ts.reduce((a, t) => a + (buy === undefined || (t.side === 'buy') === buy ? t.qty : 0), 0);
      const bids = f.book.getBids().map((l) => [l.price, l.qty] as [number, number]);
      const asks = f.book.getAsks().map((l) => [l.price, l.qty] as [number, number]);
      const spread = bids[0] && asks[0] ? ((asks[0][0] - bids[0][0]) / mid) * 1e4 : null;
      const near = (lv: [number, number][]) => lv.filter(([p]) => Math.abs(p - mid) / mid <= 0.001).reduce((a, [, q]) => a + q, 0);
      const mids = f.mids.items;
      const wave = volWave(mids, now);
      const first = mids.find((m) => m.time >= now - SPAN);
      const ridge = profileRidge(trades, w, 40, 10);
      const st = useCSwarm.getState().state;
      const gs = gauges(st, base, { buyShare: vol(last60) > 0 ? vol(last60, true) / vol(last60) : null, spreadBps: spread });
      setG(gs);
      const biggest = trades.reduce<Trade | null>((b, t) => (!b || t.price * t.qty > b.price * b.qty ? t : b), null);
      const inf: Info = {
        price: mid,
        change: first ? (mid / first.value - 1) * 100 : null,
        window: w,
        spread,
        bestBid: bids[0]?.[0] ?? null,
        bestAsk: asks[0]?.[0] ?? null,
        bidDepth: near(bids),
        askDepth: near(asks),
        poc: ridge.v.some((x) => x > 0) ? w.lo + ((ridge.poc + 0.5) / ridge.cols) * (w.hi - w.lo) : null,
        vol15: vol(trades),
        buy15: vol(trades) > 0 ? vol(trades, true) / vol(trades) : null,
        realized: wave.realized,
        rets: wave.curves.map((c) => c[c.length - 1] ?? 0),
        perMin: last60.length,
        buy1: vol(last60) > 0 ? vol(last60, true) / vol(last60) : null,
        biggest,
        avgUsd: trades.length ? trades.reduce((a, t) => a + t.price * t.qty, 0) / trades.length : null,
      };
      setInfo(inf);
      // what the swarm said since the last frame: the minions act it out
      const ls = useCSwarm.getState().lines;
      const said: IslandSay[] = ls.filter((l) => l.t > seen.current && ['propose', 'vote', 'trade', 'pass'].includes(l.kind)).slice(-12).map((l) => ({ agent: l.agent, text: l.text, kind: l.kind }));
      for (const l of ls) if (l.t > seen.current) seen.current = l.t;
      // the biggest new trades sail into the harbour
      const fresh = trades.filter((t) => t.time > lastTrade.current);
      if (trades.length) lastTrade.current = trades[trades.length - 1].time;
      const avg = inf.avgUsd ?? 0;
      const boats = fresh
        .map((t) => ({ buy: t.side === 'buy', usd: t.price * t.qty, price: t.price, qty: t.qty, time: t.time }))
        .filter((b) => b.usd >= avg * 1.5)
        .sort((a, b) => b.usd - a.usd)
        .slice(0, 3);
      const lastVerdict = [...ls].reverse().find((l) => l.agent === 'council');
      const frame: IslandFrame = {
        terrain: terrain(snaps, mids, w),
        window: w,
        lights: lights(trades, w).lights,
        price: mid,
        positions: (st?.open ?? [])
          .filter((p) => p.coin === base)
          .map((p) => ({ id: p.id, side: p.side, entry: p.entry, stop: p.stop, target: p.target, label: `${p.side === 'buy' ? 'LONG' : 'SHORT'} ${p.coin} by the ${NAME[p.agent]} · entry ${fmt(p.entry)} · stop ${fmt(p.stop)} · target ${fmt(p.target)} · open ${signed(p.upnl ?? 0)}` })),
        agents: gs.map((x) => ({ id: x.id, name: x.name, value: x.value, text: x.text, sub: x.sub })),
        said,
        running: Boolean(st?.running),
        book: bookBars(bids, asks, 12),
        ridge,
        vol: wave.realized,
        boats,
        tape: {
          buyUsd: last60.reduce((a, t) => a + (t.side === 'buy' ? t.price * t.qty : 0), 0),
          sellUsd: last60.reduce((a, t) => a + (t.side === 'sell' ? t.price * t.qty : 0), 0),
        },
        moves: inf.rets,
        tags: {
          exchange: spread !== null ? `spread ${spread.toFixed(1)} bps` : '',
          fields: inf.poc !== null ? `POC ${fmt(inf.poc)}` : '',
          lighthouse: inf.realized !== null ? `${(inf.realized * 100).toFixed(0)}% a year` : '',
          harbor: inf.buy1 !== null ? `${Math.round(inf.buy1 * 100)}% buying` : '',
          council: !st?.running ? 'asleep — start the swarm below' : lastVerdict ? lastVerdict.text.replace(/^[A-Z]+: /, '').slice(0, 30) : 'debating',
        },
      };
      engine.current?.update(frame);
    };
    build();
    const id = setInterval(build, 1000);
    return () => clearInterval(id);
  }, [base, venue]);

  // Esc flies back
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && engine.current?.home();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const agentId = sel?.startsWith('agent:') ? sel.slice(6) : null;
  const feed = useMemo(() => [...lines].reverse().filter((l) => (agentId ? l.agent === agentId : true)).slice(0, agentId ? 6 : 10), [lines, agentId]);
  const venueName = (() => {
    try {
      return ADAPTERS[venue].name;
    } catch {
      return venue;
    }
  })();

  return (
    <div className="island">
      <div className="island-host" ref={host}>
        {!gl && <div className="island-nogl">The island is drawn in 3D (WebGL), which this computer's graphics do not offer. Switch to ▦ Panels on the top bar for the same market and swarm.</div>}
      </div>

      {/* the reading of the place you visited: floating text and a line to it, no box */}
      <svg className="isl-leader" aria-hidden>
        <line ref={leader} />
      </svg>
      <div className={`isl-holo${sel ? ' open' : ''}`} ref={card}>
        {sel && (
          <>
            <div className="isl-holo-head">
              <span className="isl-holo-kicker">{agentId ? 'agent' : PLACE_ROLE[sel]}</span>
              <b>{agentId ? (g.find((x) => x.id === agentId)?.name ?? agentId) : PLACE_NAME[sel]}</b>
              <button className="isl-x" onClick={() => engine.current?.home()} title="Back to the island (Esc)">
                esc ✕
              </button>
            </div>
            <Reading sel={sel} info={info} g={g} feed={feed} />
          </>
        )}
      </div>

      {/* the market card: small, top left */}
      <div className="isl-market">
        <span className="isl-market-k">◈ MARKET ISLAND</span>
        <span className="isl-market-sym">
          <b>{base}</b> <span>{venueName}</span>
        </span>
        <b className="mono isl-market-p">{fmt(info?.price)}</b>
        {info?.change !== null && info?.change !== undefined && <span className={`mono ${info.change >= 0 ? 'up' : 'down'}`}>{info.change >= 0 ? '+' : ''}{info.change.toFixed(2)}%</span>}
      </div>

      <MoneyBar />
      {hint && gl && <div className="isl-hint">drag to look around · scroll to zoom · WASD to glide · click any place to visit it</div>}

      {peek && (
        <div className={`isl-peek ${peek.tone ?? ''}`} style={{ left: peek.x + 16, top: peek.y + 12 }}>
          <b>{peek.title}</b>
          {peek.lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="isl-row">
      <span>{k}</span>
      <b className={`mono ${tone ?? ''}`}>{v}</b>
    </div>
  );
}

function Reading({ sel, info, g, feed }: { sel: Place; info: Info | null; g: GaugeRead[]; feed: CSwarmLine[] }) {
  const cs = useCSwarm((s) => s.state);
  const i = info;
  if (sel.startsWith('agent:')) {
    const id = sel.slice(6);
    const r = g.find((x) => x.id === id);
    return (
      <div className="isl-holo-body">
        <Row k="Gauge" v={`${r?.text ?? '—'} · ${r?.sub ?? ''}`} />
        <div className="isl-meter">
          <i style={{ width: `${Math.round(Math.max(0, Math.min(1, r?.value ?? 0)) * 100)}%` }} />
        </div>
        <p>{ROLE[id]}</p>
        {feed.map((l, k) => (
          <div key={k} className={`isl-line ${l.kind}`}>
            {l.text}
          </div>
        ))}
        {!feed.length && <p className="muted">Nothing said yet.</p>}
      </div>
    );
  }
  if (sel === 'council')
    return (
      <div className="isl-holo-body">
        <p className="muted">The proposer walks to the podium; the others step up and vote. No veto and a score of 2: the hall turns green and the trade is taken.</p>
        {(cs?.open ?? []).map((p) => (
          <div key={p.id} className={`isl-line ${(p.upnl ?? 0) >= 0 ? 'win' : 'loss'}`}>
            {p.side === 'buy' ? 'LONG' : 'SHORT'} {p.coin} · {NAME[p.agent]} · {fmt(p.entry)} → stop {fmt(p.stop)} / target {fmt(p.target)} · {signed(p.upnl ?? 0)}
          </div>
        ))}
        {feed.map((l, k) => (
          <div key={k} className={`isl-line ${l.kind}`}>
            <b>{NAME[l.agent] ?? l.agent}</b> {l.text}
          </div>
        ))}
        {!feed.length && <p className="muted">The minions are asleep — start the crypto swarm at the bottom of the screen.</p>}
      </div>
    );
  if (!i) return <div className="isl-holo-body muted">Waiting for the market…</div>;
  if (sel === 'exchange')
    return (
      <div className="isl-holo-body">
        <Row k="Best bid / ask" v={`${fmt(i.bestBid)} / ${fmt(i.bestAsk)}`} />
        <Row k="Spread" v={i.spread !== null ? `${i.spread.toFixed(2)} bps` : '—'} tone={i.spread !== null && i.spread > 8 ? 'down' : ''} />
        <Row k="Bids within 0.1%" v={i.bidDepth.toPrecision(4)} tone="up" />
        <Row k="Asks within 0.1%" v={i.askDepth.toPrecision(4)} tone="down" />
        <Row k="Imbalance" v={i.bidDepth + i.askDepth > 0 ? `${Math.round(((i.bidDepth - i.askDepth) / (i.bidDepth + i.askDepth)) * 100)}%` : '—'} />
        <p className="muted">Each tower is the depth at one price level: bids cyan on the west side, asks orange on the east, nearest the price at the front.</p>
      </div>
    );
  if (sel === 'fields')
    return (
      <div className="isl-holo-body">
        <Row k="Point of control" v={fmt(i.poc)} />
        <Row k="Traded, 15 min" v={i.vol15.toPrecision(4)} />
        <Row k="Bought" v={i.buy15 !== null ? `${Math.round(i.buy15 * 100)}%` : '—'} tone={i.buy15 !== null ? (i.buy15 >= 0.5 ? 'up' : 'down') : ''} />
        <p className="muted">Each row is a price, each step back a slice of the last 15 minutes: the crops grow with the volume traded. The gold row is where the market agreed on price.</p>
      </div>
    );
  if (sel === 'lighthouse')
    return (
      <div className="isl-holo-body">
        <Row k="Realised volatility" v={i.realized !== null ? `${(i.realized * 100).toFixed(0)}% a year` : '—'} />
        {['1 min', '5 min', '15 min'].map((h, k) => (
          <Row key={h} k={`Move over ${h}`} v={`${(i.rets[k] ?? 0) >= 0 ? '+' : ''}${(i.rets[k] ?? 0).toFixed(1)} bps`} tone={(i.rets[k] ?? 0) >= 0 ? 'up' : 'down'} />
        ))}
        <p className="muted">The three rings on the tower are the 1, 5 and 15-minute moves (top is the fastest): green up, red down, brighter for bigger. The beam turns faster and warms to red, the sea runs higher, and clouds and rain gather as the market gets wilder; a hard 1-minute move brings lightning. While you are here the beam follows your pointer.</p>
      </div>
    );
  if (sel === 'harbor')
    return (
      <div className="isl-holo-body">
        <Row k="Trades in the last minute" v={String(i.perMin)} />
        <Row k="Buying" v={i.buy1 !== null ? `${Math.round(i.buy1 * 100)}%` : '—'} tone={i.buy1 !== null ? (i.buy1 >= 0.5 ? 'up' : 'down') : ''} />
        <Row k="Average trade" v={i.avgUsd !== null ? `$${i.avgUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'} />
        {i.biggest && <Row k="Biggest, 15 min" v={`${i.biggest.side === 'buy' ? 'BUY' : 'SELL'} $${(i.biggest.price * i.biggest.qty).toLocaleString('en-US', { maximumFractionDigits: 0 })} · ${clock(i.biggest.time)}`} tone={i.biggest.side === 'buy' ? 'up' : 'down'} />}
        <p className="muted">Every big trade sails in as a boat, bigger for bigger trades: gold sails moor west of the pier (buyers), red sails east (sellers), and the crane swings the cargo ashore. The crates in the yard are the last minute's buying (west) and selling (east); the buoys light green while buyers lead, red while sellers do. Hover a boat for its trade.</p>
      </div>
    );
  return (
    <div className="isl-holo-body">
      <Row k="Price" v={fmt(i.price)} />
      <Row k="15 min" v={i.change !== null ? `${i.change >= 0 ? '+' : ''}${i.change.toFixed(2)}%` : '—'} tone={(i.change ?? 0) >= 0 ? 'up' : 'down'} />
      <Row k="In the valley" v={i.window ? `${fmt(i.window.lo)} – ${fmt(i.window.hi)}` : '—'} />
      <p className="muted">The river is the price, flowing from 15 minutes ago (the back of the valley) to now (the orb), between the walls of resting orders.</p>
    </div>
  );
}

/** The balances: the one thing on screen that is not on the island. */
function MoneyBar() {
  const cs = useCSwarm((s) => s.state);
  const [busy, setBusy] = useState(false);
  const go = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } catch {
      /* the Swarm panel shows errors */
    } finally {
      setBusy(false);
    }
  };
  if (!cs)
    return (
      <div className="isl-money">
        <span className="isl-m">
          <small>CRYPTO SWARM</small>
          <b>{desktop ? 'starting…' : 'in the desktop app'}</b>
        </span>
      </div>
    );
  const eq = cs.equity;
  const b = cs.book;
  const today = eq !== null && b.dayStart > 0 ? eq - b.dayStart : null;
  const open = cs.open.reduce((a, p) => a + (p.upnl ?? 0), 0);
  return (
    <div className="isl-money">
      <span className="isl-m">
        <small>SWARM</small>
        <b>
          <i className={`vt-dot${cs.running ? (cs.mode === 'live' ? ' live' : ' on') : ''}`} /> {cs.running ? (cs.mode === 'live' ? `LIVE${cs.sandbox ? ' TESTNET' : ''}` : 'PAPER') : 'ASLEEP'}
        </b>
      </span>
      {desktop &&
        (cs.running ? (
          <button className="isl-btn" disabled={busy} onClick={() => go(() => desktop!.cswarm.stop(false))}>
            Stop
          </button>
        ) : (
          <button className="isl-btn go" disabled={busy} onClick={() => go(() => desktop!.cswarm.start())}>
            ▶ Wake the swarm
          </button>
        ))}
      <span className="isl-sep" />
      <span className="isl-m">
        <small>{cs.mode === 'live' ? 'HYPERLIQUID' : 'PAPER ACCOUNT'}</small>
        <b className="mono">{eq !== null ? usd(eq) : '—'}</b>
      </span>
      <span className="isl-m">
        <small>TODAY</small>
        <b className={`mono ${today === null ? '' : today >= 0 ? 'up' : 'down'}`}>{today !== null ? signed(today) : '—'}</b>
      </span>
      <span className="isl-m">
        <small>{cs.open.length ? 'IN A TRADE' : 'POSITION'}</small>
        <b className={`mono ${cs.open.length ? (open >= 0 ? 'up' : 'down') : ''}`}>{cs.open.length ? `${signed(open)} · ${cs.open.map((p) => `${p.side === 'buy' ? 'long' : 'short'} ${p.coin}`).join(', ')}` : 'flat'}</b>
      </span>
      <span className="isl-m">
        <small>FLOOR</small>
        <b className="mono">{b.floor ? usd(b.floor) : '—'}</b>
      </span>
    </div>
  );
}
