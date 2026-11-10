// The Strategy Lab's worker thread: runs a research run or one backtest away
// from the desktop process's event loop, reporting progress as it goes.
import { parentPort } from 'node:worker_threads';
import { evaluate, research, scoreVariants } from '../../src/lab/research.ts';

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'research') {
      const result = await research(msg.markets, msg.cfg, (progress) => parentPort.postMessage({ type: 'progress', progress }));
      parentPort.postMessage({ type: 'result', result });
    } else if (msg.type === 'evaluate') {
      parentPort.postMessage({ type: 'result', result: evaluate(msg.markets, msg.spec, msg.isShare, msg.costs) });
    } else if (msg.type === 'score') {
      // the optimizer: versions of a strategy measured inside the training years
      const result = scoreVariants(msg.markets, msg.specs, msg.isShare, msg.costs, (done, total) => (done % 3 === 0 || done === total) && parentPort.postMessage({ type: 'progress', progress: { stage: 'Trying changes on the training years', done, total } }));
      parentPort.postMessage({ type: 'result', result });
    }
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: String(err?.message ?? err) });
  }
});
