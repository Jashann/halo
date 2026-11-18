import * as THREE from 'three';
import type { HeadPose } from './place.js';

// A small layout solver for floating UI. Works in head-centred cylindrical coordinates (azimuth around the
// user, height): panels must not overlap each other, the speech bubble or the chip bar; panels stay 0.6 to
// 1.2 m away, with their top edge at or below eye level. Movable items are pushed sideways around the user
// (newest moves first); fixed items (bubble, chip bar, surface-anchored panels) are obstacles.

export interface LayoutItem {
  id: string;
  pos: THREE.Vector3; // centre, updated in place
  w: number; // metres
  h: number;
  movable: boolean;
  born: number; // newer items yield
  clampHeight?: boolean; // keep the top edge at or below eye level (panels)
}

export const MIN_DIST = 0.7;
export const MAX_DIST = 1.2;
export const CROWDED_DIST = 1.45; // a boxed-in panel may step back this far
export const EYE_MARGIN = 0.02; // panel top at most this far above eye height
const GAP_ANGLE = 0.1; // radians between neighbours (generous: a pitched-down view squeezes panels below the horizon together)
const GAP_Y = 0.03; // radians

function polar(head: HeadPose, p: THREE.Vector3) {
  const dx = p.x - head.position.x;
  const dz = p.z - head.position.z;
  return { az: Math.atan2(dx, -dz), dist: Math.hypot(dx, dz) };
}

function fromPolar(head: HeadPose, az: number, dist: number, y: number, out: THREE.Vector3) {
  return out.set(head.position.x + Math.sin(az) * dist, y, head.position.z - Math.cos(az) * dist);
}

export function wrap(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Distance and eye-level constraints for one movable panel. */
export function constrain(item: LayoutItem, head: HeadPose, maxDist = MAX_DIST) {
  if (!item.movable) return;
  const { az: az0, dist } = polar(head, item.pos);
  // stay within the comfortable field of view (about 57 degrees either side of where the user faces)
  const fwd = Math.atan2(head.forward.x, -head.forward.z);
  const rel = Math.max(-1.0, Math.min(1.0, wrap(az0 - fwd)));
  const az = fwd + rel;
  const d = Math.min(Math.max(maxDist, dist <= CROWDED_DIST && dist > MAX_DIST ? dist : maxDist), Math.max(MIN_DIST, dist || MIN_DIST));
  let y = item.pos.y;
  if (item.clampHeight !== false) {
    const top = head.position.y + EYE_MARGIN;
    if (y + item.h / 2 > top) y = top - item.h / 2;
    // never sink below the lap
    y = Math.max(y, head.position.y - 0.75 + item.h / 2);
  }
  fromPolar(head, az, d, y, item.pos);
}

/** Angular overlap (radians) between two items as seen from the head, 0 if they are clear. */
export function overlaps(a: LayoutItem, b: LayoutItem, head: HeadPose): number {
  const pa = polar(head, a.pos);
  const pb = polar(head, b.pos);
  const da = Math.max(0.3, pa.dist);
  const db = Math.max(0.3, pb.dist);
  const half = ((a.w / da + b.w / db) / 2) * 1.3 + GAP_ANGLE; // generous: views pitched down squeeze azimuths
  const dAz = Math.abs(wrap(pa.az - pb.az));
  // elevation angles, so a low item close to the user and a panel further away are compared as the eye sees them
  const ea = Math.atan2(a.pos.y - head.position.y, da);
  const eb = Math.atan2(b.pos.y - head.position.y, db);
  const halfEl = (a.h / da + b.h / db) / 2 + GAP_Y;
  if (dAz >= half || Math.abs(ea - eb) >= halfEl) return 0;
  return half - dAz;
}

/** Resolve overlaps in place. Returns the number of moves made. */
export function solve(items: LayoutItem[], head: HeadPose, iterations = 24): number {
  let moves = 0;
  for (const it of items) constrain(it, head);
  for (let k = 0; k < iterations; k++) {
    let any = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const ov = overlaps(a, b, head);
        if (ov <= 0) continue;
        // choose who moves: a movable one, the newer if both are
        let mover: LayoutItem | null = null;
        let other: LayoutItem;
        if (a.movable && b.movable) mover = a.born >= b.born ? a : b;
        else if (a.movable) mover = a;
        else if (b.movable) mover = b;
        if (!mover) continue;
        other = mover === a ? b : a;
        const pm = polar(head, mover.pos);
        const po = polar(head, other.pos);
        if (k >= iterations / 2) {
          // sideways pushing is not converging (boxed in): step the mover back (it then takes less of the view),
          // or drop it below the other
          const keep = mover.pos.clone();
          let solved = false;
          if (pm.dist < CROWDED_DIST - 0.01) {
            fromPolar(head, pm.az, CROWDED_DIST, mover.pos.y, mover.pos);
            constrain(mover, head, CROWDED_DIST);
            solved = overlaps(mover, other, head) === 0;
            if (!solved) {
              fromPolar(head, pm.az + Math.sign(wrap(pm.az - po.az) || 1) * 0.05, CROWDED_DIST, mover.pos.y, mover.pos);
              constrain(mover, head, CROWDED_DIST);
              any = true;
              moves++;
              continue; // farther away now; sideways pushes in later passes need less room
            }
          }
          if (!solved) {
            // put the mover's top edge just under the other's bottom edge, in view angles
            const od = Math.max(0.3, po.dist);
            const md = Math.max(0.3, pm.dist);
            const bottom = Math.atan2(other.pos.y - head.position.y, od) - other.h / 2 / od;
            const el = bottom - GAP_Y - mover.h / 2 / md - 0.01;
            fromPolar(head, pm.az, pm.dist, head.position.y + Math.tan(el) * md, mover.pos);
            constrain(mover, head);
            solved = overlaps(mover, other, head) === 0;
          }
          if (solved) {
            any = true;
            moves++;
            continue;
          }
          mover.pos.copy(keep); // no room: keep pushing sideways
        }
        // try both sideways directions; keep the one that leaves fewer (and smaller) overlaps
        const start = mover.pos.clone();
        const cost = () => items.reduce((acc, o) => (o === mover ? acc : acc + overlaps(mover, o, head)), 0);
        const pref = Math.sign(wrap(pm.az - po.az)) || (mover.born % 2 ? 1 : -1);
        let bestCost = Infinity;
        let bestPos = start.clone();
        for (const dir of [pref, -pref]) {
          mover.pos.copy(start);
          fromPolar(head, pm.az + dir * (ov + 0.01), pm.dist, start.y, mover.pos);
          constrain(mover, head);
          const c0 = cost() + (dir === pref ? 0 : 0.02);
          if (c0 < bestCost) {
            bestCost = c0;
            bestPos = mover.pos.clone();
          }
        }
        mover.pos.copy(bestPos);
        constrain(mover, head);
        any = true;
        moves++;
      }
    }
    if (!any) break;
  }
  // last resort: if a newer panel could not get clear, move the older panel of the pair the other way
  for (let k = 0; k < 6; k++) {
    let any = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        if (!a.movable || !b.movable) continue;
        const ov = overlaps(a, b, head);
        if (ov <= 0) continue;
        const older = a.born < b.born ? a : b;
        const newer = older === a ? b : a;
        const po = polar(head, older.pos);
        const pn = polar(head, newer.pos);
        const dir = Math.sign(wrap(po.az - pn.az)) || -1;
        fromPolar(head, po.az + dir * (ov + 0.01), Math.min(MAX_DIST, po.dist + 0.1), older.pos.y, older.pos);
        constrain(older, head);
        any = true;
        moves++;
      }
    }
    if (!any) break;
  }
  return moves;
}

/** Quaternion that turns a +Z-facing panel at `p` toward the user, tilted back if below eye level. */
export function faceUser(p: THREE.Vector3, head: HeadPose, out = new THREE.Quaternion()) {
  const yaw = Math.atan2(head.position.x - p.x, head.position.z - p.z);
  const dy = head.position.y - p.y;
  const dz = Math.max(0.2, Math.hypot(head.position.x - p.x, head.position.z - p.z));
  const tilt = -Math.max(0, Math.min(0.3, Math.atan2(dy, dz) * 0.8));
  return out.setFromEuler(new THREE.Euler(tilt, yaw, 0, 'YXZ'));
}
