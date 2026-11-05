// Island themes: the same world, dressed five ways.
//
//   night    the default: a moonlit island in a deep blue sea
//   matrix   black and phosphor green: green contour lines on dark land, a
//            sea of black glass and digital rain falling over everything
//   neo      neo-futuristic: a violet dusk, neon cyan and magenta contours,
//            glass and light
//   chrome   polished metal: land, sea and buildings reflect a studio sky
//   gold     molten gold land on a dark bronze sea under a warm sky
//
// A theme is only colours and surfaces; the market data drawn on the island
// keeps its meaning (bids/buys stay cool or gold, asks/sells warm or red).

export type IslandThemeId = 'night' | 'matrix' | 'neo' | 'chrome' | 'gold';

interface Surface {
  color: string;
  metal: number;
  rough: number;
  emissive?: string;
}

export interface IslandTheme {
  id: IslandThemeId;
  name: string;
  /** a swatch for the picker: two colours */
  swatch: [string, string];
  sky: { top: string; horizon: string; bottom: string; stars: number };
  fog: [string, number, number];
  hemi: [string, string, number];
  key: [string, number];
  rim: [string, number];
  exposure: number;
  bloom: number;
  /** how much the reflective studio environment lights the scene (0: none) */
  env: number;
  sea: Surface;
  land: { beach: string; grass: string; forest: string; rock: string; meadow: string; metal: number; rough: number };
  /** glowing contour lines over the land (strength 0 = none) */
  contour: [string, number];
  trees: Surface;
  /** the order book's heights, low to high */
  valley: [number, string][];
  river: [string, string];
  stone: Surface;
  plaza: Surface;
  dome: Surface & { glow: string };
  shell: Surface;
  wood: Surface;
  towers: { bid: string; ask: string; capBid: string; capAsk: string; metal: number; rough: number };
  crops: { low: string; high: string; poc: string };
  flies: string;
  /** falling code over the island */
  rain: string | null;
}

const RELIEF: [number, string][] = [
  [0.0, '#1d5a3e'],
  [0.12, '#2f7d2c'],
  [0.24, '#8fb83a'],
  [0.36, '#d9b443'],
  [0.5, '#d9762b'],
  [0.66, '#8c3a17'],
  [0.82, '#3a1a0c'],
  [1.0, '#1c0d06'],
];

export const ISLAND_THEMES: Record<IslandThemeId, IslandTheme> = {
  night: {
    id: 'night',
    name: 'Night',
    swatch: ['#0d4a86', '#3f8a3a'],
    sky: { top: '#02040c', horizon: '#0b1a3a', bottom: '#050b18', stars: 1 },
    fog: ['#050b18', 45, 120],
    hemi: ['#8fb4ff', '#1a1408', 1.15],
    key: ['#c8d8ff', 1.3],
    rim: ['#ff9a4a', 1.6],
    exposure: 1.25,
    bloom: 0.5,
    env: 0,
    sea: { color: '#0d4a86', metal: 0.25, rough: 0.35 },
    land: { beach: '#c9b07a', grass: '#3f8a3a', forest: '#2b6630', rock: '#6d6152', meadow: '#2c6b35', metal: 0, rough: 0.9 },
    contour: ['#000000', 0],
    trees: { color: '#1f5a2c', metal: 0, rough: 0.9 },
    valley: RELIEF,
    river: ['#2673ff', '#9fd8ff'],
    stone: { color: '#e8ebf0', metal: 0, rough: 0.5 },
    plaza: { color: '#565d6b', metal: 0, rough: 0.9 },
    dome: { color: '#9fc4ff', metal: 0.4, rough: 0.15, glow: '#1d4aa8' },
    shell: { color: '#e9edf5', metal: 0.35, rough: 0.28 },
    wood: { color: '#6a4e34', metal: 0, rough: 0.85 },
    towers: { bid: '#2fd6ff', ask: '#ff8a3d', capBid: '#52e0ff', capAsk: '#ff9a52', metal: 0.6, rough: 0.25 },
    crops: { low: '#2f8a3a', high: '#d9c45a', poc: '#ffd25a' },
    flies: '#ffd173',
    rain: null,
  },
  matrix: {
    id: 'matrix',
    name: 'Matrix',
    swatch: ['#000000', '#00ff66'],
    sky: { top: '#000000', horizon: '#021a0a', bottom: '#000000', stars: 0 },
    fog: ['#000a03', 35, 110],
    hemi: ['#3dff8a', '#000000', 0.7],
    key: ['#7dffb0', 0.9],
    rim: ['#00ff66', 0.6],
    exposure: 1.2,
    bloom: 0.85,
    env: 0,
    sea: { color: '#00170a', metal: 0.6, rough: 0.2, emissive: '#00140a' },
    land: { beach: '#06200f', grass: '#041a0b', forest: '#031408', rock: '#0a2a14', meadow: '#04200d', metal: 0.2, rough: 0.6 },
    contour: ['#00ff66', 0.9],
    trees: { color: '#03140a', metal: 0.2, rough: 0.5, emissive: '#00ff66' },
    valley: [
      [0.0, '#001a0a'],
      [0.2, '#00401a'],
      [0.45, '#00a040'],
      [0.7, '#3dff8a'],
      [1.0, '#d8ffe6'],
    ],
    river: ['#00ff66', '#d8ffe6'],
    stone: { color: '#0b1f12', metal: 0.5, rough: 0.35, emissive: '#00381a' },
    plaza: { color: '#031208', metal: 0.4, rough: 0.5 },
    dome: { color: '#00ff66', metal: 0.3, rough: 0.2, glow: '#00a040' },
    shell: { color: '#0c2416', metal: 0.6, rough: 0.3, emissive: '#00301a' },
    wood: { color: '#06200f', metal: 0.3, rough: 0.6, emissive: '#002a12' },
    towers: { bid: '#00ff66', ask: '#b4ff3d', capBid: '#9dffc4', capAsk: '#eaffb0', metal: 0.4, rough: 0.3 },
    crops: { low: '#00401a', high: '#3dff8a', poc: '#eaffb0' },
    flies: '#3dff8a',
    rain: '#3dff8a',
  },
  neo: {
    id: 'neo',
    name: 'Neo',
    swatch: ['#2a0b4a', '#ff3df0'],
    sky: { top: '#07001a', horizon: '#3a0b5e', bottom: '#0a0220', stars: 1 },
    fog: ['#12052a', 40, 115],
    hemi: ['#b48cff', '#14002a', 1.0],
    key: ['#7df4ff', 1.2],
    rim: ['#ff3df0', 2.0],
    exposure: 1.3,
    bloom: 0.9,
    env: 0.35,
    sea: { color: '#12063a', metal: 0.8, rough: 0.15, emissive: '#0a0024' },
    land: { beach: '#3a2a66', grass: '#1a1238', forest: '#140d2c', rock: '#2a2050', meadow: '#1c1440', metal: 0.4, rough: 0.45 },
    contour: ['#3df4ff', 0.75],
    trees: { color: '#1a0f3a', metal: 0.5, rough: 0.3, emissive: '#5a1aa0' },
    valley: [
      [0.0, '#140a3a'],
      [0.25, '#3a1a8a'],
      [0.5, '#7a3dff'],
      [0.75, '#ff3df0'],
      [1.0, '#ffd0fa'],
    ],
    river: ['#3df4ff', '#e0fdff'],
    stone: { color: '#e6e0ff', metal: 0.7, rough: 0.2 },
    plaza: { color: '#1e1440', metal: 0.7, rough: 0.25 },
    dome: { color: '#c08cff', metal: 0.5, rough: 0.1, glow: '#7a1aff' },
    shell: { color: '#f2eeff', metal: 0.6, rough: 0.18 },
    wood: { color: '#2a2050', metal: 0.6, rough: 0.3, emissive: '#1a0a3a' },
    towers: { bid: '#3df4ff', ask: '#ff3df0', capBid: '#bffaff', capAsk: '#ffc0fa', metal: 0.8, rough: 0.12 },
    crops: { low: '#3a1a8a', high: '#3df4ff', poc: '#ff3df0' },
    flies: '#ff9df7',
    rain: null,
  },
  chrome: {
    id: 'chrome',
    name: 'Chrome',
    swatch: ['#5d6470', '#f4f7fb'],
    sky: { top: '#05070b', horizon: '#2a313c', bottom: '#0b0e13', stars: 0.5 },
    fog: ['#0f1318', 50, 125],
    hemi: ['#cfd8e6', '#14171c', 0.55],
    key: ['#ffffff', 1.3],
    rim: ['#9fbcff', 1.0],
    exposure: 0.95,
    bloom: 0.22,
    env: 0.55,
    sea: { color: '#2a2f37', metal: 0.9, rough: 0.32 },
    land: { beach: '#9aa1ad', grass: '#6e7683', forest: '#585f6b', rock: '#454b55', meadow: '#626a76', metal: 0.9, rough: 0.34 },
    contour: ['#ffffff', 0.16],
    trees: { color: '#c3c9d3', metal: 1.0, rough: 0.22 },
    valley: [
      [0.0, '#3a404a'],
      [0.3, '#6a7280'],
      [0.6, '#aab2bf'],
      [0.85, '#e3e8ef'],
      [1.0, '#ffffff'],
    ],
    river: ['#6fa8ff', '#e8f2ff'],
    stone: { color: '#d8dce3', metal: 1.0, rough: 0.16 },
    plaza: { color: '#4a505a', metal: 1.0, rough: 0.28 },
    dome: { color: '#b8cff5', metal: 1.0, rough: 0.08, glow: '#1a2c55' },
    shell: { color: '#e6e9ee', metal: 1.0, rough: 0.16 },
    wood: { color: '#6e7683', metal: 1.0, rough: 0.3 },
    towers: { bid: '#7fdcff', ask: '#ffb07a', capBid: '#d6f4ff', capAsk: '#ffe0c8', metal: 1.0, rough: 0.12 },
    crops: { low: '#5d6470', high: '#d8dce3', poc: '#ffd25a' },
    flies: '#dfe7f5',
    rain: null,
  },
  gold: {
    id: 'gold',
    name: 'Gold',
    swatch: ['#3a2508', '#ffcf5a'],
    sky: { top: '#060402', horizon: '#2e1c06', bottom: '#0b0703', stars: 0.6 },
    fog: ['#100a03', 45, 120],
    hemi: ['#ffd9a0', '#140b02', 0.6],
    key: ['#ffe2a8', 1.2],
    rim: ['#ff9a3a', 1.3],
    exposure: 1.0,
    bloom: 0.32,
    env: 0.45,
    sea: { color: '#1e1306', metal: 0.7, rough: 0.36 },
    land: { beach: '#d9b25a', grass: '#a87c2a', forest: '#8a6220', rock: '#5e4214', meadow: '#9a7026', metal: 0.8, rough: 0.42 },
    contour: ['#fff0b0', 0.14],
    trees: { color: '#e0b04a', metal: 1.0, rough: 0.3 },
    valley: [
      [0.0, '#3a2506'],
      [0.3, '#7a5212'],
      [0.6, '#c9952e'],
      [0.85, '#ffd970'],
      [1.0, '#fff3cc'],
    ],
    river: ['#ffc43d', '#fff3cc'],
    stone: { color: '#e8c25e', metal: 1.0, rough: 0.22 },
    plaza: { color: '#4a320c', metal: 0.9, rough: 0.32 },
    dome: { color: '#ffd970', metal: 1.0, rough: 0.1, glow: '#5a3a08' },
    shell: { color: '#f2c85a', metal: 1.0, rough: 0.24 },
    wood: { color: '#3a2508', metal: 0.7, rough: 0.35 },
    towers: { bid: '#fff0b0', ask: '#ff8a3d', capBid: '#fffbe6', capAsk: '#ffc49a', metal: 1.0, rough: 0.18 },
    crops: { low: '#7a5212', high: '#ffd970', poc: '#ffffff' },
    flies: '#ffd25a',
    rain: null,
  },
};

export const ISLAND_THEME_IDS = Object.keys(ISLAND_THEMES) as IslandThemeId[];

export function islandTheme(id: string | undefined): IslandTheme {
  return ISLAND_THEMES[(id as IslandThemeId) ?? 'night'] ?? ISLAND_THEMES.night;
}
