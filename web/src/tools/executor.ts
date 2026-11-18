import type { PanelHost } from '../ui/panel-host.js';
import type { Highlights } from '../ui/highlights.js';
import type { GhostHands } from '../ui/ghost-hands.js';
import type { Timers } from '../ui/timers.js';
import type { CodeRuntime } from '../runtime/runtime.js';
import { memory } from './memory.js';

// Runs the agent's tool calls in the headset and returns {ok, result} for the tool_result message.

export interface ToolDeps {
  look(prompt?: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  room(): Record<string, unknown>;
  panels: PanelHost;
  highlights: Highlights;
  ghost: GhostHands;
  timers: Timers;
  runtime: CodeRuntime;
  setChips?(chips: string[]): void;
  /** Clear the previous topic's UI (panels, highlights, demo hands, finished timers, other programs). */
  clearScene?(opts: { except?: string; all?: boolean; keep?: string[] }): Record<string, unknown>;
  /** Called before a panel is shown (retires an options panel the user just chose from). */
  beforeShowPanel?(id: string): void;
}

export interface ToolOutcome {
  ok: boolean;
  result: unknown;
}

export const TOOL_NAMES = [
  'look', 'room', 'show_panel', 'update_panel', 'close_panel', 'highlight', 'ghost_hands', 'timer',
  'run_code', 'stop_code', 'remember', 'recall', 'set_chips', 'clear_scene',
] as const;

const str = (v: unknown, d = '') => (typeof v === 'string' ? v : v == null ? d : String(v));

export class ToolExecutor {
  log: { name: string; ok: boolean; ms: number }[] = [];
  constructor(private d: ToolDeps) {}

  async execute(name: string, rawArgs: unknown): Promise<ToolOutcome> {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let args: Record<string, unknown> = {};
    if (typeof rawArgs === 'string') {
      try {
        args = JSON.parse(rawArgs || '{}');
      } catch {
        return { ok: false, result: { error: 'arguments are not valid JSON' } };
      }
    } else if (rawArgs && typeof rawArgs === 'object') args = rawArgs as Record<string, unknown>;
    let out: ToolOutcome;
    try {
      out = { ok: true, result: await this.run(name, args) };
    } catch (e) {
      out = { ok: false, result: { error: e instanceof Error ? e.message : String(e) } };
    }
    if (out.ok && out.result && typeof out.result === 'object' && (out.result as { __fail?: boolean }).__fail) {
      const { __fail, ...rest } = out.result as Record<string, unknown>;
      void __fail;
      out = { ok: false, result: rest };
    }
    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.log.push({ name, ok: out.ok, ms: Math.round(t1 - t0) });
    if (this.log.length > 100) this.log.shift();
    return out;
  }

  private async run(name: string, a: Record<string, unknown>): Promise<unknown> {
    const d = this.d;
    switch (name) {
      case 'look':
        return d.look(str(a.prompt), a);
      case 'room':
        return d.room();
      case 'show_panel': {
        const id = str(a.id, 'panel');
        if (!d.panels.has(id)) d.beforeShowPanel?.(id);
        const info = await d.panels.show({
          id,
          title: str(a.title) || undefined,
          spec: (a.spec as Record<string, unknown>) ?? undefined,
          body_uikitml: typeof a.body_uikitml === 'string' ? a.body_uikitml : undefined,
          place: a.place,
          size: a.size,
        });
        return { id: info.id, position: info.position, buttons: info.buttons.map((b) => b.id) };
      }
      case 'update_panel': {
        const id = str(a.id);
        if (!d.panels.has(id)) throw new Error(`no panel "${id}"; open panels: ${d.panels.list().join(', ') || 'none'}`);
        const patch = (a.patch && typeof a.patch === 'object' ? a.patch : {}) as Record<string, unknown>;
        // tolerate fields sent at the top level instead of inside patch
        for (const k of ['title', 'spec', 'place', 'size', 'body_uikitml']) if (a[k] !== undefined && patch[k] === undefined) patch[k] = a[k];
        const info = await d.panels.update(id, patch);
        return { id: info.id, position: info.position };
      }
      case 'close_panel': {
        const id = str(a.id);
        return { id, closed: d.panels.close(id) };
      }
      case 'highlight':
        return d.highlights.show(a as never);
      case 'ghost_hands':
        return d.ghost.play({
          motion: str(a.motion, 'chop'),
          at: a.at,
          keyframes: a.keyframes,
          loops: typeof a.loops === 'number' ? a.loops : undefined,
          loop: a.loop === true,
          duration: typeof a.duration === 'number' ? a.duration : undefined,
          caption: typeof a.label === 'string' ? a.label : typeof a.caption === 'string' ? a.caption : undefined,
          tool: typeof a.tool === 'string' ? a.tool : undefined,
        });
      case 'timer':
        return d.timers.start({
          id: typeof a.id === 'string' ? a.id : undefined,
          label: str(a.label, 'Timer'),
          seconds: Number(a.seconds),
          at: a.at,
          cancel: a.cancel === true,
        });
      case 'run_code': {
        // a new program is a new topic: clear the previous one's UI first (keeps the orb and chips)
        d.clearScene?.({ except: str(a.id, 'program') });
        const r = await d.runtime.run(str(a.id, 'program'), str(a.js ?? a.code ?? a.src), a.at);
        return r.ok ? r.result : { __fail: true, ...(r.result as object) };
      }
      case 'stop_code': {
        const id = str(a.id);
        if (id === '*' || id === 'all') {
          d.runtime.stopAll();
          return { id, stopped: true };
        }
        return { id, stopped: d.runtime.stop(id) };
      }
      case 'remember':
        return memory.remember(str(a.key), a.value);
      case 'recall':
        return memory.recall(typeof a.key === 'string' ? a.key : undefined);
      case 'set_chips': {
        const chips = Array.isArray(a.chips) ? a.chips.map((c) => str(c)).filter(Boolean).slice(0, 5) : [];
        d.setChips?.(chips);
        return { chips };
      }
      case 'clear_scene':
        // server schema: clear_scene({keep: string[]}) removes everything except the orb, the chips and those ids
        return d.clearScene
          ? d.clearScene({ all: a.all !== false, keep: Array.isArray(a.keep) ? a.keep.map(String) : typeof a.keep === 'string' ? [a.keep] : [] })
          : { cleared: false };
      default:
        throw new Error(`unknown tool "${name}"`);
    }
  }
}
