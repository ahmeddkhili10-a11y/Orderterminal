// Hyperliquid specifics: the account is a wallet; the terminal trades through
// an API wallet ("agent") the owner approves once on hyperliquid.xyz → API.
// An agent can trade but never withdraw. The terminal refuses the main
// wallet's own key (which can withdraw everything) and, in the key test,
// checks that the agent is approved for the account it is saved with.

export const HL = 'hyperliquid';
/** entries: a market order fills at most this far from the price; closes and stops keep Hyperliquid's 5 % so they always fill */
export const HL_ENTRY_SLIPPAGE = '0.02';

const norm = (a) => String(a ?? '').trim().toLowerCase();
const short = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;
export const isEvmAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a ?? '').trim());

export const SAME_WALLET =
  'The wallet address and the private key belong to the same wallet. Wallet address must be your MAIN account (the one you deposit USDC with); the private key must be an API wallet’s (hyperliquid.xyz → More → API → Generate, then Authorize) — never your main wallet’s key, which can withdraw everything.';

/**
 * Refuse a key that is the account's own key (or an account field holding the
 * API wallet's address). `agent` is the address derived from the private key.
 */
export function assertAgentKey(account, agent) {
  if (!isEvmAddress(account)) throw new Error('Hyperliquid: the wallet address must be your main account address — 0x followed by 40 characters');
  if (norm(account) === norm(agent)) throw new Error(`Hyperliquid: ${SAME_WALLET}`);
}

/**
 * What the key test says about a Hyperliquid key.
 * @param o.account the saved wallet (main account) address
 * @param o.agent the address of the saved private key
 * @param o.agents extraAgents for the account ([{ name, address, validUntil }]), or null if it could not be read
 * @param o.role userRole of the agent ({ role, data: { user } }), or null if it could not be read
 * @returns {{ ok: boolean | null, text: string }[]}
 */
export function hyperliquidKeyChecks({ account, agent, agents, role, now = Date.now() }) {
  if (norm(account) === norm(agent)) {
    if (role?.role === 'agent' && role.data?.user) return [{ ok: false, text: `The wallet address is the API wallet’s own address. Put your main account address instead: ${role.data.user}` }];
    return [{ ok: false, text: SAME_WALLET }];
  }
  const listed = Array.isArray(agents) ? agents.find((x) => norm(x.address) === norm(agent)) : undefined;
  const roleOk = role?.role === 'agent' && norm(role.data?.user) === norm(account);
  if (listed || roleOk) {
    const until = Number(listed?.validUntil) || 0;
    const days = until ? (until - now) / 86_400_000 : Infinity;
    const out = [{ ok: true, text: `API wallet ${short(agent)} is approved to trade for ${short(account)} — it can trade, never withdraw` }];
    if (until && days <= 0) return [{ ok: false, text: `API wallet ${short(agent)} expired on ${new Date(until).toISOString().slice(0, 10)} — generate and authorize a new one on hyperliquid.xyz → API` }];
    if (days < 14) out.push({ ok: null, text: `it expires on ${new Date(until).toISOString().slice(0, 10)} — generate a new one before then` });
    return out;
  }
  if (role?.role === 'agent' && role.data?.user) return [{ ok: false, text: `API wallet ${short(agent)} is approved for a different account (${role.data.user}) — save that address as the wallet address` }];
  if (agents === null && role === null) return [{ ok: null, text: 'Could not confirm the API wallet is approved (Hyperliquid did not answer) — test again in a minute' }];
  return [
    {
      ok: false,
      text: `API wallet ${short(agent)} is not approved for ${short(account)} — on hyperliquid.xyz → More → API: Generate, then Authorize it (your wallet asks you to sign). Check the wallet address is your main account, not the API wallet’s. An account with no funds yet cannot approve API wallets: deposit first.`,
    },
  ];
}

/** Market orders on Hyperliquid carry a worst price; entries get a tighter one than closes and stops. */
export function hyperliquidOrder(o, refPrice) {
  if (o.type !== 'market' || o.price !== undefined) return o;
  const trigger = o.params?.triggerPrice;
  const price = trigger ?? refPrice;
  if (!(price > 0)) throw new Error('Hyperliquid: no price to cap the market order with yet');
  const params = { ...o.params };
  if (!params.reduceOnly && trigger === undefined) params.slippage = HL_ENTRY_SLIPPAGE;
  return { ...o, price, params };
}

/** Leverage within the coin's cap on Hyperliquid (it refuses more). */
export function capLeverage(lev, market) {
  const max = Number(market?.limits?.leverage?.max);
  return max > 0 ? Math.min(lev, max) : lev;
}
