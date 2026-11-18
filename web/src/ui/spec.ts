// Panel spec -> UIKitML. Pure (unit-tested). The agent may send either `body_uikitml` (raw markup) or a
// simple JSON spec: {title, subtitle, text, list, steps, current, buttons, image, footer, badge}.

import iconData from './icons.json';

export const ICONS = new Set<string>(iconData.icons);
export const ICON_ALIASES: Record<string, string> = iconData.aliases;

/** Bundled Lucide icon name for a requested one (case-insensitive, aliases), or null. */
export function iconName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return null;
  const raw = name.trim().replace(/[-_ ]+(\w)/g, (_, c: string) => c.toUpperCase());
  const pascal = raw[0].toUpperCase() + raw.slice(1);
  if (ICONS.has(pascal)) return pascal;
  if (ICON_ALIASES[pascal]) return ICON_ALIASES[pascal];
  for (const n of ICONS) if (n.toLowerCase() === pascal.toLowerCase()) return n;
  return null;
}

const HORIZON = new Set(['Avatar', 'Badge', 'Button', 'ButtonIcon', 'ButtonLabel', 'ButtonLabelSubtext', 'Checkbox', 'Divider', 'Dropdown', 'DropdownAvatar', 'DropdownButton', 'DropdownIcon', 'DropdownList', 'DropdownListItem', 'DropdownTextValue', 'IconIndicator', 'Input', 'InputField', 'Panel', 'ProgressBar', 'ProgressBarStepper', 'ProgressBarStepperStep', 'RadioGroup', 'RadioGroupItem', 'Slider', 'Toggle']);

/**
 * Make agent-written UIKitML safe for the production build: icon aliases are mapped to bundled icons, and
 * capitalised tags that are neither Horizon components nor bundled icons are dropped silently.
 */
export function sanitizeUikitml(src: string): { source: string; dropped: string[] } {
  const dropped: string[] = [];
  const out = src.replace(/<(\/?)([A-Z][A-Za-z0-9]*)(\s[^<>]*?)?(\/?)>/g, (m, close: string, name: string, attrs = '', self: string) => {
    if (HORIZON.has(name)) return m;
    const icon = ICONS.has(name) ? name : iconName(name);
    if (icon) return `<${close}${icon}${attrs}${self}>`;
    if (!dropped.includes(name)) dropped.push(name);
    return '';
  });
  return { source: out, dropped };
}

export interface PanelButton {
  id: string;
  label: string;
  icon?: string;
  variant?: 'primary' | 'secondary' | 'tertiary' | 'positive' | 'negative';
}
export interface PanelSpec {
  title?: string;
  subtitle?: string;
  badge?: string;
  text?: string;
  list?: (string | { label?: string; text?: string; detail?: string; checked?: boolean })[];
  steps?: (string | { label?: string; text?: string; detail?: string })[];
  current?: number; // 1-based current step
  active_step?: number; // 0-based (server schema)
  bullets?: string[];
  checklist?: { label: string; done?: boolean }[];
  buttons?: (string | Partial<PanelButton>)[];
  image?: string;
  footer?: string;
  accent?: string;
  icon?: string;
}

/** UIKit units per panel width. Fonts are in the same units; the panel is scaled to its world width. */
export const PANEL_UNITS = 600;

export function escapeText(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function safeColor(c: unknown, fallback: string): string {
  if (typeof c !== 'string') return fallback;
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + [...c.slice(1)].map((x) => x + x).join('');
  return fallback;
}

export function slugId(s: string, i: number): string {
  const b = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  return b || `button-${i + 1}`;
}

export function normalizeButtons(buttons: PanelSpec['buttons']): PanelButton[] {
  if (!Array.isArray(buttons)) return [];
  return buttons.slice(0, 6).map((b, i) => {
    if (typeof b === 'string') return { id: slugId(b, i), label: b, variant: i === 0 ? 'primary' : 'secondary' };
    const label = String(b?.label ?? b?.id ?? `Option ${i + 1}`);
    const icon = iconName(b?.icon) ?? undefined;
    return { id: String(b?.id ?? slugId(label, i)), label, variant: b?.variant ?? (i === 0 ? 'primary' : 'secondary'), icon };
  });
}

function itemText(it: unknown): { label: string; detail?: string; checked?: boolean } {
  if (typeof it === 'string' || typeof it === 'number') return { label: String(it) };
  const o = (it ?? {}) as Record<string, unknown>;
  return {
    label: String(o.label ?? o.text ?? o.name ?? ''),
    detail: o.detail != null ? String(o.detail) : o.amount != null ? String(o.amount) : undefined,
    checked: o.checked === true || o.done === true ? true : undefined,
  };
}

const STYLE = (accent: string) => `<style>
  .ax-root { flex-direction: column; width: ${PANEL_UNITS}px; padding-top: 32px; padding-bottom: 32px; padding-left: 36px; padding-right: 36px; gap: 18px; border-radius: 36px; border-width: 2px; border-color: ${accent}55; }
  .ax-head { flex-direction: row; align-items: center; gap: 18px; }
  .ax-head-text { flex-direction: column; gap: 6px; flex-shrink: 1; }
  .ax-icon { width: 64px; height: 64px; border-radius: 32px; align-items: center; justify-content: center; background-color: ${accent}26; flex-shrink: 0; }
  .ax-badge { color: ${accent}; font-size: 20px; font-weight: 700; }
  .ax-title { color: #f6f4ef; font-size: 40px; font-weight: 700; line-height: 1.2; }
  .ax-subtitle { color: #c9cdd4; font-size: 26px; line-height: 1.3; }
  .ax-text { color: #ecebe6; font-size: 28px; line-height: 1.4; }
  .ax-list { flex-direction: column; gap: 12px; }
  .ax-row { flex-direction: row; align-items: center; gap: 16px; }
  .ax-dot { width: 12px; height: 12px; border-radius: 6px; background-color: ${accent}; flex-shrink: 0; }
  .ax-check { width: 24px; height: 24px; border-radius: 8px; background-color: ${accent}; flex-shrink: 0; }
  .ax-box { width: 24px; height: 24px; border-radius: 8px; border-width: 3px; border-color: #8b95a2; flex-shrink: 0; }
  .ax-item { color: #f6f4ef; font-size: 28px; line-height: 1.3; flex-grow: 1; flex-shrink: 1; }
  .ax-detail { color: #c9cdd4; font-size: 26px; flex-shrink: 0; }
  .ax-steps { flex-direction: column; gap: 10px; }
  .ax-step { flex-direction: row; align-items: center; gap: 18px; padding-top: 12px; padding-bottom: 12px; padding-left: 14px; padding-right: 18px; border-radius: 22px; }
  .ax-step-on { background-color: ${accent}22; border-width: 2px; border-color: ${accent}; }
  .ax-num { width: 46px; height: 46px; border-radius: 23px; align-items: center; justify-content: center; background-color: #2a3340; flex-shrink: 0; }
  .ax-num-on { background-color: ${accent}; }
  .ax-num-text { color: #f6f4ef; font-size: 24px; font-weight: 700; }
  .ax-num-text-on { color: #2a1d00; font-size: 24px; font-weight: 700; }
  .ax-step-text { color: #f6f4ef; font-size: 28px; line-height: 1.3; flex-shrink: 1; }
  .ax-step-done { color: #8b95a2; font-size: 26px; line-height: 1.3; flex-shrink: 1; }
  .ax-buttons { flex-direction: row; flex-wrap: wrap; gap: 12px; padding-top: 8px; }
  .ax-btn-label { font-size: 26px; }
  .ax-footer { color: #aab3be; font-size: 22px; }
  .ax-image { width: ${PANEL_UNITS - 72}px; height: 300px; border-radius: 22px; }
</style>`;

/** Fold the server schema's aliases (bullets, checklist, active_step) into list/steps/current. */
export function normalizeSpec(spec: PanelSpec): PanelSpec {
  const out: PanelSpec = { ...spec };
  if (!out.list && Array.isArray(out.bullets)) out.list = out.bullets;
  if (!out.list && Array.isArray(out.checklist)) out.list = out.checklist.map((c) => ({ label: c?.label ?? '', checked: !!c?.done }));
  if (typeof out.active_step === 'number' && typeof out.current !== 'number') out.current = out.active_step + 1;
  return out;
}

export function specToUikitml(input: PanelSpec): { source: string; buttons: PanelButton[] } {
  const spec = normalizeSpec(input);
  const accent = safeColor(spec.accent, '#ffd27a');
  const parts: string[] = [];
  const head: string[] = [];
  if (spec.badge) head.push(`<span class="ax-badge">${escapeText(String(spec.badge).toUpperCase())}</span>`);
  if (spec.title) head.push(`<span class="ax-title">${escapeText(spec.title)}</span>`);
  if (spec.subtitle) head.push(`<span class="ax-subtitle">${escapeText(spec.subtitle)}</span>`);
  const icon = iconName(spec.icon);
  if (head.length || icon) {
    const ic = icon ? `<div class="ax-icon"><${icon} width="38" height="38" color="${accent}"></${icon}></div>` : '';
    parts.push(`<div class="ax-head">${ic}<div class="ax-head-text">${head.join('')}</div></div>`);
  }
  if (spec.image && /^(https?:|data:image\/|\.?\/|samples\/)/.test(spec.image)) {
    parts.push(`<img class="ax-image" src="${escapeText(spec.image)}" />`);
  }
  if (spec.text) {
    for (const para of String(spec.text).split(/\n{2,}|\n/).slice(0, 8)) {
      if (para.trim()) parts.push(`<span class="ax-text">${escapeText(para.trim())}</span>`);
    }
  }
  if (Array.isArray(spec.list) && spec.list.length) {
    const rows = spec.list.slice(0, 12).map((it) => {
      const t = itemText(it);
      const mark = t.checked === true ? '<div class="ax-check"></div>' : spec.list!.some((x) => typeof x === 'object' && x && ('checked' in x || 'done' in x)) ? '<div class="ax-box"></div>' : '<div class="ax-dot"></div>';
      const detail = t.detail ? `<span class="ax-detail">${escapeText(t.detail)}</span>` : '';
      return `<div class="ax-row">${mark}<span class="ax-item">${escapeText(t.label)}</span>${detail}</div>`;
    });
    parts.push(`<div class="ax-list">${rows.join('')}</div>`);
  }
  if (Array.isArray(spec.steps) && spec.steps.length) {
    const cur = typeof spec.current === 'number' ? spec.current : 0;
    const rows = spec.steps.slice(0, 10).map((s, i) => {
      const t = itemText(s);
      const n = i + 1;
      const on = n === cur;
      const done = cur > 0 && n < cur;
      return `<div class="ax-step${on ? ' ax-step-on' : ''}"><div class="ax-num${on ? ' ax-num-on' : ''}"><span class="${on ? 'ax-num-text-on' : 'ax-num-text'}">${n}</span></div><span class="${done ? 'ax-step-done' : 'ax-step-text'}">${escapeText(t.label)}</span></div>`;
    });
    parts.push(`<div class="ax-steps">${rows.join('')}</div>`);
  }
  const buttons = normalizeButtons(spec.buttons);
  if (buttons.length) {
    const bs = buttons.map(
      (b) =>
        `<Button id="btn-${escapeText(b.id)}" variant="${b.variant}" size="lg">${b.icon ? `<ButtonIcon><${b.icon}></${b.icon}></ButtonIcon>` : ''}<ButtonLabel class="ax-btn-label">${escapeText(b.label)}</ButtonLabel></Button>`,
    );
    parts.push(`<div class="ax-buttons">${bs.join('')}</div>`);
  }
  if (spec.footer) parts.push(`<span class="ax-footer">${escapeText(spec.footer)}</span>`);
  if (!parts.length) parts.push(`<span class="ax-text"> </span>`);
  const source = `${STYLE(accent)}\n<Panel class="ax-root">${parts.join('')}</Panel>`;
  return { source, buttons };
}

/** Merge an update_panel patch into a spec. Arrays replace; `append_list` / `append_steps` append. */
export function mergeSpec(base: PanelSpec, patch: Record<string, unknown>): PanelSpec {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k === 'append_list' && Array.isArray(v)) out.list = [...((base.list as unknown[]) ?? []), ...v];
    else if (k === 'append_steps' && Array.isArray(v)) out.steps = [...((base.steps as unknown[]) ?? []), ...v];
    else if (k === 'spec' && v && typeof v === 'object') Object.assign(out, v);
    else if (v === null) delete out[k];
    else out[k] = v;
  }
  return out as PanelSpec;
}

export const PANEL_SIZES: Record<string, number> = { small: 0.4, medium: 0.52, large: 0.7, wide: 0.85 };

export function panelWidth(size: unknown): number {
  if (typeof size === 'number' && size > 0.1 && size < 2) return size;
  if (Array.isArray(size) && typeof size[0] === 'number' && size[0] > 0.1 && size[0] < 2) return size[0];
  if (typeof size === 'string' && PANEL_SIZES[size]) return PANEL_SIZES[size];
  return PANEL_SIZES.medium;
}
