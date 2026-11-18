// HTTP(S) server: static web app, /health, and the agent WebSocket (any path upgrades).
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig } from './config.js';
import { buildModelClient } from './model.js';
import { MemoryStore } from './memory.js';
import { Transcriber } from './speech.js';
import { Session } from './agent.js';
import { GlobalGuard, SessionGuard } from './guard.js';
import { OperatorHub, OperatorSession } from './operator.js';

export { WebSocket };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.uikitml': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(root, req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const rootAbs = path.resolve(root);
  let file = path.resolve(rootAbs, '.' + urlPath);
  if (file !== rootAbs && !file.startsWith(rootAbs + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  let stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    file = path.join(file, 'index.html');
    stat = fs.statSync(file, { throwIfNoEntry: false });
  }
  if (!stat) {
    // SPA fallback for extension-less routes
    if (!path.extname(urlPath)) {
      file = path.join(rootAbs, 'index.html');
      stat = fs.statSync(file, { throwIfNoEntry: false });
    }
    if (!stat) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end(fs.existsSync(rootAbs) ? 'Not found' : 'Web app not built (web/dist missing)');
      return;
    }
  }
  const ext = path.extname(file).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers).end();
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

// deps can override: models, codegen, memory, transcriber (tests pass mocks).
export function createHaloServer(overrides = {}, deps = {}) {
  const config = loadConfig(overrides);
  const log =
    deps.log ||
    ((o) => {
      if (process.env.AIDE_QUIET !== '1') console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
    });
  const models = deps.models || buildModelClient(config, { log });
  const codegen = deps.codegen || null; // null: each session builds one on its guarded model client
  const globalGuard = new GlobalGuard(config);
  const perIp = new Map();
  const operator = new OperatorHub({ token: config.operatorToken, log });
  const memory = deps.memory || new MemoryStore(config.dataDir);
  const transcriber =
    deps.transcriber !== undefined
      ? deps.transcriber
      : new Transcriber({ baseUrl: config.apiBase, apiKey: config.apiKey, model: config.transcribeModel });
  const started = Date.now();
  const sessions = new Set();

  const handler = async (req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/op/')) {
      await operator.handle(req, res);
      return;
    }
    if (url === '/health' || url.startsWith('/health?')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          ok: true,
          uptimeS: Math.round((Date.now() - started) / 1000),
          sessions: sessions.size,
          models: { agent: config.agentModel, codegen: config.codegenModel, transcribe: config.transcribeModel },
          keyConfigured: Boolean(config.apiKey),
          operator: operator.enabled,
          web: fs.existsSync(path.join(config.webDist, 'index.html')),
        })
      );
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    serveStatic(config.webDist, req, res);
  };

  const useTls = config.sslCert && config.sslKey;
  const server = useTls
    ? https.createServer({ cert: fs.readFileSync(config.sslCert), key: fs.readFileSync(config.sslKey) }, handler)
    : http.createServer(handler);

  const wss = new WebSocketServer({ server, maxPayload: 10 * 1024 * 1024 });
  wss.on('connection', (ws, req) => {
    const send = (msg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (sessions.size >= config.maxSessions || (perIp.get(ip) || 0) >= config.maxSessionsPerIp) {
      send({ type: 'say', text: 'Halo is full right now. Please try again in a few minutes.' });
      ws.close(1013, 'busy');
      return;
    }
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    let isOp = false;
    try {
      isOp = new URL(req.url || '/', 'http://x').searchParams.has('op') && operator.enabled;
    } catch {}
    const session = isOp
      ? new OperatorSession({ hub: operator, send, transcriber, guard: new SessionGuard(config, globalGuard), log })
      : new Session({ send, models, codegen, memory, transcriber, config, log, globalGuard });
    sessions.add(session);
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        send({ type: 'error', text: 'invalid JSON' });
        return;
      }
      Promise.resolve(session.handle(msg)).catch(() => {});
    });
    ws.on('close', () => {
      session.close();
      sessions.delete(session);
      const n = (perIp.get(ip) || 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    });
    ws.on('error', () => {});
  });

  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  ping.unref();

  return {
    config,
    operator,
    server,
    wss,
    sessions,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      clearInterval(ping);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => wss.close(() => server.close(() => resolve())));
    },
  };
}
