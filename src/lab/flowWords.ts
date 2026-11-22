// A bot builder flow in words: what it enters on, what it waits for, how it exits. Used where a
// strategy is described to you (the phone, the deploy card), so every place says it the same way.
import { COMBINES, FORECASTS, HOLDS, MODELS, RISKS, STOP_WIDTHS, STRATEGIES, STYLE_MAP, TAKE_PROFIT, type Flow } from './flow';

const nameOf = (xs: readonly { id: string; name: string }[], id: string) => xs.find((x) => x.id === id)?.name ?? id;
const cap = (x: string) => (x ? x[0].toUpperCase() + x.slice(1) : x);
/** "Only with bitcoin's trend (the market)" → "Bitcoin's trend (the market)"; "The Kalman trend must agree" → "Kalman trend" */
const condition = (x: string) => cap(x.replace(/^only\s+(with|in|when|at|on|during)?\s*(the\s+)?/i, '').trim());
const forecast = (x: string) => cap(x.replace(/^the\s+/i, '').replace(/\s+must agree$/i, '').trim());

export interface FlowWords {
  /** e.g. "Intraday" */
  pace: string;
  /** e.g. "1-hour candles" */
  candles: string;
  /** the entry rules, by name */
  entries: string[];
  /** how two or more entry rules are joined ("all must agree"), when there are several */
  join: string | null;
  /** the conditions it trades only under */
  filters: string[];
  /** forecasts that must agree */
  ai: string[];
  /** sizing and risk rules */
  risks: string[];
  /** stop, profit taking and holding time */
  exits: string[];
  sides: string;
}

export function flowWords(f: Flow | null | undefined): FlowWords | null {
  if (!f?.strategies?.length) return null;
  const st = STYLE_MAP[f.style];
  const tf = st?.timeframe ?? '';
  const candles = tf === '1d' ? 'daily candles' : tf.endsWith('m') ? `${tf.slice(0, -1)}-minute candles` : tf.endsWith('h') ? `${tf.slice(0, -1)}-hour candles` : tf;
  return {
    pace: st?.name.split(' — ')[0] ?? f.style,
    candles,
    entries: f.strategies.map((id) => nameOf(STRATEGIES, id)),
    join: f.strategies.length > 1 ? (COMBINES.find((c) => c.id === f.combine)?.name.toLowerCase() ?? null) : null,
    filters: (f.models ?? []).map((id) => condition(nameOf(MODELS, id))),
    ai: (f.forecasts ?? []).map((id) => forecast(nameOf(FORECASTS, id))),
    risks: (f.risks ?? []).map((id) => nameOf(RISKS, id)),
    exits: [nameOf(STOP_WIDTHS, f.stopWidth), nameOf(TAKE_PROFIT, f.takeProfit), nameOf(HOLDS, f.hold)].filter(Boolean),
    sides: f.sides === 'long' ? 'long only' : f.sides === 'short' ? 'short only' : 'long and short',
  };
}
