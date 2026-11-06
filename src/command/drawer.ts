// Open a tool in the crypto swarm view's drawer from anywhere (the terminal's
// command line, a button). Kept in its own module so anything can import it.

let pending: string | null = null;

/** ask the swarm view to open this drawer tab (a panel id, or 'deploy' / 'rules') */
export function openDrawer(tab: string) {
  pending = tab;
  window.dispatchEvent(new CustomEvent('novus:drawer', { detail: tab }));
}

/** the tab asked for before the view was on screen, once */
export function takePendingDrawer(): string | null {
  const p = pending;
  pending = null;
  return p;
}
