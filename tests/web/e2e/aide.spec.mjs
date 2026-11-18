// End-to-end: the Halo web app in the IWER emulator (Quest 3, hands mode, kitchen room) in recording mode
// (?demo=1) against a mock server that replays the cooking flow (look -> show_panel -> highlight -> ghost_hands
// -> timer), several panels at once (layout), and three run_code programs from runtime_api.md (golf, engine,
// agent map with a real emulated-hand drag). Screenshots go to tests/web/shots/v3-*.png. No console errors.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, COOKING_FLOW } from '../mock-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(here, '../shots');
const API_MD = path.resolve(here, '../../../server/src/prompts/runtime_api.md');
const PORT = 8790;

const [GOLF_JS, ENGINE_JS, AGENTMAP_JS] = [...fs.readFileSync(API_MD, 'utf8').matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);

/** Screen-space rectangles of every open panel and the speech bubble; returns overlapping pairs. */
async function overlapsOnScreen(page) {
  return page.evaluate(() => {
    const { app, world } = window.__aide;
    const THREE_Box = app.root.constructor; // not used; keep page code free of imports
    void THREE_Box;
    const cam = world.renderer.xr.isPresenting ? world.renderer.xr.getCamera() : world.camera;
    const rects = [];
    // project the four corners of a w x h rectangle centred on obj (in obj's local XY plane)
    const project = (obj, w, h) => {
      obj.updateMatrixWorld(true);
      const pts = [];
      for (const x of [-w / 2, w / 2]) for (const y of [-h / 2, h / 2]) {
        const v = obj.localToWorld(obj.position.clone().set(x, y, 0));
        v.project(cam);
        pts.push(v);
      }
      return { x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)) };
    };
    for (const r of app.panels.recs.values()) {
      if (r.closing || !r.doc) continue;
      const sc = r.holder.scale.x || 1;
      rects.push({ id: r.id, ...project(r.holder, r.width / sc, r.height / sc) });
    }
    const bb = app.orb.bubbleBox();
    if (!bb.isEmpty()) {
      const pts = [];
      for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) pts.push(bb.min.clone().set(x, y, z).project(cam));
      rects.push({ id: 'bubble', x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)) });
    }
    const bad = [];
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ox > 0.01 && oy > 0.01) bad.push(`${a.id}/${b.id}`);
      }
    return { rects: rects.map((r) => r.id + ':' + [r.x0, r.x1, r.y0, r.y1].map((v) => v.toFixed(2)).join(',')), bad };
  });
}

test('Halo v3: cooking flow, layout, golf, engine and agent map in the emulator', async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const mock = await startMock(PORT);
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const shot = async (name, wait = 350) => {
    await page.waitForTimeout(wait);
    await page.screenshot({ path: path.join(SHOTS, `v3-${name}.png`) });
  };
  const pose = (position, target) =>
    page.evaluate(
      async ([position, target]) => {
        const R = window.IWER_DEVICE.remote;
        await R.dispatch('set_transform', { device: 'headset', position });
        await R.dispatch('look_at', { device: 'headset', target });
      },
      [position, target],
    );
  const SEAT = { x: -0.28, y: 1.28, z: -0.42 };
  const ISLAND = { x: -0.28, y: 0.95, z: -1.25 };

  try {
    await page.goto(`/?demo=1&samples=1&server=ws://localhost:${PORT}/ws&user=e2e`);
    await page.waitForFunction(() => !!window.__aide && !!window.IWER_DEVICE);
    await page.waitForTimeout(600);
    await shot('00-start', 0);
    await page.evaluate(() => (window.IWER_DEVICE.primaryInputMode = 'hand'));
    await page.click('#start-btn');
    await page.waitForFunction(() => !!window.__aide.world.session, null, { timeout: 15000 });
    await pose(SEAT, ISLAND);
    const hello = await mock.waitConnected();
    expect(hello.capabilities.hands).toBe(true);
    expect(hello.capabilities.camera).toBe(false); // demo mode uses the sample frames
    expect(hello.room.surfaces.some((s) => s.label === 'table')).toBe(true);
    mock.send({ type: 'say', text: "Hi, I'm Halo. Ask me what you can cook, or press a suggestion." });
    mock.send({ type: 'status', text: '' });
    await shot('01-ready', 900);
    // first-run onboarding: shown once, dismissed with "Got it"
    expect(await page.evaluate(() => window.__aide.app.panels.has('__onboarding'))).toBe(true);
    await page.evaluate(() => window.__aide.app.panels.press('__onboarding', 'ok'));
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__aide.app.panels.has('__onboarding'))).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem('halo.onboarded'))).toBe('1');

    // the user asks (in demo mode there is no dock: same path as a chip press)
    await page.evaluate(() => window.__halo_demo_say('What can I cook?'));
    expect((await mock.waitFor((m) => m.type === 'say')).text).toBe('What can I cook?');
    const room = await mock.callTool('room');
    const table = room.result.work_surface;

    const names = { show_panel: '02-recipe', highlight: '03-highlight', ghost_hands: '04-ghost-hands', timer: '05-timer' };
    for (const step of COOKING_FLOW) {
      if (step.status !== undefined) mock.send({ type: 'status', text: step.status });
      if (step.say) mock.send({ type: 'say', text: step.say });
      if (!step.tool) continue;
      const args = JSON.parse(JSON.stringify(step.args).replaceAll('$table', table));
      if (step.tool === 'show_panel') args.spec.icon = 'chef-hat';
      const r = await mock.callTool(step.tool, args);
      expect(r.ok, `${step.tool}: ${JSON.stringify(r.result).slice(0, 300)}`).toBe(true);
      if (step.tool === 'look') {
        expect(r.result).toMatchObject({ sample: true, sample_name: 'fridge' });
        expect(Math.max(r.result.width, r.result.height)).toBeLessThanOrEqual(1024);
        continue;
      }
      await shot(names[step.tool], step.tool === 'ghost_hands' ? 1500 : 800);
      if (step.tool === 'ghost_hands') {
        // the hero angle: lean in toward the demonstration
        const g = await page.evaluate(() => window.__aide.app.ghost.group.getWorldPosition(window.__aide.app.ghost.group.position.clone()).toArray());
        await pose({ x: SEAT.x + (g[0] - SEAT.x) * 0.45, y: 1.2, z: SEAT.z + (g[2] - SEAT.z) * 0.45 }, { x: g[0], y: g[1] + 0.06, z: g[2] });
        await shot('04b-ghost-hands-hero', 1200);
        await pose(SEAT, ISLAND);
      }
    }

    // several panels at once: none overlap each other or the speech bubble
    mock.send({ type: 'say', text: 'I added your shopping list and a tip. Poke a step when you are ready.' });
    await mock.callTool('show_panel', { id: 'shopping', title: 'Shopping list', place: { near: 'front' }, size: 'small', spec: { icon: 'shopping-cart', checklist: [{ label: 'Soy sauce', done: true }, { label: 'Fresh ginger' }, { label: 'Sesame oil' }] } });
    await mock.callTool('show_panel', { id: 'tip', title: 'Claw grip', place: { near: 'right' }, size: 'small', spec: { icon: 'hand', text: 'Curl your fingertips under and guide the knife with your knuckles.' } });
    await page.waitForTimeout(1500); // let the solver and springs settle
    const ov = await overlapsOnScreen(page);
    expect(ov.rects.length).toBeGreaterThanOrEqual(3);
    await shot('06-panels-layout', 0);
    // look(view): Halo's own objects rendered from the head, alone and over the (unavailable) camera
    for (const view of ['virtual', 'mixed']) {
      const snap = await mock.callTool('look', { prompt: 'what did I place', view });
      expect(snap.ok, JSON.stringify(snap.result).slice(0, 200)).toBe(true);
      expect(snap.result).toMatchObject({ view, width: 1024, height: 768, sample: false });
      expect(snap.result.image_b64.length).toBeGreaterThan(20000);
      fs.writeFileSync(path.join(SHOTS, `v3-look-${view}.jpg`), Buffer.from(snap.result.image_b64, 'base64'));
      const ids = snap.result.scene_summary.map((x) => x.id);
      expect(ids).toEqual(expect.arrayContaining(['recipe', 'shopping', 'tip', 'board', 'ghost_hands', 'stir-fry', 'halo']));
      const recipe = snap.result.scene_summary.find((x) => x.id === 'recipe');
      expect(recipe.forward).toBeGreaterThan(0.3);
    }
    // the default look in sample mode is unchanged (the sample photo)
    const plain = await mock.callTool('look', { prompt: 'ingredients in the fridge' });
    expect(plain.result).toMatchObject({ sample: true, sample_name: 'fridge' });
    expect(Array.isArray(plain.result.scene_summary)).toBe(true);
    expect(ov.bad, JSON.stringify(ov)).toEqual([]);

    await page.evaluate(() => window.__aide.app.panels.press('recipe', 'next', 'Next step'));
    expect((await mock.waitEvent('panel_button')).data).toMatchObject({ panel_id: 'recipe', button_id: 'next' });
    expect((await mock.callTool('update_panel', { id: 'recipe', patch: { spec: { active_step: 1 } } })).ok).toBe(true);
    const done = await mock.waitEvent('timer_done', { timeout: 15000 });
    expect(done.data.label).toBe('Stir-fry');
    await shot('07-timer-done', 300);

    // follow: turn far away; view panels come round after a moment
    const before = await page.evaluate(() => window.__aide.app.panels.recs.get('shopping').home.toArray());
    await pose(SEAT, { x: 2.0, y: 1.0, z: -0.42 });
    await page.waitForTimeout(2600);
    const after = await page.evaluate(() => window.__aide.app.panels.recs.get('shopping').home.toArray());
    expect(after[0]).toBeGreaterThan(before[0] + 0.3);
    await pose(SEAT, ISLAND);
    await page.waitForTimeout(2600);

    for (const id of ['recipe', 'shopping', 'tip']) await mock.callTool('close_panel', { id });
    await mock.callTool('ghost_hands', { motion: 'stop', at: { near: 'front' } });
    await mock.callTool('highlight', { id: 'board', shape: 'off', target: {}, label: '' });

    // golf
    const golf = await mock.callTool('run_code', { id: 'golf', js: GOLF_JS, at: { near: table } });
    expect(golf.ok, JSON.stringify(golf.result)).toBe(true);
    await shot('08-golf', 900);
    await page.evaluate(() => {
      const p = window.__aide.app.runtime.programs.get('golf');
      const ball = [...p.spawned].find((o) => o.userData.kind === 'ball');
      const cup = [...p.spawned].find((o) => o.userData.kind === 'cup');
      const dir = cup.position.clone().sub(ball.position);
      dir.y = 0;
      const d = dir.length();
      ball.body.velocity.copy(dir.normalize().multiplyScalar(Math.sqrt(2 * 0.7 * 1.2 * d) + 0.15));
    });
    expect((await mock.waitEvent('game_score', { timeout: 10000 })).data).toMatchObject({ id: 'golf' });
    await shot('09-golf-scored', 200);
    await mock.callTool('stop_code', { id: 'golf' });

    // engine
    const engine = await mock.callTool('run_code', { id: 'engine', js: ENGINE_JS, at: { near: table } });
    expect(engine.ok, JSON.stringify(engine.result)).toBe(true);
    await shot('10-engine', 1500);
    await mock.callTool('stop_code', { id: 'engine' });

    // agent map: drag a task card to another agent with the emulated right hand
    const map = await mock.callTool('run_code', { id: 'agentmap', js: AGENTMAP_JS, at: { near: table } });
    expect(map.ok, JSON.stringify(map.result)).toBe(true);
    await shot('11-agent-map', 1200);
    const pts = await page.evaluate(() => {
      const p = window.__aide.app.runtime.programs.get('agentmap');
      const card = [...p.spawned].filter((o) => o.userData.kind === 'box' && Math.abs(o.scale.x - 0.11) < 1e-6)[0];
      const from = card.getWorldPosition(card.position.clone()).toArray();
      const to = p.scene.localToWorld(card.position.clone().set(0.1, 0.06, -0.22)).toArray();
      return { from, to };
    });
    const hand = (p, pinch) =>
      page.evaluate(
        async ([p, pinch]) => {
          const d = window.IWER_DEVICE;
          await d.remote.dispatch('set_transform', { device: 'hand-right', position: { x: p[0], y: p[1], z: p[2] }, anchor: 'index-tip' });
          d.hands.right.updatePinchValue(pinch);
        },
        [p, pinch],
      );
    await hand([pts.from[0], pts.from[1] + 0.01, pts.from[2]], 0);
    await page.waitForTimeout(300);
    await hand([pts.from[0], pts.from[1] + 0.01, pts.from[2]], 1);
    await page.waitForTimeout(400);
    for (let k = 1; k <= 6; k++) {
      const f = k / 6;
      await hand([pts.from[0] + (pts.to[0] - pts.from[0]) * f, pts.from[1] + 0.05 * Math.sin(Math.PI * f) + 0.01, pts.from[2] + (pts.to[2] - pts.from[2]) * f], 1);
      await page.waitForTimeout(120);
    }
    await shot('12-agent-map-drag', 100);
    // drop targets glow while dragging, the nearest brightest
    const rings = await page.evaluate(() => window.__aide.app.runtime.programs.get('agentmap').dropRings.filter((r) => r.visible).map((r) => +r.material.opacity.toFixed(2)));
    expect(rings.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...rings)).toBeGreaterThan(0.9);
    await hand(pts.to, 0);
    const moved = await mock.waitEvent('task_moved', { timeout: 8000 });
    expect(moved.data).toMatchObject({ task: 'Launch post', to: 'Research', from: 'Marketing' });
    await shot('13-task-moved', 500);

    const bad = await mock.callTool('run_code', { id: 'broken', js: 'aide.spawn("teapot", {});', at: { near: 'front' } });
    expect(bad.ok).toBe(false);
    expect(bad.result.error).toMatch(/unknown kind/);
    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await mock.close();
  }
});
