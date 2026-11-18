import { PokeInteractable, RayInteractable, UIKitDocument, parseUIKitMLSource, type World } from '@iwsdk/core';
import { instantiate, resolveKitComponentSets } from '@drawcall/uikitml';
import { StyleSheet } from '@pmndrs/uikit';
import * as THREE from 'three';
import type { AideContext } from '../context.js';
import { escapeText } from './spec.js';
import { sound } from './sound.js';

// Floating chip bar within arm's reach, below the line of sight: suggested prompts pressed by poke, plus a
// "Hold to talk" button for people who prefer it to the wrist button. The agent rewrites the chips: they mirror
// the buttons of the latest panel (pressing sends panel_button for that panel), or come from set_chips / the
// `chips` message (pressing sends the chip text as `say`).

export interface Chip {
  label: string;
  panelId?: string;
  buttonId?: string;
}

export const DEFAULT_CHIPS: Chip[] = [
  { label: 'What can I cook?' },
  { label: 'Make me a game' },
  { label: 'Explain how an engine works' },
];

export class ChipBar {
  holder = new THREE.Group();
  chips: Chip[] = DEFAULT_CHIPS;
  private doc: UIKitDocument | null = null;
  private sets = resolveKitComponentSets('horizon');
  private placedYaw: number | null = null;
  private placedAt = new THREE.Vector3();
  private goal = new THREE.Vector3();
  private placedOnce = false;
  private lastPress = 0;
  visible = true;

  constructor(
    private world: World,
    private ctx: AideContext,
    private handlers: { chip(c: Chip): void; talk(down: boolean): void },
    private talkAvailable: () => boolean,
    private extra: () => Chip[] = () => [],
  ) {
    this.holder.name = 'chip-bar';
    ctx.root.add(this.holder);
    const e = world.createTransformEntity(this.holder);
    e.addComponent(RayInteractable);
    e.addComponent(PokeInteractable);
  }

  set(chips: Chip[]) {
    this.chips = chips.length ? chips.slice(0, 4) : DEFAULT_CHIPS;
    this.rebuild();
  }

  rebuild() {
    const talk = this.talkAvailable();
    if (this.chips === DEFAULT_CHIPS || this.chips.every((c) => !c.panelId)) {
      const ex = this.extra().filter((e) => !this.chips.some((c) => c.label === e.label));
      if (ex.length) this.chips = [...this.chips, ...ex].slice(0, 4);
    }
    const items = this.chips
      .map((c, i) => `<Button id="chip-${i}" variant="secondary" size="lg" class="cb-chip"><ButtonLabel class="cb-label">${escapeText(c.label)}</ButtonLabel></Button>`)
      .join('');
    const talkBtn = talk ? `<Button id="chip-talk" variant="primary" size="lg" class="cb-chip"><ButtonLabel class="cb-label">Hold to talk</ButtonLabel></Button>` : '';
    const src = `<style>
  .cb-root { flex-direction: row; flex-wrap: wrap; justify-content: center; gap: 10px; padding-top: 12px; padding-bottom: 12px; padding-left: 12px; padding-right: 12px; width: 620px; }
  .cb-label { font-size: 22px; }
  .cb-chip { flex-shrink: 0; }
</style><Panel class="cb-root">${talkBtn}${items}</Panel>`;
    const ast = parseUIKitMLSource(src, document.baseURI, { kit: 'horizon', preferredColorScheme: 'dark' });
    Object.assign(StyleSheet, ast.stylesheet);
    const root = instantiate(ast, { componentSets: this.sets, preferredColorScheme: 'dark', });
    const doc = new UIKitDocument(root);
    doc.setTargetDimensions(0.38, 10);
    this.chips.forEach((c, i) => {
      doc.getElementById(`chip-${i}`)?.addEventListener('click', () => this.press(i));
    });
    const t = doc.getElementById('chip-talk');
    if (t) {
      t.addEventListener('pointerdown', () => this.handlers.talk(true));
      t.addEventListener('pointerup', () => this.handlers.talk(false));
      t.addEventListener('pointerleave', () => this.handlers.talk(false));
    }
    if (this.doc) {
      this.doc.removeFromParent();
      this.doc.dispose?.();
    }
    this.doc = doc;
    this.holder.add(doc);
  }

  press(i: number) {
    const c = this.chips[i];
    if (!c) return false;
    const now = this.ctx.now();
    if (now - this.lastPress < 0.4) return false;
    this.lastPress = now;
    sound.press();
    this.handlers.chip(c);
    return true;
  }

  /** Keep the bar lower left, within reach; it eases after the head when the user turns or moves. */
  update(force = false, dt = 1 / 72) {
    if (!this.doc) this.rebuild();
    this.holder.visible = this.visible;
    const head = this.ctx.head();
    const yaw = Math.atan2(head.forward.x, head.forward.z);
    const moved = this.placedYaw === null || Math.abs(angleDiff(yaw, this.placedYaw)) > 0.35 || head.position.distanceTo(this.placedAt) > 0.2;
    if (force || moved) {
      this.placedYaw = yaw;
      this.placedAt.copy(head.position);
      // lower left of the view, within reach, angled up toward the user: off the work surface in front
      const dir = head.forward.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
      this.goal.copy(head.position).addScaledVector(dir, 0.42);
      this.goal.y = head.position.y - 0.42;
      if (force || !this.placedOnce) this.holder.position.copy(this.goal);
      this.placedOnce = true;
    }
    this.holder.position.lerp(this.goal, 1 - Math.exp(-dt * 5));
    const face = Math.atan2(head.position.x - this.holder.position.x, head.position.z - this.holder.position.z);
    this.holder.quaternion.setFromEuler(new THREE.Euler(-0.5, face, 0, 'YXZ'));
  }
}

function angleDiff(a: number, b: number) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
