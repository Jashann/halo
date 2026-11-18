import * as THREE from 'three';
import type { HeadPose, Surface } from './shell/place.js';

// The narrow surface every Halo module talks to. The IWSDK shell implements it in the headset;
// unit tests implement it with a plain THREE.Scene.

export const JOINTS = [
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
] as const;
export type JointName = (typeof JOINTS)[number];

export interface HandState {
  handedness: 'left' | 'right';
  visible: boolean;
  joints: Record<string, THREE.Vector3>; // world positions, updated in place every frame
  wristQuat: THREE.Quaternion;
  pinching: boolean;
  pinchStrength: number; // 0..1
  pinchPoint: THREE.Vector3; // midpoint of thumb tip and index tip
  indexTip: THREE.Vector3;
}

export type PinchListener = (hand: HandState, phase: 'start' | 'end') => void;

export interface AideContext {
  /** Group owned by Halo, in world (reference-space) coordinates. */
  root: THREE.Group;
  head(): HeadPose;
  surfaces(): Surface[];
  hands: { left: HandState; right: HandState };
  onPinch(fn: PinchListener): () => void;
  /** Send an `event` message to the server. */
  event(name: string, data?: unknown): void;
  /** Show agent text (speech bubble) locally. */
  say(text: string): void;
  /** Objects that should turn to face the user each frame. */
  billboard(obj: THREE.Object3D, on?: boolean): void;
  /** Elapsed seconds, for animation. */
  now(): number;
}

export function makeHandState(handedness: 'left' | 'right'): HandState {
  const joints: Record<string, THREE.Vector3> = {};
  for (const j of JOINTS) joints[j] = new THREE.Vector3();
  return {
    handedness,
    visible: false,
    joints,
    wristQuat: new THREE.Quaternion(),
    pinching: false,
    pinchStrength: 0,
    pinchPoint: new THREE.Vector3(),
    indexTip: joints['index-finger-tip'],
  };
}
