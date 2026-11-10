// Captures the Quant desk panels added after the first edition (PAIR, SEAS, MC) on the built-in simulator, for the manual.
//   node --experimental-strip-types manual/capture.mjs <out-dir>
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire('/home/user/Orderflow-terminal/')('playwright');
import { seedWebLedger, unlock } from '../e2e/unlock.mjs';
const PORT = 5197;
const OUT = process.argv[2];
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: '/home/user/Orderflow-terminal', stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('vite')), 40000); server.stdout.on('data', (d) => /Local:/.test(String(d)) && (clearTimeout(t), res())); });
const b = await chromium.launch();
try {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2 });
  await seedWebLedger(ctx);
  const page = await ctx.newPage();
  for (const [id, wait, extra, h] of [
    ['qpair', '.pair-table', '', 760],
    ['qseas', '.seas-grid', '&hour=21', 700],
    ['qmc', '.mc-ladder', '', 900],
  ]) {
    await page.setViewportSize({ width: 1280, height: h });
    await page.goto(`http://localhost:${PORT}/?embed=${id}&venue=sim&agg=sim&filter=none&theme=pro-amber&ui=pro${extra}`);
    await page.waitForFunction(() => /ALL SYSTEMS READY/.test(document.querySelector('.lock-loader')?.textContent ?? '') || !document.querySelector('.lock-key'), null, { timeout: 40000 });
    await unlock(page);
    await page.waitForSelector(wait, { timeout: 25000 }).catch(async () => { await page.screenshot({ path: `${OUT}/fail-${id}.png` }); console.log(id, 'no selector', (await page.locator('body').innerText()).slice(0, 300)); });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/${id}.png` });
    console.log(id, 'ok');
  }
} finally {
  await b.close();
  try { process.kill(-server.pid); } catch {}
}
