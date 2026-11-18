// Camera and microphone. Both are requested from the Start button BEFORE entering XR (the first camera prompt
// can end an immersive session on Quest). Camera: Quest exposes the passthrough cameras through getUserMedia as
// "camera 1, facing back" (left) and "camera 2, facing back" (right); we prefer camera 1.

export interface MediaState {
  video: HTMLVideoElement | null;
  videoStream: MediaStream | null;
  micStream: MediaStream | null;
  cameraLabel: string;
  cameraError: string;
  micError: string;
  forceSamples: boolean;
}

export const media: MediaState = {
  video: null,
  videoStream: null,
  micStream: null,
  cameraLabel: '',
  cameraError: '',
  micError: '',
  forceSamples: false,
};

export function pickCamera(devices: { deviceId: string; label: string }[]): { deviceId: string; label: string } | null {
  if (!devices.length) return null;
  const by = (re: RegExp) => devices.find((d) => re.test(d.label));
  return by(/camera 1.*facing back/i) ?? by(/facing back|back|rear|environment/i) ?? by(/left/i) ?? devices[0];
}

export async function requestMedia(opts: { camera: boolean; mic: boolean }): Promise<void> {
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) {
    media.cameraError = media.micError = 'media devices unavailable';
    return;
  }
  if (opts.mic) {
    try {
      media.micStream = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    } catch (e) {
      media.micError = (e as Error).name || String(e);
    }
  }
  if (opts.camera && !media.forceSamples) {
    try {
      // First a generic request so device labels become visible, then the preferred camera.
      const probe = await md.getUserMedia({ video: true });
      const devices = (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const chosen = pickCamera(devices);
      const probeLabel = probe.getVideoTracks()[0]?.label ?? '';
      let stream = probe;
      if (chosen && chosen.label !== probeLabel) {
        probe.getTracks().forEach((t) => t.stop());
        stream = await md.getUserMedia({
          video: { deviceId: { exact: chosen.deviceId }, width: { ideal: 1280 }, height: { ideal: 960 } },
        });
      }
      media.videoStream = stream;
      media.cameraLabel = stream.getVideoTracks()[0]?.label ?? chosen?.label ?? '';
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
      v.srcObject = stream;
      v.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;left:0;top:0';
      document.body.appendChild(v);
      await v.play().catch(() => {});
      media.video = v;
    } catch (e) {
      media.cameraError = (e as Error).name || String(e);
    }
  }
}

function cameraReady(): boolean {
  const v = media.video;
  const track = media.videoStream?.getVideoTracks()[0];
  return !!v && !!track && track.readyState === 'live' && v.readyState >= 2 && v.videoWidth > 0;
}

async function canvasToJpeg(c: HTMLCanvasElement, quality: number): Promise<string> {
  const blob: Blob | null = await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
  if (!blob) return c.toDataURL('image/jpeg', quality).split(',')[1] ?? '';
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

function drawScaled(src: CanvasImageSource, w: number, h: number, max = 1024): HTMLCanvasElement {
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export const SAMPLES: Record<string, string> = { fridge: 'samples/fridge.jpg', pan: 'samples/pan.jpg' };

export function chooseSample(prompt = '', explicit?: unknown): string {
  if (typeof explicit === 'string' && SAMPLES[explicit]) return explicit;
  return /pan|stove|cook(ing|ed)?\b|brown|done|fry|skillet|sear|onion/i.test(prompt) && !/fridge|ingredient/i.test(prompt) ? 'pan' : 'fridge';
}

const imgCache = new Map<string, HTMLImageElement>();
async function loadImage(url: string): Promise<HTMLImageElement> {
  const hit = imgCache.get(url);
  if (hit) return hit;
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  imgCache.set(url, img);
  return img;
}

let lastFrame: { at: number; result: Record<string, unknown> } | null = null;

/** look(): one JPEG (max 1024 px, q 0.75) from the camera, or a bundled sample frame. */
export async function look(prompt = '', args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const now = performance.now();
  const wantSample = media.forceSamples || typeof args.sample === 'string';
  if (!wantSample && cameraReady()) {
    if (lastFrame && now - lastFrame.at < 2000 && lastFrame.result.sample === false) return lastFrame.result;
    const v = media.video!;
    const c = drawScaled(v, v.videoWidth, v.videoHeight);
    const result = {
      image_b64: await canvasToJpeg(c, 0.75),
      mime: 'image/jpeg',
      width: c.width,
      height: c.height,
      sample: false,
      source: media.cameraLabel || 'camera',
    };
    lastFrame = { at: now, result };
    return result;
  }
  const name = chooseSample(prompt, args.sample);
  const img = await loadImage(`${import.meta.env.BASE_URL ?? './'}${SAMPLES[name]}`);
  const c = drawScaled(img, img.naturalWidth, img.naturalHeight);
  return {
    image_b64: await canvasToJpeg(c, 0.75),
    mime: 'image/jpeg',
    width: c.width,
    height: c.height,
    sample: true,
    sample_name: name,
    source: media.forceSamples ? 'sample (forced)' : `sample (camera unavailable${media.cameraError ? ': ' + media.cameraError : ''})`,
  };
}
