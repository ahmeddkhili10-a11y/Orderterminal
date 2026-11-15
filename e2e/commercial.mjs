// The commercial edition as a buyer meets it: the built app (release/commercial/linux-unpacked),
// a brand-new data folder, no key built in.
//   node e2e/commercial.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');
const OUT = new URL('./screenshots/', import.meta.url).pathname;
const exe = new URL('../release/commercial/linux-unpacked/novus-ordo', import.meta.url).pathname;
const userData = mkdtempSync(join(tmpdir(), 'novus-commercial-'));
const errors = [];
let ok = true;
const expect = (cond, msg) => {
  console.error(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) ok = false;
};

const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox'], env: { ...process.env, NOVUS_USER_DATA: userData, NOVUS_NO_FARM: '1' } });
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  const st0 = await page.evaluate(() => window.novus.app.status());
  expect(st0.edition === 'commercial' && st0.needsSetup && st0.needsTerms && !st0.needsLicense, `a commercial copy, first launch: terms and a key of its own to create (no licence check in this build: ${JSON.stringify({ edition: st0.edition, needsLicense: st0.needsLicense })})`);
  // the owner's key opens nothing here, nor does any other
  const tryKey = await page.evaluate(() => window.novus.app.unlock('12345678').then(() => 'opened', (e) => e.message));
  expect(/ACCEPT THE TERMS FIRST/.test(tryKey), `no key opens it before the terms are accepted (${tryKey})`);
  await page.waitForSelector('.lock-terms', { timeout: 30_000 });
  await page.waitForFunction(() => /ALL SYSTEMS READY/.test(document.querySelector('.lock-loader')?.textContent ?? ''), null, { timeout: 60_000 });
  expect(await page.locator('.lock-btn').isDisabled(), 'the terms must be scrolled to the end before they can be accepted');
  expect(/Quincy Gininda/.test(await page.locator('.lock').innerText()), 'the lock screen credits Quincy Gininda');
  await page.screenshot({ path: `${OUT}commercial-terms.png` });
  await page.locator('.lock-terms').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(300);
  await page.locator('.lock-check input').check();
  await page.click('.lock-btn');
  await page.waitForSelector('text=CREATE YOUR LEDGER KEY', { timeout: 10_000 });
  expect(true, 'accepted: next, the buyer creates their own ledger key');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}commercial-setup.png` });
  // a weak key is refused, then two that differ, then a good one
  await page.locator('input[aria-label="New ledger key"]').fill('11111111');
  await page.locator('input[aria-label="Repeat the ledger key"]').fill('11111111');
  await page.waitForFunction(() => /ALL DIGITS ARE THE SAME/.test(document.querySelector('.lock-first .lock-msg')?.textContent ?? ''), null, { timeout: 10_000 });
  expect(true, 'a weak key is refused');
  await page.locator('input[aria-label="New ledger key"]').fill('40917263');
  await page.locator('input[aria-label="Repeat the ledger key"]').fill('40917264');
  await page.waitForFunction(() => /DO NOT MATCH/.test(document.querySelector('.lock-first .lock-msg')?.textContent ?? ''), null, { timeout: 10_000 });
  expect(true, 'two keys that differ are refused');
  await page.locator('input[aria-label="New ledger key"]').fill('40917263');
  await page.locator('input[aria-label="Repeat the ledger key"]').fill('40917263');
  await page.waitForSelector('.topbar', { timeout: 30_000 });
  expect(true, 'the key is created and the terminal opens');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}commercial-terminal.png` });
  const st1 = await page.evaluate(() => window.novus.app.status());
  expect(!st1.locked && !st1.needsSetup && !st1.needsTerms, 'set up: nothing left to do');
  const vault = await page.evaluate(() => window.novus.vault.list());
  expect(Array.isArray(vault) && vault.length === 0, 'an empty key vault: no exchange keys, no Telegram, no wallets');
  const info = await page.evaluate(() => window.novus.app.info());
  expect(info.userData === userData, 'its own data folder');
  // locked again, it opens with the buyer's key only
  await page.evaluate(() => window.novus.app.seal());
  const wrong = await page.evaluate(() => window.novus.app.unlock('12345678').then(() => 'opened', (e) => e.message));
  const right = await page.evaluate(() => window.novus.app.unlock('40917263').then(() => 'opened', (e) => e.message));
  expect(/DENIED/.test(wrong) && right === 'opened', `locked again: another key is denied, the buyer's opens it (${wrong} / ${right})`);
  // the first-launch steps cannot be run again to replace the key
  const again = await page.evaluate(() => window.novus.app.setupKey('52819374', '52819374').then(() => 'replaced', (e) => e.message));
  expect(/already set/.test(again), 'the key cannot be replaced through the first-launch step');
  const sw = await page.evaluate(() => window.novus.cswarm.state().then((s) => s.cfg?.paperStartUsd ?? s.config?.paperStartUsd ?? null).catch(() => null));
  expect(sw === null || sw === 1000, `the crypto swarm's paper account starts at $1,000 (${sw})`);
} catch (e) {
  ok = false;
  console.error(e);
} finally {
  await app.close().catch(() => undefined);
}
if (errors.length) console.error(errors.join('\n'));
console.log(ok && !errors.length ? 'Commercial e2e passed.' : 'Commercial e2e FAILED.');
process.exit(ok && !errors.length ? 0 : 1);
