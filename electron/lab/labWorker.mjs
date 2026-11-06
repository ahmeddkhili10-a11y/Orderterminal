// The Strategy Lab's worker thread: runs a research run or one backtest away
// from the desktop process's event loop, reporting progress as it goes.
import { parentPort } from 'node:worker_threads';
import { evaluate, research } from '../../src/lab/research.ts';

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'research') {
      const result = await research(msg.markets, msg.cfg, (progress) => parentPort.postMessage({ type: 'progress', progress }));
      parentPort.postMessage({ type: 'result', result });
    } else if (msg.type === 'evaluate') {
      parentPort.postMessage({ type: 'result', result: evaluate(msg.markets, msg.spec, msg.isShare, msg.costs) });
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: String(err?.message ?? err) });
  }
});
