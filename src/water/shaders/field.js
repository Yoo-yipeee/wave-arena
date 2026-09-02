import { FORMS_GLSL } from '../../performance/Primitives.js';

/**
 * The shared wave field.
 *
 * One height function, evaluated by every renderable in the arena — the water
 * body, the contour lines, the mirrored reflection and the particles all sample
 * the exact same GLSL, so they can never drift out of agreement.
 */
export const FIELD_GLSL = /* glsl */`
#define TAU 6.28318530718
#define INV_TAU 0.15915494309
#define MAX_IMPULSES 8

uniform float uTime;
uniform float uAmp, uBass, uMids, uHighs, uAir;
uniform float uBeat, uBeatPulse, uBeatPhase;
uniform float uScale, uSpectrumGain, uComplexity, uChaos, uFlow, uSymmetry;
uniform float uRingRadius, uRingWidth;
uniform float uEruption, uShock, uAwake;
uniform float uHeightRef;   // expected crest height now — colour is relative to it
uniform float uRadius;
uniform float uForm[6];
uniform sampler2D uSpectrum;
uniform vec4 uImpulseA[MAX_IMPULSES];   // xz origin, birth time, strength
uniform vec4 uImpulseB[MAX_IMPULSES];   // speed, width, kind, -

// --- hashing / noise -------------------------------------------------------
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}

// --- spectrum --------------------------------------------------------------
float spec(float t) { return texture2D(uSpectrum, vec2(clamp(t, 0.0, 1.0), 0.5)).r; }
float specSmooth(float t) {
  float d = 0.013;
  return spec(t - d) * 0.25 + spec(t) * 0.5 + spec(t + d) * 0.25;
}

${FORMS_GLSL}

// --- transient shockwaves --------------------------------------------------
float impulses(vec2 p) {
  float h = 0.0;
  for (int i = 0; i < MAX_IMPULSES; i++) {
    vec4 A = uImpulseA[i];
    vec4 B = uImpulseB[i];
    if (A.w <= 0.001) continue;
    float age = uTime - A.z;
    if (age < 0.0 || age > 3.4) continue;
    float d = distance(p, A.xy);
    float dd = (d - age * B.x) / max(B.y, 0.4);
    // a leading crest with a short trailing wake
    float ring  = sin(dd * 2.6) * exp(-dd * dd);
    float decay = exp(-age * 1.45) / (1.0 + d * 0.055);
    float kind  = B.z > 1.5 ? 2.4 : (B.z > 0.5 ? 0.85 : 1.0);
    h += ring * decay * A.w * kind;
  }
  return h;
}

// --- the field ------------------------------------------------------------
float waveHeight(vec2 p) {
  float r = length(p);
  float ang = atan(p.y, p.x + 1e-5);
  float edge = 1.0 - smoothstep(uRadius * 0.56, uRadius, r);

  // Resting swell — the arena breathes even in silence.
  float swell = sin(p.x * 0.115 + uTime * 0.42) * cos(p.y * 0.097 - uTime * 0.31) * 0.55
              + sin(dot(p, vec2(0.083, -0.121)) + uTime * 0.55) * 0.40;
  swell *= 0.55 + uAmp * 0.85;

  // Every term below is normalised to roughly unit amplitude; uScale then sets
  // the crest height in world units. Keeping the shape and the size separate is
  // what makes a section's height predictable instead of multiplicative.
  float h = swell * 0.55;
  h += formSum(p, r, ang) * (0.55 + uSpectrumGain * 0.30);
  h += impulses(p) * 0.55;

  // hi-hats: fine, fast surface shimmer
  float shimmer = sin(r * 6.5 - uTime * 11.0) * 0.5 + (fbm(p * 1.6 + uTime * 1.4) - 0.5) * 1.2;
  h += shimmer * uHighs * 0.30 * (0.35 + uComplexity);

  // turbulence grows with the section's chaos
  h += (fbm(p * 0.21 + vec2(uTime * 0.28, -uTime * 0.19)) - 0.5) * uChaos * 1.8;

  // arena-wide coordinated event
  h += uEruption * (1.0 + 0.9 * fbm(p * 0.14 - uTime * 0.5)) * exp(-r * 0.030) * 1.1;
  h += uShock * exp(-r * 0.048) * 0.35;

  h *= uScale;   // world units
  h *= edge;
  return h * uAwake;
}
`;

/** Uniform block shared by every material that samples the field. */
export function createFieldUniforms(THREE, spectrumTexture, radius) {
  return {
    uTime: { value: 0 },
    uAmp: { value: 0 }, uBass: { value: 0 }, uMids: { value: 0 }, uHighs: { value: 0 }, uAir: { value: 0 },
    uBeat: { value: 0 }, uBeatPulse: { value: 0 }, uBeatPhase: { value: 0 },
    uScale: { value: 0.16 }, uSpectrumGain: { value: 0.1 }, uComplexity: { value: 0.1 },
    uChaos: { value: 0.02 }, uFlow: { value: 0.3 }, uSymmetry: { value: 2 },
    uRingRadius: { value: 9 }, uRingWidth: { value: 6 },
    uEruption: { value: 0 }, uShock: { value: 0 }, uAwake: { value: 0.25 },
    uHeightRef: { value: 1.0 },
    uRadius: { value: radius },
    uForm: { value: new Float32Array(6) },
    uSpectrum: { value: spectrumTexture },
    uImpulseA: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
    uImpulseB: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
  };
}
