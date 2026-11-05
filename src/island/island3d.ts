// The market island — a living world that is the whole crypto terminal.
//
//   the land      a large island in a moving low-poly sea: beaches, green
//                 hills, rock. In its central valley the market itself: the
//                 order book as mountains (walls of resting orders rise as
//                 peaks), the price as a glowing river that flows toward the
//                 orb of the price now, trades as lights where they printed
//   the Council   a domed hall on a plaza where the swarm's eight agents stand
//                 as little minions. When the swarm debates, the one proposing
//                 walks to the podium and speaks, the others step up and vote
//                 in turn, and the hall flashes green (trade) or red (no). Each
//                 minion's gauge glows as a ring on the ground beneath it
//   the Exchange  a district of glass towers: the live order book (bids cyan,
//                 asks orange), each tower as tall as the depth at its level
//   the Fields    terraced crops that grow with the volume traded at each
//                 price; the busiest row (the point of control) glows gold
//   the Harbor    big trades sail in as lit boats (gold buys, red sells)
//   the Lighthouse its beam turns faster, and the sea runs higher, as
//                 volatility rises
//
// Hover anything to peek, click it to fly there (its reading floats beside it);
// click the sea or press Esc to fly back. Drag to orbit, scroll to zoom,
// WASD / arrows to glide, Q / E to turn. One canvas, 30 frames a second.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Light, Terrain, Window } from './model';

// the market valley in the middle of the island
const W = 16; // price across
const D = 11; // time, back (old) to front (now)
const HS = 3.0; // height scale of the order-book mountains
const BASIN = 0.18; // the valley floor
// the island
const RX = 30;
const RZ = 21;
// the market lake: an oval round the order book (its corners sink under the land)
const VA = W / 2 + 1.2;
const VB = D / 2 + 1.2;
const lakeQ = (x: number, z: number) => Math.hypot(x / VA, z / VB);

export interface IslandPosition {
  id: string;
  side: 'buy' | 'sell';
  entry: number;
  stop: number;
  target: number;
  label: string;
}
export interface IslandAgent {
  id: string;
  name: string;
  value: number;
  text: string;
  sub: string;
}
/** something an agent (or the council) said since the last frame */
export interface IslandSay {
  agent: string;
  text: string;
  kind: string;
}
export interface IslandFrame {
  terrain: Terrain;
  window: Window;
  lights: Light[];
  price: number | null;
  positions: IslandPosition[];
  agents: IslandAgent[];
  said: IslandSay[];
  running: boolean;
  book: { bids: number[]; asks: number[] };
  ridge: { v: Float32Array; cols: number; slices: number; poc: number };
  /** realised volatility, a year (0.6 = 60 %) */
  vol: number | null;
  /** the biggest trades of the last second, for the harbour */
  boats: { buy: boolean; usd: number }[];
  /** one line under each place's name */
  tags: Partial<Record<Place, string>>;
}
export interface Peek {
  x: number;
  y: number;
  title: string;
  lines: string[];
  tone?: 'buy' | 'sell' | 'info';
}
export type Place = 'exchange' | 'fields' | 'harbor' | 'lighthouse' | 'council' | 'price' | `agent:${string}`;
export const PLACE_NAME: Record<string, string> = { exchange: 'The Exchange', fields: 'The Fields', harbor: 'The Harbor', lighthouse: 'The Lighthouse', council: 'The Council', price: 'Price' };
export const PLACE_ROLE: Record<string, string> = { exchange: 'order book', fields: 'volume profile', harbor: 'the tape', lighthouse: 'volatility', council: 'the swarm', price: 'the river' };
const HUES = ['#ff7a45', '#ffc04d', '#4dffa6', '#4de3ff', '#5a8cff', '#b95aff', '#ff5ac8', '#e8eef8'];

const fmt = (p: number) => p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 1 : p >= 10 ? 2 : 4 });
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// value noise for the island's hills
const hash = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
function noise(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x: number, y: number) => noise(x, y) * 0.55 + noise(x * 2.1, y * 2.1) * 0.28 + noise(x * 4.3, y * 4.3) * 0.17;

// where things stand
const SITES = {
  council: new THREE.Vector3(0, 0, -14.6),
  exchange: new THREE.Vector3(-15.5, 0, -2),
  fields: new THREE.Vector3(15.5, 0, -3),
  harbor: new THREE.Vector3(9, 0, 15.5),
  lighthouse: new THREE.Vector3(-17, 0, 11),
};
const PODIUM = 2.9; // the council's podium, in front of the hall
const FLAT: [THREE.Vector3, number][] = [
  [new THREE.Vector3(0, 0, -12.4), 7.4],
  [SITES.exchange, 4.6],
  [SITES.fields, 4.4],
  [SITES.lighthouse, 2.2],
];

/** The island's height at x, z (world units; the sea is 0). */
export function landHeight(x: number, z: number): number {
  const a = Math.atan2(z / RZ, x / RX);
  const coast = 1 + 0.07 * Math.sin(a * 5 + 0.7) + 0.045 * Math.sin(a * 11 + 2.1) + 0.025 * Math.sin(a * 19);
  const e = Math.hypot(x / RX, z / RZ) / coast;
  if (e > 1.04) return -1.2;
  const inland = smooth(1.0, 0.8, e);
  let h = inland * (0.25 + 2.4 * Math.pow(fbm(x * 0.08 + 3.1, z * 0.08 - 1.7), 1.6)) - (1 - smooth(1.04, 0.96, e)) * 1.2;
  // the market valley, an oval between low green banks
  const out = smooth(0.96, 1.5, lakeQ(x, z));
  h = BASIN + (h - BASIN) * out;
  // level ground where the buildings stand
  for (const [p, r] of FLAT) {
    const d = Math.hypot(x - p.x, z - p.z);
    const k = smooth(r, r * 0.6, d);
    if (k > 0) h = h + (Math.max(0.35, landAt(p.x, p.z)) - h) * k;
  }
  return h;
}
// the height under a site before levelling (no recursion through FLAT)
function landAt(x: number, z: number) {
  const a = Math.atan2(z / RZ, x / RX);
  const coast = 1 + 0.07 * Math.sin(a * 5 + 0.7) + 0.045 * Math.sin(a * 11 + 2.1) + 0.025 * Math.sin(a * 19);
  const e = Math.hypot(x / RX, z / RZ) / coast;
  return smooth(1.0, 0.8, e) * (0.25 + 0.9 * fbm(x * 0.08 + 3.1, z * 0.08 - 1.7));
}

// the valley's colours by height, as in a relief map at night
const STOPS: [number, THREE.Color][] = [
  [0.0, new THREE.Color('#1d5a3e')],
  [0.12, new THREE.Color('#2f7d2c')],
  [0.24, new THREE.Color('#8fb83a')],
  [0.36, new THREE.Color('#d9b443')],
  [0.5, new THREE.Color('#d9762b')],
  [0.66, new THREE.Color('#8c3a17')],
  [0.82, new THREE.Color('#3a1a0c')],
  [1.0, new THREE.Color('#1c0d06')],
];
export function heightColor(h: number, out = new THREE.Color()): THREE.Color {
  if (h <= STOPS[0][0]) return out.copy(STOPS[0][1]);
  for (let i = 1; i < STOPS.length; i++)
    if (h <= STOPS[i][0]) {
      const [a, ca] = STOPS[i - 1];
      const [b, cb] = STOPS[i];
      return out.copy(ca).lerp(cb, (h - a) / (b - a));
    }
  return out.copy(STOPS[STOPS.length - 1][1]);
}
// the island's colours: wet sand, beach, grass, forest, rock
function landColor(h: number, slope: number, out = new THREE.Color()): THREE.Color {
  if (h < 0.05) return out.set('#3d4a52');
  if (h < 0.3) return out.set('#c9b07a').lerp(new THREE.Color('#9fb05a'), smooth(0.12, 0.3, h));
  out.set('#3f8a3a').lerp(new THREE.Color('#2b6630'), smooth(0.6, 1.6, h));
  if (slope > 0.55 || h > 2.2) out.lerp(new THREE.Color('#6d6152'), smooth(0.55, 0.9, slope) * 0.8 + smooth(2.2, 2.8, h) * 0.6);
  return out;
}

const MEADOW = new THREE.Color('#2c6b35');

function glowPoints(scale: number) {
  return new THREE.ShaderMaterial({
    vertexShader: `attribute float size; varying vec3 vColor; uniform float uScale;
      void main(){ vColor = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * uScale / -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec3 vColor; void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard; float a = pow(smoothstep(0.5, 0.0, r), 1.8); gl_FragColor = vec4(vColor * (0.6 + a), a); }`,
    uniforms: { uScale: { value: scale } },
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

interface Minion {
  id: string;
  group: THREE.Group;
  body: THREE.Mesh;
  eye: THREE.Mesh;
  arc: THREE.Mesh;
  home: THREE.Vector3;
  target: THREE.Vector3;
  hue: THREE.Color;
  value: number;
  tag: HTMLDivElement;
  bubble: HTMLDivElement;
  hop: number;
}
interface Boat {
  mesh: THREE.Group;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  dur: number;
}

export class Island {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
  private controls: OrbitControls;
  private clock0 = performance.now();
  private seaMat: THREE.MeshStandardMaterial;
  private seaUniforms = { uTime: { value: 0 }, uAmp: { value: 0.18 } };
  private valleyGeo: THREE.BufferGeometry | null = null;
  private valley: THREE.Mesh | null = null;
  private valleyMat: THREE.MeshStandardMaterial;
  private river = new THREE.Group();
  private riverMat: THREE.ShaderMaterial;
  private orb: THREE.Mesh;
  private orbLight: THREE.PointLight;
  private lights: THREE.Points;
  private fences = new THREE.Group();
  private towers!: { bars: THREE.InstancedMesh; caps: THREE.InstancedMesh; h: Float32Array; target: Float32Array; side: Uint8Array };
  private crops!: { mesh: THREE.InstancedMesh; h: Float32Array; target: Float32Array; poc: number; rows: number; cols: number };
  private beam!: THREE.Group;
  private beamSpeed = 0.4;
  private hallLight!: THREE.PointLight;
  private hallDome!: THREE.Mesh;
  private verdict: { trade: boolean; until: number; text: string } | null = null;
  private banner: HTMLDivElement;
  private minions: Minion[] = [];
  private queue: { i: number; text: string; kind: string }[] = [];
  private speaking: { i: number; until: number } | null = null;
  private running = false;
  private boats: Boat[] = [];
  private boatPool: THREE.Group[] = [];
  private picks: THREE.Object3D[] = [];
  private frame: IslandFrame | null = null;
  private labels: HTMLDivElement;
  private priceTag: HTMLDivElement;
  private placeTags = new Map<Place, HTMLDivElement>();
  private raycaster = new THREE.Raycaster();
  private pointer = { x: 0, y: 0, inside: false, moved: false, downX: 0, downY: 0 };
  private keys = new Set<string>();
  private fly: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; at: number } | null = null;
  private selected: Place | null = null;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private w = 1;
  private h = 1;
  private ro: ResizeObserver;
  private disposed = false;
  /** the floating reading of the selected place, placed beside it every frame */
  detail: HTMLElement | null = null;
  /** the leader line from the place to its reading */
  leader: SVGLineElement | null = null;
  static HOME_POS = new THREE.Vector3(0, 27, 33);
  static HOME_TARGET = new THREE.Vector3(0, 0, 0.5);

  constructor(
    private host: HTMLElement,
    private onPeek: (p: Peek | null) => void,
    private onSelect: (place: Place | null) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x050b18, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    const el = this.renderer.domElement;
    el.className = 'island-canvas';
    el.tabIndex = 0;
    host.appendChild(el);
    this.labels = document.createElement('div');
    this.labels.className = 'island-labels';
    host.appendChild(this.labels);
    this.priceTag = this.tag('island-price');
    this.banner = this.tag('island-banner');

    // a night sky that meets the sea
    this.scene.background = new THREE.Color(0x050b18);
    this.scene.fog = new THREE.Fog(0x050b18, 45, 120);
    this.camera.position.copy(Island.HOME_POS);
    this.controls = new OrbitControls(this.camera, el);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 70;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.target.copy(Island.HOME_TARGET);
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.1;
    this.controls.addEventListener('start', () => {
      this.controls.autoRotate = false;
      this.fly = null;
    });

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.45, 0.8);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.scene.add(new THREE.HemisphereLight(0x8fb4ff, 0x1a1408, 1.15));
    const moon = new THREE.DirectionalLight(0xc8d8ff, 1.3);
    moon.position.set(12, 30, 18);
    this.scene.add(moon);
    const sunset = new THREE.DirectionalLight(0xff9a4a, 1.6);
    sunset.position.set(-30, 8, -12);
    this.scene.add(sunset);

    // the sea: a moving, faceted low-poly surface; it runs higher with volatility
    const seaGeo = new THREE.PlaneGeometry(260, 260, 130, 130);
    seaGeo.rotateX(-Math.PI / 2);
    this.seaMat = new THREE.MeshStandardMaterial({ color: 0x0d4a86, roughness: 0.35, metalness: 0.25, flatShading: true });
    this.seaMat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.seaUniforms.uTime;
      sh.uniforms.uAmp = this.seaUniforms.uAmp;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uAmp;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float w = sin(position.x * 0.32 + uTime * 0.9) * 0.5 + sin(position.z * 0.41 + uTime * 1.2) * 0.35 + sin((position.x - position.z) * 0.9 + uTime * 2.0) * 0.15;
          transformed.y += w * uAmp;`);
    };
    const sea = new THREE.Mesh(seaGeo, this.seaMat);
    sea.userData.peek = 'sea';
    this.scene.add(sea);
    this.picks.push(sea);

    this.buildLand();

    // the market valley: the order book as mountains (no grid, only faint contour lines)
    this.valleyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05 });
    this.valleyMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vY;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvY = (modelMatrix * vec4(transformed,1.0)).y;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vY;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          float c = abs(fract(vY * 2.5) - 0.5); totalEmissiveRadiance += vec3(1.0, 0.6, 0.25) * (1.0 - smoothstep(0.0, 0.04, c)) * 0.05 * step(0.9, vY);`);
    };

    // the river of price: pulses flow toward the price now
    this.riverMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec2 vUv; uniform float uTime;
        void main(){ float p = pow(fract(vUv.x * 26.0 - uTime * 0.9), 5.0); vec3 c = vec3(0.15, 0.45, 1.0) * (0.55 + 1.6 * p) + vec3(0.6,0.85,1.0) * p * 0.6; gl_FragColor = vec4(c, 1.0); }`,
    });
    this.scene.add(this.river);
    this.orb = new THREE.Mesh(new THREE.SphereGeometry(0.24, 24, 16), new THREE.MeshBasicMaterial({ color: 0xcfe9ff }));
    this.orb.userData.place = 'price';
    this.orbLight = new THREE.PointLight(0x4aa3ff, 4, 6, 1.6);
    this.scene.add(this.orb, this.orbLight);
    this.picks.push(this.orb);
    this.lights = new THREE.Points(new THREE.BufferGeometry(), glowPoints(200));
    this.scene.add(this.lights, this.fences);

    this.buildExchange();
    this.buildFields();
    this.buildHarbor();
    this.buildLighthouse();
    this.buildCouncil();

    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('click', this.onClick);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.raf = requestAnimationFrame(this.loop);
  }

  private tag(cls: string) {
    const d = document.createElement('div');
    d.className = cls;
    this.labels.appendChild(d);
    return d;
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.renderer.setSize(this.w, this.h, false);
    this.composer.setSize(this.w, this.h);
    this.bloom.resolution.set(this.w / 2, this.h / 2);
    this.camera.aspect = this.w / this.h;
    this.camera.updateProjectionMatrix();
  }

  /** A click volume for a place (invisible). */
  private hit(at: THREE.Vector3, place: Place, r: number, h: number) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 12), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    m.position.set(at.x, at.y + h / 2, at.z);
    m.userData.place = place;
    this.scene.add(m);
    this.picks.push(m);
    this.placeTags.set(place, this.tag('island-place'));
  }

  // ---------- the land ----------

  private buildLand() {
    const S = 2 * RX + 12;
    const T = 2 * RZ + 12;
    const nx = 190;
    const nz = 140;
    const g = new THREE.PlaneGeometry(S, T, nx, nz);
    g.rotateX(-Math.PI / 2);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const q = lakeQ(x, z);
      const inValley = q < 0.94 && Math.abs(x) < W / 2 - 0.2 && Math.abs(z) < D / 2 - 0.2;
      const h = inValley ? BASIN - 0.25 : landHeight(x, z);
      pos.setY(i, h);
      const slope = Math.abs(landHeight(x + 0.6, z) - landHeight(x - 0.6, z)) + Math.abs(landHeight(x, z + 0.6) - landHeight(x, z - 0.6));
      landColor(h, slope, c);
      // the lake's banks are meadow, not beach
      if (q < 1.6) c.lerp(MEADOW, smooth(1.6, 1.0, q) * 0.9);
      col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const land = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.0, flatShading: true }));
    land.userData.peek = 'land';
    this.scene.add(land);
    this.picks.push(land);
    // trees on the hills: little cones, scattered by the noise
    const trees: THREE.Matrix4[] = [];
    for (let k = 0; k < 900 && trees.length < 260; k++) {
      const x = (hash(k, 1.3) - 0.5) * 2 * RX;
      const z = (hash(k, 7.9) - 0.5) * 2 * RZ;
      const h = landHeight(x, z);
      if (h < 0.5 || h > 2.3) continue;
      if (lakeQ(x, z) < 1.3) continue;
      if (Object.values(SITES).some((p) => Math.hypot(x - p.x, z - p.z) < 5.5)) continue;
      const s = 0.5 + hash(k, 3.3) * 0.7;
      trees.push(new THREE.Matrix4().makeScale(s, s * (1.2 + hash(k, 5) * 0.6), s).setPosition(x, h + 0.45 * s, z));
    }
    const forest = new THREE.InstancedMesh(new THREE.ConeGeometry(0.35, 1.0, 6), new THREE.MeshStandardMaterial({ color: 0x1f5a2c, roughness: 0.9, flatShading: true }), trees.length);
    trees.forEach((m, i) => forest.setMatrixAt(i, m));
    this.scene.add(forest);
    // fireflies drifting over the land
    const n = 160;
    const fp = new Float32Array(n * 3);
    const fc = new Float32Array(n * 3);
    const fs = new Float32Array(n).fill(0.7);
    for (let i = 0; i < n; i++) {
      const x = (hash(i, 9.1) - 0.5) * 2 * RX * 0.9;
      const z = (hash(i, 4.4) - 0.5) * 2 * RZ * 0.9;
      fp.set([x, Math.max(0.3, landHeight(x, z)) + 0.8 + hash(i, 2) * 2, z], i * 3);
      fc.set([1, 0.82, 0.45], i * 3);
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(fp, 3));
    fg.setAttribute('color', new THREE.BufferAttribute(fc, 3));
    fg.setAttribute('size', new THREE.BufferAttribute(fs, 1));
    const flies = new THREE.Points(fg, glowPoints(90));
    flies.name = 'flies';
    this.scene.add(flies);
  }

  // ---------- the places ----------

  private buildExchange() {
    const at = SITES.exchange.clone();
    at.y = landHeight(at.x, at.z);
    const N = 24;
    const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25, metalness: 0.6 }), N);
    // glowing window bands up the towers
    (bars.material as THREE.MeshStandardMaterial).onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWp;\nvarying vec3 vTint;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWp = (modelMatrix * instanceMatrix * vec4(transformed,1.0)).xyz;\n#ifdef USE_INSTANCING_COLOR\nvTint = instanceColor;\n#else\nvTint = vec3(1.0);\n#endif');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWp;\nvarying vec3 vTint;').replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float band = step(0.62, fract(vWp.y * 3.2)) * step(0.25, fract(vWp.x * 2.6 + vWp.z * 2.6));
        totalEmissiveRadiance += vTint * band * 0.9 + vTint * 0.06;`);
    };
    const caps = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), N);
    this.scene.add(bars, caps);
    const side = new Uint8Array(N);
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      side[i] = i < N / 2 ? 0 : 1;
      bars.setColorAt(i, side[i] ? c.set('#ff8a3d') : c.set('#2fd6ff'));
      caps.setColorAt(i, side[i] ? c.set('#ff9a52') : c.set('#52e0ff'));
    }
    this.towers = { bars, caps, h: new Float32Array(N).fill(0.8), target: new Float32Array(N).fill(0.8), side };
    this.hit(at, 'exchange', 4.4, 5);
  }

  private placeTowers(dt: number) {
    const T = this.towers;
    const at = SITES.exchange;
    const y0 = landHeight(at.x, at.z);
    const m = new THREE.Matrix4();
    const N = T.h.length;
    for (let i = 0; i < N; i++) {
      T.h[i] += (T.target[i] - T.h[i]) * (1 - Math.exp(-dt * 3));
      // bids on the west side of the avenue, asks on the east; nearest the price at the front
      const k = i % (N / 2);
      const x = at.x + (T.side[i] ? 1.1 : -1.1) + (T.side[i] ? 1 : -1) * (k % 3) * 0.95;
      const z = at.z + 3.2 - Math.floor(k / 3) * 1.6;
      m.makeScale(0.78, T.h[i], 0.78).setPosition(x, y0 + 0.1 + T.h[i] / 2, z);
      T.bars.setMatrixAt(i, m);
      m.makeScale(0.5, 0.06, 0.5).setPosition(x, y0 + 0.1 + T.h[i] + 0.03, z);
      T.caps.setMatrixAt(i, m);
    }
    T.bars.instanceMatrix.needsUpdate = true;
    T.caps.instanceMatrix.needsUpdate = true;
  }

  private buildFields() {
    const at = SITES.fields.clone();
    at.y = landHeight(at.x, at.z);
    const rows = 16;
    const cols = 8;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 }), rows * cols);
    (mesh.material as THREE.MeshStandardMaterial).onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vTint;').replace('#include <begin_vertex>', '#include <begin_vertex>\n#ifdef USE_INSTANCING_COLOR\nvTint = instanceColor;\n#else\nvTint = vec3(1.0);\n#endif');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vTint;').replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vTint * 0.18;');
    };
    this.scene.add(mesh);
    this.crops = { mesh, h: new Float32Array(rows * cols).fill(0.05), target: new Float32Array(rows * cols).fill(0.05), poc: -1, rows, cols };
    this.hit(at, 'fields', 4.2, 3);
  }

  private placeCrops(dt: number, t: number) {
    const C = this.crops;
    const at = SITES.fields;
    const y0 = landHeight(at.x, at.z) + 0.1;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const c = new THREE.Color();
    for (let r = 0; r < C.rows; r++)
      for (let k = 0; k < C.cols; k++) {
        const i = r * C.cols + k;
        C.h[i] += (C.target[i] - C.h[i]) * (1 - Math.exp(-dt * 2));
        const sway = Math.sin(t * 1.4 + r * 0.6 + k * 0.3) * 0.06;
        q.setFromEuler(new THREE.Euler(sway, 0, sway * 0.5));
        const hh = 0.22 + C.h[i] * 1.8;
        m.compose(new THREE.Vector3(at.x - 3.3 + (r / (C.rows - 1)) * 6.6, y0 + hh / 2, at.z - 2.2 + (k / (C.cols - 1)) * 4.4), q, new THREE.Vector3(0.3, hh, 0.42));
        C.mesh.setMatrixAt(i, m);
        const gold = r === C.poc;
        C.mesh.setColorAt(i, gold ? c.set('#ffd25a') : c.set('#2f8a3a').lerp(new THREE.Color('#d9c45a'), clamp(C.h[i], 0, 1)));
      }
    C.mesh.instanceMatrix.needsUpdate = true;
    if (C.mesh.instanceColor) C.mesh.instanceColor.needsUpdate = true;
  }

  private buildHarbor() {
    const at = SITES.harbor;
    // a pier from the beach out over the water
    const pier = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.18, 6.5), new THREE.MeshStandardMaterial({ color: 0x5a4430, roughness: 0.9 }));
    pier.position.set(at.x, 0.35, at.z + 1.5);
    this.scene.add(pier);
    for (let k = 0; k < 6; k++)
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.2, 6), new THREE.MeshStandardMaterial({ color: 0x3a2a1c }));
        post.position.set(at.x + s * 0.5, -0.1, at.z - 1.3 + k * 1.15);
        this.scene.add(post);
      }
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd28a }));
    lamp.position.set(at.x, 1.3, at.z + 4.6);
    const lampPost = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1, 6), new THREE.MeshStandardMaterial({ color: 0x222 }));
    lampPost.position.set(at.x, 0.8, at.z + 4.6);
    this.scene.add(lamp, lampPost);
    // a pool of boats
    for (let k = 0; k < 24; k++) {
      const b = new THREE.Group();
      const hull = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.95), new THREE.MeshStandardMaterial({ color: 0xd8dde6, roughness: 0.6 }));
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.34), new THREE.MeshStandardMaterial({ color: 0x2a3446 }));
      cabin.position.set(0, 0.15, -0.1);
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffb54a }));
      light.position.set(0, 0.32, -0.1);
      light.name = 'light';
      b.add(hull, cabin, light);
      b.visible = false;
      this.scene.add(b);
      this.boatPool.push(b);
    }
    this.hit(new THREE.Vector3(at.x, 0, at.z + 1.5), 'harbor', 3.4, 2.5);
  }

  private sail(buy: boolean, usd: number) {
    const b = this.boatPool.find((x) => !x.visible);
    if (!b) return;
    const at = SITES.harbor;
    const a = Math.PI * 0.5 + (Math.random() - 0.5) * 1.6;
    const from = new THREE.Vector3(at.x + Math.cos(a) * 32, 0.12, at.z + Math.sin(a) * 26);
    const to = new THREE.Vector3(at.x + (Math.random() > 0.5 ? 0.9 : -0.9), 0.12, at.z + 1 + Math.random() * 3.2);
    const s = clamp(0.7 + Math.log10(Math.max(10, usd)) * 0.12, 0.8, 1.6);
    b.scale.setScalar(s);
    ((b.getObjectByName('light') as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(buy ? '#ffb54a' : '#ff4a6a');
    b.visible = true;
    b.position.copy(from);
    this.boats.push({ mesh: b, from, to, t: 0, dur: 6 + Math.random() * 2 });
  }

  private buildLighthouse() {
    const at = SITES.lighthouse.clone();
    at.y = landHeight(at.x, at.z);
    const g = new THREE.Group();
    g.position.copy(at);
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.5, 3.4, 16), new THREE.MeshStandardMaterial({ color: 0xeef2f7, roughness: 0.5 }));
    tower.position.y = 1.7;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.46, 0.6, 16), new THREE.MeshStandardMaterial({ color: 0xc8303a, roughness: 0.5 }));
    band.position.y = 1.2;
    const band2 = band.clone();
    band2.position.y = 2.6;
    band2.scale.setScalar(0.85);
    const room = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.45, 16), new THREE.MeshBasicMaterial({ color: 0xfff1b8 }));
    room.position.y = 3.65;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.45, 16), new THREE.MeshStandardMaterial({ color: 0x2a2f3a }));
    roof.position.y = 4.1;
    this.beam = new THREE.Group();
    this.beam.position.y = 3.65;
    // a beam that fades out with distance (no hard end)
    const beamMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: 'varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying float vY; void main(){ float a = smoothstep(-5.5, 4.5, vY); gl_FragColor = vec4(1.0, 0.94, 0.7, 0.2 * a * a); }',
    });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1.4, 11, 24, 1, true), beamMat);
    cone.rotation.z = Math.PI / 2;
    cone.position.x = 5.5;
    this.beam.add(cone);
    g.add(tower, band, band2, room, roof, this.beam);
    const l = new THREE.PointLight(0xffe7a0, 3, 8, 1.5);
    l.position.y = 3.7;
    g.add(l);
    this.scene.add(g);
    this.hit(at, 'lighthouse', 1.4, 4.4);
  }

  private buildCouncil() {
    const at = SITES.council.clone();
    at.y = landHeight(at.x, at.z);
    // the hall: a drum with columns and a glass dome, a light on top
    const hall = new THREE.Group();
    hall.position.set(at.x, at.y, at.z - 1.6);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.5, 0.4, 40), new THREE.MeshStandardMaterial({ color: 0xd9dde4, roughness: 0.6 }));
    base.position.y = 0.2;
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 1.6, 40), new THREE.MeshStandardMaterial({ color: 0xe8ebf0, roughness: 0.5 }));
    drum.position.y = 1.2;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.6, 8), new THREE.MeshStandardMaterial({ color: 0xf5f6f8 }));
      col.position.set(Math.cos(a) * 2.05, 1.2, Math.sin(a) * 2.05);
      hall.add(col);
    }
    this.hallDome = new THREE.Mesh(new THREE.SphereGeometry(1.85, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9fc4ff, roughness: 0.15, metalness: 0.4, emissive: 0x1d4aa8, emissiveIntensity: 0.7, transparent: true, opacity: 0.92 }));
    this.hallDome.position.y = 2.0;
    const spire = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), new THREE.MeshBasicMaterial({ color: 0xbfe0ff }));
    spire.position.y = 4.1;
    spire.name = 'spire';
    this.hallLight = new THREE.PointLight(0x6fb0ff, 5, 9, 1.4);
    this.hallLight.position.y = 4;
    hall.add(base, drum, this.hallDome, spire, this.hallLight);
    this.scene.add(hall);
    // the plaza and its podium
    const plaza = new THREE.Mesh(new THREE.CylinderGeometry(3.7, 3.9, 0.1, 64), new THREE.MeshStandardMaterial({ color: 0x565d6b, roughness: 0.9 }));
    plaza.position.set(at.x, at.y + 0.05, at.z + PODIUM);
    const podium = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.3, 24), new THREE.MeshStandardMaterial({ color: 0x8a93a3, emissive: 0x2a5aff, emissiveIntensity: 0.4 }));
    podium.position.set(at.x, at.y + 0.2, at.z + PODIUM);
    this.scene.add(plaza, podium);
    this.hit(new THREE.Vector3(at.x, at.y, at.z), 'council', 4.2, 4.5);
  }

  /** The council's agents, as minions on the plaza. */
  private ensureMinions(agents: IslandAgent[]) {
    if (this.minions.length === agents.length) return;
    for (const m of this.minions) {
      this.scene.remove(m.group);
      m.tag.remove();
      m.bubble.remove();
    }
    this.picks = this.picks.filter((p) => !p.userData.minion);
    const at = SITES.council.clone();
    at.y = landHeight(at.x, at.z);
    const center = new THREE.Vector3(at.x, at.y + 0.1, at.z + PODIUM);
    this.minions = agents.map((a, i) => {
      const n = agents.length;
      // a half circle behind the podium, facing the island
      const ang = Math.PI * (0.04 + (0.92 * i) / Math.max(1, n - 1));
      const home = center.clone().add(new THREE.Vector3(-Math.cos(ang) * 3.0, 0, -Math.sin(ang) * 1.45 + 0.35));
      const hue = new THREE.Color(HUES[i % HUES.length]);
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.32, 4, 12), new THREE.MeshStandardMaterial({ color: hue, roughness: 0.45, metalness: 0.1, emissive: hue, emissiveIntensity: 0.15 }));
      body.position.y = 0.36;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 18, 14), new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.35 }));
      head.position.y = 0.78;
      const visor = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.07, 0.06), new THREE.MeshBasicMaterial({ color: 0x0a0f1c }));
      visor.position.set(0, 0.8, 0.15);
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.025, 0.065), new THREE.MeshBasicMaterial({ color: hue }));
      eye.position.set(0, 0.8, 0.155);
      const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.18, 6), new THREE.MeshStandardMaterial({ color: 0xc0c6d0 }));
      antenna.position.y = 1.0;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), new THREE.MeshBasicMaterial({ color: hue }));
      bulb.position.y = 1.1;
      // the gauge: a thin ring of light on the ground, as full as the reading
      const track = new THREE.Mesh(new THREE.RingGeometry(0.33, 0.36, 64), new THREE.MeshBasicMaterial({ color: 0x2a3550, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
      track.rotation.x = -Math.PI / 2;
      track.position.y = 0.02;
      const arc = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.38, 64, 1, Math.PI / 2, 0.01), new THREE.MeshBasicMaterial({ color: hue, side: THREE.DoubleSide }));
      arc.rotation.x = -Math.PI / 2;
      arc.position.y = 0.03;
      const hitBox = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.3, 10), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
      hitBox.position.y = 0.6;
      hitBox.userData = { place: `agent:${a.id}`, minion: true };
      g.add(body, head, visor, eye, antenna, bulb, track, arc, hitBox);
      g.position.copy(home);
      this.scene.add(g);
      this.picks.push(hitBox);
      return { id: a.id, group: g, body, eye, arc, home, target: home.clone(), hue, value: -1, tag: this.tag('island-minion'), bubble: this.tag('island-bubble'), hop: 0 };
    });
  }

  // ---------- going places ----------

  private flyTo(pos: THREE.Vector3, target: THREE.Vector3) {
    this.controls.autoRotate = false;
    this.fly = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: pos, t1: target, at: performance.now() };
  }

  select(place: Place) {
    const a = this.anchorOf(place);
    if (!a) return;
    this.selected = place;
    const d = place === 'council' ? 11.5 : place.startsWith('agent:') ? 5 : place === 'price' ? 9 : place === 'lighthouse' ? 10 : 11;
    // look from the island's side (front), a little above
    const from = new THREE.Vector3(a.x * 0.15, 0, 1).normalize();
    this.flyTo(a.clone().add(from.multiplyScalar(d)).add(new THREE.Vector3(0, d * 0.62, 0)), a.clone());
    this.onSelect(place);
    this.onPeek(null);
  }

  home() {
    this.selected = null;
    this.flyTo(Island.HOME_POS.clone(), Island.HOME_TARGET.clone());
    this.onSelect(null);
  }

  reset = () => this.home();

  private anchorOf(place: Place): THREE.Vector3 | null {
    if (place === 'price') return this.orb.visible ? this.orb.position.clone() : null;
    if (place.startsWith('agent:')) {
      const m = this.minions.find((x) => `agent:${x.id}` === place);
      return m ? m.group.position.clone().add(new THREE.Vector3(0, 0.8, 0)) : null;
    }
    const s = SITES[place as keyof typeof SITES];
    if (!s) return null;
    const y = landHeight(s.x, s.z);
    const lift = place === 'council' ? 1.4 : place === 'lighthouse' ? 2.2 : place === 'exchange' ? 1.8 : 0.8;
    return new THREE.Vector3(s.x, Math.max(0.3, y) + lift, s.z + (place === 'harbor' ? 1.5 : 0));
  }

  // ---------- data ----------

  private wx(u: number) {
    return (u - 0.5) * W;
  }
  private wz(v: number) {
    return (v - 0.5) * D;
  }
  private valleyY(u: number, v: number): number {
    const f = this.frame;
    if (!f) return BASIN;
    const { cols, rows, h } = f.terrain;
    const c = clamp(Math.round(u * (cols - 1)), 0, cols - 1);
    const r = clamp(Math.round(v * (rows - 1)), 0, rows - 1);
    return BASIN + Math.max(0, h[r * cols + c]) * HS;
  }

  update(f: IslandFrame) {
    this.frame = f;
    this.running = f.running;
    this.buildValley(f.terrain);
    this.buildRiver(f.terrain);
    this.buildTradeLights(f.lights);
    this.buildFences(f.positions);
    // the exchange's towers follow the book
    const n = this.towers.h.length / 2;
    const mx = Math.max(...f.book.bids.slice(0, n), ...f.book.asks.slice(0, n), 1e-9);
    for (let k = 0; k < n; k++) {
      this.towers.target[k] = 0.7 + ((f.book.bids[k] ?? 0) / mx) * 4.6;
      this.towers.target[n + k] = 0.7 + ((f.book.asks[k] ?? 0) / mx) * 4.6;
    }
    // the fields follow the volume profile
    const C = this.crops;
    const { v, cols, slices, poc } = f.ridge;
    let mv = 0;
    const agg = new Float32Array(C.rows * C.cols);
    for (let s = 0; s < slices; s++)
      for (let x = 0; x < cols; x++) {
        const i = Math.min(C.rows - 1, Math.floor((x / cols) * C.rows)) * C.cols + Math.min(C.cols - 1, Math.floor((s / slices) * C.cols));
        agg[i] += v[s * cols + x];
        mv = Math.max(mv, agg[i]);
      }
    for (let i = 0; i < agg.length; i++) C.target[i] = mv > 0 ? agg[i] / mv : 0;
    C.poc = mv > 0 ? Math.min(C.rows - 1, Math.floor((poc / cols) * C.rows)) : -1;
    // volatility: the lighthouse and the sea
    const vn = f.vol !== null ? clamp((f.vol - 0.2) / 1.0, 0, 1) : 0.2;
    this.beamSpeed = 0.35 + vn * 2.6;
    this.seaUniforms.uAmp.value = 0.12 + vn * 0.55;
    // the harbour: big trades sail in
    for (const b of f.boats.slice(0, 3)) this.sail(b.buy, b.usd);
    // the council
    this.ensureMinions(f.agents);
    f.agents.forEach((a, i) => {
      const m = this.minions[i];
      const v2 = clamp(a.value, 0.01, 1);
      if (Math.abs(v2 - m.value) > 0.005) {
        m.arc.geometry.dispose();
        m.arc.geometry = new THREE.RingGeometry(0.32, 0.38, 64, 1, Math.PI / 2, -v2 * Math.PI * 2);
        m.value = v2;
      }
      m.tag.innerHTML = `<b>${a.name}</b><span>${a.text}</span>`;
    });
    if (!f.running) {
      this.queue = [];
    } else
      for (const s of f.said) {
        if (s.agent === 'council') {
          const trade = /TRADE/.test(s.text);
          this.verdict = { trade, until: performance.now() + 5000, text: s.text };
          for (const m of this.minions) m.hop = 1;
          continue;
        }
        const i = this.minions.findIndex((m) => m.id === s.agent);
        if (i >= 0) this.queue.push({ i, text: s.text, kind: s.kind });
      }
    if (this.queue.length > 8) this.queue = this.queue.slice(-8);
    for (const [place, el] of this.placeTags) {
      const sub = f.tags[place];
      el.innerHTML = `<b>${PLACE_NAME[place] ?? place}</b><em>${PLACE_ROLE[place] ?? ''}${sub ? ` · ${sub}` : ''}</em>`;
    }
  }

  private buildValley(tr: Terrain) {
    const { cols, rows, h } = tr;
    const n = cols * rows;
    if (!this.valleyGeo || this.valleyGeo.getAttribute('position').count !== n) {
      this.valleyGeo?.dispose();
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(n * 3);
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          pos[(r * cols + c) * 3] = this.wx(c / (cols - 1));
          pos[(r * cols + c) * 3 + 2] = this.wz(r / (rows - 1));
        }
      const idx: number[] = [];
      for (let r = 0; r < rows - 1; r++)
        for (let c = 0; c < cols - 1; c++) {
          const a = r * cols + c;
          idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
        }
      g.setIndex(idx);
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      this.valleyGeo = g;
      if (this.valley) {
        this.scene.remove(this.valley);
        this.picks = this.picks.filter((p) => p !== this.valley);
      }
      this.valley = new THREE.Mesh(g, this.valleyMat);
      this.valley.userData.peek = 'terrain';
      this.scene.add(this.valley);
      this.picks.push(this.valley);
    }
    const pos = this.valleyGeo.getAttribute('position') as THREE.BufferAttribute;
    const col = this.valleyGeo.getAttribute('color') as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const hv = Math.max(0, h[i]);
      const q = lakeQ(pos.getX(i), pos.getZ(i));
      pos.setY(i, q > 0.97 ? BASIN - 0.6 : BASIN - 0.08 + (hv * HS + 0.08) * smooth(0.97, 0.86, q));
      heightColor(hv, c);
      col.setXYZ(i, c.r, c.g, c.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.valleyGeo.computeVertexNormals();
    this.valleyGeo.computeBoundingSphere();
  }

  private buildRiver(tr: Terrain) {
    for (const ch of [...this.river.children]) {
      this.river.remove(ch);
      (ch as THREE.Mesh).geometry.dispose();
    }
    const pts: THREE.Vector3[] = [];
    for (let r = 0; r < tr.rows; r++) {
      const rc = tr.river[r];
      if (!Number.isFinite(rc)) continue;
      const u = rc / tr.cols;
      const v = r / (tr.rows - 1);
      if (lakeQ(this.wx(u), this.wz(v)) > 0.95) continue;
      pts.push(new THREE.Vector3(this.wx(u), this.valleyY(u, v) + 0.06, this.wz(v)));
    }
    if (pts.length < 3) {
      this.orb.visible = false;
      return;
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    this.river.add(new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 3, 0.07, 8, false), this.riverMat));
    const end = pts[pts.length - 1];
    this.orb.visible = true;
    this.orb.position.copy(end).add(new THREE.Vector3(0, 0.2, 0));
    this.orbLight.position.copy(end).add(new THREE.Vector3(0, 0.9, 0));
  }

  private buildTradeLights(ls0: Light[]) {
    const ls = ls0.slice(-900);
    const n = ls.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const gold = new THREE.Color('#ffb54a');
    const red = new THREE.Color('#ff3d5e');
    ls.forEach((l, i) => {
      pos.set([this.wx(l.u), this.valleyY(l.u, l.v) + 0.06, this.wz(l.v)], i * 3);
      const c = l.buy ? gold : red;
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = lakeQ(this.wx(l.u), this.wz(l.v)) > 0.95 ? 0 : 0.12 + l.size * 0.8;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    this.lights.geometry.dispose();
    this.lights.geometry = g;
    this.lights.userData.lights = ls;
  }

  private buildFences(ps: IslandPosition[]) {
    for (const ch of [...this.fences.children]) {
      this.fences.remove(ch);
      (ch as THREE.Mesh).geometry.dispose();
      ((ch as THREE.Mesh).material as THREE.Material).dispose();
    }
    const f = this.frame;
    if (!f) return;
    for (const p of ps)
      for (const [price, color, what] of [
        [p.target, '#2fe39b', 'target'],
        [p.stop, '#ff4d6a', 'stop'],
        [p.entry, '#e8f1ff', 'entry'],
      ] as [number, string, string][]) {
        const u = (price - f.window.lo) / (f.window.hi - f.window.lo);
        if (u < 0 || u > 1) continue;
        const x = this.wx(u);
        const chord = 2 * VB * Math.sqrt(Math.max(0, 1 - (x / VA) ** 2)) * 0.9;
        if (chord < 0.5) continue;
        const line = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, Math.min(D, chord)), new THREE.MeshBasicMaterial({ color }));
        line.position.set(x, BASIN + 1.6, 0);
        line.userData = { peek: 'position', what, price, label: p.label };
        this.fences.add(line);
      }
  }

  // ---------- pointing and keys ----------

  private onMove = (e: PointerEvent) => {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer = { ...this.pointer, x: e.clientX - r.left, y: e.clientY - r.top, inside: true, moved: true };
  };
  private onDown = (e: PointerEvent) => {
    this.pointer.downX = e.clientX;
    this.pointer.downY = e.clientY;
  };
  private onLeave = () => {
    this.pointer.inside = false;
    this.onPeek(null);
    this.renderer.domElement.style.cursor = '';
  };
  private onClick = (e: MouseEvent) => {
    if (Math.hypot(e.clientX - this.pointer.downX, e.clientY - this.pointer.downY) > 5) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer = { ...this.pointer, x: e.clientX - r.left, y: e.clientY - r.top, inside: true };
    const hit = this.pick();
    const place = hit?.object.userData.place as Place | undefined;
    if (place) this.select(place);
    else if (this.selected && (!hit || hit.object.userData.peek === 'sea')) this.home();
  };
  private typing(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }
  private onKey = (e: KeyboardEvent) => {
    if (!this.host.offsetParent || this.typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      this.keys.add(k);
      this.controls.autoRotate = false;
      this.fly = null;
      e.preventDefault();
    }
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());

  /** WASD / arrows glide over the island; Q / E turn round the point looked at. */
  private walk(dt: number) {
    if (!this.keys.size) return;
    const fwd = new THREE.Vector3().subVectors(this.controls.target, this.camera.position);
    fwd.y = 0;
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    const dist = this.camera.position.distanceTo(this.controls.target);
    const sp = (4 + dist * 0.6) * dt;
    const mv = new THREE.Vector3();
    if (this.keys.has('w') || this.keys.has('arrowup')) mv.add(fwd);
    if (this.keys.has('s') || this.keys.has('arrowdown')) mv.sub(fwd);
    if (this.keys.has('d') || this.keys.has('arrowright')) mv.add(right);
    if (this.keys.has('a') || this.keys.has('arrowleft')) mv.sub(right);
    if (mv.lengthSq()) {
      mv.normalize().multiplyScalar(sp);
      this.camera.position.add(mv);
      this.controls.target.add(mv);
    }
    const turn = (this.keys.has('q') ? 1 : 0) - (this.keys.has('e') ? 1 : 0);
    if (turn) {
      const off = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
      off.applyAxisAngle(new THREE.Vector3(0, 1, 0), turn * dt * 1.2);
      this.camera.position.copy(this.controls.target).add(off);
    }
  }

  private pick(): THREE.Intersection | null {
    if (!this.pointer.inside) return null;
    const ndc = new THREE.Vector2((this.pointer.x / this.w) * 2 - 1, -(this.pointer.y / this.h) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.params.Points = { threshold: 0.1 };
    const hits = this.raycaster.intersectObjects([...this.picks, ...this.fences.children, this.lights], false);
    return hits.find((h) => h.object.userData.place) ?? hits[0] ?? null;
  }

  private peekNow() {
    const f = this.frame;
    const hit = this.pick();
    const at = { x: this.pointer.x, y: this.pointer.y };
    const place = hit?.object.userData.place as Place | undefined;
    this.renderer.domElement.style.cursor = place ? 'pointer' : '';
    if (!f || !hit) return this.onPeek(null);
    const o = hit.object;
    if (place) {
      if (place === this.selected) return this.onPeek(null);
      if (place.startsWith('agent:')) {
        const a = f.agents.find((x) => `agent:${x.id}` === place);
        return this.onPeek({ ...at, title: a?.name ?? place, lines: [a ? `${a.text} — ${a.sub}` : '', 'click to visit'], tone: 'info' });
      }
      if (place === 'price' && f.price) return this.onPeek({ ...at, title: `Price now ${fmt(f.price)}`, lines: ['the river is the price, flowing through the book', 'click to visit'] });
      return this.onPeek({ ...at, title: PLACE_NAME[place] ?? place, lines: [`${PLACE_ROLE[place] ?? ''}${f.tags[place] ? ` · ${f.tags[place]}` : ''}`, 'click to visit'] });
    }
    if (o.userData.peek === 'position') return this.onPeek({ ...at, title: `${o.userData.what.toUpperCase()} ${fmt(o.userData.price)}`, lines: [o.userData.label], tone: o.userData.what === 'stop' ? 'sell' : 'buy' });
    if (o === this.lights && hit.index !== undefined) {
      const l = (this.lights.userData.lights as Light[] | undefined)?.[hit.index];
      if (l) return this.onPeek({ ...at, title: `${l.buy ? 'BUY' : 'SELL'} ${l.qty.toPrecision(4)} @ ${fmt(l.price)}`, lines: [`$${(l.qty * l.price).toLocaleString('en-US', { maximumFractionDigits: 0 })} · ${clock(l.time)}`], tone: l.buy ? 'buy' : 'sell' });
    }
    if (o.userData.peek === 'terrain') {
      const u = hit.point.x / W + 0.5;
      const v = hit.point.z / D + 0.5;
      const { cols, rows, qty, top } = f.terrain;
      const c = clamp(Math.floor(u * cols), 0, cols - 1);
      const r = clamp(Math.floor(v * rows), 0, rows - 1);
      const price = f.window.lo + (c + 0.5) * ((f.window.hi - f.window.lo) / cols);
      const time = f.window.t0 + (r + 0.5) * ((f.window.t1 - f.window.t0) / rows);
      const q = qty[r * cols + c];
      return this.onPeek({ ...at, title: `${fmt(price)} at ${clock(time)}`, lines: [`resting orders ${q.toPrecision(3)} (${Math.round((q / top) * 100)}% of the tallest wall)`, q >= top * 0.8 ? 'a wall: price tends to stall or turn here' : q <= top * 0.1 ? 'thin: price moves through easily' : 'ordinary depth'] });
    }
    this.onPeek(null);
  }

  // ---------- the loop ----------

  private loop = (ts: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const raw = Math.min(0.1, (ts - (this.last || ts)) / 1000);
    this.last = ts;
    if (document.hidden || !this.host.offsetParent) return;
    this.acc += raw;
    if (this.acc < 1 / 30) return;
    const dt = Math.min(0.1, this.acc);
    this.acc = 0;
    const t = (performance.now() - this.clock0) / 1000;
    const now = performance.now();

    if (this.fly) {
      const f = this.fly;
      const k = Math.min(1, (now - f.at) / 1200);
      const e = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
      this.camera.position.lerpVectors(f.p0, f.p1, e);
      this.controls.target.lerpVectors(f.t0, f.t1, e);
      if (k >= 1) this.fly = null;
    }
    this.walk(dt);
    this.controls.update();
    this.seaUniforms.uTime.value = t;
    this.riverMat.uniforms.uTime.value = t;
    this.placeTowers(dt);
    this.placeCrops(dt, t);
    this.beam.rotation.y += dt * this.beamSpeed;
    const flies = this.scene.getObjectByName('flies');
    if (flies) flies.position.y = Math.sin(t * 0.7) * 0.25;
    // boats sail in, bob, and fade at the pier
    this.boats = this.boats.filter((b) => {
      b.t += dt / b.dur;
      const k = Math.min(1, b.t);
      const e = 1 - (1 - k) ** 2;
      b.mesh.position.lerpVectors(b.from, b.to, e);
      b.mesh.position.y = 0.12 + Math.sin(t * 2.4 + b.from.x) * 0.06;
      b.mesh.lookAt(b.to.x, b.mesh.position.y, b.to.z);
      if (b.t > 1.35) {
        b.mesh.visible = false;
        return false;
      }
      return true;
    });
    this.animateCouncil(dt, t, now);

    // labels follow their objects
    this.place(this.priceTag, this.orb.visible ? this.orb.position.clone().add(new THREE.Vector3(0, 0.5, 0)) : null, this.frame?.price ? fmt(this.frame.price) : '');
    for (const [place, el] of this.placeTags) {
      const a = this.anchorOf(place);
      this.place(el, a && place !== this.selected ? a.add(new THREE.Vector3(0, place === 'council' ? 3.8 : 2.2, 0)) : null);
    }
    const near = this.camera.position.distanceTo(SITES.council) < 26;
    for (const m of this.minions) {
      this.place(m.tag, near && `agent:${m.id}` !== this.selected ? m.group.position.clone().add(new THREE.Vector3(0, 1.35, 0)) : null);
    }
    // the reading of the place you visited, with a line to it
    if (this.detail) {
      const a = this.selected ? this.anchorOf(this.selected) : null;
      if (!a) {
        this.detail.style.visibility = 'hidden';
        if (this.leader) this.leader.style.visibility = 'hidden';
      } else {
        const v = a.project(this.camera);
        const ax = (v.x * 0.5 + 0.5) * this.w;
        const ay = (-v.y * 0.5 + 0.5) * this.h;
        const cw = this.detail.offsetWidth || 360;
        const ch = this.detail.offsetHeight || 280;
        const right = ax < this.w * 0.62;
        const x = right ? this.w - cw - 28 : 28;
        const y = clamp(ay - ch * 0.45, 64, this.h - ch - 90);
        this.detail.style.visibility = 'visible';
        this.detail.style.transform = `translate(${x}px, ${y}px)`;
        if (this.leader) {
          this.leader.style.visibility = 'visible';
          this.leader.setAttribute('x1', String(ax));
          this.leader.setAttribute('y1', String(ay));
          this.leader.setAttribute('x2', String(right ? x - 4 : x + cw + 4));
          this.leader.setAttribute('y2', String(y + 14));
        }
      }
    }
    if (this.pointer.moved || this.fly || this.keys.size) {
      this.pointer.moved = false;
      if (this.pointer.inside) this.peekNow();
    }
    this.composer.render();
  };

  private animateCouncil(dt: number, t: number, now: number) {
    if (!this.minions.length) return;
    const at = SITES.council;
    const center = new THREE.Vector3(at.x, landHeight(at.x, at.z) + 0.1, at.z + PODIUM);
    // one speaker at a time: walk to the podium, speak, walk back
    if (this.speaking && now > this.speaking.until) {
      const m = this.minions[this.speaking.i];
      m.target.copy(m.home);
      m.bubble.style.display = 'none';
      this.speaking = null;
    }
    if (!this.speaking && this.queue.length && this.running) {
      const s = this.queue.shift()!;
      const m = this.minions[s.i];
      const dir = new THREE.Vector3().subVectors(m.home, center).setY(0).normalize();
      // the proposer takes the podium, a voter steps forward
      if (s.kind === 'propose') m.target.copy(center).add(new THREE.Vector3(0, 0, 0.75));
      else m.target.copy(m.home).add(dir.multiplyScalar(-0.9));
      m.hop = 1;
      const txt = s.text.length > 110 ? `${s.text.slice(0, 107)}…` : s.text;
      m.bubble.textContent = txt;
      m.bubble.className = `island-bubble ${s.kind}`;
      this.speaking = { i: s.i, until: now + (s.kind === 'propose' ? 3600 : 2400) };
    }
    const speaker = this.speaking ? this.minions[this.speaking.i] : null;
    for (const m of this.minions) {
      const prev = m.group.position.clone();
      m.group.position.x += (m.target.x - m.group.position.x) * (1 - Math.exp(-dt * 3.5));
      m.group.position.z += (m.target.z - m.group.position.z) * (1 - Math.exp(-dt * 3.5));
      const moving = prev.distanceTo(m.group.position) > 0.003;
      m.hop = Math.max(0, m.hop - dt * 0.9);
      const bob = this.running ? Math.sin(t * 2 + m.home.x) * 0.02 : 0;
      const step = moving ? Math.abs(Math.sin(t * 12)) * 0.06 : 0;
      const jump = m.hop > 0 ? Math.abs(Math.sin(m.hop * Math.PI * 3)) * 0.28 * m.hop : 0;
      m.group.position.y = m.home.y + bob + step + jump;
      // face the speaker (or the podium), the speaker faces the island
      const look = m === speaker ? new THREE.Vector3(m.group.position.x, m.group.position.y, m.group.position.z + 5) : speaker ? speaker.group.position : center;
      const ang = Math.atan2(look.x - m.group.position.x, look.z - m.group.position.z);
      m.group.rotation.y += (((ang - m.group.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * (1 - Math.exp(-dt * 6));
      // asleep while the swarm is stopped: dim and still
      const mat = m.body.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = this.running ? (m === speaker ? 0.6 + 0.3 * Math.sin(t * 8) : 0.15) : 0.02;
      (m.eye.material as THREE.MeshBasicMaterial).color.copy(m.hue).multiplyScalar(this.running ? 1 : 0.25);
    }
    if (speaker) this.place(speaker.bubble, speaker.group.position.clone().add(new THREE.Vector3(0, 1.75, 0)));
    // the verdict: the hall flashes green or red, the banner says it
    const v = this.verdict && now < this.verdict.until ? this.verdict : null;
    const base = new THREE.Color(0x6fb0ff);
    const flash = v ? new THREE.Color(v.trade ? 0x3dff9a : 0xff4a6a) : base;
    this.hallLight.color.lerp(flash, 1 - Math.exp(-dt * 6));
    this.hallLight.intensity = v ? 9 + 4 * Math.sin(t * 10) : 5;
    (this.hallDome.material as THREE.MeshStandardMaterial).emissive.lerp(v ? flash.clone().multiplyScalar(0.5) : new THREE.Color(0x1d4aa8), 1 - Math.exp(-dt * 4));
    const spire = this.scene.getObjectByName('spire');
    if (spire) spire.rotation.y = t * 0.8;
    if (v) {
      this.banner.textContent = v.text;
      this.banner.className = `island-banner ${v.trade ? 'trade' : 'pass'}`;
      this.place(this.banner, new THREE.Vector3(at.x, landHeight(at.x, at.z) + 6.2, at.z - 1.6));
    } else this.banner.style.display = 'none';
  }

  private place(el: HTMLDivElement, p: THREE.Vector3 | null, text?: string) {
    if (!p) {
      el.style.display = 'none';
      return;
    }
    const v = p.clone().project(this.camera);
    if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.style.transform = `translate(${(v.x * 0.5 + 0.5) * this.w}px, ${(-v.y * 0.5 + 0.5) * this.h}px) translate(-50%, -100%)`;
    if (text !== undefined) el.textContent = text;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointermove', this.onMove);
    el.removeEventListener('pointerdown', this.onDown);
    el.removeEventListener('pointerleave', this.onLeave);
    el.removeEventListener('click', this.onClick);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
    this.controls.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    });
    this.composer.dispose();
    this.renderer.dispose();
    el.remove();
    this.labels.remove();
  }
}

/** Whether this computer can draw the island. */
export function webglOk(): boolean {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}
