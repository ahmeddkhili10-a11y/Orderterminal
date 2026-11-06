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
import { desktop, type ScreensState } from '../desktop/bridge';
import { startLabLink } from '../lab/store';
import { hub } from '../market/hub';
import { PANEL_MAP } from '../panels/registry';
import { safeStorage } from '../store/settings';

/** panels that must stay in the main window (their service runs there) */
export const DOCKED_ONLY = new Set(['memeswarm', 'memescan', 'memetoken', 'wallet', 'telegram']);
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
          <div className="popover-foot">Pop a panel out with ⧉ on its tab bar — then send it to any screen here. Popped-out panels come back where they were next time, and hide while the terminal is locked.</div>
        </div>
      )}
    </div>
  );
}

/** the page of a popped-out panel window */
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
  useEffect(() => {
    // market data streams to this window directly; the swarm and the Lab come from the desktop process
    hub();
    startCryptoSwarmLink();
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
    <div className="app pro popout-root">
      <div className="popout-bar">
        <b>{def.title}</b>
        <span className="grow" />
        <ScreensMenu only={self} />
        <button className="chip" onClick={() => window.close()} title="Close this window">
          ×
        </button>
      </div>
      <div className="popout-body">
        <C config={config} setConfig={(p: Record<string, unknown>) => setConfig((c) => ({ ...c, ...p }))} nodeId={`popout-${storeKey}`} />
      </div>
    </div>
  );
}
