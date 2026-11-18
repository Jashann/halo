import { media } from './media.js';

// Push-to-talk recorder: MediaRecorder on the mic stream opened at Start. Sends webm/opus (the server remuxes
// it for the transcription model). Clips shorter than 0.35 s are dropped as accidental taps.

export class VoiceRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  recording = false;

  constructor(private onClip: (mime: string, b64: string, seconds: number) => void) {}

  get available() {
    return !!media.micStream && typeof MediaRecorder !== 'undefined';
  }

  static pickMime(): string {
    const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (const m of prefs) {
      try {
        if (MediaRecorder.isTypeSupported(m)) return m;
      } catch {
        /* ignore */
      }
    }
    return '';
  }

  start(): boolean {
    if (this.recording || !this.available) return false;
    const mime = VoiceRecorder.pickMime();
    try {
      this.rec = mime ? new MediaRecorder(media.micStream!, { mimeType: mime }) : new MediaRecorder(media.micStream!);
    } catch (e) {
      console.warn('[halo] MediaRecorder failed', e);
      return false;
    }
    this.chunks = [];
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.rec.onstop = async () => {
      const secs = (performance.now() - this.startedAt) / 1000;
      const type = this.rec?.mimeType || mime || 'audio/webm';
      const blob = new Blob(this.chunks, { type });
      this.chunks = [];
      if (secs < 0.35 || blob.size < 800) return;
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      this.onClip(type.split(';')[0], btoa(bin), secs);
    };
    this.startedAt = performance.now();
    this.rec.start(250);
    this.recording = true;
    return true;
  }

  stop() {
    if (!this.recording) return;
    this.recording = false;
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
  }
}
