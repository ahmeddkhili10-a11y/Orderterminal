// Tiles sit above the taskbar ("always on top") while Novus Ordo is the app in use. If Novus
// Ordo itself then stopped answering, nothing in it could take them back down — frozen, blank
// windows would cover every screen, Task Manager included. This watcher runs on its own thread,
// beside the app's: the app counts a heartbeat up every second; when the count stops for a few
// seconds while windows are on top, the watcher takes them down itself, through Windows, from
// outside the frozen app (a hidden PowerShell call to SetWindowPos with HWND_NOTOPMOST).
import { Worker } from 'node:worker_threads';

/**
 * The watcher's decision, on its own (tested): `read()` is the heartbeat count, `drop(handles)`
 * takes those windows down. Called once a second; returns true when it dropped them.
 */
export function makeWatch(read, drop, stallMs = 6000, now = Date.now) {
  let last = read();
  let since = now();
  let handles = [];
  let dropped = false;
  return {
    setHandles(h) {
      handles = Array.isArray(h) ? h : [];
    },
    tick() {
      const v = read();
      if (v !== last) {
        last = v;
        since = now();
        dropped = false;
        return false;
      }
      if (!dropped && handles.length && now() - since >= stallMs) {
        dropped = true;
        drop(handles);
        return true;
      }
      return false;
    },
  };
}

/** the PowerShell that takes windows off "always on top" (HWND_NOTOPMOST = −2; no move, no size, no focus) */
export function notTopmostScript(handles) {
  const list = handles.filter((h) => /^\d+$/.test(String(h))).join(',');
  return `Add-Type -Name W -Namespace NovusOrdo -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr a, int x, int y, int cx, int cy, uint f);'; foreach ($h in @(${list})) { [void][NovusOrdo.W]::SetWindowPos([System.IntPtr][long]$h, [System.IntPtr](-2), 0, 0, 0, 0, 0x13) }`;
}

/** a window's handle as a number (Windows); null elsewhere */
export function handleOf(w) {
  try {
    const b = w.getNativeWindowHandle();
    return b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0));
  } catch {
    return null;
  }
}

/** start the watcher thread (Windows only); returns { beat(), setHandles(list), stop() } */
export function startTopmostWatch(log = () => {}) {
  if (process.platform !== 'win32') return { beat() {}, setHandles() {}, stop() {} };
  const shared = new SharedArrayBuffer(4);
  const counter = new Int32Array(shared);
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { spawn } = require('node:child_process');
    const counter = new Int32Array(workerData.shared);
    const makeWatch = ${makeWatch.toString()};
    const script = ${notTopmostScript.toString()};
    const w = makeWatch(() => Atomics.load(counter, 0), (handles) => {
      try {
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script(handles)], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
        parentPort.postMessage({ dropped: handles.length });
      } catch (e) {
        parentPort.postMessage({ error: String(e && e.message || e) });
      }
    });
    parentPort.on('message', (m) => m && m.handles && w.setHandles(m.handles));
    setInterval(() => w.tick(), 1000);
  `;
  let worker = null;
  try {
    worker = new Worker(code, { eval: true, workerData: { shared } });
    worker.unref();
    worker.on('message', (m) => (m?.dropped ? log('warn', `Novus Ordo stopped answering: its ${m.dropped} tile${m.dropped === 1 ? '' : 's'} taken off "always on top" from outside`) : m?.error && log('warn', `topmost watcher: ${m.error}`)));
    worker.on('error', (e) => log('warn', 'topmost watcher stopped', e));
  } catch (e) {
    log('warn', 'could not start the topmost watcher', e);
  }
  const t = setInterval(() => Atomics.add(counter, 0, 1), 1000);
  t.unref?.();
  return {
    beat: () => Atomics.add(counter, 0, 1),
    setHandles: (h) => worker?.postMessage({ handles: h }),
    stop: () => {
      clearInterval(t);
      void worker?.terminate();
    },
  };
}
