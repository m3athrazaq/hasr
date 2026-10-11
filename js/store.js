// IndexedDB persistence: sessions (one small document each), count events, and review clips.
// Everything stays on this device; a crash or a closed tab never loses the count.
const DB_NAME = 'hasr';
const DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('events')) {
        const s = db.createObjectStore('events', { keyPath: ['sid', 'seq'] });
        s.createIndex('sid', 'sid');
      }
      if (!db.objectStoreNames.contains('clips')) {
        const s = db.createObjectStore('clips', { keyPath: ['sid', 'fid'] });
        s.createIndex('sid', 'sid');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const store = {
  async putSession(s) {
    try { await tx('sessions', 'readwrite', (os) => os.put(JSON.parse(JSON.stringify(s)))); } catch (e) { console.warn('save session', e); }
  },
  async getSession(id) {
    try { return await tx('sessions', 'readonly', (os) => reqP(os.get(id))); } catch { return null; }
  },
  async listSessions() {
    try {
      const all = await tx('sessions', 'readonly', (os) => reqP(os.getAll()));
      return (all || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch { return []; }
  },
  async addEvents(list) {
    if (!list.length) return;
    try { await tx('events', 'readwrite', (os) => { for (const e of list) os.put(e); }); } catch (e) { console.warn('save events', e); }
  },
  async getEvents(sid) {
    try { return await tx('events', 'readonly', (os) => reqP(os.index('sid').getAll(sid))); } catch { return []; }
  },
  async putClip(sid, fid, frames) {
    try { await tx('clips', 'readwrite', (os) => os.put({ sid, fid, frames })); } catch (e) { console.warn('save clip', e); }
  },
  async getClip(sid, fid) {
    try { return await tx('clips', 'readonly', (os) => reqP(os.get([sid, fid]))); } catch { return null; }
  },
  async deleteSession(id) {
    try {
      await tx('sessions', 'readwrite', (os) => os.delete(id));
      for (const name of ['events', 'clips']) {
        await tx(name, 'readwrite', (os) => new Promise((res) => {
          const r = os.index('sid').openKeyCursor(IDBKeyRange.only(id));
          r.onsuccess = () => { const c = r.result; if (c) { os.delete(c.primaryKey); c.continue(); } else res(); };
          r.onerror = () => res();
        }));
      }
    } catch (e) { console.warn('delete session', e); }
  },
  async usage() {
    try { const e = await navigator.storage?.estimate?.(); return e ? e.usage : 0; } catch { return 0; }
  },
};

// Small key/value settings (per device)
const KEY = 'hasr.settings.v1';
export const DEFAULT_SETTINGS = {
  lang: 'ar', backend: 'auto', view: 'auto', sensitivity: 'normal', band: 0.02, sound: false, clipsAll: false,
  lastCamera: '', presets: {},
};
export function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(KEY) || '{}')) }; } catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage may be unavailable */ }
}
