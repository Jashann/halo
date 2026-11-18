// A small mock of the Aide server for the web e2e test: speaks the same WebSocket protocol, lets the test
// script tool calls step by step, and records everything the headset sends.
// Usage from a test:  const mock = await startMock(8790); await mock.callTool('look', {...}); ...
// Standalone (replays the cooking flow + a game whenever the client says something):  node mock-server.mjs 8790

import { WebSocketServer } from 'ws';

export async function startMock(port = 8790) {
  const wss = new WebSocketServer({ port });
  await new Promise((r) => wss.once('listening', r));
  const state = {
    socket: null,
    received: [],
    waiters: [],
    seq: 0,
  };
  const notify = () => {
    for (const w of [...state.waiters]) {
      const hit = state.received.find((m, i) => i >= w.from && w.match(m));
      if (hit) {
        state.waiters.splice(state.waiters.indexOf(w), 1);
        w.resolve(hit);
      }
    }
  };
  wss.on('connection', (ws) => {
    state.socket = ws;
    ws.on('message', (buf) => {
      let m;
      try {
        m = JSON.parse(String(buf));
      } catch {
        return;
      }
      state.received.push(m);
      notify();
    });
  });
  const api = {
    port,
    state,
    send(msg) {
      if (!state.socket) throw new Error('no client connected');
      state.socket.send(JSON.stringify(msg));
    },
    /** wait for a client message matching fn (searching from index `from`, default: everything so far) */
    waitFor(match, { timeout = 15000, from = 0 } = {}) {
      return new Promise((resolve, reject) => {
        const w = { match, resolve, from };
        state.waiters.push(w);
        notify();
        setTimeout(() => {
          if (state.waiters.includes(w)) {
            state.waiters.splice(state.waiters.indexOf(w), 1);
            reject(new Error('mock: timed out waiting for client message'));
          }
        }, timeout);
      });
    },
    async waitConnected(timeout = 20000) {
      return api.waitFor((m) => m.type === 'hello', { timeout });
    },
    waitEvent(name, opts) {
      return api.waitFor((m) => m.type === 'event' && m.name === name, opts);
    },
    /** send a tool_call and resolve with its tool_result */
    async callTool(name, args = {}, timeout = 20000) {
      const call_id = `c${++state.seq}`;
      const from = state.received.length;
      api.send({ type: 'tool_call', call_id, name, args });
      return api.waitFor((m) => m.type === 'tool_result' && m.call_id === call_id, { timeout, from });
    },
    close() {
      return new Promise((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      });
    },
  };
  return api;
}

/** The scripted cooking flow used by the e2e test and the standalone mock. */
export const COOKING_FLOW = [
  { status: 'Looking...' },
  { tool: 'look', args: { prompt: 'ingredients in the fridge' } },
  { say: 'I see carrots, broccoli, tomatoes and zucchini. How about a 20 minute veggie stir-fry?' },
  {
    tool: 'show_panel',
    args: {
      id: 'recipe',
      title: 'Veggie stir-fry',
      place: { near: 'left' },
      size: 'medium',
      spec: {
        subtitle: '20 minutes  |  serves 2',
        steps: ['Slice 2 carrots into thin coins', 'Cut the broccoli into florets', 'Heat 1 tbsp oil, high heat', 'Stir-fry 6 minutes, then soy sauce'],
        active_step: 0,
        buttons: [{ id: 'next', label: 'Next step' }, { id: 'show_cut', label: 'Show me the cut' }],
      },
    },
  },
  { tool: 'highlight', args: { id: 'board', target: { surface_id: '$table', offset: [0, 0, 0] }, label: 'Chop here', shape: 'zone', color: '#5ee6c4' } },
  { tool: 'ghost_hands', args: { motion: 'chop', at: { near: '$table', offset: [0, 0, 0] }, label: 'Claw grip: fingertips tucked' } },
  { tool: 'timer', args: { label: 'Stir-fry', seconds: 6, at: { near: '$table', offset: [0.3, 0, -0.05] } } },
  { status: '' },
];

// Standalone mode: replay the flow on every `say`/`audio`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 8790);
  const mock = await startMock(port);
  console.log(`mock Aide server on ws://localhost:${port}/ws`);
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    const i = mock.state.received.findIndex((m) => (m.type === 'say' || m.type === 'audio') && !m.__done);
    if (i < 0) return;
    mock.state.received[i].__done = true;
    busy = true;
    try {
      const room = await mock.callTool('room');
      const table = room.result?.work_surface ?? 'front';
      for (const step of COOKING_FLOW) {
        if (step.status !== undefined) mock.send({ type: 'status', text: step.status });
        if (step.say) mock.send({ type: 'say', text: step.say });
        if (step.tool) {
          const args = JSON.parse(JSON.stringify(step.args).replaceAll('$table', table));
          const r = await mock.callTool(step.tool, args);
          console.log(step.tool, r.ok ? 'ok' : `failed: ${JSON.stringify(r.result)}`);
          await new Promise((res) => setTimeout(res, 800));
        }
      }
    } catch (e) {
      console.log('flow error', e.message);
    }
    busy = false;
  }, 300);
}
