// The market island in WebGL — the whole crypto terminal is this one scene.
//
//   the island   liquidity as mountains (sea, shore, green land, yellow and
//                orange slopes, dark peaks), the price as a glowing river
//                carved into its valley ending in the orb of the price now,
//                trades as lights on the land
//   landmarks    on pads around it: the order book (glowing bars), the volume
//                profile (a ridge of bars over time), volatility (a ribbon over
//                three horizons), the tape (a cloud of trades in a cube)
//   the swarm    its council hall behind the island, each agent a beacon round
//                it with a rainbow ring that fills as its gauge rises
//
// Hover anything for a peek; click it and the camera flies there and its card
// opens beside it; click the sea (or Esc) to fly back. Drag to orbit, scroll to
// zoom. One canvas, one GPU context, 30 frames a second, nothing while hidden.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Light, Terrain, Window } from './model';

const W = 16; // price across
const D = 11; // time, back (old) to front (now)
const HS = 3.2; // height scale

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
  /** a new line from this agent since the last frame */
  spoke: boolean;
}
export interface IslandFrame {
  terrain: Terrain;
  window: Window;
  lights: Light[];
  price: number | null;
  positions: IslandPosition[];
  agents: IslandAgent[];
  book: { bids: number[]; asks: number[] };
  wave: { curves: number[][]; scale: number };
  cloud: { x: number; y: number; z: number; buy: boolean }[];
  ridge: { v: Float32Array; cols: number; slices: number; poc: number };
  /** one line under each landmark's name */
  tags: Partial<Record<Place, string>>;
}
export interface Peek {
  x: number;
  y: number;
  title: string;
  lines: string[];
  tone?: 'buy' | 'sell' | 'info';
}
/** what can be visited: the landmarks, the council, the price, or an agent (`agent:<id>`) */
export type Place = 'book' | 'ridge' | 'wave' | 'cube' | 'council' | 'price' | `agent:${string}`;

export const PLACE_NAME: Record<string, string> = { book: 'Order book', ridge: 'Volume profile', wave: 'Volatility', cube: 'Tape', council: 'The council', price: 'Price' };
const HUES = ['#ff6a3d', '#ffb13d', '#3dffa0', '#3de0ff', '#3d7bff', '#b63dff', '#ff3dc8', '#e8f1ff'];

const fmt = (p: number) => p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 1 : p >= 10 ? 2 : 4 });
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// the island's colours by height, as in a relief map at night
const STOPS: [number, THREE.Color][] = [
  [-0.2, new THREE.Color('#041026')],
  [0.0, new THREE.Color('#0b3a63')],
  [0.04, new THREE.Color('#145a4c')],
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
  for (let i = 1; i < STOPS.length; i++) {
    if (h <= STOPS[i][0]) {
      const [a, ca] = STOPS[i - 1];
      const [b, cb] = STOPS[i];
      return out.copy(ca).lerp(cb, (h - a) / (b - a));
    }
  }
  return out.copy(STOPS[STOPS.length - 1][1]);
}

/** deep blue → cyan → green → yellow → red, for the tape */
export function jet(t: number, out = new THREE.Color()): THREE.Color {
  const x = Math.max(0, Math.min(1, t));
  return out.setRGB(Math.max(0, Math.min(1, 1.5 - Math.abs(4 * x - 3))), Math.max(0, Math.min(1, 1.5 - Math.abs(4 * x - 2))), Math.max(0, Math.min(1, 1.5 - Math.abs(4 * x - 1))));
}
/** purple → magenta → orange → yellow → white, for the volume ridge */
function magma(t: number, out = new THREE.Color()): THREE.Color {
  const s: [number, string][] = [
    [0, '#1d0b46'],
    [0.3, '#7b2bb0'],
    [0.55, '#e0457b'],
    [0.75, '#ff9a3c'],
    [0.9, '#ffe27a'],
    [1, '#fffbe8'],
  ];
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < s.length; i++) if (x <= s[i][0]) return out.set(s[i - 1][1]).lerp(new THREE.Color(s[i][1]), (x - s[i - 1][0]) / (s[i][0] - s[i - 1][0]));
  return out.set('#fffbe8');
}
/** the gauge rings' rainbow, around the ring */
function rainbow(t: number, out = new THREE.Color()): THREE.Color {
  return out.setHSL((0.52 - t * 0.75 + 1) % 1, 1, 0.58);
}

const POINT_VS = /* glsl */ `
attribute float size; attribute float phase; varying vec3 vColor; varying float vTw; uniform float uTime; uniform float uScale;
void main(){ vColor = color; vec4 mv = modelViewMatrix * vec4(position,1.0);
  vTw = 0.8 + 0.2 * sin(uTime * 2.4 + phase * 6.283);
  gl_PointSize = size * uScale * (1.0 / -mv.z); gl_Position = projectionMatrix * mv; }`;
const POINT_FS = /* glsl */ `
varying vec3 vColor; varying float vTw;
void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard;
  float core = smoothstep(0.5, 0.0, r); float a = pow(core, 1.8) * vTw;
  gl_FragColor = vec4(vColor * (0.55 + 1.1 * core), a); }`;

function pointsMaterial(scale: number) {
  return new THREE.ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, uniforms: { uTime: { value: 0 }, uScale: { value: scale } }, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
}

function pointsGeometry(pos: Float32Array, col: Float32Array, size: Float32Array) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const ph = new Float32Array(size.length);
  for (let i = 0; i < ph.length; i++) ph[i] = (i * 0.618) % 1;
  g.setAttribute('phase', new THREE.BufferAttribute(ph, 1));
  return g;
}

interface Landmark {
  id: Place;
  group: THREE.Group;
  /** where its card and the camera look */
  anchor: THREE.Vector3;
  update(f: IslandFrame): void;
  tick(t: number): void;
}

export class Island {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 220);
  private controls: OrbitControls;
  private terrainGeo: THREE.BufferGeometry | null = null;
  private terrainMesh: THREE.Mesh | null = null;
  private terrainMat: THREE.MeshStandardMaterial;
  private river = new THREE.Group();
  private orb: THREE.Mesh;
  private beam: THREE.Mesh;
  private orbLight: THREE.PointLight;
  private lightsPts: THREE.Points;
  private lightsMat: THREE.ShaderMaterial;
  private fences = new THREE.Group();
  private landmarks: Landmark[] = [];
  private picks: THREE.Object3D[] = [];
  private hall = new THREE.Group();
  private beacons: { id: string; group: THREE.Group; ring: THREE.Mesh; value: number; tag: HTMLDivElement; hue: string }[] = [];
  private wires: THREE.LineSegments;
  private sparks: THREE.Points;
  private sparkMat: THREE.ShaderMaterial;
  private sparkState: { a: THREE.Vector3; b: THREE.Vector3; t: number }[] = [];
  private frame: IslandFrame | null = null;
  private labels: HTMLDivElement;
  private priceTag: HTMLDivElement;
  private placeTags = new Map<Place, HTMLDivElement>();
  private raycaster = new THREE.Raycaster();
  private pointer = { x: 0, y: 0, inside: false, moved: false, downX: 0, downY: 0 };
  private fly: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; at: number } | null = null;
  private selected: Place | null = null;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private t = 0;
  private w = 1;
  private h = 1;
  private ro: ResizeObserver;
  private disposed = false;
  /** the selected place's card, placed beside it every frame */
  detail: HTMLElement | null = null;
  static HOME_POS = new THREE.Vector3(0, 15.5, 20.5);
  static HOME_TARGET = new THREE.Vector3(0, 0, -0.8);

  constructor(
    private host: HTMLElement,
    private onPeek: (p: Peek | null) => void,
    private onSelect: (place: Place | null) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x02040a, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.35;
    const el = this.renderer.domElement;
    el.className = 'island-canvas';
    host.appendChild(el);
    this.labels = document.createElement('div');
    this.labels.className = 'island-labels';
    host.appendChild(this.labels);
    this.priceTag = this.tag('island-price');

    this.scene.fog = new THREE.FogExp2(0x02040a, 0.018);
    this.camera.position.copy(Island.HOME_POS);
    this.controls = new OrbitControls(this.camera, el);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 40;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.target.copy(Island.HOME_TARGET);
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.12;
    this.controls.addEventListener('start', () => {
      this.controls.autoRotate = false;
      this.fly = null;
    });

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.42, 0.4, 0.78);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.scene.add(new THREE.HemisphereLight(0x7aa6ff, 0x0a0f18, 1.1));
    const key = new THREE.DirectionalLight(0xffa24a, 2.4);
    key.position.set(-9, 5, -4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x3a7bff, 0.8);
    fill.position.set(8, 6, 9);
    this.scene.add(fill);

    // the sea and the map table under everything
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshBasicMaterial({ color: 0x030b1c }));
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -0.62;
    sea.userData.peek = 'sea';
    this.scene.add(sea);
    this.picks.push(sea);
    const grid = new THREE.GridHelper(120, 120, 0x0b3060, 0x071d3a);
    grid.position.y = -0.6;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(grid);

    this.terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.08 });
    this.terrainMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWp;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWp = (modelMatrix * vec4(transformed,1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          vec2 g = abs(fract(vWp.xz * 1.0) - 0.5); float gl = 1.0 - smoothstep(0.0, 0.03, min(g.x, g.y));
          float c = abs(fract(vWp.y * 3.0) - 0.5); float cl = 1.0 - smoothstep(0.0, 0.04, c);
          totalEmissiveRadiance += vec3(0.05, 0.28, 0.7) * gl * 0.1 + vec3(1.0, 0.55, 0.2) * cl * 0.06 * step(0.35, vWp.y);`,
        );
    };

    this.scene.add(this.river);
    this.orb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 16), new THREE.MeshBasicMaterial({ color: 0xbfe3ff }));
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 3, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0x3f8fff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.orbLight = new THREE.PointLight(0x4aa3ff, 3.5, 5, 1.6);
    this.orb.userData.place = 'price';
    this.scene.add(this.orb, this.beam, this.orbLight);
    this.picks.push(this.orb);

    this.lightsMat = pointsMaterial(220);
    this.lightsPts = new THREE.Points(new THREE.BufferGeometry(), this.lightsMat);
    this.scene.add(this.lightsPts);
    this.scene.add(this.fences);

    // the landmarks, on their pads round the island
    this.landmarks = [this.bookLandmark(new THREE.Vector3(-11.2, 0, 3)), this.ridgeLandmark(new THREE.Vector3(-11.2, 0, -3.2)), this.cubeLandmark(new THREE.Vector3(11.2, 0, 3)), this.waveLandmark(new THREE.Vector3(11.2, 0, -3.2))];
    for (const l of this.landmarks) this.scene.add(l.group);
    this.buildHall(new THREE.Vector3(0, 0, -9.6));
    this.wires = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.scene.add(this.wires);
    this.sparkMat = pointsMaterial(380);
    this.sparks = new THREE.Points(new THREE.BufferGeometry(), this.sparkMat);
    this.scene.add(this.sparks);

    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('click', this.onClick);
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

  // ---------- going places ----------

  private flyTo(pos: THREE.Vector3, target: THREE.Vector3) {
    this.controls.autoRotate = false;
    this.fly = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: pos, t1: target, at: performance.now() };
  }

  /** Fly to a place and open its card. */
  select(place: Place) {
    const a = this.anchorOf(place);
    if (!a) return;
    this.selected = place;
    const dir = new THREE.Vector3(a.x * 0.25, 0, 10).normalize();
    const dist = place === 'council' ? 15 : place.startsWith('agent:') ? 6 : place === 'price' ? 7 : 8.5;
    const lift = place === 'council' ? 0.85 : 0.55;
    this.flyTo(a.clone().add(dir.multiplyScalar(dist)).add(new THREE.Vector3(0, dist * lift, 0)), a.clone());
    this.onSelect(place);
    this.onPeek(null);
  }

  /** Back to the whole island. */
  home() {
    this.selected = null;
    this.flyTo(Island.HOME_POS.clone(), Island.HOME_TARGET.clone());
    this.onSelect(null);
  }

  reset = () => this.home();

  private anchorOf(place: Place): THREE.Vector3 | null {
    if (place === 'price') return this.orb.visible ? this.orb.position.clone() : null;
    if (place === 'council') return this.hall.position.clone().add(new THREE.Vector3(0, 1.2, 0));
    if (place.startsWith('agent:')) {
      const b = this.beacons.find((x) => `agent:${x.id}` === place);
      return b ? b.group.position.clone().add(new THREE.Vector3(0, 0.9, 0)) : null;
    }
    const l = this.landmarks.find((x) => x.id === place);
    return l ? l.anchor.clone() : null;
  }

  // ---------- coordinates ----------

  private wx(u: number) {
    return (u - 0.5) * W;
  }
  private wz(v: number) {
    return (v - 0.5) * D;
  }
  private heightAt(u: number, v: number): number {
    const f = this.frame;
    if (!f) return 0;
    const { cols, rows, h } = f.terrain;
    const c = Math.max(0, Math.min(cols - 1, Math.round(u * (cols - 1))));
    const r = Math.max(0, Math.min(rows - 1, Math.round(v * (rows - 1))));
    return Math.max(0, h[r * cols + c]) * HS;
  }
  private priceU(p: number) {
    const w = this.frame!.window;
    return (p - w.lo) / (w.hi - w.lo);
  }

  // ---------- data ----------

  update(f: IslandFrame) {
    this.frame = f;
    this.buildTerrain(f.terrain);
    this.buildRiver(f.terrain);
    this.buildLights(f);
    this.buildFences(f.positions);
    for (const l of this.landmarks) l.update(f);
    this.updateSwarm(f.agents);
    for (const [place, el] of this.placeTags) {
      const sub = f.tags[place];
      el.innerHTML = `<b>${PLACE_NAME[place] ?? place}</b>${sub ? `<span>${sub}</span>` : ''}`;
    }
  }

  private buildTerrain(tr: Terrain) {
    const { cols, rows, h } = tr;
    const n = cols * rows;
    if (!this.terrainGeo || this.terrainGeo.getAttribute('position').count !== n) {
      this.terrainGeo?.dispose();
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
      this.terrainGeo = g;
      if (this.terrainMesh) {
        this.scene.remove(this.terrainMesh);
        this.picks = this.picks.filter((p) => p !== this.terrainMesh);
      }
      this.terrainMesh = new THREE.Mesh(g, this.terrainMat);
      this.terrainMesh.userData.peek = 'terrain';
      this.scene.add(this.terrainMesh);
      this.picks.push(this.terrainMesh);
    }
    const pos = this.terrainGeo.getAttribute('position') as THREE.BufferAttribute;
    const col = this.terrainGeo.getAttribute('color') as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      pos.setY(i, h[i] >= 0 ? h[i] * HS : h[i] * 3);
      heightColor(h[i], c);
      col.setXYZ(i, c.r, c.g, c.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.terrainGeo.computeVertexNormals();
    this.terrainGeo.computeBoundingSphere();
  }

  private buildRiver(tr: Terrain) {
    for (const ch of [...this.river.children]) {
      this.river.remove(ch);
      (ch as THREE.Mesh).geometry.dispose();
      ((ch as THREE.Mesh).material as THREE.Material).dispose();
    }
    const pts: THREE.Vector3[] = [];
    for (let r = 0; r < tr.rows; r++) {
      const rc = tr.river[r];
      if (!Number.isFinite(rc)) continue;
      const u = rc / tr.cols;
      const v = r / (tr.rows - 1);
      pts.push(new THREE.Vector3(this.wx(u), this.heightAt(u, v) + 0.07, this.wz(v)));
    }
    if (pts.length < 3) {
      this.orb.visible = this.beam.visible = false;
      return;
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const core = new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 3, 0.055, 6, false), new THREE.MeshBasicMaterial({ color: 0x3d8bff }));
    const glow = new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 3, 0.16, 8, false), new THREE.MeshBasicMaterial({ color: 0x1f5cff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.river.add(glow, core);
    const end = pts[pts.length - 1];
    this.orb.visible = this.beam.visible = true;
    this.orb.position.copy(end).add(new THREE.Vector3(0, 0.14, 0));
    this.beam.position.set(end.x, end.y + 1.5, end.z);
    this.orbLight.position.copy(end).add(new THREE.Vector3(0, 0.8, 0));
  }

  private buildLights(f: IslandFrame) {
    const ls = f.lights.slice(-1200);
    const n = ls.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const gold = new THREE.Color('#ffb54a');
    const red = new THREE.Color('#ff3d5e');
    ls.forEach((l, i) => {
      pos.set([this.wx(l.u), this.heightAt(l.u, l.v) + 0.06, this.wz(l.v)], i * 3);
      const c = l.buy ? gold : red;
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = 0.14 + l.size * 0.9;
    });
    this.lightsPts.geometry.dispose();
    this.lightsPts.geometry = pointsGeometry(pos, col, size);
    this.lightsPts.userData.lights = ls;
  }

  private buildFences(ps: IslandPosition[]) {
    for (const ch of [...this.fences.children]) {
      this.fences.remove(ch);
      (ch as THREE.Mesh).geometry.dispose();
      ((ch as THREE.Mesh).material as THREE.Material).dispose();
    }
    if (!this.frame) return;
    for (const p of ps)
      for (const [price, color, what] of [
        [p.target, '#2fe39b', 'target'],
        [p.stop, '#ff4d6a', 'stop'],
        [p.entry, '#e8f1ff', 'entry'],
      ] as [number, string, string][]) {
        const u = this.priceU(price);
        if (u < 0 || u > 1) continue;
        const curtain = new THREE.Mesh(new THREE.PlaneGeometry(D, 1.2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
        curtain.rotation.y = Math.PI / 2;
        curtain.position.set(this.wx(u), 0.8, 0);
        curtain.userData = { peek: 'position', what, price, label: p.label };
        const line = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, D), new THREE.MeshBasicMaterial({ color }));
        line.position.set(this.wx(u), 1.4, 0);
        line.userData = curtain.userData;
        this.fences.add(curtain, line);
      }
  }

  // ---------- landmarks ----------

  /** A pad on the sea with a glowing rim, its name above, and an invisible box to click. */
  private pad(at: THREE.Vector3, id: Place, radius = 2.5, height = 3.2): THREE.Group {
    const g = new THREE.Group();
    g.position.copy(at);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius + 0.15, 0.22, 56), new THREE.MeshStandardMaterial({ color: 0x0a1222, roughness: 0.5, metalness: 0.6 }));
    disc.position.y = -0.48;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(radius + 0.05, 0.025, 8, 96), new THREE.MeshBasicMaterial({ color: 0x3f8fff }));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -0.36;
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 16), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    hit.position.y = height / 2 - 0.4;
    hit.userData.place = id;
    this.picks.push(hit);
    g.add(disc, rim, hit);
    this.placeTags.set(id, this.tag('island-place'));
    return g;
  }

  private bookLandmark(at: THREE.Vector3): Landmark {
    const group = this.pad(at, 'book');
    const N = 48;
    const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), N);
    bars.count = 0;
    const mid = new THREE.Mesh(new THREE.BoxGeometry(0.03, 2.6, 0.03), new THREE.MeshBasicMaterial({ color: 0xe8f1ff }));
    mid.position.y = 0.9;
    group.add(bars, mid);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    return {
      id: 'book',
      group,
      anchor: at.clone().add(new THREE.Vector3(0, 1.4, 0)),
      update: (f) => {
        const n = Math.min(24, f.book.bids.length, f.book.asks.length);
        const mx = Math.max(...f.book.bids.slice(0, n), ...f.book.asks.slice(0, n), 1e-9);
        let k = 0;
        for (let side = 0; side < 2; side++)
          for (let i = 0; i < n; i++) {
            const q = (side ? f.book.asks : f.book.bids)[i] / mx;
            const hh = 0.04 + q * 2.4;
            m.makeScale(0.07, hh, 0.9);
            m.setPosition((side ? 1 : -1) * (0.1 + i * 0.085), -0.37 + hh / 2, 0);
            bars.setMatrixAt(k, m);
            (side ? c.set('#ff7a2f').lerp(new THREE.Color('#ffe1a8'), q) : c.set('#1fd2ff').lerp(new THREE.Color('#c8fff4'), q)).multiplyScalar(0.5 + 0.6 * q);
            bars.setColorAt(k, c);
            k++;
          }
        bars.count = k;
        bars.instanceMatrix.needsUpdate = true;
        if (bars.instanceColor) bars.instanceColor.needsUpdate = true;
      },
      tick: () => undefined,
    };
  }

  private ridgeLandmark(at: THREE.Vector3): Landmark {
    const group = this.pad(at, 'ridge');
    const MAX = 40 * 10;
    const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX);
    bars.count = 0;
    group.add(bars);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    return {
      id: 'ridge',
      group,
      anchor: at.clone().add(new THREE.Vector3(0, 1.4, 0)),
      update: (f) => {
        const { v, cols, slices } = f.ridge;
        let k = 0;
        for (let s = 0; s < slices; s++)
          for (let x = 0; x < cols && k < MAX; x++) {
            const q = v[s * cols + x];
            if (q <= 0.01) continue;
            const hh = 0.03 + Math.pow(q, 0.8) * 2.6;
            m.makeScale((3.4 / cols) * 0.8, hh, (2.2 / slices) * 0.8);
            m.setPosition((x / (cols - 1)) * 3.4 - 1.7, -0.37 + hh / 2, (s / Math.max(1, slices - 1)) * 2.2 - 1.1);
            bars.setMatrixAt(k, m);
            bars.setColorAt(k, magma(Math.pow(q, 0.7), c));
            k++;
          }
        bars.count = k;
        bars.instanceMatrix.needsUpdate = true;
        if (bars.instanceColor) bars.instanceColor.needsUpdate = true;
      },
      tick: () => undefined,
    };
  }

  private cubeLandmark(at: THREE.Vector3): Landmark {
    const group = this.pad(at, 'cube');
    const spin = new THREE.Group();
    spin.position.y = 1.0;
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2.4, 2.4, 2.4)), new THREE.LineBasicMaterial({ color: 0xdfe9ff, transparent: true, opacity: 0.7 }));
    const mat = pointsMaterial(150);
    const pts = new THREE.Points(new THREE.BufferGeometry(), mat);
    spin.add(box, pts);
    group.add(spin);
    return {
      id: 'cube',
      group,
      anchor: at.clone().add(new THREE.Vector3(0, 1.4, 0)),
      update: (f) => {
        const n = f.cloud.length;
        const pos = new Float32Array(n * 3);
        const col = new Float32Array(n * 3);
        const size = new Float32Array(n);
        const c = new THREE.Color();
        f.cloud.forEach((p, i) => {
          pos.set([p.x * 2.4 - 1.2, p.y * 2.4 - 1.2, p.z * 2.4 - 1.2], i * 3);
          jet(p.z, c);
          col.set([c.r, c.g, c.b], i * 3);
          size[i] = 0.12 + p.z * 0.45;
        });
        pts.geometry.dispose();
        pts.geometry = pointsGeometry(pos, col, size);
      },
      tick: (t) => {
        mat.uniforms.uTime.value = t;
        spin.rotation.y = t * 0.18;
      },
    };
  }

  private waveLandmark(at: THREE.Vector3): Landmark {
    const group = this.pad(at, 'wave');
    const holder = new THREE.Group();
    holder.position.y = 1.1;
    const ribbon = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    const edges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xdfe9ff, transparent: true, opacity: 0.85 }));
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(3.6, 2.4, 2)), new THREE.LineBasicMaterial({ color: 0x3a4660, transparent: true, opacity: 0.55 }));
    holder.add(ribbon, edges, box);
    group.add(holder);
    const hues = [new THREE.Color('#3dffb0'), new THREE.Color('#3b6bff'), new THREE.Color('#a03dff')];
    return {
      id: 'wave',
      group,
      anchor: at.clone().add(new THREE.Vector3(0, 1.4, 0)),
      update: (f) => {
        const cs = f.wave.curves;
        const n = cs[0]?.length ?? 0;
        if (n < 2) return;
        const at3 = (k: number, i: number) => [(i / (n - 1)) * 3.6 - 1.8, (cs[k][i] / f.wave.scale) * 1.1, (k - 1) * 0.9];
        const pos: number[] = [];
        const col: number[] = [];
        const idx: number[] = [];
        for (let k = 0; k < 3; k++)
          for (let i = 0; i < n; i++) {
            pos.push(...at3(k, i));
            col.push(hues[k].r, hues[k].g, hues[k].b);
          }
        for (let k = 0; k < 2; k++)
          for (let i = 0; i < n - 1; i++) {
            const a = k * n + i;
            idx.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
          }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        g.setIndex(idx);
        ribbon.geometry.dispose();
        ribbon.geometry = g;
        const lp: number[] = [];
        for (const k of [0, 2]) for (let i = 0; i < n - 1; i++) lp.push(...at3(k, i), ...at3(k, i + 1));
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
        edges.geometry.dispose();
        edges.geometry = lg;
      },
      tick: () => undefined,
    };
  }

  // ---------- the swarm: the council hall and its agents' beacons ----------

  private buildHall(at: THREE.Vector3) {
    this.hall.position.copy(at);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.9, 0.3, 64), new THREE.MeshStandardMaterial({ color: 0x0b1428, roughness: 0.4, metalness: 0.7 }));
    disc.position.y = -0.45;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.75, 0.035, 8, 96), new THREE.MeshBasicMaterial({ color: 0x6fb6ff }));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -0.3;
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), new THREE.MeshStandardMaterial({ color: 0x9fd0ff, emissive: 0x2a6fff, emissiveIntensity: 0.9, roughness: 0.2, metalness: 0.5, flatShading: true }));
    crystal.position.y = 0.8;
    crystal.name = 'crystal';
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 2.4, 16), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    hit.position.y = 0.6;
    hit.userData.place = 'council';
    this.picks.push(hit);
    this.hall.add(disc, rim, crystal, hit);
    this.scene.add(this.hall);
    this.placeTags.set('council', this.tag('island-place'));
  }

  private updateSwarm(agents: IslandAgent[]) {
    if (this.beacons.length !== agents.length) {
      for (const b of this.beacons) {
        this.scene.remove(b.group);
        b.tag.remove();
      }
      this.picks = this.picks.filter((p) => !p.userData.agent);
      this.beacons = agents.map((a, i) => {
        const n = agents.length;
        // an even, shallow arc behind the hall: every beacon 2.4 apart
        const x = -8.4 + (16.8 * i) / Math.max(1, n - 1);
        const g = new THREE.Group();
        g.position.set(this.hall.position.x + x, 0, this.hall.position.z + 1.6 - 2.4 * (1 - (x / 8.4) ** 2));
        const hue = HUES[i % HUES.length];
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 1.2, 10), new THREE.MeshStandardMaterial({ color: 0x1a2440, metalness: 0.8, roughness: 0.3 }));
        pillar.position.y = 0.1;
        const core = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 14), new THREE.MeshBasicMaterial({ color: hue }));
        core.position.y = 0.85;
        const track = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.035, 8, 64), new THREE.MeshBasicMaterial({ color: 0x1c2550 }));
        const ring = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true }));
        for (const r of [track, ring]) {
          r.position.y = 0.85;
          r.rotation.x = -Math.PI / 2 + 0.55;
        }
        const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.55, 0.12, 32), new THREE.MeshStandardMaterial({ color: 0x0b1428, metalness: 0.7, roughness: 0.4 }));
        pad.position.y = -0.5;
        const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1.8, 12), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
        hit.position.y = 0.4;
        hit.userData = { place: `agent:${a.id}`, agent: true };
        this.picks.push(hit);
        g.add(pillar, core, track, ring, pad, hit);
        this.scene.add(g);
        return { id: a.id, group: g, ring, value: -1, tag: this.tag('island-node'), hue };
      });
    }
    const lines: number[] = [];
    const cols: number[] = [];
    const hallTop = this.hall.position.clone().add(new THREE.Vector3(0, 0.8, 0));
    agents.forEach((a, i) => {
      const b = this.beacons[i];
      const v = Math.max(0.02, Math.min(1, a.value));
      if (Math.abs(v - b.value) > 0.01) {
        // the gauge: a rainbow arc as long as the value
        const geo = new THREE.TorusGeometry(0.42, 0.07, 10, 72, v * Math.PI * 2);
        const pos = geo.getAttribute('position');
        const col = new Float32Array(pos.count * 3);
        const c = new THREE.Color();
        for (let k = 0; k < pos.count; k++) {
          const ang = Math.atan2(pos.getY(k), pos.getX(k));
          rainbow(((ang + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2), c);
          col.set([c.r, c.g, c.b], k * 3);
        }
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        b.ring.geometry.dispose();
        b.ring.geometry = geo;
        b.value = v;
      }
      b.tag.innerHTML = `<b>${a.name}</b><span>${a.text}</span>`;
      const p = b.group.position.clone().add(new THREE.Vector3(0, 0.85, 0));
      const c = new THREE.Color(b.hue);
      lines.push(p.x, p.y, p.z, hallTop.x, hallTop.y, hallTop.z);
      cols.push(c.r * 0.6, c.g * 0.6, c.b * 0.6, 0.25, 0.45, 0.9);
      if (a.spoke) this.sparkState.push({ a: p, b: hallTop.clone(), t: 0 });
    });
    // the council watches the price
    if (this.orb.visible) {
      const o = this.orb.position;
      lines.push(hallTop.x, hallTop.y, hallTop.z, o.x, o.y + 0.2, o.z);
      cols.push(0.25, 0.5, 1, 0.5, 0.75, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    this.wires.geometry.dispose();
    this.wires.geometry = g;
  }

  // ---------- pointing ----------

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
    // a drag to orbit is not a click
    if (Math.hypot(e.clientX - this.pointer.downX, e.clientY - this.pointer.downY) > 5) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer = { ...this.pointer, x: e.clientX - r.left, y: e.clientY - r.top, inside: true };
    const hit = this.pick();
    const place = hit?.object.userData.place as Place | undefined;
    if (place) this.select(place);
    else if (this.selected && (!hit || hit.object.userData.peek === 'sea')) this.home();
  };

  private pick(): THREE.Intersection | null {
    if (!this.pointer.inside) return null;
    const ndc = new THREE.Vector2((this.pointer.x / this.w) * 2 - 1, -(this.pointer.y / this.h) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.params.Points = { threshold: 0.08 };
    const hits = this.raycaster.intersectObjects([...this.picks, ...this.fences.children, this.lightsPts], false);
    // places first (their click boxes), then whatever is nearest
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
      return this.onPeek({ ...at, title: PLACE_NAME[place] ?? place, lines: [f.tags[place] ?? '', 'click to visit'].filter(Boolean) });
    }
    if (o.userData.peek === 'position') return this.onPeek({ ...at, title: `${o.userData.what.toUpperCase()} ${fmt(o.userData.price)}`, lines: [o.userData.label], tone: o.userData.what === 'stop' ? 'sell' : 'buy' });
    if (o === this.lightsPts && hit.index !== undefined) {
      const l = (this.lightsPts.userData.lights as Light[] | undefined)?.[hit.index];
      if (l) return this.onPeek({ ...at, title: `${l.buy ? 'BUY' : 'SELL'} ${l.qty.toPrecision(4)} @ ${fmt(l.price)}`, lines: [`$${(l.qty * l.price).toLocaleString('en-US', { maximumFractionDigits: 0 })} · ${clock(l.time)}`, l.buy ? 'a buyer lifted the offer' : 'a seller hit the bid'], tone: l.buy ? 'buy' : 'sell' });
    }
    if (o.userData.peek === 'terrain') {
      const u = hit.point.x / W + 0.5;
      const v = hit.point.z / D + 0.5;
      const { cols, rows, qty, top } = f.terrain;
      const c = Math.max(0, Math.min(cols - 1, Math.floor(u * cols)));
      const r = Math.max(0, Math.min(rows - 1, Math.floor(v * rows)));
      const price = f.window.lo + (c + 0.5) * ((f.window.hi - f.window.lo) / cols);
      const time = f.window.t0 + (r + 0.5) * ((f.window.t1 - f.window.t0) / rows);
      const q = qty[r * cols + c];
      return this.onPeek({ ...at, title: `${fmt(price)} at ${clock(time)}`, lines: [`resting orders ${q.toPrecision(3)} (${Math.round((q / top) * 100)}% of the tallest wall)`, q >= top * 0.8 ? 'a wall: price tends to stall or turn here' : q <= top * 0.1 ? 'thin: price moves through here easily' : 'ordinary depth'] });
    }
    this.onPeek(null);
  }

  // ---------- the loop ----------

  private loop = (ts: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (ts - (this.last || ts)) / 1000);
    this.last = ts;
    if (document.hidden || !this.host.offsetParent) return;
    this.acc += dt;
    if (this.acc < 1 / 30) return;
    const step = this.acc;
    this.acc = 0;
    this.t += step;
    const t = this.t;
    if (this.fly) {
      const f = this.fly;
      // about a second, by the clock (the same on a slow computer)
      const k = Math.min(1, (performance.now() - f.at) / 1100);
      const e = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
      this.camera.position.lerpVectors(f.p0, f.p1, e);
      this.controls.target.lerpVectors(f.t0, f.t1, e);
      if (k >= 1) this.fly = null;
    }
    this.controls.update();
    this.lightsMat.uniforms.uTime.value = t;
    this.sparkMat.uniforms.uTime.value = t;
    (this.beam.material as THREE.MeshBasicMaterial).opacity = 0.22 + 0.1 * Math.sin(t * 2.2);
    for (const l of this.landmarks) l.tick(t);
    const crystal = this.hall.getObjectByName('crystal');
    if (crystal) {
      crystal.rotation.y = t * 0.5;
      crystal.position.y = 0.8 + Math.sin(t * 1.3) * 0.08;
    }
    // sparks: an agent that speaks sends one to the council
    this.sparkState = this.sparkState.filter((s) => (s.t += step * 0.8) < 1).slice(-16);
    const n = this.sparkState.length;
    const sp = new Float32Array(n * 3);
    const sc = new Float32Array(n * 3).fill(0.85);
    this.sparkState.forEach((s, i) => {
      const p = s.a.clone().lerp(s.b, s.t);
      p.y += Math.sin(s.t * Math.PI) * 0.5;
      sp.set([p.x, p.y, p.z], i * 3);
    });
    this.sparks.geometry.dispose();
    this.sparks.geometry = pointsGeometry(sp, sc, new Float32Array(n).fill(1));

    // labels follow their objects
    this.place(this.priceTag, this.orb.visible ? this.orb.position.clone().add(new THREE.Vector3(0, 0.45, 0)) : null, this.frame?.price ? fmt(this.frame.price) : '');
    for (const [place, el] of this.placeTags) {
      const a = this.anchorOf(place);
      this.place(el, a && place !== this.selected ? a.add(new THREE.Vector3(0, place === 'council' ? 2.6 : 2.1, 0)) : null);
    }
    // agents' names alternate high and low so neighbours never overlap
    this.beacons.forEach((b, i) => this.place(b.tag, `agent:${b.id}` === this.selected ? null : b.group.position.clone().add(new THREE.Vector3(0, i % 2 ? 1.85 : 1.35, 0))));
    if (this.detail) {
      const a = this.selected ? this.anchorOf(this.selected) : null;
      if (!a) this.detail.style.visibility = 'hidden';
      else {
        const v = a.project(this.camera);
        const x = Math.min(this.w - 360, Math.max(12, (v.x * 0.5 + 0.5) * this.w + 70));
        const y = Math.min(this.h - 260, Math.max(12, (-v.y * 0.5 + 0.5) * this.h - 120));
        this.detail.style.visibility = 'visible';
        this.detail.style.transform = `translate(${x}px, ${y}px)`;
      }
    }
    if (this.pointer.moved || this.fly) {
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
    if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) {
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
