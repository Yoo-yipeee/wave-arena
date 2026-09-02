# WAVE ARENA — v0

Turn music into a visual performance. Upload a song, press play, watch a body of
water perform it.

```bash
node server.js
```

Then open **http://localhost:5173**. No build step, no dependencies, no backend.
Audio is decoded and analysed entirely in the browser and never leaves the machine.

- **ENTER DEMO** plays a built-in 88-second track synthesized on the fly
  (intro → verse → build → drop → break → build → climax → outro).
- **DROP A SONG** takes an mp3 / wav / m4a by click or drag-and-drop anywhere.
- Space toggles playback, `F` fullscreen, `←`/`→` seek.

---

## Pipeline

Each stage knows only the shape of the one before it. The visual engine holds no
reference to any DOM element, and the UI holds no reference to any shader.

```
                    ┌── TrackPlan ──┐   structure of the whole song,
                    │  (at load)    │   computed once before playback
                    ▼               │
AudioEngine ──▶ MusicAnalyser ──▶ Choreographer ──▶ WaterArena ──▶ Stage ──▶ UI
  decode          music state       performance       wave field    render
  transport       (normalised)      params + events   + atmosphere  + grade
```

| Module | Responsibility |
|---|---|
| `audio/AudioEngine.js` | Decode, transport, analyser tap, loudness pre-scan |
| `audio/DemoTrack.js` | The demo song, rendered sample-by-sample into an AudioBuffer |
| `analysis/MusicAnalyser.js` | Bands, onsets, spectral flux, BPM → one normalised `musicState` |
| `performance/TrackPlan.js` | Structural read of the whole song: level curve, and where the drops are |
| `performance/Choreographer.js` | Section machine + morphing performance parameters + wave events |
| `performance/Primitives.js` | The vocabulary of shapes the water can speak |
| `water/WaterArena.js` | Body, contour lines, mirrored reflection, mist, backdrop |
| `water/shaders/field.js` | The one height function every renderable samples |
| `renderer/Stage.js` | Renderer, bloom, grade pass, cinematic camera |
| `ui/UI.js` | Every DOM concern; emits intents, never reaches into the engines |

---

## Design decisions worth knowing

**One height field, sampled by everything.** The water body, the contour lines,
their mirrored twins and the particles all evaluate the same GLSL `waveHeight()`
in their vertex shaders (`water/shaders/field.js`). They cannot drift out of
agreement, and adding a new renderable means sampling the same function.

**The spectrum is the silhouette.** The signature form wraps the song's spectrum
around the arena angularly, so the shape of the water literally is the shape of
the sound. This is the main reason two different songs look meaningfully
different rather than the same animation moving at different speeds.

**Shape and size are separated.** Form functions are pure shape, normalised to
roughly unit amplitude; the Choreographer owns crest height and expresses it in
**world units** (the arena is 26 units across). Earlier the forms scaled
themselves with loudness *and* a global scale multiplied them again — the two
compounded, so calm sections went invisible while drops left the frame. Now
`LOOKS.drop.height = 2.3` means something you can read off the table.

**Levels are measured against the whole track.** `computePeaks()` pre-scans the
decoded buffer and hands the analyser the 92nd-percentile RMS. A running
auto-gain has nothing to compare against during a quiet intro, so it normalises
near-silence up to full scale — which made quiet passages look like choruses.

**The structure is read before playback, not guessed during it.** The whole
buffer is decoded before the first frame, so `TrackPlan` builds a level curve for
the entire song and locates its drops up front. Inferring that live from a few
seconds of history is guesswork — a loud verse and a real drop sit within ~0.05
of each other, and a rear-view window cannot tell "this is loud" from "this is
the loudest thing in the song". On the demo the planner finds 12.3 s, 34.2 s and
64.4 s, against actual arrangement events at 11.25 s, 33.75 s and 63.75 s.

**A build is the run-up to a drop, not a rising-energy reading.** Because the
plan knows where the drops are, the arena *anticipates*: it starts building
`BUILD_LEAD` seconds out and ramps toward the moment. This also handles the part
of a build where the kick drops out and the measured level falls — which no
rising-energy test can catch, and which used to read as a verse.

**Spectacle is decoupled from labelling.** A separate *surge* event fires on any
large sudden arrival of energy regardless of the current section label, so a
structural moment still gets its coordinated wave event when the labelling is
unsure.

**Choreographic time is music time.** Section timers, drop cooldowns and surge
spacing are all derived from the transport clock, never accumulated from frame
deltas. `dt` is clamped for simulation stability, so accumulating it makes every
timer run slow whenever frames are dropped — which permanently stranded the
arena mid-drop the first time the frame rate dipped. Parameter smoothing uses
real elapsed time for the same reason (exponential smoothing is stable at any
step, so there is no reason to feed it a clamped value).

**Events latch, they don't sample a window.** A planned drop is claimed by index
once the transport passes it, not by testing whether "now" falls inside a
one-second window. A window has to be sampled while it is open; a dropped frame
can step straight over it and silently lose the biggest moment in the song.

**The body writes depth.** The water body is translucent but `depthWrite: true`,
so near crests genuinely occlude the contour lines behind them. That occlusion is
what gives the arena its depth; without it the lines read as a flat pattern.

**The demo is hand-written DSP.** As an OfflineAudioContext graph the
arrangement needs ~5,700 nodes, and Chrome keeps every intermediate gain and
filter in the pull graph for the whole render — over a minute before playback
could start, with a single `ConvolverNode` costing ~3.7 s on its own. Writing
samples directly renders the same music in a fraction of a second.

---

## Extending it

**A new visual form** — add a GLSL function to `performance/Primitives.js`
following the documented contract, append its name to `FORM_NAMES`, and give it
weights in the Choreographer's `LOOKS` table. Nothing else changes. This is where
silhouettes, dancers, skylines and landscapes plug in: a form is free to sample
an SDF texture instead of computing an analytic shape.

**A smarter planner** — `TrackPlan` is already the performance-plan stage of the
eventual `SONG → analysis → understanding → performance plan → choreography`
pipeline, just computed locally with no model. It is the only thing that knows a
song's structure, and it exposes a small interface (`relLevelAt`, `riseAt`,
`timeToNextDrop`, `dropIndexBefore`). Replacing it with a model-backed planner —
one that also understands sections, lyrics and repetition — means implementing
that interface; the Choreographer, water, camera and renderer are untouched.

**Tuning** — `window.WAVE` exposes `{ engine, arena, choreo, stage, camera, ui, music }`
in the console for live poking.

## Performance

Desktop runs at 60 fps (190×384 polar grid, ~1,900 particles, DPR ≤ 2); worst
frame measured 19.9 ms. Viewports under ~620 px or low-core devices drop to a
104×200 grid, 800 particles and half-resolution bloom automatically — also
measured at 60 fps. Portrait viewports pull the camera back so the arena stays
whole in frame, and the camera also backs off as the waves themselves get taller.

Per-frame cost of the pipeline itself is ~1.5 ms (choreography 0.11 ms, field
uniforms 0.06 ms, render submit 1.37 ms), so the budget is dominated by the GPU.

The choreography is frame-rate independent by construction: a full run at a
forced ~12 fps produces the same section timeline, with all three drops, both
builds, the break and the outro landing on the same bars as at 60 fps.
