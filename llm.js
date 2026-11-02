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
          .filter((m) => m.id.endsWith(':free') || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0 && !/^openrouter\/auto/.test(m.id)))
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
        return (r.json().models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini|gemma/.test(m.name) && !SKIP_RE.test(m.name) && !/tts|image|embedding/.test(m.name))
          .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name, ctx: m.inputTokenLimit, vision: true, tools: !/gemma/.test(m.name) }));
      },
    },
    xai: {
      name: 'xAI', base: 'https://api.x.ai/v1',
      async models(keyRef) {
        const r = await H.net.request({ url: this.base + '/models', headers: { Authorization: 'Bearer ' + keyRef } });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        return r.json().data.filter((m) => !SKIP_RE.test(m.id) && !/image|imagine/.test(m.id)).map((m) => ({ id: m.id, name: m.id, vision: VISION_RE.test(m.id), tools: true }));
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

  // Known-good picks (tested 31 Oct 2026) shown first in the picker, also the fallback chain.
  const RECOMMENDED = [
    'groq:openai/gpt-oss-120b', 'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free', 'cohere:command-a-03-2025',
    'nvidia:mistralai/mistral-large-4-1t-a52b', 'nvidia:minimaxai/minimax-m3.1-flash', 'openrouter:nvidia/nemotron-3.5-lightning:free',
    'groq:qwen/qwen3.8-27b', 'groq:openai/gpt-oss-20b', 'openrouter:nvidia/nemotron-3.5-super-vl:free',
    'nvidia:nvidia/nemotron-3.5-super-vl-120b-a12b', 'cohere:command-a-vision-07-2025',
  ];
  const SEED = {
    'groq:openai/gpt-oss-120b': { name: 'GPT-OSS 120B', tools: true },
    'groq:openai/gpt-oss-20b': { name: 'GPT-OSS 20B', tools: true },
    'groq:qwen/qwen3.8-27b': { name: 'Qwen 3.8 27B', tools: true, vision: true },
    'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free': { name: 'Nemotron 3 Ultra 550B', tools: true },
    'openrouter:nvidia/nemotron-3.5-lightning:free': { name: 'Nemotron 3.5 Lightning', tools: true },
    'openrouter:nvidia/nemotron-3.5-super-vl:free': { name: 'Nemotron 3.5 Super VL', tools: true, vision: true },
    'cohere:command-a-03-2025': { name: 'Command A', tools: true },
    'cohere:command-a-vision-07-2025': { name: 'Command A Vision', vision: true },
    'nvidia:minimaxai/minimax-m3.1-flash': { name: 'MiniMax M3.1 Flash', tools: true },
    'nvidia:mistralai/mistral-large-4-1t-a52b': { name: 'Mistral Large 4', tools: true },
    'nvidia:nvidia/nemotron-3.5-super-vl-120b-a12b': { name: 'Nemotron 3.5 Super VL', tools: true, vision: true },
  };

  // ---------------- catalog ----------------
  const CAT_KEY = 'hark.catalog';
  function loadCatalog() {
    try { const c = JSON.parse(localStorage.getItem(CAT_KEY) || 'null'); if (c && c.models) return c; } catch (_) {}
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
  H.providerReady = (p) => p === 'custom' ? !!PROVIDERS.custom.base : H.vault.has(p);
  H.recommended = () => RECOMMENDED.filter((id) => H.providerReady(id.split(':')[0]));

  /** Refresh the live catalog. Returns {added:[], removed:[]} */
  H.refreshCatalog = async function (opts) {
    const first = !H.catalog.updated;
    const before = new Set(Object.keys(H.catalog.models).filter((k) => !H.catalog.models[k].seed));
    const next = {}; const errors = {}; const okProviders = new Set();
    await Promise.all(Object.keys(PROVIDERS).map(async (p) => {
      if (!H.providerReady(p)) return;
      if (PROVIDERS[p].nativeOnly && !H.native) { errors[p] = 'needs the Android app (no browser access)'; return; }
      const keys = p === 'custom' ? [{ id: null }] : H.vault.byProvider(p);
      for (const k of keys) {
        try {
          const list = await PROVIDERS[p].models(k.id ? PH(k.id) : '');
          list.forEach((m) => { next[p + ':' + m.id] = Object.assign({ provider: p }, m, SEED[p + ':' + m.id] ? { name: SEED[p + ':' + m.id].name } : {}); });
          okProviders.add(p); return;
        } catch (e) { errors[p] = e.message; }
      }
    }));
    // Keep models of providers that failed this time (do not remove on a network blip).
    for (const k in H.catalog.models) {
      const p = H.catalog.models[k].provider;
      if (!okProviders.has(p) && !next[k] && H.providerReady(p)) next[k] = H.catalog.models[k];
    }
    // Seeds stay visible until their provider's real list arrives.
    for (const id in SEED) { const p = id.split(':')[0]; if (!okProviders.has(p) && !next[id]) next[id] = H.catalog.models[id] || Object.assign({ id: id.slice(p.length + 1), provider: p, seed: true }, SEED[id]); }
    const after = new Set(Object.keys(next));
    const added = first ? [] : [...after].filter((k) => !before.has(k) && !(H.catalog.models[k] && H.catalog.models[k].seed));
    const removed = [...before].filter((k) => !after.has(k) && okProviders.has(H.catalog.models[k].provider));
    H.catalog = { updated: Date.now(), models: next, newIds: Array.from(new Set([...(H.catalog.newIds || []), ...added])).filter((k) => next[k]), errors };
    saveCatalog();
    // Selected model gone? fall back.
    if (!next[H.settings.model] && okProviders.has(H.settings.model.split(':')[0])) {
      const fb = RECOMMENDED.find((id) => next[id]) || Object.keys(next)[0];
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

  function failoverWindow(provider, status, text) {
    const t = (text || '').toLowerCase();
    if (status === 401) return { until: Date.now() + 6 * 3600e3, why: 'key rejected (401)' };
    if (status === 402) return { until: provider === 'openrouter' ? PROVIDERS.openrouter.resetAt() : Date.now() + 3600e3, why: 'out of credit (402)' };
    if (status === 429) {
      const daily = /per[- ]day|daily|free-models-per-day|quota/.test(t);
      if (provider === 'openrouter' && daily) return { until: PROVIDERS.openrouter.resetAt(), why: 'daily free limit (resets 05:30 IST)' };
      return { until: Date.now() + (daily ? 3600e3 : 60e3), why: 'rate limited (429)' };
    }
    if (status === 403 && /quota|limit|exceed|insufficient|credit|billing|rate/.test(t)) return { until: Date.now() + 3600e3, why: 'quota (403)' };
    return null;
  }

  // ---------------- message conversion ----------------
  function toApiMessages(msgs, vision) {
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
      throw Object.assign(new Error('All ' + P.name + ' keys are resting until ' + new Date(soon).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) + ' IST.'), { code: 'exhausted' });
    }
    let lastErr = null; let useTools = tools && tools.length && info.tools !== false;
    for (let ki = 0; ki < live.length; ki++) {
      const k = live[ki];
      const body = { model: info.id, messages: toApiMessages(messages, info.vision !== false), stream: true };
      if (useTools) { body.tools = tools; body.tool_choice = 'auto'; }
      if (info.provider === 'openrouter') body.usage = { include: false };
      const headers = Object.assign({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }, P.headers || {});
      if (k.id) headers.Authorization = 'Bearer ' + PH(k.id);
      let content = '', reasoning = '', finish = null; const calls = [];
      let inThink = false;
      const parse = sseParser((j) => {
        if (j.error) { const e = new Error(j.error.message || JSON.stringify(j.error)); e.harkFatal = true; e.status = j.error.code; throw e; }
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
        const fo = failoverWindow(info.provider, Number(fatal.status) || 429, fatal.message);
        lastErr = new Error(P.name + ': ' + fatal.message); lastErr.status = Number(fatal.status) || 0;
        if (fo && k.id && /limit|quota|rate|credit|exceed|429|402/i.test(fatal.message + ' ' + fatal.status)) { markExhausted(k.id, fo.until, fo.why); continue; }
        throw lastErr;
      }
      if (res.aborted) return { content, reasoning, tool_calls: calls.filter(Boolean), finish: 'aborted', keyLabel: k.label };
      if (res.status >= 400) {
        const fo = failoverWindow(info.provider, res.status, res.text);
        lastErr = new Error(P.name + ' ' + res.status + ': ' + extractErr(res.text));
        lastErr.status = res.status;
        if (fo && k.id) { markExhausted(k.id, fo.until, fo.why); continue; }
        if (res.status === 400 && useTools && /tool|function/i.test(res.text)) { useTools = false; ki--; continue; }
        throw lastErr;
      }
      return { content: content.trim() ? content : content, reasoning, tool_calls: calls.filter(Boolean), finish, keyLabel: k.label, usedTools: !!useTools };
    }
    throw Object.assign(lastErr || new Error('All keys failed'), { code: 'exhausted' });
  }
  function extractErr(t) {
    try { const j = JSON.parse(t); const e = j.error || j; return (e.message || e.detail || JSON.stringify(e)).toString().slice(0, 300); } catch (_) { return String(t || '').slice(0, 300); }
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
        const canFallback = H.settings.autoFallback && (e.code === 'exhausted' || e.code === 'nokey' || e.code === 'native' || (e.status && e.status >= 500) || /network|timeout|Unable to resolve|failed to connect/i.test(e.message));
        if (!canFallback) throw e;
        const needVision = messages.some((m) => m.images && m.images.length);
        const next = RECOMMENDED.find((id) => !tried.includes(id) && H.providerReady(id.split(':')[0]) && (!needVision || H.modelInfo(id).vision) && H.catalog.models[id] && (H.native || !PROVIDERS[id.split(':')[0]].nativeOnly));
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
