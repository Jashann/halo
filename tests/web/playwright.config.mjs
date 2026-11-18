import { defineConfig } from '@playwright/test';

// Runs the IWSDK dev server (plain Vite + the IWSDK plugin, which injects the IWER emulator on localhost).
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'https://localhost:8081',
    ignoreHTTPSErrors: true,
    channel: 'chromium',
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-gpu-blocklist'],
    },
  },
  webServer: {
    command: 'npx vite --port 8081 --strictPort',
    cwd: '../../web',
    url: 'https://localhost:8081',
    ignoreHTTPSErrors: true,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
