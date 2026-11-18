// Per-user memory: a small JSON file per user id with preferences and a short recent history.
import fs from 'node:fs';
import path from 'node:path';

const MAX_HISTORY = 30;
const MAX_PREFS = 60;

export function safeUserId(id) {
  const s = String(id || 'guest').toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64);
  return s || 'guest';
}

export class MemoryStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map();
  }

  file(user) {
    return path.join(this.dir, `${safeUserId(user)}.json`);
  }

  load(user) {
    const id = safeUserId(user);
    if (this.cache.has(id)) return this.cache.get(id);
    let data = { prefs: {}, history: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
      data = { prefs: parsed.prefs || {}, history: Array.isArray(parsed.history) ? parsed.history : [] };
    } catch {}
    this.cache.set(id, data);
    return data;
  }

  save(user) {
    const id = safeUserId(user);
    const data = this.load(id);
    const tmp = this.file(id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file(id));
  }

  remember(user, key, value) {
    const data = this.load(user);
    const k = String(key).slice(0, 80);
    data.prefs[k] = { value: typeof value === 'string' ? value.slice(0, 500) : value, at: new Date().toISOString() };
    const keys = Object.keys(data.prefs);
    if (keys.length > MAX_PREFS) {
      keys.sort((a, b) => String(data.prefs[a].at).localeCompare(String(data.prefs[b].at)));
      for (const old of keys.slice(0, keys.length - MAX_PREFS)) delete data.prefs[old];
    }
    this.save(user);
    return { ok: true, key: k };
  }

  recall(user, key) {
    const data = this.load(user);
    if (!key) return { prefs: Object.fromEntries(Object.entries(data.prefs).map(([k, v]) => [k, v.value])), history: data.history.slice(-10) };
    const hit = data.prefs[key];
    if (hit) return { key, value: hit.value, at: hit.at };
    // loose match so "favorite_game" finds "favourite_game"
    const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, '').replace(/ou/g, 'o');
    const found = Object.keys(data.prefs).find((k) => norm(k) === norm(key) || norm(k).includes(norm(key)));
    return found ? { key: found, value: data.prefs[found].value, at: data.prefs[found].at } : { key, value: null };
  }

  addHistory(user, text) {
    const data = this.load(user);
    data.history.push({ at: new Date().toISOString(), text: String(text).slice(0, 200) });
    if (data.history.length > MAX_HISTORY) data.history = data.history.slice(-MAX_HISTORY);
    this.save(user);
  }

  // Short text block for the system prompt.
  summary(user) {
    const data = this.load(user);
    const prefs = Object.entries(data.prefs).map(([k, v]) => `- ${k}: ${typeof v.value === 'string' ? v.value : JSON.stringify(v.value)}`);
    const hist = data.history.slice(-8).map((h) => `- ${h.at.slice(0, 16).replace('T', ' ')}: ${h.text}`);
    if (!prefs.length && !hist.length) return 'Nothing yet. This may be a first visit.';
    return [prefs.length ? 'Preferences:\n' + prefs.join('\n') : '', hist.length ? 'Recent history:\n' + hist.join('\n') : '']
      .filter(Boolean)
      .join('\n');
  }
}
