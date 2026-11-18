import * as THREE from 'three';
import type { AideContext } from '../context.js';
import { resolvePlace } from '../shell/place.js';
import { makeLabel, type Label } from './label.js';
import { THEME } from './theme.js';
import { sound } from './sound.js';
import { springIn, springOut } from './springs.js';
import { glowMaterial } from './glow.js';

// Anchored countdowns: a progress ring that empties, the label and time under it, a chime at zero and an
// event `timer_done` to the server. Zero allocation per frame: the ring uses drawRange.

const SEGMENTS = 72;

interface TimerItem {
  id: string;
  label: string;
  total: number;
  endsAt: number;
  group: THREE.Group;
  ring: THREE.Mesh;
  text: Label;
  done: boolean;
  doneAt: number;
  lastShown: string;
}

export function formatTime(s: number): string {
  s = Math.max(0, Math.ceil(s));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export class Timers {
  items = new Map<string, TimerItem>();
  private ringGeo = new THREE.RingGeometry(0.06, 0.072, SEGMENTS, 1);
  private bgGeo = new THREE.RingGeometry(0.06, 0.072, SEGMENTS, 1);
  private faceGeo = new THREE.CircleGeometry(0.058, 48);

  /** Things a new timer should not sit on top of (the demonstration hands). */
  avoid: () => THREE.Vector3[] = () => [];

  constructor(private ctx: AideContext) {}

  start(args: { id?: string; label?: string; seconds?: number; at?: unknown; cancel?: boolean }) {
    const label = String(args.label ?? 'Timer');
    const id = String(args.id ?? slug(label));
    const seconds = Number(args.seconds ?? 60);
    if (args.cancel || !(seconds > 0)) {
      this.remove(id);
      return { id, cancelled: true };
    }
    this.remove(id, false);
    // Spread several timers side by side.
    const n = this.items.size;
    const at = args.at ?? 'table';
    const place = resolvePlace(at, this.ctx.surfaces(), this.ctx.head(), 'timer');
    const group = new THREE.Group();
    group.name = `timer:${id}`;
    group.position.copy(place.position);
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), place.facing).normalize();
    if (n > 0) group.position.addScaledVector(right, 0.2 * n);
    // if something is in the way (the demonstration hands), take the nearest clear spot beside it
    const base = group.position.clone();
    const clear = (v: THREE.Vector3) => !this.avoid().some((o) => Math.hypot(o.x - v.x, o.z - v.z) < 0.28);
    if (!clear(base)) {
      for (const k of [-1, 1, -2, 2]) {
        const v = base.clone().addScaledVector(right, 0.22 * k);
        if (clear(v)) {
          group.position.copy(v);
          break;
        }
      }
    }
    const face = new THREE.Mesh(
      this.faceGeo,
      new THREE.MeshBasicMaterial({ color: THEME.panel, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    const bg = new THREE.Mesh(
      this.bgGeo,
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.15, depthWrite: false }),
    );
    const ring = new THREE.Mesh(
      this.ringGeo.clone(),
      new THREE.MeshBasicMaterial({ color: THEME.warm, transparent: true, depthWrite: false, toneMapped: false }),
    );
    ring.rotation.z = -Math.PI / 2; // with the mirror below, starts at 12 o'clock
    ring.scale.x = -1; // run clockwise
    ring.renderOrder = 11;
    const text = makeLabel(`${formatTime(seconds)}`, { height: 0.034, background: null, fontPx: 56 });
    text.mesh.position.set(0, 0.004, 0.002);
    const name = makeLabel(label, { height: 0.022, fontPx: 40 });
    name.mesh.position.set(0, -0.1, 0);
    const bloom = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.36), glowMaterial(THEME.warm, 0.35));
    bloom.position.z = -0.004;
    const dial = new THREE.Group();
    dial.add(bloom, face, bg, ring, text.mesh, name.mesh);
    group.add(dial);
    this.ctx.billboard(dial);
    this.ctx.root.add(group);
    const now = this.ctx.now();
    const item: TimerItem = {
      id,
      label,
      total: seconds,
      endsAt: now + seconds,
      group,
      ring,
      text,
      done: false,
      doneAt: 0,
      lastShown: '',
    };
    (group.userData as any).nameLabel = name;
    this.items.set(id, item);
    springIn(group, 1);
    sound.appear();
    return { id, seconds, label };
  }

  remove(id: string, animate = true) {
    const it = this.items.get(id);
    if (!it) return false;
    this.items.delete(id);
    if (animate) springOut(it.group, () => this.dispose(it));
    else this.dispose(it);
    return true;
  }

  private dispose(it: TimerItem) {
    const dial = it.group.children[0];
    this.ctx.billboard(dial, false);
    it.text.dispose();
    (it.group.userData as any).nameLabel?.dispose();
    it.ring.geometry.dispose();
    it.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.material && !Array.isArray(m.material)) m.material.dispose();
    });
    it.group.removeFromParent();
  }

  clear() {
    for (const id of [...this.items.keys()]) this.remove(id);
  }

  /** Remove finished timers (a new topic is starting). */
  clearDone() {
    for (const it of [...this.items.values()]) if (it.done) this.remove(it.id);
  }

  remaining(id: string): number | null {
    const it = this.items.get(id);
    return it ? Math.max(0, it.endsAt - this.ctx.now()) : null;
  }

  update(t: number) {
    for (const it of this.items.values()) {
      const left = Math.max(0, it.endsAt - t);
      const frac = it.total > 0 ? left / it.total : 0;
      const segs = Math.round(frac * SEGMENTS);
      it.ring.geometry.setDrawRange(0, segs * 6);
      if (!it.done) {
        const shown = formatTime(left);
        if (shown !== it.lastShown) {
          it.lastShown = shown;
          it.text.setText(shown);
        }
        if (left <= 0) {
          it.done = true;
          it.doneAt = t;
          it.text.setText('Done');
          const m = it.ring.material as THREE.MeshBasicMaterial;
          m.color.set(THEME.mint);
          it.ring.geometry.setDrawRange(0, SEGMENTS * 6);
          sound.chime();
          this.ctx.event('timer_done', { id: it.id, label: it.label });
        }
      } else {
        // celebratory pulse for 6 s, then rest; auto-remove after 20 s
        const a = t - it.doneAt;
        it.group.children[0].scale.setScalar(a < 6 ? 1 + 0.06 * Math.abs(Math.sin(a * 4)) : 1);
        if (a > 20) this.remove(it.id);
      }
    }
  }
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'timer';
}
