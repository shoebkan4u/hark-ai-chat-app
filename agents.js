/* Shoeb AI — agent modes: Hermes Agent and Aider on hark-a1, run over the app's own SSH connection.
   A chat can be in one of three modes (picked next to the model): Hark AI (the normal model chat), Hermes or Aider.
   Agent runs start detached on the server (nohup + setsid, output to ~/.hark-agent/<run>.log) and the app follows the
   log with `tail -f --pid`, so a dropped link or the 15-minute exec cap only means re-attaching from the last byte;
   the agent itself keeps going. Everything runs at once (no confirmation), as Shoeb asked. The phone's foreground
   service + wake lock (KeepAlive) is held by the native exec for as long as the log is being followed.
   Hermes: `hermes chat --query-file - --format stream-json --continue shoebai-<chat> --create-if-missing --yolo`
   (one Hermes session per chat). Aider: `aider --yes-always --message-file … --env-file ~/.aider/keys.env` in a
   working directory the user picks (default /home/ubuntu); the new commits and their diff are shown afterwards. */
(function () {
  'use strict';
  const H = window.Hark;
  const el = H.el;
  const MODES = { hark: 'Hark AI', hermes: 'Hermes', aider: 'Aider' };
  const AIDER = '/home/ubuntu/.local/bin/aider';
  const EXIT_RE = /\n?__HARK_EXIT__:(-?\d+)\s*$/;
  const DIFF_MARK = '__HARK_DIFF__';
  const MAX_ATTACH = 12; // re-attaches (each native exec is capped at 15 min) ≈ 3 h per run

  const st = () => H.settings.agents || (H.settings.agents = { aiderDir: '/home/ubuntu' });
  const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const b64 = (s) => { const u = new TextEncoder().encode(String(s)); let b = ''; for (let i = 0; i < u.length; i += 0x8000) b += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(b); };
  const blen = (s) => new TextEncoder().encode(s).length;
  const stripAnsi = (s) => String(s).replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n');

  const agents = (H.agents = {
    MODES,
    mode(chat) { return (chat && MODES[chat.agent] && chat.agent) || 'hark'; },
    active(chat) { return this.mode(chat) !== 'hark'; },
    label(chat) {
      const m = this.mode(chat);
      if (m === 'hermes') return 'Hermes · hark-a1';
      if (m === 'aider') return 'Aider · ' + (chat.aiderDir || st().aiderDir || '/home/ubuntu').replace(/^\/home\/ubuntu/, '~');
      return null;
    },
    setMode(chat, m, dir) {
      chat.agent = MODES[m] ? m : 'hark';
      if (m === 'aider') { const d = String(dir || chat.aiderDir || st().aiderDir || '/home/ubuntu').trim() || '/home/ubuntu'; chat.aiderDir = d; st().aiderDir = d; }
      H.saveSettings();
    },
    /** hark-a1 (by id or name), else the only server. */
    server() {
      const vms = H.ssh ? H.ssh.vms() : [];
      return vms.find((v) => v.id === 'a1' || /hark-a1/i.test(v.name || '')) || (vms.length === 1 ? vms[0] : null);
    },
    /**
     * Hermes session for this chat. After a Stop, the stopped turn can stay "active" in that session and the next
     * --continue would first replay/finish it (the 1.1.8 "new message after Stop hangs" bug), so a stopped chat moves
     * to a fresh session name (…-g<n>) and the next prompt carries a short recap of the conversation instead.
     */
    sessionName(chat) { return 'shoebai-' + String(chat.id).replace(/[^A-Za-z0-9_-]/g, '') + (chat.hermesGen ? '-g' + chat.hermesGen : ''); },
    /** Recap of the chat so far (for a fresh Hermes session after a Stop). */
    recap(chat, uptoIdx) {
      const msgs = (chat.messages || []).slice(0, uptoIdx).filter((m) => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim());
      const tail = msgs.slice(-8).map((m) => (m.role === 'user' ? 'Shoeb: ' : 'You: ') + String(m.content).replace(/\s+/g, ' ').slice(0, 600));
      return tail.length ? '[Earlier in this conversation (the previous run was stopped by Shoeb):]\n' + tail.join('\n') + '\n[Now:]\n' : '';
    },

    /** The bash script that runs on the server (written there via base64, so nothing in the prompt is shell-interpreted). */
    script(mode, chat, prompt) {
      const p = b64(prompt);
      if (mode === 'hermes') {
        const prev = chat.hermesPrevSession;
        return [
          '#!/bin/bash',
          // Make sure nothing from a stopped run of this chat is still alive (wait up to 15 s, then kill it).
          ...(prev ? [
            'S=' + shq(prev + '([^A-Za-z0-9_-]|$)'),
            'for i in $(seq 1 30); do pgrep -u hermes -f -- "$S" >/dev/null || break; sleep 0.5; done',
            'for h in $(pgrep -u hermes -f -- "$S"); do sudo -n kill -KILL "$h" 2>/dev/null; done',
          ] : []),
          'echo ' + shq(p) + ' | base64 -d | sudo -n -iu hermes hermes chat --query-file - --format stream-json'
            + ' --continue ' + shq(this.sessionName(chat)) + ' --create-if-missing --yolo --accept-hooks',
          'rc=$?',
          'echo "__HARK_EXIT__:$rc"',
        ].join('\n') + '\n';
      }
      const dir = chat.aiderDir || st().aiderDir || '/home/ubuntu';
      return [
        '#!/bin/bash',
        'cd ' + shq(dir) + ' || { echo "No such directory: "' + shq(dir) + '; echo "__HARK_EXIT__:2"; exit 2; }',
        'G=""; git rev-parse --is-inside-work-tree >/dev/null 2>&1 || G="--no-git"',
        'B=$(git rev-parse HEAD 2>/dev/null)',
        'M=$(mktemp); echo ' + shq(p) + ' | base64 -d > "$M"',
        'E=""; [ -f ~/.aider/keys.env ] && E="--env-file $HOME/.aider/keys.env"',
        AIDER + ' --yes-always --no-pretty --no-fancy-input --stream --show-diffs --no-check-update --no-show-release-notes $E $G --message-file "$M" < /dev/null',
        'rc=$?; rm -f "$M"',
        'if [ -z "$G" ]; then',
        '  A=$(git rev-parse HEAD 2>/dev/null)',
        '  if [ -n "$A" ] && [ "$A" != "$B" ]; then',
        '    echo "' + DIFF_MARK + '"',
        '    if [ -n "$B" ]; then R="$B..$A"; else R="$A"; fi',
        '    git --no-pager log --oneline --no-decorate $R | head -20',
        '    echo "---"',
        '    if [ -n "$B" ]; then git --no-pager diff --stat "$B" "$A"; git --no-pager diff "$B" "$A" | head -c 60000; else git --no-pager show --stat --format= "$A"; git --no-pager show --format= "$A" | head -c 60000; fi',
        '  fi',
        'fi',
        'echo "__HARK_EXIT__:$rc"',
      ].join('\n') + '\n';
    },
    startCmd(run, script) {
      return 'mkdir -p ~/.hark-agent && cd ~/.hark-agent && (find . -maxdepth 1 -name "r*" -mtime +7 -delete 2>/dev/null; true)'
        + ' && echo ' + shq(b64(script)) + ' | base64 -d > ' + run + '.sh && chmod 700 ' + run + '.sh'
        // Subshell, so the agent is re-parented to init (and reaped) — otherwise `tail --pid` would wait on a zombie forever.
        + ' && ( nohup setsid bash ' + run + '.sh > ' + run + '.log 2>&1 < /dev/null & echo $! > ' + run + '.pid )'
        + ' && sleep 0.3 && exec tail -n +1 -f --pid=$(cat ' + run + '.pid) ' + run + '.log';
    },
    attachCmd(run, fromByte) { return 'cd ~/.hark-agent && exec tail -c +' + (fromByte + 1) + ' -f --pid=$(cat ' + run + '.pid) ' + run + '.log'; },
    /** Stop a run: its process group (aider), plus — for Hermes, which runs as user hermes under sudo — that chat's hermes process. */
    /**
     * Stop a run and everything it started: the run's process group and session (setsid), every descendant (aider's
     * shell/tool children even if they started their own group), and — for Hermes, which runs as user hermes under
     * sudo — that session's hermes processes. The tree is collected first (killing re-parents children), then TERM,
     * a 2 s grace, then KILL for anything left. sudo -n because the sudo/hermes processes are not owned by ubuntu.
     */
    stopCmd(run, hermesSession) {
      return [
        'P=$(cat ~/.hark-agent/' + run + '.pid 2>/dev/null)',
        'd(){ echo "$1"; for c in $(pgrep -P "$1"); do d "$c"; done; }',
        'T=""; [ -n "$P" ] && T="$(d "$P") $(pgrep -s "$P")"',
        hermesSession ? 'for h in $(pgrep -u hermes -f -- ' + shq(hermesSession + '([^A-Za-z0-9_-]|$)') + '); do T="$T $(d "$h")"; done' : 'true',
        'T=$(echo $T | tr " " "\n" | sort -un | tr "\n" " ")',
        '[ -n "$P" ] && { kill -TERM -- -"$P" 2>/dev/null; sudo -n kill -TERM -- -"$P" 2>/dev/null; }',
        'for p in $T; do kill -TERM "$p" 2>/dev/null || sudo -n kill -TERM "$p" 2>/dev/null; done',
        'for i in 1 2 3 4; do L=""; for p in $T; do kill -0 "$p" 2>/dev/null && L="$L $p"; sudo -n kill -0 "$p" 2>/dev/null && L="$L $p"; done; [ -z "$L" ] && break; sleep 0.5; done',
        '[ -n "$P" ] && sudo -n kill -KILL -- -"$P" 2>/dev/null',
        'for p in $T; do sudo -n kill -KILL "$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null; done',
        '[ -n "$P" ] && echo "__HARK_EXIT__:130" >> ~/.hark-agent/' + run + '.log',
        'echo stopped',
      ].join('; ');
    },

    /** Exec that fetches a one-time token by itself if the app wants one (Safety › Ask on, or an older app). */
    exec(vm, command, onOut) {
      const v = H.ssh.classify(command);
      return H.ssh.exec(vm.id, command, onOut, 900, H.ssh.nativePolicy() && !v.needsTicket);
    },

    /**
     * Run the chat's agent for the last user message. Streams into am.content and am.steps (output cards).
     * o: {chat, am, signal, paint, prompt}
     */
    async run(o) {
      const { chat, am, signal, paint } = o;
      const mode = this.mode(chat);
      const vm = this.server();
      if (!H.ssh || !H.ssh.nativePolicy || !window.HarkOps) { am.error = MODES[mode] + ' runs on hark-a1 over SSH and needs the Shoeb AI Android app.'; return; }
      if (!vm) { am.error = 'Add hark-a1 under Settings › Keys › SSH keys & servers first.'; return; }
      let prompt = String(o.prompt || '').trim();
      if (mode === 'hermes' && chat.hermesStopped) {
        // Previous run was stopped: fresh session + recap (see sessionName).
        chat.hermesPrevSession = this.sessionName(chat);
        chat.hermesGen = (chat.hermesGen || 0) + 1; chat.hermesStopped = false;
        const ui = (chat.messages || []).lastIndexOf((chat.messages || []).filter((m) => m.role === 'user').pop());
        if (prompt) prompt = this.recap(chat, ui < 0 ? (chat.messages || []).length : ui) + prompt;
      } else if (mode === 'hermes') chat.hermesPrevSession = null;
      if (!prompt) { am.error = 'Nothing to send.'; return; }
      if (this.stopping) { await Promise.race([this.stopping, H.sleep(15000)]); this.stopping = null; }
      const run = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      am.agent = { mode, run, server: vm.name };
      const step = { label: MODES[mode], sum: mode === 'hermes' ? 'session ' + this.sessionName(chat) : (chat.aiderDir || st().aiderDir), state: 'run' };
      step.card = { kind: 'agent', server: vm.name, command: mode === 'hermes' ? 'hermes chat --continue ' + this.sessionName(chat) : 'cd ' + (chat.aiderDir || st().aiderDir) + ' && aider --yes-always', output: '', code: '…', how: 'running' };
      am.steps.push(step); paint();

      let log = ''; let bytes = 0;
      const parser = mode === 'hermes' ? this.hermesParser(am, paint) : null;
      const onOut = (t) => {
        bytes += blen(t); log += t;
        if (parser) parser.feed(t);
        else { step.card.output = H.clip(stripAnsi(log).replace(EXIT_RE, ''), 40000); }
        if (log.length > 400000) log = log.slice(-300000);
        paint();
      };
      let stopped = false;
      const sess = this.sessionName(chat);
      const onAbort = () => {
        stopped = true;
        if (mode === 'hermes') chat.hermesStopped = true;
        this.stopping = this.exec(vm, this.stopCmd(run, mode === 'hermes' ? sess : null), null).catch(() => {});
      };
      signal && signal.addEventListener('abort', onAbort, { once: true });
      try {
        let attempt = 0;
        for (;;) {
          try {
            await this.exec(vm, attempt === 0 ? this.startCmd(run, this.script(mode, chat, prompt)) : this.attachCmd(run, bytes), onOut);
          } catch (e) {
            if (e.notApproved) { am.error = 'Not approved on the phone.'; step.state = 'fail'; return; }
            if (!H.netErr(e) || stopped) throw e;
          }
          if (EXIT_RE.test(log) || stopped) break;
          // Link dropped or the 15-min exec cap hit while the agent keeps running on the server: follow it again.
          if (++attempt > MAX_ATTACH) { am.error = MODES[mode] + ' is still running on the server (log ~/.hark-agent/' + run + '.log).'; break; }
          step.card.how = 'reconnecting'; paint();
          await H.whenForeground(signal); await H.sleep(600);
          step.card.how = 'running';
        }
      } catch (e) {
        step.state = 'fail'; step.card.how = 'error';
        am.error = MODES[mode] + ': ' + e.message;
        return;
      } finally { signal && signal.removeEventListener('abort', onAbort); }

      const m = EXIT_RE.exec(log); const code = m ? +m[1] : (stopped ? 130 : -1);
      log = log.replace(EXIT_RE, '');
      step.card.code = code; step.card.how = stopped ? 'stopped' : code === 0 ? 'done' : 'failed';
      step.state = code === 0 ? 'ok' : 'fail';
      if (parser) parser.finish(step, log, code, chat);
      else this.aiderFinish(am, step, stripAnsi(log), code);
      paint();
    },

    /** Hermes stream-json: text deltas → reply text, tool_use/tool_result → one output card per tool call. */
    hermesParser(am, paint) {
      let buf = ''; const tools = {}; const other = [];
      const self = {
        result: null,
        line(l) {
          if (!l.trim() || /^__HARK_EXIT__:/.test(l)) return;
          let j = null; if (l[0] === '{') { try { j = JSON.parse(l); } catch (_) {} }
          if (!j) { if (!/^(Session|session_id):/.test(l)) other.push(l); return; }
          if (j.type === 'text' && j.text) { am.content = (am.content || '') + j.text; }
          else if (j.type === 'tool_use') {
            const inp = j.input || {};
            const s = { label: 'Hermes · ' + (j.name || 'tool'), sum: String(inp.command || inp.path || inp.query || inp.url || JSON.stringify(inp)).slice(0, 80), state: 'run' };
            tools[j.tool_call_id || ('t' + Object.keys(tools).length)] = { s, inp, name: j.name };
            am.steps.push(s);
          } else if (j.type === 'tool_result') {
            const t = tools[j.tool_call_id]; if (!t) return;
            let out = j.output; let code = j.is_error ? 1 : 0;
            try { const o = JSON.parse(out); if (o && typeof o === 'object') { if (o.exit_code != null) code = o.exit_code; out = [o.output, o.error].filter((x) => x != null && x !== '').join('\n'); } } catch (_) {}
            t.s.state = j.is_error || code ? 'fail' : 'ok';
            t.s.card = { kind: 'agent-tool', server: 'hark-a1', command: t.inp.command || (t.name + ' ' + JSON.stringify(t.inp)).slice(0, 400), output: H.clip(stripAnsi(String(out == null ? '' : out)), 20000), code, how: 'Hermes' };
          } else if (j.type === 'result') { self.result = j; }
        },
        feed(t) { buf += t; let i; while ((i = buf.indexOf('\n')) >= 0) { self.line(buf.slice(0, i)); buf = buf.slice(i + 1); } },
        finish(step, log, code, chat) {
          if (buf) { self.line(buf); buf = ''; }
          for (const k in tools) if (tools[k].s.state === 'run') tools[k].s.state = 'fail';
          const r = self.result;
          if (r) { if (!String(am.content || '').trim() && r.text) am.content = r.text; if (r.session_id) { chat.hermesSession = r.session_id; step.sum = 'session ' + r.session_id.slice(0, 18) + '…'; } }
          step.card.output = H.clip((other.join('\n') || '') + (r ? '\n[session ' + (r.session_id || '?') + ' · ' + ((r.tokens || {}).total || 0) + ' tokens · ' + Math.round((r.duration_ms || 0) / 1000) + ' s]' : ''), 20000).trim();
          if (!String(am.content || '').trim()) {
            if (code === 0) am.content = '_(Hermes finished without a reply.)_';
            else am.error = 'Hermes exited with code ' + code + (other.length ? ': ' + other.slice(-3).join(' ').slice(0, 300) : '');
          }
        },
      };
      return self;
    },

    /** Aider: whole run in one card; new commits + diff in a second card and summarised in the reply. */
    aiderFinish(am, step, log, code) {
      const i = log.indexOf(DIFF_MARK);
      const out = i >= 0 ? log.slice(0, i) : log;
      step.card.output = H.clip(out.trim(), 40000);
      const lines = out.trim().split('\n').filter((l) => l.trim() && !/^(Aider v|Main model:|Weak model:|Git repo:|Repo-map:|Added .* to the chat|Tokens:|Cost:|Model:|https?:\/\/aider\.chat)/.test(l));
      let s = '**Aider** ' + (code === 0 ? 'finished' : 'exited with code ' + code) + '.';
      if (i >= 0) {
        const d = log.slice(i + DIFF_MARK.length).replace(/^\n/, '');
        const [commits, rest] = [d.split('\n---\n')[0], d.split('\n---\n').slice(1).join('\n---\n')];
        const statEnd = rest.search(/\ndiff --git /);
        const stat = statEnd >= 0 ? rest.slice(0, statEnd) : rest;
        am.steps.push({ label: 'Aider · changes', sum: commits.trim().split('\n').length + ' commit(s)', state: 'ok',
          card: { kind: 'diff', server: step.card.server, command: 'git log + diff', output: H.clip(d.trim(), 60000), code: 0, how: 'commits' } });
        s += '\n\nCommits:\n```\n' + commits.trim() + '\n```\n' + (stat.trim() ? '```\n' + stat.trim().slice(0, 3000) + '\n```' : '');
      } else s += ' No new commits.';
      const tail = lines.slice(-12).join('\n').trim();
      if (tail) s += '\n\nLast output:\n```\n' + tail.slice(-3000) + '\n```';
      am.content = s;
    },

    /** Picker block shown at the top of the model sheet. */
    pickerBlock(chat, close, after) {
      const cur = this.mode(chat);
      const dir = el('input', { value: chat.aiderDir || st().aiderDir || '/home/ubuntu', placeholder: '/home/ubuntu', autocapitalize: 'off', spellcheck: 'false' });
      const seg = el('div', { class: 'seg agentseg' }, Object.keys(MODES).map((m) => el('button', { class: m === cur ? 'on' : '', text: MODES[m], onclick: () => {
        this.setMode(chat, m, dir.value); after && after(); if (m !== 'aider') close(); else { [...seg.children].forEach((b) => b.classList.toggle('on', b.textContent === MODES[m])); dirRow.style.display = ''; }
      } })));
      const dirRow = el('div', { class: 'agentdir', style: { display: cur === 'aider' ? '' : 'none' } },
        el('small', { text: 'Aider working directory on hark-a1 (remembered)' }), dir,
        el('button', { class: 'btn', text: 'Use this folder', onclick: () => { this.setMode(chat, 'aider', dir.value); after && after(); close(); } }));
      return el('div', { class: 'agentpick' }, el('div', { class: 'mp-group', text: 'Mode' }), seg, dirRow,
        el('div', { class: 'note', style: { padding: '2px 8px 8px' }, text: 'Hermes and Aider run on hark-a1 over SSH and act at once (no confirmation). Hermes keeps one session per chat.' }));
    },
  });
})();
