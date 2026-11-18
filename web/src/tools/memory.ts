// remember / recall in localStorage (the server also keeps its own memory; this is the headset-side copy).
// Every storage access is wrapped: private windows and blocked storage must not break the app.

const PREFIX = 'aide.mem.';
const fallback = new Map<string, string>();

function store(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    if (!s) return null;
    const k = '__aide_probe__';
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

export const memory = {
  remember(key: string, value: unknown) {
    if (!key) throw new Error('remember needs a key');
    const v = JSON.stringify(value ?? null);
    const s = store();
    let persisted = false;
    if (s) {
      try {
        s.setItem(PREFIX + key, v);
        persisted = true;
      } catch {
        /* quota or blocked */
      }
    }
    if (!persisted) fallback.set(key, v);
    return { key, saved: true, persisted };
  },
  recall(key?: string) {
    const s = store();
    const read = (k: string): unknown => {
      let raw: string | null | undefined = null;
      try {
        raw = s?.getItem(PREFIX + k);
      } catch {
        raw = null;
      }
      raw = raw ?? fallback.get(k) ?? null;
      if (raw == null) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    };
    if (key) {
      const value = read(key);
      return { key, found: value !== undefined, value: value ?? null };
    }
    const keys = new Set<string>(fallback.keys());
    try {
      if (s) for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.startsWith(PREFIX)) keys.add(k.slice(PREFIX.length));
      }
    } catch {
      /* ignore */
    }
    const all: Record<string, unknown> = {};
    for (const k of keys) all[k] = read(k);
    return { all };
  },
};
