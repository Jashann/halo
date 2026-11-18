// Frame-rate check in the IWER emulator with a busy scene: three panels, looping ghost hands, a highlight, a
// timer and the golf game running. Chromium runs with vsync and the frame-rate limit off, so the number is what
// the app can sustain rather than the desktop display rate. Also records per-frame CPU time (Halo's update and
// the three.js render call) and draw calls. Results: tests/web/perf-results.json.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from '../mock-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const API_MD = path.resolve(here, '../../../server/src/prompts/runtime_api.md');
const [GOLF_JS] = [...fs.readFileSync(API_MD, 'utf8').matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
const PORT = 8791;

test.use({
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  },
});

test('busy scene holds 72+ fps in the emulator', async ({ page }) => {
  const mock = await startMock(PORT);
  try {
    await page.goto(`/?demo=1&samples=1&server=ws://localhost:${PORT}/ws&user=perf`);
    await page.waitForFunction(() => !!window.__aide && !!window.IWER_DEVICE);
    await page.evaluate(() => (window.IWER_DEVICE.primaryInputMode = 'hand'));
    await page.click('#start-btn');
    await page.waitForFunction(() => !!window.__aide.world.session, null, { timeout: 15000 });
    await page.evaluate(async () => {
      const R = window.IWER_DEVICE.remote;
      await R.dispatch('set_transform', { device: 'headset', position: { x: -0.28, y: 1.28, z: -0.42 } });
      await R.dispatch('look_at', { device: 'headset', target: { x: -0.28, y: 0.95, z: -1.25 } });
    });
    await mock.waitConnected();
    const table = (await mock.callTool('room')).result.work_surface;
    // the game first: starting a program clears the previous topic's UI, so the panels and hands come after it
    const steps = [
      ['run_code', { id: 'golf', js: GOLF_JS, at: { near: table } }],
      ['show_panel', { id: 'recipe', title: 'Veggie stir-fry', place: { near: 'left' }, spec: { icon: 'chef-hat', steps: ['Slice', 'Chop', 'Heat', 'Stir-fry'], active_step: 0, buttons: [{ id: 'next', label: 'Next step' }] } }],
      ['show_panel', { id: 'list', title: 'Shopping list', place: { near: 'front' }, size: 'small', spec: { checklist: [{ label: 'Soy sauce', done: true }, { label: 'Ginger' }] } }],
      ['show_panel', { id: 'tip', title: 'Tip', place: { near: 'right' }, size: 'small', spec: { text: 'Keep the knife tip on the board.' } }],
      ['highlight', { id: 'z', target: { surface_id: table }, label: 'Chop here', shape: 'zone' }],
      ['ghost_hands', { motion: 'chop', at: { near: table }, label: 'Claw grip', loop: true }],
      ['timer', { label: 'Rice', seconds: 600, at: { near: table, offset: [0.3, 0, 0] } }],
    ];
    for (const [name, args] of steps) expect((await mock.callTool(name, args)).ok, name).toBe(true);
    mock.send({ type: 'say', text: 'Everything is running: recipe, list, tip, demo hands, a timer and a game.' });
    await page.waitForTimeout(1500);

    const res = await page.evaluate(async () => {
      const { app, world } = window.__aide;
      const r = world.renderer;
      let renderMs = 0;
      let haloMs = 0;
      let calls = 0;
      let tris = 0;
      let renders = 0;
      const origRender = r.render.bind(r);
      r.render = (s, c) => {
        const t0 = performance.now();
        origRender(s, c);
        renderMs += performance.now() - t0;
        calls += r.info.render.calls;
        tris += r.info.render.triangles;
        renders++;
      };
      const origFrame = app.frame.bind(app);
      app.frame = (dt, t) => {
        const t0 = performance.now();
        origFrame(dt, t);
        haloMs += performance.now() - t0;
      };
      const stamps = [];
      const off = world.onXRFrame(() => stamps.push(performance.now()));
      await new Promise((res) => setTimeout(res, 6000));
      off();
      r.render = origRender;
      app.frame = origFrame;
      const iv = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b);
      const q = (p) => iv[Math.min(iv.length - 1, Math.floor(p * iv.length))];
      const frames = stamps.length - 1;
      const secs = (stamps[stamps.length - 1] - stamps[0]) / 1000;
      return {
        frames,
        seconds: +secs.toFixed(2),
        fps_avg: +(frames / secs).toFixed(1),
        frame_ms_p50: +q(0.5).toFixed(2),
        frame_ms_p95: +q(0.95).toFixed(2),
        frame_ms_p99: +q(0.99).toFixed(2),
        halo_update_ms_avg: +(haloMs / frames).toFixed(2),
        render_call_ms_avg: +(renderMs / Math.max(1, renders)).toFixed(2),
        draw_calls_avg: Math.round(calls / Math.max(1, renders)),
        triangles_avg: Math.round(tris / Math.max(1, renders)),
        panels: app.panels.list().length,
        programs: [...app.runtime.programs.keys()],
        ghost_active: app.ghost.active,
      };
    });
    fs.writeFileSync(path.resolve(here, '../perf-results.json'), JSON.stringify({ when: new Date().toISOString(), scene: 'kitchen, 3 panels, ghost hands loop, highlight, timer, golf', ...res }, null, 2));
    console.log('PERF', JSON.stringify(res));
    expect(res.programs).toContain('golf');
    expect(res.ghost_active).toBe(true);
    expect(res.fps_avg).toBeGreaterThanOrEqual(72);
    expect(res.frame_ms_p95).toBeLessThan(1000 / 72);
  } finally {
    await mock.close();
  }
});
