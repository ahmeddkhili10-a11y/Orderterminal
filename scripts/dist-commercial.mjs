// Builds the commercial edition of Novus Ordo — the copy that is sold — and its
// installers:
//
//   node scripts/dist-commercial.mjs win mac linux
//
//   win    a Windows installer (setup.exe, with the licence agreement) and a portable .exe
//   mac    macOS apps for Apple Silicon and Intel, zipped (ad-hoc signed when
//          rcodesign is available: see below)
//   linux  an AppImage and a .deb
//
// The commercial edition has no built-in ledger key (each buyer creates their
// own), asks the buyer to accept the licence agreement, keeps its data in its
// own folder, ships no source maps, and — when NOVUS_GUMROAD_PRODUCT is set to
// the Gumroad product's id — asks for a Gumroad licence key on first launch.
//
//   NOVUS_GUMROAD_PRODUCT=<id>   turn the licence check on (find the id on the
//                                product's page in Gumroad, with "Generate a
//                                unique licence key per sale" ticked)
//   NOVUS_SEATS=3                computers per licence
//
// Nothing personal is in it: keys, Telegram, wallets and settings live in each
// user's own data folder, never in the app. The script checks the built code
// for the personal edition's key digest and refuses to package if it is there.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const want = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['win', 'mac', 'linux']);
const env = { ...process.env, NOVUS_EDITION: 'commercial' };
const run = (cmd, args, extra = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...env, ...extra } });
const out = join(root, 'release', 'commercial');

// 1 — the app, built as the commercial edition
console.log(`\n▶ building the commercial edition (licence check ${env.NOVUS_GUMROAD_PRODUCT ? `ON for Gumroad product ${env.NOVUS_GUMROAD_PRODUCT}` : 'off — set NOVUS_GUMROAD_PRODUCT to turn it on'})`);
rmSync(join(root, 'dist'), { recursive: true, force: true });
run('npx', ['tsc', '-b']);
run('npx', ['vite', 'build']);
run('node', ['scripts/build-main.mjs']);

// 2 — nothing of the personal edition in it
const ledgerSrc = readFileSync(join(root, 'src/shared/ledger.ts'), 'utf8');
const digest = ledgerSrc.match(/LEDGER_DIGEST[^\n]*'([0-9a-f]{64})'/)?.[1];
if (!digest) throw new Error('could not find the personal key digest to check for');
const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
for (const f of [...files(join(root, 'dist')), ...files(join(root, 'dist-electron'))]) {
  if (f.endsWith('.map')) throw new Error(`a source map was built (${f}) — the commercial edition ships none`);
  if (!/\.(m?js|html|css)$/.test(f)) continue;
  const text = readFileSync(f, 'utf8');
  if (digest && text.includes(digest)) throw new Error(`the personal edition's ledger key digest is in ${f} — not packaging`);
  if (!text.includes('commercial') && f.endsWith('main.mjs')) throw new Error('dist-electron/main.mjs was not built as the commercial edition');
}
console.log('✓ checked: no built-in ledger key, no source maps');

// 3 — the licence agreement for the Windows installer (plain ASCII: the installer's text box is not Unicode-safe)
const { termsText } = await import('../src/shared/terms.ts').catch(async () => {
  // plain node cannot import .ts: render it with esbuild first
  const { build } = await import('esbuild');
  const r = await build({ entryPoints: [join(root, 'src/shared/terms.ts')], bundle: true, write: false, format: 'esm', platform: 'node' });
  const tmp = join(root, 'release', '.terms.mjs');
  mkdirSync(join(root, 'release'), { recursive: true });
  writeFileSync(tmp, r.outputFiles[0].text);
  return import(tmp);
});
const ascii = termsText()
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/…/g, '...')
  .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '');
writeFileSync(join(root, 'build', 'EULA.txt'), ascii.replace(/\n/g, '\r\n'));

// 4 — the installers
const cfg = join(root, 'electron-builder.commercial.cjs');
const builder = (args) => run('npx', ['electron-builder', '--config', cfg, ...args]);
mkdirSync(out, { recursive: true });
if (want.has('win')) {
  console.log('\n▶ Windows');
  // unpacked first, so the exe gets its icon and details without Wine, then the installers from it
  builder(['--win', 'dir', '--x64', '-c.win.signAndEditExecutable=false']);
  run('node', ['scripts/set-exe-icon.mjs', join(out, 'win-unpacked', 'Novus Ordo.exe')]);
  builder(['--win', 'nsis', 'portable', '--x64', '--prepackaged', join(out, 'win-unpacked'), '-c.win.signAndEditExecutable=false']);
}
if (want.has('linux')) {
  console.log('\n▶ Linux');
  builder(['--linux', 'AppImage', 'deb', '--x64']);
}
if (want.has('mac')) {
  console.log('\n▶ macOS');
  builder(['--mac', 'dir', '--x64', '--arm64', '-c.mac.identity=null']);
  // Apple Silicon will not open an app whose signature is broken. Built on a Mac, each app is signed ad hoc
  // (no Apple account needed); built elsewhere, rcodesign does it if it is installed — otherwise the apps are
  // left unsigned and the buyer runs the two Terminal commands in the read-me (or sign and notarise them on a Mac).
  for (const arch of ['mac', 'mac-arm64']) {
    const app = join(out, arch, 'Novus Ordo.app');
    if (!existsSync(app)) continue;
    const [cmd, args] = process.platform === 'darwin' ? ['codesign', ['--force', '--deep', '--sign', '-', app]] : [process.env.RCODESIGN || 'rcodesign', ['sign', app]];
    try {
      execFileSync(cmd, args, { stdio: 'ignore' });
      console.log(`✓ ad-hoc signed ${arch}`);
    } catch {
      console.warn(`! ${arch}: left unsigned (no ${cmd} here) — see the macOS read-me`);
    }
  }
  for (const [dir, arch] of [['mac', 'x64'], ['mac-arm64', 'arm64']]) {
    const app = join(out, dir, 'Novus Ordo.app');
    if (!existsSync(app)) continue;
    const zip = join(out, `NovusOrdo-${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}-macOS-${arch === 'arm64' ? 'AppleSilicon' : 'Intel'}.zip`);
    rmSync(zip, { force: true });
    // ditto-style zip: symlinks kept (the app's frameworks need them)
    execFileSync('zip', ['-qry', zip, 'Novus Ordo.app'], { cwd: join(out, dir), stdio: 'inherit' });
    console.log(`✓ ${zip}`);
  }
}
console.log(`\nDone — the installers are in ${out}`);
