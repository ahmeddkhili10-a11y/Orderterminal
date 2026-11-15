// Bundles the desktop process and its worker threads (dist-electron/), with the
// edition's build-time constants. The commercial edition is also folded
// (constant conditions resolved, dead branches dropped), so code meant only for
// the personal edition — the built-in ledger key above all — is not in it.
import { build } from 'esbuild';
import { editionDefines } from './edition.mjs';

const define = editionDefines();
const commercial = define.__NOVUS_EDITION__ === '"commercial"';
const entries = {
  main: 'electron/main.mjs',
  trainWorker: 'electron/amt/trainWorker.mjs',
  labWorker: 'electron/lab/labWorker.mjs',
  dbWorker: 'electron/dbWorker.mjs',
  farmWorker: 'electron/lab/farmWorker.mjs',
};
for (const [name, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: `dist-electron/${name}.mjs`,
    external: name === 'main' ? ['electron', 'ccxt'] : [],
    define,
    minifySyntax: commercial,
    logLevel: 'warning',
  });
}
console.log(`dist-electron built (${commercial ? 'commercial' : 'personal'} edition)`);
