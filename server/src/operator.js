// Operator mode: a person (or an outside agent) drives a headset session instead of the model.
// A WebSocket opened with ?op=... becomes an OperatorSession when OPERATOR_TOKEN is set. Everything the headset
// sends goes to an inbox that the operator reads over HTTP (long-poll); the operator sends protocol messages back.
import crypto from 'node:crypto';
import { validateCode } from './codegen.js';
import { Window } from './guard.js';

const SEND_TYPES = new Set(['tool_call', 'say', 'status', 'chips']);

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export class OperatorHub {
  constructor({ token, maxEvents = 3000, maxFrames = 120, reqPerMin = 240, log = () => {} }) {
    this.token = token;
    this.tokenBuf = Buffer.from(token || '');
    this.maxEvents = maxEvents;
    this.maxFrames = maxFrames;
    this.log = log;
    this.events = [];
    this.seq = 0;
    this.waiters = new Set();
    this.frames = new Map();
    this.sessions = new Map();
    this.sessionSeq = 0;
    this.limits = new Map(); // ip -> Window
    this.badAuth = new Map(); // ip -> Window
    this.reqPerMin = reqPerMin;
  }

  get enabled() {
    return Boolean(this.token);
  }

  // ---------- sessions ----------
  register(send) {
    const id = `s${++this.sessionSeq}-${crypto.randomBytes(2).toString('hex')}`;
    const s = { id, send, user: null, connectedAt: Date.now(), lastSeen: Date.now(), calls: new Set() };
    this.sessions.set(id, s);
    this.push(id, { type: 'connected' });
    return s;
  }

  unregister(id) {
    if (this.sessions.delete(id)) this.push(id, { type: 'disconnected' });
  }

  sessionList() {
    return [...this.sessions.values()].map((s) => ({ id: s.id, user: s.user, connectedAt: s.connectedAt, lastSeen: s.lastSeen }));
  }

  // ---------- inbox ----------
  push(session, msg) {
    const s = this.sessions.get(session);
    if (s) s.lastSeen = Date.now();
    if (msg && msg.type === 'tool_result' && msg.result && typeof msg.result === 'object' && msg.result.image_b64) {
      let b64 = String(msg.result.image_b64);
      const m = b64.match(/^data:image\/[a-z]+;base64,(.*)$/s);
      if (m) b64 = m[1];
      const frame_id = `f${this.seq + 1}-${crypto.randomBytes(3).toString('hex')}`;
      this.frames.set(frame_id, Buffer.from(b64, 'base64'));
      while (this.frames.size > this.maxFrames) this.frames.delete(this.frames.keys().next().value);
      const { image_b64, ...rest } = msg.result;
      msg = { ...msg, result: { ...rest, frame_id } };
    }
    if (msg && msg.type === 'audio') msg = { type: 'audio', mime: msg.mime, bytes: Math.round(((msg.b64 || '').length * 3) / 4) };
    const ev = { seq: ++this.seq, ts: Date.now(), session, msg };
    this.events.push(ev);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    for (const w of this.waiters) w();
    return ev;
  }

  since(seq) {
    return this.events.filter((e) => e.seq > seq);
  }

  waitFor(seq, ms) {
    return new Promise((resolve) => {
      if (this.seq > seq) return resolve();
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  // ---------- sending ----------
  send(sessionId, message) {
    const s = sessionId === 'latest' || !sessionId ? [...this.sessions.values()].at(-1) : this.sessions.get(sessionId);
    if (!s) return { ok: false, code: 404, error: 'no such live operator session' };
    if (!message || !SEND_TYPES.has(message.type)) return { ok: false, code: 400, error: `message.type must be one of ${[...SEND_TYPES].join(', ')}` };
    let out = message;
    if (message.type === 'tool_call') {
      if (!message.name) return { ok: false, code: 400, error: 'tool_call needs name' };
      const args = message.args && typeof message.args === 'object' ? message.args : {};
      if (message.name === 'run_code') {
        if (typeof args.js !== 'string') return { ok: false, code: 400, error: 'run_code in operator mode needs args.js (the program)' };
        const check = validateCode(args.js);
        if (!check.ok) return { ok: false, code: 422, error: 'program failed checks', problems: check.errors };
      }
      out = { type: 'tool_call', call_id: message.call_id || `op${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, name: message.name, args };
      s.calls.add(out.call_id);
    } else if (message.type === 'chips') {
      out = { type: 'chips', chips: (Array.isArray(message.chips) ? message.chips : []).map(String).slice(0, 4) };
    } else {
      out = { type: message.type, text: String(message.text ?? '') };
    }
    s.send(out);
    this.push(s.id, { type: 'sent', message: out.type === 'tool_call' && out.name === 'run_code' ? { ...out, args: { ...out.args, js: `[${out.args.js.length} chars]` } } : out });
    return { ok: true, session: s.id, call_id: out.call_id };
  }

  // ---------- HTTP ----------
  authorized(req, ip) {
    const h = String(req.headers.authorization || '');
    const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7).trim() : '');
    const ok = given.length === this.tokenBuf.length && given.length > 0 && crypto.timingSafeEqual(given, this.tokenBuf);
    if (!ok) {
      if (!this.badAuth.has(ip)) this.badAuth.set(ip, new Window(10, 60000));
      this.badAuth.get(ip).take();
    }
    return ok;
  }

  // Returns true when the request was an /op/ request (handled here).
  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/op/')) return false;
    if (!this.enabled) {
      json(res, 404, { error: 'operator mode disabled' });
      return true;
    }
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const bad = this.badAuth.get(ip);
    if (bad && bad.hits.length >= bad.max && Date.now() - bad.hits[0] < bad.ms) {
      json(res, 429, { error: 'too many failed attempts' });
      return true;
    }
    if (!this.limits.has(ip)) this.limits.set(ip, new Window(this.reqPerMin, 60000));
    if (!this.limits.get(ip).take()) {
      json(res, 429, { error: 'rate limited' });
      return true;
    }
    if (!this.authorized(req, ip)) {
      json(res, 401, { error: 'unauthorized' });
      return true;
    }
    try {
      if (req.method === 'GET' && url.pathname === '/op/inbox') {
        const since = Number(url.searchParams.get('since') || 0) || 0;
        const wait = Math.min(Math.max(Number(url.searchParams.get('wait') || 0) || 0, 0), 50);
        if (wait && this.seq <= since) await this.waitFor(since, wait * 1000);
        json(res, 200, { events: this.since(since), last_seq: this.seq, sessions: this.sessionList() });
        return true;
      }
      const fm = url.pathname.match(/^\/op\/frame\/([A-Za-z0-9-]+?)(?:\.jpg)?$/);
      if (req.method === 'GET' && fm) {
        const buf = this.frames.get(fm[1]);
        if (!buf) json(res, 404, { error: 'no such frame' });
        else res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' }).end(buf);
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/op/send') {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: 'body must be JSON {session, message}' });
          return true;
        }
        const r = this.send(body.session || 'latest', body.message);
        json(res, r.ok ? 200 : r.code, r.ok ? r : { error: r.error, problems: r.problems });
        return true;
      }
      json(res, 404, { error: 'unknown operator endpoint' });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return true;
  }
}

// Per-connection handler for operator sessions: no model calls, everything goes to the inbox.
export class OperatorSession {
  constructor({ hub, send, transcriber, guard, log = () => {} }) {
    this.hub = hub;
    this.send = send;
    this.transcriber = transcriber;
    this.guard = guard;
    this.log = log;
    this.s = hub.register(send);
    this.id = this.s.id;
    send({ type: 'status', text: '' });
  }

  async handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') this.s.user = String(msg.user || 'guest');
    this.hub.push(this.id, msg);
    if (msg.type === 'audio') {
      let text = '';
      try {
        this.guard?.transcribeCall();
        if (!this.transcriber) throw new Error('voice unavailable');
        text = (await this.transcriber.transcribe({ mime: msg.mime, b64: msg.b64 })).text;
        this.send({ type: 'heard', text });
        this.hub.push(this.id, { type: 'heard', text });
      } catch (e) {
        this.send({ type: 'heard', text: '', error: 'transcription failed' });
        this.hub.push(this.id, { type: 'heard', text: '', error: e.message });
      }
    }
  }

  close() {
    this.hub.unregister(this.id);
  }
}
