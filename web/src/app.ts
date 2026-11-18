import { createSystem, XRAnchor, XRMesh, XRPlane, type World } from '@iwsdk/core';
import * as THREE from 'three';
import type { AideContext, PinchListener } from './context.js';
import { AideClient, resolveServerUrl, type ServerMessage } from './net/client.js';
import { CodeRuntime } from './runtime/runtime.js';
import { EXAMPLES } from './runtime/examples.js';
import { HandTracker } from './shell/hands.js';
import { look, media } from './shell/media.js';
import { cameraAvailable, sceneSummary, snapshot } from './shell/snapshot.js';
import { workSurface, type HeadPose, type Surface } from './shell/place.js';
import { dedupe, meshToSurface, planeToSurface, sortForAgent } from './shell/room.js';
import { VoiceRecorder } from './shell/voice.js';
import { ToolExecutor } from './tools/executor.js';
import { ChipBar, DEFAULT_CHIPS, type Chip } from './ui/chips.js';
import { GhostHands } from './ui/ghost-hands.js';
import { Highlights } from './ui/highlights.js';
import { makeLabel } from './ui/label.js';
import { Orb } from './ui/orb.js';
import { Panels } from './ui/panels.js';
import { sound } from './ui/sound.js';
import { TalkButton } from './ui/talk-button.js';
import { Timers } from './ui/timers.js';
import { springIn, springOut, tickSprings } from './ui/springs.js';

// Glue: one IWSDK system drives every Halo module per frame; the WebSocket client feeds tool calls to the
// executor; the context object is what every module sees.

let app: AideApp | null = null;

export class AideSystem extends createSystem({
  planes: { required: [XRPlane] },
  meshes: { required: [XRMesh] },
}) {
  update(delta: number, time: number) {
    if (!app) return;
    app.planeEntities = this.queries.planes.entities as unknown as Set<any>;
    app.meshEntities = this.queries.meshes.entities as unknown as Set<any>;
    app.frame(delta, time);
  }
}

export class AideApp {
  root = new THREE.Group();
  hands = new HandTracker();
  ctx: AideContext;
  orb: Orb;
  panels: Panels;
  highlights: Highlights;
  ghost: GhostHands;
  timers: Timers;
  runtime: CodeRuntime;
  executor: ToolExecutor;
  chips: ChipBar;
  talk: TalkButton;
  voice: VoiceRecorder;
  client: AideClient | null = null;
  planeEntities: Set<any> = new Set();
  meshEntities: Set<any> = new Set();
  placed: Surface[] = [];
  private billboards = new Set<THREE.Object3D>();
  private headPose: HeadPose = { position: new THREE.Vector3(0, 1.3, 0), forward: new THREE.Vector3(0, 0, -1) };
  private t = 0;
  private surfaceCache: { at: number; list: Surface[] } = { at: -1, list: [] };
  private placing: { reticle: THREE.Mesh; source?: XRHitTestSource; hit: THREE.Vector3 | null } | null = null;
  private xrStartedAt = -1;
  private sampleNote: ReturnType<typeof makeLabel> | null = null;
  fps = 0;
  user: string;
  statusText = '';
  heardText = '';
  events: { name: string; data: unknown }[] = [];
  received: ServerMessage[] = [];

  constructor(public world: World) {
    app = this;
    this.root.name = 'halo-root';
    world.scene.add(this.root);
    const hemi = new THREE.HemisphereLight('#ffffff', '#3a3f47', 1.6);
    const key = new THREE.DirectionalLight('#ffffff', 1.4);
    key.position.set(0.5, 2.5, 1);
    this.root.add(hemi, key);
    this.user = userId();

    const self = this;
    this.ctx = {
      root: this.root,
      head: () => this.headPose,
      surfaces: () => this.surfaces(),
      hands: { left: this.hands.left, right: this.hands.right },
      onPinch: (fn: PinchListener) => this.hands.onPinch(fn),
      event: (name, data) => this.sendEvent(name, data),
      say: (text) => self.orb.say(text),
      billboard: (o, on = true) => {
        if (on) this.billboards.add(o);
        else this.billboards.delete(o);
      },
      now: () => this.t,
    };
    this.orb = new Orb(this.ctx);
    this.orb.setState('offline');
    this.panels = new Panels(world, this.ctx, (panel_id, button_id, label) => this.sendEvent('panel_button', { panel_id, button_id, label }));
    this.panels.onButtons = (panelId, buttons) =>
      this.chips.set(buttons.slice(0, 4).map((b) => ({ label: b.label, panelId, buttonId: b.id })));
    // chips mirror the latest panel's buttons; when that panel closes they go back to the defaults
    this.panels.onClosed = (id) => {
      if (this.chips.chips.some((c) => c.panelId === id)) this.chips.set(DEFAULT_CHIPS);
    };
    this.highlights = new Highlights(this.ctx);
    this.ghost = new GhostHands(this.ctx);
    this.timers = new Timers(this.ctx);
    this.runtime = new CodeRuntime(this.ctx, {
      panels: this.panels,
      event: (n, d) => this.sendEvent(n, d),
      say: (t) => this.orb.say(t),
      obstacles: () => [this.orb.bubbleBox()],
    });
    this.voice = new VoiceRecorder((mime, b64) => {
      this.client?.send({ type: 'audio', mime, b64 });
      this.orb.setState('thinking');
      this.orb.showStatus('Sending what you said...');
    });
    this.chips = new ChipBar(
      world,
      this.ctx,
      { chip: (c) => this.pressChip(c), talk: (d) => this.setTalking(d) },
      () => this.voice.available,
      () => (this.world.session && workSurface(this.surfaces(), this.headPose).kind === 'virtual' ? [{ label: 'Set my table here' }] : []),
    );
    this.talk = new TalkButton(this.ctx, (down) => this.setTalking(down));
    // the layout solver keeps panels clear of the speech bubble and the chip bar; the demonstration hands pick
    // the side of the work zone that is clear of panels and timers
    const chipBox = new THREE.Box3();
    this.panels.obstacles.push(
      { id: 'bubble', box: () => this.orb.bubbleBox() },
      { id: 'chips', box: () => (this.chips.holder.visible ? chipBox.setFromObject(this.chips.holder) : null) },
    );
    // panels keep clear of the work zone: the demonstration hands and the highlights on the table
    const tmpBox = new THREE.Box3();
    this.panels.obstacles.push({
      id: 'work',
      box: () => {
        const out: THREE.Box3[] = [];
        if (this.ghost.active) {
          const c = this.ghost.group.getWorldPosition(new THREE.Vector3());
          out.push(new THREE.Box3().setFromCenterAndSize(c.add(new THREE.Vector3(0, 0.12, 0)), new THREE.Vector3(0.45, 0.3, 0.45)));
        }
        // highlights lie flat on the table: only their label stands up
        for (const h of this.highlights.items.values()) {
          const c = h.group.getWorldPosition(new THREE.Vector3());
          out.push(new THREE.Box3().setFromCenterAndSize(c.add(new THREE.Vector3(0, 0.06, 0)), new THREE.Vector3(0.25, 0.12, 0.2)));
        }
        return out;
      },
    });
    this.panels.obstacles.push({
      id: 'timers',
      box: () => {
        // the dial and its name, not the soft glow behind it
        return [...this.timers.items.values()].map((t) => {
          const c = t.group.getWorldPosition(new THREE.Vector3());
          return new THREE.Box3().setFromCenterAndSize(c.add(new THREE.Vector3(0, -0.02, 0)), new THREE.Vector3(0.17, 0.22, 0.05));
        });
      },
    });
    // panels also keep clear of running programs' content (labels, parts)
    const progBox = new THREE.Box3();
    this.panels.obstacles.push({
      id: 'programs',
      box: () => {
        progBox.makeEmpty();
        for (const p of this.runtime.programs.values()) if (!p.stopped) progBox.expandByObject(p.scene);
        return progBox.isEmpty() ? null : progBox;
      },
    });
    this.timers.avoid = () => (this.ghost.active ? [this.ghost.group.getWorldPosition(new THREE.Vector3())] : []);
    this.ghost.avoid = () => [
      this.chips.holder.position.clone(),
      ...[...this.panels.recs.values()].filter((r) => !r.closing).map((r) => r.home.clone()),
      ...[...this.timers.items.values()].map((t) => t.group.position.clone()),
    ];
    this.executor = new ToolExecutor({
      look: async (prompt, args) => {
        this.orb.showStatus('Looking...', 3);
        // view: "camera" (passthrough only), "virtual" (Halo's objects only), "mixed" (objects over the camera).
        // Default: mixed when the camera is live; otherwise the camera/sample path as before.
        const view = typeof args?.view === 'string' ? String(args.view) : cameraAvailable() ? 'mixed' : 'camera';
        let r: Record<string, unknown>;
        if (view === 'virtual' || view === 'mixed') {
          try {
            r = await snapshot(this.world, view);
          } catch (e) {
            console.warn('[halo] snapshot failed, falling back to the camera', e);
            r = await look(prompt, args);
          }
        } else r = await look(prompt, args);
        if (r.sample) this.showSampleNote(String(r.sample_name ?? 'sample'));
        this.showSnapshot(String(r.image_b64 ?? ''), String(r.mime ?? 'image/jpeg'));
        r.scene_summary = this.sceneSummary();
        return r;
      },
      room: () => this.roomInfo(),
      panels: this.panels,
      highlights: this.highlights,
      ghost: this.ghost,
      timers: this.timers,
      runtime: this.runtime,
      setChips: (chips) => this.chips.set(chips.map((label) => ({ label }))),
      clearScene: (o) => this.clearScene(o),
      beforeShowPanel: (id) => this.retireChoicePanel(id),
    });
    this.root.updateMatrixWorld(true);
  }

  // ------------------------------------------------------------------------------------------- room
  surfaces(): Surface[] {
    if (this.surfaceCache.at === this.t) return this.surfaceCache.list;
    const out: Surface[] = [];
    let i = 0;
    for (const e of this.planeEntities) {
      try {
        const plane = e.getValue(XRPlane, '_plane');
        if (!plane || !e.object3D) continue;
        const s = planeToSurface(`plane-${++i}`, { object3D: e.object3D, plane });
        if (s) out.push(s);
      } catch {
        /* entity torn down mid-frame */
      }
    }
    let j = 0;
    for (const e of this.meshEntities) {
      try {
        if (!e.object3D) continue;
        const s = meshToSurface(`mesh-${++j}`, {
          object3D: e.object3D,
          semanticLabel: String(e.getValue(XRMesh, 'semanticLabel') ?? ''),
          isBounded3D: !!e.getValue(XRMesh, 'isBounded3D'),
        });
        if (s) out.push(s);
      } catch {
        /* ignore */
      }
    }
    const list = sortForAgent(dedupe([...this.placed, ...out]), this.headPose.position);
    this.surfaceCache = { at: this.t, list };
    return list;
  }

  /**
   * Clear the previous topic: close panels (except those of the program being kept), remove highlights, stop
   * the demonstration hands, remove finished timers (all timers with `all`), stop other programs. The orb and
   * the chip bar stay.
   */
  clearScene(o: { except?: string; all?: boolean; keep?: string[] } = {}) {
    const keepSet = new Set([...(o.keep ?? []), ...(o.except ? [o.except] : [])]);
    let panels = 0;
    for (const r of [...this.panels.recs.values()]) {
      if (r.closing || keepSet.has(r.id) || (r.owner && keepSet.has(r.owner))) continue;
      this.panels.close(r.id);
      panels++;
    }
    let highlights = 0;
    for (const id of [...this.highlights.items.keys()]) if (!keepSet.has(id)) {
      this.highlights.remove(id);
      highlights++;
    }
    const hands = this.ghost.active && !keepSet.has('ghost_hands');
    if (hands) this.ghost.stop();
    for (const t of [...this.timers.items.values()]) if (!keepSet.has(t.id) && (o.all || t.done)) this.timers.remove(t.id);
    const programs: string[] = [];
    for (const id of [...this.runtime.programs.keys()]) if (!keepSet.has(id)) {
      this.runtime.stop(id);
      programs.push(id);
    }
    return { cleared: true, panels, highlights, ghost_hands: hands, programs };
  }

  /** When the user has just picked an option from a panel and a new panel arrives, close the options panel. */
  retireChoicePanel(newId: string) {
    const c = this.lastChoice;
    if (!c) return;
    for (const r of [...this.panels.recs.values()]) {
      if (r.closing || r.id === newId || r.owner) continue;
      const near = (a: string) => a.length >= 3 && (a === c.text || c.text.includes(a) || a.includes(c.text));
      const fromIt = c.panel === r.id || r.buttons.some((b) => near(b.label.toLowerCase()) || near(b.id.toLowerCase()));
      if (fromIt) this.panels.close(r.id);
    }
    this.lastChoice = null;
  }

  /** What Halo has placed, relative to the user's head (for look() results). */
  sceneSummary() {
    const items: { id: string; kind: string; obj: THREE.Object3D; note?: string }[] = [];
    for (const r of this.panels.recs.values()) if (!r.closing) items.push({ id: r.id, kind: 'panel', obj: r.holder, note: r.title ?? (r.spec.title as string | undefined) });
    for (const h of this.highlights.items.values()) items.push({ id: h.id, kind: `highlight-${h.shape}`, obj: h.group, note: h.label?.text });
    for (const t of this.timers.items.values()) items.push({ id: t.id, kind: 'timer', obj: t.group, note: `${t.label}${t.done ? ' (done)' : ''}` });
    if (this.ghost.active) items.push({ id: 'ghost_hands', kind: 'ghost_hands', obj: this.ghost.group, note: this.ghost.motion });
    for (const p of this.runtime.programs.values()) items.push({ id: p.id, kind: 'program', obj: p.scene, note: `${p.spawned.size} objects${p.finished ? ', done' : ''}${p.score != null ? `, score ${p.score}` : ''}` });
    items.push({ id: 'chips', kind: 'chip_bar', obj: this.chips.holder, note: this.chips.chips.map((c) => c.label).join(' | ') });
    items.push({ id: 'halo', kind: 'orb', obj: this.orb.group, note: this.orb.bubbleText || undefined });
    return sceneSummary(this.world, items);
  }

  roomInfo() {
    const surfaces = this.surfaces();
    const work = workSurface(surfaces, this.headPose);
    const h = (x: typeof this.hands.left) => ({ visible: x.visible, pinching: x.pinching });
    const p = this.headPose.position;
    return {
      surfaces: surfaces.slice(0, 24).map((s) => ({ id: s.id, label: s.label, size: s.size, center: s.center, normal: s.normal, ...(s.height ? { height: s.height } : {}) })),
      work_surface: work.id,
      default_spot: work.kind === 'virtual' ? { id: 'front-spot', note: 'no labelled table found; "table" means a spot in front of the seated user', center: work.center } : undefined,
      head: { position: [r3(p.x), r3(p.y), r3(p.z)], forward: [r3(this.headPose.forward.x), 0, r3(this.headPose.forward.z)] },
      hands: { left: h(this.hands.left), right: h(this.hands.right) },
      seated: true,
      in_xr: !!this.world.session,
    };
  }

  // ------------------------------------------------------------------------------------------ network
  connect() {
    if (this.client) return;
    const url = resolveServerUrl(location);
    this.client = new AideClient({
      url,
      hello: () => ({
        type: 'hello',
        user: this.user,
        capabilities: {
          camera: !!media.videoStream && !media.forceSamples,
          mic: !!media.micStream,
          planes: this.planeEntities.size > 0 || !!this.world.session?.enabledFeatures?.includes?.('plane-detection'),
          meshes: this.meshEntities.size > 0,
          hands: this.hands.left.visible || this.hands.right.visible || !!this.world.session,
        },
        room: { surfaces: this.roomInfo().surfaces },
      }),
      onMessage: (m) => this.onMessage(m),
      onState: (s) => {
        if (s === 'open') {
          this.orb.setState('idle');
          this.orb.showStatus('Connected', 2);
        } else if (s === 'closed') {
          this.orb.setState('offline');
          this.orb.showStatus('Reconnecting to Halo...', 30);
        }
      },
    });
    this.client.connect();
  }

  sendEvent(name: string, data?: unknown) {
    if (name === 'panel_button') {
      const d = data as { panel_id?: string; label?: string; button_id?: string };
      this.lastChoice = { text: String(d.label ?? d.button_id ?? '').toLowerCase(), panel: d.panel_id };
    }
    this.events.push({ name, data });
    if (this.events.length > 50) this.events.shift();
    this.client?.send({ type: 'event', name, data });
  }

  /** The user's last choice (said text or pressed panel), used to retire the panel the choice came from. */
  lastChoice: { text: string; panel?: string } | null = null;

  say(text: string) {
    const t = text.trim();
    if (!t) return;
    this.lastChoice = { text: t.toLowerCase() };
    this.client?.send({ type: 'say', text: t });
    this.orb.showStatus(`You: ${t}`, 5);
    this.orb.setState('thinking');
  }

  /** First-run onboarding: one card explaining the hands-only flow; dismissible, shown once per browser. */
  maybeOnboard() {
    let seen = false;
    try {
      seen = localStorage.getItem('halo.onboarded') === '1';
    } catch {
      /* storage blocked: show it */
    }
    if (seen || new URLSearchParams(location.search).get('onboarding') === '0') return;
    void this.panels.show({
      id: '__onboarding',
      title: 'Hands only',
      place: { near: 'front' },
      size: 'small',
      spec: {
        icon: 'hand',
        badge: 'Welcome to Halo',
        text: 'Pinch and hold your wrist to talk, or poke a suggestion.',
        buttons: [{ id: 'ok', label: 'Got it', icon: 'check' }],
      },
      onButton: () => this.dismissOnboarding(),
    });
  }

  dismissOnboarding() {
    if (!this.panels.has('__onboarding')) return;
    this.panels.close('__onboarding');
    try {
      localStorage.setItem('halo.onboarded', '1');
    } catch {
      /* ignore */
    }
  }

  private pressChip(c: Chip) {
    this.dismissOnboarding();
    if (c.panelId && c.buttonId) {
      if (!this.panels.press(c.panelId, c.buttonId, c.label)) this.sendEvent('panel_button', { panel_id: c.panelId, button_id: c.buttonId, label: c.label });
    } else if (c.label === 'Set my table here') this.startPlacing();
    else this.say(c.label);
  }

  setTalking(down: boolean) {
    if (down) {
      this.dismissOnboarding();
      if (this.voice.start()) {
        sound.listenStart();
        this.orb.setState('listening');
        this.orb.showStatus('Listening... let go to send', 30);
        this.talk.setRecording(true);
      } else this.orb.showStatus('Microphone unavailable: use the suggestions', 4);
    } else if (this.voice.recording) {
      this.voice.stop();
      sound.listenStop();
      this.talk.setRecording(false);
      this.orb.setState('thinking');
    }
  }

  async onMessage(m: ServerMessage) {
    this.received.push(m);
    if (this.received.length > 100) this.received.shift();
    switch (m.type) {
      case 'tool_call': {
        const tc = m as Extract<ServerMessage, { type: 'tool_call' }>;
        const out = await this.executor.execute(tc.name, tc.args ?? {});
        if (!out.ok) console.warn(`[halo] tool ${tc.name} failed:`, (out.result as { error?: string })?.error);
        this.client?.send({ type: 'tool_result', call_id: tc.call_id, ok: out.ok, result: out.result });
        return;
      }
      case 'status': {
        const text = String((m as { text?: string }).text ?? '');
        this.statusText = text;
        if (!text) {
          if (this.orb.state === 'thinking') this.orb.setState('idle');
          this.orb.clearStatus();
        } else {
          if (this.orb.state !== 'listening') this.orb.setState('thinking');
          this.orb.showStatus(text, 20);
        }
        return;
      }
      case 'say': {
        const s = m as Extract<ServerMessage, { type: 'say' }>;
        this.orb.say(String(s.text ?? ''));
        sound.tick();
        if (s.audio_b64) void sound.playB64(s.audio_b64, s.mime);
        return;
      }
      case 'heard': {
        const h = m as { text?: string; error?: string };
        this.heardText = String(h.text ?? '');
        if (h.error) this.orb.showStatus(`Didn't catch that (${h.error})`, 4);
        else if (h.text) this.orb.showStatus(`You: ${h.text}`, 6);
        return;
      }
      case 'clear_scene': {
        const cm = m as { keep?: string[] };
        this.clearScene({ all: true, keep: Array.isArray(cm.keep) ? cm.keep : [] });
        return;
      }
      case 'chips': {
        const c = (m as { chips?: unknown[] }).chips;
        if (Array.isArray(c)) this.chips.set(c.map((x) => ({ label: String(x) })));
        return;
      }
      case 'error': {
        const e = m as { text?: string; message?: string };
        console.warn('[halo] server error:', e.text ?? e.message);
        return;
      }
      default:
        return;
    }
  }

  /** A small photo card of what Halo just looked at, beside the orb for a few seconds. */
  private snapCard: THREE.Mesh | null = null;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;
  private showSnapshot(b64: string, mime: string) {
    if (!b64 || typeof document === 'undefined') return;
    const url = b64.startsWith('data:') ? b64 : `data:${mime};base64,${b64}`;
    new THREE.TextureLoader().load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      const img = tex.image as { width: number; height: number };
      const w = 0.22;
      const h = (w * img.height) / Math.max(1, img.width);
      if (this.snapCard) {
        ((this.snapCard.material as THREE.MeshBasicMaterial).map as THREE.Texture | null)?.dispose();
        (this.snapCard.material as THREE.Material).dispose();
        this.snapCard.removeFromParent();
      }
      const card = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, transparent: true }));
      const frame = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.012, h + 0.012), new THREE.MeshBasicMaterial({ color: '#ffd27a', transparent: true, opacity: 0.85, toneMapped: false }));
      frame.position.z = -0.001;
      card.add(frame);
      card.renderOrder = 21;
      // under the orb, a little toward the centre of view
      card.position.set(-0.07 - w / 2, -0.06 - h / 2, 0);
      this.orb.face.add(card);
      this.snapCard = card;
      springIn(card, 1);
      sound.appear();
      if (this.snapTimer) clearTimeout(this.snapTimer);
      this.snapTimer = setTimeout(() => {
        const c = this.snapCard;
        if (c === card) springOut(card, () => card.removeFromParent());
      }, 4500);
    });
  }

  private showSampleNote(name: string) {
    const text = `Using a sample ${name} photo (camera unavailable)`;
    if (!this.sampleNote) {
      this.sampleNote = makeLabel(text, { height: 0.016, fontPx: 36 });
      this.orb.group.children[0].add(this.sampleNote.mesh);
      this.sampleNote.mesh.position.set(0, -0.07, 0);
    } else this.sampleNote.setText(text);
    this.sampleNote.mesh.visible = true;
    setTimeout(() => this.sampleNote && (this.sampleNote.mesh.visible = false), 8000);
  }

  // ------------------------------------------------------------------------------------------ placing
  async startPlacing() {
    if (this.placing) return;
    const reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.06, 0.08, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#5ee6c4', transparent: true, opacity: 0.9, toneMapped: false }),
    );
    this.root.add(reticle);
    this.placing = { reticle, hit: null };
    this.orb.say('Look at your table and pinch to set the spot.');
    const session = this.world.session;
    if (session) {
      try {
        const viewer = await session.requestReferenceSpace('viewer');
        this.placing.source = await this.world.requestHitTestSource({ space: viewer });
      } catch {
        /* no hit test: fall back to the default spot */
      }
    }
    const off = this.hands.onPinch((hand, phase) => {
      if (phase !== 'start' || !this.placing) return;
      off();
      const p = this.placing.hit ?? new THREE.Vector3(...workSurface([], this.headPose).center);
      this.finishPlacing(p);
    });
  }

  private finishPlacing(p: THREE.Vector3) {
    if (!this.placing) return;
    this.placing.source?.cancel?.();
    this.placing.reticle.removeFromParent();
    this.placing = null;
    const id = `placed-${this.placed.length + 1}`;
    const s: Surface = { id, label: 'table', size: [0.6, 0.4], center: [r3(p.x), r3(p.y), r3(p.z)], normal: [0, 1, 0], kind: 'placed', orientation: 'horizontal' };
    this.placed = [s];
    // anchor a small marker at the spot so it stays put
    const marker = new THREE.Mesh(new THREE.RingGeometry(0.02, 0.026, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#5ee6c4', transparent: true, opacity: 0.5 }));
    marker.position.copy(p);
    this.root.add(marker);
    try {
      const e = this.world.createTransformEntity(marker);
      e.addComponent(XRAnchor);
    } catch {
      /* anchors unsupported */
    }
    sound.pop();
    this.surfaceCache.at = -1;
    this.chips.rebuild();
    this.sendEvent('item_placed', { id, label: 'table', point: s.center });
  }

  // ------------------------------------------------------------------------------------------- frame
  frame(dt: number, t: number) {
    this.t = t;
    dt = Math.min(dt, 0.1);
    this.fps = this.fps * 0.95 + (dt > 0 ? 1 / dt : 0) * 0.05;
    const cam = this.world.camera;
    cam.updateMatrixWorld(true);
    cam.getWorldPosition(this.headPose.position);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    f.y = 0;
    if (f.lengthSq() > 1e-4) this.headPose.forward.copy(f.normalize());
    this.hands.update(this.world.xrFrame, this.world.xrReferenceSpace);

    if (this.world.session && this.xrStartedAt < 0) {
      this.xrStartedAt = t;
      // give plane detection ~2.5 s before the agent's hello describes the room
      setTimeout(() => this.maybeOnboard(), 1200);
      setTimeout(() => {
        this.connect();
        this.chips.rebuild(); // offers "Set my table here" when no table was detected
      }, 2500);
    }
    if (this.placing) {
      const src = this.placing.source;
      const frame = this.world.xrFrame;
      const ref = this.world.xrReferenceSpace;
      let hit: THREE.Vector3 | null = null;
      if (src && frame && ref) {
        const r = frame.getHitTestResults(src)[0];
        const pose = r?.getPose(ref);
        if (pose) hit = new THREE.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
      }
      this.placing.hit = hit;
      this.placing.reticle.position.copy(hit ?? new THREE.Vector3(...workSurface([], this.headPose).center));
    }

    this.orb.update(t, dt);
    tickSprings(dt);
    this.panels.update_(t, dt);
    this.highlights.update(t);
    this.ghost.update(t);
    this.timers.update(t);
    this.runtime.update(dt, t);
    this.chips.update(false, dt);
    this.talk.update(t);
    for (const o of this.billboards) {
      if (o.parent) o.lookAt(this.headPose.position);
    }
  }

  /** Desktop/test helper: run a built-in example as if the agent had sent run_code. */
  async runExample(name: string, at: unknown = 'table') {
    const js = EXAMPLES[name];
    if (!js) throw new Error(`no example ${name}`);
    return this.executor.execute('run_code', { id: name, js, at });
  }
}

function userId(): string {
  const q = new URLSearchParams(location.search).get('user');
  if (q) return q.slice(0, 64);
  try {
    let id = localStorage.getItem('aide.user');
    if (!id) {
      id = `u-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem('aide.user', id);
    }
    return id;
  } catch {
    return 'guest';
  }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
export { DEFAULT_CHIPS };
