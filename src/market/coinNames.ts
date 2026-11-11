// What people call coins, and the ticker the exchanges list them under —
// so the command line understands "ask about solana" as well as "ASK SOL".

/** what people call coins, to the ticker the exchanges use */
export const COIN_NAMES: Record<string, string> = {
  BITCOIN: 'BTC',
  XBT: 'BTC',
  ETHEREUM: 'ETH',
  ETHER: 'ETH',
  SOLANA: 'SOL',
  AVALANCHE: 'AVAX',
  RIPPLE: 'XRP',
  DOGECOIN: 'DOGE',
  DOGE: 'DOGE',
  CARDANO: 'ADA',
  CHAINLINK: 'LINK',
  POLKADOT: 'DOT',
  POLYGON: 'POL',
  MATIC: 'POL',
  LITECOIN: 'LTC',
  TRON: 'TRX',
  TONCOIN: 'TON',
  SHIBA: 'SHIB',
  SHIBAINU: 'SHIB',
  PEPE: 'PEPE',
  SUI: 'SUI',
  APTOS: 'APT',
  ARBITRUM: 'ARB',
  OPTIMISM: 'OP',
  NEAR: 'NEAR',
  COSMOS: 'ATOM',
  UNISWAP: 'UNI',
  AAVE: 'AAVE',
  STELLAR: 'XLM',
  HEDERA: 'HBAR',
  FILECOIN: 'FIL',
  INJECTIVE: 'INJ',
  RENDER: 'RENDER',
  HYPERLIQUID: 'HYPE',
  BINANCECOIN: 'BNB',
  BNB: 'BNB',
  MONERO: 'XMR',
  BITCOINCASH: 'BCH',
  ETHEREUMCLASSIC: 'ETC',
  WORLDCOIN: 'WLD',
  CELESTIA: 'TIA',
  SEI: 'SEI',
  JUPITER: 'JUP',
  BONK: 'BONK',
  DOGWIFHAT: 'WIF',
  ALGORAND: 'ALGO',
  KASPA: 'KAS',
  ONDO: 'ONDO',
  ENA: 'ENA',
  ETHENA: 'ENA',
};

/** "solana" → SOL; a ticker stays itself */
export const coinOf = (word: string): string => {
  const w = word.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return COIN_NAMES[w] ?? w;
};

/** the names a coin goes by in headlines, for matching the news */
export function namesOf(coin: string): string[] {
  const c = coin.toUpperCase();
  return [c, ...Object.keys(COIN_NAMES).filter((k) => COIN_NAMES[k] === c && k !== c && k.length > 3)];
}
