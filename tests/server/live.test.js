// Live smoke test against the Meta Model API. Off by default (costs money). Run with:
//   cd server && npm run test:live
// Writes tests/server/live_cooking_transcript.json (and live_codegen_golf.js when AIDE_LIVE_CODEGEN=1).
// The fridge photo is "Fruits and Vegetables in Refrigerator" (Wikimedia Commons, CC0), see fixtures/SOURCES.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHaloServer } from '../../server/src/server.js';
import { MemoryStore } from '../../server/src/memory.js';
import { validateCode } from '../../server/src/codegen.js';
import { FakeClient, tmpDir, tinyJpegB64 } from './helpers.js';

const LIVE = process.env.AIDE_LIVE === '1';
const here = path.dirname(new URL(import.meta.url).pathname);

const ROOM = {
  surfaces: [
    { id: 'counter-1', label: 'table', size: [1.4, 0.6], center: [0.0, 0.92, -0.55] },
    { id: 'stove-1', label: 'stove', size: [0.6, 0.6], center: [0.9, 0.92, -0.55] },
    { id: 'wall-1', label: 'wall', size: [3.0, 2.4], center: [0.0, 1.3, -0.9] },
  ],
};

test('live: cooking flow against Meta Model API', { skip: !LIVE, timeout: 300000 }, async () => {
  const logs = [];
  const app = createHaloServer(
    { port: 0, host: '127.0.0.1', dataDir: tmpDir('aide-live-mem-'), webDist: tmpDir('aide-live-web-'), greet: false, toolTimeoutMs: 5000 },
    { memory: undefined, log: (o) => logs.push({ t: Date.now(), ...o }), transcriber: undefined }
  );
  assert.ok(app.config.apiKey, 'needs META_API_KEY or ~/.meta_api_key');
  const addr = await app.listen(0, '127.0.0.1');
  const events = [];
  const t0 = Date.now();
  const c = new FakeClient(`ws://127.0.0.1:${addr.port}/`, {
    look: (args) => ({ ok: true, result: { image_b64: tinyJpegB64(), sample: true, sample_name: 'fridge', width: 1280, height: 1041 } }),
    room: () => ({ ok: true, result: { ...ROOM, hands: { left: 'tracked', right: 'tracked' } } }),
    '*': (args, msg) => ({ ok: true, result: { done: true, id: args.id || null } }),
  });
  await c.open();
  const origOn = c.onMessage.bind(c);
  c.onMessage = (msg) => {
    events.push({ ms: Date.now() - t0, ...summarize(msg) });
    return origOn(msg);
  };
  c.send({ type: 'hello', user: 'live-smoke', capabilities: { camera: false, mic: true, planes: true, meshes: false, hands: true }, room: ROOM });

  // optional live transcription of a synthetic voice clip (macOS `say`)
  let transcription = null;
  try {
    const wav = path.join(os.tmpdir(), 'aide-live-q.wav');
    execFileSync('say', ['-o', wav, '--data-format=LEI16@16000', 'What can I make for dinner with what is in my fridge?']);
    const before = c.messages.length;
    const ts = Date.now();
    c.send({ type: 'audio', mime: 'audio/wav', b64: fs.readFileSync(wav).toString('base64') });
    const heard = await c.waitFor((m, cl) => m.type === 'heard' && cl.messages.indexOf(m) >= before, 30000);
    transcription = { text: heard.text, ms: Date.now() - ts };
  } catch (e) {
    transcription = { error: e.message };
    c.send({ type: 'say', text: 'What can I make for dinner with what is in my fridge?' });
  }
  await c.waitIdle(180000);
  const turn1End = c.messages.length;

  c.send({ type: 'say', text: 'Sounds good. Show me how to cut the vegetables and set a timer for the pan.' });
  await c.waitIdle(180000, turn1End);
  c.close();

  const session = [...app.sessions][0];
  const trace = session ? session.trace : [];
  await app.close();

  const transcript = {
    when: new Date().toISOString(),
    agentModel: app.config.agentModel,
    image: 'fixtures/fridge.jpg (Wikimedia Commons, CC0), sent as a SAMPLE frame',
    transcription,
    turns: trace.filter((x) => x.kind === 'turn').map((x) => x.turn),
    wire: events,
    modelCalls: logs.filter((l) => l.role),
  };
  fs.writeFileSync(path.join(here, 'live_cooking_transcript.json'), JSON.stringify(transcript, null, 2));

  const tools = c.toolCalls.map((t) => t.name);
  console.log('tool calls:', tools.join(' -> '));
  console.log('says:', c.messages.filter((m) => m.type === 'say').map((m) => m.text));
  assert.ok(tools.includes('look'), 'agent looked at the fridge');
  assert.ok(tools.includes('show_panel'), 'agent showed a panel');
});

test('live: one Spark codegen call for the golf game', { skip: !(LIVE && process.env.AIDE_LIVE_CODEGEN === '1'), timeout: 200000 }, async () => {
  const { loadConfig } = await import('../../server/src/config.js');
  const { buildModelClient } = await import('../../server/src/model.js');
  const { CodeGenerator } = await import('../../server/src/codegen.js');
  const logs = [];
  const models = buildModelClient(loadConfig(), { log: (o) => logs.push(o) });
  const gen = new CodeGenerator({ models, log: (o) => logs.push(o) });
  const out = await gen.generate({
    brief:
      'Hands-only mini golf on the kitchen table: a ball and a cup 35 cm apart, pinch-pull-release to putt (slingshot), ' +
      'aim line while pulling, 3 holes with the cup moving each time, count strokes, burst and short line when sunk, ' +
      'reset if the ball leaves the table, aide.done with the total at the end.',
    surfaces: ROOM.surfaces,
  });
  fs.writeFileSync(path.join(here, 'live_codegen_golf.js'), `// generated by ${out.model} in ${out.latencyMs} ms, attempts ${out.attempts}, valid ${out.ok}\n${out.code}\n`);
  console.log('codegen', { ok: out.ok, attempts: out.attempts, ms: out.latencyMs, bytes: out.code.length, errors: out.errors, logs });
  assert.equal(validateCode(out.code).ok, out.ok);
});

function summarize(msg) {
  if (msg.type === 'tool_call') {
    const args = { ...msg.args };
    if (typeof args.js === 'string') args.js = `[${args.js.length} chars]`;
    return { dir: 'server->client', type: msg.type, name: msg.name, args };
  }
  return { dir: 'server->client', ...msg };
}
