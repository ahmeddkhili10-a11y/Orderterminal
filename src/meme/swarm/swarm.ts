// The swarm: five bots working the meme-coin chain together, every two seconds.
//
//   Scout      — every launch, migration and DexScreener listing (the scanner)
//   Sentinel   — viability: rejects the rugs, bundles, dumps and wash trades
//   Herald     — virality: new wallets arriving, the meme's narrative, socials
//   Strategist — enters when heat, virality and viability all line up
//   Manager    — runs the trade: take profits, trailing stop, stop loss, rug exits
//
// Trades are on paper, or live from the swarm's own wallet (signed in the main
// process within hard limits, no approval clicks). Every pick (and a sample of
// passed-but-not-picked coins) is followed for an hour, so the hit rates per
// conviction level show whether the strategy works.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { desktop, type SwarmLimits } from '../../desktop/bridge';
import { fetchJson } from '../../exchanges/ws';
import { getSettings } from '../../store/settings';
import { scanner, useMeme } from '../scanner';
import { assess } from '../score';
import type { MemeToken } from '../token';
import { herald, insiderRead, isSmart, learnSmart, Narratives, sentinel, strategist, STRATEGY_DEFAULTS, type CreatorRecord, type SmartBook, type StrategyConfig, type Viability, type Virality } from './agents';
import { MIN_TRADE_SOL, riskGate, TRADE_SHARE, tradeSize } from './bankroll';
import { applySell, decideExit, managePosition, MANAGER_DEFAULTS, markPrice, multiple, newMilestone, openPosition, pnlSol, quoteSell, type ExitDecision, type ManagerConfig, type Position } from './book';
import { alertHere, tellWithCard, type CardBadge } from './notify';
import { FakeFilter } from './fakes';
import { council, MARK, type CouncilBot } from './council';
import { features, type XStats } from './features';
import { classOf, Forest, oddsOf, type Odds } from './forest';
import { fmtReach, X_DEFAULTS, XWatch, type XConfig } from './xwatch';
import { convictionTilt, optimize, OPTIMIZER_DEFAULTS, sharedNarrative, shiftBook, trimShare, updateBook, type OptimizerConfig, type OptimizerRead, type RiskBook } from './optimizer';
import { follow, newOutcome, type Outcome } from './outcomes';

export type AgentId = 'scout' | 'sentinel' | 'herald' | 'strategist' | 'manager' | 'optimizer' | 'forest';

export interface LogLine {
  t: number;
  agent: AgentId;
  text: string;
  mint?: string;
}

export interface CoinRead {
  mint: string;
  symbol: string;
  heat: number;
  viability: Viability;
  virality: Virality | null;
  conviction: number;
  decision: string;
  enter: boolean;
  mcapUsd: number;
  /** insider tracker score (0–100) */
  insider: number;
  /** the decision forest's odds for it (coins that passed the Sentinel) */
  odds?: Odds;
}

export interface SwarmWallet {
  address: string;
  limits: SwarmLimits;
  spentToday: number;
  sol: number | null;
  /** the owner's Phantom wallet: withdrawals and profits go there, nowhere else */
  home?: string | null;
}

interface SwarmState {
  enabled: boolean;
  /** paper, or live: real trades from the swarm wallet, no approval click */
  mode: 'paper' | 'live';
  wallet: SwarmWallet | null;
  strategy: StrategyConfig;
  manager: ManagerConfig;
  positions: Position[];
  outcomes: Outcome[];
  /** wallets seen selling coins at 3×+ (the insider tracker's memory) */
  smart: SmartBook;
  optimizer: OptimizerConfig;
  /** the Optimizer's record of each book: start, high, start of today */
  risk: { live?: RiskBook; paper?: RiskBook };
  /** the paper (demo) trades were cleared once, when this version first ran */
  paperCleared?: boolean;
  /** the Herald on X (off until switched on; X bills each post read) */
  x: XConfig;
  // runtime (not saved)
  log: LogLine[];
  reads: CoinRead[];
  stats: {
    scout: { seen: number; perMin: number };
    sentinel: { checked: number; pass: number; watch: number; reject: number; top: { why: string; n: number }[] };
    herald: { scored: number; viral: number; narratives: { word: string; count: number }[]; xSearches: number };
    strategist: { signals: number; last: string; proven: number; insiderBest: number };
    forest: { n: number; accuracy: number | null; baseline: number | null; brier: number | null; trust: number; best: Odds | null; trainedAt: number; importance: number[] };
    manager: { open: number; closed: number; pnlSol: number; winRate: number | null };
    optimizer: (OptimizerRead & { equity: number | null }) | null;
  };
  set(p: Partial<SwarmState>): void;
  setOptimizer(p: Partial<OptimizerConfig>): void;
  setX(p: Partial<XConfig>): void;
  /** forget every paper (demo) trade: positions, fills and the paper record; live trades stay */
  clearPaper(): void;
  setStrategy(p: Partial<StrategyConfig>): void;
  setManager(p: Partial<ManagerConfig>): void;
  reset(): void;
}

const emptyStats = (): SwarmState['stats'] => ({
  scout: { seen: 0, perMin: 0 },
  sentinel: { checked: 0, pass: 0, watch: 0, reject: 0, top: [] },
  herald: { scored: 0, viral: 0, narratives: [], xSearches: 0 },
  strategist: { signals: 0, last: '', proven: 0, insiderBest: 0 },
  forest: { n: 0, accuracy: null, baseline: null, brier: null, trust: 0, best: null, trainedAt: 0, importance: [] },
  manager: { open: 0, closed: 0, pnlSol: 0, winRate: null },
  optimizer: null,
});

/** The saved swarm over the defaults. A sell in flight when the app closed is not in flight any more: those positions are managed again. */
export function mergeSwarm(persisted: unknown, current: SwarmState): SwarmState {
  const p = (persisted ?? {}) as Partial<SwarmState>;
  // the demo trades made before this version are cleared once; live trades always stay
  const clear = !p.paperCleared;
  const positions = (p.positions ?? []).filter((x) => !clear || x.live).map((x) => ({ ...x, pending: false, retryAt: undefined }));
  if (clear) p.risk = { ...p.risk, paper: undefined };
  p.paperCleared = true;
  // rules saved before the 5× strategy (no conviction floor): the new entry and exit rules,
  // keeping the account's sizing (positions, size, daily loss limit)
  if (p.strategy && !('minConviction' in p.strategy)) {
    const m = p.manager ?? MANAGER_DEFAULTS;
    return { ...current, ...p, positions, strategy: { ...STRATEGY_DEFAULTS }, manager: { ...MANAGER_DEFAULTS, sizeSol: m.sizeSol, maxOpen: m.maxOpen, dailyLossSol: m.dailyLossSol } };
  }
  return { ...current, ...p, positions, strategy: { ...STRATEGY_DEFAULTS, ...p.strategy }, manager: { ...MANAGER_DEFAULTS, ...p.manager }, optimizer: { ...OPTIMIZER_DEFAULTS, ...p.optimizer }, x: { ...X_DEFAULTS, ...p.x } };
}

export const useSwarm = create<SwarmState>()(
  persist(
    (set) => ({
      enabled: false,
      mode: 'paper',
      wallet: null,
      strategy: { ...STRATEGY_DEFAULTS },
      manager: { ...MANAGER_DEFAULTS },
      positions: [],
      outcomes: [],
      smart: {},
      optimizer: { ...OPTIMIZER_DEFAULTS },
      risk: {},
      x: { ...X_DEFAULTS },
      log: [],
      reads: [],
      stats: emptyStats(),
      set: (p) => set(p),
      setOptimizer: (p) => set((s) => ({ optimizer: { ...s.optimizer, ...p } })),
      setX: (p) => set((s) => ({ x: { ...s.x, ...p } })),
      clearPaper: () => set((s) => ({ positions: s.positions.filter((x) => x.live), risk: { ...s.risk, paper: undefined }, log: s.log.filter((l) => !/\(paper\)|· paper/.test(l.text)) })),
      setStrategy: (p) => set((s) => ({ strategy: { ...s.strategy, ...p } })),
      setManager: (p) => set((s) => ({ manager: { ...s.manager, ...p } })),
      reset: () => set({ positions: [], outcomes: [], log: [] }),
    }),
    {
      name: 'novus-swarm',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ enabled: s.enabled, mode: s.mode, strategy: s.strategy, manager: s.manager, positions: s.positions.slice(-300), outcomes: s.outcomes.slice(-4000), smart: s.smart, optimizer: s.optimizer, risk: s.risk, paperCleared: s.paperCleared, x: s.x }),
      merge: (persisted, current) => mergeSwarm(persisted, current),
    },
  ),
);

const TICK_MS = 2000;
/** a pick the council could not buy (a veto that can pass, no free slot, the daily limit, not armed) sits again after this, up to MAX_TRIES times */
const RETRY_MS = 60_000;
const MAX_TRIES = 4;

/** Which bot speaks for each council seat in the live feed. */
const AGENT_OF: Record<CouncilBot, AgentId> = { sentinel: 'sentinel', herald: 'herald', strategist: 'strategist', forest: 'forest', optimizer: 'optimizer' };

/** The x potential, in words: what the forest expects, its odds, and the room to the target. */
export function potentialText(p: NonNullable<Position['potential']>) {
  return `expects ${p.expMult.toFixed(2)}× · P(2×) ${Math.round(p.p2 * 100)}% · P(5×) ${Math.round(p.p5 * 100)}%${p.room ? ` · up to ${Math.round(p.room)}× of room to the target cap` : ''}${p.trust < 0.15 ? ' · forest still learning' : ''}`;
}

/** The card's badge on a buy: how far it could go (the room to the target cap), and what the forest expects. */
export function potentialBadge(p?: Position['potential']): CardBadge | undefined {
  if (!p) return undefined;
  return p.room
    ? { label: 'X POTENTIAL', value: `${p.room >= 10 ? Math.round(p.room) : p.room.toFixed(1)}×`, sub: `room to the target cap · expects ${p.expMult.toFixed(2)}× · P(5×) ${Math.round(p.p5 * 100)}%`, tone: 'accent' }
    : { label: 'X POTENTIAL', value: `${p.expMult.toFixed(2)}×`, sub: `expected · P(2×) ${Math.round(p.p2 * 100)}% · P(5×) ${Math.round(p.p5 * 100)}%`, tone: 'accent' };
}

/** The card's badge on a close: the x it ended at, against what was hoped for. */
export function resultBadge(p: Position): CardBadge {
  const x = p.costSol > 0 ? p.realizedSol / p.costSol : 0;
  const was = p.potential ? ` · potential was ${p.potential.room ? `${Math.round(p.potential.room)}×` : `${p.potential.expMult.toFixed(1)}×`}, expected ${p.potential.expMult.toFixed(2)}×` : '';
  return { label: 'RESULT', value: `${x.toFixed(2)}×`, sub: `peak ${p.peakMult.toFixed(2)}×${was}`, tone: x >= 1 ? 'buy' : 'sell' };
}

/** Followed coins the forest learns from: done, with their numbers kept. */
export function trainingRows(outcomes: Outcome[]) {
  return outcomes.filter((o) => o.done && o.x && o.x.length).map((o) => ({ x: o.x!, y: classOf(o.peak, o.last, o.lost) }));
}

class Swarm {
  private release: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private walletTimer: ReturnType<typeof setInterval> | null = null;
  private narratives = new Narratives();
  private creators = new Map<string, CreatorRecord>();
  private seen = new Set<string>();
  private seenTimes: number[] = [];
  private rugged = new Set<string>();
  private traded = new Set<string>();
  private controls = new Set<string>();
  private lastControl = 0;
  private metaInFlight = 0;
  private verdicts = new Map<string, Viability['verdict']>();
  private smartDone = new Set<string>();
  private fakes = new FakeFilter();
  /** picks the council turned down for a reason that can pass: when it may sit again, how often it has */
  private retryAt = new Map<string, number>();
  private tries = new Map<string, number>();
  private picks = new Map<string, Outcome>();
  /** the decision forest (null until it has learned from 30 followed coins) */
  forest: Forest | null = null;
  private training = false;
  private lastTrain = 0;
  private sampled = new Set<string>();
  /** what the Herald found on X, by coin */
  social = new Map<string, XStats>();
  private xw = new XWatch(
    (id, q, max) => desktop!.x.search(id, q, max),
    this.social,
    (mint, stats) => {
      scanner.watchMint(mint);
      this.say('herald', `spotted on X: ${mint.slice(0, 4)}…${mint.slice(-4)} — ${stats.posts} posts from ${stats.authors} accounts (${fmtReach(stats.reach)} followers) — sent to the swarm to be read`, mint);
    },
    (text, mint) => this.say('herald', text, mint),
  );
  private lastPrune = 0;
  private floorHit = false;
  private lastNotes = '';
  private lastOptGate: string | null = null;
  private lastLearn = 0;

  /** Retrain the forest on what the swarm has followed (every 10 minutes, once 30 coins are done). */
  private maybeTrain(outcomes: Outcome[], now: number) {
    if (this.training || (this.forest && now - this.lastTrain < 10 * 60_000)) return;
    const rows = trainingRows(outcomes);
    if (rows.length < 30 || (this.forest && rows.length === this.forest.stats.n)) return;
    this.training = true;
    this.lastTrain = now;
    void Forest.train(rows, undefined, now)
      .then((f) => {
        this.forest = f;
        const acc = f.stats.accuracy;
        this.say('forest', `retrained on ${f.stats.n} followed coins — right ${acc === null ? '—' : `${Math.round(acc * 100)}%`} of the time on coins it did not see (always guessing the commonest: ${Math.round((f.stats.baseline ?? 0) * 100)}%) · trust ${Math.round((f.stats.n / (f.stats.n + 60)) * 100)}%`);
      })
      .finally(() => (this.training = false));
  }

  /** Run while enabled; the scanner runs with it, whatever panels are open. */
  sync() {
    const on = useSwarm.getState().enabled;
    if (on && !this.timer) {
      this.release = scanner.use();
      // coins already traded (before a restart too) are not bought again
      for (const p of useSwarm.getState().positions) {
        this.traded.add(p.mint);
        if (!p.closedAt) scanner.pin(p.mint);
      }
      this.timer = setInterval(() => this.tick(), TICK_MS);
      void this.refreshWallet();
      this.walletTimer = setInterval(() => void this.refreshWallet(), 30_000);
      const live = useSwarm.getState().mode === 'live';
      this.say('scout', `Swarm on — watching every pump.fun launch, migration and DexScreener listing (${live ? 'LIVE trading from the swarm wallet' : 'paper trading'}).`);
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      if (this.walletTimer) clearInterval(this.walletTimer);
      this.walletTimer = null;
      this.release?.();
      this.release = null;
      this.say('scout', 'Swarm off.');
    }
  }

  private say(agent: AgentId, text: string, mint?: string) {
    useSwarm.setState((s) => ({ log: [...s.log.slice(-199), { t: Date.now(), agent, text, mint }] }));
  }

  private rpcId() {
    return getSettings().memeRpcSecretId || undefined;
  }

  /** The swarm wallet's state (live mode), refreshed every half minute. */
  async refreshWallet() {
    if (!desktop) return;
    try {
      const w = await desktop.swarm.wallet();
      if (!w) return useSwarm.setState({ wallet: null });
      const b = await desktop.swarm.balance(this.rpcId()).catch(() => null);
      const wallet = { address: w.address, limits: b?.limits ?? w.limits, spentToday: b?.spentToday ?? w.spentToday, sol: b ? b.sol : null, home: w.home ?? null };
      useSwarm.setState({ wallet });
      if (wallet.sol !== null) this.noticeFlows(wallet.sol);
      void this.sweepHome(wallet);
    } catch {
      /* keep the last state */
    }
  }

  /** the wallet's SOL at the last look, and what trades moved since */
  private lastSol: number | null = null;
  private tradeFlow = 0;

  /**
   * A change in the wallet no trade explains (0.01 SOL or more) is money moved
   * in or out — a deposit, a withdrawal, profits sent home: the Optimizer's
   * record shifts with it, so it is not read as a gain or a loss. Not judged
   * while a buy or sell is on its way.
   */
  private noticeFlows(sol: number) {
    const sw = useSwarm.getState();
    if (this.buying.size || sw.positions.some((p) => p.pending)) return;
    if (this.lastSol !== null) {
      const moved = sol - this.lastSol - this.tradeFlow;
      const book = sw.risk?.live;
      if (Math.abs(moved) >= 0.01 && book) {
        useSwarm.setState((s) => ({ risk: { ...s.risk, live: shiftBook(book, moved) } }));
        this.say('optimizer', `${moved > 0 ? 'deposit' : 'withdrawal'} of ${Math.abs(moved).toFixed(4)} SOL noticed — counted as money moved, not as a ${moved > 0 ? 'gain' : 'loss'}`);
      }
    }
    this.lastSol = sol;
    this.tradeFlow = 0;
  }

  private sweeping = false;

  /** Profits home: when switched on, SOL over the amount kept goes to the owner's Phantom (main checks the address and the amounts). */
  private async sweepHome(w: SwarmWallet) {
    if (!desktop || this.sweeping || this.buying.size || !w.home || !(w.limits.sweepAboveSol > 0) || w.sol === null) return;
    if (w.sol < w.limits.sweepAboveSol + 0.05) return;
    this.sweeping = true;
    try {
      const r = await desktop.swarm.sweep(this.rpcId());
      if (r) {
        this.say('manager', `sent ${r.sol.toFixed(4)} SOL of profit to your Phantom (kept ${w.limits.sweepAboveSol} SOL for trading)`);
        void tellWithCard(undefined, null, '', `💸 Swarm sent ${r.sol.toFixed(4)} SOL to your Phantom\nKept ${w.limits.sweepAboveSol} SOL in the swarm wallet for trading\nTx: https://solscan.io/tx/${r.signature}`, 0);
        void this.refreshWallet();
      }
    } catch (e) {
      this.say('manager', `could not send profits to Phantom — ${String((e as Error)?.message ?? e)}`);
    } finally {
      this.sweeping = false;
    }
  }

  private buying = new Set<string>();

  /** Buy for real from the swarm wallet; the position books what the chain says happened. */
  private async liveBuy(tok: MemeToken, sizeSol: number, why: string, conviction: number, mc: string, insiders?: string[], extra?: Pick<Position, 'potential' | 'council'>) {
    this.buying.add(tok.mint);
    this.say('manager', `${tok.symbol}: buying ${sizeSol} SOL live${mc}…`, tok.mint);
    try {
      const r = await desktop!.swarm.buy(tok.mint, sizeSol, this.rpcId());
      const decimals = r.decimals ?? 6;
      const raw = BigInt(r.tokenDelta ?? '0');
      const tokens = Number(raw) / 10 ** decimals;
      const cost = r.solDelta !== null ? -r.solDelta : sizeSol;
      this.tradeFlow -= cost;
      if (!(tokens > 0)) throw new Error(`the buy went through (${r.signature}) but no tokens showed up — check the wallet`);
      const now = Date.now();
      const p: Position = {
        id: `${tok.mint}-${now}`,
        mint: tok.mint,
        symbol: tok.symbol,
        openedAt: now,
        costSol: cost,
        entryPx: cost / tokens,
        tokens,
        left: tokens,
        realizedSol: 0,
        peakMult: 1,
        peakAt: now,
        tpDone: 0,
        fills: [{ t: now, side: 'buy', sol: cost, tokens, mult: 1, why }],
        why,
        conviction,
        live: { rawLeft: raw.toString(), decimals, buyTx: r.signature },
        insiders,
        ...extra,
      };
      useSwarm.setState((s) => ({ positions: [...s.positions, p] }));
      this.say('manager', `${tok.symbol}: bought live — ${cost.toFixed(4)} SOL for ${tokens.toLocaleString('en-US', { maximumFractionDigits: 0 })} tokens via ${r.via}`, tok.mint);
      alertHere(`Swarm bought ${tok.symbol} · LIVE`, `${cost.toFixed(3)} SOL${mc} — ${why}`, 'buy');
      void tellWithCard(tok, p, `Bought — ${cost.toFixed(3)} SOL`, `🐝 Swarm bought ${tok.symbol} (LIVE)${mc}\nPotential: ${p.potential ? potentialText(p.potential) : '—'}\nWhy: ${why}${p.council ? `\n${p.council.join('\n')}` : ''}\nPaid: ${cost.toFixed(4)} SOL incl. fees, via ${r.via}\nPlan: ${this.plan()}\nTx: https://solscan.io/tx/${r.signature}`, useMeme.getState().solUsd, potentialBadge(p.potential));
      void this.refreshWallet();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      this.say('manager', `${tok.symbol}: live buy failed — ${msg}`, tok.mint);
      void tellWithCard(undefined, null, '', `⚠️ Swarm could not buy ${tok.symbol}\nWhy: ${msg}`, 0);
    } finally {
      this.buying.delete(tok.mint);
    }
  }

  /** Sell for real; books the SOL that really came back. */
  private async liveSell(p: Position, d: ExitDecision) {
    if (!p.live) return;
    p.pending = true;
    const sym = p.symbol;
    try {
      const left = BigInt(p.live.rawLeft);
      const raw = d.share >= 1 ? 'all' : ((left * BigInt(Math.round(d.share * 1_000_000))) / 1_000_000n).toString();
      const r = await desktop!.swarm.sell(p.mint, raw, this.rpcId());
      // the chain's amounts when it reported them, else what was asked for (and SOL at the price now)
      const reported = r.tokenDelta !== null;
      const sold = reported ? -BigInt(r.tokenDelta!) : raw === 'all' ? left : BigInt(raw);
      const rest = left - sold > 0n ? left - sold : 0n;
      p.live.rawLeft = rest.toString();
      const tokens = Number(sold) / 10 ** p.live.decimals;
      const sol = r.solDelta ?? tokens * p.entryPx * (Number.isFinite(d.mult) ? d.mult : 0);
      if (!reported || r.solDelta === null) this.say('manager', `${sym}: the RPC did not report the sale's amounts yet — booked at the price now`, p.mint);
      applySell(p, Date.now(), tokens, sol, d.why, d.mult, d.share >= 1 || rest === 0n);
      this.tradeFlow += sol + (r.rentBack ?? 0);
      if (d.tp) p.tpDone++;
      p.retryAt = undefined;
      this.say('manager', `${sym}: sold live — ${sol.toFixed(4)} SOL back — ${d.why}`, p.mint);
      if (r.rentBack) this.say('manager', `${sym}: closed the empty token account — ${r.rentBack.toFixed(4)} SOL of rent back`, p.mint);
      this.afterSell(p, d, `https://solscan.io/tx/${r.signature}`);
      void this.refreshWallet();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/no tokens to sell/.test(msg)) {
        applySell(p, Date.now(), p.left, 0, 'no tokens left in the wallet — closed', d.mult, true);
        this.say('manager', `${sym}: nothing left in the wallet — position closed`, p.mint);
      } else {
        p.retryAt = Date.now() + 15_000;
        this.say('manager', `${sym}: live sell failed, retrying in 15 s — ${msg}`, p.mint);
      }
    } finally {
      p.pending = false;
      useSwarm.setState((s) => ({ positions: [...s.positions] }));
    }
  }

  private plan() {
    const m = useSwarm.getState().manager;
    return `${m.takeProfits.map((t) => `sell ${Math.round(t.sell * 100)}% at ${t.at}×`).join(', ')}, trail ${Math.round(m.trail * 100)}% from the peak once up ${m.trailFrom}×, stop −${Math.round(m.stopLoss * 100)}%`;
  }

  /** Telegram after a sell: a progress note for a take-profit, the result for a close. */
  private afterSell(p: Position, d: ExitDecision, tx?: string) {
    const { tokens, solUsd } = useMeme.getState();
    const tok = tokens[p.mint];
    const tag = p.live ? 'LIVE' : 'paper';
    if (p.closedAt) {
      const pnl = p.realizedSol - p.costSol;
      alertHere(`Swarm closed ${p.symbol} · ${tag}`, `${pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(4)} SOL · peak ${p.peakMult.toFixed(2)}× — ${d.why}`, pnl >= 0 ? 'buy' : 'sell');
      void tellWithCard(
        tok,
        p,
        `${pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(3)} SOL (${(((p.realizedSol / p.costSol) - 1) * 100).toFixed(0)}%)`,
        `${pnl >= 0 ? '💰' : '🔻'} Swarm closed ${p.symbol} (${tag}) at ${(p.realizedSol / p.costSol).toFixed(2)}× · ${pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(4)} SOL\nWhy: ${d.why}\nResult: paid ${p.costSol.toFixed(4)} SOL, got back ${p.realizedSol.toFixed(4)} SOL (${(p.realizedSol / p.costSol).toFixed(2)}×) · peak ${p.peakMult.toFixed(2)}× · held ${Math.max(1, Math.round((Date.now() - p.openedAt) / 60_000))} min${p.potential ? `\nAt the buy: ${potentialText(p.potential)}` : ''}${tx ? `\nTx: ${tx}` : ''}`,
        solUsd,
        resultBadge(p),
      );
    } else
      void tellWithCard(
        tok,
        p,
        `${d.mult.toFixed(2)}× — profit taken`,
        `✅ ${p.symbol} at ${d.mult.toFixed(2)}× (${tag}) — ${d.why}\nBanked so far: ${p.realizedSol.toFixed(4)} SOL of ${p.costSol.toFixed(4)} paid · still holding ${Math.round((p.left / p.tokens) * 100)}%${tx ? `\nTx: ${tx}` : ''}`,
        solUsd,
        { label: 'NOW', value: `${d.mult.toFixed(2)}×`, sub: `profit taken · banked ${(p.realizedSol / p.costSol).toFixed(2)}× of the cost so far`, tone: 'buy' },
      );
  }

  /** Sell a position now (the panel's button). */
  sellNow(id: string) {
    const p = useSwarm.getState().positions.find((x) => x.id === id);
    const { tokens, solUsd } = useMeme.getState();
    const tok = p ? tokens[p.mint] : undefined;
    if (!p || p.closedAt || p.pending) return;
    const mult = tok ? multiple(p, tok, solUsd) : NaN;
    const d: ExitDecision = { share: 1, why: 'sold by you', mult: Number.isFinite(mult) ? mult : 0, tp: false };
    if (p.live) void this.liveSell(p, d);
    else if (tok) {
      const sol = Number.isFinite(mult) ? p.left * p.entryPx * mult * 0.98 : 0;
      applySell(p, Date.now(), p.left, sol, d.why, d.mult, true);
      this.afterSell(p, d);
      useSwarm.setState((s) => ({ positions: [...s.positions] }));
    }
  }

  /** Socials from the coin's metadata file (fetched only for coins worth a look). */
  private fetchMeta(tok: MemeToken) {
    if (tok.meta || !tok.uri || this.metaInFlight >= 2) return;
    const url = tok.uri.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${tok.uri.slice(7)}` : tok.uri;
    if (!/^https:\/\//.test(url)) {
      tok.meta = { fetchedAt: Date.now(), error: 'no https metadata' };
      return;
    }
    this.metaInFlight++;
    fetchJson(url)
      .then((m: any) => {
        tok.meta = { twitter: m?.twitter || undefined, telegram: m?.telegram || undefined, website: m?.website || undefined, description: typeof m?.description === 'string' ? m.description.slice(0, 280) : undefined, fetchedAt: Date.now() };
        if (!tok.image && typeof m?.image === 'string') tok.image = m.image;
      })
      .catch((e) => (tok.meta = { fetchedAt: Date.now(), error: String(e?.message ?? e) }))
      .finally(() => this.metaInFlight--);
  }

  tick(now = Date.now()) {
    const sw = useSwarm.getState();
    const { tokens, solUsd } = useMeme.getState();
    const all = Object.values(tokens);
    // Scout: what is new
    for (const tok of all) {
      if (this.seen.has(tok.mint)) continue;
      this.seen.add(tok.mint);
      this.seenTimes.push(now);
      this.narratives.add(tok.mint, tok.name, tok.symbol, tok.createdAt);
      if (tok.creator) {
        const r = this.creators.get(tok.creator) ?? { launches: 0, rugs: 0 };
        r.launches++;
        this.creators.set(tok.creator, r);
      }
    }
    this.narratives.prune(now);
    if (now - this.lastPrune > 60_000) {
      this.lastPrune = now;
      this.fakes.prune(now);
    }
    // the insider tracker learns which wallets really sell at 3×+ (every half minute)
    const smartBook = sw.smart ?? {};
    let learned = 0;
    const learning = now - this.lastLearn >= 30_000;
    if (learning) {
      this.lastLearn = now;
      learned = learnSmart(smartBook, all, now, this.smartDone, sw.wallet?.address);
      if (learned) this.say('strategist', `insider tracker: ${learned} more wallet${learned > 1 ? 's' : ''} seen selling at 3×+ — ${Object.values(smartBook).filter(isSmart).length} proven so far`);
    }
    let insiderBest = 0;
    let bestOdds: Odds | null = null;
    let openSamples = sw.outcomes.filter((o) => o.kind === 'sample' && !o.done).length;
    this.maybeTrain(sw.outcomes, now);
    this.seenTimes = this.seenTimes.filter((t) => now - t < 60_000);
    const leaderOf = (mints: string[]) => {
      let best: string | null = null;
      let cap = -1;
      for (const m of mints) {
        const t = tokens[m];
        if (t && t.mcapSol > cap) {
          cap = t.mcapSol;
          best = m;
        }
      }
      return best;
    };

    const reads: CoinRead[] = [];
    const tally = { checked: 0, pass: 0, watch: 0, reject: 0 };
    // reasons grouped with their numbers ignored; shown as the first one seen
    const why = new Map<string, { text: string; n: number }>();
    let scored = 0;
    let viral = 0;
    // paper and live are separate books: paper trades never take a live slot or count against the live loss limit
    const sameBook = (p: Position) => Boolean(p.live) === (sw.mode === 'live');
    const open = sw.positions.filter((p) => !p.closedAt && sameBook(p));
    const dayStart = new Date(now).setHours(0, 0, 0, 0);
    const lostToday = -sw.positions.filter((p) => p.closedAt && p.closedAt >= dayStart && sameBook(p)).reduce((a, p) => a + pnlSol(p, tokens[p.mint], solUsd), 0);
    const newPositions: Position[] = [];
    const newOutcomes: Outcome[] = [];
    // live: what the account is worth now — the SOL in the wallet and the open coins at their price
    const live = sw.mode === 'live';
    // what a held coin is worth now; with no price yet (just restarted, not in the scanner's memory) it counts at what was paid —
    // a coin with no price is not a loss, and must not trip the Optimizer's heat gate or read as a drawdown
    const valueOf = (p: Position) => {
      const px = tokens[p.mint] ? markPrice(tokens[p.mint], solUsd) : NaN;
      return Math.max(0, p.left * (px > 0 ? px : p.entryPx));
    };
    const equity = live && sw.wallet?.sol != null ? sw.wallet.sol + open.filter((p) => p.live).reduce((a, p) => a + valueOf(p), 0) : null;
    const m = sw.manager;
    // the Optimizer: the account as a whole (paper: an account the paper size implies, plus the paper results)
    const book = live ? 'live' : 'paper';
    const opt = sw.optimizer ?? OPTIMIZER_DEFAULTS;
    const share = (m.autoSize ?? 0) > 0 ? m.autoSize : TRADE_SHARE;
    const acct = equity ?? m.sizeSol / share + sw.positions.filter(sameBook).reduce((a, p) => a + pnlSol(p, tokens[p.mint], solUsd), 0);
    const riskBook = acct > 0 ? updateBook(sw.risk?.[book], acct, now) : sw.risk?.[book];
    const closedBook = sw.positions.filter((p) => p.closedAt && sameBook(p));
    const read = riskBook ? optimize(opt, riskBook, acct, closedBook, open.map((p) => ({ costSol: p.costSol * (p.left / p.tokens), valueSol: valueOf(p) })), live ? (m.floorSol ?? 0) : 0, share) : null;
    // said again only when what it says changes, not each time a number in it moves
    const noteKey = read ? `${read.notes.join().replace(/\d+(\.\d+)?/g, '#')}|${read.sizeMult}` : '';
    if (read && noteKey !== this.lastNotes) {
      this.lastNotes = noteKey;
      this.say('optimizer', `${read.notes.join('; ')} · size ${read.sizeMult.toFixed(2)}× · health ${read.health}`);
    }
    if (read?.gate && read.gate !== this.lastOptGate) this.say('optimizer', read.gate);
    this.lastOptGate = read?.gate ?? null;
    const gate = riskGate(
      sw.positions.filter(sameBook),
      now,
      { lossStreak: m.lossStreak ?? 0, cooldownMin: m.cooldownMin ?? 60, floorSol: live ? (m.floorSol ?? 0) : 0 },
      equity,
    );
    const underFloor = Boolean(gate && live && equity !== null && (m.floorSol ?? 0) > 0 && equity < m.floorSol);
    if (underFloor && !this.floorHit) {
      this.say('manager', `Account floor: ${gate}`);
      alertHere('Swarm stopped buying', gate!, 'warn');
      void tellWithCard(undefined, null, '', `🛑 Swarm stopped buying — account floor\nWhy: ${gate}`, 0);
    }
    this.floorHit = underFloor;

    for (const tok of all) {
      const a = assess(tok, now, solUsd);
      // only coins with something going on are worth the bots' time
      if (tok.trades.length < 3 && !tok.dex) continue;
      // the creator's record from their other coins: a coin that went quiet is not held against itself when it wakes up
      const cr = tok.creator ? this.creators.get(tok.creator) : undefined;
      this.fakes.see(tok);
      const fake = this.fakes.check(tok, now, (m) => tokens[m]?.symbol ?? '', (m) => tokens[m]?.mcapSol ?? 0);
      const v = sentinel(tok, now, cr && this.rugged.has(tok.mint) ? { ...cr, rugs: cr.rugs - 1 } : cr, fake);
      tally.checked++;
      tally[v.verdict]++;
      if (v.verdict !== 'pass' && v.reasons[0]) {
        const key = v.reasons[0].replace(/\d+(\.\d+)?%?/g, '#');
        const g = why.get(key) ?? { text: v.reasons[0], n: 0 };
        g.n++;
        why.set(key, g);
      }
      // a rejected coin's creator is remembered for their next launch
      if (v.verdict === 'reject' && tok.creator && !this.rugged.has(tok.mint) && /dumped|sold|bundled|idle|wash|a copy|copied|impersonates|not theirs/.test(v.reasons.join(' '))) {
        this.rugged.add(tok.mint);
        const r = this.creators.get(tok.creator);
        if (r) r.rugs++;
      }
      const prev = this.verdicts.get(tok.mint);
      if (prev !== v.verdict && a.heat >= 50) {
        if (v.verdict === 'reject' && prev) this.say('sentinel', `${tok.symbol}: rejected — ${v.reasons[0]}`, tok.mint);
        else if (v.verdict === 'pass' && prev === 'watch') this.say('sentinel', `${tok.symbol}: cleared — on-chain checks and early buyers look clean (viability ${v.score})`, tok.mint);
      }
      this.verdicts.set(tok.mint, v.verdict);
      // the on-chain check for anything with heat and no check yet
      // the on-chain check for anything with heat (again if the last one failed); likely picks first
      if ((!tok.safety || tok.safety.error) && a.heat >= 35) scanner.check(tok.mint, a.heat >= 55);
      let x: Virality | null = null;
      if (v.verdict !== 'reject') {
        if (a.heat >= 35) this.fetchMeta(tok);
        x = herald(tok, now, this.narratives, leaderOf, this.social.get(tok.mint));
        scored++;
        if (x.score >= 60) viral++;
      }
      const ins = v.verdict === 'pass' ? insiderRead(tok, now, smartBook) : null;
      if (ins) insiderBest = Math.max(insiderBest, ins.score);
      const d = x ? strategist(tok, a, v, x, sw.strategy, ins ?? undefined) : { enter: false, conviction: 0, why: `rejected: ${v.reasons[0] ?? ''}`, insiders: undefined };
      // the statistics: the coin as numbers, and the forest's odds for it
      const fx = v.verdict === 'pass' && x ? features(tok, now, a, v, x, ins, this.social.get(tok.mint) ?? null) : null;
      const odds = fx ? oddsOf(fx, this.forest) : undefined;
      if (odds && (!bestOdds || odds.expMult > bestOdds.expMult)) bestOdds = odds;
      if (a.heat >= 30 || d.enter || (ins?.score ?? 0) >= 40) reads.push({ mint: tok.mint, symbol: tok.symbol, heat: a.heat, viability: v, virality: x, conviction: d.conviction, decision: d.why, enter: d.enter, mcapUsd: a.mcapUsd, insider: ins?.score ?? 0, odds });
      // the forest's schooling: every coin that passed the Sentinel with some heat is followed for an hour, its numbers kept
      if (fx && a.heat >= 30 && !d.enter && !this.sampled.has(tok.mint) && openSamples < 400) {
        this.sampled.add(tok.mint);
        openSamples++;
        newOutcomes.push(newOutcome({ mint: tok.mint, symbol: tok.symbol, t0: now, mcap0: tok.mcapSol, kind: 'sample', conviction: d.conviction, heat: a.heat, virality: x?.score ?? 0, viability: v.score, x: fx }));
      }

      if (d.enter && !this.traded.has(tok.mint) && now >= (this.retryAt.get(tok.mint) ?? 0)) {
        // a pick is recorded once (the research record); the council can sit again if what stopped the buy was passing
        const tries = (this.tries.get(tok.mint) ?? 0) + 1;
        this.tries.set(tok.mint, tries);
        let pick = this.picks.get(tok.mint);
        if (!pick) {
          pick = newOutcome({ mint: tok.mint, symbol: tok.symbol, t0: now, mcap0: tok.mcapSol, kind: 'pick', conviction: d.conviction, heat: a.heat, virality: x!.score, viability: v.score, x: fx ?? undefined });
          this.picks.set(tok.mint, pick);
          newOutcomes.push(pick);
          scanner.pin(tok.mint);
        }
        this.say('strategist', `${tok.symbol}: ${d.insiders ? 'INSIDER PICK' : 'PICK'} (conviction ${d.conviction})${tries > 1 ? ` — again, try ${tries} of ${MAX_TRIES}` : ''} — ${d.why}`, tok.mint);
        // buys still in flight count as open
        const room = open.length + newPositions.length + this.buying.size < sw.manager.maxOpen;
        const budget = lostToday < sw.manager.dailyLossSol;
        const mc = Number.isFinite(a.mcapUsd) ? ` at $${Math.round(a.mcapUsd).toLocaleString('en-US')} market cap` : '';
        // the size: the Optimizer's multiple (edge, drawdown, a good day), the pick's conviction and,
        // once the forest is trusted, what it expects the trade to come back as — together never past 0.25×–1.25×
        const o = odds ?? oddsOf(features(tok, now, a, v, x, ins, this.social.get(tok.mint) ?? null), this.forest);
        const forestMult = o.trust >= 0.3 ? Math.min(1.25, Math.max(0.6, 0.6 + (o.expMult - 1))) : 1;
        const sizeMult = opt.enabled ? Math.min(1.25, Math.max(0.25, (read?.sizeMult ?? 1) * convictionTilt(d.conviction, d.insiders ? sw.strategy.insiderMin : sw.strategy.minConviction) * forestMult)) : 1;
        // live: the trade follows the account (smaller after losses, bigger after wins), within the wallet's cap; never pushed under the fee floor by the Optimizer
        const plain = equity !== null && (m.autoSize ?? 0) > 0 ? tradeSize(equity, m.autoSize) : m.sizeSol;
        const tuned = equity !== null && (m.autoSize ?? 0) > 0 ? tradeSize(equity, m.autoSize * sizeMult) : Math.round(m.sizeSol * sizeMult * 1000) / 1000;
        const liveSize = plain >= MIN_TRADE_SOL ? Math.max(MIN_TRADE_SOL, tuned) : tuned;
        const paperSize = Math.max(0.005, Math.round(m.sizeSol * sizeMult * 1000) / 1000);
        const heldNames = [...open, ...newPositions].map((p) => tokens[p.mint]).filter(Boolean).map((t) => ({ name: t!.name, symbol: t!.symbol }));
        const twin = opt.enabled && opt.oneNarrative ? sharedNarrative(tok.name, tok.symbol, heldNames) : null;
        // the council: every bot gives its view; a veto or too few votes and it is not bought
        const verdict = council({
          viability: v,
          virality: x!,
          minVirality: sw.strategy.minVirality,
          decision: d,
          odds: o,
          optimizerGate: gate ?? read?.gate ?? (twin ? `already holding a coin on "${twin}" — same-narrative coins pump and rug together` : null),
          sizeMult,
          social: this.social.get(tok.mint) ?? null,
        });
        const transcript = verdict.votes.map((b) => `${MARK[b.stance]} ${b.bot[0].toUpperCase() + b.bot.slice(1)}: ${b.why}`);
        for (const b of verdict.votes) this.say(AGENT_OF[b.bot], `${tok.symbol} · council ${MARK[b.stance]} ${b.why}`, tok.mint);
        this.say('strategist', `${tok.symbol}: council — ${verdict.summary}`, tok.mint);
        pick.voted = verdict.buy ? 'buy' : 'no';
        const room5 = Number.isFinite(a.mcapUsd) && a.mcapUsd > 0 ? sw.strategy.targetMcapUsd / a.mcapUsd : null;
        const potential = { expMult: o.expMult, p2: o.p2, p5: o.p5, trust: o.trust, room: room5 };
        // what stopped it, if anything — and whether that can pass (then the council sits again in a minute)
        let held: string | null = null;
        let bought = false;
        if (!verdict.buy) held = verdict.summary;
        else if (!room) held = `${sw.manager.maxOpen} positions already open`;
        else if (!budget) held = `daily loss limit (${sw.manager.dailyLossSol} SOL) reached`;
        else if (live) {
          const w = sw.wallet;
          const size = w ? Math.min(liveSize, w.limits.maxBuySol) : 0;
          if (!desktop || !w) held = 'live mode needs the swarm wallet (Wallet tab)';
          else if (!w.limits.armed) held = 'live trading is not armed (Wallet tab)';
          else if (size < MIN_TRADE_SOL) held = `a trade would be ${size} SOL, too small for its fees (under ${MIN_TRADE_SOL})`;
          else {
            bought = true;
            if (!this.buying.has(tok.mint)) void this.liveBuy(tok, size, d.why, d.conviction, mc, d.insiders, { potential, council: transcript });
          }
        } else {
          const p = openPosition(tok, paperSize, now, solUsd, d.why, d.conviction);
          if (p) {
            bought = true;
            if (d.insiders) p.insiders = d.insiders;
            p.potential = potential;
            p.council = transcript;
            newPositions.push(p);
            this.say('manager', `${tok.symbol}: bought ${p.costSol} SOL (paper)${mc}`, tok.mint);
            alertHere(`Swarm bought ${tok.symbol} · paper`, `${p.costSol} SOL${mc} — ${d.why}`, 'buy');
            void tellWithCard(tok, p, `Bought — ${p.costSol} SOL (paper)`, `🐝 Swarm bought ${tok.symbol} (paper)${mc}\nPotential: ${potentialText(potential)}\nCouncil: ${verdict.summary}\n${transcript.join('\n')}\nPlan: ${this.plan()}`, solUsd, potentialBadge(potential));
          } else held = 'no price to buy at';
        }
        if (bought || tries >= MAX_TRIES) {
          this.traded.add(tok.mint);
          this.retryAt.delete(tok.mint);
          if (!bought) this.say('manager', `${tok.symbol}: not bought — ${held}; that was the last of ${MAX_TRIES} tries`, tok.mint);
        } else {
          this.retryAt.set(tok.mint, now + RETRY_MS);
          this.say('manager', `${tok.symbol}: not bought — ${held}; the council sits again in ${RETRY_MS / 60_000} min if it still qualifies (try ${tries} of ${MAX_TRIES})`, tok.mint);
        }
      } else if (!d.enter && v.verdict === 'pass' && a.heat >= 30 && !this.traded.has(tok.mint) && !this.controls.has(tok.mint) && now - this.lastControl > 30_000) {
        // the comparison sample: coins that passed but were not picked
        this.controls.add(tok.mint);
        this.lastControl = now;
        scanner.pin(tok.mint);
        newOutcomes.push(newOutcome({ mint: tok.mint, symbol: tok.symbol, t0: now, mcap0: tok.mcapSol, kind: 'control', conviction: d.conviction, heat: a.heat, virality: x?.score ?? 0, viability: v.score, x: fx ?? undefined }));
      }
    }

    // the Herald on X: the best candidates' posts, and the trend scan (within its hourly budget)
    if (desktop && sw.x && (sw.x.mentions || sw.x.trend)) {
      const cands = reads
        .filter((r) => r.viability.verdict === 'pass' && (r.heat >= 55 || r.insider >= 50))
        .sort((p, q) => q.conviction - p.conviction)
        .map((r) => ({ mint: r.mint, symbol: r.symbol }));
      void this.xw.tick(Date.now(), sw.x, cands);
    }

    // Manager: every open position (paper fills at once; live sells wait for the chain)
    const positions = [...sw.positions, ...newPositions];
    for (const p of positions) {
      if (p.closedAt) continue;
      const tok = tokens[p.mint];
      if (!tok) continue;
      const dangers = assess(tok, now, solUsd).flags.filter((f) => f.level === 'danger').map((f) => f.text);
      if (p.live) {
        // a failed sell waits 15 s of wall-clock time (the sell itself can take a minute)
        if (p.pending || (p.retryAt && Date.now() < p.retryAt)) continue;
        const d = decideExit(p, tok, now, solUsd, sw.manager, dangers);
        if (d) void this.liveSell(p, d);
      } else {
        const tpBefore = p.tpDone;
        for (const f of managePosition(p, tok, now, solUsd, sw.manager, dangers)) {
          const pnl = pnlSol(p, tok, solUsd);
          this.say('manager', `${p.symbol}: sold ${f.sol.toFixed(3)} SOL — ${f.why}${p.closedAt ? ` · closed ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} SOL` : ''}`, p.mint);
          if (p.closedAt || p.tpDone > tpBefore) this.afterSell(p, { share: 1, why: f.why, mult: f.mult, tp: p.tpDone > tpBefore && !p.closedAt });
        }
      }
      // the Optimizer: a winner grown past half the account is sold back to a third of it
      if (!p.closedAt && !p.pending && !(p.retryAt && Date.now() < p.retryAt) && sameBook(p)) {
        const mult = multiple(p, tok, solUsd);
        const cut = trimShare(valueOf(p), acct, mult, opt);
        if (cut) {
          const why = `rebalanced: ${p.symbol} grew to ${Math.round((valueOf(p) / acct) * 100)}% of the account — sold ${Math.round(cut * 100)}% to bank it, the rest keeps running`;
          this.say('optimizer', why, p.mint);
          if (p.live) void this.liveSell(p, { share: cut, why, mult, tp: false });
          else {
            const tokensOut = p.left * cut;
            applySell(p, now, tokensOut, quoteSell(tok, tokensOut, solUsd), why, mult, false);
            this.afterSell(p, { share: cut, why, mult, tp: false });
          }
        }
      }
      if (p.closedAt) scanner.pin(p.mint, false);
      // progress on Telegram as the price multiplies: 2×, 5×, 10×, 25×, 50×, 100× …
      const m = multiple(p, tok, solUsd);
      const hit = !p.closedAt && Number.isFinite(m) ? newMilestone(p, m) : null;
      if (hit) {
        const value = p.realizedSol + p.left * p.entryPx * m;
        this.say('manager', `${p.symbol}: ${hit}× — position worth ${value.toFixed(3)} SOL (paid ${p.costSol.toFixed(3)})`, p.mint);
        void tellWithCard(tok, p, `${m.toFixed(1)}× and running`, `🚀 ${p.symbol} is ${m.toFixed(2)}× (${p.live ? 'LIVE' : 'paper'})\nPosition: worth ${value.toFixed(4)} SOL · paid ${p.costSol.toFixed(4)} SOL · banked ${p.realizedSol.toFixed(4)} SOL\nNext: ${this.plan()}`, solUsd, { label: 'NOW', value: `${m.toFixed(1)}×`, sub: `and running${p.potential ? ` · potential was ${p.potential.room ? `${Math.round(p.potential.room)}×` : `${p.potential.expMult.toFixed(1)}×`}` : ''}`, tone: 'buy' });
      }
    }

    // outcomes: follow each call for an hour
    const outcomes = [...sw.outcomes, ...newOutcomes];
    for (const o of outcomes) {
      if (o.done) continue;
      const tok = tokens[o.mint];
      follow(o, tok?.mcapSol ?? 0, Boolean(tok?.migrated), now, !tok);
      if (o.done && !positions.some((p) => p.mint === o.mint && !p.closedAt)) scanner.pin(o.mint, false);
    }

    const closed = positions.filter((p) => p.closedAt);
    const wins = closed.filter((p) => p.realizedSol > p.costSol).length;
    useSwarm.setState({
      positions,
      outcomes,
      ...(learning ? { smart: { ...smartBook } } : {}),
      ...(riskBook ? { risk: { ...sw.risk, [book]: riskBook } } : {}),
      reads: reads.sort((a, b) => b.conviction - a.conviction).slice(0, 60),
      stats: {
        scout: { seen: this.seen.size, perMin: this.seenTimes.length },
        sentinel: { ...tally, top: [...why.values()].sort((a, b) => b.n - a.n).slice(0, 5).map((g) => ({ why: g.text, n: g.n })) },
        herald: { scored, viral, narratives: this.narratives.top(8), xSearches: this.xw.used(Date.now()) },
        strategist: { signals: positions.length, last: sw.stats.strategist.last, proven: Object.values(smartBook).filter(isSmart).length, insiderBest },
        forest: {
          n: this.forest?.stats.n ?? 0,
          accuracy: this.forest?.stats.accuracy ?? null,
          baseline: this.forest?.stats.baseline ?? null,
          brier: this.forest?.stats.brier ?? null,
          trust: bestOdds?.trust ?? (this.forest ? this.forest.stats.n / (this.forest.stats.n + 60) : 0),
          best: bestOdds,
          trainedAt: this.forest?.stats.trainedAt ?? 0,
          importance: this.forest?.stats.importance ?? [],
        },
        optimizer: read ? { ...read, equity: acct } : null,
        manager: {
          open: positions.filter((p) => !p.closedAt).length,
          closed: closed.length,
          pnlSol: positions.reduce((a, p) => a + pnlSol(p, tokens[p.mint], solUsd), 0),
          winRate: closed.length ? wins / closed.length : null,
        },
      },
    });
  }
}

export const swarm = new Swarm();

/** Start the swarm when it was left on, and follow the on/off switch. */
export function startSwarmService() {
  swarm.sync();
  useSwarm.subscribe((s, p) => s.enabled !== p.enabled && swarm.sync());
}

export { multiple };
