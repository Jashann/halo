# Halo: architecture

An agent that lives in a Meta Quest 3 mixed reality session. It sees what you see (passthrough camera), knows your
room (planes, meshes, anchors), follows your hands, and builds its own interface on the spot: floating panels,
highlights on real surfaces, demonstration hands, timers, mini-games and 3D explanations that it writes itself.
Fully autonomous: it decides what to show and when; the person only talks, looks and uses their hands.

Meta VR Start Developer Competition 2026 entry, track Productivity, New Experience division,
Must be fully usable
with hands only, seated-friendly, a complete moment in under 10 minutes, 60+ fps on Quest 3.

## Platform facts 
- Meta Immersive Web SDK (IWSDK, @iwsdk/core 1.1.x, `npm create @iwsdk@latest`), three.js under it, ECS.
- Meta Quest Browser WebXR `immersive-ar` (passthrough). Hands: pinch/poke/grab built in, 25 joints per hand.
- Scene understanding: planes and meshes with semantic labels (table, wall, ...), hit test, anchors (persist, 8/site).
- Passthrough camera: `navigator.mediaDevices.getUserMedia` ("camera 1/2, facing back", 1280x960); IWSDK
  `features.camera`, `CameraSource`, `CameraUtils.captureFrame()`. Ask camera and mic BEFORE entering XR.
  Camera pixels are not pixel-aligned with the XR view (fine for "what is in this fridge").
- No eye tracking on Quest 3 (use head direction). No Web Speech API (speech goes to the server).
- Plain page HTML is not drawn inside XR: every UI is a 3D panel (IWSDK UIKit / UIKitML) or WebGL.

## Models (Meta Model API, https://api.meta.ai/v1, OpenAI-compatible chat/completions, key in ~/.meta_api_key)
- muse-ember-1.0: fast, vision + tool calling (~3 s). Default agent loop model.
- muse-spark-1.3: reasoning; use with reasoning_effort "low" and max_tokens >= 2000 for code generation
  (mini-games, 3D explanations, generated UI). Spark may skip tool calls: for code it returns code in content.
- muse-voice-transcribe-1.0: speech to text.
- The key never reaches the browser: the server proxies every call.

## Pieces

```
Quest Browser (WebXR page, IWSDK app)                     Server (Node 20, single process)
-----------------------------------------                 ------------------------------------------
Shell: session, hands, room, camera, mic   <--WebSocket-->  Agent loop (tool calling, Muse models)
Tool executor (runs the agent's tool calls)                 Tools schema + system prompt
Generated runtime (sandboxed agent code)                    Code generator (Spark) + validator
UI kit: panels from UIKitML/spec, highlights,               Vision helper (frames -> Ember)
  ghost hands, timers, toasts                               Speech: transcribe (Muse Voice Transcribe)
Fallbacks: sample camera frames, tap-to-place               Memory (per user: preferences, history)
                                                            Static hosting of the built web app
```

### Protocol (WebSocket, JSON messages)
Client -> server:
- `{type:"hello", user, capabilities:{camera, mic, planes, meshes, hands}, room:{surfaces:[{id,label,size,center}]}}`
- `{type:"say", text}` or `{type:"audio", mime, b64}` (server transcribes, echoes `{type:"heard", text}`)
- `{type:"tool_result", call_id, ok, result}` (frames come back as `result.image_b64` jpeg)
- `{type:"event", name, data}` (e.g. "item_placed", "timer_done", "game_score", "panel_button")
Server -> client:
- `{type:"tool_call", call_id, name, args}`: client executes and replies with tool_result
- `{type:"status", text}` (thinking indicator), `{type:"say", text}` (agent speech bubble; TTS optional)

### Agent tools (executed in the headset)
- `look(prompt?)`: capture a camera frame (or the sample frame), returns jpeg; server sends it to Ember.
- `room()`: surfaces with labels, sizes, positions; hands state.
- `show_panel(id, title, body_uikitml | spec, place: {near: surface_id|"front"|"left"|"right"}, size)`: the agent's own UI.
- `update_panel(id, patch)`, `close_panel(id)`.
- `highlight(target: {surface_id, offset} | {point}, label, color, shape: "ring"|"zone"|"arrow")`: mark real places
  ("chop here", "pan goes here", "stove: 230 C / 450 F").
- `ghost_hands(motion: "chop"|"dice"|"julienne"|"whisk"|"flip"|custom keyframes, at)`: demonstration hands beside you.
- `timer(label, seconds, at)`: a timer anchored to a place (the stove).
- `run_code(id, js, at)`: run agent-written code in the generated runtime (mini-games, 3D explanations, custom widgets).
- `stop_code(id)`, `remember(key, value)`, `recall(key)`.

### Generated runtime (the "it can build anything" part)
Agent-written JS runs via `new Function("aide", src)` inside a try/catch, with a frame-time budget and an
`aide` API only (no fetch, no DOM): `aide.THREE`, `aide.scene` (a sub-group it owns), `aide.hands` (joint
positions, pinch state), `aide.surfaces`, `aide.onFrame(fn)`, `aide.onPinch(fn)`, `aide.physics` (simple
built-in ball/box physics), `aide.spawn(kind, opts)` helpers (ball, cup, target, label, arrow, line, particle burst),
`aide.panel(spec)`, `aide.score(n)`, `aide.say(text)`, `aide.done()`. The server validates generated code (parse,
forbidden tokens), and the client kills code that throws or overruns its budget, reporting the error so the agent
can fix and retry once.

### Experiences in the build (each a few minutes, all hands only)
1. Cooking (hero): "what can I make?" -> look() at the fridge -> ingredient list -> recipe panel -> highlights on
   the counter and stove -> ghost hands demonstrate the cut -> timers by the stove -> look() at the pan:
   "not brown enough, 2 more minutes" / taste adjustments by question.
2. "Make me a game" (exercise): the agent writes a hands-only mini-game on the spot (e.g. golf into a cup on
   your table, catch targets) using `aide` helpers; it remembers you liked yesterday's game.
3. "Explain this": the agent builds a grabbable 3D explanation in the air (e.g. how an engine works, a
   concept from a document) and expands parts when you pinch them.
4. Workspace (vision in the video, light in the build): agent arranges a composite of panels; an agent map in the
   room with draggable agent cards (marketing, sales), using sample data.

### Input
Hands only. A wrist/palm "talk" button: pinch-and-hold to record voice (MediaRecorder -> server transcribe). For
people who cannot or will not talk: a floating chip bar of suggestions the agent writes for the moment ("What can
I cook?", "Make me a game", "Explain how this works"), pressed by poke. No controller, no keyboard needed.

### Fallbacks (emulator, rooms we never tested)
- Camera refused or unavailable: use bundled sample frames (fridge, pan) and say so in small text.
- No labelled table: tap-to-place with hit test; else a default spot in front of the seated user.
- Mic unavailable: chips only. Model slow: show status; never freeze the frame loop (all network async).

### Performance
72+ fps target (Quest 3): instanced geometry, few draw calls, panels reused, camera capture at most every 2 s and
only on look(), generated code budget per frame, foveation tuned so text stays sharp.

### Repo layout
```
halo/
  web/       IWSDK app (Vite), src/shell, src/tools, src/runtime, src/ui, public/samples
  server/    Node 20: ws server, agent loop, tools schema, prompts, codegen, vision, speech, memory, static
  tests/     server unit tests (mock model), web runtime tests, Playwright e2e in the IWER emulator
  scripts/   record_demo.mjs (emulator capture), deploy notes
  docs/      how to try it, architecture
```

### Testing without a headset
- Server: unit tests with a mock model that returns scripted tool calls; one live smoke test against Meta API.
- Web: the runtime and tool executor tested in Node/jsdom where possible; full flows in Playwright with IWER
  (IWSDK's emulator, hands mode, sample AR rooms) and the sample camera frames; screenshots per step.

### Deployment
One container (server + built web app) on Cloud Run, HTTPS, min instances 0; see deploy/DEPLOY.md.
