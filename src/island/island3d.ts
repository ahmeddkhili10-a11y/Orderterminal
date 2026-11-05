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
//   the Harbor    big trades sail in (gold sails buy, red sell), a crane unloads
//                 them, crates in the yard are the minute's buying and selling
//   the Lighthouse rings for the 1/5/15-minute moves; the beam turns faster, the
//                 weather turns stormy (rain, lightning on hard moves) as
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
  boats: IslandBoat[];
  /** dollars bought and sold in the last minute (the harbour's yard) */
  tape: { buyUsd: number; sellUsd: number };
  /** the 1, 5 and 15-minute moves in bps (the lighthouse's rings) */
  moves: number[];
  /** one line under each place's name */
  tags: Partial<Record<Place, string>>;
}
export interface IslandBoat {
  buy: boolean;
  usd: number;
  price: number;
  qty: number;
  time: number;
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
  harbor: new THREE.Vector3(17.2, 0, 13.6),
  lighthouse: new THREE.Vector3(-17, 0, 11),
};
const PODIUM = 2.9; // the council's podium, in front of the hall
const FLAT: [THREE.Vector3, number][] = [
  [new THREE.Vector3(0, 0, -12.4), 7.4],
  [SITES.exchange, 4.6],
  [SITES.fields, 4.4],
  [SITES.lighthouse, 2.2],
  [new THREE.Vector3(17.2, 0, 12.6), 3.0],
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
  name: string;
  group: THREE.Group;
  rig: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  stripe: THREE.Mesh;
  bulb: THREE.Mesh;
  jet: THREE.Mesh;
  arc: THREE.Mesh;
  pulse: THREE.Mesh;
  face: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; key: string };
  home: THREE.Vector3;
  target: THREE.Vector3;
  hue: THREE.Color;
  value: number;
  tag: HTMLDivElement;
  bubble: HTMLDivElement;
  hop: number;
  pose: string;
  poseUntil: number;
  /** how it voted on the debate in progress: for, against, abstain, veto */
  stance: string;
  blink: number;
}
interface Boat {
  mesh: THREE.Group;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  dur: number;
  trade: IslandBoat;
  docked: boolean;
}
interface Link {
  sparks: THREE.Points;
  line: THREE.Line;
  from: () => THREE.Vector3;
  to: () => THREE.Vector3;
  born: number;
  until: number;
  untilVerdict: boolean;
  color: THREE.Color;
}
const esc = (x: string) => x.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** a vote line starts with its mark: ✓ for, ✗ against, – abstain, ⛔ veto */
export function stanceOf(text: string): string {
  const c = text.trim()[0];
  return c === '✓' ? 'for' : c === '✗' ? 'against' : c === '⛔' ? 'veto' : 'abstain';
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
  private crates!: { mesh: THREE.InstancedMesh; buy: number; sell: number; shown: Float32Array };
  private crane!: { jib: THREE.Group; hook: THREE.Mesh; aim: number; busy: number; buy?: boolean };
  private buoys: THREE.Group[] = [];
  private floaters: { el: HTMLDivElement; p: THREE.Vector3; t0: number }[] = [];
  private bands: THREE.Mesh[] = [];
  private lantern!: THREE.Mesh;
  private beamMat!: THREE.ShaderMaterial;
  private lampLight!: THREE.PointLight;
  private beamAim: number | null = null;
  private storm!: { clouds: THREE.Group; puff: THREE.MeshStandardMaterial; rain: THREE.Points; bolt: THREE.Line; flash: THREE.PointLight; level: number; strike: number; nextStrike: number };
  private links: Link[] = [];
  private lastSail = 0;
  private debate: { proposer: number } | null = null;
  private clearStances = 0;
  private spot!: THREE.Mesh;
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
          // calm inside the island (the lake), full swell offshore
          float e = length(vec2(position.x / 30.0, position.z / 21.0));
          transformed.y += w * uAmp * smoothstep(0.75, 1.08, e);`);
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
    // the stage light that falls on whoever is speaking
    this.spot = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 2.6, 32, 1, true),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: { uColor: { value: new THREE.Color(1, 1, 1) } },
        vertexShader: 'varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'varying float vY; uniform vec3 uColor; void main(){ float a = smoothstep(1.3, -1.3, vY); gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.4), 0.16 * a * a); }',
      }),
    );
    this.spot.visible = false;
    this.scene.add(this.spot);

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
    // development only: lets the visual checks reach the scene
    if (import.meta.env.DEV) (window as unknown as { __island?: Island }).__island = this;
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
    const wood = new THREE.MeshStandardMaterial({ color: 0x6a4e34, roughness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 0.9 });
    // a pier from the beach out to sea, with a T-head where the boats moor
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 6.4), wood);
    deck.position.set(at.x, 0.62, at.z + 3.0);
    const head = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.12, 1.0), wood);
    head.position.set(at.x, 0.62, at.z + 6.4);
    this.scene.add(deck, head);
    for (let k = 0; k < 7; k++)
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.8, 6), dark);
        post.position.set(at.x + s * 0.55, -0.2, at.z + 0.6 + k * 0.95);
        this.scene.add(post);
      }
    for (const s of [-1, 1]) {
      const lampPost = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.1, 6), new THREE.MeshStandardMaterial({ color: 0x1e232c }));
      lampPost.position.set(at.x + s * 1.9, 1.2, at.z + 6.6);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd28a }));
      lamp.position.set(at.x + s * 1.9, 1.8, at.z + 6.6);
      this.scene.add(lampPost, lamp);
    }
    const glow = new THREE.PointLight(0xffc27a, 4, 9, 1.6);
    glow.position.set(at.x, 2.2, at.z + 5.5);
    this.scene.add(glow);
    // buoys at the harbour mouth: their lights say who is winning the tape
    for (const s of [-1, 1]) {
      const g = new THREE.Group();
      const float = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 0.4, 10), new THREE.MeshStandardMaterial({ color: 0xc8303a, roughness: 0.6 }));
      const top = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      top.position.y = 0.42;
      top.name = 'light';
      g.add(float, top);
      g.position.set(at.x + s * 3.4, 0.1, at.z + 9.5);
      this.scene.add(g);
      this.buoys.push(g);
    }
    // the yard: crates of what was bought (west) and sold (east) in the last minute
    const crate = new THREE.BoxGeometry(0.42, 0.42, 0.42);
    const mesh = new THREE.InstancedMesh(crate, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, emissive: 0x111111 }), 24);
    const c = new THREE.Color();
    for (let i = 0; i < 24; i++) mesh.setColorAt(i, i < 12 ? c.set('#ffb54a') : c.set('#d93448'));
    this.scene.add(mesh);
    this.crates = { mesh, buy: 0, sell: 0, shown: new Float32Array(24) };
    for (const [side, dx] of [['buy', -2.6], ['sell', 2.6]] as [string, number][]) {
      const yard = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 1.2, 10), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
      yard.position.set(at.x + dx, landHeight(at.x + dx, at.z - 1.2) + 0.6, at.z - 1.2);
      yard.userData = { peek: 'yard', side, first: true };
      this.scene.add(yard);
      this.picks.push(yard);
    }
    // a crane at the root of the pier swings each boat's cargo ashore
    const crane = new THREE.Group();
    const cy = landHeight(at.x + 1.4, at.z - 0.2);
    crane.position.set(at.x + 1.4, cy, at.z - 0.2);
    const steel = new THREE.MeshStandardMaterial({ color: 0xffb020, roughness: 0.5, metalness: 0.3 });
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.8, 0.18), steel);
    mast.position.y = 1.4;
    const jib = new THREE.Group();
    jib.position.y = 2.75;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 3.0), steel);
    arm.position.z = 1.0;
    const counter = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.25, 0.4), new THREE.MeshStandardMaterial({ color: 0x2a2f3a }));
    counter.position.z = -0.7;
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 1.4, 4), new THREE.MeshBasicMaterial({ color: 0x222831 }));
    cable.position.set(0, -0.7, 2.3);
    const hook = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshStandardMaterial({ color: 0xffb54a, emissive: 0x442200 }));
    hook.position.set(0, -1.5, 2.3);
    hook.name = 'cargo';
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3030 }));
    tip.position.set(0, 0.12, 2.5);
    jib.add(arm, counter, cable, hook, tip);
    crane.add(mast, jib);
    this.scene.add(crane);
    this.crane = { jib, hook, aim: 0, busy: 0 };
    // a pool of boats: hull, cabin, mast and a sail in the trade's colour, a wake behind
    const hullShape = new THREE.Shape();
    hullShape.moveTo(-0.22, -0.5);
    hullShape.lineTo(0.22, -0.5);
    hullShape.quadraticCurveTo(0.27, 0.15, 0, 0.58);
    hullShape.quadraticCurveTo(-0.27, 0.15, -0.22, -0.5);
    const hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 0.2, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 2 });
    hullGeo.rotateX(Math.PI / 2);
    hullGeo.translate(0, 0.16, 0);
    const sailShape = new THREE.Shape();
    sailShape.moveTo(0, 0);
    sailShape.lineTo(0, 0.85);
    sailShape.lineTo(0.5, 0.05);
    sailShape.lineTo(0, 0);
    const sailGeo = new THREE.ShapeGeometry(sailShape);
    sailGeo.rotateY(Math.PI / 2);
    const wakeMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: this.seaUniforms.uTime, uOn: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec2 vUv; uniform float uTime; uniform float uOn;
        void main(){
          // a soft V of foam behind the boat: narrow at the stern, wider and fainter behind
          float d = vUv.y;
          float hw = 0.08 + 0.4 * d;
          float x = abs(vUv.x - 0.5);
          float rim = smoothstep(hw, hw * 0.55, x) * smoothstep(hw * 0.1, hw * 0.5, x);
          float a = rim * pow(1.0 - d, 1.6) * (0.85 + 0.15 * sin(d * 18.0 - uTime * 6.0));
          gl_FragColor = vec4(vec3(0.85, 0.95, 1.0), a * 0.35 * uOn); }`,
    });
    for (let k = 0; k < 16; k++) {
      const b = new THREE.Group();
      const hull = new THREE.Mesh(hullGeo, new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.5 }));
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.16, 0.3), new THREE.MeshStandardMaterial({ color: 0x24324a, roughness: 0.4 }));
      cabin.position.set(0, 0.24, -0.18);
      const mastM = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.95, 6), new THREE.MeshStandardMaterial({ color: 0x8a6a48 }));
      mastM.position.set(0, 0.62, 0.08);
      const sail = new THREE.Mesh(sailGeo, new THREE.MeshStandardMaterial({ color: 0xffc04d, emissive: 0xffc04d, emissiveIntensity: 0.35, side: THREE.DoubleSide, roughness: 0.7 }));
      sail.position.set(0, 0.2, 0.1);
      sail.name = 'sail';
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffb54a }));
      light.position.set(0, 1.12, 0.08);
      light.name = 'light';
      const wake = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.7), wakeMat.clone());
      (wake.material as THREE.ShaderMaterial).uniforms.uTime = this.seaUniforms.uTime;
      wake.rotation.x = -Math.PI / 2;
      wake.position.set(0, 0.04, -1.25);
      wake.name = 'wake';
      const hitBox = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.3, 1.3), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
      hitBox.position.y = 0.5;
      hitBox.userData = { peek: 'boat', first: true };
      b.add(hull, cabin, mastM, sail, light, wake, hitBox);
      b.visible = false;
      this.scene.add(b);
      this.boatPool.push(b);
      this.picks.push(hitBox);
    }
    this.hit(new THREE.Vector3(at.x, 0.6, at.z + 3.2), 'harbor', 3.2, 2.5);
  }

  private sail(trade: IslandBoat) {
    const b = this.boatPool.find((x) => !x.visible);
    if (!b || this.boats.length >= 6) return;
    const at = SITES.harbor;
    // buyers moor on the west of the pier, sellers on the east (as the book: bids west, asks east)
    const side = trade.buy ? -1 : 1;
    const slot = this.boats.filter((x) => x.trade.buy === trade.buy).length % 4;
    const to = new THREE.Vector3(at.x + side * (0.95 + (slot % 2) * 0.0), 0.12, at.z + 2.0 + slot * 1.15);
    if (slot === 3) to.set(at.x + side * 2.6, 0.12, at.z + 7.4);
    const a = Math.PI * 0.5 + side * (0.25 + Math.random() * 0.45);
    const from = new THREE.Vector3(at.x + Math.cos(a) * 30, 0.12, at.z + Math.sin(a) * 26);
    const s = clamp(0.75 + Math.log10(Math.max(10, trade.usd)) * 0.1, 0.85, 1.6);
    b.scale.setScalar(s);
    const tint = new THREE.Color(trade.buy ? '#ffc04d' : '#ff4a6a');
    const sail = (b.getObjectByName('sail') as THREE.Mesh).material as THREE.MeshStandardMaterial;
    sail.color.copy(tint);
    sail.emissive.copy(tint);
    ((b.getObjectByName('light') as THREE.Mesh).material as THREE.MeshBasicMaterial).color.copy(tint);
    for (const ch of b.children) if (ch.userData.peek === 'boat') ch.userData.trade = trade;
    b.visible = true;
    b.position.copy(from);
    b.rotation.set(0, Math.atan2(to.x - from.x, to.z - from.z), 0);
    this.boats.push({ mesh: b, from, to, t: 0, dur: 7 + Math.random() * 2, trade, docked: false });
  }

  private animateHarbor(dt: number, t: number) {
    const at = SITES.harbor;
    // boats sail in with a wake, turn alongside, unload, and leave
    this.boats = this.boats.filter((b) => {
      b.t += dt / b.dur;
      const k = Math.min(1, b.t);
      const e = 1 - (1 - k) ** 2.2;
      const prev = b.mesh.position.clone();
      b.mesh.position.lerpVectors(b.from, b.to, e);
      b.mesh.position.y = 0.1 + Math.sin(t * 2.2 + b.from.x) * 0.05 + this.seaUniforms.uAmp.value * 0.25;
      const v = Math.hypot(b.mesh.position.x - prev.x, b.mesh.position.z - prev.z) / Math.max(dt, 1e-3);
      if (k < 0.97) {
        const ang = Math.atan2(b.to.x - b.mesh.position.x, b.to.z - b.mesh.position.z);
        b.mesh.rotation.y += (((ang - b.mesh.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * (1 - Math.exp(-dt * 3));
      } else {
        // moored: bow toward the shore
        b.mesh.rotation.y += (((Math.PI - b.mesh.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * (1 - Math.exp(-dt * 2));
      }
      b.mesh.rotation.z = Math.sin(t * 1.7 + b.from.z) * 0.06 * (1 + this.seaUniforms.uAmp.value);
      const wake = b.mesh.getObjectByName('wake') as THREE.Mesh;
      (wake.material as THREE.ShaderMaterial).uniforms.uOn.value = clamp((v - 0.3) / 3, 0, 1);
      if (!b.docked && k >= 1) {
        b.docked = true;
        this.crane.aim = Math.atan2(b.to.x - (at.x + 1.4), b.to.z - (at.z - 0.2));
        this.crane.busy = 2.2;
        this.crane.buy = b.trade.buy;
        const usd = b.trade.usd >= 1e6 ? `$${(b.trade.usd / 1e6).toFixed(2)}M` : b.trade.usd >= 1e3 ? `$${(b.trade.usd / 1e3).toFixed(1)}k` : `$${b.trade.usd.toFixed(0)}`;
        const el = this.tag(`island-float ${b.trade.buy ? 'buy' : 'sell'}`);
        el.textContent = `${b.trade.buy ? 'BOUGHT' : 'SOLD'} ${usd}`;
        this.floaters.push({ el, p: b.to.clone().add(new THREE.Vector3(0, 1.4, 0)), t0: performance.now() });
      }
      if (b.t > 2.2) {
        b.mesh.visible = false;
        return false;
      }
      if (b.t > 1.8) b.mesh.position.y -= (b.t - 1.8) * 1.2; // slips away under the night
      return true;
    });
    // the crane swings to the boat, then to the yard
    const C = this.crane;
    C.busy = Math.max(0, C.busy - dt);
    const yard = Math.atan2((C.buy ? -2.6 : 2.6) - 1.4, -1.2 + 0.2);
    const goal = C.busy > 1.1 ? C.aim : C.busy > 0 ? yard : Math.sin(t * 0.25) * 0.4 + Math.PI;
    C.jib.rotation.y += (((goal - C.jib.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * (1 - Math.exp(-dt * 2.2));
    C.hook.visible = C.busy > 0 && C.busy < 1.6;
    ((C.hook.material as THREE.MeshStandardMaterial).color as THREE.Color).set(C.buy ? '#ffb54a' : '#ff4a6a');
    // crates: as many as the minute's buying and selling, stacked 3 × 2, two high
    const M = this.crates;
    const m = new THREE.Matrix4();
    for (let i = 0; i < 24; i++) {
      const buy = i < 12;
      const k = i % 12;
      const want = k < (buy ? M.buy : M.sell) ? 1 : 0;
      M.shown[i] += (want - M.shown[i]) * (1 - Math.exp(-dt * 4));
      const s = M.shown[i] < 0.02 ? 0.0001 : M.shown[i];
      const x = at.x + (buy ? -2.6 : 2.6) + ((k % 3) - 1) * 0.46;
      const z = at.z - 1.2 + (Math.floor(k / 3) % 2) * 0.46 - 0.23;
      const y = landHeight(at.x + (buy ? -2.6 : 2.6), at.z - 1.2) + 0.21 + Math.floor(k / 6) * 0.44;
      m.makeScale(s, s, s).setPosition(x, y + (1 - s) * 0.6, z);
      M.mesh.setMatrixAt(i, m);
    }
    M.mesh.instanceMatrix.needsUpdate = true;
    // buoys bob and blink: green while buyers lead, red while sellers lead
    const lead = M.buy + M.sell > 0 ? (M.buy - M.sell) / (M.buy + M.sell) : 0;
    for (const [i, g] of this.buoys.entries()) {
      g.position.y = 0.05 + Math.sin(t * 1.9 + i) * 0.08 * (1 + this.seaUniforms.uAmp.value * 2);
      g.rotation.z = Math.sin(t * 1.3 + i * 2) * 0.12;
      const l = (g.getObjectByName('light') as THREE.Mesh).material as THREE.MeshBasicMaterial;
      l.color.set(lead > 0.15 ? '#3dff9a' : lead < -0.15 ? '#ff4a6a' : '#fff4d0').multiplyScalar(0.4 + 0.6 * (Math.sin(t * 4 + i * 1.5) > 0 ? 1 : 0.2));
    }
    // floating "BOUGHT $x" tags rise and fade over the pier
    const now = performance.now();
    this.floaters = this.floaters.filter((fl) => {
      const k = (now - fl.t0) / 2600;
      if (k >= 1) {
        fl.el.remove();
        return false;
      }
      this.place(fl.el, fl.p.clone().add(new THREE.Vector3(0, k * 1.2, 0)));
      fl.el.style.opacity = String(k < 0.15 ? k / 0.15 : 1 - Math.max(0, k - 0.6) / 0.4);
      return true;
    });
  }

  private buildLighthouse() {
    const at = SITES.lighthouse.clone();
    at.y = landHeight(at.x, at.z);
    const g = new THREE.Group();
    g.position.copy(at);
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.52, 3.4, 20), new THREE.MeshStandardMaterial({ color: 0xeef2f7, roughness: 0.5 }));
    tower.position.y = 1.7;
    // three rings of light up the tower: the 15, 5 and 1-minute moves (the top is the fastest)
    this.bands = [];
    for (let k = 0; k < 3; k++) {
      const y = 0.75 + k * 0.85;
      const r = 0.52 - (y / 3.4) * 0.2 + 0.03;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(r, r + 0.02, 0.22, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0x334055, side: THREE.DoubleSide }));
      band.position.y = y;
      band.userData = { peek: 'band', k: 2 - k, first: true };
      g.add(band);
      this.picks.push(band);
      this.bands.push(band);
    }
    const gallery = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 20), new THREE.MeshStandardMaterial({ color: 0x2a2f3a }));
    gallery.position.y = 3.4;
    this.lantern = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.45, 16), new THREE.MeshBasicMaterial({ color: 0xfff1b8 }));
    this.lantern.position.y = 3.65;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.45, 16), new THREE.MeshStandardMaterial({ color: 0x2a2f3a }));
    roof.position.y = 4.1;
    this.beam = new THREE.Group();
    this.beam.position.y = 3.65;
    // a beam that fades out with distance (no hard end); its colour warms to red in a storm
    this.beamMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(1, 0.94, 0.7) } },
      vertexShader: 'varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying float vY; uniform vec3 uColor; void main(){ float a = smoothstep(-6.5, 5.5, vY); gl_FragColor = vec4(uColor, 0.22 * a * a); }',
    });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1.5, 13, 24, 1, true), this.beamMat);
    cone.rotation.z = Math.PI / 2;
    cone.position.x = 6.5;
    this.beam.add(cone);
    g.add(tower, gallery, this.lantern, roof, this.beam);
    this.lampLight = new THREE.PointLight(0xffe7a0, 3, 9, 1.5);
    this.lampLight.position.y = 3.7;
    g.add(this.lampLight);
    this.scene.add(g);
    // the weather over the lighthouse: clouds and rain gather as volatility rises
    const storm = new THREE.Group();
    storm.position.set(at.x, at.y + 7.5, at.z);
    const puffMat = new THREE.MeshStandardMaterial({ color: 0x9aa6bd, roughness: 1, flatShading: true, transparent: true, opacity: 0, emissive: 0x1c2436, depthWrite: false });
    for (let k = 0; k < 22; k++) {
      const p = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45 + hash(k, 2) * 0.55, 1), puffMat);
      p.position.set((hash(k, 5) - 0.5) * 8, (hash(k, 8) - 0.5) * 0.7, (hash(k, 11) - 0.5) * 6);
      p.scale.set(1.4, 0.55, 1);
      storm.add(p);
    }
    const n = 420;
    const rp = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) rp.set([(hash(i, 1.7) - 0.5) * 12, hash(i, 3.1) * 7.5, (hash(i, 9.2) - 0.5) * 9], i * 3);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    const rain = new THREE.Points(rg, new THREE.PointsMaterial({ color: 0x9fc4ff, size: 0.06, transparent: true, opacity: 0, depthWrite: false }));
    rain.position.set(at.x, at.y, at.z);
    const bolt = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xe8f0ff, transparent: true, opacity: 0 }));
    const flash = new THREE.PointLight(0xcfe0ff, 0, 30, 1.2);
    flash.position.set(at.x, at.y + 6, at.z);
    this.scene.add(storm, rain, bolt, flash);
    this.storm = { clouds: storm, puff: puffMat, rain, bolt, flash, level: 0, strike: 0, nextStrike: 0 };
    this.hit(at, 'lighthouse', 1.4, 4.4);
  }

  /** a lightning strike near the lighthouse: the market just moved hard */
  private strike() {
    const S = this.storm;
    const at = SITES.lighthouse;
    const y0 = landHeight(at.x, at.z);
    const x = at.x + (Math.random() - 0.5) * 6;
    const z = at.z + (Math.random() - 0.5) * 4;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 8; k++) pts.push(new THREE.Vector3(x + (k && k < 8 ? (Math.random() - 0.5) * 0.9 : 0), y0 + 7.2 - (k / 8) * 7.2, z + (k && k < 8 ? (Math.random() - 0.5) * 0.6 : 0)));
    S.bolt.geometry.dispose();
    S.bolt.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    S.strike = 0.35;
  }

  private animateLighthouse(dt: number, t: number) {
    const f = this.frame;
    const S = this.storm;
    const vn = f?.vol !== null && f?.vol !== undefined ? clamp((f.vol - 0.2) / 1.0, 0, 1) : 0.2;
    // the beam: sweeps, or follows your pointer while you visit
    if (this.selected === 'lighthouse' && this.beamAim !== null) {
      this.beam.rotation.y += (((this.beamAim - this.beam.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * (1 - Math.exp(-dt * 5));
    } else this.beam.rotation.y += dt * this.beamSpeed;
    const calm = new THREE.Color(1, 0.94, 0.7);
    const wild = new THREE.Color(1, 0.35, 0.22);
    (this.beamMat.uniforms.uColor.value as THREE.Color).copy(calm).lerp(wild, smooth(0.45, 0.95, vn));
    (this.lantern.material as THREE.MeshBasicMaterial).color.copy(calm).lerp(wild, smooth(0.45, 0.95, vn)).multiplyScalar(0.85 + 0.15 * Math.sin(t * 6));
    this.lampLight.color.copy((this.lantern.material as THREE.MeshBasicMaterial).color);
    // the move rings
    const moves = f?.moves ?? [0, 0, 0];
    const scale = Math.max(12, ...moves.map(Math.abs));
    this.bands.forEach((b) => {
      const v = moves[b.userData.k as number] ?? 0;
      const k = Math.min(1, Math.abs(v) / scale);
      const col = v >= 0 ? new THREE.Color('#3dff9a') : new THREE.Color('#ff4a6a');
      (b.material as THREE.MeshBasicMaterial).color.copy(new THREE.Color('#2a3448')).lerp(col, 0.25 + 0.75 * k).multiplyScalar(0.7 + 0.5 * k + 0.15 * Math.sin(t * 3 + (b.userData.k as number)));
    });
    // the weather follows volatility; a hard 1-minute move brings lightning
    S.level += (smooth(0.35, 0.9, vn) - S.level) * (1 - Math.exp(-dt * 0.8));
    S.puff.opacity = S.level * 0.7;
    S.clouds.visible = S.level > 0.02;
    S.clouds.rotation.y += dt * 0.05;
    S.clouds.position.y = landHeight(SITES.lighthouse.x, SITES.lighthouse.z) + 7.5 + Math.sin(t * 0.4) * 0.2;
    const rm = S.rain.material as THREE.PointsMaterial;
    rm.opacity = clamp((S.level - 0.25) * 1.4, 0, 0.8);
    S.rain.visible = rm.opacity > 0.01;
    if (S.rain.visible) {
      const p = S.rain.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        let y = p.getY(i) - dt * 9;
        if (y < 0) y += 7.5;
        p.setY(i, y);
      }
      p.needsUpdate = true;
    }
    const now = performance.now();
    const hard = Math.abs(moves[0]) >= Math.max(20, scale * 0.9) && Math.abs(moves[0]) >= 20;
    if (now > S.nextStrike && (hard || (S.level > 0.6 && Math.random() < dt * 0.15))) {
      this.strike();
      S.nextStrike = now + 5000;
    }
    S.strike = Math.max(0, S.strike - dt);
    const fl = S.strike > 0 ? (Math.sin(S.strike * 60) > 0 ? 1 : 0.3) * (S.strike / 0.35) : 0;
    (S.bolt.material as THREE.LineBasicMaterial).opacity = fl;
    S.bolt.visible = fl > 0;
    S.flash.intensity = fl * 40;
    S.puff.emissive.setRGB(0.11 + fl * 0.6, 0.14 + fl * 0.6, 0.21 + fl * 0.6);
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

  /** The council's agents: little hovering robots on the plaza. */
  private ensureMinions(agents: IslandAgent[]) {
    if (this.minions.length === agents.length && this.minions.every((m, i) => m.id === agents[i].id)) return;
    for (const m of this.minions) {
      this.scene.remove(m.group);
      m.tag.remove();
      m.bubble.remove();
      m.face.tex.dispose();
    }
    this.picks = this.picks.filter((p) => !p.userData.minion);
    const at = SITES.council.clone();
    at.y = landHeight(at.x, at.z);
    const center = new THREE.Vector3(at.x, at.y + 0.1, at.z + PODIUM);
    const torsoGeo = new THREE.LatheGeometry(
      [
        [0, 0],
        [0.1, 0.01],
        [0.17, 0.06],
        [0.2, 0.16],
        [0.2, 0.27],
        [0.17, 0.38],
        [0.11, 0.44],
        [0, 0.46],
      ].map(([x, y]) => new THREE.Vector2(x, y)),
      28,
    );
    const shell = new THREE.MeshStandardMaterial({ color: 0xe9edf5, roughness: 0.28, metalness: 0.35 });
    const joint = new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.5, metalness: 0.5 });
    this.minions = agents.map((a, i) => {
      const n = agents.length;
      // a half circle behind the podium, facing the island
      const ang = Math.PI * (0.04 + (0.92 * i) / Math.max(1, n - 1));
      const home = center.clone().add(new THREE.Vector3(-Math.cos(ang) * 3.0, 0, -Math.sin(ang) * 1.45 + 0.35));
      const hue = new THREE.Color(HUES[i % HUES.length]);
      const g = new THREE.Group();
      const rig = new THREE.Group(); // floats and leans; the ground gauge stays put
      g.add(rig);
      const torso = new THREE.Mesh(torsoGeo, shell);
      torso.position.y = 0.2;
      const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.203, 0.203, 0.045, 28, 1, true), new THREE.MeshStandardMaterial({ color: hue, emissive: hue, emissiveIntensity: 0.6, side: THREE.DoubleSide }));
      stripe.position.y = 0.42;
      const core = new THREE.Mesh(new THREE.CircleGeometry(0.05, 20), new THREE.MeshBasicMaterial({ color: hue }));
      core.position.set(0, 0.5, 0.196);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.06, 12), joint);
      neck.position.y = 0.68;
      const head = new THREE.Group();
      head.position.y = 0.86;
      const skull = new THREE.Mesh(new THREE.SphereGeometry(0.19, 28, 20), shell);
      skull.scale.set(1.12, 0.92, 1);
      // the face: a screen that shows how it feels about the trade
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const screen = new THREE.Mesh(new THREE.SphereGeometry(0.196, 28, 16, Math.PI / 2 - 0.8, 1.6, Math.PI / 2 - 0.45, 0.9), new THREE.MeshBasicMaterial({ map: tex }));
      screen.scale.set(1.12, 0.92, 1);
      const ears = [-1, 1].map((s) => {
        const e = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.05, 16), new THREE.MeshStandardMaterial({ color: hue, emissive: hue, emissiveIntensity: 0.4 }));
        e.rotation.z = Math.PI / 2;
        e.position.x = s * 0.215;
        return e;
      });
      const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.16, 6), joint);
      antenna.position.y = 0.24;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshBasicMaterial({ color: hue }));
      bulb.position.y = 0.33;
      head.add(skull, screen, ...ears, antenna, bulb);
      // arms on shoulder pivots: they wave, raise a hand to vote for, cross to vote against
      const arms = [-1, 1].map((s) => {
        const pivot = new THREE.Group();
        pivot.position.set(s * 0.215, 0.52, 0);
        const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.17, 4, 8), shell);
        upper.position.y = -0.13;
        const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), new THREE.MeshStandardMaterial({ color: hue, emissive: hue, emissiveIntensity: 0.3 }));
        hand.position.y = -0.27;
        pivot.add(upper, hand);
        return pivot;
      });
      // it hovers: a glowing jet under it
      const jet = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.22, 16, 1, true), new THREE.MeshBasicMaterial({ color: hue, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      jet.rotation.x = Math.PI;
      jet.position.y = 0.1;
      rig.add(torso, stripe, core, neck, head, ...arms, jet);
      // the gauge: a ring of light on the ground, as full as the reading
      const track = new THREE.Mesh(new THREE.RingGeometry(0.33, 0.36, 64), new THREE.MeshBasicMaterial({ color: 0x2a3550, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
      track.rotation.x = -Math.PI / 2;
      track.position.y = 0.02;
      const arc = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.38, 64, 1, Math.PI / 2, 0.01), new THREE.MeshBasicMaterial({ color: hue, side: THREE.DoubleSide }));
      arc.rotation.x = -Math.PI / 2;
      arc.position.y = 0.03;
      const pulse = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.42, 48), new THREE.MeshBasicMaterial({ color: hue, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      pulse.rotation.x = -Math.PI / 2;
      pulse.position.y = 0.04;
      const hitBox = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 1.3, 10), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
      hitBox.position.y = 0.6;
      hitBox.userData = { place: `agent:${a.id}`, minion: true };
      g.add(track, arc, pulse, hitBox);
      g.position.copy(home);
      rig.scale.setScalar(1.15);
      this.scene.add(g);
      this.picks.push(hitBox);
      const m: Minion = {
        id: a.id,
        name: a.name,
        group: g,
        rig,
        head,
        armL: arms[0],
        armR: arms[1],
        stripe,
        bulb,
        jet,
        arc,
        pulse,
        face: { ctx, tex, key: '' },
        home,
        target: home.clone(),
        hue,
        value: -1,
        tag: this.tag('island-minion'),
        bubble: this.tag('island-bubble'),
        hop: 0,
        pose: 'idle',
        poseUntil: 0,
        stance: '',
        blink: 2 + Math.random() * 3,
      };
      this.drawFace(m, 'idle', 0);
      return m;
    });
  }

  /** the robot's face screen: eyes and a mouth in its colour */
  private drawFace(m: Minion, mood: string, mouth: number) {
    const key = `${mood}:${mouth}`;
    if (m.face.key === key) return;
    m.face.key = key;
    const c = m.face.ctx;
    c.fillStyle = '#060a14';
    c.fillRect(0, 0, 128, 64);
    const col = mood === 'sleep' ? '#2c3a55' : mood === 'for' ? '#3dff9a' : mood === 'against' || mood === 'veto' ? '#ff4a6a' : `#${m.hue.getHexString()}`;
    c.strokeStyle = col;
    c.fillStyle = col;
    c.lineWidth = 6;
    c.lineCap = 'round';
    c.shadowColor = col;
    c.shadowBlur = 8;
    const eye = (x: number) => {
      c.beginPath();
      if (mood === 'sleep' || mood === 'blink') {
        c.moveTo(x - 10, 28);
        c.lineTo(x + 10, 28);
      } else if (mood === 'for') {
        c.moveTo(x - 11, 32);
        c.quadraticCurveTo(x, 16, x + 11, 32);
      } else if (mood === 'veto') {
        c.moveTo(x - 9, 18);
        c.lineTo(x + 9, 36);
        c.moveTo(x + 9, 18);
        c.lineTo(x - 9, 36);
      } else if (mood === 'abstain') {
        c.moveTo(x - 11, 27);
        c.lineTo(x + 11, 27);
        c.moveTo(x - 5, 33);
        c.lineTo(x + 5, 33);
      } else {
        c.roundRect(x - 8, 16, 16, 22, 7);
        c.fill();
        return;
      }
      c.stroke();
    };
    eye(42);
    eye(86);
    if (mood === 'against') {
      // brows down
      c.beginPath();
      c.moveTo(30, 12);
      c.lineTo(52, 18);
      c.moveTo(98, 12);
      c.lineTo(76, 18);
      c.stroke();
    }
    c.beginPath();
    if (mood === 'talk') {
      c.roundRect(52, 44, 24, 4 + mouth * 3, 4);
      c.fill();
    } else if (mood === 'for') {
      c.moveTo(52, 46);
      c.quadraticCurveTo(64, 56, 76, 46);
      c.stroke();
    } else if (mood === 'against' || mood === 'veto') {
      c.moveTo(52, 52);
      c.quadraticCurveTo(64, 43, 76, 52);
      c.stroke();
    } else if (mood !== 'sleep') {
      c.moveTo(56, 49);
      c.lineTo(72, 49);
      c.stroke();
    }
    m.face.tex.needsUpdate = true;
  }

  /** a link of light between two speakers: a stream of sparks along a curve */
  private link(from: () => THREE.Vector3, to: () => THREE.Vector3, color: string, life: number, untilVerdict: boolean) {
    const n = 26;
    const pts = new THREE.BufferGeometry();
    pts.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const c = new THREE.Color(color);
    pts.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Array.from({ length: n }, () => [c.r, c.g, c.b]).flat()), 3));
    pts.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n).fill(0.55), 1));
    const sparks = new THREE.Points(pts, glowPoints(220));
    const line = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(33 * 3), 3)), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.scene.add(sparks, line);
    this.links.push({ sparks, line, from, to, born: performance.now(), until: performance.now() + life, untilVerdict, color: c });
  }

  private animateLinks(t: number, now: number) {
    const curve = new THREE.QuadraticBezierCurve3();
    this.links = this.links.filter((L) => {
      const left = (L.until - now) / 900;
      if (left <= 0) {
        this.scene.remove(L.sparks, L.line);
        L.sparks.geometry.dispose();
        L.line.geometry.dispose();
        (L.line.material as THREE.Material).dispose();
        return false;
      }
      const a = L.from();
      const b = L.to();
      const mid = a.clone().lerp(b, 0.5);
      mid.y += 0.8 + a.distanceTo(b) * 0.28;
      curve.v0.copy(a);
      curve.v1.copy(mid);
      curve.v2.copy(b);
      const grow = Math.min(1, (now - L.born) / 500);
      const fade = Math.min(1, left);
      const lp = L.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i <= 32; i++) {
        const p = curve.getPoint((i / 32) * grow);
        lp.setXYZ(i, p.x, p.y, p.z);
      }
      lp.needsUpdate = true;
      (L.line.material as THREE.LineBasicMaterial).opacity = 0.8 * fade;
      const sp = L.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
      const sz = L.sparks.geometry.getAttribute('size') as THREE.BufferAttribute;
      for (let i = 0; i < sp.count; i++) {
        const s = ((i / sp.count + t * 0.55) % 1) * grow;
        const p = curve.getPoint(s);
        sp.setXYZ(i, p.x, p.y, p.z);
        sz.setX(i, (0.6 + 0.7 * Math.sin(s * Math.PI)) * fade);
      }
      sp.needsUpdate = true;
      sz.needsUpdate = true;
      return true;
    });
  }

  private animateCouncil(dt: number, t: number, now: number) {
    if (!this.minions.length) return;
    const at = SITES.council;
    const y0 = landHeight(at.x, at.z);
    const center = new THREE.Vector3(at.x, y0 + 0.1, at.z + PODIUM);
    const hall = new THREE.Vector3(at.x, y0 + 3.2, at.z - 1.6);
    const headOf = (m: Minion) => () => m.group.position.clone().add(new THREE.Vector3(0, 1.0, 0));
    // one speaker at a time: walk to the podium (or step up), speak, walk back
    if (this.speaking && now > this.speaking.until) {
      const m = this.speaking.i >= 0 ? this.minions[this.speaking.i] : null;
      if (m) {
        m.target.copy(m.home);
        m.bubble.style.display = 'none';
      }
      this.speaking = null;
    }
    if (!this.speaking && this.queue.length && this.running) {
      const s = this.queue.shift()!;
      const pace = this.queue.length > 10 ? 0.5 : 1;
      if (s.kind === 'verdict') {
        const trade = /TRADE/.test(s.text);
        this.verdict = { trade, until: now + 4500, text: s.text };
        for (const m of this.minions) m.hop = 1;
        // every link flashes the verdict's colour, then fades
        for (const L of this.links) {
          L.untilVerdict = false;
          L.until = now + 2600;
          const c = new THREE.Color(trade ? '#3dff9a' : '#ff4a6a');
          (L.line.material as THREE.LineBasicMaterial).color.copy(c);
          const col = L.sparks.geometry.getAttribute('color') as THREE.BufferAttribute;
          for (let i = 0; i < col.count; i++) col.setXYZ(i, c.r, c.g, c.b);
          col.needsUpdate = true;
        }
        this.debate = null;
        this.clearStances = now + 4000;
        this.speaking = { i: -1, until: now + 2600 * pace };
      } else {
        const m = this.minions[s.i];
        const dir = new THREE.Vector3().subVectors(m.home, center).setY(0).normalize();
        const stance = s.kind === 'vote' ? stanceOf(s.text) : '';
        if (s.kind === 'propose') {
          // a new debate: the proposer takes the podium and links to the hall
          this.debate = { proposer: s.i };
          for (const o of this.minions) o.stance = '';
          m.target.copy(center).add(new THREE.Vector3(0, 0, 0.75));
          this.link(headOf(m), () => hall, `#${m.hue.getHexString()}`, 60000, true);
        } else if (s.kind === 'trade') {
          // the order goes to the market: a golden link to the price
          m.target.copy(m.home).add(dir.clone().multiplyScalar(-0.6));
          this.link(headOf(m), () => (this.orb.visible ? this.orb.position.clone() : new THREE.Vector3(0, 1, 0)), '#ffc04d', 5000, false);
        } else {
          m.target.copy(m.home).add(dir.clone().multiplyScalar(-0.9));
        }
        if (stance) {
          m.stance = stance;
          const p = this.debate ? this.minions[this.debate.proposer] : null;
          const color = stance === 'for' ? '#3dff9a' : stance === 'against' ? '#ff4a6a' : stance === 'veto' ? '#c060ff' : '#8a96aa';
          this.link(headOf(m), p && p !== m ? headOf(p) : () => hall, color, 60000, true);
        }
        m.pose = s.kind === 'vote' ? (stance || 'abstain') : 'talk';
        m.poseUntil = now + (s.kind === 'propose' ? 3600 : 2400) * pace;
        m.hop = 1;
        const txt = s.text.length > 120 ? `${s.text.slice(0, 117)}…` : s.text;
        const verb = s.kind === 'propose' ? 'proposes' : s.kind === 'trade' ? 'sends the order' : stance === 'for' ? 'votes for' : stance === 'against' ? 'votes against' : stance === 'veto' ? 'vetoes' : s.kind === 'vote' ? 'abstains' : 'says';
        const to = s.kind === 'vote' && this.debate && this.minions[this.debate.proposer] !== m ? ` → ${this.minions[this.debate.proposer].name}` : '';
        m.bubble.innerHTML = `<i style="color:#${m.hue.getHexString()}">${esc(m.name)} · ${verb}${esc(to)}</i>${esc(txt.replace(/^[✓✗–⛔]\s*/, ''))}`;
        m.bubble.className = `island-bubble ${s.kind} ${stance}`;
        m.bubble.style.borderColor = `#${m.hue.getHexString()}`;
        this.speaking = { i: s.i, until: now + (s.kind === 'propose' ? 3600 : 2400) * pace };
      }
    }
    if (this.clearStances && now > this.clearStances) {
      for (const m of this.minions) m.stance = '';
      this.clearStances = 0;
    }
    // a debate that never got its verdict lets go after a while
    for (const L of this.links) if (L.untilVerdict && now - L.born > 25000) L.until = Math.min(L.until, now + 900);
    const speaker = this.speaking && this.speaking.i >= 0 ? this.minions[this.speaking.i] : null;
    for (const m of this.minions) {
      const prev = m.group.position.clone();
      m.group.position.x += (m.target.x - m.group.position.x) * (1 - Math.exp(-dt * 3.5));
      m.group.position.z += (m.target.z - m.group.position.z) * (1 - Math.exp(-dt * 3.5));
      const moving = prev.distanceTo(m.group.position) > 0.003;
      m.hop = Math.max(0, m.hop - dt * 0.9);
      m.group.position.y = m.home.y;
      // the robot hovers; it leans as it glides and jumps for the verdict
      const awake = this.running;
      const float = awake ? 0.12 + Math.sin(t * 2.2 + m.home.x * 3) * 0.04 : 0.02;
      const jump = m.hop > 0 ? Math.abs(Math.sin(m.hop * Math.PI * 3)) * 0.3 * m.hop : 0;
      m.rig.position.y += (float + jump - m.rig.position.y) * (1 - Math.exp(-dt * 8));
      m.rig.rotation.x += ((moving ? 0.22 : 0) - m.rig.rotation.x) * (1 - Math.exp(-dt * 5));
      // face the speaker (or the podium); the speaker faces the island
      const look = m === speaker ? new THREE.Vector3(m.group.position.x, 0, m.group.position.z + 5) : speaker ? speaker.group.position : center;
      const ang = Math.atan2(look.x - m.group.position.x, look.z - m.group.position.z);
      m.group.rotation.y += (((ang - m.group.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * (1 - Math.exp(-dt * 6));
      // the pose: talk with the hands, raise one to vote for, cross arms against
      if (now > m.poseUntil) m.pose = awake ? 'idle' : 'sleep';
      const P = m.pose;
      let lx = 0;
      let lz = -0.12 - Math.sin(t * 1.3 + m.home.x) * 0.04;
      let rx = 0;
      let rz = 0.12 + Math.sin(t * 1.3 + m.home.x) * 0.04;
      if (P === 'talk') {
        rx = -0.9 + Math.sin(t * 6) * 0.45;
        rz = 0.35;
        lx = -0.4 + Math.sin(t * 4 + 1) * 0.25;
        lz = -0.3;
      } else if (P === 'for') {
        rz = 2.7 + Math.sin(t * 9) * 0.15;
      } else if (P === 'against') {
        lx = -1.35;
        lz = 0.75;
        rx = -1.35;
        rz = -0.75;
      } else if (P === 'veto') {
        lz = -2.5;
        rz = 2.5 + Math.sin(t * 10) * 0.1;
      } else if (P === 'abstain') {
        lz = -0.6;
        rz = 0.6;
        lx = rx = -0.4;
      } else if (P === 'sleep') {
        lz = -0.05;
        rz = 0.05;
      }
      const k = 1 - Math.exp(-dt * 8);
      m.armL.rotation.x += (lx - m.armL.rotation.x) * k;
      m.armL.rotation.z += (lz - m.armL.rotation.z) * k;
      m.armR.rotation.x += (rx - m.armR.rotation.x) * k;
      m.armR.rotation.z += (rz - m.armR.rotation.z) * k;
      m.head.rotation.z = P === 'abstain' ? 0.18 : P === 'sleep' ? 0.3 : Math.sin(t * 0.9 + m.home.z) * 0.05;
      m.head.rotation.x = P === 'sleep' ? 0.35 : P === 'talk' ? Math.sin(t * 5) * 0.06 : 0;
      // the face
      m.blink -= dt;
      const blinking = m.blink < 0.12 && m.blink > 0;
      if (m.blink < 0) m.blink = 2 + Math.random() * 4;
      const mood = !awake ? 'sleep' : P === 'talk' ? 'talk' : P === 'for' || P === 'against' || P === 'veto' || P === 'abstain' ? P : m.stance && m.stance !== 'abstain' ? m.stance : blinking ? 'blink' : 'idle';
      this.drawFace(m, mood, mood === 'talk' ? Math.round(Math.abs(Math.sin(t * 11)) * 3) : 0);
      // lights: the speaker glows, its bulb blinks, its ring pulses outward
      const talking = m === speaker;
      m.tag.classList.toggle('speaking', talking);
      (m.stripe.material as THREE.MeshStandardMaterial).emissiveIntensity = !awake ? 0.05 : talking ? 1.2 + 0.5 * Math.sin(t * 8) : 0.5;
      (m.bulb.material as THREE.MeshBasicMaterial).color.copy(m.hue).multiplyScalar(!awake ? 0.2 : talking ? (Math.sin(t * 14) > 0 ? 1.4 : 0.3) : 0.9);
      const jm = m.jet.material as THREE.MeshBasicMaterial;
      jm.opacity = awake ? 0.35 + 0.25 * Math.sin(t * 20 + m.home.x) : 0;
      m.jet.scale.y = awake ? 0.8 + 0.3 * Math.sin(t * 17 + m.home.z) : 0.1;
      const pm = m.pulse.material as THREE.MeshBasicMaterial;
      if (talking) {
        const ph = (t * 1.2) % 1;
        m.pulse.scale.setScalar(1 + ph * 1.8);
        pm.opacity = (1 - ph) * 0.8;
      } else pm.opacity = 0;
    }
    // the stage light falls on whoever is speaking
    if (speaker) {
      this.spot.visible = true;
      this.spot.position.lerp(speaker.group.position.clone().add(new THREE.Vector3(0, 2.6, 0)), 1 - Math.exp(-dt * 10));
      (this.spot.material as THREE.ShaderMaterial).uniforms.uColor.value.copy(speaker.hue);
      this.place(speaker.bubble, speaker.group.position.clone().add(new THREE.Vector3(0, 1.85, 0)));
    } else this.spot.visible = false;
    this.animateLinks(t, now);
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
      this.place(this.banner, new THREE.Vector3(at.x, y0 + 5.6, at.z - 1.6));
    } else this.banner.style.display = 'none';
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
    const d = place === 'council' ? 10 : place.startsWith('agent:') ? 5 : place === 'price' ? 9 : place === 'lighthouse' ? 10 : 11;
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
    const lift = place === 'council' ? 1.1 : place === 'lighthouse' ? 2.2 : place === 'exchange' ? 1.8 : 0.8;
    return new THREE.Vector3(s.x, Math.max(0.3, y) + lift, s.z + (place === 'harbor' ? 3.2 : 0));
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
    // the biggest trade sails in; one boat every few seconds keeps the harbour readable
    const now = performance.now();
    if (f.boats.length && now - this.lastSail > 2500) {
      this.sail(f.boats[0]);
      this.lastSail = now;
    }
    const most = Math.max(f.tape.buyUsd, f.tape.sellUsd);
    this.crates.buy = most > 0 ? Math.max(f.tape.buyUsd > 0 ? 1 : 0, Math.round((f.tape.buyUsd / most) * 12)) : 0;
    this.crates.sell = most > 0 ? Math.max(f.tape.sellUsd > 0 ? 1 : 0, Math.round((f.tape.sellUsd / most) * 12)) : 0;
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
      const mark = m.stance === 'for' ? '✓' : m.stance === 'against' ? '✗' : m.stance === 'veto' ? '⛔' : m.stance === 'abstain' ? '–' : '';
      m.tag.innerHTML = `<b>${esc(a.name)}${mark ? ` <i class="st ${m.stance}">${mark}</i>` : ''}</b><span>${esc(a.text)}</span>`;
    });
    if (!f.running) {
      this.queue = [];
    } else
      for (const s of f.said) {
        if (s.agent === 'council') {
          // the verdict waits its turn, after the votes are acted out
          this.queue.push({ i: -1, text: s.text, kind: 'verdict' });
          continue;
        }
        const i = this.minions.findIndex((m) => m.id === s.agent);
        if (i >= 0) this.queue.push({ i, text: s.text, kind: s.kind });
      }
    if (this.queue.length > 40) this.queue = this.queue.slice(-40);
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
    const shown = (o: THREE.Object3D) => {
      for (let x: THREE.Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
      return true;
    };
    const hits = this.raycaster.intersectObjects([...this.picks, ...this.fences.children, this.lights], false).filter((h) => shown(h.object));
    // small things (a boat, a ring on the lighthouse, the crates) win over the place around them
    return hits.find((h) => h.object.userData.first) ?? hits.find((h) => h.object.userData.place) ?? hits[0] ?? null;
  }

  private peekNow() {
    const f = this.frame;
    const hit = this.pick();
    const at = { x: this.pointer.x, y: this.pointer.y };
    const place = hit?.object.userData.place as Place | undefined;
    this.renderer.domElement.style.cursor = place ? 'pointer' : '';
    // visiting the lighthouse, the beam follows the pointer like a searchlight
    if (this.selected === 'lighthouse' && hit) {
      const L = SITES.lighthouse;
      this.beamAim = Math.atan2(-(hit.point.z - L.z), hit.point.x - L.x);
    } else this.beamAim = null;
    if (!f || !hit) return this.onPeek(null);
    const o = hit.object;
    if (place) {
      if (place === this.selected) return this.onPeek(null);
      if (place.startsWith('agent:')) {
        const a = f.agents.find((x) => `agent:${x.id}` === place);
        const m = this.minions.find((x) => `agent:${x.id}` === place);
        const st = m?.stance ? ({ for: 'voted for this trade', against: 'voted against this trade', veto: 'vetoed this trade', abstain: 'abstained' } as Record<string, string>)[m.stance] : '';
        return this.onPeek({ ...at, title: a?.name ?? place, lines: [a ? `${a.text} — ${a.sub}` : '', ...(st ? [st] : []), 'click to visit'], tone: 'info' });
      }
      if (place === 'price' && f.price) return this.onPeek({ ...at, title: `Price now ${fmt(f.price)}`, lines: ['the river is the price, flowing through the book', 'click to visit'] });
      return this.onPeek({ ...at, title: PLACE_NAME[place] ?? place, lines: [`${PLACE_ROLE[place] ?? ''}${f.tags[place] ? ` · ${f.tags[place]}` : ''}`, 'click to visit'] });
    }
    if (o.userData.peek === 'boat' && o.userData.trade) {
      const b = o.userData.trade as IslandBoat;
      return this.onPeek({ ...at, title: `${b.buy ? 'BOUGHT' : 'SOLD'} $${b.usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`, lines: [`${b.qty.toPrecision(4)} @ ${fmt(b.price)} · ${clock(b.time)}`, b.buy ? 'a big buyer: moors west of the pier' : 'a big seller: moors east of the pier'], tone: b.buy ? 'buy' : 'sell' });
    }
    if (o.userData.peek === 'yard') {
      const buy = o.userData.side === 'buy';
      const usd = buy ? f.tape.buyUsd : f.tape.sellUsd;
      const all = f.tape.buyUsd + f.tape.sellUsd;
      return this.onPeek({ ...at, title: `${buy ? 'Bought' : 'Sold'} in the last minute`, lines: [`$${usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}${all > 0 ? ` · ${Math.round((usd / all) * 100)}% of the tape` : ''}`, 'one crate for each twelfth of the bigger side'], tone: buy ? 'buy' : 'sell' });
    }
    if (o.userData.peek === 'band') {
      const k = o.userData.k as number;
      const v = f.moves[k] ?? 0;
      return this.onPeek({ ...at, title: `${['1-minute', '5-minute', '15-minute'][k]} move ${v >= 0 ? '+' : ''}${v.toFixed(1)} bps`, lines: [['the top ring', 'the middle ring', 'the bottom ring'][k] + ': green up, red down, brighter for bigger'], tone: v >= 0 ? 'buy' : 'sell' });
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
    const flies = this.scene.getObjectByName('flies');
    if (flies) flies.position.y = Math.sin(t * 0.7) * 0.25;
    this.animateHarbor(dt, t);
    this.animateLighthouse(dt, t);
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
