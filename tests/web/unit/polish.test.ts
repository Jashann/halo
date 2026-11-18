import { describe, it, expect } from 'vitest';
import { parse, resolveKitComponentSets } from '../../../web/node_modules/@drawcall/uikitml/dist/index.js';
import { solve, overlaps, constrain, MIN_DIST, MAX_DIST, type LayoutItem } from '../../../web/src/shell/layout.js';
import { sanitizeUikitml, iconName, specToUikitml, ICONS } from '../../../web/src/ui/spec.js';
import { springIn, springOut, tickSprings } from '../../../web/src/ui/springs.js';
import { THREE } from './helpers.js';

const head = { position: new THREE.Vector3(0, 1.2, 0), forward: new THREE.Vector3(0, 0, -1) };
const sets = resolveKitComponentSets('horizon');

function item(id: string, x: number, y: number, z: number, w = 0.52, h = 0.4, born = 1, movable = true): LayoutItem {
  return { id, pos: new THREE.Vector3(x, y, z), w, h, movable, born, clampHeight: true };
}

describe('layout solver', () => {
  it('pushes three overlapping panels (two medium, one small) apart (newest moves) and keeps them clear of the bubble', () => {
    const items = [
      item('a', 0, 1.0, -0.85, 0.52, 0.4, 1),
      item('b', 0.05, 1.0, -0.85, 0.52, 0.4, 2),
      item('c', -0.02, 1.05, -0.8, 0.4, 0.4, 3),
      item('bubble', 0.15, 1.44, -0.85, 0.35, 0.08, -1, false), // above eye level, where the orb keeps it
      item('chips', -0.27, 0.78, -0.32, 0.38, 0.1, -1, false), // lower left, as placed by the chip bar
    ];
    solve(items, head);
    // panels never overlap each other or the bubble (the chip bar is a soft obstacle: it is avoided when there is room)
    const hard = items.filter((i) => i.id !== 'chips');
    for (let i = 0; i < hard.length; i++) for (let j = i + 1; j < hard.length; j++) expect(overlaps(hard[i], hard[j], head), `${hard[i].id}/${hard[j].id}`).toBe(0);
    expect(items.filter((i) => i.movable).every((i) => i.pos.y + i.h / 2 <= 1.2201)).toBe(true);
  });

  it('keeps panels 0.6 to 1.2 m away with the top edge at or below eye level', () => {
    const near = item('n', 0, 1.5, -0.3);
    const far = item('f', 0, 1.0, -3);
    constrain(near, head);
    constrain(far, head);
    expect(Math.hypot(near.pos.x, near.pos.z)).toBeCloseTo(MIN_DIST, 3);
    expect(Math.hypot(far.pos.x, far.pos.z)).toBeCloseTo(MAX_DIST, 3);
    expect(near.pos.y + near.h / 2).toBeLessThanOrEqual(1.2 + 0.0201);
  });
});

describe('icons', () => {
  it('maps names and aliases to bundled icons; unknown names are dropped silently', () => {
    expect(iconName('chef-hat')).toBe('ChefHat');
    expect(iconName('timer')).toBe('Timer');
    expect(iconName('AlertTriangle')).toBe('TriangleAlert');
    expect(iconName('definitely-not-an-icon')).toBeNull();
    expect(ICONS.size).toBeGreaterThan(150);
    const { source, dropped } = sanitizeUikitml('<Panel><Home></Home><Flux width="2"/><Button><ButtonIcon><Timer></Timer></ButtonIcon><ButtonLabel>x</ButtonLabel></Button></Panel>');
    expect(dropped).toEqual(['Flux']);
    expect(source).toContain('<House>');
    expect(parse(source, { componentSets: sets }).success).toBe(true);
  });

  it('spec icons (header and buttons) produce valid UIKitML', () => {
    const { source } = specToUikitml({ title: 'Stir-fry', icon: 'chef-hat', buttons: [{ id: 't', label: 'Timer', icon: 'timer' } as any, { id: 'x', label: 'X', icon: 'nope' } as any] });
    expect(source).toContain('<ChefHat');
    expect(source).toContain('<ButtonIcon><Timer>');
    const r = parse(source, { componentSets: sets });
    if (!r.success) throw new Error(JSON.stringify(r.errors));
  });
});

describe('springs', () => {
  it('spring in settles at the base scale; spring out calls back when gone', () => {
    const a = new THREE.Object3D();
    springIn(a, 2);
    for (let i = 0; i < 120; i++) tickSprings(1 / 72);
    expect(a.scale.x).toBeCloseTo(2, 2);
    let gone = false;
    springOut(a, () => (gone = true));
    for (let i = 0; i < 120; i++) tickSprings(1 / 72);
    expect(gone).toBe(true);
  });
});

describe('layout solver, normal case', () => {
  it('two panels and the chip bar: all clear', () => {
    const items = [
      item('a', 0, 1.0, -0.85, 0.52, 0.45, 1),
      item('b', 0.05, 1.05, -0.85, 0.4, 0.2, 2),
      item('chips', -0.27, 0.78, -0.32, 0.38, 0.1, -1, false),
    ];
    solve(items, head);
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) expect(overlaps(items[i], items[j], head), `${items[i].id}/${items[j].id}`).toBe(0);
  });
});

describe('springs keep non-square scales', () => {
  it('a 3:1 label springs back to 3:1', () => {
    const o = new THREE.Object3D();
    o.scale.set(0.3, 0.1, 1);
    springIn(o);
    for (let i = 0; i < 120; i++) tickSprings(1 / 72);
    expect(o.scale.x).toBeCloseTo(0.3, 3);
    expect(o.scale.y).toBeCloseTo(0.1, 3);
  });
});
