// GLSL ES 3.00 shaders for the WebGL2 pipeline.
const SV_SHADERS = {
  // Fullscreen triangle, no vertex buffers needed.
  vert: `#version 300 es
out vec2 v_uv;
void main(){
  float x = float((gl_VertexID << 1) & 2);
  float y = float(gl_VertexID & 2);
  v_uv = vec2(x, y);
  gl_Position = vec4(v_uv * 2.0 - 1.0, 0.0, 1.0);
}`,

  // Downsample to luma at analysis resolution (4-tap box).
  down: `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 v_uv; uniform sampler2D u_tex; uniform vec2 u_step; out vec4 o;
float L(vec2 uv){ return dot(texture(u_tex, uv).rgb, vec3(0.299, 0.587, 0.114)); }
void main(){
  float l = 0.25 * (L(v_uv + vec2( u_step.x,  u_step.y)) + L(v_uv + vec2(-u_step.x,  u_step.y))
                  + L(v_uv + vec2( u_step.x, -u_step.y)) + L(v_uv + vec2(-u_step.x, -u_step.y)));
  o = vec4(l, l, l, 1.0);
}`,

  // Block matching: one fragment per 8x8 block. Finds F so that cur(x) ~= prev(x + F).
  // Coarse search with step S, then +/-(S-1) refinement. Zero-motion is favoured (lambda penalty).
  flow: `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D u_prev; uniform sampler2D u_cur;
uniform ivec2 u_size; uniform int u_R; uniform int u_S; uniform float u_lambda;
out vec4 o;
float sad(ivec2 base, ivec2 d){
  float s = 0.0;
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      ivec2 p = base + ivec2(i * 2, j * 2);
      float a = texelFetch(u_cur, p, 0).r;
      float b = texelFetch(u_prev, clamp(p + d, ivec2(0), u_size - 1), 0).r;
      s += abs(a - b);
    }
  }
  return s + u_lambda * length(vec2(d));
}
void main(){
  ivec2 base = ivec2(gl_FragCoord.xy) * 8;
  ivec2 best = ivec2(0);
  float bestc = sad(base, best);
  for (int dy = -u_R; dy <= u_R; dy += u_S) {
    for (int dx = -u_R; dx <= u_R; dx += u_S) {
      if (dx == 0 && dy == 0) continue;
      float c = sad(base, ivec2(dx, dy));
      if (c < bestc) { bestc = c; best = ivec2(dx, dy); }
    }
  }
  ivec2 c0 = best;
  for (int ry = -(u_S - 1); ry <= (u_S - 1); ry++) {
    for (int rx = -(u_S - 1); rx <= (u_S - 1); rx++) {
      if (rx == 0 && ry == 0) continue;
      ivec2 d = c0 + ivec2(rx, ry);
      if (abs(d.x) > u_R || abs(d.y) > u_R) continue;
      float c = sad(base, d);
      if (c < bestc) { bestc = c; best = d; }
    }
  }
  o = vec4(vec2(best) / float(u_R) * 0.5 + 0.5, clamp(bestc / 4.0, 0.0, 1.0), 1.0);
}`,

  // Output: motion-compensated (flow) or plain blend, mixed with the nearest source frame by u_strength.
  interp: `#version 300 es
precision highp float; precision highp sampler2D;
in vec2 v_uv;
uniform sampler2D u_prev; uniform sampler2D u_cur; uniform sampler2D u_flow;
uniform float u_t; uniform float u_strength; uniform float u_range; uniform int u_useFlow; uniform vec2 u_invA;
out vec4 o;
void main(){
  vec3 p0 = texture(u_prev, v_uv).rgb;
  vec3 p1 = texture(u_cur,  v_uv).rgb;
  vec3 nearest = (u_t < 0.5) ? p0 : p1;
  vec3 interp;
  if (u_useFlow == 1) {
    vec2 f = (texture(u_flow, v_uv).rg * 2.0 - 1.0) * u_range * u_invA;
    vec3 a = texture(u_prev, v_uv + u_t * f).rgb;
    vec3 b = texture(u_cur,  v_uv - (1.0 - u_t) * f).rgb;
    float occ = smoothstep(0.10, 0.30, length(a - b));   // mismatch => occlusion/bad vector => fall back
    interp = mix(mix(a, b, u_t), nearest, occ);
  } else {
    interp = mix(p0, p1, u_t);
  }
  o = vec4(mix(nearest, interp, u_strength), 1.0);
}`
};
