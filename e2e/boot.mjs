// Start-up check: the real desktop app on a computer that has been in use for weeks — a large
// edge finder save, years of cached candles, a full trade journal — measured from launch to
// the lock screen, and how long the desktop process is held up while it starts.
//
//   npm run build && npm run build:main && xvfb-run -a node e2e/boot.mjs [path/to/farm.json]
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { seedDesktopLedger } from './unlock.mjs';

const require = createRequire(import.meta.url);
const userData = mkdtempSync(join(tmpdir(), 'novus-boot-'));
const log = (m) => console.error(m);
await seedDesktopLedger(userData);
const lab = join(userData, 'lab');
mkdirSync(join(lab, 'cache'), { recursive: true });
if (process.argv[2]) copyFileSync(process.argv[2], join(lab, 'farm.json'));
for (const coin of ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX'])
  for (const [tf, ms, n] of [['15m', 900_000, 35_000], ['1h', 3_600_000, 17_500], ['4h', 14_400_000, 11_000], ['1d', 86_400_000, 2_200]]) {
    const last = Math.floor(Date.now() / ms) * ms;
    let p = 100;
    const bars = Array.from({ length: n }, (_, i) => {
      const o = p;
      p *= 1 + Math.sin(i / 37) * 0.002;
      return { time: last - (n - i) * ms, open: o, high: Math.max(o, p) * 1.001, low: Math.min(o, p) * 0.999, close: p, volume: 100 + (i % 13) };
    });
    writeFileSync(join(lab, 'cache', `binance-${coin}-${tf}.json`), JSON.stringify(bars));
  }
const runs = Number(process.env.BOOT_RUNS ?? 2);
const results = [];
for (let r = 0; r < runs; r++) {
  const t0 = Date.now();
  const app = await electron.launch({ executablePath: require('electron'), args: ['.', '--no-sandbox'], env: { ...process.env, NOVUS_USER_DATA: userData, NOVUS_NO_FARM: '1' } });
  try {
    const page = await app.firstWindow();
    const tWin = Date.now() - t0;
    await app.evaluate(() => {
      const g = globalThis;
      g.__lag = { max: 0, over100: 0 };
      let last = performance.now();
      g.__lagT = setInterval(() => {
        const t = performance.now();
        const late = t - last - 10;
        last = t;
        if (late > g.__lag.max) g.__lag.max = late;
        if (late > 100) g.__lag.over100++;
      }, 10);
    });
    await page.waitForSelector('.lock-key input, .lock', { timeout: 120_000 });
    const tLock = Date.now() - t0;
    await page.waitForFunction(() => /ALL SYSTEMS READY/.test(document.querySelector('.lock-loader')?.textContent ?? ''), null, { timeout: 120_000 });
    const tReady = Date.now() - t0;
    await page.waitForTimeout(3000);
    const lag = await app.evaluate(() => globalThis.__lag);
    results.push({ run: r + 1, windowMs: tWin, lockScreenMs: tLock, readyMs: tReady, mainLongestStallMs: Math.round(lag.max), stallsOver100: lag.over100 });
  } finally {
    await app.close().catch(() => undefined);
  }
}
const logText = (() => {
  try {
    return readFileSync(join(userData, 'logs', 'novus.log'), 'utf8');
  } catch {
    return '';
  }
})();
log(JSON.stringify(results));
log(logText.split('\n').filter((l) => /electron ready|window created|window shown|page loaded|services|lab ready|ccxt/i.test(l)).slice(-14).join('\n'));
