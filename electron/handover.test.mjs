// Opening Novus Ordo while a copy is already running: the open copy answers once its window
// is on screen; a copy that never answers is stuck and can be closed so a new one starts.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { endStuck, onScreen, pidAlive, readAck, runningPid, waitForAck, writeAck } from './handover.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'novus-handover-'));

describe('handing over to the open copy', () => {
  it('the new copy sees the open copy’s answer, and only an answer newer than its own ask', async () => {
    const d = dir();
    const asked = Date.now();
    expect(readAck(d, asked)).toBeNull();
    writeAck(d, asked - 60_000);
    expect(readAck(d, asked)).toBeNull();
    // the open copy answers a moment later
    setTimeout(() => writeAck(d), 300);
    const t0 = Date.now();
    expect(await waitForAck(d, asked, 3000, 50)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('no answer within the wait: the open copy is stuck', async () => {
    const d = dir();
    const t0 = Date.now();
    expect(await waitForAck(d, Date.now(), 400, 50)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(380);
  });

  it('a stuck copy is found by the number it wrote when it started, and closed', async () => {
    const d = dir();
    // a process that never ends by itself, standing in for the stuck copy
    const stuck = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(join(d, 'running.json'), JSON.stringify({ t: Date.now(), pid: stuck.pid }));
    expect(runningPid(d)).toBe(stuck.pid);
    expect(pidAlive(stuck.pid)).toBe(true);
    expect(await endStuck(stuck.pid, 5000)).toBe(true);
    expect(pidAlive(stuck.pid)).toBe(false);
  });

  it('never points at itself or at nothing', () => {
    const d = dir();
    expect(runningPid(d)).toBeNull();
    writeFileSync(join(d, 'running.json'), JSON.stringify({ t: 1, pid: process.pid }));
    expect(runningPid(d)).toBeNull();
    writeFileSync(join(d, 'running.json'), JSON.stringify({ t: 1, restart: 'safe mode' }));
    expect(runningPid(d)).toBeNull();
  });

  it('a window off every screen (a monitor unplugged) comes back to the middle of the main one', () => {
    const laptop = { x: 0, y: 0, width: 1920, height: 1040 };
    expect(onScreen({ x: 100, y: 100, width: 1200, height: 800 }, [laptop])).toBeNull();
    expect(onScreen({ x: 2200, y: 50, width: 1600, height: 900 }, [laptop])).toEqual({ x: 160, y: 70, width: 1600, height: 900 });
    expect(onScreen({ x: -32000, y: -32000, width: 2560, height: 1440 }, [laptop])).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });
});
