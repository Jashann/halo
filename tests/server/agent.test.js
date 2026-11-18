import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MockModels, FakeClient, startServer, reply, toolCall, tinyJpegB64 } from './helpers.js';

const md = fs.readFileSync(new URL('../../server/src/prompts/runtime_api.md', import.meta.url), 'utf8');
const [GOLF, ENGINE] = [...md.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);

const ROOM = { surfaces: [{ id: 'counter', label: 'table', size: [1.2, 0.6], center: [0, 0.9, -0.6] }, { id: 'stove', label: 'other', size: [0.6, 0.6], center: [0.8, 0.9, -0.6] }] };

async function connect(models, handlers, extra = {}) {
  const srv = await startServer({ models, ...extra });
  const c = new FakeClient(srv.url, handlers);
  await c.open();
  c.send({ type: 'hello', user: 'jashan', capabilities: { camera: false, mic: true, planes: true, hands: true }, room: ROOM });
  return { srv, c };
}

test('cooking flow: look -> recipe panel -> highlight -> ghost hands -> timer', async () => {
  const models = new MockModels({
    agent: [
      reply('Let me see what you have.', [toolCall('look', { prompt: 'ingredients in the fridge' })]),
      reply('You can make a spinach and carrot omelette.', [
        toolCall('show_panel', { id: 'recipe', title: 'Spinach omelette', spec: { steps: ['Wash spinach', 'Dice carrot', 'Whisk 3 eggs', 'Cook 4 min'] }, place: { near: 'counter', offset: [-0.4, 0.3, 0] }, size: 'medium' }),
        toolCall('highlight', { id: 'board', target: { surface_id: 'counter' }, label: 'Chop here', shape: 'zone' }),
        toolCall('ghost_hands', { motion: 'dice', at: { near: 'counter' }, label: 'Claw grip' }),
        toolCall('timer', { label: 'Omelette', seconds: 240, at: { near: 'stove' } }),
      ]),
      reply('Start by washing the spinach. Keep your fingertips tucked when you cut.'),
    ],
  });
  const { srv, c } = await connect(models, {
    look: () => ({ ok: true, result: { image_b64: tinyJpegB64(), sample: true, sample_name: 'fridge' } }),
  });
  c.send({ type: 'say', text: 'What can I make for dinner?' });
  await c.waitFor((m) => m.type === 'say' && /washing/.test(m.text));
  await c.waitIdle();

  assert.deepEqual(c.toolCalls.map((t) => t.name), ['look', 'show_panel', 'highlight', 'ghost_hands', 'timer']);
  assert.equal(c.toolCalls[1].args.spec.steps.length, 4);
  // the second model call carries the frame as an image with the SAMPLE note, after the tool result
  const req2 = models.requests.agent[1].messages;
  const last = req2[req2.length - 1];
  assert.equal(last.role, 'user');
  assert.ok(last.content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/jpeg;base64,')));
  assert.match(last.content[0].text, /SAMPLE image/);
  assert.equal(req2[req2.length - 2].role, 'tool');
  assert.ok(!req2[req2.length - 2].content.includes('/9j/'), 'jpeg bytes must not be inside the tool message');
  // tools schema sent every call, system prompt includes room and safety
  assert.ok(models.requests.agent[0].tools.some((t) => t.function.name === 'ghost_hands'));
  assert.match(req2[0].content, /counter: table/);
  assert.match(req2[0].content, /SAMPLE/);
  // say bubbles
  const says = c.messages.filter((m) => m.type === 'say').map((m) => m.text);
  assert.deepEqual(says, ['Let me see what you have.', 'You can make a spinach and carrot omelette.', 'Start by washing the spinach. Keep your fingertips tucked when you cut.']);
  // statuses stream
  assert.ok(c.messages.some((m) => m.type === 'status' && m.text === 'Looking...'));
  c.close();
  await srv.app.close();
});

test('game flow: run_code goes through codegen, client gets validated js; runtime error gets one fix', async () => {
  const models = new MockModels({
    agent: [
      reply('Building you a putting game on your table.', [toolCall('run_code', { id: 'golf', brief: 'Hands-only golf into a cup on the table, 3 holes', at: { near: 'counter' } })]),
      reply('Pinch the ball and pull back to putt.', [toolCall('remember', { key: 'favourite_game', value: 'table golf' })]),
      reply(''),
      // after the runtime error event that cannot be fixed a second time
      reply('Sorry, that game hit a snag. Want a different one?'),
    ],
    codegen: [reply('```js\n' + GOLF + '```'), reply('```js\n' + GOLF + '```')],
  });
  let runs = 0;
  const { srv, c } = await connect(models, {
    run_code: (args) => {
      runs++;
      assert.ok(args.js.includes('aide.spawn'));
      assert.deepEqual(args.at, { near: 'counter' });
      return { ok: true, result: { running: true } };
    },
  });
  c.send({ type: 'say', text: 'Make me a game' });
  await c.waitFor((m) => m.type === 'say' && /Pinch the ball/.test(m.text));
  await c.waitIdle();
  assert.equal(runs, 1);
  assert.equal(models.requests.codegen.length, 1);
  assert.match(models.requests.codegen[0].messages[0].content, /aide\.onPinch/);
  assert.match(models.requests.codegen[0].messages[1].content, /3 holes/);
  assert.equal(srv.memory.recall('jashan', 'favorite_game').value, 'table golf');

  // runtime error reported by the headset -> server asks codegen for a fix once and restarts
  const before = c.messages.length;
  c.send({ type: 'event', name: 'code_error', data: { id: 'golf', error: 'TypeError: cup.contains is not a function' } });
  await c.waitFor(() => runs === 2);
  await c.waitIdle(5000, before);
  assert.equal(models.requests.codegen.length, 2);
  assert.match(models.requests.codegen[1].messages[1].content, /cup\.contains is not a function/);
  assert.equal(models.requests.agent.length, 3, 'a successful fix does not need an agent turn');

  // second error on the same program: no more fixes, the agent is told
  c.send({ type: 'event', name: 'code_error', data: { id: 'golf', error: 'again' } });
  await c.waitFor((m) => m.type === 'say' && /snag/.test(m.text));
  assert.equal(models.requests.codegen.length, 2);
  assert.match(models.requests.agent[3].messages.at(-1).content, /\[event\] code_error/);
  c.close();
  await srv.app.close();
});

test('codegen output that fails validation is repaired once, then rejected', async () => {
  const models = new MockModels({
    agent: [reply('', [toolCall('run_code', { id: 'w', brief: 'widget', at: { near: 'front' } })]), reply('That did not work.')],
    codegen: [reply('```js\nfetch("x"); aide.say("hi")\n```'), reply('```js\nwhile(true){} aide.say(1)\n```')],
  });
  const { srv, c } = await connect(models, {});
  c.send({ type: 'say', text: 'build a widget' });
  await c.waitFor((m) => m.type === 'say' && /did not work/.test(m.text));
  assert.equal(c.toolCalls.filter((t) => t.name === 'run_code').length, 0, 'invalid code never reaches the headset');
  const toolMsg = models.requests.agent[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /failed checks/);
  assert.match(toolMsg.content, /while\(true\)/);
  assert.match(models.requests.codegen[1].messages[1].content, /forbidden identifier: fetch/);
  c.close();
  await srv.app.close();
});

test('explain flow: look at the object, then a grabbable 3D explanation', async () => {
  const models = new MockModels({
    agent: [
      reply('', [toolCall('look', { prompt: 'what object is this' })]),
      reply('That is a car engine part. Here is how the whole engine works.', [
        toolCall('run_code', { id: 'engine', brief: 'Grabbable four-stroke engine explanation with pinchable parts', at: { near: 'counter' } }),
        toolCall('show_panel', { id: 'engine-info', title: 'Four strokes', spec: { steps: ['Intake', 'Compression', 'Power', 'Exhaust'] }, place: { near: 'right' } }),
      ]),
      reply('Pinch any part to see what it does.'),
    ],
    codegen: [reply('Here you go:\n```javascript\n' + ENGINE + '```\nEnjoy.')],
  });
  const { srv, c } = await connect(models, {
    look: () => ({ ok: true, result: { image_b64: 'data:image/jpeg;base64,' + tinyJpegB64(), sample: false } }),
  });
  c.send({ type: 'say', text: 'Explain how this works' });
  await c.waitFor((m) => m.type === 'say' && /Pinch any part/.test(m.text));
  assert.deepEqual(c.toolCalls.map((t) => t.name), ['look', 'run_code', 'show_panel']);
  assert.ok(c.toolCalls[1].args.js.includes('Crankshaft'));
  assert.ok(!c.toolCalls[1].args.js.includes('```'));
  const img = models.requests.agent[1].messages.at(-1);
  assert.match(img.content[0].text, /LIVE camera frame/);
  c.close();
  await srv.app.close();
});

test('events start a turn; tool timeouts are reported to the model; older frames are dropped', async () => {
  const models = new MockModels({
    agent: [
      reply('', [toolCall('look', {})]),
      reply('', [toolCall('look', {})]),
      reply('', [toolCall('timer', { label: 'x', seconds: 5, at: { near: 'stove' } })]),
      reply('Got it.'),
      reply('Your omelette is ready. Turn off the heat first.'),
    ],
  });
  const { srv, c } = await connect(models, {
    look: () => ({ ok: true, result: { image_b64: tinyJpegB64() } }),
    timer: null, // never answers
  });
  c.send({ type: 'say', text: 'check the pan' });
  await c.waitFor((m) => m.type === 'say' && m.text === 'Got it.', 6000);
  const timerTool = models.requests.agent[3].messages.filter((m) => m.role === 'tool').at(-1);
  assert.match(timerTool.content, /did not answer timer/);
  // only the latest frame is sent as an image
  const req3 = models.requests.agent[2].messages;
  const imgs = req3.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  assert.equal(imgs.length, 1);
  assert.ok(req3.some((m) => Array.isArray(m.content) && m.content.some((p) => p.text === '[earlier camera frame omitted]')));

  c.send({ type: 'event', name: 'timer_done', data: { label: 'Omelette' } });
  await c.waitFor((m) => m.type === 'say' && /ready/.test(m.text));
  assert.match(models.requests.agent[4].messages.at(-1).content, /\[event\] timer_done/);
  c.close();
  await srv.app.close();
});

test('audio is transcribed, echoed as heard, then answered', async () => {
  const models = new MockModels({ agent: [reply('Sure, let us cook.')] });
  const transcriber = { transcribe: async ({ mime }) => ({ text: mime === 'audio/wav' ? 'what can I cook' : '', latencyMs: 5 }) };
  const { srv, c } = await connect(models, {}, { transcriber });
  c.send({ type: 'audio', mime: 'audio/wav', b64: Buffer.from('RIFF').toString('base64') });
  const heard = await c.waitFor((m) => m.type === 'heard');
  assert.equal(heard.text, 'what can I cook');
  await c.waitFor((m) => m.type === 'say' && /cook/.test(m.text));
  assert.equal(models.requests.agent[0].messages.at(-1).content, 'what can I cook');
  c.close();
  await srv.app.close();
});

test('model failure gives a spoken apology, not a crash; session keeps working', async () => {
  const models = new MockModels({ agent: [new Error('HTTP 503'), reply('I am back.')] });
  const { srv, c } = await connect(models, {});
  c.send({ type: 'say', text: 'hello' });
  await c.waitFor((m) => m.type === 'say' && /train of thought/.test(m.text));
  c.send({ type: 'say', text: 'hello again' });
  await c.waitFor((m) => m.type === 'say' && m.text === 'I am back.');
  c.close();
  await srv.app.close();
});

test('greeting turn on hello when enabled, with memory in the system prompt', async () => {
  const models = new MockModels({ agent: [reply('Welcome back!', [toolCall('show_panel', { id: 'chips', title: 'Try', spec: { buttons: [{ id: 'cook', label: 'What can I cook?' }] }, place: { near: 'front' } })]), reply('')] });
  const srv = await startServer({ models, overrides: { greet: true } });
  srv.memory.remember('nam', 'favourite_game', 'table golf');
  const c = new FakeClient(srv.url, {});
  await c.open();
  c.send({ type: 'hello', user: 'nam', capabilities: {}, room: ROOM });
  await c.waitFor((m) => m.type === 'say' && m.text === 'Welcome back!');
  await c.waitIdle();
  assert.match(models.requests.agent[0].messages.at(-1).content, /^\[session started\] Returning user\. .*favourite_game: table golf/);
  assert.equal(models.requests.agent[0].maxTokens, 600, 'greeting uses a short budget');
  assert.equal(models.requests.agent[0].reasoningEffort, 'low');
  assert.equal(models.requests.agent[1].maxTokens, undefined, 'only the first greeting call is capped');
  assert.match(models.requests.agent[0].messages[0].content, /favourite_game: table golf/);
  c.close();
  await srv.app.close();
});

test('a reply cut off by the token limit is dropped and retried with a larger budget', async () => {
  const cut = { ...reply('I put a timer by the stove'), finishReason: 'length' };
  const models = new MockModels({ agent: [cut, reply('', [toolCall('timer', { label: 'Pan', seconds: 600, at: { near: 'stove' } })]), reply('Timer is set.')] });
  const { srv, c } = await connect(models, {});
  c.send({ type: 'say', text: 'set a timer for the pan' });
  await c.waitFor((m) => m.type === 'say' && m.text === 'Timer is set.');
  assert.equal(models.requests.agent[1].maxTokens, 12000);
  assert.ok(!c.messages.some((m) => m.type === 'say' && /I put a timer/.test(m.text)), 'cut-off promise is never spoken');
  assert.deepEqual(c.toolCalls.map((t) => t.name), ['timer']);
  c.close();
  await srv.app.close();
});

test('workspace flow: agent map via run_code, then task_moved event gets a reply and a panel update', async () => {
  const AGENT_MAP = [...md.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1])[2];
  const models = new MockModels({
    agent: [
      reply('Here are your agents on the table, with sample tasks.', [
        toolCall('run_code', { id: 'agents', brief: 'Agent map: Marketing, Sales, Research, Ops cards with draggable task cards; emit task_moved on drop', at: { near: 'counter' } }),
        toolCall('show_panel', { id: 'work', title: 'Who does what', spec: { bullets: ['Marketing: 2', 'Sales: 2', 'Research: 1', 'Ops: 1'] }, place: { near: 'right' } }),
        toolCall('set_chips', { chips: ['Add a task', 'Balance the load', 'Done'] }),
      ]),
      reply(''),
      reply('Sales will turn the newsletter into a customer update.', [
        toolCall('update_panel', { id: 'work', patch: { spec: { bullets: ['Marketing: 1', 'Sales: 3', 'Research: 1', 'Ops: 1'] } } }),
      ]),
      reply(''),
    ],
    codegen: [reply('```js\n' + AGENT_MAP + '```')],
  });
  const { srv, c } = await connect(models, { set_chips: (a) => ({ ok: true, result: { chips: a.chips } }) });
  c.send({ type: 'say', text: 'Help me organise my work' });
  await c.waitIdle();
  assert.deepEqual(c.toolCalls.map((t) => t.name), ['run_code', 'show_panel', 'set_chips']);
  assert.ok(c.toolCalls[0].args.js.includes("aide.emit('task_moved'"));
  assert.deepEqual(c.toolCalls[2].args.chips, ['Add a task', 'Balance the load', 'Done']);

  const before = c.messages.length;
  c.send({ type: 'event', name: 'task_moved', data: { id: 'agents', task: 'Newsletter', to: 'Sales', from: 'Marketing' } });
  await c.waitFor((m) => m.type === 'say' && /Sales will/.test(m.text));
  await c.waitIdle(5000, before);
  assert.match(models.requests.agent[2].messages.at(-1).content, /\[event\] task_moved: .*Newsletter.*Sales/);
  assert.equal(c.toolCalls.at(-1).name, 'update_panel');
  c.close();
  await srv.app.close();
});

test('cost guard: per-minute model cap and per-session codegen cap are enforced over the socket', async () => {
  const models = new MockModels({
    agent: [
      reply('', [toolCall('run_code', { id: 'g1', brief: 'game', at: { near: 'counter' } })]),
      reply('', [toolCall('run_code', { id: 'g2', brief: 'game two', at: { near: 'counter' } })]),
      reply('Let me use a panel instead.'),
      reply('never reached'),
    ],
    codegen: [reply('```js\n' + GOLF + '```'), reply('```js\n' + GOLF + '```')],
  });
  const { srv, c } = await connect(models, {}, { overrides: { modelPerMin: 3, codegenPerSession: 1 } });
  c.send({ type: 'say', text: 'two games please' });
  await c.waitFor((m) => m.type === 'say' && /panel instead/.test(m.text));
  assert.equal(models.requests.codegen.length, 1, 'second codegen blocked');
  const tool = models.requests.agent[2].messages.filter((m) => m.role === 'tool').at(-1);
  assert.match(tool.content, /code generation limit/);
  c.send({ type: 'say', text: 'again' });
  await c.waitFor((m) => m.type === 'say' && /catch up/.test(m.text));
  assert.equal(models.requests.agent.length, 3, 'fourth model call in the minute never went out');
  c.close();
  await srv.app.close();
});

test('cost guard: connections per IP are capped', async () => {
  const srv = await startServer({ models: new MockModels(), overrides: { maxSessionsPerIp: 1 } });
  const a = new FakeClient(srv.url);
  await a.open();
  const b = new FakeClient(srv.url);
  await b.open();
  await b.waitFor((m) => m.type === 'say' && /full/.test(m.text));
  await new Promise((r) => b.ws.on('close', r));
  a.close();
  await srv.app.close();
});

test('hello without greeting warms the model once; first visit greeting says so', async () => {
  const models = new MockModels({ agent: [reply('')] });
  const srv = await startServer({ models, overrides: { warmOnHello: true } });
  const c = new FakeClient(srv.url, {});
  await c.open();
  c.send({ type: 'hello', user: 'warm', capabilities: {}, room: ROOM });
  c.send({ type: 'hello', user: 'warm', capabilities: {}, room: ROOM });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(models.requests.agent.length, 1);
  assert.equal(models.requests.agent[0].maxTokens, 16);
  assert.equal(models.requests.agent[0].tools, undefined);
  c.close();
  await srv.app.close();

  const m2 = new MockModels({ agent: [reply('Hi, I am Halo.'), reply('')] });
  const s2 = await startServer({ models: m2, overrides: { greet: true } });
  const c2 = new FakeClient(s2.url, {});
  await c2.open();
  c2.send({ type: 'hello', user: 'newbie', capabilities: {}, room: ROOM });
  await c2.waitFor((m) => m.type === 'say' && /Halo/.test(m.text));
  assert.equal(m2.requests.agent[0].messages.at(-1).content, '[session started] First visit.');
  c2.close();
  await s2.app.close();
});

test('clear_scene reaches the headset; game_score and code_done are stored for the next visit', async () => {
  const models = new MockModels({
    agent: [
      reply('Fresh table for the game.', [toolCall('clear_scene', { keep: ['timer-pasta'] })]),
      reply(''),
      reply('Nice, 4 strokes.', [toolCall('remember', { key: 'last_game', value: 'table golf, 4 strokes' })]),
      reply(''),
    ],
  });
  const { srv, c } = await connect(models, { clear_scene: (a) => ({ ok: true, result: { removed: 5, kept: a.keep } }) });
  c.send({ type: 'say', text: 'now a game' });
  await c.waitIdle();
  assert.equal(c.toolCalls[0].name, 'clear_scene');
  assert.deepEqual(c.toolCalls[0].args, { keep: ['timer-pasta'] });
  const before = c.messages.length;
  c.send({ type: 'event', name: 'game_score', data: { id: 'golf', score: 4 } });
  await c.waitFor((m) => m.type === 'say' && /4 strokes/.test(m.text));
  await c.waitIdle(5000, before);
  assert.equal(srv.memory.recall('jashan', 'last_score_golf').value, '4');
  assert.equal(srv.memory.recall('jashan', 'last_game').value, 'table golf, 4 strokes');
  assert.match(models.requests.agent[0].messages[0].content, /clear_scene/);
  c.close();
  await srv.app.close();
});
