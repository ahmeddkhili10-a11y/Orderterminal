// Start-up you can see. Opening Novus Ordo used to show nothing until its main window was
// ready; when something on the way held the app up, Task Manager showed it running, the screen
// stayed empty and the log stopped mid-way without saying why. Now:
//   • a small "starting" window appears at once and says which step it is on
//   • every step is written to the log with how long it took
//   • a watchdog on its own thread writes to the log when the app's main thread stops answering,
//     naming the step — it keeps writing even while the app is frozen
//   • a start that never got its window up is noticed by the next start, which then runs
//     without the graphics card (and keeps doing so once that works)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

export const STEPS = ['starting', 'database', 'background engine', 'menus and messages', 'main window', 'page', 'shown', 'extras', 'running'];
const FILE = 'startup.json';

/** where the last start got to (written as it goes); null when there is no record */
export function lastStart(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** the last start never showed its window (and it was not this process): worth starting differently */
export function failedBefore(prev, pid = process.pid) {
  return !!prev && prev.pid !== pid && !prev.shown && STEPS.indexOf(prev.step) < STEPS.indexOf('shown');
}

/** the last start froze while starting the extras (stay awake, the topmost watcher…): this one leaves them off */
export function extrasFailedBefore(prev, pid = process.pid) {
  return !!prev && prev.pid !== pid && prev.step === 'extras';
}

/** the watchdog's decision on its own (tested): read() is the heartbeat, write(line) adds to the log */
export function makeStallWatch(read, step, write, { firstMs = 15_000, againMs = 30_000, now = Date.now } = {}) {
  let last = read();
  let since = now();
  let told = 0;
  return {
    tick() {
      const v = read();
      const t = now();
      if (v !== last) {
        if (told) write(`the main thread answers again after ${Math.round((t - since) / 1000)} s (it was busy during: ${step()})`);
        last = v;
        since = t;
        told = 0;
        return false;
      }
      const busy = t - since;
      if (busy >= firstMs && (!told || t - told >= againMs)) {
        told = t;
        write(`STALL — the app's main thread has not answered for ${Math.round(busy / 1000)} s, during: ${step()}`);
        return true;
      }
      return false;
    },
  };
}

/**
 * Track the steps: `step(name)` marks one (log, record, watchdog); `shown()` marks the window
 * on screen. The watchdog thread appends to `logFile` directly, so it is heard even while the
 * app's own thread is stuck.
 */
export function startStartup(dir, logFile, log) {
  const shared = new SharedArrayBuffer(8);
  const s = new Int32Array(shared);
  const t0 = Date.now();
  let at = t0;
  let cur = 'starting';
  const rec = { pid: process.pid, t: t0, step: cur, shown: false };
  const save = () => {
    try {
      writeFileSync(join(dir, FILE), JSON.stringify(rec));
    } catch {
      /* a record is a convenience */
    }
  };
  save();
  const beat = setInterval(() => Atomics.add(s, 0, 1), 500);
  beat.unref?.();
  let worker = null;
  try {
    const code = `
      const { workerData } = require('node:worker_threads');
      const { appendFileSync } = require('node:fs');
      const s = new Int32Array(workerData.shared);
      const steps = ${JSON.stringify(STEPS)};
      const makeStallWatch = ${makeStallWatch.toString()};
      const w = makeStallWatch(() => Atomics.load(s, 0), () => steps[Atomics.load(s, 1)] || 'running', (line) => {
        try { appendFileSync(workerData.logFile, new Date().toISOString() + ' WARN ' + line + '\\n'); } catch {}
      });
      setInterval(() => w.tick(), 1000);
    `;
    worker = new Worker(code, { eval: true, workerData: { shared, logFile } });
    worker.unref();
    worker.on('error', (e) => log('warn', 'start-up watchdog stopped', e));
  } catch (e) {
    log('warn', 'could not start the start-up watchdog', e);
  }
  return {
    step(name) {
      const now = Date.now();
      log('info', `start-up: ${cur} took ${((now - at) / 1000).toFixed(2)} s → ${name}`);
      at = now;
      cur = name;
      rec.step = name;
      save();
      const i = STEPS.indexOf(name);
      if (i >= 0) Atomics.store(s, 1, i);
    },
    shown() {
      if (rec.shown) return;
      rec.shown = true;
      this.step('shown');
      log('info', `start-up: window on screen ${((Date.now() - t0) / 1000).toFixed(1)} s after launch`);
    },
    get current() {
      return cur;
    },
    stop() {
      clearInterval(beat);
      void worker?.terminate();
    },
  };
}

/** the small window that says Novus Ordo is starting (its own page: nothing to load from disk) */
export function splashHtml(step, safe) {
  const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Novus Ordo — starting</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
html,body{margin:0;height:100%;background:#050505;color:#e8e8e8;font:13px/1.45 Segoe UI,system-ui,sans-serif;-webkit-user-select:none;overflow:hidden}
.b{padding:22px 26px;border:1px solid #2a2a2a;height:100%;box-sizing:border-box}
h1{margin:0 0 6px;font-size:15px;letter-spacing:.32em;font-weight:600}
.s{color:#f0b90b}.m{color:#8a8a8a;font-size:11.5px;margin-top:10px}
.bar{height:2px;background:#1c1c1c;margin:12px 0 0;overflow:hidden}.bar i{display:block;height:100%;width:30%;background:#c9c9c9;animation:a 1.4s linear infinite}
@keyframes a{from{transform:translateX(-100%)}to{transform:translateX(340%)}}
</style></head><body><div class="b"><h1>NOVUS ORDO</h1><div>Starting… <span class="s" id="s">${esc(step)}</span></div><div class="bar"><i></i></div>
<div class="m">${safe ? 'The last start did not get its window up: this start runs without the graphics card. ' : ''}If this stays for more than a minute, the log says why: %APPDATA%\\Novus Ordo\\logs\\novus.log</div></div></body></html>`;
}
