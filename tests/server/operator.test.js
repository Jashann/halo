import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockModels, FakeClient, startServer, tinyJpegB64 } from './helpers.js';

const TOKEN = 'test-operator-token-0123456789';

test('operator session: hello -> inbox, send tool_call -> client, tool_result image -> frame endpoint', async () => {
  const models = new MockModels();
  const srv = await startServer({ models, overrides: { operatorToken: TOKEN } });
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const op = (p, init = {}) => fetch(srv.http + p, { ...init, headers: { ...auth, ...(init.headers || {}) } });

  assert.equal((await fetch(srv.http + '/op/inbox')).status, 401);
  assert.equal((await fetch(srv.http + '/op/inbox', { headers: { Authorization: 'Bearer wrong' } })).status, 401);

  const c = new FakeClient(srv.url.replace('/ws', '/ws?op=1'), {
    look: () => ({ ok: true, result: { image_b64: tinyJpegB64(), sample: false } }),
  });
  await c.open();
  c.send({ type: 'hello', user: 'jashan', capabilities: { camera: true }, room: { surfaces: [{ id: 't1', label: 'table' }] } });
  c.send({ type: 'say', text: 'hi operator' });

  // long-poll returns once events exist
  let body = await (await op('/op/inbox?since=0&wait=5')).json();
  for (let i = 0; i < 20 && !body.events.some((e) => e.msg.type === 'say'); i++) body = await (await op('/op/inbox?since=0&wait=2')).json();
  const types = body.events.map((e) => e.msg.type);
  assert.deepEqual(types.slice(0, 3), ['connected', 'hello', 'say']);
  assert.equal(body.events[1].msg.room.surfaces[0].id, 't1');
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].user, 'jashan');
  const session = body.sessions[0].id;

  // send a tool_call to the latest session; client answers with a frame
  const sent = await (await op('/op/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: 'latest', message: { type: 'tool_call', name: 'look', args: { prompt: 'fridge' } } }) })).json();
  assert.equal(sent.ok, true);
  assert.equal(sent.session, session);
  const tc = await c.waitFor((m) => m.type === 'tool_call' && m.name === 'look');
  assert.equal(tc.call_id, sent.call_id);

  let res;
  for (let i = 0; i < 20; i++) {
    body = await (await op(`/op/inbox?since=${body.last_seq}&wait=2`)).json();
    res = body.events.find((e) => e.msg.type === 'tool_result');
    if (res) break;
  }
  assert.equal(res.msg.call_id, sent.call_id);
  assert.equal(res.msg.result.image_b64, undefined);
  const frame = await op(`/op/frame/${res.msg.result.frame_id}`);
  assert.equal(frame.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await frame.arrayBuffer()).toString('base64'), tinyJpegB64());

  // say / chips pass through; run_code js is validated, bad code rejected, no codegen call
  await op('/op/send', { method: 'POST', body: JSON.stringify({ session, message: { type: 'say', text: 'Hello from the operator' } }) });
  await c.waitFor((m) => m.type === 'say' && m.text === 'Hello from the operator');
  await op('/op/send', { method: 'POST', body: JSON.stringify({ session, message: { type: 'chips', chips: ['A', 'B'] } }) });
  await c.waitFor((m) => m.type === 'chips' && m.chips.length === 2);
  const bad = await op('/op/send', { method: 'POST', body: JSON.stringify({ session, message: { type: 'tool_call', name: 'run_code', args: { id: 'x', js: 'fetch("/"); aide.say(1)' } } }) });
  assert.equal(bad.status, 422);
  assert.match(JSON.stringify(await bad.json()), /fetch/);
  const good = await op('/op/send', { method: 'POST', body: JSON.stringify({ session, message: { type: 'tool_call', name: 'run_code', args: { id: 'x', js: 'aide.say("hi")', at: { near: 'front' } } } }) });
  assert.equal(good.status, 200);
  await c.waitFor((m) => m.type === 'tool_call' && m.name === 'run_code');
  assert.equal((await op('/op/send', { method: 'POST', body: JSON.stringify({ session, message: { type: 'error' } }) })).status, 400);
  assert.equal(models.requests.agent.length + models.requests.codegen.length, 0, 'operator sessions never call the model');

  // a normal session on the same server still uses the model path
  const n = new FakeClient(srv.url);
  await n.open();
  n.send({ type: 'hello', user: 'x', capabilities: {}, room: { surfaces: [] } });
  n.send({ type: 'say', text: 'model please' });
  await n.waitIdle();
  assert.equal(models.requests.agent.length, 1);
  n.close();
  c.close();
  await srv.app.close();
});

test('operator endpoints are off without OPERATOR_TOKEN, and ?op=1 then gets a normal session', async () => {
  const models = new MockModels();
  const srv = await startServer({ models, overrides: { operatorToken: '' } });
  assert.equal((await fetch(srv.http + '/op/inbox', { headers: { Authorization: 'Bearer ' } })).status, 404);
  const c = new FakeClient(srv.url + '?op=1');
  await c.open();
  c.send({ type: 'say', text: 'hello' });
  await c.waitIdle();
  assert.equal(models.requests.agent.length, 1);
  c.close();
  await srv.app.close();
});
