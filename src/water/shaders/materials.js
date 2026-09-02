import { FIELD_GLSL } from './field.js';

/* ---------------------------------------------------------------------------
 * WATER BODY
 * A translucent volume that writes depth, so near crests genuinely occlude the
 * contour lines behind them. That occlusion is what gives the arena its depth.
 * ------------------------------------------------------------------------- */
export const SURFACE_VERT = /* glsl */`
${FIELD_GLSL}
varying float vH;
varying float vR;
varying vec3  vWorld;
varying vec3  vNrm;

void main() {
  vec2 p = vec2(position.x, position.z);
  float h  = waveHeight(p);
  float e  = 0.40;
  float hx = waveHeight(p + vec2(e, 0.0));
  float hz = waveHeight(p + vec2(0.0, e));
  vec3 n = normalize(vec3(-(hx - h) / e, 1.0, -(hz - h) / e));

  vec3 pos = vec3(position.x, h, position.z);
  vec4 world = modelMatrix * vec4(pos, 1.0);
  vWorld = world.xyz;
  vNrm   = normalize(mat3(modelMatrix) * n);
  vH = h;
  vR = length(p);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const SURFACE_FRAG = /* glsl */`
precision highp float;
uniform vec3  uDeep, uMid, uHot;
uniform float uOpacity, uHeat, uReflect, uRadius, uAwake, uHeightRef;
varying float vH;
varying float vR;
varying vec3  vWorld;
varying vec3  vNrm;

void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 N = normalize(vNrm);
  if (uReflect > 0.5) N.y = -N.y;

  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);

  vec3 L1 = normalize(vec3(0.30, 0.80, 0.52));
  vec3 L2 = normalize(vec3(-0.62, 0.34, -0.30));
  float spe = pow(max(dot(reflect(-L1, N), V), 0.0), 72.0)
            + pow(max(dot(reflect(-L2, N), V), 0.0), 30.0) * 0.35;
  float diff = max(dot(N, L1), 0.0);

  float hn    = clamp(vH / uHeightRef, -1.2, 2.2);
  float crest = smoothstep(0.12, 1.05, hn);
  float deepness = smoothstep(0.35, -0.6, hn);

  vec3 col = mix(uDeep, uMid, clamp(hn * 0.70 + 0.16, 0.0, 1.0)) * 0.62;
  col = mix(col, uHot, crest * crest * (0.20 + uHeat * 0.42));
  col += uMid * fres * 0.34;
  col += vec3(0.80, 0.94, 1.0) * spe * (0.28 + uHeat * 0.55);
  col += uMid * diff * 0.06;
  col *= 1.0 - deepness * 0.62;

  float edgeFade = 1.0 - smoothstep(uRadius * 0.60, uRadius * 0.99, vR);
  float a = uOpacity * edgeFade * (0.16 + crest * 0.74 + fres * 0.26);

  if (uReflect > 0.5) {
    a   *= 0.30 * (1.0 - smoothstep(0.0, uHeightRef * 2.4, abs(vH)));
    col *= 0.82;
  }
  col *= 0.74 + uHeat * 0.20;
  gl_FragColor = vec4(col * uAwake, clamp(a, 0.0, 1.0) * uAwake);
}
`;

/* ---------------------------------------------------------------------------
 * CONTOUR LINES
 * The signature of the reference imagery: layered luminous curves. Additive,
 * depth-tested against the body so far lines disappear behind near crests.
 * ------------------------------------------------------------------------- */
export const LINE_VERT = /* glsl */`
${FIELD_GLSL}
varying float vH;
varying float vR;
varying float vSlope;

void main() {
  vec2 p = vec2(position.x, position.z);
  float h  = waveHeight(p);
  float e  = 0.55;
  float hx = waveHeight(p + vec2(e, 0.0));
  vSlope = abs(hx - h) / e;
  vH = h;
  vR = length(p);
  vec4 world = modelMatrix * vec4(position.x, h, position.z, 1.0);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const LINE_FRAG = /* glsl */`
precision highp float;
uniform vec3  uMid, uHot;
uniform float uOpacity, uHeat, uReflect, uRadius, uAwake, uHeightRef;
varying float vH;
varying float vR;
varying float vSlope;

void main() {
  float hn    = clamp(vH / uHeightRef, -1.0, 2.2);
  float crest = smoothstep(-0.15, 0.95, hn);
  // steep flanks catch the light — this is what draws the "spikes"
  float rim   = clamp(vSlope * 3.2 / uHeightRef, 0.0, 1.4);

  vec3 col = mix(uMid * 1.05, uHot, clamp(crest * (0.45 + uHeat * 0.7) + rim * 0.25, 0.0, 1.0));
  float edgeFade = 1.0 - smoothstep(uRadius * 0.52, uRadius * 0.98, vR);
  float a = uOpacity * edgeFade * (0.22 + crest * 0.85 + rim * 0.32);
  if (uReflect > 0.5) a *= 0.34 * (1.0 - smoothstep(0.0, uHeightRef * 2.2, abs(vH)));
  gl_FragColor = vec4(col * a * uAwake, 1.0);   // premultiplied, additive
}
`;

/* ---------------------------------------------------------------------------
 * ATMOSPHERE — mist riding the surface, spray thrown on big events
 * ------------------------------------------------------------------------- */
export const POINTS_VERT = /* glsl */`
${FIELD_GLSL}
attribute float aSeed;
uniform float uMist, uSpray, uSize, uPixelRatio;
varying float vA;
varying float vHot;

void main() {
  vec2 p = vec2(position.x, position.z);
  float h = waveHeight(p);

  float seed = aSeed;
  // each particle runs its own slow rise-and-reset cycle
  float life = fract(seed * 7.31 + uTime * (0.055 + 0.10 * seed) * (0.6 + uSpray * 1.8));
  float lift = life * (0.9 + uSpray * 6.0 * (0.30 + seed));

  vec2 drift = vec2(sin(uTime * 0.13 + seed * 41.0), cos(uTime * 0.11 + seed * 27.0)) * 1.6;
  vec3 pos = vec3(position.x + drift.x, h + lift + 0.25, position.z + drift.y);

  vec4 mv = viewMatrix * modelMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float near = smoothstep(0.0, 0.25, life);          // fade in
  float far  = 1.0 - smoothstep(0.55, 1.0, life);    // fade out
  float rFade = 1.0 - smoothstep(uRadius * 0.45, uRadius * 0.95, length(p));
  // mist belongs to the water, not the sky: fade it out as it rises away
  float hFade = 1.0 - smoothstep(2.5, 11.0, lift);
  vA   = near * far * rFade * hFade * (0.03 + uMist * 0.20 + uSpray * 0.40);
  vHot = clamp(h * 0.10 + uSpray * 0.5, 0.0, 1.0);

  gl_PointSize = uSize * uPixelRatio * (0.45 + seed) * (1.0 + uSpray * 1.4) * (44.0 / max(1.0, -mv.z));
}
`;

export const POINTS_FRAG = /* glsl */`
precision highp float;
uniform vec3 uMidC, uHotC;
varying float vA;
varying float vHot;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d);
  if (r > 0.25) discard;
  float soft = smoothstep(0.25, 0.0, r);
  vec3 col = mix(uMidC, uHotC, vHot);
  gl_FragColor = vec4(col * soft * vA, 1.0);   // premultiplied, additive
}
`;

/* ---------------------------------------------------------------------------
 * BACKDROP — a dark graded shell so the arena sits inside a space, not a void
 * ------------------------------------------------------------------------- */
export const BACKDROP_VERT = /* glsl */`
varying vec3 vPos;
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const BACKDROP_FRAG = /* glsl */`
precision highp float;
uniform vec3  uTop, uBottom, uGlow;
uniform float uGlowStrength, uTime;
varying vec3 vPos;

void main() {
  vec3 d = normalize(vPos);
  float y = d.y * 0.5 + 0.5;
  vec3 col = mix(uBottom, uTop, smoothstep(0.30, 0.92, y));

  // a soft pool of light sitting just above the horizon, behind the water
  float horizon = exp(-pow((d.y - 0.02) * 5.2, 2.0));
  col += uGlow * horizon * uGlowStrength * 0.5;

  // extremely subtle banding break
  float g = fract(sin(dot(d.xy, vec2(12.9898, 78.233)) + uTime * 0.05) * 43758.5453);
  col += (g - 0.5) * 0.006;
  gl_FragColor = vec4(col, 1.0);
}
`;
