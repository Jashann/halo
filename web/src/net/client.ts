// WebSocket client for the Halo protocol, with reconnect and an outbox while disconnected.
// Client -> server: hello, say, audio, tool_result, event. Server -> client: tool_call, status, say, heard (+ chips).

export type ServerMessage =
  | { type: 'tool_call'; call_id: string; name: string; args?: Record<string, unknown> }
  | { type: 'status'; text?: string; state?: string }
  | { type: 'say'; text: string; audio_b64?: string; mime?: string }
  | { type: 'heard'; text: string }
  | { type: 'chips'; chips: string[] }
  | { type: 'error'; message?: string; text?: string }
  | { type: string; [k: string]: unknown };

export type ClientMessage =
  | { type: 'hello'; user: string; capabilities: Record<string, boolean>; room: { surfaces: unknown[] }; [k: string]: unknown }
  | { type: 'say'; text: string }
  | { type: 'audio'; mime: string; b64: string }
  | { type: 'tool_result'; call_id: string; ok: boolean; result: unknown }
  | { type: 'event'; name: string; data?: unknown };

/** ws(s) URL: `?server=` (full ws/wss/http/https URL or host:port) else same origin `/ws`. */
export function resolveServerUrl(loc: { protocol: string; host: string; search: string }): string {
  const base = resolveBaseUrl(loc);
  const op = new URLSearchParams(loc.search).get('op');
  if (op === null) return base;
  const u = new URL(base);
  u.searchParams.set('op', op || '1');
  return u.toString();
}

function resolveBaseUrl(loc: { protocol: string; host: string; search: string }): string {
  const q = new URLSearchParams(loc.search).get('server');
  if (q) {
    if (/^wss?:\/\//i.test(q)) return q;
    const u = new URL(/^https?:\/\//i.test(q) ? q : `${loc.protocol}//${q}`);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
    return u.toString();
  }
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`;
}

export interface ClientOptions {
  url: string;
  hello: () => ClientMessage;
  onMessage: (m: ServerMessage) => void;
  onState?: (s: 'connecting' | 'open' | 'closed') => void;
  WebSocketImpl?: typeof WebSocket;
}

export class AideClient {
  private ws: WebSocket | null = null;
  private outbox: string[] = [];
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  state: 'connecting' | 'open' | 'closed' = 'closed';
  sent: ClientMessage[] = []; // last few, for debugging / tests

  constructor(private opts: ClientOptions) {}

  connect() {
    this.closedByUser = false;
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WS(this.opts.url);
    } catch (e) {
      console.warn('[halo] websocket failed to open', e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setState('open');
      this.rawSend(JSON.stringify(this.opts.hello()));
      const pending = this.outbox.splice(0);
      for (const s of pending) this.rawSend(s);
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        console.warn('[halo] non-JSON message ignored');
        return;
      }
      try {
        this.opts.onMessage(msg);
      } catch (e) {
        console.warn('[halo] message handler failed', e);
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.setState('closed');
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; keep the console quiet (a missing server is a normal dev state)
    };
  }

  private setState(s: 'connecting' | 'open' | 'closed') {
    this.state = s;
    this.opts.onState?.(s);
  }

  private scheduleReconnect() {
    if (this.timer) return;
    const delay = Math.min(8000, 500 * Math.pow(1.7, this.retry++)) + Math.random() * 250;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private rawSend(s: string) {
    try {
      this.ws!.send(s);
    } catch {
      this.outbox.push(s);
    }
  }

  send(m: ClientMessage) {
    this.sent.push(m);
    if (this.sent.length > 50) this.sent.shift();
    const s = JSON.stringify(m);
    if (this.ws && this.ws.readyState === 1) this.rawSend(s);
    else {
      // keep the outbox bounded; drop the oldest audio first
      this.outbox.push(s);
      if (this.outbox.length > 40) this.outbox.shift();
    }
  }

  close() {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
  }
}
