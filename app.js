/* Hark AI — boot. */
(function () {
  'use strict';
  const H = window.Hark;
  const TWELVE_H = 12 * 3600e3;

  H.applyTheme();
  H.ui.mount();

  // Native events: OAuth deep link, widget/notification actions, shared text.
  H.onNative(async (type, d) => {
    if (type === 'deeplink' && /oauth/.test(d.url)) {
      try { const s = await H.mcp.finish(d.url); H.toast((s ? s.name : 'Server') + ' connected'); }
      catch (e) { H.toast('Sign-in failed: ' + e.message, 4000); }
    } else if (type === 'action') {
      // 1.1.14: widgets and notifications never open a blank chat; they land in the chat you had open.
      await Promise.resolve(H.ui.restored).catch(() => {});
      if (d.action === 'voice') H.ui.openVoice();
      else if (d.action === 'pnl') H.ui.send('What’s my P&L today across my accounts?', []);
      else setTimeout(() => H.$('#input').focus(), 300);
    } else if (type === 'task_result') {
      try { H.showTaskResult(JSON.parse(d.json)); } catch (_) {}
    } else if (type === 'updated') {
      H.toast(d.message || ('Updated to v' + d.version), 4000);
    } else if (type === 'shared_text') {
      await Promise.resolve(H.ui.restored).catch(() => {});
      const ta = H.$('#input'); ta.value = (ta.value.trim() ? ta.value + '\n' : '') + d.text; ta.dispatchEvent(new Event('input'));
    }
  });

  // Browser-mode OAuth return (?oauth=1&code=…)
  if (/[?&]oauth=1/.test(location.search) && /[?&](code|error)=/.test(location.search)) {
    const url = location.href;
    history.replaceState(null, '', location.pathname);
    H.mcp.finish(url).then((s) => H.toast((s ? s.name : 'Server') + ' connected')).catch((e) => H.toast('Sign-in failed: ' + e.message));
  }

  // Live model catalog: on launch, then every 12 hours while open.
  setTimeout(() => H.ui.refreshCatalog(false), 1200);
  // 1.1.14: daily model health check (once per IST day), so broken models disappear everywhere.
  const dailyCheck = () => { if (H.checkModels) H.checkModels(false).catch(() => {}); };
  setTimeout(dailyCheck, 20000);
  setInterval(dailyCheck, 60 * 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(dailyCheck, 5000); });
  setInterval(() => { if (Date.now() - (H.catalog.updated || 0) > TWELVE_H) H.ui.refreshCatalog(false); }, 30 * 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (H.catalog.updated || 0) > TWELVE_H) H.ui.refreshCatalog(false); });

  // New Android shell version? (checked once a day)
  if (H.native && !(window.HarkNative && typeof window.HarkNative.updateStatus === 'function')) { // older shells only; 1.1.5+ update natively
    const last = +localStorage.getItem('hark.apkcheck') || 0;
    if (Date.now() - last > 864e5) { localStorage.setItem('hark.apkcheck', String(Date.now())); setTimeout(() => H.checkApkUpdate(false), 5000); }
  }

  // First run without keys: point to import.
  if (!H.vault.list().length) {
    setTimeout(async () => {
      H.toast('No keys yet — Settings › Import from Hark', 5000);
    }, 600);
  }
})();
