// The database's heavy work, on a thread of its own so the app's main process
// never stalls on it: deleting old recorded trades (in small chunks), reading
// a market's history for the charts (as typed columns, a page at a time), and
// keeping the write-ahead log small. It opens its own connections; the main
// process keeps one for the small, quick reads and writes.
import { parentPort } from 'node:worker_threads';
import { openConnection, pruneChunked, readColumnsFromFile, recordChunked } from './db.mjs';

/** typed arrays in shared memory, copied into plain buffers that can be handed over (and sent on to a window) */
function plain(cols) {
  const out = {};
  const transfer = [];
  for (const k of ['t', 'p', 'q', 's']) {
    const a = new cols[k].constructor(cols[k].length);
    a.set(cols[k]);
    out[k] = a;
    transfer.push(a.buffer);
  }
  return { out, transfer };
}

parentPort.on('message', async (m) => {
  try {
    if (m.type === 'columns') {
      const cols = await readColumnsFromFile(m.file, m.venue, m.symbol, m.from, m.to, m.limit);
      const { out, transfer } = plain(cols);
      parentPort.postMessage({ id: m.id, cols: out }, transfer);
      return;
    }
    if (m.type === 'prune') {
      const sql = openConnection(m.file);
      try {
        const deleted = await pruneChunked(sql, m.olderThan, { skip: m.skip ?? [] });
        // fold the log back into the database and shrink it, without waiting on readers
        sql.exec('PRAGMA wal_checkpoint(PASSIVE);');
        parentPort.postMessage({ id: m.id, deleted });
      } finally {
        sql.close();
      }
      return;
    }
    if (m.type === 'record') {
      const sql = openConnection(m.file);
      try {
        parentPort.postMessage({ id: m.id, n: await recordChunked(sql, m.venue, m.symbol, m.rows) });
      } finally {
        sql.close();
      }
      return;
    }
    if (m.type === 'checkpoint') {
      const sql = openConnection(m.file);
      try {
        sql.exec('PRAGMA wal_checkpoint(PASSIVE);');
      } finally {
        sql.close();
      }
      parentPort.postMessage({ id: m.id, ok: true });
      return;
    }
    parentPort.postMessage({ id: m.id, error: `unknown task ${m.type}` });
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: String(e?.message ?? e) });
  }
});
