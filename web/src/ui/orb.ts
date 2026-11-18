import * as THREE from 'three';
import type { AideContext } from '../context.js';
import { makeLabel, type Label } from './label.js';
import { THEME } from './theme.js';
import { glowMaterial } from './glow.js';
import { springIn, springPulse } from './springs.js';

// Halo's presence: a luminous ring with a soft bloom, floating up and to the right of the user's view and
// drifting after the head. States: idle (slow breath), listening (rose, ring opens and pulses), thinking (sky,
// a bright comet runs around the ring), speaking (gold, the ring beats with the words). Speech bubble above
// and to the left; a small status line under it. Panels are kept below eye level, the bubble above it, so the
// two never overlap.

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'offline';

const UP = new THREE.Vector3(0, 1, 0);
const COLORS: Record<OrbState, string> = {
  idle: THEME.halo,
  listening: THEME.rose,
  thinking: THEME.sky,
  speaking: THEME.halo,
  offline: '#8a94a3',
};

export class Orb {
  group = new THREE.Group();
  face = new THREE.Group();
  state: OrbState = 'idle';
  private ring: THREE.Mesh;
  private inner: THREE.Mesh;
  private comet: THREE.Mesh;
  private glow: THREE.Mesh;
  private core: THREE.Mesh;
  private bubble: Label;
  private bubbleWrap = new THREE.Group(); // springs animate this, so the label's own (non-square) scale is untouched
  private status: Label;
  private bubbleUntil = 0;
  private statusUntil = 0;
  private speakUntil = 0;
  private target = new THREE.Vector3();
  private placed = false;
  private color = new THREE.Color(THEME.halo);
  private right = new THREE.Vector3();
  private cur = new THREE.Color(THEME.halo);

  constructor(private ctx: AideContext) {
    this.group.name = 'halo-orb';
    const ringMat = new THREE.MeshBasicMaterial({ color: THEME.halo, toneMapped: false });
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.0055, 12, 72), ringMat);
    this.inner = new THREE.Mesh(
      new THREE.TorusGeometry(0.045, 0.012, 12, 72),
      new THREE.MeshBasicMaterial({ color: THEME.halo, transparent: true, opacity: 0.18, depthWrite: false, toneMapped: false }),
    );
    this.comet = new THREE.Mesh(
      new THREE.TorusGeometry(0.045, 0.0075, 8, 24, 1.1),
      new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }),
    );
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), glowMaterial(THEME.halo, 0.55));
    this.glow.renderOrder = 9;
    this.core = new THREE.Mesh(
      new THREE.CircleGeometry(0.03, 32),
      new THREE.MeshBasicMaterial({ color: THEME.haloSoft, transparent: true, opacity: 0.12, depthWrite: false, toneMapped: false }),
    );
    this.bubble = makeLabel(' ', { height: 0.03, maxWidthPx: 820, align: 'left', border: 'rgba(255,210,122,0.55)', background: 'rgba(14,18,25,0.92)' });
    this.status = makeLabel(' ', { height: 0.02, color: THEME.textDim, background: 'rgba(14,18,25,0.78)', maxWidthPx: 700 });
    this.bubble.mesh.visible = false;
    this.status.mesh.visible = false;
    this.bubble.mesh.renderOrder = 20;
    this.status.mesh.renderOrder = 20;
    this.bubbleWrap.add(this.bubble.mesh);
    this.face.add(this.glow, this.core, this.inner, this.ring, this.comet, this.bubbleWrap, this.status.mesh);
    this.group.add(this.face);
    ctx.billboard(this.face);
    ctx.root.add(this.group);
  }

  setState(s: OrbState) {
    this.state = s;
  }

  say(text: string, seconds?: number) {
    const dur = seconds ?? Math.min(14, 2.5 + text.split(/\s+/).length * 0.33);
    const wasHidden = !this.bubble.mesh.visible;
    this.bubble.setText(text);
    this.bubble.mesh.visible = true;
    if (wasHidden) springIn(this.bubbleWrap, 1);
    this.bubbleUntil = this.ctx.now() + dur;
    this.speakUntil = this.ctx.now() + Math.min(dur, 1.2 + text.length * 0.045);
    this.state = 'speaking';
    springPulse(this.ring, 0.08);
  }

  showStatus(text: string, seconds = 6) {
    this.status.setText(text);
    this.status.mesh.visible = true;
    this.statusUntil = this.ctx.now() + seconds;
  }

  clearStatus() {
    this.statusUntil = 0;
    this.status.mesh.visible = false;
  }

  get bubbleText() {
    return this.bubble.mesh.visible ? this.bubble.text : '';
  }

  /** World-space box of the bubble (for layout checks). */
  bubbleBox(out = new THREE.Box3()) {
    if (!this.bubble.mesh.visible) return out.makeEmpty();
    return out.setFromObject(this.bubble.mesh);
  }

  update(t: number, dt: number) {
    const head = this.ctx.head();
    const right = this.right.crossVectors(head.forward, UP).normalize();
    this.target.copy(head.position).addScaledVector(head.forward, 0.85).addScaledVector(right, 0.32);
    this.target.y = head.position.y + 0.13;
    if (!this.placed) {
      this.group.position.copy(this.target);
      this.placed = true;
    } else {
      const d = this.group.position.distanceTo(this.target);
      const k = d > 0.35 ? 1 - Math.exp(-dt * 3) : 1 - Math.exp(-dt * 0.8);
      this.group.position.lerp(this.target, k);
    }
    if (this.state === 'speaking' && t > this.speakUntil) this.state = 'idle';
    if (this.bubble.mesh.visible && t > this.bubbleUntil) this.bubble.mesh.visible = false;
    if (this.status.mesh.visible && t > this.statusUntil) this.status.mesh.visible = false;

    // Bubble sits above-left of the ring (toward the centre of view, above eye level); status below it.
    const bw = this.bubble.mesh.scale.x;
    const bh = this.bubble.mesh.scale.y;
    this.bubbleWrap.position.set(-0.07 - bw / 2, bh / 2, 0.002);
    const sw = this.status.mesh.scale.x;
    this.status.mesh.position.set(-0.07 - sw / 2, this.bubble.mesh.visible ? -0.03 : 0, 0.002);

    this.color.set(COLORS[this.state]);
    this.cur.lerp(this.color, Math.min(1, dt * 6));
    (this.ring.material as THREE.MeshBasicMaterial).color.copy(this.cur);
    (this.inner.material as THREE.MeshBasicMaterial).color.copy(this.cur);
    (this.glow.material as THREE.MeshBasicMaterial).color.copy(this.cur);
    const glowMat = this.glow.material as THREE.MeshBasicMaterial;
    let g = 0.5 + 0.08 * Math.sin(t * 1.4);
    let s = 1 + 0.03 * Math.sin(t * 1.4);
    if (this.state === 'speaking') {
      s = 1 + 0.07 * Math.abs(Math.sin(t * 8));
      g = 0.7;
    }
    if (this.state === 'listening') {
      s = 1.12 + 0.08 * Math.sin(t * 5);
      g = 0.75 + 0.15 * Math.sin(t * 5);
    }
    if (this.state === 'offline') {
      s = 0.85;
      g = 0.15;
    }
    glowMat.opacity = g;
    this.inner.scale.setScalar(s * 1.02);
    this.glow.scale.setScalar(0.9 + 0.25 * s);
    this.comet.visible = this.state === 'thinking';
    if (this.comet.visible) this.comet.rotation.z = -t * 5;
    this.ring.rotation.z = t * 0.2;
  }
}
