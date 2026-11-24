// Pop-out windows as tiles: no title bar, edge to edge, the heat map filling its tile.
// Two panels pop out on the simulated market, are arranged side by side, one is tiled to a
// quarter and one goes full screen; each is photographed.
//
//   npm run build && npm run build:main && xvfb-run -a node e2e/tiles.mjs
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { seedDesktopLedger, unlock } from './unlock.mjs';

const require = createRequire(import.meta.url);
const OUT = process.env.TILES_OUT ?? new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'novus-tiles-'));
let ok = true;
const expect = (cond, msg) => {
  if (!cond) ok = false;
  console.error(`  ${cond ? '✓' : '✗'} ${msg}`);
};
await seedDesktopLedger(userData);
const app = await electron.launch({ executablePath: require('electron'), args: ['.', '--no-sandbox'], env: { ...process.env, NOVUS_USER_DATA: userData, NOVUS_NO_FARM: '1' } });
try {
  const page = await app.firstWindow();
  await unlock(page);
  await page.waitForSelector('.pro-cmd-input', { timeout: 60_000 });
  // the simulated market, so the heat map has a book to record
  await page.evaluate(() => {
    const k = 'oft-settings';
    const s = JSON.parse(localStorage.getItem(k) ?? '{"state":{}}');
    s.state = { ...s.state, primaryVenue: 'sim', aggregateVenues: ['sim'], historySource: 'exchange' };
    localStorage.setItem(k, JSON.stringify(s));
  });
  await page.reload();
  await unlock(page);
  await page.waitForSelector('.pro-cmd-input', { timeout: 60_000 });
  // the terminal records for a while first: a heat map popped out later starts with that history
  await page.waitForTimeout(20_000);
  const open = async (panel, title) => {
    const ev = app.waitForEvent('window', { timeout: 30_000 });
    const id = await page.evaluate(([p, t]) => window.novus.screens.popout(p, t, {}), [panel, title]);
    const w = await ev;
    await w.waitForSelector('.popout-bar', { timeout: 30_000 });
    return { id, w };
  };
  const hm = await open('heatmap', 'Liquidity Heatmap');
  const dom = await open('dom', 'DOM Ladder');
  await hm.w.waitForTimeout(4000);
  const st0 = await page.evaluate(() => window.novus.screens.state());
  const d = st0.displays[0];
  // no Windows title bar: the window's whole area is the page
  const frameless = await app.evaluate(({ BrowserWindow }, id) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.id === id);
    const [cw, ch] = w.getContentSize();
    const b = w.getBounds();
    return cw === b.width && ch === b.height;
  }, hm.id);
  expect(frameless, 'a popped-out window has no title bar: its content is the whole window');
  // side by side, edge to edge, over the whole screen
  const n = await hm.w.evaluate(() => window.novus.screens.arrange('self'));
  await hm.w.waitForTimeout(1500);
  const st = await page.evaluate(() => window.novus.screens.state());
  const tiles = st.windows.filter((w) => w.kind === 'panel');
  const area = tiles.reduce((a, w) => a + w.bounds.width * w.bounds.height, 0);
  const wa = d.workArea;
  expect(n === 2 && tiles.every((w) => w.tiled) && area === wa.width * wa.height, `two pop-outs arranged side by side, filling the screen above the taskbar (${tiles.map((w) => `${w.bounds.width}×${w.bounds.height}`).join(' + ')} on ${wa.width}×${wa.height})`);
  const onTop = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isAlwaysOnTop()).length);
  expect(onTop === 0, 'no window is ever "always on top" (a frozen one must never cover Task Manager)');
  // tiled: the bar tucks away — nothing but the panel
  const barHidden = await hm.w.evaluate(() => {
    const r = document.querySelector('.popout-root');
    const bar = document.querySelector('.popout-bar').getBoundingClientRect();
    return r.classList.contains('clean') && bar.bottom <= 1;
  });
  expect(barHidden, 'while tiled, the window shows only the panel (its bar slides in from the top edge)');
  // the heat map fills its tile: no empty columns on the left
  const fill = await hm.w.evaluate(() => {
    const c = [...document.querySelectorAll('.popout-body canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const g = c.getContext('2d');
    const h = c.height;
    const cols = [0.02, 0.1, 0.3, 0.6].map((f) => Math.floor(c.width * f * 0.85));
    return cols.map((x) => {
      const px = g.getImageData(x, Math.floor(h * 0.15), 1, Math.floor(h * 0.7)).data;
      let lit = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 60) lit++;
      return lit;
    });
  });
  expect(fill.every((x) => x > 5), `the heat map fills its tile from the left edge (lit pixels down columns at 2 %, 10 %, 30 %, 60 %: ${fill.join(', ')})`);
  await hm.w.screenshot({ path: `${OUT}tiles-heatmap-half.png` });
  await dom.w.screenshot({ path: `${OUT}tiles-dom-half.png` });
  // a quarter, then full screen
  await hm.w.evaluate(() => window.novus.screens.tile('self', 'tl'));
  await hm.w.waitForTimeout(1200);
  const q = (await page.evaluate(() => window.novus.screens.state())).windows.find((w) => w.id === hm.id);
  expect(q.tiled === 'tl' && q.bounds.width === Math.floor(wa.width / 2) && q.bounds.height === Math.floor(wa.height / 2), `tiled to the top-left quarter (${q.bounds.width}×${q.bounds.height})`);
  await hm.w.screenshot({ path: `${OUT}tiles-heatmap-quarter.png` });
  await dom.w.evaluate(() => window.novus.screens.tile('self', 'full'));
  await dom.w.waitForTimeout(1500);
  const f = (await page.evaluate(() => window.novus.screens.state())).windows.find((w) => w.id === dom.id);
  expect(f.fullScreen, 'full screen from the window itself');
  // hovering the top edge brings the bar back
  await hm.w.mouse.move(200, 2);
  await hm.w.waitForTimeout(400);
  const barBack = await hm.w.evaluate(() => document.querySelector('.popout-bar').getBoundingClientRect().top >= 0 && getComputedStyle(document.querySelector('.popout-bar')).opacity === '1');
  expect(barBack, 'the mouse at the top edge brings the bar back (tile, full screen, minimise, close)');
  await hm.w.screenshot({ path: `${OUT}tiles-heatmap-bar.png` });
  // the graphics process crashes with the windows open (what blanked every screen): the app carries on
  console.error('• the graphics process crashes with every window open');
  const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const pidBefore = app.process().pid;
  await app.evaluate(({ BrowserWindow }) => {
    const g = new BrowserWindow({ show: false });
    void g.loadURL('chrome://gpucrash').catch(() => undefined);
    setTimeout(() => !g.isDestroyed() && g.destroy(), 3000);
  });
  await hm.w.waitForTimeout(12_000);
  const after = await app.evaluate(({ BrowserWindow, globalShortcut }) => ({ n: BrowserWindow.getAllWindows().length, visible: BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length, top: BrowserWindow.getAllWindows().filter((w) => w.isAlwaysOnTop()).length, escape: globalShortcut.isRegistered('CommandOrControl+Alt+Shift+Q') }));
  const alive = (() => {
    try {
      process.kill(pidBefore, 0);
      return true;
    } catch {
      return false;
    }
  })();
  expect(alive && after.n === before && after.visible >= 3 && after.top === 0, `the app was not closed or restarted: ${after.n} windows before and after, ${after.visible} showing, none on top`);
  // and they draw again: the heat map still fills its window
  const lit = await hm.w.evaluate(() => {
    const c = [...document.querySelectorAll('.popout-body canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const px = c.getContext('2d').getImageData(Math.floor(c.width * 0.3), Math.floor(c.height * 0.2), 1, Math.floor(c.height * 0.6)).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 60) n++;
    return n;
  });
  expect(lit > 5, `the windows are drawn again after it (lit pixels down a column of the heat map: ${lit})`);
  expect(after.escape, 'Ctrl + Alt + Shift + Q is ready to close Novus Ordo at once, whatever its windows look like');
  await hm.w.screenshot({ path: `${OUT}tiles-after-gpu-crash.png` });
} finally {
  await app.close().catch(() => undefined);
}
if (!ok) process.exit(1);
console.error('Tiles check passed.');
