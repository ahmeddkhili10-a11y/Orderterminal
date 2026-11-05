import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ccxt from 'ccxt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CcxtService } from './ccxt-service.mjs';
import { Db } from './db.mjs';
import { assertAgentKey, capLeverage, HL_ENTRY_SLIPPAGE, hyperliquidKeyChecks, hyperliquidOrder } from './hyperliquid.mjs';
import { exchangeQuirks } from './trading.mjs';
import { Vault } from './vault.mjs';

const MAIN = '0x1111111111111111111111111111111111111111';
const AGENT = '0x2222222222222222222222222222222222222222';
// the well-known address of private key 1 (a test value, never a real wallet)
const KEY1 = '0x' + '0'.repeat(63) + '1';
const KEY1_ADDR = '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf';

describe('Hyperliquid keys', () => {
  it('derives the API wallet address from its private key', () => {
    expect(new ccxt.hyperliquid().ethGetAddressFromPrivateKey(KEY1).toLowerCase()).toBe(KEY1_ADDR);
  });

  it('refuses the main wallet’s own key, and an account field holding the API wallet’s address', () => {
    expect(() => assertAgentKey(MAIN, AGENT)).not.toThrow();
    expect(() => assertAgentKey(KEY1_ADDR, KEY1_ADDR)).toThrow(/same wallet.*never your main wallet’s key/);
    expect(() => assertAgentKey(MAIN.toUpperCase().replace('0X', '0x'), MAIN)).toThrow(/same wallet/);
    expect(() => assertAgentKey('not-an-address', AGENT)).toThrow(/0x followed by 40 characters/);
  });

  it('the key test says whether the API wallet is approved for the account', () => {
    const now = Date.UTC(2026, 10, 5);
    const ok = hyperliquidKeyChecks({ account: MAIN, agent: AGENT, agents: [{ name: 'Novus Ordo', address: AGENT, validUntil: now + 90 * 86_400_000 }], role: { role: 'agent', data: { user: MAIN } }, now });
    expect(ok).toEqual([{ ok: true, text: expect.stringMatching(/approved to trade.*never withdraw/) }]);
    // approved through its role even when unnamed
    expect(hyperliquidKeyChecks({ account: MAIN, agent: AGENT, agents: [], role: { role: 'agent', data: { user: MAIN } }, now })[0].ok).toBe(true);
    // expiring soon, and expired
    expect(hyperliquidKeyChecks({ account: MAIN, agent: AGENT, agents: [{ address: AGENT, validUntil: now + 3 * 86_400_000 }], role: null, now })[1]).toMatchObject({ ok: null, text: expect.stringMatching(/expires on/) });
    expect(hyperliquidKeyChecks({ account: MAIN, agent: AGENT, agents: [{ address: AGENT, validUntil: now - 1 }], role: null, now })[0]).toMatchObject({ ok: false, text: expect.stringMatching(/expired/) });
    // not approved; approved for someone else; Hyperliquid silent
    expect(hyperliquidKeyChecks({ account: MAIN, agent: AGENT, agents: [], role: { role: 'missing' }, now })[0]).toMatchObject({ ok: false, text: expect.stringMatching(/not approved.*Authorize/) });
    expect(hyperliquidKeyChecks({ account: MAIN, agent: AGENT, agents: [], role: { role: 'agent', data: { user: '0x9999999999999999999999999999999999999999' } }, now })[0].text).toMatch(/different account/);
    expect(hyperliquidKeyChecks({ account: MAIN, agent: AGENT, agents: null, role: null, now })[0].ok).toBeNull();
    // the API wallet's address saved as the account
    expect(hyperliquidKeyChecks({ account: AGENT, agent: AGENT, agents: [], role: { role: 'agent', data: { user: MAIN } }, now })[0].text).toContain(MAIN);
  });
});

describe('Hyperliquid orders', () => {
  const market = { symbol: 'BTC/USDC:USDC', type: 'market', side: 'buy', amount: 0.001, price: undefined, params: {} };

  it('a market entry carries the price and at most 2 % slippage; closes and stops keep the 5 % default', () => {
    expect(hyperliquidOrder(market, 100_000)).toMatchObject({ price: 100_000, params: { slippage: HL_ENTRY_SLIPPAGE } });
    expect(hyperliquidOrder({ ...market, side: 'sell', params: { reduceOnly: true } }, 100_000)).toEqual({ ...market, side: 'sell', price: 100_000, params: { reduceOnly: true } });
    expect(hyperliquidOrder({ ...market, side: 'sell', params: { triggerPrice: 95_000, reduceOnly: true } }, 100_000)).toMatchObject({ price: 95_000, params: { triggerPrice: 95_000 } });
    const limit = { ...market, type: 'limit', price: 99_000 };
    expect(hyperliquidOrder(limit, 100_000)).toBe(limit);
    expect(() => hyperliquidOrder(market, undefined)).toThrow(/no price/);
    expect(exchangeQuirks('hyperliquid', market, 100_000).price).toBe(100_000);
  });

  it('keeps leverage under the coin’s cap', () => {
    expect(capLeverage(10, { limits: { leverage: { max: 5 } } })).toBe(5);
    expect(capLeverage(3, { limits: { leverage: { max: 40 } } })).toBe(3);
    expect(capLeverage(3, {})).toBe(3);
  });
});

describe('Hyperliquid through the CCXT service', () => {
  let dir;
  let db;
  let vault;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'novus-hl-'));
    db = new Db(join(dir, 't.sqlite'));
    vault = new Vault(db, { isEncryptionAvailable: () => false }, join(dir, 'vault.key'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeHl(info = {}) {
    const created = [];
    const leverage = [];
    const perp = { id: 'BTC', symbol: 'BTC/USDC:USDC', base: 'BTC', quote: 'USDC', settle: 'USDC', baseId: '0', type: 'swap', contract: true, linear: true, contractSize: 1, limits: { amount: {}, cost: { min: 10 }, leverage: { max: 40 } } };
    class Hyperliquid {
      constructor(cfg) {
        this.cfg = cfg;
        this.id = 'hyperliquid';
        this.name = 'Hyperliquid';
        this.has = { setLeverage: true, setMarginMode: true, fetchPositions: true };
        this.options = {};
        this.markets = { 'BTC/USDC:USDC': perp };
      }
      ethGetAddressFromPrivateKey(k) {
        return new ccxt.hyperliquid().ethGetAddressFromPrivateKey(k);
      }
      setSandboxMode() {}
      async loadMarkets() {
        return this.markets;
      }
      async fetchTicker() {
        return { last: 100_000, bid: 99_990, ask: 100_010 };
      }
      async fetchBalance() {
        return { total: { USDC: 30 }, free: { USDC: 30 } };
      }
      amountToPrecision(_s, x) {
        return String(Math.floor(x * 1e5) / 1e5);
      }
      priceToPrecision(_s, x) {
        return String(Math.round(x));
      }
      async setLeverage(lev, symbol, params) {
        leverage.push({ lev, symbol, params });
      }
      async publicPostInfo(req) {
        return info[req.type] ?? null;
      }
      async createOrder(symbol, type, side, amount, price, params) {
        created.push({ symbol, type, side, amount, price, params });
        return { id: `o${created.length}`, status: 'open' };
      }
    }
    return { lib: { hyperliquid: Hyperliquid, pro: {} }, created, leverage };
  }
  const save = (fields) => vault.save({ label: 'HL', kind: 'exchange', exchange: 'hyperliquid', fields: { trading: 'enabled', ...fields } });

  it('refuses to trade with the main wallet’s own key', async () => {
    const { lib, created } = fakeHl();
    const svc = new CcxtService(vault, { db, lib });
    const id = save({ walletAddress: KEY1_ADDR, privateKey: KEY1 });
    await expect(svc.placeOrder(id, { symbol: 'BTC/USDC:USDC', side: 'buy', type: 'market', sizeMode: 'quote', size: 20 })).rejects.toThrow(/same wallet/);
    expect(created).toHaveLength(0);
  });

  it('sends a market entry with its worst price, and sets isolated leverage within the coin’s cap', async () => {
    const { lib, created, leverage } = fakeHl();
    const svc = new CcxtService(vault, { db, lib });
    const id = save({ walletAddress: MAIN, privateKey: KEY1 });
    await svc.placeOrder(id, { symbol: 'BTC/USDC:USDC', side: 'buy', type: 'market', sizeMode: 'quote', size: 20, leverage: 60 });
    expect(leverage).toEqual([{ lev: 40, symbol: 'BTC/USDC:USDC', params: { marginMode: 'isolated' } }]);
    expect(created[0]).toMatchObject({ type: 'market', side: 'buy', price: 100_000, params: { slippage: HL_ENTRY_SLIPPAGE } });
    // under the $10 minimum
    await expect(svc.placeOrder(id, { symbol: 'BTC/USDC:USDC', side: 'buy', type: 'market', sizeMode: 'quote', size: 5 })).rejects.toThrow(/minimum order value is 10/);
  });

  it('the key test reports the API wallet approved for the account', async () => {
    const { lib } = fakeHl({ extraAgents: [{ name: 'Novus Ordo', address: KEY1_ADDR, validUntil: Date.now() + 100 * 86_400_000 }], userRole: { role: 'agent', data: { user: MAIN } } });
    const svc = new CcxtService(vault, { db, lib });
    const id = save({ walletAddress: MAIN, privateKey: KEY1 });
    const t = await svc.testKey(id);
    expect(t).toMatchObject({ ok: true, exchange: 'Hyperliquid', assets: 1 });
    expect(t.checks[0]).toMatchObject({ ok: true });
    const { lib: lib2 } = fakeHl({ extraAgents: [], userRole: { role: 'missing' } });
    const t2 = await new CcxtService(vault, { db, lib: lib2 }).testKey(id);
    expect(t2.ok).toBe(false);
    expect(t2.checks[0].text).toMatch(/not approved/);
  });
});
