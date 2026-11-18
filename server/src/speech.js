// Speech to text with Meta Muse Voice Transcribe.
//
// Endpoint (found by probing on 2026-11-16; /v1/audio/transcriptions returns 404 on api.meta.ai):
//   POST {base}/asr/transcribe, multipart/form-data with two parts:
//     request: JSON {"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV"|"OGG_OPUS"}
//     audio:   the audio file
//   200 -> {"sessionId", "transcript", "audioDurationMs", "turns": []}
// Accepted encodings seen working: WAV (16-bit PCM) and OGG_OPUS. WebM/Opus (what Chromium MediaRecorder makes)
// is rejected, so it is remuxed to Ogg with ffmpeg when ffmpeg is installed (no re-encode, Opus is copied).
import { spawn } from 'node:child_process';
import { scrub } from './model.js';

export function encodingFor(mime = '') {
  const m = mime.toLowerCase();
  if (m.includes('wav') || m.includes('wave')) return 'WAV';
  if (m.includes('ogg')) return 'OGG_OPUS';
  if (m.includes('webm')) return 'WEBM';
  return null;
}

export function remuxWebmToOgg(buf, { ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn(ffmpeg, ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'copy', '-f', 'ogg', 'pipe:1']);
    } catch (e) {
      return reject(e);
    }
    const out = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg unavailable: ${e.message}`));
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.length) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg remux failed (${code}): ${err.slice(0, 200)}`));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
  });
}

export class Transcriber {
  constructor({ baseUrl, apiKey, model = 'muse-voice-transcribe-1.0', fetchImpl = globalThis.fetch, timeoutMs = 30000, remux = remuxWebmToOgg }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.remux = remux;
  }

  async transcribe({ mime, b64 }) {
    if (!this.apiKey) throw new Error('No API key configured');
    let audio = Buffer.from(b64 || '', 'base64');
    if (!audio.length) throw new Error('Empty audio');
    let encoding = encodingFor(mime);
    if (!encoding) throw new Error(`Unsupported audio type ${mime}; send audio/wav or audio/ogg`);
    if (encoding === 'WEBM') {
      audio = await this.remux(audio);
      encoding = 'OGG_OPUS';
    }
    const form = new FormData();
    form.append('request', new Blob([JSON.stringify({ model: this.model, audioEncoding: encoding })], { type: 'application/json' }));
    form.append('audio', new Blob([audio], { type: encoding === 'WAV' ? 'audio/wav' : 'audio/ogg' }), encoding === 'WAV' ? 'speech.wav' : 'speech.ogg');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const t0 = Date.now();
    try {
      const res = await this.fetch(`${this.baseUrl}/asr/transcribe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Transcribe HTTP ${res.status}: ${scrub(text, this.apiKey).slice(0, 300)}`);
      const json = JSON.parse(text);
      return { text: (json.transcript || '').trim(), durationMs: json.audioDurationMs, latencyMs: Date.now() - t0 };
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Transcribe timed out');
      throw new Error(scrub(e.message, this.apiKey));
    } finally {
      clearTimeout(timer);
    }
  }
}
