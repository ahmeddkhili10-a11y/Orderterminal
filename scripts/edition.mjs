// The build-time constants of an edition, for vite (`define`) and esbuild (`--define`).
//   NOVUS_EDITION=commercial  NOVUS_GUMROAD_PRODUCT=<product id>  NOVUS_SEATS=3
export function editionDefines(env = process.env) {
  const edition = env.NOVUS_EDITION === 'commercial' ? 'commercial' : 'personal';
  const product = edition === 'commercial' ? String(env.NOVUS_GUMROAD_PRODUCT ?? '').trim() : '';
  const seats = Math.max(1, Math.min(20, Math.round(Number(env.NOVUS_SEATS) || 3)));
  return {
    __NOVUS_EDITION__: JSON.stringify(edition),
    __NOVUS_GUMROAD_PRODUCT__: JSON.stringify(product),
    __NOVUS_SEATS__: String(seats),
  };
}

/** the same as esbuild command-line flags */
export function esbuildFlags(env = process.env) {
  return Object.entries(editionDefines(env)).map(([k, v]) => `--define:${k}=${v}`);
}
