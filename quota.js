/* Shoeb AI 1.1.9 — free-model usage: the app's own per-model counts (requests + tokens), published free limits,
   and hark-a1's `ai-quota --json` (read over SSH, cached ≤30 min, optional). Shown as small numbers in the model picker. */
(function () {
  'use strict';
  const H = window.Hark;
  const KEY = 'hark.usage';
  const ZKEY = 'hark.usage.zero';
  const QKEY = 'hark.quota.server';
  const QTTL = 30 * 60e3;
  const istDay = (t) => new Date((t || Date.now()) + 5.5 * 3600e3).toISOString().slice(0, 10);
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (_) { return d; } };
  let data = load(KEY, {});
  let zero = load(ZKEY, {});
  const save = () => localStorage.setItem(KEY, JSON.stringify(data));

  /**
   * Published free allowances (approximate; providers change them). n per `per` ('day'|'month'); unit 'req' unless noted.
   * null = free but only rate-limited per minute (no daily cap to count down).
   */
  function freeLimit(full) {
    const i = String(full).indexOf(':'); const p = full.slice(0, i); const id = full.slice(i + 1);
    const m = (H.catalog && H.catalog.models[full]) || {};
    switch (p) {
      case 'gemini': return /gemma/.test(id) ? { n: 14400, per: 'day' } : /lite/.test(id) ? { n: 1000, per: 'day' } : { n: 250, per: 'day' };
      case 'groq': return /instant|8b|gpt-oss-20b/.test(id) ? { n: 14400, per: 'day' } : { n: 1000, per: 'day' };
      case 'openrouter': return { n: 50 * Math.max(1, (H.vault.byProvider('openrouter') || []).length), per: 'day' };
      case 'github': { const t = m.tier || (/mini|nano|llama|phi|mistral|small/i.test(id) ? 'low' : 'high'); return { n: t === 'low' ? 150 : t === 'custom' ? 8 : 50, per: 'day' }; }
      case 'cohere': return { n: 1000, per: 'month' };
      case 'cloudflare': return { n: 10000, per: 'day', unit: 'neurons' };
      default: return null; // kilo, opencode, mistral, sambanova, nvidia, custom: rate-limited, no fixed daily count
    }
  }

  const usage = (H.usage = {
    /** One finished request: usage = OpenAI-style {prompt_tokens, completion_tokens, total_tokens} if the provider sent it. */
    record(full, u, chars) {
      if (!full) return;
      const d = istDay(); const m = data[full] || (data[full] = {}); const r = m[d] || (m[d] = { r: 0, t: 0, e: 0 });
      r.r += 1;
      const tok = u ? (Number(u.total_tokens) || (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0)) : 0;
      if (tok) r.t += tok; else { r.t += Math.ceil((chars || 0) / 4); r.e = 1; }
      // keep 8 days
      const cut = istDay(Date.now() - 8 * 864e5);
      for (const k in m) if (k < cut) delete m[k];
      save();
    },
    /** totals {today:{r,t}, week:{r,t}} (IST days; week = today + previous 6). */
    totals(full) {
      const m = data[full] || {}; const today = istDay(); const from = istDay(Date.now() - 6 * 864e5);
      const o = { today: { r: 0, t: 0 }, week: { r: 0, t: 0 } };
      for (const k in m) { if (k >= from) { o.week.r += m[k].r; o.week.t += m[k].t; } if (k === today) { o.today.r += m[k].r; o.today.t += m[k].t; } }
      return o;
    },
    /** A provider said this model's (or provider's) free allowance is used up until `until`. */
    markZero(full, why, until) {
      const p = String(full).split(':')[0];
      zero[p] = { why, until: until || Date.now() + 3600e3 };
      localStorage.setItem(ZKEY, JSON.stringify(zero));
    },
    zeroInfo(full) {
      const p = String(full).split(':')[0]; const z = zero[p];
      if (z && z.until > Date.now()) return z;
      // all keys of the provider resting?
      const keys = H.vault.byProvider(p);
      if (keys.length && H.keyStatus && keys.every((k) => H.keyStatus(k.id))) { const s = H.keyStatus(keys[0].id); return { why: s.why, until: s.until }; }
      return null;
    },
    isZero(full) { const v = quota.view(full); return v.remaining === 0; },
    _reset() { data = {}; zero = {}; save(); localStorage.removeItem(ZKEY); },
  });

  // ---------------- hark-a1 ai-quota --json ----------------
  const num = (...xs) => { for (const x of xs) if (x != null && x !== '' && !isNaN(Number(x))) return Number(x); return null; };
  const quota = (H.quota = {
    server: load(QKEY, null), // {at, absent, models:{key:{...}}}
    /** Normalise whatever shape ai-quota prints into {"provider:model": {...}} (also indexed by bare model id). */
    parse(text) {
      const t = String(text || '').trim(); const s = t.indexOf('{') < 0 ? t.indexOf('[') : Math.min(...['{', '['].map((c) => t.indexOf(c)).filter((i) => i >= 0));
      const j = JSON.parse(t.slice(Math.max(0, s)));
      if (j && j.absent) return { absent: true, models: {} };
      let list = Array.isArray(j) ? j : (j.models || j.items || j.data || j.quotas || null);
      if (!list && j && typeof j === 'object') list = Object.keys(j).map((k) => Object.assign({ model: k }, j[k]));
      const models = {};
      const val = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x.value : x);
      (list || []).forEach((x) => {
        if (!x || typeof x !== 'object' || x.free === false) return;
        let model = String(x.model || x.id || x.name || ''); if (!model) return;
        let provider = String(x.provider || '').toLowerCase().replace(/\s+/g, '');
        if (!provider && x.ref && String(x.ref).includes('/')) { provider = String(x.ref).split('/')[0]; }
        provider = provider.replace(/^(google|googleai|google-ai|gemini)$/, 'gemini').replace(/^(githubmodels|github-models|github)$/, 'github').replace(/^(opencodezen|opencode-zen|zen|opencode)$/, 'opencode').replace(/^(cloudflareworkersai|workers-ai|cf|cloudflare)$/, 'cloudflare').replace(/^(nim|nvidia-nim|nvidia_nim)$/, 'nvidia').replace(/^(kilocode|kilo-gateway)$/, 'kilo');
        const c = x.consumed || x.used || x.usage || {};
        const ct = c.today || {}; const cw = c['7d'] || c.week || {};
        const fl = x.free_limit != null ? x.free_limit : x.freeLimit;
        const rem = x.remaining;
        let unit = (fl && typeof fl === 'object' && fl.unit) || x.unit || x.limit_unit || null;
        let per = x.per || x.period || null;
        if (unit && /\/(day|d)\b/i.test(unit)) { per = 'day'; unit = unit.replace(/\/(day|d)\b/i, '').replace(/^requests?$/i, 'req'); }
        else if (unit && /\/(month|mo)\b/i.test(unit)) { per = 'month'; unit = unit.replace(/\/(month|mo)\b/i, '').replace(/^requests?$/i, 'req'); }
        else if (unit && /\/(min|minute)\b/i.test(unit)) { per = 'min'; unit = unit.replace(/\/(min|minute)\b/i, '').replace(/^requests?$/i, 'req'); }
        const remStatus = rem && typeof rem === 'object' ? String(rem.status || '') : '';
        const v = {
          provider, model,
          limit: num(val(fl), x.limit, x.daily_limit, x.limit_per_day),
          unit, per,
          remaining: /exhausted|empty|depleted/i.test(remStatus) ? 0 : num(val(rem), x.left),
          remainingStatus: remStatus || null, resetAt: rem && typeof rem === 'object' ? rem.reset_at || null : null,
          today: num(x.consumed_today, x.used_today, typeof ct === 'object' ? ct.requests : ct, typeof x.today === 'number' ? x.today : null),
          todayTok: num(typeof ct === 'object' ? ct.total_tokens : null),
          week: num(x.consumed_7d, x.consumed_week, x.used_7d, typeof cw === 'object' ? cw.requests : cw),
          weekTok: num(typeof cw === 'object' ? cw.total_tokens : null),
          sources: x.sources || c.sources || x.source || null,
        };
        if (provider && model.startsWith(provider + '/')) model = model.slice(provider.length + 1);
        models[(provider ? provider + ':' : '') + model] = v;
        if (!models[model]) models[model] = v;
      });
      return { absent: false, models };
    },
    find(full) {
      const s = this.server; if (!s || !s.models) return null;
      const i = full.indexOf(':'); const id = full.slice(i + 1);
      return s.models[full] || s.models[id] || s.models[id.split('/').pop()] || null;
    },
    /** Read ai-quota over the admin SSH (only when the app has hark-a1). Cached for 30 minutes; never throws. */
    async refresh(force) {
      try {
        if (!force && this.server && Date.now() - (this.server.at || 0) < QTTL) return this.server;
        if (!H.ssh || !H.agents || !window.HarkOps) return this.server;
        const vm = H.agents.server(); if (!vm) return this.server;
        let out = '';
        const cmd = 'if command -v ai-quota >/dev/null 2>&1; then ai-quota --json; elif [ -x /usr/local/bin/ai-quota ]; then /usr/local/bin/ai-quota --json; else echo \'{"absent":true}\'; fi';
        const v = H.ssh.classify(cmd);
        await H.ssh.exec(vm.id, cmd, (t) => { out += t; }, 40, H.ssh.nativePolicy() && !v.needsTicket);
        const p = this.parse(out);
        this.server = Object.assign({ at: Date.now() }, p);
        localStorage.setItem(QKEY, JSON.stringify(this.server));
      } catch (e) {
        // keep the last good copy; remember the failure so we don't hammer SSH
        this.server = Object.assign({}, this.server || { models: {}, absent: true }, { at: Date.now(), error: String(e && e.message || e).slice(0, 120) });
        try { localStorage.setItem(QKEY, JSON.stringify(this.server)); } catch (_) {}
      }
      return this.server;
    },
    /**
     * Everything the picker shows for one model: {limit, limitText, remaining, today:{r,t}, week:{r,t}, zero, src}.
     * Server numbers (ai-quota) win where present; otherwise the app's own counts against the published limit.
     */
    view(full) {
      const loc = usage.totals(full); const lim = freeLimit(full); const srv = this.find(full); const z = usage.zeroInfo(full);
      const o = { limit: lim ? lim.n : null, per: lim ? lim.per : 'day', unit: lim && lim.unit || 'req', remaining: null, today: loc.today, week: loc.week, src: 'app', zero: z };
      if (lim && lim.per === 'day' && o.unit === 'req') o.remaining = Math.max(0, lim.n - loc.today.r);
      if (srv) {
        if (srv.limit != null && srv.per !== 'min') { o.limit = srv.limit; if (srv.unit) o.unit = srv.unit; if (srv.per) o.per = srv.per; }
        if (srv.remaining != null) o.remaining = Math.max(0, srv.remaining);
        // Server counts (OpenClaw, Hermes, … on hark-a1) plus this app's own requests, which the server can't see.
        if (srv.today != null) o.today = { r: srv.today + loc.today.r, t: (srv.todayTok || 0) + loc.today.t, server: srv.today };
        if (srv.week != null) o.week = { r: srv.week + loc.week.r, t: (srv.weekTok || 0) + loc.week.t, server: srv.week };
        o.src = 'hark-a1';
      }
      if (z) o.remaining = 0;
      o.limitText = o.limit == null ? 'free' : 'free ' + short(o.limit) + (o.unit && o.unit !== 'req' ? ' ' + o.unit : '') + '/' + (o.per === 'month' ? 'mo' : 'd');
      return o;
    },
    /** One short line for the picker row. */
    line(full) {
      const v = this.view(full);
      const parts = [v.limitText];
      if (v.remaining != null) parts.push('left ' + short(v.remaining));
      parts.push('used ' + short(v.today.r) + (v.today.t ? ' (' + short(v.today.t) + ' tok)' : '') + ' today · ' + short(v.week.r) + (v.week.t ? ' (' + short(v.week.t) + ' tok)' : '') + ' 7d');
      if (v.zero) parts.push(v.zero.why);
      return parts.join(' · ');
    },
  });
  function short(n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); }
  H.freeLimit = freeLimit;

  /**
   * "Long chats" (1.1.12): free models that suit long conversations and many tool rounds —
   * tool calling, a big context (≥128k where the catalog says; unknown counts as OK for providers whose free models are all
   * large), ≥8k reply tokens accepted, and no tiny daily quota. Out: OpenRouter :free (~50/day), GitHub Models (≤150/day,
   * 4k output cap), Cloudflare (10k-neuron day, 4k output), SambaNova (low quota, 4k output), Cohere trial (1,000/month),
   * Groq (free tier caps tokens per minute at ~6–12k, too small for a long chat's prompt), custom endpoint (not a free tier).
   */
  const LONG_OK = { gemini: 1, mistral: 1, opencode: 1, kilo: 1, nvidia: 1 };
  function longChat(full) {
    const i = String(full).indexOf(':'); const p = full.slice(0, i); const id = full.slice(i + 1);
    if (!LONG_OK[p]) return false;
    const m = (H.catalog && H.catalog.models[full]) || {};
    if (m.tools === false || (H.modelInfo && H.modelInfo(full).tools === false)) return false;
    if (/image|tts|audio|embed|live|ocr|moderation|guard/i.test(id) || (p === 'gemini' && /gemma/.test(id))) return false;
    if (H.MAX_OUT && (H.MAX_OUT[p] || 0) < 8192) return false;
    if (m.ctx && Number(m.ctx) < 128000) return false;
    if (p === 'mistral' && !/-latest$|^mistral-large-4$/.test(id)) return false;
    const lim = freeLimit(full);
    if (lim && lim.per === 'day' && (!lim.unit || lim.unit === 'req') && lim.n < 200) return false;
    return true;
  }
  H.longChat = longChat;
})();
