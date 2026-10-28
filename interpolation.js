// SmoothVision engine: WebGL2 block-matching frame interpolation with graceful fallbacks.
// Pipeline per source frame (driven by requestVideoFrameCallback):
//   video -> texture -> luma downsample -> block-matching flow (GPU)
// Pipeline per display refresh (driven by requestAnimationFrame):
//   draw an intermediate frame between prev and cur at phase t, onto an overlay canvas.
// The overlay is delayed by ONE source frame (an interpolator needs the next frame), so video
// is shown ~1 source-frame-interval after the audio (≈33–42 ms at 30/24 fps).

const SV_PROFILES = {
  performance: { outW: 1280, an: 256, R: 8, S: 2 },
  balanced:    { outW: 1600, an: 384, R: 6, S: 1 },
  quality:     { outW: 1920, an: 512, R: 8, S: 1 }
};
const SV_SMOOTH = { low: 0.35, medium: 0.65, high: 1.0 };
const SV_SHORT = { flow: 'Optical Flow (approx.)', blend: 'Frame Blending', dup: 'Frame Duplication', bypass: 'Bypassed' };

class SVEngine {
  static async detectCapabilities() {
    const caps = { rvfc: 'requestVideoFrameCallback' in HTMLVideoElement.prototype, offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
      webgl2: false, webgl2Hardware: false, webgl1: false, renderer: '', vendor: '', maxTexture: 0,
      webgpu: false, webgpuAdapter: '', userAgent: navigator.userAgent };
    try {
      let gl = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
      caps.webgl2Hardware = !!gl;
      if (!gl) gl = document.createElement('canvas').getContext('webgl2');
      caps.webgl2 = !!gl;
      if (!gl) { const g1 = document.createElement('canvas').getContext('webgl'); caps.webgl1 = !!g1; }
      else {
        caps.webgl1 = true;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        caps.renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        caps.vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
        caps.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
      }
    } catch (e) { caps.webglError = String(e); }
    try {
      if (navigator.gpu) {
        const a = await navigator.gpu.requestAdapter();
        caps.webgpu = !!a;
        if (a && a.info) caps.webgpuAdapter = [a.info.vendor, a.info.architecture, a.info.description].filter(Boolean).join(' ');
      }
    } catch (e) { caps.webgpuError = String(e); }
    return caps;
  }

  constructor(video, settings) {
    this.video = video; this.s = { ...settings };
    this.state = 'starting'; this.message = '';
    this.running = false; this.gl = null; this.res = null; this.cfg = null;
    this.ls = []; this.ladder = []; this.level = 0;
    this._onFrame = this._onFrame.bind(this); this._tick = this._tick.bind(this);
    this.srcMs = 0; this.refreshMs = 0; this.lastTs = 0; this.nextDue = 0;
    this.outFps = 0; this.srcFps = 0; this.displayHz = 0; this.gpuMs = 0; this.cpuMs = 0;
    this.skipped = 0; this.missedSrc = 0; this.lateOut = 0; this.flowFrames = 0; this.fallbackFrames = 0;
    this.outCount = 0; this.lastSec = performance.now(); this.lateInSec = 0; this.skippedInSec = 0;
    this.overload = 0; this.lastDegrade = 0; this.pending = []; this.noNeed = false; this.dirty = true;
    this._resetHistory(true);
  }

  // ---------- lifecycle ----------
  start() {
    const v = this.video;
    if (!('requestVideoFrameCallback' in v)) return this._fail(new Error('requestVideoFrameCallback is not supported.'));
    try { this._createCanvas(); this._initGL(); } catch (e) { return this._fail(e); }
    this.running = true;
    this._buildLadder(); this._applyLevel();
    this._listen(v, 'emptied', () => this._resetHistory(true));
    this._listen(v, 'seeking', () => this._resetHistory(false));
    this._listen(v, 'pause', () => { this.dirty = true; });
    this._listen(v, 'play', () => { this.dirty = true; this.nextDue = 0; });
    this._listen(document, 'fullscreenchange', () => setTimeout(() => this._syncLayout(), 150));
    this._listen(window, 'resize', () => this._syncLayout());
    this.ro = new ResizeObserver(() => this._syncLayout()); this.ro.observe(v);
    this.mo = new MutationObserver(() => this._syncLayout()); this.mo.observe(v, { attributes: true, attributeFilter: ['style', 'class'] });
    this._syncLayout();
    this._vfc = v.requestVideoFrameCallback(this._onFrame);
    this._raf = requestAnimationFrame(this._tick);
  }

  destroy() {
    this.running = false;
    try { if (this._vfc && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this._vfc); } catch (e) {}
    if (this._raf) cancelAnimationFrame(this._raf);
    for (const [t, e, f] of this.ls) t.removeEventListener(e, f);
    this.ls = [];
    if (this.ro) this.ro.disconnect();
    if (this.mo) this.mo.disconnect();
    try { this._freeRes(); const l = this.gl && this.gl.getExtension('WEBGL_lose_context'); if (l) l.loseContext(); } catch (e) {}
    if (this.canvas) this.canvas.remove();
    this.canvas = null; this.gl = null; // the original <video> was never modified
  }

  _listen(t, e, f) { t.addEventListener(e, f); this.ls.push([t, e, f]); }
  _fail(e) {
    console.warn('[SmoothVision]', e);
    this.state = 'error'; this.message = String((e && e.message) || e);
    this.running = false; this.cfg = null;
    try { if (this.canvas) this.canvas.style.display = 'none'; } catch (x) {}
    try { if (this._vfc && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this._vfc); } catch (x) {}
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  _resetHistory(full) {
    this.haveCur = false; this.havePair = false; this.pairFlow = false; this.cur = 0;
    this.lastMT = null; this.lastNow = null; this.lastPF = null; this.allocKey = full ? null : this.allocKey;
    if (full) this.srcMs = 0;
    this.dirty = true;
  }

  // ---------- quality ladder (auto-degrade) ----------
  _buildLadder() {
    const order = ['performance', 'balanced', 'quality']; const pi = Math.max(0, order.indexOf(this.s.performance));
    const L = [];
    if (this.s.method === 'flow') { for (let i = pi; i >= 0; i--) L.push({ method: 'flow', perf: order[i] }); L.push({ method: 'blend', perf: 'performance' }); }
    else L.push({ method: this.s.method, perf: order[pi] });
    L.push({ method: 'bypass' });
    this.ladder = L; this.level = 0;
  }
  _applyLevel() {
    const c = this.ladder[this.level];
    this.allocKey = null; this.nextDue = 0; this.pending.forEach(p => this.gl.deleteSync(p.s)); this.pending = [];
    if (c.method === 'bypass') { this.cfg = null; this.state = 'bypassed'; this._hide(); if (this.level > 0) this.message = 'Interpolation stopped to protect normal playback (GPU could not keep up).'; }
    else { this.cfg = c; this.state = 'active'; this.message = this.level > 0 ? 'Auto-lowered to: ' + SV_SHORT[c.method] + ' / ' + c.perf : ''; }
  }
  applySettings(s) { this.s = { ...s }; this._buildLadder(); this._applyLevel(); this._resetHistory(false); }

  // ---------- canvas / GL ----------
  _createCanvas() {
    const c = document.createElement('canvas'); c.id = 'smoothvision-canvas';
    c.style.cssText = 'position:absolute;pointer-events:none;object-fit:contain;display:none;z-index:1;';
    this.video.parentElement.insertBefore(c, this.video.nextSibling);
    c.addEventListener('webglcontextlost', e => { e.preventDefault(); this._fail(new Error('WebGL context lost.')); });
    this.canvas = c;
  }
  _syncLayout() {
    const v = this.video, c = this.canvas; if (!c) return;
    c.style.left = v.offsetLeft + 'px'; c.style.top = v.offsetTop + 'px';
    c.style.width = v.offsetWidth + 'px'; c.style.height = v.offsetHeight + 'px';
  }
  _hide() { if (this.canvas) this.canvas.style.display = 'none'; }
  _show() { if (this.canvas && this.canvas.style.display !== 'block') this.canvas.style.display = 'block'; }

  _initGL() {
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true });
    if (!gl) throw new Error('Hardware WebGL2 unavailable (software rendering would be too slow). Check chrome://gpu.');
    this.gl = gl;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    this.renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    this.pDown = this._prog(SV_SHADERS.vert, SV_SHADERS.down);
    this.pFlow = this._prog(SV_SHADERS.vert, SV_SHADERS.flow);
    this.pInterp = this._prog(SV_SHADERS.vert, SV_SHADERS.interp);
  }
  _prog(vs, fs) {
    const gl = this.gl;
    const mk = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x);
      if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error('Shader compile: ' + gl.getShaderInfoLog(x)); return x; };
    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Shader link: ' + gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
    return { p, u };
  }
  _use(pr) { this.gl.useProgram(pr.p); return pr.u; }
  _tex(w, h, filter) {
    const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  _fbo(tex) {
    const gl = this.gl, f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete.');
    return f;
  }
  _freeRes() {
    const gl = this.gl, R = this.res; if (!gl || !R) return;
    R.full.concat(R.small, [R.flow]).forEach(t => gl.deleteTexture(t));
    R.smallFbo.concat([R.flowFbo]).forEach(f => gl.deleteFramebuffer(f));
    this.res = null;
  }
  _allocate(vw, vh) {
    const gl = this.gl; this._freeRes();
    const P = SV_PROFILES[this.cfg.perf], sc = Math.min(1, P.outW / vw);
    const outW = Math.max(2, Math.round(vw * sc)), outH = Math.max(2, Math.round(vh * sc));
    const aw = Math.max(16, Math.round(P.an / 8) * 8), ah = Math.max(16, Math.round(P.an * vh / vw / 8) * 8);
    const R = { vw, vh, outW, outH, aw, ah, bw: aw / 8, bh: ah / 8, R: P.R, S: P.S, full: [], small: [], smallFbo: [] };
    for (let i = 0; i < 2; i++) { R.full[i] = this._tex(vw, vh, gl.LINEAR); R.small[i] = this._tex(aw, ah, gl.NEAREST); R.smallFbo[i] = this._fbo(R.small[i]); }
    R.flow = this._tex(R.bw, R.bh, gl.LINEAR); R.flowFbo = this._fbo(R.flow);
    this.canvas.width = outW; this.canvas.height = outH; this.res = R; this.cur = 0;
  }

  // ---------- GPU latency (fence polling; resolution ~ one display refresh) ----------
  _pollFences() {
    const gl = this.gl; if (!gl) return;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i], r = gl.clientWaitSync(p.s, 0, 0);
      if (r === gl.ALREADY_SIGNALED || r === gl.CONDITION_SATISFIED) {
        const ms = performance.now() - p.t; this.gpuMs = this.gpuMs ? this.gpuMs * 0.8 + ms * 0.2 : ms;
        gl.deleteSync(p.s); this.pending.splice(i, 1);
      } else if (r === gl.WAIT_FAILED) { gl.deleteSync(p.s); this.pending.splice(i, 1); }
    }
  }

  // ---------- per source frame ----------
  _onFrame(now, meta) {
    if (!this.running) return;
    const v = this.video;
    this._vfc = v.requestVideoFrameCallback(this._onFrame);
    if (!this.cfg || v.readyState < 2) return;
    const t0 = performance.now();
    try {
      const vw = v.videoWidth, vh = v.videoHeight; if (!vw || !vh) return;
      // source interval (nominal, from media timestamps; falls back to arrival times)
      const mt = meta && Number.isFinite(meta.mediaTime) ? meta.mediaTime : null; let dt = null;
      if (mt !== null && this.lastMT !== null) {
        const d = mt - this.lastMT;
        if (d > 0 && d < 0.5) dt = d * 1000 / Math.max(0.1, v.playbackRate); else this._resetHistory(false);
      } else if (mt === null && this.lastNow !== null) { const d = now - this.lastNow; if (d > 1 && d < 500) dt = d; }
      this.lastMT = mt; this.lastNow = now;
      if (dt) this.srcMs = this.srcMs ? this.srcMs * 0.9 + dt * 0.1 : dt;
      if (meta && typeof meta.presentedFrames === 'number') {
        if (this.lastPF !== null && meta.presentedFrames - this.lastPF > 1) this.missedSrc += meta.presentedFrames - this.lastPF - 1;
        this.lastPF = meta.presentedFrames;
      }
      this.noNeed = this.srcMs > 0 && 1000 / this.srcMs >= this.s.targetFps * 0.95;
      if (this.noNeed) { this._hide(); this.message = 'Source frame rate already ≥ target; nothing to interpolate.'; return; }
      if (this.message.startsWith('Source frame rate')) this.message = '';

      const key = vw + 'x' + vh + ':' + this.cfg.perf;
      if (key !== this.allocKey) { this._allocate(vw, vh); this.allocKey = key; this.haveCur = false; this.havePair = false; }
      const gl = this.gl, R = this.res, n = 1 - this.cur, m = this.cfg.method;

      gl.bindTexture(gl.TEXTURE_2D, R.full[n]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, v);   // throws SecurityError for protected/tainted video

      let flowOk = false;
      if (m === 'flow') {
        let u = this._use(this.pDown);
        gl.bindFramebuffer(gl.FRAMEBUFFER, R.smallFbo[n]); gl.viewport(0, 0, R.aw, R.ah);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.full[n]);
        gl.uniform1i(u.u_tex, 0); gl.uniform2f(u.u_step, 0.25 / R.aw, 0.25 / R.ah);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (this.haveCur) {
          this._pollFences();
          if (this.pending.length >= 2) { this.skipped++; this.skippedInSec++; this.fallbackFrames++; }   // GPU is behind: skip flow for this pair
          else {
            u = this._use(this.pFlow);
            gl.bindFramebuffer(gl.FRAMEBUFFER, R.flowFbo); gl.viewport(0, 0, R.bw, R.bh);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.small[this.cur]);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, R.small[n]);
            gl.uniform1i(u.u_prev, 0); gl.uniform1i(u.u_cur, 1);
            gl.uniform2i(u.u_size, R.aw, R.ah); gl.uniform1i(u.u_R, R.R); gl.uniform1i(u.u_S, R.S); gl.uniform1f(u.u_lambda, 0.03);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            const s = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush(); this.pending.push({ s, t: performance.now() });
            flowOk = true; this.flowFrames++;
          }
        }
      }
      this.havePair = this.haveCur; this.haveCur = true; this.cur = n; this.pairFlow = flowOk;
      this.tCur = (meta && meta.expectedDisplayTime) || now; this.dirty = true;
      const c = performance.now() - t0; this.cpuMs = this.cpuMs ? this.cpuMs * 0.9 + c * 0.1 : c;
    } catch (e) { this._fail(e); }
  }

  // ---------- per display refresh ----------
  _tick(ts) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._tick);
    const v = this.video;
    if (this.lastTs) {
      const d = ts - this.lastTs;
      if (d > 2 && d < 100) this.refreshMs = this.refreshMs ? this.refreshMs * 0.95 + d * 0.05 : d;
      if (this.refreshMs && d > this.refreshMs * 1.6 && d < 1000 && !v.paused) { this.lateOut++; this.lateInSec++; }
    }
    this.lastTs = ts;
    if (this.gl) this._pollFences();
    this._second();
    if (!this.cfg || this.noNeed || !this.haveCur || !this.res) return;
    const paused = v.paused || v.ended;
    if (paused) { if (!this.dirty) return; }
    else {
      const interval = 1000 / this.s.targetFps, half = (this.refreshMs || 16.7) * 0.5;
      if (ts < this.nextDue - half) return;
      this.nextDue = (ts - this.nextDue > interval * 2) ? ts + interval : this.nextDue + interval;
    }
    const m = this.cfg.method; let t = 1;
    if (!paused && m !== 'dup') t = Math.min(1, Math.max(0, (ts - this.tCur) / (this.srcMs || 41.7)));
    try { this._draw(t); } catch (e) { return this._fail(e); }
    this.dirty = false; this.outCount++; this._show();
  }

  _draw(t) {
    const gl = this.gl, R = this.res, u = this._use(this.pInterp), m = this.cfg.method;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, R.outW, R.outH);
    const cur = R.full[this.cur], prev = this.havePair ? R.full[1 - this.cur] : cur;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, prev);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, cur);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, R.flow);
    gl.uniform1i(u.u_prev, 0); gl.uniform1i(u.u_cur, 1); gl.uniform1i(u.u_flow, 2);
    const plain = (m === 'dup' || !this.havePair);
    gl.uniform1f(u.u_t, plain ? 1 : t);
    gl.uniform1f(u.u_strength, plain ? 0 : (SV_SMOOTH[this.s.smoothing] || 0.65));
    gl.uniform1i(u.u_useFlow, (m === 'flow' && this.havePair && this.pairFlow) ? 1 : 0);
    gl.uniform1f(u.u_range, R.R); gl.uniform2f(u.u_invA, 1 / R.aw, 1 / R.ah);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---------- once per second: measured stats + auto-degrade ----------
  _second() {
    const now = performance.now(); if (now - this.lastSec < 1000) return;
    const sec = (now - this.lastSec) / 1000; this.lastSec = now;
    this.outFps = this.outCount / sec; this.outCount = 0;
    this.srcFps = this.srcMs ? 1000 / this.srcMs : 0; this.displayHz = this.refreshMs ? 1000 / this.refreshMs : 0;
    if (this.s.autoDegrade && this.cfg && !this.noNeed && !this.video.paused) {
      const lat = Math.max(this.gpuMs, this.cpuMs), budget = (this.srcMs || 41.7) * 0.7;
      const bad = lat > budget || this.lateInSec >= Math.max(4, (this.displayHz || 60) * 0.1) || this.skippedInSec >= 3;
      this.overload = bad ? this.overload + 1 : 0;
      if (this.overload >= 2 && now - this.lastDegrade > 3000 && this.level < this.ladder.length - 1) {
        this.level++; this.lastDegrade = now; this.overload = 0; this.gpuMs = 0; this.cpuMs = 0;
        this._applyLevel(); this._resetHistory(false);
      }
    }
    this.lateInSec = 0; this.skippedInSec = 0;
  }

  getStatus() {
    const c = this.cfg, R = this.res, paused = this.video.paused || this.video.ended;
    return {
      state: this.state, message: this.message, requested: this.s.method,
      effective: c ? c.method : 'bypass', short: SV_SHORT[c ? c.method : 'bypass'], perf: c ? c.perf : null, level: this.level,
      srcFps: this.srcFps, outFps: this.outFps, displayHz: this.displayHz, targetFps: this.s.targetFps,
      cap: this.displayHz ? Math.min(this.s.targetFps, this.displayHz) : this.s.targetFps,
      gpuMs: this.gpuMs, cpuMs: this.cpuMs, skipped: this.skipped, missedSrc: this.missedSrc, lateOut: this.lateOut,
      flowFrames: this.flowFrames, fallbackFrames: this.fallbackFrames, noNeed: this.noNeed,
      processing: this.running && this.state === 'active' && !this.noNeed && !paused && this.haveCur,
      size: R ? `${R.vw}x${R.vh} → ${R.outW}x${R.outH} (analysis ${R.aw}x${R.ah})` : '', renderer: this.renderer || ''
    };
  }
}
