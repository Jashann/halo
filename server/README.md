# Halo server

One Node process that serves the built web app (`../web/dist`) and runs the agent over a WebSocket on the same
port. The Meta API key stays on the server; the headset only ever sees tool calls, speech lines and status text.

## Run

```
cd server
npm install
npm start                      # http://localhost:8787, WebSocket on any path of the same port
```

| env | default | meaning |
|---|---|---|
| `PORT` / `HOST` | 8787 / 0.0.0.0 | listen address |
| `SSL_CERT`, `SSL_KEY` | unset | PEM paths; when both are set the server speaks HTTPS/WSS (needed for WebXR off localhost) |
| `META_API_KEY` | `~/.meta_api_key` | Meta Model API key (never logged, never sent to the client) |
| `WEB_DIST` | `../web/dist` | static files |
| `AIDE_DATA_DIR` | `server/data` | per-user memory JSON files |
| `AIDE_AGENT_MODEL` | `muse-ember-1.0` | agent loop model (vision + tools) |
| `AIDE_AGENT_REASONING` | `low` | reasoning_effort for the agent; empty string for the model default |
| `AIDE_AGENT_FALLBACK_MODEL` | unset | second model tried when the first fails |
| `AIDE_CODEGEN_MODEL` / `_FALLBACK_MODEL` | `muse-spark-1.3` / `muse-ember-1.0` | run_code program writer |
| `AIDE_TOOL_TIMEOUT_MS` | 15000 | wait for a tool_result (look and run_code: 20000) |
| `AIDE_GREET` | on | `0` disables the greeting turn after `hello` |
| `AIDE_MODEL_PER_MIN` / `_PER_SESSION` | 20 / 300 | cost guard: agent model calls per connection |
| `AIDE_CODEGEN_PER_SESSION` | 8 | cost guard: codegen calls per connection (a repair or fix counts) |
| `AIDE_TRANSCRIBE_PER_MIN` | 12 | cost guard: voice clips per connection |
| `AIDE_GLOBAL_MODEL_PER_MIN` / `AIDE_GLOBAL_CODEGEN_PER_HOUR` | 300 / 150 | cost guard: per process (about 10 people at once) |
| `AIDE_MAX_SESSIONS` / `AIDE_MAX_SESSIONS_PER_IP` | 40 / 4 | connection caps (IP from `x-forwarded-for`) |

When a limit is hit the agent says so in one line (and run_code falls back to panels); nothing is queued up to
run later.

`GET /health` returns `{ok, uptimeS, sessions, models, keyConfigured, web}`.

## Protocol notes (beyond ARCHITECTURE.md)

- `status` with `text: ""` means the agent is idle again (end of a turn).
- `heard` may carry `error` when transcription failed; the agent then also says so.
- `look` result: `{image_b64, sample?, sample_name?, width?, height?}`. `image_b64` may be bare base64 or a
  `data:image/jpeg;base64,` URI. Set `sample: true` when the frame is a bundled sample; the agent then tells the
  user it is a sample photo.
- `run_code`: the model sends a brief, the server writes the program with Spark, validates it, and the client
  receives `{id, js, at}`. If the program throws, report it either as `tool_result {ok:false, result:{error}}` or
  as `event code_error {id, error}`. The server asks for one fix and sends a new `run_code` with the same id.
  `aide.done(summary)` should be sent as `event code_done {id, summary}`.
- Panel buttons: `event panel_button {panel_id, button_id}`. Timers: `event timer_done {label}`.
- `remember` / `recall` run on the server and never reach the client.
- `set_chips {chips: string[]}` runs in the headset (2 to 4 suggestion chips; a chip press comes back as `say`).
  The server may also push `{type: "chips", chips}` directly.
- Workspace: the agent builds an agent map with `run_code`; the program calls `aide.emit('task_moved', {task, to, from})`,
  which the headset forwards as `event task_moved`, and the agent answers it. `aide.emit(name, data)` must exist in
  the web runtime for this (see Example 3 in `src/prompts/runtime_api.md`).
- The generated runtime API the programs are written against is in `src/prompts/runtime_api.md` (signatures plus
  two full example programs). The web runtime should implement exactly that surface.

## Speech

`/v1/audio/transcriptions` does not exist on api.meta.ai (404). The working endpoint, found by probing, is
`POST /v1/asr/transcribe` with multipart parts `request` (JSON `{"model":"muse-voice-transcribe-1.0","audioEncoding":"WAV"}`)
and `audio`. Accepted encodings: `WAV` (16-bit PCM) and `OGG_OPUS`. WebM/Opus from Chromium's MediaRecorder is
rejected, so the server remuxes it to Ogg with ffmpeg (installed in the Docker image). Send `audio/wav` or
`audio/ogg` to skip ffmpeg. No TTS: speech lines are text bubbles.

## Tests

```
npm test                                     # mock model + fake ws client, no network
npm run test:live                            # one cooking run against the Meta API (writes tests/server/live_cooking_transcript.json)
AIDE_LIVE_CODEGEN=1 npm run test:live        # plus one Spark codegen call (writes tests/server/live_codegen_golf.js)
```

## Deploy

Cloud Run steps (Cloud Build, Secret Manager, budget) are in `../deploy/DEPLOY.md`.

## Docker

```
cd ..   # jarvis-vr root
docker build -f server/Dockerfile -t halo .
docker run -p 8080:8080 -e META_API_KEY=... halo
```
The web stage uses Node 22 (the IWSDK app needs 22.12+); the runtime image is Node 20 slim with ffmpeg.
