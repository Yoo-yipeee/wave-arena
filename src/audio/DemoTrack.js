/**
 * DemoTrack — a synthesized demo song written straight into an AudioBuffer.
 *
 * A real arrangement (intro, verse, build, drop, break, second build, climax,
 * outro) at 128 BPM in A minor. It is rendered to a buffer, so it plays through
 * exactly the same transport + analyser path as an uploaded file and nothing in
 * the visual pipeline is special-cased for it.
 *
 * Why hand-written DSP rather than an OfflineAudioContext graph: this piece
 * needs ~5,700 nodes, and Chrome's offline renderer keeps every intermediate
 * gain and filter in the pull graph for the whole render — that measured at
 * over a minute before the demo could start, and a ConvolverNode alone cost
 * ~3.7 s. Writing samples directly renders the same arrangement in a fraction
 * of a second, and is completely deterministic.
 */

const BPM = 128;
const BEAT = 60 / BPM;          // 0.46875 s
const BAR = BEAT * 4;           // 1.875 s
const STEP = BEAT / 4;          // 16th
const TAU = Math.PI * 2;

const ARRANGEMENT = [
  { name: 'intro',  from: 0,  to: 6  },
  { name: 'verse',  from: 6,  to: 12 },
  { name: 'build',  from: 12, to: 18 },
  { name: 'drop',   from: 18, to: 26 },
  { name: 'break',  from: 26, to: 30 },
  { name: 'build2', from: 30, to: 34 },
  { name: 'climax', from: 34, to: 42 },
  { name: 'outro',  from: 42, to: 46 },
];
const TOTAL_BARS = 46;          // ~86 s

// A minor: Am - F - C/G - G, two bars each
const CHORDS = [
  { root: 110.00, notes: [220.00, 261.63, 329.63] },
  { root:  87.31, notes: [174.61, 220.00, 261.63] },
  { root: 130.81, notes: [196.00, 261.63, 329.63] },
  { root:  98.00, notes: [196.00, 246.94, 293.66] },
];

const sectionOf = (bar) =>
  ARRANGEMENT.find(s => bar >= s.from && bar < s.to) || ARRANGEMENT[ARRANGEMENT.length - 1];

// Deterministic noise — the demo renders identically every time.
let _seed = 0x2f6e2b1;
const rnd = () => {
  _seed ^= _seed << 13; _seed ^= _seed >>> 17; _seed ^= _seed << 5;
  return ((_seed >>> 0) / 4294967296) * 2 - 1;
};

/** Chamberlin state-variable filter — cheap, stable, resonant. */
const svf = () => ({ lp: 0, bp: 0 });
function svfRun(s, x, fc, sr, q) {
  const f = Math.min(0.95, 2 * Math.sin(Math.PI * Math.min(fc, sr * 0.45) / sr));
  s.lp += f * s.bp;
  const hp = x - s.lp - q * s.bp;
  s.bp += f * hp;
  return { lp: s.lp, bp: s.bp, hp };
}

export async function renderDemoTrack(audioCtx) {
  const sr = audioCtx.sampleRate;
  const n = Math.ceil((TOTAL_BARS * BAR + 2.5) * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const W = new Float32Array(n);        // reverb send (mono)
  _seed = 0x2f6e2b1;

  /** equal-power pan gains */
  const panGains = (p) => {
    const a = (p + 1) * Math.PI / 4;
    return [Math.cos(a) * 1.414, Math.sin(a) * 1.414];
  };

  // ---- voices -------------------------------------------------------------
  function kick(t, g = 1) {
    const i0 = (t * sr) | 0, N = (0.45 * sr) | 0;
    let ph = 0;
    for (let i = 0; i < N; i++) {
      const j = i0 + i; if (j >= n) break;
      const x = i / sr;
      ph += TAU * (44 + 126 * Math.exp(-x * 26)) / sr;
      const env = Math.exp(-x * 6.5) * (1 - Math.exp(-x * 420));
      const s = (Math.sin(ph) * env + Math.exp(-x * 170) * rnd() * 0.32) * g;
      L[j] += s; R[j] += s; W[j] += s * 0.04;
    }
  }

  function snare(t, g = 0.7, send = 0.22) {
    const i0 = (t * sr) | 0, N = (0.22 * sr) | 0;
    const f = svf();
    let ph = 0;
    for (let i = 0; i < N; i++) {
      const j = i0 + i; if (j >= n) break;
      const x = i / sr;
      const nz = svfRun(f, rnd(), 1900, sr, 0.85).bp;
      ph += TAU * (196 * Math.exp(-x * 7) + 130) / sr;
      const s = (nz * 0.95 * Math.exp(-x * 21) + Math.sin(ph) * 0.42 * Math.exp(-x * 30)) * g;
      L[j] += s; R[j] += s; W[j] += s * send;
    }
  }

  function hat(t, g = 0.24, open = false, pan = 0) {
    const i0 = (t * sr) | 0, N = ((open ? 0.2 : 0.06) * sr) | 0;
    const f = svf();
    const [gl, gr] = panGains(pan);
    for (let i = 0; i < N; i++) {
      const j = i0 + i; if (j >= n) break;
      const x = i / sr;
      const s = svfRun(f, rnd(), 7400, sr, 1.3).hp * Math.exp(-x * (open ? 16 : 58)) * g;
      L[j] += s * gl; R[j] += s * gr; W[j] += s * 0.05;
    }
  }

  function bass(t, dur, freq, g = 0.5, cutoff = 620) {
    const i0 = (t * sr) | 0, N = ((dur + 0.18) * sr) | 0;
    const f = svf();
    let ph = 0, ph2 = 0;
    for (let i = 0; i < N; i++) {
      const j = i0 + i; if (j >= n) break;
      const x = i / sr;
      ph += freq / sr; if (ph > 1) ph -= 1;
      ph2 += freq * 0.5 / sr; if (ph2 > 1) ph2 -= 1;
      const env = (1 - Math.exp(-x * 130)) *
        (x < dur ? 0.62 + 0.38 * Math.exp(-x * 9) : Math.exp(-(x - dur) * 34));
      const y = svfRun(f, (2 * ph - 1) * 0.75 + Math.sin(TAU * ph2) * 0.6,
        cutoff * (1 + 1.2 * Math.exp(-x * 9)), sr, 0.32).lp;
      const s = y * env * g;
      L[j] += s; R[j] += s;
    }
  }

  function pad(t, dur, notes, g = 0.16, bright = 1) {
    const i0 = (t * sr) | 0, N = ((dur + 1.8) * sr) | 0;
    const fl = svf(), fr = svf();
    const inc = [], ph = [];
    for (const nt of notes) {
      for (const det of [-6, 6]) {
        inc.push(nt * Math.pow(2, det / 1200) / sr);
        ph.push(rnd() * 0.5 + 0.5);
      }
    }
    const k = inc.length;
    for (let i = 0; i < N; i++) {
      const j = i0 + i; if (j >= n) break;
      const x = i / sr;
      let a = 0, b = 0;
      for (let o = 0; o < k; o++) {
        ph[o] += inc[o]; if (ph[o] > 1) ph[o] -= 1;
        const v = 2 * ph[o] - 1;
        if (o & 1) a += v; else b += v;          // detuned halves feed opposite sides
      }
      a /= k * 0.5; b /= k * 0.5;
      const env = Math.min(1, x / 1.3) * (x < dur ? 1 : Math.exp(-(x - dur) * 1.15));
      const fc = (400 + 520 * Math.min(1, x / (dur * 0.7))) * bright;
      const yl = svfRun(fl, a, fc, sr, 0.9).lp * env * g;
      const yr = svfRun(fr, b, fc * 1.02, sr, 0.9).lp * env * g;
      L[j] += yl; R[j] += yr; W[j] += (yl + yr) * 0.34;
    }
  }

  function pluck(t, freq, g = 0.2, dur = 0.4, pan = 0) {
    if (!isFinite(freq) || freq <= 0) return;
    const i0 = (t * sr) | 0, N = ((dur + 0.08) * sr) | 0;
    const f = svf();
    const [gl, gr] = panGains(pan);
    let ph = 0;
    for (let i = 0; i < N; i++) {
      const j = i0 + i; if (j >= n) break;
      const x = i / sr;
      ph += freq / sr; if (ph > 1) ph -= 1;
      const y = svfRun(f, (ph < 0.5 ? 0.5 : -0.5), 700 + 3500 * Math.exp(-x * (3.2 / dur)), sr, 0.22).lp;
      const s = y * Math.exp(-x * (3.4 / dur)) * (1 - Math.exp(-x * 500)) * g;
      L[j] += s * gl; R[j] += s * gr; W[j] += s * 0.3;
    }
  }

  function riser(t, dur, g = 0.22) {
    const i0 = (t * sr) | 0, N = ((dur + 0.1) * sr) | 0;
    const fn = svf(), fs = svf();
    let ph = 0;
    for (let i = 0; i < N; i++) {
      const j = i0 + i; if (j >= n) break;
      const x = i / sr, u = Math.min(1, x / dur);
      ph += 90 * Math.pow(1500 / 90, u) / sr; if (ph > 1) ph -= 1;
      const saw = svfRun(fs, 2 * ph - 1, 300 * Math.pow(13, u), sr, 1.2).bp;
      const nz = svfRun(fn, rnd(), 400 * Math.pow(22, u), sr, 1.1).bp;
      const env = Math.pow(u, 2.2) * (x < dur ? 1 : Math.exp(-(x - dur) * 30));
      const s = (saw * 0.6 + nz * 0.8) * env * g;
      const w = Math.sin(x * 1.7) * 0.4;             // slow stereo sweep
      L[j] += s * (1 - w); R[j] += s * (1 + w); W[j] += s * 0.35;
    }
  }

  function impact(t, g = 0.85) {
    const i0 = (t * sr) | 0, N = (2.4 * sr) | 0;
    const fl = svf(), fh = svf();
    let ph = 0;
    for (let i = 0; i < N; i++) {
      const j = i0 + i; if (j >= n) break;
      const x = i / sr;
      const low = svfRun(fl, rnd(), 700, sr, 0.8).lp * Math.exp(-x * 2.2);
      const cr = svfRun(fh, rnd(), 6000, sr, 1.0).hp * Math.exp(-x * 2.6) * 0.34;
      ph += TAU * (34 + 76 * Math.exp(-x * 3.4)) / sr;
      const s = (low * 0.55 + Math.sin(ph) * Math.exp(-x * 2.6) + cr) * g;
      L[j] += s; R[j] += s * 0.96; W[j] += s * 0.5;
    }
  }

  // ---- arrangement --------------------------------------------------------
  for (let bar = 0; bar < TOTAL_BARS; bar++) {
    const t0 = bar * BAR;
    const sec = sectionOf(bar);
    const name = sec.name;
    const chord = CHORDS[(bar >> 1) % CHORDS.length];
    const barIn = bar - sec.from;
    const secLen = sec.to - sec.from;

    const full = name === 'drop' || name === 'climax';
    const isBuild = name === 'build' || name === 'build2';
    const buildT = barIn / secLen;

    if (bar % 2 === 0) {
      const padGain = name === 'intro' ? 0.15 : name === 'break' ? 0.19
        : name === 'outro' ? 0.15 : full ? 0.10 : 0.11;
      pad(t0, BAR * 2, chord.notes, padGain, full ? 1.9 : isBuild ? 1.4 : 1);
    }

    for (let s16 = 0; s16 < 16; s16++) {
      const t = t0 + s16 * STEP;
      const beat = s16 / 4;
      const onBeat = s16 % 4 === 0;
      const on8 = s16 % 2 === 0;

      // ---- kick ----
      if (name === 'verse' && onBeat && !(bar === 11 && beat >= 3)) kick(t, 0.9);
      if (full && onBeat) kick(t, 1.0);
      if (full && s16 === 14 && bar % 4 === 3) kick(t, 0.6);
      if (isBuild && onBeat && buildT < 0.62) kick(t, 0.8 * (1 - buildT * 0.5));
      if (name === 'outro' && onBeat && barIn < 2) kick(t, 0.8 - barIn * 0.3);

      // ---- snare ----
      if ((name === 'verse' || full) && (beat === 1 || beat === 3)) {
        snare(t, full ? 0.75 : 0.52, full ? 0.3 : 0.2);
      }
      if (name === 'outro' && barIn < 2 && (beat === 1 || beat === 3)) snare(t, 0.45 - barIn * 0.15);
      if (isBuild) {
        const div = buildT < 0.34 ? 4 : buildT < 0.66 ? 2 : 1;   // roll accelerates
        if (s16 % div === 0) snare(t, 0.18 + buildT * 0.45, 0.25);
      }

      // ---- hats ----
      if (name === 'intro' && bar >= 3 && onBeat) hat(t, 0.11, false, s16 % 8 === 0 ? -0.3 : 0.3);
      if (name === 'verse' && on8) hat(t, s16 % 4 === 2 ? 0.21 : 0.13, s16 === 14, s16 % 4 === 2 ? 0.3 : -0.3);
      if (full) hat(t, s16 % 4 === 2 ? 0.27 : 0.15, s16 % 8 === 6, s16 % 4 === 2 ? 0.35 : -0.35);
      if (isBuild && on8) hat(t, 0.1 + buildT * 0.22, false, s16 % 4 === 2 ? 0.3 : -0.3);

      // ---- bass ----
      if (name === 'verse' && on8 && s16 % 8 !== 6) {
        bass(t, STEP * 1.7, chord.root * (s16 % 8 === 4 ? 2 : 1), 0.36, 480);
      }
      if (full && on8) {
        bass(t, STEP * 1.75, chord.root * (s16 === 6 || s16 === 14 ? 2 : 1), 0.52,
          name === 'climax' ? 900 : 720);
      }
      if (isBuild && onBeat && buildT < 0.7) bass(t, BEAT * 0.8, chord.root, 0.3, 380);

      // ---- melodic ----
      if (name === 'intro' && (s16 === 0 || s16 === 6 || s16 === 11)) {
        pluck(t, chord.notes[s16 % 3] * 2, 0.11, 0.85, s16 === 6 ? 0.45 : -0.45);
      }
      if (name === 'break' && (s16 === 0 || s16 === 10)) {
        pluck(t, chord.notes[s16 ? 2 : 0] * 2, 0.13, 1.1, s16 ? 0.4 : -0.4);
      }
      if (name === 'drop' && s16 % 4 === 2) {
        const k = (s16 >> 2) % 3;
        pluck(t, chord.notes[k] * 2, 0.13, 0.3, (k % 2 ? 1 : -1) * 0.4);
      }
      if (name === 'climax' && on8) {
        const seq = [0, 2, 1, 2, 0, 1, 2, 1];
        const k = seq[(s16 >> 1) % 8];
        pluck(t, chord.notes[k] * 2, 0.16, 0.36, ((s16 >> 1) % 2 ? 1 : -1) * 0.42);
      }
    }

    // ---- transitional gestures ----
    if (bar === 12) riser(t0, BAR * 6 - BEAT, 0.20);
    if (bar === 30) riser(t0, BAR * 4 - BEAT, 0.24);
    if (bar === 18) impact(t0, 0.95);        // the drop
    if (bar === 34) impact(t0, 1.00);        // the climax
    if (bar === 26) impact(t0, 0.42);        // into the break
    if (bar === 42) impact(t0, 0.36);        // into the outro
  }

  reverb(W, L, R, sr);

  // ---- master: soft-clip glue, then normalise -----------------------------
  let peak = 1e-6;
  for (let i = 0; i < n; i++) {
    const l = Math.tanh(L[i] * 0.95);
    const r = Math.tanh(R[i] * 0.95);
    L[i] = l; R[i] = r;
    const a = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
    if (a > peak) peak = a;
  }
  const norm = 0.92 / peak;
  for (let i = 0; i < n; i++) { L[i] *= norm; R[i] *= norm; }

  const buffer = audioCtx.createBuffer(2, n, sr);
  buffer.copyToChannel(L, 0);
  buffer.copyToChannel(R, 1);
  return buffer;
}

/** Four damped comb filters into two allpasses — a small, warm space. */
function reverb(W, L, R, sr) {
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map(d => ({
    buf: new Float32Array(Math.max(1, (d * sr) | 0)), i: 0, lp: 0, fb: 0.8,
  }));
  const aps = [0.0050, 0.0017].map(d => ({
    buf: new Float32Array(Math.max(1, (d * sr) | 0)), i: 0, g: 0.5,
  }));
  const off = (0.011 * sr) | 0;
  const n = W.length;
  for (let k = 0; k < n; k++) {
    const x = W[k];
    let y = 0;
    for (let c = 0; c < combs.length; c++) {
      const cb = combs[c];
      const v = cb.buf[cb.i];
      cb.lp += (v - cb.lp) * 0.42;              // damped tail
      cb.buf[cb.i] = x + cb.lp * cb.fb;
      cb.i = cb.i + 1 === cb.buf.length ? 0 : cb.i + 1;
      y += v;
    }
    y *= 0.25;
    for (let a = 0; a < aps.length; a++) {
      const ap = aps[a];
      const v = ap.buf[ap.i];
      const out = v - ap.g * y;
      ap.buf[ap.i] = y + ap.g * out;
      ap.i = ap.i + 1 === ap.buf.length ? 0 : ap.i + 1;
      y = out;
    }
    L[k] += y * 0.52;
    if (k + off < n) R[k + off] += y * 0.48;    // small offset widens the tail
  }
}

export const DEMO_TITLE = 'WAVE ARENA — DEMO PERFORMANCE';
