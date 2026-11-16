// Crash reports. Novus Ordo leaves a small marker file while it runs and
// removes it when it closes properly; a marker found at start means the last
// session ended without closing — a crash, a power cut, Windows restarting.
// That, and the last errors in the log, are sent to Telegram once the terminal
// is unlocked, so a problem can be fixed from what really happened.
import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FLAG = 'running.json';

/** mark this session as running; returns the previous session's marker when it did not close properly */
export function markRunning(dir, now = Date.now()) {
  const f = join(dir, FLAG);
  let prev = null;
  try {
    if (existsSync(f)) prev = JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    prev = { t: 0 };
  }
  try {
    writeFileSync(f, JSON.stringify({ t: now, pid: process.pid }));
  } catch {
    /* a read-only folder: no crash reports */
  }
  return prev;
}

/** the session closed properly */
export function markStopped(dir) {
  try {
    rmSync(join(dir, FLAG), { force: true });
  } catch {
    /* nothing to do */
  }
}

/** the last errors in a log file (its last 96 KB), tidied for a message: no request signatures, no long keys or addresses */
export function lastErrors(file, max = 6) {
  if (!file || !existsSync(file)) return [];
  let text = '';
  try {
    const size = statSync(file).size;
    const n = Math.min(size, 96 * 1024);
    const buf = Buffer.alloc(n);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buf, 0, n, size - n);
    } finally {
      closeSync(fd);
    }
    text = buf.toString('utf8');
  } catch {
    return [];
  }
  return tidyErrors(text, max);
}

export function tidyErrors(text, max = 6) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^(\S+) \+\S+ ERROR (.*)$/.exec(line);
    if (!m) continue;
    const msg = m[2]
      .replace(/(https?:\/\/[^\s?]+)\?\S+/g, '$1')
      .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,}\b/g, '…')
      .replace(/\b(0x)?[0-9a-fA-F]{32,}\b/g, '…')
      .slice(0, 180);
    out.push({ t: Date.parse(m[1]) || 0, msg });
  }
  // the same error over and over is one line
  const seen = new Set();
  return out
    .reverse()
    .filter((x) => !seen.has(x.msg) && seen.add(x.msg))
    .slice(0, max)
    .reverse();
}

const when = (t) => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** before the ledger key: a fixed message, nothing private in it */
export function wakeText({ unclean, offSince }) {
  return `🔒 <b>Novus Ordo has started again and is waiting for your ledger key.</b>\n${unclean ? 'The last session did not close properly (a crash, a power cut or Windows restarting)' : 'It was closed'}${offSince ? ` — last seen ${when(offSince)}` : ''}.\nNothing trades until it is unlocked. Once you enter the key, the crypto swarm picks up where it left off by itself.`;
}

/** after the ledger key: what happened, with the last errors from the log */
export function crashText({ lastSeen, errors }) {
  const L = [`💥 <b>Novus Ordo closed unexpectedly last time</b>${lastSeen ? ` (last seen ${when(lastSeen)})` : ''}.`];
  if (errors.length) {
    L.push('The last errors in its log:');
    for (const x of errors) L.push(`• <code>${x.msg.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])}</code>`);
  } else L.push('Nothing was logged before it stopped — most likely a power cut, Windows restarting or the computer sleeping, not a fault in Novus Ordo.');
  L.push('<i>Forward this to whoever looks after Novus Ordo if it keeps happening.</i>');
  return L.join('\n');
}
