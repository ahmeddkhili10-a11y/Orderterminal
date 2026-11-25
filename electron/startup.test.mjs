// Start-up you can see: the watchdog notices a frozen main thread and says which step it is
// stuck on; a start that never showed its window is noticed by the next one.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { failedBefore, lastStart, makeStallWatch, splashHtml, startStartup } from './startup.mjs';

describe('start-up', () => {
  it('the watchdog writes when the main thread stops answering, names the step, repeats, and says when it is back', () => {
    let beat = 0;
    let t = 0;
    const lines = [];
    const w = makeStallWatch(() => beat, () => 'database', (l) => lines.push(l), { now: () => t });
    for (let i = 0; i < 5; i++) {
      t += 1000;
      beat++;
      w.tick();
    }
    expect(lines).toEqual([]);
    for (let i = 0; i < 15; i++) {
      t += 1000;
      w.tick();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/STALL — the app's main thread has not answered for 15 s, during: database/);
    t += 30_000;
    w.tick();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/for 45 s/);
    beat++;
    t += 1000;
    w.tick();
    expect(lines[2]).toMatch(/answers again after 46 s/);
  });

  it('the watchdog’s decision runs on its own (it is copied into its thread as text)', () => {
    const f = new Function(`return (${makeStallWatch.toString()})`)();
    let t = 0;
    const lines = [];
    const w = f(() => 0, () => 'page', (l) => lines.push(l), { now: () => t });
    t = 16_000;
    w.tick();
    expect(lines[0]).toMatch(/during: page/);
  });

  it('records each step, and the next start knows whether the window was ever shown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'novus-start-'));
    const logs = [];
    const b = startStartup(dir, join(dir, 'novus.log'), (_l, m) => logs.push(m));
    b.step('database');
    b.step('main window');
    expect(lastStart(dir).step).toBe('main window');
    // a start stopped here: the next one (another process) notices
    expect(failedBefore(lastStart(dir), process.pid + 1)).toBe(true);
    b.shown();
    expect(lastStart(dir).shown).toBe(true);
    expect(failedBefore(lastStart(dir), process.pid + 1)).toBe(false);
    expect(logs.some((m) => /start-up: database took .* → main window/.test(m))).toBe(true);
    expect(logs.some((m) => /window on screen .* after launch/.test(m))).toBe(true);
    b.stop();
    // nothing recorded yet: nothing to worry about
    expect(failedBefore(null)).toBe(false);
  });

  it('the starting window shows the step, escaped, and why it runs without the graphics card', () => {
    const h = splashHtml('opening <your> data', true);
    expect(h).toContain('opening &lt;your&gt; data');
    expect(h).toContain('without the graphics card');
    expect(h).toContain("default-src 'none'");
    expect(splashHtml('x', false)).not.toContain('without the graphics card');
  });
});

describe('start-up extras', () => {
  it('a start that froze while starting the extras makes the next one leave them off', async () => {
    const { extrasFailedBefore } = await import('./startup.mjs');
    expect(extrasFailedBefore({ pid: 1, step: 'extras', shown: true }, 2)).toBe(true);
    expect(extrasFailedBefore({ pid: 1, step: 'running', shown: true }, 2)).toBe(false);
    expect(extrasFailedBefore({ pid: 2, step: 'extras', shown: true }, 2)).toBe(false);
    expect(extrasFailedBefore(null, 2)).toBe(false);
  });
});
