// A start that freezes, with the real desktop app: the main thread is held up on purpose while
// the database opens (NOVUS_TEST_FREEZE_MS), as an unknown problem froze it on a laptop.
//   1. the small "starting" window is on screen at once, frozen or not
//   2. the log names the step it is stuck on, written by the watchdog while the app is frozen
//   3. that start is closed before its window showed: the next start notices, runs without the
//      graphics card, and the terminal opens (and stays that way next time)
//
//   npm run build && npm run build:main && xvfb-run -a node e2e/startup.mjs
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { seedDesktopLedger } from './unlock.mjs';

const require = createRequire(import.meta.url);
const exe = require('electron');
const userData = mkdtempSync(join(tmpdir(), 'novus-startup-'));
const logFile = join(userData, 'logs', 'novus.log');
const readLog = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const expect = (cond, msg) => {
  if (!cond) ok = false;
  console.error(`  ${cond ? '✓' : '✗'} ${msg}`);
};
await seedDesktopLedger(userData);
const env = { ...process.env, NOVUS_USER_DATA: userData, NOVUS_NO_FARM: '1' };

console.error('• a start that freezes while opening the data');
// started directly (a test tool attached to the app would freeze with it)
const shot = (name) => {
  const f = join(userData, `${name}.png`);
  try {
    execFileSync('import', ['-display', process.env.DISPLAY ?? ':99', '-window', 'root', '-crop', '460x170+730+455', f]);
    return Number(execFileSync('convert', [f, '-colorspace', 'gray', '-threshold', '60%', '-format', '%[fx:mean]', 'info:']).toString()) * 460 * 170;
  } catch {
    return -1;
  }
};
const before = shot('before');
const a = spawn(exe, ['.', '--no-sandbox'], { env: { ...env, NOVUS_TEST_FREEZE_MS: '60000' }, stdio: 'ignore' });
await sleep(9000);
const lit = shot('frozen');
expect(lit > 200 && before >= 0 && before < 50, `the "starting" window is on screen while the app is frozen (bright pixels in the middle of the screen: ${Math.round(before)} before, ${Math.round(lit)} during)`);
await sleep(14_000);
const l1 = readLog();
expect(/STALL — the app's main thread has not answered for \d+ s, during: database/.test(l1), 'the watchdog wrote, while the app was frozen, which step it is stuck on');
expect(/start-up: starting took .* → database/.test(l1), 'each step is in the log with its time');
expect(!/window on screen/.test(l1), 'the terminal never got its window up (still frozen)');
// closed while frozen, as the "stuck" box does
a.kill('SIGKILL');
await sleep(1500);

console.error('• the next start');
const b = await electron.launch({ executablePath: exe, args: ['.', '--no-sandbox'], env });
try {
  const until = Date.now() + 60_000;
  while (Date.now() < until && !/window on screen/.test(readLog().split('the last start never showed')[1] ?? '')) await sleep(500);
  const l2 = readLog();
  expect(/the last start never showed its window \(it stopped at: database\) — this start runs without the graphics card/.test(l2), 'the next start noticed the last one never showed its window');
  expect(/safe mode: hardware acceleration disabled/.test(l2), 'so it runs without the graphics card');
  const after = l2.split('the last start never showed')[1] ?? '';
  expect(/window on screen [\d.]+ s after launch/.test(after), `and the terminal opened (${after.match(/window on screen ([\d.]+) s/)?.[1]} s after launch)`);
  expect(existsSync(join(userData, 'safe-mode.json')), 'and it stays that way next time (safe mode can be left from the Help menu)');
  const st = JSON.parse(readFileSync(join(userData, 'startup.json'), 'utf8'));
  expect(st.shown === true, 'the start is recorded as shown');
  const t1 = Date.now() + 15_000;
  while (Date.now() < t1 && !/start-up: extras running/.test(readLog().split('the last start never showed')[1] ?? '')) await sleep(500);
  const extras = /start-up: extras running/.test(readLog().split('the last start never showed')[1] ?? '');
  expect(extras, 'the extras (stay awake, sleep tracking, topmost watcher, the escape key) started after the window, not before');
} finally {
  await b.close().catch(() => undefined);
}
if (!ok) process.exit(1);
console.error('Start-up check passed.');
