// Exposes a narrow, typed bridge to the renderer as window.novus.
// Every call returns the value or throws the main-process error message.
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const ccxtListeners = new Set();
const fsListeners = new Set();
const sealListeners = new Set();
ipcRenderer.on('app:sealed', (_e, reason) => sealListeners.forEach((fn) => fn(reason)));
ipcRenderer.on('app:fullscreen', (_e, on) => fsListeners.forEach((fn) => fn(on)));
const amtListeners = { status: new Set(), event: new Set(), train: new Set() };
for (const ch of ['status', 'event', 'train']) ipcRenderer.on(`amt:${ch}`, (_e, msg) => amtListeners[ch].forEach((fn) => fn(msg)));
const listen = (set, fn) => {
  set.add(fn);
  return () => set.delete(fn);
};
const verifiedListeners = new Set();
const cswarmListeners = { state: new Set(), event: new Set() };
const labListeners = { state: new Set(), event: new Set() };
const screenListeners = new Set();
ipcRenderer.on('screens:changed', (_e, msg) => screenListeners.forEach((fn) => fn(msg)));
for (const ch of ['state', 'event']) ipcRenderer.on(`lab:${ch}`, (_e, msg) => labListeners[ch].forEach((fn) => fn(msg)));
for (const ch of ['state', 'event']) ipcRenderer.on(`cswarm:${ch}`, (_e, msg) => cswarmListeners[ch].forEach((fn) => fn(msg)));
ipcRenderer.on('swarm:verified', (_e, msg) => verifiedListeners.forEach((fn) => fn(msg)));
ipcRenderer.on('ccxt:event', (_e, msg) => {
  for (const fn of ccxtListeners) fn(msg);
});

contextBridge.exposeInMainWorld('novus', {
  desktop: true,
  app: { info: () => call('app:info'), openExternal: (url) => call('shell:open', url), locked: () => call('app:locked'), unlock: (code) => call('app:unlock', code), seal: () => call('app:seal'), changeKey: (current, next) => call('app:changeKey', current, next), leaveSafeMode: () => call('app:leaveSafeMode'),
    fullscreen: (on) => call('app:fullscreen', on),
    isFullscreen: () => call('app:isFullscreen'),
    onFullscreen: (fn) => listen(fsListeners, fn),
    status: () => call('app:status'),
    onSealed: (fn) => listen(sealListeners, fn) },
  net: { fetchJson: (url, init) => call('net:fetchJson', url, init) },
  solana: { rpc: (method, params, rpcSecretId) => call('solana:rpc', method, params, rpcSecretId) },
  screens: {
    state: () => call('screens:state'),
    popout: (panel, title, config, displayId) => call('screens:popout', panel, title, config, displayId),
    move: (id, displayId, mode) => call('screens:move', id, displayId, mode),
    focus: (id) => call('screens:focus', id),
    close: (id) => call('screens:close', id),
    self: () => call('screens:self'),
    onChanged: (fn) => listen(screenListeners, fn),
  },
  lab: {
    state: () => call('lab:state'),
    result: () => call('lab:result'),
    config: (patch) => call('lab:config', patch),
    run: (patch) => call('lab:run', patch),
    cancel: () => call('lab:cancel'),
    test: (spec, patch) => call('lab:test', spec, patch),
    deploy: (args, targets, coins) => call('lab:deploy', args, targets, coins),
    undeploy: (id) => call('lab:undeploy', id),
    toggle: (id, on) => call('lab:toggle', id, on),
    onState: (fn) => listen(labListeners.state, fn),
    onEvent: (fn) => listen(labListeners.event, fn),
  },
  cswarm: {
    state: () => call('cswarm:state'),
    start: () => call('cswarm:start'),
    stop: (flatten) => call('cswarm:stop', flatten),
    config: (patch) => call('cswarm:config', patch),
    mode: (mode, secretId) => call('cswarm:mode', mode, secretId),
    resetPaper: () => call('cswarm:resetPaper'),
    onState: (fn) => listen(cswarmListeners.state, fn),
    onEvent: (fn) => listen(cswarmListeners.event, fn),
  },
  swarm: {
    wallet: () => call('swarm:wallet'),
    create: () => call('swarm:walletCreate'),
    importKey: (secret) => call('swarm:walletImport', secret),
    exportKey: () => call('swarm:walletExport'),
    remove: () => call('swarm:walletRemove'),
    setLimits: (p) => call('swarm:setLimits', p),
    setHome: (address) => call('swarm:setHome', address),
    verifyPhone: (rpcSecretId) => call('swarm:verifyPhone', rpcSecretId),
    verifyCancel: () => call('swarm:verifyCancel'),
    verifyState: () => call('swarm:verifyState'),
    onVerified: (fn) => listen(verifiedListeners, fn),
    withdraw: (sol, rpcSecretId) => call('swarm:withdraw', sol, rpcSecretId),
    sweep: (rpcSecretId) => call('swarm:sweep', rpcSecretId),
    balance: (rpcSecretId) => call('swarm:balance', rpcSecretId),
    buy: (mint, sol, rpcSecretId) => call('swarm:buy', mint, sol, rpcSecretId),
    sell: (mint, raw, rpcSecretId) => call('swarm:sell', mint, raw, rpcSecretId),
    notify: (id, html) => call('swarm:notify', id, html),
    notifyPhoto: (id, png, caption) => call('swarm:notifyPhoto', id, png, caption),
    fetchImage: (url) => call('net:fetchImage', url),
  },
  vault: {
    list: () => call('vault:list'),
    save: (rec) => call('vault:save', rec),
    remove: (id) => call('vault:remove', id),
    copy: (id, field) => call('vault:copy', id, field),
    test: (id, opts) => call('vault:test', id, opts),
  },
  ccxt: {
    exchanges: () => call('ccxt:exchanges'),
    markets: (id) => call('ccxt:markets', id),
    ohlcv: (id, symbol, tf, limit) => call('ccxt:ohlcv', id, symbol, tf, limit),
    tickers: (id) => call('ccxt:tickers', id),
    ticker: (id, symbol) => call('ccxt:ticker', id, symbol),
    account: (secretId, symbol) => call('ccxt:account', secretId, symbol),
    subscribe: (sid, id, symbol) => call('ccxt:subscribe', sid, id, symbol),
    unsubscribe: (sid) => call('ccxt:unsubscribe', sid),
    onEvent: (fn) => {
      ccxtListeners.add(fn);
      return () => ccxtListeners.delete(fn);
    },
  },
  trade: {
    marketInfo: (secretId, symbol) => call('trade:marketInfo', secretId, symbol),
    place: (secretId, req) => call('trade:place', secretId, req),
    cancel: (secretId, orderId, symbol) => call('trade:cancel', secretId, orderId, symbol),
    cancelAll: (secretId, symbol) => call('trade:cancelAll', secretId, symbol),
    close: (secretId, symbol, side) => call('trade:close', secretId, symbol, side),
    limits: () => call('trade:limits'),
    setLimits: (l) => call('trade:setLimits', l),
    log: (limit) => call('trade:log', limit),
  },
  amt: {
    list: () => call('amt:list'),
    defaults: () => call('amt:defaults'),
    presets: () => call('amt:presets'),
    save: (cfg) => call('amt:save', cfg),
    remove: (id) => call('amt:remove', id),
    start: (id) => call('amt:start', id),
    stop: (id, flatten) => call('amt:stop', id, flatten),
    stopAll: () => call('amt:stopAll'),
    snapshot: (id) => call('amt:snapshot', id),
    events: (id) => call('amt:events', id),
    backtest: (params, venue, symbol, from) => call('amt:backtest', params, venue, symbol, from),
    train: (params, venue, symbol, opts) => call('amt:train', params, venue, symbol, opts),
    trendBacktest: (params, exchangeId, symbol, fromYear) => call('amt:trendBacktest', params, exchangeId, symbol, fromYear),
    onTrain: (fn) => listen(amtListeners.train, fn),
    onStatus: (fn) => listen(amtListeners.status, fn),
    onEvent: (fn) => listen(amtListeners.event, fn),
  },
  db: {
    info: () => call('db:info'),
    record: (venue, symbol, rows) => call('db:record', venue, symbol, rows),
    query: (venue, symbol, from, to) => call('db:query', venue, symbol, from, to),
    stats: () => call('db:stats'),
    prune: (days) => call('db:prune', days),
    deleteInstrument: (venue, symbol) => call('db:deleteInstrument', venue, symbol),
    vacuum: () => call('db:vacuum'),
    setRetention: (days) => call('db:setRetention', days),
    exportCsv: (venue, symbol) => call('db:exportCsv', venue, symbol),
  },
  wallet: {
    connectPhantom: () => call('wallet:connectPhantom'),
    watch: (address) => call('wallet:watch', address),
    list: () => call('wallet:list'),
    remove: (address) => call('wallet:remove', address),
    balances: (address, rpcSecretId) => call('wallet:balances', address, rpcSecretId),
    tokenInfo: (mints) => call('wallet:tokenInfo', mints),
    activity: (address, rpcSecretId) => call('wallet:activity', address, rpcSecretId),
  },
  x: { search: (id, query, max) => call('x:search', id, query, max) },
  telegram: {
    me: (id) => call('telegram:me', id),
    detect: (id) => call('telegram:detect', id),
    send: (id, html) => call('telegram:send', id, html),
    sendPhoto: (id, png, caption) => call('telegram:sendPhoto', id, png, caption),
    commands: (id) => call('telegram:commands', id),
    setStatus: (snap) => call('telegram:setStatus', snap),
  },
});
