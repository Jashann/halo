import * as THREE from '../../../web/src/three.js';
import { makeHandState, type AideContext, type HandState, type PinchListener } from '../../../web/src/context.js';
import type { Surface } from '../../../web/src/shell/place.js';
import type { PanelHost, ShowPanelArgs, PanelInfo } from '../../../web/src/ui/panel-host.js';

export { THREE };

export const TABLE: Surface = {
  id: 'plane-1', label: 'table', size: [1.2, 0.7], center: [0, 0.75, -0.6], normal: [0, 1, 0], kind: 'plane', orientation: 'horizontal',
};
export const WALL: Surface = {
  id: 'plane-2', label: 'wall', size: [4, 2.6], center: [0, 1.3, -2.0], normal: [0, 0, 1], kind: 'plane', orientation: 'vertical', height: 2.6,
};

export interface FakeCtx extends AideContext {
  t: number;
  events: { name: string; data: any }[];
  said: string[];
  surfacesList: Surface[];
  pinch(hand: 'left' | 'right', phase: 'start' | 'end'): void;
  hand(side: 'left' | 'right'): HandState;
}

export function fakeCtx(surfaces: Surface[] = [TABLE, WALL]): FakeCtx {
  const root = new THREE.Group();
  const listeners: PinchListener[] = [];
  const hands = { left: makeHandState('left'), right: makeHandState('right') };
  const ctx: FakeCtx = {
    t: 0,
    events: [],
    said: [],
    surfacesList: surfaces,
    root,
    head: () => ({ position: new THREE.Vector3(0, 1.2, 0), forward: new THREE.Vector3(0, 0, -1) }),
    surfaces: () => ctx.surfacesList,
    hands,
    onPinch: (fn) => {
      listeners.push(fn);
      return () => listeners.splice(listeners.indexOf(fn), 1);
    },
    event: (name, data) => ctx.events.push({ name, data }),
    say: (text) => ctx.said.push(text),
    billboard: () => {},
    now: () => ctx.t,
    pinch(side, phase) {
      const h = hands[side];
      h.pinching = phase === 'start';
      for (const f of [...listeners]) f(h, phase);
    },
    hand: (side) => hands[side],
  };
  return ctx;
}

/** Put a hand's pinch point (and all joints) at a world position. */
export function moveHand(h: HandState, p: THREE.Vector3) {
  h.visible = true;
  for (const v of Object.values(h.joints)) v.copy(p);
  h.pinchPoint.copy(p);
}

export class FakePanels implements PanelHost {
  shown = new Map<string, ShowPanelArgs>();
  async show(a: ShowPanelArgs): Promise<PanelInfo> {
    this.shown.set(a.id, a);
    const buttons = ((a.spec?.buttons as any[]) ?? []).map((b: any) => ({ id: b.id ?? b, label: b.label ?? b }));
    return { id: a.id, position: [0, 1.2, -0.85], buttons };
  }
  async update(id: string, patch: Record<string, unknown>): Promise<PanelInfo> {
    const cur = this.shown.get(id)!;
    this.shown.set(id, { ...cur, ...(patch as object) });
    return { id, position: [0, 1.2, -0.85], buttons: [] };
  }
  close(id: string) {
    return this.shown.delete(id);
  }
  closeOwned(owner: string) {
    for (const [k, v] of this.shown) if (v.owner === owner) this.shown.delete(k);
  }
  has(id: string) {
    return this.shown.has(id);
  }
  list() {
    return [...this.shown.keys()];
  }
}
