/**
 * MusicAnalyser — turns an AnalyserNode into a normalized, smoothed music state.
 *
 * Design notes:
 *  - Levels are measured against a whole-track reference from the decode-time
 *    pre-scan, so a quiet acoustic track performs as vividly as a mastered EDM
 *    track while its own quiet passages still read as quiet.
 *  - Onsets use per-band spectral flux against an adaptive (median-ish)
 *    threshold rather than a fixed level, which is what makes kick / snare /
 *    hat separation survive across wildly different mixes.
 *  - All outward-facing values are smoothed with asymmetric attack/release so
 *    the water anticipates and flows instead of twitching.
 */

const BANDS = {
  sub:    [20, 60],
  bass:   [60, 160],
  lowMid: [160, 500],
  mid:    [500, 1600],
  hiMid:  [1600, 4500],
  high:   [4500, 10000],
  air:    [10000, 17000],
};

export const SPECTRUM_BINS = 128;

export class MusicAnalyser {
  constructor(analyserNode, sampleRate) {
    this.analyser = analyserNode;
    this.sampleRate = sampleRate;
    this.binCount = analyserNode.frequencyBinCount;
    this.freq = new Uint8Array(this.binCount);
    this.time = new Uint8Array(analyserNode.fftSize);
    this.prevMag = new Float32Array(this.binCount);

    this.binHz = sampleRate / analyserNode.fftSize;
    this.ranges = {};
    for (const k in BANDS) {
      this.ranges[k] = [
        Math.max(1, Math.floor(BANDS[k][0] / this.binHz)),
        Math.min(this.binCount - 1, Math.ceil(BANDS[k][1] / this.binHz)),
      ];
    }

    // Whole-track loudness reference, supplied by the pre-scan. Everything is
    // measured against this rather than a running maximum, so a quiet passage
    // stays quiet instead of being auto-gained back up to full scale.
    this.refRms = 0.2;

    // flux histories for adaptive onset thresholds
    this.fluxHist = { kick: new Ring(48), snare: new Ring(48), hat: new Ring(48) };

    // decaying impulse envelopes
    this.kick = 0; this.snare = 0; this.hat = 0; this.beat = 0; this.beatPulse = 0;
    this._sinceKick = 10; this._sinceSnare = 10; this._sinceHat = 10;

    // smoothed outputs
    this.s = { amplitude: 0, sub: 0, bass: 0, lowMid: 0, mid: 0, hiMid: 0, high: 0, air: 0 };

    this.spectrum = new Float32Array(SPECTRUM_BINS);
    this.spectrumSmooth = new Float32Array(SPECTRUM_BINS);

    // energy envelopes over different horizons
    this.energyFast = 0; this.energyShort = 0; this.energyLong = 0;
    this.beatDensity = 0;

    this.tracker = new BeatTracker();

    this.state = {
      amplitude: 0, sub: 0, bass: 0, mids: 0, highs: 0, air: 0,
      kick: 0, snare: 0, hat: 0, beat: 0, beatPulse: 0,
      energy: 0, energyShort: 0, energyLong: 0, rise: 0, flux: 0,
      bpm: 0, beatPhase: 0, beatConfidence: 0, beatDensity: 0,
      spectrum: this.spectrumSmooth,
      time: 0, progress: 0, playing: false, silence: 1,
    };
  }

  /** @param {number} refRms loud-plateau RMS of the whole track */
  setReference(refRms) { this.refRms = Math.max(refRms, 0.008); }

  /**
   * Clear per-song state. Reusing the analyser across tracks otherwise carries
   * the previous song's onset thresholds, spectrum smoothing and tempo into the
   * opening seconds of the next one.
   */
  resetTrack(refRms) {
    if (refRms !== undefined) this.setReference(refRms);
    this.prevMag.fill(0);
    this.fluxHist = { kick: new Ring(48), snare: new Ring(48), hat: new Ring(48) };
    this.kick = 0; this.snare = 0; this.hat = 0; this.beat = 0; this.beatPulse = 0;
    this._sinceKick = 10; this._sinceSnare = 10; this._sinceHat = 10;
    for (const k in this.s) this.s[k] = 0;
    this.spectrum.fill(0);
    this.spectrumSmooth.fill(0);
    this.energyFast = 0; this.energyShort = 0; this.energyLong = 0;
    this.beatDensity = 0;
    this.tracker = new BeatTracker();
    const st = this.state;
    st.amplitude = 0; st.sub = 0; st.bass = 0; st.mids = 0; st.highs = 0; st.air = 0;
    st.kick = 0; st.snare = 0; st.hat = 0; st.beat = 0; st.beatPulse = 0;
    st.energy = 0; st.energyShort = 0; st.energyLong = 0; st.rise = 0; st.flux = 0;
    st.bpm = 0; st.beatPhase = 0; st.beatConfidence = 0; st.beatDensity = 0;
    st.silence = 1; st.onset = null;
  }

  bandEnergy(mag, key) {
    const [a, b] = this.ranges[key];
    let sum = 0;
    for (let i = a; i <= b; i++) sum += mag[i];
    return sum / (b - a + 1);
  }

  update(dt, transportTime, progress, playing) {
    const st = this.state;
    // Everything here is time-based smoothing and decay, so it wants real
    // elapsed time — not the clamped simulation step. The bound is only a
    // guard against a multi-second stall (tab restored, GC pause).
    dt = Math.min(dt, 0.5);

    if (!playing) {
      // Decay everything toward stillness — silence must look like silence.
      const k = 1 - Math.exp(-dt * 1.6);
      for (const key of ['amplitude', 'sub', 'bass', 'mids', 'highs', 'air', 'energy', 'flux'])
        st[key] += (0 - st[key]) * k;
      st.kick *= Math.exp(-dt * 3);
      st.snare *= Math.exp(-dt * 3);
      st.hat *= Math.exp(-dt * 3);
      st.beat *= Math.exp(-dt * 3);
      st.beatPulse *= Math.exp(-dt * 1.6);
      st.silence += (1 - st.silence) * k;
      for (let i = 0; i < SPECTRUM_BINS; i++) this.spectrumSmooth[i] *= Math.exp(-dt * 2.2);
      st.time = transportTime; st.progress = progress; st.playing = false;
      return st;
    }

    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.time);

    // ---- RMS amplitude from the time domain -------------------------------
    let sum = 0;
    for (let i = 0; i < this.time.length; i += 2) {
      const v = (this.time[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / (this.time.length / 2));

    // ---- magnitudes + per-band energy -------------------------------------
    const mag = this.freq;
    const raw = {};
    for (const k in BANDS) raw[k] = this.bandEnergy(mag, k) / 255;

    // ---- spectral flux, per drum-relevant region --------------------------
    let fluxKick = 0, fluxSnare = 0, fluxHat = 0, fluxAll = 0;
    const kEnd = Math.min(this.binCount - 1, Math.ceil(150 / this.binHz));
    const sStart = Math.floor(180 / this.binHz), sEnd = Math.ceil(2600 / this.binHz);
    const hStart = Math.floor(6000 / this.binHz), hEnd = Math.min(this.binCount - 1, Math.ceil(15000 / this.binHz));
    for (let i = 1; i < this.binCount; i++) {
      const m = mag[i] / 255;
      const d = m - this.prevMag[i];
      const pos = d > 0 ? d : 0;
      fluxAll += pos;
      if (i <= kEnd) fluxKick += pos;
      else if (i >= sStart && i <= sEnd) fluxSnare += pos;
      if (i >= hStart && i <= hEnd) fluxHat += pos;
      this.prevMag[i] = m;
    }
    fluxKick /= Math.max(1, kEnd);
    fluxSnare /= Math.max(1, sEnd - sStart);
    fluxHat /= Math.max(1, hEnd - hStart);
    fluxAll /= this.binCount;

    // ---- adaptive onset detection ----------------------------------------
    this._sinceKick += dt; this._sinceSnare += dt; this._sinceHat += dt;
    const kickOn = this.fluxHist.kick.onset(fluxKick, 1.55, 0.004) && this._sinceKick > 0.11;
    const snareOn = this.fluxHist.snare.onset(fluxSnare, 1.7, 0.0025) && this._sinceSnare > 0.1;
    const hatOn = this.fluxHist.hat.onset(fluxHat, 1.5, 0.0012) && this._sinceHat > 0.055;

    // impulse envelopes: instant attack, exponential release
    this.kick *= Math.exp(-dt * 7.5);
    this.snare *= Math.exp(-dt * 11);
    this.hat *= Math.exp(-dt * 16);
    if (kickOn) { this.kick = Math.min(1, Math.max(this.kick, 0.55 + raw.bass * 1.1)); this._sinceKick = 0; }
    if (snareOn) { this.snare = Math.min(1, Math.max(this.snare, 0.5 + raw.mid * 1.1)); this._sinceSnare = 0; }
    if (hatOn) { this.hat = Math.min(1, Math.max(this.hat, 0.4 + raw.high * 1.3)); this._sinceHat = 0; }

    this.tracker.push(transportTime, fluxKick + fluxSnare * 0.6 + fluxHat * 0.35, kickOn);

    // beat density (onsets per second) — tells builds from breakdowns
    const dens = (kickOn ? 1 : 0) + (snareOn ? 1 : 0) + (hatOn ? 0.5 : 0);
    this.beatDensity += (dens / Math.max(dt, 1e-3) - this.beatDensity) * (1 - Math.exp(-dt * 0.8));

    // ---- level + spectral balance -----------------------------------------
    // `level` is where this moment sits in the track's own dynamic range;
    // `bal` is how much each band dominates the current spectrum (1 = even
    // share). Multiplying them means a band can only read loud when the music
    // is both loud AND weighted toward that band — which is what keeps an
    // intro calm and lets a bass drop hit.
    const amp = clamp01(Math.pow(rms / this.refRms, 0.85));
    let tot = 0;
    for (const k in BANDS) tot += raw[k];
    const share = Math.max(tot / 7, 1e-3);
    const norm = {};
    for (const k in BANDS) {
      const bal = raw[k] / share;
      norm[k] = clamp01(amp * (0.30 + 0.70 * bal));
    }

    // ---- smoothing (fast attack, slower release) ---------------------------
    const sm = (cur, target, up, down) => {
      const rate = target > cur ? up : down;
      return cur + (target - cur) * (1 - Math.exp(-dt * rate));
    };
    const st_ = this.s;
    st_.amplitude = sm(st_.amplitude, amp, 14, 3.6);
    st_.sub = sm(st_.sub, norm.sub, 13, 3.0);
    st_.bass = sm(st_.bass, norm.bass, 15, 4.0);
    st_.lowMid = sm(st_.lowMid, norm.lowMid, 13, 5.0);
    st_.mid = sm(st_.mid, norm.mid, 13, 5.5);
    st_.hiMid = sm(st_.hiMid, norm.hiMid, 16, 7.0);
    st_.high = sm(st_.high, norm.high, 18, 8.5);
    st_.air = sm(st_.air, norm.air, 18, 9.0);

    // ---- log-spaced spectrum for the shader --------------------------------
    const minHz = 40, maxHz = 15000;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const f0 = minHz * Math.pow(maxHz / minHz, i / SPECTRUM_BINS);
      const f1 = minHz * Math.pow(maxHz / minHz, (i + 1) / SPECTRUM_BINS);
      const b0 = Math.max(1, Math.floor(f0 / this.binHz));
      const b1 = Math.max(b0 + 1, Math.min(this.binCount - 1, Math.ceil(f1 / this.binHz)));
      let s = 0;
      for (let b = b0; b < b1; b++) s = Math.max(s, mag[b] / 255);
      // tilt: lift the top end so highs remain visible against bass-heavy mixes
      const tilt = 0.55 + 0.85 * (i / SPECTRUM_BINS);
      this.spectrum[i] = clamp01(s * tilt * 1.35) * (0.18 + 0.82 * amp);
    }
    const upK = 1 - Math.exp(-dt * 22), dnK = 1 - Math.exp(-dt * 6.5);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const t = this.spectrum[i];
      const c = this.spectrumSmooth[i];
      this.spectrumSmooth[i] = c + (t - c) * (t > c ? upK : dnK);
    }

    // ---- energy horizons ---------------------------------------------------
    const inst = amp * 0.6 + norm.bass * 0.25 + norm.hiMid * 0.15;
    this.energyFast += (inst - this.energyFast) * (1 - Math.exp(-dt * 8));
    this.energyShort += (inst - this.energyShort) * (1 - Math.exp(-dt * 1.1));
    this.energyLong += (inst - this.energyLong) * (1 - Math.exp(-dt * 0.14));

    // ---- beat pulse --------------------------------------------------------
    const beatNow = Math.max(this.kick, this.snare * 0.75);
    this.beat = beatNow;
    this.beatPulse = Math.max(this.beatPulse * Math.exp(-dt * 4.2), beatNow);

    // ---- publish -----------------------------------------------------------
    st.amplitude = st_.amplitude;
    st.sub = st_.sub;
    st.bass = st_.bass;
    st.mids = st_.mid * 0.65 + st_.lowMid * 0.35;
    st.highs = st_.hiMid * 0.45 + st_.high * 0.55;
    st.air = st_.air;
    st.kick = this.kick;
    st.snare = this.snare;
    st.hat = this.hat;
    st.beat = this.beat;
    st.beatPulse = this.beatPulse;
    st.flux = fluxAll;
    st.energy = this.energyFast;
    st.energyShort = this.energyShort;
    st.energyLong = this.energyLong;
    st.rise = this.energyShort - this.energyLong;
    st.beatDensity = this.beatDensity;
    st.bpm = this.tracker.bpm;
    st.beatPhase = this.tracker.phase(transportTime);
    st.beatConfidence = this.tracker.confidence;
    // Relative to the track: a quiet mix is not silence, and a gap in a loud
    // master is. An absolute threshold called soft intros "silent" for seconds.
    st.silence += (((rms < this.refRms * 0.035) ? 1 : 0) - st.silence) * (1 - Math.exp(-dt * 2.2));
    st.time = transportTime;
    st.progress = progress;
    st.playing = true;
    st.onset = { kick: kickOn, snare: snareOn, hat: hatOn };
    return st;
  }
}

/** Ring buffer with an adaptive-threshold onset test. */
class Ring {
  constructor(n) { this.buf = new Float32Array(n); this.n = n; this.i = 0; this.filled = 0; }
  push(v) { this.buf[this.i] = v; this.i = (this.i + 1) % this.n; if (this.filled < this.n) this.filled++; }
  mean() { let s = 0; for (let i = 0; i < this.filled; i++) s += this.buf[i]; return this.filled ? s / this.filled : 0; }
  onset(v, factor, floor) {
    const m = this.mean();
    let varsum = 0;
    for (let i = 0; i < this.filled; i++) { const d = this.buf[i] - m; varsum += d * d; }
    const sd = this.filled ? Math.sqrt(varsum / this.filled) : 0;
    const hit = this.filled > 12 && v > Math.max(floor, m * factor + sd * 1.15);
    this.push(v);
    return hit;
  }
}

/**
 * BeatTracker — autocorrelation over the onset envelope.
 * Deliberately conservative: a wrong tempo is worse than no tempo, so a low
 * confidence score simply lets the choreographer fall back to onset-driven timing.
 */
class BeatTracker {
  constructor() {
    this.rate = 100;                       // Hz of the resampled envelope
    this.len = this.rate * 8;              // 8 s window
    this.env = new Float32Array(this.len);
    this.w = 0;
    this.lastT = -1;
    this.bpm = 0;
    this.confidence = 0;
    this.lastBeatTime = 0;
    this.period = 0.5;
    this._acc = 0;
    this._nextAnalyse = 0;
  }

  push(t, flux, isKick) {
    if (this.lastT < 0) { this.lastT = t; return; }
    let dt = t - this.lastT;
    if (dt < 0 || dt > 1) { this.lastT = t; return; }
    this.lastT = t;
    this._acc += dt;
    const stepDur = 1 / this.rate;
    // resample the (variable-rate) frame flux onto a fixed 100 Hz grid
    let guard = 0;
    while (this._acc >= stepDur && guard++ < 64) {
      this._acc -= stepDur;
      this.env[this.w % this.len] = flux;
      this.w++;
    }
    if (isKick) this.lastBeatTime = t;
    if (t > this._nextAnalyse) { this._nextAnalyse = t + 0.75; this.analyse(); }
  }

  analyse() {
    if (this.w < this.len * 0.5) return;
    const n = Math.min(this.w, this.len);
    const buf = new Float32Array(n);
    const start = this.w - n;
    let mean = 0;
    for (let i = 0; i < n; i++) { buf[i] = this.env[(start + i) % this.len]; mean += buf[i]; }
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) { buf[i] -= mean; energy += buf[i] * buf[i]; }
    if (energy < 1e-9) return;

    const minLag = Math.floor(this.rate * 60 / 185);   // 185 BPM
    const maxLag = Math.ceil(this.rate * 60 / 68);     // 68 BPM
    const topLag = Math.min(n - 2, maxLag * 3);

    // Normalising by the TOTAL energy (rather than by the overlap length) makes
    // this a biased estimator, which tapers long lags. That taper matters: the
    // unbiased version inflates sparse long-lag correlations and was picking
    // spurious periods — a 128 BPM track was reading as 102.
    const ac = new Float32Array(topLag + 2);
    for (let lag = minLag; lag <= topLag; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < n; i++) sum += buf[i] * buf[i + lag];
      ac[lag] = sum / energy;
    }

    // Harmonic sum: a true beat period also correlates at 2x and 3x its lag,
    // which is what separates the beat from its subdivisions.
    let best = -Infinity, bestLag = 0, total = 0, count = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let score = ac[lag];
      if (lag * 2 <= topLag) score += ac[lag * 2] * 0.5;
      if (lag * 3 <= topLag) score += ac[lag * 3] * 0.25;
      const bpm = 60 * this.rate / lag;
      score *= 1 + 0.20 * Math.exp(-Math.pow((bpm - 120) / 42, 2));
      total += Math.abs(score); count++;
      if (score > best) { best = score; bestLag = lag; }
    }
    if (!bestLag) return;

    const avgScore = total / Math.max(1, count);
    this.confidence = clamp01(avgScore > 0 ? (best / avgScore - 1) / 2.2 : 0);
    if (this.confidence < 0.18) return;      // a wrong tempo is worse than none

    // sub-bin refinement around the peak
    const y0 = ac[bestLag - 1] || 0, y1 = ac[bestLag], y2 = ac[bestLag + 1] || 0;
    const denom = y0 - 2 * y1 + y2;
    const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / denom)) : 0;

    let bpm = 60 * this.rate / (bestLag + shift);
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;

    this.bpm = this.bpm ? this.bpm * 0.65 + bpm * 0.35 : bpm;
    this.period = 60 / this.bpm;
  }

  phase(t) {
    if (!this.bpm) return 0;
    const d = t - this.lastBeatTime;
    return ((d / this.period) % 1 + 1) % 1;
  }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
