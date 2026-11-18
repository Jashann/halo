import * as THREE from 'three';

// Pure placement logic: turns the agent's `place` / `at` / `target` arguments into a world pose.
// Shared by panels, highlights, timers, ghost hands and generated code. No IWSDK imports (unit-testable).

export type Vec3 = [number, number, number];

export interface Surface {
  id: string;
  label: string; // semantic label: table, desk, wall, floor, couch, ... or "placed" / "front-spot"
  size: [number, number]; // metres (width, depth) of the surface's bounding rectangle
  center: Vec3;
  normal: Vec3;
  kind?: 'plane' | 'mesh' | 'placed' | 'virtual';
  orientation?: 'horizontal' | 'vertical';
  height?: number; // for meshes: vertical size
}

export interface HeadPose {
  position: THREE.Vector3;
  forward: THREE.Vector3; // horizontal unit vector the user faces
}

export interface Placement {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  surface?: Surface;
  facing: THREE.Vector3; // unit vector from placement toward the user (horizontal)
}

export type PlaceUse = 'panel' | 'marker' | 'object' | 'hands' | 'timer';

const UP = new THREE.Vector3(0, 1, 0);

export const TABLE_LABELS = ['table', 'desk', 'counter', 'countertop', 'kitchen counter', 'island', 'placed'];

export function isHorizontal(s: Surface): boolean {
  if (s.orientation) return s.orientation === 'horizontal';
  return Math.abs(s.normal[1]) > 0.7;
}

/** A default work surface in front of a seated user, used when the room has no table. */
export function virtualTable(head: HeadPose): Surface {
  const c = head.position.clone().addScaledVector(head.forward, 0.55);
  c.y = Math.max(0.55, head.position.y - 0.5);
  return {
    id: 'front-spot',
    label: 'table',
    size: [0.8, 0.5],
    center: [c.x, c.y, c.z],
    normal: [0, 1, 0],
    kind: 'virtual',
    orientation: 'horizontal',
  };
}

export function findSurface(surfaces: Surface[], key: string, head?: HeadPose): Surface | undefined {
  if (!key) return undefined;
  const k = key.trim().toLowerCase();
  const byId = surfaces.find((s) => s.id.toLowerCase() === k);
  if (byId) return byId;
  const matches = surfaces.filter((s) => s.label.toLowerCase() === k || s.label.toLowerCase().includes(k));
  let pool = matches;
  if (!pool.length && TABLE_LABELS.includes(k)) {
    pool = surfaces.filter((s) => TABLE_LABELS.includes(s.label.toLowerCase()) && isHorizontal(s));
  }
  if (!pool.length) return undefined;
  if (!head) return pool[0];
  // nearest to the user wins
  return pool
    .map((s) => ({ s, d: head.position.distanceTo(new THREE.Vector3(...s.center)) }))
    .sort((a, b) => a.d - b.d)[0].s;
}

/** Best work surface: placed spot, else nearest labelled table/desk within reach, else a virtual spot. */
export function workSurface(surfaces: Surface[], head: HeadPose): Surface {
  const placed = surfaces.find((s) => s.kind === 'placed');
  if (placed) return placed;
  const tables = surfaces
    .filter((s) => TABLE_LABELS.includes(s.label.toLowerCase()) && isHorizontal(s) && s.center[1] > 0.4)
    .map((s) => ({ s, d: head.position.distanceTo(new THREE.Vector3(...s.center)) }))
    .filter((x) => x.d < 2.5)
    .sort((a, b) => a.d - b.d);
  return tables[0]?.s ?? virtualTable(head);
}

function facingQuat(from: THREE.Vector3, head: HeadPose, tilt = 0): { q: THREE.Quaternion; facing: THREE.Vector3 } {
  const to = head.position.clone().sub(from);
  to.y = 0;
  if (to.lengthSq() < 1e-6) to.copy(head.forward).multiplyScalar(-1);
  to.normalize();
  const yaw = Math.atan2(to.x, to.z);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, yaw, 0, 'YXZ'));
  return { q, facing: to };
}

function vec(v: unknown): Vec3 | null {
  if (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return [v[0], v[1], v[2]];
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.x === 'number' && typeof o.y === 'number' && typeof o.z === 'number') return [o.x, o.y, o.z];
  }
  return null;
}

/** Point in front of the user at a yaw offset (radians, positive = left). */
export function frontPoint(head: HeadPose, dist: number, yaw: number, dy: number): THREE.Vector3 {
  const dir = head.forward.clone().applyAxisAngle(UP, yaw);
  const p = head.position.clone().addScaledVector(dir, dist);
  p.y = head.position.y + dy;
  return p;
}

/**
 * Resolve a placement spec. Accepted forms:
 *  undefined | "front" | "left" | "right" | "<surface id or label>" | {near: ...} | {point:[x,y,z]} |
 *  {surface_id, offset:[x,y,z]} | {near, offset}
 */
export function resolvePlace(spec: unknown, surfaces: Surface[], head: HeadPose, use: PlaceUse = 'panel'): Placement {
  let near: string | undefined;
  let offset: Vec3 = [0, 0, 0];
  let point: Vec3 | null = null;
  let dist: number | undefined;
  if (typeof spec === 'string') near = spec;
  else if (Array.isArray(spec)) point = vec(spec);
  else if (spec && typeof spec === 'object') {
    const o = spec as Record<string, unknown>;
    point = vec(o.point) ?? vec(o.position);
    near = (o.near ?? o.surface_id ?? o.surface ?? o.on) as string | undefined;
    offset = vec(o.offset) ?? offset;
    if (typeof o.distance === 'number') dist = o.distance;
  }
  near = typeof near === 'string' ? near : undefined;

  if (point) {
    const p = new THREE.Vector3(...point).add(new THREE.Vector3(...offset));
    if (use === 'panel') keepReadable(p, head);
    const { q, facing } = facingQuat(p, head, use === 'panel' ? tiltFor(p, head) : 0);
    return { position: p, quaternion: q, facing };
  }

  const yawFor: Record<string, number> = { front: 0, center: 0, left: 0.6, right: -0.6, 'far-left': 1.1, 'far-right': -1.1 };
  const key = (near ?? 'front').toLowerCase();
  if (key in yawFor || key === 'here' || key === 'me' || key === 'user') {
    const yaw = yawFor[key] ?? 0;
    const d = dist ?? (use === 'panel' ? 0.85 : use === 'hands' ? 0.55 : 0.6);
    const dy = use === 'panel' ? -0.08 : use === 'hands' ? -0.25 : use === 'timer' ? -0.05 : -0.35;
    const p = frontPoint(head, d, yaw, dy);
    p.add(new THREE.Vector3(...offset));
    const { q, facing } = facingQuat(p, head, use === 'panel' ? tiltFor(p, head) : 0);
    return { position: p, quaternion: q, facing };
  }

  let s = findSurface(surfaces, key, head);
  if (!s && (TABLE_LABELS.includes(key) || key === 'work' || key === 'workspace')) s = workSurface(surfaces, head);
  if (!s) {
    // Unknown target (e.g. "stove" in a room without labels): fall back to the work surface, nudged right.
    s = workSurface(surfaces, head);
    if (!offset[0] && !offset[2]) offset = [0.25, 0, 0];
  }
  return placeOnSurface(s, offset, head, use);
}

/** Panels closer than 0.6 m or above eye level are hard to read: push them out and down. */
export function keepReadable(p: THREE.Vector3, head: HeadPose) {
  const d = new THREE.Vector3(p.x - head.position.x, 0, p.z - head.position.z);
  const len = d.length();
  if (len < 0.6) {
    if (len < 1e-3) d.copy(head.forward);
    d.normalize();
    p.x = head.position.x + d.x * 0.6;
    p.z = head.position.z + d.z * 0.6;
  }
  if (p.y > head.position.y + 0.05) p.y = head.position.y + 0.05;
}

function tiltFor(p: THREE.Vector3, head: HeadPose): number {
  // Tilt panels below eye level up toward the eyes (radians, negative x = lean back).
  const dy = head.position.y - p.y;
  const dz = Math.max(0.2, Math.hypot(head.position.x - p.x, head.position.z - p.z));
  return -Math.max(0, Math.min(0.6, Math.atan2(dy, dz)));
}

/** Offsets are in the user's frame on the surface: x = right, y = up, z = toward the user. */
export function placeOnSurface(s: Surface, offset: Vec3, head: HeadPose, use: PlaceUse): Placement {
  const c = new THREE.Vector3(...s.center);
  const n = new THREE.Vector3(...s.normal).normalize();
  const toUser = head.position.clone().sub(c);
  toUser.y = 0;
  if (toUser.lengthSq() < 1e-6) toUser.copy(head.forward).multiplyScalar(-1);
  toUser.normalize();
  const right = new THREE.Vector3().crossVectors(UP, toUser).normalize(); // user's right when facing the surface
  const p = c.clone();
  if (isHorizontal(s)) {
    // Keep the point on the half of the surface nearest the user, within its extent.
    const reach = Math.min(0.2, Math.max(0, Math.min(s.size[0], s.size[1]) / 2 - 0.08));
    p.addScaledVector(toUser, reach);
    p.addScaledVector(right, offset[0]).addScaledVector(toUser, offset[2]);
    p.y = c.y + offset[1];
    if (use === 'panel' && offset[1] < 0.15) p.y = c.y + 0.3; // panels float above the surface by default
    if (use === 'timer') p.y += 0.18;
    if (use === 'hands') p.y += 0.002; // the demo board sits on the surface
    if (use === 'marker') p.y += 0.004;
    if (use === 'panel') keepReadable(p, head);
    const { q, facing } = facingQuat(p, head, use === 'panel' ? tiltFor(p, head) : 0);
    return { position: p, quaternion: q, surface: s, facing };
  }
  // Vertical surface (wall, fridge door): stand off along its normal, face along the normal.
  const nn = n.clone();
  if (nn.dot(toUser) < 0) nn.multiplyScalar(-1);
  const wallRight = new THREE.Vector3().crossVectors(UP, nn).normalize();
  p.addScaledVector(wallRight, offset[0]);
  p.y += offset[1];
  p.addScaledVector(nn, (use === 'panel' ? 0.06 : 0.01) + offset[2]);
  if (p.y > head.position.y + 0.3) p.y = head.position.y + 0.1;
  const yaw = Math.atan2(nn.x, nn.z);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
  return { position: p, quaternion: q, surface: s, facing: nn };
}
