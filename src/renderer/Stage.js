import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/** Grade pass: vignette, edge chromatic aberration, film grain, global fade. */
const GRADE = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.62 },
    uGrain: { value: 0.028 },
    uAber: { value: 0.9 },
    uFade: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uAber, uFade;
    varying vec2 vUv;
    void main(){
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float d = length(c);
      float k = uAber * 0.006 * d * d;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * k).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * k).b;
      col *= 1.0 - uVignette * smoothstep(0.30, 1.05, d);
      float g = fract(sin(dot(uv * vec2(97.3, 131.7) + uTime * 0.41, vec2(12.9898, 78.233))) * 43758.5453);
      col += (g - 0.5) * uGrain;
      gl_FragColor = vec4(max(col, 0.0) * uFade, 1.0);
    }
  `,
};

export function detectQuality() {
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(ua)
    || (navigator.maxTouchPoints > 1 && window.innerWidth < 1100);
  const small = Math.min(window.innerWidth, window.innerHeight) < 620;
  const weak = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;

  if (mobile || small || weak) {
    return {
      tier: 'low', rings: 104, segments: 200, lineStep: 3,
      particles: 800, particleSize: 2.4, maxDpr: 1.5,
      antialias: false, bloomRes: 0.5,
    };
  }
  return {
    tier: 'high', rings: 190, segments: 384, lineStep: 3,
    particles: 1900, particleSize: 2.1, maxDpr: 2,
    antialias: true, bloomRes: 1,
  };
}

export class Stage {
  constructor(canvas, quality) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality.antialias,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
    });
    this.renderer.setClearColor(0x000208, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 900);
    this.camera.position.set(0, 14, 40);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.60, 0.62);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.grade = new ShaderPass(GRADE);
    this.grade.renderToScreen = true;
    this.composer.addPass(this.grade);

    this.fade = 0;         // 0 = black, 1 = fully visible
    this.ready = false;
    this.resize();
    window.addEventListener('resize', () => this.resize(), { passive: true });

    // A window resize event never fires for a container that is simply laid out
    // late, so watch the canvas itself and pick up its real size when it lands.
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas);
    }
  }

  get pixelRatio() { return Math.min(window.devicePixelRatio || 1, this.quality.maxDpr); }

  resize() {
    // Never let a dimension reach zero. The constructor sizes the stage
    // immediately, and in a hidden iframe or a container that has not been laid
    // out yet the viewport reads 0 — which builds zero-sized render targets and
    // makes every draw fail with an incomplete framebuffer until some later
    // resize happens to rescue it.
    const w = Math.max(1, window.innerWidth | 0);
    const h = Math.max(1, window.innerHeight | 0);
    this.ready = w > 1 && h > 1;

    const pr = this.pixelRatio;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.bloom.setSize(
      Math.max(1, Math.round(w * this.quality.bloomRes)),
      Math.max(1, Math.round(h * this.quality.bloomRes)),
    );
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.onResize) this.onResize(pr);
  }

  render(dt, perf) {
    // Nothing to draw into yet; drawing anyway just logs GL errors every frame.
    if (!this.ready) return;
    this.grade.uniforms.uTime.value += dt;
    this.grade.uniforms.uFade.value = this.fade;
    this.bloom.strength = 0.26 + perf.bloom * 0.26 + perf.eruption * 0.34;
    this.bloom.radius = 0.52 + perf.intensity * 0.22;
    this.bloom.threshold = 0.74 - perf.heat * 0.12;
    this.composer.render(dt);
  }
}

/**
 * CinematicCamera — the arena is the hero; the camera only breathes with it.
 * Slow orbital drift, section-driven framing, and short impulses on big events.
 */
export class CinematicCamera {
  constructor(camera) {
    this.cam = camera;
    this.az = Math.PI * 0.5;
    this.dist = 30;
    this.height = 5;
    this.fov = 38;
    this.shake = 0;
    this.push = 0;
    this.target = new THREE.Vector3(0, 1.4, 0);
    this._t = 0;
    this._look = new THREE.Vector3(0, 1.4, 0);
  }

  /** Short cinematic shove — used on drops and section changes. */
  impulse(strength = 1) {
    this.shake = Math.min(1.4, this.shake + strength);
    this.push = Math.min(1.2, this.push + strength * 0.85);
  }

  update(dt, perf, music, dtSmooth = dt) {
    this._t += dt;
    const t = this._t;

    // slow orbit — faster when the arena is energetic, never fast enough to notice
    this.az += dt * (0.026 + perf.intensity * 0.05);

    this.push *= Math.exp(-dtSmooth * 1.35);
    this.shake *= Math.exp(-dtSmooth * 2.2);

    // A portrait viewport sees far less width, so the arena has to sit further
    // back to stay whole. Without this the water crops to the frame edges on
    // phones and stops reading as an object in a space.
    const aspectComp = 1 + Math.max(0, 1.25 - this.cam.aspect) * 0.55;

    const k = 1 - Math.exp(-dtSmooth * 1.6);
    this.dist += (perf.camDist * aspectComp - this.push * 4.6 - this.dist) * k;
    this.height += (perf.camHeight - this.height) * k;
    this.fov += (perf.fov - this.fov) * (1 - Math.exp(-dtSmooth * 2.4));

    // handheld micro-motion, layered so it never reads as a loop
    const hx = Math.sin(t * 0.37) * 0.28 + Math.sin(t * 0.91 + 1.3) * 0.14;
    const hy = Math.sin(t * 0.29 + 2.1) * 0.22 + Math.sin(t * 0.73) * 0.10;

    // beat-locked shake, strongest during drops
    const s = this.shake * (0.5 + perf.intensity);
    const sx = (Math.sin(t * 41.0) + Math.sin(t * 27.3)) * 0.5 * s * 0.34;
    const sy = (Math.sin(t * 33.7) + Math.sin(t * 51.1)) * 0.5 * s * 0.26;

    const x = Math.cos(this.az) * this.dist + hx + sx;
    const z = Math.sin(this.az) * this.dist + hx * 0.4;
    const y = this.height + hy + sy + music.bass * 0.5;

    this.cam.position.set(x, y, z);

    // look slightly above the surface; lift the framing when the arena erupts
    const ty = 1.2 + perf.intensity * 2.4 + perf.eruption * 3.0;
    this._look.x += (hx * 0.3 - this._look.x) * (1 - Math.exp(-dtSmooth * 2));
    this._look.y += (ty - this._look.y) * (1 - Math.exp(-dtSmooth * 1.2));
    this._look.z += (0 - this._look.z) * (1 - Math.exp(-dtSmooth * 2));
    this.cam.lookAt(this._look);

    if (Math.abs(this.cam.fov - this.fov) > 0.01) {
      this.cam.fov = this.fov;
      this.cam.updateProjectionMatrix();
    }
  }
}
