/**
 * 测试用最小 IndexedDB 内存实现。
 * 只实现 src/store/db.js 实际用到的能力，让回归测试可以跑**真实的**
 * db.js / sync.js / reconcile.js（而不是把逻辑复制一份去测）。
 * 仅用于 Node 测试环境，不进打包产物。
 */
/**
 * 极简 IndexedDB 内存实现 —— 只覆盖 src/store/db.js 用到的能力：
 * open/onupgradeneeded/createObjectStore、transaction、objectStore、
 * put/get/getAll/delete、index('byBook').count/openCursor/openKeyCursor、IDBKeyRange。
 * 目的是在无浏览器环境下跑通真实的 db.js / sync.js / reconcile.js 集成。
 */
const storesByDb = new WeakMap();

class FakeRequest {
  constructor() { this.result = undefined; this.error = null; this.onsuccess = null; this.onerror = null; }
  _succeed(v) { this.result = v; queueMicrotask(() => this.onsuccess && this.onsuccess({ target: this })); }
  _fail(e) { this.error = e; queueMicrotask(() => this.onerror && this.onerror({ target: this })); }
}

function keyOf(store, key) {
  if (Array.isArray(store.keyPath)) return JSON.stringify(key);
  return String(key);
}
function recordKey(store, record) {
  const kp = store.keyPath;
  if (Array.isArray(kp)) return JSON.stringify(kp.map((k) => record[k]));
  return String(record[kp]);
}
function extractKey(store, record) {
  const kp = store.keyPath;
  if (Array.isArray(kp)) return kp.map((k) => record[k]);
  return record[kp];
}

class FakeIndex {
  constructor(store, name, keyPath) { this.store = store; this.name = name; this.keyPath = keyPath; }
  _matching(range) {
    const out = [];
    for (const [key, rec] of this.store.data) {
      const v = rec[this.keyPath];
      if (!range || range._matches(v)) out.push(rec);
    }
    return out;
  }
  count(range) {
    const req = new FakeRequest();
    req._succeed(this._matching(range).length);
    return req;
  }
  getAll(range) {
    const req = new FakeRequest();
    req._succeed(this._matching(range));
    return req;
  }
  openCursor(range) {
    const req = new FakeRequest();
    const rows = this._matching(range);
    let i = 0;
    const step = () => {
      if (i >= rows.length) { req.result = null; req.onsuccess?.({ target: req }); return; }
      const rec = rows[i++];
      req.result = { primaryKey: extractKey(this.store, rec), value: rec, continue: () => queueMicrotask(step) };
      req.onsuccess?.({ target: req });
    };
    queueMicrotask(step);
    return req;
  }
  openKeyCursor(range) {
    const req = new FakeRequest();
    const rows = this._matching(range);
    let i = 0;
    const step = () => {
      if (i >= rows.length) { req.result = null; req.onsuccess?.({ target: req }); return; }
      const rec = rows[i++];
      req.result = { primaryKey: extractKey(this.store, rec), key: rec[this.keyPath], continue: () => queueMicrotask(step) };
      req.onsuccess?.({ target: req });
    };
    queueMicrotask(step);
    return req;
  }
}

class FakeObjectStore {
  constructor(name, keyPath, indexes) {
    this.name = name; this.keyPath = keyPath; this.indexes = indexes || {}; this.data = new Map();
  }
  _key(record) { return keyOf(this, recordKey(this, record)); }
  put(record) {
    const req = new FakeRequest();
    this.data.set(recordKey(this, record), { ...record });
    req._succeed(extractKey(this, record));
    return req;
  }
  get(key) {
    const req = new FakeRequest();
    req._succeed(this.data.get(keyOf(this, key)));
    return req;
  }
  getAll() { const req = new FakeRequest(); req._succeed([...this.data.values()].map((r) => ({ ...r }))); return req; }
  count() { const req = new FakeRequest(); req._succeed(this.data.size); return req; }
  delete(key) { const req = new FakeRequest(); this.data.delete(keyOf(this, key)); req._succeed(undefined); return req; }
  index(name) {
    const desc = this.indexes[name];
    if (!desc) throw new Error('no index ' + name);
    return new FakeIndex(this, name, desc.keyPath);
  }
}

class FakeTransaction {
  constructor(db, names, mode) {
    this.db = db; this.mode = mode; this.error = null;
    this._stores = new Map();
    this._pending = 0; this._done = false;
    this.oncomplete = null; this.onerror = null;
    this._names = Array.isArray(names) ? names : [names];
  }
  objectStore(name) {
    if (!this._names.includes(name)) throw new Error('store not in transaction: ' + name);
    if (!this._stores.has(name)) this._stores.set(name, this.db._stores[name].store);
    return this._stores.get(name);
  }
  _complete() { if (this._done) return; this._done = true; queueMicrotask(() => this.oncomplete && this.oncomplete()); }
}

class FakeDB {
  constructor(name) { this.name = name; this.objectStoreNames = { _s: new Set(), contains(n) { return this._s.has(n); } }; this._stores = {}; }
  createObjectStore(name, opts = {}) {
    const store = new FakeObjectStore(name, opts.keyPath, {});
    this._stores[name] = { store, indexes: {}, keyPath: opts.keyPath };
    this.objectStoreNames._s.add(name);
    return {
      createIndex: (iname, keyPath) => { store.indexes[iname] = { keyPath }; }
    };
  }
  transaction(names, mode) {
    const t = new FakeTransaction(this, names, mode);
    // auto-complete on microtask drain
    queueMicrotask(() => queueMicrotask(() => t._complete()));
    return t;
  }
}

export const databases = new Map();

export function install() {
  globalThis.IDBKeyRange = {
    only: (v) => ({ _only: v, _matches: (x) => JSON.stringify(x) === JSON.stringify(v) })
  };
  globalThis.indexedDB = {
    open(name) {
      const req = new FakeRequest();
      let db = databases.get(name);
      const isNew = !db;
      if (!db) { db = new FakeDB(name); databases.set(name, db); }
      queueMicrotask(() => {
        req.result = db;
        if (isNew && req.onupgradeneeded) req.onupgradeneeded({ target: req });
        req.onsuccess && req.onsuccess({ target: req });
      });
      return req;
    }
  };
}

