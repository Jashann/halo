/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { defineConfig } from 'vite';
import iconData from './src/ui/icons.json' with { type: 'json' };

// `npm run build:emulator` (scripts/build-emulator.mjs) builds dist-emulator/: the same app plus the IWER emulator,
// which activates only on localhost and never in Quest Browser. For recording and e2e runs against the real server.
const emulatorBuild = process.env.AIDE_EMULATOR === '1';

export default defineConfig({
  // Panels are built from UIKitML at runtime (no static .uikitml files), so the font and the Lucide icons the
  // agent may name are bundled explicitly. Unknown icon names are dropped by sanitizeUikitml() at runtime.
  plugins: [iwsdkDev({ bundle: { fonts: ['inter'], icons: iconData.icons } })],
  server: { host: '0.0.0.0', port: 8081, open: false },
  build: {
    outDir: emulatorBuild ? 'dist-emulator' : 'dist',
    sourcemap: process.env.NODE_ENV !== 'production',
    target: 'esnext',
    rollupOptions: { input: './index.html' },
  },
  esbuild: { target: 'esnext' },
  // @drawcall/uikitml otherwise pulls a second three/@pmndrs/uikit graph
  // (its own three vs the app's super-three alias). Duplicate Component classes break
  // instanceof checks → "Only pmndrs/uikit components can be added as children".
  resolve: {
    dedupe: [
      'three',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
    ],
  },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
    include: [
      'three',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
      '@drawcall/uikitml',
    ],
    esbuildOptions: { target: 'esnext' },
  },
  publicDir: 'public',
  base: './',
});
