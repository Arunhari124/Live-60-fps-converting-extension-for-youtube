// Shared defaults (loaded by content script, popup, options, background, test page).
const SV_DEFAULTS = {
  enabled: false,        // master switch (off until the user turns it on)
  smoothing: 'medium',   // off | low | medium | high  (how strongly generated frames replace source frames)
  targetFps: 60,         // 30 | 48 | 60 | 90 | 120  (a CAP; capped by display refresh)
  method: 'flow',        // flow | blend | dup
  performance: 'balanced', // performance | balanced | quality
  autoDegrade: true,     // step quality down automatically if the GPU can't keep up
  badge: true            // small on-player label showing the active mode
};
