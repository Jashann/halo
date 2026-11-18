import { describe, it, expect } from 'vitest';
import { ToolExecutor, TOOL_NAMES } from '../../../web/src/tools/executor.js';
import { Highlights } from '../../../web/src/ui/highlights.js';
import { GhostHands, normalizeKeyframes, motionFrame, MOTIONS } from '../../../web/src/ui/ghost-hands.js';
import { Timers, formatTime } from '../../../web/src/ui/timers.js';
import { CodeRuntime } from '../../../web/src/runtime/runtime.js';
import { GOLF_JS } from '../../../web/src/runtime/examples.js';
import { fakeCtx, FakePanels } from './helpers.js';

function setup() {
  const ctx = fakeCtx();
  const panels = new FakePanels();
  const highlights = new Highlights(ctx);
  const ghost = new GhostHands(ctx);
  const timers = new Timers(ctx);
  const runtime = new CodeRuntime(ctx, { panels, event: (n, d) => ctx.events.push({ name: n, data: d }), say: (t) => ctx.said.push(t) });
  let chips: string[] = [];
  const looks: string[] = [];
  const ex = new ToolExecutor({
    look: async (prompt) => {
      looks.push(prompt ?? '');
      return { image_b64: 'AAAA', sample: true, sample_name: 'fridge', width: 1024, height: 682 };
    },
    room: () => ({ surfaces: ctx.surfaces() }),
    panels,
    highlights,
    ghost,
    timers,
    runtime,
    setChips: (c) => (chips = c),
  });
  const tick = (sec: number) => {
    const steps = Math.ceil(sec * 72);
    for (let i = 0; i < steps; i++) {
      ctx.t += 1 / 72;
      highlights.update(ctx.t);
      ghost.update(ctx.t);
      timers.update(ctx.t);
      runtime.update(1 / 72, ctx.t);
    }
  };
  return { ctx, panels, highlights, ghost, timers, runtime, ex, tick, looks, chips: () => chips };
}

describe('tool executor', () => {
  it('look returns the frame and forwards the prompt', async () => {
    const { ex, looks } = setup();
    const r = await ex.execute('look', { prompt: 'ingredients in the fridge' });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ image_b64: 'AAAA', sample: true });
    expect(looks).toEqual(['ingredients in the fridge']);
  });

  it('room returns surfaces', async () => {
    const { ex } = setup();
    const r = await ex.execute('room', {});
    expect((r.result as any).surfaces[0].label).toBe('table');
  });

  it('show_panel / update_panel / close_panel with the server schema', async () => {
    const { ex, panels } = setup();
    const s = await ex.execute('show_panel', {
      id: 'recipe', title: 'Stir-fry', place: { near: 'front' }, size: 'medium',
      spec: { steps: ['Slice', 'Fry'], active_step: 0, buttons: [{ id: 'next', label: 'Next' }] },
    });
    expect(s.ok).toBe(true);
    expect((s.result as any).buttons).toEqual(['next']);
    const u = await ex.execute('update_panel', { id: 'recipe', patch: { spec: { active_step: 1 } } });
    expect(u.ok).toBe(true);
    expect(panels.shown.get('recipe')!).toMatchObject({ spec: { active_step: 1 } });
    const bad = await ex.execute('update_panel', { id: 'nope', patch: {} });
    expect(bad.ok).toBe(false);
    expect((bad.result as any).error).toMatch(/no panel "nope"/);
    const c = await ex.execute('close_panel', { id: 'recipe' });
    expect(c.result).toEqual({ id: 'recipe', closed: true });
  });

  it('highlight places a ring on the table surface and can be cleared', async () => {
    const { ex, highlights, ctx } = setup();
    const r = await ex.execute('highlight', { id: 'cut', target: { surface_id: 'plane-1', offset: [0.1, 0, 0] }, label: 'Chop here', shape: 'ring', color: '#ffb000' });
    expect(r.ok).toBe(true);
    const res = r.result as any;
    expect(res.surface).toBe('plane-1');
    expect(res.position[1]).toBeCloseTo(0.754, 2);
    expect(highlights.items.has('cut')).toBe(true);
    const p = await ex.execute('highlight', { target: { point: [0.2, 0.9, -0.5] }, label: 'Pan', shape: 'arrow' });
    expect((p.result as any).position).toEqual([0.2, 0.9, -0.5]);
    await ex.execute('highlight', { id: 'cut', shape: 'off', target: {} , label: '' });
    expect(highlights.items.has('cut')).toBe(false);
    expect(ctx.root.children.length).toBeGreaterThan(0);
  });

  it('ghost_hands plays every procedural motion and server-format custom keyframes', async () => {
    const { ex, ghost, tick } = setup();
    for (const m of MOTIONS) {
      const r = await ex.execute('ghost_hands', { motion: m, at: { near: 'plane-1' }, label: 'Claw grip' });
      expect(r.ok, m).toBe(true);
      tick(0.3);
      expect(ghost.active).toBe(true);
    }
    const custom = await ex.execute('ghost_hands', {
      motion: 'custom', at: { near: 'front' },
      keyframes: [
        { t: 0, hand: 'right', pose: 'open', position: [0.05, 0.1, 0] },
        { t: 0.5, hand: 'right', pose: 'pinch', position: [0.05, 0.05, -0.05] },
        { t: 1, hand: 'right', pose: 'fist', position: [0.05, 0.12, 0] },
      ],
    });
    expect(custom.ok).toBe(true);
    expect((custom.result as any).motion).toBe('custom');
    const bad = await ex.execute('ghost_hands', { motion: 'juggle', at: { near: 'front' } });
    expect(bad.ok).toBe(false);
    tick(20); // loops end, hands fade out
    expect(ghost.active).toBe(false);
  });

  it('motion frames stay within reach of the anchor', () => {
    for (const m of MOTIONS) {
      for (let t = 0; t < 5; t += 0.25) {
        const f = motionFrame(m, t);
        for (const h of [f.left, f.right]) for (const v of h.pos) expect(Math.abs(v)).toBeLessThan(0.35);
      }
    }
    expect(() => normalizeKeyframes([{ t: 0 }])).toThrow();
  });

  it('timer counts down and sends timer_done {id, label}', async () => {
    const { ex, ctx, tick, timers } = setup();
    const r = await ex.execute('timer', { label: 'Pasta', seconds: 2, at: { near: 'plane-1', offset: [0.3, 0, 0] } });
    expect(r.result).toMatchObject({ id: 'pasta', seconds: 2, label: 'Pasta' });
    tick(1);
    expect(ctx.events.find((e) => e.name === 'timer_done')).toBeUndefined();
    expect(timers.remaining('pasta')).toBeGreaterThan(0.5);
    tick(1.2);
    expect(ctx.events.find((e) => e.name === 'timer_done')?.data).toEqual({ id: 'pasta', label: 'Pasta' });
    expect(formatTime(125)).toBe('2:05');
  });

  it('run_code runs a program and stop_code removes it; errors come back ok:false', async () => {
    const { ex, runtime, tick } = setup();
    const p = ex.execute('run_code', { id: 'golf', js: GOLF_JS, at: { near: 'plane-1' } });
    tick(0.1);
    const r = await p;
    expect(r.ok).toBe(true);
    expect((r.result as any).id).toBe('golf');
    expect(runtime.programs.has('golf')).toBe(true);
    const s = await ex.execute('stop_code', { id: 'golf' });
    expect(s.result).toEqual({ id: 'golf', stopped: true });
    const bad = ex.execute('run_code', { id: 'x', js: 'throw new Error("nope")', at: { near: 'front' } });
    tick(0.1);
    const br = await bad;
    expect(br.ok).toBe(false);
    expect((br.result as any).error).toMatch(/nope/);
  });

  it('remember / recall work without localStorage (Node)', async () => {
    const { ex } = setup();
    await ex.execute('remember', { key: 'favourite_game', value: 'golf' });
    const r = await ex.execute('recall', { key: 'favourite_game' });
    expect(r.result).toEqual({ key: 'favourite_game', found: true, value: 'golf' });
    const all = await ex.execute('recall', {});
    expect((all.result as any).all.favourite_game).toBe('golf');
  });

  it('clear_scene and run_code clear the previous topic (panels, highlights, hands, finished timers, programs)', async () => {
    const { ex, panels, highlights, ghost, timers, runtime, tick } = setup();
    let cleared: any = null;
    (ex as any).d.clearScene = (o: any) => {
      cleared = o;
      for (const id of panels.list()) panels.close(id);
      highlights.clear();
      ghost.stop();
      timers.clearDone();
      for (const id of [...runtime.programs.keys()]) if (id !== o.except) runtime.stop(id);
      return { cleared: true };
    };
    await ex.execute('show_panel', { id: 'recipe', title: 'R', place: { near: 'front' }, spec: {} });
    await ex.execute('highlight', { target: { surface_id: 'plane-1' }, label: 'x' });
    await ex.execute('timer', { label: 'Done soon', seconds: 0.5, at: { near: 'plane-1' } });
    tick(1);
    const p = ex.execute('run_code', { id: 'g', js: 'aide.spawn("ball", {})', at: { near: 'plane-1' } });
    tick(0.1);
    expect((await p).ok).toBe(true);
    expect(cleared).toEqual({ except: 'g' });
    expect(panels.list()).toEqual([]);
    expect(highlights.items.size).toBe(0);
    expect(timers.items.size).toBe(0);
    const r = await ex.execute('clear_scene', { all: true });
    expect(r.ok).toBe(true);
  });

  it('set_chips, unknown tools and bad JSON', async () => {
    const { ex, chips } = setup();
    await ex.execute('set_chips', { chips: ['Next step', 'Repeat'] });
    expect(chips()).toEqual(['Next step', 'Repeat']);
    expect((await ex.execute('teleport', {})).ok).toBe(false);
    expect((await ex.execute('room', '{bad')).ok).toBe(false);
    expect(TOOL_NAMES).toContain('ghost_hands');
  });
});
