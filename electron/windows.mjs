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

/**
 * A tile of a screen: halves, quarters and thirds of its WHOLE area (the taskbar's too — a tiled
 * window covers it while Novus Ordo is in use), with no gap between neighbours.
 */
/** where tiles go on a screen: all of it, the taskbar's strip too (tiles sit above the taskbar while Novus Ordo is in use) */
export const areaOf = (d) => d.bounds;

export const CELLS = ['left', 'right', 'top', 'bottom', 'tl', 'tr', 'bl', 'br', 'l3', 'm3', 'r3'];
export function cellRect(b, cell) {
  const hw = Math.floor(b.width / 2);
  const hh = Math.floor(b.height / 2);
  const tw = Math.floor(b.width / 3);
  const R = (x, y, width, height) => ({ x: b.x + x, y: b.y + y, width, height });
  switch (cell) {
    case 'all':
      return R(0, 0, b.width, b.height);
    case 'left':
      return R(0, 0, hw, b.height);
    case 'right':
      return R(hw, 0, b.width - hw, b.height);
    case 'top':
      return R(0, 0, b.width, hh);
    case 'bottom':
      return R(0, hh, b.width, b.height - hh);
    case 'tl':
      return R(0, 0, hw, hh);
    case 'tr':
      return R(hw, 0, b.width - hw, hh);
    case 'bl':
      return R(0, hh, hw, b.height - hh);
    case 'br':
      return R(hw, hh, b.width - hw, b.height - hh);
    case 'l3':
      return R(0, 0, tw, b.height);
    case 'm3':
      return R(tw, 0, tw, b.height);
    case 'r3':
      return R(2 * tw, 0, b.width - 2 * tw, b.height);
    default:
      return R(0, 0, b.width, b.height);
  }
}

/** n windows side by side on a screen: one row up to three, then a grid (2×2, 3×2, 3×3…), edge to edge */
export function gridRects(b, n) {
  if (n <= 0) return [];
  const cols = n <= 3 ? n : Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    // the last row may hold fewer windows: they share its width
    const inRow = r === rows - 1 ? n - cols * (rows - 1) : cols;
    const x0 = Math.round((c * b.width) / inRow);
    const x1 = Math.round(((c + 1) * b.width) / inRow);
    const y0 = Math.round((r * b.height) / rows);
    const y1 = Math.round(((r + 1) * b.height) / rows);
    out.push({ x: b.x + x0, y: b.y + y0, width: x1 - x0, height: y1 - y0 });
  }
  return out;
}

export class Screens {
  /**
   * @param o {{ screen, BrowserWindow, file: string, mainWindow: () => any, newWindow: (query: Record<string,string>, bounds) => any, log?: (level, msg) => void }}
   */
  constructor(o) {
    o.now ??= Date.now;
    this.o = o;
    this.popouts = new Map(); // window id → { key, panel, title, win }
    /** tiled windows: window id → { cell or grid rectangle, display } (they cover the taskbar while Novus Ordo is in use) */
    this.tiled = new Map();
    this.covering = false;
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
      list.push({ id: w.id, kind, title, panel, displayId: displayOf(ds, b).id, bounds: b, maximized: w.isMaximized(), fullScreen: w.isFullScreen(), visible: w.isVisible(), tiled: this.tiled.get(w.id)?.cell ?? null });
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
      this.tiled.delete(win.id);
      this.save();
    });
    win.on('closed', () => {
      this.popouts.delete(win.id);
      this.tiled.delete(win.id);
    });
    for (const ev of ['moved', 'resized']) win.on(ev, () => this.save());
    // dragged or resized by hand: no longer a tile (it stops covering the taskbar)
    for (const ev of ['will-move', 'will-resize']) win.on(ev, () => !this.placing && this.untile(win));
    // Maximise is the whole screen, taskbar too: Windows' own maximise stops at the taskbar
    win.on('maximize', () => {
      if (this.placing || win.isDestroyed()) return;
      setTimeout(() => !win.isDestroyed() && this.tile(win.id, 'all'), 0);
    });
    for (const ev of ['enter-full-screen', 'leave-full-screen']) win.on(ev, () => this.changed());
    this.save();
    return win.id;
  }

  /** tell every window that the windows changed (a popped-out window hides its bar while tiled or full screen) */
  changed() {
    try {
      this.o.changed?.();
    } catch {
      /* nothing listening */
    }
  }

  /** a window placed exactly where asked (its own move and resize events are not taken for your hand) */
  place(w, rect) {
    this.placing = true;
    try {
      if (w.isFullScreen()) w.setFullScreen(false);
      if (w.isMaximized()) w.unmaximize();
      w.setBounds(rect);
    } finally {
      setTimeout(() => (this.placing = false), 250);
    }
  }

  /**
   * Tile a window on the screen it is on: a half, a quarter or a third of the WHOLE screen, or
   * 'full' (true full screen: no title bar, no taskbar). A tile has no banner and, while Novus
   * Ordo is the app in use, sits above the taskbar too, so tiles meet edge to edge.
   */
  tile(id, cell) {
    const w = this.o.BrowserWindow.getAllWindows().find((x) => x.id === id);
    if (!w) throw new Error('no such window');
    if (cell === 'full') {
      this.untile(w);
      w.setFullScreen(!w.isFullScreen());
      w.show();
      w.focus();
      this.save();
      this.changed();
      return true;
    }
    const d = displayOf(this.o.screen.getAllDisplays(), w.getBounds());
    this.place(w, cellRect(areaOf(d), cell));
    this.tiled.set(w.id, { cell, displayId: d.id });
    w.show();
    w.focus();
    this.cover(true);
    this.save();
    this.changed();
    return true;
  }

  /** every popped-out window on a screen, side by side or in a grid, edge to edge (the order they were opened in) */
  arrange(displayId) {
    const d = this.o.screen.getAllDisplays().find((x) => x.id === displayId);
    if (!d) throw new Error('no such screen');
    const ws = [...this.popouts.values()].map((p) => p.win).filter((w) => !w.isDestroyed() && displayOf([d, ...this.o.screen.getAllDisplays().filter((x) => x.id !== d.id)], w.getBounds()).id === d.id);
    const rects = gridRects(areaOf(d), ws.length);
    ws.forEach((w, i) => {
      this.place(w, rects[i]);
      this.tiled.set(w.id, { cell: `grid${i}`, rect: rects[i], displayId: d.id });
      w.showInactive();
    });
    this.cover(true);
    this.save();
    this.changed();
    return ws.length;
  }

  /** a tile goes back to an ordinary window (it no longer covers the taskbar) */
  untile(w) {
    if (!this.tiled.has(w.id)) return;
    this.tiled.delete(w.id);
    if (!w.isDestroyed()) w.setAlwaysOnTop(false);
    this.save();
    this.changed();
  }

  /**
   * While Novus Ordo is the app in use its tiles sit above the taskbar (so a tile at the bottom
   * of the screen is not cut off by it); when you switch to another app they step back.
   */
  cover(on) {
    // above the taskbar only while Novus Ordo is the app in use (and never while it is in trouble:
    // after a graphics crash or a hang it waits — see safety() — so frozen windows cannot cover the screen)
    const want = !!on && this.o.now() >= (this.suspendedUntil ?? 0);
    const all = this.o.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    for (const w of all) {
      const top = want && this.tiled.has(w.id);
      // only a change is sent to Windows: clicking between Novus Ordo windows no longer restacks them every time
      if (!!w.isAlwaysOnTop?.() !== top) w.setAlwaysOnTop(top, top ? 'screen-saver' : undefined);
    }
    this.covering = want;
    this.o.onTopmost?.(all.filter((w) => w.isAlwaysOnTop?.()));
  }

  /** something is wrong (a window hung, the graphics crashed): nothing stays above the taskbar for `ms` */
  safety(ms = 60_000) {
    this.suspendedUntil = this.o.now() + ms;
    this.cover(false);
  }



  /** a screen changed size (or was unplugged): tiles are laid out again on it */
  retile() {
    const ds = this.o.screen.getAllDisplays();
    for (const [id, t] of this.tiled) {
      const w = this.o.BrowserWindow.getAllWindows().find((x) => x.id === id);
      const d = ds.find((x) => x.id === t.displayId);
      if (!w || w.isDestroyed()) continue;
      if (!d) {
        this.untile(w);
        continue;
      }
      if (!String(t.cell).startsWith('grid')) this.place(w, cellRect(areaOf(d), t.cell));
    }
    const grids = new Set([...this.tiled.values()].filter((t) => String(t.cell).startsWith('grid')).map((t) => t.displayId));
    for (const id of grids) if (ds.some((d) => d.id === id)) this.arrange(id);
  }

  /** send a window to a screen: fill (maximised), full screen, or float */
  move(id, displayId, mode = 'fill') {
    const all = this.o.BrowserWindow.getAllWindows();
    const w = all.find((x) => x.id === id);
    const d = this.o.screen.getAllDisplays().find((x) => x.id === displayId);
    if (!w || !d) throw new Error('no such window or screen');
    this.untile(w);
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
    const rows = [...this.popouts.values()].filter((p) => !p.win.isDestroyed()).map((p) => ({ key: p.key, panel: p.panel, title: p.title, bounds: p.win.getBounds(), fullScreen: p.win.isFullScreen(), maximized: p.win.isMaximized(), tiled: this.tiled.get(p.win.id)?.cell ?? null }));
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
      // a tile comes back as a tile, where it was
      if (w && on && r.tiled) this.tiled.set(w.id, { cell: r.tiled, rect: r.bounds, displayId: displayOf(ds, r.bounds).id });
    }
  }
}
