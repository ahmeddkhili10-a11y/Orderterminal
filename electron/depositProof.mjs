// Verifying the owner's Phantom wallet from a phone: instead of signing a
// message in a browser extension, the owner sends a small, exact amount of SOL
// from Phantom to the swarm wallet. Only the holder of that wallet's key can
// sign the transfer, so the address it came from is proven to be theirs.
// The verification is started on the computer (where the app asks to confirm),
// expires after 30 minutes, and refuses exchange-sized and program accounts.

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const PROOF_TTL_MS = 30 * 60_000;
/** an account holding more than this is an exchange's hot wallet, not a personal Phantom */
export const EXCHANGE_LAMPORTS = 5_000 * 1e9;

/** 0.001001–0.001999 SOL, never a round 0.0011, 0.0012…: lamports */
export function proofAmount(rand = Math.random) {
  let k = 1 + Math.floor(rand() * 998);
  if (k % 100 === 0) k += 1;
  return 1_000_000 + k * 1_000;
}

export const proofSol = (lamports) => (lamports / 1e9).toFixed(6);

/** Plain SOL transfers into `dest` in a jsonParsed transaction (top level and inner). */
export function transfersTo(tx, dest) {
  const top = tx?.transaction?.message?.instructions ?? [];
  const inner = (tx?.meta?.innerInstructions ?? []).flatMap((g) => g.instructions ?? []);
  const out = [];
  for (const ix of [...top, ...inner]) {
    if (ix?.program !== 'system' || ix.parsed?.type !== 'transfer') continue;
    const info = ix.parsed.info ?? {};
    if (info.destination === dest && typeof info.source === 'string') out.push({ source: info.source, lamports: Number(info.lamports) });
  }
  return out;
}

/**
 * Watches the swarm wallet for the proof transfer.
 * @param o.rpc (method, params) => result — JSON-RPC
 * @param o.address () => the swarm wallet's address
 * @param o.now () => ms
 */
export class DepositVerifier {
  constructor({ rpc, address, now = Date.now }) {
    this.rpc = rpc;
    this.address = address;
    this.now = now;
    this.pending = null;
    this.seen = new Set();
  }

  start(lamports) {
    const at = this.now();
    this.pending = { lamports, since: at, until: at + PROOF_TTL_MS };
    this.seen.clear();
    return this.pending;
  }

  cancel() {
    this.pending = null;
  }

  /**
   * One look at the wallet's latest transactions.
   * @returns {Promise<{ address: string } | { expired: true } | { refused: string } | null>}
   */
  async poll() {
    const p = this.pending;
    if (!p) return null;
    if (this.now() > p.until) {
      this.pending = null;
      return { expired: true };
    }
    const me = this.address();
    const sigs = (await this.rpc('getSignaturesForAddress', [me, { limit: 25, commitment: 'confirmed' }])) ?? [];
    for (const s of sigs) {
      if (s.err || this.seen.has(s.signature)) continue;
      // older than the request (with two minutes for clocks): not the proof
      if (s.blockTime && s.blockTime * 1000 < p.since - 120_000) continue;
      const tx = await this.rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      if (!tx) continue; // not available yet: look again next time
      this.seen.add(s.signature);
      if (tx.meta?.err) continue;
      for (const t of transfersTo(tx, me)) {
        if (t.lamports !== p.lamports || t.source === me) continue;
        const acct = (await this.rpc('getAccountInfo', [t.source, { encoding: 'base64', commitment: 'confirmed' }]))?.value;
        if (!acct || acct.owner !== SYSTEM_PROGRAM || acct.executable) {
          this.pending = null;
          return { refused: `${t.source} is not a personal wallet` };
        }
        if (Number(acct.lamports) > EXCHANGE_LAMPORTS) {
          this.pending = null;
          return { refused: `${t.source} holds more than ${EXCHANGE_LAMPORTS / 1e9} SOL — that is an exchange's wallet, not your Phantom. Send the amount from Phantom.` };
        }
        this.pending = null;
        return { address: t.source };
      }
    }
    return null;
  }
}
