import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MockModels, FakeClient, startServer, tmpDir, reply } from './helpers.js';

test('health route, static files, SPA fallback, traversal blocked', async () => {
  const web = tmpDir('aide-dist-');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Halo</title>');
  fs.mkdirSync(path.join(web, 'assets'));
  fs.writeFileSync(path.join(web, 'assets', 'app.js'), 'console.log(1)');
  const srv = await startServer({ models: new MockModels(), webDist: web });

  const h = await (await fetch(srv.http + '/health')).json();
  assert.equal(h.ok, true);
  assert.equal(h.web, true);
  assert.equal(h.models.agent, 'muse-ember-1.0');
  assert.ok(!JSON.stringify(h).includes(srv.app.config.apiKey || 'zzz-no-key'), 'key never in health');

  const idx = await fetch(srv.http + '/');
  assert.equal(idx.status, 200);
  assert.match(await idx.text(), /Halo/);
  const js = await fetch(srv.http + '/assets/app.js');
  assert.match(js.headers.get('content-type'), /javascript/);
  const spa = await fetch(srv.http + '/some/route');
  assert.equal(spa.status, 200);
  const missing = await fetch(srv.http + '/nope.png');
  assert.equal(missing.status, 404);
  const trav = await fetch(srv.http + '/..%2f..%2fetc%2fpasswd');
  assert.ok([403, 404].includes(trav.status));
  const post = await fetch(srv.http + '/', { method: 'POST' });
  assert.equal(post.status, 405);
  await srv.app.close();
});

test('ws: invalid JSON and unknown types get error messages; unknown call ids are ignored', async () => {
  const srv = await startServer({ models: new MockModels() });
  const c = new FakeClient(srv.url);
  await c.open();
  c.ws.send('not json');
  await c.waitFor((m) => m.type === 'error' && /invalid JSON/.test(m.text));
  c.send({ type: 'teleport' });
  await c.waitFor((m) => m.type === 'error' && /unknown message type/.test(m.text));
  c.send({ type: 'tool_result', call_id: 'nope', ok: true, result: {} });
  c.send({ type: 'say', text: '   ' }); // ignored
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(c.messages.filter((m) => m.type === 'status').length, 0);
  c.close();
  await srv.app.close();
});

test('ws: messages are processed in order, one turn at a time; tool_call/tool_result round trip shape', async () => {
  const order = [];
  const models = new MockModels({
    agent: [
      (req) => {
        order.push(req.messages.at(-1).content);
        return reply('', [{ id: 'x1', name: 'show_panel', arguments: JSON.stringify({ id: 'p', title: 'T', place: { near: 'front' } }) }]);
      },
      (req) => {
        const tool = req.messages.at(-1);
        assert.equal(tool.role, 'tool');
        assert.equal(tool.tool_call_id, 'x1');
        assert.deepEqual(JSON.parse(tool.content), { ok: true, panel: 'p', placed: true });
        return reply('first done');
      },
      (req) => {
        order.push(req.messages.at(-1).content);
        return reply('second done');
      },
    ],
  });
  const srv = await startServer({ models });
  const c = new FakeClient(srv.url, { show_panel: async (args) => {
    await new Promise((r) => setTimeout(r, 50));
    return { ok: true, result: { panel: args.id, placed: true } };
  } });
  await c.open();
  c.send({ type: 'hello', user: 'u1', capabilities: {}, room: { surfaces: [] } });
  c.send({ type: 'say', text: 'one' });
  c.send({ type: 'say', text: 'two' });
  await c.waitFor((m) => m.type === 'say' && m.text === 'second done');
  assert.deepEqual(order, ['one', 'two']);
  const tc = c.toolCalls[0];
  assert.equal(typeof tc.call_id, 'string');
  assert.deepEqual(tc.args, { id: 'p', title: 'T', place: { near: 'front' } });
  c.close();
  await srv.app.close();
});

test('room tool falls back to the hello room when the headset fails', async () => {
  const models = new MockModels({ agent: [reply('', [{ id: 'r', name: 'room', arguments: '{}' }]), reply('ok')] });
  const srv = await startServer({ models });
  const c = new FakeClient(srv.url, { room: () => ({ ok: false, result: { error: 'no planes' } }) });
  await c.open();
  c.send({ type: 'hello', user: 'u', capabilities: {}, room: { surfaces: [{ id: 't1', label: 'table' }] } });
  c.send({ type: 'say', text: 'where is my table' });
  await c.waitFor((m) => m.type === 'say' && m.text === 'ok');
  const tool = models.requests.agent[1].messages.at(-1);
  assert.match(tool.content, /t1/);
  assert.match(tool.content, /session start/);
  c.close();
  await srv.app.close();
});
