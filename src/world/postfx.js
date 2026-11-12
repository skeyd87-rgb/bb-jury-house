// Post-processing: what turns a lit scene into a picture.
//
//   RenderPass (MSAA, half-float)  ->  GTAO  ->  bloom  ->  tone map  ->  grade
//
// GTAO grounds everything: furniture sits on the floor, people stand in the
// room rather than on top of it. Bloom is thresholded high so only real light
// sources (bulbs, neon, the pool) glow. The grade pass is the broadcast look:
// a soft vignette, split-toned shadows/highlights and a little sensor grain.
//
// Everything here is optional. `quality` starts from the device and steps down
// on its own if frames run long, ending at a plain renderer.render().

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

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

export function createPostFx(renderer, scene, camera) {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  // 3 = AO + bloom + grade, 2 = bloom + grade, 1 = grade only, 0 = plain render
  let quality = coarse ? 2 : 3;

  const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: coarse ? 0 : 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  const gtao = new GTAOPass(scene, camera, 4, 4);
  gtao.blendIntensity = 0.92;
  gtao.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.4, thickness: 1.2, scale: 1.25, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 12 });
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
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  function applyQuality() {
    gtao.enabled = quality >= 3;
    bloom.enabled = quality >= 2;
  }
  applyQuality();

  function setSize(w, h, pixelRatio) {
    composer.setPixelRatio(pixelRatio);
    composer.setSize(w, h);
  }

  // Frame-time watchdog. A long first second (shader compiles) is ignored;
  // after that, a sustained run of slow frames drops one quality step.
  let slow = 0, frames = 0, last = 0;
  function render(t) {
    const now = performance.now();
    const ms = last ? now - last : 16;
    last = now;
    if (++frames > 90 && !document.hidden && ms < 400) {
      slow = ms > 30 ? slow + 1 : Math.max(0, slow - 2);
      if (slow > 75 && quality > 0) {
        quality--;
        slow = 0; frames = 30;
        applyQuality();
        console.info(`[postfx] frames running long — quality stepped down to ${quality}`);
      }
    }
    if (quality === 0) { renderer.render(scene, camera); return; }
    grade.uniforms.time.value = t;
    composer.render();
  }

  return {
    render, setSize,
    get quality() { return quality; },
    set quality(q) { quality = Math.max(0, Math.min(3, q | 0)); applyQuality(); },
  };
}
