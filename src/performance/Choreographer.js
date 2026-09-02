/**
 * Choreographer — the layer that makes this a performance rather than a meter.
 *
 * It consumes the normalized music state, decides which *section* of the song
 * we are in, and emits a set of smoothly-morphing performance parameters plus
 * discrete wave events. Nothing downstream knows about frequencies; the water,
 * camera and atmosphere only read this.
 *
 * The future pipeline (semantic understanding -> performance plan -> choreography)
 * plugs in here: replace or precede `decideSection` with a planned timeline and
 * every other layer keeps working unchanged.
 */

import { FORM_COUNT, FORM_INDEX } from './Primitives.js';

export const SECTIONS = ['silence', 'intro', 'verse', 'build', 'drop', 'chorus', 'break', 'outro'];

/**
 * Target look per section. Blended, never switched.
 * `height` is the crest height in WORLD UNITS (the arena is 26 units across),
 * so a section's size is something you can read off the table directly.
 */
const LOOKS = {
  silence: {
    height: 0.7, spectrumGain: 0.10, complexity: 0.10, chaos: 0.02, flow: 0.28, symmetry: 2,
    mist: 0.20, spray: 0.0, bloom: 0.55, heat: 0.0, camDist: 40, camHeight: 13.0, fov: 34,
    forms: { radial: 0.10, rings: 0.55, towers: 0.0, walls: 0.10, arches: 0.0, columns: 0.0 },
  },
  intro: {
    height: 1.1, spectrumGain: 0.30, complexity: 0.24, chaos: 0.05, flow: 0.45, symmetry: 2,
    mist: 0.32, spray: 0.03, bloom: 0.7, heat: 0.05, camDist: 38, camHeight: 12.0, fov: 35,
    forms: { radial: 0.30, rings: 0.60, towers: 0.05, walls: 0.18, arches: 0.05, columns: 0.0 },
  },
  verse: {
    height: 2.2, spectrumGain: 0.62, complexity: 0.45, chaos: 0.10, flow: 0.7, symmetry: 2,
    mist: 0.40, spray: 0.12, bloom: 0.85, heat: 0.18, camDist: 34, camHeight: 11.0, fov: 37,
    forms: { radial: 0.55, rings: 0.50, towers: 0.18, walls: 0.30, arches: 0.10, columns: 0.10 },
  },
  build: {
    height: 1.9, spectrumGain: 0.85, complexity: 0.75, chaos: 0.26, flow: 1.05, symmetry: 3,
    mist: 0.60, spray: 0.30, bloom: 1.0, heat: 0.45, camDist: 38, camHeight: 14.5, fov: 39,
    forms: { radial: 0.75, rings: 0.40, towers: 0.55, walls: 0.28, arches: 0.20, columns: 0.35 },
  },
  drop: {
    height: 2.3, spectrumGain: 1.15, complexity: 0.95, chaos: 0.42, flow: 1.35, symmetry: 4,
    mist: 0.85, spray: 1.0, bloom: 1.35, heat: 1.0, camDist: 43, camHeight: 21.0, fov: 46,
    forms: { radial: 1.0, rings: 0.75, towers: 0.9, walls: 0.5, arches: 0.45, columns: 0.6 },
  },
  chorus: {
    height: 2.0, spectrumGain: 1.0, complexity: 0.8, chaos: 0.24, flow: 1.15, symmetry: 4,
    mist: 0.70, spray: 0.6, bloom: 1.15, heat: 0.72, camDist: 41, camHeight: 18.0, fov: 41,
    forms: { radial: 0.9, rings: 0.6, towers: 0.65, walls: 0.4, arches: 0.6, columns: 0.75 },
  },
  break: {
    height: 0.9, spectrumGain: 0.28, complexity: 0.2, chaos: 0.04, flow: 0.4, symmetry: 2,
    mist: 0.34, spray: 0.05, bloom: 0.7, heat: 0.08, camDist: 39, camHeight: 12.0, fov: 34,
    forms: { radial: 0.25, rings: 0.6, towers: 0.02, walls: 0.14, arches: 0.05, columns: 0.0 },
  },
  outro: {
    height: 1.0, spectrumGain: 0.3, complexity: 0.22, chaos: 0.04, flow: 0.42, symmetry: 2,
    mist: 0.35, spray: 0.05, bloom: 0.72, heat: 0.06, camDist: 41, camHeight: 13.0, fov: 33,
    forms: { radial: 0.28, rings: 0.55, towers: 0.02, walls: 0.12, arches: 0.10, columns: 0.0 },
  },
};

/**
 * Phrase variants — every 8 bars the emphasis rotates, so a repeated chorus
 * reads as choreography rather than noise. Each entry is a multiplier set.
 */
const PHRASE_VARIANTS = [
  { radial: 1.0, rings: 1.0, towers: 1.0, walls: 1.0, arches: 1.0, columns: 1.0 },
  { radial: 0.8, rings: 1.2, towers: 0.5, walls: 1.5, arches: 0.6, columns: 1.3 },
  { radial: 1.15, rings: 0.7, towers: 1.4, walls: 0.5, arches: 1.4, columns: 0.7 },
  { radial: 0.9, rings: 1.1, towers: 0.9, walls: 1.2, arches: 0.8, columns: 1.4 },
];

/** Crest height ceiling, world units — the arena is 26 units across. */
const MAX_HEIGHT = 5.2;

/** How long before a planned drop the arena starts building. */
const BUILD_LEAD = 8.0;

const MAX_IMPULSES = 8;
const MIN_SECTION_TIME = { silence: 0.5, intro: 1.5, verse: 2.5, build: 1.5, drop: 5.0, chorus: 3.0, break: 2.0, outro: 3.0 };

export class Choreographer {
  constructor() {
    this.section = 'silence';
    this.prevSection = 'silence';
    this.sectionTime = 0;
    this.time = 0;
    this.phrase = 0;

    this.p = {
      height: 0.7, spectrumGain: 0.1, complexity: 0.1, chaos: 0.02, flow: 0.3, symmetry: 2,
      mist: 0.2, spray: 0, bloom: 0.55, heat: 0, camDist: 40, camHeight: 13.0, fov: 34,
      forms: new Float32Array(FORM_COUNT),
      eruption: 0, shock: 0, intensity: 0, shake: 0, ringRadius: 9, ringWidth: 7,
      // exposed for the UI
      section: 'silence', bpm: 0,
    };
    this.p.forms[FORM_INDEX.rings] = 0.55;

    // impulse ring buffer: xz origin, birth, strength / speed, width, kind
    this.impulseA = new Float32Array(MAX_IMPULSES * 4);
    this.impulseB = new Float32Array(MAX_IMPULSES * 4);
    this._imp = 0;

    this.plan = null;
    this.events = [];   // consumed each frame by camera / spray
    this.resetTrack();
  }

  /**
   * Clear everything that belongs to one song.
   *
   * Without this a second track inherits the first one's loudness ceiling,
   * section state, phrase clock and rolling histories — so it opens mid-chorus
   * with the wrong dynamics for its first half-minute.
   */
  resetTrack(plan = null) {
    this.plan = plan;
    this.section = 'silence';
    this.prevSection = 'silence';
    this.sectionTime = 0;
    this.time = 0;
    this.phrase = -1;

    this._bassHist = [];
    this._riseHist = [];
    this._hiHist = [];
    this._sinceDrop = 99;
    this._buildMinE = 1;     // quietest point of the current build
    this._buildMaxE = 0;
    this._eMax = 0.05;       // loudest the track has been (slowly forgetting)
    this._sinceSurge = 99;
    this._jump = 0;
    this._seekGuard = 0;
    this._lastTime = 0;
    this._lastWall = 0;
    this._sectionStart = 0;      // all in MUSIC time, not render time
    this._lastDropTime = -999;
    this._lastSurgeTime = -999;
    this._toDrop = null;
    this._anticipation = 0;
    this._firedDrop = -1;
    this.events.length = 0;

    const p = this.p;
    p.eruption = 0; p.shock = 0; p.shake = 0; p.intensity = 0;
    p.height = 0.7; p.heat = 0; p.spray = 0;
    for (let i = 0; i < FORM_COUNT; i++) p.forms[i] = 0;
    p.forms[FORM_INDEX.rings] = 0.55;
    p.section = 'silence';
  }

  /** Emit an expanding wave impulse into the field. */
  emit(x, z, strength, speed = 7.5, width = 4.0, kind = 0) {
    const i = this._imp % MAX_IMPULSES;
    this._imp++;
    this.impulseA[i * 4 + 0] = x;
    this.impulseA[i * 4 + 1] = z;
    this.impulseA[i * 4 + 2] = this.time;
    this.impulseA[i * 4 + 3] = strength;
    this.impulseB[i * 4 + 0] = speed;
    this.impulseB[i * 4 + 1] = width;
    this.impulseB[i * 4 + 2] = kind;
    this.impulseB[i * 4 + 3] = 0;
  }

  decideSection(m) {
    if (!m.playing || m.silence > 0.75) return 'silence';

    const e = m.energyShort;
    const el = Math.max(m.energyLong, 0.02);

    // ---- planned structure (the normal path) -------------------------------
    if (this.plan) {
      const t = m.time;
      const L = this.plan.relLevelAt(t);      // 0..1 against this track's plateau
      const toDrop = this._toDrop;

      // A drop the planner found by reading the whole song — the one decision
      // live analysis could never make reliably. Latched by index so it cannot
      // be missed between two frames.
      const di = this.plan.dropIndexBefore(t);
      if (di >= 0 && di !== this._firedDrop && t - this.plan.dropTime(di) < 2.5) {
        this._firedDrop = di;
        return 'drop';
      }
      if (this.section === 'drop' && this.sectionTime < 5.5) return 'drop';

      if (m.progress > 0.86 && L < 0.62) return 'outro';
      if (L < 0.30) return t < 24 ? 'intro' : 'break';

      // The run-up to a known drop IS the build — including the part where the
      // kick drops out and the level actually falls, which no rising-energy
      // test can catch.
      if (toDrop !== null && toDrop <= BUILD_LEAD) return 'build';

      if (L < 0.46) return t < 24 ? 'intro' : 'break';
      if (L > 0.86) return 'chorus';
      if (this._sinceDrop < 16 && L > 0.70) return 'chorus';
      if (L > 0.50) return 'verse';
      return 'break';
    }

    // ---- fallback: live-only inference (no plan available) -----------------
    const ratio = e / el;
    const loud = e > 0.52 && e > this._eMax * 0.85;
    if (m.time > 16 && this._sinceDrop > 8 && loud && m.bass > 0.55 && m.kick > 0.22 &&
        (this._jump > 0.15 || this._buildRelease(m, e))) {
      return 'drop';
    }
    if (this.section === 'drop' && this.sectionTime < 5.5) return 'drop';
    if (m.progress > 0.87 && e < el * 1.02 && e < 0.45) return 'outro';
    if (e < 0.30 && m.time < 22 && this._sinceDrop > 20) return 'intro';
    if (e < 0.13) return 'break';
    if (e < 0.26 && m.beatDensity < 1.6) return 'break';
    if (this._sinceDrop < 24 && e > 0.42) return 'chorus';
    if (this.section === 'build' && this.sectionTime < 10 && e > this._buildMaxE * 0.90 && e > 0.16) {
      return 'build';
    }
    if (this._sinceDrop > 12 && (this._sustainedRise() || this._brightRise())
        && e > 0.16 && e < 0.88 && m.beatDensity > 1.4) {
      return 'build';
    }
    if (e > 0.58 && ratio > 1.02) return 'chorus';
    if (e > 0.2) return 'verse';
    return 'break';
  }

  /**
   * Low end arriving hard after an absence. The comparison window is several
   * seconds wide on purpose: a build usually still has bass in it, so a short
   * window sees no change and the drop goes undetected.
   */
  _bassSurge(m) {
    const h = this._bassHist;
    if (h.length < 180) return false;
    const recent = avg(h.slice(-10));            // ~0.2 s
    const before = avg(h.slice(0, 100));         // ~3-4 s ago
    return recent > 0.55 && recent > before * 1.45 && m.kick > 0.22;
  }

  /**
   * The other, more reliable signature: we have been building, and the music
   * just jumped clear of everything that build contained.
   */
  _buildRelease(m, e) {
    return this.section === 'build'
      && this.sectionTime > 2.0
      && e > Math.max(0.60, this._buildMinE + 0.16);
  }

  /** Energy climbing steadily over ~5 s — the signature of a build. */
  _sustainedRise() {
    const h = this._riseHist;
    if (h.length < 200) return false;
    return avg(h.slice(-60)) - avg(h.slice(0, 60)) > 0.020;
  }

  /** Top end opening up — risers, hat rolls, filter sweeps. */
  _brightRise() {
    const h = this._hiHist;
    if (h.length < 200) return false;
    return avg(h.slice(-60)) - avg(h.slice(0, 60)) > 0.045;
  }

  update(dt, m) {
    this.time += dt;                 // render clock — only for shader impulse rebasing
    this.events.length = 0;

    // Choreographic timing runs on the MUSIC clock, never on accumulated dt.
    // dt is deliberately clamped for simulation stability, so accumulating it
    // makes every section timer run slow whenever the frame rate dips — which
    // stranded the arena in 'drop' for the rest of a track. Deriving from the
    // transport also means seeking lands on the right timings immediately.
    const now = m.time;
    this.sectionTime = Math.max(0, now - this._sectionStart);
    this._sinceDrop = now - this._lastDropTime;
    this._sinceSurge = now - this._lastSurgeTime;

    // A seek makes every rolling history meaningless and would fire a bogus
    // surge from the apparent jump. Drop the histories and hold off briefly.
    //
    // Crucially this is measured against WALL CLOCK, not against music time: a
    // slow frame also advances music time by a large amount, and treating that
    // as a seek re-armed every timer on every frame — which froze the section
    // machine permanently the first time the frame rate dipped.
    const wallNow = performance.now() / 1000;
    const wallDt = this._lastWall ? Math.max(0, wallNow - this._lastWall) : 0;
    this._lastWall = wallNow;
    const drift = m.time - this._lastTime;
    const isSeek = drift < -0.35 || drift > wallDt + 0.5;

    if (isSeek) {
      this._riseHist.length = 0;
      this._hiHist.length = 0;
      this._bassHist.length = 0;
      this._jump = 0;
      this._seekGuard = 1.2;
      this._sectionStart = m.time;
      this._lastDropTime = -999;
      this._lastSurgeTime = m.time;   // no surge from the jump itself
      // Treat drops before the new position as already spent, so scrubbing
      // backwards re-arms them and scrubbing forwards does not replay them.
      if (this.plan) this._firedDrop = this.plan.dropIndexBefore(m.time - 2.5);
    }
    this._lastTime = m.time;
    if (this._seekGuard > 0) this._seekGuard -= dt;

    this._riseHist.push(m.energyShort);
    if (this._riseHist.length > 300) this._riseHist.shift();     // ~5 s
    this._hiHist.push(m.highs);
    if (this._hiHist.length > 300) this._hiHist.shift();
    this._bassHist.push(m.bass);
    if (this._bassHist.length > 260) this._bassHist.shift();      // ~4 s
    if (this.section === 'build') {
      this._buildMinE = Math.min(this._buildMinE, m.energyShort);
      this._buildMaxE = Math.max(this._buildMaxE, m.energyShort);
    }
    // ~35 s half-life: a later, bigger drop can still clear the bar
    this._eMax = Math.max(m.energyShort, this._eMax * Math.exp(-dt * 0.02));
    this._jump = this._riseHist.length > 100
      ? m.energyShort - avg(this._riseHist.slice(-96, -60))
      : 0;

    // ---- section machine with minimum dwell times -------------------------
    this._toDrop = this.plan ? this.plan.timeToNextDrop(m.time) : null;
    this._anticipation = this._toDrop !== null && this._toDrop <= BUILD_LEAD
      ? clamp01(1 - this._toDrop / BUILD_LEAD)
      : (this.section === 'build' ? Math.min(1, this.sectionTime / 9) : 0);

    const want = this.decideSection(m);
    // A drop overrides the minimum dwell time: it is the one moment in a song
    // that must land on the beat it belongs to, not two seconds later. Silence
    // overrides it too, or the arena keeps erupting after the audio has stopped.
    const mayChange = want === 'drop' || want === 'silence'
      || this.sectionTime >= (MIN_SECTION_TIME[this.section] || 2);
    if (want !== this.section && mayChange) {
      this.prevSection = this.section;
      this.section = want;
      this._sectionStart = now;
      this.sectionTime = 0;
      if (want === 'build') { this._buildMinE = m.energyShort; this._buildMaxE = m.energyShort; }
      this.events.push({ type: 'section', from: this.prevSection, to: want });
      if (want === 'drop') {
        this._lastDropTime = now;
        this._lastSurgeTime = now;
        this._sinceDrop = 0;
        this._sinceSurge = 0;
        this.p.eruption = 1.0;
        this.p.shake = 1.0;
        this.emit(0, 0, 2.6, 11, 8.0, 2);
        this.events.push({ type: 'drop' });
      }
      if (want === 'break' || want === 'silence' || want === 'outro') {
        this.events.push({ type: 'settle' });
      }
    }

    // A surge is any large, sudden arrival of energy — the moment a chorus
    // lands, a section changes, a beat re-enters. Deliberately independent of
    // the section machine: whether or not we labelled it a drop, the arena
    // should answer a structural moment with a coordinated wave event.
    if (this._sinceSurge > 5.5 && this._seekGuard <= 0 && this._jump > 0.11
        && m.energyShort > 0.42 && this.section !== 'drop') {
      this._lastSurgeTime = now;
      this._sinceSurge = 0;
      this.p.eruption = Math.max(this.p.eruption, Math.min(0.75, this._jump * 3.2));
      this.p.shake = Math.max(this.p.shake, 0.45);
      this.emit(0, 0, 1.5, 9.5, 6.5, 2);
      this.events.push({ type: 'surge', strength: this._jump });
    }

    // ---- phrase clock ------------------------------------------------------
    const bpm = m.bpm > 40 ? m.bpm : 120;
    const barDur = (60 / bpm) * 4;
    const phrase = Math.floor(m.time / (barDur * 8));
    if (phrase !== this.phrase) { this.phrase = phrase; this.events.push({ type: 'phrase', index: phrase }); }

    // ---- discrete wave events ---------------------------------------------
    if (m.onset) {
      const hot = this.section === 'drop' || this.section === 'chorus';
      if (m.onset.kick) {
        // Kick: forward shockwave from the heart of the arena.
        const jitter = hot ? 2.6 : 0.9;
        this.emit(
          (Math.random() - 0.5) * jitter, (Math.random() - 0.5) * jitter,
          0.7 + m.bass * (hot ? 2.1 : 1.2),
          6.5 + m.bass * 4.5, 3.4 + m.bass * 2.4, 0,
        );
        this.events.push({ type: 'kick', strength: m.bass });
      }
      if (m.onset.snare) {
        // Snare: a sharper, tighter impulse offset from the centre.
        const a = Math.random() * Math.PI * 2;
        const r = 5 + Math.random() * 9;
        this.emit(Math.cos(a) * r, Math.sin(a) * r, 0.42 + m.mids * 1.0, 10 + m.mids * 5, 2.0, 1);
        this.events.push({ type: 'snare', strength: m.mids });
      }
    }

    // ---- eruption / shock envelopes ----------------------------------------
    const sdtEnv = Math.min(0.5, wallDt > 0 ? wallDt : dt);
    this.p.eruption *= Math.exp(-sdtEnv * 0.85);
    this.p.shock = Math.max(this.p.shock * Math.exp(-sdtEnv * 5.0), m.beatPulse * (this.section === 'drop' ? 1 : 0.55));
    this.p.shake *= Math.exp(-sdtEnv * 1.9);

    // ---- parameter morphing -------------------------------------------------
    // Smoothing uses REAL elapsed time. Exponential smoothing is stable for any
    // step, so there is no reason to feed it the clamped simulation dt — doing
    // so made every look converge in slow motion whenever frames were dropped.
    const sdt = Math.min(0.5, wallDt > 0 ? wallDt : dt);
    const look = LOOKS[this.section] || LOOKS.verse;
    const entering = Math.min(1, this.sectionTime / 1.4);
    // Sections that must hit hard morph fast; settling morphs slowly.
    const fast = this.section === 'drop' ? 9 : this.section === 'build' ? 2.2 : 1.5;
    const slow = 0.9;
    const rate = (this.section === 'break' || this.section === 'silence' || this.section === 'outro') ? slow : fast;
    const k = 1 - Math.exp(-sdt * rate);
    const p = this.p;

    // Live music modulation on top of the section target.
    const drive = 0.55 + m.amplitude * 0.9;
    const buildRamp = this._anticipation;

    // crest height, in world units
    // Clamped: a track that sits at full scale with no dynamics (a drone, a
    // heavily limited master) otherwise drives this past anything the camera
    // can frame, and the arena becomes a wall.
    const wantHeight = Math.min(MAX_HEIGHT,
      look.height * (0.62 + m.amplitude * 0.62) * (1 + buildRamp * 0.55)
      + m.bass * 0.85 + this.p.eruption * 1.5);
    p.height += (wantHeight - p.height) * k;
    p.spectrumGain += (look.spectrumGain * (0.65 + m.amplitude * 0.7) - p.spectrumGain) * k;
    p.complexity += (look.complexity * (1 + buildRamp * 0.5) + m.highs * 0.25 - p.complexity) * k;
    p.chaos += (look.chaos * (1 + buildRamp) + m.highs * 0.12 - p.chaos) * k;
    p.flow += (look.flow * (0.8 + m.energyShort * 0.55) - p.flow) * k;
    p.symmetry += (look.symmetry - p.symmetry) * (1 - Math.exp(-sdt * 0.8));
    p.mist += (look.mist * (0.7 + m.amplitude * 0.6) - p.mist) * (1 - Math.exp(-sdt * 1.1));
    p.spray += (look.spray * (0.4 + m.beatPulse * 1.2) - p.spray) * (1 - Math.exp(-sdt * 3.5));
    p.bloom += (look.bloom * (0.85 + m.amplitude * 0.35) - p.bloom) * (1 - Math.exp(-sdt * 1.6));
    const wantHeat = Math.min(1.02, look.heat * (0.6 + m.energyShort * 0.8) + this.p.eruption * 0.5);
    p.heat += (wantHeat - p.heat) * (1 - Math.exp(-sdt * 2.0));
    // Frame the water we actually have, not the water the section nominally wants.
    const distForHeight = look.camDist * (1 + Math.max(0, p.height - 2.4) * 0.13);
    p.camDist += (distForHeight - p.camDist) * (1 - Math.exp(-sdt * 0.55));
    p.camHeight += (look.camHeight - p.camHeight) * (1 - Math.exp(-sdt * 0.55));
    p.fov += (look.fov + this.p.eruption * 4 - p.fov) * (1 - Math.exp(-sdt * 1.2));

    // Spectrum ring geometry breathes with the section.
    const targetR = 8.5 + (1 - m.bass) * 3.0 + (this.section === 'drop' ? 1.5 : 0);
    const targetW = 5.0 + m.amplitude * 5.0 + (this.section === 'chorus' ? 2.0 : 0);
    p.ringRadius += (targetR - p.ringRadius) * (1 - Math.exp(-sdt * 0.9));
    p.ringWidth += (targetW - p.ringWidth) * (1 - Math.exp(-sdt * 0.9));

    // ---- form weights -------------------------------------------------------
    const variant = PHRASE_VARIANTS[this.phrase % PHRASE_VARIANTS.length];
    const fk = 1 - Math.exp(-sdt * (this.section === 'drop' ? 4.0 : 1.1));
    for (const name in FORM_INDEX) {
      const idx = FORM_INDEX[name];
      let target = (look.forms[name] || 0) * (variant[name] || 1);
      // Live nudges so forms answer the mix, not just the section label.
      if (name === 'towers') target *= 0.6 + m.bass * 0.9;
      if (name === 'columns') target *= 0.6 + m.mids * 0.9;
      if (name === 'arches') target *= 0.6 + m.highs * 0.8;
      if (name === 'walls') target *= 0.7 + m.mids * 0.6;
      p.forms[idx] += (Math.min(1.4, target) * entering - p.forms[idx]) * fk;
    }

    p.intensity += (clamp01(m.energyShort * 0.7 + m.amplitude * 0.3 + this.p.eruption * 0.5) - p.intensity)
      * (1 - Math.exp(-sdt * 2.2));
    p.section = this.section;
    p.bpm = m.bpm;
    return p;
  }
}

function avg(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
