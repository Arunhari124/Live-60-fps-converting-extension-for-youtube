// SmoothVision content script: finds the YouTube <video>, owns the engine lifecycle, answers popup queries.
(() => {
  if (window.__svContent) return; window.__svContent = true;
  const isTest = location.protocol === 'chrome-extension:';
  let settings = { ...SV_DEFAULTS }, engine = null, caps = null, lastBadgeText = null;

  const onWatch = () => isTest || location.pathname === '/watch';
  const pickVideo = () => isTest ? document.getElementById('testVideo')
    : document.querySelector('#movie_player video.html5-main-video') || document.querySelector('video.html5-main-video');
  const wanted = () => settings.enabled && settings.smoothing !== 'off' && onWatch();

  function idleStatus() {
    return { state: settings.enabled ? (onWatch() ? 'waiting' : 'idle') : 'off', effective: 'bypass', short: 'Off (original video)', processing: false,
      srcFps: 0, outFps: 0, displayHz: 0, targetFps: settings.targetFps, cap: settings.targetFps, gpuMs: 0, cpuMs: 0, skipped: 0, missedSrc: 0, lateOut: 0,
      flowFrames: 0, fallbackFrames: 0, size: '', renderer: '',
      message: !settings.enabled ? 'Disabled — original playback.' : !onWatch() ? 'Open a YouTube watch page.'
        : settings.smoothing === 'off' ? 'Motion Smoothing is set to Off.' : 'Waiting for a video…' };
  }
  const status = () => engine ? engine.getStatus() : idleStatus();

  function reconcile() {
    const v = wanted() ? pickVideo() : null;
    if (engine && (!v || engine.video !== v || !v.isConnected)) { engine.destroy(); engine = null; }   // restores page to untouched state
    if (v && !engine) { engine = new SVEngine(v, settings); engine.start(); }
  }
  function restart() { if (engine) { engine.destroy(); engine = null; } reconcile(); }

  function badge(st) {
    const player = isTest ? document.getElementById('stage') : document.getElementById('movie_player');
    let b = document.getElementById('smoothvision-badge');
    const show = settings.badge && player && st.state === 'active' && !st.noNeed;
    if (!show) { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement('div'); b.id = 'smoothvision-badge';
      b.style.cssText = 'position:absolute;left:12px;top:12px;z-index:70;padding:3px 8px;border-radius:4px;font:12px/1.4 system-ui,sans-serif;color:#7df3ff;background:rgba(6,20,28,.72);border:1px solid rgba(34,211,238,.5);pointer-events:none;';
      player.appendChild(b);
    }
    b.textContent = `SmoothVision · ${st.short} · ${st.srcFps ? st.srcFps.toFixed(0) : '…'}→${st.outFps ? st.outFps.toFixed(0) : '…'} fps (measured)`;
  }

  function toolbar(st) {
    const text = st.state === 'active' && !st.noNeed ? 'ON' : st.state === 'error' ? '!' : '';
    if (text === lastBadgeText) return; lastBadgeText = text;
    try { chrome.runtime.sendMessage({ type: 'sv:badge', text }); } catch (e) {}
  }

  chrome.storage.local.get('settings').then(r => { settings = { ...SV_DEFAULTS, ...(r.settings || {}) }; reconcile(); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.settings) { settings = { ...SV_DEFAULTS, ...(ch.settings.newValue || {}) }; restart(); }
  });
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg && msg.type === 'sv:status') reply({ settings, status: status(), caps });
  });
  SVEngine.detectCapabilities().then(c => { caps = c; });

  document.addEventListener('yt-navigate-finish', () => setTimeout(reconcile, 300));   // SPA navigation
  window.addEventListener('popstate', () => setTimeout(reconcile, 300));
  setInterval(() => { reconcile(); const st = status(); badge(st); toolbar(st); }, 1000);

  window.__sv = { status };   // used by test.html (same JS world)
})();
