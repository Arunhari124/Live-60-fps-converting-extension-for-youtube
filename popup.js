const $ = id => document.getElementById(id);
let settings = { ...SV_DEFAULTS };
const save = () => chrome.storage.local.set({ settings });
const f = (n, d = 1) => n > 0 ? n.toFixed(d) : '—';

function paint() {
  $('enabled').checked = settings.enabled;
  document.querySelectorAll('#smoothing button').forEach(b => b.classList.toggle('on', b.dataset.v === settings.smoothing));
  $('targetFps').value = settings.targetFps; $('method').value = settings.method;
  $('performance').value = settings.performance; $('autoDegrade').checked = settings.autoDegrade;
}
function bind() {
  $('enabled').onchange = e => { settings.enabled = e.target.checked; save(); };
  document.querySelectorAll('#smoothing button').forEach(b => b.onclick = () => { settings.smoothing = b.dataset.v; paint(); save(); });
  $('targetFps').onchange = e => { settings.targetFps = +e.target.value; save(); };
  $('method').onchange = e => { settings.method = e.target.value; save(); };
  $('performance').onchange = e => { settings.performance = e.target.value; save(); };
  $('autoDegrade').onchange = e => { settings.autoDegrade = e.target.checked; save(); };
  $('reset').onclick = () => { settings = { ...SV_DEFAULTS }; paint(); save(); };
  $('opts').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
}

function render(r) {
  const msg = $('msg');
  if (!r) {
    msg.textContent = 'Open a YouTube watch page to use SmoothVision (reload the tab if you just installed it).';
    msg.className = 'msg show'; ['mode','src','out','hz','gpu','cpu','drop','accel'].forEach(i => $(i).textContent = '—'); return;
  }
  const s = r.status, c = r.caps;
  msg.textContent = s.message || ''; msg.className = 'msg' + (s.message ? ' show' : '') + (s.state === 'error' ? ' err' : '');
  $('mode').textContent = s.state === 'active' ? s.short + (s.perf ? ' · ' + s.perf : '') : s.state === 'error' ? 'Error (original video)' : s.short || 'Off';
  $('src').textContent = f(s.srcFps);
  $('out').textContent = s.processing && s.outFps > 0 ? f(s.outFps) : '—';
  $('hz').textContent = f(s.displayHz, 0) + (s.displayHz ? ' Hz' : '');
  $('gpu').textContent = s.gpuMs > 0 ? f(s.gpuMs) + ' ms' : '—';
  $('cpu').textContent = s.cpuMs > 0 ? f(s.cpuMs, 2) + ' ms' : '—';
  $('drop').textContent = `${s.skipped} / ${s.missedSrc} / ${s.lateOut}`;
  $('accel').textContent = !c ? '…' : c.webgl2Hardware ? 'WebGL2 (hardware)' : c.webgl2 ? 'WebGL2 (software!)' : 'None';
  $('cap').textContent = s.state === 'active' ? `Output is capped at min(target, display refresh) ≈ ${f(s.cap, 0)} fps. Only the measured value above is real.` : '';
  $('diag').textContent = JSON.stringify({ capabilities: c, status: s }, null, 2);
}

async function poll() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    render(await chrome.tabs.sendMessage(tab.id, { type: 'sv:status' }));
  } catch (e) { render(null); }
}
chrome.storage.local.get('settings').then(r => { settings = { ...SV_DEFAULTS, ...(r.settings || {}) }; paint(); bind(); poll(); setInterval(poll, 700); });
