import { useEffect, useState, type ReactNode } from 'react';
import { switchUi } from '../pro/ProBar';
import type { IJsonModel } from 'flexlayout-react';
import { byodInfo, type ByodInfo } from '../history/byod';
import { desktop, isDesktop, type AppStatus } from '../desktop/bridge';
import { COMMERCIAL } from '../shared/edition';
import { LEDGER_LENGTH } from '../shared/ledger';
import { changeLedgerKey, sealTerminal } from './LockScreen';
import { ADAPTERS } from '../exchanges';
import { hub } from '../market/hub';
import { PANELS, type Category } from '../panels/registry';
import { useSettings, type HistorySource } from '../store/settings';
import { NumberInput, useHubVersion } from '../ui/controls';
import { AppearanceSettings } from '../ui/ThemeControls';
import { deleteNamed, listSaved, PRESETS, saveNamed, type SavedLayout } from './layouts';

export function Modal({ title, onClose, children, footer, width }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, 100%)` } : undefined} role="dialog" aria-label={title}>
        <header>
          {title}
          <button className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="body">{children}</div>
        {footer && <div className="foot">{footer}</div>}
      </div>
    </div>
  );
}

const SOURCES: { id: HistorySource; name: string; text: string; desktopOnly?: boolean }[] = [
  { id: 'local', name: 'Local database', text: 'Trades recorded by this app in its SQLite database, with any recent gap filled from the exchange.', desktopOnly: true },
  { id: 'exchange', name: 'Exchange REST backfill', text: 'Pull recent aggregated trades from the venue’s public API on load (Binance spot/futures and the simulator). Other venues start live.' },
  { id: 'byod', name: 'Custom (BYOD)', text: 'Your own history server speaking the v1 protocol (/v1/info, /v1/trades, /v1/liquidations) — e.g. server/history-server.mjs in this repo.' },
  { id: 'none', name: 'Live only', text: 'No history. Footprint and DOM build from the moment the terminal opens.' },
];

export function ConnectionModal({ onClose }: { onClose: () => void }) {
  useHubVersion();
  const s = useSettings();
  const [url, setUrl] = useState(s.byodUrl);
  const [token, setToken] = useState(s.byodToken);
  const [source, setSource] = useState<HistorySource>(s.historySource);
  const [minutes, setMinutes] = useState(s.backfillMinutes);
  const [test, setTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'error'; msg?: string; info?: ByodInfo }>({ state: 'idle' });
  const H = hub();
  const bf = H.backfill;

  const runTest = async () => {
    setTest({ state: 'testing' });
    try {
      const info = await byodInfo(url, token);
      setTest({ state: 'ok', info, msg: `${info.server} · ${info.exchanges.map((e) => `${e.id}: ${e.symbols.map((x) => x.symbol).join(', ')}`).join(' · ')}` });
    } catch (e) {
      setTest({ state: 'error', msg: String((e as Error).message ?? e) });
    }
  };

  const apply = () => {
    if (source === 'byod' && test.state !== 'ok') {
      void runTest();
      return;
    }
    s.set({ historySource: source, byodUrl: url, byodToken: token, backfillMinutes: minutes });
    onClose();
  };

  return (
    <Modal
      title="Connection & history"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={() => void H.runBackfill()}>
            Reload history
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={apply}>
            {source === 'byod' && test.state !== 'ok' ? 'Test & apply' : 'Apply'}
          </button>
        </>
      }
    >
      <div className="section-title">Live data</div>
      <p className="muted" style={{ marginTop: 0, lineHeight: 1.5 }}>
        Your browser connects directly to each venue’s public WebSocket — no backend, no account, no data leaving your device. Primary:{' '}
        <b style={{ color: 'var(--text)' }}>
          {H.primary.adapter.name} {H.primary.inst.symbol}
        </b>
        .
      </p>
      <table className="grid" style={{ marginBottom: 12 }}>
        <thead>
          <tr>
            <th>Venue</th>
            <th>Symbol</th>
            <th>Status</th>
            <th>Msg/s</th>
            <th>Latency</th>
            <th>Trades held</th>
          </tr>
        </thead>
        <tbody>
          {H.aggregate.map((f) => (
            <tr key={f.key}>
              <td>{f.adapter.name}</td>
              <td className="mono">{f.inst.symbol}</td>
              <td title={f.status.error}>
                <span className={`status-dot status-${f.status.state}`} /> {f.status.state}
                {f.status.error && f.status.state !== 'open' ? <span className="muted"> — {f.status.error}</span> : null}
              </td>
              <td>{f.rate.toFixed(0)}</td>
              <td>{f.status.latencyMs !== undefined ? f.status.latencyMs.toFixed(0) + 'ms' : '—'}</td>
              <td>{f.store.length.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="section-title">History source</div>
      <div className="radio-cards">
        {SOURCES.filter((x) => !x.desktopOnly || isDesktop).map((x) => (
          <div key={x.id} className={`radio-card ${source === x.id ? 'on' : ''}`} onClick={() => setSource(x.id)} role="radio" aria-checked={source === x.id}>
            <b>{x.name}</b>
            <span>{x.text}</span>
          </div>
        ))}
      </div>
      {source !== 'none' && (
        <div className="form-row">
          <span>Lookback</span>
          <NumberInput value={minutes} onChange={(m) => setMinutes(Math.max(1, Math.min(1440, Math.round(m))))} suffix="minutes" width={90} />
        </div>
      )}
      {source === 'byod' && (
        <>
          <div className="form-row">
            <span>Server URL</span>
            <input className="ctl mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:8080" />
          </div>
          <div className="form-row">
            <span>Auth token (optional)</span>
            <input className="ctl mono" value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="Bearer token" />
          </div>
          <div className="form-row">
            <span />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn ghost" onClick={() => void runTest()} disabled={test.state === 'testing'}>
                {test.state === 'testing' ? 'Testing…' : 'Test connection'}
              </button>
              {test.msg && <span className={test.state === 'ok' ? 'up' : 'down'}>{test.msg}</span>}
            </div>
          </div>
        </>
      )}
      <div className="muted" style={{ marginTop: 6 }}>
        Current: <b>{bf.state}</b> {bf.message}
      </div>
    </Modal>
  );
}

function Thumb({ thumb }: { thumb: (typeof PRESETS)[number]['thumb'] }) {
  return (
    <div className="mini" style={{ gridTemplateColumns: thumb.cols, gridTemplateRows: thumb.rows }}>
      {thumb.cells.map(([name, area]) => (
        <div key={name + area} style={{ gridArea: area }}>
          {name}
        </div>
      ))}
    </div>
  );
}

export function LayoutsModal({ onClose, onApply, current }: { onClose: () => void; onApply: (json: IJsonModel) => void; current: () => IJsonModel }) {
  const [saved, setSaved] = useState<SavedLayout[]>(listSaved());
  const [name, setName] = useState('');
  const [importText, setImportText] = useState('');
  const [err, setErr] = useState('');
  return (
    <Modal title="Layouts" onClose={onClose} width={860}>
      <div className="section-title">Gallery</div>
      <div className="gallery">
        {PRESETS.map((p) => (
          <div
            key={p.id}
            className="gallery-card"
            onClick={() => {
              onApply(p.build());
              onClose();
            }}
          >
            <Thumb thumb={p.thumb} />
            <b>{p.name}</b>
            <span>{p.description}</span>
          </div>
        ))}
      </div>
      <div className="section-title">Saved layouts</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input className="ctl" placeholder="Name this layout…" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, height: 28 }} />
        <button
          className="btn"
          disabled={!name.trim()}
          onClick={() => {
            saveNamed(name.trim(), current());
            setSaved(listSaved());
            setName('');
          }}
        >
          Save current
        </button>
      </div>
      {saved.length === 0 ? (
        <div className="muted">No saved layouts yet. Layouts, panel settings and journal persist in this browser.</div>
      ) : (
        saved.map((l) => (
          <div key={l.name} className="list-row" style={{ alignItems: 'center' }}>
            <b style={{ flex: 1 }}>{l.name}</b>
            <span className="muted">{new Date(l.time).toLocaleString()}</span>
            <button
              className="chip"
              onClick={() => {
                onApply(l.json);
                onClose();
              }}
            >
              Load
            </button>
            <button
              className="chip"
              onClick={() => {
                deleteNamed(l.name);
                setSaved(listSaved());
              }}
            >
              Delete
            </button>
          </div>
        ))
      )}
      <div className="section-title">Import / export</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <button className="btn ghost" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(current()))}>
          Copy current layout JSON
        </button>
        <button
          className="btn ghost"
          disabled={!importText.trim()}
          onClick={() => {
            try {
              const json = JSON.parse(importText);
              if (!json.layout) throw new Error('missing "layout"');
              onApply(json);
              onClose();
            } catch (e) {
              setErr(String((e as Error).message));
            }
          }}
        >
          Import JSON
        </button>
        {err && <span className="down">{err}</span>}
      </div>
      <textarea className="ctl mono" rows={3} placeholder="Paste layout JSON to import" value={importText} onChange={(e) => setImportText(e.target.value)} />
    </Modal>
  );
}

const CATS: Category[] = ['Charts', 'Orderflow', 'Order book', 'Derivatives', 'Market', 'Quant', 'Strategy Lab', 'Account', 'Algo', 'Tools'];

export type Placement = 'active' | 'left' | 'right' | 'bottom' | 'dock-left' | 'dock-right' | 'dock-bottom';

const PLACEMENTS: { id: Placement; label: string }[] = [
  { id: 'active', label: 'Active area (as a tab)' },
  { id: 'left', label: 'New column — left' },
  { id: 'right', label: 'New column — right' },
  { id: 'bottom', label: 'New row — bottom' },
  { id: 'dock-left', label: 'Left dock (collapsible)' },
  { id: 'dock-right', label: 'Right dock (collapsible)' },
  { id: 'dock-bottom', label: 'Bottom dock (collapsible)' },
];

export function AddPanelModal({ onClose, onAdd }: { onClose: () => void; onAdd: (id: string, where: Placement) => void }) {
  const [where, setWhere] = useState<Placement>('active');
  return (
    <Modal title="Add panel" onClose={onClose} width={820}>
      <div className="section-title">Place in</div>
      <div className="chip-row">
        {PLACEMENTS.map((p) => (
          <button key={p.id} className={`chip ${where === p.id ? 'active' : ''}`} onClick={() => setWhere(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="muted" style={{ marginBottom: 4 }}>
        You can also drag any tab by its title onto any side of any panel or the window edge; drag the gaps between panels to resize.
      </div>
      {CATS.map((cat) => (
        <div key={cat}>
          <div className="section-title">{cat}</div>
          <div className="panel-list">
            {PANELS.filter((p) => p.category === cat).map((p) => (
              <div
                key={p.id}
                className="panel-item"
                onClick={() => {
                  onAdd(p.id, where);
                  onClose();
                }}
              >
                <b>
                  {p.title} {p.aggregated && <span className="tag">Σ</span>}
                </b>
                <span>{p.description}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </Modal>
  );
}

function LedgerKeySettings() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, LEDGER_LENGTH);
  const field = (value: string, set: (v: string) => void, label: string) => (
    <div className="form-row">
      <span>{label}</span>
      <input className="ctl mono" type="password" inputMode="numeric" autoComplete="off" value={value} maxLength={LEDGER_LENGTH} onChange={(e) => set(digits(e.target.value))} style={{ width: 160 }} />
    </div>
  );
  const change = async () => {
    setMsg(null);
    if (next !== again) return setMsg({ ok: false, text: 'The new keys do not match.' });
    try {
      await changeLedgerKey(cur, next);
      setCur('');
      setNext('');
      setAgain('');
      setMsg({ ok: true, text: 'Ledger key changed. Use the new key from now on.' });
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message ?? e) });
    }
  };
  return (
    <div className="ledger-settings">
      <div className="section-title">Ledger key (lock screen)</div>
      {field(cur, setCur, 'Current key')}
      {field(next, setNext, `New key (${LEDGER_LENGTH} digits)`)}
      {field(again, setAgain, 'Repeat new key')}
      <div className="form-row">
        <span />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn" disabled={cur.length !== LEDGER_LENGTH || next.length !== LEDGER_LENGTH || again.length !== LEDGER_LENGTH} onClick={() => void change()}>
            Change key
          </button>
          <button className="btn ghost" onClick={() => void sealTerminal()} title="Back to the lock screen; bots keep running">
            Seal now
          </button>
          {msg && <span className={msg.ok ? 'up' : 'down'}>{msg.text}</span>}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>
        Only a salted SHA-256 digest of the key is stored{desktop ? ' (in the app database, checked by the desktop process)' : ' (in this browser)'}. {COMMERCIAL ? 'It cannot be recovered if you forget it' : 'If you forget it, the built-in key stops working too'} — keep it somewhere safe.
      </div>
    </div>
  );
}

/** a purchased copy's licence: what it is, and moving it to another computer */
function LicenseSettings() {
  const [st, setSt] = useState<AppStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void desktop?.app.status().then(setSt).catch(() => undefined);
  }, []);
  const L = st?.license;
  if (!COMMERCIAL || !desktop || !L?.required) return null;
  const deactivate = async () => {
    if (!confirm('Deactivate Novus Ordo on this computer?\n\nIts licence seat is given back, so you can activate the licence on another computer. This copy locks, and asks for the licence key again the next time it opens. Your keys and settings stay on this computer.')) return;
    setBusy(true);
    try {
      await desktop!.app.deactivate();
    } catch (e) {
      alert(String((e as Error).message ?? e));
    }
    setBusy(false);
  };
  return (
    <div className="ledger-settings">
      <div className="section-title">Licence</div>
      <div className="form-row">
        <span>Licence key</span>
        <span className="mono">{L.key ?? '—'}</span>
      </div>
      {L.email && (
        <div className="form-row">
          <span>Licensed to</span>
          <span>{L.email}</span>
        </div>
      )}
      <div className="form-row">
        <span>Last checked</span>
        <span className="muted">{L.verifiedAt ? new Date(L.verifiedAt).toLocaleString() : '—'}{typeof L.uses === 'number' ? ` · active on ${L.uses} computer${L.uses === 1 ? '' : 's'}` : ''}</span>
      </div>
      <div className="form-row">
        <span />
        <button className="btn" disabled={busy} onClick={() => void deactivate()} title="Give this computer's licence seat back, to use the licence on another computer">
          Deactivate this computer
        </button>
      </div>
    </div>
  );
}

/** everything this window keeps in its own storage (settings, layouts, panel choices), for a backup */
function windowStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) out[k] = localStorage.getItem(k) ?? '';
    }
  } catch {
    /* storage unavailable */
  }
  return out;
}

/** Backups: everything in one password-protected file; restore on this or another computer */
function BackupSettings() {
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [rpw, setRpw] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!desktop?.backup) return null;
  const create = async () => {
    setMsg(null);
    if (pw !== again) return setMsg({ ok: false, text: 'The passwords do not match.' });
    setBusy(true);
    try {
      const r = await desktop!.backup.create(pw, windowStorage());
      if (r) {
        setPw('');
        setAgain('');
        setMsg({ ok: true, text: `Saved ${r.path} — ${r.summary.keys} keys, ${r.summary.trades} journal trades, ${r.summary.strategies} deployed strategies, your settings and layouts.` });
      }
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message ?? e) });
    }
    setBusy(false);
  };
  const restore = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await desktop!.backup.restore(rpw);
      if (r) {
        // the window's own settings and layouts come back too, then everything starts again from the backup
        try {
          localStorage.clear();
          for (const [k, v] of Object.entries(r.storage)) localStorage.setItem(k, v);
        } catch {
          /* settings could not be written: the rest is restored */
        }
        setMsg({ ok: true, text: `Restored ${r.keys} keys and ${r.trades} journal trades. Restarting…` });
        setTimeout(() => void desktop!.app.restart(), 800);
      }
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message ?? e) });
    }
    setBusy(false);
  };
  return (
    <div className="ledger-settings" data-backup>
      <div className="section-title">Backup</div>
      <div className="muted" style={{ fontSize: 11, lineHeight: 1.5, marginBottom: 6 }}>
        One file with everything: your keys (exchanges, Telegram, wallets), settings and layouts, the Strategy Lab and the edge finder's progress, deployed strategies, the crypto swarm's book and what it learned, the trade journal and the bots. Recorded tick history and downloaded candles are left out (they come back from the exchanges). It is locked with your password — <b>nobody can open it without the password, and the password cannot be recovered</b>. Keep the file and the password somewhere safe, apart from this computer.
      </div>
      <div className="form-row">
        <span>Backup password</span>
        <input className="ctl" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} style={{ width: 220 }} placeholder="at least 10 characters" />
      </div>
      <div className="form-row">
        <span>Repeat it</span>
        <input className="ctl" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} style={{ width: 220 }} />
      </div>
      <div className="form-row">
        <span />
        <button className="btn" disabled={busy || pw.length < 10 || !again} onClick={() => void create()}>
          Save a backup…
        </button>
      </div>
      <div className="form-row">
        <span>Restore</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="ctl" type="password" autoComplete="off" value={rpw} onChange={(e) => setRpw(e.target.value)} style={{ width: 220 }} placeholder="the backup's password" />
          <button className="btn ghost" disabled={busy || !rpw} onClick={() => void restore()} title="Choose a backup file; you are asked to confirm before anything changes">
            Restore from a backup…
          </button>
        </div>
      </div>
      {msg && <div className={msg.ok ? 'up' : 'down'} style={{ fontSize: 12, marginTop: 4 }}>{msg.text}</div>}
    </div>
  );
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  return (
    <Modal title="Settings" onClose={onClose} width={820}>
      <div className="section-title">Workspace</div>
      <div className="form-row">
        <span>Screen</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className={`chip${s.ui === 'pro' ? ' active' : ''}`} onClick={() => (switchUi('pro'), onClose())}>
            Terminal
          </button>
          <button className={`chip${s.ui === 'swarm' ? ' active' : ''}`} onClick={() => (switchUi('swarm'), onClose())}>
            Crypto swarm
          </button>
          <button className={`chip${s.ui === 'classic' ? ' active' : ''}`} onClick={() => (switchUi('classic'), s.set({ view: 'terminal', cryptoView: 'panels' }), onClose())}>
            Classic order-flow terminal
          </button>
          <span className="muted" style={{ fontSize: 11 }}>
            The terminal (Ctrl+1) has Markets, the Strategy Lab and the Quant desk (F1–F3); the crypto swarm (Ctrl+2) is its own view, where strategies are deployed and your accounts trade; the classic look keeps the old order-flow layout.
          </span>
        </div>
      </div>
      <AppearanceSettings />
      <LedgerKeySettings />
      <LicenseSettings />
      <BackupSettings />
      <div className="section-title">Display</div>
      <div className="form-row">
        <span>FPS counter</span>
        <label className="check">
          <input type="checkbox" checked={s.showFps} onChange={(e) => s.set({ showFps: e.target.checked })} /> show in top bar
        </label>
      </div>
      <div className="section-title">Sound & alerts</div>
      <div className="form-row">
        <span>Sounds</span>
        <label className="check">
          <input type="checkbox" checked={s.soundEnabled} onChange={(e) => s.set({ soundEnabled: e.target.checked })} /> enable alert and tape sounds
        </label>
      </div>
      <div className="form-row">
        <span>Browser notifications</span>
        <div>
          <button className="btn ghost" onClick={() => typeof Notification !== 'undefined' && void Notification.requestPermission()}>
            {typeof Notification === 'undefined' ? 'Not supported' : `Permission: ${Notification.permission}`}
          </button>
        </div>
      </div>
      <div className="section-title">Trade size tiers (tape, bubbles)</div>
      <div className="form-row">
        <span>Mid tier from</span>
        <NumberInput value={s.tierMid} onChange={(tierMid) => s.set({ tierMid })} suffix="$" width={110} />
      </div>
      <div className="form-row">
        <span>Whale tier from</span>
        <NumberInput value={s.tierWhale} onChange={(tierWhale) => s.set({ tierWhale })} suffix="$" width={110} />
      </div>
      <div className="section-title">Venues</div>
      <div className="muted" style={{ lineHeight: 1.6 }}>
        {Object.values(ADAPTERS)
          .map((a) => `${a.name}${a.hasLiquidations ? ' (liquidations)' : ''}`)
          .join(' · ')}
      </div>
      <div className="section-title">Data</div>
      <button
        className="btn danger"
        onClick={() => {
          if (!confirm('Reset all settings, layouts, alerts and journal stored in this browser?')) return;
          try {
            for (const k of ['oft-settings', 'oft-layout', 'oft-saved-layouts']) localStorage.removeItem(k);
          } catch {
            /* ignore */
          }
          location.reload();
        }}
      >
        Reset everything
      </button>
    </Modal>
  );
}
