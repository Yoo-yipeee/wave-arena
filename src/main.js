/**
 * WAVE ARENA — v0
 *
 *   AudioEngine -> MusicAnalyser -> Choreographer -> WaterArena -> Stage -> UI
 *
 * Each stage only knows the shape of the one before it. The visual engine has
 * no reference to any DOM element, and the UI has no reference to any shader.
 */
import * as THREE from 'three';
import { AudioEngine, computePeaks } from './audio/AudioEngine.js';
import { renderDemoTrack, DEMO_TITLE } from './audio/DemoTrack.js';
import { MusicAnalyser } from './analysis/MusicAnalyser.js';
import { Choreographer } from './performance/Choreographer.js';
import { TrackPlan } from './performance/TrackPlan.js';
import { WaterArena } from './water/WaterArena.js';
import { Stage, CinematicCamera, detectQuality } from './renderer/Stage.js';
import { UI } from './ui/UI.js';

const quality = detectQuality();
const stage = new Stage(document.getElementById('stage'), quality);
const arena = new WaterArena(stage.scene, quality);
const camera = new CinematicCamera(stage.camera);
const choreo = new Choreographer();
const engine = new AudioEngine();
const ui = new UI();

arena.setPixelRatio(stage.pixelRatio);
stage.onResize = (pr) => { arena.setPixelRatio(pr); ui.redrawPeaks(); };

let analyser = null;
let awake = 0.22;          // how "alive" the field is: landing 0.22 -> performance 1
let started = false;       // a track is loaded and the arena is live
let last = performance.now();

// Idle music state so the arena breathes before anything is loaded.
const idleMusic = {
  amplitude: 0, sub: 0, bass: 0, mids: 0, highs: 0, air: 0,
  kick: 0, snare: 0, hat: 0, beat: 0, beatPulse: 0,
  energy: 0, energyShort: 0, energyLong: 0, rise: 0, flux: 0,
  bpm: 0, beatPhase: 0, beatConfidence: 0, beatDensity: 0,
  spectrum: new Float32Array(128),
  harmony: null,
  time: 0, progress: 0, playing: false, silence: 1, onset: null,
};

// ---------------------------------------------------------------------------
// Track loading
// ---------------------------------------------------------------------------
async function beginTrack(loader, label) {
  ui.showLoading(label);
  try {
    await engine.resume();
    await loader();
  } catch (err) {
    console.error(err);
    ui.hideLoading();
    ui.toast('COULD NOT DECODE THAT FILE — TRY MP3, WAV OR M4A');
    return;
  }

  if (!analyser) analyser = new MusicAnalyser(engine.analyser, engine.ctx.sampleRate, engine.harmonyAnalyser);

  // Read the whole track before a single frame is drawn: level envelope for the
  // scrubber, loudness reference for the analyser, structure for the plan.
  const { peaks, rms, refRms } = computePeaks(engine.buffer);
  analyser.resetTrack(refRms);
  choreo.resetTrack(new TrackPlan(rms, refRms, engine.duration));

  ui.hideLoading();
  ui.enterPerformance(engine.title, engine.duration, peaks);

  // Cinematic entry: the arena wakes, the camera settles in.
  camera.impulse(0.55);
  started = true;

  engine.play();
  ui.setPlaying(true);
}

ui.on.file = (file) => {
  if (!/^audio\//.test(file.type) && !/\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(file.name)) {
    ui.toast('THAT DOES NOT LOOK LIKE AN AUDIO FILE');
    return;
  }
  engine.ensureContext();
  beginTrack(() => engine.loadFile(file), 'READING ' + file.name.slice(0, 34).toUpperCase());
};

ui.on.demo = () => {
  engine.ensureContext();
  beginTrack(async () => {
    const buf = await renderDemoTrack(engine.ctx);
    engine.setBuffer(buf, DEMO_TITLE);
  }, 'COMPOSING DEMO PERFORMANCE');
};

ui.on.toggle = () => {
  if (!engine.buffer) return;
  engine.toggle();
  ui.setPlaying(engine.playing);
  if (engine.playing) camera.impulse(0.2);
};

ui.on.seek = (p) => { engine.seek(p * engine.duration); };
ui.on.nudge = (d) => { engine.seek(engine.currentTime + d); };
ui.on.volume = (v) => engine.setVolume(v);

ui.on.reset = () => {
  engine.rewind();
  ui.setPlaying(false);
  ui.backToLanding();
  started = false;
};

engine.onEnded = () => {
  ui.setPlaying(false);
  // Nothing to damp here: with playback stopped the analyser decays to silence
  // on its own and the arena settles. Forcing the field down instead left the
  // water at a fraction of its height for the whole of any replay.
};

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
function frame(now) {
  requestAnimationFrame(frame);
  // Two steps, deliberately. `dt` advances the simulation (the field's clock and
  // impulse ages) and is clamped hard so a hitch cannot make the water jump.
  // `dtSmooth` drives exponential smoothing, which is stable at any step size —
  // clamping that only makes every transition crawl when frames are dropped.
  const rawDt = (now - last) / 1000;
  const dt = Math.min(rawDt, 1 / 20);
  const dtSmooth = Math.min(rawDt, 0.5);
  last = now;

  const music = analyser
    ? analyser.update(dtSmooth, engine.currentTime, engine.progress, engine.playing)
    : idleMusic;

  const perf = choreo.update(dt, music);

  // choreography events -> camera
  for (const ev of choreo.events) {
    if (ev.type === 'drop') camera.impulse(1.15);
    else if (ev.type === 'surge') camera.impulse(0.35 + ev.strength * 1.6);
    else if (ev.type === 'section') camera.impulse(0.22);
    else if (ev.type === 'kick' && perf.section === 'drop') camera.impulse(0.07 * ev.strength);
  }

  // Derived, never assigned from events — an event-driven version got stuck at
  // a damped value after a track ended and crippled every subsequent replay.
  const awakeTarget = started ? 1 : 0.22;
  awake += (awakeTarget - awake) * (1 - Math.exp(-dtSmooth * (awakeTarget > awake ? 0.9 : 1.6)));
  stage.fade += (1 - stage.fade) * (1 - Math.exp(-dt * 1.1));   // fade up from black

  arena.syncImpulses(choreo.impulseA, choreo.impulseB, choreo.time);
  arena.update(dt, music, perf, awake, dtSmooth);
  camera.update(dt, perf, music, dtSmooth);
  stage.render(dt, perf);

  ui.update(now, engine, perf);
}

// Fade up from black on first paint.
requestAnimationFrame((t) => { last = t; frame(t); });

// Expose the pipeline for tinkering from the console.
window.WAVE = {
  engine, arena, choreo, stage, camera, ui, THREE,
  get music() { return analyser?.state; },
  get plan() { return choreo.plan?.describe(); },
};
