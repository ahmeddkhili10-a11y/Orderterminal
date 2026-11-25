// Opening Novus Ordo while it is already running, with the real desktop app:
//   1. the open copy is fine but minimised: a second click brings its window back at once
//   2. its window is off every screen (a monitor unplugged): a second click brings it back
//   3. the open copy is stuck (in Task Manager, answering nothing, no window): the second copy
//      waits, notices, closes the stuck one and starts a fresh copy whose window shows
//
//   npm run build && npm run build:main && xvfb-run -a node e2e/launch.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { seedDesktopLedger, unlock, terminalWindow } from './unlock.mjs';

const require = createRequire(import.meta.url);
const exe = require('electron');
const userData = mkdtempSync(join(tmpdir(), 'novus-launch-'));
const logFile = join(userData, 'logs', 'novus.log');
const readLog = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const expect = (cond, msg) => {
  if (!cond) ok = false;
  console.error(`  ${cond ? '✓' : '✗'} ${msg}`);
};
const env = { ...process.env, NOVUS_USER_DATA: userData, NOVUS_NO_FARM: '1' };
/** a second click on Novus Ordo.exe */
const click = (extra = {}) =>
  new Promise((done) => {
    const t0 = Date.now();
    const p = spawn(exe, ['.', '--no-sandbox'], { env: { ...env, ...extra }, stdio: 'ignore' });
    p.on('exit', (code) => done({ code, ms: Date.now() - t0 }));
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

await seedDesktopLedger(userData);
const app = await electron.launch({ executablePath: exe, args: ['.', '--no-sandbox'], env });
const pidA = app.process().pid;
let pidC = null;
try {
  const page = await terminalWindow(app);
  await page.waitForSelector('.lock-key input, .topbar', { timeout: 60_000 });
  // stay awake: on by default while open; the ☀ button switches it off and on (and it is remembered)
  console.error('• stay awake');
  await unlock(page);
  await page.waitForSelector('.topbar', { timeout: 60_000 });
  const awake0 = await page.evaluate(() => window.novus.app.stayAwake());
  expect(awake0 === true, 'the screen stays on and the computer does not sleep while Novus Ordo is open (on by default)');
  const btn = await page.locator('[data-awake]').count();
  if (btn) {
    await page.click('[data-awake]');
    await page.waitForSelector('[data-awake="off"]', { timeout: 5000 });
    const off = await page.evaluate(() => window.novus.app.stayAwake());
    await page.click('[data-awake]');
    await page.waitForSelector('[data-awake="on"]', { timeout: 5000 });
    expect(off === false && (await page.evaluate(() => window.novus.app.stayAwake())) === true, 'the ☀ button in the top bar switches it off and on again');
  } else expect(false, 'the ☀ button is in the top bar');
  expect(/stay awake: on/.test(readLog()), 'the log says when it is on');
  // 1 — open and fine, but minimised
  console.error('• a second click while it is open (minimised)');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await sleep(800);
  const r1 = await click();
  const st = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { visible: w.isVisible(), minimised: w.isMinimized() };
  });
  expect(r1.code === 0 && r1.ms < 5000, `the second copy handed over and left within seconds (${r1.ms} ms)`);
  expect(st.visible && !st.minimised, 'the open window is back on screen');
  expect(/the open copy is showing its window/.test(readLog()), 'the open copy said its window was showing');

  // 2 — off every screen
  console.error('• a second click while its window is off every screen');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w.isFullScreen()) w.setFullScreen(false);
    w.unmaximize();
    w.setBounds({ x: 6000, y: 3000, width: 1200, height: 800 });
  });
  await sleep(800);
  const r3 = await click();
  const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  expect(r3.code === 0 && b.x < 1920 && b.y < 1080 && b.x + b.width > 0, `the window came back onto the screen (at ${b.x}, ${b.y})`);

  // 3 — stuck: it answers nothing and shows no window
  console.error('• a second click while the open copy is stuck');
  await app.evaluate(({ app: a, BrowserWindow }) => {
    a.removeAllListeners('second-instance');
    BrowserWindow.getAllWindows()[0].hide();
  });
  const r2 = await click({ NOVUS_HANDOVER: 'restart' });
  expect(r2.code === 0 && r2.ms >= 7500 && r2.ms < 30_000, `the second copy waited for an answer, then acted (${r2.ms} ms)`);
  expect(!alive(pidA), 'the stuck copy was closed');
  const log2 = readLog();
  expect(/did not show its window within 8 s/.test(log2) && /closing the stuck copy/.test(log2), 'the log says what happened');
  // the fresh copy starts and shows its window
  const before = (log2.match(/window shown/g) ?? []).length;
  const until = Date.now() + 60_000;
  while (Date.now() < until && (readLog().match(/window shown/g) ?? []).length <= before) await sleep(500);
  const shown = (readLog().match(/window shown/g) ?? []).length > before;
  try {
    pidC = JSON.parse(readFileSync(join(userData, 'running.json'), 'utf8')).pid;
  } catch {
    pidC = null;
  }
  expect(shown && pidC && pidC !== pidA && alive(pidC), `a fresh copy started and showed its window (process ${pidC})`);
} finally {
  await app.close().catch(() => undefined);
  if (pidC && alive(pidC)) process.kill(pidC);
}
if (!ok) process.exit(1);
console.error('Launch check passed.');
