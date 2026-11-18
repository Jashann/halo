// Small synthesized sounds (no audio files): soft UI ticks, a chime for timers, a pop for spawns.
// Everything is quiet by design. Safe to call in Node (no AudioContext -> no-op).

type Ctx = AudioContext;
let ctx: Ctx | null = null;
let master: GainNode | null = null;

function ac(): Ctx | null {
  if (ctx) return ctx;
  const AC = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC() as Ctx;
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Call from a user gesture (the Start button) so the context may start. */
export function unlockAudio(): void {
  const c = ac();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

function tone(freq: number, start: number, dur: number, type: OscillatorType, gain: number, glideTo?: number) {
  const c = ac();
  if (!c || !master) return;
  const t0 = c.currentTime + start;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

export const sound = {
  // Halo's sound palette: soft sine bells in one key (A major), short and quiet.
  tick() {
    tone(1760, 0, 0.05, 'sine', 0.06);
  },
  press() {
    // confirm: two quick rising notes
    tone(880, 0, 0.09, 'sine', 0.14);
    tone(1318.5, 0.06, 0.12, 'sine', 0.1);
  },
  appear() {
    // a soft shimmer: a gliding fifth
    tone(659.25, 0, 0.22, 'sine', 0.07, 987.77);
    tone(1318.5, 0.05, 0.25, 'sine', 0.035);
  },
  dismiss() {
    tone(987.77, 0, 0.16, 'sine', 0.05, 659.25);
  },
  pop() {
    tone(440, 0, 0.12, 'sine', 0.12, 1320);
  },
  listenStart() {
    tone(880, 0, 0.08, 'sine', 0.12);
    tone(1108.73, 0.07, 0.1, 'sine', 0.11);
  },
  listenStop() {
    tone(1108.73, 0, 0.08, 'sine', 0.1);
    tone(880, 0.07, 0.1, 'sine', 0.09);
  },
  chime() {
    // timer done: a three-note bell arpeggio, twice, with a soft overtone
    [0, 1.1].forEach((o) => {
      tone(880, o, 1.0, 'sine', 0.2);
      tone(1108.73, o + 0.16, 1.0, 'sine', 0.16);
      tone(1318.5, o + 0.32, 1.3, 'sine', 0.14);
      tone(2637, o + 0.32, 0.6, 'sine', 0.025);
    });
  },
  score() {
    tone(880, 0, 0.12, 'triangle', 0.14);
    tone(1108.73, 0.09, 0.12, 'triangle', 0.14);
    tone(1760, 0.18, 0.3, 'sine', 0.12);
  },
  error() {
    tone(330, 0, 0.18, 'sine', 0.08, 247);
  },
  /** Play server TTS audio if it arrives (optional in the protocol). */
  async playB64(b64: string, mime = 'audio/mpeg'): Promise<number> {
    const c = ac();
    if (!c || !master) return 0;
    try {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const audio = await c.decodeAudioData(buf.buffer);
      const src = c.createBufferSource();
      src.buffer = audio;
      const g = c.createGain();
      g.gain.value = 2.4; // master is quiet; speech should be clear
      src.connect(g).connect(master);
      src.start();
      void mime;
      return audio.duration;
    } catch {
      return 0;
    }
  },
};

// Sound cue log (for adding the sounds in a video edit: browser captures have no audio).
export const soundLog: { name: string; t: number }[] = [];
for (const k of Object.keys(sound) as (keyof typeof sound)[]) {
  const fn = sound[k] as (...a: unknown[]) => unknown;
  if (k === 'playB64') continue;
  (sound as Record<string, unknown>)[k] = (...a: unknown[]) => {
    soundLog.push({ name: k, t: typeof performance !== 'undefined' ? performance.now() / 1000 : 0 });
    if (soundLog.length > 500) soundLog.shift();
    return fn(...a);
  };
}
