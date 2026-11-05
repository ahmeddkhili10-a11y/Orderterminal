// The crypto swarm as the app sees it: its state (pushed by the desktop
// process every second while it runs) and its talk. The swarm itself runs in
// the desktop process, whichever screen is open.
import { create } from 'zustand';
import type { CSwarmLine, CSwarmState } from '../desktop/bridge';
import { desktop } from '../desktop/bridge';
import { tellTrade } from './notify';

export const useCSwarm = create<{ state: CSwarmState | null; lines: CSwarmLine[]; error: string }>(() => ({ state: null, lines: [], error: '' }));

let linked = false;

export function refreshCSwarm() {
  return desktop?.cswarm
    .state()
    .then((state) => useCSwarm.setState({ state, lines: state.lines, error: '' }))
    .catch((e) => useCSwarm.setState({ error: String((e as Error)?.message ?? e) }));
}

export function startCryptoSwarmLink() {
  if (!desktop || linked) return;
  linked = true;
  desktop.cswarm.onState((state) => useCSwarm.setState({ state, lines: state.lines }));
  desktop.cswarm.onEvent((e) => {
    if (e.kind === 'line') useCSwarm.setState((s) => ({ lines: [...s.lines, e.line].slice(-200) }));
    else if (e.kind === 'notify') void tellTrade(e).catch(() => undefined);
  });
  // the exchange services start a moment after the window: ask until they answer
  const first = () => {
    void refreshCSwarm()?.then(() => {
      if (!useCSwarm.getState().state) setTimeout(first, 2000);
    });
  };
  first();
}
