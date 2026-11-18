import * as THREE from 'three';
import type { AideContext } from '../context.js';
import { resolvePlace } from '../shell/place.js';
import { makeLabel, type Label } from './label.js';
import { resolveColor } from './theme.js';
import { sound } from './sound.js';
import { springIn, springOut } from './springs.js';
import { glowMaterial } from './glow.js';

// Marks on real places: "chop here", "pan goes here", "stove: 230 C / 450 F". Gentle pulse, label on top.

export interface HighlightArgs {
  id?: string;
  target?: unknown; // {surface_id, offset} | {point} | "table"
  label?: string;
  color?: string;
  shape?: 'ring' | 'zone' | 'arrow' | 'off' | 'none';
  size?: number | [number, number];
  clear?: boolean;
}

interface Item {
  id: string;
  group: THREE.Group;
  pulse: THREE.Object3D;
  shape: string;
  label?: Label;
  born: number;
}

let seq = 0;

export class Highlights {
  items = new Map<string, Item>();
  private ringGeo = new THREE.TorusGeometry(1, 0.06, 8, 48);
  private discGeo = new THREE.CircleGeometry(1, 40);

  constructor(private ctx: AideContext) {}

  show(args: HighlightArgs): { id: string; position: number[]; surface?: string } {
    const id = String(args.id || `hl-${++seq}`);
    if (args.clear || args.shape === 'off' || args.shape === 'none') {
      this.remove(id);
      return { id, position: [] };
    }
    this.remove(id, false);
    const shape = args.shape === 'zone' || args.shape === 'arrow' ? args.shape : 'ring';
    const color = new THREE.Color(resolveColor(args.color));
    const place = resolvePlace(args.target ?? 'table', this.ctx.surfaces(), this.ctx.head(), 'marker');
    const group = new THREE.Group();
    group.name = `highlight:${id}`;
    group.position.copy(place.position);
    const vertical = place.surface && Math.abs(place.surface.normal[1]) < 0.7;
    // Orient so local +Y is the surface normal (horizontal default).
    if (vertical) {
      const n = place.facing.clone();
      group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    }
    const sizeArr = Array.isArray(args.size) ? args.size : [args.size ?? 0, args.size ?? 0];
    const r = typeof args.size === 'number' ? args.size : 0.09;
    let pulse: THREE.Object3D;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
    if (shape === 'ring') {
      const ring = new THREE.Mesh(this.ringGeo, mat);
      ring.rotation.x = -Math.PI / 2;
      ring.scale.setScalar(r);
      const fill = new THREE.Mesh(this.discGeo, mat.clone());
      (fill.material as THREE.MeshBasicMaterial).opacity = 0.18;
      fill.rotation.x = -Math.PI / 2;
      fill.scale.setScalar(r * 0.94);
      group.add(fill, ring);
      pulse = ring;
    } else if (shape === 'zone') {
      const w = sizeArr[0] || 0.3;
      const d = sizeArr[1] || 0.2;
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat.clone());
      (fill.material as THREE.MeshBasicMaterial).opacity = 0.2;
      fill.rotation.x = -Math.PI / 2;
      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, d)),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, toneMapped: false }),
      );
      edge.rotation.x = -Math.PI / 2;
      // align zone with the user's view
      const yaw = Math.atan2(place.facing.x, place.facing.z);
      const holder = new THREE.Group();
      holder.rotation.y = yaw;
      holder.add(fill, edge);
      group.add(holder);
      pulse = fill;
    } else {
      const arrow = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.09, 12), mat);
      shaft.position.y = 0.1;
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.06, 16), mat);
      head.rotation.x = Math.PI;
      head.position.y = 0.035;
      const dot = new THREE.Mesh(this.discGeo, mat.clone());
      (dot.material as THREE.MeshBasicMaterial).opacity = 0.3;
      dot.rotation.x = -Math.PI / 2;
      dot.scale.setScalar(0.04);
      arrow.add(shaft, head);
      group.add(arrow, dot);
      pulse = arrow;
    }
    // soft bloom on the surface under every mark
    const bloom = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMaterial(color, 0.35));
    bloom.rotation.x = -Math.PI / 2;
    bloom.position.y = 0.001;
    const bs = shape === 'zone' ? Math.max(sizeArr[0] || 0.3, sizeArr[1] || 0.2) * 1.6 : r * 4.5;
    bloom.scale.setScalar(shape === 'arrow' ? 0.18 : bs);
    group.add(bloom);
    let label: Label | undefined;
    if (args.label) {
      label = makeLabel(String(args.label), { height: 0.03, border: `#${color.getHexString()}` });
      label.mesh.position.set(0, shape === 'arrow' ? 0.2 : 0.09, 0);
      group.add(label.mesh);
      this.ctx.billboard(label.mesh);
    }
    this.ctx.root.add(group);
    springIn(group, 1);
    this.items.set(id, { id, group, pulse, shape, label, born: this.ctx.now() });
    sound.appear();
    const p = group.position;
    return { id, position: [round(p.x), round(p.y), round(p.z)], surface: place.surface?.id };
  }

  /** Remove with a spring-out (the default) or at once. */
  remove(id: string, animate = true): boolean {
    const it = this.items.get(id);
    if (!it) return false;
    this.items.delete(id);
    if (animate) springOut(it.group, () => this.dispose(it));
    else this.dispose(it);
    return true;
  }

  private dispose(it: Item) {
    if (it.label) this.ctx.billboard(it.label.mesh, false);
    it.label?.dispose();
    it.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
      if (m.geometry && m.geometry !== this.ringGeo && m.geometry !== this.discGeo) m.geometry.dispose();
    });
    it.group.removeFromParent();
  }

  clear() {
    for (const id of [...this.items.keys()]) this.remove(id);
  }

  update(t: number) {
    for (const it of this.items.values()) {
      const age = t - it.born;
      const k = 1 + 0.08 * Math.sin(age * 3.2);
      if (it.shape === 'arrow') it.pulse.position.y = 0.02 * Math.sin(age * 3.2);
      else if (it.shape === 'ring') {
        const base = it.pulse.userData.base ?? (it.pulse.userData.base = it.pulse.scale.x);
        it.pulse.scale.setScalar(base * k);
      } else {
        const m = (it.pulse as THREE.Mesh).material as THREE.MeshBasicMaterial;
        m.opacity = 0.16 + 0.08 * Math.sin(age * 3.2);
      }
    }
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
