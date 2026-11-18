#!/usr/bin/env node
// Operator CLI for Halo.
//   node op.mjs watch <baseUrl>                       long-poll the inbox; append events to ./op_inbox.jsonl,
//                                                      save frames to ./op_frames/<frame_id>.jpg
//   node op.mjs send <baseUrl> '<json message>' [session]   send a protocol message (default session: latest)
// Token: env OPERATOR_TOKEN or ~/.halo_operator_token. It is never printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function token() {
  if (process.env.OPERATOR_TOKEN) return process.env.OPERATOR_TOKEN.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), '.halo_operator_token'), 'utf8').trim();
  } catch {
    console.error('No token: set OPERATOR_TOKEN or create ~/.halo_operator_token');
    process.exit(2);
  }
}

const [cmd, base0, arg, sessionArg] = process.argv.slice(2);
if (!cmd || !base0) {
  console.error("usage: op.mjs watch <baseUrl> | op.mjs send <baseUrl> '<json>' [session]");
  process.exit(2);
}
const base = base0.replace(/\/$/, '');
const auth = { Authorization: `Bearer ${token()}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function watch() {
  const inbox = path.resolve('op_inbox.jsonl');
  const frames = path.resolve('op_frames');
  const sinceFile = path.resolve('.op_since');
  fs.mkdirSync(frames, { recursive: true });
  let since = 0;
  try {
    since = Number(fs.readFileSync(sinceFile, 'utf8')) || 0;
  } catch {}
  console.error(`watching ${base} from seq ${since} -> ${inbox}`);
  for (;;) {
    try {
      const res = await fetch(`${base}/op/inbox?since=${since}&wait=25`, { headers: auth, signal: AbortSignal.timeout(60000) });
      if (!res.ok) {
        console.error(`inbox HTTP ${res.status}`);
        await sleep(res.status === 401 ? 10000 : 2000);
        continue;
      }
      const body = await res.json();
      if (body.last_seq < since) since = 0; // server restarted
      for (const ev of body.events) {
        const fid = ev.msg?.result?.frame_id;
        if (fid) {
          const f = await fetch(`${base}/op/frame/${fid}`, { headers: auth });
          if (f.ok) {
            const file = path.join(frames, `${fid}.jpg`);
            fs.writeFileSync(file, Buffer.from(await f.arrayBuffer()));
            ev.frame_file = file;
          }
        }
        fs.appendFileSync(inbox, JSON.stringify({ ...ev, sessions: undefined }) + '\n');
        since = Math.max(since, ev.seq);
      }
      if (body.events.length) fs.writeFileSync(sinceFile, String(since));
    } catch (e) {
      console.error(`inbox error: ${e.message}`);
      await sleep(2000);
    }
  }
}

async function send() {
  let message;
  try {
    message = JSON.parse(arg);
  } catch {
    console.error('message must be JSON');
    process.exit(2);
  }
  const res = await fetch(`${base}/op/send`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: sessionArg || 'latest', message }),
  });
  const text = await res.text();
  console.log(text);
  process.exit(res.ok ? 0 : 1);
}

if (cmd === 'watch') await watch();
else if (cmd === 'send') await send();
else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
