/* Hark AI — providers, live model catalog, streaming chat with multi-key failover. */
(function () {
  'use strict';
  const H = window.Hark;
  const PH = H.vault.PH;

  const VISION_RE = /(vision|[-_.]vl\b|-vl-|\bvl\b|omni|llama-4|llama4|gemma-?3|gemma-?4|pixtral|gemini|grok-4|grok-2-vision|qwen3\.[5-9]|qwen2\.5-vl|minimax-m3|nemotron.*vl|kimi-k2\.[5-9]|mistral-(small|medium)-3)/i;
  const SKIP_RE = /(embed|rerank|guard|safety|reward|whisper|tts|speech|transcri|audio|parse|retriever|nv-clip|clip|vila|deplot|kosmos|paligemma|image-gen|flux|sdxl|stable-diffusion|playai|orpheus|moderation|bge|e5-|arctic-embed|cosmos|ocdr|nemoretriever|-detect|translate|aqa|imagen|veo|lyria|native-audio|computer-use)/i;

  const PROVIDERS = {
    openrouter: {
      name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', note: 'free models only',
      headers: { 'HTTP-Referer': 'https://shoebkan4u.github.io/hark-ai-chat-app/', 'X-Title': 'Shoeb AI' },
      async models(keyRef) {
        const r = await H.net.request({ url: this.base + '/models', headers: { Authorization: 'Bearer ' + keyRef } });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        return r.json().data
          .filter((m) => H.isFree('openrouter:' + m.id))
          .map((m) => ({ id: m.id, name: (m.name || m.id).replace(/\s*\(free\)\s*$/i, ''), ctx: m.context_length,
            vision: ((m.architecture && m.architecture.input_modalities) || []).includes('image'),
            tools: (m.supported_parameters || []).includes('tools') }));
      },
      resetAt() { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); }, // 00:00 UTC = 05:30 IST
    },
    groq: {
      name: 'Groq', base: 'https://api.groq.com/openai/v1',
      async models(keyRef) {
        const r = await H.net.request({ url: this.base + '/models', headers: { Authorization: 'Bearer ' + keyRef } });
        if (r.status !== 200) throw new Error('HTTP ' + r.status + (r.status === 403 ? ' (network edge block — try another network)' : ''));
        return r.json().data.filter((m) => m.active !== false && !SKIP_RE.test(m.id))
          .map((m) => ({ id: m.id, name: m.id, ctx: m.context_window, vision: VISION_RE.test(m.id), tools: true }));
      },
    },
    cohere: {
      name: 'Cohere', base: 'https://api.cohere.ai/compatibility/v1',
      async models(keyRef) {
        const r = await H.net.request({ url: 'https://api.cohere.com/v1/models?endpoint=chat&page_size=100', headers: { Authorization: 'Bearer ' + keyRef } });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        return (r.json().models || []).filter((m) => !SKIP_RE.test(m.name))
          .map((m) => ({ id: m.name, name: m.name, ctx: m.context_length, vision: (m.features || []).includes('vision') || /vision/.test(m.name), tools: !/vision|aya-expanse|light/.test(m.name) }));
      },
    },
    nvidia: {
      name: 'NVIDIA', base: 'https://integrate.api.nvidia.com/v1', nativeOnly: true,
      async models(keyRef) {
        const r = await H.net.request({ url: this.base + '/models', headers: { Authorization: 'Bearer ' + keyRef } });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        return r.json().data.filter((m) => !SKIP_RE.test(m.id))
          .map((m) => ({ id: m.id, name: m.id, vision: VISION_RE.test(m.id), tools: true }));
      },
    },
    gemini: {
      name: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
      async models(keyRef) {
        const r = await H.net.request({ url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', headers: { 'x-goog-api-key': keyRef } });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        return (r.json().models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && H.isFree('gemini:' + m.name.replace(/^models\//, '')))
          .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name, ctx: m.inputTokenLimit, vision: true, tools: !/gemma/.test(m.name) }));
      },
    },
    xai: {
      name: 'xAI', base: 'https://api.x.ai/v1', paid: true, // no free tier: never listed, picked or used for fallback (1.1.9)
      async models(keyRef) {
        const r = await H.net.request({ url: this.base + '/models', headers: { Authorization: 'Bearer ' + keyRef } });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        return r.json().data.filter((m) => !SKIP_RE.test(m.id) && !/image|imagine/.test(m.id)).map((m) => ({ id: m.id, name: m.id, vision: VISION_RE.test(m.id), tools: true }));
      },
    },
    // ---- free providers added in 1.1.9 (keys only in the on-device vault) ----
    opencode: {
      name: 'OpenCode Zen', base: 'https://opencode.ai/zen/v1', note: 'free models only',
      async models(keyRef) {
        let ids = [];
        try { const r = await H.net.request({ url: this.base + '/models', headers: { Authorization: 'Bearer ' + keyRef } }); if (r.status === 200) ids = (r.json().data || []).map((m) => m.id); } catch (_) {}
        if (!ids.length) ids = OPENCODE_FREE.slice();
        return ids.filter((id) => H.isFree('opencode:' + id)).map((id) => ({ id, name: (SEED['opencode:' + id] || {}).name || id, vision: VISION_RE.test(id), tools: true }));
      },
    },
    kilo: {
      name: 'Kilo', base: 'https://api.kilo.ai/api/openrouter', note: 'free models only',
      async models(keyRef) {
        const r = await H.net.request({ url: this.base + '/models', headers: { Authorization: 'Bearer ' + keyRef } });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        return (r.json().data || []).filter((m) => H.isFree('kilo:' + m.id) && !SKIP_RE.test(m.id))
          .map((m) => ({ id: m.id, name: String(m.name || m.id).replace(/\s*\(free\)\s*$/i, ''), ctx: m.context_length,
            vision: ((m.architecture && m.architecture.input_modalities) || []).includes('image') || VISION_RE.test(m.id),
            tools: m.supported_parameters ? m.supported_parameters.includes('tools') : true }));
      },
      resetAt() { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); },
    },
    sambanova: {
      name: 'SambaNova', base: 'https://api.sambanova.ai/v1',
      async models(keyRef) {
        const r = await H.net.request({ url: this.base + '/models', headers: { Authorization: 'Bearer ' + keyRef } });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        return (r.json().data || []).filter((m) => !SKIP_RE.test(m.id) && !/prefill|spec-/i.test(m.id))
          .map((m) => ({ id: m.id, name: m.id, ctx: m.context_length, vision: VISION_RE.test(m.id), tools: true }));
      },
    },
    mistral: {
      name: 'Mistral', base: 'https://api.mistral.ai/v1', note: 'free tier',
      async models(keyRef) {
        const r = await H.net.request({ url: this.base + '/models', headers: { Authorization: 'Bearer ' + keyRef } });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        return (r.json().data || []).filter((m) => (!m.capabilities || m.capabilities.completion_chat !== false) && H.isFree('mistral:' + m.id) && !m.deprecation)
          .map((m) => ({ id: m.id, name: m.id, ctx: m.max_context_length, vision: !!(m.capabilities && m.capabilities.vision) || VISION_RE.test(m.id), tools: !(m.capabilities && m.capabilities.function_calling === false) }));
      },
    },
    github: {
      name: 'GitHub Models', base: 'https://models.github.ai/inference', note: 'free, rate-limited',
      async models(keyRef) {
        const r = await H.net.request({ url: 'https://models.github.ai/catalog/models', headers: { Authorization: 'Bearer ' + keyRef, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        const j = r.json(); const list = Array.isArray(j) ? j : (j.models || j.data || []);
        return list.filter((m) => m.id && (m.supported_output_modalities || ['text']).includes('text') && !(m.supported_output_modalities || []).includes('embeddings') && !SKIP_RE.test(m.id))
          .map((m) => ({ id: m.id, name: (m.name || m.id) + ' (GitHub)', tier: m.rate_limit_tier || '', vision: (m.supported_input_modalities || []).includes('image'), tools: (m.capabilities || []).includes('tool-calling') || /gpt|llama|mistral|grok|deepseek/i.test(m.id) }));
      },
    },
    cloudflare: {
      name: 'Cloudflare Workers AI',
      get account() { return String((H.settings.cloudflare && H.settings.cloudflare.accountId) || '').trim(); },
      get base() { return 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(this.account) + '/ai/v1'; },
      async models(keyRef) {
        if (!this.account) throw new Error('No Cloudflare account id');
        const r = await H.net.request({ url: 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(this.account) + '/ai/models/search?task=Text%20Generation&per_page=200', headers: { Authorization: 'Bearer ' + keyRef } });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        const prop = (m, k) => ((m.properties || []).find((p) => p.property_id === k) || {}).value;
        return ((r.json() || {}).result || []).filter((m) => m.name && /^@cf\//.test(m.name) && !SKIP_RE.test(m.name) && !/lora|-awq-|deprecated/i.test(m.name) && !CF_RETIRED.has(m.name) && !H.retired('cloudflare:' + m.name))
          .map((m) => ({ id: m.name, name: m.name.replace(/^@cf\/[^/]+\//, '') + ' (Cloudflare)', ctx: +prop(m, 'context_window') || undefined, vision: VISION_RE.test(m.name), tools: String(prop(m, 'function_calling')) === 'true' || /llama-3\.3-70b/.test(m.name) }));
      },
    },
    custom: {
      name: 'Custom', get base() { return (H.settings.custom.base || '').replace(/\/+$/, ''); },
      async models(keyRef) {
        if (!this.base) throw new Error('No base URL');
        const r = await H.net.request({ url: this.base + '/models', headers: keyRef ? { Authorization: 'Bearer ' + keyRef } : {} });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        return (r.json().data || []).map((m) => ({ id: m.id, name: m.id, vision: VISION_RE.test(m.id), tools: true }));
      },
    },
  };
  H.PROVIDERS = PROVIDERS;

  // 1.1.9: free models only. Gemini 3.5 Flash is the daily default; the list is also the fallback chain (in order).
  const OPENCODE_FREE = ['big-pickle', 'deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'mimo-v2.6-flash-free', 'nemotron-3.5-super-vl-free', 'nemotron-3.5-lightning-free', 'beam-free', 'flint-40b-free', 'pulse-alpha-free'];
  // Cloudflare models that answer "deprecated" (error 5028): never listed or used.
  const CF_RETIRED = new Set(['@cf/meta/llama-3.1-8b-instruct']);
  H.DEFAULT_MODEL = 'gemini:gemini-3.5-flash';
  const RECOMMENDED = [
    'gemini:gemini-3.5-flash', 'groq:openai/gpt-oss-120b', 'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free', 'kilo:kilo-auto/free',
    'github:openai/gpt-4.1-mini', 'mistral:mistral-medium-latest', 'gemini:gemini-3.5-flash-lite', 'cohere:command-a-03-2025',
    'nvidia:mistralai/mistral-large-4-1t-a52b', 'nvidia:minimaxai/minimax-m3.1-flash', 'openrouter:nvidia/nemotron-3.5-lightning:free',
    'sambanova:DeepSeek-V3.2', 'opencode:big-pickle', 'kilo:google/gemma-4-31b-it:free', 'groq:qwen/qwen3.8-27b', 'groq:openai/gpt-oss-20b',
    'openrouter:nvidia/nemotron-3.5-super-vl:free', 'nvidia:nvidia/nemotron-3.5-super-vl-120b-a12b', 'cohere:command-a-vision-07-2025',
    'mistral:mistral-small-latest', 'opencode:deepseek-v4.1-flash-free',
    // Last in the fallback order: Cloudflare Workers AI (free 10,000 neurons a day), 70B first, then 8B fp8.
    'cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'cloudflare:@cf/meta/llama-3.1-8b-instruct-fp8',
  ];
  const SEED = {
    'gemini:gemini-3.5-flash': { name: 'Gemini 3.5 Flash', tools: true, vision: true },
    'gemini:gemini-3.5-flash-lite': { name: 'Gemini 3.5 Flash-Lite', tools: true, vision: true },
    'groq:openai/gpt-oss-120b': { name: 'GPT-OSS 120B', tools: true },
    'groq:openai/gpt-oss-20b': { name: 'GPT-OSS 20B', tools: true },
    'groq:qwen/qwen3.8-27b': { name: 'Qwen 3.8 27B', tools: true, vision: true },
    'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free': { name: 'Nemotron 3 Ultra 550B', tools: true },
    'openrouter:nvidia/nemotron-3.5-lightning:free': { name: 'Nemotron 3.5 Lightning', tools: true },
    'openrouter:nvidia/nemotron-3.5-super-vl:free': { name: 'Nemotron 3.5 Super VL', tools: true, vision: true },
    'kilo:kilo-auto/free': { name: 'Kilo Auto (free)', tools: true },
    'kilo:google/gemma-4-31b-it:free': { name: 'Gemma 4 31B (Kilo)', tools: true, vision: true },
    'github:openai/gpt-4.1-mini': { name: 'GPT-4.1 mini (GitHub)', tools: true, vision: true, tier: 'low' },
    'mistral:mistral-medium-latest': { name: 'Mistral Medium', tools: true, vision: true },
    'mistral:mistral-small-latest': { name: 'Mistral Small', tools: true, vision: true },
    'sambanova:DeepSeek-V3.2': { name: 'DeepSeek V3.2 (SambaNova)', tools: true },
    'opencode:big-pickle': { name: 'Big Pickle (OpenCode)', tools: true },
    'opencode:deepseek-v4.1-flash-free': { name: 'DeepSeek V4.1 Flash (OpenCode)', tools: true },
    'cohere:command-a-03-2025': { name: 'Command A', tools: true },
    'cohere:command-a-vision-07-2025': { name: 'Command A Vision', vision: true },
    'nvidia:minimaxai/minimax-m3.1-flash': { name: 'MiniMax M3.1 Flash', tools: true },
    'nvidia:mistralai/mistral-large-4-1t-a52b': { name: 'Mistral Large 4', tools: true },
    'nvidia:nvidia/nemotron-3.5-super-vl-120b-a12b': { name: 'Nemotron 3.5 Super VL', tools: true, vision: true },
    'cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast': { name: 'Llama 3.3 70B (Cloudflare)', tools: true },
    'cloudflare:@cf/meta/llama-3.1-8b-instruct-fp8': { name: 'Llama 3.1 8B (Cloudflare)', tools: false },
  };

  // ---------------- free-only policy (1.1.9) ----------------
  const GEMINI_FREE_RE = /^(gemini-\d+(\.\d+)?-flash(-lite)?(-preview)?(-\d{2}-\d{4})?|gemini-flash(-lite)?-latest|gemma-[\w.-]+)$/;
  /** True only for models usable on a free tier/key. Paid models are never listed, picked or used for fallback. */
  H.isFree = (full) => {
    const [p, ...rest] = String(full || '').split(':'); const id = rest.join(':');
    if (!p || !id) return false;
    if (H.retired && H.retired(full)) return false;
    switch (p) {
      case 'openrouter': return /:free$/.test(id) || id === 'openrouter/free';
      case 'kilo': return /:free$/.test(id) || /\/free$/.test(id);
      case 'opencode': return OPENCODE_FREE.includes(id);
      case 'gemini': return GEMINI_FREE_RE.test(id) && !/(image|tts|live|audio|transcribe|embedding|robotics|computer-use)/.test(id);
      case 'mistral': return !/(embed|ocr|moderation|voxtral|transcribe|tts|fim|vibe-cli|leanstral)/.test(id) && (/-latest$/.test(id) || id === 'mistral-large-4');
      case 'cloudflare': return !CF_RETIRED.has(id);
      case 'xai': return false;
      case 'groq': case 'cohere': case 'nvidia': case 'sambanova': case 'github': case 'custom': return true; // free-tier keys / your own gateway
      default: return false;
    }
  };
  // Models a provider told us are retired (e.g. Cloudflare 5028) — hidden and skipped from then on.
  const RET_KEY = 'hark.retired';
  const retiredSet = (() => { try { return new Set(JSON.parse(localStorage.getItem(RET_KEY) || '[]')); } catch (_) { return new Set(); } })();
  H.retired = (full) => retiredSet.has(full);
  H.retire = (full) => { retiredSet.add(full); localStorage.setItem(RET_KEY, JSON.stringify([...retiredSet])); if (H.catalog && H.catalog.models[full]) { delete H.catalog.models[full]; saveCatalog(); } };

  // ---------------- catalog ----------------
  const CAT_KEY = 'hark.catalog';
  function loadCatalog() {
    try { const c = JSON.parse(localStorage.getItem(CAT_KEY) || 'null'); if (c && c.models) { for (const k in c.models) if (!H.isFree(k)) delete c.models[k]; for (const id in SEED) if (!c.models[id] && !c.updated) c.models[id] = Object.assign({ id: id.slice(id.indexOf(':') + 1), provider: id.split(':')[0], seed: true }, SEED[id]); return c; } } catch (_) {}
    const models = {};
    for (const id in SEED) { const [p, ...rest] = id.split(':'); models[id] = Object.assign({ id: rest.join(':'), provider: p, seed: true }, SEED[id]); }
    return { updated: 0, models, newIds: [], errors: {} };
  }
  H.catalog = loadCatalog();
  const saveCatalog = () => localStorage.setItem(CAT_KEY, JSON.stringify(H.catalog));

  H.modelInfo = (full) => {
    const m = H.catalog.models[full];
    if (m) return Object.assign({ full }, m);
    const [p, ...rest] = String(full).split(':');
    return { full, provider: p, id: rest.join(':'), name: rest.join(':'), tools: true, vision: VISION_RE.test(full) };
  };
  H.modelLabel = (full) => {
    const m = H.modelInfo(full);
    if (m.name && m.name !== m.id) return m.name;
    let n = m.id.split('/').pop().replace(/:free$/, '');
    return n;
  };
  H.providerReady = (p) => p === 'custom' ? !!PROVIDERS.custom.base : p === 'cloudflare' ? !!PROVIDERS.cloudflare.account && H.vault.has(p) : H.vault.has(p);
  H.recommended = () => RECOMMENDED.filter((id) => H.isFree(id) && H.providerReady(id.split(':')[0]));
  H.RECOMMENDED = RECOMMENDED;
  /** Settings or tasks still pointing at a paid / retired model → the free daily default (or the first ready free pick). */
  H.freeModelOr = (full) => (H.isFree(full) ? full : (H.providerReady('gemini') || !H.recommended().length ? H.DEFAULT_MODEL : H.recommended()[0]));
  (function migrateDefault() {
    const s = H.settings; if (!s) return;
    // 1.1.9: the daily default becomes Gemini 3.5 Flash (free), once; afterwards the user's own pick is kept.
    if (!s.migrated119) { s.model = H.DEFAULT_MODEL; s.migrated119 = true; }
    s.model = H.freeModelOr(s.model);
    (s.tasks || []).forEach((t) => { if (t.model) t.model = H.freeModelOr(t.model); });
    H.saveSettings();
  })();

  /** Refresh the live catalog. Returns {added:[], removed:[]} */
  H.refreshCatalog = async function (opts) {
    const first = !H.catalog.updated;
    const before = new Set(Object.keys(H.catalog.models).filter((k) => !H.catalog.models[k].seed));
    const next = {}; const errors = {}; const okProviders = new Set();
    await Promise.all(Object.keys(PROVIDERS).map(async (p) => {
      if (!H.providerReady(p) || PROVIDERS[p].paid) return;
      if (PROVIDERS[p].nativeOnly && !H.native) { errors[p] = 'needs the Android app (no browser access)'; return; }
      const keys = p === 'custom' ? [{ id: null }] : H.vault.byProvider(p);
      for (const k of keys) {
        try {
          const list = await PROVIDERS[p].models(k.id ? PH(k.id) : '');
          list.forEach((m) => { if (!H.isFree(p + ':' + m.id)) return; next[p + ':' + m.id] = Object.assign({ provider: p }, m, SEED[p + ':' + m.id] ? { name: SEED[p + ':' + m.id].name } : {}); });
          okProviders.add(p); return;
        } catch (e) { errors[p] = e.message; }
      }
    }));
    // Keep models of providers that failed this time (do not remove on a network blip).
    for (const k in H.catalog.models) {
      const p = H.catalog.models[k].provider;
      if (!okProviders.has(p) && !next[k] && H.providerReady(p) && H.isFree(k)) next[k] = H.catalog.models[k];
    }
    // Seeds stay visible until their provider's real list arrives.
    for (const id in SEED) { const p = id.split(':')[0]; if (!okProviders.has(p) && !next[id] && H.isFree(id)) next[id] = H.catalog.models[id] || Object.assign({ id: id.slice(p.length + 1), provider: p, seed: true }, SEED[id]); }
    const after = new Set(Object.keys(next));
    const added = first ? [] : [...after].filter((k) => !before.has(k) && !(H.catalog.models[k] && H.catalog.models[k].seed));
    const removed = [...before].filter((k) => !after.has(k) && okProviders.has(H.catalog.models[k].provider));
    H.catalog = { updated: Date.now(), models: next, newIds: Array.from(new Set([...(H.catalog.newIds || []), ...added])).filter((k) => next[k]), errors };
    saveCatalog();
    // Selected model gone? fall back.
    if (!next[H.settings.model] && okProviders.has(H.settings.model.split(':')[0])) {
      const fb = RECOMMENDED.find((id) => next[id] && H.isFree(id)) || Object.keys(next)[0];
      if (fb) { const old = H.settings.model; H.settings.model = fb; H.saveSettings(); H.emit && H.emit('model-fallback', { old, now: fb }); }
    }
    return { added, removed, errors };
  };

  // ---------------- key failover state ----------------
  const EX_KEY = 'hark.exhausted';
  const exhausted = (() => { try { return JSON.parse(localStorage.getItem(EX_KEY) || '{}'); } catch (_) { return {}; } })();
  function markExhausted(keyId, until, why) { exhausted[keyId] = { until, why }; localStorage.setItem(EX_KEY, JSON.stringify(exhausted)); }
  function usable(keyId) { const e = exhausted[keyId]; return !e || e.until < Date.now(); }
  H.keyStatus = (keyId) => (usable(keyId) ? null : exhausted[keyId]);
  H.clearExhausted = () => { for (const k in exhausted) delete exhausted[k]; localStorage.setItem(EX_KEY, '{}'); };

  const nextUtcMidnight = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };
  /** Cloudflare's daily free allowance (10,000 neurons) is used up: "you have used up your daily free allocation of 10,000 neurons". */
  const CF_DAILY_RE = /daily free allocation|10,?000 neurons|neurons? (limit|allocation)|used up your daily/i;
  H.CF_DAILY_MSG = 'Cloudflare: daily free limit used, resets 05:30 IST';
  function failoverWindow(provider, status, text) {
    const t = (text || '').toLowerCase();
    if (provider === 'cloudflare' && CF_DAILY_RE.test(text || '')) return { until: nextUtcMidnight(), why: 'daily free limit used, resets 05:30 IST', daily: true };
    if (/free usage limit|freeusagelimit/.test(t)) return { until: Date.now() + 6 * 3600e3, why: 'free usage limit reached', daily: true };
    if (status === 401) return { until: Date.now() + 6 * 3600e3, why: 'key rejected (401)' };
    if (status === 402) return { until: provider === 'openrouter' ? PROVIDERS.openrouter.resetAt() : Date.now() + 3600e3, why: 'out of credit (402)' };
    if (status === 429) {
      const daily = /per[- ]day|daily|free-models-per-day|quota/.test(t);
      if ((provider === 'openrouter' || provider === 'kilo') && daily) return { until: nextUtcMidnight(), why: 'daily free limit (resets 05:30 IST)', daily: true };
      return { until: Date.now() + (daily ? 3600e3 : 60e3), why: 'rate limited (429)' };
    }
    if (status === 403 && /quota|limit|exceed|insufficient|credit|billing|rate/.test(t)) return { until: Date.now() + 3600e3, why: 'quota (403)' };
    return null;
  }

  // Output-token cap per provider (without it some providers stop at ~256 tokens, e.g. Cloudflare Workers AI).
  // A 400 that mentions max_tokens drops it for that provider and retries once without it.
  const MAX_OUT = { openrouter: 8192, groq: 8192, cohere: 4000, nvidia: 8192, gemini: 8192, xai: 8192, opencode: 8192, kilo: 8192, sambanova: 4096, mistral: 8192, github: 4000, cloudflare: 4096, custom: 8192 };
  const NO_MAXTOK = new Set();
  H.MAX_OUT = MAX_OUT;
  // Providers that send token usage in the last stream chunk when asked (stream_options.include_usage).
  const USAGE_OPT = new Set(['groq', 'gemini', 'mistral', 'github', 'sambanova', 'opencode', 'nvidia', 'cloudflare']);

  // ---------------- message conversion ----------------
  /** Cloudflare Workers AI wants plain string content everywhere (no null content, no content arrays). */
  function toApiMessages(msgs, vision, provider) {
    const out = toApiMessages0(msgs, vision);
    if (provider !== 'cloudflare') return out;
    return out.map((m) => Object.assign({}, m, { content: m.content == null ? '' : Array.isArray(m.content) ? m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : String(m.content) }));
  }
  H._toApiMessages = toApiMessages;
  function toApiMessages0(msgs, vision) {
    return msgs.map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content) };
      if (m.role === 'assistant') {
        const o = { role: 'assistant', content: m.content || '' };
        if (m.tool_calls && m.tool_calls.length) { o.tool_calls = m.tool_calls; if (!o.content) o.content = null; }
        return o;
      }
      if (m.role === 'user' && m.images && m.images.length && vision) {
        return { role: 'user', content: [{ type: 'text', text: m.content || ' ' }].concat(m.images.map((u) => ({ type: 'image_url', image_url: { url: u } }))) };
      }
      return { role: m.role, content: m.content || '' };
    });
  }

  // ---------------- SSE parsing ----------------
  function sseParser(onEvent) {
    let buf = '';
    return (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        try { onEvent(JSON.parse(d)); } catch (e) { if (e && e.harkFatal) throw e; }
      }
    };
  }

  /**
   * Stream one completion. Returns {content, reasoning, tool_calls, finish, keyLabel}
   * cb: {onText(full), onReasoning(full)}
   */
  async function completeOnce(full, messages, tools, cb, signal) {
    const info = H.modelInfo(full);
    const P = PROVIDERS[info.provider];
    if (!P) throw new Error('Unknown provider ' + info.provider);
    if (P.nativeOnly && !H.native) throw Object.assign(new Error(P.name + ' works only inside the Android app.'), { code: 'native' });
    let keys = info.provider === 'custom' ? [{ id: null, label: 'custom' }] : H.vault.byProvider(info.provider);
    if (!keys.length) throw Object.assign(new Error('No ' + P.name + ' key in the vault. Add one in Settings → Keys.'), { code: 'nokey' });
    const live = keys.filter((k) => !k.id || usable(k.id));
    if (!live.length) {
      const soon = Math.min(...keys.map((k) => exhausted[k.id].until));
      const daily = keys.map((k) => exhausted[k.id]).find((x) => x && /daily free limit used|free usage limit/.test(x.why || ''));
      if (daily) throw Object.assign(new Error(info.provider === 'cloudflare' ? H.CF_DAILY_MSG : P.name + ': ' + daily.why), { code: 'exhausted' });
      throw Object.assign(new Error('All ' + P.name + ' keys are resting until ' + new Date(soon).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) + ' IST.'), { code: 'exhausted' });
    }
    let lastErr = null; let useTools = tools && tools.length && info.tools !== false;
    for (let ki = 0; ki < live.length; ki++) {
      const k = live[ki];
      const body = { model: info.id, messages: toApiMessages(messages, info.vision !== false, info.provider), stream: true };
      if (USAGE_OPT.has(info.provider)) body.stream_options = { include_usage: true };
      if (!NO_MAXTOK.has(info.provider)) body.max_tokens = MAX_OUT[info.provider] || 8192;
      let usage = null;
      if (useTools) { body.tools = tools; body.tool_choice = 'auto'; }
      if (info.provider === 'openrouter' || info.provider === 'kilo') body.usage = { include: true };
      const headers = Object.assign({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }, P.headers || {});
      if (k.id) headers.Authorization = 'Bearer ' + PH(k.id);
      let content = '', reasoning = '', finish = null; const calls = [];
      let inThink = false;
      const parse = sseParser((j) => {
        if (j.error) { const e = new Error(j.error.message || JSON.stringify(j.error)); e.harkFatal = true; e.status = j.error.code; throw e; }
        if (j.usage) usage = j.usage;
        const ch = j.choices && j.choices[0]; if (!ch) return;
        const d = ch.delta || ch.message || {};
        const r = d.reasoning || d.reasoning_content;
        if (r) { reasoning += r; cb.onReasoning && cb.onReasoning(reasoning); }
        if (d.content) {
          // Split inline <think> blocks (some open models) into reasoning.
          let t = d.content;
          while (t) {
            if (inThink) { const e = t.indexOf('</think>'); if (e < 0) { reasoning += t; t = ''; } else { reasoning += t.slice(0, e); t = t.slice(e + 8); inThink = false; } cb.onReasoning && cb.onReasoning(reasoning); }
            else { const s = t.indexOf('<think>'); if (s < 0) { content += t; t = ''; } else { content += t.slice(0, s); t = t.slice(s + 7); inThink = true; } }
          }
          cb.onText && cb.onText(content);
        }
        (d.tool_calls || []).forEach((tc) => {
          const idx = tc.index != null ? tc.index : calls.length;
          const c = calls[idx] || (calls[idx] = { id: tc.id || 'call_' + idx + '_' + Date.now().toString(36), type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) c.id = tc.id;
          if (tc.function) { if (tc.function.name) c.function.name += tc.function.name; if (tc.function.arguments) c.function.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments); }
        });
        if (ch.finish_reason) finish = ch.finish_reason;
      });
      let res; let fatal = null; let raw = ''; let gotEvent = false;
      const parseWrap = (t) => { if (raw.length < 400000) raw += t; if (fatal) return; try { parse(t); } catch (e) { fatal = e; } };
      const origOnText = cb.onText; 
      res = await H.net.stream({ url: P.base + '/chat/completions', method: 'POST', headers, body: JSON.stringify(body), signal }, parseWrap);
      gotEvent = /\ndata:|^data:/.test(raw);
      if (!fatal && res.status === 200 && !gotEvent && /^\s*\{/.test(raw)) {
        // Server ignored stream:true and sent one JSON body.
        try {
          const j = JSON.parse(raw);
          if (j.error) { fatal = Object.assign(new Error(j.error.message || 'error'), { status: j.error.code }); }
          else {
            if (j.usage) usage = j.usage;
            const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
            content = (msg.content || '').replace(/<think>([\s\S]*?)<\/think>/g, (_, r) => { reasoning += r; return ''; });
            reasoning += msg.reasoning || msg.reasoning_content || '';
            (msg.tool_calls || []).forEach((c) => calls.push(c));
            finish = j.choices && j.choices[0] && j.choices[0].finish_reason;
            origOnText && origOnText(content);
          }
        } catch (_) {}
      }
      if (fatal) {
        if (body.max_tokens && /max_tokens|max_completion_tokens|max_new_tokens/i.test(fatal.message || '')) { NO_MAXTOK.add(info.provider); ki--; continue; }
        const fo = failoverWindow(info.provider, Number(fatal.status) || 429, fatal.message);
        lastErr = new Error(fo && fo.daily && info.provider === 'cloudflare' ? H.CF_DAILY_MSG : P.name + ': ' + fatal.message); lastErr.status = Number(fatal.status) || 0;
        if (fo && fo.daily && k.id) { markExhausted(k.id, fo.until, fo.why); H.usage && H.usage.markZero(full, fo.why, fo.until); continue; }
        if (fo && k.id && /limit|quota|rate|credit|exceed|429|402/i.test(fatal.message + ' ' + fatal.status)) { markExhausted(k.id, fo.until, fo.why); continue; }
        throw lastErr;
      }
      if (res.aborted) return { content, reasoning, tool_calls: calls.filter(Boolean), finish: 'aborted', keyLabel: k.label };
      if (res.status >= 400 || (info.provider === 'cloudflare' && CF_DAILY_RE.test(res.text || ''))) {
        const fo = failoverWindow(info.provider, res.status, res.text);
        lastErr = new Error(fo && fo.daily && info.provider === 'cloudflare' ? H.CF_DAILY_MSG : P.name + ' ' + res.status + ': ' + extractErr(res.text));
        lastErr.status = res.status;
        if (fo && fo.daily) { H.usage && H.usage.markZero(full, fo.why, fo.until); if (k.id) markExhausted(k.id, fo.until, fo.why); continue; }
        if (/\b5028\b|deprecated|no longer (available|supported)|has been retired/i.test(res.text || '')) { H.retire(full); throw Object.assign(lastErr, { code: 'retired' }); }
        if (fo && k.id) { markExhausted(k.id, fo.until, fo.why); continue; }
        if ((res.status === 400 || res.status === 422) && body.max_tokens && /max_tokens|max_completion_tokens|max_new_tokens|maximum.*tokens|output tokens/i.test(res.text || '')) { NO_MAXTOK.add(info.provider); ki--; continue; }
        if (res.status === 400 && body.stream_options && /stream_options|include_usage/i.test(res.text || '')) { USAGE_OPT.delete(info.provider); ki--; continue; }
        if (res.status === 400 && useTools && /tool|function/i.test(res.text)) { useTools = false; ki--; continue; }
        throw lastErr;
      }
      H.usage && H.usage.record(full, usage, content.length + reasoning.length);
      return { content: content.trim() ? content : content, reasoning, tool_calls: calls.filter(Boolean), finish, keyLabel: k.label, usedTools: !!useTools, usage };
    }
    throw Object.assign(lastErr || new Error('All keys failed'), { code: 'exhausted' });
  }
  function extractErr(t) {
    try { const j = JSON.parse(t); const e = j.error || (j.errors && j.errors[0]) || j; return (e.message || e.detail || JSON.stringify(e)).toString().slice(0, 300); } catch (_) { return String(t || '').slice(0, 300); }
  }

  /** Complete with automatic model fallback when keys are exhausted or the provider is down. */
  H.complete = async function (full, messages, tools, cb, signal) {
    const tried = [];
    let model = full;
    for (let attempt = 0; attempt < 4; attempt++) {
      tried.push(model);
      try {
        const r = await completeOnce(model, messages, tools, cb, signal);
        r.model = model; r.switched = model !== full ? { from: full, to: model } : null;
        return r;
      } catch (e) {
        if (H.netErr && H.netErr(e)) throw e; // a dropped link is retried by the caller, not a reason to switch models
        const canFallback = H.settings.autoFallback && (e.code === 'exhausted' || e.code === 'retired' || e.code === 'nokey' || e.code === 'native' || (e.status && e.status >= 500) || /network|timeout|Unable to resolve|failed to connect/i.test(e.message));
        if (!canFallback) throw e;
        const needVision = messages.some((m) => m.images && m.images.length);
        const next = RECOMMENDED.find((id) => !tried.includes(id) && H.isFree(id) && !(H.usage && H.usage.isZero(id)) && H.providerReady(id.split(':')[0]) && (!needVision || H.modelInfo(id).vision) && H.catalog.models[id] && (H.native || !PROVIDERS[id.split(':')[0]].nativeOnly));
        if (!next) throw e;
        cb.onSwitch && cb.onSwitch(model, next, e.message);
        model = next;
      }
    }
    throw new Error('No model available right now');
  };

  /** One-shot non-streaming helper (titles etc.). */
  H.quick = async function (prompt, maxTokens) {
    let out = '';
    try {
      const r = await H.complete(H.settings.model, [{ role: 'user', content: prompt }], null, { onText: (t) => (out = t) });
      return (r.content || out).replace(/<think>[\s\S]*?<\/think>/g, '').trim().slice(0, maxTokens || 400);
    } catch (_) { return ''; }
  };
})();
