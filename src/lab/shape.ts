// Each candle's shape as numbers, for the forecasting models and the
// meta-labeller (see candles.ts for what they are used for and the papers).
import type { Bar } from './series';

export const CANDLE_FEATURES = ['body', 'upper wick', 'lower wick', 'close location', 'range / ATR', 'gap / ATR', 'candle run', 'engulfing', 'doji', 'hammer / star'];

/** each candle's shape, as CANDLE_FEATURES (uses only that candle and the ones before it) */
export function candleShape(b: Bar[], atr: ArrayLike<number>): Float64Array[] {
  let run = 0;
  return b.map((x, i) => {
    const rng = x.high - x.low;
    const body = x.close - x.open;
    const p = i ? b[i - 1] : x;
    const a = atr[i];
    const up = body > 0 ? 1 : body < 0 ? -1 : 0;
    run = up === 0 ? 0 : Math.sign(run) === up ? run + up : up;
    const pBody = p.close - p.open;
    const engulf = i && pBody < 0 && body > 0 && x.open <= p.close && x.close >= p.open ? 1 : i && pBody > 0 && body < 0 && x.open >= p.close && x.close <= p.open ? -1 : 0;
    const uw = x.high - Math.max(x.open, x.close);
    const lw = Math.min(x.open, x.close) - x.low;
    const ab = Math.abs(body);
    const hammer = rng > 0 && lw >= 2 * ab && uw <= 0.3 * rng ? 1 : rng > 0 && uw >= 2 * ab && lw <= 0.3 * rng ? -1 : 0;
    if (!(rng > 0) || !(a > 0)) return Float64Array.from({ length: CANDLE_FEATURES.length }, () => NaN);
    return Float64Array.from([body / rng, uw / rng, lw / rng, (x.close - x.low - (x.high - x.close)) / rng, rng / a, i ? (x.open - p.close) / a : 0, Math.max(-6, Math.min(6, run)) / 6, engulf, ab < 0.1 * rng ? 1 : 0, hammer]);
  });
}

