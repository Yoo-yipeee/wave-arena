/**
 * TrackPlan — a structural read of the whole song, computed once at load time.
 *
 * The section machine used to infer structure from a few seconds of history,
 * which is guesswork: a loud verse and a real drop sit within a few percent of
 * each other, and a rear-view window cannot tell "this is loud" from "this is
 * the loudest thing in the song". But the entire buffer is already decoded
 * before the first frame, so the structure does not have to be guessed at all.
 *
 * This is the local, no-model version of the eventual
 *   SONG -> analysis -> understanding -> performance plan -> choreography
 * pipeline. Swapping in a smarter planner later means replacing this class;
 * the Choreographer's interface to it (`levelAt`, `riseAt`, `dropNear`) stays.
 */
export class TrackPlan {
  /**
   * @param {Float32Array} rms   per-bin RMS envelope of the whole track
   * @param {number} refRms      the track's loud-plateau RMS
   * @param {number} duration    seconds
   */
  constructor(rms, refRms, duration) {
    const n = rms.length;
    this.n = n;
    this.duration = duration;
    this.binDur = duration / n;

    // Level: where each moment sits in the track's own dynamic range.
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) raw[i] = Math.min(1, Math.pow(rms[i] / refRms, 0.85));
    this.level = smooth(raw, Math.max(1, Math.round(0.9 / this.binDur)));

    // Rise: how much louder than ~2.5 s ago.
    const back = Math.max(1, Math.round(2.5 / this.binDur));
    this.rise = new Float32Array(n);
    for (let i = 0; i < n; i++) this.rise[i] = this.level[i] - this.level[Math.max(0, i - back)];

    // Loud plateau of this particular track, for relative thresholds.
    const sorted = Array.from(this.level).sort((a, b) => a - b);
    this.peakLevel = Math.max(0.25, sorted[Math.floor(n * 0.97)] || 1);

    this.drops = this._findDrops(back);
  }

  /**
   * A drop is a large rise that lands near the loudest the track ever gets.
   * Candidates are thinned to the strongest in each neighbourhood so a single
   * event cannot fire twice, and so a long crescendo yields one moment.
   */
  _findDrops(back) {
    const minGap = Math.max(1, Math.round(9 / this.binDur));
    const riseGate = 0.13;
    const levelGate = this.peakLevel * 0.80;

    const cands = [];
    for (let i = back; i < this.n; i++) {
      if (this.level[i] < levelGate || this.rise[i] < riseGate) continue;
      // local maximum of rise within a short window
      let isPeak = true;
      const w = Math.max(1, Math.round(1.2 / this.binDur));
      for (let j = Math.max(0, i - w); j <= Math.min(this.n - 1, i + w); j++) {
        if (this.rise[j] > this.rise[i]) { isPeak = false; break; }
      }
      if (isPeak) cands.push({ i, score: this.rise[i] + this.level[i] * 0.5 });
    }

    cands.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const c of cands) {
      if (kept.every(k => Math.abs(k.i - c.i) >= minGap)) kept.push(c);
    }
    return kept.map(c => c.i * this.binDur).sort((a, b) => a - b);
  }

  _idx(t) {
    const i = Math.floor(t / this.binDur);
    return i < 0 ? 0 : i >= this.n ? this.n - 1 : i;
  }

  levelAt(t) { return this.level[this._idx(t)]; }
  riseAt(t) { return this.rise[this._idx(t)]; }

  /** Level relative to this track's own loud plateau (0..~1). */
  relLevelAt(t) { return Math.min(1.3, this.levelAt(t) / this.peakLevel); }

  /**
   * Seconds until the next planned drop, or null if none remains.
   * This is what lets the arena *anticipate*: a build is not a thing we detect
   * after the fact, it is the run-up to a drop we already know is coming.
   */
  timeToNextDrop(t) {
    for (let i = 0; i < this.drops.length; i++) {
      if (this.drops[i] > t) return this.drops[i] - t;
    }
    return null;
  }

  /**
   * Index of the most recent planned drop at or before `t`, else -1.
   *
   * Callers latch on the index rather than testing a time window: a window has
   * to be sampled while it is open, and a dropped frame or a throttled tab can
   * step straight over it — silently losing the biggest moment in the song.
   */
  dropIndexBefore(t) {
    let idx = -1;
    for (let i = 0; i < this.drops.length; i++) {
      if (this.drops[i] <= t + 0.12) idx = i; else break;
    }
    return idx;
  }

  dropTime(i) { return this.drops[i]; }

  /** Diagnostics. */
  describe() {
    return {
      duration: +this.duration.toFixed(1),
      peakLevel: +this.peakLevel.toFixed(2),
      drops: this.drops.map(d => +d.toFixed(1)),
    };
  }
}

function smooth(a, w) {
  if (w <= 1) return a;
  const n = a.length;
  const out = new Float32Array(n);
  let sum = 0;
  const half = Math.floor(w / 2);
  for (let i = 0; i < n; i++) {
    sum += a[i];
    if (i >= w) sum -= a[i - w];
    const c = Math.min(i, w - 1) + 1;
    out[Math.max(0, i - half)] = sum / c;
  }
  // tail
  for (let i = Math.max(0, n - half); i < n; i++) out[i] = a[i];
  return out;
}
