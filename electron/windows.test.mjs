import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { areaOf, cellRect, displayLabel, displayOf, gridRects, placeOn, Screens } from './windows.mjs';

const laptop = { id: 1, label: '', internal: true, size: { width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1.5 };
const monitor = { id: 2, label: 'DELL U2723QE', internal: false, size: { width: 2560, height: 1440 }, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 }, scaleFactor: 1 };

function fakeWindows() {
  let next = 1;
  const all = [];
  class W extends EventEmitter {
    constructor(b) {
      super();
      this.id = next++;
      this.b = { ...b };
      this.max = false;
      this.full = false;
      this.dead = false;
      this.shown = true;
      all.push(this);
    }
    getBounds() {
      return this.b;
    }
    setBounds(b) {
      this.b = { ...b };
    }
    isDestroyed() {
      return this.dead;
    }
    isMaximized() {
      return this.max;
    }
    isFullScreen() {
      return this.full;
    }
    isVisible() {
      return this.shown;
    }
    isMinimized() {
      return false;
    }
    maximize() {
      this.max = true;
    }
    unmaximize() {
      this.max = false;
    }
    setFullScreen(v) {
      this.full = v;
    }
    show() {
      this.shown = true;
    }
    showInactive() {
      this.shown = true;
    }
    hide() {
      this.shown = false;
    }
    focus() {}
    restore() {}
    setAlwaysOnTop(on, level) {
      this.top = on ? level ?? 'floating' : false;
    }
    isAlwaysOnTop() {
      return !!this.top;
    }
    close() {
      this.emit('close');
      this.dead = true;
      this.emit('closed');
    }
  }
  return { W, BrowserWindow: { getAllWindows: () => all.filter((w) => !w.dead) } };
}

describe('windows and screens', () => {
  it('names screens and finds where a window sits', () => {
    expect(displayLabel(laptop, 0)).toBe('Built-in screen (1920×1080)');
    expect(displayLabel(monitor, 1)).toBe('DELL U2723QE (2560×1440)');
    expect(displayOf([laptop, monitor], { x: 2000, y: 100, width: 800, height: 600 }).id).toBe(2);
    expect(displayOf([laptop, monitor], { x: 1500, y: 100, width: 800, height: 600 }).id).toBe(1);
    expect(placeOn(monitor, 'fill')).toEqual(monitor.workArea);
    const f = placeOn(monitor, 'float');
    expect(f.width).toBe(1792);
    expect(f.x).toBeGreaterThan(1920);
  });

  it('pops a panel out, sends windows to screens, hides them while sealed and restores them next time', () => {
    const { W, BrowserWindow } = fakeWindows();
    const file = join(mkdtempSync(join(tmpdir(), 'scr-')), 'panel-windows.json');
    const main = new W(laptop.workArea);
    const opened = [];
    const screen = { getAllDisplays: () => [laptop, monitor], getPrimaryDisplay: () => laptop };
    const newWindow = (q, b) => {
      opened.push(q);
      return new W(b);
    };
    const s = new Screens({ screen, BrowserWindow, file, mainWindow: () => main, newWindow });
    const id = s.popout('heatgrid', 'HMAP · Heat Map', { tiles: 96 }, 2);
    expect(opened[0]).toMatchObject({ popout: 'heatgrid', title: 'HMAP · Heat Map', cfg: '{"tiles":96}' });
    const st = s.state();
    expect(st.displays.map((d) => d.label)).toEqual(['Built-in screen (1920×1080)', 'DELL U2723QE (2560×1440)']);
    expect(st.windows.find((w) => w.id === id)).toMatchObject({ kind: 'panel', displayId: 2 });
    // the whole laptop face becomes the heat map; the terminal goes full screen on the monitor
    s.move(id, 1, 'fill');
    expect(s.state().windows.find((w) => w.id === id)).toMatchObject({ displayId: 1, maximized: true });
    s.move(main.id, 2, 'full');
    expect(s.state().windows.find((w) => w.kind === 'main')).toMatchObject({ displayId: 2, fullScreen: true });
    s.setVisible(false);
    expect(s.state().windows.find((w) => w.id === id).visible).toBe(false);
    s.setVisible(true);
    // quitting keeps the list; next session reopens it where it was
    s.quitting = true;
    BrowserWindow.getAllWindows().find((w) => w.id === id).close();
    const s2 = new Screens({ screen, BrowserWindow, file, mainWindow: () => main, newWindow });
    s2.restore();
    expect(opened.at(-1)).toMatchObject({ popout: 'heatgrid' });
    expect(s2.state().windows.filter((w) => w.kind === 'panel')).toHaveLength(1);
    // closing it on purpose forgets it
    const again = s2.state().windows.find((w) => w.kind === 'panel').id;
    s2.close(again);
    const s3 = new Screens({ screen, BrowserWindow, file, mainWindow: () => main, newWindow });
    s3.restore();
    expect(s3.state().windows.filter((w) => w.kind === 'panel')).toHaveLength(0);
  });
});

describe('tiles: no banner, edge to edge over the taskbar, never above a frozen app', () => {
  it('halves, quarters and thirds cover the whole screen, the taskbar’s strip too; a grid of any count does too', () => {
    const b = areaOf(monitor);
    expect(b).toEqual(monitor.bounds);
    expect(cellRect(b, 'left')).toEqual({ x: 1920, y: 0, width: 1280, height: 1440 });
    expect(cellRect(b, 'br')).toEqual({ x: 3200, y: 720, width: 1280, height: 720 });
    expect(cellRect(b, 'all')).toEqual(monitor.bounds);
    const t = ['l3', 'm3', 'r3'].map((c) => cellRect(b, c));
    expect(t[0].x + t[0].width).toBe(t[1].x);
    expect(t[1].x + t[1].width).toBe(t[2].x);
    expect(t[2].x + t[2].width).toBe(b.x + b.width);
    expect(cellRect(areaOf(laptop), 'bottom')).toEqual({ x: 0, y: 540, width: 1920, height: 540 });
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      const rs = gridRects(b, n);
      expect(rs).toHaveLength(n);
      expect(rs.reduce((a, r) => a + r.width * r.height, 0)).toBe(b.width * b.height);
    }
    expect(gridRects(b, 4).map((r) => [r.x - b.x, r.y, r.width, r.height])).toEqual([[0, 0, 1280, 720], [1280, 0, 1280, 720], [0, 720, 1280, 720], [1280, 720, 1280, 720]]);
    expect(gridRects(b, 5).slice(3).map((r) => r.width)).toEqual([1280, 1280]);
  });

  it('tiles sit above the taskbar only while the app is in use, never while it is in trouble; Maximise fills the whole screen; a drag untiles', () => {
    const { W, BrowserWindow } = fakeWindows();
    const file = join(mkdtempSync(join(tmpdir(), 'scr-')), 'panel-windows.json');
    const main = new W(laptop.workArea);
    const screen = { getAllDisplays: () => [laptop, monitor], getPrimaryDisplay: () => laptop };
    let changed = 0;
    let t = 1_000_000;
    let watched = [];
    const s = new Screens({ screen, BrowserWindow, file, mainWindow: () => main, newWindow: (_q, b) => new W(b), changed: () => changed++, now: () => t, onTopmost: (ws) => (watched = ws.map((w) => w.id)) });
    const a = s.popout('heatmap', 'Heatmap', {}, 2);
    const b = s.popout('dom', 'DOM', {}, 2);
    const wa = BrowserWindow.getAllWindows().find((w) => w.id === a);
    s.tile(a, 'left');
    expect(wa.getBounds()).toEqual(cellRect(monitor.bounds, 'left'));
    expect(wa.top).toBe('screen-saver');
    expect(main.top ?? false).toBe(false);
    // the outside watcher knows which windows are on top
    expect(watched).toEqual([a]);
    expect(s.state().windows.find((w) => w.id === a).tiled).toBe('left');
    expect(changed).toBeGreaterThan(0);
    // another app in use: tiles step back; back in Novus Ordo: above the taskbar again
    s.cover(false);
    expect(wa.top).toBe(false);
    expect(watched).toEqual([]);
    s.cover(true);
    expect(wa.top).toBe('screen-saver');
    // a window hangs or the graphics crash: nothing stays on top, even if the app is clicked meanwhile
    s.safety(30_000);
    expect(wa.top).toBe(false);
    s.cover(true);
    expect(wa.top).toBe(false);
    t += 31_000;
    s.cover(true);
    expect(wa.top).toBe('screen-saver');
    // full screen toggles, and leaves the tile
    s.tile(a, 'full');
    expect(wa.isFullScreen()).toBe(true);
    expect(s.tiled.has(a)).toBe(false);
    s.tile(a, 'full');
    expect(wa.isFullScreen()).toBe(false);
    // both pop-outs on the monitor, edge to edge over its taskbar
    expect(s.arrange(2)).toBe(2);
    const wb = BrowserWindow.getAllWindows().find((w) => w.id === b);
    expect([wa.getBounds(), wb.getBounds()]).toEqual(gridRects(monitor.bounds, 2));
    expect([wa.top, wb.top]).toEqual(['screen-saver', 'screen-saver']);
    // dragged by hand: an ordinary window again, not on top
    s.placing = false;
    wb.emit('will-move');
    expect(s.tiled.has(b)).toBe(false);
    expect(wb.top).toBe(false);
  });

  it('Maximise (Windows+Up, snapping to the top) is the whole screen, over the taskbar', async () => {
    const { W, BrowserWindow } = fakeWindows();
    const file = join(mkdtempSync(join(tmpdir(), 'scr-')), 'panel-windows.json');
    const main = new W(laptop.workArea);
    const screen = { getAllDisplays: () => [laptop, monitor], getPrimaryDisplay: () => laptop };
    const s = new Screens({ screen, BrowserWindow, file, mainWindow: () => main, newWindow: (_q, b) => new W(b) });
    const a = s.popout('heatmap', 'Heatmap', {}, 2);
    const wa = BrowserWindow.getAllWindows().find((w) => w.id === a);
    s.placing = false;
    wa.emit('maximize');
    await new Promise((r) => setTimeout(r, 5));
    expect(wa.getBounds()).toEqual(monitor.bounds);
    expect(s.tiled.get(a)?.cell).toBe('all');
    expect(wa.top).toBe('screen-saver');
  });
});


