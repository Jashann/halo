# Halo

An assistant that lives in your Meta Quest 3. It sees through the headset camera, knows the surfaces in your room,
follows your hands, and builds whatever the moment needs: recipe cards and timers in your kitchen, glowing hands that
demonstrate a technique, games written on the spot for your table, 3D models you pull apart to learn how things work,
and a map of your AI agents you reorganise by dragging. Hands only, no controller.

**Try it:** open https://halo-955819688070.us-central1.run.app in the Meta Quest Browser on a Quest 3.
1. Settings > Privacy & safety > Browser > Headset cameras: On (so Halo can see; without it Halo uses a sample photo).
2. Tap Start, allow camera and microphone, then "Got it".
3. Pinch and hold the "Hold to talk" chip to speak, or poke a suggestion. Try "What can I cook?", "Make me a game",
   "Explain how an engine works", "Organise my work", or anything else.
For best placement, run Space Setup on the Quest first; without it Halo places things in front of you.

## How it works
- **Headset (web/):** a WebXR app built with Meta's Immersive Web SDK in Quest Browser (immersive-ar passthrough, hand
  tracking, plane and mesh detection, hit test, anchors). It executes the agent's tool calls: panels, highlights,
  demonstration hands, timers, camera looks, and agent-written programs in a sandboxed runtime.
- **Agent (server/):** a Node server running the agent loop on Meta's Muse models through the Meta Model API: Muse Ember
  sees and decides through tool calls, Muse Spark writes code for games and explanations (validated before it runs),
  Muse Voice Transcribe turns speech into text. It also serves the web app, keeps a small per-user memory and enforces
  cost limits.
- Details: docs/ARCHITECTURE.md, server/README.md, deploy/DEPLOY.md.

## Run it locally
```
cd web && npm ci && npm run build
cd ../server && npm ci && META_API_KEY=<your key> npm start   # serves web/dist and the agent on :8787
```
For development in Meta's IWER emulator: `cd web && npm run dev:runtime` (see web/README.md if present).

## Tests
`cd server && npm test` (mock model, no network) and `cd tests/web && npm run unit && npm run e2e` (IWER emulator).

## Credits and licences
WebXR hand models from @webxr-input-profiles/assets (MIT). Sample photos are CC0 (web/public/samples/SOURCES.md).
Icons from Lucide (ISC). Built with Meta's Immersive Web SDK and three.js.
