# SmoothVision (v0.1.0)
TV-style motion smoothing for YouTube in Chrome. Local only: no network access, no uploads, no downloads.

## Install
1. Chrome → `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open a YouTube watch page, **reload it once**, click the SmoothVision icon, switch **Enable** on.
4. Local test: Options → "Open local test page" (or open `chrome-extension://<id>/test.html`). Use "Synthetic 24 fps test pattern" or pick a video file.

## How it works (honest summary)
- Frames come from the `<video>` via `requestVideoFrameCallback`, uploaded to WebGL2 textures.
- **Optical Flow** = GPU 8x8 block matching on a reduced-resolution luma image + motion-compensated warp. It is an *approximation*, not dense per-pixel flow. Occlusions fall back to the nearest source frame.
- **Frame Blending** cross-fades neighbouring frames (no motion estimation). **Frame Duplication** repeats frames (no new motion information).
- Output is drawn on an overlay canvas on top of the video. The original video element is untouched; disabling removes the canvas.
- The overlay is delayed by one source frame (~33–42 ms), so picture lags audio by about that much.
- Output FPS shown is **measured** (frames actually drawn per second), and can never exceed your display refresh rate. Targets above it (90/120 on a 60 Hz monitor) cannot be reached.
- WebGPU is detected and reported but not used; WebGL2 is more broadly supported on Kepler-era GPUs.

## Limits
- Not applied in Picture-in-Picture (PiP shows the original video). DRM/protected video cannot be read and falls back to the original with an error message.
- Fast scenes with big motion, text overlays, and scene cuts will show artifacts.
- Only `https://www.youtube.com/watch` pages (and the test page).

## Troubleshooting
- Popup says "Open a YouTube watch page": reload the YouTube tab after installing/reloading the extension.
- "Hardware WebGL2 unavailable": check `chrome://gpu`; update the NVIDIA driver; make sure hardware acceleration is on in Chrome settings.
- Stuttering / "Bypassed": the GPU couldn't keep up. Choose Performance mode, lower YouTube quality to 720p, or use Frame Blending. Keep "Auto-lower quality" on.
- Shader compile errors in the console (F12): report the message; lowering the search range in `SV_PROFILES` (interpolation.js) is the first thing to try.
