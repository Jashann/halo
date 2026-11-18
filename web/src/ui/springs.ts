import * as THREE from 'three';

// Critically-damped-ish springs for every appear/disappear: panels, highlights, timers, ghost hands, bubbles.
// One shared ticker; objects spring their uniform scale toward a target and can run a callback when gone.

interface Anim {
  obj: THREE.Object3D;
  base: THREE.Vector3; // the object's resting scale (per axis: labels are not square)
  s: number;
  v: number;
  target: number;
  onDone?: () => void;
}

const anims = new Map<THREE.Object3D, Anim>();
const K = 260; // stiffness
const C = 22; // damping (slightly under critical for a small overshoot)

/** Spring an object in from small; `base` is its resting scale (uniform), else its current scale. */
export function springIn(obj: THREE.Object3D, base?: number) {
  const b = base !== undefined ? new THREE.Vector3(base, base, base) : obj.scale.clone();
  const a: Anim = { obj, base: b, s: 0.6, v: 0, target: 1 };
  anims.set(obj, a);
  obj.scale.copy(b).multiplyScalar(a.s);
}

/** Spring an object out, then call onDone (e.g. remove it). */
export function springOut(obj: THREE.Object3D, onDone: () => void) {
  const prev = anims.get(obj);
  const base = prev?.base ?? obj.scale.clone();
  anims.set(obj, { obj, base, s: prev?.s ?? 1, v: prev?.v ?? 0, target: 0, onDone });
}

/** A gentle bump (e.g. content changed). */
export function springPulse(obj: THREE.Object3D, amount = 0.06) {
  const a = anims.get(obj) ?? { obj, base: obj.scale.clone(), s: 1, v: 0, target: 1 };
  a.v += amount * 12;
  anims.set(obj, a);
}

export function isAnimating(obj: THREE.Object3D) {
  return anims.has(obj);
}

export function tickSprings(dt: number) {
  const h = Math.min(dt, 1 / 30);
  for (const a of anims.values()) {
    const acc = K * (a.target - a.s) - C * a.v;
    a.v += acc * h;
    a.s += a.v * h;
    if (a.target === 0 && a.s <= 0.05) {
      anims.delete(a.obj);
      a.obj.scale.setScalar(0.0001);
      a.onDone?.();
      continue;
    }
    a.obj.scale.copy(a.base).multiplyScalar(Math.max(0.0001, a.s));
    if (Math.abs(a.target - a.s) < 0.001 && Math.abs(a.v) < 0.001) {
      a.obj.scale.copy(a.base).multiplyScalar(a.target);
      anims.delete(a.obj);
    }
  }
}
