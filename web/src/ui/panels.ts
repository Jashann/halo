import {
  PokeInteractable,
  RayInteractable,
  UIKitDocument,
  parseUIKitMLSource,
  type Entity,
  type World,
} from '@iwsdk/core';
import { instantiate, resolveKitComponentSets } from '@drawcall/uikitml';
import { StyleSheet } from '@pmndrs/uikit';
import * as THREE from 'three';
import type { AideContext } from '../context.js';
import { resolvePlace } from '../shell/place.js';
import { faceUser, solve, wrap, type LayoutItem } from '../shell/layout.js';
import type { PanelHost, PanelInfo, ShowPanelArgs } from './panel-host.js';
import { mergeSpec, panelWidth, sanitizeUikitml, specToUikitml, type PanelButton, type PanelSpec } from './spec.js';
import { cardShadow } from './glow.js';
import { springIn, springOut, springPulse } from './springs.js';
import { THEME } from './theme.js';
import { sound } from './sound.js';

// The agent's own UI: 3D cards built with IWSDK's UIKit/UIKitML. A card is an IWSDK entity with
// RayInteractable + PokeInteractable so hands can poke buttons (rays and mouse clicks work too). Each card has
// a soft shadow and a gold rim glow behind it, springs in and out, and is laid out with the others so cards
// never overlap each other, the speech bubble or the chip bar. Cards placed relative to the user (front, left,
// right) follow gently when the user turns far away; cards placed on a surface stay with the surface.

interface PanelRec {
  id: string;
  entity: Entity;
  holder: THREE.Group; // animated (spring) and positioned
  card: THREE.Group; // shadow + rim
  shadow: THREE.Mesh;
  rim: THREE.Mesh;
  doc: UIKitDocument | null;
  spec: PanelSpec;
  title?: string;
  uikitml?: string;
  width: number;
  height: number;
  place: unknown;
  view: boolean; // placed relative to the user (follows), else anchored to a surface/point
  slotAz: number; // for view panels: azimuth offset from the group's base yaw
  target: THREE.Vector3; // solved position (eased toward each frame)
  home: THREE.Vector3; // where the panel wants to be before layout
  buttons: PanelButton[];
  onButton?: (id: string) => void;
  owner?: string;
  born: number;
  closing: boolean;
  lastPress: number;
}

const SLOT_AZ: Record<string, number> = { front: 0, center: 0, left: -0.5, right: 0.5, 'far-left': -1.0, 'far-right': 1.0 };
const VIEW_DIST = 0.85;

export interface Obstacle {
  id: string;
  box(): THREE.Box3 | THREE.Box3[] | null;
}

export class Panels implements PanelHost {
  recs = new Map<string, PanelRec>();
  obstacles: Obstacle[] = [];
  private componentSets = resolveKitComponentSets('horizon');
  private seq = 0;
  private baseAz: number | null = null; // where view panels are centred (head yaw when placed)
  private awaySince = -1;
  onButtons?: (panelId: string, buttons: PanelButton[]) => void;
  onClosed?: (panelId: string) => void;
  private shadowGeo = new THREE.PlaneGeometry(1, 1);

  constructor(
    private world: World,
    private ctx: AideContext,
    private sendButton: (panelId: string, buttonId: string, label: string) => void,
  ) {}

  has(id: string) {
    const r = this.recs.get(id);
    return !!r && !r.closing;
  }
  list() {
    return [...this.recs.values()].filter((r) => !r.closing).map((r) => r.id);
  }

  private headAz() {
    const f = this.ctx.head().forward;
    return Math.atan2(f.x, -f.z);
  }

  private build(rec: PanelRec): UIKitDocument {
    let source: string;
    let buttons: PanelButton[] = [];
    if (rec.uikitml) {
      const clean = sanitizeUikitml(rec.uikitml);
      if (clean.dropped.length) console.info(`[halo] panel ${rec.id}: dropped unknown components ${clean.dropped.join(', ')}`);
      source = clean.source;
    } else {
      const spec = { ...rec.spec };
      if (rec.title && !spec.title) spec.title = rec.title;
      const r = specToUikitml(spec);
      source = r.source;
      buttons = r.buttons;
    }
    const ast = parseUIKitMLSource(source, document.baseURI, { kit: 'horizon', preferredColorScheme: 'dark' });
    Object.assign(StyleSheet, ast.stylesheet);
    const root = instantiate(ast, { componentSets: this.componentSets, preferredColorScheme: 'dark' });
    const doc = new UIKitDocument(root);
    doc.setTargetDimensions(rec.width, 10);
    rec.buttons = buttons;
    const wire = (elId: string, buttonId: string, label: string) => {
      const el = doc.getElementById(elId);
      if (!el) return;
      el.addEventListener('click', () => this.press(rec.id, buttonId, label));
    };
    if (rec.uikitml) {
      const ids = [...rec.uikitml.matchAll(/id="(btn[^"]*)"/g)].map((m) => m[1]);
      for (const elId of ids) {
        const bid = elId.replace(/^btn-?/, '') || elId;
        wire(elId, bid, bid);
        rec.buttons.push({ id: bid, label: bid });
      }
    } else for (const b of buttons) wire(`btn-${b.id}`, b.id, b.label);
    return doc;
  }

  press(panelId: string, buttonId: string, label = buttonId) {
    const rec = this.recs.get(panelId);
    if (!rec || rec.closing) return false;
    const now = this.ctx.now();
    if (now - rec.lastPress < 0.35) return false; // poke + ray double fire
    rec.lastPress = now;
    sound.press();
    springPulse(rec.holder, 0.04);
    if (rec.onButton) rec.onButton(buttonId);
    else this.sendButton(panelId, buttonId, label);
    return true;
  }

  /** Where a panel wants to be, before layout. */
  private placeRec(rec: PanelRec) {
    const spec = rec.place;
    const near = typeof spec === 'string' ? spec : (spec as { near?: string } | undefined)?.near;
    const key = (near ?? 'front').toLowerCase();
    const head = this.ctx.head();
    rec.view = !spec || key in SLOT_AZ || key === 'here' || key === 'me';
    if (rec.view) {
      if (this.baseAz === null || !this.list().some((id) => id !== rec.id && this.recs.get(id)!.view)) this.baseAz = this.headAz();
      rec.slotAz = SLOT_AZ[key] ?? 0;
      const az = this.baseAz + rec.slotAz;
      const off = (spec as { offset?: number[] } | undefined)?.offset;
      rec.home.set(head.position.x + Math.sin(az) * VIEW_DIST, head.position.y - 0.12 + (off?.[1] ?? 0), head.position.z - Math.cos(az) * VIEW_DIST);
    } else {
      const p = resolvePlace(spec, this.ctx.surfaces(), head, 'panel');
      rec.home.copy(p.position);
    }
    rec.target.copy(rec.home);
  }

  private info(rec: PanelRec): PanelInfo {
    const p = rec.target;
    return { id: rec.id, position: [r3(p.x), r3(p.y), r3(p.z)], buttons: rec.buttons.map((b) => ({ id: b.id, label: b.label })) };
  }

  async show(a: ShowPanelArgs): Promise<PanelInfo> {
    const id = a.id || 'panel';
    let rec = this.recs.get(id);
    if (rec?.closing) {
      this.dispose(rec);
      rec = undefined;
    }
    const isNew = !rec;
    if (!rec) {
      const holder = new THREE.Group();
      holder.name = `panel:${id}`;
      const card = new THREE.Group();
      const shadow = new THREE.Mesh(
        this.shadowGeo,
        new THREE.MeshBasicMaterial({ color: '#000000', map: cardShadow(), transparent: true, opacity: 0.55, depthWrite: false }),
      );
      shadow.position.set(0, -0.012, -0.012);
      const rim = new THREE.Mesh(
        this.shadowGeo,
        new THREE.MeshBasicMaterial({ color: THEME.halo, map: cardShadow(), transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
      );
      rim.position.set(0, 0, -0.006);
      card.add(shadow, rim);
      holder.add(card);
      this.ctx.root.add(holder);
      const entity = this.world.createTransformEntity(holder);
      entity.addComponent(RayInteractable);
      entity.addComponent(PokeInteractable);
      rec = {
        id, entity, holder, card, shadow, rim, doc: null, spec: {}, width: 0.52, height: 0.3, place: a.place, view: true, slotAz: 0,
        target: new THREE.Vector3(), home: new THREE.Vector3(), buttons: [], born: ++this.seq, closing: false, lastPress: -1,
      };
      this.recs.set(id, rec);
    }
    rec.title = a.title ?? rec.title;
    rec.spec = (a.spec as PanelSpec) ?? (isNew ? {} : rec.spec);
    rec.uikitml = a.body_uikitml;
    rec.width = panelWidth(a.size);
    rec.onButton = a.onButton ?? rec.onButton;
    rec.owner = a.owner ?? rec.owner;
    if (a.place !== undefined || isNew) {
      rec.place = a.place;
      this.placeRec(rec);
    }
    this.swapDoc(rec);
    if (isNew) {
      rec.holder.position.copy(rec.target);
      rec.holder.quaternion.copy(faceUser(rec.target, this.ctx.head()));
      this.layout(true);
      rec.holder.position.copy(rec.target);
      springIn(rec.holder, 1);
      sound.appear();
    } else springPulse(rec.holder, 0.05);
    if (rec.buttons.length && !rec.onButton) this.onButtons?.(rec.id, rec.buttons);
    return this.info(rec);
  }

  private swapDoc(rec: PanelRec) {
    const doc = this.build(rec); // throws on bad UIKitML: the old document stays
    if (rec.doc) {
      rec.doc.removeFromParent();
      rec.doc.dispose?.();
    }
    rec.doc = doc;
    rec.holder.add(doc);
    this.measure(rec);
  }

  private measure(rec: PanelRec) {
    const size = rec.doc?.computedSize;
    if (size && size.width > 0) rec.height = rec.width * (size.height / size.width);
    const pad = 0.09;
    rec.shadow.scale.set(rec.width * 1.28 + pad, rec.height * 1.28 + pad, 1);
    rec.rim.scale.set(rec.width * 1.18 + pad * 0.6, rec.height * 1.18 + pad * 0.6, 1);
  }

  async update(id: string, patch: Record<string, unknown>): Promise<PanelInfo> {
    const rec = this.recs.get(id);
    if (!rec || rec.closing) throw new Error(`no panel "${id}"`);
    if (typeof patch.title === 'string') rec.title = patch.title;
    const specPatch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (!['title', 'place', 'size', 'body_uikitml'].includes(k)) specPatch[k] = v;
    if (typeof patch.body_uikitml === 'string') rec.uikitml = patch.body_uikitml;
    else if (Object.keys(specPatch).length) {
      rec.spec = mergeSpec(rec.spec, specPatch);
      rec.uikitml = undefined;
    }
    if (patch.size !== undefined) rec.width = panelWidth(patch.size);
    if (patch.place !== undefined) {
      rec.place = patch.place;
      this.placeRec(rec);
    }
    this.swapDoc(rec);
    if (rec.buttons.length && !rec.onButton) this.onButtons?.(rec.id, rec.buttons);
    springPulse(rec.holder, 0.04);
    sound.tick();
    return this.info(rec);
  }

  close(id: string): boolean {
    const rec = this.recs.get(id);
    if (!rec || rec.closing) return false;
    rec.closing = true;
    sound.dismiss();
    this.onClosed?.(id);
    springOut(rec.holder, () => this.dispose(rec));
    return true;
  }

  private dispose(rec: PanelRec) {
    if (this.recs.get(rec.id) === rec) this.recs.delete(rec.id);
    rec.doc?.removeFromParent();
    rec.doc?.dispose?.();
    rec.holder.removeFromParent();
    (rec.shadow.material as THREE.Material).dispose();
    (rec.rim.material as THREE.Material).dispose();
    try {
      rec.entity.dispose();
    } catch {
      /* already gone */
    }
  }

  closeOwned(owner: string) {
    for (const r of [...this.recs.values()]) if (r.owner === owner) this.close(r.id);
  }

  /** Run the layout solver on the panels' targets (plus fixed obstacles). */
  layout(force = false) {
    const head = this.ctx.head();
    const items: LayoutItem[] = [];
    const live = [...this.recs.values()].filter((r) => !r.closing);
    // solve from the home positions every time, so panels drift back once an obstacle has gone
    for (const r of live) items.push({ id: r.id, pos: r.target.copy(r.home), w: r.width, h: r.height, movable: true, born: r.born, clampHeight: true });
    const box = new THREE.Box3();
    const c = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (const o of this.obstacles) {
      const got = o.box();
      for (const b of Array.isArray(got) ? got : got ? [got] : []) {
        if (!b || b.isEmpty()) continue;
        box.copy(b);
        box.getCenter(c);
        box.getSize(s);
        items.push({ id: o.id, pos: c.clone(), w: Math.max(s.x, s.z), h: s.y, movable: false, born: -1 });
      }
    }
    if (items.length || force) solve(items, head);
  }

  update_(t: number, dt: number) {
    const live = [...this.recs.values()].filter((r) => !r.closing);
    if (!live.length) return;
    const head = this.ctx.head();
    for (const r of live) this.measure(r);
    // follow: when the user has turned far away from the view panels for a while, bring them round
    const views = live.filter((r) => r.view);
    if (views.length && this.baseAz !== null) {
      const away = Math.abs(wrap(this.headAz() - this.baseAz)) > 1.0;
      if (away) {
        if (this.awaySince < 0) this.awaySince = t;
        else if (t - this.awaySince > 1.2) {
          this.baseAz = this.headAz();
          for (const r of views) {
            const az = this.baseAz + r.slotAz;
            r.home.set(head.position.x + Math.sin(az) * VIEW_DIST, head.position.y - 0.12, head.position.z - Math.cos(az) * VIEW_DIST);
          }
          this.awaySince = -1;
        }
      } else this.awaySince = -1;
    }
    this.layout();
    const k = 1 - Math.exp(-dt * 4);
    const q = new THREE.Quaternion();
    for (const r of live) {
      r.holder.position.lerp(r.target, k);
      faceUser(r.holder.position, head, q);
      r.holder.quaternion.slerp(q, k);
    }
  }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
