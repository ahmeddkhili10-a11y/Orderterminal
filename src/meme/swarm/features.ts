// What the decision forest sees of a coin: the bots' readings and the raw
// numbers under them, as one row of numbers. Unknown values are -1 (the trees
// learn to split them off). Change the list only by adding to the end: rows
// saved before keep their meaning.
import { curveProgress } from '../pump';
import type { Assessment } from '../score';
import { devActivity, type MemeToken } from '../token';
import { buyerGrowth, buyShare5m, extension5m, run5m, type InsiderRead, type Viability, type Virality } from './agents';

export const FEATURES = [
  'heat',
  'virality',
  'viability',
  'insider score',
  'market cap (log10 $)',
  'age (min)',
  'curve sold',
  'new buyers a minute',
  'buyers speeding up',
  'buy share (5 min)',
  'price vs 5-min average',
  'top 10 holders',
  'creator sold',
  'socials linked',
  'narrative size',
  'X posts (1 h)',
  'X accounts posting',
  'X reach (log10 followers)',
] as const;

export interface XStats {
  posts: number;
  authors: number;
  reach: number;
}

/** The coin as numbers, in FEATURES order. */
export function features(tok: MemeToken, now: number, a: Assessment, v: Viability, x: Virality | null, ins: InsiderRead | null, social?: XStats | null): number[] {
  const g = buyerGrowth(tok, now);
  const onCurve = tok.source === 'pump' && !tok.migrated;
  const ext = onCurve ? extension5m(tok, now) : (() => {
    const r = run5m(tok, now);
    return r === null ? null : 1 + r;
  })();
  const share = buyShare5m(tok, now);
  const socials = new Set([tok.meta?.twitter, tok.meta?.telegram, tok.meta?.website, ...(tok.dex?.socials ?? []).map((s) => s.url)].filter(Boolean)).size;
  const dev = devActivity(tok);
  const n = (z: number | null | undefined, d = -1) => (z === null || z === undefined || !Number.isFinite(z) ? d : z);
  return [
    a.heat,
    n(x?.score),
    v.score,
    n(ins?.score, 0),
    Number.isFinite(a.mcapUsd) && a.mcapUsd > 0 ? Math.log10(a.mcapUsd) : -1,
    a.ageSec / 60,
    onCurve ? curveProgress(tok.vTokens) : tok.migrated || tok.source === 'dex' ? 1 : -1,
    g.perMin,
    Math.min(g.accel, 20),
    n(share),
    n(ext),
    n(tok.safety?.top10),
    n(dev.soldShare, 0),
    socials,
    n(x?.narrative?.count, 0),
    n(social?.posts),
    n(social?.authors),
    social ? Math.log10(1 + social.reach) : -1,
  ];
}
