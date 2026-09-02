/**
 * Visual primitives — the vocabulary the water can "speak".
 *
 * Each primitive is a GLSL height function evaluated over the arena plane and
 * blended by a weight the Choreographer controls. Adding a new form (a human
 * silhouette sampled from an SDF texture, a dancer, a skyline) means appending
 * one entry here plus one GLSL function; nothing else in the pipeline changes.
 *
 * Contract for a form function:
 *     float form_<name>(vec2 p, float r, float ang)
 *   p   arena-plane position (world units)
 *   r   length(p)
 *   ang atan(p.y, p.x)
 *   ->  a SHAPE, normalised to roughly [-1.2, 1.5]. Forms deliberately do not
 *       scale themselves with loudness: the Choreographer owns wave height (in
 *       world units) so the two cannot compound into an unpredictable range.
 */

export const FORM_NAMES = ['radial', 'rings', 'towers', 'walls', 'arches', 'columns'];
export const FORM_INDEX = FORM_NAMES.reduce((o, n, i) => (o[n] = i, o), {});
export const FORM_COUNT = FORM_NAMES.length;

export const FORMS_GLSL = /* glsl */`
// ---------------------------------------------------------------------------
// radial — the song's spectrum wrapped around the arena. This is the signature
// form: the silhouette of the water literally is the shape of the sound.
// ---------------------------------------------------------------------------
float form_radial(vec2 p, float r, float ang) {
  float au  = ang * INV_TAU + 0.5;
  float sym = max(1.0, floor(uSymmetry));
  float m   = abs(fract(au * sym) * 2.0 - 1.0);      // mirrored -> symmetrical
  float s   = specSmooth(m);
  float env = exp(-pow((r - uRingRadius) / uRingWidth, 2.0));
  float ridge = 0.70 + 0.30 * sin(r * 1.7 - uTime * 2.2 * uFlow);
  // a second, finer harmonic keeps the crests from reading as a plain fan
  float fine = 0.82 + 0.18 * specSmooth(fract(m * 2.0 + 0.13));
  return s * env * ridge * fine * 1.15;
}

// ---------------------------------------------------------------------------
// rings — travelling concentric swells; the resting motion of the arena
// ---------------------------------------------------------------------------
float form_rings(vec2 p, float r, float ang) {
  float w1 = sin(r * 0.70 - uTime * 2.0 * uFlow);
  float w2 = sin(r * 1.29 + uTime * 1.25 * uFlow + 1.7);
  float w3 = sin(r * 0.31 - uTime * 0.8 * uFlow + ang * 0.5);
  return (w1 * 0.5 + w2 * 0.3 + w3 * 0.35) * exp(-r * 0.030) * 1.05;
}

// ---------------------------------------------------------------------------
// towers — discrete columns on a ring, each keyed to its own spectral band
// ---------------------------------------------------------------------------
float form_towers(vec2 p, float r, float ang) {
  const float N = 11.0;
  float au   = ang * INV_TAU + 0.5;
  float id   = floor(au * N);
  float cell = fract(au * N) - 0.5;
  float band = hash11(id * 1.37);
  float amp  = specSmooth(band);
  float rad  = 5.5 + 8.0 * hash11(id + 17.0);
  float aw   = 0.15;
  float g = exp(-(cell * cell) / (aw * aw)) * exp(-pow((r - rad) / 2.7, 2.0));
  float pulse = 0.5 + 0.5 * sin(uTime * 2.6 * uFlow + id * 1.9);
  return g * (0.45 + amp * 1.0) * pulse * 1.5;
}

// ---------------------------------------------------------------------------
// walls — a wave wall traversing the arena, slowly rotating its heading
// ---------------------------------------------------------------------------
float form_walls(vec2 p, float r, float ang) {
  float head = uTime * 0.11;
  vec2 d = vec2(cos(head), sin(head));
  float x = dot(p, d);
  float span = 62.0;
  float front = mod(uTime * 6.0 * uFlow, span) - span * 0.5;
  float w1 = exp(-pow((x - front) / 3.2, 2.0)) * (0.8 + 0.2 * sin(x * 0.85 - uTime * 3.0));
  float w2 = exp(-pow((x + front * 0.62) / 4.6, 2.0)) * 0.7;
  return (w1 * 1.0 + w2 * 0.55) * 0.95;
}

// ---------------------------------------------------------------------------
// arches — opposing arcs lifting out of the surface
// ---------------------------------------------------------------------------
float form_arches(vec2 p, float r, float ang) {
  float R    = 9.5 + 3.0 * sin(uTime * 0.21);
  float band = exp(-pow((r - R) / 1.9, 2.0));
  float win  = smoothstep(0.15, 0.95, cos(ang * 2.0 + uTime * 0.32));
  float lift = 0.62 + 0.38 * sin(ang * 6.0 - uTime * 2.1 * uFlow);
  return band * win * lift * 1.25;
}

// ---------------------------------------------------------------------------
// columns — a symmetrical lattice that pulses in unison (chorus architecture)
// ---------------------------------------------------------------------------
float form_columns(vec2 p, float r, float ang) {
  vec2 g    = p / 5.2;
  vec2 id   = floor(g);
  vec2 cell = fract(g) - 0.5;
  float d   = length(cell);
  float sync = 0.35 + 0.65 * pow(max(0.0, sin(uBeatPhase * TAU)), 2.0);
  float lat  = exp(-(d * d) / 0.055);
  float vary = 0.6 + 0.4 * hash21(id);
  return lat * vary * (0.45 + sync * 0.7 + uBeatPulse * 0.5) * 1.15 * exp(-r * 0.028);
}

// ---------------------------------------------------------------------------
float formSum(vec2 p, float r, float ang) {
  float h = 0.0;
  if (uForm[0] > 0.001) h += uForm[0] * form_radial (p, r, ang);
  if (uForm[1] > 0.001) h += uForm[1] * form_rings  (p, r, ang);
  if (uForm[2] > 0.001) h += uForm[2] * form_towers (p, r, ang);
  if (uForm[3] > 0.001) h += uForm[3] * form_walls  (p, r, ang);
  if (uForm[4] > 0.001) h += uForm[4] * form_arches (p, r, ang);
  if (uForm[5] > 0.001) h += uForm[5] * form_columns(p, r, ang);
  return h;
}
`;
