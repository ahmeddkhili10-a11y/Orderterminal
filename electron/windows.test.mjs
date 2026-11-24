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

describe('tiles: no banner, edge to edge, never above everything', () => {
  it('halves, quarters and thirds fill the screen above the taskbar with no gaps; a grid of any count does too', () => {
    const b = areaOf(monitor);
    expect(b).toEqual(monitor.workArea);
    expect(cellRect(b, 'left')).toEqual({ x: 1920, y: 0, width: 1280, height: 1400 });
    expect(cellRect(b, 'br')).toEqual({ x: 3200, y: 700, width: 1280, height: 700 });
    // the three thirds meet exactly and fill the width
    const t = ['l3', 'm3', 'r3'].map((c) => cellRect(b, c));
    expect(t[0].x + t[0].width).toBe(t[1].x);
    expect(t[1].x + t[1].width).toBe(t[2].x);
    expect(t[2].x + t[2].width).toBe(b.x + b.width);
    // never under the taskbar (with the taskbar hidden by Windows, the usable area is the whole screen)
    expect(cellRect(areaOf(laptop), 'bottom')).toEqual({ x: 0, y: 520, width: 1920, height: 520 });
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      const rs = gridRects(b, n);
      expect(rs).toHaveLength(n);
      expect(rs.reduce((a, r) => a + r.width * r.height, 0)).toBe(b.width * b.height);
    }
    expect(gridRects(b, 4).map((r) => [r.x - b.x, r.y, r.width, r.height])).toEqual([[0, 0, 1280, 700], [1280, 0, 1280, 700], [0, 700, 1280, 700], [1280, 700, 1280, 700]]);
    expect(gridRects(b, 5).slice(3).map((r) => r.width)).toEqual([1280, 1280]);
  });

  it('tiles a window and arranges every pop-out, never "always on top" (a frozen window must never cover Task Manager), and a hand drag untiles', () => {
    const { W, BrowserWindow } = fakeWindows();
    const file = join(mkdtempSync(join(tmpdir(), 'scr-')), 'panel-windows.json');
    const main = new W(laptop.workArea);
    const screen = { getAllDisplays: () => [laptop, monitor], getPrimaryDisplay: () => laptop };
    let changed = 0;
    const s = new Screens({ screen, BrowserWindow, file, mainWindow: () => main, newWindow: (_q, b) => new W(b), changed: () => changed++ });
    const a = s.popout('heatmap', 'Heatmap', {}, 2);
    const b = s.popout('dom', 'DOM', {}, 2);
    const wa = BrowserWindow.getAllWindows().find((w) => w.id === a);
    s.tile(a, 'left');
    expect(wa.getBounds()).toEqual(cellRect(monitor.workArea, 'left'));
    expect(wa.top ?? false).toBe(false);
    expect(s.state().windows.find((w) => w.id === a).tiled).toBe('left');
    expect(changed).toBeGreaterThan(0);
    // a window left on top by an earlier version is put back
    wa.setAlwaysOnTop(true, 'screen-saver');
    s.cover(true);
    expect(wa.top).toBe(false);
    // full screen toggles, and leaves the tile
    s.tile(a, 'full');
    expect(wa.isFullScreen()).toBe(true);
    expect(s.tiled.has(a)).toBe(false);
    s.tile(a, 'full');
    expect(wa.isFullScreen()).toBe(false);
    // both pop-outs on the monitor, side by side, edge to edge above its taskbar
    expect(s.arrange(2)).toBe(2);
    const wb = BrowserWindow.getAllWindows().find((w) => w.id === b);
    expect([wa.getBounds(), wb.getBounds()]).toEqual(gridRects(monitor.workArea, 2));
    expect([wa.top ?? false, wb.top ?? false]).toEqual([false, false]);
    // dragged by hand: an ordinary window again
    s.placing = false;
    wb.emit('will-move');
    expect(s.tiled.has(b)).toBe(false);
  });
});

