// Backups: your whole setup in one password-protected file, to keep somewhere
// safe and restore on this or another computer.
//
// In it: your keys (exchanges, Telegram, wallets — the vault on this computer
// is locked to this computer, so they are re-encrypted with your backup
// password), your settings and layouts, the Strategy Lab (its research, the
// strategies you deployed, the edge finder's survivors and progress), the
// crypto swarm's book and what its forest learned, the trade journal, the bots
// and their trade log. Not in it: the recorded tick history and downloaded
// candles (they come back from the exchanges).
//
// The file is compressed and encrypted with AES-256-GCM under a key made from
// your password with scrypt; without the password it cannot be read — keep the
// password somewhere safe too, because nobody can recover it.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

export const BACKUP_FORMAT = 'novus-ordo-backup';
export const MIN_PASSWORD = 10;
const KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
/** database entries that belong to one computer or one session, never carried over */
const LOCAL_KEYS = new Set(['tradeStatsReady', 'care:lastSeen', 'license', 'safeMode']);

export function passwordProblem(pw) {
  const p = String(pw ?? '');
  if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters for the backup password.`;
  if (/^(.)\1+$/.test(p) || /^(0123456789|1234567890|password|qwerty)/i.test(p)) return 'That password is too easy to guess — choose another.';
  return null;
}

/** encrypt a backup's contents with a password */
export function sealBackup(contents, password, meta = {}) {
  const why = passwordProblem(password);
  if (why) throw new Error(why);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(String(password), salt, 32, KDF);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const head = { format: BACKUP_FORMAT, v: 1, created: meta.created ?? Date.now(), app: meta.app ?? null, summary: meta.summary ?? null };
  c.setAAD(Buffer.from(JSON.stringify(head)));
  const data = Buffer.concat([c.update(gzipSync(Buffer.from(JSON.stringify(contents)))), c.final()]);
  return JSON.stringify({ ...head, kdf: { name: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') }, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
}

/** what a backup file says about itself, without the password */
export function peekBackup(text) {
  let f;
  try {
    f = JSON.parse(String(text));
  } catch {
    throw new Error('This is not a Novus Ordo backup file.');
  }
  if (f?.format !== BACKUP_FORMAT || !f.data) throw new Error('This is not a Novus Ordo backup file.');
  if (f.v !== 1) throw new Error('This backup was made by a newer version of Novus Ordo — update first.');
  return { created: f.created, app: f.app, summary: f.summary };
}

/** decrypt a backup (a wrong password, or a changed file, is refused) */
export function openBackup(text, password) {
  peekBackup(text);
  const f = JSON.parse(String(text));
  const head = { format: f.format, v: f.v, created: f.created, app: f.app, summary: f.summary };
  const N = Number(f.kdf?.N);
  if (!(N >= 2 ** 14 && N <= 2 ** 17) || !(f.kdf.r >= 1 && f.kdf.r <= 16) || !(f.kdf.p >= 1 && f.kdf.p <= 4)) throw new Error('This backup file is damaged.');
  const key = scryptSync(String(password ?? ''), Buffer.from(f.kdf.salt, 'base64'), 32, { N, r: f.kdf.r, p: f.kdf.p, maxmem: 256 * 1024 * 1024 });
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'));
    d.setAAD(Buffer.from(JSON.stringify(head)));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]);
    return { head, contents: JSON.parse(gunzipSync(plain).toString('utf8')) };
  } catch {
    throw new Error('Wrong password (or the backup file was changed).');
  }
}

/**
 * Gather everything for a backup.
 * @param o {{ sql: import('node:sqlite').DatabaseSync, vault: { list(): any[], reveal(id: string): any }, journal, labFiles: Record<string, unknown>, storage: Record<string, string> }}
 */
export function collectBackup(o) {
  const kv = {};
  for (const r of o.sql.prepare('SELECT k, v FROM kv').all()) if (!LOCAL_KEYS.has(r.k)) kv[r.k] = r.v;
  const secrets = o.vault.list().map((s) => {
    const r = o.vault.reveal(s.id);
    return { id: s.id, label: r.label, kind: r.kind, exchange: r.exchange, fields: r.fields };
  });
  const table = (name, limit = 1_000_000) => {
    try {
      return o.sql.prepare(`SELECT * FROM ${name} ORDER BY rowid DESC LIMIT ?`).all(limit).reverse().map((x) => ({ ...x }));
    } catch {
      return [];
    }
  };
  const contents = {
    kv,
    secrets,
    wallets: table('wallets'),
    amtTrades: table('amt_trades'),
    ordersLog: table('orders_log', 5000),
    journal: o.journal.dump(),
    lab: o.labFiles ?? {},
    storage: o.storage ?? {},
  };
  const summary = { keys: secrets.length, trades: contents.journal.length, strategies: Array.isArray(o.labFiles?.['deployed.json']) ? o.labFiles['deployed.json'].length : 0, settings: Object.keys(contents.storage).length };
  return { contents, summary };
}

/**
 * Put a backup back. Keys go into this computer's vault (encrypted for this
 * computer again); database entries, tables and Lab files are replaced; the
 * window's settings are returned for the window to write.
 */
export function restoreBackup(contents, o) {
  const c = contents ?? {};
  const put = o.sql.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
  let kv = 0;
  for (const [k, v] of Object.entries(c.kv ?? {})) {
    if (LOCAL_KEYS.has(k) || typeof v !== 'string') continue;
    put.run(k, v);
    kv++;
  }
  let keys = 0;
  for (const s of c.secrets ?? []) {
    if (!s?.kind || !s.fields || typeof s.fields !== 'object') continue;
    o.vault.save({ id: s.id, label: s.label, kind: s.kind, exchange: s.exchange ?? null, fields: Object.fromEntries(Object.entries(s.fields).map(([k, v]) => [k, String(v)])) });
    keys++;
  }
  const insertAll = (name, rows, cols) => {
    if (!rows?.length) return 0;
    const ins = o.sql.prepare(`INSERT OR IGNORE INTO ${name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    let n = 0;
    for (const r of rows) n += Number(ins.run(...cols.map((k) => (r[k] === undefined ? null : r[k]))).changes);
    return n;
  };
  insertAll('wallets', c.wallets, ['address', 'chain', 'label', 'verified', 'connected_at']);
  // the bots' trade log: rows already here (the same bot, the same close) are not doubled
  const have = new Set(o.sql.prepare('SELECT bot_id, closed FROM amt_trades').all().map((r) => `${r.bot_id}:${r.closed}`));
  insertAll('amt_trades', (c.amtTrades ?? []).filter((r) => !have.has(`${r.bot_id}:${r.closed}`)), ['bot_id', 'bot_name', 'symbol', 'mode', 'setup', 'side', 'entry', 'exit', 'qty', 'pnl', 'fees', 'opened', 'closed', 'reason']);
  const trades = o.journal.restore(c.journal ?? []);
  let files = 0;
  for (const [name, v] of Object.entries(c.lab ?? {})) {
    if (!/^[a-z][a-z0-9-]*\.json$/i.test(name)) continue;
    o.writeLab(name, v);
    files++;
  }
  return { kv, keys, trades, files, storage: c.storage ?? {} };
}
