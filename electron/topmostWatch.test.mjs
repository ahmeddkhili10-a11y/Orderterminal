// The watcher beside the app: when Novus Ordo stops answering while tiles are above the
// taskbar, it takes them down from outside, once, and arms itself again when the app answers.
import { describe, expect, it } from 'vitest';
import { makeWatch, notTopmostScript } from './topmostWatch.mjs';

describe('the topmost watcher', () => {
  it('takes the windows down after a few seconds without a heartbeat, once, and again only after the app came back', () => {
    let beat = 0;
    let t = 0;
    const drops = [];
    const w = makeWatch(() => beat, (h) => drops.push(h), 6000, () => t);
    w.setHandles(['1001', '2002']);
    // a live app: the count moves every second
    for (let i = 0; i < 10; i++) {
      t += 1000;
      beat++;
      expect(w.tick()).toBe(false);
    }
    // frozen: nothing for six seconds
    for (let i = 0; i < 5; i++) {
      t += 1000;
      expect(w.tick()).toBe(false);
    }
    t += 1000;
    expect(w.tick()).toBe(true);
    expect(drops).toEqual([['1001', '2002']]);
    // still frozen: not again
    t += 5000;
    expect(w.tick()).toBe(false);
    // it comes back, then freezes again: again
    beat++;
    w.tick();
    t += 7000;
    expect(w.tick()).toBe(true);
    expect(drops).toHaveLength(2);
  });

  it('does nothing when no window is on top', () => {
    let t = 0;
    const drops = [];
    const w = makeWatch(() => 0, (h) => drops.push(h), 6000, () => t);
    t += 60_000;
    expect(w.tick()).toBe(false);
    expect(drops).toHaveLength(0);
  });

  it('asks Windows to take exactly those windows off "always on top", nothing else', () => {
    const ps = notTopmostScript(['1001', '2002', 'x; rm -rf /']);
    expect(ps).toContain('@(1001,2002)');
    expect(ps).not.toContain('rm -rf');
    expect(ps).toContain('SetWindowPos');
    expect(ps).toContain('(-2)');
  });

  it('runs on its own (its decision is copied into the watcher thread as text)', () => {
    const f = new Function(`return (${makeWatch.toString()})`)();
    let t = 0;
    const drops = [];
    const w = f(() => 0, (h) => drops.push(h), 6000, () => t);
    w.setHandles(['7']);
    t = 6000;
    expect(w.tick()).toBe(true);
    expect(drops).toEqual([['7']]);
  });
});
