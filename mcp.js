/* Hark AI — remote MCP client (streamable HTTP + OAuth 2.1/PKCE), uses window.HarkNet from app.js */
(function () {
  'use strict';
  const MCP_PROTOCOL = '2025-06-18';
  const WRITE_RE = /(place|modify|cancel|close|exit|convert|transfer|withdraw|deposit|pledge|unpledge|basket|split|gtt|squareoff|square_off|toggle|order_slice|smartorder|create_alert|delete)/i;
  const READ_SAFE_RE = /(book|list|get|status|history|quote|depth|holdings|positions|funds|margin_info|search|profile|ping|instruments|expiry|ltp)/i;

  // Classify a tool as write (can place/modify/cancel orders or move money) or read.
  function isWriteTool(tool) {
    const ann = tool.annotations || {};
    const name = (tool.name || '') + ' ' + (tool.title || '');
    if (ann.readOnlyHint === true && !WRITE_RE.test(tool.name || '')) return false;
    if (WRITE_RE.test(tool.name || '')) return !(READ_SAFE_RE.test(tool.name) && !/place|modify|cancel|close|exit|transfer|withdraw|toggle/i.test(tool.name));
    if (ann.destructiveHint === true) return true;
    return /order|trade/i.test(name) && !READ_SAFE_RE.test(name);
  }

  function b64url(bytes) { let s = ''; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  async function pkce() {
    const v = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
    return { verifier: v, challenge: b64url(d) };
  }

  class McpClient {
    constructor(server, store) { this.s = server; this.store = store; this.sessionId = null; this.tools = null; this.nextId = 1; }
    authHeaders() {
      const h = {};
      if (this.s.tokenRef) h['Authorization'] = 'Bearer ' + this.s.tokenRef; // e.g. {{vault:<id>}} resolved natively
      if (this.s.headers) Object.assign(h, this.s.headers);
      return h;
    }
    async rpc(method, params, isNotification, opts) {
      const body = { jsonrpc: '2.0', method };
      if (params !== undefined) body.params = params;
      if (!isNotification) body.id = this.nextId++;
      const headers = Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': MCP_PROTOCOL }, this.authHeaders());
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      const res = await window.HarkNet.request(Object.assign({ url: this.s.url, method: 'POST', headers, body: JSON.stringify(body), want: 'text' }, opts || {}));
      if (res.headers && (res.headers['mcp-session-id'] || res.headers['Mcp-Session-Id'])) this.sessionId = res.headers['mcp-session-id'] || res.headers['Mcp-Session-Id'];
      if (res.status === 401) { const e = new Error('auth_required'); e.auth = true; e.wwwAuth = res.headers && (res.headers['www-authenticate'] || ''); throw e; }
      if (res.status === 404 && this.sessionId) { this.sessionId = null; }
      if (isNotification) return null;
      if (res.status >= 400) throw new Error('MCP HTTP ' + res.status + ': ' + (res.text || '').slice(0, 200));
      let msg = null; const t = res.text || '';
      if (/^\s*\{/.test(t)) msg = JSON.parse(t);
      else { // SSE: take the last data: line carrying our id
        for (const line of t.split(/\r?\n/)) { if (line.startsWith('data:')) { try { const j = JSON.parse(line.slice(5)); if (j.id === body.id || j.result || j.error) msg = j; } catch (_) {} } }
      }
      if (!msg) throw new Error('MCP: empty response');
      if (msg.error) throw new Error('MCP error: ' + (msg.error.message || JSON.stringify(msg.error)));
      return msg.result;
    }
    async connect() {
      await this.rpc('initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'hark-ai', version: '1.1' } });
      try { await this.rpc('notifications/initialized', undefined, true); } catch (_) {}
      const r = await this.rpc('tools/list', {});
      this.tools = (r.tools || []).map(t => Object.assign({}, t, { _write: isWriteTool(t) }));
      return this.tools;
    }
    async call(name, args, opts) {
      if (!this.tools) await this.connect();
      return this.rpc('tools/call', { name, arguments: args || {} }, false, opts);
    }
  }

  // OAuth 2.1 (discovery, dynamic client registration, PKCE). Tokens are stored by the native vault.
  async function discover(serverUrl, wwwAuth) {
    const u = new URL(serverUrl);
    let asBase = u.origin;
    const m = /resource_metadata="([^"]+)"/.exec(wwwAuth || '');
    const tryJson = async (url) => { try { const r = await window.HarkNet.request({ url, method: 'GET', headers: { Accept: 'application/json' }, want: 'text' }); if (r.status === 200) return JSON.parse(r.text); } catch (_) {} return null; };
    const prm = (m && await tryJson(m[1])) || await tryJson(u.origin + '/.well-known/oauth-protected-resource' + u.pathname) || await tryJson(u.origin + '/.well-known/oauth-protected-resource');
    if (prm && prm.authorization_servers && prm.authorization_servers[0]) asBase = prm.authorization_servers[0].replace(/\/$/, '');
    const meta = await tryJson(asBase + '/.well-known/oauth-authorization-server') || await tryJson(asBase + '/.well-known/openid-configuration');
    if (!meta) throw new Error('No OAuth metadata at ' + asBase);
    return meta;
  }

  const REDIRECT = 'harkai://oauth/callback';
  async function startOAuth(server, onDone) {
    const meta = await discover(server.url, server.wwwAuth);
    let clientId = server.clientId;
    if (!clientId && meta.registration_endpoint) {
      const r = await window.HarkNet.request({ url: meta.registration_endpoint, method: 'POST', headers: { 'Content-Type': 'application/json' }, want: 'text',
        body: JSON.stringify({ client_name: 'Shoeb AI', redirect_uris: [REDIRECT, location.origin + location.pathname + '?oauth=1'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
      if (r.status >= 300) throw new Error('Client registration failed: HTTP ' + r.status + ' ' + (r.text || '').slice(0, 160));
      clientId = JSON.parse(r.text).client_id;
    }
    if (!clientId) throw new Error('Server needs a client id (no dynamic registration)');
    const { verifier, challenge } = await pkce();
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const redirect = window.HarkNative ? REDIRECT : location.origin + location.pathname + '?oauth=1';
    const authUrl = new URL(meta.authorization_endpoint);
    authUrl.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state, resource: server.url }).toString();
    const pending = { serverId: server.id, verifier, state, clientId, tokenEndpoint: meta.token_endpoint, redirect, resource: server.url };
    localStorage.setItem('hark.oauthPending', JSON.stringify(pending));
    window.HarkNet.openAuth(authUrl.toString());
    return { clientId, tokenEndpoint: meta.token_endpoint };
  }

  async function finishOAuth(callbackUrl) {
    const pending = JSON.parse(localStorage.getItem('hark.oauthPending') || 'null');
    if (!pending) throw new Error('No sign-in in progress');
    const u = new URL(callbackUrl);
    if (u.searchParams.get('state') !== pending.state) throw new Error('OAuth state mismatch');
    const code = u.searchParams.get('code');
    if (!code) throw new Error('Sign-in cancelled: ' + (u.searchParams.get('error') || 'no code'));
    const form = { grant_type: 'authorization_code', code, redirect_uri: pending.redirect, client_id: pending.clientId, code_verifier: pending.verifier };
    const r = await window.HarkNet.oauthToken(pending.tokenEndpoint, form, 'mcp:' + pending.serverId, pending.resource);
    localStorage.removeItem('hark.oauthPending');
    return Object.assign({ serverId: pending.serverId, clientId: pending.clientId, tokenEndpoint: pending.tokenEndpoint }, r);
  }

  async function refreshOAuth(server) {
    if (!server.refreshRef || !server.tokenEndpoint) throw new Error('No refresh token');
    return window.HarkNet.oauthToken(server.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: server.refreshRef, client_id: server.clientId }, 'mcp:' + server.id, server.url);
  }

  window.HarkMCP = { McpClient, isWriteTool, startOAuth, finishOAuth, refreshOAuth, REDIRECT };
})();
