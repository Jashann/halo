// Recording harness for the Halo demo video. Opens the Halo web app (served by the real local server) in the
// IWER emulator at 1920x1080, and takes commands over HTTP (localhost:8899) so takes can be directed step by
// step: smooth head moves, emulated hand moves and pinches, the user's spoken line, waiting for the agent.
// Each clip is captured with CDP screencast frames (JPEG), then assembled with ffmpeg at a constant 30 fps,
// with a JSON of timestamped key moments (agent say text, tool calls, user actions).
//
// Usage: node rec-server.mjs [appUrl]   then   curl -s localhost:8899 -d '{"op":"...", ...}'
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../tests/web/node_modules/playwright/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIPS = path.resolve(here, '../clips');
const APP = process.argv[2] || 'http://localhost:8787/?demo=1&user=video';
fs.mkdirSync(CLIPS, { recursive: true });

const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.join(here, 'media', process.env.CAMERA || 'fridge.y4m')}`, '--ignore-gpu-blocklist', '--force-device-scale-factor=1'],
});
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(e.message));

let clip = null; // { name, dir, t0, frames: [{file, ts}], events: [] }
const now = () => Date.now() / 1000;
const mark = (kind, data = {}) => {
  if (!clip) return;
  clip.events.push({ t: +(now() - clip.t0).toFixed(2), kind, ...data });
};

// messages to and from the server, polled from the page
await page.exposeFunction('__recMsg', (dir, m) => {
  if (!clip) return;
  if (dir === 'in') {
    if (m.type === 'say') mark('agent_say', { text: m.text });
    else if (m.type === 'tool_call') mark('tool_call', { name: m.name, args: m.args });
    else if (m.type === 'status') mark('status', { text: m.text });
    else if (m.type === 'heard') mark('heard', { text: m.text });
  } else if (dir === 'sound') {
    mark('sound', { name: m.name });
  } else if (m.type === 'tool_result') mark('tool_result', { ok: m.ok, keys: m.result && typeof m.result === 'object' ? Object.keys(m.result).slice(0, 8) : [] });
  else if (m.type === 'event') mark('event', { name: m.name, data: m.data });
  else if (m.type === 'say') mark('user_say', { text: m.text });
});
await page.addInitScript(() => {
  let inN = 0;
  let outN = 0;
  let sN = 0;
  setInterval(() => {
    const a = window.__aide?.app;
    if (!a) return;
    const snd = window.__halo_sounds ?? [];
    while (sN < snd.length) window.__recMsg('sound', snd[sN++]);
    const rec = a.received;
    while (inN < rec.length) window.__recMsg('in', rec[inN++]);
    if (rec.length < inN) inN = rec.length; // ring buffer trimmed
    const sent = a.client?.sent ?? [];
    while (outN < sent.length) {
      const m = sent[outN++];
      window.__recMsg('out', m.type === 'tool_result' ? { type: m.type, ok: m.ok, result: m.result && { ...m.result, image_b64: undefined } } : m);
    }
    if (sent.length < outN) outN = sent.length;
  }, 80);
});

cdp.on('Page.screencastFrame', async (f) => {
  try {
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId });
  } catch {
    /* page closing */
  }
  if (!clip) return;
  const i = clip.frames.length;
  const file = path.join(clip.dir, `f${String(i).padStart(6, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
  clip.frames.push({ file, ts: f.metadata.timestamp ?? now() });
});

async function startClip(name) {
  const dir = path.join(CLIPS, `.frames_${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  clip = { name, dir, t0: now(), frames: [], events: [] };
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  return { started: name };
}

async function stopClip() {
  if (!clip) return { error: 'no clip' };
  await cdp.send('Page.stopScreencast');
  const c = clip;
  clip = null;
  const frames = c.frames;
  if (frames.length < 2) return { error: 'no frames' };
  // concat list with real per-frame durations, then resample to constant 30 fps
  const list = path.join(c.dir, 'list.txt');
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const d = i + 1 < frames.length ? Math.max(0.001, frames[i + 1].ts - frames[i].ts) : 1 / 30;
    lines.push(`file '${frames[i].file}'`, `duration ${d.toFixed(4)}`);
  }
  lines.push(`file '${frames[frames.length - 1].file}'`);
  fs.writeFileSync(list, lines.join('\n'));
  const out = path.join(CLIPS, `${c.name}.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-movflags', '+faststart', out]);
  // align event times to the first frame
  const offset = frames[0].ts - c.t0;
  const events = c.events.map((e) => ({ ...e, t: +(e.t - offset).toFixed(2) })).filter((e) => e.t >= -0.5);
  const duration = +(frames[frames.length - 1].ts - frames[0].ts).toFixed(2);
  const fpsCaptured = +((frames.length - 1) / duration).toFixed(1);
  fs.writeFileSync(path.join(CLIPS, `${c.name}.json`), JSON.stringify({ clip: `${c.name}.mp4`, duration_s: duration, captured_fps: fpsCaptured, output_fps: 30, resolution: '1920x1080', events }, null, 2));
  fs.rmSync(c.dir, { recursive: true, force: true });
  return { out, duration, frames: frames.length, fpsCaptured, events: events.length };
}

// ---- director helpers (run in the page through IWER's remote control) ----
const deg = (r) => (r * 180) / Math.PI;
function orientTo(pos, target) {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const dz = target.z - pos.z;
  return { pitch: deg(Math.atan2(dy, Math.hypot(dx, dz))), yaw: deg(Math.atan2(-dx, -dz)), roll: 0 };
}
const remote = (method, params) => page.evaluate(([m, p]) => window.IWER_DEVICE.remote.dispatch(m, p), [method, params]);

const ops = {
  async open(a = {}) {
    await page.goto(a.url || APP);
    await page.waitForFunction(() => !!window.__aide && !!window.IWER_DEVICE, null, { timeout: 30000 });
    await page.evaluate((f) => {
      window.IWER_DEVICE.primaryInputMode = 'hand';
      window.IWER_DEVICE.fovy = f; // about 77 degrees vertical, ~110 horizontal at 16:9: Quest 3's horizontal field of view
    }, a.fovy ?? 1.35);
    return { ok: true };
  },
  startClip: (a) => startClip(a.name),
  stopClip: () => stopClip(),
  mark: (a) => (mark(a.kind || 'note', a.data || {}), { ok: true }),
  async clickStart() {
    mark('user_action', { action: 'press Start' });
    await page.click('#start-btn');
    await page.waitForFunction(() => !!window.__aide.world.session, null, { timeout: 20000 });
    return { ok: true };
  },
  async head(a) {
    const o = orientTo(a.pos, a.target);
    if (!a.dur) {
      await remote('set_transform', { device: 'headset', position: a.pos, orientation: o });
      return o;
    }
    return remote('animate_to', { device: 'headset', position: a.pos, orientation: o, duration: a.dur, easing: 'minimum-jerk' });
  },
  async hand(a) {
    const p = { device: `hand-${a.side || 'right'}`, position: a.pos, anchor: a.anchor || 'index-tip' };
    if (a.orientation) p.orientation = a.orientation;
    if (!a.dur) return remote('set_transform', p);
    return remote('animate_to', { ...p, duration: a.dur, easing: 'minimum-jerk' });
  },
  async pinch(a) {
    mark('user_action', { action: `${a.value > 0.5 ? 'pinch' : 'release'} ${a.side || 'right'}` });
    return remote('set_select_value', { device: `hand-${a.side || 'right'}`, value: a.value, duration: a.dur ?? 0.15 });
  },
  async say(a) {
    mark('user_action', { action: 'says', text: a.text });
    await page.evaluate((t) => window.__halo_demo_say(t), a.text);
    return { ok: true };
  },
  async waitIdle(a) {
    // wait until the agent finished a turn: an empty status after `since` received messages
    const since = a.since ?? 0;
    await page.waitForFunction(
      (s) => {
        const r = window.__aide.app.received.slice(s);
        return r.some((m) => m.type === 'status' && m.text === '') && r.some((m) => m.type === 'say' || m.type === 'tool_call');
      },
      since,
      { timeout: (a.timeout ?? 120) * 1000, polling: 200 },
    );
    return { ok: true };
  },
  received: () => page.evaluate(() => window.__aide.app.received.length),
  wait: (a) => new Promise((r) => setTimeout(() => r({ ok: true }), (a.s ?? 1) * 1000)),
  async eval(a) {
    return page.evaluate(a.js);
  },
  async shot(a) {
    await page.screenshot({ path: a.path });
    return { path: a.path };
  },
  errors: () => consoleErrors.slice(-20),
  async quit() {
    setTimeout(() => browser.close().then(() => process.exit(0)), 100);
    return { bye: true };
  },
};

http
  .createServer(async (req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      try {
        const a = JSON.parse(body || '{}');
        const fn = ops[a.op];
        if (!fn) throw new Error(`unknown op ${a.op}`);
        const r = await fn(a);
        res.end(JSON.stringify(r ?? { ok: true }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      }
    });
  })
  .listen(8899, '127.0.0.1', () => console.log('rec-server on 127.0.0.1:8899, app', APP));
