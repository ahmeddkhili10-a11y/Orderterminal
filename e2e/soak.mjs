// Soak check: the real desktop app left running for a long while — the edge finder breeding
// flat out, the simulated market streaming, a heat map popped out — then hidden and brought
// back. Every minute it records what builds up (memory, page size, the edge finder's
// numbers) and the longest hold-ups of the desktop process and of the page in that minute.
// At the end the window is minimised for a while and restored, and the time until the page
// answers the mouse again is measured.
//
//   npm run build && npm run build:main && SOAK_MIN=15 xvfb-run -a node e2e/soak.mjs
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { seedDesktopLedger, unlock, terminalWindow } from './unlock.mjs';

const require = createRequire(import.meta.url);
const userData = mkdtempSync(join(tmpdir(), 'novus-soak-'));
const MIN = Number(process.env.SOAK_MIN ?? 15);
const HIDE = Number(process.env.SOAK_HIDE_MIN ?? 3);
const log = (m) => console.error(m);
let ok = true;
const expect = (cond, msg) => {
  if (!cond) ok = false;
  log(`  ${cond ? '✓' : '✗'} ${msg}`);
};

await seedDesktopLedger(userData);
{
  const dir = join(userData, 'lab', 'cache');
  mkdirSync(dir, { recursive: true });
  const coins = ['BTC', 'ETH', 'SOL', 'BNB', 'LINK', 'LTC', 'ADA'];
  coins.forEach((coin, ci) => {
    let seed = 20261117 + ci * 7919;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
    for (const [tf, ms, days] of [['15m', 900_000, 380], ['1h', 3_600_000, 760], ['4h', 14_400_000, 1850], ['1d', 86_400_000, 2200]]) {
      const sd = 0.006 * Math.sqrt(ms / 3_600_000);
      const last = Math.floor(Date.now() / ms) * ms + 2 * ms;
      const n = Math.round((days * 86_400_000) / ms);
      let p = 1000 * (ci + 1);
      let mu = 0;
      const bars = Array.from({ length: n }, (_, i) => {
        mu = 0.997 * mu + sd * 0.03 * gauss();
        const o = p;
        p *= Math.exp(mu + sd * gauss());
        return { time: last - (n - 1 - i) * ms, open: o, high: Math.max(o, p) * (1 + Math.abs(gauss()) * sd * 0.3), low: Math.min(o, p) * (1 - Math.abs(gauss()) * sd * 0.3), close: p, volume: 100 * (1 + Math.abs(gauss())) };
      });
      for (const ex of ['binance', 'hyperliquid']) writeFileSync(join(dir, `${ex}-${coin}-${tf}.json`), JSON.stringify(ex === 'hyperliquid' ? bars.slice(-5000) : bars));
    }
  });
}

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', '--no-sandbox'],
  env: { ...process.env, NOVUS_USER_DATA: userData, NOVUS_NO_FARM: '1', NOVUS_FARM_EVERY: process.env.SOAK_FARM_EVERY ?? '60000' },
});
const rows = [];
try {
  const page = await terminalWindow(app);
  await page.setViewportSize({ width: 1600, height: 950 }).catch(() => undefined);
  await unlock(page);
  await page.waitForSelector('.pro-cmd-input', { timeout: 60_000 });
  // the simulated market, so there is a live stream to record
  await page.evaluate(() => {
    const k = 'oft-settings';
    const s = JSON.parse(localStorage.getItem(k) ?? '{"state":{}}');
    s.state = { ...s.state, primaryVenue: 'sim', aggregateVenues: ['sim'], historySource: 'exchange' };
    localStorage.setItem(k, JSON.stringify(s));
  });
  await page.reload();
  await unlock(page);
  await page.waitForSelector('.pro-cmd-input', { timeout: 60_000 });
  // a heat map popped out, as on a second screen
  if (process.env.SOAK_POPOUT !== '0') {
    const ev = app.waitForEvent('window', { timeout: 30_000 });
    await page.evaluate(() => window.novus.screens.popout('heatmap', 'Liquidity Heatmap', {}));
    await (await ev).waitForSelector('.popout-bar', { timeout: 30_000 });
    await page.bringToFront();
  }
  // the quant desk visited first (value at risk, regimes, GARCH…): it stays mounted, hidden, behind the edge finder
  if (process.env.SOAK_QUANT !== '0') {
    await page.click('.pro-cmd-input');
    await page.keyboard.type('VAR');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(20_000);
  }
  // the edge finder, flat out
  await page.click('.pro-cmd-input');
  await page.keyboard.type('FARM');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-farm]', { timeout: 10_000 });
  await page.click('[data-farm] button:has-text("Settings")');
  await page.fill('.farm-settings input', 'BTC ETH SOL BNB');
  for (const id of ['scalp15', 'scalp', 'intraday', 'swing', 'position']) if (!(await page.locator(`.farm-settings [data-style="${id}"].active`).count())) await page.click(`.farm-settings [data-style="${id}"]`);
  await page.click('.farm-settings .chip:has-text("Full")');
  await page.click('.farm-settings button:has-text("Apply and run")');
  await page.waitForFunction(() => /Running · generation/.test(document.querySelector('.farm-title')?.textContent ?? ''), null, { timeout: 120_000 });

  // probes: the desktop process's timer lateness, the page's long tasks
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
  const probe = () =>
    page.evaluate(() => {
      const w = window;
      w.__long = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__long.push(e.duration))).observe({ type: 'longtask', buffered: false });
    });
  await probe();
  const cdp = process.env.SOAK_PROFILE ? await page.context().newCDPSession(page) : null;
  if (cdp) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    await cdp.send('Profiler.start');
  }
  const sample = async (label) => {
    const p = await page.evaluate(() => {
      const w = window;
      const long = w.__long ?? [];
      w.__long = [];
      return { heapMb: Math.round(performance.memory.usedJSHeapSize / 1e6), nodes: document.getElementsByTagName('*').length, longest: Math.round(Math.max(0, ...long)), longTotal: Math.round(long.reduce((a, b) => a + b, 0)), longN: long.length };
    });
    const m = await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis;
      const lag = g.__lag;
      g.__lag = { max: 0, over100: 0 };
      const mu = process.memoryUsage();
      return { mainMax: Math.round(lag.max), main100: lag.over100, mainHeapMb: Math.round(mu.heapUsed / 1e6), rssMb: Math.round(mu.rss / 1e6), windows: BrowserWindow.getAllWindows().length };
    });
    const st = await page.evaluate(() => window.novus.lab.farm.state()).catch(() => ({}));
    const row = { t: label, ...m, ...p, tried: st.tried, survivors: st.survivors, gen: st.gen };
    rows.push(row);
    log(JSON.stringify(row));
    return row;
  };
  log(`• left running for ${MIN} min (a sample a minute)`);
  for (let i = 1; i <= MIN; i++) {
    // now and then the mouse wanders over the page, as a person glancing at it would
    const box = await page.locator('[data-farm] .pro-scroll').boundingBox();
    if (box) {
      await page.mouse.move(box.x + 40 + ((i * 97) % Math.max(1, box.width - 80)), box.y + 60 + ((i * 53) % Math.max(1, box.height - 120)));
      await page.mouse.wheel(0, i % 2 ? -300 : 300);
    }
    await page.waitForTimeout(60_000);
    await sample(`${i} min`);
  }
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync(process.env.SOAK_PROFILE, JSON.stringify(profile));
    log(`• profile written to ${process.env.SOAK_PROFILE}`);
  }
  // away from the desk: minimised, then back
  log(`• minimised for ${HIDE} min, then restored`);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.minimize()));
  await page.waitForTimeout(HIDE * 60_000);
  await sample('hidden');
  const t0 = Date.now();
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.getParentWindow() && x.getTitle() !== 'Liquidity Heatmap') ?? BrowserWindow.getAllWindows()[0];
    w.restore();
    w.focus();
  });
  // the page answers: a hover on a row is seen by the page
  const answered = await page.evaluate(
    () =>
      new Promise((res) => {
        const t = performance.now();
        const tick = () => requestAnimationFrame(() => res(performance.now() - t));
        setTimeout(tick, 0);
      }),
  );
  const back = Date.now() - t0;
  await page.waitForTimeout(5000);
  const after = await sample('restored');
  log(JSON.stringify({ restoreMs: back, firstFrameMs: Math.round(answered) }));
  // the GARCH panel's numbers are worked out off the page: they still arrive
  await page.click('.pro-cmd-input');
  await page.keyboard.type('GV');
  await page.keyboard.press('Enter');
  const gv = await page.waitForSelector('.gv-coin', { timeout: 60_000 }).then(() => true).catch(() => false);
  expect(gv, 'the GARCH panel shows its forecasts (worked out on a separate thread)');
  const first = rows[0];
  const last = rows[MIN - 1];
  writeFileSync(process.env.SOAK_OUT ?? join(userData, 'soak.json'), JSON.stringify({ rows, restoreMs: back }, null, 1));
  if (process.env.SOAK_STRICT !== '0') {
    const worstMain = Math.max(...rows.map((r) => r.mainMax));
    const worstPage = Math.max(...rows.map((r) => r.longest));
    expect(worstMain < 250, `the desktop process was never held up for long over ${MIN} min (longest ${worstMain} ms)`);
    expect(worstPage < 400, `the page never froze over ${MIN} min (longest stall ${worstPage} ms)`);
    expect(last.heapMb < first.heapMb * 1.6 + 40, `the page's memory stayed level (${first.heapMb} → ${last.heapMb} MB)`);
    expect(last.mainHeapMb < first.mainHeapMb * 1.6 + 40, `the desktop process's memory stayed level (${first.mainHeapMb} → ${last.mainHeapMb} MB)`);
    expect(back < 1500 && after.longest < 400, `back from minimised at once (${back} ms; longest stall after ${after.longest} ms)`);
  }
} finally {
  await app.close().catch(() => undefined);
}
if (!ok) process.exit(1);
log('Soak check passed.');
