import { JOINTS, makeHandState, type HandState, type PinchListener } from '../context.js';

// Reads the 25 WebXR hand joints every frame (XRFrame.getJointPose) into reusable vectors and derives pinch
// with hysteresis (thumb tip to index tip: start < 1.8 cm, release > 3.5 cm). Works in IWER hands mode too.

const PINCH_ON = 0.018;
const PINCH_OFF = 0.035;

export class HandTracker {
  left = makeHandState('left');
  right = makeHandState('right');
  private listeners: PinchListener[] = [];
  /** test / desktop override: when set, joints are not read from XR */
  manual = false;

  onPinch(fn: PinchListener) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  emit(h: HandState, phase: 'start' | 'end') {
    for (const f of [...this.listeners]) {
      try {
        f(h, phase);
      } catch (e) {
        console.warn('[halo] pinch listener failed', e);
      }
    }
  }

  update(frame: XRFrame | null, ref: XRReferenceSpace | null) {
    if (this.manual) {
      this.derive(this.left);
      this.derive(this.right);
      return;
    }
    let seenL = false;
    let seenR = false;
    if (frame && ref) {
      for (const src of frame.session.inputSources) {
        const hand = (src as XRInputSource & { hand?: XRHand }).hand;
        if (!hand || (src.handedness !== 'left' && src.handedness !== 'right')) continue;
        const st = src.handedness === 'left' ? this.left : this.right;
        let ok = true;
        for (const name of JOINTS) {
          const space = hand.get(name as XRHandJoint);
          const pose = space ? frame.getJointPose?.(space, ref) : null;
          if (!pose) {
            ok = false;
            break;
          }
          const p = pose.transform.position;
          st.joints[name].set(p.x, p.y, p.z);
          if (name === 'wrist') {
            const o = pose.transform.orientation;
            st.wristQuat.set(o.x, o.y, o.z, o.w);
          }
        }
        st.visible = ok;
        if (src.handedness === 'left') seenL = ok;
        else seenR = ok;
      }
    }
    if (!seenL) this.left.visible = false;
    if (!seenR) this.right.visible = false;
    this.derive(this.left);
    this.derive(this.right);
  }

  private derive(h: HandState) {
    const t = h.joints['thumb-tip'];
    const i = h.joints['index-finger-tip'];
    h.pinchPoint.copy(t).add(i).multiplyScalar(0.5);
    if (!h.visible) {
      if (h.pinching) {
        h.pinching = false;
        this.emit(h, 'end');
      }
      h.pinchStrength = 0;
      return;
    }
    const d = t.distanceTo(i);
    h.pinchStrength = Math.max(0, Math.min(1, 1 - (d - 0.01) / 0.06));
    if (!h.pinching && d < PINCH_ON) {
      h.pinching = true;
      this.emit(h, 'start');
    } else if (h.pinching && d > PINCH_OFF) {
      h.pinching = false;
      this.emit(h, 'end');
    }
  }
}
