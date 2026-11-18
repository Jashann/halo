import { describe, it, expect } from 'vitest';
import { parse, resolveKitComponentSets } from '../../../web/node_modules/@drawcall/uikitml/dist/index.js';
import { specToUikitml, mergeSpec, normalizeSpec, escapeText, panelWidth } from '../../../web/src/ui/spec.js';
import { resolvePlace, workSurface, findSurface } from '../../../web/src/shell/place.js';
import { resolveServerUrl, AideClient } from '../../../web/src/net/client.js';
import { pickCamera, chooseSample } from '../../../web/src/shell/media.js';
import { Physics } from '../../../web/src/runtime/physics.js';
import { THREE, TABLE, WALL } from './helpers.js';

const head = { position: new THREE.Vector3(0, 1.2, 0), forward: new THREE.Vector3(0, 0, -1) };
const sets = resolveKitComponentSets('horizon');

describe('panel spec -> UIKitML', () => {
  it('every spec field produces UIKitML that the IWSDK parser accepts', () => {
    const { source, buttons } = specToUikitml({
      title: 'Veggie stir-fry', subtitle: '20 min', badge: 'recipe', text: 'Line one\nLine two',
      bullets: ['Carrots', 'Broccoli'], steps: ['Slice', 'Fry'], active_step: 1,
      buttons: [{ id: 'next', label: 'Next step' }, 'Repeat'], footer: 'Sample photo', image: 'samples/fridge.jpg', accent: '#ffb000',
    });
    const r = parse(source, { componentSets: sets });
    if (!r.success) throw new Error(JSON.stringify(r.errors));
    expect(buttons.map((b) => b.id)).toEqual(['next', 'repeat']);
    expect(source).toContain('id="btn-next"');
    expect(source).toContain('ax-step-on');
  });

  it('checklist renders checked boxes; escaping is safe', () => {
    const { source } = specToUikitml({ title: '<b>&', checklist: [{ label: 'Oil', done: true }, { label: 'Salt' }] });
    expect(parse(source, { componentSets: sets }).success).toBe(true);
    expect(source).toContain('&lt;b&gt;&amp;');
    expect(source).toContain('ax-check');
    expect(source).toContain('ax-box');
    expect(escapeText('"x"')).toBe('&quot;x&quot;');
  });

  it('normalizeSpec and mergeSpec', () => {
    expect(normalizeSpec({ active_step: 0, bullets: ['a'] })).toMatchObject({ current: 1, list: ['a'] });
    const m = mergeSpec({ title: 'A', steps: ['x'] }, { spec: { active_step: 2 }, append_steps: ['y'] });
    expect(m).toMatchObject({ title: 'A', active_step: 2, steps: ['x', 'y'] });
    expect(panelWidth('large')).toBe(0.7);
    expect(panelWidth(undefined)).toBe(0.52);
  });
});

describe('placement', () => {
  it('front / left / right are in front of the seated user and face them', () => {
    const f = resolvePlace({ near: 'front' }, [], head, 'panel');
    expect(f.position.z).toBeCloseTo(-0.85, 2);
    expect(f.position.y).toBeLessThan(1.2);
    const l = resolvePlace('left', [], head, 'panel');
    expect(l.position.x).toBeLessThan(-0.3);
    const r = resolvePlace({ near: 'right' }, [], head, 'panel');
    expect(r.position.x).toBeGreaterThan(0.3);
  });

  it('surface ids, labels and offsets resolve onto the surface; unknown targets fall back to the work surface', () => {
    const s = resolvePlace({ near: 'plane-1', offset: [0.2, 0, 0] }, [TABLE, WALL], head, 'marker');
    expect(s.surface?.id).toBe('plane-1');
    expect(s.position.y).toBeCloseTo(0.754, 3);
    expect(s.position.x).toBeCloseTo(0.2, 3);
    expect(findSurface([TABLE, WALL], 'table')?.id).toBe('plane-1');
    const stove = resolvePlace('stove', [TABLE, WALL], head, 'timer');
    expect(stove.surface?.id).toBe('plane-1');
    const w = resolvePlace({ near: 'plane-2' }, [TABLE, WALL], head, 'panel');
    expect(w.position.z).toBeGreaterThan(-2.0); // stands off the wall toward the user
  });

  it('no table: a virtual spot in front of the seated user', () => {
    const ws = workSurface([WALL], head);
    expect(ws.id).toBe('front-spot');
    expect(ws.center[2]).toBeLessThan(-0.3);
    expect(ws.center[1]).toBeCloseTo(0.7, 1);
  });
});

describe('network client', () => {
  it('server url: same origin /ws, ?server= variants', () => {
    expect(resolveServerUrl({ protocol: 'https:', host: 'aide.app', search: '' })).toBe('wss://aide.app/ws');
    expect(resolveServerUrl({ protocol: 'https:', host: 'x', search: '?server=ws://localhost:8790/ws' })).toBe('ws://localhost:8790/ws');
    expect(resolveServerUrl({ protocol: 'http:', host: 'x', search: '?server=localhost:8787' })).toBe('ws://localhost:8787/ws');
    expect(resolveServerUrl({ protocol: 'https:', host: 'x', search: '?server=https://a.b' })).toBe('wss://a.b/ws');
  });

  it('sends hello on open, queues while closed, reconnects', async () => {
    const sockets: any[] = [];
    class FakeWS {
      readyState = 0;
      sent: string[] = [];
      onopen?: () => void; onclose?: () => void; onmessage?: (e: { data: string }) => void; onerror?: () => void;
      constructor(public url: string) { sockets.push(this); }
      send(s: string) { this.sent.push(s); }
      close() { this.readyState = 3; this.onclose?.(); }
    }
    const got: any[] = [];
    const c = new AideClient({
      url: 'ws://x/ws',
      hello: () => ({ type: 'hello', user: 'u', capabilities: { camera: false }, room: { surfaces: [] } }),
      onMessage: (m) => got.push(m),
      WebSocketImpl: FakeWS as any,
    });
    c.connect();
    c.send({ type: 'say', text: 'queued' });
    sockets[0].readyState = 1;
    sockets[0].onopen();
    expect(JSON.parse(sockets[0].sent[0]).type).toBe('hello');
    expect(JSON.parse(sockets[0].sent[1])).toEqual({ type: 'say', text: 'queued' });
    sockets[0].onmessage({ data: JSON.stringify({ type: 'say', text: 'hi' }) });
    expect(got[0]).toEqual({ type: 'say', text: 'hi' });
    sockets[0].readyState = 3;
    sockets[0].onclose();
    await new Promise((r) => setTimeout(r, 900));
    expect(sockets.length).toBe(2);
    c.close();
  });
});

describe('media helpers', () => {
  it('prefers "camera 1, facing back" (left passthrough camera)', () => {
    const d = [
      { deviceId: '0', label: 'camera 0, facing front' },
      { deviceId: '2', label: 'camera 2, facing back' },
      { deviceId: '1', label: 'camera 1, facing back' },
    ];
    expect(pickCamera(d)?.deviceId).toBe('1');
    expect(pickCamera([{ deviceId: 'w', label: 'FaceTime HD' }])?.deviceId).toBe('w');
  });
  it('chooses the pan sample for pan prompts, fridge otherwise', () => {
    expect(chooseSample('is the pan browned enough?')).toBe('pan');
    expect(chooseSample('ingredients in the fridge')).toBe('fridge');
    expect(chooseSample('', 'pan')).toBe('pan');
  });
});

describe('physics', () => {
  it('a ball dropped on a table bounces and comes to rest on top', () => {
    const ph = new Physics();
    ph.setSurfaces([TABLE]);
    const ball = new THREE.Object3D();
    ball.position.set(0, 1.2, -0.6);
    const b = ph.add(ball, { shape: 'sphere', radius: 0.03, bounce: 0.5 });
    for (let i = 0; i < 300; i++) ph.step(1 / 72);
    expect(ball.position.y).toBeCloseTo(0.78, 2);
    expect(b.velocity.length()).toBeLessThan(0.05);
  });
  it('a rolling ball slows down by friction', () => {
    const ph = new Physics();
    ph.setSurfaces([TABLE]);
    const ball = new THREE.Object3D();
    ball.position.set(-0.4, 0.78, -0.6);
    const b = ph.add(ball, { shape: 'sphere', radius: 0.03, friction: 0.5, velocity: [0.6, 0, 0] });
    for (let i = 0; i < 72 * 3; i++) ph.step(1 / 72);
    expect(b.velocity.length()).toBeLessThan(0.01);
    expect(ball.position.x).toBeGreaterThan(-0.3);
    expect(ball.position.x).toBeLessThan(0.0);
  });
  it('a ball off the table edge falls to the floor', () => {
    const ph = new Physics();
    ph.setSurfaces([TABLE]);
    const ball = new THREE.Object3D();
    ball.position.set(1.5, 1.0, -0.6);
    ph.add(ball, { shape: 'sphere', radius: 0.03 });
    for (let i = 0; i < 200; i++) ph.step(1 / 72);
    expect(ball.position.y).toBeCloseTo(0.03, 2);
  });
});
