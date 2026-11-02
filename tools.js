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
  // Reads go straight through. Every write (orders, cancels, closes, analyzer toggle) opens a
  // full-screen ticket and is sent only after the user's tap + native fingerprint/PIN for that
  // exact request (enforced again in native code).
  const OA_READ = {
    funds: 'funds', positions: 'positionbook', holdings: 'holdings', orderbook: 'orderbook', tradebook: 'tradebook',
    quote: 'quotes', history: 'history', depth: 'depth', analyzer_status: 'analyzer', ping: 'ping', pnl: null, open_position: 'openposition',
    order_status: 'orderstatus', intervals: 'intervals', symbol_info: 'symbol', search: 'search', expiry: 'expiry', margin: 'margin',
  };
  H.OA_READ = OA_READ;
  H.oaAccounts = () => H.settings.openalgo.filter((a) => H.vault.byProvider(a.provider).length);
  H.oaAccount = (id) => { const a = H.settings.openalgo.find((x) => x.id === id); if (!a) throw new Error('Unknown account ' + id + ' (use tradesmart or wisdom)'); return a; };
  const hostOf = (u) => { try { return new URL(u).host; } catch (_) { return ''; } };
  function oaKey(acc) {
    const keys = H.vault.byProvider(acc.provider);
    if (!keys.length) throw new Error('No API key for ' + acc.name + ' in the vault');
    const h = hostOf(acc.base);
    return keys.find((k) => k.host === h) || keys[0];
  }
  async function oaCall(acc, endpoint, extra, opts) {
    if (!acc.base) throw new Error(acc.name + ' has no OpenAlgo address yet. Import the Hark file first.');
    const k = oaKey(acc);
    const url = acc.base.replace(/\/+$/, '') + '/api/v1/' + endpoint;
    const host = new URL(url).host;
    if (k.host && k.host !== host) {
      const ok = await H.vault.setHost(k.id, host);
      if (!ok) throw new Error('The ' + acc.name + ' key is saved for ' + k.host + '. Address change not allowed.');
    }
    const body = Object.assign({ apikey: PH(k.id) }, extra || {});
    const r = await H.net.request(Object.assign({ url, method: 'POST', headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' }, body: JSON.stringify(body), timeout: 45000 }, opts || {}));
    let j; try { j = r.json(); } catch (_) { throw new Error(acc.name + ' HTTP ' + r.status + ': ' + r.text.slice(0, 160)); }
    if (r.status >= 400 || j.status === 'error') throw new Error(acc.name + ': ' + (j.message || 'HTTP ' + r.status));
    return j;
  }
  H.oaCall = oaCall;
  const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  H.num = num;
  H.oaAnalyzer = async (acc) => {
    const a = await oaCall(acc, 'analyzer').catch(() => null);
    if (!a || !a.data) return null;
    return a.data.analyze_mode === true || a.data.mode === 'analyze';
  };
  async function oaRead(args) {
    const acc = H.oaAccount(args.account);
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
    const up = (v) => String(v || '').toUpperCase();
    if (['quote', 'history', 'depth', 'open_position', 'symbol_info'].includes(args.action)) {
      if (!args.symbol || !args.exchange) throw new Error('symbol and exchange are required');
      extra.symbol = up(args.symbol); extra.exchange = up(args.exchange);
    }
    if (args.action === 'open_position') { extra.product = args.product || 'MIS'; extra.strategy = 'HarkAI'; }
    if (args.action === 'order_status') { if (!args.orderid) throw new Error('orderid is required'); extra.orderid = String(args.orderid); extra.strategy = 'HarkAI'; }
    if (args.action === 'search') { extra.query = String(args.query || args.symbol || ''); if (args.exchange) extra.exchange = up(args.exchange); }
    if (args.action === 'expiry') { extra.symbol = up(args.symbol); extra.exchange = up(args.exchange || 'NFO'); extra.instrumenttype = args.instrumenttype || 'options'; }
    if (args.action === 'margin') { extra.positions = args.positions || []; }
    if (args.action === 'history') {
      extra.interval = args.interval || 'D';
      const today = new Date().toISOString().slice(0, 10);
      extra.start_date = args.start_date || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      extra.end_date = args.end_date || today;
    }
    const j = await oaCall(acc, ep, extra);
    return { account: acc.name, mode: acc.mode, action: args.action, data: j.data !== undefined ? j.data : j };
  }
  H.oaRead = oaRead;

  // ----- write actions (tickets) -----
  const TRADE_KINDS = {
    place: { ep: 'placeorder', title: 'Place order', order: true },
    smart: { ep: 'placesmartorder', title: 'Smart order (target position size)', order: true },
    basket: { ep: 'basketorder', title: 'Basket order', order: true },
    split: { ep: 'splitorder', title: 'Split order', order: true },
    modify: { ep: 'modifyorder', title: 'Modify order', order: true },
    cancel: { ep: 'cancelorder', title: 'Cancel order' },
    cancel_all: { ep: 'cancelallorder', title: 'Cancel ALL open orders' },
    close_all: { ep: 'closeposition', title: 'Close ALL open positions' },
    analyzer: { ep: 'analyzer/toggle', title: 'Switch analyzer mode' },
  };
  H.TRADE_KINDS = TRADE_KINDS;
  const U = (v, d) => String(v == null || v === '' ? d : v).toUpperCase();
  function orderFields(a) {
    const o = {
      symbol: U(a.symbol, ''), exchange: U(a.exchange, 'NSE'), action: U(a.action, ''), quantity: String(parseInt(a.quantity, 10) || 0),
      product: U(a.product, 'MIS'), pricetype: U(a.pricetype, 'MARKET'), price: String(a.price || 0), trigger_price: String(a.trigger_price || 0),
    };
    if (!o.symbol || !['BUY', 'SELL'].includes(o.action)) throw new Error('Order needs symbol and BUY/SELL');
    if (!['MIS', 'CNC', 'NRML'].includes(o.product)) throw new Error('product must be MIS, CNC or NRML');
    if (!['MARKET', 'LIMIT', 'SL', 'SL-M'].includes(o.pricetype)) throw new Error('pricetype must be MARKET, LIMIT, SL or SL-M');
    if (o.pricetype !== 'MARKET' && o.pricetype !== 'SL-M' && !(+o.price > 0)) throw new Error('A ' + o.pricetype + ' order needs a price');
    if (/^SL/.test(o.pricetype) && !(+o.trigger_price > 0)) throw new Error('A stop order needs a trigger price');
    return o;
  }
  /** Turn a request into {endpoint, body, cells, lines, warn}. Throws on bad input. */
  H.tradeSpec = function (kind, a, acc) {
    const k = TRADE_KINDS[kind]; if (!k) throw new Error('Unknown trade action ' + kind);
    const body = { strategy: 'HarkAI' }; const cells = []; let lines = null; let headline = k.title;
    const fmtPx = (o) => o.pricetype === 'MARKET' ? 'Market' : '₹' + o.price;
    if (kind === 'place' || kind === 'split' || kind === 'smart') {
      const o = orderFields(a);
      if (kind !== 'smart' && !(+o.quantity > 0)) throw new Error('Quantity must be positive');
      Object.assign(body, o);
      if (kind === 'smart') { if (a.position_size == null) throw new Error('position_size is required'); body.position_size = String(parseInt(a.position_size, 10) || 0); }
      if (kind === 'split') { body.splitsize = String(parseInt(a.splitsize, 10) || 0); if (!(+body.splitsize > 0)) throw new Error('splitsize is required'); }
      headline = (o.action === 'BUY' ? 'Buy ' : 'Sell ') + o.symbol;
      cells.push(['Side', o.action, o.action === 'BUY' ? 'side-buy' : 'side-sell'], ['Quantity', o.quantity], ['Symbol', o.symbol], ['Exchange', o.exchange], ['Product', o.product], ['Price type', o.pricetype], ['Price', fmtPx(o)], ['Trigger', +o.trigger_price ? '₹' + o.trigger_price : '—']);
      if (kind === 'smart') cells.push(['Target position', body.position_size]);
      if (kind === 'split') cells.push(['Split into', body.splitsize + ' per order']);
    } else if (kind === 'basket') {
      const orders = (a.orders || []).map(orderFields);
      if (!orders.length || orders.length > 20) throw new Error('A basket needs 1–20 orders');
      orders.forEach((o) => { if (!(+o.quantity > 0)) throw new Error('Every basket order needs a positive quantity'); });
      body.orders = orders;
      headline = 'Basket · ' + orders.length + ' orders';
      lines = orders.map((o) => o.action + ' ' + o.quantity + ' ' + o.symbol + ' ' + o.exchange + ' · ' + o.product + ' · ' + fmtPx(o));
    } else if (kind === 'modify') {
      if (!a.orderid) throw new Error('orderid is required');
      const o = orderFields(a); Object.assign(body, o, { orderid: String(a.orderid), disclosed_quantity: String(a.disclosed_quantity || 0) });
      headline = 'Modify ' + o.symbol + ' order';
      cells.push(['Order ID', String(a.orderid)], ['Side', o.action, o.action === 'BUY' ? 'side-buy' : 'side-sell'], ['Quantity', o.quantity], ['Symbol', o.symbol], ['Price type', o.pricetype], ['Price', fmtPx(o)], ['Trigger', +o.trigger_price ? '₹' + o.trigger_price : '—'], ['Product', o.product]);
    } else if (kind === 'cancel') {
      if (!a.orderid) throw new Error('orderid is required');
      body.orderid = String(a.orderid); headline = 'Cancel order ' + body.orderid;
      cells.push(['Order ID', body.orderid]); if (a.symbol) cells.push(['Symbol', U(a.symbol, '')]);
    } else if (kind === 'cancel_all') {
      headline = 'Cancel every open order';
    } else if (kind === 'close_all') {
      headline = 'Square off every open position';
    } else if (kind === 'analyzer') {
      if (typeof a.mode !== 'boolean') throw new Error('mode must be true (analyzer/paper ON) or false (OFF = live)');
      delete body.strategy; body.mode = a.mode;
      headline = 'Analyzer ' + (a.mode ? 'ON (paper)' : 'OFF (live orders)');
    }
    let warn = acc.mode === 'LIVE' ? 'LIVE TradeSmart account: real money. Check every field.' : 'Wisdom PAPER account (analyzer/sandbox): no real money.';
    if (kind === 'cancel_all' || kind === 'close_all') warn = (acc.mode === 'LIVE' ? 'Real money. ' : '') + 'This affects every open ' + (kind === 'close_all' ? 'position (market orders to square off)' : 'order') + ' on ' + acc.name + ', including ones your strategies placed.';
    if (kind === 'analyzer') warn = a.mode ? acc.name + ' will stop sending real orders; strategies there will trade in the sandbox.' : 'DANGER: ' + acc.name + ' will start sending REAL orders, including from any strategies running there.';
    return { endpoint: k.ep, body, cells, lines, headline, warn, title: k.title };
  };

  /** Show a ticket for a write action; send it only on tap + biometric. */
  H.trade = async function (kind, args) {
    const acc = H.oaAccount(args.account);
    const spec = H.tradeSpec(kind, args, acc);
    const isOrder = TRADE_KINDS[kind].order;
    let analyzer = null;
    if (acc.mode !== 'LIVE' || kind === 'analyzer') analyzer = await H.oaAnalyzer(acc);
    if (acc.mode !== 'LIVE' && isOrder && analyzer !== true) {
      return { status: 'blocked', message: acc.name + ' is not in analyzer (paper) mode, so Hark will not send this order.' };
    }
    const danger = kind === 'analyzer' && !args.mode;
    const res = await H.ui.ticket({
      badge: danger ? 'DANGER' : acc.mode === 'LIVE' ? 'LIVE' : 'PAPER',
      source: acc.name + ' · OpenAlgo' + (analyzer == null ? '' : ' · analyzer ' + (analyzer ? 'ON' : 'OFF')),
      headline: spec.headline, cells: spec.cells, lines: spec.lines, warn: spec.warn,
      goText: (acc.mode === 'LIVE' ? 'Send LIVE · ' : 'Send PAPER · ') + spec.title,
      typeToConfirm: danger ? acc.name.toUpperCase() : null,
      run: () => oaCall(acc, spec.endpoint, spec.body, { approval: spec.title + ' · ' + acc.name + (acc.mode === 'LIVE' ? ' LIVE' : ' PAPER') }),
    });
    if (!res.confirmed) return { status: 'declined', message: 'The user did not confirm. Nothing was sent.' };
    if (res.error) return { status: 'failed_after_confirmation', account: acc.name, error: res.error };
    const j = res.result || {};
    H.toast(acc.name + ': ' + spec.title.toLowerCase() + ' sent' + (j.orderid ? ' · ' + j.orderid : ''));
    return { status: 'sent_after_user_confirmation', account: acc.name, mode: acc.mode, action: kind, orderid: j.orderid, response: j };
  };

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
      const accDesc = accs.map((a) => a.id + ' (' + a.name + ', ' + (a.mode === 'LIVE' ? 'LIVE real money' : 'PAPER analyzer/sandbox') + ')').join(', ');
      add('openalgo_read', 'Read broker data via OpenAlgo. Accounts: ' + accDesc + '. Actions: funds, positions, holdings, orderbook, tradebook, pnl (today realised + unrealised), quote, history (OHLC; interval 1m/3m/5m/15m/30m/1h/D), depth, analyzer_status, ping, open_position, order_status (needs orderid), intervals, symbol_info, search (query), expiry (symbol, instrumenttype options/futures), margin (positions list). Symbols use OpenAlgo format, e.g. RELIANCE on NSE, NIFTY28NOV2524000CE on NFO, NIFTY on NSE_INDEX.',
        { type: 'object', properties: { account: { type: 'string', enum: accs.map((a) => a.id) }, action: { type: 'string', enum: Object.keys(OA_READ) }, symbol: { type: 'string' }, exchange: { type: 'string', enum: ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'BCD', 'NSE_INDEX', 'BSE_INDEX'] }, interval: { type: 'string' }, start_date: { type: 'string', description: 'YYYY-MM-DD' }, end_date: { type: 'string', description: 'YYYY-MM-DD' }, product: { type: 'string' }, orderid: { type: 'string' }, query: { type: 'string' }, instrumenttype: { type: 'string' }, positions: { type: 'array', items: { type: 'object' } } }, required: ['account', 'action'] },
        oaRead, { label: 'Checking broker', sum: (a) => a.account + ' · ' + a.action + (a.symbol ? ' ' + a.symbol : '') });
      const ord = { type: 'object', properties: { symbol: { type: 'string' }, exchange: { type: 'string' }, action: { type: 'string', enum: ['BUY', 'SELL'] }, quantity: { type: 'integer' }, product: { type: 'string', enum: ['MIS', 'CNC', 'NRML'] }, pricetype: { type: 'string', enum: ['MARKET', 'LIMIT', 'SL', 'SL-M'] }, price: { type: 'number' }, trigger_price: { type: 'number' } } };
      add('openalgo_trade', 'Draft a trading action as a full-screen ticket. NOTHING is sent unless the user taps confirm AND passes fingerprint/PIN on the phone; you cannot confirm it yourself. Use only when the user asks for that action. kind: place | smart (position_size = target net position) | basket (orders[]) | split (splitsize) | modify (orderid + full new order fields) | cancel (orderid) | cancel_all | close_all (square off every position) | analyzer (mode true = paper ON, false = live). Wisdom orders are refused unless its analyzer (paper) mode is on. Never retry a declined ticket.',
        { type: 'object', properties: Object.assign({ account: { type: 'string', enum: accs.map((a) => a.id) }, kind: { type: 'string', enum: Object.keys(TRADE_KINDS) }, position_size: { type: 'integer' }, splitsize: { type: 'integer' }, orderid: { type: 'string' }, mode: { type: 'boolean' }, orders: { type: 'array', items: ord } }, ord.properties), required: ['account', 'kind'] },
        (a) => H.trade(a.kind, a), { label: 'Trade ticket', sum: (a) => a.account + ' · ' + a.kind + (a.symbol ? ' ' + (a.action || '') + ' ' + (a.quantity || '') + ' ' + a.symbol : ''), write: true });
    }
    if (H.opsTools) { try { await H.opsTools(add, t); } catch (e) { console.error(e); } }
    if (H.accountTools) { try { await H.accountTools(add, t); } catch (e) { console.error(e); } }
    if (t.mcp) {
      for (const s of H.settings.mcpServers.filter((x) => x.enabled)) {
        let tools = mcpTools[s.id];
        if (!tools) { try { tools = await H.mcp.connect(s.id); } catch (_) { continue; } }
        for (const tool of tools) {
          if (tool._write && s.readOnly) continue;
          const name = toolName(s.id, tool.name);
          const params = tool.inputSchema && tool.inputSchema.type ? tool.inputSchema : { type: 'object', properties: {} };
          add(name, '[' + s.name + '] ' + (tool.description || tool.title || tool.name).slice(0, 900) + (tool._write ? ' (needs the user\'s on-screen confirmation)' : ''), params, async (a) => {
            const doCall = async () => {
              const opts = tool._write ? { approval: s.name + ': ' + (tool.title || tool.name) } : undefined;
              const c = mcpClients[s.id] || (await H.mcp.connect(s.id), mcpClients[s.id]);
              try { return await c.call(tool.name, a, opts); }
              catch (e) { if (e.auth && s.refreshRef) { await H.mcp.refresh(s); await H.mcp.connect(s.id); return mcpClients[s.id].call(tool.name, a, opts); } throw e; }
            };
            let r;
            if (tool._write) {
              const res = await H.ui.confirmAction({ title: s.name + ': ' + (tool.title || tool.name), server: s, tool, args: a, run: doCall });
              if (!res.confirmed) return { status: 'declined', message: 'The user did not confirm.' };
              if (res.error) return { error: res.error };
              r = res.result;
            } else r = await doCall();
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
