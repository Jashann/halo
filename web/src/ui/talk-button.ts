import * as THREE from 'three';
import type { AideContext } from '../context.js';
import { makeLabel, type Label } from './label.js';
import { THEME } from './theme.js';

// A "talk" button on the back of the left wrist. Pinch with the right hand on the button and hold to speak;
// let go to send. (The palm-facing pinch is reserved by the system on Quest, so the button sits on the back of
// the wrist and is pinched by the other hand.) Glows while recording.

const REACH = 0.06; // metres from the right pinch point to the button centre

export class TalkButton {
  group = new THREE.Group();
  private disc: THREE.Mesh;
  private ring: THREE.Mesh;
  private label: Label;
  holding = false;
  private tmp = new THREE.Vector3();
  private off = new THREE.Vector3();

  constructor(
    private ctx: AideContext,
    private onHold: (down: boolean) => void,
  ) {
    this.group.name = 'talk-button';
    this.disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.018, 32),
      new THREE.MeshBasicMaterial({ color: THEME.accent, transparent: true, opacity: 0.9, toneMapped: false, side: THREE.DoubleSide }),
    );
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.021, 0.025, 40),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.7, toneMapped: false, side: THREE.DoubleSide }),
    );
    this.label = makeLabel('Pinch to talk', { height: 0.012, fontPx: 40 });
    this.label.mesh.position.set(0, 0.036, 0);
    this.group.add(this.disc, this.ring, this.label.mesh);
    this.group.visible = false;
    ctx.root.add(this.group);
    ctx.onPinch((hand, phase) => {
      if (hand.handedness !== 'right') return;
      if (phase === 'start' && this.group.visible && hand.pinchPoint.distanceTo(this.group.position) < REACH) {
        this.holding = true;
        this.onHold(true);
      } else if (phase === 'end' && this.holding) {
        this.holding = false;
        this.onHold(false);
      }
    });
  }

  setRecording(on: boolean) {
    this.label.setText(on ? 'Listening... let go to send' : 'Pinch to talk');
    (this.disc.material as THREE.MeshBasicMaterial).color.set(on ? '#ff7a9c' : THEME.accent);
  }

  update(t: number) {
    const L = this.ctx.hands.left;
    this.group.visible = L.visible;
    if (!L.visible) return;
    // back of the wrist: wrist joint pushed out along the back-of-hand normal (+Y in the wrist frame, palm is -Y)
    this.off.set(0, 0.035, 0.02).applyQuaternion(L.wristQuat);
    this.group.position.copy(L.joints['wrist']).add(this.off);
    // face the head
    const head = this.ctx.head();
    this.tmp.copy(head.position);
    this.group.lookAt(this.tmp);
    const s = this.holding ? 1.15 + 0.08 * Math.sin(t * 10) : 1;
    this.disc.scale.setScalar(s);
  }
}
