// Halo's visual identity: warm luminous gold for the agent and its marks, cool sky for "thinking", rose for
// "listening", on dark glass. One palette for panels, labels, highlights, timers, ghost hands and the orb.
export const THEME = {
  ink: '#0b0f14',
  panel: '#121821',
  panelEdge: '#2a3340',
  text: '#f6f4ef',
  textDim: '#c9cdd4',
  halo: '#ffd27a', // the halo: agent presence, primary actions, default marks
  haloSoft: '#fff1cc',
  accent: '#ffd27a',
  accentInk: '#2a1d00',
  warm: '#ffb547', // timers, heat
  sky: '#8fd3ff', // thinking
  rose: '#ff8fab', // listening
  mint: '#7ef0c8', // success / done
  danger: '#ff6b6b',
  info: '#8fd3ff',
  font: '600 {size}px "Inter", "Segoe UI", system-ui, sans-serif',
};

export const NAMED_COLORS: Record<string, string> = {
  halo: THEME.halo,
  gold: THEME.halo,
  accent: THEME.halo,
  mint: THEME.mint,
  green: '#7ee08a',
  yellow: '#ffe066',
  orange: THEME.warm,
  amber: THEME.warm,
  red: THEME.danger,
  blue: THEME.sky,
  sky: THEME.sky,
  purple: '#b9a1ff',
  white: '#ffffff',
  pink: THEME.rose,
  rose: THEME.rose,
};

export function resolveColor(c: unknown, fallback = THEME.halo): string {
  if (typeof c !== 'string' || !c.trim()) return fallback;
  const k = c.trim().toLowerCase();
  if (NAMED_COLORS[k]) return NAMED_COLORS[k];
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(k)) return k;
  return fallback;
}
