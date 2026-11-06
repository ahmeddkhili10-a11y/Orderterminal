import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { displayLabel, displayOf, placeOn, Screens } from './windows.mjs';

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
