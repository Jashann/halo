# Halo: web (headset) app

Meta Immersive Web SDK app (`@iwsdk/core` 1.1.0, Vite) that runs in Quest Browser as `immersive-ar`. It talks to
`../server` over one WebSocket (protocol in `../ARCHITECTURE.md`, conventions in `../server/README.md`).

## Run

```
npm install
npm run dev:runtime          # https://localhost:8081, IWER emulator injected on localhost (Quest 3, kitchen room)
                             # add ?server=ws://localhost:8787/ws to talk to a local server
npm run build                # dist/ (served by the server; no emulator)
npm run build:emulator       # dist-emulator/: same app + IWER, for recording / e2e against the real server
npm run typecheck
```

URL parameters: `demo=1` (recording mode: sample frames, no debug UI, emulator controls hidden after Start; type
`__halo_demo_say('...')` in the console to speak to Halo), `onboarding=0` (skip the first-run hands-only card, shown once per browser otherwise), `server=` (ws/wss/http(s) URL or host:port; default same origin `/ws`), `samples=1` (always use the
bundled sample frames), `user=` (user id; default a random id kept in localStorage), `debug` (show the text dock
outside the emulator), `autostart`.

## Layout

```
src/index.ts            Start button: camera + mic first, then immersive-ar (hands, planes, meshes, hit test, anchors, local-floor)
src/app.ts              glue: one IWSDK system per frame, WebSocket handling, room model, tap-to-place
src/net/client.ts       protocol client with reconnect and outbox
src/tools/executor.ts   every agent tool (look, room, show/update/close_panel, highlight, ghost_hands, timer, run_code, stop_code, remember, recall, set_chips)
src/runtime/            generated-code runtime (`aide` API of server/src/prompts/runtime_api.md), physics, spawn helpers, built-in examples (golf, engine, agent map)
src/ui/                 Halo look (theme, glow, springs, sounds), panels (UIKitML cards + layout solver, Lucide icon subset), chip bar, wrist talk button, orb + speech bubble, highlights, ghost hands, timers, labels, sounds
src/shell/              camera/mic, push-to-talk recorder, hand joints + pinch, room surfaces, placement
public/samples/         sample camera frames (CC0, see SOURCES.md)
public/models/hands/    WebXR generic hand models (MIT, see SOURCES.md) for the demonstration hands
```

Tests live in `../tests/web` (`npm test` and `npm run e2e` from here, or `npm run unit` / `npm run e2e` there).
