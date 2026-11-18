import { World, SessionMode, ReferenceSpaceType } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { AideApp, AideSystem } from './app.js';
import { media, requestMedia } from './shell/media.js';
import { soundLog, unlockAudio } from './ui/sound.js';

// Entry: one big Start button asks for camera + microphone (before XR, as Quest requires), then enters
// immersive-ar with hands, planes, meshes, hit test, anchors and local-floor. On desktop the IWSDK dev server
// injects IWER (the emulator, with hands and sample rooms).

const params = new URLSearchParams(location.search);
// ?demo=1: recording mode for the video: no debug UI, emulator controls hidden after Start, a small honest note
// that this is the emulator. The camera path is the normal one (the recorder feeds Chromium a fake camera).
const demo = params.get('demo') === '1';
media.forceSamples = params.has('samples') || params.get('camera') === 'sample';
if (demo) document.body.classList.add('demo');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const startEl = $('start');
const startBtn = $<HTMLButtonElement>('start-btn');
const note = $('start-note');

const world = await World.create($('scene-container') as HTMLDivElement, projectOptions);
world.registerSystem(AideSystem);
const app = new AideApp(world);
(window as any).__aide = { app, world, media };
(window as any).__halo = (window as any).__aide;
(window as any).__halo_sounds = soundLog; // sound cue log for video edits

const isEmulated = !!(window as any).IWER_DEVICE;
const showDock = !demo && (isEmulated || params.has('debug') || !navigator.xr);

function setupDock() {
  const dock = $('dock');
  dock.style.display = 'flex';
  const input = $<HTMLInputElement>('say-input');
  const send = () => {
    app.say(input.value);
    input.value = '';
  };
  $('say-send').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep IWER keyboard controls from eating typing
    if (e.key === 'Enter') send();
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
  const talk = $('talk-btn');
  talk.addEventListener('pointerdown', () => app.setTalking(true));
  talk.addEventListener('pointerup', () => app.setTalking(false));
  talk.addEventListener('pointerleave', () => app.setTalking(false));
  const hud = $('hud');
  hud.style.display = 'block';
  setInterval(() => {
    const s = app.client?.state ?? 'not connected';
    hud.textContent = `${Math.round(app.fps)} fps | server ${s} | camera ${media.videoStream && !media.forceSamples ? 'on' : 'sample'} | mic ${media.micStream ? 'on' : 'off'} | surfaces ${app.surfaces().length}`;
  }, 500);
}

async function start() {
  startBtn.disabled = true;
  unlockAudio();
  note.textContent = 'Asking for camera and microphone...';
  await requestMedia({ camera: true, mic: true });
  const bits = [];
  bits.push(media.videoStream ? `camera: ${media.cameraLabel || 'on'}` : media.forceSamples ? 'camera: sample photos' : `camera: off (${media.cameraError || 'denied'}), using sample photos`);
  bits.push(media.micStream ? 'mic: on' : `mic: off (${media.micError || 'denied'}), suggestions only`);
  note.textContent = bits.join(' | ');
  const xrOk = !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar').catch(() => false));
  if (xrOk) {
    world.launchXR({
      sessionMode: SessionMode.ImmersiveAR,
      referenceSpace: { type: ReferenceSpaceType.LocalFloor, fallbackOrder: [ReferenceSpaceType.Local, ReferenceSpaceType.Viewer] },
      features: { handTracking: true, planeDetection: true, meshDetection: true, hitTest: true, anchors: true },
    });
    const t0 = performance.now();
    while (!world.session && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));
    if (!world.session) {
      note.textContent = 'Could not open mixed reality. Check the browser permissions, then press Start again.';
      startBtn.disabled = false;
      return;
    }
    startEl.style.display = 'none';
    document.body.classList.add('in-xr');
    world.session.addEventListener('end', () => {
      document.body.classList.remove('in-xr');
      startEl.style.display = 'flex';
      startBtn.disabled = false;
      startBtn.textContent = 'Resume';
      note.textContent = '';
    });
  } else {
    // flat fallback (no WebXR): still connect so the agent and panels can be tried with a mouse
    startEl.style.display = 'none';
    app.connect();
  }
  if (showDock) setupDock();
  if (demo) hideEmulatorControls();
}

/** Recording mode: hide IWER's control overlays (the emulated room and the app stay visible). */
function hideEmulatorControls() {
  const tryHide = () => {
    const d = [...document.body.children].find((e) => getComputedStyle(e).zIndex === '999') as HTMLElement | undefined;
    if (!d) return false;
    for (const i of [0, 1]) (d.children[i] as HTMLElement | undefined)?.style.setProperty('visibility', 'hidden');
    return true;
  };
  if (!tryHide()) setTimeout(tryHide, 500);
  (window as any).__halo_demo_say = (t: string) => app.say(t); // console helper for scripted takes
  // Demo-only: point the "camera" at another photo (e.g. the pan) by swapping the video source to a canvas
  // stream drawn from that image. Same capture path for look() afterwards.
  (window as any).__halo_set_camera = async (url: string) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 960;
    const ctx = c.getContext('2d')!;
    const k = Math.max(c.width / img.naturalWidth, c.height / img.naturalHeight);
    const draw = () => ctx.drawImage(img, (c.width - img.naturalWidth * k) / 2, (c.height - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
    draw();
    setInterval(draw, 500);
    const stream = c.captureStream(15);
    media.videoStream = stream;
    if (media.video) {
      media.video.srcObject = stream;
      await media.video.play().catch(() => {});
    }
    return true;
  };
}

startBtn.addEventListener('click', () => void start());
if (params.has('autostart')) void start();
