// The Strategy Lab in the terminal: its state from the desktop process (the
// research runs there, in a worker), the last result, and the deployed list.
import { create } from 'zustand';
import { desktop } from '../desktop/bridge';
import type { StrategySpec } from './backtest';
import type { DeciderTest, Parts, ResearchResult } from './research';
import type { MonteCarlo, Perf } from './stats';

export interface LabConfig {
  coins: string[];
  timeframe: '1h' | '4h' | '1d';
  years: number;
  source: 'auto' | 'binance' | 'okx' | 'bybit' | 'hyperliquid';
  isShare: number;
  combos: number;
  sides: 'both' | 'long';
  feeBps: number;
  slipBps: number;
  meta: boolean;
  funding: boolean;
}

export interface LabDeployed {
  id: string;
  name: string;
  spec: StrategySpec;
  tfH: number;
  coins: string[];
  targets: { crypto: boolean; meme: boolean };
  stats: { sharpe: number; t: number; dsr: number; trades: number; verdict: string };
  deployedAt: number;
  on: boolean;
  /** council: the swarm's council can block its signals · tested: only the safety bots (Guardian, Risk) can */
  authority?: Authority;
}
export type Authority = 'council' | 'tested';

export interface LabStatus {
  running: boolean;
  progress: { stage: string; done: number; total: number } | null;
  error: string | null;
  cfg: LabConfig;
  deployed: LabDeployed[];
  last: { at: number; trials: number; top: number; verdicts: string[] } | null;
}

export interface LabTest {
  is: Perf;
  oos: Perf;
  curve: { t: number; eq: number; bh: number }[];
  trades: number;
  mc: MonteCarlo | null;
  /** buy-and-hold over the unseen period */
  bh?: Perf;
  perCoin?: { coin: string; oos: Perf }[];
  /** the spec as tested (with the AI trade filter's model when it was kept) */
  spec?: StrategySpec;
  meta?: { used: boolean; before: number; after: number; trainedOn: number; kind?: 'forest' | 'nn' | 'both' } | null;
  /** each decision maker (forest, neural network, both) measured on the unseen data */
  deciders?: DeciderTest[];
  /** the parts of a combined strategy: each rule alone, how the rules relate, what each filter adds */
  parts?: Parts | null;
  /** Kelly sizing: the full Kelly fraction found in sample and the half used */
  kelly?: { f: number; target: number; trades: number } | null;
  /** when the unseen (out-of-sample) period starts, and the years of history tested */
  split?: number;
  years?: number;
}

interface LabStore {
  status: LabStatus | null;
  result: ResearchResult | null;
  loaded: boolean;
}

export const useLab = create<LabStore>(() => ({ status: null, result: null, loaded: false }));

const api = () => desktop?.lab;

let linked = false;
/** follow the desktop process's Lab (once per window) */
export function startLabLink() {
  const L = api();
  if (!L || linked) return;
  linked = true;
  L.state()
    .then((status) => useLab.setState({ status, loaded: true }))
    .catch(() => useLab.setState({ loaded: true }));
  L.result()
    .then((result) => useLab.setState({ result }))
    .catch(() => {});
  L.onState((status) => useLab.setState({ status }));
  L.onEvent((e) => {
    if (e.kind === 'done') void L.result().then((result) => useLab.setState({ result }));
  });
}

export const labApi = api;
