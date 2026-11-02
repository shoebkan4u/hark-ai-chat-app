/* Shoeb AI — SSH command policy (mirror of android/.../SshPolicy.kt, used for labels and on old app shells).
   Read-only commands run straight away; anything unrecognised counts as "changes" (fail closed).
   The Android app enforces its own copy; this one never grants anything by itself. */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  class Bad extends Error {}
  const WS = ' \t\n;|&)';

  function segments(s, depth) {
    if (depth > 4) throw new Bad('nested too deep');
    const segs = [[]]; let w = ''; let inWord = false; let i = 0;
    const endWord = () => { if (inWord) { segs[segs.length - 1].push(w); w = ''; inWord = false; } };
    const newSeg = () => { endWord(); if (segs[segs.length - 1].length) segs.push([]); };
    const sub = (inner) => { const v = classify0(inner, depth + 1); if (!v.readOnly) throw new Bad('command substitution: ' + v.reason); };
    const closeParen = (from) => {
      let d = 1, j = from, q = '';
      while (j < s.length) {
        const c = s[j];
        if (q) { if (c === q) q = ''; else if (c === '\\' && q === '"') j++; }
        else if (c === "'" || c === '"') q = c; else if (c === '\\') j++; else if (c === '(') d++; else if (c === ')') { d--; if (d === 0) return j; }
        j++;
      }
      throw new Bad('unclosed $(');
    };
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') { if (i + 1 < s.length && s[i + 1] !== '\n') { w += s[i + 1]; inWord = true; } i += 2; continue; }
      if (c === "'") { const j = s.indexOf("'", i + 1); if (j < 0) throw new Bad('unclosed quote'); w += s.slice(i + 1, j); inWord = true; i = j + 1; continue; }
      if (c === '"') {
        let j = i + 1; inWord = true;
        for (;;) {
          if (j >= s.length) throw new Bad('unclosed quote');
          const d = s[j];
          if (d === '"') break;
          if (d === '\\' && j + 1 < s.length) { w += s[j + 1]; j += 2; continue; }
          if (d === '`') { const k = s.indexOf('`', j + 1); if (k < 0) throw new Bad('unclosed backtick'); sub(s.slice(j + 1, k)); w += 'x'; j = k + 1; continue; }
          if (d === '$' && s[j + 1] === '(') { const k = closeParen(j + 2); sub(s.slice(j + 2, k)); w += 'x'; j = k + 1; continue; }
          w += d; j++;
        }
        i = j + 1; continue;
      }
      if (c === '`') { const k = s.indexOf('`', i + 1); if (k < 0) throw new Bad('unclosed backtick'); sub(s.slice(i + 1, k)); w += 'x'; inWord = true; i = k + 1; continue; }
      if (c === '$' && s[i + 1] === '(') {
        if (s[i + 2] === '(') throw new Bad('arithmetic');
        const k = closeParen(i + 2); sub(s.slice(i + 2, k)); w += 'x'; inWord = true; i = k + 1; continue;
      }
      if (c === '#' && !inWord) { while (i < s.length && s[i] !== '\n') i++; continue; }
      if (c === ' ' || c === '\t') { endWord(); i++; continue; }
      if (c === '\n' || c === ';') { newSeg(); i++; continue; }
      if (c === '|') { newSeg(); i += s[i + 1] === '|' ? 2 : 1; if (i < s.length && s[i - 1] === '|' && s[i] === '&') throw new Bad('|&'); continue; }
      if (c === '&') { if (s[i + 1] === '&') { newSeg(); i += 2; continue; } throw new Bad('background or &> redirect'); }
      if (c === '>' || c === '<') {
        const fd = inWord ? w : '';
        if (fd !== '2' || c !== '>') throw new Bad('redirect');
        w = ''; inWord = false;
        let j = i + 1;
        if (s[j] === '>') throw new Bad('redirect');
        if (s[j] === '&') { if (s[j + 1] === '1' && (j + 2 >= s.length || WS.includes(s[j + 2]))) { i = j + 2; continue; } throw new Bad('redirect'); }
        while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
        if (s.startsWith('/dev/null', j) && (j + 9 >= s.length || WS.includes(s[j + 9]))) { i = j + 9; continue; }
        throw new Bad('redirect');
      }
      if (c === '(' || c === ')' || (c === '{' && !inWord && (i + 1 >= s.length || ' \t\n'.includes(s[i + 1])))) throw new Bad('subshell or group');
      if (c === '$' && s[i + 1] === "'") throw new Bad('ansi-c quote');
      w += c; inWord = true; i++;
    }
    endWord();
    return segs.filter((x) => x.length);
  }

  const PLAIN = new Set(['echo', 'printf', 'free', 'df', 'du', 'uptime', 'uname', 'whoami', 'id', 'nproc', 'lscpu', 'ps', 'pgrep',
    'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'wc', 'cut', 'stat', 'which', 'netstat', 'printenv', 'true', 'lsblk', 'lsof', 'vmstat', 'iostat', 'w', 'last', 'dmesg', 'zcat', 'tac', 'basename', 'dirname', 'realpath', 'readlink']);
  const LOCAL_URL = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?([/?#].*)?$/i;
  const shortHas = (a, ch) => a.startsWith('-') && !a.startsWith('--') && a.indexOf(ch) > 0;
  const inSet = (x, arr) => arr.includes(x);

  function sedWrites(script) {
    if (/(^|[;{}\n]|\d|\$|\/|!)\s*[wWe]\b/.test(script)) return true;
    if (/s(.).*?\1.*?\1[gpiImM0-9]*[we]/.test(script)) return true;
    return false;
  }
  function curl(a) {
    const valueFlags = ['-H', '--header', '-m', '--max-time', '--connect-timeout', '-A', '--user-agent', '-e', '--referer', '-u', '--user', '-w', '--write-out', '--retry', '-r', '--range'];
    const plain = ['--silent', '--show-error', '--fail', '--location', '--insecure', '--verbose', '--include', '--head', '--compressed', '--http1.1', '--get', '--no-progress-meter'];
    let urls = 0;
    for (let k = 0; k < a.length; k++) {
      const x = a[k];
      if (x === '-X' || x === '--request') { if (String(a[k + 1] || '').toUpperCase() !== 'GET') return 'curl non-GET'; k++; }
      else if (x.startsWith('-X') && x.length > 2) { if (x.slice(2).toUpperCase() !== 'GET') return 'curl non-GET'; }
      else if (x.startsWith('--request=')) { if (x.split('=')[1].toUpperCase() !== 'GET') return 'curl non-GET'; }
      else if (inSet(x, valueFlags)) k++;
      else if (inSet(x, plain)) {}
      else if (x.startsWith('--max-time=') || x.startsWith('--connect-timeout=') || x.startsWith('--header=')) {}
      else if (x.startsWith('--')) return 'curl ' + x;
      else if (x.startsWith('-') && x.length > 1) { if (![...x.slice(1)].every((ch) => 'sSfLkviIG46q'.includes(ch))) return 'curl ' + x; }
      else { if (!LOCAL_URL.test(x)) return 'curl to a non-local address'; urls++; }
    }
    return urls > 0 ? null : 'curl without a local URL';
  }
  function wget(a) {
    let urls = 0, toStdout = false;
    for (let k = 0; k < a.length; k++) {
      const x = a[k];
      if (x === '-O') { if (a[k + 1] !== '-') return 'wget writes a file'; toStdout = true; k++; }
      else if (x === '-O-' || x === '-qO-' || (x === '-qO' && a[k + 1] === '-') || x === '--output-document=-') { toStdout = true; if (x === '-qO') k++; }
      else if (x === '--spider') toStdout = true;
      else if (inSet(x, ['-q', '--quiet', '-S', '--server-response', '--no-verbose', '-nv'])) {}
      else if (x === '-T' || x === '-t') k++;
      else if (x.startsWith('--timeout=') || x.startsWith('--tries=')) {}
      else if (x.startsWith('-')) return 'wget ' + x;
      else { if (!LOCAL_URL.test(x)) return 'wget to a non-local address'; urls++; }
    }
    return urls > 0 && toStdout ? null : 'wget must print to stdout (-O-) to a local URL';
  }

  function checkSeg(words) {
    if (!words.length) return null;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return 'variable assignment';
    if (words[0] === 'sudo') { words = words.slice(1); while (words.length && inSet(words[0], ['-n', '-E', '-H'])) words = words.slice(1); if (!words.length || words[0].startsWith('-')) return 'sudo option'; }
    let cmd = words[0];
    if (cmd.startsWith('/')) { if (!/^\/(usr\/)?(s?bin)\/[a-z0-9._-]+$/.test(cmd)) return 'path ' + cmd; cmd = cmd.split('/').pop(); }
    const a = words.slice(1);
    const nonFlag = a.filter((x) => !x.startsWith('-'));
    if (PLAIN.has(cmd)) {
      if (cmd === 'dmesg' && a.some((x) => x === '-c' || x === '-C' || x.startsWith('--clear') || x.startsWith('--read-clear') || x.startsWith('--console') || shortHas(x, 'c') || shortHas(x, 'C') || shortHas(x, 'n'))) return 'dmesg clears';
      return null;
    }
    switch (cmd) {
      case 'hostname': return !nonFlag.length && !a.some((x) => x === '-F' || x.startsWith('--file') || x === '-b' || x === '--boot') ? null : 'hostname change';
      case 'date': {
        for (let k = 0; k < a.length; k++) {
          const x = a[k];
          if (inSet(x, ['-d', '--date', '-r', '--reference'])) k++;
          else if (x === '-s' || x.startsWith('--set') || shortHas(x, 's')) return 'date set';
          else if (x.startsWith('-') || x.startsWith('+')) {}
          else return 'date set';
        }
        return null;
      }
      case 'sort': return a.some((x) => x === '-o' || x.startsWith('--output') || shortHas(x, 'o') || x.startsWith('--compress-program')) ? 'sort -o' : null;
      case 'uniq': return nonFlag.length > 1 ? 'uniq output file' : null;
      case 'top': return a.some((x) => x === '-b' || shortHas(x, 'b')) && a.some((x) => x.startsWith('-n') || shortHas(x, 'n')) ? null : 'top needs -b -n';
      case 'ss': return a.some((x) => x === '-K' || x === '--kill' || shortHas(x, 'K')) ? 'ss --kill' : null;
      case 'journalctl': return a.some((x) => /^--(vacuum|rotate|flush|sync|relinquish|setup-keys|update-catalog)/.test(x)) ? 'journalctl maintenance' : null;
      case 'crontab': { const j = a.join(' '); return j === '-l' || (a.length === 3 && a[0] === '-u' && a[2] === '-l') || (a.length === 3 && a[0] === '-l' && a[1] === '-u') ? null : 'crontab edit'; }
      case 'awk': case 'gawk': case 'mawk':
        return a.some((x) => x === '-i' || x.startsWith('--inplace') || x.startsWith('-i') || x.includes('system') || x.includes('|') || x.includes('>') || x.includes('getline') || x.includes('fflush')) ? 'awk can write or run commands' : null;
      case 'sed': {
        if (a.some((x) => x.startsWith('--in-place') || x === '-f' || x.startsWith('--file') || (x.startsWith('-') && !x.startsWith('--') && x.includes('i')))) return 'sed -i';
        const scripts = []; let sawE = false;
        for (let k = 0; k < a.length; k++) {
          if (a[k] === '-e' || a[k] === '--expression') { if (k + 1 < a.length) scripts.push(a[k + 1]); sawE = true; k++; continue; }
          if (a[k].startsWith('--expression=')) { scripts.push(a[k].slice(13)); sawE = true; }
        }
        if (!sawE && nonFlag.length) scripts.push(nonFlag[0]);
        return scripts.some(sedWrites) ? 'sed w/e command' : null;
      }
      case 'find': return a.some((x) => inSet(x, ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'])) ? 'find -delete/-exec' : null;
      case 'env': return a.every((x) => x === '-0' || x === '--null') ? null : 'env runs a command';
      case 'ip': {
        const r = a.slice(a.findIndex((x) => !x.startsWith('-')) < 0 ? a.length : a.findIndex((x) => !x.startsWith('-')));
        const obj = r[0], act = r[1];
        return inSet(obj, ['a', 'addr', 'address', 'r', 'ro', 'route', 'l', 'link', 'n', 'neigh']) && (act == null || inSet(act, ['show', 'list', 'ls', 's', 'sh']) || act.startsWith('dev')) ? null : 'ip change';
      }
      case 'ping': case 'ping6': return a.some((x) => x === '-c' || /^-[a-zA-Z]*c\d*$/.test(x)) ? null : 'ping needs -c';
      case 'curl': return curl(a);
      case 'wget': return wget(a);
      case 'systemctl': { const sub = a.find((x) => !x.startsWith('-')); return inSet(sub, ['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-timers', 'list-unit-files', 'list-sockets', 'show', 'cat']) || (sub == null && a.includes('--version')) ? null : 'systemctl ' + sub; }
      case 'docker': {
        const sub = a[0], s2 = a[1];
        if (inSet(sub, ['ps', 'logs', 'inspect', 'images', 'top', 'port', 'version', 'info'])) return null;
        if (sub === 'stats') return a.includes('--no-stream') ? null : 'docker stats needs --no-stream';
        if (sub === 'container' && inSet(s2, ['ls', 'ps', 'list', 'logs', 'inspect', 'top', 'port'])) return null;
        if (sub === 'image' && inSet(s2, ['ls', 'list', 'inspect'])) return null;
        if (sub === 'compose' && inSet(s2, ['ps', 'logs', 'ls', 'config', 'images', 'top'])) return null;
        if (sub === 'compose' && inSet(a.slice(1).find((x) => !x.startsWith('-')), ['ps', 'logs', 'ls', 'images', 'top']) && !a.some((x) => x === '-f' || x.startsWith('--file') || x === '--project-directory')) return null;
        return 'docker ' + sub;
      }
      case 'tailscale': return inSet(a[0], ['status', 'ip', 'version', 'netcheck', 'whois']) ? null : 'tailscale ' + a[0];
      case 'openclaw': {
        const r = a.filter((x) => !x.startsWith('-')).join(' ');
        return r === 'status' || r === 'channels list' || r === 'models status' || (r === '' && a.some((x) => x === '--version' || x === '-v')) ? null : 'openclaw ' + r;
      }
      default: return 'not on the read-only list: ' + cmd;
    }
  }

  function classify0(command, depth) {
    let segs;
    try { segs = segments(command, depth); } catch (e) { if (e instanceof Bad) return { readOnly: false, reason: e.message }; throw e; }
    if (!segs.length) return { readOnly: false, reason: 'empty' };
    for (const s of segs) { const r = checkSeg(s); if (r != null) return { readOnly: false, reason: r }; }
    return { readOnly: true, reason: 'read-only' };
  }
  function classify(command) {
    command = String(command == null ? '' : command);
    if (command.length > 4000) return { readOnly: false, reason: 'too long' };
    if (/[\x00-\x08\x0b-\x1f]/.test(command)) return { readOnly: false, reason: 'control characters' };
    return classify0(command, 0);
  }
  function isProtected(c) {
    c = String(c || '');
    return /--no-preserve-root/.test(c) ||
      /\brm\b[^;&|\n]*\s['"]?\/\*?['"]?(\s|$|[;&|])/.test(c) ||
      /\b(reboot|shutdown|poweroff|halt|kexec)\b/.test(c) ||
      /\b(init|telinit)\s+[06]\b/.test(c) ||
      (/\bdocker\b/.test(c) && /openalgo/i.test(c) && /\b(rm|stop|kill|restart|down|rmi|prune|pause|update|rename|exec|run|compose|up)\b/.test(c)) ||
      /openalgo-tradesmart/i.test(c) ||
      /(^|[\s'"=:;&|(/~])wisdom(\/|\s|$|['";&|)])/i.test(c) ||
      /(~|\$HOME|\$\{HOME\}|\/home\/[^/\s]+)\/wisdom\b/i.test(c);
  }
  const needsTicket = (c, askChanges) => !classify(c).readOnly && (askChanges || isProtected(c));
  const SECRET_NAME = /key|token|secret|pass|pwd|auth|cred/i;
  const ENV_LINE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.+)$/;
  const maskLine = (line) => { const m = ENV_LINE.exec(line); if (!m || !SECRET_NAME.test(m[2]) || !m[4].trim()) return line; return m[1] + m[2] + m[3] + '••••'; };
  const mask = (t) => String(t).split('\n').map(maskLine).join('\n');

  const api = { classify, isProtected, needsTicket, mask };
  if (root.Hark) root.Hark.sshPolicy = api;
  root.HarkSshPolicy = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
