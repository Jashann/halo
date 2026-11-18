import * as THREE from 'three';
import { makeLabel } from '../ui/label.js';
import type { Physics, BodyOptions } from './physics.js';

// Ready-made objects for generated programs (`aide.spawn(kind, opts)`), as specified in the server's
// runtime_api.md: ball, box, cup, target, label, arrow, line, burst. Each returns a THREE.Object3D with
// .remove() and the documented extras.

export type V3 = THREE.Vector3 | [number, number, number] | number[] | undefined | null;

export function toVec(v: V3, out = new THREE.Vector3()): THREE.Vector3 {
  if (!v) return out.set(0, 0, 0);
  if (v instanceof THREE.Vector3) return out.copy(v);
  if (Array.isArray(v)) return out.set(Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0);
  const o = v as unknown as { x?: number; y?: number; z?: number };
  return out.set(o.x ?? 0, o.y ?? 0, o.z ?? 0);
}

export interface SpawnHost {
  scene: THREE.Group;
  physics: Physics;
  billboard(o: THREE.Object3D, on?: boolean): void;
  /** per-frame animators that are not part of the program's budget (bursts) */
  animate(fn: (dt: number) => boolean): void;
  track(o: THREE.Object3D): void; // spawned set, for onPinch picking
  untrack(o: THREE.Object3D): void;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry) {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}
const matCache = new Map<string, THREE.Material>();
function stdMat(color: unknown, extra: Partial<THREE.MeshStandardMaterialParameters> = {}, key = '') {
  const c = typeof color === 'string' || typeof color === 'number' ? color : '#ffffff';
  const k = `${String(c)}|${key}|${JSON.stringify(extra)}`;
  let m = matCache.get(k);
  if (!m) {
    let col: THREE.Color;
    try {
      col = new THREE.Color(c as THREE.ColorRepresentation);
    } catch {
      col = new THREE.Color('#ffffff');
    }
    // a faint self-glow so spawned objects read clearly against passthrough
    m = new THREE.MeshStandardMaterial({ color: col, roughness: 0.45, metalness: 0.05, emissive: col, emissiveIntensity: 0.22, ...extra });
    matCache.set(k, m);
  }
  return m;
}

function physOpts(p: unknown, base: BodyOptions): BodyOptions | null {
  if (!p) return null;
  const o = p === true ? {} : (p as BodyOptions);
  return { ...base, ...o };
}

function finish(host: SpawnHost, obj: THREE.Object3D, kind: string, pickRadius: number, opts: Record<string, unknown>) {
  obj.name = obj.name || `spawn:${kind}`;
  obj.userData.kind = kind;
  obj.userData.pickRadius = pickRadius;
  if (opts.position) toVec(opts.position as V3, obj.position);
  host.scene.add(obj);
  host.track(obj);
  (obj as any).remove = () => {
    host.physics.remove(obj);
    host.untrack(obj);
    host.billboard(obj, false);
    obj.removeFromParent();
  };
  return obj;
}

export function spawn(host: SpawnHost, kind: string, opts: Record<string, unknown> = {}): THREE.Object3D {
  const k = String(kind).toLowerCase();
  switch (k) {
    case 'ball':
    case 'sphere': {
      const r = Number(opts.radius ?? 0.03);
      const m = new THREE.Mesh(geo(`sphere`, () => new THREE.SphereGeometry(1, 24, 16)), stdMat(opts.color ?? '#ffffff'));
      m.scale.setScalar(r);
      finish(host, m, 'ball', r, opts);
      const po = physOpts(opts.physics, { shape: 'sphere', radius: r });
      if (po) (m as any).body = host.physics.add(m, { ...po, shape: 'sphere', radius: po.radius ?? r });
      return m;
    }
    case 'box':
    case 'cube': {
      const s = toVec((opts.size as V3) ?? [0.1, 0.1, 0.1]);
      const m = new THREE.Mesh(geo('box', () => new THREE.BoxGeometry(1, 1, 1)), stdMat(opts.color ?? '#d0d6dd'));
      m.scale.copy(s);
      finish(host, m, 'box', Math.max(s.x, s.y, s.z) / 2, opts);
      const po = physOpts(opts.physics, { shape: 'box', size: [s.x, s.y, s.z] });
      if (po) (m as any).body = host.physics.add(m, { ...po, shape: 'box', size: po.size ?? [s.x, s.y, s.z] });
      return m;
    }
    case 'cup': {
      const r = Number(opts.radius ?? 0.05);
      const h = Number(opts.height ?? 0.07);
      const g = new THREE.Group();
      const wallMat = stdMat(opts.color ?? '#f4f4f4', { transparent: true, opacity: 0.82, side: THREE.DoubleSide }, 'cupwall');
      const wall = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.92, h, 36, 1, true), wallMat);
      wall.position.y = h / 2;
      const inner = new THREE.Mesh(geo('disc', () => new THREE.CircleGeometry(1, 32)), stdMat('#20252b'));
      inner.rotation.x = -Math.PI / 2;
      inner.position.y = 0.004;
      inner.scale.setScalar(r * 0.92);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(r, 0.0035, 8, 40), stdMat(opts.color ?? '#f4f4f4'));
      rim.rotation.x = Math.PI / 2;
      rim.position.y = h;
      g.add(wall, inner, rim);
      finish(host, g, 'cup', Math.max(r, h), opts);
      host.physics.addCup(g, r, h);
      (g as any).contains = (point: V3) => {
        const p = toVec(point);
        const dx = p.x - g.position.x;
        const dz = p.z - g.position.z;
        const y = p.y - g.position.y;
        return dx * dx + dz * dz < r * r && y > -0.005 && y < h;
      };
      return g;
    }
    case 'target': {
      const r = Number(opts.radius ?? 0.06);
      const g = new THREE.Group();
      const color = opts.color ?? '#ff5a5a';
      const rings = [1, 0.66, 0.33];
      rings.forEach((f, i) => {
        const m = new THREE.Mesh(
          new THREE.RingGeometry(r * f * 0.62, r * f, 40),
          new THREE.MeshBasicMaterial({ color: i % 2 ? '#ffffff' : (color as string), side: THREE.DoubleSide }),
        );
        m.position.z = i * 0.001;
        g.add(m);
      });
      const bull = new THREE.Mesh(geo('disc', () => new THREE.CircleGeometry(1, 32)), new THREE.MeshBasicMaterial({ color: color as string }));
      bull.scale.setScalar(r * 0.2);
      bull.position.z = 0.003;
      g.add(bull);
      finish(host, g, 'target', r, opts);
      (g as any).hitTest = (point: V3, margin = 0) => {
        const p = g.worldToLocal(g.parent!.localToWorld(toVec(point)));
        return Math.abs(p.z) < 0.04 + margin && Math.hypot(p.x, p.y) < r + margin;
      };
      return g;
    }
    case 'label':
    case 'text': {
      const size = Math.max(0.02, Number(opts.size ?? 0.03));
      const l = makeLabel(String(opts.text ?? ''), { height: size });
      // program labels draw on top of the program's own geometry so they stay readable
      (l.mesh.material as THREE.MeshBasicMaterial).depthTest = false;
      l.mesh.renderOrder = 15;
      const holder = new THREE.Group();
      holder.add(l.mesh);
      l.mesh.visible = !!l.text;
      finish(host, holder, 'label', size, opts);
      holder.userData.size = size;
      host.billboard(holder);
      (holder as any).setText = (t: unknown) => {
        l.setText(String(t ?? ''));
        l.mesh.visible = !!String(t ?? '');
      };
      (holder as any).text = () => l.text;
      const rm = (holder as any).remove;
      (holder as any).remove = () => {
        rm();
        l.dispose();
      };
      return holder;
    }
    case 'arrow': {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: (opts.color as string) ?? '#5ee6c4' });
      const shaft = new THREE.Mesh(geo('cyl', () => new THREE.CylinderGeometry(1, 1, 1, 10)), mat);
      const head = new THREE.Mesh(geo('cone', () => new THREE.ConeGeometry(1, 1, 14)), mat);
      g.add(shaft, head);
      const setEnds = (from: V3, to: V3) => {
        const a = toVec(from);
        const b = toVec(to);
        const dir = b.clone().sub(a);
        const len = Math.max(0.001, dir.length());
        dir.divideScalar(len);
        g.position.copy(a);
        g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        const hl = Math.min(0.04, len * 0.4);
        shaft.scale.set(0.006, len - hl, 0.006);
        shaft.position.y = (len - hl) / 2;
        head.scale.set(0.016, hl, 0.016);
        head.position.y = len - hl / 2;
      };
      finish(host, g, 'arrow', 0.05, {});
      setEnds((opts.from as V3) ?? [0, 0, 0], (opts.to as V3) ?? [0, 0.1, 0]);
      (g as any).setEnds = setEnds;
      return g;
    }
    case 'line': {
      const MAX = 64;
      const width = Number(opts.width ?? 0.004);
      const mesh = new THREE.InstancedMesh(
        geo('cyl', () => new THREE.CylinderGeometry(1, 1, 1, 10)),
        new THREE.MeshBasicMaterial({ color: (opts.color as string) ?? '#5ee6c4' }),
        MAX,
      );
      mesh.frustumCulled = false;
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const m = new THREE.Matrix4();
      const up = new THREE.Vector3(0, 1, 0);
      const setPoints = (pts: V3[]) => {
        const list = Array.isArray(pts) ? pts : [];
        let n = 0;
        for (let i = 0; i + 1 < list.length && n < MAX; i++) {
          toVec(list[i], a);
          toVec(list[i + 1], b);
          const len = a.distanceTo(b);
          if (len < 1e-5) continue;
          s.set(width / 2, len, width / 2);
          b.sub(a).divideScalar(len);
          q.setFromUnitVectors(up, b);
          a.addScaledVector(b, len / 2);
          m.compose(a, q, s);
          mesh.setMatrixAt(n++, m);
        }
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
      };
      finish(host, mesh, 'line', 0, {});
      setPoints((opts.points as V3[]) ?? []);
      (mesh as any).setPoints = setPoints;
      host.untrack(mesh); // lines are not pickable
      return mesh;
    }
    case 'burst':
    case 'particles': {
      const count = Math.max(4, Math.min(80, Number(opts.count ?? 24)));
      const mesh = new THREE.InstancedMesh(
        geo('spark', () => new THREE.SphereGeometry(1, 6, 4)),
        new THREE.MeshBasicMaterial({ color: (opts.color as string) ?? '#ffd400', transparent: true }),
        count,
      );
      mesh.frustumCulled = false;
      const vel: THREE.Vector3[] = [];
      const pos: THREE.Vector3[] = [];
      for (let i = 0; i < count; i++) {
        const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.3, Math.random() - 0.5).normalize();
        vel.push(v.multiplyScalar(0.5 + Math.random() * 0.6));
        pos.push(new THREE.Vector3());
      }
      finish(host, mesh, 'burst', 0, opts);
      host.untrack(mesh);
      const m = new THREE.Matrix4();
      let age = 0;
      const life = 0.9;
      host.animate((dt) => {
        age += dt;
        const k = age / life;
        for (let i = 0; i < count; i++) {
          vel[i].y -= 3 * dt;
          pos[i].addScaledVector(vel[i], dt);
          const sc = 0.006 * (1 - k);
          m.makeScale(sc, sc, sc).setPosition(pos[i]);
          mesh.setMatrixAt(i, m);
        }
        mesh.instanceMatrix.needsUpdate = true;
        (mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - k);
        if (age >= life) {
          (mesh as any).remove();
          (mesh.material as THREE.Material).dispose();
          return false;
        }
        return true;
      });
      return mesh;
    }
    default:
      throw new Error(`aide.spawn: unknown kind "${kind}" (use ball, box, cup, target, label, arrow, line, burst)`);
  }
}
