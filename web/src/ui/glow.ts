import * as THREE from 'three';

// Shared soft-glow textures (radial bloom, rounded-rect shadow). Generated once on a canvas; plain fallbacks in
// Node so modules stay testable.

let radial: THREE.Texture | null = null;
let shadow: THREE.Texture | null = null;

function canvas(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  try {
    return c.getContext('2d') ? c : null;
  } catch {
    return null;
  }
}

export function radialGlow(): THREE.Texture | null {
  if (radial) return radial;
  const c = canvas(128, 128);
  if (!c) return null;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  radial = new THREE.CanvasTexture(c);
  radial.colorSpace = THREE.SRGBColorSpace;
  return radial;
}

/** Soft drop shadow / rim glow behind a rounded card (white; tint with material colour). */
export function cardShadow(): THREE.Texture | null {
  if (shadow) return shadow;
  const c = canvas(256, 256);
  if (!c) return null;
  const ctx = c.getContext('2d')!;
  ctx.filter = 'blur(18px)';
  ctx.fillStyle = 'rgba(255,255,255,1)';
  const r = 40;
  const x = 40, y = 40, w = 176, h = 176;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
  shadow = new THREE.CanvasTexture(c);
  shadow.colorSpace = THREE.SRGBColorSpace;
  return shadow;
}

export function glowMaterial(color: THREE.ColorRepresentation, opacity = 0.6): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    map: radialGlow(),
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}
