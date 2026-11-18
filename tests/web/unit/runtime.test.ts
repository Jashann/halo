import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeRuntime, guardLoops } from '../../../web/src/runtime/runtime.js';
import { GOLF_JS, ENGINE_JS, AGENTMAP_JS } from '../../../web/src/runtime/examples.js';
import { fakeCtx, moveHand, FakePanels, THREE, type FakeCtx } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const API_MD = path.resolve(here, '../../../server/src/prompts/runtime_api.md');

function serverExamples(): string[] {
  const md = fs.readFileSync(API_MD, 'utf8');
  return [...md.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
}

function setup() {
  const ctx = fakeCtx();
  const panels = new FakePanels();
  const rt = new CodeRuntime(ctx, { panels, event: (n, d) => ctx.events.push({ name: n, data: d }), say: (t) => ctx.said.push(t) });
  return { ctx, rt, panels };
}

/** advance n frames of dt seconds */
function frames(ctx: FakeCtx, rt: CodeRuntime, n: number, dt = 1 / 72) {
  for (let i = 0; i < n; i++) {
    ctx.t += dt;
    rt.update(dt, ctx.t);
  }
}

async function run(ctx: FakeCtx, rt: CodeRuntime, id: string, js: string, at: unknown = { near: 'plane-1' }) {
  const pr = rt.run(id, js, at);
  frames(ctx, rt, 4);
  return pr;
}

describe('built-in examples match the server spec', () => {
  it('golf, engine and agent map are verbatim copies of runtime_api.md', () => {
    const [golf, engine, map] = serverExamples();
    expect(GOLF_JS).toBe(golf);
    expect(ENGINE_JS).toBe(engine);
    expect(AGENTMAP_JS).toBe(map);
  });
});

describe('golf example (from runtime_api.md)', () => {
  it('runs, places cup/ball on the table, says the instruction', async () => {
    const { ctx, rt } = setup();
    const r = await run(ctx, rt, 'golf', serverExamples()[0]);
    expect(r.ok).toBe(true);
    const p = rt.programs.get('golf')!;
    // the program origin sits on the table top
    expect(p.scene.position.y).toBeCloseTo(0.75, 3);
    expect(ctx.said[0]).toMatch(/Pinch the ball/);
    const ball = [...p.spawned].find((o) => o.userData.kind === 'ball')!;
    frames(ctx, rt, 72);
    // resting on the table (local y = radius), not fallen through
    expect(ball.position.y).toBeCloseTo(0.021, 2);
  });

  it('pinch the ball, pull back, release: the ball is putted and the stroke counted', async () => {
    const { ctx, rt } = setup();
    await run(ctx, rt, 'golf', serverExamples()[0]);
    const p = rt.programs.get('golf')!;
    const ball = [...p.spawned].find((o) => o.userData.kind === 'ball')!;
    frames(ctx, rt, 30);
    const R = ctx.hand('right');
    const ballWorld = ball.getWorldPosition(new THREE.Vector3());
    moveHand(R, ballWorld);
    frames(ctx, rt, 1);
    ctx.pinch('right', 'start');
    // pull back toward the user by 8 cm
    moveHand(R, ballWorld.clone().add(new THREE.Vector3(0, 0, 0.08)));
    frames(ctx, rt, 5);
    R.pinching = false;
    frames(ctx, rt, 2);
    expect(ball.position.z).toBeLessThan(0.12); // moving away from the user, toward the cup
    expect((ball as any).body.velocity.length()).toBeGreaterThan(0.1);
  });

  it('a ball rolled into the cup scores, and three holes finish with code_done', async () => {
    const { ctx, rt } = setup();
    await run(ctx, rt, 'golf', serverExamples()[0]);
    const p = rt.programs.get('golf')!;
    const ball = [...p.spawned].find((o) => o.userData.kind === 'ball')! as any;
    const cup = [...p.spawned].find((o) => o.userData.kind === 'cup')! as any;
    for (let hole = 0; hole < 3; hole++) {
      frames(ctx, rt, 10);
      // aim straight at the cup with a gentle putt
      const dir = cup.position.clone().sub(ball.position);
      dir.y = 0;
      const dist = dir.length();
      ball.body.velocity.copy(dir.normalize().multiplyScalar(Math.sqrt(2 * 0.7 * 1.2 * dist) + 0.15));
      frames(ctx, rt, 72 * 4);
    }
    const scores = ctx.events.filter((e) => e.name === 'game_score');
    expect(scores.length).toBe(3);
    const done = ctx.events.find((e) => e.name === 'code_done');
    expect(done?.data).toMatchObject({ id: 'golf' });
    expect(done?.data.summary).toMatch(/golf finished/);
  });
});

describe('engine example (from runtime_api.md)', () => {
  it('runs, animates the piston, pinching four parts ends with code_done', async () => {
    const { ctx, rt } = setup();
    const r = await run(ctx, rt, 'engine', serverExamples()[1]);
    expect(r.ok).toBe(true);
    const p = rt.programs.get('engine')!;
    const root = p.scene.children.find((c) => c.type === 'Group' && c.children.length >= 7)!;
    const piston = root.children[1];
    const y0 = piston.position.y;
    frames(ctx, rt, 60);
    expect(piston.position.y).not.toBeCloseTo(y0, 4);
    // pinch the spark plug, valves and crank (positions are in program-local coordinates)
    const R = ctx.hand('right');
    for (const idx of [6, 4, 5, 0]) {
      const world = root.children[idx].getWorldPosition(new THREE.Vector3());
      moveHand(R, world);
      frames(ctx, rt, 1);
      ctx.pinch('right', 'start');
      ctx.pinch('right', 'end');
      frames(ctx, rt, 2);
    }
    expect(ctx.said.some((s) => /spark/i.test(s))).toBe(true);
    const done = ctx.events.find((e) => e.name === 'code_done');
    expect(done?.data.summary).toMatch(/engine explanation/);
  });
});

describe('agent map example (from runtime_api.md)', () => {
  it('pinch a task card, drop it on another agent: task_moved {task, to, from} is emitted', async () => {
    const { ctx, rt } = setup();
    const r = await run(ctx, rt, 'agentmap', serverExamples()[2]);
    expect(r.ok, JSON.stringify(r.result)).toBe(true);
    expect(ctx.said[0]).toMatch(/agents/i);
    const p = rt.programs.get('agentmap')!;
    // the first white card belongs to Marketing (x = -0.3); the Research pad is at x = 0.1
    const cards = [...p.spawned].filter((o) => o.userData.kind === 'box' && Math.abs(o.scale.x - 0.11) < 1e-6);
    expect(cards.length).toBe(6);
    const card = cards[0];
    const R = ctx.hand('right');
    moveHand(R, card.getWorldPosition(new THREE.Vector3()));
    frames(ctx, rt, 1);
    ctx.pinch('right', 'start');
    frames(ctx, rt, 2);
    // carry it over the Research pad (local x 0.1, z -0.28 + 0.06)
    const target = p.scene.localToWorld(new THREE.Vector3(0.1, 0.05, -0.22));
    moveHand(R, target);
    frames(ctx, rt, 3);
    expect(card.position.x).toBeCloseTo(0.1, 2);
    R.pinching = false;
    frames(ctx, rt, 2);
    const ev = ctx.events.find((e) => e.name === 'task_moved');
    expect(ev?.data).toEqual({ task: 'Launch post', to: 'Research', from: 'Marketing' });
    // the card is re-laid out under its new agent
    expect(card.position.x).toBeCloseTo(0.1, 3);
  });
});

describe('fit and readability helpers', () => {
  it('programs without moving physics are scaled up and centred on the anchor; games are left alone', async () => {
    const { ctx, rt } = setup();
    await run(ctx, rt, 'map', serverExamples()[2]);
    const map = rt.programs.get('map')!;
    expect(map.scene.scale.x).toBeCloseTo(1.3, 3);
    await run(ctx, rt, 'golf', serverExamples()[0]);
    expect(rt.programs.get('golf')!.scene.scale.x).toBe(1);
  });

  it('labels never shrink below ~1.8 degrees of view', async () => {
    const { ctx, rt } = setup();
    await run(ctx, rt, 'l', 'aide.spawn("label", { text: "far", size: 0.02, position: [0, 0.2, -0.5] });');
    frames(ctx, rt, 2);
    const p = rt.programs.get('l')!;
    const label = [...p.spawned].find((o) => o.userData.kind === 'label')!;
    const d = label.getWorldPosition(new THREE.Vector3()).distanceTo(ctx.head().position);
    expect(label.scale.x * 0.02 * p.scene.scale.x).toBeGreaterThanOrEqual(d * 0.0314 - 1e-6);
  });

  it('while dragging a card, bigger drop targets glow and the nearest is brightest', async () => {
    const { ctx, rt } = setup();
    await run(ctx, rt, 'map', serverExamples()[2]);
    const p = rt.programs.get('map')!;
    const card = [...p.spawned].filter((o) => o.userData.kind === 'box' && Math.abs(o.scale.x - 0.11) < 1e-6)[0];
    const R = ctx.hand('right');
    moveHand(R, card.getWorldPosition(new THREE.Vector3()));
    frames(ctx, rt, 1);
    ctx.pinch('right', 'start');
    moveHand(R, p.scene.localToWorld(new THREE.Vector3(-0.1, 0.06, -0.22)));
    frames(ctx, rt, 3);
    const lit = p.dropRings.filter((r) => r.visible).map((r) => (r.material as any).opacity);
    expect(lit.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...lit)).toBeGreaterThan(0.9);
    R.pinching = false;
    frames(ctx, rt, 2);
    expect(p.dropRings.some((r) => r.visible)).toBe(false);
  });
});

describe('aide.emit / time / sound', () => {
  it('emit forwards {name, data} and is rate-limited; time() and sound.* exist', async () => {
    const { ctx, rt } = setup();
    const r = await run(ctx, rt, 'e', 'for (let i = 0; i < 9; i++) aide.emit("ping", { i }); aide.say(typeof aide.time() + " " + ["pop","score","chime","tick"].map(k => typeof aide.sound[k]).join(","));');
    expect(r.ok).toBe(true);
    const pings = ctx.events.filter((e) => e.name === 'ping');
    expect(pings.length).toBe(6);
    expect(pings[0].data).toEqual({ i: 0 });
    expect(ctx.said[0]).toBe('number function,function,function,function');
  });
});

describe('runtime safety', () => {
  it('a program that throws at start returns ok:false with the message', async () => {
    const { ctx, rt } = setup();
    const r = await run(ctx, rt, 'bad', 'const x = aide.nope.call();');
    expect(r.ok).toBe(false);
    expect((r.result as any).error).toMatch(/TypeError/);
    expect(rt.programs.has('bad')).toBe(false);
  });

  it('a frame callback that throws later is stopped and reported as code_error {id, error}', async () => {
    const { ctx, rt } = setup();
    const r = await run(ctx, rt, 'later', 'let n = 0; aide.onFrame(() => { if (++n > 20) throw new Error("boom"); });');
    expect(r.ok).toBe(true);
    frames(ctx, rt, 30);
    const err = ctx.events.find((e) => e.name === 'code_error');
    expect(err?.data).toMatchObject({ id: 'later' });
    expect(err?.data.error).toMatch(/boom/);
    expect(rt.programs.has('later')).toBe(false);
  });

  it('a frame error in the first frames comes back in the run_code result', async () => {
    const { ctx, rt } = setup();
    const r = await run(ctx, rt, 'early', 'aide.onFrame(() => { undefinedFn(); });');
    expect(r.ok).toBe(false);
    expect((r.result as any).error).toMatch(/undefinedFn/);
  });

  it('runaway loops throw instead of freezing', async () => {
    const { ctx, rt } = setup();
    const r = await run(ctx, rt, 'loop', 'let i = 0; while (true) { i++; }');
    expect(r.ok).toBe(false);
    expect((r.result as any).error).toMatch(/loop/);
    expect(guardLoops('for (let i = 0; i < 3; i++) { x(); }')).toContain('__aideLoop();');
  });

  it('frame budget overrun kills the program', async () => {
    const { ctx, rt } = setup();
    // slow only after a few frames, so the run_code result is ok and the kill arrives as code_error
    const r = await run(ctx, rt, 'slow', 'let n = 0; aide.onFrame(() => { if (++n < 10) return; const t = performance.now(); let s = 0; for (let k = 0; k < 1e9 && performance.now() - t < 45; k++) s += k; });');
    expect(r.ok).toBe(true);
    frames(ctx, rt, 12);
    expect(rt.programs.has('slow')).toBe(false);
    const ev = ctx.events.find((e) => e.name === 'code_error');
    expect(ev?.data.error ?? '').toMatch(/budget/);
  });

  it('globals such as fetch, window and document are shadowed', async () => {
    const { ctx, rt } = setup();
    const r = await run(ctx, rt, 'g', 'aide.say(String(typeof fetch) + typeof window + typeof document);');
    expect(r.ok).toBe(true);
    expect(ctx.said[0]).toBe('undefinedundefinedundefined');
  });

  it('stop removes the program scene and its panels; re-running an id replaces it', async () => {
    const { ctx, rt, panels } = setup();
    await run(ctx, rt, 'p', 'aide.panel({ title: "Hi", text: "x" }); aide.spawn("box", {});');
    expect(panels.list().length).toBe(1);
    await run(ctx, rt, 'p', 'aide.spawn("ball", {});');
    expect(panels.list().length).toBe(0);
    expect(rt.programs.get('p')!.scene.children.length).toBe(1);
    expect(rt.stop('p')).toBe(true);
    expect(ctx.root.children.length).toBe(0);
  });

  it('spawn kinds expose the documented extras', async () => {
    const { ctx, rt } = setup();
    const src = `
      const cup = aide.spawn('cup', { position: [0, 0, -0.2] });
      const t = aide.spawn('target', { position: [0, 0.2, -0.3] });
      const l = aide.spawn('label', { text: 'hi', position: [0, 0.3, 0] });
      const a = aide.spawn('arrow', { from: [0,0,0], to: [0,0.1,0] });
      const ln = aide.spawn('line', { points: [[0,0,0],[0.1,0,0],[0.2,0.1,0]] });
      aide.spawn('burst', { position: [0, 0.1, 0] });
      const b = aide.spawn('ball', { physics: true, position: [0, 0.2, 0] });
      const ok = cup.contains([0, 0.03, -0.2]) && !cup.contains([0.2, 0.03, -0.2]) && t.hitTest([0, 0.2, -0.3]) && !t.hitTest([0.5, 0.2, -0.3]);
      l.setText('bye'); a.setEnds([0,0,0],[0.1,0.1,0]); ln.setPoints([[0,0,0],[0,0.2,0]]);
      aide.say(String(ok) + ' ' + (b.body && b.body.velocity ? 'body' : 'nobody') + ' ' + typeof b.remove);
    `;
    const r = await run(ctx, rt, 'kinds', src);
    expect(r.ok).toBe(true);
    expect(ctx.said[0]).toBe('true body function');
  });

  it('aide.surfaces are in program-local coordinates with top and size', async () => {
    const { ctx, rt } = setup();
    await run(ctx, rt, 's', 'const s = aide.surfaces.find(x => x.id === aide.anchorSurfaceId); aide.say(s.label + " " + s.top.toFixed(2) + " " + s.size.x);');
    expect(ctx.said[0]).toBe('table 0.00 1.2');
  });

  it('onCollide fires for a falling box hitting the table', async () => {
    const { ctx, rt } = setup();
    await run(ctx, rt, 'c', 'const b = aide.spawn("box", { size: [0.05,0.05,0.05], position: [0, 0.3, 0], physics: true }); aide.physics.onCollide(b, (o) => aide.say("hit " + o));');
    frames(ctx, rt, 72);
    expect(ctx.said[0]).toBe('hit surface');
  });
});
