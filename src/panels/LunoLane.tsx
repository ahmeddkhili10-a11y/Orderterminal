// The Luno lane in the Command Center drawer: rands on Luno into real crypto,
// one daily trend bot per pair, beside the meme swarm. Optional.
import { useEffect, useMemo, useState } from 'react';
import { openConnections } from '../app/connect';
import { desktop, type AccountSnapshot, type CcxtMarket, type CcxtTicker, type SecretRecord } from '../desktop/bridge';
import { useAmtBots, useAmtLive } from '../desktop/amt';
import { vault } from '../desktop/vault';
import { fmtZar, isLaneBot, laneBot, LUNO, shareFits, shareZar, useLuno, zarPairs } from '../luno/lane';
import { Chip, Empty, NumberInput, Select } from '../ui/controls';

const clean = (e: unknown) => {
  const msg = String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  return /ENOTFOUND|ETIMEDOUT|ECONNRE|EAI_AGAIN|fetch failed|NetworkError|RequestTimeout/i.test(msg) ? 'cannot reach Luno right now — check the internet connection; it tries again every 30 s' : msg;
};

export function LunoLane() {
  const cfg = useLuno();
  const [keys, setKeys] = useState<SecretRecord[] | null>(null);
  const [markets, setMarkets] = useState<CcxtMarket[]>([]);
  const [tickers, setTickers] = useState<Record<string, CcxtTicker>>({});
  const [acct, setAcct] = useState<AccountSnapshot | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [bots, reload] = useAmtBots();
  const snaps = useAmtLive((s) => s.snaps);

  useEffect(() => {
    vault
      .list()
      .then((l) => {
        const k = l.filter((r) => r.kind === 'exchange' && r.exchange === LUNO);
        setKeys(k);
        if (k.length && !k.some((r) => r.id === useLuno.getState().secretId)) useLuno.getState().set({ secretId: k[0].id });
      })
      .catch(() => setKeys([]));
  }, []);

  // prices (public) and the account (with the key) while the drawer is open
  useEffect(() => {
    if (!desktop) return;
    let gotMarkets = false;
    const load = () => {
      if (!gotMarkets)
        desktop!.ccxt
          .markets(LUNO)
          .then((m) => {
            gotMarkets = true;
            setMarkets(zarPairs(m));
            setErr((e) => (e.startsWith('Luno markets') ? '' : e));
          })
          .catch((e) => setErr(`Luno markets: ${clean(e)}`));
      desktop!.ccxt
        .tickers(LUNO)
        .then((l) => setTickers(Object.fromEntries(l.map((t) => [t.symbol, t]))))
        .catch(() => undefined);
      if (cfg.secretId)
        desktop!.ccxt
          .account(cfg.secretId)
          .then(setAcct)
          .catch((e) => setErr(`Luno account: ${clean(e)}`));
    };
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [cfg.secretId]);

  const lane = useMemo(() => (bots ?? []).filter(isLaneBot), [bots]);
  const running = lane.filter((b) => b.running);
  const share = shareZar(cfg);
  const key = keys?.find((k) => k.id === cfg.secretId);
  const canTrade = key?.meta.fields.trading === 'enabled';
  const minOrder = (m: CcxtMarket) => (m.minAmount && tickers[m.symbol]?.last ? m.minAmount * tickers[m.symbol].last : null);

  if (!desktop) return <Empty>The Luno lane runs in the desktop app: the key stays in its main process.</Empty>;

  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what);
    setErr('');
    try {
      await f();
    } catch (e) {
      setErr(clean(e));
    } finally {
      setBusy('');
      reload();
    }
  };

  const start = () =>
    run('start', async () => {
      if (!cfg.secretId) throw new Error('connect your Luno key first (Connect → Luno) — Luno shares its price candles only with a key');
      if (!cfg.pairs.length) throw new Error('choose at least one pair');
      if (cfg.mode === 'live' && !canTrade) throw new Error('this key is read-only — tick “Allow trading” on it under Connect → Luno to trade live');
      const trend = (await desktop!.amt.presets()).trend;
      // the old lane stops first (a bot's settings change only while stopped); its coins stay on the account
      for (const b of lane) if (b.running) await desktop!.amt.stop(b.id);
      for (const b of lane) if (!cfg.pairs.includes(b.symbol)) await desktop!.amt.remove(b.id);
      for (const symbol of cfg.pairs) {
        const old = lane.find((b) => b.symbol === symbol);
        const id = await desktop!.amt.save(laneBot(trend, symbol, cfg, old?.id));
        await desktop!.amt.start(id);
      }
    });
  const stop = () =>
    run('stop', async () => {
      for (const b of running) await desktop!.amt.stop(b.id);
    });
  const togglePair = (s: string) => cfg.set({ pairs: cfg.pairs.includes(s) ? cfg.pairs.filter((p) => p !== s) : [...cfg.pairs, s] });

  const zar = acct?.balances.find((b) => b.currency === 'ZAR');
  const coins = (acct?.balances ?? []).filter((b) => b.currency !== 'ZAR' && b.total > 0);

  return (
    <div className="swarm-rules luno-lane">
      <div className="muted swarm-note">
        Real crypto against rands on Luno, beside the meme swarm. Each pair gets a spot trend bot: once a day, at the daily close, its 20-, 60- and 120-day trends vote; it holds the coin in proportion to how many point up and sells when they turn down. No leverage, no liquidation. It trades a few times a month — this is the slow, steady lane. Optional: nothing runs until you start it.
      </div>

      <div className="section-title">Luno key</div>
      {keys === null ? (
        <div className="muted">Loading…</div>
      ) : keys.length ? (
        <label className="swarm-rule">
          <span>Key</span>
          <Select value={cfg.secretId} options={keys.map((k) => ({ value: k.id, label: k.label }))} onChange={(secretId) => cfg.set({ secretId })} width={160} />
          <span className="muted">{canTrade ? '● trading on — it can buy and sell, never withdraw' : '● read-only — enough for paper; tick “Allow trading” on it (Connect → Luno) to trade live'}</span>
        </label>
      ) : (
        <div className="swarm-rule">
          <span>Not connected</span>
          <button className="chip" onClick={openConnections}>
            Connect → Luno
          </button>
          <span className="muted">Luno → Security → API keys. Give it trading permission only — never send or withdraw. Even paper needs the key: Luno shares its price candles only with one.</span>
        </div>
      )}

      {acct && (
        <div className="swarm-wallet">
          <div>
            <div className="muted">Rands</div>
            <div className="mono swarm-balance">{fmtZar(zar?.total ?? 0)}</div>
            <div className="muted">{zar?.free !== null && zar?.free !== undefined ? `${fmtZar(zar.free)} free` : ''}</div>
          </div>
          <div>
            <div className="muted">Coins</div>
            <div className="mono">{coins.length ? coins.map((c) => `${+c.total.toFixed(6)} ${c.currency}`).join(' · ') : 'none'}</div>
          </div>
          {acct.errors && Object.keys(acct.errors).length > 0 && <div className="muted">{Object.values(acct.errors)[0]}</div>}
        </div>
      )}

      <div className="section-title">Mode</div>
      <div className="swarm-modes">
        <Chip active={cfg.mode === 'paper'} onClick={() => cfg.set({ mode: 'paper' })}>
          Paper
        </Chip>
        <Chip active={cfg.mode === 'live'} onClick={() => cfg.set({ mode: 'live' })}>
          Live
        </Chip>
        <span className="muted">
          {cfg.mode === 'paper'
            ? 'Simulated against Luno’s real prices, from the rands below. Nothing is bought.'
            : 'Live: real orders on Luno from the rands on the account, split evenly across the pairs. A bot treats all of its coin on the account as its own. The terminal’s order cap (ticket ⚙ limits) still applies.'}
        </span>
      </div>

      <label className="swarm-rule">
        <span>Rands</span>
        <NumberInput value={cfg.bankZar} onChange={(bankZar) => cfg.set({ bankZar: Math.max(50, bankZar) })} min={50} step={50} suffix="R" />
        <span className="muted">{cfg.mode === 'paper' ? 'the paper bank' : 'for its records — live, each bot sizes from its share of the free rands on Luno'} · {fmtZar(share)} a pair</span>
      </label>

      <div className="section-title">Pairs</div>
      {markets.length ? (
        <div className="luno-pairs">
          {markets.slice(0, 16).map((m) => {
            const t = tickers[m.symbol];
            const on = cfg.pairs.includes(m.symbol);
            const min = minOrder(m);
            const fits = shareFits(on ? share : shareZar({ bankZar: cfg.bankZar, pairs: [...cfg.pairs, m.symbol] }), min);
            return (
              <button key={m.symbol} className={`luno-pair${on ? ' active' : ''}${fits ? '' : ' tight'}`} onClick={() => togglePair(m.symbol)} title={min ? `Smallest Luno order ≈ ${fmtZar(min)}` : undefined}>
                <b>{m.base}</b>
                <span className="mono">{t ? fmtZar(t.last) : '—'}</span>
                {t && <span className={`mono ${t.change24hPct >= 0 ? 'up' : 'down'}`}>{t.change24hPct >= 0 ? '+' : ''}{t.change24hPct.toFixed(1)}%</span>}
                {!fits && <span className="muted">share under 3× the smallest order</span>}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="muted">{err ? '' : 'Loading Luno’s rand pairs…'}</div>
      )}
      {cfg.pairs.some((s) => {
        const m = markets.find((x) => x.symbol === s);
        return m && !shareFits(share, minOrder(m));
      }) && <div className="muted swarm-note">With {fmtZar(cfg.bankZar)} over {cfg.pairs.length} pairs, a share is close to the smallest order on a marked pair — it may skip trades there. Fewer pairs trade more cleanly on a small bank.</div>}

      <div className="swarm-modes">
        <button className="chip" disabled={!!busy || !cfg.pairs.length} onClick={start}>
          {busy === 'start' ? 'Starting…' : running.length ? 'Restart the lane' : `Start the lane (${cfg.mode})`}
        </button>
        {running.length > 0 && (
          <button className="chip" disabled={!!busy} onClick={stop} title="Stops the bots; the coins they bought stay on your Luno account">
            {busy === 'stop' ? 'Stopping…' : 'Stop'}
          </button>
        )}
        <span className="muted">{running.length ? `${running.length} running` : 'stopped'}</span>
      </div>
      {err && <div className="down swarm-note">{err}</div>}

      {lane.length > 0 && (
        <>
          <div className="section-title">The lane</div>
          <table className="grid luno-table">
            <thead>
              <tr>
                <th>Pair</th>
                <th>Trends</th>
                <th>Target</th>
                <th>Held</th>
                <th>Worth</th>
                <th>P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {lane.map((b) => {
                const s = snaps[b.id];
                const tr = s?.trend;
                const up = tr?.votes.filter((v) => v.vote > 0).length ?? 0;
                const pnl = tr?.equity !== null && tr?.equity !== undefined ? tr.equity - tr.start : null;
                return (
                  <tr key={b.id} title={tr?.explain || s?.feedError || ''}>
                    <td>
                      <span className={b.running ? 'up' : 'muted'}>●</span> {b.symbol} <span className="muted">{b.mode}</span>
                    </td>
                    <td className="mono">{!b.running ? '—' : tr?.ready ? `${up}/${tr.votes.length} up` : s?.feedError ? 'error' : 'reading…'}</td>
                    <td className="mono">{tr?.target !== null && tr?.target !== undefined ? `${Math.round(tr.target * 100)}%` : '—'}</td>
                    <td className="mono">{tr ? `${Math.round(tr.held * 100)}%` : '—'}</td>
                    <td className="mono">{fmtZar(tr?.equity)}</td>
                    <td className={`mono ${pnl === null ? '' : pnl >= 0 ? 'up' : 'down'}`}>{pnl === null ? '—' : `${pnl >= 0 ? '+' : '−'}${fmtZar(Math.abs(pnl))}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="muted swarm-note">Trades and problems alert here and on Telegram (the swarm’s alert settings). Each bot’s full log and a backtest on Luno’s history are in the Bots panel.</div>
        </>
      )}
    </div>
  );
}
