// Opening Novus Ordo while it is already running: only one copy may run (it owns the database
// and the bots), so the new copy asks the open one to show its window and leaves. That used to
// be all — and when the open copy was stuck (no window, but still in Task Manager), every click
// handed over to it and nothing ever appeared. Now the open copy answers by writing a small
// file once its window is on screen, and the new copy waits for that answer. No answer in a few
// seconds: the open copy is stuck, and you are offered to close it and start again.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ACK = 'show-ack.json';
const RUNNING = 'running.json';

/** the open copy: its window is on screen (written each time it is asked) */
export function writeAck(dir, now = Date.now()) {
  try {
    writeFileSync(join(dir, ACK), JSON.stringify({ t: now, pid: process.pid }));
  } catch {
    /* a read-only folder: the new copy will offer to restart */
  }
}

/** the answer the open copy wrote, if it is newer than `since` */
export function readAck(dir, since) {
  try {
    const a = JSON.parse(readFileSync(join(dir, ACK), 'utf8'));
    return Number(a?.t) >= since ? a : null;
  } catch {
    return null;
  }
}

/** the new copy: wait up to `ms` for the open copy to say its window is showing */
export async function waitForAck(dir, since, ms = 8000, step = 250) {
  const end = Date.now() + ms;
  for (;;) {
    if (readAck(dir, since)) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

/** the process id the open copy wrote when it started (care/crash.mjs keeps it in running.json) */
export function runningPid(dir) {
  try {
    const pid = Number(JSON.parse(readFileSync(join(dir, RUNNING), 'utf8'))?.pid);
    return Number.isInteger(pid) && pid > 0 && pid !== process.pid ? pid : null;
  } catch {
    return null;
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** close the stuck copy and wait (up to `ms`) until it is gone */
export async function endStuck(pid, ms = 10_000) {
  try {
    process.kill(pid);
  } catch {
    /* already gone */
  }
  const end = Date.now() + ms;
  let forced = false;
  while (pidAlive(pid) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 250));
    // a frozen process may not act on a polite close: forced after three seconds (on Windows both are the same)
    if (!forced && Date.now() > end - ms + 3000) {
      forced = true;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  return !pidAlive(pid);
}

/** a window that has ended up off every screen (a monitor unplugged): put back in the middle of the main one */
export function onScreen(bounds, workAreas) {
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  if (workAreas.some((d) => overlap(bounds, d) >= 120 * 120)) return null;
  const d = workAreas[0];
  const width = Math.min(bounds.width, d.width);
  const height = Math.min(bounds.height, d.height);
  return { x: d.x + Math.round((d.width - width) / 2), y: d.y + Math.round((d.height - height) / 2), width, height };
}
