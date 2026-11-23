// Whether a panel is on show. A workspace you are not looking at, or a tab behind another in
// its tabset, stays mounted (so it keeps its state) but is hidden; its panels need not reload
// candles or redraw lists meanwhile. They catch up the moment they are shown again.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

const Visible = createContext(true);

/** true while the panel is on show (always true outside a panel host, e.g. in a pop-out) */
export const usePanelVisible = () => useContext(Visible);

/**
 * Wraps a panel: an invisible marker the size of its tab tells, through an observer (no
 * layout reads), when the tab or its workspace is hidden.
 */
export function VisibleBoundary({ children }: { children: ReactNode }) {
  const probe = useRef<HTMLElement>(null);
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = probe.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => {
      const e = es[es.length - 1];
      setOn(e.isIntersecting || (e.boundingClientRect.width > 0 && e.boundingClientRect.height > 0));
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Visible.Provider value={on}>
      <i ref={probe} className="panel-probe" aria-hidden />
      {children}
    </Visible.Provider>
  );
}
