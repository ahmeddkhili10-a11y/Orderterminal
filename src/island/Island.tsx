// The crypto terminal is an island: everything lives on it and is a click
// away — the order book, the volume profile, volatility and the tape on their
// pads, the swarm's council hall with every agent's beacon and gauge, the price
// itself. Click one and the camera flies there and its card opens beside it;
// click the sea or press Esc to fly back. Only the money stays on screen: a
// strip at the bottom, centred.
import { useEffect, useMemo, useRef, useState } from 'react';
import { hub } from '../market/hub';
import { useSettings } from '../store/settings';
import { useCSwarm } from '../cswarm/store';
import { desktop, type CSwarmLine } from '../desktop/bridge';
import { bookBars, gauges, lights, priceWindow, profileRidge, tapeCloud, terrain, volWave, type GaugeRead, type Window } from './model';
import { Island as Island3D, PLACE_NAME, webglOk, type IslandFrame, type Peek, type Place } from './island3d';
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
  const engine = useRef<Island3D | null>(null);
  const win = useRef<Window | null>(null);
  const winKey = useRef('');
  const seen = useRef(0);
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
    const t = setTimeout(() => setHint(false), 9000);
    return () => clearTimeout(t);
  }, []);

  // the 3D engine
  useEffect(() => {
    if (!gl || !host.current) return;
    try {
      const e = new Island3D(host.current, setPeek, setSel);
      e.detail = card.current;
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
    if (engine.current) engine.current.detail = card.current;
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
      // the window recentres only when the price has walked well away (no jitter)
      const w0 = win.current;
      const half = w0 ? (w0.hi - w0.lo) / 2 : 0;
      if (!w0 || Math.abs(mid - (w0.lo + half)) > half * 0.45 || f.key !== winKey.current) {
        win.current = { ...priceWindow(mid, res), t0: now - SPAN, t1: now };
        winKey.current = f.key;
      }
      // up to 15 minutes; with less history so far, what there is fills the island
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
      // agents that spoke since the last frame send a spark to the council
      const ls = useCSwarm.getState().lines;
      const spoke = new Set(ls.filter((l) => l.t > seen.current).map((l) => l.agent));
      seen.current = ls.length ? ls[ls.length - 1].t : seen.current;
      const lastVerdict = [...ls].reverse().find((l) => l.agent === 'council');
      const frame: IslandFrame = {
        terrain: terrain(snaps, mids, w),
        window: w,
        lights: lights(trades, w).lights,
        price: mid,
        positions: (st?.open ?? [])
          .filter((p) => p.coin === base)
          .map((p) => ({ id: p.id, side: p.side, entry: p.entry, stop: p.stop, target: p.target, label: `${p.side === 'buy' ? 'LONG' : 'SHORT'} ${p.coin} by the ${NAME[p.agent]} · entry ${fmt(p.entry)} · stop ${fmt(p.stop)} · target ${fmt(p.target)} · open ${signed(p.upnl ?? 0)}` })),
        agents: gs.map((x) => ({ id: x.id, name: x.name, value: x.value, text: x.text, sub: x.sub, spoke: spoke.has(x.id as CSwarmLine['agent']) })),
        book: bookBars(bids, asks, 24),
        wave,
        cloud: tapeCloud(trades.slice(-1500)),
        ridge,
        tags: {
          book: spread !== null ? `spread ${spread.toFixed(1)} bps` : '',
          ridge: inf.poc !== null ? `POC ${fmt(inf.poc)}` : '',
          wave: inf.realized !== null ? `${(inf.realized * 100).toFixed(0)}% a year` : '',
          cube: inf.buy1 !== null ? `${Math.round(inf.buy1 * 100)}% buying` : '',
          council: !st?.running ? 'swarm stopped — click to start' : lastVerdict ? lastVerdict.text.replace(/^[A-Z]+: /, '').slice(0, 34) : 'listening',
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
  const feed = useMemo(() => [...lines].reverse().filter((l) => (agentId ? l.agent === agentId : true)).slice(0, agentId ? 8 : 14), [lines, agentId]);

  return (
    <div className="island">
      <div className="island-host" ref={host}>
        {!gl && <div className="island-nogl">The island is drawn in 3D (WebGL), which this computer's graphics do not offer. Switch to ▦ Panels on the top bar for the same market and swarm.</div>}
      </div>

      {/* the card of the place you visited, placed beside it by the engine */}
      <div className={`isl-detail${sel ? ' open' : ''}`} ref={card}>
        {sel && (
          <>
            <header>
              <i className="isl-dot" />
              <b>{agentId ? (g.find((x) => x.id === agentId)?.name ?? agentId) : PLACE_NAME[sel]}</b>
              <button className="isl-x" onClick={() => engine.current?.home()} title="Back to the island (Esc)">
                ✕
              </button>
            </header>
            <Detail sel={sel} info={info} g={g} feed={feed} />
          </>
        )}
      </div>

      <MoneyStrip />
      {hint && gl && <div className="isl-hint">drag to look around · scroll to zoom · click anything on the island to explore it</div>}

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

function Detail({ sel, info, g, feed }: { sel: Place; info: Info | null; g: GaugeRead[]; feed: CSwarmLine[] }) {
  const cs = useCSwarm((s) => s.state);
  const i = info;
  if (sel.startsWith('agent:')) {
    const id = sel.slice(6);
    const r = g.find((x) => x.id === id);
    return (
      <div className="isl-detail-body">
        <div className="isl-gauge-big" style={{ ['--v' as string]: Math.max(0.02, Math.min(1, r?.value ?? 0)) }}>
          <span className="mono">{r?.text ?? '—'}</span>
        </div>
        <p className="muted">{r?.sub}</p>
        <p>{ROLE[id]}</p>
        <div className="isl-feed">{feed.length ? feed.map((l, k) => <div key={k} className={`isl-line ${l.kind}`}>{l.text}</div>) : <div className="muted">Nothing said yet.</div>}</div>
      </div>
    );
  }
  if (sel === 'council') {
    return (
      <div className="isl-detail-body">
        <p className="muted">Scalper, Auctioneer and Trend propose; Tape, Crowd, Guardian, Forest and Risk vote. A trade needs no veto and a score of 2.</p>
        {(cs?.open ?? []).map((p) => (
          <div key={p.id} className={`isl-pos ${(p.upnl ?? 0) >= 0 ? 'up' : 'down'}`}>
            {p.side === 'buy' ? 'LONG' : 'SHORT'} {p.coin} · {NAME[p.agent]} · {fmt(p.entry)} · stop {fmt(p.stop)} · target {fmt(p.target)} · {signed(p.upnl ?? 0)}
          </div>
        ))}
        <div className="isl-feed">
          {feed.length ? (
            feed.map((l, k) => (
              <div key={k} className={`isl-line ${l.kind}`}>
                <b>{NAME[l.agent] ?? l.agent}</b> {l.text}
              </div>
            ))
          ) : (
            <div className="muted">Quiet — start the crypto swarm (bottom of the screen) and its agents talk here.</div>
          )}
        </div>
      </div>
    );
  }
  if (!i) return <div className="isl-detail-body muted">Waiting for the market…</div>;
  if (sel === 'book')
    return (
      <div className="isl-detail-body">
        <Row k="Best bid / ask" v={`${fmt(i.bestBid)} / ${fmt(i.bestAsk)}`} />
        <Row k="Spread" v={i.spread !== null ? `${i.spread.toFixed(2)} bps` : '—'} tone={i.spread !== null && i.spread > 8 ? 'down' : ''} />
        <Row k="Bids within 0.1%" v={i.bidDepth.toPrecision(4)} tone="up" />
        <Row k="Asks within 0.1%" v={i.askDepth.toPrecision(4)} tone="down" />
        <Row k="Imbalance" v={i.bidDepth + i.askDepth > 0 ? `${Math.round(((i.bidDepth - i.askDepth) / (i.bidDepth + i.askDepth)) * 100)}%` : '—'} />
        <p className="muted">Bids cyan on the left, asks orange on the right, nearest the price in the middle. On the island, the same book is the mountains: walls of orders rise as peaks.</p>
      </div>
    );
  if (sel === 'ridge')
    return (
      <div className="isl-detail-body">
        <Row k="Point of control" v={fmt(i.poc)} />
        <Row k="Traded, 15 min" v={i.vol15.toPrecision(4)} />
        <Row k="Bought" v={i.buy15 !== null ? `${Math.round(i.buy15 * 100)}%` : '—'} tone={i.buy15 !== null ? (i.buy15 >= 0.5 ? 'up' : 'down') : ''} />
        <p className="muted">Volume at each price, slice by slice over the last 15 minutes. The tallest, brightest bars are where the market agreed on price — the point of control.</p>
      </div>
    );
  if (sel === 'wave')
    return (
      <div className="isl-detail-body">
        <Row k="Realised volatility" v={i.realized !== null ? `${(i.realized * 100).toFixed(0)}% a year` : '—'} />
        {['1 min', '5 min', '15 min'].map((h, k) => (
          <Row key={h} k={`Move over ${h}`} v={`${(i.rets[k] ?? 0) >= 0 ? '+' : ''}${(i.rets[k] ?? 0).toFixed(1)} bps`} tone={(i.rets[k] ?? 0) >= 0 ? 'up' : 'down'} />
        ))}
        <p className="muted">The ribbon runs through the 1, 5 and 15-minute moves (green, blue, purple) over the last half hour: a calm market lies flat, a wild one waves.</p>
      </div>
    );
  if (sel === 'cube')
    return (
      <div className="isl-detail-body">
        <Row k="Trades in the last minute" v={String(i.perMin)} />
        <Row k="Buying" v={i.buy1 !== null ? `${Math.round(i.buy1 * 100)}%` : '—'} tone={i.buy1 !== null ? (i.buy1 >= 0.5 ? 'up' : 'down') : ''} />
        <Row k="Average trade" v={i.avgUsd !== null ? `$${i.avgUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'} />
        {i.biggest && <Row k="Biggest, 15 min" v={`${i.biggest.side === 'buy' ? 'BUY' : 'SELL'} $${(i.biggest.price * i.biggest.qty).toLocaleString('en-US', { maximumFractionDigits: 0 })} · ${clock(i.biggest.time)}`} tone={i.biggest.side === 'buy' ? 'up' : 'down'} />}
        <p className="muted">Every recent trade as a point: across is time, up is price, deep is size — blue small, red large.</p>
      </div>
    );
  return (
    <div className="isl-detail-body">
      <Row k="Price" v={fmt(i.price)} />
      <Row k="15 min" v={i.change !== null ? `${i.change >= 0 ? '+' : ''}${i.change.toFixed(2)}%` : '—'} tone={(i.change ?? 0) >= 0 ? 'up' : 'down'} />
      <Row k="On the island" v={i.window ? `${fmt(i.window.lo)} – ${fmt(i.window.hi)}` : '—'} />
      <p className="muted">The river is the price, flowing from the back of the island (15 minutes ago) to the front (now), between the walls of resting orders.</p>
    </div>
  );
}

/** The money: the only thing on screen that is not on the island. */
function MoneyStrip() {
  const cs = useCSwarm((s) => s.state);
  const [busy, setBusy] = useState(false);
  if (!cs)
    return (
      <div className="isl-money">
        <div className="isl-chip isl-chip-swarm">
          <small>CRYPTO SWARM</small>
          <b>{desktop ? 'starting…' : 'desktop app'}</b>
          <span>{desktop ? 'connecting to its engine' : 'the swarm and its account run in the desktop app'}</span>
        </div>
        {['ACCOUNT', 'TODAY', 'POSITION', 'FLOOR'].map((k) => (
          <div key={k} className="isl-chip">
            <small>{k}</small>
            <b className="mono">—</b>
            <span>&nbsp;</span>
          </div>
        ))}
      </div>
    );
  const eq = cs.equity;
  const b = cs.book;
  const today = eq !== null && b.dayStart > 0 ? eq - b.dayStart : null;
  const open = cs.open.reduce((a, p) => a + (p.upnl ?? 0), 0);
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
  return (
    <div className="isl-money">
      <div className="isl-chip isl-chip-swarm">
        <small>CRYPTO SWARM</small>
        <b>
          <span className={`vt-dot${cs.running ? (cs.mode === 'live' ? ' live' : ' on') : ''}`} /> {cs.running ? (cs.mode === 'live' ? `LIVE${cs.sandbox ? ' testnet' : ''}` : 'paper') : 'stopped'}
        </b>
        {desktop &&
          (cs.running ? (
            <button className="chip" disabled={busy} onClick={() => go(() => desktop!.cswarm.stop(false))}>
              Stop
            </button>
          ) : (
            <button className="chip isl-go" disabled={busy} onClick={() => go(() => desktop!.cswarm.start())}>
              ▶ Start
            </button>
          ))}
      </div>
      <div className="isl-chip">
        <small>{cs.mode === 'live' ? 'HYPERLIQUID' : 'PAPER ACCOUNT'}</small>
        <b className="mono">{eq !== null ? usd(eq) : '—'}</b>
        <span>started {usd(b.start || 0)}</span>
      </div>
      <div className="isl-chip">
        <small>TODAY</small>
        <b className={`mono ${today === null ? '' : today >= 0 ? 'up' : 'down'}`}>{today !== null ? signed(today) : '—'}</b>
        <span>{cs.totals.trades ? `${cs.totals.trades} trades · ${Math.round((cs.totals.wins / cs.totals.trades) * 100)}% won` : 'no trades yet'}</span>
      </div>
      <div className="isl-chip">
        <small>{cs.open.length ? 'IN A TRADE' : 'POSITION'}</small>
        <b className={`mono ${cs.open.length ? (open >= 0 ? 'up' : 'down') : ''}`}>{cs.open.length ? signed(open) : 'flat'}</b>
        <span>{cs.open.length ? cs.open.map((p) => `${p.side === 'buy' ? 'long' : 'short'} ${p.coin}`).join(' · ') : 'waiting for the council'}</span>
      </div>
      <div className="isl-chip">
        <small>FLOOR</small>
        <b className="mono">{b.floor ? usd(b.floor) : '—'}</b>
        <span>stops trading under it</span>
      </div>
    </div>
  );
}
