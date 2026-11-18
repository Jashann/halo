import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHaloServer, WebSocket } from '../../server/src/server.js';
import { MemoryStore } from '../../server/src/memory.js';

process.env.AIDE_QUIET = '1';

export const tmpDir = (p = 'aide-test-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

let tcSeq = 0;
export const toolCall = (name, args = {}) => ({ id: `tc_${++tcSeq}`, name, arguments: JSON.stringify(args) });
export const reply = (content = '', toolCalls = []) => ({ content, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop', latencyMs: 1, model: 'mock' });

// Scripted model: per role an array of replies (or functions (req) => reply). Records every request.
export class MockModels {
  constructor(script = {}) {
    this.script = { agent: [], codegen: [], ...script };
    this.requests = { agent: [], codegen: [] };
  }
  async call(role, req) {
    this.requests[role].push(JSON.parse(JSON.stringify(req)));
    const next = this.script[role].shift();
    if (next === undefined) return reply('');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(req) : next;
  }
}

export async function startServer({ models, transcriber = null, overrides = {}, webDist } = {}) {
  const dataDir = tmpDir('aide-mem-');
  const memory = new MemoryStore(dataDir);
  const app = createHaloServer(
    { port: 0, host: '127.0.0.1', dataDir, webDist: webDist || tmpDir('aide-web-'), greet: false, warmOnHello: false, toolTimeoutMs: 1500, ...overrides },
    { models, memory, transcriber, log: () => {} }
  );
  const addr = await app.listen(0, '127.0.0.1');
  return { app, memory, port: addr.port, url: `ws://127.0.0.1:${addr.port}/ws`, http: `http://127.0.0.1:${addr.port}` };
}

// Fake headset: answers tool calls with handlers, records everything.
export class FakeClient {
  constructor(url, handlers = {}) {
    this.url = url;
    this.handlers = handlers;
    this.messages = [];
    this.toolCalls = [];
    this.waiters = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (d) => this.onMessage(JSON.parse(d.toString())));
    });
  }
  async onMessage(msg) {
    this.messages.push(msg);
    if (msg.type === 'tool_call') {
      this.toolCalls.push(msg);
      const h = msg.name in this.handlers ? this.handlers[msg.name] : this.handlers['*'];
      if (h !== null) {
        const out = h ? await h(msg.args, msg) : { ok: true, result: { shown: true } };
        if (out !== undefined) this.send({ type: 'tool_result', call_id: msg.call_id, ok: out.ok !== false, result: out.result ?? {} });
      }
    }
    for (const w of [...this.waiters]) {
      if (w.pred(msg, this)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  waitFor(pred, ms = 5000) {
    const hit = this.messages.find((m) => pred(m, this));
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, timer: setTimeout(() => reject(new Error('waitFor timeout; got ' + JSON.stringify(this.messages.map((m) => m.type + ':' + (m.name || m.text || ''))))), ms) };
      this.waiters.push(w);
    });
  }
  // A turn ends with status "" after at least one non-empty status.
  async waitIdle(ms = 8000, after = 0) {
    const start = this.messages.length > after ? after : this.messages.length;
    return new Promise((resolve, reject) => {
      const check = () => {
        const tail = this.messages.slice(start);
        const sawBusy = tail.some((m) => m.type === 'status' && m.text);
        const last = [...tail].reverse().find((m) => m.type === 'status');
        if (sawBusy && last && last.text === '') return true;
        return false;
      };
      if (check()) return resolve();
      const w = { pred: () => check(), resolve, timer: setTimeout(() => reject(new Error('waitIdle timeout')), ms) };
      this.waiters.push(w);
    });
  }
  close() {
    this.ws.close();
  }
}

export const tinyJpegB64 = () =>
  fs.readFileSync(new URL('./fixtures/fridge.jpg', import.meta.url)).toString('base64');
