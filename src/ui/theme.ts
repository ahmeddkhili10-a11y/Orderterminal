import { useSettings } from '../store/settings';

export type ThemeId = 'void' | 'solana' | 'gold' | 'arctic' | 'crimson' | 'synthwave' | 'grey' | 'white' | 'black' | 'neon-green' | 'neon-orange';
export type FilterId = 'none' | 'vivid' | 'soft' | 'mono' | 'warm' | 'cool' | 'night' | 'crt';
export type GlassLevel = 'off' | 'light' | 'medium' | 'heavy';

type RGB = [number, number, number];

/** Colours used by canvas renderers. */
export interface Palette {
  bg: string;
  /** translucent tint laid over the glass card behind each canvas */
  panel: string;
  grid: string;
  border: string;
  text: string;
  muted: string;
  buy: string;
  sell: string;
  buyRgb: RGB;
  sellRgb: RGB;
  textRgb: RGB;
  accentRgb: RGB;
  warnRgb: RGB;
  pocRgb: RGB;
  accent: string;
  warn: string;
  poc: string;
  vwap: string;
  crosshair: string;
  /** table header strip, alternating rows, price cells, spread cells, tooltips */
  header: string;
  rowAlt: string;
  cell: string;
  cellSpread: string;
  tooltip: string;
  /** heatmap colour ramp, low → high liquidity */
  ramp: RGB[];
  dark: boolean;
}

/**
 * How the swarm looks in a theme: the 3D core's two lights, its metal and its
 * "up" colour; the chrome edges and type (CSS --chrome-*); and one colour per
 * gauge (Scout, Sentinel, Herald, Strategist, Insiders, Forest, Manager,
 * Optimizer, Loss limit, Budget — in that order).
 */
export interface SwarmLook {
  a: string;
  b: string;
  metal: string;
  up: string;
  gauges: string[];
  chrome: Record<string, string>;
}

export interface ThemeDef {
  id: ThemeId;
  name: string;
  /** swatch gradient for the picker */
  swatch: string;
  /** CSS custom properties applied to :root */
  css: Record<string, string>;
  pal: Palette;
  swarm: SwarmLook;
}

/** the gauges' colours in the Void Chrome look: ten hues at one brightness */
export const DEFAULT_GAUGES = ['#3fd4f2', '#5b8def', '#e8578f', '#36d6a0', '#a68cf2', '#9ccc65', '#e6b955', '#dfe4ea', '#f07a5a', '#8fa7c6'];

const metal = (c1: string, c2: string, c3: string, c4: string, c5: string, glow: string, halo: string, text: string): Record<string, string> => ({
  '--chrome-1': c1,
  '--chrome-2': c2,
  '--chrome-3': c3,
  '--chrome-4': c4,
  '--chrome-5': c5,
  '--chrome-glow': glow,
  '--chrome-halo': halo,
  '--chrome-text': text,
});
const SILVER = metal('#ffffff', '#c7ccd4', '#6c737d', '#eef1f4', '#9aa0a8', 'rgba(226, 234, 248, 0.95)', 'rgba(186, 202, 230, 0.6)', 'linear-gradient(180deg, #ffffff 0%, #eef1f5 40%, #b9c0c9 100%)');
const GRAPHITE = metal('#8a919b', '#4b525c', '#1f242b', '#7d848e', '#353b43', 'rgba(120, 132, 150, 0.45)', 'rgba(150, 165, 190, 0.3)', 'linear-gradient(180deg, #5b626c 0%, #2f353d 55%, #1c2027 100%)');

const hexRgb = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const DEFAULT_RAMP: RGB[] = [
  [10, 20, 48],
  [24, 70, 150],
  [0, 170, 220],
  [110, 225, 120],
  [255, 225, 60],
  [255, 120, 40],
  [255, 255, 255],
];

interface Spec {
  id: ThemeId;
  name: string;
  swatch: string;
  dark: boolean;
  bg: string;
  bgImage: string;
  glass: string;
  glassStrong: string;
  glassBorder: string;
  glassHi: string;
  shadow: string;
  control: string;
  raised: string;
  border: string;
  border2: string;
  text: string;
  muted: string;
  faint: string;
  buy: string;
  sell: string;
  accent: string;
  warn: string;
  poc: string;
  glow: string;
  canvasTint: string;
  grid: string;
  header: string;
  rowAlt: string;
  cell: string;
  cellSpread: string;
  tooltip: string;
  tabbar: string;
  rowLine: string;
  accentSoft: string;
  focus: string;
  onAccent: string;
  ramp?: RGB[];
  swarm?: Partial<SwarmLook>;
}

function build(s: Spec): ThemeDef {
  return {
    id: s.id,
    name: s.name,
    swatch: s.swatch,
    css: {
      '--bg': s.bg,
      '--bg-image': s.bgImage,
      '--glass': s.glass,
      '--glass-strong': s.glassStrong,
      '--glass-border': s.glassBorder,
      '--glass-hi': s.glassHi,
      '--glass-shadow': s.shadow,
      '--panel': s.glass,
      '--panel2': s.control,
      '--raised': s.raised,
      '--border': s.border,
      '--border2': s.border2,
      '--text': s.text,
      '--muted': s.muted,
      '--faint': s.faint,
      '--buy': s.buy,
      '--sell': s.sell,
      '--accent': s.accent,
      '--warn': s.warn,
      '--poc': s.poc,
      '--glow': s.glow,
      '--tabbar': s.tabbar,
      '--row-line': s.rowLine,
      '--accent-soft': s.accentSoft,
      '--focus': s.focus,
      '--on-accent': s.onAccent,
      'color-scheme': s.dark ? 'dark' : 'light',
    },
    pal: {
      bg: s.bg,
      panel: s.canvasTint,
      grid: s.grid,
      border: s.border,
      text: s.text,
      muted: s.muted,
      buy: s.buy,
      sell: s.sell,
      buyRgb: hexRgb(s.buy),
      sellRgb: hexRgb(s.sell),
      textRgb: hexRgb(s.text),
      accentRgb: hexRgb(s.accent),
      warnRgb: hexRgb(s.warn),
      pocRgb: hexRgb(s.poc),
      accent: s.accent,
      warn: s.warn,
      poc: s.poc,
      vwap: '#c77dff',
      crosshair: s.dark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)',
      header: s.header,
      rowAlt: s.rowAlt,
      cell: s.cell,
      cellSpread: s.cellSpread,
      tooltip: s.tooltip,
      ramp: s.ramp ?? DEFAULT_RAMP,
      dark: s.dark,
    },
    swarm: {
      a: s.swarm?.a ?? s.accent,
      b: s.swarm?.b ?? s.sell,
      metal: s.swarm?.metal ?? '#e4eaf4',
      up: s.swarm?.up ?? s.buy,
      gauges: s.swarm?.gauges ?? DEFAULT_GAUGES,
      chrome: s.swarm?.chrome ?? (s.dark ? SILVER : GRAPHITE),
    },
  };
}

/** A dark swarm theme from a few colours: black glass tinted by `tint`, with its own lights, metal and gauges. */
function swarmTheme(o: { id: ThemeId; name: string; swatch: string; bg: string; glow1: string; glow2: string; tint: [number, number, number]; text: string; muted: string; faint: string; buy: string; sell: string; accent: string; warn: string; onAccent: string; look: SwarmLook; ramp: RGB[] }): ThemeDef {
  const [r, g, b] = o.tint;
  const t = (a: number) => `rgba(${r},${g},${b},${a})`;
  return build({
    id: o.id,
    name: o.name,
    swatch: o.swatch,
    dark: true,
    bg: o.bg,
    bgImage: `radial-gradient(1200px 520px at 50% -18%, ${o.glow1}, transparent 70%), radial-gradient(900px 600px at 50% 120%, ${o.glow2}, transparent 70%), ${o.bg}`,
    glass: 'rgba(5,5,7,0.94)',
    glassStrong: 'rgba(7,7,9,0.97)',
    glassBorder: t(0.14),
    glassHi: t(0.06),
    shadow: '0 1px 2px rgba(0,0,0,0.8), 0 10px 30px rgba(0,0,0,0.6)',
    control: t(0.04),
    raised: t(0.07),
    border: t(0.11),
    border2: t(0.22),
    text: o.text,
    muted: o.muted,
    faint: o.faint,
    buy: o.buy,
    sell: o.sell,
    accent: o.accent,
    warn: o.warn,
    poc: o.warn,
    glow: t(0.3),
    canvasTint: 'rgba(0,0,0,0)',
    grid: t(0.05),
    header: t(0.035),
    rowAlt: t(0.016),
    cell: 'rgba(0,0,0,0.4)',
    cellSpread: t(0.05),
    tooltip: 'rgba(6,6,8,0.97)',
    tabbar: t(0.02),
    rowLine: t(0.055),
    accentSoft: t(0.1),
    focus: t(0.3),
    onAccent: o.onAccent,
    ramp: o.ramp,
    swarm: o.look,
  });
}

export const THEMES: Record<ThemeId, ThemeDef> = {
  // pure black, chrome edges, cyan and magenta light — the Command Center look
  void: build({
    id: 'void',
    name: 'Void Chrome',
    swatch: 'linear-gradient(135deg,#e9edf2 0%,#5d646e 30%,#000000 62%,#00e5ff 100%)',
    dark: true,
    bg: '#000000',
    bgImage: 'radial-gradient(1200px 520px at 50% -18%, rgba(190,205,225,0.07), transparent 70%), radial-gradient(900px 600px at 50% 120%, rgba(0,229,255,0.035), transparent 70%), #000000',
    glass: 'rgba(5,6,8,0.94)',
    glassStrong: 'rgba(7,8,10,0.97)',
    glassBorder: 'rgba(214,222,235,0.10)',
    glassHi: 'rgba(255,255,255,0.05)',
    shadow: '0 1px 2px rgba(0,0,0,0.8), 0 10px 30px rgba(0,0,0,0.6)',
    control: 'rgba(255,255,255,0.03)',
    raised: 'rgba(255,255,255,0.055)',
    border: 'rgba(214,222,235,0.09)',
    border2: 'rgba(214,222,235,0.18)',
    text: '#eef1f5',
    muted: '#8c939e',
    faint: '#4f5560',
    buy: '#2cf0b0',
    sell: '#ff3d7f',
    accent: '#38e1ff',
    warn: '#ffc53d',
    poc: '#f5c542',
    glow: 'rgba(56,225,255,0.30)',
    canvasTint: 'rgba(0,0,0,0)',
    grid: 'rgba(214,222,235,0.045)',
    header: 'rgba(255,255,255,0.03)',
    rowAlt: 'rgba(255,255,255,0.014)',
    cell: 'rgba(0,0,0,0.4)',
    cellSpread: 'rgba(255,255,255,0.045)',
    tooltip: 'rgba(6,7,9,0.97)',
    tabbar: 'rgba(255,255,255,0.018)',
    rowLine: 'rgba(214,222,235,0.05)',
    accentSoft: 'rgba(56,225,255,0.10)',
    focus: 'rgba(56,225,255,0.30)',
    onAccent: '#001218',
    ramp: [
      [6, 10, 22],
      [20, 40, 90],
      [0, 150, 210],
      [56, 225, 255],
      [210, 120, 255],
      [255, 61, 127],
      [255, 255, 255],
    ],
    swarm: { a: '#38e1ff', b: '#ff3d7f', metal: '#e4eaf4', up: '#2cf0b0' },
  }),
  // Solana's own colours: violet into sea green
  solana: swarmTheme({
    id: 'solana',
    name: 'Solana',
    swatch: 'linear-gradient(135deg,#9945ff 0%,#5a3fd8 40%,#06040c 62%,#14f195 100%)',
    bg: '#04030a',
    glow1: 'rgba(153,69,255,0.10)',
    glow2: 'rgba(20,241,149,0.05)',
    tint: [176, 140, 255],
    text: '#f0ecff',
    muted: '#968fae',
    faint: '#544d6b',
    buy: '#14f195',
    sell: '#ff4d8d',
    accent: '#a479ff',
    warn: '#ffd166',
    onAccent: '#0d0420',
    look: {
      a: '#9945ff',
      b: '#14f195',
      metal: '#ece6ff',
      up: '#14f195',
      gauges: ['#b18cff', '#9a7bff', '#7d6cff', '#5f86ff', '#3fa4f5', '#22bfe0', '#19d6c0', '#14e8a2', '#14f195', '#ddd6ff'],
      chrome: metal('#ffffff', '#d8ccff', '#5b4a8a', '#f1ecff', '#a99ad6', 'rgba(210, 190, 255, 0.95)', 'rgba(153, 69, 255, 0.5)', 'linear-gradient(180deg, #ffffff 0%, #ece6ff 40%, #b9aee0 100%)'),
    },
    ramp: [
      [6, 4, 16],
      [40, 20, 90],
      [120, 60, 230],
      [153, 69, 255],
      [60, 170, 230],
      [20, 241, 149],
      [255, 255, 255],
    ],
  }),
  // black and gold: champagne metal, warm lights
  gold: swarmTheme({
    id: 'gold',
    name: 'Midnight Gold',
    swatch: 'linear-gradient(135deg,#fff1c9 0%,#d4af37 32%,#050403 64%,#b38728 100%)',
    bg: '#050403',
    glow1: 'rgba(212,175,55,0.09)',
    glow2: 'rgba(212,175,55,0.035)',
    tint: [230, 196, 110],
    text: '#f6efe0',
    muted: '#a8997a',
    faint: '#5e5440',
    buy: '#5fd4a0',
    sell: '#e0645a',
    accent: '#e2bd55',
    warn: '#f0c85a',
    onAccent: '#1a1203',
    look: {
      a: '#e8c66a',
      b: '#b88a2e',
      metal: '#f7ead0',
      up: '#f2d98f',
      gauges: ['#f2d27a', '#e8b84a', '#d99a3d', '#c27c45', '#e3a68f', '#c9b27a', '#f0e2b6', '#fff3d6', '#d9735a', '#b49a6e'],
      chrome: metal('#fff8e4', '#e2c27a', '#7a5a1a', '#f8ecc8', '#b8924a', 'rgba(255, 228, 160, 0.95)', 'rgba(212, 175, 55, 0.55)', 'linear-gradient(180deg, #fff8e4 0%, #f2dfa8 40%, #c9a456 100%)'),
    },
    ramp: [
      [10, 8, 4],
      [50, 36, 12],
      [120, 88, 30],
      [212, 175, 55],
      [240, 210, 130],
      [255, 238, 190],
      [255, 255, 255],
    ],
  }),
  // deep navy and ice
  arctic: swarmTheme({
    id: 'arctic',
    name: 'Arctic',
    swatch: 'linear-gradient(135deg,#ffffff 0%,#9be7ff 32%,#030810 64%,#4f8dff 100%)',
    bg: '#02060d',
    glow1: 'rgba(155,231,255,0.09)',
    glow2: 'rgba(79,141,255,0.05)',
    tint: [170, 215, 255],
    text: '#eef6ff',
    muted: '#8ea2b8',
    faint: '#4a5a6c',
    buy: '#7ff2d6',
    sell: '#ff6b8a',
    accent: '#8fdcff',
    warn: '#ffd27a',
    onAccent: '#021018',
    look: {
      a: '#9be7ff',
      b: '#4f8dff',
      metal: '#f2f8ff',
      up: '#bff4ff',
      gauges: ['#bfefff', '#8fd8ff', '#ff8fb0', '#7fe0d8', '#a9b8ff', '#9fe6b8', '#ffd98a', '#eef6ff', '#ff9a7a', '#7fa3cc'],
      chrome: metal('#ffffff', '#d4ecff', '#5c7a99', '#eef7ff', '#9cb8d6', 'rgba(200, 235, 255, 0.95)', 'rgba(130, 200, 255, 0.55)', 'linear-gradient(180deg, #ffffff 0%, #e6f4ff 40%, #a9c4de 100%)'),
    },
    ramp: [
      [2, 8, 18],
      [10, 40, 80],
      [40, 110, 200],
      [120, 200, 255],
      [190, 235, 255],
      [235, 248, 255],
      [255, 255, 255],
    ],
  }),
  // black and blood red, silver type
  crimson: swarmTheme({
    id: 'crimson',
    name: 'Crimson',
    swatch: 'linear-gradient(135deg,#ffffff 0%,#ff2e4d 32%,#070203 64%,#8a0f22 100%)',
    bg: '#060203',
    glow1: 'rgba(255,46,77,0.08)',
    glow2: 'rgba(255,46,77,0.035)',
    tint: [255, 120, 140],
    text: '#f6eef0',
    muted: '#a58c91',
    faint: '#5e4a4e',
    buy: '#3ddc97',
    sell: '#ff2e4d',
    accent: '#ff4d68',
    warn: '#ffb74d',
    onAccent: '#1a0206',
    look: {
      a: '#ff3b5c',
      b: '#c41230',
      metal: '#ffe8eb',
      up: '#ff9aa8',
      gauges: ['#ff5a6e', '#ff8a7a', '#ff2e4d', '#e8e1e2', '#ffb3b8', '#c4a3a8', '#ff6f3c', '#f4ecee', '#b3132c', '#a8868c'],
      chrome: metal('#ffffff', '#e2cfd2', '#6e2a33', '#f6eef0', '#ab8a90', 'rgba(255, 170, 180, 0.9)', 'rgba(255, 46, 77, 0.45)', 'linear-gradient(180deg, #ffffff 0%, #f6e8ea 40%, #c9a9ae 100%)'),
    },
    ramp: [
      [12, 2, 4],
      [60, 6, 14],
      [140, 14, 32],
      [255, 46, 77],
      [255, 140, 150],
      [255, 210, 214],
      [255, 255, 255],
    ],
  }),
  // a night drive: hot pink, violet, cyan, a sunset gold
  synthwave: swarmTheme({
    id: 'synthwave',
    name: 'Synthwave',
    swatch: 'linear-gradient(135deg,#ff3d9a 0%,#9d4dff 34%,#0b0414 62%,#2de2e6 100%)',
    bg: '#07030f',
    glow1: 'rgba(255,61,154,0.09)',
    glow2: 'rgba(45,226,230,0.05)',
    tint: [220, 140, 255],
    text: '#fbeeff',
    muted: '#a48fb4',
    faint: '#5a4868',
    buy: '#2de2e6',
    sell: '#ff3d9a',
    accent: '#ff5fb8',
    warn: '#ffd23d',
    onAccent: '#1a0412',
    look: {
      a: '#ff3d9a',
      b: '#2de2e6',
      metal: '#ffe8ff',
      up: '#ffd23d',
      gauges: ['#2de2e6', '#6a5cff', '#ff3d9a', '#3df2b1', '#c774e8', '#9dff6a', '#ffd23d', '#f5e6ff', '#ff9e3d', '#9d8cff'],
      chrome: metal('#ffffff', '#f0c8ff', '#5a2a7a', '#fff0ff', '#c08ad8', 'rgba(255, 170, 245, 0.9)', 'rgba(255, 61, 154, 0.5)', 'linear-gradient(180deg, #ffffff 0%, #fbe6ff 40%, #d2a6e6 100%)'),
    },
    ramp: [
      [10, 4, 20],
      [60, 20, 110],
      [157, 77, 255],
      [255, 61, 154],
      [255, 158, 61],
      [255, 210, 61],
      [255, 255, 255],
    ],
  }),
  grey: build({
    id: 'grey',
    name: 'Grey',
    swatch: 'linear-gradient(135deg,#5a5f68,#2a2d33)',
    dark: true,
    bg: '#24272c',
    bgImage: 'linear-gradient(180deg, #2a2d33 0%, #222429 100%)',
    glass: 'rgba(46,49,55,0.94)',
    glassStrong: 'rgba(44,47,53,0.97)',
    glassBorder: 'rgba(255,255,255,0.08)',
    glassHi: 'rgba(255,255,255,0.05)',
    shadow: '0 1px 2px rgba(0,0,0,0.25), 0 6px 18px rgba(0,0,0,0.18)',
    control: 'rgba(255,255,255,0.04)',
    raised: 'rgba(255,255,255,0.07)',
    border: 'rgba(255,255,255,0.08)',
    border2: 'rgba(255,255,255,0.16)',
    text: '#e7e9ec',
    muted: '#9aa1ab',
    faint: '#6b717b',
    buy: '#2ebd85',
    sell: '#f6465d',
    accent: '#5b9cff',
    warn: '#f0b90b',
    poc: '#f5c542',
    glow: 'rgba(91,156,255,0.3)',
    canvasTint: 'rgba(0,0,0,0)',
    grid: 'rgba(255,255,255,0.045)',
    header: 'rgba(255,255,255,0.035)',
    rowAlt: 'rgba(255,255,255,0.018)',
    cell: 'rgba(0,0,0,0.12)',
    cellSpread: 'rgba(255,255,255,0.05)',
    tooltip: 'rgba(32,34,39,0.97)',
    tabbar: 'rgba(255,255,255,0.025)',
    rowLine: 'rgba(255,255,255,0.045)',
    accentSoft: 'rgba(91,156,255,0.12)',
    focus: 'rgba(91,156,255,0.28)',
    onAccent: '#ffffff',
  }),
  white: build({
    id: 'white',
    name: 'White',
    swatch: 'linear-gradient(135deg,#ffffff,#dfe3e8)',
    dark: false,
    bg: '#eceef1',
    bgImage: 'linear-gradient(180deg, #f1f3f5 0%, #e6e9ed 100%)',
    glass: 'rgba(255,255,255,0.95)',
    glassStrong: 'rgba(255,255,255,0.97)',
    glassBorder: 'rgba(15,23,42,0.09)',
    glassHi: 'rgba(255,255,255,1)',
    shadow: '0 1px 2px rgba(15,23,42,0.06), 0 6px 18px rgba(15,23,42,0.06)',
    control: 'rgba(15,23,42,0.035)',
    raised: 'rgba(15,23,42,0.06)',
    border: 'rgba(15,23,42,0.09)',
    border2: 'rgba(15,23,42,0.18)',
    text: '#14171c',
    muted: '#5b6370',
    faint: '#9aa1ab',
    buy: '#089981',
    sell: '#e5374d',
    accent: '#2563eb',
    warn: '#c98a00',
    poc: '#b8860b',
    glow: 'rgba(37,99,235,0.2)',
    canvasTint: 'rgba(0,0,0,0)',
    grid: 'rgba(15,23,42,0.06)',
    header: 'rgba(15,23,42,0.035)',
    rowAlt: 'rgba(15,23,42,0.018)',
    cell: 'rgba(15,23,42,0.025)',
    cellSpread: 'rgba(15,23,42,0.06)',
    tooltip: 'rgba(255,255,255,0.98)',
    tabbar: 'rgba(15,23,42,0.025)',
    rowLine: 'rgba(15,23,42,0.06)',
    accentSoft: 'rgba(37,99,235,0.1)',
    focus: 'rgba(37,99,235,0.22)',
    onAccent: '#ffffff',
    swarm: { gauges: ['#0891b2', '#2563eb', '#db2777', '#059669', '#7c3aed', '#65a30d', '#ca8a04', '#475569', '#ea580c', '#64748b'] },
  }),
  black: build({
    id: 'black',
    name: 'Black',
    swatch: 'linear-gradient(135deg,#2a2c31,#000000)',
    dark: true,
    bg: '#08090b',
    bgImage: 'linear-gradient(180deg, #0c0d10 0%, #060708 100%)',
    glass: 'rgba(18,19,22,0.95)',
    glassStrong: 'rgba(20,21,24,0.97)',
    glassBorder: 'rgba(255,255,255,0.07)',
    glassHi: 'rgba(255,255,255,0.04)',
    shadow: '0 1px 2px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.4)',
    control: 'rgba(255,255,255,0.035)',
    raised: 'rgba(255,255,255,0.06)',
    border: 'rgba(255,255,255,0.07)',
    border2: 'rgba(255,255,255,0.14)',
    text: '#e8eaed',
    muted: '#8b919a',
    faint: '#565b63',
    buy: '#2ebd85',
    sell: '#f6465d',
    accent: '#6ea8ff',
    warn: '#f0b90b',
    poc: '#f5c542',
    glow: 'rgba(110,168,255,0.28)',
    canvasTint: 'rgba(0,0,0,0)',
    grid: 'rgba(255,255,255,0.04)',
    header: 'rgba(255,255,255,0.03)',
    rowAlt: 'rgba(255,255,255,0.015)',
    cell: 'rgba(0,0,0,0.25)',
    cellSpread: 'rgba(255,255,255,0.045)',
    tooltip: 'rgba(14,15,18,0.97)',
    tabbar: 'rgba(255,255,255,0.02)',
    rowLine: 'rgba(255,255,255,0.04)',
    accentSoft: 'rgba(110,168,255,0.12)',
    focus: 'rgba(110,168,255,0.28)',
    onAccent: '#06101f',
  }),
  'neon-green': build({
    id: 'neon-green',
    name: 'Neon Green',
    swatch: 'linear-gradient(135deg,#39ff14,#07100a)',
    dark: true,
    bg: '#050a07',
    bgImage: 'radial-gradient(1400px 500px at 50% -15%, rgba(57,255,20,0.07), transparent 70%), linear-gradient(180deg, #07100a 0%, #040805 100%)',
    glass: 'rgba(9,17,12,0.95)',
    glassStrong: 'rgba(10,19,13,0.97)',
    glassBorder: 'rgba(57,255,20,0.14)',
    glassHi: 'rgba(57,255,20,0.06)',
    shadow: '0 1px 2px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.45)',
    control: 'rgba(57,255,20,0.04)',
    raised: 'rgba(57,255,20,0.08)',
    border: 'rgba(57,255,20,0.11)',
    border2: 'rgba(57,255,20,0.24)',
    text: '#d8f5dc',
    muted: '#7fa886',
    faint: '#46634c',
    buy: '#39ff14',
    sell: '#ff3d6e',
    accent: '#39ff14',
    warn: '#e4ff3a',
    poc: '#e4ff3a',
    glow: 'rgba(57,255,20,0.35)',
    canvasTint: 'rgba(0,0,0,0)',
    grid: 'rgba(57,255,20,0.055)',
    header: 'rgba(57,255,20,0.04)',
    rowAlt: 'rgba(57,255,20,0.02)',
    cell: 'rgba(0,0,0,0.3)',
    cellSpread: 'rgba(57,255,20,0.06)',
    tooltip: 'rgba(6,14,9,0.97)',
    tabbar: 'rgba(57,255,20,0.03)',
    rowLine: 'rgba(57,255,20,0.06)',
    accentSoft: 'rgba(57,255,20,0.1)',
    focus: 'rgba(57,255,20,0.25)',
    onAccent: '#04120a',
    ramp: [
      [2, 14, 6],
      [6, 60, 22],
      [18, 140, 40],
      [57, 255, 20],
      [190, 255, 120],
      [235, 255, 0],
      [255, 255, 255],
    ],
    swarm: { a: '#39ff14', b: '#e4ff3a', metal: '#d8f5dc', up: '#39ff14', gauges: ['#39ff14', '#2ee8a0', '#ff3d6e', '#7dff5a', '#14d4a0', '#b6ff3a', '#e4ff3a', '#d8f5dc', '#ff7a3d', '#6fcf97'] },
  }),
  'neon-orange': build({
    id: 'neon-orange',
    name: 'Neon Orange',
    swatch: 'linear-gradient(135deg,#ff7a00,#140902)',
    dark: true,
    bg: '#0b0603',
    bgImage: 'radial-gradient(1400px 500px at 50% -15%, rgba(255,122,0,0.08), transparent 70%), linear-gradient(180deg, #120904 0%, #080402 100%)',
    glass: 'rgba(20,12,6,0.95)',
    glassStrong: 'rgba(22,13,7,0.97)',
    glassBorder: 'rgba(255,122,0,0.16)',
    glassHi: 'rgba(255,122,0,0.06)',
    shadow: '0 1px 2px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.45)',
    control: 'rgba(255,122,0,0.045)',
    raised: 'rgba(255,122,0,0.09)',
    border: 'rgba(255,122,0,0.12)',
    border2: 'rgba(255,122,0,0.26)',
    text: '#fbe8d6',
    muted: '#bf946f',
    faint: '#6e5038',
    buy: '#00e5c0',
    sell: '#ff3b3b',
    accent: '#ff7a00',
    warn: '#ffd000',
    poc: '#ffd000',
    glow: 'rgba(255,122,0,0.38)',
    canvasTint: 'rgba(0,0,0,0)',
    grid: 'rgba(255,122,0,0.055)',
    header: 'rgba(255,122,0,0.045)',
    rowAlt: 'rgba(255,122,0,0.02)',
    cell: 'rgba(0,0,0,0.3)',
    cellSpread: 'rgba(255,122,0,0.07)',
    tooltip: 'rgba(16,9,4,0.97)',
    tabbar: 'rgba(255,122,0,0.03)',
    rowLine: 'rgba(255,122,0,0.065)',
    accentSoft: 'rgba(255,122,0,0.12)',
    focus: 'rgba(255,122,0,0.28)',
    onAccent: '#1a0b00',
    ramp: [
      [16, 6, 2],
      [70, 22, 4],
      [160, 55, 0],
      [255, 122, 0],
      [255, 190, 60],
      [255, 230, 120],
      [255, 255, 255],
    ],
    swarm: { a: '#ff7a00', b: '#ffd000', metal: '#fbe8d6', up: '#00e5c0', gauges: ['#ff9e3d', '#ffc14d', '#ff3b3b', '#00e5c0', '#ff5a36', '#c8e64a', '#ffd000', '#fbe8d6', '#e85d04', '#d49a6a'] },
  }),
};

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

export const FILTERS: { id: FilterId; name: string; css: string }[] = [
  { id: 'none', name: 'None', css: 'none' },
  { id: 'vivid', name: 'Vivid', css: 'saturate(1.4) contrast(1.08)' },
  { id: 'soft', name: 'Soft', css: 'contrast(0.9) saturate(0.85) brightness(1.04)' },
  { id: 'mono', name: 'Mono', css: 'grayscale(1) contrast(1.05)' },
  { id: 'warm', name: 'Warm', css: 'sepia(0.28) saturate(1.2) hue-rotate(-8deg)' },
  { id: 'cool', name: 'Cool', css: 'saturate(1.1) hue-rotate(12deg) brightness(1.02)' },
  { id: 'night', name: 'Night', css: 'brightness(0.72) contrast(1.06) saturate(0.9)' },
  { id: 'crt', name: 'CRT', css: 'contrast(1.12) saturate(1.15) brightness(1.05)' },
];

/**
 * Glass levels. Cards sit over a static, pre-blurred backdrop, so translucency
 * plus rim and highlights read as glass without a live blur; only "Frosted"
 * adds a real backdrop blur under every card (GPU-heavy while charts animate).
 * Floating overlays (menus, modals, toasts) always blur what is behind them.
 */
export const GLASS_LEVELS: { id: GlassLevel; name: string; blur: number; cardBlur: boolean }[] = [
  { id: 'off', name: 'Solid', blur: 0, cardBlur: false },
  { id: 'light', name: 'Light', blur: 10, cardBlur: false },
  { id: 'medium', name: 'Glass', blur: 16, cardBlur: false },
  { id: 'heavy', name: 'Frosted', blur: 22, cardBlur: true },
];

export function themeOf(id: string | undefined): ThemeDef {
  return THEMES[(id as ThemeId) in THEMES ? (id as ThemeId) : 'grey'];
}

export function palette(): Palette {
  return themeOf(useSettings.getState().theme).pal;
}

/** Push a theme's CSS variables onto the document root. */
export function applyTheme(id: string, filter: FilterId, glass: GlassLevel) {
  const t = themeOf(id);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.css)) root.style.setProperty(k, v);
  for (const [k, v] of Object.entries(t.swarm.chrome)) root.style.setProperty(k, v);
  root.dataset.theme = t.id;
  root.dataset.filter = filter;
  root.dataset.glass = glass;
  root.style.setProperty('--app-filter', FILTERS.find((f) => f.id === filter)?.css ?? 'none');
  const level = GLASS_LEVELS.find((g) => g.id === glass) ?? GLASS_LEVELS[2];
  root.style.setProperty('--blur', `${level.blur}px`);
  root.style.setProperty('--card-backdrop', level.cardBlur ? `blur(${level.blur}px) saturate(170%)` : 'none');
  root.style.setProperty('--panel-fill', glass === 'off' ? 'var(--glass-strong)' : 'var(--glass)');
}

/** Black or white text, whichever reads better on a #rrggbb background. */
export function ink(bg: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(bg)) return '#fff';
  const [r, g, b] = hexRgb(bg).map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#000' : '#fff';
}

export const rgba = (rgb: [number, number, number], a: number) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`;

export const VENUE_COLORS: Record<string, string> = {
  binancef: '#f0b90b',
  binance: '#c99a0a',
  bybit: '#f7a600',
  okx: '#cfd3dc',
  hyperliquid: '#50e3c2',
  coinbase: '#3f7bff',
  kraken: '#8d5cff',
  bitget: '#00d4e6',
  bitfinex: '#16b157',
  ccxt: '#7f8cff',
  sim: '#b39ddb',
};
