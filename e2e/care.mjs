// Desktop e2e for the final additions: the trade journal (JRNL) and its exports,
// strategy health on DEPL, real costs, the "while you are away" settings on the
// Telegram panel, the background watcher, and a backup saved and restored.
//
//   npm run build && npm run build:main && xvfb-run -a node e2e/care.mjs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron } from 'playwright-core';
import { seedDesktopLedger, unlock } from './unlock.mjs';
import { TradeJournal, fromBot, fromSwarm } from '../electron/care/journal.mjs';

const require = createRequire(import.meta.url);
const OUT = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'novus-care-'));
const errors = [];
let ok = true;
const expect = (cond, msg) => {
  if (!cond) {
    ok = false;
    console.error(`  ✗ ${msg}`);
  } else console.error(`  ✓ ${msg}`);
};
const step = (m) => console.error(`• ${m}`);

// ---- seed: a ledger key, a deployed strategy, and a journal of past trades ----
await seedDesktopLedger(userData);
mkdirSync(join(userData, 'lab', 'cache'), { recursive: true });
const DAY = 86_400_000;
const now = Date.now();
const deployedAt = now - 40 * DAY;
writeFileSync(
  join(userData, 'lab', 'deployed.json'),
  JSON.stringify([
    { id: 'L1', spec: { name: 'Ride the trend', signal: { id: 'tsmom', p: { lookback: 72 } }, filters: [], exit: { stopAtr: 2, targetR: 0, trailAtr: 0, maxBars: 240, onFlip: true, stopVol: 0 }, sides: 'both' }, tfH: 4, coins: ['BTC', 'ETH'], targets: { crypto: true, meme: false }, stats: { sharpe: 1.1, t: 2.4, dsr: 0.7, trades: 60, verdict: 'edge finder · proven', winRate: 0.58, avgR: 0.35, perYear: 40 }, deployedAt, on: true, authority: 'council' },
    { id: 'L2', spec: { name: 'Dip buyer', signal: { id: 'tsmom', p: { lookback: 24 } }, filters: [], exit: { stopAtr: 2, targetR: 0, trailAtr: 0, maxBars: 240, onFlip: true, stopVol: 0 }, sides: 'long' }, tfH: 1, coins: ['SOL'], targets: { crypto: true, meme: false }, stats: { sharpe: 0.9, t: 2, dsr: 0.6, trades: 40, verdict: 'bot builder · strong', winRate: 0.5, avgR: 0.2, perYear: 200 }, deployedAt: now - 2 * DAY, on: true, authority: 'tested' },
  ]),
);
{
  const sql = new DatabaseSync(join(userData, 'novus-ordo.sqlite'));
  const j = new TradeJournal(sql);
  // the strategy that stopped working: 14 trades, 2 won, against 58 % in its test
  for (let i = 0; i < 14; i++) {
    const win = i % 7 === 0;
    j.record(fromSwarm({ id: `l${i}`, labId: 'L1', mode: 'live', coin: i % 2 ? 'ETH' : 'BTC', symbol: `${i % 2 ? 'ETH' : 'BTC'}/USDC:USDC`, agent: 'lab', side: 'buy', setup: 'Lab · Ride the trend', why: 'tested: Sharpe 1.10 on unseen data', entry: 100, askEntry: 99.97, exit: win ? 103 : 99, askExit: win ? 103.02 : 99.03, qty: 1, fees: 0.09, feeReal: true, fillsReal: true, pnl: win ? 2.9 : -1.09, r: win ? 1.45 : -0.55, riskUsd: 2, openedAt: deployedAt + i * DAY, closedAt: deployedAt + i * DAY + 6 * 3_600_000, reason: win ? 'target' : 'stop', votes: [{ bot: 'tape', stance: 'for', why: 'flow with it' }], summary: 'TRADE — a tested strategy', odds: { pWin: 0.58, expR: 0.35 }, mgmt: [{ text: 'stop moved to break-even' }] }, { labName: 'Ride the trend', venue: 'hyperliquid' }));
  }
  j.record(fromSwarm({ id: 'a1', mode: 'paper', coin: 'SOL', symbol: 'SOL/USDC:USDC', agent: 'auction', side: 'sell', setup: 'Value area high', why: 'buyers failed at the top of value', entry: 180, exit: 176, qty: 2, fees: 0.3, pnl: 7.7, r: 1.9, riskUsd: 4, openedAt: now - 5 * 3_600_000, closedAt: now - 2 * 3_600_000, reason: 'target', votes: [], summary: 'TRADE — 5 for, 0 against', odds: { pWin: 0.6, expR: 0.4 }, mgmt: [] }));
  j.record(fromBot({ side: 'buy', setup: 'Trend', why: 'the daily trend is up', entry: 1_700_000, exit: 1_730_000, qty: 0.001, pnl: 28.5, fees: 1.5, opened: now - 3 * DAY, closed: now - 2 * DAY, reason: 'trail', risk: 20_000 }, { id: 'lane1', name: 'Luno lane · BTC', symbol: 'BTC/ZAR', mode: 'live', exchangeId: 'luno', lane: true }));
  sql.prepare("INSERT INTO kv (k, v) VALUES ('journal:imported', '1') ON CONFLICT(k) DO UPDATE SET v = excluded.v").run();
  sql.close();
}

const app = await electron.launch({ executablePath: require('electron'), args: ['.', '--no-sandbox'], env: { ...process.env, NOVUS_USER_DATA: userData, NOVUS_NO_FARM: '1' } });
const open = async (page, panel, ws) => {
  await page.evaluate(([p, w]) => window.dispatchEvent(new CustomEvent('novus:open-panel', { detail: { panel: p, ws: w } })), [panel, ws]);
  await page.waitForTimeout(1500);
};
const cmd = async (page, code) => {
  await page.click('.pro-cmd-input');
  await page.keyboard.type(code);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
};
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1600, height: 950 }).catch(() => undefined);
  await page.waitForSelector('.lock-key input', { timeout: 60_000 });
  await unlock(page);
  await page.waitForSelector('.topbar', { timeout: 30_000 });
  await page.evaluate(() => window.novus.cswarm.state()).catch(() => undefined);

  step('the trade journal (JRNL)');
  await cmd(page, 'JRNL');
  const seen = await page.waitForSelector('[data-journal] [data-row]', { timeout: 20_000 }).then(() => true, () => false);
  if (!seen) {
    await page.screenshot({ path: `${OUT}desktop-journal-fail.png` });
    console.error(await page.evaluate(() => window.novus.journal.list({ limit: 5 }).then((r) => `rows ${r.length}`, (e) => e.message)));
    console.error((await page.locator('body').innerText()).slice(0, 600));
  }
  const n = await page.locator('[data-journal] [data-row]').count();
  expect(n === 16, `every seeded trade is listed (${n}): the strategy's 14, the swarm agent's 1, the Luno lane's 1`);
  const head = await page.locator('[data-journal] .journal-head').innerText();
  expect(/Live/.test(head) && /Paper/.test(head), `totals for live and paper apart (${head.replace(/\s+/g, ' ').slice(0, 160)})`);
  const costs = await page.locator('[data-journal] [data-costs]').innerText();
  expect(/measured on 14 live trades on hyperliquid/.test(costs), `real costs measured from the live fills (${costs.slice(0, 140)})`);
  await page.locator('[data-journal] [data-row="swarm:l0"]').click();
  await page.waitForSelector('.journal-detail');
  const det = await page.locator('.journal-detail').innerText();
  expect(/Why it was taken/.test(det) && /flow with it/.test(det) && /It expected \+0\.35R/.test(det) && /Slippage: entry 3\.0 bps/.test(det), 'a trade opens with its reasons, the council, what it expected and its measured slippage');
  await page.locator('.journal-detail button:has-text("note")').click();
  await page.fill('.journal-detail textarea', 'Took it early — note for later');
  await page.click('.journal-detail button:has-text("Save note")');
  await page.waitForFunction(() => /note for later/.test(document.querySelector('.journal-detail')?.textContent ?? ''), null, { timeout: 10_000 });
  expect(true, 'a note is written on the trade and kept');
  await page.screenshot({ path: `${OUT}desktop-journal.png` });

  step('exports: the journal and the tax year in rands');
  const csvPath = join(userData, 'journal.csv');
  const taxPath = join(userData, 'tax.csv');
  await app.evaluate(({ dialog }, paths) => {
    const q = [...paths];
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: q.shift() });
  }, [csvPath, taxPath]);
  await page.click('[data-journal] button:has-text("Journal (CSV)")');
  await page.waitForFunction(() => /Saved/.test(document.querySelector('.journal-msg')?.textContent ?? ''), null, { timeout: 10_000 });
  const csv = readFileSync(csvPath, 'utf8');
  expect(csv.split('\r\n').length >= 17 && /Took it early/.test(csv), 'the journal spreadsheet holds every trade and the note');
  await page.click('[data-tax]');
  await page.waitForFunction(() => /live trades/.test(document.querySelector('.journal-msg')?.textContent ?? ''), null, { timeout: 40_000 });
  const tax = readFileSync(taxPath, 'utf8');
  const msg = await page.locator('.journal-msg').innerText();
  expect(/Profit or loss \(ZAR\)/.test(tax) && /Summary/.test(tax) && /Not tax advice/.test(tax) && /Luno lane/.test(tax) && !/,paper,/.test(tax), `the tax export: live trades only, rand columns and a summary (${msg.slice(0, 160)})`);

  step('strategy health on DEPL');
  await open(page, 'labdeployed', 'lab');
  await page.waitForSelector('[data-health="stopped"]', { timeout: 30_000 });
  const h1 = await page.locator('[data-health="stopped"]').innerText();
  expect(/may have stopped working/.test(h1) && /14 trades, 14% won \(test 58%\)/.test(h1), `the strategy that lost its edge is flagged (${h1})`);
  expect((await page.locator('[data-health="early"]').count()) === 1, 'the newly deployed one is "too early to tell"');
  const dc = await page.locator('.pro-panel [data-costs]').first().innerText();
  expect(/bps slippage/.test(dc), `the costs every test now charges are shown (${dc.slice(0, 150)})`);
  await page.screenshot({ path: `${OUT}desktop-depl-health.png` });
  const hs = await page.evaluate(() => window.novus.care.health());
  expect(hs[0].status === 'stopped' && /consider switching it off/.test(hs[0].words), 'the health check says so in plain words, and switches nothing off');
  const lab = await page.evaluate(() => window.novus.lab.state());
  expect(lab.costs.measured && lab.costs.slipBps >= 2, `the Lab's tests charge the measured costs (fees ${lab.costs.feeBps} bps, slippage ${lab.costs.slipBps} bps)`);

  step('while you are away: the Telegram panel and the watcher');
  await open(page, 'telegram', 'swarm');
  await page.waitForSelector('[data-care]', { timeout: 15_000 });
  const away = await page.locator('[data-care]').innerText();
  expect(/Daily check-in/.test(away) && /Warn me when something stops/.test(away) && /Strategy health/.test(away) && /Weekly report card/.test(away), 'the daily check-in, warnings, strategy health and weekly report can be switched on and timed');
  const st0 = await page.evaluate(() => window.novus.care.config({ dailyHour: 7, weekday: 5 }));
  expect(st0.cfg.dailyHour === 7 && st0.cfg.weekday === 5 && st0.running, 'the settings are kept by the background engine, which is running since the unlock');
  const noBot = await page.evaluate(() => window.novus.care.sendNow('daily').then(() => 'sent', (e) => e.message));
  expect(/Telegram bot/.test(noBot), `with no Telegram bot nothing is sent, and it says why (${noBot})`);
  // a Telegram bot with its chat, "Answer /price" left off (the default): the background engine still sends with it
  const botId = await page.evaluate(() => window.novus.vault.save({ label: 'My bot', kind: 'telegram', exchange: null, fields: { token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', chatId: '42' } }));
  const picked = await page.evaluate(() => window.novus.care.bot(null));
  expect(!!botId && picked.cfg.secretId === botId, 'a Telegram bot with a chat is used for the background messages without ticking "Answer /price"');
  // this computer cannot reach Telegram: the failure is recorded with its reason, for the panel and the status line
  for (let i = 0; i < 2; i++) await page.evaluate(() => window.novus.care.sendNow('daily').catch(() => null));
  const st1 = await page.evaluate(() => window.novus.care.status());
  expect(st1.delivery?.failing === true && st1.delivery.lastWhy.length > 10 && st1.delivery.lastFailWhat.length > 3, `failed messages are recorded with the reason (“${st1.delivery?.lastFailWhat}”: ${st1.delivery?.lastWhy})`);
  await page.waitForSelector('[data-delivery="failing"]', { timeout: 40_000 });
  await page.locator('[data-care]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}desktop-telegram-away.png` });
  const wanted = await page.evaluate(async () => {
    await window.novus.cswarm.start();
    await window.novus.cswarm.stop(false);
    return true;
  }).catch((e) => String(e?.message ?? e));
  expect(wanted === true, 'starting and stopping the swarm yourself is remembered (a stop you asked for is never a warning)');

  step('a backup, saved and restored');
  const bak = join(userData, 'all.novus');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
    dialog.showMessageBox = async () => ({ response: 1 });
  }, bak);
  await page.evaluate(() => window.novus.vault.save({ label: 'Backup test', kind: 'exchange', exchange: 'binance', fields: { apiKey: 'BK-123', secret: 'SECRET-xyz-987' } }));
  const weak = await page.evaluate(() => window.novus.backup.create('short', {}).then(() => 'saved', (e) => e.message));
  expect(/10 characters/.test(weak), 'a short password is refused');
  const made = await page.evaluate(() => window.novus.backup.create('a long backup phrase 42', { 'e2e-setting': 'kept' }));
  expect(made && existsSync(bak) && made.summary.trades === 16 && made.summary.keys >= 1 && made.summary.strategies === 2, `saved: ${JSON.stringify(made?.summary)}`);
  const file = readFileSync(bak, 'utf8');
  expect(!file.includes('SECRET-xyz-987') && !file.includes('BK-123') && !file.includes('Ride the trend'), 'the file reveals nothing without the password (keys, strategies, trades all encrypted)');
  const wrong = await page.evaluate(() => window.novus.backup.restore('not the password').then(() => 'restored', (e) => e.message));
  expect(/Wrong password/.test(wrong), 'a wrong password is refused');
  // the restore restarts the app at the end: kept from doing so here
  await app.evaluate(({ app }) => {
    app.relaunch = () => undefined;
    app.exit = () => undefined;
  });
  await page.evaluate(() => window.novus.journal.note('swarm:a1', 'changed after the backup'));
  const back = await page.evaluate(() => window.novus.backup.restore('a long backup phrase 42'));
  expect(back && back.keys >= 1 && back.storage['e2e-setting'] === 'kept', `restored: ${back?.keys} keys and the window's settings`);
  const keys = await page.evaluate(() => window.novus.vault.list());
  expect(keys.some((k) => k.label === 'Backup test'), 'the keys are back in the vault (encrypted for this computer again)');
  const jr = await page.evaluate(() => window.novus.journal.list({ limit: 100 }));
  expect(jr.length === 16, 'the journal is whole, nothing doubled');

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('novus:open-settings'))).catch(() => undefined);
  expect(!errors.length, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} catch (e) {
  ok = false;
  console.error(e);
} finally {
  await app.close().catch(() => undefined);
}
console.error(ok ? '\nCARE E2E PASSED' : '\nCARE E2E FAILED');
process.exit(ok ? 0 : 1);
