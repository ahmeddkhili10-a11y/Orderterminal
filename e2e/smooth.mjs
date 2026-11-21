// Smoothness check: the real desktop app with the edge finder running flat out on four
// coins and five paces (years of candles), while the window is scrolled and clicked.
// It measures what a person feels: how long the desktop process is held up (every click,
// key and scroll passes through it), the longest stalls on the page, how long clicks take
// to answer, and how many frames are dropped while scrolling.
//
//   npm run build && npm run build:main && xvfb-run -a node e2e/smooth.mjs
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { seedDesktopLedger, unlock } from './unlock.mjs';

const require = createRequire(import.meta.url);
const userData = mkdtempSync(join(tmpdir(), 'novus-smooth-'));
const SECS = Number(process.env.SMOOTH_SECS ?? 40);
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
  // the four it breeds on, and the first three confirmation coins (never bred on) the edge finder re-tests proven strategies on
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
  // fresh candles are loaded every 20 seconds here (every 15 minutes normally), so their cost shows within the run
  env: { ...process.env, NOVUS_USER_DATA: userData, NOVUS_NO_FARM: '1', NOVUS_FARM_EVERY: '20000' },
});
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1600, height: 950 }).catch(() => undefined);
  await unlock(page);
  await page.waitForSelector('.pro-cmd-input', { timeout: 60_000 });
  await page.click('.pro-cmd-input');
  await page.keyboard.type('FARM');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-farm]', { timeout: 10_000 });
  // the desktop process: how late its timers fire is how long it was held up
  await app.evaluate(() => {
    const g = globalThis;
    g.__lag = { max: 0, over50: 0, over100: 0, total: 0, n: 0 };
    let last = performance.now();
    g.__lagT = setInterval(() => {
      const t = performance.now();
      const late = t - last - 10;
      last = t;
      if (late > 0) {
        g.__lag.max = Math.max(g.__lag.max, late);
        if (late > 50) g.__lag.over50++;
        if (late > 100) g.__lag.over100++;
        g.__lag.total += late;
      }
      g.__lag.n++;
    }, 10);
  });
  log(`• edge finder: 4 coins, 5 paces, full speed — measured for ${SECS} s while scrolling and clicking`);
  await page.click('[data-farm] button:has-text("Settings")');
  await page.fill('.farm-settings input', 'BTC ETH SOL BNB');
  for (const id of ['scalp15', 'scalp', 'intraday', 'swing', 'position']) if (!(await page.locator(`.farm-settings [data-style="${id}"].active`).count())) await page.click(`.farm-settings [data-style="${id}"]`);
  await page.click('.farm-settings .chip:has-text("Full")');
  await page.click('.farm-settings button:has-text("Apply and run")');
  await page.waitForFunction(() => /Running · generation/.test(document.querySelector('.farm-title')?.textContent ?? ''), null, { timeout: 120_000 });
  // the page: stalls of 50 ms or more, how long each click took to answer, frames while scrolling
  await page.evaluate(() => {
    const w = window;
    w.__long = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__long.push(e.duration))).observe({ type: 'longtask', buffered: false });
    w.__ev = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => ['pointerdown', 'click', 'wheel', 'keydown'].includes(e.name) && w.__ev.push(e.duration))).observe({ type: 'event', durationThreshold: 16, buffered: false });
    w.__frames = [];
    let lastF = performance.now();
    const tick = (t) => {
      w.__frames.push(t - lastF);
      lastF = t;
      w.__raf = requestAnimationFrame(tick);
    };
    w.__raf = requestAnimationFrame(tick);
  });
  await app.evaluate(() => {
    const g = globalThis;
    g.__lag = { max: 0, over50: 0, over100: 0, total: 0, n: 0 };
  });
  const clicks = [];
  const end = Date.now() + SECS * 1000;
  let i = 0;
  const box = await page.locator('[data-farm] .pro-scroll').boundingBox();
  while (Date.now() < end) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, i % 2 ? -400 : 400);
    await page.waitForTimeout(150);
    // a click that must answer: the Explain box, round trip measured from the test's side
    if (i % 4 === 0) {
      const t0 = Date.now();
      await page.locator('[data-farm] .farm-head label.check input').click();
      await page.waitForFunction((was) => document.querySelector('[data-farm] .farm-head label.check input')?.checked !== was, (i / 4) % 2 === 0, { timeout: 10_000 }).catch(() => undefined);
      clicks.push(Date.now() - t0);
    }
    i++;
  }
  const r = await page.evaluate(() => {
    const w = window;
    cancelAnimationFrame(w.__raf);
    const f = w.__frames.slice(1);
    return { long: w.__long, ev: w.__ev, frames: f.length, dropped: f.filter((x) => x > 50).length, worstFrame: Math.max(...f) };
  });
  const lag = await app.evaluate(() => globalThis.__lag);
  const st = await page.evaluate(() => window.novus.lab.farm.state());
  const q = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
  const out = {
    mainMaxMs: Math.round(lag.max),
    mainStalls50: lag.over50,
    mainStalls100: lag.over100,
    pageLongTasks: r.long.length,
    pageLongestMs: Math.round(Math.max(0, ...r.long)),
    pageLongTotalMs: Math.round(r.long.reduce((a, b) => a + b, 0)),
    slowInputs: r.ev.length,
    worstInputMs: Math.round(Math.max(0, ...r.ev)),
    clickMedianMs: q(clicks, 0.5),
    clickWorstMs: Math.max(...clicks),
    framesDroppedPct: Math.round((100 * r.dropped) / Math.max(1, r.frames)),
    worstFrameMs: Math.round(r.worstFrame),
    tried: st.tried,
    survivors: st.survivors,
  };
  log(JSON.stringify(out));
  writeFileSync(process.env.SMOOTH_OUT ?? join(userData, 'smooth.json'), JSON.stringify(out));
  if (process.env.SMOOTH_STRICT !== '0') {
    expect(out.mainMaxMs < 150, `the desktop process was never held up for long (longest ${out.mainMaxMs} ms; ${out.mainStalls100} hold-ups over 100 ms)`);
    expect(out.clickMedianMs < 250, `clicks answer at once (median ${out.clickMedianMs} ms, worst ${out.clickWorstMs} ms)`);
  }
} finally {
  await app.close().catch(() => undefined);
}
if (!ok) process.exit(1);
log('Smoothness check passed.');
