import * as THREE from 'three';
import { THEME } from './theme.js';

// Canvas text labels: one quad, one texture, one draw call. Used for highlight tags, timers, speech
// bubbles and generated-code labels. Falls back to a blank texture when no 2D canvas exists (Node tests).

export interface LabelOptions {
  fontPx?: number; // canvas font size; world size comes from `height`
  height?: number; // world height of one text line in metres
  color?: string;
  background?: string | null;
  border?: string | null;
  maxWidthPx?: number;
  padding?: number;
  align?: 'center' | 'left';
}

export interface Label {
  mesh: THREE.Mesh;
  setText(text: string): void;
  text: string;
  dispose(): void;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas | null {
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    // jsdom has no 2D context
    try {
      if (!c.getContext('2d')) return null;
    } catch {
      return null;
    }
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && line) {
        out.push(line);
        line = w;
      } else line = t;
    }
    out.push(line);
  }
  return out.slice(0, 8);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function makeLabel(text: string, opts: LabelOptions = {}): Label {
  const fontPx = opts.fontPx ?? 44;
  const lineH = Math.round(fontPx * 1.3);
  const pad = opts.padding ?? Math.round(fontPx * 0.55);
  const maxW = opts.maxWidthPx ?? 900;
  const worldLine = opts.height ?? 0.035;
  const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false });
  const geometry = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 10;
  let texture: THREE.Texture | null = null;

  const label: Label = {
    mesh,
    text: '',
    setText(t: string) {
      if (t === label.text && texture) return;
      label.text = t;
      const probe = makeCanvas(4, 4);
      const pctx = probe ? (probe.getContext('2d') as CanvasRenderingContext2D | null) : null;
      if (!probe || !pctx) {
        // Headless: keep a sensible size so layout code still works.
        const approxW = Math.min(maxW, t.length * fontPx * 0.55) + pad * 2;
        mesh.scale.set((approxW / lineH) * worldLine, worldLine * 1.4, 1);
        return;
      }
      const font = THEME.font.replace('{size}', String(fontPx));
      pctx.font = font;
      const lines = wrap(pctx, t, maxW);
      const textW = Math.max(...lines.map((l) => pctx.measureText(l).width), fontPx);
      const w = Math.ceil(textW + pad * 2);
      const h = Math.ceil(lines.length * lineH + pad * 1.4);
      const canvas = makeCanvas(w, h)!;
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      if (opts.background !== null) {
        ctx.fillStyle = opts.background ?? 'rgba(15,18,22,0.88)';
        roundRect(ctx, 1, 1, w - 2, h - 2, Math.min(h / 2, fontPx * 0.7));
        ctx.fill();
        if (opts.border !== null) {
          ctx.strokeStyle = opts.border ?? 'rgba(255,255,255,0.14)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
      ctx.font = font;
      ctx.fillStyle = opts.color ?? THEME.text;
      ctx.textBaseline = 'middle';
      ctx.textAlign = opts.align === 'left' ? 'left' : 'center';
      lines.forEach((l, i) => {
        const x = opts.align === 'left' ? pad : w / 2;
        ctx.fillText(l, x, pad * 0.7 + lineH * (i + 0.5));
      });
      texture?.dispose();
      texture = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      material.map = texture;
      material.needsUpdate = true;
      const unit = worldLine / lineH;
      mesh.scale.set(w * unit, h * unit, 1);
    },
    dispose() {
      texture?.dispose();
      material.dispose();
      geometry.dispose();
      mesh.removeFromParent();
    },
  };
  label.setText(text);
  return label;
}
