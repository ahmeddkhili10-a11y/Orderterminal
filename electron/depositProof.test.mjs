import { describe, expect, it } from 'vitest';
import { DepositVerifier, EXCHANGE_LAMPORTS, proofAmount, proofSol, PROOF_TTL_MS, SYSTEM_PROGRAM, transfersTo } from './depositProof.mjs';

const ME = 'SwarmWa11et111111111111111111111111111111111';
const PHANTOM = 'Phant0mHome11111111111111111111111111111111';
const transfer = (source, destination, lamports) => ({ program: 'system', parsed: { type: 'transfer', info: { source, destination, lamports } } });
const tx = (ixs, inner = []) => ({ transaction: { message: { instructions: ixs } }, meta: { err: null, innerInstructions: inner.length ? [{ instructions: inner }] : [] } });

function chain({ txs, owner = SYSTEM_PROGRAM, lamports = 2e9, blockTime }) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push(method);
    if (method === 'getSignaturesForAddress') return Object.keys(txs).map((signature) => ({ signature, err: null, blockTime }));
    if (method === 'getTransaction') return txs[params[0]] ?? null;
    if (method === 'getAccountInfo') return { value: { owner, lamports, executable: false } };
    throw new Error(method);
  };
  return { rpc, calls };
}

describe('Phantom verified by a deposit from the phone', () => {
  it('asks for an odd amount between 0.001001 and 0.001999 SOL', () => {
    for (const r of [0, 0.1, 0.5, 0.999999]) {
      const l = proofAmount(() => r);
      expect(l).toBeGreaterThan(1_000_000);
      expect(l).toBeLessThan(2_000_000);
      expect((l - 1_000_000) % 100_000).not.toBe(0);
    }
    expect(proofSol(1_372_000)).toBe('0.001372');
  });

  it('reads plain SOL transfers into the wallet, inner ones too', () => {
    const t = tx([{ program: 'compute-budget' }, transfer(PHANTOM, ME, 1_372_000), transfer(PHANTOM, 'Other', 5)], [transfer('X', ME, 9)]);
    expect(transfersTo(t, ME)).toEqual([
      { source: PHANTOM, lamports: 1_372_000 },
      { source: 'X', lamports: 9 },
    ]);
  });

  it('the exact amount from a personal wallet proves it; another amount does not', async () => {
    const now = 1_800_000_000_000;
    const { rpc } = chain({ txs: { a: tx([transfer('Luno', ME, 50_000_000)]), b: tx([transfer(PHANTOM, ME, 1_372_000)]) }, blockTime: now / 1000 });
    const v = new DepositVerifier({ rpc, address: () => ME, now: () => now });
    expect(await v.poll()).toBeNull(); // nothing asked yet
    v.start(1_372_000);
    expect(await v.poll()).toEqual({ address: PHANTOM });
    expect(v.pending).toBeNull();
  });

  it('waits while the amount has not arrived, then expires after 30 minutes', async () => {
    let now = 1_800_000_000_000;
    const { rpc } = chain({ txs: { a: tx([transfer(PHANTOM, ME, 1_371_000)]) }, blockTime: now / 1000 });
    const v = new DepositVerifier({ rpc, address: () => ME, now: () => now });
    v.start(1_372_000);
    expect(await v.poll()).toBeNull();
    now += PROOF_TTL_MS + 1;
    expect(await v.poll()).toEqual({ expired: true });
  });

  it('ignores transfers from before it was asked', async () => {
    const now = 1_800_000_000_000;
    const { rpc } = chain({ txs: { a: tx([transfer(PHANTOM, ME, 1_372_000)]) }, blockTime: (now - 10 * 60_000) / 1000 });
    const v = new DepositVerifier({ rpc, address: () => ME, now: () => now });
    v.start(1_372_000);
    expect(await v.poll()).toBeNull();
  });

  it('refuses an exchange wallet (sent from Luno by mistake) and program accounts', async () => {
    const now = 1_800_000_000_000;
    const ex = new DepositVerifier({ rpc: chain({ txs: { a: tx([transfer('LunoHot', ME, 1_372_000)]) }, lamports: EXCHANGE_LAMPORTS + 1, blockTime: now / 1000 }).rpc, address: () => ME, now: () => now });
    ex.start(1_372_000);
    expect((await ex.poll()).refused).toMatch(/exchange's wallet, not your Phantom/);
    const prog = new DepositVerifier({ rpc: chain({ txs: { a: tx([transfer('Pda', ME, 1_372_000)]) }, owner: 'SomeProgram', blockTime: now / 1000 }).rpc, address: () => ME, now: () => now });
    prog.start(1_372_000);
    expect((await prog.poll()).refused).toMatch(/not a personal wallet/);
  });

  it('looks again at a transaction the RPC could not return yet', async () => {
    const now = 1_800_000_000_000;
    const txs = { a: null };
    const { rpc } = chain({ txs, blockTime: now / 1000 });
    const v = new DepositVerifier({ rpc, address: () => ME, now: () => now });
    v.start(1_372_000);
    expect(await v.poll()).toBeNull();
    txs.a = tx([transfer(PHANTOM, ME, 1_372_000)]);
    expect(await v.poll()).toEqual({ address: PHANTOM });
  });
});
