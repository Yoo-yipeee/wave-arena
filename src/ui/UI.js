import { formatTime } from '../audio/AudioEngine.js';

const SECTION_LABEL = {
  silence: 'STILL',
  intro: 'INTRO',
  verse: 'FLOW',
  build: 'BUILD',
  drop: 'DROP',
  chorus: 'CHORUS',
  break: 'BREAK',
  outro: 'OUTRO',
};
const HOT_SECTIONS = new Set(['drop', 'chorus', 'build']);

/**
 * UI — every DOM concern lives here.
 * It emits intents; it never reaches into the audio or visual engines.
 */
export class UI {
  constructor() {
    this.el = {
      landing: document.getElementById('landing'),
      dropTarget: document.getElementById('dropTarget'),
      demoBtn: document.getElementById('demoBtn'),
      fileInput: document.getElementById('fileInput'),
      loading: document.getElementById('loading'),
      loadingLabel: document.getElementById('loadingLabel'),
      hud: document.getElementById('hud'),
      trackName: document.getElementById('trackName'),
      stateLabel: document.getElementById('stateLabel'),
      tCur: document.getElementById('tCur'),
      tDur: document.getElementById('tDur'),
      playBtn: document.getElementById('playBtn'),
      playIcon: document.getElementById('playIcon'),
      scrub: document.getElementById('scrub'),
      scrubFill: document.getElementById('scrubFill'),
      scrubHead: document.getElementById('scrubHead'),
      peaks: document.getElementById('peaks'),
      vol: document.getElementById('vol'),
      fsBtn: document.getElementById('fsBtn'),
      newSong: document.getElementById('newSong'),
      wordmark: document.querySelector('.wordmark'),
      toast: document.getElementById('toast'),
    };

    this.on = {};                 // { file, demo, toggle, seek, volume, reset }
    this._scrubbing = false;
    this._idleTimer = 0;
    this._lastMove = performance.now();
    this._peaks = null;
    this._sectionShown = '';

    this._bind();
  }

  emit(name, ...args) { if (this.on[name]) this.on[name](...args); }

  _bind() {
    const e = this.el;

    e.dropTarget.addEventListener('click', () => e.fileInput.click());
    e.dropTarget.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); e.fileInput.click(); }
    });
    e.fileInput.addEventListener('change', () => {
      if (e.fileInput.files && e.fileInput.files[0]) this.emit('file', e.fileInput.files[0]);
      e.fileInput.value = '';
    });
    e.demoBtn.addEventListener('click', () => this.emit('demo'));

    // drag & drop anywhere on the page
    let dragDepth = 0;
    window.addEventListener('dragenter', ev => {
      ev.preventDefault(); dragDepth++; document.body.classList.add('dragging');
    });
    window.addEventListener('dragover', ev => ev.preventDefault());
    window.addEventListener('dragleave', ev => {
      ev.preventDefault(); dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) document.body.classList.remove('dragging');
    });
    window.addEventListener('drop', ev => {
      ev.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
      const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) this.emit('file', f);
    });

    e.playBtn.addEventListener('click', () => this.emit('toggle'));
    e.newSong.addEventListener('click', () => this.emit('reset'));
    e.vol.addEventListener('input', () => this.emit('volume', parseFloat(e.vol.value)));
    e.fsBtn.addEventListener('click', () => this.toggleFullscreen());

    // scrubbing
    const posOf = ev => {
      const r = e.scrub.getBoundingClientRect();
      const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
      return Math.max(0, Math.min(1, x / r.width));
    };
    const down = ev => { this._scrubbing = true; this.emit('seek', posOf(ev)); };
    const move = ev => { if (this._scrubbing) this.emit('seek', posOf(ev)); };
    const up = () => { this._scrubbing = false; };
    e.scrub.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    e.scrub.addEventListener('touchstart', ev => { ev.preventDefault(); down(ev); }, { passive: false });
    e.scrub.addEventListener('touchmove', ev => { ev.preventDefault(); move(ev); }, { passive: false });
    e.scrub.addEventListener('touchend', up);

    // keyboard
    window.addEventListener('keydown', ev => {
      if (ev.target.tagName === 'INPUT') return;
      if (ev.code === 'Space') { ev.preventDefault(); this.emit('toggle'); }
      else if (ev.key === 'f' || ev.key === 'F') this.toggleFullscreen();
      else if (ev.key === 'ArrowRight') this.emit('nudge', 5);
      else if (ev.key === 'ArrowLeft') this.emit('nudge', -5);
    });

    // idle auto-hide
    const wake = () => { this._lastMove = performance.now(); };
    window.addEventListener('mousemove', wake, { passive: true });
    window.addEventListener('touchstart', wake, { passive: true });
    window.addEventListener('keydown', wake);
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.();
  }

  // ---- states -------------------------------------------------------------
  showLoading(label) {
    this.el.loadingLabel.textContent = label;
    this.el.loading.classList.add('on');
  }
  hideLoading() { this.el.loading.classList.remove('on'); }

  enterPerformance(title, duration, peaks) {
    this.el.landing.classList.add('gone');
    this.el.trackName.textContent = title;
    this.el.tDur.textContent = formatTime(duration);
    this.el.hud.classList.add('on');
    this._peaks = peaks;
    this._drawPeaks();
  }

  backToLanding() {
    this.el.landing.classList.remove('gone');
    this.el.hud.classList.remove('on');
    this.el.hud.classList.remove('idle');
    this.el.wordmark.style.opacity = '';
  }

  setPlaying(playing) {
    this.el.playBtn.classList.toggle('playing', playing);
    this.el.playIcon.innerHTML = playing
      ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>'
      : '<path d="M7 4l13 8-13 8z"/>';
    this.el.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  toast(msg) {
    this.el.toast.textContent = msg;
    this.el.toast.classList.add('on');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.el.toast.classList.remove('on'), 4200);
  }

  // ---- per-frame ----------------------------------------------------------
  update(now, engine, perf) {
    const e = this.el;
    if (engine.duration) {
      const p = engine.progress;
      e.scrubFill.style.width = (p * 100) + '%';
      e.scrubHead.style.left = (p * 100) + '%';
      e.tCur.textContent = formatTime(engine.currentTime);
    }

    const label = SECTION_LABEL[perf.section] || '';
    if (label !== this._sectionShown) {
      this._sectionShown = label;
      e.stateLabel.textContent = label;
      e.stateLabel.classList.toggle('hot', HOT_SECTIONS.has(perf.section));
    }

    // fade the chrome away while the performance is running and untouched
    const idle = engine.playing && !this._scrubbing && (now - this._lastMove > 3200);
    e.hud.classList.toggle('idle', idle);
    e.wordmark.style.opacity = idle ? '0' : '';
  }

  _drawPeaks() {
    const c = this.el.peaks;
    if (!c || !this._peaks) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth, h = c.clientHeight || 16;
    if (!w) return;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const n = this._peaks.length;
    const bw = w / n;
    ctx.fillStyle = 'rgba(120,205,255,0.22)';
    for (let i = 0; i < n; i++) {
      const v = this._peaks[i];
      const bh = Math.max(0.6, v * h);
      ctx.fillRect(i * bw, h - bh, Math.max(0.6, bw * 0.62), bh);
    }
  }

  redrawPeaks() { this._drawPeaks(); }
}
