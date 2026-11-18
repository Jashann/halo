// Builds dist-emulator/: the production app plus the IWER emulator (injectOnBuild), without touching dist/.
// iwsdk.config.json is the only place IWSDK accepts emulator options, so it is patched for the build and restored.
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const file = new URL('../iwsdk.config.json', import.meta.url);
const original = fs.readFileSync(file, 'utf8');
try {
  const cfg = JSON.parse(original);
  cfg.dev = cfg.dev ?? {};
  cfg.dev.emulator = { ...(cfg.dev.emulator ?? {}), injectOnBuild: true, activation: 'localhost' };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  execSync('npx vite build', { stdio: 'inherit', env: { ...process.env, AIDE_EMULATOR: '1' } });
} finally {
  fs.writeFileSync(file, original);
}
