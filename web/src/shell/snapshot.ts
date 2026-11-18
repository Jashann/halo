import * as THREE from 'three';
import type { World } from '@iwsdk/core';
import { media } from './media.js';

// Mixed-reality snapshot for look(view): renders Halo's own scene offscreen (only when asked, never per frame)
// from the user's head pose, roughly matched to the left passthrough camera, and composites it over the camera
// frame. Also used for a "virtual" view (Halo's objects alone over a dark background).

const W = 1024;
const H = 768;
// Quest 3 left passthrough camera relative to the head centre (metres, head frame) and its field of view.
// Approximate on purpose: exact alignment is not needed to see what is where.
const CAM_OFFSET = new THREE.Vector3(-0.032, -0.018, -0.02);
const CAM_HFOV = 80; // degrees
const VFOV = (2 * Math.atan(Math.tan(((CAM_HFOV / 2) * Math.PI) / 180) * (H / W)) * 180) / Math.PI;

let rt: THREE.WebGLRenderTarget | null = null;
const snapCam = new THREE.PerspectiveCamera(VFOV, W / H, 0.02, 60);

function nextFrame(world: World): Promise<void> {
  // inside an XR session, render from the frame callback (between the systems and the main render)
  return new Promise((resolve) => {
    if (!world.session) return resolve();
    const off = world.onXRFrame(() => {
      off();
      resolve();
    });
  });
}

/** Render Halo's scene from the head (camera-matched) into RGBA pixels, top row first. */
async function renderVirtual(world: World): Promise<ImageData> {
  await nextFrame(world);
  const renderer = world.renderer;
  rt ??= new THREE.WebGLRenderTarget(W, H, { samples: 4 });
  const head = world.camera;
  head.updateMatrixWorld(true);
  snapCam.position.copy(CAM_OFFSET).applyMatrix4(head.matrixWorld);
  snapCam.quaternion.copy(head.getWorldQuaternion(new THREE.Quaternion()));
  snapCam.updateMatrixWorld(true);
  const xrWas = renderer.xr.enabled;
  const prevTarget = renderer.getRenderTarget();
  const prevColor = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const bg = world.scene.background;
  renderer.xr.enabled = false;
  world.scene.background = null;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(world.scene, snapCam);
  const px = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevColor, prevAlpha);
  world.scene.background = bg;
  renderer.xr.enabled = xrWas;
  // WebGL rows are bottom-up
  const img = new ImageData(W, H);
  const row = W * 4;
  for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * row, (H - y) * row), y * row);
  return img;
}

function cameraReady() {
  const v = media.video;
  return !!v && !media.forceSamples && v.readyState >= 2 && v.videoWidth > 0 && media.videoStream?.getVideoTracks()[0]?.readyState === 'live';
}

async function toJpegB64(c: HTMLCanvasElement): Promise<string> {
  const blob: Blob | null = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.8));
  if (!blob) return c.toDataURL('image/jpeg', 0.8).split(',')[1] ?? '';
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function cameraAvailable() {
  return cameraReady();
}

/** view "virtual": Halo's objects over a dark background; "mixed": over the camera frame (dark if no camera). */
export async function snapshot(world: World, view: 'mixed' | 'virtual'): Promise<Record<string, unknown>> {
  const img = await renderVirtual(world);
  const layer = document.createElement('canvas');
  layer.width = W;
  layer.height = H;
  layer.getContext('2d')!.putImageData(img, 0, 0);
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d')!;
  const withCamera = view === 'mixed' && cameraReady();
  if (withCamera) {
    const v = media.video!;
    // fit the camera frame to 4:3 (crop the long side)
    const ar = v.videoWidth / v.videoHeight;
    let sw = v.videoWidth;
    let sh = v.videoHeight;
    if (ar > W / H) sw = sh * (W / H);
    else sh = sw / (W / H);
    ctx.drawImage(v, (v.videoWidth - sw) / 2, (v.videoHeight - sh) / 2, sw, sh, 0, 0, W, H);
  } else {
    ctx.fillStyle = '#16191d';
    ctx.fillRect(0, 0, W, H);
  }
  ctx.drawImage(layer, 0, 0);
  return {
    image_b64: await toJpegB64(out),
    mime: 'image/jpeg',
    width: W,
    height: H,
    view,
    sample: false,
    source: withCamera ? `mixed: Halo's objects over ${media.cameraLabel || 'camera'} (approximate alignment)` : `virtual: Halo's objects over a dark background${view === 'mixed' ? ' (camera unavailable)' : ''}`,
  };
}

/** Compact list of what Halo has placed, relative to the user's head: right(+)/left(-), up(+)/down(-), forward distance. */
export function sceneSummary(world: World, items: { id: string; kind: string; obj: THREE.Object3D; note?: string }[]) {
  const head = world.camera;
  head.updateMatrixWorld(true);
  const inv = head.matrixWorld.clone().invert();
  const v = new THREE.Vector3();
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return items
    .filter((i) => i.obj.parent && i.obj.visible)
    .map((i) => {
      i.obj.getWorldPosition(v).applyMatrix4(inv);
      return { id: i.id, kind: i.kind, right: r2(v.x), up: r2(v.y), forward: r2(-v.z), distance: r2(v.length()), ...(i.note ? { note: i.note } : {}) };
    });
}
