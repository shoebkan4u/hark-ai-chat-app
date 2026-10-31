/* Hark AI — tools: web search, fetch, memory, OpenAlgo (read + confirmed order ticket), MCP servers. */
(function () {
  'use strict';
  const H = window.Hark;
  const PH = H.vault.PH;
  const MAX_TOOL_CHARS = 14000;
  const clip = (s, n) => { s = typeof s === 'string' ? s : JSON.stringify(s); n = n || MAX_TOOL_CHARS; return s.length > n ? s.slice(0, n) + '\n…[truncated ' + (s.length - n) + ' chars]' : s; };

  // ---------------- web search ----------------
  async function geminiSearch(query) {
    const k = H.vault.byProvider('gemini')[0];
    if (!k) return null;
    const model = H.settings.searchModel || 'gemini-flash-latest';
    const r = await H.net.request({
      url: 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': PH(k.id) },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Search the web and answer with facts, figures and dates. Query: ' + query }] }], tools: [{ google_search: {} }] }),
    });
    if (r.status !== 200) throw new Error('Gemini search HTTP ' + r.status);
    const j = r.json(); const c = (j.candidates || [])[0] || {};
    const text = ((c.content && c.content.parts) || []).map((p) => p.text || '').join('');
    const gm = c.groundingMetadata || {};
    const sources = (gm.groundingChunks || []).filter((x) => x.web).map((x) => ({ title: x.web.title || x.web.uri, url: x.web.uri }));
    return { engine: 'Google Search via Gemini', summary: text, sources };
  }
  async function ddgSearch(query) {
    const r = await H.net.request({
      url: 'https://html.duckduckgo.com/html/', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) HarkAI' },
      body: 'q=' + encodeURIComponent(query) + '&kl=in-en',
    });
    if (r.status !== 200) throw new Error('search HTTP ' + r.status);
    const doc = new DOMParser().parseFromString(r.text, 'text/html');
    const out = [];
    doc.querySelectorAll('.result').forEach((el) => {
      const a = el.querySelector('a.result__a'); if (!a) return;
      let href = a.getAttribute('href') || '';
      const m = /[?&]uddg=([^&]+)/.exec(href); if (m) href = decodeURIComponent(m[1]);
      if (href.startsWith('//')) href = 'https:' + href;
      if (/duckduckgo\.com\/y\.js/.test(href)) return; // ads
      const sn = el.querySelector('.result__snippet');
      out.push({ title: a.textContent.trim(), url: href, snippet: sn ? sn.textContent.trim() : '' });
    });
    return { engine: 'DuckDuckGo', results: out.slice(0, 8), sources: out.slice(0, 8).map((x) => ({ title: x.title, url: x.url })) };
  }
  async function wikiSearch(query) {
    const r = await H.net.request({ url: 'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=6&srsearch=' + encodeURIComponent(query) });
    const j = r.json();
    const res = (j.query.search || []).map((s) => ({ title: s.title, url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(s.title.replace(/ /g, '_')), snippet: s.snippet.replace(/<[^>]+>/g, '') }));
    return { engine: 'Wikipedia', results: res, sources: res.map((x) => ({ title: x.title, url: x.url })) };
  }
  H.webSearch = async function (query) {
    const errs = [];
    for (const f of [geminiSearch, ddgSearch, wikiSearch]) {
      try { const r = await f(query); if (r && ((r.results && r.results.length) || r.summary)) return r; } catch (e) { errs.push(e.message); }
    }
    throw new Error('Search failed: ' + errs.join('; '));
  };

  async function fetchUrl(url) {
    const r = await H.net.request({ url, headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) HarkAI', Accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5' } });
    let t = r.text || '';
    if (/<html|<body|<div/i.test(t)) {
      const doc = new DOMParser().parseFromString(t, 'text/html');
      doc.querySelectorAll('script,style,noscript,svg,nav,footer,header,iframe,form').forEach((e) => e.remove());
      const title = doc.title;
      t = (title ? '# ' + title + '\n\n' : '') + (doc.body ? doc.body.innerText || doc.body.textContent : '').replace(/\n\s*\n\s*\n+/g, '\n\n');
    }
    return { status: r.status, url, text: clip(t, 20000) };
  }

  // ---------------- OpenAlgo ----------------
  const OA_READ = {
    funds: 'funds', positions: 'positionbook', holdings: 'holdings', orderbook: 'orderbook', tradebook: 'tradebook',
    quote: 'quotes', history: 'history', depth: 'depth', analyzer_status: 'analyzer', ping: 'ping', pnl: null, open_position: 'openposition',
  };
  H.oaAccounts = () => H.settings.openalgo.filter((a) => H.vault.byProvider(a.provider).length);
  function oaKey(acc) { const k = H.vault.byProvider(acc.provider)[0]; if (!k) throw new Error('No API key for ' + acc.name + ' in the vault'); return k; }
  async function oaCall(acc, endpoint, extra) {
    const k = oaKey(acc);
    const url = acc.base.replace(/\/+$/, '') + '/api/v1/' + endpoint;
    const host = new URL(url).host;
    if (k.host && k.host !== host) {
      const ok = await H.vault.setHost(k.id, host);
      if (!ok) throw new Error('The ' + acc.name + ' key is saved for ' + k.host + '. Address change not allowed.');
    }
    const body = Object.assign({ apikey: PH(k.id) }, extra || {});
    const r = await H.net.request({ url, method: 'POST', headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' }, body: JSON.stringify(body), timeout: 45000 });
    let j; try { j = r.json(); } catch (_) { throw new Error(acc.name + ' HTTP ' + r.status + ': ' + r.text.slice(0, 160)); }
    if (r.status >= 400 || j.status === 'error') throw new Error(acc.name + ': ' + (j.message || 'HTTP ' + r.status));
    return j;
  }
  H.oaCall = oaCall;
  const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  async function oaRead(args) {
    const acc = H.settings.openalgo.find((a) => a.id === args.account);
    if (!acc) throw new Error('Unknown account ' + args.account);
    if (args.action === 'pnl') {
      const [f, p] = await Promise.all([oaCall(acc, 'funds'), oaCall(acc, 'positionbook').catch(() => ({ data: [] }))]);
      const pos = Array.isArray(p.data) ? p.data : [];
      const realized = num(f.data && f.data.m2mrealized), unrealized = num(f.data && f.data.m2munrealized);
      const out = { account: acc.name, mode: acc.mode, realized, unrealized, total: realized + unrealized, open_positions: pos.filter((x) => num(x.quantity) !== 0).length, positions: pos.map((x) => ({ symbol: x.symbol, exchange: x.exchange, product: x.product, quantity: x.quantity, average_price: x.average_price, ltp: x.ltp, pnl: x.pnl })) };
      if (H.native && window.HarkNative.setWidgetData && H.settings.widgetSource === acc.id) {
        const fmt = (n) => (n >= 0 ? '+' : '−') + '₹' + Math.abs(Math.round(n)).toLocaleString('en-IN');
        window.HarkNative.setWidgetData(JSON.stringify({ title: acc.name + ' · today', value: fmt(out.total), sub: 'Realised ' + fmt(realized) + ' · Open ' + fmt(unrealized) }));
      }
      return out;
    }
    const ep = OA_READ[args.action];
    if (!ep) throw new Error('Unsupported action ' + args.action);
    const extra = {};
    if (['quote', 'history', 'depth', 'open_position'].includes(args.action)) {
      if (!args.symbol || !args.exchange) throw new Error('symbol and exchange are required');
      extra.symbol = String(args.symbol).toUpperCase(); extra.exchange = String(args.exchange).toUpperCase();
    }
    if (args.action === 'open_position') { extra.product = args.product || 'MIS'; extra.strategy = 'HarkAI'; }
    if (args.action === 'history') {
      extra.interval = args.interval || 'D';
      const today = new Date().toISOString().slice(0, 10);
      extra.start_date = args.start_date || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      extra.end_date = args.end_date || today;
    }
    const j = await oaCall(acc, ep, extra);
    return { account: acc.name, mode: acc.mode, action: args.action, data: j.data !== undefined ? j.data : j };
  }

  async function oaPlaceOrder(args, ctx) {
    const acc = H.settings.openalgo.find((a) => a.id === args.account);
    if (!acc) throw new Error('Unknown account');
    if (!acc.orderTickets) return { status: 'blocked', message: 'Order tickets are switched off for ' + acc.name + ' in Settings → Brokers.' };
    const order = {
      symbol: String(args.symbol || '').toUpperCase(), exchange: String(args.exchange || 'NSE').toUpperCase(),
      action: String(args.action || '').toUpperCase(), quantity: String(parseInt(args.quantity, 10) || 0),
      product: String(args.product || 'MIS').toUpperCase(), pricetype: String(args.pricetype || 'MARKET').toUpperCase(),
      price: String(args.price || 0), trigger_price: String(args.trigger_price || 0),
    };
    if (!order.symbol || !['BUY', 'SELL'].includes(order.action) || !(+order.quantity > 0)) throw new Error('Order needs symbol, BUY/SELL and a positive quantity');
    if (acc.id === 'wisdom' || acc.mode !== 'LIVE') {
      // Wisdom must stay paper: refuse unless the analyzer (paper) mode is on.
      const a = await oaCall(acc, 'analyzer').catch(() => null);
      const on = a && a.data && (a.data.analyze_mode === true || a.data.mode === 'analyze');
      if (!on) return { status: 'blocked', message: acc.name + ' is not in analyzer (paper) mode, so Hark will not send this order.' };
    }
    const ok = await H.ui.confirmOrder(order, acc);
    if (!ok) return { status: 'declined', message: 'The user did not confirm. No order was sent.' };
    const j = await oaCall(acc, 'placeorder', Object.assign({ strategy: 'HarkAI' }, order));
    H.toast(acc.name + ': order sent' + (j.orderid ? ' · ' + j.orderid : ''));
    return { status: 'placed_after_user_confirmation', account: acc.name, mode: acc.mode, orderid: j.orderid, response: j };
  }

  // ---------------- MCP ----------------
  const mcpClients = {};
  const mcpTools = {}; // serverId -> tools
  function mcpServer(id) { return H.settings.mcpServers.find((s) => s.id === id); }
  H.mcp = {
    clients: mcpClients, tools: mcpTools,
    async connect(id) {
      const s = mcpServer(id);
      if (s.expiresAt && s.refreshRef && s.expiresAt < Date.now() + 60e3) { try { await this.refresh(s); } catch (_) {} }
      const c = new window.HarkMCP.McpClient(s);
      if (s.sessionId) c.sessionId = s.sessionId;
      try {
        mcpTools[id] = await c.connect();
      } catch (e) {
        if (e.auth && s.refreshRef) { await this.refresh(s); return this.connect(id); }
        if (e.auth) { s.wwwAuth = e.wwwAuth; s.needsAuth = true; H.saveSettings(); }
        throw e;
      }
      mcpClients[id] = c; s.sessionId = c.sessionId; s.needsAuth = false; s.toolCount = mcpTools[id].length; s.lastOk = Date.now(); H.saveSettings();
      return mcpTools[id];
    },
    async signIn(id) {
      const s = mcpServer(id);
      const r = await window.HarkMCP.startOAuth(s);
      s.clientId = r.clientId; s.tokenEndpoint = r.tokenEndpoint; H.saveSettings();
    },
    async finish(url) {
      const r = await window.HarkMCP.finishOAuth(url);
      const s = mcpServer(r.serverId); if (!s) return;
      Object.assign(s, { tokenRef: r.tokenRef, refreshRef: r.refreshRef || s.refreshRef, expiresAt: r.expiresAt || 0, clientId: r.clientId, tokenEndpoint: r.tokenEndpoint, enabled: true, needsAuth: false, sessionId: null });
      H.saveSettings();
      await this.connect(s.id).catch(() => {});
      return s;
    },
    async refresh(s) {
      const r = await window.HarkMCP.refreshOAuth(s);
      Object.assign(s, { tokenRef: r.tokenRef, refreshRef: r.refreshRef || s.refreshRef, expiresAt: r.expiresAt || 0 }); H.saveSettings();
    },
  };
  const toolName = (sid, name) => ('mcp_' + sid + '__' + name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

  // ---------------- tool registry ----------------
  H.buildTools = async function () {
    const t = H.settings.tools; const defs = []; const run = {};
    const add = (name, description, parameters, fn, meta) => { defs.push({ type: 'function', function: { name, description, parameters } }); run[name] = Object.assign({ fn }, meta || {}); };
    if (t.web) {
      add('web_search', 'Search the web for current information. Use for news, prices, facts after your training data, or anything you are unsure of. Cite sources.', { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, (a) => H.webSearch(a.query), { label: 'Searching the web', sum: (a) => a.query });
      add('fetch_url', 'Fetch a web page and return its readable text.', { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, (a) => fetchUrl(a.url), { label: 'Reading', sum: (a) => a.url });
    }
    if (t.memory) {
      add('memory_save', 'Save a durable fact or preference about the user to on-device memory (only when the user shares something worth remembering or asks you to remember).', { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] }, (a) => { const m = H.memory.add(a.fact, 'assistant'); return m ? { saved: true } : { saved: false, reason: 'duplicate or empty' }; }, { label: 'Saving to memory', sum: (a) => a.fact });
    }
    const accs = t.openalgo ? H.oaAccounts() : [];
    if (accs.length) {
      add('openalgo_read', 'Read-only broker data via OpenAlgo. Accounts: ' + accs.map((a) => a.id + ' (' + a.name + ', ' + (a.mode === 'LIVE' ? 'LIVE money' : 'paper/analyzer') + ')').join(', ') + '. Actions: funds, positions, holdings, orderbook, tradebook, pnl (today realised + unrealised), quote, history (OHLC; interval 1m/5m/15m/1h/D), depth, analyzer_status, ping, open_position. Symbols use OpenAlgo format, e.g. RELIANCE on NSE, NIFTY28NOV2524000CE on NFO.',
        { type: 'object', properties: { account: { type: 'string', enum: accs.map((a) => a.id) }, action: { type: 'string', enum: Object.keys(OA_READ) }, symbol: { type: 'string' }, exchange: { type: 'string', enum: ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'NSE_INDEX', 'BSE_INDEX'] }, interval: { type: 'string' }, start_date: { type: 'string', description: 'YYYY-MM-DD' }, end_date: { type: 'string', description: 'YYYY-MM-DD' }, product: { type: 'string' } }, required: ['account', 'action'] },
        oaRead, { label: 'Checking broker', sum: (a) => a.account + ' · ' + a.action + (a.symbol ? ' ' + a.symbol : '') });
      const orderAccs = accs.filter((a) => a.orderTickets);
      if (orderAccs.length) {
        add('openalgo_place_order', 'Prepare an order ticket. This does NOT place the order by itself: Hark shows the user a full-screen confirmation, and the order is sent only if the user taps confirm. Only use when the user explicitly asks to place an order. Never retry a declined order.',
          { type: 'object', properties: { account: { type: 'string', enum: orderAccs.map((a) => a.id) }, symbol: { type: 'string' }, exchange: { type: 'string' }, action: { type: 'string', enum: ['BUY', 'SELL'] }, quantity: { type: 'integer' }, product: { type: 'string', enum: ['MIS', 'CNC', 'NRML'] }, pricetype: { type: 'string', enum: ['MARKET', 'LIMIT', 'SL', 'SL-M'] }, price: { type: 'number' }, trigger_price: { type: 'number' } }, required: ['account', 'symbol', 'exchange', 'action', 'quantity', 'product', 'pricetype'] },
          oaPlaceOrder, { label: 'Order ticket', sum: (a) => a.action + ' ' + a.quantity + ' ' + a.symbol, write: true });
      }
    }
    if (t.mcp) {
      for (const s of H.settings.mcpServers.filter((x) => x.enabled)) {
        let tools = mcpTools[s.id];
        if (!tools) { try { tools = await H.mcp.connect(s.id); } catch (_) { continue; } }
        for (const tool of tools) {
          if (tool._write && s.readOnly) continue;
          const name = toolName(s.id, tool.name);
          const params = tool.inputSchema && tool.inputSchema.type ? tool.inputSchema : { type: 'object', properties: {} };
          add(name, '[' + s.name + '] ' + (tool.description || tool.title || tool.name).slice(0, 900) + (tool._write ? ' (needs the user\'s on-screen confirmation)' : ''), params, async (a) => {
            if (tool._write) {
              const ok = await H.ui.confirmAction({ title: s.name + ': ' + (tool.title || tool.name), server: s, tool, args: a });
              if (!ok) return { status: 'declined', message: 'The user did not confirm.' };
            }
            const c = mcpClients[s.id] || (await H.mcp.connect(s.id), mcpClients[s.id]);
            let r;
            try { r = await c.call(tool.name, a); }
            catch (e) { if (e.auth && s.refreshRef) { await H.mcp.refresh(s); await H.mcp.connect(s.id); r = await mcpClients[s.id].call(tool.name, a); } else throw e; }
            const text = (r.content || []).map((p) => p.type === 'text' ? p.text : p.type === 'resource' ? JSON.stringify(p.resource) : '[' + p.type + ']').join('\n');
            return r.structuredContent ? { text, structured: r.structuredContent, isError: r.isError } : (r.isError ? { error: text } : text);
          }, { label: s.name, sum: () => tool.title || tool.name, write: tool._write });
        }
      }
    }
    return { defs, run };
  };

  H.runTool = async function (registry, call) {
    const r = registry.run[call.function.name];
    let args = {};
    try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch (_) { return { error: 'Arguments were not valid JSON' }; }
    if (!r) return { error: 'Unknown tool ' + call.function.name };
    return r.fn(args);
  };
  H.clip = clip;
})();
