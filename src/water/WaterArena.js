import * as THREE from 'three';
import { createFieldUniforms } from './shaders/field.js';
import {
  SURFACE_VERT, SURFACE_FRAG, LINE_VERT, LINE_FRAG,
  POINTS_VERT, POINTS_FRAG, BACKDROP_VERT, BACKDROP_FRAG,
} from './shaders/materials.js';
import { SPECTRUM_BINS } from '../analysis/MusicAnalyser.js';
import { FORM_COUNT } from '../performance/Primitives.js';

const PALETTE = {
  deep: new THREE.Color(0x01060d),
  mid:  new THREE.Color(0x1273c4),
  hot:  new THREE.Color(0xcaf0ff),
  backTop: new THREE.Color(0x000106),
  backBottom: new THREE.Color(0x01050b),
  glow: new THREE.Color(0x06243f),
};

/**
 * The song's water colour, as a blue-family bilinear blend over
 * (mode: minor..major) x (brightness: dark..bright).
 *
 * Deliberately one hue family: every track should still read as WAVE ARENA.
 * Songs separate themselves through shape, motion and material — harmony only
 * shifts the tone within the family.
 */
const TONE = {
  minorDark:   new THREE.Color(0x0a3a68),   // deep indigo
  minorBright: new THREE.Color(0x1273c4),   // steel blue
  majorDark:   new THREE.Color(0x1a86c8),   // muted aqua
  majorBright: new THREE.Color(0x37c8e8),   // aqua
};

/**
 * WaterArena — every renderable in the performance.
 *
 * Body, contour lines, their mirrored twins, mist and backdrop all share one
 * uniform block, so a single field update moves the entire arena coherently.
 */
export class WaterArena {
  constructor(scene, quality) {
    this.radius = 26;
    this.quality = quality;

    const rings = quality.rings;
    const segments = quality.segments;
    const lineStep = quality.lineStep;

    // ---- spectrum texture ---------------------------------------------------
    this.spectrumData = new Uint8Array(SPECTRUM_BINS);
    this.spectrumTex = new THREE.DataTexture(this.spectrumData, SPECTRUM_BINS, 1, THREE.RedFormat);
    this.spectrumTex.minFilter = THREE.LinearFilter;
    this.spectrumTex.magFilter = THREE.LinearFilter;
    this.spectrumTex.wrapS = THREE.ClampToEdgeWrapping;
    this.spectrumTex.needsUpdate = true;

    // 12 pitch classes, wrapped so pc 11 is adjacent to pc 0 on the circle
    this.chromaData = new Uint8Array(12);
    this.chromaTex = new THREE.DataTexture(this.chromaData, 12, 1, THREE.RedFormat);
    this.chromaTex.minFilter = THREE.LinearFilter;
    this.chromaTex.magFilter = THREE.LinearFilter;
    this.chromaTex.wrapS = THREE.RepeatWrapping;
    this.chromaTex.needsUpdate = true;

    this.U = createFieldUniforms(THREE, this.spectrumTex, this.chromaTex, this.radius);
    this._tone = PALETTE.mid.clone();
    this._toneTarget = PALETTE.mid.clone();
    this._toneScratch = PALETTE.mid.clone();

    // ---- shared polar geometry ---------------------------------------------
    const { positionAttr, triIndex, lineIndex } = buildPolarDisc(rings, segments, this.radius, lineStep);

    const bodyGeo = new THREE.BufferGeometry();
    bodyGeo.setAttribute('position', positionAttr);
    bodyGeo.setIndex(triIndex);
    // The field displaces far beyond the flat disc; skip auto-culling entirely.
    bodyGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), this.radius * 3);

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', positionAttr);      // shared buffer, different index
    lineGeo.setIndex(lineIndex);
    lineGeo.boundingSphere = bodyGeo.boundingSphere;

    // ---- materials ----------------------------------------------------------
    const surfaceUniforms = (reflect) => Object.assign({}, this.U, {
      uDeep: { value: PALETTE.deep.clone() },
      uMid: { value: PALETTE.mid.clone() },
      uHot: { value: PALETTE.hot.clone() },
      uOpacity: { value: 0.9 },
      uHeat: { value: 0 },
      uReflect: { value: reflect },
    });
    const lineUniforms = (reflect) => Object.assign({}, this.U, {
      uMid: { value: PALETTE.mid.clone() },
      uHot: { value: PALETTE.hot.clone() },
      uOpacity: { value: 0.5 },
      uHeat: { value: 0 },
      uReflect: { value: reflect },
    });

    this.bodyMat = new THREE.ShaderMaterial({
      uniforms: surfaceUniforms(0), vertexShader: SURFACE_VERT, fragmentShader: SURFACE_FRAG,
      transparent: true, depthWrite: true, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    this.bodyReflMat = new THREE.ShaderMaterial({
      uniforms: surfaceUniforms(1), vertexShader: SURFACE_VERT, fragmentShader: SURFACE_FRAG,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    this.lineMat = new THREE.ShaderMaterial({
      uniforms: lineUniforms(0), vertexShader: LINE_VERT, fragmentShader: LINE_FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.lineReflMat = new THREE.ShaderMaterial({
      uniforms: lineUniforms(1), vertexShader: LINE_VERT, fragmentShader: LINE_FRAG,
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    // ---- meshes -------------------------------------------------------------
    this.body = new THREE.Mesh(bodyGeo, this.bodyMat);
    this.body.frustumCulled = false;
    this.body.renderOrder = 1;

    this.lines = new THREE.LineSegments(lineGeo, this.lineMat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 2;

    // mirrored twins — the arena stands on its own reflection
    this.bodyRefl = new THREE.Mesh(bodyGeo, this.bodyReflMat);
    this.bodyRefl.scale.y = -1;
    this.bodyRefl.position.y = -0.06;
    this.bodyRefl.frustumCulled = false;
    this.bodyRefl.renderOrder = 0;

    this.linesRefl = new THREE.LineSegments(lineGeo, this.lineReflMat);
    this.linesRefl.scale.y = -1;
    this.linesRefl.position.y = -0.06;
    this.linesRefl.frustumCulled = false;
    this.linesRefl.renderOrder = 0;

    // ---- atmosphere ---------------------------------------------------------
    const pCount = quality.particles;
    const pPos = new Float32Array(pCount * 3);
    const pSeed = new Float32Array(pCount);
    for (let i = 0; i < pCount; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = this.radius * Math.sqrt(Math.random()) * 0.92;
      pPos[i * 3] = Math.cos(a) * r;
      pPos[i * 3 + 1] = 0;
      pPos[i * 3 + 2] = Math.sin(a) * r;
      pSeed[i] = Math.random();
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    pGeo.setAttribute('aSeed', new THREE.BufferAttribute(pSeed, 1));
    pGeo.boundingSphere = bodyGeo.boundingSphere;

    this.mistMat = new THREE.ShaderMaterial({
      uniforms: Object.assign({}, this.U, {
        uMist: { value: 0.2 },
        uSpray: { value: 0 },
        uSize: { value: quality.particleSize },
        uPixelRatio: { value: 1 },
        uMidC: { value: new THREE.Color(0x2a7fc0) },
        uHotC: { value: new THREE.Color(0xd6f4ff) },
      }),
      vertexShader: POINTS_VERT, fragmentShader: POINTS_FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.mist = new THREE.Points(pGeo, this.mistMat);
    this.mist.frustumCulled = false;
    this.mist.renderOrder = 3;

    // ---- backdrop -----------------------------------------------------------
    this.backdropMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: PALETTE.backTop.clone() },
        uBottom: { value: PALETTE.backBottom.clone() },
        uGlow: { value: PALETTE.glow.clone() },
        uGlowStrength: { value: 0.5 },
        uTime: { value: 0 },
      },
      vertexShader: BACKDROP_VERT, fragmentShader: BACKDROP_FRAG,
      side: THREE.BackSide, depthWrite: false,
    });
    this.backdrop = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 24), this.backdropMat);
    this.backdrop.renderOrder = -1;

    scene.add(this.backdrop, this.bodyRefl, this.linesRefl, this.body, this.lines, this.mist);

  }

  setPixelRatio(pr) { this.mistMat.uniforms.uPixelRatio.value = pr; }

  /** Push a frame of music + choreography into the field. */
  update(dt, music, perf, awake, dtSmooth = dt) {
    const U = this.U;
    U.uTime.value += dt;

    U.uAmp.value = music.amplitude;
    U.uBass.value = music.bass;
    U.uMids.value = music.mids;
    U.uHighs.value = music.highs;
    U.uAir.value = music.air;
    U.uBeat.value = music.beat;
    U.uBeatPulse.value = music.beatPulse;
    U.uBeatPhase.value = music.beatPhase;

    // perf.height is already in world units — the field is normalised so this
    // is simply "how tall are the crests right now".
    U.uScale.value = perf.height;
    U.uSpectrumGain.value = perf.spectrumGain;
    U.uComplexity.value = perf.complexity;
    U.uChaos.value = perf.chaos;
    U.uFlow.value = perf.flow;
    U.uSymmetry.value = perf.symmetry;
    U.uRingRadius.value = perf.ringRadius;
    U.uRingWidth.value = perf.ringWidth;
    U.uEruption.value = perf.eruption;
    U.uShock.value = perf.shock;
    U.uAwake.value = awake;
    // Colour is keyed to how tall the water is *expected* to be right now, so a
    // calm section still reads as luminous water rather than fading to black.
    const href = Math.max(0.7, perf.height * 2.3);
    U.uHeightRef.value += (href - U.uHeightRef.value) * (1 - Math.exp(-dtSmooth * 1.4));

    for (let i = 0; i < FORM_COUNT; i++) U.uForm.value[i] = perf.forms[i];

    // ---- harmony -----------------------------------------------------------
    const h = music.harmony;
    if (h) {
      const c = h.chroma;
      for (let i = 0; i < 12; i++) {
        this.chromaData[i] = Math.max(0, Math.min(255, c[i] * 255)) | 0;
      }
      this.chromaTex.needsUpdate = true;

      // Assigned, not interpolated: the tonic is circular, so easing from 11.9
      // to 0.1 would sweep the long way round and visibly spin the arena. It is
      // already smoothed around the circle inside HarmonyAnalyser.
      U.uTonic.value = h.tonic;
      U.uMode.value += (h.mode - U.uMode.value) * (1 - Math.exp(-dt * 0.8));
      U.uConsonance.value += (h.consonance - U.uConsonance.value) * (1 - Math.exp(-dt * 1.5));
      U.uHarmChange.value = h.change;

      // tone: bilinear over (mode, brightness), inside the blue family
      const maj = h.mode * 0.5 + 0.5;
      const bright = Math.min(1, music.highs * 0.55 + music.mids * 0.3 + h.tonalness * 0.3);
      this._toneScratch.copy(TONE.majorDark).lerp(TONE.majorBright, bright);
      this._toneTarget
        .copy(TONE.minorDark).lerp(TONE.minorBright, bright)
        .lerp(this._toneScratch, maj);
      this._tone.lerp(this._toneTarget, 1 - Math.exp(-dt * 0.5));

      this.bodyMat.uniforms.uMid.value.copy(this._tone);
      this.bodyReflMat.uniforms.uMid.value.copy(this._tone);
      this.lineMat.uniforms.uMid.value.copy(this._tone);
      this.lineReflMat.uniforms.uMid.value.copy(this._tone);
    }

    // spectrum -> texture
    const sp = music.spectrum;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      this.spectrumData[i] = Math.max(0, Math.min(255, sp[i] * 255)) | 0;
    }
    this.spectrumTex.needsUpdate = true;

    // heat drives how far the palette pushes toward white
    const heat = perf.heat;
    this.bodyMat.uniforms.uHeat.value = heat;
    this.bodyReflMat.uniforms.uHeat.value = heat;
    this.lineMat.uniforms.uHeat.value = heat;
    this.lineReflMat.uniforms.uHeat.value = heat;

    this.lineMat.uniforms.uOpacity.value = 0.62 + perf.intensity * 0.42;
    this.lineReflMat.uniforms.uOpacity.value = 0.44 + perf.intensity * 0.36;
    this.bodyMat.uniforms.uOpacity.value = 0.50 + perf.intensity * 0.30;

    this.mistMat.uniforms.uMist.value = perf.mist;
    this.mistMat.uniforms.uSpray.value = perf.spray;

    this.backdropMat.uniforms.uTime.value = U.uTime.value;
    this.backdropMat.uniforms.uGlowStrength.value = 0.14 + perf.intensity * 0.30 + perf.eruption * 0.25;
  }

  /** Copy the choreographer's impulse ring buffer into uniforms. */
  syncImpulses(impulseA, impulseB, choreoTime) {
    const A = this.U.uImpulseA.value;
    const B = this.U.uImpulseB.value;
    // The shader's clock is uTime; the choreographer's is its own. Rebase.
    const offset = this.U.uTime.value - choreoTime;
    for (let i = 0; i < A.length; i++) {
      A[i].set(impulseA[i * 4], impulseA[i * 4 + 1], impulseA[i * 4 + 2] + offset, impulseA[i * 4 + 3]);
      B[i].set(impulseB[i * 4], impulseB[i * 4 + 1], impulseB[i * 4 + 2], impulseB[i * 4 + 3]);
    }
  }

  dispose() {
    this.body.geometry.dispose();
    this.lines.geometry.dispose();
    this.mist.geometry.dispose();
    this.backdrop.geometry.dispose();
    [this.bodyMat, this.bodyReflMat, this.lineMat, this.lineReflMat, this.mistMat, this.backdropMat]
      .forEach(m => m.dispose());
    this.spectrumTex.dispose();
    this.chromaTex.dispose();
  }
}

/**
 * A polar disc: dense enough to resolve spectral spikes, with a radius
 * distribution that keeps detail where the arena actually performs.
 * Triangles and contour lines share one position buffer.
 */
function buildPolarDisc(rings, segments, radius, lineStep) {
  const vertCount = 1 + rings * segments;
  const pos = new Float32Array(vertCount * 3);

  // index 0 = centre
  pos[0] = 0; pos[1] = 0; pos[2] = 0;
  const idx = (ring, seg) => 1 + (ring - 1) * segments + (seg % segments);

  for (let i = 1; i <= rings; i++) {
    const t = i / rings;
    const r = radius * Math.pow(t, 1.18);
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      const o = idx(i, j) * 3;
      pos[o] = Math.cos(a) * r;
      pos[o + 1] = 0;
      pos[o + 2] = Math.sin(a) * r;
    }
  }

  const tri = [];
  for (let j = 0; j < segments; j++) tri.push(0, idx(1, j), idx(1, j + 1));
  for (let i = 1; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = idx(i, j), b = idx(i, j + 1), c = idx(i + 1, j), d = idx(i + 1, j + 1);
      tri.push(a, c, b, b, c, d);
    }
  }

  const lines = [];
  for (let i = 1; i <= rings; i++) {
    if (i % lineStep !== 0) continue;
    for (let j = 0; j < segments; j++) lines.push(idx(i, j), idx(i, j + 1));
  }

  const Index = vertCount > 65535 ? Uint32Array : Uint16Array;
  return {
    positionAttr: new THREE.BufferAttribute(pos, 3),
    triIndex: new THREE.BufferAttribute(new Index(tri), 1),
    lineIndex: new THREE.BufferAttribute(new Index(lines), 1),
  };
}
