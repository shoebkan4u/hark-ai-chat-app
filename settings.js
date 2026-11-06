/* Hark AI — settings screens. */
(function () {
  'use strict';
  const H = window.Hark;
  const { el, icon } = { el: H.el, icon: H.icon };
  const N = window.HarkNative || null;
  const PUBLIC_REPO = 'shoebkan4u/hark-ai-chat-app';

  function screen(title, build) {
    let close;
    const body = el('div', { class: 'body' });
    const s = el('div', { class: 'screen' },
      el('div', { class: 'topbar' }, el('button', { class: 'iconbtn', html: icon.back, onclick: () => close() }), el('h2', { text: title })), body);
    close = H.ui.pushOverlay(s);
    const redraw = () => { body.innerHTML = ''; build(body, redraw, close); };
    redraw();
    return close;
  }
  const sec = (t) => el('div', { class: 'sec', text: t });
  const row = (ic, title, sub, fn, right) => el(fn ? 'button' : 'div', { class: 'row', onclick: fn, html: ic || '' }, el('span', { class: 't', html: '<b>' + H.esc(title) + '</b>' + (sub ? '<small>' + H.esc(sub) + '</small>' : '') }), right || (fn ? el('span', { html: icon.right }) : null));
  const toggle = (checked, onchange) => { const i = el('input', { type: 'checkbox' }); i.checked = !!checked; i.onchange = () => onchange(i.checked, i); return el('label', { class: 'switch', onclick: (e) => e.stopPropagation() }, i, el('i')); };
  const field = (label, input) => el('label', { class: 'field' }, el('span', { text: label }), input);

  const PROVIDER_CHOICES = [
    ['openrouter', 'OpenRouter', 'openrouter.ai'], ['groq', 'Groq', 'api.groq.com'], ['cohere', 'Cohere', 'api.cohere.ai'],
    ['nvidia', 'NVIDIA', 'integrate.api.nvidia.com'], ['gemini', 'Gemini', 'generativelanguage.googleapis.com'],
    ['opencode', 'OpenCode Zen (free models)', 'opencode.ai'], ['kilo', 'Kilo (free models)', 'api.kilo.ai'], ['sambanova', 'SambaNova', 'api.sambanova.ai'],
    ['mistral', 'Mistral (free tier)', 'api.mistral.ai'], ['github', 'GitHub Models', 'models.github.ai'], ['xai', 'xAI (Grok) · paid, not used', 'api.x.ai'],
    ['huggingface', 'Hugging Face', 'huggingface.co'], ['cloudflare', 'Cloudflare Workers AI', 'api.cloudflare.com'], ['custom', 'Custom / OpenClaw gateway', ''],
    ['openalgo:tradesmart', 'OpenAlgo TradeSmart', ''], ['openalgo:wisdom', 'OpenAlgo Wisdom', ''],
    ['runner:tradesmart', 'Hark runner · TradeSmart', 'runner-tradesmart.hark.local'], ['runner:wisdom', 'Hark runner · Wisdom', 'runner-wisdom.hark.local'],
    ['ssh', 'SSH keys (app only)', ''], ['ssh-pass', 'SSH key passphrases (app only)', ''], ['oci', 'Oracle Cloud API key (app only)', ''],
  ];

  const open = (section) => {
    if (section && SECTIONS[section]) return SECTIONS[section]();
    screen('Settings', (b) => {
      const name = el('input', { value: H.settings.name, onchange: (e) => { H.settings.name = e.target.value.trim() || 'Shoeb'; H.saveSettings(); } });
      const full = el('input', { value: H.settings.fullName, onchange: (e) => { H.settings.fullName = e.target.value.trim(); H.saveSettings(); } });
      const seg = el('div', { class: 'seg' }, ['system', 'light', 'dark'].map((m) => el('button', { class: H.settings.theme === m ? 'on' : '', text: m[0].toUpperCase() + m.slice(1), onclick: (e) => { H.settings.theme = m; H.saveSettings(); H.applyTheme(); e.target.parentNode.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === e.target)); } })));
      const keys = H.vault.list();
      b.append(sec('Profile'), el('div', { class: 'card', style: { padding: '4px 14px' } }, field('What Hark calls you', name), field('Full name', full)),
        sec('Appearance'), seg,
        sec('Connections'), el('div', { class: 'card' },
          row(icon.key, 'Keys & vault', keys.length + ' saved on this phone', SECTIONS.keys),
          row(icon.upload, 'Import from Hark', 'Encrypted file with keys and knowledge', SECTIONS.import),
          row(icon.chat, 'Models', H.modelLabel(H.settings.model) + ' · auto-fallback ' + (H.settings.autoFallback ? 'on' : 'off'), SECTIONS.models),
          row(icon.chart, 'Brokers (OpenAlgo)', H.settings.openalgo.map((a) => a.name).join(' · '), SECTIONS.brokers),
          row(icon.plug, 'MCP servers', H.settings.mcpServers.length + ' configured', SECTIONS.mcp),
          ...(H.accountsUI ? [
            row(icon.chat, 'Gmail', H.accountsUI.summary().gmail, () => H.accountsUI.gmail()),
            row(icon.send, 'Telegram', 'OpenClaw bot ' + H.accountsUI.summary().telegram, () => H.accountsUI.telegram()),
            row(icon.key, 'Saved logins', H.accountsUI.summary().logins, () => H.accountsUI.logins())] : [])),
        sec('Personal'), el('div', { class: 'card' },
          row(icon.brain, 'Memory', H.memory.list().length + ' items, encrypted on this phone', SECTIONS.memory),
          row(icon.doc, 'Knowledge', H.settings.knowledge ? Math.round(H.settings.knowledge.length / 100) / 10 + 'k chars of background' : 'None imported', SECTIONS.knowledge),
          row(icon.clock, 'Scheduled tasks', (H.settings.tasks || []).length + ' tasks', SECTIONS.tasks),
          row(icon.speak, 'Voice', 'Auto-read replies ' + (H.settings.voice.autoSpeak ? 'on' : 'off'), SECTIONS.voice),
          row(icon.widget, 'Home screen widgets', 'Quick ask · P&L', SECTIONS.widgets)),
        sec('App'), el('div', { class: 'card' },
          approvalsRow(),
          row(icon.shield, 'Safety', 'When Shoeb AI asks before acting', SECTIONS.safety),
          row(icon.shield, 'Security & privacy', 'How keys and data are protected', SECTIONS.security),
          row(icon.info, 'About & updates', 'Web ' + H.version + (N ? ' · app ' + N.version() : ''), SECTIONS.about)));
    });
  };

  const SECTIONS = {};
  // ---------------- keys ----------------
  SECTIONS.keys = () => screen('Keys & vault', (b, redraw) => {
    const list = H.vault.list();
    b.append(el('div', { class: 'note', text: N ? 'Keys are encrypted with a key held in Android Keystore. The app\'s web code never sees them: it sends a placeholder and the phone fills the key in only for that provider\'s own address.' : 'Browser mode: keys are stored in this browser. Use the Android app for the secure vault.' }));
    const groups = {};
    list.forEach((m) => (groups[m.provider] = groups[m.provider] || []).push(m));
    Object.keys(groups).sort().forEach((p) => {
      b.append(sec((PROVIDER_CHOICES.find((x) => x[0] === p) || [p, p])[1]));
      b.append(el('div', { class: 'card' }, groups[p].sort((a, c) => (a.order || 1) - (c.order || 1)).map((m) => {
        const st = H.keyStatus(m.id);
        return row(icon.key, m.label, m.preview + (m.host ? ' · ' + m.host : '') + (st ? ' · resting: ' + st.why + ' until ' + new Date(st.until).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : ''), null,
          el('button', { class: 'iconbtn', html: icon.trash, onclick: () => { if (confirm('Delete "' + m.label + '" from the vault?')) { H.vault.del(m.id); redraw(); } } }));
      })));
    });
    const slots = (H.settings.slots || []).filter((s) => !list.some((m) => m.provider === s.provider && (m.order || 1) === (s.order || 1)));
    if (slots.length) {
      b.append(sec('Empty slots to fill'), el('div', { class: 'card' }, slots.map((s) => row(icon.plus, s.label.replace(/\s+/g, ' ').trim(), 'Tap to paste', () => addKey(redraw, s)))));
    }
    b.append(el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'Add a key', onclick: () => addKey(redraw) }),
      el('button', { class: 'btn ghost', text: 'SSH keys & servers', onclick: () => H.opsUI.servers() }),
      el('button', { class: 'btn ghost', text: 'Reset rate-limit pauses', onclick: () => { H.clearExhausted(); redraw(); H.toast('All keys active again'); } })));
  });
  function addKey(done, slot) {
    H.ui.sheet('Add a key', (b, close) => {
      const sel = el('select', null, PROVIDER_CHOICES.filter(([id]) => !['ssh', 'ssh-pass', 'oci'].includes(id)).map(([id, n]) => el('option', { value: id, text: n })));
      if (slot) sel.value = slot.provider;
      const label = el('input', { placeholder: 'Label', value: slot ? slot.label.replace(/\s+/g, ' ').trim() : '' });
      const host = el('input', { placeholder: 'Host (for OpenAlgo/custom), e.g. my-server.ngrok-free.dev' });
      const val = el('input', { type: 'password', placeholder: 'Paste the key', autocomplete: 'off' });
      const order = el('input', { type: 'number', min: 1, value: slot ? slot.order || 1 : 1 });
      const sync = () => {
        const p = sel.value; const c = PROVIDER_CHOICES.find((x) => x[0] === p);
        const acc = H.settings.openalgo.find((a) => a.provider === p);
        host.value = c[2] || (acc && acc.base ? new URL(acc.base).host : p === 'custom' && H.settings.custom.base ? new URL(H.settings.custom.base).host : host.value);
        if (!slot) { const n = H.vault.byProvider(p).length + 1; label.value = c[1] + (p.startsWith('openalgo') ? ' API key' : ' key ' + n); order.value = n; }
      };
      sel.onchange = sync; sync();
      b.append(el('div', { style: { padding: '0 8px' } }, field('Provider', sel), field('Label', label), field('Host it may be sent to', host), field('Failover order', order), field('Key', val),
        el('button', { class: 'btn block', text: 'Save to vault', onclick: () => {
          if (!val.value.trim()) return H.toast('Paste a key first');
          if (!host.value.trim()) return H.toast('Host is required');
          H.vault.put({ label: label.value.trim() || sel.value, provider: sel.value, host: host.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''), order: +order.value || 1 }, val.value);
          val.value = ''; close(); done && done(); H.toast('Saved'); H.ui.refreshCatalog(false);
        } })));
    });
  }

  // ---------------- import ----------------
  SECTIONS.import = () => screen('Import from Hark', (b) => {
    const file = el('input', { type: 'file', accept: '.json,application/json' });
    const pass = el('input', { type: 'password', placeholder: 'Passphrase from Hark', autocomplete: 'off' });
    const status = el('div', { class: 'note' });
    const go = el('button', { class: 'btn block', text: 'Decrypt and import' });
    go.onclick = async () => {
      const f = file.files[0];
      if (!f) return H.toast('Choose the hark-import file');
      if (!pass.value.trim()) return H.toast('Enter the passphrase');
      go.disabled = true; status.textContent = 'Decrypting (a few seconds)…';
      try {
        const r = await H.vault.importFile(await f.text(), pass.value);
        pass.value = '';
        (r.openalgo || []).forEach((o) => {
          const acc = H.settings.openalgo.find((a) => a.id === o.id);
          if (!acc) return;
          // SSH tunnels need the Android app; a browser keeps using the ngrok address.
          const tunnel = /\.hark\.local/.test(o.base || '');
          acc.base = tunnel && (r.browserOnly || !H.opsNative) ? (o.fallbackBase || acc.base) : o.base;
          acc.fallbackBase = o.fallbackBase || '';
          acc.mode = /LIVE/i.test(o.mode) ? 'LIVE' : 'PAPER';
        });
        (r.runners || []).forEach((x) => {
          if (!x.tokenRef) return;
          const cur = H.settings.mcpServers.find((m) => m.id === x.id);
          const srv = { id: x.id, name: x.name, url: x.url, enabled: true, readOnly: false, trading: true, runner: true, account: x.account, tokenRef: x.tokenRef };
          if (cur) Object.assign(cur, srv, { sessionId: null }); else H.settings.mcpServers.unshift(srv);
        });
        H.settings.tools.ops = true;
        if (r.knowledge) H.settings.knowledge = r.knowledge;
        if (r.cloudflare && r.cloudflare.accountId) H.settings.cloudflare = Object.assign(H.settings.cloudflare || {}, { accountId: r.cloudflare.accountId });
        H.settings.slots = r.slots || [];
        H.saveSettings();
        status.textContent = 'Imported ' + r.imported + ' keys' + (r.knowledge ? ' and your background notes' : '') + '. ' + ((r.vms || []).length ? r.vms.length + ' server(s), ' + (r.tunnels || []).length + ' SSH tunnels' + (r.oci && r.oci.configured ? ', Oracle Cloud' : '') + '. ' : '') + (r.slots && r.slots.length ? r.slots.length + ' empty slots are listed under Keys.' : '');
        if ((r.vms || []).length) setTimeout(() => H.opsUI.connections(), 600);
        H.toast('Import complete');
        H.ui.refreshCatalog(true);
      } catch (e) { status.textContent = 'Import failed: ' + e.message; }
      go.disabled = false;
    };
    b.append(el('div', { class: 'note', text: 'Hark gave you an encrypted file (hark-import.enc.json) and a passphrase separately. The file is decrypted on this phone (AES-256-GCM, PBKDF2-SHA256 310k) and its keys go straight into the vault. Importing again replaces keys with the same names.' }),
      field('Import file', file), field('Passphrase', pass), go, status);
  });

  // ---------------- models ----------------
  SECTIONS.models = () => screen('Models', (b, redraw) => {
    const base = el('input', { value: H.settings.custom.base, placeholder: 'https://gateway.example.com/v1', onchange: (e) => { H.settings.custom.base = e.target.value.trim(); H.saveSettings(); } });
    const sm = el('input', { value: H.settings.searchModel || 'gemini-flash-latest', onchange: (e) => { H.settings.searchModel = e.target.value.trim(); H.saveSettings(); } });
    const n = Object.keys(H.catalog.models).length;
    b.append(el('div', { class: 'card' },
      row(icon.chat, 'Default model', H.modelLabel(H.settings.model), () => H.ui.openModelPicker()),
      row(icon.retry, 'Auto-fallback', 'If keys run out or a provider is down, switch to the next recommended model', null, toggle(H.settings.autoFallback, (v) => { H.settings.autoFallback = v; H.saveSettings(); })),
      row(icon.globe, 'Live catalog', n + ' models · refreshed ' + (H.catalog.updated ? new Date(H.catalog.updated).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'never') + ' · checks on launch and every 12 h', async () => { await H.ui.refreshCatalog(true); redraw(); })),
      freeKeysRow(redraw),
      el('div', { class: 'note', text: 'Free models only: paid models are hidden everywhere (picker, fallback, tasks). OpenRouter and Kilo show only “:free” ids, OpenCode Zen only its free models, Gemini only Flash / Flash-Lite / Gemma. Daily default: Gemini 3.5 Flash. Daily free limits of OpenRouter, Kilo and Cloudflare reset at 05:30 IST. NVIDIA requests go through the phone (no browser access).' }),
      sec('Cloudflare Workers AI'), cloudflareCard(redraw),
      el('div', { class: 'note', text: 'Free daily allowance (10,000 neurons, resets 05:30 IST). Used last in auto-fallback: Llama 3.3 70B (fast), then Llama 3.1 8B (fp8). Create a token at dash.cloudflare.com › My Profile › API Tokens with “Workers AI: Read” (and Edit) for this account.' }),
      sec('Custom OpenAI-compatible endpoint (OpenClaw, Ollama…)'), el('div', { class: 'card', style: { padding: '4px 14px' } }, field('Base URL (ends in /v1)', base)),
      el('div', { class: 'note', text: 'Save the gateway token under Keys → Custom. An OpenClaw gateway that listens only on loopback must be exposed (tunnel/Tailscale) before the phone can reach it.' }),
      sec('Web search model (Gemini)'), el('div', { class: 'card', style: { padding: '4px 14px' } }, field('Model used for Google Search grounding', sm)));
  });

  /**
   * Settings › Models › Import free keys from hark-a1: the app reads /etc/hark-ai/free-keys.env over its own admin SSH
   * (sudo cat) and native code stores each key straight into the vault — the values never reach this page.
   */
  function freeKeysRow(redraw) {
    const O = window.HarkOps;
    const can = !!(O && typeof O.importFreeKeys === 'function');
    return row(icon.retry, 'Import free keys from hark-a1', can ? 'Gemini, GitHub Models, Cloudflare, OpenCode Zen, Kilo, SambaNova, Mistral — read over SSH straight into the vault' : 'Needs Shoeb AI 1.1.9 or later (or use the v3 import file)', can ? async () => {
      const vm = H.agents && H.agents.server();
      if (!vm) return H.toast('Add hark-a1 under Settings › Keys › SSH keys & servers first');
      H.toast('Reading keys from hark-a1…');
      try {
        const r = await H.opsCall('importFreeKeys', vm.id);
        if (r && r.cloudflareAccountId) { H.settings.cloudflare = Object.assign(H.settings.cloudflare || {}, { accountId: r.cloudflareAccountId }); H.saveSettings(); }
        H.toast('Imported ' + ((r && r.imported) || 0) + ' free keys' + (r && r.missing && r.missing.length ? ' · missing: ' + r.missing.join(', ') : ''));
        await H.ui.refreshCatalog(false); redraw && redraw();
      } catch (e) { H.toast('Import failed: ' + e.message); }
    } : null);
  }

  /** Account id + API token for Cloudflare Workers AI. The token goes straight into the vault (host api.cloudflare.com). */
  function cloudflareCard(redraw) {
    const cf = H.settings.cloudflare || (H.settings.cloudflare = { accountId: '' });
    const acct = el('input', { value: cf.accountId || '', placeholder: '32-character account id', autocapitalize: 'off', spellcheck: 'false', onchange: (e) => { cf.accountId = e.target.value.trim(); H.saveSettings(); } });
    const tok = el('input', { type: 'password', placeholder: H.vault.has('cloudflare') ? 'Saved · paste to replace' : 'Paste the API token', autocomplete: 'off' });
    const st = el('div', { class: 'note' });
    const saved = H.vault.byProvider('cloudflare');
    return el('div', { class: 'card', style: { padding: '4px 14px 12px' } }, field('Account ID', acct), field('API token', tok),
      saved.length ? el('div', { class: 'note', text: 'Token in vault: ' + saved.map((k) => k.preview).join(', ') }) : null,
      el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'Save token', onclick: () => {
        const v = tok.value.trim(); if (!v) return H.toast('Paste the token first');
        if (!cf.accountId) return H.toast('Enter the account id first');
        saved.forEach((k) => H.vault.del(k.id));
        H.vault.put({ label: 'Cloudflare Workers AI token', provider: 'cloudflare', host: 'api.cloudflare.com', order: 1 }, v);
        tok.value = ''; H.toast('Saved'); H.ui.refreshCatalog(false); redraw && redraw();
      } })), st);
  }

  // ---------------- brokers ----------------
  SECTIONS.brokers = () => screen('Brokers & MCP', (b, redraw) => {
    b.append(el('div', { class: 'note', text: 'Hark reads funds, positions, holdings, orders, trades, P&L, quotes and history, and can send any trading action: place, smart, basket, split, modify, cancel, cancel all, close all and analyzer toggle. When you ask for one in the chat it goes to the broker at once; turn on Settings › Safety › Ask before orders to get a LIVE/PAPER ticket first. Trade-desk buttons you press yourself always show a ticket.' }));
    H.settings.openalgo.forEach((a) => {
      const k = H.vault.byProvider(a.provider).find((x) => a.base && x.host === new URL(a.base).host) || H.vault.byProvider(a.provider)[0];
      const baseIn = el('input', { value: a.base });
      baseIn.onchange = () => { a.base = baseIn.value.trim().replace(/\/+$/, ''); H.saveSettings(); };
      const test = el('button', { class: 'btn ghost', text: 'Test connection' });
      const out = el('div', { class: 'note' });
      test.onclick = async () => {
        test.disabled = true; out.textContent = 'Checking…';
        try {
          const f = await H.oaCall(a, 'funds'); const an = await H.oaAnalyzer(a);
          const d = f.data || {};
          out.textContent = 'OK · cash ₹' + Math.round(+d.availablecash || 0).toLocaleString('en-IN') + ' · analyzer ' + (an == null ? 'unknown' : an ? 'ON (paper)' : 'OFF (live)');
        } catch (e) { out.textContent = 'Failed: ' + e.message; }
        test.disabled = false;
      };
      const tunnel = /\.hark\.local/.test(a.base || '');
      const swap = a.fallbackBase ? el('button', { class: 'btn ghost', text: tunnel ? 'Use ngrok instead' : 'Use SSH tunnel', onclick: () => {
        const t = tunnel ? a.fallbackBase : 'http://oa-' + a.id + '.hark.local';
        if (!tunnel) a.fallbackBase = a.base;
        a.base = t; H.saveSettings(); redraw();
      } }) : null;
      b.append(sec(a.name), el('div', { class: 'card', style: { padding: '4px 14px 12px' } },
        el('div', { style: { margin: '10px 0' }, html: '<span class="badge ' + (a.mode === 'LIVE' ? 'live' : 'paper') + '" style="margin:0">' + (a.mode === 'LIVE' ? 'LIVE' : 'PAPER') + '</span> <span class="note">' + (k ? 'Key: ' + H.esc(k.label) + ' (' + H.esc(k.preview) + ')' : 'No key yet — import or add one') + '</span>' }),
        field('OpenAlgo address' + (tunnel ? ' (SSH tunnel to hark-a1)' : ''), baseIn),
        el('div', { class: 'note', text: a.mode === 'LIVE' ? 'LIVE money. Every write needs your tap on its ticket.' : 'Paper. Orders are refused unless analyzer (paper) mode is on.' }),
        el('div', { class: 'btns' }, test, swap, el('button', { class: 'btn ghost', text: 'Trade desk', onclick: () => H.opsUI.trade(a.id) })), out));
    });
    b.append(sec('Order safety'), el('div', { class: 'card' }, row(icon.shield, 'Tap to confirm every order', N ? 'Each ticket is bound to the exact request by the phone. No fingerprint/PIN.' : 'The browser asks for a confirm instead', null)));
    b.append(el('div', { class: 'btns' }, el('button', { class: 'btn ghost', text: 'MCP servers', onclick: SECTIONS.mcp }), el('button', { class: 'btn ghost', text: 'Connections', onclick: () => H.opsUI.connections() })));
  });

  // ---------------- MCP ----------------
  SECTIONS.mcp = () => screen('MCP servers', (b, redraw) => {
    b.append(el('div', { class: 'note', text: 'Remote MCP servers over streamable HTTP. Sign-in uses OAuth 2.1 with PKCE in a secure browser tab; tokens go into the vault. Trading servers start read-only: tools that place, modify or cancel orders are hidden until you turn read-only off, and even then each call needs your confirmation.' }));
    H.settings.mcpServers.forEach((s) => {
      const status = el('div', { class: 'note', text: s.needsAuth ? 'Needs sign-in' : s.toolCount != null ? s.toolCount + ' tools · last OK ' + (s.lastOk ? new Date(s.lastOk).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—') : (s.tokenRef ? 'Signed in' : 'Not connected') });
      const connect = el('button', { class: 'btn', text: s.tokenRef || s.toolCount ? 'Reconnect' : 'Connect' });
      connect.onclick = async () => {
        connect.disabled = true; status.textContent = 'Connecting…';
        s.enabled = true; H.saveSettings();
        try { const t = await H.mcp.connect(s.id); status.textContent = t.length + ' tools ready (' + t.filter((x) => x._write).length + ' write tools' + (s.readOnly ? ', hidden' : '') + ')'; }
        catch (e) {
          if (e.auth) {
            status.textContent = 'Opening sign-in…';
            try { await H.mcp.signIn(s.id); status.textContent = 'Finish signing in in the browser tab; you\'ll come back here.'; }
            catch (e2) { status.textContent = 'Sign-in failed: ' + e2.message; }
          } else status.textContent = 'Failed: ' + e.message;
        }
        connect.disabled = false;
      };
      b.append(sec(s.name), el('div', { class: 'card', style: { padding: '4px 14px 12px' } },
        el('div', { class: 'note', text: s.url + (s.runner ? ' · via SSH tunnel, token in the vault · write tools need a tap on the ticket' : '') }),
        el('div', { class: 'row', style: { padding: '8px 0', border: 0 } }, el('span', { class: 't', html: '<b>Enabled in chat</b>' }), toggle(s.enabled, (v) => { s.enabled = v; H.saveSettings(); })),
        el('div', { class: 'row', style: { padding: '8px 0', border: 0 } }, el('span', { class: 't', html: '<b>Read-only</b><small>Hide tools that can place/modify/cancel orders or move money</small>' }),
          toggle(s.readOnly, async (v, inp) => {
            if (!v && s.trading) { const ok = await H.ui.modal('Allow action tools?', 'Order and money tools from ' + H.esc(s.name) + ' will be offered to the AI. Each call still needs your full-screen confirmation.', [['Cancel', false, 'ghost'], ['Allow', true, 'danger']]); if (!ok) { inp.checked = true; return; } }
            s.readOnly = v; H.saveSettings();
          })),
        status,
        el('div', { class: 'btns' }, connect,
          el('button', { class: 'btn ghost', text: 'Sign out', onclick: () => { ['tokenRef', 'refreshRef'].forEach((k) => { const m = /\{\{vault:([^}]+)\}\}/.exec(s[k] || ''); if (m) H.vault.del(m[1]); delete s[k]; }); s.sessionId = null; s.toolCount = null; delete H.mcp.clients[s.id]; delete H.mcp.tools[s.id]; H.saveSettings(); redraw(); } }),
          el('button', { class: 'btn ghost', text: 'Remove', onclick: () => { if (confirm('Remove ' + s.name + '?')) { H.settings.mcpServers = H.settings.mcpServers.filter((x) => x !== s); H.saveSettings(); redraw(); } } }))));
    });
    const name = el('input', { placeholder: 'Name' }); const url = el('input', { placeholder: 'https://example.com/mcp' });
    const trading = el('input', { type: 'checkbox' }); trading.checked = true;
    b.append(sec('Add a server'), el('div', { class: 'card', style: { padding: '4px 14px 12px' } }, field('Name', name), field('URL', url),
      el('label', { class: 'row', style: { padding: '8px 0', border: 0 } }, el('span', { class: 't', html: '<b>Trading / money server</b><small>Starts read-only</small>' }), el('span', { class: 'switch' }, trading, el('i'))),
      el('button', { class: 'btn block', text: 'Add', onclick: () => {
        try { new URL(url.value); } catch (_) { return H.toast('Enter a valid URL'); }
        H.settings.mcpServers.push({ id: (name.value || 'mcp').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) + Math.random().toString(36).slice(2, 5), name: name.value.trim() || new URL(url.value).host, url: url.value.trim(), enabled: true, readOnly: trading.checked, trading: trading.checked });
        H.saveSettings(); redraw();
      } })));
  });

  // ---------------- memory ----------------
  SECTIONS.memory = () => screen('Memory', (b, redraw) => {
    const list = H.memory.list();
    b.append(el('div', { class: 'card' }, row(icon.brain, 'Use memory in chats', 'Hark reads these and can save new ones', null, toggle(H.settings.tools.memory, (v) => { H.settings.tools.memory = v; H.saveSettings(); }))),
      el('div', { class: 'note', text: 'Stored encrypted on this phone only. Edit or delete anything.' }));
    if (list.length) b.append(el('div', { class: 'card' }, list.map((m) => row(null, m.text, new Date(m.created).toLocaleDateString('en-IN') + ' · ' + m.source, null,
      el('span', { style: { display: 'flex' } },
        el('button', { class: 'iconbtn', html: icon.edit, onclick: () => { const t = prompt('Edit memory', m.text); if (t != null) { if (t.trim()) H.memory.update(m.id, t.trim()); else H.memory.del(m.id); redraw(); } } }),
        el('button', { class: 'iconbtn', html: icon.trash, onclick: () => { H.memory.del(m.id); redraw(); } }))))));
    const inp = el('input', { placeholder: 'Add something to remember' });
    b.append(el('div', { class: 'card', style: { padding: '4px 14px 12px', marginTop: '14px' } }, field('New memory', inp),
      el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'Add', onclick: () => { if (inp.value.trim()) { H.memory.add(inp.value, 'you'); redraw(); } } }),
        list.length ? el('button', { class: 'btn ghost', text: 'Delete all', onclick: () => { if (confirm('Delete all memory?')) { H.memory.save([]); redraw(); } } }) : null)));
  });

  SECTIONS.knowledge = () => screen('Knowledge', (b) => {
    const ta = el('textarea', { style: { minHeight: '50vh' } }); ta.value = H.settings.knowledge || '';
    b.append(el('div', { class: 'note', text: 'Background Hark imported about you. It is added to every chat. Edit freely; a new import replaces it.' }), field('Background', ta),
      el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'Save', onclick: () => { H.settings.knowledge = ta.value; H.saveSettings(); H.toast('Saved'); } }),
        el('button', { class: 'btn ghost', text: 'Clear', onclick: () => { ta.value = ''; H.settings.knowledge = ''; H.saveSettings(); } })));
  });

  // ---------------- scheduled tasks ----------------
  function taskPayload(t) {
    let full = t.model || H.settings.model;
    // Native scheduled tasks call one provider directly: Auto (Long chats) sends the model Auto would use right now.
    if (H.isAuto && H.isAuto(full)) full = (H.autoLongCurrent && H.autoLongCurrent()) || H.DEFAULT_MODEL;
    const info = H.modelInfo(full); const P = H.PROVIDERS[info.provider];
    return {
      id: t.id, name: t.name, prompt: t.prompt, hour: t.hour, minute: t.minute, tz: 'Asia/Kolkata', base: P.base, model: info.id,
      keyIds: info.provider === 'custom' ? [] : H.vault.byProvider(info.provider).map((k) => k.id), headers: P.headers || {},
      openalgo: (t.accounts || []).map((id) => H.settings.openalgo.find((a) => a.id === id)).filter(Boolean).map((a) => { const k = H.vault.byProvider(a.provider)[0]; return k ? { name: a.name, base: a.base, keyId: k.id } : null; }).filter(Boolean),
    };
  }
  SECTIONS.tasks = () => screen('Scheduled tasks', (b, redraw) => {
    if (!N) b.append(el('div', { class: 'note', text: 'Scheduled tasks run in the Android app (WorkManager) and notify you. They are not available in the browser.' }));
    b.append(el('div', { class: 'note', text: 'Each task runs daily at its time (IST), even when the app is closed, and posts a notification. Tasks only read data; they never place orders.' }));
    (H.settings.tasks || []).forEach((t) => {
      b.append(el('div', { class: 'card', style: { marginTop: '10px' } }, row(icon.clock, t.name, String(t.hour).padStart(2, '0') + ':' + String(t.minute).padStart(2, '0') + ' IST daily · ' + H.modelLabel(t.model || H.settings.model) + (t.accounts && t.accounts.length ? ' · with ' + t.accounts.join(', ') : ''), null,
        el('span', { style: { display: 'flex' } },
          el('button', { class: 'mini', text: 'Run now', onclick: () => { if (N) { N.runTaskNow(JSON.stringify(taskPayload(t))); H.toast('Running — you\'ll get a notification'); } } }),
          el('button', { class: 'iconbtn', html: icon.edit, onclick: () => editTask(t, redraw) }),
          el('button', { class: 'iconbtn', html: icon.trash, onclick: () => { if (N) N.cancelTask(t.id); H.settings.tasks = H.settings.tasks.filter((x) => x !== t); H.saveSettings(); redraw(); } })))));
    });
    b.append(el('div', { class: 'btns' }, el('button', { class: 'btn', text: 'New task', onclick: () => editTask(null, redraw) }),
      !(H.settings.tasks || []).some((t) => /market brief/i.test(t.name)) ? el('button', { class: 'btn ghost', text: 'Add morning market brief', onclick: () => {
        const t = { id: H.newId('t'), name: 'Morning market brief', prompt: 'Give me a short pre-market brief for Indian markets today: key global cues, anything notable for Nifty/Bank Nifty, and a one-line summary of my accounts if data is attached. Under 150 words.', hour: 8, minute: 45, accounts: H.oaAccounts().map((a) => a.id) };
        saveTask(t); redraw();
      } }) : null));
    if (N) {
      let res = []; try { res = JSON.parse(N.taskResults()); } catch (_) {}
      if (res.length) b.append(sec('Recent results'), el('div', { class: 'card' }, res.slice(0, 10).map((r) => row(null, r.name + ' · ' + new Date(r.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), r.text.slice(0, 300), () => H.showTaskResult(r)))));
    }
  });
  // 1.1.9: tasks scheduled with a paid or old default model are re-registered once with their free model.
  setTimeout(() => {
    try {
      if (!N || H.settings.tasks119 || !(H.settings.tasks || []).length) return;
      H.settings.tasks.forEach((t) => { try { N.scheduleTask(JSON.stringify(taskPayload(t))); } catch (_) {} });
      H.settings.tasks119 = true; H.saveSettings();
    } catch (_) {}
  }, 1500);
  function saveTask(t) {
    H.settings.tasks = H.settings.tasks || [];
    if (!H.settings.tasks.includes(t)) H.settings.tasks.push(t);
    H.saveSettings();
    if (N) { N.requestNotifications(); const ok = N.scheduleTask(JSON.stringify(taskPayload(t))); H.toast(ok ? 'Scheduled' : 'Couldn’t schedule'); }
  }
  function editTask(t, done) {
    H.ui.sheet(t ? 'Edit task' : 'New task', (b, close) => {
      const name = el('input', { value: t ? t.name : '', placeholder: 'e.g. Evening P&L summary' });
      const prompt = el('textarea', { placeholder: 'What should Hark do?' }); prompt.value = t ? t.prompt : '';
      const time = el('input', { type: 'time', value: t ? String(t.hour).padStart(2, '0') + ':' + String(t.minute).padStart(2, '0') : '08:45' });
      const accBoxes = H.oaAccounts().map((a) => { const c = el('input', { type: 'checkbox', value: a.id }); c.checked = t ? (t.accounts || []).includes(a.id) : false; return el('label', { class: 'row', style: { border: 0, padding: '6px 0' } }, el('span', { class: 't', text: 'Attach ' + a.name + ' funds & positions (read-only)' }), el('span', { class: 'switch' }, c, el('i'))); });
      b.append(el('div', { style: { padding: '0 8px' } }, field('Name', name), field('Prompt', prompt), field('Time (IST, daily)', time), accBoxes,
        el('div', { class: 'note', text: 'Uses your current default model: ' + H.modelLabel(H.settings.model) }),
        el('button', { class: 'btn block', text: 'Save', onclick: () => {
          if (!prompt.value.trim()) return H.toast('Add a prompt');
          const [hh, mm] = (time.value || '08:45').split(':').map(Number);
          const nt = t || { id: H.newId('t') };
          Object.assign(nt, { name: name.value.trim() || 'Hark task', prompt: prompt.value.trim(), hour: hh, minute: mm, model: H.settings.model, accounts: accBoxes.map((l) => l.querySelector('input')).filter((c) => c.checked).map((c) => c.value) });
          saveTask(nt); close(); done();
        } })));
    });
  }

  // ---------------- voice ----------------
  SECTIONS.voice = () => screen('Voice', (b) => {
    const rate = el('input', { type: 'range', min: 0.6, max: 1.6, step: 0.1, value: H.settings.voice.rate, onchange: (e) => { H.settings.voice.rate = +e.target.value; H.saveSettings(); } });
    const lang = el('select', { onchange: (e) => { H.settings.voice.lang = e.target.value; H.saveSettings(); } }, [['en-IN', 'English (India)'], ['hi-IN', 'Hindi'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)']].map(([v, t]) => el('option', { value: v, text: t, selected: H.settings.voice.lang === v })));
    b.append(el('div', { class: 'card' }, row(icon.speak, 'Read replies aloud', 'Speak every answer automatically', null, toggle(H.settings.voice.autoSpeak, (v) => { H.settings.voice.autoSpeak = v; H.saveSettings(); }))),
      el('div', { class: 'card', style: { padding: '4px 14px 12px', marginTop: '12px' } }, field('Speaking rate', rate), field('Language for speech', lang),
        el('button', { class: 'btn ghost', text: 'Test voice', onclick: () => H.ui.speak('Hi ' + H.settings.name + ', this is how I sound.') })),
      el('div', { class: 'note', text: 'Voice uses Android’s own speech recognition and text-to-speech. Voice mode (the waveform button) is a hands-free back-and-forth conversation.' }));
  });

  // ---------------- widgets ----------------
  SECTIONS.widgets = () => screen('Home screen widgets', (b) => {
    const sel = el('select', { onchange: (e) => {
      H.settings.widgetSource = e.target.value; H.saveSettings();
      const a = H.settings.openalgo.find((x) => x.id === e.target.value); const k = a && H.vault.byProvider(a.provider)[0];
      if (N && a && k) { N.setPnlSource(JSON.stringify({ name: a.name, base: a.base, keyId: k.id })); H.toast('P&L widget will refresh every 30 min'); }
    } }, [el('option', { value: '', text: 'None' })].concat(H.settings.openalgo.map((a) => el('option', { value: a.id, text: a.name, selected: H.settings.widgetSource === a.id }))));
    b.append(el('div', { class: 'note', text: 'Long-press your home screen → Widgets → Shoeb AI. “Quick ask” opens a new chat or voice mode; “P&L” shows today’s realised + open P&L for the account you pick (read-only).' }),
      el('div', { class: 'card', style: { padding: '4px 14px 12px' } }, field('P&L widget account', sel)));
  });

  SECTIONS.safety = () => screen('Safety', (b, redraw) => {
    const ssh = H.ssh;
    const native = !!(ssh && ssh.nativePolicy && ssh.nativePolicy());
    const pol = native ? ssh.policy() : { askChanges: false };
    const st = el('div', { class: 'note' });
    b.append(sec('SSH commands'), el('div', { class: 'card' },
      row(icon.check || icon.shield, 'Commands run directly', 'Every SSH command from the chat or the Run screen runs at once, including ones that change things. Output shows in a collapsible card in the chat.', null),
      row(icon.shield, 'Ask before SSH commands that change things', native ? (pol.askChanges ? 'On — a Run/Cancel card in the chat for anything that isn’t read-only' : 'Off — every command runs directly (default)') : 'Needs Shoeb AI 1.1.6 or newer', null,
        native ? toggle(pol.askChanges, async (v, inp) => {
          try { const r = await ssh.setAskChanges(v); inp.checked = !!r.askChanges; if (!!r.askChanges !== !!v) st.textContent = 'Not changed.'; else redraw(); }
          catch (e) { inp.checked = !v; st.textContent = e.message; }
        }) : null)),
      st,
      el('div', { class: 'note', text: 'With this off nothing asks — not even rm -rf /, reboot/shutdown, openalgo containers or ~/openalgo-tradesmart and ~/wisdom. A command that changes things is never re-run automatically if the connection drops. No fingerprint/PIN anywhere in the app.' }));
    // What the AI sends or runs from the chat goes out at once. Each switch (all off by default) brings back a confirmation.
    const sf = H.settings.safety || (H.settings.safety = {});
    const ask = (k, icn, title, onText, offText) => row(icn, title, sf[k] ? onText : offText, null,
      toggle(sf[k], (v) => { sf[k] = !!v; H.saveSettings(); redraw(); }));
    b.append(sec('What the AI sends or runs'), el('div', { class: 'card' },
      ask('askTrades', icon.chart, 'Ask before orders', 'On — orders, cancels, closes and the analyzer toggle open a LIVE/PAPER ticket you tap', 'Off — the AI’s orders go to the broker at once (default)'),
      ask('askCloud', icon.globe, 'Ask before Oracle Cloud actions', 'On — start/stop/reboot/terminate open a ticket (terminate needs the name typed)', 'Off — run at once, terminate included (default)'),
      ask('askTools', icon.plug || icon.shield, 'Ask before MCP / runner write tools', 'On — a ticket before each write tool', 'Off — run at once (default)'),
      ask('askEmail', icon.mail || icon.shield, 'Ask before sending email', 'On — a Send/Cancel card in the chat', 'Off — emails go out at once (default)')),
      el('div', { class: 'note', text: 'Wisdom orders are still refused unless its analyzer (paper) mode is on. Buttons you press yourself on the Trade desk and Oracle Cloud screens keep their ticket.' }));
  });

  // ---------------- Hermes trade approval pop-ups (app 1.1.10+) ----------------
  const hasApprovals = () => !!(N && typeof N.approvalsStatus === 'function');
  const apStatus = () => { try { return JSON.parse(N.approvalsStatus()); } catch (_) { return {}; } };
  const istTime = (ms) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  function approvalsRow() {
    if (!hasApprovals()) return row(icon.chart, 'Trade approval pop-ups', 'Needs Shoeb AI 1.1.10 or newer (updates itself)', null);
    const st = apStatus();
    const sub = (st.enabled === false ? 'Off' : (st.running ? 'Watching now' : 'On · next ' + istTime(st.nextOpen) + ' IST')) + ' · server ' + (st.server || 'hark-a1 not set up');
    return row(icon.chart, 'Trade approval pop-ups', sub, SECTIONS.approvals, toggle(st.enabled !== false, (v) => { N.approvalsSet(JSON.stringify({ enabled: !!v })); }));
  }
  SECTIONS.approvals = () => screen('Trade approval pop-ups', (b, redraw) => {
    if (!hasApprovals()) { b.append(el('div', { class: 'note', text: 'Needs Shoeb AI 1.1.10 or newer. The app updates itself from GitHub.' })); return; }
    const st = apStatus();
    const out = el('div', { class: 'note' });
    const fix = (what) => () => { N.approvalsFix(what); setTimeout(redraw, 1500); };
    const yes = (v, okText, badText) => v ? okText : badText;
    b.append(el('div', { class: 'card' },
      row(icon.chart, 'Trade approval pop-ups', 'Pops up each Hermes LIVE buy (✅ Buy / ⏭ Skip) and sell suggestion (🔴 Sell / ✋ Hold) with a chart, Mon–Fri 09:15–15:30 IST', null,
        toggle(st.enabled !== false, (v) => { N.approvalsSet(JSON.stringify({ enabled: !!v })); setTimeout(redraw, 300); })),
      row(icon.globe, 'Server', (st.server || 'hark-a1 isn’t set up — add it under Keys › SSH keys & servers') + ' · admin SSH key from the vault', null),
      row(icon.clock, 'Status', st.enabled === false ? 'Off' : st.running ? 'Watching now (every 15 s)' + (st.lastPoll ? ' · last check ' + new Date(st.lastPoll).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : '') + (st.lastError ? ' · last error: ' + st.lastError : '') : 'Starts ' + istTime(st.nextOpen) + ' IST', null),
      typeof N.approvalsPositions === 'function' ? row(icon.chart, 'Hermes positions · Sell now', 'Open Hermes positions with a chart and a 🔴 Sell tap (app 1.1.11+)', () => N.approvalsPositions()) : null,
      row(icon.retry, 'Check hark-a1 now', 'Reads the pending list once (nothing is approved)', async () => {
        out.textContent = 'Checking hark-a1…';
        try { const r = await H.nativeCall('approvalsCheck'); out.textContent = r.pending ? r.pending + ' waiting: ' + r.symbols.join(', ') : 'Connected · nothing waiting'; }
        catch (e) { out.textContent = 'Couldn’t check: ' + e.message; }
      })),
      out,
      sec('So it pops up on time'),
      el('div', { class: 'card' },
        row(icon.shield, 'Notifications', yes(st.notifications, 'Allowed', 'Not allowed — tap to allow'), fix('notifications')),
        row(icon.shield, 'Full-screen pop-up', yes(st.fullScreen, 'Allowed (shows over the lock screen)', 'Not allowed — tap; without it you get a heads-up banner'), fix('fullscreen')),
        row(icon.clock, 'Start at 09:15 by itself', yes(st.exactAlarm, 'Alarms & reminders allowed', 'Tap to allow Alarms & reminders'), fix('exact')),
        row(icon.shield, 'Battery: unrestricted', yes(st.battery, 'Yes', 'Tap so Android doesn’t pause the watcher'), fix('battery')),
        row(icon.speak, 'Sound & vibration', 'Android settings for the “Trade approvals” channel', fix('channel'))),
      el('div', { class: 'note', text: 'Each pop-up shows a 5-minute candlestick chart with the buy/entry, stop-loss and target lines, plus the account, quantity, prices, reason and a countdown. Buy/Sell or Skip/Hold runs on hark-a1 straight away (no fingerprint) and the pop-up changes to the server’s answer. Requests expire after 5 minutes; answering twice is safe. A small “Watching for Hermes trades” notification stays while it runs and goes away at 15:30.' }));
  });

  SECTIONS.security = () => screen('Security & privacy', (b) => {
    b.append(el('div', { class: 'content', style: { lineHeight: 1.6, fontSize: '15px' }, html: DOMPurify.sanitize(marked.parse([
      '**Keys** live in an encrypted vault backed by Android Keystore. The web code that draws this app only handles placeholders; the phone inserts a key only into requests to the address that key was saved for, and blanks it out of any response.',
      '**Moving a key** to a new address (for example a new ngrok URL) needs your OK in a native Android dialog.',
      '**Trading**: the AI can send any action (place, smart, basket, split, modify, cancel, cancel all, close all, analyzer toggle) to TradeSmart (LIVE) or Wisdom (PAPER). From 1.1.8 it goes out at once, with no confirmation; Settings › Safety › Ask before orders brings back the tap ticket. Wisdom orders are refused unless analyzer (paper) mode is on.',
      '**Servers**: SSH keys, the Oracle Cloud key and runner tokens stay inside the app. Host keys are pinned. Loopback services on your VM are reached through SSH tunnels; no port is opened. SSH commands, VM start/stop/reboot/terminate and emails the AI sends run at once (Settings › Safety has a switch for each to bring back a confirmation). No fingerprint/PIN anywhere.',
      '**Chats** are stored on this phone (app storage). **Memory** is encrypted on this phone. Nothing is sent anywhere except to the model provider you chose and the tools you enabled.',
      '**Updates**: the app loads its interface from GitHub Pages, so improvements arrive without reinstalling. Keys are never part of the app or the repositories.',
    ].join('\n\n'))) }));
  });

  // ---------------- about ----------------
  SECTIONS.about = () => screen('About & updates', (b) => {
    const out = el('div', { class: 'note' });
    b.append(el('div', { class: 'card' },
      row(icon.info, 'Shoeb AI', 'Web build ' + H.version + (N ? ' · Android app ' + N.version() + ' (' + N.platform() + ')' : ' · browser')),
      row(icon.retry, 'Reload latest interface', 'Fetches the newest web build', () => { if (N) N.reload(); else location.reload(); }),
      H.nativeUpdater ? null : row(icon.download, 'Check for a new app version', 'Downloads the newest APK', async () => { out.textContent = 'Checking…'; out.textContent = await H.checkApkUpdate(true); })),
      out,
      H.nativeUpdater ? updaterCard(out) : null,
      el('div', { class: 'note', text: 'Original design and code. The app’s interface follows common chat-app patterns; no third-party proprietary code or assets are included.' }));
  });

  // Native self-updater (app 1.1.5+): checks GitHub on launch, on return to the app and hourly; installs at once.
  H.nativeUpdater = !!(N && typeof N.updateStatus === 'function');
  function updaterCard(out) {
    let st = {}; try { st = JSON.parse(N.updateStatus()); } catch (_) {}
    const when = st.lastCheck ? new Date(st.lastCheck).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'not yet';
    const mode = st.silent ? 'Installs silently (Android 12+, Shoeb AI is its own installer)' : 'Opens the Android install prompt as soon as an update is downloaded';
    const set = (k, v) => { const o = {}; o[k] = v; N.updateSetPrefs(JSON.stringify(o)); };
    return el('div', {},
      sec('App updates from GitHub'),
      el('div', { class: 'card' },
        row(icon.download, 'Check for updates', 'Last check ' + when + (st.latest ? ' · latest ' + st.latest : '') + (st.message ? ' · ' + st.message : ''), async () => {
          out.textContent = 'Checking GitHub…';
          try { const r = await H.nativeCall('updateCheck'); out.textContent = r.message; } catch (e) { out.textContent = 'Couldn’t check: ' + e.message; }
        }),
        row(icon.retry, 'Auto-update', 'Check on launch, on return and every hour; install immediately', null, toggle(st.auto !== false, (v) => set('auto', v))),
        row(icon.globe, 'Wi-Fi only', 'Only download updates on Wi-Fi', null, toggle(!!st.wifiOnly, (v) => set('wifiOnly', v)))),
      el('div', { class: 'note', text: mode + '. Every APK is checked against the SHA-256 in apk.json and must be signed with the same key as the installed app, or it is refused.' }));
  }

  H.checkApkUpdate = async function (manual) {
    if (H.nativeUpdater && !manual) return '';
    try {
      let j = null;
      try { const a = await fetch('apk.json?t=' + Date.now(), { cache: 'no-store' }); if (a.status === 200) { const x = await a.json(); j = { tag_name: x.version, assets: [{ name: 'HarkAI.apk', browser_download_url: new URL(x.url || 'HarkAI.apk', location.href).href }] }; } } catch (_) {}
      if (!j) {
        const r = await fetch('https://api.github.com/repos/' + PUBLIC_REPO + '/releases/latest', { cache: 'no-store' });
        if (r.status !== 200) return 'No releases found';
        j = await r.json();
      }
      const latest = (j.tag_name || '').replace(/^v/, '');
      const cur = N ? N.version() : null;
      const newer = cur && latest && latest.split('.').map(Number).some((x, i, a) => { const c = cur.split('.').map(Number); for (let k = 0; k < a.length; k++) { if ((a[k] || 0) !== (c[k] || 0)) return (a[k] || 0) > (c[k] || 0); } return false; });
      const asset = (j.assets || []).find((a) => /\.apk$/.test(a.name));
      if (newer && asset) {
        if (manual) H.openExternal(asset.browser_download_url);
        else if (localStorage.getItem('hark.apknote') !== latest) { localStorage.setItem('hark.apknote', latest); H.toast('Shoeb AI ' + latest + ' is out — Settings › Check for a new app version', 5000); }
        return 'Version ' + latest + ' available';
      }
      return 'You’re up to date (' + (cur || 'browser') + '; latest ' + (latest || '?') + ')';
    } catch (e) { return manual ? 'Couldn’t check: ' + e.message : ''; }
  };

  H.showTaskResult = function (r) {
    H.ui.modal(r.name, H.esc(r.text).replace(/\n/g, '<br>'), [['Close', false, 'ghost'], ['Continue in chat', true]]).then((go) => {
      if (!go) return;
      // 1.1.14: add it to the chat on screen instead of opening a new one.
      if (!H.state.chat.title) H.state.chat.title = r.name;
      H.state.chat.messages.push({ id: H.newId('m'), role: 'assistant', content: '**' + r.name + '**\n\n' + r.text, ts: r.at });
      H.ui.renderThread(); H.chats.put(H.state.chat).catch(() => {});
    });
  };

  H.settingsUI = { open, SECTIONS };
})();
