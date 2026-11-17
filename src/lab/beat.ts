// A heartbeat for long work. The edge finder's thread sets it (farmLoop.mjs): every
// backtest and every round of model training calls it, so the desktop process can tell
// a long stretch of work from a hang without the thread stopping to send a message.
let fn: (() => void) | null = null;
export const setBeat = (f: (() => void) | null) => {
  fn = f;
};
export const beat = () => {
  fn?.();
};
