// One Session per WebSocket connection: conversation state, the agent loop, tool execution through the client.
import { TOOLS, SERVER_TOOLS, TOOL_TIMEOUTS } from './tools.js';
import { systemPrompt } from './prompts.js';
import { CodeGenerator } from './codegen.js';
import { SessionGuard, guardedModels, LimitError } from './guard.js';

let callSeq = 0;
const newCallId = () => `c${Date.now().toString(36)}_${(++callSeq).toString(36)}`;

const CODE_ERROR_EVENTS = new Set(['code_error', 'runtime_error']);

function isSample(result) {
  return Boolean(result && (result.sample === true || result.is_sample === true || result.source === 'sample'));
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + '...' : s;
}

export class Session {
  constructor({ send, models, codegen, memory, transcriber, config, log = () => {}, globalGuard = null }) {
    this.send = send;
    this.guard = new SessionGuard(config, globalGuard);
    // every paid call goes through the guard (codegen too, unless a custom generator is injected)
    this.models = guardedModels(models, this.guard);
    this.codegen = codegen || new CodeGenerator({ models: this.models, log });
    this.queued = 0;
    this.memory = memory;
    this.transcriber = transcriber;
    this.config = config;
    this.log = log;
    this.user = 'guest';
    this.capabilities = {};
    this.room = { surfaces: [] };
    this.messages = [];
    this.pending = new Map();
    this.programs = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
    this.trace = []; // tool calls and timings, for tests and the live transcript
  }

  // ---------- inbound ----------
  handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'hello':
        this.user = String(msg.user || 'guest');
        this.capabilities = msg.capabilities || {};
        if (msg.room && Array.isArray(msg.room.surfaces)) this.room = msg.room;
        if (this.config.greet) this.enqueue(() => this.runTurn(this.sessionStartText(), { greeting: true }));
        else this.warm();
        return;
      case 'say':
        if (typeof msg.text === 'string' && msg.text.trim()) {
          const text = msg.text.trim().slice(0, 2000);
          this.enqueue(() => this.userSaid(text));
        }
        return;
      case 'audio':
        this.enqueue(() => this.userAudio(msg));
        return;
      case 'tool_result':
        this.onToolResult(msg);
        return;
      case 'event':
        this.enqueue(() => this.onEvent(msg.name, msg.data));
        return;
      default:
        this.send({ type: 'error', text: `unknown message type ${msg.type}` });
    }
  }

  enqueue(fn) {
    if (this.queued >= this.config.maxQueued) {
      this.say('One moment, I am still on the last thing.');
      return this.queue;
    }
    this.queued++;
    this.queue = this.queue
      .then(() => (this.closed ? null : fn()))
      .catch((err) => {
        this.status('');
        if (err instanceof LimitError) {
          this.log({ limit: err.kind, message: err.message });
          this.say(
            err.kind === 'rate'
              ? 'I need a few seconds to catch up. Try again in a moment.'
              : err.kind === 'global'
                ? 'I am very busy right now. Please try again in a minute.'
                : 'This session has reached its limit. Reload the page to start a fresh one.'
          );
          return;
        }
        this.log({ sessionError: err.message });
        this.say('Sorry, I lost my train of thought for a moment. Could you say that again?');
      })
      .finally(() => {
        this.queued--;
      });
    return this.queue;
  }

  async userSaid(text) {
    try {
      this.memory.addHistory(this.user, `said: ${truncate(text, 120)}`);
    } catch {}
    return this.runTurn(text);
  }

  async userAudio(msg) {
    if (!this.transcriber) {
      this.send({ type: 'heard', text: '', error: 'voice unavailable' });
      return;
    }
    try {
      this.guard.transcribeCall();
    } catch (err) {
      this.send({ type: 'heard', text: '', error: err.message });
      this.say('Too many voice clips at once. Give me a few seconds.');
      return;
    }
    this.status('Listening...');
    let text = '';
    try {
      const out = await this.transcriber.transcribe({ mime: msg.mime, b64: msg.b64 });
      text = out.text;
      this.trace.push({ kind: 'transcribe', latencyMs: out.latencyMs, text });
    } catch (err) {
      this.log({ transcribeError: err.message });
      this.send({ type: 'heard', text: '', error: 'transcription failed' });
      this.status('');
      this.say("I didn't catch that. Try again, or press one of the suggestions.");
      return;
    }
    this.send({ type: 'heard', text });
    if (!text) {
      this.status('');
      this.say("I didn't hear anything. Hold the talk button while you speak.");
      return;
    }
    return this.userSaid(text);
  }

  async onEvent(name, data) {
    name = String(name || 'event');
    if (CODE_ERROR_EVENTS.has(name)) {
      const handled = await this.tryFixProgram(data?.id, data?.error || data?.message);
      if (handled) return;
    }
    if (name === 'game_score' && data && data.score !== undefined) {
      try {
        this.memory.remember(this.user, `last_score_${data.id || 'game'}`, String(data.score));
      } catch {}
    }
    if (name === 'code_done' && data?.summary) {
      try {
        this.memory.addHistory(this.user, `finished ${data.id || 'program'}: ${truncate(data.summary, 120)}`);
      } catch {}
    }
    return this.runTurn(`[event] ${name}: ${truncate(JSON.stringify(data ?? {}), 1500)}`);
  }

  // ---------- outbound helpers ----------
  status(text) {
    this.send({ type: 'status', text });
  }

  say(text) {
    if (text && text.trim()) this.send({ type: 'say', text: text.trim() });
  }

  callClient(name, args, timeoutMs) {
    const call_id = newCallId();
    const ms = timeoutMs || TOOL_TIMEOUTS[name] || this.config.toolTimeoutMs;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(call_id);
        resolve({ ok: false, result: { error: `headset did not answer ${name} within ${ms} ms` } });
      }, ms);
      this.pending.set(call_id, { resolve, timer, name });
      this.send({ type: 'tool_call', call_id, name, args });
    });
  }

  onToolResult(msg) {
    const p = this.pending.get(msg.call_id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.call_id);
    p.resolve({ ok: msg.ok !== false, result: msg.result ?? null });
  }

  close() {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, result: { error: 'connection closed' } });
    }
    this.pending.clear();
  }

  // ---------- model context ----------
  buildMessages() {
    const sys = {
      role: 'system',
      content: systemPrompt({
        user: this.user,
        capabilities: this.capabilities,
        room: this.room,
        memory: this.memory.summary(this.user),
      }),
    };
    // Only the most recent camera frame is sent as an image; older ones become a short note.
    let lastImageIdx = -1;
    this.messages.forEach((m, i) => {
      if (Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url')) lastImageIdx = i;
    });
    const hist = this.messages.map((m, i) => {
      if (!Array.isArray(m.content) || i === lastImageIdx) return m;
      return { ...m, content: m.content.map((c) => (c.type === 'image_url' ? { type: 'text', text: '[earlier camera frame omitted]' } : c)) };
    });
    return [sys, ...hist];
  }

  trimHistory() {
    const max = this.config.maxHistory;
    if (this.messages.length <= max) return;
    // cut at a plain user message so tool call / tool result pairs stay together
    let cut = this.messages.length - max;
    while (cut < this.messages.length && !(this.messages[cut].role === 'user' && typeof this.messages[cut].content === 'string')) cut++;
    if (cut < this.messages.length) this.messages = this.messages.slice(cut);
  }

  // ---------- the loop ----------
  // A short opening message: the memory recap is in the system prompt; this line points the model at it.
  sessionStartText() {
    let recent = [];
    try {
      const mem = this.memory.recall(this.user);
      const prefs = Object.entries(mem.prefs || {}).filter(([k]) => /^(last_|best_|favou?rite)/.test(k));
      recent = [...prefs.map(([k, v]) => `${k}: ${v}`), ...(mem.history || []).slice(-4).map((h) => h.text)];
    } catch {}
    return recent.length ? `[session started] Returning user. Most relevant memory: ${recent.slice(0, 8).join('; ')}` : '[session started] First visit.';
  }

  // Opens the HTTPS connection to the model API so the first real answer is quick (keep-alive reuses it).
  warm() {
    if (this.warmed || !this.config.warmOnHello) return;
    this.warmed = true;
    this.models
      .call('agent', { messages: [{ role: 'user', content: 'ok' }], maxTokens: 16, reasoningEffort: 'low' })
      .catch(() => {});
  }

  async runTurn(userText, { greeting = false } = {}) {
    this.messages.push({ role: 'user', content: userText });
    this.trimHistory();
    const turn = { user: userText, steps: [] };
    this.trace.push({ kind: 'turn', turn });
    try {
      for (let step = 0; step < this.config.maxSteps; step++) {
        if (this.closed) return;
        this.status(step === 0 ? 'Thinking...' : 'Working...');
        const budget = greeting && step === 0 ? { maxTokens: this.config.greetMaxTokens, reasoningEffort: 'low' } : {};
        let out = await this.models.call('agent', { messages: this.buildMessages(), tools: TOOLS, ...budget });
        if (out.finishReason === 'length' && !out.toolCalls.length) {
          // reasoning used up the budget before the tool calls: the cut-off text may promise actions that never
          // happened, so drop it and ask again with more room.
          this.log({ warn: 'agent reply cut off, retrying with a larger budget' });
          out = await this.models.call('agent', { messages: this.buildMessages(), tools: TOOLS, maxTokens: 12000 });
        }
        const stepRec = { model: out.model, latencyMs: out.latencyMs, say: out.content || '', tools: [] };
        turn.steps.push(stepRec);
        const assistant = { role: 'assistant', content: out.content || '' };
        if (out.toolCalls.length) {
          assistant.tool_calls = out.toolCalls.map((tc) => ({
            id: tc.id || newCallId(),
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments || '{}' },
          }));
        }
        this.messages.push(assistant);
        if (out.content && out.content.trim()) this.say(out.content);
        if (!out.toolCalls.length) break;

        const images = [];
        for (const tc of assistant.tool_calls) {
          let args;
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            args = null;
          }
          const t0 = Date.now();
          const res = args === null ? { ok: false, result: { error: 'arguments were not valid JSON' } } : await this.executeTool(tc.function.name, args, images);
          stepRec.tools.push({ name: tc.function.name, args: redactArgs(args), ok: res.ok, ms: Date.now() - t0, result: summarizeResult(res.result) });
          this.messages.push({ role: 'tool', tool_call_id: tc.id, content: truncate(JSON.stringify({ ok: res.ok, ...asObject(res.result) }), 4000) });
        }
        for (const img of images) this.messages.push(img);
        if (step === this.config.maxSteps - 1) this.log({ warn: 'max steps reached' });
      }
    } finally {
      this.status('');
    }
  }

  async executeTool(name, args, images) {
    switch (name) {
      case 'remember':
        return { ok: true, result: this.memory.remember(this.user, args.key, args.value) };
      case 'recall':
        return { ok: true, result: this.memory.recall(this.user, args.key) };
      case 'look':
        return this.doLook(args, images);
      case 'room': {
        const r = await this.callClient('room', {});
        if (r.ok && r.result) {
          if (Array.isArray(r.result.surfaces)) this.room = { ...this.room, ...r.result };
          return r;
        }
        return { ok: true, result: { ...this.room, note: 'live room data unavailable; this is the room from session start' } };
      }
      case 'run_code':
        return this.doRunCode(args);
      default:
        if (SERVER_TOOLS.has(name)) return { ok: false, result: { error: 'unsupported' } };
        if (!TOOLS.some((t) => t.function.name === name)) return { ok: false, result: { error: `unknown tool ${name}` } };
        return this.callClient(name, args);
    }
  }

  async doLook(args, images) {
    this.status('Looking...');
    const r = await this.callClient('look', args || {});
    if (!r.ok || !r.result || !r.result.image_b64) {
      return { ok: false, result: { error: r.result?.error || 'no camera frame came back' } };
    }
    const sample = isSample(r.result);
    let b64 = String(r.result.image_b64);
    const m = b64.match(/^data:(image\/[a-z]+);base64,(.*)$/s);
    const mime = m ? m[1] : r.result.mime || 'image/jpeg';
    if (m) b64 = m[2];
    const note = sample
      ? `SAMPLE image (the camera is unavailable, so the headset sent a bundled example photo${r.result.sample_name ? ` "${r.result.sample_name}"` : ''}). It is NOT the user's real view.`
      : 'LIVE camera frame from the headset (what the user is looking at now).';
    images.push({
      role: 'user',
      content: [
        { type: 'text', text: `Camera frame from look(${args?.prompt ? JSON.stringify(args.prompt) : ''}). ${note}` },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ],
    });
    return { ok: true, result: { frame: 'attached in the next message', sample, width: r.result.width, height: r.result.height } };
  }

  async doRunCode(args) {
    const id = String(args.id || `prog${this.programs.size + 1}`);
    const brief = String(args.brief || args.js || '').slice(0, 6000);
    if (!brief) return { ok: false, result: { error: 'brief is required' } };
    this.status('Building it...');
    let gen;
    try {
      gen = await this.codegen.generate({ brief, surfaces: this.room.surfaces, memory: this.memory.summary(this.user) });
    } catch (err) {
      if (err instanceof LimitError)
        return { ok: false, result: { error: `${err.message}; build it with panels, highlights and timers instead` } };
      return { ok: false, result: { error: `code generator unavailable: ${err.message}` } };
    }
    this.trace.push({ kind: 'codegen', id, ok: gen.ok, attempts: gen.attempts, latencyMs: gen.latencyMs, bytes: gen.code?.length || 0 });
    if (!gen.ok) return { ok: false, result: { error: 'generated program failed checks', problems: gen.errors.slice(0, 5) } };
    this.programs.set(id, { brief, code: gen.code, at: args.at, fixed: false });
    let r = await this.callClient('run_code', { id, js: gen.code, at: args.at });
    if (!r.ok && r.result?.error) {
      const fixed = await this.tryFixProgram(id, r.result.error, { returnResult: true });
      if (fixed && typeof fixed === 'object') r = fixed;
    }
    try {
      this.memory.addHistory(this.user, `built ${id}: ${truncate(brief, 100)}`);
    } catch {}
    return r;
  }

  // Asks the generator for one fix after a runtime error, then restarts the program. Returns false if no fix
  // was attempted (unknown id, already fixed once, generator failed).
  async tryFixProgram(id, error, { returnResult = false } = {}) {
    const prog = id && this.programs.get(String(id));
    if (!prog || prog.fixed) return false;
    prog.fixed = true;
    this.status('Fixing a bug...');
    let fix;
    try {
      fix = await this.codegen.fix({ brief: prog.brief, code: prog.code, error: String(error || 'unknown error').slice(0, 1000) });
    } catch (err) {
      this.log({ fixError: err.message });
      return false;
    }
    this.trace.push({ kind: 'codefix', id, ok: fix.ok, latencyMs: fix.latencyMs });
    if (!fix.ok) return false;
    prog.code = fix.code;
    const r = await this.callClient('run_code', { id, js: fix.code, at: prog.at });
    if (!returnResult) this.messages.push({ role: 'user', content: `[event] code_error: program "${id}" crashed (${truncate(error, 200)}); it was fixed automatically and restarted (${r.ok ? 'running' : 'failed again'}).` });
    if (!returnResult) this.status('');
    return returnResult ? r : true;
  }
}

function asObject(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  return { result: v };
}

function redactArgs(args) {
  if (!args) return args;
  const out = { ...args };
  if (typeof out.js === 'string') out.js = `[${out.js.length} chars]`;
  return out;
}

function summarizeResult(r) {
  if (!r || typeof r !== 'object') return r;
  const out = { ...r };
  if (out.image_b64) out.image_b64 = `[${String(out.image_b64).length} b64 chars]`;
  return out;
}
