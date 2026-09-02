/**
 * AudioEngine — decode / transport / analyser tap.
 *
 * Everything (uploaded files AND the synthetic demo) becomes an AudioBuffer
 * played through an AudioBufferSourceNode, so the analysis path is identical
 * regardless of source. Nothing leaves the browser.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.gain = null;
    this.analyser = null;

    this.title = '';
    this.playing = false;
    this._startedAt = 0;    // ctx.currentTime when playback began
    this._offset = 0;       // position within buffer at _startedAt
    this._volume = 0.85;

    this.onEnded = null;
    this.onTrackLoaded = null;
  }

  /** Must be called from a user gesture. */
  ensureContext() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });

    this.gain = this.ctx.createGain();
    this.gain.gain.value = this._volume;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.55;
    this.analyser.minDecibels = -92;
    this.analyser.maxDecibels = -12;

    // Tap post-gain so the visual follows what is actually heard.
    this.gain.connect(this.analyser);
    this.gain.connect(this.ctx.destination);
    return this.ctx;
  }

  async resume() {
    this.ensureContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  async loadArrayBuffer(arrayBuffer, title) {
    this.ensureContext();
    this.stop();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.title = title;
    this._offset = 0;
    if (this.onTrackLoaded) this.onTrackLoaded(this);
    return this.buffer;
  }

  async loadFile(file) {
    const ab = await file.arrayBuffer();
    const title = file.name.replace(/\.[^.]+$/, '');
    return this.loadArrayBuffer(ab, title);
  }

  setBuffer(buffer, title) {
    this.stop();
    this.buffer = buffer;
    this.title = title;
    this._offset = 0;
    if (this.onTrackLoaded) this.onTrackLoaded(this);
  }

  play() {
    if (!this.buffer || this.playing) return;
    this.resume();

    // Release any previous source before starting a new one.
    if (this.source) {
      this.source.onended = null;
      try { this.source.disconnect(); } catch (e) { /* already gone */ }
      this.source = null;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    src.onended = () => {
      // `onended` is dispatched asynchronously, so by the time it runs this
      // source may already have been replaced — pressing play immediately after
      // a track finishes is enough to hit that. A stale handler must not
      // rewind and stop the source that superseded it.
      if (this.source !== src || src._intentionalStop) return;
      this.playing = false;
      this._offset = 0;
      if (this.onEnded) this.onEnded();
    };
    src.start(0, Math.min(this._offset, this.buffer.duration - 0.02));
    this._startedAt = this.ctx.currentTime;
    this.source = src;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this._offset = this.currentTime;
    this.stop();
  }

  stop() {
    if (this.source) {
      this.source._intentionalStop = true;
      try { this.source.stop(); } catch (e) { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
    this.playing = false;
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  /** Return to the start without playing. */
  rewind() { this.stop(); this._offset = 0; }

  seek(t) {
    if (!this.buffer) return;
    const target = Math.max(0, Math.min(t, this.buffer.duration - 0.05));
    const wasPlaying = this.playing;
    this.stop();
    this._offset = target;
    if (wasPlaying) this.play();
  }

  setVolume(v) {
    this._volume = v;
    if (this.gain) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  get volume() { return this._volume; }

  get currentTime() {
    if (!this.buffer) return 0;
    if (!this.playing) return this._offset;
    return Math.min(this._offset + (this.ctx.currentTime - this._startedAt), this.buffer.duration);
  }

  get duration() { return this.buffer ? this.buffer.duration : 0; }
  get progress() { return this.duration ? this.currentTime / this.duration : 0; }
}

export function formatTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/**
 * Loudness pre-scan over the decoded buffer.
 *
 * Returns the scrubber envelope AND a reference level for the analyser. Having
 * a whole-track reference before the first frame is what lets a quiet intro
 * actually look quiet: a running auto-gain has nothing to compare against yet,
 * so it normalises near-silence up to full scale.
 */
export function computePeaks(buffer, bins = 420) {
  const chans = Math.min(2, buffer.numberOfChannels);
  const data = buffer.getChannelData(0);
  const data2 = chans > 1 ? buffer.getChannelData(1) : null;
  const step = Math.floor(data.length / bins) || 1;
  const peaks = new Float32Array(bins);
  let max = 1e-6;
  for (let i = 0; i < bins; i++) {
    let sum = 0, cnt = 0;
    const start = i * step;
    const end = Math.min(start + step, data.length);
    // RMS reads better than absolute peak at this scale.
    for (let j = start; j < end; j += 4) {
      const v = data2 ? (data[j] + data2[j]) * 0.5 : data[j];
      sum += v * v; cnt++;
    }
    const rms = Math.sqrt(sum / Math.max(1, cnt));
    peaks[i] = rms;
    if (rms > max) max = rms;
  }

  // 92nd percentile: the track's loud plateau, immune to a single transient.
  const sorted = Array.from(peaks).sort((a, b) => a - b);
  const refRms = Math.max(sorted[Math.floor(bins * 0.92)] || max, 0.008);

  const shaped = new Float32Array(bins);
  for (let i = 0; i < bins; i++) shaped[i] = Math.pow(peaks[i] / max, 0.72);
  // `peaks` = raw RMS for the structural planner, `shaped` = for the scrubber
  return { peaks: shaped, rms: peaks, refRms };
}
