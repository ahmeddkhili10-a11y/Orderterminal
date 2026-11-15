// Which edition this build is. Set when the app is built (vite `define`, esbuild
// `--define`), never at run time, so a commercial build cannot be switched back:
//
//   personal    the owner's own copy: the built-in ledger key, the owner's defaults
//   commercial  the copy that is sold: no built-in key (each buyer creates their
//               own on first launch), terms to accept, a licence to activate when
//               a Gumroad product is configured, and its own data folder
//
// `npm run dist:commercial:*` builds the commercial edition; everything else
// builds the personal one.
declare const __NOVUS_EDITION__: string;
declare const __NOVUS_GUMROAD_PRODUCT__: string;
declare const __NOVUS_SEATS__: number;

export type Edition = 'personal' | 'commercial';
const ED = typeof __NOVUS_EDITION__ === 'undefined' ? 'personal' : __NOVUS_EDITION__;
export const EDITION: Edition = ED === 'commercial' ? 'commercial' : 'personal';
export const COMMERCIAL = ED === 'commercial';
/** the Gumroad product whose licence keys unlock a commercial copy ('' = no licence check) */
export const GUMROAD_PRODUCT_ID: string = typeof __NOVUS_GUMROAD_PRODUCT__ === 'undefined' ? '' : __NOVUS_GUMROAD_PRODUCT__;
/** how many computers one licence may be activated on */
export const LICENSE_SEATS: number = typeof __NOVUS_SEATS__ === 'undefined' ? 3 : __NOVUS_SEATS__;
/** the version of the terms a buyer accepts (raise it when the terms change: everyone accepts again) */
export const TERMS_VERSION = 1;
