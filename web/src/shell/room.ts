import * as THREE from 'three';
import type { Surface } from './place.js';

// Room model: detected planes and meshes (IWSDK SceneUnderstandingSystem entities) -> surfaces[] with semantic
// labels, sizes, centres and normals. Plus user-placed spots from tap-to-place.

const UP = new THREE.Vector3(0, 1, 0);
const tmpN = new THREE.Vector3();
const tmpX = new THREE.Vector3();
const box = new THREE.Box3();
const size = new THREE.Vector3();
const center = new THREE.Vector3();

export interface PlaneLike {
  object3D: THREE.Object3D;
  plane: { semanticLabel?: string | null; orientation?: string; polygon?: DOMPointReadOnly[] | { x: number; z: number }[] };
}
export interface MeshLike {
  object3D: THREE.Object3D;
  semanticLabel: string;
  isBounded3D: boolean;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function planeToSurface(id: string, p: PlaneLike): Surface | null {
  const o = p.object3D;
  o.updateMatrixWorld(true);
  const poly = (p.plane.polygon ?? []) as { x: number; z: number }[];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const v of poly) {
    minX = Math.min(minX, v.x);
    maxX = Math.max(maxX, v.x);
    minZ = Math.min(minZ, v.z);
    maxZ = Math.max(maxZ, v.z);
  }
  if (!isFinite(minX)) return null;
  const local = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
  const c = o.localToWorld(local.clone());
  tmpN.set(0, 1, 0).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion())).normalize();
  const horizontal = Math.abs(tmpN.y) > 0.7;
  const label = (p.plane.semanticLabel || (horizontal ? (c.y < 0.25 ? 'floor' : c.y > 2.0 ? 'ceiling' : 'surface') : 'wall')).toLowerCase();
  tmpX.set(1, 0, 0).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
  const yaw = Math.atan2(-tmpX.z, tmpX.x);
  return {
    id,
    label,
    size: [r3(maxX - minX), r3(maxZ - minZ)],
    center: [r3(c.x), r3(c.y), r3(c.z)],
    normal: [r3(tmpN.x), r3(tmpN.y), r3(tmpN.z)],
    kind: 'plane',
    orientation: horizontal ? 'horizontal' : 'vertical',
    ...(horizontal ? { yaw: r3(yaw) } : { height: r3(maxZ - minZ) }),
  } as Surface;
}

export function meshToSurface(id: string, m: MeshLike): Surface | null {
  const label = (m.semanticLabel || '').toLowerCase();
  if (!m.isBounded3D || !label || ['global mesh', 'wall', 'floor', 'ceiling', 'door', 'window'].includes(label)) return null;
  m.object3D.updateMatrixWorld(true);
  box.setFromObject(m.object3D);
  if (box.isEmpty()) return null;
  box.getSize(size);
  box.getCenter(center);
  return {
    id,
    label,
    size: [r3(size.x), r3(size.z)],
    center: [r3(center.x), r3(box.max.y), r3(center.z)],
    normal: [0, 1, 0],
    kind: 'mesh',
    orientation: 'horizontal',
    height: r3(size.y),
  };
}

/** Drop mesh surfaces that duplicate a plane with the same label (same thing reported twice). */
export function dedupe(surfaces: Surface[]): Surface[] {
  const planes = surfaces.filter((s) => s.kind === 'plane');
  return surfaces.filter((s) => {
    if (s.kind !== 'mesh') return true;
    return !planes.some(
      (p) => p.label === s.label && Math.hypot(p.center[0] - s.center[0], p.center[2] - s.center[2]) < 0.3 && Math.abs(p.center[1] - s.center[1]) < 0.12,
    );
  });
}

export function sortForAgent(surfaces: Surface[], head: THREE.Vector3): Surface[] {
  // tables and desks first, then by distance; the agent sees the useful ones first
  const rank = (s: Surface) => (['table', 'desk', 'counter', 'placed'].includes(s.label) ? 0 : ['couch', 'shelf', 'bed', 'surface'].includes(s.label) ? 1 : s.label === 'wall' ? 2 : 3);
  return [...surfaces].sort((a, b) => rank(a) - rank(b) || head.distanceTo(new THREE.Vector3(...a.center)) - head.distanceTo(new THREE.Vector3(...b.center)));
}

export { UP };
