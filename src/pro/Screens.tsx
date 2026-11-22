// Multi-monitor: popped-out panel windows and the Screens menu.
//
//   ⧉ on a tab bar     pops the panel out into its own window
//   SCREENS            every screen and every window on it; send any window to
//                      any screen — fill it, make it full screen, or float it
//
// A popped-out panel is its own page: it streams its own market data, and the
// swarms and the Strategy Lab reach it through the desktop process. The meme
// swarm runs in the main window, so its panels stay there.
import { useEffect, useRef, useState } from 'react';
import { useThemeAttr } from '../app/App';
import { startCryptoSwarmLink } from '../cswarm/store';
import { desktop, type TileCell, type ScreensState } from '../desktop/bridge';
import { startLabLink } from '../lab/store';
import { hub } from '../market/hub';
import { PANELS, PANEL_MAP } from '../panels/registry';
import { FUNCTIONS } from './functions';
import { safeStorage } from '../store/settings';

/** panels that must stay in the main window (their service runs there) */
export const DOCKED_ONLY = new Set(['wallet', 'telegram']);
export const canPopOut = (panel: string) => !!desktop?.screens && !DOCKED_ONLY.has(panel) && !!PANEL_MAP[panel];

export function popOut(panel: string, title: string, config: Record<string, unknown>) {
  return desktop?.screens.popout(panel, title, config) ?? Promise.resolve(null);
}

function useScreens() {
  const [s, setS] = useState<ScreensState | null>(null);
  useEffect(() => {
    if (!desktop?.screens) return;
    const load = () => void desktop!.screens.state().then(setS).catch(() => undefined);
    load();
    const t = setInterval(load, 2000);
    const off = desktop.screens.onChanged(setS);
    return () => {
      clearInterval(t);
      off();
    };
  }, []);
  return s;
}

/** a small map of the screens, as they are arranged, with the windows on each */
function ScreenMap({ s, self }: { s: ScreensState; self: number | null }) {
  const xs = s.displays.flatMap((d) => [d.bounds.x, d.bounds.x + d.bounds.width]);
  const ys = s.displays.flatMap((d) => [d.bounds.y, d.bounds.y + d.bounds.height]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const W = Math.max(...xs) - x0 || 1;
  const H = Math.max(...ys) - y0 || 1;
  const k = Math.min(300 / W, 120 / H);
  return (
    <div className="scr-map" style={{ width: W * k, height: H * k }}>
      {s.displays.map((d) => (
        <div key={d.id} className="scr-display" style={{ left: (d.bounds.x - x0) * k, top: (d.bounds.y - y0) * k, width: d.bounds.width * k, height: d.bounds.height * k }} title={d.label}>
          <span>{d.internal ? 'LAPTOP' : d.primary ? 'MAIN' : 'SCREEN'}</span>
          {s.windows
            .filter((w) => w.displayId === d.id)
            .map((w) => (
              <i key={w.id} className={`scr-win${w.id === self ? ' self' : ''}${w.kind === 'main' ? ' main' : ''}`} style={{ left: (w.bounds.x - d.bounds.x) * k, top: (w.bounds.y - d.bounds.y) * k, width: Math.max(6, w.bounds.width * k), height: Math.max(4, w.bounds.height * k) }} />
            ))}
        </div>
      ))}
    </div>
  );
}

export function ScreensMenu({ only }: { only?: number | null } = {}) {
  const s = useScreens();
  const [open, setOpen] = useState(false);
  const [self, setSelf] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [onScreen, setOnScreen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => void desktop?.screens.self().then(setSelf).catch(() => undefined), []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  if (!desktop?.screens) return null;
  const S = desktop.screens;
  const wins = (s?.windows ?? []).filter((w) => only === undefined || only === null || w.id === only);
  return (
    <div className="scr" ref={ref}>
      <button className={`chip${open ? ' active' : ''}`} onClick={() => setOpen(!open)} title="Screens: send any window to any screen, pop panels out with ⧉ on their tab bar">
        ⧉ <span className="lbl keep">Screens{s && s.displays.length > 1 ? ` ${s.displays.length}` : ''}</span>
      </button>
      {open && s && (
        <div className="popover scr-pop">
          <div className="pop-title">Screens and windows</div>
          <ScreenMap s={s} self={self} />
          {wins.map((w) => (
            <div key={w.id} className="scr-row">
              <div className="scr-row-head">
                <b>{w.kind === 'main' ? 'Terminal' : w.title}</b>
                <span className="muted">on {s.displays.find((d) => d.id === w.displayId)?.label ?? '—'}</span>
                {w.kind === 'panel' && (
                  <button className="btn ghost" onClick={() => void S.close(w.id)} title="Close this window">
                    ×
                  </button>
                )}
              </div>
              <div className="scr-targets">
                {s.displays.map((d) => (
                  <span key={d.id} className="scr-target">
                    <em title={d.label}>{d.internal ? 'Laptop' : d.primary ? 'Main' : d.label.replace(/ \(.*$/, '')}</em>
                    <button className="btn ghost" onClick={() => void S.move(w.id, d.id, 'fill')} title={`Fill ${d.label}`}>
                      Fill
                    </button>
                    <button className="btn ghost" onClick={() => void S.move(w.id, d.id, 'full')} title={`Full screen on ${d.label} (taskbar hidden)`}>
                      Full
                    </button>
                    <button className="btn ghost" onClick={() => void S.move(w.id, d.id, 'float')} title={`A floating window on ${d.label}`}>
                      Float
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ))}
          <div className="pop-title scr-open-title">Open any tool in its own window</div>
          <div className="scr-open-bar">
            <input className="ctl" placeholder="Search: BOT, NNET, VAR, footprint…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the tools" />
            <select className="ctl" value={onScreen ?? ''} onChange={(e) => setOnScreen(e.target.value ? Number(e.target.value) : null)} title="Which screen it opens on">
              <option value="">Beside this window</option>
              {(s.displays ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  on {d.label}
                </option>
              ))}
            </select>
          </div>
          <div className="scr-open-list">
            {PANELS.filter((p) => canPopOut(p.id))
              .map((p) => ({ p, code: FUNCTIONS.find((f) => f.panel === p.id)?.code }))
              .filter(({ p, code }) => !q || `${code ?? ''} ${p.title} ${p.category} ${p.description}`.toLowerCase().includes(q.toLowerCase()))
              .map(({ p, code }) => (
                <button key={p.id} className="scr-open-row" data-panel={p.id} onClick={() => void desktop!.screens.popout(p.id, p.title, { ...(p.defaults as Record<string, unknown>) }, onScreen)} title={p.description}>
                  {code && <b className="mono">{code}</b>}
                  <span>{p.title.replace(/^[A-Z0-9]+ · /, '')}</span>
                  <em>{p.category}</em>
                </button>
              ))}
          </div>
          <div className="popover-foot">Any tool — the Strategy Lab, the quant desk, the markets, the swarm's tools — opens in its own window and stays open whichever view the main window is on, so the crypto swarm can fill one screen while the quant desk or the bot builder fills another. ⧉ on a tab bar pops that tab out; ⇄ moves it to another workspace. Windows come back where they were next time and hide while the terminal is locked.</div>
        </div>
      )}
    </div>
  );
}

/** the page of a popped-out panel window */
/** a tile's picture: where on the screen it goes */
const TILES: { cell: TileCell; name: string; box: [number, number, number, number] }[] = [
  { cell: 'left', name: 'Left half', box: [0, 0, 50, 100] },
  { cell: 'right', name: 'Right half', box: [50, 0, 50, 100] },
  { cell: 'top', name: 'Top half', box: [0, 0, 100, 50] },
  { cell: 'bottom', name: 'Bottom half', box: [0, 50, 100, 50] },
  { cell: 'tl', name: 'Top left quarter', box: [0, 0, 50, 50] },
  { cell: 'tr', name: 'Top right quarter', box: [50, 0, 50, 50] },
  { cell: 'bl', name: 'Bottom left quarter', box: [0, 50, 50, 50] },
  { cell: 'br', name: 'Bottom right quarter', box: [50, 50, 50, 50] },
  { cell: 'l3', name: 'Left third', box: [0, 0, 33.3, 100] },
  { cell: 'm3', name: 'Middle third', box: [33.3, 0, 33.4, 100] },
  { cell: 'r3', name: 'Right third', box: [66.7, 0, 33.3, 100] },
];

/** tile this window: a half, a quarter or a third of the whole screen (no banner, over the taskbar), full screen, or all pop-outs at once */
function TileMenu({ tiled, full }: { tiled: string | null; full: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const S = desktop?.screens;
  if (!S?.tile) return null;
  const go = (cell: TileCell) => {
    setOpen(false);
    void S.tile!('self', cell);
  };
  return (
    <div className="scr tile-menu" ref={ref}>
      <button className={`chip${open || tiled ? ' active' : ''}`} onClick={() => setOpen(!open)} title="Tile this window on its screen — no banner, edge to edge">
        ▦ <span className="lbl keep">Tile</span>
      </button>
      <button className={`chip${full ? ' active' : ''}`} onClick={() => go('full')} title={full ? 'Leave full screen (Esc)' : 'Full screen: the whole screen, no banner, no taskbar (F11)'}>
        ⛶
      </button>
      {open && (
        <div className="popover tile-pop">
          <div className="pop-title">Tile this window — the whole screen, edge to edge</div>
          <div className="tile-grid">
            {TILES.map((t) => (
              <button key={t.cell} className={`tile-cell${tiled === t.cell ? ' active' : ''}`} onClick={() => go(t.cell)} title={t.name} aria-label={t.name}>
                <span style={{ left: `${t.box[0]}%`, top: `${t.box[1]}%`, width: `${t.box[2]}%`, height: `${t.box[3]}%` }} />
              </button>
            ))}
            <button className={`tile-cell${full ? ' active' : ''}`} onClick={() => go('full')} title="Full screen" aria-label="Full screen">
              <span style={{ left: 0, top: 0, width: '100%', height: '100%' }} />
            </button>
          </div>
          <button
            className="btn"
            onClick={() => {
              setOpen(false);
              void S.arrange?.('self');
            }}
            title="Every popped-out window on this screen: side by side, or in a grid (2×2, 3×2…)"
          >
            ▦ Arrange all pop-outs on this screen
          </button>
          <div className="muted tile-note">Tiles cover the taskbar while Novus Ordo is in use. Drag a tile by its bar to make it an ordinary window again.</div>
        </div>
      )}
    </div>
  );
}

export function PopoutPage({ panelId, storeKey, title, cfg }: { panelId: string; storeKey: string; title: string; cfg: string | null }) {
  useThemeAttr();
  const def = PANEL_MAP[panelId];
  const saved = `novus-popout:${storeKey}`;
  const [config, setConfig] = useState<Record<string, unknown>>(() => {
    try {
      const s = safeStorage.getItem(saved) as string | null;
      if (s) return { ...(def?.defaults ?? {}), ...JSON.parse(s) };
    } catch {
      /* the defaults */
    }
    try {
      return { ...(def?.defaults ?? {}), ...(cfg ? JSON.parse(cfg) : {}) };
    } catch {
      return { ...(def?.defaults ?? {}) };
    }
  });
  const [self, setSelf] = useState<number | null>(null);
  const screensNow = useScreens();
  const me = screensNow?.windows.find((w) => w.id === self) ?? null;
  // tiled or full screen: the bar tucks away (it shows when the mouse reaches the top edge) — nothing but the panel
  const clean = !!me && (me.fullScreen || !!me.tiled);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault();
        void desktop?.screens.tile?.('self', 'full');
      } else if (e.key === 'Escape' && me?.fullScreen) void desktop?.screens.tile?.('self', 'full');
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [me?.fullScreen]);
  useEffect(() => {
    // market data streams to this window directly; the swarm and the Lab come from the desktop process
    hub();
    // the order-book history the terminal has already recorded: a heat map here starts full, not empty
    void desktop?.screens.heatHistory?.().then((d) => hub().importHeat(d as never)).catch(() => undefined);
    // the trades are told by the main window only (one message each, however many windows are open)
    startCryptoSwarmLink({ tell: false });
    startLabLink();
    void desktop?.screens.self().then(setSelf);
    document.title = `${title} — Novus Ordo`;
  }, [title]);
  useEffect(() => {
    try {
      safeStorage.setItem(saved, JSON.stringify(config));
    } catch {
      /* not saved */
    }
  }, [saved, config]);
  if (!def || DOCKED_ONLY.has(panelId)) return <div className="empty">This panel stays in the main window.</div>;
  const C = def.component;
  return (
    <div className={`app pro popout-root${clean ? ' clean' : ''}`}>
      {clean && <div className="popout-hot" aria-hidden />}
      <div className="popout-bar" onDoubleClick={(e) => (e.target as HTMLElement).closest('button, .scr, .tile-pop') === null && void desktop?.screens.tile?.('self', 'full')} title="Drag to move · double-click: full screen">
        <b>{def.title}</b>
        <span className="grow" />
        <TileMenu tiled={me?.tiled ?? null} full={!!me?.fullScreen} />
        <ScreensMenu only={self} />
        <button className="chip" onClick={() => void desktop?.screens.dock(panelId, title, config)} title="Back to the terminal: close this window and open the panel where it lives">
          ⇤ Back to the terminal
        </button>
        <button className="chip win-btn" onClick={() => void desktop?.screens.minimize?.()} title="Minimise">
          —
        </button>
        <button className="chip win-btn" onClick={() => window.close()} title="Close this window">
          ×
        </button>
      </div>
      <div className="popout-body">
        <C config={config} setConfig={(p: Record<string, unknown>) => setConfig((c) => ({ ...c, ...p }))} nodeId={`popout-${storeKey}`} />
      </div>
    </div>
  );
}
