// Builds the printable A4 manual: the cover, then the body with page numbers in the footer,
// with the table of contents' page numbers looked up from a first render and filled in.
//   node manual/build.mjs [out.pdf]
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(here, 'Novus-Ordo-Operators-Manual.pdf'));
const tmp = mkdtempSync(path.join(tmpdir(), 'manual-'));

const footer = `<div style="width:100%;font-family:Inter,sans-serif;font-size:7.5pt;color:#7a838e;padding:0 17mm;display:flex;justify-content:space-between;-webkit-print-color-adjust:exact">
  <span>Novus Ordo · Operator's Manual · constructed by Quincy Gininda</span><span>page <span class="pageNumber"></span></span></div>`;

const norm = (s) => s.replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();

function pagesOf(pdf) {
  const n = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf], { encoding: 'utf8' }))[1]);
  const pages = [];
  for (let i = 1; i <= n; i++) pages.push(norm(execFileSync('pdftotext', ['-f', String(i), '-l', String(i), '-layout', pdf, '-'], { encoding: 'utf8' })));
  return pages;
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const render = (file) => page.pdf({ path: file, format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, outline: true, tagged: true, headerTemplate: '<span></span>', footerTemplate: footer });

  // the cover's chrome lettering, as transparent high-resolution images (gradient-clipped text prints badly in some readers)
  const chrome = await browser.newPage({ deviceScaleFactor: 4 });
  for (const [file, html] of [
    ['cover-word.png', `<span style="font:600 40pt 'Inter Display','Inter',sans-serif;letter-spacing:0.3em;padding-left:0.3em">NOVUS ORDO</span>`],
    ['cover-name.png', `<span style="font:700 24pt 'Inter Display','Inter',sans-serif;letter-spacing:0.01em">Quincy Gininda</span>`],
  ]) {
    await chrome.setContent(`<style>body{margin:0;background:transparent}div{display:inline-block;padding:4px 6px;line-height:1.25;background:linear-gradient(180deg,#fff 0%,#e4e8ee 40%,#9aa3ae 100%);-webkit-background-clip:text;background-clip:text;color:transparent}</style><div>${html}</div>`);
    await chrome.evaluate(() => document.fonts.ready);
    await chrome.locator('div').screenshot({ path: path.join(here, 'img', file), omitBackground: true });
  }
  await chrome.close();

  // cover
  await page.goto(pathToFileURL(path.join(here, 'cover.html')).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: path.join(tmp, 'cover.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true });

  // body, first pass
  await page.goto(pathToFileURL(path.join(here, 'manual.html')).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const toc = await page.evaluate(() => window.__toc);
  const first = path.join(tmp, 'body1.pdf');
  await render(first);

  // where each entry starts: Chromium writes a bookmark for every heading with its page; walk them in order
  const marks = JSON.parse(execFileSync('python3', ['-I', path.join(here, 'outline.py'), 'pages', first], { encoding: 'utf8' }));
  const pages = pagesOf(first);
  const nums = [];
  let at = 0;
  for (const title of toc) {
    const t = norm(title);
    let i = at;
    while (i < marks.length && norm(marks[i][0]) !== t) i++;
    if (i >= marks.length) throw new Error(`no heading in the PDF for: ${title}`);
    nums.push(marks[i][1]);
    at = i + 1;
  }
  await page.evaluate((nums) => {
    document.querySelectorAll('#toc .pg').forEach((el, k) => { el.textContent = String(nums[k]); });
  }, nums);

  // second pass with the numbers in; the numbers must not move anything
  const second = path.join(tmp, 'body2.pdf');
  await render(second);
  const pages2 = pagesOf(second);
  if (pages2.length !== pages.length) throw new Error(`pagination changed: ${pages.length} -> ${pages2.length}`);

  execFileSync('python3', ['-I', path.join(here, 'outline.py'), 'merge', path.join(tmp, 'cover.pdf'), second, out]);
  console.log(`${out}\n${pages2.length + 1} pages (cover + ${pages2.length})`);
  toc.forEach((t, k) => console.log(String(nums[k]).padStart(3), t));
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
