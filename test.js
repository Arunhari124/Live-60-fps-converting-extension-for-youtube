const $ = id => document.getElementById(id), v = $('testVideo');
async function setS(p) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...SV_DEFAULTS, ...(settings || {}), ...p } });
}
chrome.storage.local.get('settings').then(r => { const s = { ...SV_DEFAULTS, ...(r.settings || {}) };
  $('en').checked = s.enabled; $('mt').value = s.method; $('sm').value = s.smoothing === 'off' ? 'low' : s.smoothing; $('tf').value = s.targetFps; });
$('en').onchange = e => setS({ enabled: e.target.checked });
$('mt').onchange = e => setS({ method: e.target.value });
$('sm').onchange = e => setS({ smoothing: e.target.value });
$('tf').onchange = e => setS({ targetFps: +e.target.value });
$('file').onchange = e => { const f = e.target.files[0]; if (!f) return; v.srcObject = null; v.src = URL.createObjectURL(f); v.play(); };
$('synth').onclick = () => {
  const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d'); let last = 0; const t0 = performance.now();
  (function frame(ts) {
    requestAnimationFrame(frame); if (ts - last < 1000 / 24 - 1) return; last = ts; const t = (ts - t0) / 1000;
    x.fillStyle = '#0b1118'; x.fillRect(0, 0, 640, 360);
    for (let i = -1; i < 17; i++) { x.fillStyle = i % 2 ? '#16324a' : '#0f2233'; x.fillRect(((i * 40 + t * 120) % 680) - 40, 0, 40, 360); }
    x.fillStyle = '#22d3ee'; x.fillRect((t * 300) % 700 - 60, 140, 60, 60);
    x.fillStyle = '#fbbf24'; x.beginPath(); x.arc(320 + 200 * Math.cos(t * 2), 180 + 120 * Math.sin(t * 2), 24, 0, 7); x.fill();
  })(0);
  v.removeAttribute('src'); v.srcObject = c.captureStream(24); v.play();
};
setInterval(() => { if (window.__sv) $('st').textContent = JSON.stringify(window.__sv.status(), null, 2); }, 500);
