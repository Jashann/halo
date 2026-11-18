import * as THREE from 'three';
import type { AideContext, HandState } from '../context.js';
import { resolvePlace, workSurface, type Surface } from '../shell/place.js';
import type { PanelHost } from '../ui/panel-host.js';
import { makeLabel, type Label } from '../ui/label.js';
import { sound } from '../ui/sound.js';
import { Physics } from './physics.js';
import { spawn, toVec, type SpawnHost, type V3 } from './spawn.js';

// Generated runtime: runs agent-written programs with `new Function("aide", src)` against the `aide` API
// specified in server/src/prompts/runtime_api.md. Each program owns a THREE.Group placed at `at` (origin on the
// table top, +z toward the user), its own physics world, frame and pinch callbacks. Programs that throw or
// overrun their frame budget are stopped and reported (event code_error {id, error}).

export const FRAME_BUDGET_MS = 4; // documented per-frame budget
const HARD_FRAME_MS = 40; // a single frame this slow is a strike
const LOOP_LIMIT = 2_000_000; // iterations per callback before a loop is considered runaway

export interface LocalHand {
  visible: boolean;
  pinching: boolean;
  pinchStrength: number;
  pinchPoint: THREE.Vector3;
  velocity: THREE.Vector3;
  joints: {
    wrist: THREE.Vector3;
    palm: THREE.Vector3;
    thumbTip: THREE.Vector3;
    indexTip: THREE.Vector3;
    middleTip: THREE.Vector3;
    ringTip: THREE.Vector3;
    pinkyTip: THREE.Vector3;
  };
}

export interface LocalSurface {
  id: string;
  label: string;
  center: THREE.Vector3;
  top: number;
  size: { x: number; z: number };
}

export interface RuntimeDeps {
  panels?: PanelHost;
  /** World boxes generated labels must keep clear of (the speech bubble). */
  obstacles?(): THREE.Box3[];
  event(name: string, data: unknown): void;
  say(text: string): void;
}

function makeLocalHand(): LocalHand {
  const v = () => new THREE.Vector3();
  return {
    visible: false,
    pinching: false,
    pinchStrength: 0,
    pinchPoint: v(),
    velocity: v(),
    joints: { wrist: v(), palm: v(), thumbTip: v(), indexTip: v(), middleTip: v(), ringTip: v(), pinkyTip: v() },
  };
}

/** Inserts a counter into loop bodies so a runaway loop throws instead of freezing the headset. */
export function guardLoops(src: string): string {
  return src
    .replace(/\b(for|while)\s*(\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))\s*\{/g, (m) => `${m}__aideLoop();`)
    .replace(/\bdo\s*\{/g, (m) => `${m}__aideLoop();`);
}

const SHADOWED = ['window', 'document', 'globalThis', 'self', 'fetch', 'XMLHttpRequest', 'WebSocket', 'localStorage', 'sessionStorage', 'indexedDB', 'importScripts', 'setTimeout', 'setInterval', 'Function'];

export class Program {
  id: string;
  scene = new THREE.Group();
  physics = new Physics();
  hands = { left: makeLocalHand(), right: makeLocalHand() };
  surfaces: LocalSurface[] = [];
  anchorSurfaceId: string | null = null;
  frameFns: ((dt: number, t: number) => void)[] = [];
  pinchFns: ((e: { hand: 'left' | 'right'; point: THREE.Vector3; object: THREE.Object3D | null }) => void)[] = [];
  animators: ((dt: number) => boolean)[] = [];
  spawned = new Set<THREE.Object3D>();
  billboards = new Set<THREE.Object3D>();
  panels: string[] = [];
  started = 0;
  t = 0;
  finished = false;
  stopped = false;
  error: string | null = null;
  frames = 0;
  slowFrames = 0;
  avgMs = 0;
  score: number | null = null;
  scoreLabel: Label | null = null;
  loops = 0;
  emits: number[] = [];
  drag: { left?: { obj: THREE.Object3D; start: THREE.Vector3 }; right?: { obj: THREE.Object3D; start: THREE.Vector3 } } = {};
  dropRings: THREE.Mesh[] = [];
  fitted = false;
  private inv = new THREE.Matrix4();
  private prevIndex = { left: new THREE.Vector3(), right: new THREE.Vector3() };

  constructor(id: string) {
    this.id = id;
    this.scene.name = `program:${id}`;
  }

  worldToLocal(v: THREE.Vector3, out: THREE.Vector3) {
    return out.copy(v).applyMatrix4(this.inv);
  }

  syncHands(src: { left: HandState; right: HandState }, dt: number) {
    this.scene.updateMatrixWorld(true);
    this.inv.copy(this.scene.matrixWorld).invert();
    for (const side of ['left', 'right'] as const) {
      const h = src[side];
      const l = this.hands[side];
      l.visible = h.visible;
      l.pinching = h.pinching;
      l.pinchStrength = h.pinchStrength;
      this.worldToLocal(h.pinchPoint, l.pinchPoint);
      const j = h.joints;
      this.worldToLocal(j['wrist'], l.joints.wrist);
      this.worldToLocal(j['thumb-tip'], l.joints.thumbTip);
      this.worldToLocal(j['index-finger-tip'], l.joints.indexTip);
      this.worldToLocal(j['middle-finger-tip'], l.joints.middleTip);
      this.worldToLocal(j['ring-finger-tip'], l.joints.ringTip);
      this.worldToLocal(j['pinky-finger-tip'], l.joints.pinkyTip);
      // palm centre: between wrist and middle knuckle
      this.worldToLocal(j['middle-finger-metacarpal'], l.joints.palm).lerp(l.joints.wrist, 0.2);
      l.joints.palm.lerp(this.worldToLocal(j['middle-finger-phalanx-proximal'], tmpV), 0.5);
      if (dt > 0) {
        tmpV.copy(l.joints.indexTip).sub(this.prevIndex[side]).divideScalar(dt);
        if (tmpV.length() < 20) l.velocity.lerp(tmpV, 0.5);
      }
      this.prevIndex[side].copy(l.joints.indexTip);
    }
  }
}

const tmpV = new THREE.Vector3();
const tmpW = new THREE.Vector3();

export class CodeRuntime {
  programs = new Map<string, Program>();
  private pending: { p: Program; frames: number; resolve: (r: { ok: boolean; result: unknown }) => void; deadline: number }[] = [];
  private headLocal = new THREE.Vector3();

  constructor(private ctx: AideContext, private deps: RuntimeDeps) {
    ctx.onPinch((hand, phase) => {
      if (phase === 'start') this.dispatchPinch(hand);
    });
  }

  /** Run a program. Resolves after a few frames so early frame errors are reported in the tool_result. */
  run(id: string, js: string, at?: unknown): Promise<{ ok: boolean; result: unknown }> {
    id = String(id || 'program');
    if (typeof js !== 'string' || !js.trim()) return Promise.resolve({ ok: false, result: { id, error: 'run_code needs js source' } });
    this.stop(id, false);
    const p = new Program(id);
    const head = this.ctx.head();
    const surfaces = this.ctx.surfaces();
    const place = resolvePlace(at ?? 'table', surfaces, head, 'object');
    p.scene.position.copy(place.position);
    if (place.surface && Math.abs(place.surface.normal[1]) > 0.7) p.scene.position.y = place.surface.center[1];
    else if (!place.surface) {
      // in front of the user with no surface: use the virtual table height
      p.scene.position.y = workSurface(surfaces, head).center[1];
    }
    p.scene.rotation.set(0, Math.atan2(place.facing.x, place.facing.z), 0);
    p.anchorSurfaceId = place.surface?.id ?? (surfaces.length ? null : 'front-spot');
    this.ctx.root.add(p.scene);
    p.syncHands(this.ctx.hands, 0); // also computes the world->local matrix used below
    p.surfaces = this.localSurfaces(p, place.surface ? surfaces : [...surfaces, workSurface(surfaces, head)]);
    if (!place.surface && !p.anchorSurfaceId) p.anchorSurfaceId = 'front-spot';
    p.physics.setSurfaces(this.physicsSurfaces(p));
    p.physics.floorY = -p.scene.position.y;
    p.started = this.ctx.now();
    p.syncHands(this.ctx.hands, 0);
    this.programs.set(id, p);

    const aide = this.makeApi(p);
    try {
      const body = `"use strict";\n${guardLoops(js)}`;
      const fn = new Function('aide', '__aideLoop', ...SHADOWED, body);
      p.loops = 0;
      fn(aide, () => {
        if (++p.loops > LOOP_LIMIT) throw new Error('loop ran too long (possible infinite loop)');
      });
    } catch (e) {
      const msg = errMsg(e);
      this.stop(id, false);
      sound.error();
      return Promise.resolve({ ok: false, result: { id, error: msg } });
    }
    return new Promise((resolve) => {
      this.pending.push({ p, frames: 0, resolve, deadline: this.ctx.now() + 1.5 });
    });
  }

  private localSurfaces(p: Program, surfaces: Surface[]): LocalSurface[] {
    const out: LocalSurface[] = [];
    for (const s of surfaces) {
      const c = p.worldToLocal(new THREE.Vector3(...s.center), new THREE.Vector3());
      out.push({ id: s.id, label: s.label, center: c, top: c.y, size: { x: s.size[0], z: s.size[1] } });
    }
    if (!out.some((s) => s.label === 'floor')) {
      const f = p.worldToLocal(new THREE.Vector3(p.scene.position.x, 0, p.scene.position.z), new THREE.Vector3());
      out.push({ id: 'floor', label: 'floor', center: f, top: f.y, size: { x: 4, z: 4 } });
    }
    return out;
  }

  private physicsSurfaces(p: Program): Surface[] {
    // Convert world surfaces into the program's local frame for the physics engine.
    const yaw = p.scene.rotation.y;
    return this.ctx
      .surfaces()
      .concat(p.anchorSurfaceId === 'front-spot' ? [workSurface([], this.ctx.head())] : [])
      .map((s) => {
        const c = p.worldToLocal(new THREE.Vector3(...s.center), new THREE.Vector3());
        const n = new THREE.Vector3(...s.normal).applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
        return { ...s, center: [c.x, c.y, c.z], normal: [n.x, n.y, n.z], yaw: ((s as any).yaw ?? 0) - yaw } as Surface;
      });
  }

  private makeApi(p: Program) {
    const ctx = this.ctx;
    const host: SpawnHost = {
      scene: p.scene,
      physics: p.physics,
      billboard: (o, on = true) => {
        ctx.billboard(o, on);
        if (on) p.billboards.add(o);
        else p.billboards.delete(o);
      },
      animate: (fn) => p.animators.push(fn),
      track: (o) => p.spawned.add(o),
      untrack: (o) => p.spawned.delete(o),
    };
    const deps = this.deps;
    let panelSeq = 0;
    const api = {
      THREE,
      scene: p.scene,
      hands: p.hands,
      surfaces: p.surfaces,
      anchorSurfaceId: p.anchorSurfaceId,
      onFrame(fn: (dt: number, t: number) => void) {
        if (typeof fn !== 'function') throw new Error('aide.onFrame needs a function');
        p.frameFns.push(fn);
        return () => (p.frameFns = p.frameFns.filter((f) => f !== fn));
      },
      onPinch(fn: (e: { hand: 'left' | 'right'; point: THREE.Vector3; object: THREE.Object3D | null }) => void) {
        if (typeof fn !== 'function') throw new Error('aide.onPinch needs a function');
        p.pinchFns.push(fn);
        return () => (p.pinchFns = p.pinchFns.filter((f) => f !== fn));
      },
      physics: {
        add(obj: THREE.Object3D, opts: Record<string, unknown> = {}) {
          if (!obj || !(obj as THREE.Object3D).isObject3D) throw new Error('aide.physics.add needs a THREE.Object3D');
          if (!obj.parent) p.scene.add(obj);
          const shape = opts.shape === 'box' ? 'box' : 'sphere';
          let radius = opts.radius as number | undefined;
          let size = opts.size as [number, number, number] | undefined;
          if ((shape === 'sphere' && !radius) || (shape === 'box' && !size)) {
            const box = new THREE.Box3().setFromObject(obj);
            const s = box.getSize(new THREE.Vector3());
            radius = radius ?? Math.max(s.x, s.y, s.z) / 2;
            size = size ?? [s.x, s.y, s.z];
          }
          const body = p.physics.add(obj, { ...(opts as object), shape, radius, size });
          (obj as any).body = body;
          obj.userData.pickRadius = obj.userData.pickRadius ?? (radius ?? 0.05);
          p.spawned.add(obj);
          return body;
        },
        remove(obj: THREE.Object3D) {
          p.physics.remove(obj);
        },
        onCollide(obj: THREE.Object3D, fn: (other: THREE.Object3D | 'surface') => void) {
          return p.physics.onCollide(obj, (o) => guard(p, this_, () => fn(o)));
        },
        get gravity() {
          return p.physics.gravity;
        },
        set gravity(g: number) {
          p.physics.gravity = Number(g) || 0;
        },
      },
      spawn(kind: string, opts: Record<string, unknown> = {}) {
        if (p.spawned.size > 400) throw new Error('too many spawned objects (limit 400)');
        return spawn(host, kind, opts ?? {});
      },
      panel(spec: Record<string, unknown> = {}) {
        const pid = `${p.id}-panel-${++panelSeq}`;
        const onButton = typeof spec.onButton === 'function' ? (spec.onButton as (id: string) => void) : undefined;
        const toArgs = (s: Record<string, unknown>) => {
          const { title, position, onButton: _ob, ...rest } = s;
          const place = position ? { point: p.scene.localToWorld(toVec(position as V3)).toArray() } : { near: 'right' };
          return { title: title as string | undefined, spec: rest, place };
        };
        p.panels.push(pid);
        const a = toArgs(spec);
        void deps.panels?.show({ id: pid, ...a, owner: p.id, onButton: (b) => onButton && guard(p, this_, () => onButton(b)) });
        return {
          id: pid,
          update(next: Record<string, unknown> = {}) {
            const n = toArgs(next);
            const patch: Record<string, unknown> = { spec: n.spec };
            if (n.title) patch.title = n.title;
            if (next.position) patch.place = n.place;
            void deps.panels?.update(pid, patch);
          },
          close() {
            deps.panels?.close(pid);
          },
        };
      },
      score(n: number) {
        p.score = Number(n);
        if (!p.scoreLabel) {
          p.scoreLabel = makeLabel(`Score ${p.score}`, { height: 0.03, border: 'rgba(255,212,0,0.7)' });
          p.scoreLabel.mesh.position.set(0.28, 0.32, -0.1);
          p.scene.add(p.scoreLabel.mesh);
          host.billboard(p.scoreLabel.mesh);
        } else p.scoreLabel.setText(`Score ${p.score}`);
        sound.score();
        deps.event('game_score', { id: p.id, score: p.score });
      },
      say(text: string) {
        deps.say(String(text ?? '').slice(0, 200));
      },
      emit(name: string, data?: unknown) {
        // custom event to the agent; rate-limited (at most 6 per 10 s per program) so a frame loop cannot flood it
        const n = String(name ?? '').replace(/[^\w.:-]/g, '').slice(0, 48);
        if (!n) throw new Error('aide.emit needs an event name');
        const now = p.t;
        p.emits = p.emits.filter((x) => now - x < 10);
        if (p.emits.length >= 6) {
          console.warn(`[halo] program ${p.id}: aide.emit("${n}") dropped (rate limit)`);
          return false;
        }
        p.emits.push(now);
        let payload: unknown = data ?? {};
        try {
          payload = JSON.parse(JSON.stringify(payload));
        } catch {
          payload = { value: String(data) };
        }
        deps.event(n, payload);
        return true;
      },
      done(summary?: string) {
        if (p.finished) return;
        p.finished = true;
        deps.event('code_done', { id: p.id, summary: summary == null ? '' : String(summary).slice(0, 500) });
      },
      time() {
        return p.t;
      },
      sound: { pop: () => sound.pop(), score: () => sound.score(), chime: () => sound.chime(), tick: () => sound.tick() },
    };
    const this_ = this;
    return api;
  }

  private dispatchPinch(hand: HandState) {
    for (const p of this.programs.values()) {
      if (p.stopped || p.finished || !p.pinchFns.length) continue;
      const point = p.worldToLocal(hand.pinchPoint, new THREE.Vector3());
      let best: THREE.Object3D | null = null;
      let bestD = 0.08;
      for (const o of p.spawned) {
        if (!o.parent || !o.visible) continue;
        const op = o.parent === p.scene ? o.position : p.worldToLocal(o.getWorldPosition(tmpW), tmpW);
        const d = Math.max(0, op.distanceTo(point) - Math.min(0.06, Number(o.userData.pickRadius ?? 0)));
        if (d < bestD) {
          bestD = d;
          best = o;
        }
      }
      if (best) p.drag[hand.handedness] = { obj: best, start: best.position.clone() };
      const e = { hand: hand.handedness, point, object: best };
      for (const f of [...p.pinchFns]) {
        if (!guard(p, this, () => f(e))) break;
      }
    }
  }

  /** Called by guard() when a callback throws. */
  fail(p: Program, e: unknown) {
    if (p.stopped) return;
    const msg = errMsg(e);
    p.error = msg;
    const pend = this.pending.find((x) => x.p === p);
    this.stop(p.id, false);
    sound.error();
    if (pend) {
      this.pending = this.pending.filter((x) => x !== pend);
      pend.resolve({ ok: false, result: { id: p.id, error: msg } });
    } else this.deps.event('code_error', { id: p.id, error: msg });
  }

  stop(id: string, report = false): boolean {
    const p = this.programs.get(id);
    if (!p) return false;
    p.stopped = true;
    for (const o of p.billboards) this.ctx.billboard(o, false);
    p.scoreLabel?.dispose();
    for (const pid of p.panels) this.deps.panels?.close(pid);
    this.deps.panels?.closeOwned(p.id);
    p.scene.removeFromParent();
    this.programs.delete(id);
    const pend = this.pending.find((x) => x.p === p);
    if (pend) {
      this.pending = this.pending.filter((x) => x !== pend);
      pend.resolve({ ok: false, result: { id, error: p.error ?? 'stopped' } });
    }
    if (report) this.deps.event('code_stopped', { id });
    return true;
  }

  stopAll() {
    for (const id of [...this.programs.keys()]) this.stop(id);
  }

  /**
   * After the first frames, bring the program's content toward the user: its centre moves to the anchor spot
   * (the near part of the table) and the content is scaled up 1.3x so labels and parts read from a seated
   * distance. Only for programs without moving physics (explanations, maps, widgets): games keep their layout. Hands, surfaces and picking follow automatically
   * because they are converted through the scene's matrix.
   */
  autoFit(p: Program) {
    p.fitted = true;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    let n = 0;
    for (const o of p.spawned) {
      if (o.userData.kind === 'label' || !o.parent) continue;
      box.expandByPoint(o.parent === p.scene ? o.position : p.worldToLocal(o.getWorldPosition(v), v.clone()));
      n++;
    }
    p.scene.traverse((o) => {
      if (o !== p.scene && (o as THREE.Mesh).isMesh && o.parent && o.parent !== p.scene && !p.spawned.has(o)) {
        box.expandByPoint(p.worldToLocal(o.getWorldPosition(v), v.clone()));
        n++;
      }
    });
    if (!n || box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const dynamic = p.physics.bodies.some((b) => !b.isStatic && b.gravity);
    if (dynamic) return; // games with moving bodies keep their layout: the table edges are their colliders
    const scale = 1.3;
    // move the scene so the content centre (x, z) lands on the anchor, never more than 0.3 m
    const shift = new THREE.Vector3(-c.x, 0, -c.z).multiplyScalar(scale).clampLength(0, 0.3);
    shift.applyQuaternion(p.scene.quaternion);
    // never bring the nearest part closer than 0.42 m (horizontally) to the user's head
    const head = this.ctx.head().position;
    const nearest = () => {
      let m = Infinity;
      for (const x of [box.min.x, box.max.x]) for (const z of [box.min.z, box.max.z]) {
        const w = new THREE.Vector3(x * scale, 0, z * scale).applyQuaternion(p.scene.quaternion).add(p.scene.position).add(shift);
        m = Math.min(m, Math.hypot(w.x - head.x, w.z - head.z));
      }
      return m;
    };
    for (let k = 0; k < 12 && nearest() < 0.42; k++) shift.multiplyScalar(0.7);
    if (nearest() < 0.42) shift.set(0, 0, 0);
    p.scene.position.add(shift);
    p.scene.scale.setScalar(scale);
    p.scene.updateMatrixWorld(true);
    p.syncHands(this.ctx.hands, 0);
    // refresh surfaces (in place, programs may hold references) and physics colliders in the new frame
    const fresh = this.localSurfaces(p, this.ctx.surfaces());
    for (const s of p.surfaces) {
      const f = fresh.find((x) => x.id === s.id);
      if (f) {
        s.center.copy(f.center);
        s.top = f.top;
      }
    }
    p.physics.setSurfaces(this.physicsSurfaces(p));
    p.physics.floorY = p.worldToLocal(new THREE.Vector3(0, 0, 0), new THREE.Vector3()).y;
  }

  /** Spawned labels never get smaller than about 1.8 degrees of view (roughly 22 px on a panel) for the user. */
  private readableLabels(p: Program) {
    const head = this.ctx.head().position;
    const s = p.scene.scale.x || 1;
    for (const o of p.billboards) {
      const size = o.userData.size as number | undefined;
      if (!size) continue;
      const d = o.getWorldPosition(tmpW).distanceTo(head);
      o.scale.setScalar(Math.max(1, (d * 0.0314) / (size * s)));
    }
  }

  /**
   * Labels of generated programs must not overlap as the user sees them: lay them out in view angles (azimuth,
   * elevation from the head), lifting a label above any lower one it collides with. The lift is applied to the
   * label's inner mesh, which programs never move, and eases in and out.
   */
  private separateLabels(p: Program, dt: number) {
    const head = this.ctx.head().position;
    type Rect = { az: number; el: number; hw: number; hh: number };
    const items: (Rect & { mesh: THREE.Object3D; d: number; ws: number })[] = [];
    const wp = new THREE.Vector3();
    const ws = new THREE.Vector3();
    const toRect = (x: number, y: number, z: number, w: number, h: number): Rect & { d: number } => {
      const dx = x - head.x;
      const dz = z - head.z;
      const d = Math.max(0.2, Math.hypot(dx, dz));
      return { az: Math.atan2(dx, -dz), el: Math.atan2(y - head.y, d), hw: w / 2 / d, hh: h / 2 / d, d };
    };
    for (const o of p.billboards) {
      if (!o.userData.size || !o.visible || !o.parent) continue;
      const mesh = o.children[0];
      if (!mesh || !mesh.visible) continue;
      o.getWorldPosition(wp);
      o.getWorldScale(ws);
      const r = toRect(wp.x, wp.y, wp.z, mesh.scale.x * ws.x, mesh.scale.y * ws.y);
      items.push({ ...r, mesh, ws: ws.y });
    }
    // fixed obstacles (the speech bubble) are placed first
    const placed: Rect[] = [];
    const c = new THREE.Vector3();
    const sz = new THREE.Vector3();
    for (const box of this.deps.obstacles?.() ?? []) {
      if (!box || box.isEmpty()) continue;
      box.getCenter(c);
      box.getSize(sz);
      placed.push(toRect(c.x, c.y, c.z, Math.max(sz.x, sz.z), sz.y));
    }
    const gap = 0.006;
    const hits = (r: Rect) => placed.some((q) => Math.abs(r.az - q.az) < r.hw + q.hw + gap && Math.abs(r.el - q.el) < r.hh + q.hh + gap);
    items.sort((a, b) => a.el - b.el);
    for (const it of items) {
      // nearest clear spot: stay, else small steps up, down, left, right (growing)
      let best = { daz: 0, del: 0 };
      if (hits(it)) {
        const sy = it.hh * 0.8 + gap;
        const sx = it.hw * 0.6 + gap;
        search: for (let k = 1; k <= 10; k++) {
          for (const [daz, del] of [[0, sy * k], [0, -sy * k], [-sx * k, 0], [sx * k, 0], [sx * k, sy * k], [-sx * k, sy * k]]) {
            if (!hits({ ...it, az: it.az + daz, el: it.el + del })) {
              best = { daz, del };
              break search;
            }
          }
        }
      }
      placed.push({ az: it.az + best.daz, el: it.el + best.del, hw: it.hw, hh: it.hh });
      const ty = ((Math.tan(it.el + best.del) - Math.tan(it.el)) * it.d) / Math.max(1e-4, it.ws);
      const tx = (Math.tan(best.daz) * it.d) / Math.max(1e-4, it.ws);
      const k = Math.min(1, dt * 10);
      it.mesh.position.y += (ty - it.mesh.position.y) * k;
      it.mesh.position.x += (tx - it.mesh.position.x) * k;
    }
  }

  /** While a spawned object is dragged, glow the bigger objects it can be dropped on; the nearest one brightest. */
  private dragAssist(p: Program, t: number) {
    let shown = 0;
    for (const side of ['left', 'right'] as const) {
      const d = p.drag[side];
      if (!d) continue;
      if (!this.ctx.hands[side].pinching || !d.obj.parent) {
        delete p.drag[side];
        continue;
      }
      if (d.obj.position.distanceTo(d.start) < 0.03) continue;
      const foot = (o: THREE.Object3D) => o.scale.x * o.scale.z;
      const cands = [...p.spawned].filter(
        (o) => o !== d.obj && o.parent === p.scene && o.userData.kind === 'box' && foot(o) > foot(d.obj) * 1.5 && Math.hypot(o.position.x - d.obj.position.x, o.position.z - d.obj.position.z) < 0.45,
      );
      let near: THREE.Object3D | null = null;
      let nd = 0.2;
      for (const o of cands) {
        const dist = Math.hypot(o.position.x - d.obj.position.x, o.position.z - d.obj.position.z);
        if (dist < nd) {
          nd = dist;
          near = o;
        }
      }
      for (const o of cands.slice(0, 8)) {
        let ring = p.dropRings[shown];
        if (!ring) {
          ring = new THREE.Mesh(
            new THREE.RingGeometry(0.8, 1, 48).rotateX(-Math.PI / 2),
            new THREE.MeshBasicMaterial({ color: '#ffd27a', transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
          );
          ring.renderOrder = 12;
          p.dropRings.push(ring);
          p.scene.add(ring);
        }
        const r = Math.max(o.scale.x, o.scale.z) * 0.62;
        const on = o === near;
        ring.visible = true;
        ring.position.set(o.position.x, o.position.y + o.scale.y / 2 + 0.004, o.position.z);
        ring.scale.setScalar(r * (on ? 1.15 + 0.06 * Math.sin(t * 9) : 1));
        (ring.material as THREE.MeshBasicMaterial).opacity = on ? 0.95 : 0.35;
        shown++;
      }
    }
    for (let i = shown; i < p.dropRings.length; i++) p.dropRings[i].visible = false;
  }

  update(dt: number, t: number) {
    dt = Math.min(0.05, Math.max(0, dt));
    for (const p of [...this.programs.values()]) {
      if (p.stopped) continue;
      p.syncHands(this.ctx.hands, dt);
      p.t = t - p.started;
      // animators (bursts) run even after done()
      if (p.animators.length) p.animators = p.animators.filter((a) => a(dt));
      this.readableLabels(p);
      this.separateLabels(p, dt);
      this.dragAssist(p, t);
      if (p.finished) continue;
      const t0 = performance.now();
      p.loops = 0;
      p.physics.step(dt);
      for (const f of [...p.frameFns]) {
        if (!guard(p, this, () => f(dt, p.t))) break;
      }
      if (p.stopped) continue;
      const ms = performance.now() - t0;
      p.frames++;
      if (p.frames === 2 && !p.fitted) this.autoFit(p);
      p.avgMs = p.avgMs * 0.95 + ms * 0.05;
      if (ms > HARD_FRAME_MS) p.slowFrames++;
      if (p.slowFrames >= 3 || (p.frames > 90 && p.avgMs > FRAME_BUDGET_MS * 2)) {
        this.fail(p, new Error(`frame budget exceeded (${p.avgMs.toFixed(1)} ms average, budget ${FRAME_BUDGET_MS} ms)`));
      }
    }
    // resolve pending run() calls once they have survived a few frames
    for (const pend of [...this.pending]) {
      pend.frames++;
      if (pend.frames >= 3 || t > pend.deadline) {
        this.pending = this.pending.filter((x) => x !== pend);
        const p = pend.p;
        pend.resolve({
          ok: true,
          result: { id: p.id, running: !p.finished, objects: p.scene.children.length, anchor_surface: p.anchorSurfaceId },
        });
      }
    }
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) {
    const line = /<anonymous>:(\d+):(\d+)/.exec(e.stack ?? '');
    return line ? `${e.name}: ${e.message} (line ${Number(line[1]) - 3})` : `${e.name}: ${e.message}`;
  }
  return String(e);
}

function guard(p: Program, rt: CodeRuntime, f: () => void): boolean {
  if (p.stopped) return false;
  try {
    f();
    return true;
  } catch (e) {
    rt.fail(p, e);
    return false;
  }
}
