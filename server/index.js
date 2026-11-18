import { createHaloServer } from './src/server.js';

const app = createHaloServer();
const addr = await app.listen();
const proto = app.config.sslCert && app.config.sslKey ? 'https' : 'http';
console.log(`Halo server on ${proto}://${addr.address}:${addr.port} (ws on the same port), web: ${app.config.webDist}`);
if (!app.config.apiKey) console.warn('No Meta API key found (META_API_KEY or ~/.meta_api_key): model calls will fail.');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
