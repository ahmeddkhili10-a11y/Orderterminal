// The professional terminal's chrome: workspace tabs, the command line with
// its function keys and a running quote tape, and the status line.
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtPct, fmtPrice } from '../core/format';
import { useLab, startLabLink } from '../lab/store';
import { hub } from '../market/hub';
import { useSettings } from '../store/settings';
import { useHubVersion, useTicker } from '../ui/controls';
import { isProTheme, PRO_THEME_IDS, THEMES, type ThemeId } from '../ui/theme';
import { useBoardVenue, useTickers } from './data';
import { openDrawer } from '../command/drawer';
import { FN_MAP, KEYS, parseCommand, suggest, WORKSPACES, type FnHome, type Workspace } from './functions';

/** Open a function's panel in its workspace (App listens). */
export function openFunction(panel: string, ws: FnHome) {
  // the crypto swarm's tools live in its own view, not in the terminal
  if (ws === 'swarm') {
    switchUi('swarm');
    if (panel !== 'command') openDrawer(panel === 'cswarm' ? 'rules' : panel);
    return;
  }
  window.dispatchEvent(new CustomEvent('novus:open-panel', { detail: { panel, ws } }));
}

/** Switch between the professional terminal and the classic swarm views, keeping each look's theme. */
export function switchUi(ui: 'pro' | 'classic' | 'swarm') {
  const s = useSettings.getState();
  if (ui === s.ui) return;
  // the swarm view and the classic look wear the swarm themes; the terminal its own
  if (ui !== 'pro') s.set({ ui, theme: isProTheme(s.theme) ? s.classicTheme : s.theme });
  else s.set({ ui, classicTheme: isProTheme(s.theme) ? s.classicTheme : s.theme, theme: isProTheme(s.theme) ? s.theme : 'pro-amber' });
}

export function WorkspaceTabs() {
  const ws = useSettings((s) => s.workspace);
  const set = useSettings((s) => s.set);
  const lab = useLab((s) => s.status);
  const dot = (id: Workspace) => (id === 'lab' ? (lab?.running ? ' on' : lab?.deployed.some((d) => d.on) ? ' on' : '') : ' on');
  return (
    <div className="pro-ws" role="tablist" aria-label="Workspaces">
      {WORKSPACES.map((w) => (
        <button key={w.id} role="tab" aria-selected={ws === w.id} className={`pro-ws-tab${ws === w.id ? ' active' : ''}`} onClick={() => set({ workspace: w.id })} title={`${w.desc} (${w.key})`}>
          <span className={`vt-dot${dot(w.id)}`} />
          {w.name}
        </button>
      ))}
    </div>
  );
}

/** the terminal's theme: a compact list (the top bar is full in the professional terminal) */
export function ProThemePicker() {
  const theme = useSettings((s) => s.theme);
  const set = useSettings((s) => s.set);
  return (
    <select className="ctl pro-theme-select" value={theme} onChange={(e) => set({ theme: e.target.value as ThemeId })} title="Terminal theme" aria-label="Terminal theme">
      {PRO_THEME_IDS.map((id) => (
        <option key={id} value={id}>
          ◐ {THEMES[id].name}
        </option>
      ))}
    </select>
  );
}

function QuoteTape() {
  const venue = useBoardVenue();
  const t = useTickers(venue);
  const top = useMemo(() => [...t.rows].sort((a, b) => b.volume24hUsd - a.volume24hUsd).slice(0, 16), [t.rows, t.at]);
  if (!top.length) return <div className="pro-tape" />;
  const items = top.map((x) => (
    <span key={x.symbol} className="pro-tape-item">
      <b>{x.base}</b> <span className="mono">{fmtPrice(x.last)}</span> <span className={`mono ${x.change24hPct >= 0 ? 'up' : 'down'}`}>{fmtPct(x.change24hPct)}</span>
    </span>
  ));
  return (
    <div className="pro-tape" aria-label="Quote tape">
      <div className="pro-tape-run">
        {items}
        {items}
      </div>
    </div>
  );
}

export function CommandBar() {
  const ws = useSettings((s) => s.workspace);
  const set = useSettings((s) => s.set);
  const setPrimary = useSettings((s) => s.setPrimary);
  const venue = useSettings((s) => s.primaryVenue);
  const base = useSettings((s) => s.base);
  const [text, setText] = useState('');
  const [hint, setHint] = useState('');
  const [pick, setPick] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const sug = suggest(text);
  useEffect(() => startLabLink(), []);
  // F1–F4 switch workspaces; ` or Ctrl+K focuses the command line
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const w = WORKSPACES.find((x) => x.key === e.key);
      if (w && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        set({ workspace: w.id });
        return;
      }
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '`' && document.activeElement?.tagName !== 'INPUT')) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [set]);
  const run = (cmd: string) => {
    const p = parseCommand(cmd);
    const did: string[] = [];
    if (p.coin && !p.fn && !p.workspace && FN_MAP[p.coin] === undefined && p.coin !== base) {
      setPrimary(p.coin, venue);
      did.push(`${p.coin} is the market`);
    } else if (p.coin && p.coin !== base) {
      setPrimary(p.coin, venue);
      did.push(`${p.coin}`);
    }
    if (p.fn) {
      openFunction(p.fn.panel, p.fn.ws);
      did.push(`${p.fn.code} ${p.fn.name}`);
    } else if (p.workspace) {
      set({ workspace: p.workspace });
      did.push(WORKSPACES.find((w) => w.id === p.workspace)?.name ?? '');
    }
    setHint(p.unknown.length ? `Unknown: ${p.unknown.join(' ')} — type HELP or a code like MON, GP, RSCH` : did.join(' · '));
    setText('');
    setPick(0);
  };
  return (
    <div className="pro-cmdbar">
      <div className="pro-cmd">
        <span className="pro-cmd-prompt">{base}</span>
        <input
          ref={input}
          className="pro-cmd-input mono"
          value={text}
          placeholder="Type a function and press Enter — ETH GP · MON · HMAP · RSCH · F1–F4 workspaces"
          onChange={(e) => {
            setText(e.target.value);
            setPick(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const words = text.trim().split(/\s+/);
              // Enter on a half-typed code takes the highlighted suggestion
              if (sug.length && !FN_MAP[words[words.length - 1]?.toUpperCase()] && words[words.length - 1]) words[words.length - 1] = sug[pick].code;
              run(words.join(' '));
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setPick((p) => Math.min(sug.length - 1, p + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setPick((p) => Math.max(0, p - 1));
            } else if (e.key === 'Escape') {
              setText('');
              input.current?.blur();
            }
          }}
          aria-label="Command line"
        />
        <span className="pro-cmd-go" onClick={() => run(text)}>
          GO
        </span>
        {text && sug.length > 0 && (
          <div className="pro-sug" role="listbox">
            {sug.map((f, i) => (
              <div key={f.code} role="option" aria-selected={i === pick} className={`pro-sug-row${i === pick ? ' on' : ''}`} onMouseDown={(e) => (e.preventDefault(), run(text.replace(/\S+$/, f.code)))}>
                <b className="mono">{f.code}</b>
                <span>{f.name}</span>
                <em>{f.desc}</em>
                <small>{WORKSPACES.find((w) => w.id === f.ws)?.name ?? 'CRYPTO SWARM'}</small>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="pro-keys">
        {KEYS[ws].map((code, i) => {
          const f = FN_MAP[code];
          return (
            <button key={code} className="pro-key" onClick={() => openFunction(f.panel, f.ws)} title={`${f.name}: ${f.desc}`}>
              <i>{i + 1}</i>
              <b>{code}</b>
              <span>{f.name}</span>
            </button>
          );
        })}
        {hint && <span className="pro-hint">{hint}</span>}
      </div>
      <QuoteTape />
    </div>
  );
}

export function StatusLine() {
  useTicker(1000);
  useHubVersion();
  const H = hub();
  const f = H.primary;
  const lab = useLab((s) => s.status);
  const now = new Date();
  const dep = lab?.deployed.filter((d) => d.on).length ?? 0;
  return (
    <div className="pro-status-line mono">
      <span>
        <span className={`status-dot status-${f.status.state}`} /> {f.adapter.name} {f.inst.symbol} {f.status.state.toUpperCase()}
        {f.status.latencyMs !== undefined ? ` ${f.status.latencyMs.toFixed(0)}ms` : ''} · {f.rate.toFixed(0)} msg/s
      </span>
      <span>
        LAB {lab?.running ? `RESEARCHING ${lab.progress ? Math.round((lab.progress.done / Math.max(1, lab.progress.total)) * 100) : 0}%` : `${dep} DEPLOYED`}
      </span>
      <span className="grow" />
      <span>
        {now.toISOString().slice(11, 19)} UTC · {now.toLocaleTimeString([], { hour12: false })} LOCAL
      </span>
    </div>
  );
}

export function useIsPro() {
  return useSettings((s) => s.ui) === 'pro';
}
