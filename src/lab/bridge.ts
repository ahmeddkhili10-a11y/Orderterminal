// The bridge from the Quant desk to the Strategy Lab: a model studied on the
// desk — a neural network trained in NNET, a GARCH forecast, a Kelly fraction,
// a pair found in PAIR — is sent into the bot builder as a pick in the right
// block, carrying the settings it was studied with, so the strategy runs that
// model instead of the model living beside it.
//
// A send is small and plain (which block, which pick, which settings). The
// bot builder applies it to the bot being built (applySend) and the bot is
// then tested like any other: the Lab fits the model on the training years
// only, so a network that looked good on the desk still has to earn its place
// on data it never saw.
import { create } from 'zustand';
import { DECIDERS, FORECASTS, migrateFlow, MODELS, PORTFOLIOS, RISKS, STRATEGIES, STYLE_MAP, STYLES, type BlockId, type Decider, type Flow, type StyleId } from './flow';
import type { Params } from './library';

export type SendBlock = 'strategy' | 'model' | 'forecast' | 'decider' | 'risk' | 'portfolio';

export interface LabSend {
  block: SendBlock;
  /** the pick's id in that block's list */
  id: string;
  /** the function it comes from (NNET, VAR, PAIR …) */
  from: string;
  /** settings that go with it, over the style's defaults */
  tune?: Params;
  /** coins to make sure the bot is tested on */
  coins?: string[];
  /** the trading style the model was studied at (its candles and horizon) */
  style?: StyleId;
  /** strategy only: replace the bot's strategies instead of joining them */
  solo?: boolean;
}

const BLOCK_OF: Record<SendBlock, BlockId> = { strategy: 'strategy', model: 'model', forecast: 'forecast', decider: 'forecast', risk: 'risk', portfolio: 'risk' };
const BLOCK_NAME: Record<SendBlock, string> = { strategy: 'Strategies', model: 'Market models', forecast: 'Forecasts & AI (a second opinion)', decider: 'Forecasts & AI (the decision maker)', risk: 'Risk management', portfolio: 'Risk management (the split across coins)' };

const nameIn = (s: LabSend): string | null => {
  const list: readonly { id: string; name: string }[] = s.block === 'strategy' ? STRATEGIES : s.block === 'model' ? MODELS : s.block === 'forecast' ? FORECASTS : s.block === 'decider' ? DECIDERS : s.block === 'risk' ? RISKS : PORTFOLIOS;
  return list.find((x) => x.id === s.id)?.name ?? null;
};

/** the trading style whose candles and usual holding time are nearest a model's own */
export function styleFor(tfH: number, horizonH: number): StyleId {
  const same = STYLES.filter((s) => s.tfH === tfH);
  const pool = same.length ? same : STYLES;
  return pool.reduce((best, s) => (Math.abs(Math.log(s.holdH / horizonH)) < Math.abs(Math.log(best.holdH / horizonH)) ? s : best)).id;
}

/** a pick's settings in words, for the note that says what arrived */
export function tuneWords(tune: Params | undefined): string {
  if (!tune) return '';
  const out: string[] = [];
  if (tune.horizon > 0) out.push(`looks ${tune.horizon >= 48 && tune.horizon % 24 === 0 ? `${tune.horizon / 24} days` : `${tune.horizon} hours`} ahead`);
  if (tune.h1 > 0) out.push(`${tune.h1} → ${tune.h2 > 0 ? tune.h2 : Math.max(2, Math.round(tune.h1 / 2))} hidden units`);
  if (tune.edge > 0) out.push(`trades when its odds pass ${(50 + tune.edge * 100).toFixed(0)} %`);
  if (tune.target > 0) out.push(`target ${tune.target < 0.1 ? `${(tune.target * 100).toFixed(1)} %` : `${Math.round(tune.target * 100)} %`}`);
  if (tune.window > 0) out.push(`${tune.window >= 48 && tune.window % 24 === 0 ? `${tune.window / 24}-day` : `${tune.window}-hour`} window`);
  if (tune.k > 0) out.push(`${tune.k} standard deviations`);
  if (tune.hour >= 0 && Number.isFinite(tune.hour)) out.push(`at ${tune.hour}:00 UTC`);
  if (tune.lookback > 0) out.push(`${tune.lookback >= 48 && tune.lookback % 24 === 0 ? `${tune.lookback / 24}-day` : `${tune.lookback}-hour`} look-back`);
  return out.join(', ');
}

/**
 * Put a model sent from the Quant desk into a bot: the pick joins its block
 * (or replaces the block's choice where only one can be made), its settings
 * are kept beside it, and its coin and style come with it when it has them.
 */
export function applySend(flow0: Flow, s: LabSend): { flow: Flow; text: string; block: BlockId; ok: boolean } {
  const flow = migrateFlow(flow0 as Flow & Record<string, unknown>);
  const name = nameIn(s);
  const block = BLOCK_OF[s.block];
  if (!name) return { flow, text: `${s.from}: nothing in the bot builder matches “${s.id}”.`, block, ok: false };
  const next: Flow = { ...flow, tunes: { ...(flow.tunes ?? {}) } };
  const notes: string[] = [];
  const add = (xs: string[]) => (xs.includes(s.id) ? xs : [...xs, s.id]);
  let key = `${s.block}:${s.id}`;
  if (s.block === 'strategy') next.strategies = s.solo ? [s.id] : add(flow.strategies);
  else if (s.block === 'model') next.models = add(flow.models);
  else if (s.block === 'forecast') next.forecasts = add(flow.forecasts);
  else if (s.block === 'risk') {
    let risks = add(flow.risks);
    // two sizing rules at most (the smaller size wins): the newest replaces the oldest
    const sizing = risks.filter((id) => RISKS.find((r) => r.id === id)?.sizing);
    if (sizing.length > 2) {
      risks = risks.filter((id) => id !== sizing[0]);
      notes.push(`“${RISKS.find((r) => r.id === sizing[0])!.name}” made way (two sizing rules at most)`);
    }
    next.risks = risks;
  } else if (s.block === 'decider') {
    next.decider = s.id as Decider;
    key = 'decider';
  } else next.portfolio = s.id as Flow['portfolio'];
  if (s.tune && Object.keys(s.tune).length && s.block !== 'portfolio') next.tunes![key] = { ...s.tune };
  if (s.style && STYLE_MAP[s.style] && s.style !== flow.style) {
    next.style = s.style;
    notes.push(`style set to ${STYLE_MAP[s.style].name.split(' — ')[0].toLowerCase()} (${STYLE_MAP[s.style].timeframe} candles), the pace it was studied at`);
  }
  if (s.coins?.length) {
    const have = flow.coins.toUpperCase().split(/[\s,]+/).filter(Boolean);
    const extra = s.coins.map((x) => x.toUpperCase()).filter((x) => x && !have.includes(x));
    if (extra.length) {
      next.coins = [...have, ...extra].slice(0, 8).join(' ');
      notes.push(`${extra.join(', ')} added to the coins`);
    }
  }
  const words = tuneWords(s.tune);
  const text = `From ${s.from}: “${name}” is now in ${BLOCK_NAME[s.block]}${words ? ` — ${words}` : ''}${notes.length ? `; ${notes.join('; ')}` : ''}. Test the bot to see what it adds.`;
  return { flow: migrateFlow(next as Flow & Record<string, unknown>), text, block, ok: true };
}

// ---------- the delivery: from any window to the bot builder ----------

interface Inbox {
  queue: LabSend[];
}
export const useLabInbox = create<Inbox>(() => ({ queue: [] }));

const CHANNEL = 'novus-lab-bridge';
let channel: BroadcastChannel | null = null;
let isMain = false;
let openBot: (() => void) | null = null;
const chan = () => {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e) => {
    if (isMain && e.data && typeof e.data === 'object') receive(e.data as LabSend);
  };
  return channel;
};

function receive(s: LabSend) {
  useLabInbox.setState((st) => ({ queue: [...st.queue, s] }));
  openBot?.();
}

/** the main window listens for models sent from any window (a popped-out panel included) and opens the bot builder */
export function startLabBridge(open: () => void) {
  isMain = true;
  openBot = open;
  chan();
}

/** send a model to the bot builder (from a Quant desk panel) */
export function sendToBot(s: LabSend) {
  if (isMain) receive(s);
  else chan()?.postMessage(s);
}

/** the bot builder takes what has arrived */
export function takeSends(): LabSend[] {
  const q = useLabInbox.getState().queue;
  if (q.length) useLabInbox.setState({ queue: [] });
  return q;
}

/** a list of trade results in R sent the other way: the bot builder's last test, for the Monte Carlo panel */
export interface LabTrades {
  name: string;
  rs: number[];
  at: number;
}
export const useLabTrades = create<{ last: LabTrades | null }>(() => ({ last: null }));
