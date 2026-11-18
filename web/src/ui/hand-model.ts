import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { THEME } from './theme.js';

// A real hand for the demonstrations: the WebXR "generic-hand" skinned model (MIT, public/models/hands), whose 25
// bones carry the WebXR joint names. The bones are flat under the armature, so Halo runs its own forward
// kinematics from the model's rest pose: the wrist goes where the keyframe says, and each finger joint flexes
// about its local X axis by the keyframe's curl. The mesh is recoloured as glowing translucent "light" with a
// fresnel rim so the shape reads clearly over passthrough.

const FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
const CHAINS: string[][] = [
  ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  ...FINGERS.map((f) => ['wrist', `${f}-metacarpal`, `${f}-phalanx-proximal`, `${f}-phalanx-intermediate`, `${f}-phalanx-distal`, `${f}-tip`]),
];
// flexion (radians at curl = 1) per joint along each chain, wrist excluded
const FLEX_FINGER = [0.08, 1.45, 1.6, 1.05, 0];
const FLEX_THUMB = [0.25, 0.55, 0.75, 0];

let loader: GLTFLoader | null = null;
const cache = new Map<string, Promise<THREE.Group | null>>();

function load(url: string): Promise<THREE.Group | null> {
  if (typeof document === 'undefined') return Promise.resolve(null); // Node tests: procedural fallback
  if (!cache.has(url)) {
    loader ??= new GLTFLoader();
    cache.set(
      url,
      loader.loadAsync(url).then(
        (g) => g.scene as THREE.Group,
        (e) => {
          console.warn('[halo] hand model failed to load, using the simple hand', e);
          return null;
        },
      ),
    );
  }
  return cache.get(url)!;
}

export function makeGlowHandMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({
    color: '#fff3d6',
    emissive: THEME.halo,
    emissiveIntensity: 0.35,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.rimColor = { value: new THREE.Color(THEME.halo) };
    shader.fragmentShader = shader.fragmentShader
      .replace('uniform vec3 emissive;', 'uniform vec3 emissive;\nuniform vec3 rimColor;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float rim = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 2.2);
        totalEmissiveRadiance += rimColor * rim * 1.4;
        diffuseColor.a = min(1.0, diffuseColor.a + rim * 0.45);`,
      );
  };
  return m;
}

export class SkinnedHand {
  root = new THREE.Group();
  ready = false;
  private bones = new Map<string, THREE.Bone>();
  private rest = new Map<string, THREE.Matrix4>();
  private localRest = new Map<string, THREE.Matrix4>();
  private world = new Map<string, THREE.Matrix4>();
  private rx = new THREE.Matrix4();
  private tmp = new THREE.Matrix4();
  private p = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();

  constructor(public side: 'left' | 'right', material: THREE.Material, base = './') {
    this.root.name = `glow-hand-${side}`;
    void load(`${base}models/hands/${side}.glb`).then((scene) => {
      if (!scene) return;
      scene.traverse((o) => {
        if ((o as THREE.Bone).isBone) this.bones.set(o.name, o as THREE.Bone);
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
          const m = o as THREE.SkinnedMesh;
          m.material = material;
          m.frustumCulled = false;
          m.renderOrder = 3;
        }
      });
      for (const [name, b] of this.bones) this.rest.set(name, new THREE.Matrix4().compose(b.position, b.quaternion, b.scale));
      for (const chain of CHAINS) {
        for (let i = 1; i < chain.length; i++) {
          const parent = this.rest.get(chain[i - 1]);
          const child = this.rest.get(chain[i]);
          if (parent && child) this.localRest.set(chain[i], parent.clone().invert().multiply(child));
        }
      }
      for (const n of this.bones.keys()) this.world.set(n, new THREE.Matrix4());
      this.root.add(scene);
      this.ready = this.localRest.size >= 24;
    });
  }

  /** Pose the hand: `wrist` is the wrist joint's matrix in the parent's space (WebXR joint convention). */
  setPose(wrist: THREE.Matrix4, curl: number, thumb: number) {
    if (!this.ready) return;
    this.world.get('wrist')!.copy(wrist);
    CHAINS.forEach((chain, c) => {
      const flex = c === 0 ? FLEX_THUMB : FLEX_FINGER;
      const k = c === 0 ? thumb : curl;
      for (let i = 1; i < chain.length; i++) {
        const name = chain[i];
        const w = this.world.get(name)!;
        w.multiplyMatrices(this.world.get(chain[i - 1])!, this.localRest.get(name)!);
        const a = flex[i - 1] ?? 0;
        if (a) w.multiply(this.rx.makeRotationX(-a * k));
      }
    });
    for (const [name, b] of this.bones) {
      const w = this.world.get(name);
      if (!w) continue;
      w.decompose(this.p, this.q, this.s);
      b.position.copy(this.p);
      b.quaternion.copy(this.q);
    }
  }

  /** A joint's position in the parent's space (after setPose). */
  joint(name: string, out: THREE.Vector3): THREE.Vector3 | null {
    const w = this.world.get(name);
    if (!this.ready || !w) return null;
    return out.setFromMatrixPosition(w);
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }
}
