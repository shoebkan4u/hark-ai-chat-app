/* Hark AI — operations: SSH keys/servers/terminal, connections, Oracle Cloud, trade desk, backtests.
   Secrets never enter this file: SSH keys, OCI keys and tokens are used inside the Android app
   (window.HarkOps). Every write goes through a full-screen ticket + native fingerprint/PIN. */
(function () {
  'use strict';
  const H = window.Hark;
  const { el, icon } = { el: H.el, icon: H.icon };
  const O = window.HarkOps || null;
  const PH = H.vault.PH;
  const esc = H.esc;
  const jparse = (s, d) => { try { return JSON.parse(s); } catch (_) { return d; } };
  const inr = (n) => (n < 0 ? '−' : '') + '₹' + Math.abs(Math.round(+n || 0)).toLocaleString('en-IN');
  const needApp = () => { if (!O) throw new Error('This needs the Shoeb AI Android app (v1.1 or newer)'); };

  // ============================================================ SSH
  const ssh = (H.ssh = {
    keys() { return H.vault.list().filter((k) => k.type === 'ssh_key'); },
    vms() { return O ? jparse(O.vmList(), []) : []; },
    tunnels() { return O ? jparse(O.tunnelList(), []) : []; },
    vm(idOrName) {
      const q = String(idOrName || '').toLowerCase();
      const v = this.vms().find((x) => x.id.toLowerCase() === q || (x.name || '').toLowerCase() === q || x.host === q) || (this.vms().length === 1 && !q ? this.vms()[0] : null);
      if (!v) throw new Error('Unknown server "' + idOrName + '". Servers: ' + this.vms().map((x) => x.id + ' (' + x.name + ')').join(', '));
      return v;
    },
    savePasted(label, pem, pass) { needApp(); return H.opsCall('sshKeySave', JSON.stringify({ label }), pem, pass || ''); },
    pick(label) { needApp(); return H.opsCall('sshKeyPick', JSON.stringify({ label })); },
    generate(label) { needApp(); return H.opsCall('sshKeyGenerate', label || 'Phone key'); },
    info(id) { needApp(); return H.opsCall('sshKeyInfo', id); },
    scan(host, port) { needApp(); return H.opsCall('sshScan', host, +port || 22); },
    saveVm(vm) { needApp(); return H.opsCall('vmSave', JSON.stringify(vm)); },
    delVm(id) { needApp(); return H.opsCall('vmDelete', id); },
    saveTunnel(t) { needApp(); return H.opsCall('tunnelSave', JSON.stringify(t)); },
    test(vmId, keyId) { needApp(); return H.opsCall('sshTest', vmId, keyId || ''); },
    /** Run a command. Returns {code, output}. onOut gets streamed text. With direct, no approval is asked:
        the app itself decides (read-only commands, or changes when Safety › Ask is off and the command isn't protected). */
    async exec(vmId, command, onOut, timeoutSec, direct) {
      needApp();
      let tok = '';
      if (!direct) [tok] = await H.approve('Run command on ' + vmId, ['SSH ' + vmId + '\n' + command]);
      return new Promise((resolve, reject) => {
        const id = H.newId('sx'); let out = '';
        H.nativeCallRaw(id, (type, d) => {
          if (type === 'out') { out += d.t; if (onOut) onOut(d.t); return; }
          H.nativeDone(id);
          if (type === 'err') reject(H.nativeError(d)); else resolve({ code: d.code, output: out, readOnly: d.readOnly, ticketed: d.ticketed });
        });
        try { O.sshExec(id, vmId, command, tok || '', timeoutSec || 120); } catch (e) { H.nativeDone(id); reject(e); }
      });
    },
    /** True when the installed app has the native read-only policy (1.1.6+). */
    nativePolicy() { return !!(O && typeof O.sshClassify === 'function'); },
    policy() { return this.nativePolicy() ? jparse(O.sshPolicy(), { askChanges: true }) : { askChanges: true }; },
    /** {readOnly, protected, reason, needsTicket}. Native verdict when the app has it; the web mirror otherwise (display only). */
    classify(command) {
      if (this.nativePolicy()) { const v = jparse(O.sshClassify(command), null); if (v) return v; }
      const P = H.sshPolicy || window.HarkSshPolicy;
      const v = P ? P.classify(command) : { readOnly: false, reason: 'policy missing' };
      return { readOnly: v.readOnly, protected: P ? P.isProtected(command) : true, reason: v.reason, needsTicket: true };
    },
    setAskChanges(on) { needApp(); return H.opsCall('sshSetAskChanges', !!on); },
  });
  // Ticket for a command (used by the chat tool and the Run screen).
  const RISKY = /\b(rm|reboot|shutdown|poweroff|halt|mkfs|dd|kill|pkill|systemctl\s+(stop|restart|disable|mask)|docker\s+(rm|stop|restart|kill|compose\s+down)|iptables|ufw|chmod|chown|mv|truncate|crontab|apt|pip|npm|sed\s+-i|tee|>)/;
  const sshCard = (vm, command, r, how) => ({ kind: 'ssh', server: vm.name || vm.host, command, code: r.code, output: H.clip(stripAnsi(r.output || ''), 20000), how });
  /**
   * Run a command (chat tool and the Run screen). Read-only commands run straight away with no ticket; so do changing
   * ones when Settings › Safety › "Ask before SSH commands that change things" is off and the command isn't protected.
   * Everything else opens the full-screen ticket + fingerprint. Old app shells (before 1.1.6) always need the ticket.
   */
  /** Result for a dropped SSH link. Read-only commands get a Retry chip; a write is reported as unknown and never re-run. */
  const dropped = (vm, command, readOnly) => readOnly
    ? { status: 'connection_dropped', server: vm.name, message: 'The connection dropped twice. The user can tap Retry.', retry: { server: vm.id, command } }
    : { status: 'connection_dropped', server: vm.name, message: 'The connection dropped while this command was running. It may or may not have finished, and it was NOT re-run. Check its effect with a read-only command before suggesting anything else; never re-run it without the user asking.' };
  H.sshRunTicket = async function (vmId, command, timeoutSec) {
    const vm = ssh.vm(vmId);
    const v = ssh.classify(command);
    if (ssh.nativePolicy() && !v.needsTicket) {
      const run = async () => {
        const r = await ssh.exec(vm.id, command, null, timeoutSec, true);
        const how = v.readOnly ? 'read-only' : 'ran without asking (Safety setting off)';
        return { status: v.readOnly ? 'ran_read_only' : 'ran_without_ticket_by_user_setting', server: vm.name, exit_code: r.code, output: H.clip(r.output, 12000), card: sshCard(vm, command, r, how) };
      };
      try { return await run(); } catch (e) {
        if (!H.netErr(e)) return { status: 'failed', error: e.message };
        // Only read-only commands are repeated (once, when the app is back in front). Writes are never re-run.
        if (!v.readOnly) return dropped(vm, command, false);
        await H.whenForeground(); await H.sleep(400);
        try { return await run(); } catch (e2) { return H.netErr(e2) ? dropped(vm, command, true) : { status: 'failed', error: e2.message }; }
      }
    }
    const danger = !v.readOnly && (v.protected || RISKY.test(command));
    const res = await H.ui.ticket({
      badge: v.readOnly ? 'READ-ONLY' : danger ? 'DANGER' : 'ACTION', source: vm.name + ' · SSH ' + vm.user + '@' + vm.host, headline: v.readOnly ? 'Read from the server' : 'Run a command', code: command,
      warn: v.readOnly ? 'This command only reads. Update Shoeb AI to 1.1.6 and read-only commands run without this step.'
        : (danger ? 'This command can change or stop things on the server. ' : '') + (vm.id === 'a1' ? 'hark-a1 runs your LIVE TradeSmart trading. ' : '') + 'It runs as ' + vm.user + ' only if you confirm.',
      goText: 'Run on ' + (vm.name || vm.host),
      run: () => ssh.exec(vm.id, command, null, timeoutSec),
    });
    if (!res.confirmed) return { status: 'declined', message: 'The user did not confirm. Nothing ran.' };
    if (res.error && H.netErr({ message: res.error })) return dropped(vm, command, v.readOnly);
    if (res.error) return { status: 'failed_after_confirmation', error: res.error };
    return { status: 'ran_after_user_confirmation', server: vm.name, exit_code: res.result.code, output: H.clip(res.result.output, 12000), card: sshCard(vm, command, res.result, 'confirmed') };
  };

  // ============================================================ Oracle Cloud
  const OCI_LIMITS = { a1Ocpu: 4, a1MemGb: 24, micro: 2, blockGb: 200 };
  const oci = (H.oci = {
    info() { return O ? jparse(O.ociInfo(), { configured: false }) : { configured: false }; },
    async req(method, service, path, body, title) {
      needApp();
      let tok = '';
      if (method !== 'GET') {
        const url = O.ociUrl(service, path);
        if (!url) throw new Error('Oracle Cloud isn’t set up. Import the v2 file.');
        [tok] = await H.approve(title || 'Oracle Cloud action', [H.reqKey(method, url, body || null)]);
      }
      const r = await H.opsCall('ociRequest', method, service, path, body || '', tok);
      let j = null; try { j = r.text ? JSON.parse(r.text) : null; } catch (_) {}
      if (r.status >= 300) throw new Error('Oracle Cloud HTTP ' + r.status + ': ' + ((j && (j.message || j.code)) || r.text || '').slice(0, 200));
      return j;
    },
    async instances() {
      const list = await this.req('GET', 'iaas', '/20160918/instances?compartmentId={tenancy}&limit=100');
      return (list || []).filter((i) => i.lifecycleState !== 'TERMINATED').map((i) => ({
        id: i.id, name: i.displayName, state: i.lifecycleState, shape: i.shape, ocpus: (i.shapeConfig || {}).ocpus, memoryGb: (i.shapeConfig || {}).memoryInGBs,
        ad: i.availabilityDomain, created: i.timeCreated, region: i.region,
      }));
    },
    async ads() { return (await this.req('GET', 'identity', '/20160918/availabilityDomains?compartmentId={tenancy}')) || []; },
    async bootVolumes() {
      const out = [];
      for (const ad of await this.ads()) {
        const v = await this.req('GET', 'iaas', '/20160918/bootVolumes?compartmentId={tenancy}&availabilityDomain=' + encodeURIComponent(ad.name));
        (v || []).filter((x) => x.lifecycleState !== 'TERMINATED').forEach((x) => out.push({ id: x.id, name: x.displayName, sizeGb: x.sizeInGBs, state: x.lifecycleState, vpus: x.vpusPerGB, ad: ad.name }));
      }
      return out;
    },
    async usage() {
      const [ins, vols, ads] = await Promise.all([this.instances(), this.bootVolumes(), this.ads()]);
      const a1 = ins.filter((i) => /A1/.test(i.shape)); const micro = ins.filter((i) => /E2\.1\.Micro/.test(i.shape));
      const used = { a1Ocpu: a1.reduce((s, i) => s + (+i.ocpus || 0), 0), a1MemGb: a1.reduce((s, i) => s + (+i.memoryGb || 0), 0), micro: micro.length, blockGb: vols.reduce((s, v) => s + (+v.sizeGb || 0), 0) };
      const limits = {};
      for (const name of ['standard-a1-core-count', 'standard-a1-memory-count']) {
        try {
          let u = 0, a = 0;
          for (const ad of ads) { const r = await this.req('GET', 'limits', '/20190729/services/compute/limits/' + name + '/resourceAvailability?compartmentId={tenancy}&availabilityDomain=' + encodeURIComponent(ad.name)); u += +(r.used || 0); a += +(r.available || 0); }
          limits[name] = { used: u, available: a };
        } catch (_) {}
      }
      const items = [
        { name: 'Ampere A1 OCPUs', used: used.a1Ocpu, free: OCI_LIMITS.a1Ocpu, unit: 'OCPU' },
        { name: 'Ampere A1 memory', used: used.a1MemGb, free: OCI_LIMITS.a1MemGb, unit: 'GB' },
        { name: 'E2.1.Micro VMs', used: used.micro, free: OCI_LIMITS.micro, unit: 'VMs' },
        { name: 'Block storage (boot volumes)', used: used.blockGb, free: OCI_LIMITS.blockGb, unit: 'GB' },
      ];
      return { items, limits, running: ins.filter((i) => i.state === 'RUNNING').length, instances: ins.length, note: 'Always Free allowances shown are Oracle’s standard ones (4 OCPU/24 GB A1, 2 micro VMs, 200 GB). Your account notes say A1 is capped at 2 OCPU/12 GB in Mumbai; the limits line shows what Oracle reports.' };
    },
    find(ins, q) {
      const s = String(q || '').toLowerCase();
      return ins.find((i) => i.id === q || i.name.toLowerCase() === s) || ins.find((i) => i.name.toLowerCase().includes(s));
    },
  });
  const ACTIONS = { START: 'Start', STOP: 'Stop (graceful)', SOFTSTOP: 'Stop (graceful)', SOFTRESET: 'Reboot (graceful)', RESET: 'Force reboot', TERMINATE: 'Terminate' };
  /** Ticket for an instance action. Terminate also needs the instance name typed. */
  H.ociActionTicket = async function (inst, action, preserveBoot) {
    action = String(action || '').toUpperCase();
    if (action === 'STOP') action = 'SOFTSTOP';
    if (action === 'REBOOT') action = 'SOFTRESET';
    if (!ACTIONS[action]) throw new Error('action must be START, STOP, SOFTRESET (reboot), RESET or TERMINATE');
    const terminate = action === 'TERMINATE';
    const pres = preserveBoot !== false;
    const path = terminate ? '/20160918/instances/' + inst.id + '?preserveBootVolume=' + (pres ? 'true' : 'false') : '/20160918/instances/' + inst.id + '?action=' + action;
    const isA1 = /hark-a1/.test(inst.name);
    const res = await H.ui.ticket({
      badge: action === 'START' ? 'ACTION' : 'DANGER', source: 'Oracle Cloud · ' + inst.shape,
      headline: ACTIONS[action] + ' · ' + inst.name,
      cells: [['Instance', inst.name], ['State now', inst.state], ['Shape', (inst.ocpus || '?') + ' OCPU / ' + (inst.memoryGb || '?') + ' GB'], ['Action', ACTIONS[action]]].concat(terminate ? [['Boot volume', pres ? 'Kept' : 'DELETED']] : []),
      warn: terminate ? 'Terminating deletes the VM permanently' + (pres ? ' (its boot volume is kept and can be reattached)' : ' and its boot volume: all data is lost') + '. ' + (isA1 ? 'hark-a1 runs your LIVE TradeSmart and Wisdom servers. ' : '') + 'This cannot be undone.'
        : action === 'START' ? 'Starts the VM. A stopped Always Free VM may fail to start if Mumbai has no capacity.' : (isA1 ? 'hark-a1 runs your LIVE TradeSmart trading, Wisdom paper and OpenClaw. They stop until the VM is back. ' : '') + 'Running programs on the VM are interrupted.',
      typeToConfirm: terminate ? inst.name : null,
      goText: ACTIONS[action],
      run: () => oci.req(terminate ? 'DELETE' : 'POST', 'iaas', path, terminate ? '' : '', 'Oracle Cloud: ' + ACTIONS[action] + ' ' + inst.name),
    });
    if (!res.confirmed) return { status: 'declined', message: 'The user did not confirm. Nothing was changed.' };
    if (res.error) return { status: 'failed_after_confirmation', error: res.error };
    H.toast('Oracle Cloud: ' + ACTIONS[action].toLowerCase() + ' requested for ' + inst.name);
    return { status: 'requested_after_user_confirmation', instance: inst.name, action, state: res.result && res.result.lifecycleState };
  };

  // ============================================================ Connections
  function runnerToken(acc) { const k = H.vault.byProvider('runner:' + acc)[0]; return k ? PH(k.id) : null; }
  H.connections = async function () {
    const out = [];
    const push = (id, name, ok, detail, level) => out.push({ id, name, ok, level: level || (ok ? 'ok' : 'bad'), detail });
    const tasks = [];
    for (const acc of H.settings.openalgo) {
      tasks.push((async () => {
        const label = acc.name + (acc.mode === 'LIVE' ? ' LIVE' : ' PAPER');
        if (!H.vault.byProvider(acc.provider).length || !acc.base) return push(acc.id, label, false, 'Not set up — import the Hark file');
        try {
          const f = await H.oaCall(acc, 'funds'); const an = await H.oaAnalyzer(acc);
          const d = f.data || {};
          const via = /\.hark\.local/.test(acc.base) ? 'SSH tunnel' : new URL(acc.base).host;
          if (acc.mode === 'LIVE') push(acc.id, label, an === false, 'Cash ' + inr(d.availablecash) + ' · analyzer ' + (an == null ? 'unknown' : an ? 'ON (paper!)' : 'OFF (live)') + ' · via ' + via, an === false ? 'ok' : 'warn');
          else push(acc.id, label, an === true, 'Cash ' + inr(d.availablecash) + ' · analyzer ' + (an == null ? 'unknown' : an ? 'ON (paper)' : 'OFF — orders blocked') + ' · via ' + via, an === true ? 'ok' : 'warn');
        } catch (e) { push(acc.id, label, false, e.message); }
      })());
    }
    if (O) {
      for (const vm of ssh.vms()) {
        tasks.push(ssh.test(vm.id).then((r) => push('vm:' + vm.id, vm.name || vm.host, true, (r.output || 'SSH OK') + ' · ' + r.ms + ' ms'), (e) => push('vm:' + vm.id, vm.name || vm.host, false, e.hostKey ? 'Host key changed! Got ' + e.hostKey + ' — check before trusting' : e.message)));
      }
      const tun = ssh.tunnels();
      if (tun.some((t) => t.vhost === 'openclaw.hark.local')) {
        tasks.push(H.net.request({ url: 'http://openclaw.hark.local/', timeout: 20000 }).then((r) => push('openclaw', 'OpenClaw gateway', r.status > 0 && r.status < 500, 'HTTP ' + r.status + ' on loopback :18789 via SSH'), (e) => push('openclaw', 'OpenClaw gateway', false, e.message)));
      }
      for (const acc of ['tradesmart', 'wisdom']) {
        const tok = runnerToken(acc);
        if (!tok || !tun.some((t) => t.vhost === 'runner-' + acc + '.hark.local')) continue;
        tasks.push(H.net.request({ url: 'http://runner-' + acc + '.hark.local/hark/health', headers: { Authorization: 'Bearer ' + tok }, timeout: 20000 }).then((r) => {
          const j = jparse(r.text, {}); push('runner:' + acc, 'Hark runner · ' + (acc === 'tradesmart' ? 'TradeSmart' : 'Wisdom'), r.status === 200 && j.ok, r.status === 200 ? 'v' + j.version + (j.job ? ' · job running' : '') + ' · ' + (j.mem_mb ? Math.round(j.mem_mb.avail || j.mem_mb.available || 0) + ' MB free' : '') : 'HTTP ' + r.status);
        }, (e) => push('runner:' + acc, 'Hark runner · ' + acc, false, e.message)));
      }
    }
    await Promise.all(tasks);
    const order = ['tradesmart', 'wisdom', 'vm:a1', 'openclaw', 'runner:tradesmart', 'runner:wisdom'];
    out.sort((a, b) => ((order.indexOf(a.id) + 1) || 99) - ((order.indexOf(b.id) + 1) || 99));
    H.settings.lastConnections = { at: Date.now(), items: out }; H.saveSettings();
    return out;
  };

  // ============================================================ Backtester
  const ind = {
    ema(x, n) { const k = 2 / (n + 1); const o = []; let p = null; x.forEach((v, i) => { p = p == null ? v : v * k + p * (1 - k); o.push(i >= n - 1 ? p : null); }); return o; },
    sma(x, n) { const o = []; let s = 0; x.forEach((v, i) => { s += v; if (i >= n) s -= x[i - n]; o.push(i >= n - 1 ? s / n : null); }); return o; },
    std(x, n) { const m = ind.sma(x, n); return x.map((_, i) => { if (m[i] == null) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += (x[j] - m[i]) ** 2; return Math.sqrt(s / n); }); },
    rsi(x, n) { const o = [null]; let g = 0, l = 0; for (let i = 1; i < x.length; i++) { const d = x[i] - x[i - 1]; const up = Math.max(d, 0), dn = Math.max(-d, 0); if (i <= n) { g += up / n; l += dn / n; o.push(i === n ? (l === 0 ? 100 : 100 - 100 / (1 + g / l)) : null); } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o.push(l === 0 ? 100 : 100 - 100 / (1 + g / l)); } } return o; },
    atr(h, l, c, n) { const tr = c.map((_, i) => i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))); const o = []; let a = null; tr.forEach((t, i) => { a = i < n ? (a == null ? t : a + t) : a; if (i === n - 1) a = a / n; else if (i >= n) a = (a * (n - 1) + t) / n; o.push(i >= n - 1 ? a : null); }); return o; },
    supertrend(h, l, c, n, m) {
      const a = ind.atr(h, l, c, n); const dir = []; let ub = null, lb = null, d = 1;
      for (let i = 0; i < c.length; i++) {
        if (a[i] == null) { dir.push(null); continue; }
        const mid = (h[i] + l[i]) / 2; let u = mid + m * a[i], lo = mid - m * a[i];
        if (ub != null && c[i - 1] <= ub) u = Math.min(u, ub);
        if (lb != null && c[i - 1] >= lb) lo = Math.max(lo, lb);
        if (ub != null && c[i] > ub) d = 1; else if (lb != null && c[i] < lb) d = -1;
        ub = u; lb = lo; dir.push(d);
      }
      return dir;
    },
  };
  const STRATS = {
    ema_cross: { desc: 'Long when fast EMA > slow EMA (short when below unless long_only).', params: { fast: 9, slow: 21 }, sig(d, p) { const f = ind.ema(d.c, p.fast), s = ind.ema(d.c, p.slow); return d.c.map((_, i) => f[i] == null || s[i] == null ? 0 : f[i] > s[i] ? 1 : -1); } },
    rsi_reversion: { desc: 'Buy when RSI < low, exit above exit level; short above high.', params: { period: 14, low: 30, high: 70, exit: 50 }, sig(d, p) { const r = ind.rsi(d.c, p.period); let pos = 0; return d.c.map((_, i) => { const v = r[i]; if (v == null) return 0; if (pos === 0) pos = v < p.low ? 1 : v > p.high ? -1 : 0; else if (pos === 1 && v > p.exit) pos = 0; else if (pos === -1 && v < p.exit) pos = 0; return pos; }); } },
    supertrend: { desc: 'Follow Supertrend direction.', params: { period: 10, mult: 3 }, sig(d, p) { return ind.supertrend(d.h, d.l, d.c, p.period, p.mult).map((x) => x || 0); } },
    donchian_breakout: { desc: 'Long on close above the prior N-bar high, exit below the prior M-bar low (mirror for shorts).', params: { n: 20, exit: 10 }, sig(d, p) { let pos = 0; return d.c.map((c, i) => { if (i < p.n) return 0; const hh = Math.max(...d.h.slice(i - p.n, i)), ll = Math.min(...d.l.slice(i - p.n, i)); const xh = Math.max(...d.h.slice(i - p.exit, i)), xl = Math.min(...d.l.slice(i - p.exit, i)); if (pos === 0) pos = c > hh ? 1 : c < ll ? -1 : 0; else if (pos === 1 && c < xl) pos = 0; else if (pos === -1 && c > xh) pos = 0; return pos; }); } },
    macd: { desc: 'Long when MACD > signal line.', params: { fast: 12, slow: 26, signal: 9 }, sig(d, p) { const f = ind.ema(d.c, p.fast), s = ind.ema(d.c, p.slow); const m = d.c.map((_, i) => f[i] == null || s[i] == null ? null : f[i] - s[i]); const mv = m.map((x) => x == null ? 0 : x); const sg = ind.ema(mv, p.signal); return m.map((x, i) => x == null || sg[i] == null || i < p.slow + p.signal ? 0 : x > sg[i] ? 1 : -1); } },
    bollinger_reversion: { desc: 'Buy below the lower band, exit at the middle; short above the upper band.', params: { n: 20, k: 2 }, sig(d, p) { const m = ind.sma(d.c, p.n), s = ind.std(d.c, p.n); let pos = 0; return d.c.map((c, i) => { if (m[i] == null) return 0; const up = m[i] + p.k * s[i], lo = m[i] - p.k * s[i]; if (pos === 0) pos = c < lo ? 1 : c > up ? -1 : 0; else if (pos === 1 && c >= m[i]) pos = 0; else if (pos === -1 && c <= m[i]) pos = 0; return pos; }); } },
    momentum: { desc: 'Long when N-bar rate of change > threshold %.', params: { n: 20, threshold: 0 }, sig(d, p) { return d.c.map((c, i) => i < p.n ? 0 : (c / d.c[i - p.n] - 1) * 100 > p.threshold ? 1 : -1); } },
  };
  H.STRATS = STRATS;
  function candles(data) {
    const rows = Array.isArray(data) ? data : (data && (data.candles || data.data)) || [];
    const out = rows.map((r) => Array.isArray(r) ? { t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] || 0 } : { t: r.timestamp != null ? r.timestamp : r.time != null ? r.time : r.date, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +r.volume || 0 })
      .filter((r) => isFinite(r.c) && r.c > 0);
    out.forEach((r) => { if (typeof r.t === 'number') r.ms = r.t < 1e12 ? r.t * 1000 : r.t; else r.ms = Date.parse(r.t); });
    out.sort((a, b) => a.ms - b.ms);
    return out;
  }
  const istDay = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
  function metrics(trades, curve, capital) {
    const pnl = trades.map((t) => t.net); const wins = pnl.filter((x) => x > 0); const losses = pnl.filter((x) => x <= 0);
    const gp = wins.reduce((a, b) => a + b, 0), gl = -losses.reduce((a, b) => a + b, 0);
    let peak = -Infinity, dd = 0; curve.forEach((p) => { peak = Math.max(peak, p[1]); dd = Math.min(dd, p[1] - peak); });
    const net = pnl.reduce((a, b) => a + b, 0);
    return { trades: trades.length, win_rate_pct: trades.length ? +(100 * wins.length / trades.length).toFixed(1) : 0, net_pnl: +net.toFixed(2), gross_profit: +gp.toFixed(2), gross_loss: +gl.toFixed(2), profit_factor: gl > 0 ? +(gp / gl).toFixed(2) : (gp > 0 ? 'inf' : 0), avg_trade: trades.length ? +(net / trades.length).toFixed(2) : 0, max_drawdown: +dd.toFixed(2), return_on_capital_pct: +(100 * net / capital).toFixed(2), costs_paid: +trades.reduce((a, t) => a + t.cost, 0).toFixed(2) };
  }
  /** Pure backtest on candles. Signals at bar close, fills at the next bar's open. */
  H.backtestCandles = function (rows, o) {
    const S = STRATS[o.strategy]; if (!S) throw new Error('Unknown strategy ' + o.strategy + '. Choose: ' + Object.keys(STRATS).join(', '));
    const p = Object.assign({}, S.params, o.params || {});
    const d = { o: rows.map((r) => r.o), h: rows.map((r) => r.h), l: rows.map((r) => r.l), c: rows.map((r) => r.c) };
    if (rows.length < 30) throw new Error('Not enough candles (' + rows.length + ') for a backtest');
    let sig = S.sig(d, p); if (o.long_only) sig = sig.map((x) => Math.max(0, x));
    const capital = +o.capital || 100000; const costBps = o.cost_bps == null ? 5 : +o.cost_bps; const sl = +o.stop_loss_pct || 0, tp = +o.take_profit_pct || 0;
    const intraday = o.intraday != null ? !!o.intraday : !/^(D|W|M|1d|day)$/i.test(o.interval || 'D');
    const trades = []; const curve = []; let pos = null; let realized = 0;
    const close = (i, px, why) => {
      const gross = pos.dir * pos.qty * (px - pos.px); const cost = (pos.qty * pos.px + pos.qty * px) * costBps / 1e4;
      trades.push({ side: pos.dir > 0 ? 'LONG' : 'SHORT', entry_time: new Date(pos.ms).toISOString(), entry: +pos.px.toFixed(2), exit_time: new Date(rows[i].ms).toISOString(), exit: +px.toFixed(2), qty: pos.qty, net: +(gross - cost).toFixed(2), cost: +cost.toFixed(2), why });
      realized += gross - cost; pos = null;
    };
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]; const want = sig[i - 1];
      if (pos && intraday && istDay(rows[i - 1].ms) !== istDay(r.ms)) close(i - 1, rows[i - 1].c, 'eod');
      if (pos && want !== pos.dir) close(i, r.o, 'signal');
      if (!pos && want !== 0 && !(intraday && i + 1 < rows.length && istDay(rows[i + 1].ms) !== istDay(r.ms))) {
        const qty = Math.floor(capital / r.o); if (qty > 0) pos = { dir: want, px: r.o, qty, ms: r.ms };
      }
      if (pos && (sl || tp)) {
        const stop = pos.dir > 0 ? pos.px * (1 - sl / 100) : pos.px * (1 + sl / 100); const take = pos.dir > 0 ? pos.px * (1 + tp / 100) : pos.px * (1 - tp / 100);
        if (sl && (pos.dir > 0 ? r.l <= stop : r.h >= stop)) close(i, stop, 'stop');
        else if (tp && (pos.dir > 0 ? r.h >= take : r.l <= take)) close(i, take, 'target');
      }
      curve.push([r.ms, realized + (pos ? pos.dir * pos.qty * (r.c - pos.px) : 0)]);
    }
    if (pos) close(rows.length - 1, rows[rows.length - 1].c, 'end');
    const all = metrics(trades, curve, capital);
    const cut = rows[Math.floor(rows.length * 0.7)].ms;
    const oosTrades = trades.filter((t) => Date.parse(t.entry_time) >= cut);
    const isTrades = trades.filter((t) => Date.parse(t.entry_time) < cut);
    const bh = (rows[rows.length - 1].c / rows[0].c - 1) * 100;
    const step = Math.max(1, Math.ceil(curve.length / 300));
    return {
      strategy: o.strategy, params: p, interval: o.interval, bars: rows.length, from: new Date(rows[0].ms).toISOString().slice(0, 10), to: new Date(rows[rows.length - 1].ms).toISOString().slice(0, 10),
      capital_per_trade: capital, cost_bps_per_side: costBps, long_only: !!o.long_only, intraday_squareoff: intraday,
      metrics: all, in_sample_70pct: metrics(isTrades, [], capital), out_of_sample_30pct: metrics(oosTrades, [], capital), buy_and_hold_pct: +bh.toFixed(2),
      last_trades: trades.slice(-12), curve: curve.filter((_, i) => i % step === 0 || i === curve.length - 1),
    };
  };
  H.backtest = async function (a) {
    const acc = H.oaAccount(a.account || 'tradesmart');
    const interval = a.interval || 'D';
    const end = a.end_date || new Date().toISOString().slice(0, 10);
    const start = a.start_date || new Date(Date.now() - (/^D$/i.test(interval) ? 730 : 60) * 864e5).toISOString().slice(0, 10);
    const sym = String(a.symbol || '').toUpperCase(); const ex = String(a.exchange || 'NSE').toUpperCase();
    if (!sym) throw new Error('symbol is required');
    const j = await H.oaCall(acc, 'history', { symbol: sym, exchange: ex, interval, start_date: start, end_date: end });
    const rows = candles(j.data);
    const r = H.backtestCandles(rows, Object.assign({}, a, { interval }));
    r.symbol = sym; r.exchange = ex; r.data_from = acc.name + ' OpenAlgo history';
    r.chart = { title: sym + ' · ' + r.strategy + ' · ' + interval, subtitle: 'Equity (₹, closed + open P&L) · net ' + inr(r.metrics.net_pnl) + ' · PF ' + r.metrics.profit_factor + ' · ' + r.metrics.trades + ' trades', points: r.curve };
    delete r.curve;
    H.state.lastBacktest = r;
    return r;
  };

  // Chart (SVG line with zero line)
  H.chartSvg = function (points, w, h) {
    w = w || 340; h = h || 150;
    if (!points || points.length < 2) return '<svg width="100%" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"></svg>';
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs); let y0 = Math.min(0, ...ys), y1 = Math.max(0, ...ys); if (y1 === y0) y1 = y0 + 1;
    const X = (x) => 6 + (w - 12) * (x - x0) / ((x1 - x0) || 1), Y = (y) => h - 18 - (h - 30) * (y - y0) / (y1 - y0);
    const d = points.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join(' ');
    const last = ys[ys.length - 1]; const col = last >= 0 ? 'var(--ok)' : 'var(--danger)';
    const lab = (t) => new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' });
    return '<svg class="chart" width="100%" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<line x1="6" x2="' + (w - 6) + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '" stroke="var(--line)" stroke-dasharray="3 3"/>' +
      '<path d="' + d + ' L' + X(x1).toFixed(1) + ' ' + Y(0).toFixed(1) + ' L' + X(x0).toFixed(1) + ' ' + Y(0).toFixed(1) + 'Z" fill="' + col + '" opacity=".12"/>' +
      '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="1.8"/>' +
      '<text x="6" y="' + (h - 4) + '" font-size="10" fill="var(--muted)">' + lab(x0) + '</text><text x="' + (w - 6) + '" y="' + (h - 4) + '" font-size="10" text-anchor="end" fill="var(--muted)">' + lab(x1) + '</text>' +
      '<text x="' + (w - 6) + '" y="12" font-size="10" text-anchor="end" fill="var(--muted)">' + inr(y1) + '</text><text x="' + (w - 6) + '" y="' + (Y(y0) - 3).toFixed(1) + '" font-size="10" text-anchor="end" fill="var(--muted)">' + inr(y0) + '</text></svg>';
  };
  H.chartCard = function (c) {
    return el('div', { class: 'chartcard' }, el('b', { text: c.title || 'Chart' }), c.subtitle ? el('small', { text: c.subtitle }) : null, el('div', { html: H.chartSvg(c.points) }));
  };

  // ============================================================ chat tools
  H.opsTools = async function (add, t) {
    if (t.ops === false) return;
    add('connections_check', 'Check Shoeb’s connections: TradeSmart LIVE and Wisdom PAPER (OpenAlgo funds + analyzer), the A1 VM over SSH, the OpenClaw gateway and the Hark runners. Read-only.', { type: 'object', properties: {} },
      async () => ({ checked_at: H.istNow(), items: await H.connections() }), { label: 'Checking connections', sum: () => 'brokers · VM · runners' });
    if (H.oaAccounts().length) {
      add('strategies_list', 'List the built-in backtest strategies and their default parameters (the Hark runners also have their own strategies via backtest_start).', { type: 'object', properties: {} },
        () => Object.keys(STRATS).map((k) => ({ strategy: k, description: STRATS[k].desc, default_params: STRATS[k].params })), { label: 'Strategies', sum: () => Object.keys(STRATS).length + ' built in' });
      add('backtest_run', 'Run a backtest on the phone using OpenAlgo historical candles. Signals at bar close, fills next bar open, costs per side, optional stop/target, intraday square-off for minute bars, 70/30 in-sample/out-of-sample split, equity chart shown to the user. Strategies: ' + Object.keys(STRATS).join(', ') + '.',
        { type: 'object', properties: { account: { type: 'string', enum: H.oaAccounts().map((a) => a.id) }, symbol: { type: 'string' }, exchange: { type: 'string' }, interval: { type: 'string', description: '1m,3m,5m,15m,30m,1h,D' }, start_date: { type: 'string' }, end_date: { type: 'string' }, strategy: { type: 'string', enum: Object.keys(STRATS) }, params: { type: 'object' }, capital: { type: 'number', description: '₹ per trade (default 100000)' }, cost_bps: { type: 'number', description: 'cost per side in basis points (default 5)' }, long_only: { type: 'boolean' }, stop_loss_pct: { type: 'number' }, take_profit_pct: { type: 'number' } }, required: ['symbol', 'strategy'] },
        (a) => H.backtest(a), { label: 'Backtesting', sum: (a) => (a.symbol || '') + ' · ' + a.strategy + ' · ' + (a.interval || 'D') });
    }
    if (!O) return;
    const vms = ssh.vms();
    if (vms.length) {
      add('ssh_servers', 'List Shoeb’s SSH servers (no secrets).', { type: 'object', properties: {} }, () => vms.map((v) => ({ id: v.id, name: v.name, host: v.host, user: v.user, note: v.note })), { label: 'Servers', sum: () => vms.length + ' saved' });
      add('ssh_run', 'Run a shell command on one of Shoeb’s servers over SSH. Read-only commands (status, free, df, ps, ls, cat, grep, logs, docker ps, systemctl status, journalctl, curl GET to localhost…) run immediately and the output shows in chat. Commands that change things open a full-screen ticket and run only after his tap + fingerprint/PIN (unless he turned that off in Safety). Prefer read-only commands (status, logs, df, free, docker ps, systemctl status, journalctl). Never stop or change trading containers, strategies, timers or OpenClaw unless he explicitly asked. Servers: ' + vms.map((v) => v.id + ' = ' + v.name).join('; '),
        { type: 'object', properties: { server: { type: 'string', enum: vms.map((v) => v.id) }, command: { type: 'string' }, timeout_sec: { type: 'integer' } }, required: ['server', 'command'] },
        (a) => H.sshRunTicket(a.server, a.command, a.timeout_sec), { label: 'SSH command', sum: (a) => a.server + ': ' + String(a.command).slice(0, 60), write: true });
    }
    if (oci.info().configured) {
      add('oci_instances', 'List Oracle Cloud instances (name, state, shape, OCPU/memory). Read-only.', { type: 'object', properties: {} }, () => oci.instances(), { label: 'Oracle Cloud', sum: () => 'instances' });
      add('oci_boot_volumes', 'List Oracle Cloud boot volumes. Read-only.', { type: 'object', properties: {} }, () => oci.bootVolumes(), { label: 'Oracle Cloud', sum: () => 'boot volumes' });
      add('oci_usage', 'Always Free usage summary (A1 OCPU/memory, micro VMs, block storage) plus Oracle’s reported limits. Read-only.', { type: 'object', properties: {} }, () => oci.usage(), { label: 'Oracle Cloud', sum: () => 'free-tier usage' });
      add('oci_instance_action', 'Draft an Oracle Cloud instance action as a ticket: START, STOP, SOFTRESET (reboot), RESET (force reboot) or TERMINATE (also needs the instance name typed; boot volume kept unless preserve_boot_volume=false). Runs only after Shoeb taps confirm + fingerprint/PIN. hark-a1 hosts his LIVE trading: warn him before stopping it.',
        { type: 'object', properties: { instance: { type: 'string', description: 'display name or OCID' }, action: { type: 'string', enum: ['START', 'STOP', 'SOFTRESET', 'RESET', 'TERMINATE'] }, preserve_boot_volume: { type: 'boolean' } }, required: ['instance', 'action'] },
        async (a) => { const ins = await oci.instances(); const i = oci.find(ins, a.instance); if (!i) throw new Error('No instance matches ' + a.instance); return H.ociActionTicket(i, a.action, a.preserve_boot_volume); },
        { label: 'Oracle Cloud ticket', sum: (a) => a.action + ' ' + a.instance, write: true });
    }
  };

  // ============================================================ screens
  function screen(title, build) {
    let close;
    const body = el('div', { class: 'body' });
    const s = el('div', { class: 'screen' }, el('div', { class: 'topbar' }, el('button', { class: 'iconbtn', html: icon.back, onclick: () => close() }), el('h2', { text: title })), body);
    close = H.ui.pushOverlay(s);
    const redraw = () => { body.innerHTML = ''; build(body, redraw, close); };
    redraw();
    return close;
  }
  const sec = (t) => el('div', { class: 'sec', text: t });
  const row = (ic, title, sub, fn, right) => el(fn ? 'button' : 'div', { class: 'row', onclick: fn, html: ic || '' }, el('span', { class: 't', html: '<b>' + esc(title) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') }), right || (fn ? el('span', { html: icon.right }) : null));
  const field = (label, input) => el('label', { class: 'field' }, el('span', { text: label }), input);
  const dot = (level) => el('span', { class: 'cdot ' + (level || 'bad') });
  const btn = (text, fn, cls) => el('button', { class: 'btn ' + (cls || 'ghost'), text, onclick: fn });
  const appOnly = (b) => { if (!O) { b.append(el('div', { class: 'note', text: 'SSH, tunnels and Oracle Cloud work in the Shoeb AI Android app (v1.1+). In a browser only broker reads over ngrok are available.' })); return true; } return false; };
  const ui = (H.opsUI = {});

  // ----- Connections -----
  ui.connections = () => screen('Connections', (b, redraw) => {
    const list = el('div', { class: 'card' });
    const when = el('div', { class: 'note' });
    const paint = (items, at) => {
      list.innerHTML = '';
      if (!items || !items.length) list.append(el('div', { class: 'row' }, el('span', { class: 't', html: '<small>Tap “Check now”.</small>' })));
      (items || []).forEach((it) => list.append(el('div', { class: 'row' }, dot(it.level), el('span', { class: 't', html: '<b>' + esc(it.name) + '</b><small>' + esc(it.detail || '') + '</small>' }))));
      when.textContent = at ? 'Checked ' + new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '';
    };
    const last = H.settings.lastConnections; paint(last && last.items, last && last.at);
    const go = btn('Check now', async () => { go.disabled = true; when.textContent = 'Checking…'; try { paint(await H.connections(), Date.now()); } catch (e) { when.textContent = 'Failed: ' + e.message; } go.disabled = false; }, '');
    b.append(el('div', { class: 'note', text: 'Green means reachable and in the expected mode: TradeSmart LIVE with analyzer OFF, Wisdom PAPER with analyzer ON. Loopback services on hark-a1 are reached through SSH tunnels; nothing is exposed to the internet.' }), list, when,
      el('div', { class: 'btns' }, go, btn('Add server', () => ui.addServer()), btn('Servers & terminal', () => ui.servers())));
    if (!last || Date.now() - last.at > 60e3) setTimeout(() => go.click(), 50);
  });

  // ----- Servers, keys, tunnels -----
  ui.servers = () => screen('Servers & terminal', (b, redraw) => {
    if (appOnly(b)) return;
    const vms = ssh.vms();
    b.append(sec('Servers'));
    const card = el('div', { class: 'card' }); b.append(card);
    if (!vms.length) card.append(row(icon.info, 'No servers yet', 'Import the Hark file or add one'));
    vms.forEach((v) => {
      const key = H.vault.list().find((k) => k.id === v.keyId);
      const out = el('div', { class: 'note' });
      card.append(el('div', { class: 'row', style: { flexWrap: 'wrap' } },
        el('span', { class: 't', html: '<b>' + esc(v.name) + '</b><small>' + esc(v.user + '@' + v.host + ':' + v.port) + ' · key ' + esc(key ? key.label : 'none') + '</small><small>Host key ' + esc((v.pins || [])[0] || 'not pinned') + ((v.pins || []).length > 1 ? ' +' + (v.pins.length - 1) : '') + '</small>' }),
        el('div', { class: 'btns', style: { width: '100%' } },
          btn('Test', async () => { out.textContent = 'Connecting…'; try { const r = await ssh.test(v.id); out.textContent = 'OK · ' + r.ms + ' ms' + (r.output ? ' · ' + r.output : ''); } catch (e) { out.textContent = (e.hostKey ? 'Host key mismatch: server sent ' + e.hostKey + '. ' : '') + e.message; } }),
          btn('Terminal', () => ui.terminal(v)), btn('Run command', () => ui.runCommand(v)), btn('Edit', () => ui.addServer(v)), btn('Remove', async () => { await ssh.delVm(v.id); redraw(); })),
        out));
    });
    b.append(el('div', { class: 'btns' }, btn('Add server', () => ui.addServer(null, redraw), '')));

    b.append(sec('SSH keys (stored in the phone vault)'));
    const kc = el('div', { class: 'card' }); b.append(kc);
    const keys = ssh.keys();
    if (!keys.length) kc.append(row(icon.key, 'No SSH keys', 'Paste, pick a file or generate one'));
    keys.forEach((k) => kc.append(row(icon.key, k.label, k.preview, async () => {
      try {
        const i = await ssh.info(k.id);
        const go = await H.ui.modal(k.label, esc(i.type + ' · ' + i.bits + ' bits') + '<br><code style="word-break:break-all">' + esc(i.fingerprint) + '</code><br><br>Public key (safe to share, for authorized_keys):<br><code style="word-break:break-all;font-size:12px">' + esc(i.publicKey) + '</code>', [['Close', false, 'ghost'], ['Delete key', 'del', 'danger'], ['Copy public key', 'copy']]);
        if (go === 'copy') H.copy(i.publicKey);
        if (go === 'del') { const ok = await H.ui.modal('Delete this key?', 'Servers using it will stop connecting until you choose another key.', [['Cancel', false, 'ghost'], ['Delete', true, 'danger']]); if (ok) { H.vault.del(k.id); H.vault.del(k.id + '_p'); redraw(); } }
      } catch (e) { H.toast(e.message, 4000); }
    })));
    const label = el('input', { placeholder: 'Label, e.g. “New VM key”' });
    const pem = el('textarea', { placeholder: 'Paste the whole private key file (OpenSSH or PEM text)', autocomplete: 'off', spellcheck: 'false', style: { fontFamily: 'var(--mono)', fontSize: '12px' } });
    const pass = el('input', { type: 'password', placeholder: 'Passphrase (only if the key has one)', autocomplete: 'off' });
    const st = el('div', { class: 'note' });
    const done = (r) => { if (r && r.cancelled) { st.textContent = 'Cancelled'; return; } st.textContent = 'Saved “' + r.label + '” · ' + r.type + ' ' + r.bits + ' · ' + r.fingerprint; pem.value = ''; pass.value = ''; setTimeout(redraw, 1200); };
    b.append(el('div', { class: 'card', style: { padding: '4px 14px 12px', marginTop: '10px' } }, field('Label', label), field('Private key (OpenSSH, PEM, PKCS#8, ed25519, PuTTY)', pem), field('Passphrase', pass),
      el('div', { class: 'btns' },
        btn('Save pasted key', async () => { st.textContent = 'Checking…'; try { done(await ssh.savePasted(label.value.trim(), pem.value, pass.value)); } catch (e) { st.textContent = 'Couldn’t use that key: ' + e.message; } }, ''),
        btn('Pick key file', async () => { try { done(await ssh.pick(label.value.trim())); } catch (e) { st.textContent = 'Couldn’t use that file: ' + e.message; } }),
        btn('Generate on phone', async () => { try { const r = await ssh.generate(label.value.trim() || 'Phone key'); done(r); const i = await ssh.info(r.id); H.ui.modal('Add this to the server', 'Append this line to <code>~/.ssh/authorized_keys</code> on the new server:<br><br><code style="word-break:break-all;font-size:12px">' + esc(i.publicKey) + '</code>', [['Done', false, 'ghost'], ['Copy', true]]).then((c) => c && H.copy(i.publicKey)); } catch (e) { st.textContent = e.message; } })),
      st));

    b.append(sec('SSH tunnels (loopback services)'));
    const tc = el('div', { class: 'card' }); b.append(tc);
    const tun = ssh.tunnels();
    if (!tun.length) tc.append(row(icon.plug, 'No tunnels', 'Imported with the Hark file'));
    tun.forEach((t) => tc.append(row(icon.plug, t.name || t.vhost, t.vhost + ' → ' + t.vm + ' 127.0.0.1:' + t.remotePort)));
    const vh = el('input', { placeholder: 'myservice.hark.local' }); const port = el('input', { type: 'number', placeholder: '8080' });
    const vmSel = el('select', null, vms.map((v) => el('option', { value: v.id, text: v.name })));
    const kSel = el('select', null, el('option', { value: '', text: 'Server’s default key' }), keys.map((k) => el('option', { value: k.id, text: k.label })));
    b.append(el('div', { class: 'card', style: { padding: '4px 14px 12px', marginTop: '10px' } }, field('Address in the app', vh), field('Server', vmSel), field('Remote port on 127.0.0.1', port), field('Key', kSel),
      btn('Add tunnel', async () => { try { const r = await ssh.saveTunnel({ vhost: vh.value.trim(), vm: vmSel.value, remotePort: +port.value, keyId: kSel.value, name: vh.value.trim() }); if (!r.cancelled) redraw(); } catch (e) { H.toast(e.message, 4000); } }, 'block')));
  });

  ui.addServer = (vm, after) => screen(vm ? 'Edit server' : 'Add server', (b) => {
    if (appOnly(b)) return;
    vm = vm || {};
    const name = el('input', { value: vm.name || '', placeholder: 'e.g. Oracle VM 2' });
    const host = el('input', { value: vm.host || '', placeholder: 'IP or hostname', autocapitalize: 'off' });
    const port = el('input', { type: 'number', value: vm.port || 22 });
    const user = el('input', { value: vm.user || 'ubuntu', autocapitalize: 'off' });
    const keys = ssh.keys();
    const kSel = el('select', null, keys.map((k) => el('option', { value: k.id, text: k.label + ' · ' + (k.preview || '') })));
    if (vm.keyId) kSel.value = vm.keyId;
    let pins = (vm.pins || []).slice();
    const pinBox = el('div', { class: 'note', text: pins.length ? 'Trusted host key: ' + pins.join(', ') : 'Host key not read yet' });
    const st = el('div', { class: 'note' });
    b.append(el('div', { class: 'note', text: 'Hark pins the server’s host key, so a changed or fake server is refused. Compare the fingerprint with the one on the server (Oracle: instance console connection, or `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).' }),
      el('div', { class: 'card', style: { padding: '4px 14px 12px' } }, field('Name', name), field('Host', host), field('Port', port), field('User', user), field('SSH key', kSel), pinBox,
        el('div', { class: 'btns' },
          btn('Read host key', async () => { pinBox.textContent = 'Reading…'; try { const r = await ssh.scan(host.value.trim(), +port.value); pins = [r.fingerprint]; pinBox.textContent = 'Server sent ' + r.type + ' ' + r.fingerprint + '. Saving will ask you to trust it.'; } catch (e) { pinBox.textContent = e.message; } }),
          btn('Save', async () => {
            if (!keys.length) return H.toast('Add an SSH key first (Servers & terminal → SSH keys)');
            if (!pins.length) return H.toast('Read the host key first');
            st.textContent = 'Saving…';
            try {
              const r = await ssh.saveVm({ id: vm.id, name: name.value.trim(), host: host.value.trim(), port: +port.value || 22, user: user.value.trim(), keyId: kSel.value, pins, note: vm.note || '' });
              if (r.cancelled) { st.textContent = 'Not saved'; return; }
              st.textContent = 'Saved. Testing…';
              const t = await ssh.test(r.id).catch((e) => ({ error: e.message }));
              st.textContent = t.error ? 'Saved, but the test failed: ' + t.error : 'Connected in ' + t.ms + ' ms' + (t.output ? ' · ' + t.output : '');
              if (after) after();
            } catch (e) { st.textContent = e.message; }
          }, '')), st));
  });

  ui.runCommand = (vm) => screen('Run on ' + (vm.name || vm.host), (b) => {
    const cmd = el('textarea', { placeholder: 'e.g. docker ps --format "{{.Names}}  {{.Status}}"', spellcheck: 'false', autocapitalize: 'off', style: { fontFamily: 'var(--mono)', fontSize: '13px' } });
    const out = el('pre', { class: 'term small' });
    const quick = ['uptime; free -m; df -h /', 'docker ps --format "{{.Names}}  {{.Status}}"', 'systemctl list-timers --no-pager | head -25', 'journalctl -u hark-runner -n 40 --no-pager', 'tail -n 40 ~/logs/oa-notify.log'];
    b.append(el('div', { class: 'note', text: 'Each command opens a ticket and runs only after you confirm with fingerprint/PIN.' }), field('Command', cmd),
      el('div', { class: 'chips' }, quick.map((q) => el('button', { class: 'chip', text: q.length > 34 ? q.slice(0, 32) + '…' : q, onclick: () => { cmd.value = q; } }))),
      btn('Run', async () => { if (!cmd.value.trim()) return; out.textContent = ''; const r = await H.sshRunTicket(vm.id, cmd.value.trim()); out.textContent = r.output != null ? stripAnsi(r.output) + '\n[exit ' + r.exit_code + ']' : (r.error || r.message || ''); }, 'block'), out);
  });

  // ----- Terminal -----
  function stripAnsi(s) { return String(s).replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/\x1b[=>]/g, ''); }
  ui.terminal = (vm) => {
    let sid = null; let buf = ''; const MAX = 60000; const cbId = H.newId('term');
    const out = el('pre', { class: 'term' });
    const input = el('input', { class: 'term-in', placeholder: 'Type a command, Enter to send', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
    const send = (t) => { if (sid) O.sshShellWrite(sid, t); };
    const paint = () => { out.textContent = buf; out.scrollTop = out.scrollHeight; };
    const write = (t) => {
      t = stripAnsi(t);
      for (const ch of t) {
        if (ch === '\r') continue;
        if (ch === '\b' || ch === '\x7f') { buf = buf.slice(0, -1); continue; }
        if (ch === '\x07') continue;
        buf += ch;
      }
      if (buf.length > MAX) buf = buf.slice(-MAX);
      paint();
    };
    const close = screen('Terminal · ' + (vm.name || vm.host), (b) => {
      const keys = [['Ctrl-C', '\x03'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['Esc', '\x1b'], ['Ctrl-D', '\x04'], ['q', 'q']];
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(input.value + '\n'); input.value = ''; } });
      b.classList.add('termbody');
      b.append(out, el('div', { class: 'term-keys' }, keys.map(([l, s]) => el('button', { class: 'chip', text: l, onclick: () => send(s) })), el('button', { class: 'chip', text: 'Clear', onclick: () => { buf = ''; paint(); } })),
        el('div', { class: 'term-row' }, input, el('button', { class: 'btn', text: 'Send', onclick: () => { send(input.value + '\n'); input.value = ''; } })));
    });
    if (!O) { write('Terminal needs the Android app.\n'); return; }
    write('Connecting to ' + vm.user + '@' + vm.host + ' (confirm with fingerprint/PIN)…\n');
    H.nativeCallRaw(cbId, (type, d) => {
      if (type === 'open') { sid = d.sid; write('Connected. Host key verified.\n'); setTimeout(() => input.focus(), 200); }
      else if (type === 'data') write(d.t);
      else if (type === 'closed') { write('\n[session closed]\n'); sid = null; H.nativeDone(cbId); }
      else if (type === 'err') { write('\n' + (d.hostKey ? 'Host key mismatch (' + d.hostKey + '). Refusing to connect.\n' : '') + 'Error: ' + d.message + '\n'); H.nativeDone(cbId); }
    });
    const cols = Math.max(40, Math.floor((window.innerWidth - 24) / 7.4)); const rows = Math.max(12, Math.floor((window.innerHeight - 200) / 15));
    O.sshShellOpen(cbId, vm.id, cols, rows);
    const ov = H.state.overlays[H.state.overlays.length - 1];
    if (ov) { const prev = ov.onClose; ov.onClose = () => { if (sid) O.sshShellClose(sid); H.nativeDone(cbId); prev && prev(); }; }
    return close;
  };

  // ----- Oracle Cloud -----
  ui.oci = () => screen('Oracle Cloud', (b, redraw) => {
    if (appOnly(b)) return;
    const info = oci.info();
    if (!info.configured) { b.append(el('div', { class: 'note', text: 'Import the v2 Hark file to add your Oracle Cloud API key (it stays in the phone vault and signs requests natively).' })); return; }
    const usage = el('div', { class: 'card' }, row(icon.info, 'Loading…', ''));
    const insCard = el('div', { class: 'card' }, row(icon.info, 'Loading…', ''));
    const volCard = el('div', { class: 'card' }, row(icon.info, 'Loading…', ''));
    b.append(el('div', { class: 'note', text: 'Region ' + info.region + ' · API key …' + info.fingerprintTail + '. Start/stop/reboot/terminate open a ticket and need fingerprint/PIN; terminate also needs the name typed.' }),
      sec('Free-tier usage'), usage, sec('Instances'), insCard, sec('Boot volumes'), volCard, el('div', { class: 'btns' }, btn('Refresh', redraw, '')));
    oci.usage().then((u) => {
      usage.innerHTML = '';
      u.items.forEach((it) => { const pct = Math.min(100, Math.round(100 * it.used / it.free)); usage.append(el('div', { class: 'row' }, el('span', { class: 't', html: '<b>' + esc(it.name) + '</b><small>' + esc(it.used + ' of ' + it.free + ' ' + it.unit + ' Always Free') + '</small><div class="bar"><i style="width:' + pct + '%" class="' + (pct > 100 ? 'over' : '') + '"></i></div>' }))); });
      const l = u.limits['standard-a1-core-count']; const m = u.limits['standard-a1-memory-count'];
      if (l || m) usage.append(el('div', { class: 'row' }, el('span', { class: 't', html: '<b>Oracle-reported A1 limits</b><small>' + esc((l ? 'OCPU used ' + l.used + ', available ' + l.available : '') + (m ? ' · memory used ' + m.used + ' GB, available ' + m.available + ' GB' : '')) + '</small>' })));
      usage.append(el('div', { class: 'row' }, el('span', { class: 't', html: '<small>' + esc(u.note) + '</small>' })));
    }).catch((e) => { usage.innerHTML = ''; usage.append(row(icon.info, 'Couldn’t load usage', e.message)); });
    oci.instances().then((ins) => {
      insCard.innerHTML = '';
      if (!ins.length) insCard.append(row(icon.info, 'No instances', ''));
      ins.forEach((i) => {
        const lvl = i.state === 'RUNNING' ? 'ok' : /STOP|TERMINAT/.test(i.state) ? 'bad' : 'warn';
        const act = (a) => async () => { const r = await H.ociActionTicket(i, a); if (r.status === 'requested_after_user_confirmation') setTimeout(redraw, 1500); else if (r.error) H.toast(r.error, 5000); };
        insCard.append(el('div', { class: 'row', style: { flexWrap: 'wrap' } }, dot(lvl),
          el('span', { class: 't', html: '<b>' + esc(i.name) + '</b><small>' + esc(i.state + ' · ' + i.shape + ' · ' + (i.ocpus || '?') + ' OCPU / ' + (i.memoryGb || '?') + ' GB · ' + (i.ad || '').split(':').pop()) + '</small>' }),
          el('div', { class: 'btns', style: { width: '100%' } },
            i.state === 'STOPPED' ? btn('Start', act('START')) : null,
            i.state === 'RUNNING' ? btn('Stop', act('SOFTSTOP')) : null,
            i.state === 'RUNNING' ? btn('Reboot', act('SOFTRESET')) : null,
            btn('Terminate', act('TERMINATE'), 'ghost danger-text'))));
      });
    }).catch((e) => { insCard.innerHTML = ''; insCard.append(row(icon.info, 'Couldn’t list instances', e.message)); });
    oci.bootVolumes().then((v) => { volCard.innerHTML = ''; if (!v.length) volCard.append(row(icon.info, 'No boot volumes', '')); v.forEach((x) => volCard.append(row(icon.doc, x.name, x.sizeGb + ' GB · ' + x.state + ' · ' + (x.vpus || 10) + ' VPU/GB'))); })
      .catch((e) => { volCard.innerHTML = ''; volCard.append(row(icon.info, 'Couldn’t list volumes', e.message)); });
  });

  // ----- Trade desk -----
  ui.trade = (accId) => screen('Trade desk', (b, redraw) => {
    const accs = H.oaAccounts();
    if (!accs.length) { b.append(el('div', { class: 'note', text: 'Import the Hark file to connect TradeSmart and Wisdom.' })); return; }
    const acc = accs.find((a) => a.id === (accId || H.state.tradeAcc)) || accs[0]; H.state.tradeAcc = acc.id;
    const live = acc.mode === 'LIVE';
    b.append(el('div', { class: 'seg' }, accs.map((a) => el('button', { class: a.id === acc.id ? 'on' : '', text: a.name + (a.mode === 'LIVE' ? ' · LIVE' : ' · PAPER'), onclick: () => { H.state.tradeAcc = a.id; redraw(); } }))));
    const head = el('div', { class: 'tradehead ' + (live ? 'live' : 'paper') }, el('span', { class: 'modebadge ' + (live ? 'live' : 'paper'), text: live ? 'LIVE' : 'PAPER' }), el('span', { text: 'Loading…' }));
    b.append(head);
    const t = (kind, extra) => async () => { const r = await H.trade(kind, Object.assign({ account: acc.id }, extra || {})).catch((e) => ({ status: 'error', message: e.message })); if (r.status === 'sent_after_user_confirmation') setTimeout(redraw, 800); else if (r.status !== 'declined') H.toast(r.message || r.error || r.status, 4500); };
    b.append(el('div', { class: 'btns' }, btn('New order', () => ui.orderForm(acc, 'place', {}, redraw), ''), btn('Smart order', () => ui.orderForm(acc, 'smart', {}, redraw)), btn('Basket', () => ui.basketForm(acc, redraw)), btn('Cancel all', t('cancel_all')), btn('Close all', t('close_all')), btn('Analyzer…', async () => { const on = await H.oaAnalyzer(acc); t('analyzer', { mode: !on })(); })));
    const tabs = ['positions', 'orders', 'trades', 'holdings', 'funds']; const cur = H.state.tradeTab || 'positions';
    b.append(el('div', { class: 'seg', style: { marginTop: '10px' } }, tabs.map((x) => el('button', { class: x === cur ? 'on' : '', text: x[0].toUpperCase() + x.slice(1), onclick: () => { H.state.tradeTab = x; redraw(); } }))));
    const box = el('div', { class: 'card', style: { marginTop: '8px' } }, row(icon.info, 'Loading…', '')); b.append(box);
    Promise.all([H.oaCall(acc, 'funds').catch(() => null), H.oaAnalyzer(acc)]).then(([f, an]) => {
      const d = (f && f.data) || {};
      head.lastChild.textContent = acc.name + ' · cash ' + inr(d.availablecash) + ' · P&L ' + inr(H.num(d.m2mrealized) + H.num(d.m2munrealized)) + ' · analyzer ' + (an == null ? '?' : an ? 'ON' : 'OFF');
    });
    const ep = { positions: 'positionbook', orders: 'orderbook', trades: 'tradebook', holdings: 'holdings', funds: 'funds' }[cur];
    H.oaCall(acc, ep).then((j) => {
      box.innerHTML = '';
      let data = j.data;
      if (cur === 'orders' && data && data.orders) data = data.orders;
      if (cur === 'holdings' && data && data.holdings) data = data.holdings;
      if (cur === 'funds') { Object.keys(data || {}).forEach((k) => box.append(row(null, k, String(data[k])))); return; }
      if (!Array.isArray(data) || !data.length) { box.append(row(icon.info, 'Nothing here', '')); return; }
      data.slice(0, 100).forEach((x) => {
        if (cur === 'positions') {
          const q = H.num(x.quantity);
          box.append(el('div', { class: 'row' }, el('span', { class: 't', html: '<b>' + esc(x.symbol) + ' <small style="display:inline">' + esc(x.exchange + ' · ' + x.product) + '</small></b><small>Qty ' + esc(x.quantity) + ' · avg ' + esc(x.average_price) + ' · LTP ' + esc(x.ltp) + ' · P&L ' + esc(x.pnl) + '</small>' }),
            q !== 0 ? btn('Exit', async () => { const r = await H.trade('smart', { account: acc.id, symbol: x.symbol, exchange: x.exchange, product: x.product, action: q > 0 ? 'SELL' : 'BUY', quantity: Math.abs(q), pricetype: 'MARKET', position_size: 0 }).catch((e) => ({ message: e.message })); if (r.status === 'sent_after_user_confirmation') setTimeout(redraw, 800); else if (r.status !== 'declined') H.toast(r.message || r.status, 4000); }) : null));
        } else if (cur === 'orders') {
          const open = /open|pending|trigger/i.test(x.order_status || x.status || '');
          box.append(el('div', { class: 'row', style: { flexWrap: 'wrap' } }, el('span', { class: 't', html: '<b>' + esc((x.action || '') + ' ' + (x.quantity || '') + ' ' + (x.symbol || '')) + '</b><small>' + esc((x.order_status || x.status || '') + ' · ' + (x.pricetype || '') + ' ' + (x.price || '') + ' · ' + (x.orderid || '') + ' · ' + (x.timestamp || '')) + '</small>' }),
            open ? el('div', { class: 'btns', style: { width: '100%' } }, btn('Modify', () => ui.orderForm(acc, 'modify', x, redraw)), btn('Cancel', t('cancel', { orderid: x.orderid, symbol: x.symbol }))) : null));
        } else {
          box.append(row(null, (x.action ? x.action + ' ' : '') + (x.quantity || '') + ' ' + (x.symbol || x.tradingsymbol || ''), Object.keys(x).filter((k) => !['symbol', 'action', 'quantity'].includes(k)).slice(0, 6).map((k) => k + ' ' + x[k]).join(' · ')));
        }
      });
    }).catch((e) => { box.innerHTML = ''; box.append(row(icon.info, 'Couldn’t load ' + cur, e.message)); });
  });

  ui.orderForm = (acc, kind, pre, after) => H.ui.sheet((kind === 'modify' ? 'Modify order' : kind === 'smart' ? 'Smart order' : 'New order') + ' · ' + acc.name + (acc.mode === 'LIVE' ? ' LIVE' : ' PAPER'), (b, close) => {
    pre = pre || {};
    const sel = (opts, v) => { const s = el('select', null, opts.map((o) => el('option', { value: o, text: o }))); if (v) s.value = String(v).toUpperCase(); return s; };
    const f = {
      symbol: el('input', { value: pre.symbol || '', placeholder: 'SBIN', autocapitalize: 'characters' }), exchange: sel(['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'], pre.exchange),
      action: sel(['BUY', 'SELL'], pre.action), quantity: el('input', { type: 'number', value: pre.quantity || '' }), product: sel(['MIS', 'CNC', 'NRML'], pre.product),
      pricetype: sel(['MARKET', 'LIMIT', 'SL', 'SL-M'], pre.pricetype), price: el('input', { type: 'number', step: '0.05', value: pre.price || '' }), trigger_price: el('input', { type: 'number', step: '0.05', value: pre.trigger_price || '' }),
    };
    const ps = el('input', { type: 'number', placeholder: 'target net position, e.g. 0 to exit' });
    b.append(el('div', { style: { padding: '0 6px' } }, ...Object.keys(f).map((k) => field(k.replace('_', ' '), f[k])), kind === 'smart' ? field('Position size', ps) : null,
      el('button', { class: 'btn block', text: 'Review ticket', onclick: async () => {
        const a = { account: acc.id }; Object.keys(f).forEach((k) => (a[k] = f[k].value)); a.quantity = +a.quantity; a.price = +a.price || 0; a.trigger_price = +a.trigger_price || 0;
        if (kind === 'modify') a.orderid = pre.orderid; if (kind === 'smart') a.position_size = +ps.value;
        close();
        const r = await H.trade(kind, a).catch((e) => ({ message: e.message }));
        if (r.status === 'sent_after_user_confirmation') after && setTimeout(after, 800); else if (r.status !== 'declined') H.toast(r.message || r.error || r.status, 4500);
      } })));
  });

  ui.basketForm = (acc, after) => H.ui.sheet('Basket · ' + acc.name, (b, close) => {
    const ta = el('textarea', { placeholder: 'One order per line:\nBUY 10 SBIN NSE MIS\nSELL 5 INFY NSE CNC LIMIT 1500', style: { fontFamily: 'var(--mono)', minHeight: '140px' } });
    b.append(el('div', { style: { padding: '0 6px' } }, field('Orders', ta), el('button', { class: 'btn block', text: 'Review ticket', onclick: async () => {
      try {
        const orders = ta.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const p = l.split(/\s+/); return { action: p[0], quantity: +p[1], symbol: p[2], exchange: p[3] || 'NSE', product: p[4] || 'MIS', pricetype: p[5] || 'MARKET', price: +p[6] || 0 }; });
        close();
        const r = await H.trade('basket', { account: acc.id, orders });
        if (r.status === 'sent_after_user_confirmation') after && setTimeout(after, 800); else if (r.status !== 'declined') H.toast(r.message || r.error || r.status, 4500);
      } catch (e) { H.toast(e.message, 4000); }
    } })));
  });

  // ----- Backtest -----
  ui.backtest = () => screen('Backtest', (b) => {
    const accs = H.oaAccounts();
    if (!accs.length) { b.append(el('div', { class: 'note', text: 'Import the Hark file to load OpenAlgo history.' })); return; }
    const accSel = el('select', null, accs.map((a) => el('option', { value: a.id, text: a.name + ' history' })));
    const sym = el('input', { value: 'NIFTYBEES', autocapitalize: 'characters' }); const ex = el('select', null, ['NSE', 'NSE_INDEX', 'BSE', 'NFO', 'MCX'].map((x) => el('option', { value: x, text: x })));
    const iv = el('select', null, ['D', '1h', '30m', '15m', '5m'].map((x) => el('option', { value: x, text: x })));
    const st = el('select', null, Object.keys(STRATS).map((x) => el('option', { value: x, text: x })));
    const params = el('input', { placeholder: 'params JSON, e.g. {"fast":9,"slow":21}' });
    const start = el('input', { type: 'date', value: new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10) }); const end = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const cap = el('input', { type: 'number', value: 100000 }); const cost = el('input', { type: 'number', value: 5, step: '0.5' });
    const lo = el('input', { type: 'checkbox' }); lo.checked = true;
    const desc = el('div', { class: 'note' }); const upd = () => { const s = STRATS[st.value]; desc.textContent = s.desc + ' Defaults: ' + JSON.stringify(s.params); }; st.onchange = upd; upd();
    const out = el('div');
    b.append(el('div', { class: 'card', style: { padding: '4px 14px 12px' } }, field('Data', accSel), field('Symbol', sym), field('Exchange', ex), field('Interval', iv), field('Strategy', st), desc, field('Parameters', params), field('From', start), field('To', end), field('₹ per trade', cap), field('Cost per side (bps)', cost),
      el('label', { class: 'row', style: { padding: '8px 0', border: 0 } }, el('span', { class: 't', html: '<b>Long only</b>' }), el('span', { class: 'switch' }, lo, el('i'))),
      el('button', { class: 'btn block', text: 'Run backtest', onclick: async (e) => {
        e.target.disabled = true; out.innerHTML = '<div class="note">Downloading candles and testing…</div>';
        try {
          const r = await H.backtest({ account: accSel.value, symbol: sym.value, exchange: ex.value, interval: iv.value, strategy: st.value, params: params.value.trim() ? JSON.parse(params.value) : {}, start_date: start.value, end_date: end.value, capital: +cap.value, cost_bps: +cost.value, long_only: lo.checked });
          out.innerHTML = ''; out.append(H.chartCard(r.chart), btResultTable(r));
        } catch (err) { out.innerHTML = ''; out.append(el('div', { class: 'err', text: err.message })); }
        e.target.disabled = false;
      } })),
      el('div', { class: 'note', text: 'Runs on the phone with OpenAlgo candles: signals at bar close, fills at the next open, costs on both sides, intraday positions squared off at day end, 70/30 in/out-of-sample split. For long runs or the runners’ strategies, ask in chat (runner backtest_start).' }), out);
  });
  function btResultTable(r) {
    const m = r.metrics, i = r.in_sample_70pct, o = r.out_of_sample_30pct;
    const rowH = (k, a, b2, c) => '<tr><td>' + k + '</td><td>' + a + '</td><td>' + b2 + '</td><td>' + c + '</td></tr>';
    return el('div', { class: 'content', html: '<table><thead><tr><th></th><th>All</th><th>In-sample</th><th>Out-of-sample</th></tr></thead><tbody>' +
      rowH('Trades', m.trades, i.trades, o.trades) + rowH('Win rate', m.win_rate_pct + '%', i.win_rate_pct + '%', o.win_rate_pct + '%') + rowH('Net P&L', inr(m.net_pnl), inr(i.net_pnl), inr(o.net_pnl)) +
      rowH('Profit factor', m.profit_factor, i.profit_factor, o.profit_factor) + rowH('Avg trade', inr(m.avg_trade), inr(i.avg_trade), inr(o.avg_trade)) + rowH('Costs', inr(m.costs_paid), inr(i.costs_paid), inr(o.costs_paid)) +
      '</tbody></table><p class="note">Max drawdown ' + inr(m.max_drawdown) + ' · buy &amp; hold ' + r.buy_and_hold_pct + '% · ' + r.bars + ' bars ' + r.from + ' → ' + r.to + '</p>' });
  }
})();
