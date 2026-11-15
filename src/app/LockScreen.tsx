import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import emblem from '../assets/emblem.png';
import { desktop, type AppGate } from '../desktop/bridge';
import { COMMERCIAL, TERMS_VERSION } from '../shared/edition';
import { TERMS, TERMS_TITLE } from '../shared/terms';
import { AttemptGate, isLedgerRecord, LEDGER_LENGTH, ledgerMatches, makeLedger, normalizeKey, type LedgerRecord } from '../shared/ledger';
import { runBoot, useBoot } from './boot';
import { lockTerminal, SESSION_FLAG, useLock } from './lock';
import { RunningBar } from './RunningBar';
import { BootRing } from './BootRing';


async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// browser builds check the key here; the desktop app checks it in its own process
const webGate = new AttemptGate();
const WEB_LEDGER = 'novus-ledger';

function webLedger(): LedgerRecord | undefined {
  try {
    const r = JSON.parse(localStorage.getItem(WEB_LEDGER) ?? 'null');
    return isLedgerRecord(r) ? r : undefined;
  } catch {
    return undefined;
  }
}

/** Replace the ledger key (needs the current one). */
export async function changeLedgerKey(current: string, next: string): Promise<void> {
  if (desktop) {
    await desktop.app.changeKey(current, next);
    return;
  }
  webGate.check();
  if (!(await ledgerMatches(current, sha256Hex, webLedger()))) {
    webGate.fail();
    throw new Error('Current ledger key is wrong');
  }
  const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(WEB_LEDGER, JSON.stringify(await makeLedger(next, sha256Hex, salt)));
}

// ---------- the commercial edition's first launch (browser builds keep it in this browser) ----------
const WEB_TERMS = 'novus-terms';

async function gateNow(): Promise<AppGate> {
  if (!COMMERCIAL) return { needsLicense: false, needsTerms: false, needsSetup: false };
  if (desktop) {
    const st = await desktop.app.status();
    return { needsLicense: !!st.needsLicense, needsTerms: !!st.needsTerms, needsSetup: !!st.needsSetup, license: st.license };
  }
  let terms = 0;
  try {
    terms = Number(localStorage.getItem(WEB_TERMS) ?? 0);
  } catch {
    /* private mode */
  }
  return { needsLicense: false, needsTerms: terms < TERMS_VERSION, needsSetup: !webLedger() };
}

async function acceptTerms(): Promise<void> {
  if (desktop) await desktop.app.acceptTerms(TERMS_VERSION);
  else localStorage.setItem(WEB_TERMS, String(TERMS_VERSION));
}

async function setupKey(next: string, again: string): Promise<void> {
  if (normalizeKey(next) !== normalizeKey(again)) throw new Error('THE TWO KEYS DO NOT MATCH');
  if (desktop) await desktop.app.setupKey(next, again);
  else {
    const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(WEB_LEDGER, JSON.stringify(await makeLedger(next, sha256Hex, salt)));
  }
  try {
    sessionStorage.setItem(SESSION_FLAG, '1');
  } catch {
    /* private mode */
  }
}

/** Lock the terminal now and return to the lock screen (see app/lock). */
export function sealTerminal(reason?: string): Promise<void> {
  return lockTerminal(reason);
}

async function unlock(code: string): Promise<void> {
  if (desktop) {
    await desktop.app.unlock(code);
  } else {
    webGate.check();
    if (!(await ledgerMatches(code, sha256Hex, webLedger()))) {
      webGate.fail();
      throw new Error(webGate.waitMs() ? `ACCESS DENIED — locked for ${Math.ceil(webGate.waitMs() / 1000)}s` : 'ACCESS DENIED');
    }
    webGate.success();
  }
  try {
    sessionStorage.setItem(SESSION_FLAG, '1');
  } catch {
    /* private mode */
  }
}

/** Already unlocked in this window (e.g. after View → Reload)? */
export async function alreadyUnlocked(): Promise<boolean> {
  if (desktop) return !(await desktop.app.locked().catch(() => true));
  try {
    return sessionStorage.getItem(SESSION_FLAG) === '1';
  } catch {
    return false;
  }
}

function sessionId() {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase().replace(/(.{4})/, '$1-');
}

export function LockScreen({ onUnlocked, onGone }: { onUnlocked: () => void; onGone: () => void }) {
  const { steps, done, safeMode } = useBoot();
  // locked again after use (not the first boot): show that the terminal is still running
  const relocked = useLock((s) => s.lockedAt !== null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ kind: 'denied' | 'granted' | 'busy'; text: string } | null>(null);
  const [shake, setShake] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sid = useMemo(sessionId, []);
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    runBoot();
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  // the commercial edition: licence, terms and the buyer's own key come first
  const [gate, setGate] = useState<AppGate | null>(COMMERCIAL ? null : { needsLicense: false, needsTerms: false, needsSetup: false });
  useEffect(() => {
    if (!COMMERCIAL) return;
    let alive = true;
    const ask = () =>
      gateNow()
        .then((g) => alive && setGate(g))
        .catch(() => alive && setTimeout(ask, 1000));
    ask();
    return () => {
      alive = false;
    };
  }, []);
  const step = !gate ? 'wait' : gate.needsLicense ? 'license' : gate.needsTerms ? 'terms' : gate.needsSetup ? 'setup' : 'unlock';
  const granted = () => {
    setMsg({ kind: 'granted', text: 'ACCESS GRANTED' });
    setLeaving(true);
    onUnlocked();
    setTimeout(onGone, 850);
  };

  const submit = async (value = code) => {
    const digits = normalizeKey(value);
    if (digits.length !== LEDGER_LENGTH || msg?.kind === 'busy' || leaving) return;
    setMsg({ kind: 'busy', text: 'VERIFYING…' });
    try {
      await unlock(digits);
      setMsg({ kind: 'granted', text: 'ACCESS GRANTED' });
      setLeaving(true);
      onUnlocked();
      setTimeout(onGone, 850);
    } catch (e) {
      setMsg({ kind: 'denied', text: String((e as Error).message ?? e).replace(/^Error:\s*/, '') });
      setShake((n) => n + 1);
      setCode('');
      input.current?.focus();
    }
  };

  const current = [...steps].reverse().find((s) => s.state === 'loading');
  const finished = steps.filter((s) => s.state !== 'loading').length;
  const total = Math.max(steps.length, finished + (done ? 0 : 1), 1);
  const pct = done ? 100 : Math.round((finished / (total + 2)) * 100);

  return (
    <div className={`lock ${leaving ? 'leaving' : ''} ${step === 'license' || step === 'terms' || step === 'setup' ? 'first-run' : ''}`} onMouseDown={() => setTimeout(() => step === 'unlock' && input.current?.focus(), 0)}>
      <div className="lock-ring">{relocked ? <RunningBar /> : <BootRing />}</div>
      <div className="lock-corner tr">
        {clock.toISOString().slice(0, 19).replace('T', ' ')} UTC · NODE {sid}
      </div>

      <div className="lock-center">
        <div className="lock-emblem" style={{ '--emblem': `url(${emblem})` } as CSSProperties}>
          <img src={emblem} alt="Novus Ordo emblem" draggable={false} />
          <span className="shine" />
        </div>
        <div className="lock-title">WELCOME TO NOVUS ORDO</div>
        <div className="lock-sub">a construction by Quincy Gininda</div>
        <div className="lock-motto">Classified order-flow terminal · Eyes only · Every session sealed</div>
      </div>

      {step === 'wait' && (
        <div className="lock-key">
          <div className="lock-msg">CHECKING THIS COPY…</div>
        </div>
      )}
      {step === 'license' && <LicenseStep gate={gate!} onDone={setGate} />}
      {step === 'terms' && <TermsStep onDone={() => void gateNow().then(setGate)} />}
      {step === 'setup' && <SetupStep onDone={granted} />}
      {step === 'unlock' && (
      <form
        className={`lock-key ${msg?.kind ?? ''}`}
        key={shake}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="ledger-key">ENTER LEDGER KEY</label>
        <div className="pin" onClick={() => input.current?.focus()}>
          {Array.from({ length: LEDGER_LENGTH }, (_, i) => (
            <span key={i} className={`cell ${i < code.length ? 'filled' : ''} ${i === code.length ? 'caret' : ''}`}>
              {i < code.length ? '•' : ''}
            </span>
          ))}
          <input
            id="ledger-key"
            ref={input}
            className="pin-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            maxLength={LEDGER_LENGTH + 4}
            value={code}
            aria-label="Ledger key"
            onChange={(e) => {
              const d = normalizeKey(e.target.value).slice(0, LEDGER_LENGTH);
              setCode(d);
              if (msg?.kind === 'denied') setMsg(null);
              if (d.length === LEDGER_LENGTH) void submit(d);
            }}
          />
        </div>
        <div className="lock-msg" role="status">
          {msg?.text ?? ' '}
        </div>
      </form>
      )}

      <div className="lock-corner bl">
        BUILD 1.0.0 · {desktop ? 'DESKTOP' : 'BROWSER'} · {navigator.platform || 'node'}
        {safeMode && ' · SAFE MODE (NO GPU)'}
      </div>
      <div className="lock-loader" aria-live="polite">
        <div className="now">
          {done ? (
            <>
              <b>ALL SYSTEMS READY</b> — {step === 'license' ? 'awaiting licence' : step === 'terms' ? 'awaiting your agreement' : step === 'setup' ? 'create your ledger key' : 'awaiting ledger key'}
            </>
          ) : current ? (
            <>
              <span className="spin" /> LOADING <b>{current.label}</b> <span className="dim">{current.detail}</span>
            </>
          ) : (
            'INITIALISING…'
          )}
        </div>
        <div className="bar">
          <div style={{ width: `${pct}%` }} />
        </div>
        <ul>
          {steps.slice(-7).map((s) => (
            <li key={s.id} className={s.state}>
              <span className="tag">{s.state === 'done' ? '[ OK ]' : s.state === 'warn' ? '[WARN]' : '[ .. ]'}</span> {s.label} <span className="dim">— {s.detail}</span>
              {s.ms !== undefined && <span className="ms">{s.ms} ms</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------- first launch of a commercial copy ----------

/** eight PIN cells over a hidden input (the same as the ledger key's) */
function Pin({ value, onChange, label, autoFocus, inputRef }: { value: string; onChange: (v: string) => void; label: string; autoFocus?: boolean; inputRef: React.RefObject<HTMLInputElement | null> }) {
  return (
    <div className="pin" onClick={() => inputRef.current?.focus()}>
      {Array.from({ length: LEDGER_LENGTH }, (_, i) => (
        <span key={i} className={`cell ${i < value.length ? 'filled' : ''} ${i === value.length ? 'caret' : ''}`}>
          {i < value.length ? '•' : ''}
        </span>
      ))}
      <input ref={inputRef} className="pin-input" type="password" inputMode="numeric" autoComplete="off" autoFocus={autoFocus} maxLength={LEDGER_LENGTH + 4} value={value} aria-label={label} onChange={(e) => onChange(normalizeKey(e.target.value).slice(0, LEDGER_LENGTH))} />
    </div>
  );
}

function LicenseStep({ gate, onDone }: { gate: AppGate; onDone: (g: AppGate) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const L = gate.license;
  const go = async () => {
    if (!desktop || busy) return;
    setBusy(true);
    setErr('');
    try {
      onDone(await desktop.app.activate(key));
    } catch (e) {
      setErr(String((e as Error).message ?? e).replace(/^Error:\s*/, ''));
    }
    setBusy(false);
  };
  return (
    <form
      className={`lock-key lock-first ${err ? 'denied' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <label htmlFor="license-key">ACTIVATE YOUR LICENCE</label>
      <p className="lock-first-text">
        {L?.reason === 'revoked' || L?.reason === 'offline'
          ? L.message
          : 'Enter the licence key from your Gumroad receipt (it is also in your Gumroad library). One licence runs on up to three of your computers.'}
      </p>
      <input id="license-key" className="lock-license mono" value={key} autoFocus spellCheck={false} autoComplete="off" placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX" onChange={(e) => setKey(e.target.value)} aria-label="Licence key" />
      <button className="lock-btn" type="submit" disabled={busy || key.trim().length < 16}>
        {busy ? 'CHECKING WITH GUMROAD…' : L?.reason === 'offline' ? 'CHECK AGAIN' : 'ACTIVATE'}
      </button>
      <div className="lock-msg lock-msg-wrap" role="status">
        {err || ' '}
      </div>
    </form>
  );
}

function TermsStep({ onDone }: { onDone: () => void }) {
  const [read, setRead] = useState(false);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState('');
  return (
    <div className="lock-key lock-first lock-terms-step">
      <label>{TERMS_TITLE.toUpperCase()}</label>
      <div
        className="lock-terms"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setRead(true);
        }}
      >
        {TERMS.map((t) => (
          <section key={t.h}>
            <b>{t.h}</b>
            {t.p.map((x, i) => (
              <p key={i}>{x}</p>
            ))}
          </section>
        ))}
      </div>
      <label className="lock-check">
        <input type="checkbox" checked={ok} disabled={!read} onChange={(e) => setOk(e.target.checked)} /> I have read the licence agreement and the risk disclosure, and I accept them
      </label>
      <button
        className="lock-btn"
        disabled={!ok}
        onClick={() =>
          acceptTerms()
            .then(onDone)
            .catch((e) => setErr(String((e as Error).message ?? e)))
        }
      >
        {read ? 'ACCEPT AND CONTINUE' : 'SCROLL TO THE END TO ACCEPT'}
      </button>
      <div className="lock-msg lock-msg-wrap">{err || ' '}</div>
    </div>
  );
}

function SetupStep({ onDone }: { onDone: () => void }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const second = useRef<HTMLInputElement>(null);
  const done = async (bb: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await setupKey(a, bb);
      onDone();
    } catch (e) {
      setErr(
        String((e as Error).message ?? e)
          .replace(/^Error:\s*/, '')
          .replace(/^Choose another key: /i, 'CHOOSE ANOTHER KEY — ')
          .toUpperCase(),
      );
      setA('');
      setB('');
      setTimeout(() => first.current?.focus(), 0);
    }
    setBusy(false);
  };
  return (
    <form className={`lock-key lock-first ${err ? 'denied' : ''}`} onSubmit={(e) => e.preventDefault()}>
      <label>CREATE YOUR LEDGER KEY</label>
      <p className="lock-first-text">Choose eight digits. They unlock this terminal and protect the exchange keys you will keep in it — no one else has them, and they cannot be recovered, so keep them somewhere safe.</p>
      <Pin
        value={a}
        label="New ledger key"
        autoFocus
        inputRef={first}
        onChange={(v) => {
          setA(v);
          setErr('');
          if (v.length === LEDGER_LENGTH) setTimeout(() => second.current?.focus(), 0);
        }}
      />
      <label>ENTER IT AGAIN</label>
      <Pin
        value={b}
        label="Repeat the ledger key"
        inputRef={second}
        onChange={(v) => {
          setB(v);
          setErr('');
          if (v.length === LEDGER_LENGTH && a.length === LEDGER_LENGTH) void done(v);
        }}
      />
      <div className="lock-msg lock-msg-wrap" role="status">
        {busy ? 'SEALING…' : err || ' '}
      </div>
    </form>
  );
}
