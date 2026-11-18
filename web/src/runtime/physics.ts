import * as THREE from 'three';
import type { Surface } from '../shell/place.js';

// Small built-in physics for generated mini-games: balls (spheres) and boxes (axis-aligned), gravity,
// restitution, friction, collisions against the room's horizontal surfaces (finite rectangles), walls,
// the floor, open cups, and each other. Fixed 1/120 s substeps. Deliberately simple and allocation-free.

export interface BodyOptions {
  shape?: 'ball' | 'sphere' | 'box';
  bounce?: number; // alias of restitution (runtime API)
  isStatic?: boolean; // alias of static (runtime API)
  radius?: number;
  size?: [number, number, number];
  mass?: number;
  restitution?: number;
  friction?: number;
  velocity?: [number, number, number];
  static?: boolean;
  gravity?: boolean;
}

export interface Body {
  object: THREE.Object3D;
  shape: 'ball' | 'box';
  radius: number;
  half: THREE.Vector3;
  velocity: THREE.Vector3;
  angularVelocity: THREE.Vector3;
  isStatic: boolean;
  mass: number;
  restitution: number;
  friction: number;
  static: boolean;
  gravity: boolean;
  held: boolean; // when true the game moves it (e.g. in a pinch); physics skips it
  grounded: boolean;
  sleeping: boolean;
  userData: Record<string, unknown>;
}

export interface Cup {
  object: THREE.Object3D; // origin at the centre of the cup's base
  radius: number;
  height: number;
  wall: number;
}

export type HitListener = (a: Body, b: Body | { surface: Surface } | { cup: Cup } | { floor: true }, speed: number) => void;

interface Rect {
  surface: Surface;
  c: THREE.Vector3;
  n: THREE.Vector3;
  u: THREE.Vector3; // in-plane axis 1
  v: THREE.Vector3; // in-plane axis 2
  hu: number;
  hv: number;
  horizontal: boolean;
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const tmpT = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Physics {
  bodies: Body[] = [];
  cups: Cup[] = [];
  gravity = -9.81;
  floorY = 0;
  floor = true;
  private rects: Rect[] = [];
  private listeners: HitListener[] = [];
  private acc = 0;
  private h = 1 / 120;

  setSurfaces(surfaces: Surface[]) {
    this.rects = surfaces
      .filter((s) => s.kind !== 'mesh' || s.orientation === 'horizontal')
      .filter((s) => !['floor', 'ceiling', 'global mesh'].includes(s.label.toLowerCase()))
      .map((s) => {
        const n = new THREE.Vector3(...s.normal).normalize();
        const horizontal = Math.abs(n.y) > 0.7;
        let u: THREE.Vector3;
        let v: THREE.Vector3;
        if (horizontal) {
          const yaw = (s as Surface & { yaw?: number }).yaw ?? 0;
          u = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
          v = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
          if (n.y < 0) n.multiplyScalar(-1);
        } else {
          u = new THREE.Vector3().crossVectors(UP, n).normalize();
          v = UP.clone();
        }
        return {
          surface: s,
          c: new THREE.Vector3(...s.center),
          n,
          u,
          v,
          hu: s.size[0] / 2,
          hv: (horizontal ? s.size[1] : s.height ?? s.size[1]) / 2,
          horizontal,
        };
      });
  }

  add(object: THREE.Object3D, o: BodyOptions = {}): Body {
    const shape: 'ball' | 'box' = o.shape === 'box' ? 'box' : 'ball';
    const isStatic = !!(o.static ?? o.isStatic);
    const half = new THREE.Vector3(...(o.size ?? [0.05, 0.05, 0.05])).multiplyScalar(0.5);
    const b: Body = {
      object,
      shape,
      radius: o.radius ?? (shape === 'ball' ? 0.03 : Math.max(half.x, half.y, half.z)),
      half,
      velocity: new THREE.Vector3(...(o.velocity ?? [0, 0, 0])),
      angularVelocity: new THREE.Vector3(),
      isStatic,
      mass: o.mass ?? 1,
      restitution: o.restitution ?? o.bounce ?? 0.4,
      friction: o.friction ?? 0.4,
      static: isStatic,
      gravity: o.gravity !== false,
      held: false,
      grounded: false,
      sleeping: false,
      userData: {},
    };
    this.bodies.push(b);
    return b;
  }

  addCup(object: THREE.Object3D, radius: number, height: number, wall = 0.004): Cup {
    const c = { object, radius, height, wall };
    this.cups.push(c);
    return c;
  }

  remove(target: THREE.Object3D | Body) {
    this.bodies = this.bodies.filter((b) => b !== target && b.object !== target);
    this.cups = this.cups.filter((c) => c.object !== target);
  }

  /** Runtime API: aide.physics.onCollide(obj, fn(other: Object3D | "surface")). */
  onCollide(obj: THREE.Object3D, fn: (other: THREE.Object3D | 'surface') => void) {
    return this.onHit((a, b) => {
      const other = (x: Parameters<HitListener>[1]): THREE.Object3D | 'surface' =>
        'object' in x ? (x as Body).object : 'cup' in x ? (x as { cup: Cup }).cup.object : 'surface';
      if (a.object === obj) fn(other(b));
      else if ('object' in b && (b as Body).object === obj) fn(a.object);
    });
  }

  onHit(fn: HitListener) {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((f) => f !== fn));
  }

  private emit(a: Body, b: Parameters<HitListener>[1], speed: number) {
    for (const f of this.listeners) f(a, b, speed);
  }

  /** Is the ball resting inside the cup (below the rim, within the radius)? */
  inCup(b: Body, cup: Cup): boolean {
    const base = tmp2.copy(cup.object.position);
    const dx = b.object.position.x - base.x;
    const dz = b.object.position.z - base.z;
    const y = b.object.position.y - base.y;
    return dx * dx + dz * dz < cup.radius * cup.radius && y < cup.height && y > -0.01;
  }

  step(dt: number) {
    this.acc = Math.min(this.acc + dt, 0.05);
    const h = 1 / 120;
    let n = 0;
    while (this.acc >= h && n < 6) {
      this.substep(h);
      this.acc -= h;
      n++;
    }
  }

  private substep(h: number) {
    for (const b of this.bodies) {
      b.static = b.isStatic;
      if (b.static || b.held) continue;
      if (b.sleeping) continue;
      if (b.gravity) b.velocity.y += this.gravity * h;
      b.object.position.addScaledVector(b.velocity, h);
      b.grounded = false;
      this.collideWorld(b);
      if (b.velocity.lengthSq() < 0.0004 && b.grounded) {
        b.velocity.set(0, 0, 0);
      }
    }
    // pairs
    const bs = this.bodies;
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) this.collidePair(bs[i], bs[j]);
    }
  }

  private extentAlong(b: Body, n: THREE.Vector3): number {
    if (b.shape === 'ball') return b.radius;
    return Math.abs(n.x) * b.half.x + Math.abs(n.y) * b.half.y + Math.abs(n.z) * b.half.z;
  }

  private bounce(b: Body, n: THREE.Vector3, other: Parameters<HitListener>[1]) {
    const vn = b.velocity.dot(n);
    if (vn < 0) {
      const speed = -vn;
      b.velocity.addScaledVector(n, -vn * (1 + b.restitution));
      // friction on the tangential part: rolling decel on floors/tables, a small loss on walls
      tmp.copy(n).multiplyScalar(b.velocity.dot(n));
      tmpT.copy(b.velocity).sub(tmp);
      const tl = tmpT.length();
      if (n.y > 0.7) {
        const dec = b.friction * 1.2 * this.h;
        tmpT.multiplyScalar(tl > dec ? (tl - dec) / tl : 0);
      } else if (speed > 0.2) tmpT.multiplyScalar(0.9);
      b.velocity.copy(tmp).add(tmpT);
      if (Math.abs(b.velocity.dot(n)) < 0.15) b.velocity.addScaledVector(n, -b.velocity.dot(n));
      if (speed > 0.25) this.emit(b, other, speed);
    }
    if (n.y > 0.7) b.grounded = true;
  }

  private collideWorld(b: Body) {
    const p = b.object.position;
    // floor
    if (this.floor) {
      const e = this.extentAlong(b, UP);
      if (p.y - e < this.floorY) {
        p.y = this.floorY + e;
        this.bounce(b, UP, { floor: true });
      }
    }
    for (const r of this.rects) {
      const e = this.extentAlong(b, r.n);
      tmp.copy(p).sub(r.c);
      const d = tmp.dot(r.n);
      const a = tmp.dot(r.u);
      const c = tmp.dot(r.v);
      const margin = b.shape === 'ball' ? b.radius * 0.5 : 0;
      if (Math.abs(a) > r.hu + margin || Math.abs(c) > r.hv + margin) continue;
      if (r.horizontal) {
        // only from above, and only if we were not well below the top (tunnelling guard)
        if (d < e && d > -0.05) {
          p.addScaledVector(r.n, e - d);
          this.bounce(b, r.n, { surface: r.surface });
        }
      } else if (Math.abs(d) < e) {
        const side = d >= 0 ? 1 : -1;
        p.addScaledVector(r.n, side * e - d);
        tmp2.copy(r.n).multiplyScalar(side);
        this.bounce(b, tmp2, { surface: r.surface });
      }
    }
    if (b.shape === 'ball') for (const cup of this.cups) this.collideCup(b, cup);
  }

  private collideCup(b: Body, cup: Cup) {
    const base = tmp2.copy(cup.object.position);
    const p = b.object.position;
    const y = p.y - base.y;
    if (y > cup.height + b.radius || y < -b.radius) return;
    const dx = p.x - base.x;
    const dz = p.z - base.z;
    const d = Math.hypot(dx, dz);
    const R = cup.radius;
    // cup floor (inside)
    if (d < R && y - b.radius < cup.wall) {
      p.y = base.y + cup.wall + b.radius;
      this.bounce(b, UP, { cup });
      b.velocity.multiplyScalar(0.92); // cups swallow energy
      return;
    }
    // rim / walls: treat the wall as a thin ring
    const nx = d > 1e-6 ? dx / d : 1;
    const nz = d > 1e-6 ? dz / d : 0;
    if (y <= cup.height) {
      const gap = d - R;
      const inside = gap < 0;
      // A slow ball rolling along the table is let in through the wall (so a putt can drop into the cup);
      // fast or high balls hit the outside wall.
      const hs = Math.hypot(b.velocity.x, b.velocity.z);
      const passThrough = !inside && hs < 1.2 && y < cup.height * 0.6;
      if (!passThrough && Math.abs(gap) < b.radius + cup.wall) {
        const push = (b.radius + cup.wall) - Math.abs(gap);
        const sign = inside ? -1 : 1;
        p.x += nx * push * sign;
        p.z += nz * push * sign;
        tmp.set(nx * sign, 0, nz * sign);
        this.bounce(b, tmp, { cup });
      }
    } else {
      // above the rim: a ball whose centre is over the rim line bounces off the lip
      const lip = Math.hypot(d - R, y - cup.height);
      if (lip < b.radius) {
        tmp.set(nx * (d - R), y - cup.height, nz * (d - R)).normalize();
        p.addScaledVector(tmp, b.radius - lip);
        this.bounce(b, tmp, { cup });
      }
    }
  }

  private collidePair(a: Body, b: Body) {
    if ((a.static || a.held) && (b.static || b.held)) return;
    const pa = a.object.position;
    const pb = b.object.position;
    if (a.shape === 'ball' && b.shape === 'ball') {
      tmp.copy(pb).sub(pa);
      const d = tmp.length();
      const min = a.radius + b.radius;
      if (d >= min || d < 1e-9) return;
      tmp.divideScalar(d);
      this.resolve(a, b, tmp, min - d);
      return;
    }
    // box-box or ball-box: use AABB vs AABB/sphere approximations
    const ha = a.shape === 'ball' ? tmp2.setScalar(a.radius) : a.half;
    const hbx = b.shape === 'ball' ? b.radius : b.half.x;
    const hby = b.shape === 'ball' ? b.radius : b.half.y;
    const hbz = b.shape === 'ball' ? b.radius : b.half.z;
    const ox = ha.x + hbx - Math.abs(pb.x - pa.x);
    const oy = ha.y + hby - Math.abs(pb.y - pa.y);
    const oz = ha.z + hbz - Math.abs(pb.z - pa.z);
    if (ox <= 0 || oy <= 0 || oz <= 0) return;
    const n = new THREE.Vector3();
    if (ox < oy && ox < oz) n.set(Math.sign(pb.x - pa.x) || 1, 0, 0);
    else if (oy < oz) n.set(0, Math.sign(pb.y - pa.y) || 1, 0);
    else n.set(0, 0, Math.sign(pb.z - pa.z) || 1);
    this.resolve(a, b, n, Math.min(ox, oy, oz));
  }

  private resolve(a: Body, b: Body, n: THREE.Vector3, depth: number) {
    const ia = a.static || a.held ? 0 : 1 / a.mass;
    const ib = b.static || b.held ? 0 : 1 / b.mass;
    const sum = ia + ib;
    if (sum === 0) return;
    a.object.position.addScaledVector(n, (-depth * ia) / sum);
    b.object.position.addScaledVector(n, (depth * ib) / sum);
    // held bodies act as moving pushers: use their velocity
    const rv = tmp.copy(b.velocity).sub(a.velocity).dot(n);
    if (rv > 0) return;
    const e = Math.min(a.restitution, b.restitution);
    const j = (-(1 + e) * rv) / sum;
    a.velocity.addScaledVector(n, -j * ia);
    b.velocity.addScaledVector(n, j * ib);
    a.sleeping = b.sleeping = false;
    if (n.y < -0.7) a.grounded = true;
    if (n.y > 0.7) b.grounded = true;
    if (-rv > 0.25) this.emit(a, b, -rv);
  }
}
