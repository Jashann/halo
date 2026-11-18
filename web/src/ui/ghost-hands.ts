import * as THREE from 'three';
import type { AideContext } from '../context.js';
import { resolvePlace } from '../shell/place.js';
import { makeLabel, type Label } from './label.js';
import { THEME } from './theme.js';
import { glowMaterial } from './glow.js';
import { springIn, springOut } from './springs.js';
import { SkinnedHand, makeGlowHandMaterial } from './hand-model.js';

// Two translucent demonstration hands that perform a motion beside the user's work spot, seen from the
// user's own point of view (fingers away from the user, right hand on the right). Procedural keyframes for
// chop, dice, julienne, whisk, flip; custom keyframes from the agent's args. 2 instanced draw calls for the
// hands, a few for props.

export interface HandPose {
  pos: [number, number, number]; // metres, local to the anchor: x = user's right, y = up, z = toward user
  rot?: [number, number, number]; // radians: pitch (X), yaw (Y), roll (Z), applied in XYZ order
  curl?: number; // 0 = open, 1 = fist
  thumb?: number; // thumb curl
  visible?: boolean;
}
export interface Frame {
  left: HandPose;
  right: HandPose;
  props?: Record<string, { pos?: [number, number, number]; rot?: [number, number, number]; visible?: boolean }>;
}
export interface Keyframe {
  t: number; // seconds
  left?: Partial<HandPose> & { rot_deg?: [number, number, number] };
  right?: Partial<HandPose> & { rot_deg?: [number, number, number] };
}

export const MOTIONS = ['chop', 'dice', 'julienne', 'whisk', 'flip', 'stir', 'pinch', 'grab', 'wave'] as const;
const TAU = Math.PI * 2;

const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const frac = (x: number) => x - Math.floor(x);

/** Procedural motions: (time in seconds) -> pose of both hands and props. Period in `PERIOD`. */
export const PERIOD: Record<string, number> = { chop: 4, dice: 4.8, julienne: 4, whisk: 2, flip: 2.6, stir: 3, pinch: 2, grab: 3, wave: 2 };

const KNIFE_GRIP: [number, number, number] = [0, -Math.PI / 2, 0];

export function motionFrame(motion: string, t: number): Frame {
  switch (motion) {
    case 'chop': {
      // Knife rises and falls at 2 Hz, walking left along a carrot; the guide hand (claw) steps back with it.
      const p = frac(t / PERIOD.chop);
      const along = 0.07 - 0.1 * p; // knife x moves right -> left
      const beat = Math.max(0, Math.sin(t * TAU * 1.6));
      return {
        right: { pos: [along + 0.02, 0.055 + 0.055 * beat, 0.0], rot: [0.25 * beat, KNIFE_GRIP[1], 0], curl: 0.8, thumb: 0.6 },
        left: { pos: [along - 0.075, 0.035, -0.01], rot: [0.35, 0.25, 0], curl: 0.62, thumb: 0.5 },
        props: { knife: { visible: true }, carrot: { visible: true, pos: [0, 0.012, 0] }, board: { visible: true } },
      };
    }
    case 'dice': {
      // Grid of cuts: four lengthwise strokes, then a crosswise pass.
      const p = frac(t / PERIOD.dice);
      const beat = Math.max(0, Math.sin(t * TAU * 2.2));
      const phaseA = p < 0.5;
      const k = phaseA ? p / 0.5 : (p - 0.5) / 0.5;
      const x = phaseA ? 0.05 : 0.06 - 0.12 * k;
      const z = phaseA ? 0.03 - 0.06 * Math.floor(k * 4) / 3 : 0;
      const yaw = phaseA ? 0 : KNIFE_GRIP[1];
      return {
        right: { pos: [x + 0.02, 0.05 + 0.045 * beat, z], rot: [0.22 * beat, yaw, 0], curl: 0.8, thumb: 0.6 },
        left: { pos: [-0.09, 0.035, -0.0], rot: [0.35, 0.25, 0], curl: 0.6, thumb: 0.5 },
        props: { knife: { visible: true }, cubes: { visible: true }, board: { visible: true } },
      };
    }
    case 'julienne': {
      // Long rocking slices: knife slides forward while it goes down, back while it rises.
      const s = frac(t * 1.4);
      const down = s < 0.5 ? smooth(s / 0.5) : 1 - smooth((s - 0.5) / 0.5);
      const p = frac(t / PERIOD.julienne);
      const x = 0.06 - 0.09 * p;
      return {
        right: { pos: [x + 0.02, 0.1 - 0.075 * down, 0.03 - 0.06 * down], rot: [-0.25 + 0.35 * down, KNIFE_GRIP[1], 0], curl: 0.8, thumb: 0.6 },
        left: { pos: [x - 0.07, 0.035, -0.01], rot: [0.35, 0.25, 0], curl: 0.6, thumb: 0.5 },
        props: { knife: { visible: true }, sticks: { visible: true }, board: { visible: true } },
      };
    }
    case 'whisk': {
      const a = t * TAU * 1.6;
      return {
        right: { pos: [0.015 + 0.035 * Math.cos(a), 0.17, 0.0 + 0.03 * Math.sin(a)], rot: [0.15 * Math.sin(a), 0, -Math.PI / 2 + 0.25 * Math.cos(a)], curl: 0.85, thumb: 0.7 },
        left: { pos: [-0.12, 0.07, 0.02], rot: [0, 0.6, Math.PI / 2.4], curl: 0.45, thumb: 0.2 },
        props: { whisk: { visible: true }, bowl: { visible: true } },
      };
    }
    case 'flip': {
      // slide under (0-0.35), lift and turn the wrist (0.35-0.6), lower (0.6-1)
      const p = frac(t / PERIOD.flip);
      const slide = smooth(clamp01(p / 0.35));
      const lift = p < 0.35 ? 0 : p < 0.6 ? smooth((p - 0.35) / 0.25) : 1 - smooth((p - 0.6) / 0.4);
      const turn = p < 0.4 ? 0 : p < 0.6 ? smooth((p - 0.4) / 0.2) : 1;
      return {
        right: { pos: [0.11 - 0.06 * slide, 0.04 + 0.12 * lift, 0.09 - 0.05 * slide], rot: [0, -0.4, -turn * 2.2], curl: 0.8, thumb: 0.6 },
        left: { pos: [-0.2, 0.05, 0.08], rot: [0, 0.9, 0.4], curl: 0.75, thumb: 0.6 },
        props: {
          spatula: { visible: true },
          pan: { visible: true },
          pancake: { visible: true, pos: [0.0, 0.03 + 0.12 * lift, 0.0], rot: [Math.PI * turn, 0, 0] },
        },
      };
    }
    case 'stir': {
      const a = t * TAU * 0.7;
      return {
        right: { pos: [0.0 + 0.06 * Math.cos(a), 0.12, 0.0 + 0.05 * Math.sin(a)], rot: [0.5, -0.4, -0.3], curl: 0.8, thumb: 0.6 },
        left: { pos: [-0.2, 0.05, 0.08], rot: [0, 0.9, 0.4], curl: 0.75, thumb: 0.6 },
        props: { spatula: { visible: true }, pan: { visible: true } },
      };
    }
    case 'grab': {
      const p = frac(t / PERIOD.grab);
      const reach = smooth(clamp01(p / 0.35));
      const close = smooth(clamp01((p - 0.35) / 0.15));
      const lift = p < 0.5 ? 0 : p < 0.8 ? smooth((p - 0.5) / 0.3) : 1 - smooth((p - 0.8) / 0.2);
      return {
        right: { pos: [0.05, 0.06 + 0.1 * lift + 0.04 * (1 - reach), 0.06 - 0.1 * reach], rot: [0.3, 0, -0.5], curl: 0.15 + 0.6 * close, thumb: 0.2 + 0.5 * close },
        left: { pos: [-0.08, 0.13, 0.02], rot: [0, 0, 0], curl: 0.1, thumb: 0.1, visible: false },
      };
    }
    case 'pinch': {
      const s = 0.5 + 0.5 * Math.sin(t * TAU * 0.6);
      return {
        right: { pos: [0.06, 0.15, 0], rot: [0.2, 0, -0.3], curl: 0.15 + 0.5 * s, thumb: 0.2 + 0.6 * s },
        left: { pos: [-0.08, 0.13, 0.02], rot: [0.1, 0, 0.3], curl: 0.1, thumb: 0.1, visible: false },
      };
    }
    case 'wave':
    default: {
      return {
        right: { pos: [0.07, 0.22, 0], rot: [-1.3, 0, 0.35 * Math.sin(t * TAU * 1.2)], curl: 0.05, thumb: 0 },
        left: { pos: [-0.08, 0.13, 0.02], rot: [0, 0, 0], curl: 0.1, thumb: 0.1, visible: false },
      };
    }
  }
}

function lerp(a: number, b: number, k: number) {
  return a + (b - a) * k;
}
function lerpPose(a: HandPose, b: HandPose, k: number): HandPose {
  const ra = a.rot ?? [0, 0, 0];
  const rb = b.rot ?? [0, 0, 0];
  return {
    pos: [lerp(a.pos[0], b.pos[0], k), lerp(a.pos[1], b.pos[1], k), lerp(a.pos[2], b.pos[2], k)],
    rot: [lerp(ra[0], rb[0], k), lerp(ra[1], rb[1], k), lerp(ra[2], rb[2], k)],
    curl: lerp(a.curl ?? 0.2, b.curl ?? 0.2, k),
    thumb: lerp(a.thumb ?? 0.2, b.thumb ?? 0.2, k),
    visible: k < 0.5 ? a.visible : b.visible,
  };
}

const DEFAULT_LEFT: HandPose = { pos: [-0.09, 0.08, 0.02], rot: [0, 0, 0], curl: 0.2, thumb: 0.2, visible: true };
const DEFAULT_RIGHT: HandPose = { pos: [0.09, 0.08, 0.02], rot: [0, 0, 0], curl: 0.2, thumb: 0.2, visible: true };

function normKey(k: Keyframe['left'], base: HandPose): HandPose {
  if (!k) return base;
  const rot = k.rot_deg ? (k.rot_deg.map((d) => (d * Math.PI) / 180) as [number, number, number]) : k.rot ?? base.rot;
  return {
    pos: (Array.isArray(k.pos) && k.pos.length >= 3 ? k.pos.slice(0, 3) : base.pos) as [number, number, number],
    rot,
    curl: typeof k.curl === 'number' ? k.curl : base.curl,
    thumb: typeof k.thumb === 'number' ? k.thumb : base.thumb,
    visible: k.visible ?? base.visible ?? true,
  };
}

const POSES: Record<string, { curl: number; thumb: number }> = {
  open: { curl: 0.08, thumb: 0.1 },
  pinch: { curl: 0.4, thumb: 0.75 },
  fist: { curl: 0.95, thumb: 0.8 },
  point: { curl: 0.75, thumb: 0.6 },
  grab: { curl: 0.7, thumb: 0.6 },
};

/** Server schema: [{t, hand: "left"|"right", pose: "open"|"pinch"|"fist"|"point", position:[x,y,z]}] -> per-frame keys. */
function fromHandKeys(raw: Record<string, unknown>[]): Keyframe[] {
  const byT = new Map<number, Keyframe>();
  for (const k of raw) {
    const t = Number(k.t);
    if (!Number.isFinite(t)) throw new Error('each keyframe needs a numeric t (seconds)');
    const hand = k.hand === 'left' ? 'left' : 'right';
    const pose = POSES[String(k.pose ?? 'open')] ?? POSES.open;
    const kf = byT.get(t) ?? { t };
    const entry: Keyframe['left'] = { ...pose, visible: true };
    if (Array.isArray(k.position) && k.position.length >= 3) entry.pos = k.position.slice(0, 3).map(Number) as [number, number, number];
    if (Array.isArray(k.rotation)) entry.rot_deg = k.rotation.slice(0, 3).map(Number) as [number, number, number];
    kf[hand] = entry;
    byT.set(t, kf);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** Validate and normalise agent keyframes; throws on unusable input. */
export function normalizeKeyframes(raw: unknown): { keys: { t: number; left: HandPose; right: HandPose }[]; duration: number } {
  if (!Array.isArray(raw) || raw.length < 2) throw new Error('keyframes must be an array of at least 2 {t, left?, right?}');
  if (raw.some((k) => k && typeof k === 'object' && 'hand' in k)) {
    const hk = fromHandKeys(raw as Record<string, unknown>[]);
    const usesLeft = hk.some((k) => k.left);
    if (!usesLeft) for (const k of hk) k.left = { visible: false };
    raw = hk;
    if ((raw as unknown[]).length < 2) (raw as Keyframe[]).push({ ...(raw as Keyframe[])[0], t: (raw as Keyframe[])[0].t + 1 });
  }
  const keys: { t: number; left: HandPose; right: HandPose }[] = [];
  let prevL = DEFAULT_LEFT;
  let prevR = DEFAULT_RIGHT;
  for (const k of raw as Keyframe[]) {
    if (!k || typeof k.t !== 'number' || !Number.isFinite(k.t)) throw new Error('each keyframe needs a numeric t (seconds)');
    prevL = normKey(k.left, prevL);
    prevR = normKey(k.right, prevR);
    keys.push({ t: k.t, left: prevL, right: prevR });
  }
  keys.sort((a, b) => a.t - b.t);
  const duration = Math.max(0.2, keys[keys.length - 1].t);
  return { keys, duration };
}

export function keyframeAt(keys: { t: number; left: HandPose; right: HandPose }[], t: number): Frame {
  if (t <= keys[0].t) return { left: keys[0].left, right: keys[0].right };
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      const k = smooth((t - a.t) / Math.max(1e-6, b.t - a.t));
      return { left: lerpPose(a.left, b.left, k), right: lerpPose(a.right, b.right, k) };
    }
  }
  const last = keys[keys.length - 1];
  return { left: last.left, right: last.right };
}

// ---------------------------------------------------------------------------------------------------------
// Hand rig

interface Seg {
  node: THREE.Object3D;
  len: number;
  r: number;
}
interface Finger {
  base: THREE.Object3D;
  joints: THREE.Object3D[];
  thumb: boolean;
}

class GhostHand {
  root = new THREE.Object3D();
  palm = new THREE.Object3D();
  fingers: Finger[] = [];
  segs: Seg[] = [];
  mesh: THREE.InstancedMesh;
  shell: THREE.InstancedMesh; // larger additive copy: the glow around each segment
  grip = new THREE.Object3D(); // where held props attach

  constructor(public side: 'left' | 'right', geo: THREE.BufferGeometry, mat: THREE.Material, shellMat: THREE.Material) {
    const sx = side === 'right' ? 1 : -1; // thumb on -X for the right hand (palm down)
    this.root.add(this.palm);
    this.segs.push({ node: this.palm, len: 0.095, r: 0.0 });
    const fingerX = [-0.026, -0.009, 0.008, 0.024];
    const lens = [
      [0.042, 0.025, 0.022],
      [0.046, 0.028, 0.024],
      [0.043, 0.027, 0.023],
      [0.034, 0.02, 0.02],
    ];
    const radii = [0.0085, 0.0088, 0.0083, 0.0074];
    for (let f = 0; f < 4; f++) {
      const base = new THREE.Object3D();
      base.position.set(fingerX[f] * sx, 0, -0.085 + Math.abs(f - 1.2) * 0.004);
      this.root.add(base);
      const joints: THREE.Object3D[] = [];
      let parent: THREE.Object3D = base;
      for (let s = 0; s < 3; s++) {
        const j = new THREE.Object3D();
        if (s > 0) j.position.z = -lens[f][s - 1];
        parent.add(j);
        joints.push(j);
        this.segs.push({ node: j, len: lens[f][s], r: radii[f] * (1 - s * 0.08) });
        parent = j;
      }
      this.fingers.push({ base, joints, thumb: false });
    }
    // thumb
    const tb = new THREE.Object3D();
    tb.position.set(-0.03 * sx, -0.006, -0.025);
    tb.rotation.set(0, 0.75 * sx, -0.5 * sx);
    this.root.add(tb);
    const tj: THREE.Object3D[] = [];
    let parent: THREE.Object3D = tb;
    const tl = [0.04, 0.032, 0.026];
    for (let s = 0; s < 3; s++) {
      const j = new THREE.Object3D();
      if (s > 0) j.position.z = -tl[s - 1];
      parent.add(j);
      tj.push(j);
      this.segs.push({ node: j, len: tl[s], r: 0.0098 * (1 - s * 0.1) });
      parent = j;
    }
    this.fingers.push({ base: tb, joints: tj, thumb: true });
    // grip point: inside the curled fist, below the palm
    this.grip.position.set(0, -0.022, -0.06);
    this.root.add(this.grip);
    this.mesh = new THREE.InstancedMesh(geo, mat, this.segs.length);
    this.mesh.frustumCulled = false;
    this.mesh.name = `ghost-hand-${side}`;
    this.shell = new THREE.InstancedMesh(geo, shellMat, this.segs.length);
    this.shell.frustumCulled = false;
    this.shell.renderOrder = 2;
  }

  curl = 0.2;
  thumbCurl = 0.2;

  apply(p: HandPose) {
    this.curl = p.curl ?? 0.2;
    this.thumbCurl = p.thumb ?? 0.2;
    this.root.visible = p.visible !== false;
    this.mesh.visible = this.root.visible;
    this.shell.visible = this.root.visible;
    this.root.position.set(p.pos[0], p.pos[1], p.pos[2]);
    const r = p.rot ?? [0, 0, 0];
    this.root.rotation.set(r[0], r[1], r[2], 'XYZ');
    const curl = p.curl ?? 0.2;
    const thumb = p.thumb ?? 0.2;
    for (const f of this.fingers) {
      const c = f.thumb ? thumb : curl;
      f.joints.forEach((j, i) => {
        const max = f.thumb ? [0.35, 0.6, 0.7][i] : [1.45, 1.6, 1.1][i];
        j.rotation.x = -c * max;
        if (f.thumb) j.rotation.y = 0;
      });
    }
  }

  private m = new THREE.Matrix4();
  private t = new THREE.Matrix4();
  private s = new THREE.Matrix4();
  private rx = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  private grow = new THREE.Matrix4().makeScale(1.45, 1.15, 1.45);

  writeInstances(anchorInv: THREE.Matrix4) {
    this.root.updateMatrixWorld(true);
    this.segs.forEach((seg, i) => {
      this.m.multiplyMatrices(anchorInv, seg.node.matrixWorld);
      if (i === 0) {
        // palm: flattened ellipsoid centred half-way to the knuckles
        this.t.makeTranslation(0, -0.002, -0.045);
        this.s.makeScale(0.078, 0.1, 0.03);
      } else {
        this.t.makeTranslation(0, 0, -seg.len / 2);
        this.s.makeScale(seg.r * 2, seg.len * 1.25, seg.r * 2);
      }
      this.m.multiply(this.t).multiply(this.rx).multiply(this.s);
      this.mesh.setMatrixAt(i, this.m);
      this.m.multiply(this.grow);
      this.shell.setMatrixAt(i, this.m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.shell.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Props

function propMat(color: string, opacity = 0.55) {
  return new THREE.MeshLambertMaterial({ color, transparent: true, opacity, depthWrite: false, emissive: color, emissiveIntensity: 0.25 });
}

function buildProps(): Record<string, THREE.Object3D> {
  const props: Record<string, THREE.Object3D> = {};
  const knife = new THREE.Group();
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.038, 0.17), propMat('#dfe7ef', 0.75));
  blade.position.set(0, -0.012, -0.11);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.022, 0.1), propMat('#2a2f36', 0.8));
  handle.position.set(0, 0, 0.0);
  knife.add(blade, handle);
  // The knife is held in the right grip: handle across the fist, blade toward the thumb side, edge down.
  knife.rotation.set(0, Math.PI / 2, 0);
  props.knife = knife;

  const carrot = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.2, 14), propMat('#ff8a2a', 0.8));
  carrot.rotation.z = Math.PI / 2;
  props.carrot = carrot;

  const cubes = new THREE.Group();
  const cubeGeo = new THREE.BoxGeometry(0.012, 0.012, 0.012);
  const cubeMat = propMat('#ffd166', 0.8);
  for (let i = 0; i < 12; i++) {
    const c = new THREE.Mesh(cubeGeo, cubeMat);
    c.position.set(-0.06 + (i % 4) * 0.018, 0.006, -0.01 + Math.floor(i / 4) * 0.018);
    cubes.add(c);
  }
  props.cubes = cubes;

  const sticks = new THREE.Group();
  const stickGeo = new THREE.BoxGeometry(0.06, 0.004, 0.004);
  const stickMat = propMat('#ff8a2a', 0.85);
  for (let i = 0; i < 8; i++) {
    const s = new THREE.Mesh(stickGeo, stickMat);
    s.position.set(-0.07, 0.003, -0.02 + i * 0.006);
    sticks.add(s);
  }
  props.sticks = sticks;

  const board = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.012, 0.22), propMat('#c89b62', 0.35));
  board.position.y = -0.006;
  props.board = board;

  const whisk = new THREE.Group();
  const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.009, 0.1, 10), propMat('#2a2f36', 0.8));
  wh.position.y = 0.0;
  whisk.add(wh);
  const loopGeo = new THREE.TorusGeometry(0.03, 0.0012, 6, 24);
  for (let i = 0; i < 4; i++) {
    const loop = new THREE.Mesh(loopGeo, propMat('#e8eef5', 0.85));
    loop.scale.set(0.8, 1.7, 1);
    loop.position.y = -0.095;
    loop.rotation.y = (i / 4) * Math.PI;
    whisk.add(loop);
  }
  // whisk hangs down out of the fist
  whisk.rotation.set(0, 0, Math.PI / 2);
  props.whisk = whisk;

  const bowlGeo = new THREE.SphereGeometry(0.1, 28, 12, 0, TAU, Math.PI / 2, Math.PI / 2);
  const bowl = new THREE.Mesh(bowlGeo, propMat('#9fd3ff', 0.3));
  (bowl.material as THREE.Material).side = THREE.DoubleSide;
  bowl.position.set(0, 0.1, 0);
  props.bowl = bowl;

  const spatula = new THREE.Group();
  const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.007, 0.12, 8), propMat('#2a2f36', 0.8));
  sh.rotation.x = Math.PI / 2;
  sh.position.z = -0.02;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.003, 0.08), propMat('#e8eef5', 0.8));
  head.position.set(0, -0.012, -0.12);
  spatula.add(sh, head);
  spatula.rotation.set(0, Math.PI / 2, 0);
  props.spatula = spatula;

  const pan = new THREE.Group();
  const panBody = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.11, 0.035, 32, 1, true), propMat('#3b4450', 0.45));
  (panBody.material as THREE.Material).side = THREE.DoubleSide;
  panBody.position.y = 0.017;
  const panBase = new THREE.Mesh(new THREE.CircleGeometry(0.11, 32), propMat('#3b4450', 0.45));
  panBase.rotation.x = -Math.PI / 2;
  const panHandle = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.014, 0.025), propMat('#2a2f36', 0.7));
  panHandle.position.set(-0.2, 0.03, 0.06);
  panHandle.rotation.y = -0.35;
  pan.add(panBody, panBase, panHandle);
  props.pan = pan;

  const pancake = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.008, 24), propMat('#f2c46d', 0.85));
  props.pancake = pancake;
  return props;
}

const HELD: Record<string, 'right' | 'left'> = { knife: 'right', whisk: 'right', spatula: 'right' };

const TRAIL = 30; // points per fingertip trail
const SCALE = 1.15; // a touch larger than life so the motion reads from a seated distance
const OPACITY = 0.72;

export class GhostHands {
  group = new THREE.Group(); // placed beside the work zone, springs in/out
  private stage = new THREE.Group(); // tilted toward the viewer; hands and props live here
  private hands: { left: GhostHand; right: GhostHand };
  private props: Record<string, THREE.Object3D>;
  private caption?: Label;
  motion = '';
  private keys: { t: number; left: HandPose; right: HandPose }[] | null = null;
  private duration = 4;
  private started = 0;
  private until = Infinity;
  private fading = false;
  private mat: THREE.MeshLambertMaterial;
  private shellMat: THREE.MeshBasicMaterial;
  private anchorInv = new THREE.Matrix4();
  private trail: THREE.InstancedMesh;
  private trailPts: THREE.Vector3[][] = [[], []];
  private trailHead = 0;
  private plate: THREE.Mesh;
  private tmp = new THREE.Vector3();
  private tm = new THREE.Matrix4();
  private skinned: { left: SkinnedHand; right: SkinnedHand };
  private wm = new THREE.Matrix4();
  /** Positions of other things in the room (panels, timers) that the demonstration should keep clear of. */
  avoid: () => THREE.Vector3[] = () => [];

  constructor(private ctx: AideContext) {
    const geo = new THREE.SphereGeometry(0.5, 16, 12);
    this.mat = new THREE.MeshLambertMaterial({
      color: '#fff6dc',
      emissive: THEME.halo,
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: OPACITY,
      depthWrite: false,
    });
    this.shellMat = new THREE.MeshBasicMaterial({
      color: THEME.halo,
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.hands = { left: new GhostHand('left', geo, this.mat, this.shellMat), right: new GhostHand('right', geo, this.mat, this.shellMat) };
    this.group.name = 'ghost-hands';
    this.group.add(this.stage);
    this.stage.add(this.hands.left.root, this.hands.right.root, this.hands.left.shell, this.hands.right.shell, this.hands.left.mesh, this.hands.right.mesh);
    this.hands.left.root.visible = false;
    // the real hand meshes (WebXR generic hand); the simple rig above stays as the skeleton driver and fallback
    const handMat = makeGlowHandMaterial();
    const base = (import.meta as any).env?.BASE_URL ?? './';
    this.skinned = { left: new SkinnedHand('left', handMat, base), right: new SkinnedHand('right', handMat, base) };
    this.stage.add(this.skinned.left.root, this.skinned.right.root);
    this.props = buildProps();
    for (const [name, obj] of Object.entries(this.props)) {
      obj.visible = false;
      obj.name = `prop:${name}`;
      const holder = HELD[name];
      if (holder) this.hands[holder].grip.add(obj);
      else this.stage.add(obj);
    }
    // fingertip trails: fading glowing beads
    this.trail = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 8, 6),
      new THREE.MeshBasicMaterial({ color: THEME.halo, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
      TRAIL * 2,
    );
    this.trail.frustumCulled = false;
    this.stage.add(this.trail);
    // a soft glowing stage disc under the demonstration
    this.plate = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), glowMaterial(THEME.halo, 0.22));
    this.plate.rotation.x = -Math.PI / 2;
    this.plate.position.y = -0.004;
    this.stage.add(this.plate);
    this.group.visible = false;
  }

  get active() {
    return this.group.visible && !this.fading;
  }

  play(args: { motion?: string; at?: unknown; keyframes?: unknown; loops?: number; duration?: number; loop?: boolean; caption?: string; tool?: string; beside?: boolean }) {
    const motion = String(args.motion ?? 'chop').toLowerCase();
    if (motion === 'stop' || motion === 'none' || motion === 'off') {
      this.stop();
      return { stopped: true };
    }
    if (motion === 'custom' || args.keyframes) {
      const { keys, duration } = normalizeKeyframes(args.keyframes);
      this.keys = keys;
      this.duration = duration;
      this.motion = 'custom';
    } else {
      if (!(MOTIONS as readonly string[]).includes(motion)) {
        throw new Error(`unknown motion "${motion}"; use one of ${MOTIONS.join(', ')} or keyframes`);
      }
      this.keys = null;
      this.motion = motion;
      this.duration = PERIOD[motion] ?? 3;
    }
    const head = this.ctx.head();
    const place = resolvePlace(args.at ?? 'table', this.ctx.surfaces(), head, 'hands');
    // Beside the work zone: shifted to the user's right (or left when that is closer to their centre of view),
    // raised a little, and turned/tilted toward the eyes so the motion reads at a glance.
    const toUser = place.facing.clone();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), toUser).normalize();
    const p = place.position.clone();
    if (args.beside !== false) {
      // left of the work zone by default (timers and pans usually go to the right); right if left is out of view
      const side = right.clone().multiplyScalar(0.3);
      const left = p.clone().sub(side);
      const rightP = p.clone().add(side);
      const ahead = (v: THREE.Vector3) => v.clone().sub(head.position).setY(0).normalize().dot(head.forward);
      // pick the side that is in view and furthest from panels and timers already in the room
      const others = this.avoid();
      const clearance = (v: THREE.Vector3) => (others.length ? Math.min(...others.map((o) => Math.hypot(o.x - v.x, o.z - v.z) + Math.max(0, o.y - v.y - 0.35))) : 1);
      const score = (v: THREE.Vector3) => (ahead(v) > 0.55 ? 1 : 0) + Math.min(0.6, clearance(v)) + (v === left ? 0.05 : 0);
      p.copy(score(left) >= score(rightP) ? left : rightP);
      p.y += 0.06;
    }
    this.group.position.copy(p);
    const toHead = head.position.clone().sub(p);
    const yaw = Math.atan2(toHead.x, toHead.z);
    this.group.rotation.set(0, yaw, 0);
    const dy = head.position.y - p.y;
    const dz = Math.max(0.2, Math.hypot(toHead.x, toHead.z));
    this.stage.rotation.set(Math.min(0.55, Math.atan2(dy, dz) * 0.5), 0, 0); // tip the board toward the viewer
    if (!this.group.parent) this.ctx.root.add(this.group);
    const wasVisible = this.group.visible && !this.fading;
    this.group.visible = true;
    this.fading = false;
    if (!wasVisible) springIn(this.group, SCALE);
    else this.group.scale.setScalar(SCALE);
    this.started = this.ctx.now();
    const loops = args.loop ? Infinity : Math.max(1, Math.min(20, Number(args.loops ?? 3)));
    this.until = typeof args.duration === 'number' ? this.started + args.duration : this.started + this.duration * loops;
    for (const obj of Object.values(this.props)) obj.visible = false;
    if (this.keys && args.tool && this.props[args.tool]) this.props[args.tool].visible = true;
    this.trailPts = [[], []];
    this.caption?.dispose();
    this.caption = undefined;
    const cap = args.caption ?? (this.motion === 'custom' ? '' : this.motion[0].toUpperCase() + this.motion.slice(1));
    if (cap) {
      this.caption = makeLabel(String(cap), { height: 0.03, border: 'rgba(255,210,122,0.6)' });
      this.caption.mesh.position.set(0, 0.2, 0);
      this.group.add(this.caption.mesh);
      this.ctx.billboard(this.caption.mesh);
    }
    this.update(this.started);
    return { motion: this.motion, period: round(this.duration), until: isFinite(this.until) ? round(this.until - this.started) : 'loop' };
  }

  stop() {
    if (!this.group.visible || this.fading) return;
    this.fading = true;
    springOut(this.group, () => {
      this.group.visible = false;
      this.fading = false;
      this.motion = '';
      if (this.caption) this.ctx.billboard(this.caption.mesh, false);
      this.caption?.dispose();
      this.caption = undefined;
    });
  }

  update(t: number) {
    if (!this.group.visible) return;
    const local = t - this.started;
    if (t > this.until && !this.fading) this.stop();
    this.mat.opacity = Math.min(OPACITY, OPACITY * (local / 0.4));
    let f: Frame;
    if (this.keys) f = keyframeAt(this.keys, local % this.duration);
    else f = motionFrame(this.motion, local);
    this.hands.left.apply(f.left);
    this.hands.right.apply(f.right);
    if (f.props) {
      for (const [name, st] of Object.entries(f.props)) {
        const o = this.props[name];
        if (!o) continue;
        o.visible = st.visible !== false;
        if (st.pos && !HELD[name]) o.position.set(st.pos[0], st.pos[1], st.pos[2]);
        if (st.rot && !HELD[name]) o.rotation.set(st.rot[0], st.rot[1], st.rot[2]);
      }
    } else if (!this.keys) for (const o of Object.values(this.props)) o.visible = false;
    this.stage.updateMatrixWorld(true);
    this.anchorInv.copy(this.stage.matrixWorld).invert();
    this.hands.left.writeInstances(this.anchorInv);
    this.hands.right.writeInstances(this.anchorInv);
    for (const side of ['left', 'right'] as const) {
      const rig = this.hands[side];
      const sk = this.skinned[side];
      if (sk.ready) {
        rig.mesh.visible = false;
        rig.shell.visible = false;
        sk.visible = rig.root.visible;
        this.wm.multiplyMatrices(this.anchorInv, rig.root.matrixWorld);
        sk.setPose(this.wm, rig.curl, rig.thumbCurl);
      } else sk.visible = false;
    }
    this.updateTrail();
  }

  private updateTrail() {
    // right: the held tool's tip if any (knife/spatula/whisk), else the index tip; left: index tip
    const tips: (THREE.Object3D | null)[] = [null, null];
    const R = this.hands.right;
    const L = this.hands.left;
    const tool = ['knife', 'spatula', 'whisk'].find((n) => this.props[n]?.visible);
    tips[0] = tool ? this.props[tool] : R.fingers[1]?.joints[2] ?? null;
    tips[1] = L.root.visible ? L.fingers[0]?.joints[2] ?? null : null;
    this.trailHead = (this.trailHead + 1) % TRAIL;
    let n = 0;
    for (let k = 0; k < 2; k++) {
      const list = this.trailPts[k];
      const o = tips[k];
      const sk = k === 0 ? this.skinned.right : this.skinned.left;
      const useSkin = sk.ready && !(tool && k === 0) && sk.root.visible;
      if (useSkin ? sk.joint('index-finger-tip', this.tmp) : o) {
        if (!useSkin) o!.getWorldPosition(this.tmp).applyMatrix4(this.anchorInv);
        if (tool && k === 0) this.tmp.y -= 0.0; // tool origin is close enough to its working edge
        if (list.length < TRAIL) list.push(this.tmp.clone());
        else list[this.trailHead].copy(this.tmp);
      }
      for (let i = 0; i < list.length; i++) {
        const age = (this.trailHead - i + TRAIL) % TRAIL; // 0 = newest
        const sc = 0.0055 * (1 - age / TRAIL);
        this.tm.makeScale(sc, sc, sc).setPosition(list[i]);
        this.trail.setMatrixAt(n++, this.tm);
      }
    }
    this.trail.count = n;
    this.trail.instanceMatrix.needsUpdate = true;
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
