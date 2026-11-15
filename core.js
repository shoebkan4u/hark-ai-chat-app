/* Shoeb AI — core: vault, settings, network, storage, memory, helpers, icons. */
(function () {
  'use strict';
  const H = window.Hark;
  const N = window.HarkNative;
  const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const PH = (id) => '{{vault:' + id + '}}';
  const handlers = new Map();
  let nativeListeners = [];

  // ---------------- vault (encrypted key/value with metadata) ----------------
  // Keys are stored with: id, label, provider, host, order, type, created, slots[], openalgo[], knowledge, vms[], tunnels[], runners[], oci{}, cloudflare
  // Values are kept in the native vault (Android Keystore) or a WebCrypto fallback (IndexedDB + PBKDF2).
  // The native vault is the source of truth when available.
  const PROVIDER_HOSTS = {
    gemini: ['generativelanguage.googleapis.com'],
    openai: ['api.openai.com', 'api.anthropic.com', 'api.groq.com', 'openrouter.ai', 'api.mistral.ai', 'api.cohere.ai', 'api.deepinfra.com', 'api.together.xyz', 'api.fireworks.ai', 'api.perplexity.ai', 'api.x.ai', 'api.deepseek.com'],
    openalgo: ['127.0.0.1', 'localhost', '[::1]', '100.111.56.19', 'hark-a1', 'hark-a2', '10.0.0.68'], // Tailscale IPs + local
    ssh_key: [], ssh_pass: [], oci_key: [], oauth: [], cloudflare: [],
  };
  const webVault = {
    async open() {
      if (this.db) return this.db;
      return new Promise((res, rej) => {
        const r = indexedDB.open('hark-vault', 2);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('keys')) d.createObjectStore('keys', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('vals')) d.createObjectStore('vals', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
        };
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => rej(r.error);
      });
    },
    async list() {
      const d = await this.open();
      return new Promise((res, rej) => {
        const t = d.transaction('keys', 'readonly');
        const req = t.objectStore('keys').getAll();
        req.onsuccess = () => res(req.result || []); req.onerror = () => rej(req.error);
      });
    },
    async get(id) {
      const d = await this.open();
      return new Promise((res, rej) => {
        const t = d.transaction('vals', 'readonly');
        const req = t.objectStore('vals').get(id);
        req.onsuccess = () => { const v = req.result; res(v ? v.value : null); }; req.onerror = () => rej(req.error);
      });
    },
    async put(meta, value) {
      const id = meta.id || newId('k');
      const d = await this.open();
      return new Promise((res, rej) => {
        const t = d.transaction(['keys', 'vals'], 'readwrite');
        t.objectStore('keys').put(Object.assign({ id, created: Date.now() }, meta));
        t.objectStore('vals').put({ id, value });
        t.oncomplete = () => res(id); t.onerror = () => rej(t.error);
      });
    },
    async del(id) {
      const d = await this.open();
      return new Promise((res, rej) => {
        const t = d.transaction(['keys', 'vals'], 'readwrite');
        t.objectStore('keys').delete(id); t.objectStore('vals').delete(id);
        t.oncomplete = () => res(); t.onerror = () => rej(t.error);
      });
    },
    byProvider(p) { return this.list().then((a) => a.filter((k) => k.provider === p).sort((a, b) => (a.order || 1) - (b.order || 1))); },
    async setHost(id, host) {
      const d = await this.open();
      return new Promise((res, rej) => {
        const t = d.transaction('keys', 'readwrite');
        const req = t.objectStore('keys').get(id);
        req.onsuccess = () => {
          const k = req.result; if (!k) { res(false); return; }
          k.host = host; t.objectStore('keys').put(k); t.oncomplete = () => res(true); t.onerror = () => rej(t.error);
        }; req.onerror = () => rej(req.error);
      });
    },
    _resolve(text, url) {
      if (!text || !text.includes('{{vault:')) return text;
      const host = new URL(url).host.toLowerCase();
      const d = this.load();
      return text.replace(/\{\{vault:([A-Za-z0-9_-]{4,64})\}\}/g, (_, id) => {
        const m = d.index.find((x) => x.id === id);
        if (!m) throw new Error('Unknown vault entry');
        const ok = m.host === host || (PROVIDER_HOSTS[m.provider] || []).includes(host);
        if (!ok) throw new Error('Key "' + m.label + '" is saved for ' + m.host + ', not ' + host);
        return d.v[id];
      });
    },
    load() {
      try {
        const ks = JSON.parse(localStorage.getItem('hark.vault.keys') || '[]');
        const vs = JSON.parse(localStorage.getItem('hark.vault.vals') || '[]');
        const v = {}; vs.forEach((x) => { v[x.id] = x.value; });
        return { index: ks, v };
      } catch (_) { return { index: [], v: {} }; }
    },
    async importFile(text, passphrase) {
      if (N) return nativeCall('importEncrypted', text, passphrase);
      // WebCrypto fallback: same format as the native importer.
      const o = JSON.parse(text);
      if (o.format !== 'hark-import-v1') throw new Error('Not a Hark import file');
      const b = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.trim()), 'PBKDF2', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b(o.salt), iterations: o.iterations || 310000 }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      let plain;
      try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b(o.iv), additionalData: new TextEncoder().encode(o.aad || 'hark-import-v1') }, key, b(o.ct)); }
      catch (_) { throw new Error('Wrong passphrase or damaged file'); }
      const bundle = JSON.parse(new TextDecoder().decode(plain));
      const secrets = [];
      for (const s of bundle.secrets || []) {
        if (!s.value) continue;
        if (['ssh_key', 'ssh_pass', 'oci_key'].includes(s.type) || /\.hark\.local$/.test(s.host || '')) continue; // app-only (SSH/OCI), never kept in a browser
        const id = this.put({ label: String(s.label).replace(/\s+/g, ' ').trim(), provider: s.provider, host: s.host, order: s.order || 1, type: s.type }, s.value);
        secrets.push({ id, label: s.label, provider: s.provider });
      }
      return { imported: secrets.length, secrets, slots: bundle.slots || [], openalgo: bundle.openalgo || [], knowledge: bundle.knowledge || '', created: bundle.created, payload: bundle.format, cloudflare: bundle.cloudflare || null, runners: [], vms: [], tunnels: [], oci: {}, browserOnly: true };
    },
  };

  // Encrypted key/value (native) for memory etc.
  H.kv = {
    get(k, def) {
      try {
        const v = N ? N.kvGet(k) : localStorage.getItem('hark.kv.' + k);
        return v == null ? def : JSON.parse(v);
      } catch (_) { return def; }
    },
    set(k, v) {
      const s = v == null ? null : JSON.stringify(v);
      if (N) N.kvPut(k, s); else if (s == null) localStorage.removeItem('hark.kv.' + k); else localStorage.setItem('hark.kv.' + k, s);
    },
  };

  // ---------------- network ----------------
  function lowerHeaders(h) { const o = {}; Object.keys(h || {}).forEach((k) => (o[k.toLowerCase()] = h[k])); return o; }

  window.HarkNet = {
    _cb(id, type, data) {
      const h = handlers.get(id);
      if (h) { h(type, data); return; }
      if (id === 'native') nativeListeners.forEach((fn) => { try { fn(type, data); } catch (e) { console.error(e); } });
    },
    /** Buffered request. Resolves {status, headers, text, json()} */
    async request(opts) {
      const o = Object.assign({ method: 'GET', headers: {} }, opts);
      if (o.approval) {
        const [tok] = await H.approve(o.approval, [H.reqKey(o.method, o.url, o.body)]);
        o.headers = Object.assign({}, o.headers, { 'X-Hark-Approval': tok });
      }
      if (N) {
        return new Promise((resolve, reject) => {
          const id = newId('h');
          handlers.set(id, (type, data) => {
            handlers.delete(id);
            if (type === 'err') return reject(H.nativeError(data));
            const res = { status: data.status, headers: lowerHeaders(data.headers), text: data.text || '' };
            res.json = () => JSON.parse(res.text);
            resolve(res);
          });
          if (o.signal) o.signal.addEventListener('abort', () => { N.httpAbort(id); handlers.delete(id); reject(new DOMException('Aborted', 'AbortError')); });
          N.http(id, JSON.stringify({ url: o.url, method: o.method, headers: o.headers, body: o.body == null ? null : o.body, stream: false, timeout: o.timeout || 120000 }));
        });
      }
      return (async () => {
        const headers = {};
        for (const k in o.headers) headers[k] = H.vault._resolve(String(o.headers[k]), o.url);
        const r = await fetch(o.url, { method: o.method, headers, body: o.body == null ? undefined : H.vault._resolve(o.body, o.url), signal: o.signal });
        const text = await r.text();
        const hd = {}; r.headers.forEach((v, k) => (hd[k.toLowerCase()] = v));
        return { status: r.status, headers: hd, text, json: () => JSON.parse(text) };
      })();
    },
    /** Streaming request. onChunk(text). Resolves {status, headers, text(if error)} at end. */
    stream(opts, onChunk) {
      const o = Object.assign({ method: 'POST', headers: {} }, opts);
      if (N) {
        return new Promise((resolve, reject) => {
          const id = newId('s');
          let head = null; let errText = '';
          handlers.set(id, (type, data) => {
            if (type === 'head') { head = { status: data.status, headers: lowerHeaders(data.headers) }; return; }
            if (type === 'chunk') { if (head && head.status >= 400) errText += data.t; else onChunk(data.t); return; }
            handlers.delete(id);
            if (type === 'err') return reject(H.nativeError(data));
            resolve(Object.assign({ status: 0, headers: {} }, head, { text: errText }));
          });
          if (o.signal) o.signal.addEventListener('abort', () => { N.httpAbort(id); handlers.delete(id); resolve(Object.assign({ status: 0, headers: {} }, head, { aborted: true, text: '' })); });
          N.http(id, JSON.stringify({ url: o.url, method: o.method, headers: o.headers, body: o.body, stream: true, timeout: o.timeout || 180000 }));
        });
      }
      return (async () => {
        const headers = {};
        for (const k in o.headers) headers[k] = H.vault._resolve(String(o.headers[k]), o.url);
        let r;
        try { r = await fetch(o.url, { method: o.method, headers, body: H.vault._resolve(o.body, o.url), signal: o.signal }); }
        catch (e) { if (e.name === 'AbortError') return { status: 0, headers: {}, aborted: true, text: '' }; throw e; }
        const hd = {}; r.headers.forEach((v, k) => (hd[k.toLowerCase()] = v));
        if (r.status >= 400) return { status: r.status, headers: hd, text: await r.text() };
        const rd = r.body.getReader(); const dec = new TextDecoder();
        try { for (;;) { const { done, value } = await rd.read(); if (done) break; onChunk(dec.decode(value, { stream: true })); } }
        catch (e) { if (e.name !== 'AbortError') throw e; return { status: r.status, headers: hd, aborted: true, text: '' }; }
        return { status: r.status, headers: hd, text: '' };
      })();
    },
    openAuth(url) { if (N) N.openUrl(url); else location.href = url; },
    async oauthToken(endpoint, form, label, resourceUrl) {
      if (N) return nativeCall('oauthToken', endpoint, JSON.stringify(form), label, resourceUrl || endpoint);
      const body = new URLSearchParams();
      for (const k in form) body.set(k, H.vault._resolve(String(form[k]), endpoint));
      const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
      const j = await r.json();
      if (!j.access_token) throw new Error('Token exchange failed: ' + JSON.stringify(j).slice(0, 160));
      const out = {};
      out.tokenRef = PH(H.vault.put({ label: label + ' access token', provider: 'oauth', host: new URL(resourceUrl || endpoint).host, type: 'oauth' }, j.access_token));
      if (j.refresh_token) out.refreshRef = PH(H.vault.put({ label: label + ' refresh token', provider: 'oauth', host: new URL(endpoint).host, type: 'oauth' }, j.refresh_token));
      if (j.expires_in) out.expiresAt = Date.now() + j.expires_in * 1000;
      return out;
    },
  };
  H.net = window.HarkNet;

  // ---------------- settings ----------------
  const DEFAULT_SETTINGS = {
    name: 'Shoeb', fullName: 'Shoeb Khan', theme: 'system', model: 'gemini:gemini-3.5-flash',
    autoFallback: true, tools: { web: true, openalgo: true, mcp: true, memory: true, ops: true },
    voice: { autoSpeak: false, rate: 1.0, lang: 'en-IN' },
    openalgo: [
      // hark-a2 (local) — paper accounts
      { id: 'flattrade', name: 'Flattrade', base: 'http://127.0.0.1:5000', mode: 'PAPER', provider: 'openalgo:flattrade' },
      { id: 'shoonya', name: 'Shoonya (Finvasia)', base: 'http://127.0.0.1:5001', mode: 'PAPER', provider: 'openalgo:shoonya' },
      { id: 'sharekhan', name: 'Sharekhan', base: 'http://127.0.0.1:5002', mode: 'PAPER', provider: 'openalgo:sharekhan' },
      // hark-a1 (remote) — tradesmart LIVE, wisdom PAPER
      { id: 'tradesmart', name: 'TradeSmart', base: '', mode: 'LIVE', provider: 'openalgo:tradesmart' },
      { id: 'wisdom', name: 'Wisdom (sandbox)', base: '', mode: 'PAPER', provider: 'openalgo:wisdom' },
    ],
    mcpServers: [
      { id: 'kite', name: 'Zerodha Kite', url: 'https://mcp.kite.trade/mcp', enabled: false, readOnly: true, trading: true },
      { id: 'dhan', name: 'Dhan', url: 'https://mcp.dhan.co/mcp', enabled: false, readOnly: true, trading: true },
    ],
    custom: { base: '', name: 'Custom (OpenAI-compatible)' },
    // Cloudflare Workers AI (OpenAI-compatible). The account id is not a secret; the API token lives only in the vault.
    cloudflare: { accountId: '76be185864dd8975a52803c507e4c048' },
    projects: [], tasks: [], knowledge: '',
    // Settings › Safety (1.1.8): everything the AI sends or runs goes out at once. Each switch brings back a confirmation.
    safety: { askTrades: false, askCloud: false, askTools: false, askEmail: false }, widgetSource: '', lastConnections: null,
  };
  function deepMerge(a, b) {
    const o = Array.isArray(a) ? a.slice() : Object.assign({}, a);
    for (const k in b) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) o[k] = deepMerge(a[k], b[k]);
      else o[k] = b[k];
    }
    return o;
  }
  /** True only when the user turned that confirmation back on in Settings › Safety (all off by default). */
  H.askFirst = (k) => !!(H.settings && H.settings.safety && H.settings.safety[k]);
  H.settings = (() => { try { return deepMerge(DEFAULT_SETTINGS, JSON.parse(localStorage.getItem('hark.settings') || '{}')); } catch (_) { return deepMerge(DEFAULT_SETTINGS, {}); } })();
  H.saveSettings = () => localStorage.setItem('hark.settings', JSON.stringify(H.settings));

  // ---------------- chat storage (IndexedDB) ----------------
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('hark', 1);
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('chats', mode); const s = t.objectStore('chats'); const out = fn(s); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); }); }
  H.chats = {
    async all() { const list = await tx('readonly', (s) => s.getAll()); return (list || []).sort((a, b) => (b.updated || 0) - (a.updated || 0)); },
    async get(id) { const r = await tx('readonly', (s) => s.get(id)); return r && r.id ? r : null; }, // a missing id used to come back as the IDBRequest itself
    async put(c) { c.updated = c.updated || Date.now(); return tx('readwrite', (s) => s.put(JSON.parse(JSON.stringify(c)))); },
    async del(id) { return tx('readwrite', (s) => s.delete(id)); },
  };

  // ---------------- memory ----------------
  H.memory = {
    list() { return H.kv.get('memory', []); },
    save(list) { H.kv.set('memory', list); },
    add(text, source) { const l = this.list(); const t = String(text).trim(); if (!t || l.some((m) => m.text.toLowerCase() === t.toLowerCase())) return null; const m = { id: newId('m'), text: t, created: Date.now(), source: source || 'chat' }; l.push(m); this.save(l); return m; },
    update(id, text) { const l = this.list(); const m = l.find((x) => x.id === id); if (m) { m.text = text; m.updated = Date.now(); this.save(l); } },
    del(id) { this.save(this.list().filter((m) => m.id !== id)); },
  };

  // ---------------- helpers ----------------
  H.$ = (s, r) => (r || document).querySelector(s);
  H.$$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  H.el = function (tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  };
  H.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": ''' }[c]));
  H.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  H.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  H.toast = (msg, ms) => {
    const t = H.el('div', { class: 'toast', text: msg }); document.body.append(t);
    setTimeout(() => t.remove(), ms || 2600);
  };
  H.copy = async (text) => {
    try { if (N && N.copyText) N.copyText(text); else await navigator.clipboard.writeText(text); H.toast('Copied'); }
    catch (_) { H.toast('Couldn’t copy'); }
  };
  H.openExternal = (url) => { if (N) N.openUrl(url); else window.open(url, '_blank', 'noopener'); };
  H.istNow = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  // Theme
  H.applyTheme = () => {
    const mode = H.settings.theme;
    const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = dark ? '#1e1d1a' : '#f5f3ee';
    if (N && N.setTheme) N.setTheme(mode);
  };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => H.applyTheme());

  // Icons (original, simple strokes)
  // Every icon carries an explicit 20×20 size so it can never scale to its container (CSS may still resize it).
  const P = (d, extra) => '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"' + (extra || '') + '>' + d + '</svg>';
  H.icon = {
    menu: P('<path d="M4 7h16M4 12h10M4 17h16"/>'),
    newchat: P('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    chev: P('<path d="m6 9 6 6 6-6"/>'),
    back: P('<path d="M15 18l-6-6 6-6"/>'),
    close: P('<path d="M18 6 6 18M6 6l12 12"/>'),
    plus: P('<path d="M12 5v14M5 12h14"/>'),
    tools: P('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
    mic: P('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
    wave: P('<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10v4"/>'),
    send: P('<path d="M12 19V5M5 12l7-7 7 7"/>', ' stroke-width="2.2"'),
    stop: '<svg width="20" height="20" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
    copy: P('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
    retry: P('<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>'),
    up: P('<path d="M7 10v11M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 7A2 2 0 0 1 18.4 21H7V10l4.3-7.2A1.7 1.7 0 0 1 14.4 4z"/>'),
    down: P('<path d="M17 14V3M9 18.1 10 14H4.2a2 2 0 0 1-2-2.3l1.4-7A2 2 0 0 1 5.6 3H17v11l-4.3 7.2a1.7 1.7 0 0 1-3.1-1.2z"/>'),
    speak: P('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>'),
    search: P('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    gear: P('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8-.3l-.1.1a2 2 0 1 1-2.8-2.8l.1.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    folder: P('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    chat: P('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
    camera: P('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
    image: P('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>'),
    file: P('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
    globe: P('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
    chart: P('<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>'),
    plug: P('<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"/>'),
    brain: P('<path d="M6 3h12v18l-6-4-6 4z"/><path d="M9 8h6M9 11h4"/>'), // memory (bookmark); the old brain glyph is gone
    clock: P('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    key: P('<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14 9l2 2"/>'),
    trash: P('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    edit: P('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
    check: P('<path d="M5 12l5 5 9-11"/>', ' stroke-width="2.2"'),
    code: P('<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>'),
    doc: P('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/>'),
    share: P('<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v14"/>'),
    download: P('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>'),
    mute: P('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 11 5.7M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18"/>'),
    shield: P('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>'),
    sun: P('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    info: P('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
    widget: P('<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="8" rx="2"/><rect x="3" y="13" width="18" height="8" rx="2"/>'),
    upload: P('<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>'),
    more: P('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
    right: P('<path d="m9 6 6 6-6 6"/>'),
  };
  H.markSvg = '<svg class="mark" width="40" height="40" viewBox="0 0 48 48"><g fill="var(--accent)"><circle cx="24" cy="8" r="5"/><circle cx="38" cy="18" r="5" opacity=".8"/><circle cx="33" cy="35" r="5" opacity=".6"/><circle cx="15" cy="35" r="5" opacity=".45"/><circle cx="10" cy="18" r="5" opacity=".3"/></g></svg>';
})();
