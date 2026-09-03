/**
 * HarmonyAnalyser — what notes are sounding, not how loud they are.
 *
 * Everything else in the pipeline measures energy. This measures pitch: a
 * 12-bin chroma vector (energy per pitch class), the key and mode it implies,
 * how consonant the current sonority is, and when the harmony changes.
 *
 * Why this exists: loudness tells you a song's shape but nothing about its
 * character. Two tracks with identical dynamics feel completely different if
 * one is a minor drone and the other a major turnaround — and until this
 * module, the arena could not tell them apart at all.
 *
 * It runs off its own AnalyserNode with a large FFT. Transient detection wants
 * a short window (sharp attacks, poor frequency resolution); pitch detection
 * wants the opposite. One node cannot serve both: at fftSize 2048 a semitone
 * near the bass is narrower than a single bin.
 */

const A4 = 440;
const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Krumhansl-Kessler key profiles — how strongly each scale degree is expected
// to sound in a major / minor key. Correlating chroma against all 12 rotations
// of these is the standard way to name a key.
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/**
 * Consonance weight per interval class (0-6 semitones, folded).
 * ic1 (minor 2nd) and ic6 (tritone) are the harsh ones; thirds, fourths and
 * fifths are the sweet ones. Used to turn a chord into a surface texture.
 */
const IC_WEIGHT = [0.0, -1.0, -0.45, 0.85, 1.0, 0.95, -0.8];

const LO_HZ = 65;      // below this the FFT cannot resolve semitones
const HI_HZ = 1700;    // above this, harmonics outnumber fundamentals

export class HarmonyAnalyser {
  constructor(analyserNode, sampleRate) {
    this.analyser = analyserNode;
    this.bins = analyserNode.frequencyBinCount;
    this.db = new Float32Array(this.bins);
    this.lin = new Float32Array(this.bins);
    this.binHz = sampleRate / analyserNode.fftSize;

    this.loBin = Math.max(2, Math.floor(LO_HZ / this.binHz));
    this.hiBin = Math.min(this.bins - 2, Math.ceil(HI_HZ / this.binHz));

    this.raw = new Float32Array(12);
    this.fast = new Float32Array(12);     // ~0.12 s — the current sonority
    this.slow = new Float32Array(12);     // ~1.1 s  — the harmonic context
    this.key = new Float32Array(12);      // long accumulation, for key detection

    this._tonicX = 0; this._tonicY = 0;   // tonic smoothed around the circle
    this._sinceChange = 9;
    this._keyTimer = 0;

    this.state = {
      chroma: this.fast,
      tonic: 0,            // 0-11, fractional
      tonicName: 'C',
      mode: 0,             // -1 fully minor .. +1 fully major
      consonance: 0,       // -1 harsh .. +1 sweet
      tonalness: 0,        // 0 noise/percussion .. 1 clearly pitched
      change: 0,           // decaying pulse, 1 at a harmonic change
      changed: false,      // single-frame flag
      confidence: 0,
    };
  }

  reset() {
    this.raw.fill(0); this.fast.fill(0); this.slow.fill(0); this.key.fill(0);
    this._tonicX = 0; this._tonicY = 0; this._sinceChange = 9; this._keyTimer = 0;
    const s = this.state;
    s.tonic = 0; s.tonicName = 'C'; s.mode = 0; s.consonance = 0;
    s.tonalness = 0; s.change = 0; s.changed = false; s.confidence = 0;
  }

  update(dt, playing) {
    const s = this.state;
    s.changed = false;
    s.change *= Math.exp(-dt * 2.6);
    this._sinceChange += dt;

    if (!playing) {
      const k = 1 - Math.exp(-dt * 1.5);
      for (let i = 0; i < 12; i++) this.fast[i] += (0 - this.fast[i]) * k;
      s.tonalness += (0 - s.tonalness) * k;
      return s;
    }

    // Float, not byte: getByteFrequencyData returns dB compressed into 0-255
    // between minDecibels and maxDecibels, which flattens the very differences
    // chroma depends on — every pitch class came back at 0.6-1.0. In linear
    // amplitude a sounding note towers over the noise floor the way it should.
    this.analyser.getFloatFrequencyData(this.db);

    let maxLin = 1e-9;
    for (let i = this.loBin - 1; i <= this.hiBin + 1; i++) {
      const v = this.db[i];
      const lin = v > -100 ? Math.pow(10, v * 0.05) : 0;
      this.lin[i] = lin;
      if (lin > maxLin) maxLin = lin;
    }

    // ---- chroma, from spectral peaks --------------------------------------
    // A sounding note is a sharp local maximum. Noise and percussion are broad
    // and flat, so peak-picking is what separates "a chord is playing" from
    // "there is energy in this region".
    this.raw.fill(0);
    let peakEnergy = 0, totalEnergy = 0;
    const thresh = maxLin * 0.055;
    for (let i = this.loBin; i <= this.hiBin; i++) {
      const c = this.lin[i];
      totalEnergy += c;
      if (c < thresh) continue;
      const l = this.lin[i - 1], r = this.lin[i + 1];
      if (c <= l || c < r) continue;                 // not a local maximum

      // parabolic interpolation -> sub-bin frequency; worth a lot down low
      const denom = l - 2 * c + r;
      const shift = denom !== 0 ? 0.5 * (l - r) / denom : 0;
      const f = (i + shift) * this.binHz;
      if (f < LO_HZ || f > HI_HZ) continue;

      let pcf = (69 + 12 * Math.log2(f / A4)) % 12;
      if (pcf < 0) pcf += 12;
      const lo = Math.floor(pcf) % 12;
      const frac = pcf - Math.floor(pcf);

      // fundamentals carry the chord; damp the upper harmonics
      const w = c / (1 + f / 700);
      this.raw[lo] += w * (1 - frac);
      this.raw[(lo + 1) % 12] += w * frac;
      peakEnergy += c;
    }

    let peak = 0;
    for (let pc = 0; pc < 12; pc++) if (this.raw[pc] > peak) peak = this.raw[pc];

    // Tonalness: how much of the spectrum sits in sharp peaks rather than
    // spread across the floor. Percussion and noise score low.
    const tone = totalEnergy > 1e-9 ? clamp01((peakEnergy / totalEnergy) * 2.6) : 0;
    s.tonalness += (tone - s.tonalness) * (1 - Math.exp(-dt * 2.0));

    const norm = peak > 1e-9 ? 1 / peak : 0;
    const kf = 1 - Math.exp(-dt * 8.0);
    const ks = 1 - Math.exp(-dt * 0.9);
    for (let pc = 0; pc < 12; pc++) {
      const v = this.raw[pc] * norm;
      this.fast[pc] += (v - this.fast[pc]) * kf;
      this.slow[pc] += (v - this.slow[pc]) * ks;
      this.key[pc] += (v - this.key[pc]) * (1 - Math.exp(-dt * 0.12));
    }

    // ---- harmonic change ---------------------------------------------------
    // A chord change is the fast chroma pulling away from its own context.
    const dist = 1 - cosine(this.fast, this.slow);
    if (dist > 0.30 && this._sinceChange > 0.45 && s.tonalness > 0.25) {
      this._sinceChange = 0;
      s.change = Math.min(1, dist * 2.2);
      s.changed = true;
    }

    // ---- key / mode --------------------------------------------------------
    this._keyTimer -= dt;
    if (this._keyTimer <= 0) {
      this._keyTimer = 0.5;
      this._detectKey();
    }

    // ---- consonance --------------------------------------------------------
    let cons = 0, total = 0;
    for (let i = 0; i < 12; i++) {
      const a = this.fast[i];
      if (a < 0.12) continue;
      for (let j = i + 1; j < 12; j++) {
        const b = this.fast[j];
        if (b < 0.12) continue;
        const d = j - i;
        const ic = Math.min(d, 12 - d);              // interval class 1..6
        const w = a * b;
        cons += w * IC_WEIGHT[ic];
        total += w;
      }
    }
    const target = total > 1e-6 ? cons / total : 0;
    s.consonance += (target - s.consonance) * (1 - Math.exp(-dt * 1.6));

    return s;
  }

  /** Correlate the accumulated chroma against all 24 major/minor key profiles. */
  _detectKey() {
    const s = this.state;
    let bestMaj = -Infinity, bestMin = -Infinity, majRoot = 0, minRoot = 0;
    for (let r = 0; r < 12; r++) {
      let cMaj = 0, cMin = 0;
      for (let i = 0; i < 12; i++) {
        const v = this.key[(i + r) % 12];
        cMaj += v * KK_MAJOR[i];
        cMin += v * KK_MINOR[i];
      }
      if (cMaj > bestMaj) { bestMaj = cMaj; majRoot = r; }
      if (cMin > bestMin) { bestMin = cMin; minRoot = r; }
    }

    const isMajor = bestMaj >= bestMin;
    const root = isMajor ? majRoot : minRoot;
    const top = Math.max(bestMaj, bestMin);
    const spread = Math.abs(bestMaj - bestMin) / Math.max(1e-6, top);

    // Mode is a continuum, not a verdict: a weak major/minor distinction should
    // sit near the middle rather than snapping to one extreme.
    const modeTarget = (isMajor ? 1 : -1) * clamp01(spread * 6.0);
    s.mode += (modeTarget - s.mode) * 0.35;
    s.confidence = clamp01(spread * 5.0);

    // Smooth the tonic *around the circle* — averaging 11 and 0 numerically
    // would land on 5.5, a tritone from either.
    const ang = (root / 12) * Math.PI * 2;
    const k = 0.3;
    this._tonicX += (Math.cos(ang) - this._tonicX) * k;
    this._tonicY += (Math.sin(ang) - this._tonicY) * k;
    let t = Math.atan2(this._tonicY, this._tonicX) / (Math.PI * 2) * 12;
    if (t < 0) t += 12;
    s.tonic = t;
    s.tonicName = PC_NAMES[Math.round(t) % 12] + (isMajor ? '' : 'm');
  }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 1e-9 ? dot / d : 0;
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
