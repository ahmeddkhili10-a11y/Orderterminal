// Windows and screens: any panel can pop out into its own window, and any
// window (the terminal itself included) can be sent to any screen — fill it,
// make it full screen, or float it. Popped-out panels come back where they
// were the next time the terminal is unlocked.
//
// A popped-out panel is its own renderer: market data streams straight to it,
// and the swarms and the Strategy Lab reach it through the desktop process,
// like the main window. It is hidden while the terminal is sealed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** what a screen is called: its own name, or "Built-in screen" / "Screen 2", with its size */
export function displayLabel(d, i) {
  const name = d.label || (d.internal ? 'Built-in screen' : `Screen ${i + 1}`);
  return `${name} (${d.size.width}×${d.size.height})`;
}

/** the display a rectangle mostly sits on */
export function displayOf(displays, b) {
  let best = displays[0];
  let area = -1;
  for (const d of displays) {
    const w = Math.max(0, Math.min(b.x + b.width, d.bounds.x + d.bounds.width) - Math.max(b.x, d.bounds.x));
    const h = Math.max(0, Math.min(b.y + b.height, d.bounds.y + d.bounds.height) - Math.max(b.y, d.bounds.y));
    if (w * h > area) {
      area = w * h;
      best = d;
    }
  }
  return best;
}

/** where a window goes on a screen: filling its work area, or floating at 70 % in its middle */
export function placeOn(d, mode) {
  const a = d.workArea;
  if (mode === 'float') {
    const width = Math.round(a.width * 0.7);
    const height = Math.round(a.height * 0.7);
    return { x: a.x + Math.round((a.width - width) / 2), y: a.y + Math.round((a.height - height) / 2), width, height };
  }
  return { ...a };
}

export class Screens {
  /**
   * @param o {{ screen, BrowserWindow, file: string, mainWindow: () => any, newWindow: (query: Record<string,string>, bounds) => any, log?: (level, msg) => void }}
   */
  constructor(o) {
    this.o = o;
    this.popouts = new Map(); // window id → { key, panel, title, win }
    this.quitting = false;
    this.restored = false;
  }

  displays() {
    const ds = this.o.screen.getAllDisplays();
    const primary = this.o.screen.getPrimaryDisplay().id;
    return ds.map((d, i) => ({ id: d.id, label: displayLabel(d, i), primary: d.id === primary, internal: !!d.internal, bounds: d.bounds, workArea: d.workArea, scale: d.scaleFactor }));
  }

  windows() {
    const ds = this.o.screen.getAllDisplays();
    const main = this.o.mainWindow();
    const list = [];
    const add = (w, kind, title, panel = null) => {
      if (!w || w.isDestroyed()) return;
      const b = w.getBounds();
      list.push({ id: w.id, kind, title, panel, displayId: displayOf(ds, b).id, bounds: b, maximized: w.isMaximized(), fullScreen: w.isFullScreen(), visible: w.isVisible() });
    };
    add(main, 'main', 'Terminal');
    for (const p of this.popouts.values()) add(p.win, 'panel', p.title, p.panel);
    return list;
  }

  state() {
    return { displays: this.displays(), windows: this.windows() };
  }

  /** pop a panel out into its own window, on a chosen screen (or beside the terminal) */
  popout(panel, title, config = {}, displayId = null, key = randomUUID(), bounds = null) {
    const ds = this.o.screen.getAllDisplays();
    const main = this.o.mainWindow();
    const d = (displayId && ds.find((x) => x.id === displayId)) || (main && !main.isDestroyed() ? displayOf(ds, main.getBounds()) : this.o.screen.getPrimaryDisplay());
    const b = bounds ?? placeOn(d, 'float');
    const win = this.o.newWindow({ popout: panel, key, title, cfg: JSON.stringify(config ?? {}) }, b);
    const entry = { key, panel, title, win };
    this.popouts.set(win.id, entry);
    win.on('close', () => {
      if (!this.quitting) this.popouts.delete(win.id);
      this.save();
    });
    win.on('closed', () => this.popouts.delete(win.id));
    for (const ev of ['moved', 'resized']) win.on(ev, () => this.save());
    this.save();
    return win.id;
  }

  /** send a window to a screen: fill (maximised), full screen, or float */
  move(id, displayId, mode = 'fill') {
    const all = this.o.BrowserWindow.getAllWindows();
    const w = all.find((x) => x.id === id);
    const d = this.o.screen.getAllDisplays().find((x) => x.id === displayId);
    if (!w || !d) throw new Error('no such window or screen');
    if (w.isFullScreen()) w.setFullScreen(false);
    if (w.isMaximized()) w.unmaximize();
    w.setBounds(placeOn(d, mode));
    if (mode === 'fill') w.maximize();
    if (mode === 'full') w.setFullScreen(true);
    w.show();
    w.focus();
    this.save();
    return true;
  }

  focus(id) {
    const w = this.o.BrowserWindow.getAllWindows().find((x) => x.id === id);
    if (!w) return false;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    return true;
  }

  close(id) {
    const p = this.popouts.get(id);
    if (p && !p.win.isDestroyed()) p.win.close();
    return !!p;
  }

  /** sealed: popped-out panels hide; unlocked: they come back */
  setVisible(on) {
    for (const p of this.popouts.values()) {
      if (p.win.isDestroyed()) continue;
      if (on) p.win.showInactive();
      else p.win.hide();
    }
  }

  save() {
    const rows = [...this.popouts.values()].filter((p) => !p.win.isDestroyed()).map((p) => ({ key: p.key, panel: p.panel, title: p.title, bounds: p.win.getBounds(), fullScreen: p.win.isFullScreen(), maximized: p.win.isMaximized() }));
    try {
      writeFileSync(this.o.file, JSON.stringify(rows));
    } catch {
      /* placement is a convenience */
    }
  }

  /** once per session, after the first unlock: reopen the panels that were popped out */
  restore() {
    if (this.restored) return;
    this.restored = true;
    let rows = [];
    try {
      rows = existsSync(this.o.file) ? JSON.parse(readFileSync(this.o.file, 'utf8')) : [];
    } catch {
      rows = [];
    }
    const ds = this.o.screen.getAllDisplays();
    for (const r of rows) {
      // a screen that is no longer plugged in: put it beside the terminal instead
      const on = ds.some((d) => displayOf([d], r.bounds) === d && r.bounds.x >= d.bounds.x - 50 && r.bounds.x < d.bounds.x + d.bounds.width);
      const id = this.popout(r.panel, r.title, undefined, null, r.key, on ? r.bounds : null);
      const w = this.o.BrowserWindow.getAllWindows().find((x) => x.id === id);
      if (w && r.maximized) w.maximize();
      if (w && r.fullScreen) w.setFullScreen(true);
    }
  }
}
