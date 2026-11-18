import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateCode, extractCode, CodeGenerator } from '../../server/src/codegen.js';
import { OpenAICompatProvider, ModelClient, scrub } from '../../server/src/model.js';
import { Transcriber, encodingFor } from '../../server/src/speech.js';
import { MemoryStore, safeUserId } from '../../server/src/memory.js';
import { TOOLS } from '../../server/src/tools.js';
import { systemPrompt, codegenSystemPrompt } from '../../server/src/prompts.js';
import { MockModels, reply, tmpDir } from './helpers.js';

const md = fs.readFileSync(new URL('../../server/src/prompts/runtime_api.md', import.meta.url), 'utf8');
const examples = [...md.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);

// ---------- validator ----------
test('validator: all documented example programs pass', () => {
  assert.equal(examples.length, 3);
  for (const ex of examples) assert.deepEqual(validateCode(ex), { ok: true, errors: [] });
});

test('validator: forbidden tokens are rejected', () => {
  const bad = {
    'fetch("/x"); aide.say(1)': /fetch/,
    'new XMLHttpRequest(); aide.say(1)': /XMLHttpRequest/,
    'const s = new WebSocket("ws://x"); aide.say(1)': /WebSocket/,
    'eval("1"); aide.say(1)': /eval/,
    'document.body.innerHTML = ""; aide.say(1)': /document/,
    'window.foo = 1; aide.say(1)': /window/,
    'localStorage.setItem("a", 1); aide.say(1)': /localStorage/,
    'while (true) { aide.say(1) }': /while\(true\)/,
    'while (1) { aide.say(1) }': /while\(true\)/,
    'for (;;) { aide.say(1) }': /for\(;;\)/,
    'import("x"); aide.say(1)': /import\(\)/,
    'aide.say(1); globalThis.x = 1': /globalThis/,
    'aide.say(1); const F = Function; F("x")': /Function/,
    'aide.say(1); aide["constructor"]; ({}).constructor.constructor("x")()': /constructor/,
    'aide.say(1); setTimeout(() => {}, 5)': /setTimeout/,
    'aide.say(1); aide.THREE["eval"]': /eval/,
  };
  for (const [src, re] of Object.entries(bad)) {
    const r = validateCode(src);
    assert.equal(r.ok, false, src);
    assert.match(r.errors.join(' | '), re, src);
  }
});

test('validator: syntax errors, imports, empty, and no aide usage are rejected', () => {
  assert.match(validateCode('aide.say(').errors[0], /syntax error/);
  assert.match(validateCode('import x from "y"; aide.say(1)').errors[0], /syntax error/);
  assert.equal(validateCode('').ok, false);
  assert.match(validateCode('const a = 1;').errors.join(), /never uses the aide API/);
});

test('validator: harmless look-alikes are allowed', () => {
  const ok = [
    'const label = aide.spawn("label", { text: "document your score" }); aide.say("fetch the ball")',
    'const top = aide.surfaces[0]?.top ?? 0; aide.say(String(top))',
    'const o = { window: 1, fetch: 2 }; aide.say(String(o.window + o.fetch))',
    'let i = 0; while (i < 3) { i++; } aide.say("x")',
    'for (let i = 0; i < 3; i++) aide.say("x")',
  ];
  for (const src of ok) assert.deepEqual(validateCode(src), { ok: true, errors: [] }, src);
});

test('extractCode: fenced, javascript tag, unterminated, bare', () => {
  assert.equal(extractCode('hi\n```js\naide.say(1)\n```\nbye'), 'aide.say(1)');
  assert.equal(extractCode('```javascript\naide.say(2)\n```'), 'aide.say(2)');
  assert.equal(extractCode('```\naide.say(3)\n```'), 'aide.say(3)');
  assert.equal(extractCode('```js\naide.say(4)'), 'aide.say(4)');
  assert.equal(extractCode('aide.say(5)'), 'aide.say(5)');
});

test('CodeGenerator: repair once on invalid output; fix() includes the runtime error', async () => {
  const models = new MockModels({ codegen: [reply('```js\nwindow.x=1;aide.say(1)\n```'), reply('```js\naide.say("ok")\n```'), reply('```js\naide.say("fixed")\n```')] });
  const gen = new CodeGenerator({ models });
  const out = await gen.generate({ brief: 'say ok', surfaces: [] });
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
  assert.equal(out.code, 'aide.say("ok")');
  const fix = await gen.fix({ brief: 'say ok', code: out.code, error: 'ReferenceError: q' });
  assert.equal(fix.ok, true);
  assert.match(models.requests.codegen[2].messages[1].content, /ReferenceError: q/);
  assert.match(models.requests.codegen[0].messages[0].content, /aide\.physics\.add/);
});

// ---------- model client ----------
function fakeFetch(responses, calls = []) {
  return async (url, opts) => {
    calls.push({ url, opts });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    if (r === 'hang')
      return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    return { ok: r.status < 400, status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
}
const okBody = (content, tool_calls) => ({ status: 200, body: { model: 'm', choices: [{ finish_reason: 'stop', message: { content, tool_calls } }] } });

test('provider: parses tool calls, sends auth + body fields', async () => {
  const calls = [];
  const p = new OpenAICompatProvider({ baseUrl: 'https://api.example/v1/', apiKey: 'sk-secret-123456', fetchImpl: fakeFetch([okBody('hi', [{ id: 'c1', type: 'function', function: { name: 'look', arguments: '{}' } }])], calls) });
  const out = await p.chat({ model: 'muse-spark-1.3', messages: [{ role: 'user', content: 'x' }], tools: TOOLS, maxTokens: 2000, reasoningEffort: 'low' });
  assert.equal(out.content, 'hi');
  assert.deepEqual(out.toolCalls, [{ id: 'c1', name: 'look', arguments: '{}' }]);
  assert.equal(calls[0].url, 'https://api.example/v1/chat/completions');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer sk-secret-123456');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.max_tokens, 2000);
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.tools.length, TOOLS.length);
});

test('provider: retries 5xx/429/network, not 4xx; errors never contain the key', async () => {
  const key = 'sk-secret-abcdefgh';
  const p = new OpenAICompatProvider({ baseUrl: 'https://a/v1', apiKey: key, backoffMs: 1, retries: 2, fetchImpl: fakeFetch([{ status: 500, body: 'oops' }, { status: 429, body: 'slow' }, okBody('done')]) });
  assert.equal((await p.chat({ model: 'm', messages: [] })).content, 'done');

  const calls = [];
  const p2 = new OpenAICompatProvider({ baseUrl: 'https://a/v1', apiKey: key, backoffMs: 1, fetchImpl: fakeFetch([{ status: 400, body: `bad key ${key}` }, okBody('never')], calls) });
  await assert.rejects(p2.chat({ model: 'm', messages: [] }), (e) => e.status === 400 && !e.message.includes(key) && e.message.includes('[redacted]'));
  assert.equal(calls.length, 1);

  const p3 = new OpenAICompatProvider({ baseUrl: 'https://a/v1', apiKey: key, backoffMs: 1, retries: 1, fetchImpl: fakeFetch([new Error('ECONNRESET'), 'hang']) });
  await assert.rejects(p3.chat({ model: 'm', messages: [], timeoutMs: 30 }), /Timed out/);
  assert.equal(scrub(`Authorization: Bearer ${key}`, key), 'Authorization: Bearer [redacted]');
});

test('ModelClient: falls through the chain to the fallback model', async () => {
  const failing = { chat: async () => { throw new Error('down'); } };
  const working = { chat: async (req) => ({ content: req.model, toolCalls: [], latencyMs: 1 }) };
  const mc = new ModelClient({ agent: [{ provider: failing, model: 'a' }, { provider: working, model: 'b' }] });
  assert.equal((await mc.call('agent', { messages: [] })).content, 'b');
  await assert.rejects(new ModelClient({ agent: [] }).call('agent', {}), /No model configured/);
});

// ---------- speech ----------
test('speech: encoding mapping and multipart request shape', async () => {
  assert.equal(encodingFor('audio/wav'), 'WAV');
  assert.equal(encodingFor('audio/ogg;codecs=opus'), 'OGG_OPUS');
  assert.equal(encodingFor('audio/webm;codecs=opus'), 'WEBM');
  assert.equal(encodingFor('audio/mp4'), null);
  let seen;
  const t = new Transcriber({
    baseUrl: 'https://api.meta.ai/v1',
    apiKey: 'k-123456789',
    fetchImpl: async (url, opts) => {
      seen = { url, opts };
      return { ok: true, status: 200, text: async () => JSON.stringify({ transcript: ' hello there ', audioDurationMs: 900 }) };
    },
    remux: async (buf) => Buffer.concat([Buffer.from('OggS'), buf]),
  });
  const out = await t.transcribe({ mime: 'audio/webm;codecs=opus', b64: Buffer.from('abc').toString('base64') });
  assert.equal(out.text, 'hello there');
  assert.equal(seen.url, 'https://api.meta.ai/v1/asr/transcribe');
  const req = JSON.parse(await seen.opts.body.get('request').text());
  assert.deepEqual(req, { model: 'muse-voice-transcribe-1.0', audioEncoding: 'OGG_OPUS' });
  assert.equal((await seen.opts.body.get('audio').arrayBuffer()).byteLength, 7);
  await assert.rejects(t.transcribe({ mime: 'audio/mp4', b64: 'AAAA' }), /Unsupported audio/);
});

// ---------- memory ----------
test('memory: remember/recall persist to disk; summary; ids sanitised', () => {
  const dir = tmpDir();
  const m = new MemoryStore(dir);
  m.remember('Jashan!', 'favourite_game', 'table golf');
  m.remember('Jashan!', 'diet', 'no peanuts');
  m.addHistory('Jashan!', 'cooked an omelette');
  const m2 = new MemoryStore(dir);
  assert.equal(m2.recall('Jashan!', 'favourite_game').value, 'table golf');
  assert.equal(m2.recall('Jashan!', 'favorite_game').value, 'table golf');
  assert.equal(m2.recall('Jashan!', 'shoe size').value, null);
  assert.deepEqual(m2.recall('Jashan!').prefs, { favourite_game: 'table golf', diet: 'no peanuts' });
  assert.match(m2.summary('Jashan!'), /no peanuts/);
  assert.match(m2.summary('Jashan!'), /omelette/);
  assert.equal(safeUserId('../../etc/passwd'), '______etc_passwd');
  assert.match(m2.summary('new-person'), /first visit/);
});

// ---------- prompts / schema ----------
test('tool schema covers every architecture tool; prompts carry the key rules', () => {
  const names = TOOLS.map((t) => t.function.name).sort();
  assert.deepEqual(names, ['clear_scene', 'close_panel', 'ghost_hands', 'highlight', 'look', 'recall', 'remember', 'room', 'run_code', 'set_chips', 'show_panel', 'stop_code', 'timer', 'update_panel'].sort());
  for (const t of TOOLS) assert.equal(t.function.parameters.type, 'object');
  const sp = systemPrompt({ user: 'u', capabilities: { camera: true }, room: { surfaces: [{ id: 't', label: 'table' }] }, memory: 'x' });
  for (const re of [/SAMPLE/, /dangerous/, /hands/i, /t: table/, /claw grip/i, /concise/]) assert.match(sp, re);
  const cg = codegenSystemPrompt();
  for (const re of [/aide\.onFrame\(fn/, /golf/, /four-stroke engine/, /agent map/, /aide\.emit\('task_moved'/, /while\(true\)/]) assert.match(cg, re);
  assert.match(sp, /You are Halo/);
  assert.match(sp, /set_chips/);
  assert.match(sp, /task_moved/);
});

// ---------- cost guard ----------
import { SessionGuard, GlobalGuard, Window, LimitError } from '../../server/src/guard.js';

test('guard: sliding window, per-session codegen cap, global cap', () => {
  const w = new Window(2, 1000);
  assert.equal(w.take(0), true);
  assert.equal(w.take(10), true);
  assert.equal(w.take(20), false);
  assert.equal(w.take(1001), true);
  const cfg = { modelPerMin: 3, modelPerSession: 4, codegenPerSession: 2, transcribePerMin: 1, globalModelPerMin: 100, globalCodegenPerHour: 100 };
  const g = new SessionGuard(cfg, new GlobalGuard(cfg));
  g.modelCall(); g.modelCall(); g.modelCall();
  assert.throws(() => g.modelCall(), (e) => e instanceof LimitError && e.kind === 'rate');
  g.codegenCall(); g.codegenCall();
  assert.throws(() => g.codegenCall(), (e) => e.kind === 'codegen');
  g.transcribeCall();
  assert.throws(() => g.transcribeCall(), /voice clips/);
  const shared = new GlobalGuard({ ...cfg, globalModelPerMin: 1 });
  new SessionGuard(cfg, shared).modelCall();
  assert.throws(() => new SessionGuard(cfg, shared).modelCall(), (e) => e.kind === 'global');
  const capped = new SessionGuard({ ...cfg, modelPerMin: 100, modelPerSession: 1 }, null);
  capped.modelCall();
  assert.throws(() => capped.modelCall(), (e) => e.kind === 'session');
});
