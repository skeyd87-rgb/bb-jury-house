// Post-processing: what turns a lit scene into a picture.
//
//   RenderPass (half-float)  ->  GTAO (half res)  ->  bloom  ->  tone map  ->  FXAA  ->  grade
//
// GTAO grounds everything: furniture sits on the floor, people stand in the
// room rather than on top of it. Bloom is thresholded high so only real light
// sources (bulbs, neon, the pool) glow. The grade pass is the broadcast look:
// a soft vignette, split-toned shadows/highlights and a little sensor grain.
//
// Cost is the constraint. On integrated graphics (measured: Intel Iris Xe) a
// 4x MSAA half-float target alone cost ~11 ms and full-res GTAO another ~11,
// so anti-aliasing is one FXAA pass and GTAO runs at half resolution. On top
// of that there is a quality ladder: each step down trades effects or render
// resolution for frame time. It steps down by itself when frames run long and
// remembers where it landed, so the next launch does not start by lagging.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    vignette: { value: 0.34 },
    grain: { value: 0.028 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time; uniform float vignette; uniform float grain;
    varying vec2 vUv;
    float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    void main(){
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 c = tex.rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      // Split tone: the UI's green-black in the shadows, brass in the highlights.
      c += vec3(-0.012, 0.006, 0.004) * (1.0 - smoothstep(0.0, 0.45, l));
      c += vec3(0.020, 0.010, -0.014) * smoothstep(0.55, 1.0, l);
      // Gentle S-curve and a touch of saturation.
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, 1.08);
      vec2 d = vUv - 0.5;
      c *= 1.0 - vignette * smoothstep(0.25, 0.95, dot(d, d) * 2.2);
      c += (hash(vUv * vec2(1920.0, 1080.0) + fract(time) * 91.7) - 0.5) * grain;
      gl_FragColor = vec4(c, tex.a);
    }`,
};

// The ladder, best first. `scale` multiplies the render resolution; the final
// pass upsamples to the canvas, which costs far less than shading the pixels.
const LEVELS = [
  { ao: false, bloom: false, scale: 0.6 },   // 0  Fast
  { ao: false, bloom: true, scale: 0.7 },    // 1
  { ao: false, bloom: true, scale: 0.85 },   // 2  Balanced (phones start here)
  { ao: true, bloom: true, scale: 0.85 },    // 3
  { ao: true, bloom: true, scale: 1 },       // 4  High
];
const STORE = 'bbjury.gfx';
const TARGET_MS = 24;   // step down when the average frame runs longer than this

export function createPostFx(renderer, scene, camera) {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  let quality = coarse ? 2 : 4;
  // Integrated graphics cannot hold High at desktop resolutions; starting
  // there just means several seconds of lag while the watchdog walks down.
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    if (!coarse && /Intel|SwiftShader|llvmpipe|Microsoft Basic/i.test(gpu) && !/Arc\b/i.test(gpu)) quality = 2;
  } catch { /* no renderer info: keep the default */ }
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved && Number.isInteger(saved.q) && saved.q >= 0 && saved.q < LEVELS.length) quality = saved.q;
  } catch { /* private mode: start from the device default */ }

  const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  const gtao = new GTAOPass(scene, camera, 4, 4);
  gtao.blendIntensity = 0.92;
  gtao.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.4, thickness: 1.2, scale: 1.25, samples: 8, distanceFallOff: 1, screenSpaceRadius: false });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 8 });
  // The AO normal pass draws everything with one opaque override material, so
  // alpha-tested hair cards, glass, water and decals would occlude as solid
  // slabs. Hide anything that is not a plain opaque surface while it runs.
  const hidden = [];
  gtao.overrideVisibility = function () {
    scene.traverse((o) => {
      if (!o.visible) return;
      const m = o.material;
      const skip = o.isPoints || o.isLine || o.isSprite || o.userData.noAO ||
        (o.isMesh && m && !Array.isArray(m) && (m.transparent || m.alphaTest > 0 || m.side === THREE.BackSide));
      if (skip) { o.visible = false; hidden.push(o); }
    });
  };
  gtao.restoreVisibility = function () {
    for (const o of hidden) o.visible = true;
    hidden.length = 0;
  };
  composer.addPass(gtao);

  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.34, 0.7, 1.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const fxaa = new ShaderPass(FXAAShader);
  composer.addPass(fxaa);
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  // Fabric sheen and clearcoat each add a second BRDF evaluation per light,
  // and the houseguests carry them on ~350 meshes under a dozen lights: about
  // a quarter of the frame on integrated graphics. Below High they are off.
  // Houseguests join the scene after this is built, so it is re-applied
  // periodically from render() as well as on every quality change.
  function applyMaterialTier() {
    const rich = quality >= LEVELS.length - 1;
    scene.traverse((o) => {
      const m = o.material;
      if (!m || !m.isMeshPhysicalMaterial) return;
      if (m.userData.sheen0 === undefined) { m.userData.sheen0 = m.sheen; m.userData.clearcoat0 = m.clearcoat; }
      const sheen = rich ? m.userData.sheen0 : 0, clearcoat = rich ? m.userData.clearcoat0 : 0;
      if (m.sheen !== sheen || m.clearcoat !== clearcoat) { m.sheen = sheen; m.clearcoat = clearcoat; m.needsUpdate = true; }
    });
  }

  let cssW = 4, cssH = 4, basePr = 1;
  function applyQuality() {
    applyMaterialTier();
    const lv = LEVELS[quality];
    gtao.enabled = lv.ao;
    bloom.enabled = lv.bloom;
    const pr = basePr * lv.scale;
    composer.setPixelRatio(pr);
    composer.setSize(cssW, cssH);
    const pw = Math.max(1, Math.round(cssW * pr)), ph = Math.max(1, Math.round(cssH * pr));
    // AO is low-frequency: half resolution is a quarter of the cost and the
    // denoise + blend hide the difference.
    gtao.setSize(Math.ceil(pw / 2), Math.ceil(ph / 2));
    fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
  }

  function setSize(w, h, pixelRatio) {
    cssW = w; cssH = h; basePr = pixelRatio;
    applyQuality();
  }

  function setQuality(q, remember) {
    quality = Math.max(0, Math.min(LEVELS.length - 1, q | 0));
    applyQuality();
    acc = 0; n = 0; warm = 0;
    if (remember) { try { localStorage.setItem(STORE, JSON.stringify({ q: quality })); } catch { /* ignore */ } }
  }

  // Frame-time watchdog: a rolling average over about a second. The first
  // stretch after any change is ignored (shader compiles, resized targets).
  // It only ever steps down — stepping back up invites oscillation; the
  // Graphics button in the menu is how to ask for more.
  let acc = 0, n = 0, warm = 0, last = 0, tick = 0;
  function render(t) {
    const now = performance.now();
    const ms = last ? now - last : 16;
    last = now;
    if (!document.hidden && ms < 250) {
      if (warm < 45) warm++;
      else {
        acc += ms; n++;
        if (n >= 50) {
          if (acc / n > TARGET_MS && quality > 0) {
            // Far over budget: one step will not be enough, so take two.
            const next = Math.max(0, quality - (acc / n > TARGET_MS * 1.6 ? 2 : 1));
            console.info(`[postfx] ${(acc / n).toFixed(1)} ms/frame — quality ${quality} -> ${next}`);
            setQuality(next, true);
          }
          acc = 0; n = 0;
        }
      }
    }
    if ((tick++ & 63) === 0) applyMaterialTier();
    grade.uniforms.time.value = t;
    composer.render();
  }

  return {
    render, setSize,
    levels: LEVELS.length,
    get quality() { return quality; },
    set quality(q) { setQuality(q, true); },
  };
}
