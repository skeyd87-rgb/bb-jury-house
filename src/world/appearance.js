// Procedural appearance for houseguests: skin/face maps, irises, fabric weave,
// hair-strand cards, and the per-character wardrobe table.
//
// The project ships no texture assets, so everything here is painted at runtime
// into a <canvas> and cached by key — eight houseguests wearing cotton share
// one weave texture, and a face map is only rebuilt when its recipe changes.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const CACHE = new Map();
function cached(key, make) {
  let v = CACHE.get(key);
  if (v === undefined) { v = make(); CACHE.set(key, v); }
  return v;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function toTexture(canvas, { srgb = true, repeat = 1, wrap = true } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (wrap) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
  } else {
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  }
  t.anisotropy = 8;
  return t;
}

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Deterministic per-character RNG: the same houseguest always gets the same
// freckles, the same cowlick, the same stubble speckle.
export function rngFrom(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

function hexOf(c) { return '#' + new THREE.Color(c).getHexString(); }

function shade(c, amt) {
  const col = new THREE.Color(c);
  if (amt >= 0) col.lerp(new THREE.Color(0xffffff), amt);
  else col.lerp(new THREE.Color(0x000000), -amt);
  return col;
}

function rgba(c, a) {
  const col = new THREE.Color(c);
  return `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},${a})`;
}

// ---------------------------------------------------------------------------
// Sphere UV mapping
//
// The head keeps SphereGeometry's equirectangular UVs through sculpting, so a
// painted feature only needs its direction on the unit sphere. three builds the
// sphere as x=-cos(phi)sin(theta), z=sin(phi)sin(theta), y=cos(theta) with
// uv=(phi/2pi, 1-theta/pi); with the default flipY that puts canvas row 0 at
// the crown, so canvas px = (u*W, v*H) for the v returned below.
// ---------------------------------------------------------------------------

export function sphUV(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  x /= l; y /= l; z /= l;
  let u = Math.atan2(z, -x) / (Math.PI * 2);
  if (u < 0) u += 1;
  return [u, Math.acos(clamp(y, -1, 1)) / Math.PI];
}

// Face landmarks as unit-sphere directions. The sculptor pushes geometry at
// these points and the painter shades the same spots, so form and shading agree.
export const FACE = {
  eye: [0.40, 0.05, 0.84],
  brow: [0.40, 0.24, 0.80],
  cheek: [0.60, -0.12, 0.62],
  nasal: [0.00, 0.30, 0.94],
  noseTip: [0.00, -0.09, 1.00],
  nostril: [0.155, -0.175, 0.90],
  lipTop: [0.00, -0.45, 0.86],
  lipLow: [0.00, -0.57, 0.83],
  chin: [0.00, -0.78, 0.60],
  jaw: [0.72, -0.46, 0.34],
  temple: [0.80, 0.30, 0.42],
  forehead: [0.00, 0.52, 0.80],
};

// ---------------------------------------------------------------------------
// Skin + face map
// ---------------------------------------------------------------------------

const FACE_W = 1024, FACE_H = 512;

function px(dir, sx = 1) {
  const [u, v] = sphUV(dir[0] * sx, dir[1], dir[2]);
  return [u * FACE_W, v * FACE_H];
}

// One painted map per face recipe: base tone, pore mottle, socket/nostril/lip
// ambient shading, blush, stubble and age lines. Crisp features (brows, lashes,
// irises) are geometry, not pixels — they have to hold up in a close-up.
export function faceTexture(spec) {
  const key = `face:${spec.skin}:${spec.gender}:${spec.age}:${spec.beard}:${spec.lip}:${spec.freckles}:${spec.seed}`;
  return cached(key, () => {
    const [canvas, ctx] = makeCanvas(FACE_W, FACE_H);
    const rnd = rngFrom(spec.seed);
    const base = new THREE.Color(spec.skin);

    ctx.fillStyle = hexOf(base);
    ctx.fillRect(0, 0, FACE_W, FACE_H);

    // Pore / subdermal mottle: hundreds of very soft, very low-alpha blobs in
    // warm and cool offsets of the base tone. Reads as skin, not paint.
    for (let i = 0; i < 700; i++) {
      const x = rnd() * FACE_W, y = rnd() * FACE_H;
      const r = 8 + rnd() * 34;
      const warm = rnd() < 0.55;
      const tint = warm
        ? base.clone().lerp(new THREE.Color(0xd08060), 0.35)
        : base.clone().lerp(new THREE.Color(0x6a7f8c), 0.25);
      const grd = ctx.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, rgba(tint, 0.035 + rnd() * 0.035));
      grd.addColorStop(1, rgba(tint, 0));
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }

    const blob = (dir, rx, ry, color, alpha, rot = 0, mirror = true) => {
      for (const sx of mirror ? [1, -1] : [1]) {
        const [x, y] = px(dir, sx);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rot * sx);
        ctx.scale(rx, ry);
        const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        grd.addColorStop(0, rgba(color, alpha));
        grd.addColorStop(0.55, rgba(color, alpha * 0.55));
        grd.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    };

    const deep = shade(base, -0.55);
    const soft = shade(base, -0.28);

    // Orbital shading — the single biggest cue that a head has a skull in it.
    blob(FACE.eye, 34, 22, deep, 0.34);
    blob([0.40, 0.14, 0.82], 30, 13, soft, 0.30);            // upper lid crease
    blob([0.40, -0.07, 0.82], 26, 12, soft, 0.22);           // tear trough
    blob([0.20, 0.06, 0.92], 14, 20, soft, 0.22);            // nose-bridge side
    blob(FACE.temple, 30, 34, soft, 0.16);
    blob([0.58, -0.36, 0.60], 34, 26, soft, 0.20);           // cheek hollow
    blob(FACE.nostril, 8, 6, deep, 0.36);
    blob([0.10, -0.28, 0.92], 12, 8, soft, 0.15, 0.4);       // under the nose
    blob(FACE.jaw, 30, 22, soft, 0.14);
    blob([0.00, -0.68, 0.74], 26, 11, soft, 0.12, 0, false); // mentolabial crease
    blob([0.00, 0.62, 0.72], 70, 26, soft, 0.10, 0, false);  // hairline falloff

    // Flush across the cheeks and nose — skin is never one flat colour.
    const flush = base.clone().lerp(new THREE.Color(0xc0392b), spec.gender === 'f' ? 0.26 : 0.16);
    blob(FACE.cheek, 44, 34, flush, spec.gender === 'f' ? 0.30 : 0.20);
    blob(FACE.noseTip, 22, 18, flush, 0.18, 0, false);
    blob([0.44, 0.06, 0.78], 30, 20, flush, 0.10);

    // Lips: a soft body with a darker vermilion border and a defined seam.
    const lip = new THREE.Color(spec.lip);
    const [lx, ly] = px(FACE.lipTop);
    const [, ly2] = px(FACE.lipLow);
    const lh = Math.abs(ly2 - ly);
    ctx.save();
    ctx.translate(lx, (ly + ly2) / 2);
    const lipW = 34, lipH = Math.max(8, lh * 0.66);
    const lg = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    lg.addColorStop(0, rgba(lip, 0.92));
    lg.addColorStop(0.62, rgba(lip, 0.82));
    lg.addColorStop(0.86, rgba(shade(lip, -0.3), 0.45));
    lg.addColorStop(1, rgba(lip, 0));
    ctx.save();
    ctx.scale(lipW, lipH);
    ctx.fillStyle = lg;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // Cupid bow notch + the mouth seam.
    ctx.strokeStyle = rgba(shade(lip, -0.62), 0.75);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-lipW * 0.96, 0.5);
    ctx.quadraticCurveTo(-lipW * 0.42, -lipH * 0.30, 0, 0.2);
    ctx.quadraticCurveTo(lipW * 0.42, -lipH * 0.30, lipW * 0.96, 0.5);
    ctx.stroke();
    ctx.strokeStyle = rgba(shade(lip, 0.45), 0.30);
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(-lipW * 0.5, lipH * 0.42);
    ctx.quadraticCurveTo(0, lipH * 0.62, lipW * 0.5, lipH * 0.42);
    ctx.stroke();
    ctx.restore();

    // Philtrum
    blob([0.00, -0.36, 0.90], 5, 10, soft, 0.16, 0, false);

    // Stubble / beard shadow — masked to the jaw, chin and moustache field.
    if (spec.beard > 0) {
      const bc = new THREE.Color(spec.beardColor || 0x2a2018);
      const zones = [
        [FACE.chin, 46, 34], [FACE.jaw, 52, 34], [[0.36, -0.62, 0.62], 40, 30],
        [[0.13, -0.33, 0.90], 20, 11], [[0.00, -0.70, 0.66], 34, 24],
      ];
      for (const [dir, rx, ry] of zones) {
        for (const sx of [1, -1]) {
          const [x, y] = px(dir, sx);
          for (let i = 0; i < 420; i++) {
            const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd());
            ctx.fillStyle = rgba(bc, (1 - rr) * 0.16 * spec.beard);
            ctx.fillRect(x + Math.cos(a) * rr * rx, y + Math.sin(a) * rr * ry, 1.4, 1.4);
          }
        }
      }
    }

    if (spec.freckles) {
      const fc = shade(base, -0.4).lerp(new THREE.Color(0xa0522d), 0.4);
      for (const dir of [FACE.cheek, FACE.noseTip, [0.5, 0.0, 0.76]]) {
        for (const sx of [1, -1]) {
          const [x, y] = px(dir, sx);
          for (let i = 0; i < 70; i++) {
            const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 34;
            ctx.fillStyle = rgba(fc, 0.10 + rnd() * 0.16);
            ctx.beginPath();
            ctx.arc(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.8, 0.9 + rnd() * 1.4, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    // Age: nasolabial folds, crow's feet, forehead creases.
    const age = clamp((spec.age - 38) / 26, 0, 1);
    if (age > 0.05) {
      ctx.lineCap = 'round';
      ctx.strokeStyle = rgba(deep, 0.08 + age * 0.20);
      ctx.lineWidth = 2;
      for (const sx of [1, -1]) {
        const [nx, ny] = px(FACE.nostril, sx);
        const [mx, my] = px([0.30, -0.62, 0.72], sx);
        ctx.beginPath();
        ctx.moveTo(nx, ny);
        ctx.quadraticCurveTo(nx + (mx - nx) * 0.3, ny + (my - ny) * 0.75, mx, my);
        ctx.stroke();
        const [ex, ey] = px([0.62, 0.06, 0.72], sx);
        ctx.lineWidth = 1.3;
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath();
          ctx.moveTo(ex, ey + i * 7);
          ctx.lineTo(ex + sx * 13, ey + i * 12 - 2);
          ctx.stroke();
        }
      }
      ctx.lineWidth = 1.8;
      const [fx, fy] = px(FACE.forehead);
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(fx - 46, fy + i * 13);
        ctx.quadraticCurveTo(fx, fy + i * 13 - 6, fx + 46, fy + i * 13);
        ctx.stroke();
      }
    }

    return toTexture(canvas, { wrap: false });
  });
}

export function skinMaterial(skin, mapSpec) {
  const key = `skinmat:${skin}:${mapSpec ? mapSpec.seed : 'plain'}`;
  return cached(key, () => new THREE.MeshPhysicalMaterial({
    color: mapSpec ? 0xffffff : skin,
    map: mapSpec ? faceTexture(mapSpec) : null,
    roughness: 0.66,
    metalness: 0,
    // Sheen fakes the soft forward-scatter that makes skin look like skin
    // rather than painted plastic under this scene's warm key light.
    sheen: 0.5,
    sheenRoughness: 0.85,
    sheenColor: new THREE.Color(0xff9d7a),
    clearcoat: 0.08,
    clearcoatRoughness: 0.7,
  }));
}

// ---------------------------------------------------------------------------
// Eyes
// ---------------------------------------------------------------------------

export function irisTexture(color) {
  return cached(`iris:${color}`, () => {
    const [canvas, ctx] = makeCanvas(512, 256);
    const rnd = rngFrom(hashSeed('iris' + color));
    ctx.fillStyle = '#f2f0ee';
    ctx.fillRect(0, 0, 512, 256);
    // Sclera is never pure white — warm it toward the corners, add fine vessels.
    const wash = ctx.createLinearGradient(0, 0, 0, 256);
    wash.addColorStop(0, 'rgba(176,156,146,0.55)');
    wash.addColorStop(0.5, 'rgba(255,255,255,0)');
    wash.addColorStop(1, 'rgba(176,156,146,0.55)');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, 512, 256);
    ctx.strokeStyle = 'rgba(190,90,90,0.28)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 26; i++) {
      const x = rnd() * 512, y = rnd() * 256;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + 16, y + 8, x + 34, y + (rnd() - 0.5) * 22);
      ctx.stroke();
    }

    // The iris sits at u=0.25 (straight ahead), v=0.5 (equator).
    const cx = 128, cy = 128, R = 46;
    const base = new THREE.Color(color);
    const grd = ctx.createRadialGradient(cx, cy - 4, R * 0.12, cx, cy, R);
    grd.addColorStop(0, hexOf(shade(base, -0.55)));
    grd.addColorStop(0.32, hexOf(shade(base, 0.06)));
    grd.addColorStop(0.72, hexOf(base));
    grd.addColorStop(1, hexOf(shade(base, -0.45)));
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    // Stromal fibres radiating from the pupil.
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    for (let i = 0; i < 130; i++) {
      const a = (i / 130) * Math.PI * 2 + rnd() * 0.05;
      const lightFibre = rnd() < 0.5;
      ctx.strokeStyle = rgba(shade(base, lightFibre ? 0.35 : -0.4), 0.22 + rnd() * 0.3);
      ctx.lineWidth = 0.8 + rnd() * 1.6;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * R * 0.28, cy + Math.sin(a) * R * 0.28);
      ctx.lineTo(cx + Math.cos(a) * R * (0.7 + rnd() * 0.32), cy + Math.sin(a) * R * (0.7 + rnd() * 0.32));
      ctx.stroke();
    }
    ctx.restore();

    // Limbal ring, pupil, and a catchlight so the eye reads as wet.
    ctx.strokeStyle = 'rgba(20,16,24,0.62)';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(cx, cy, R - 2, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#080610';
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.40, 0, Math.PI * 2); ctx.fill();
    const cl = ctx.createRadialGradient(cx - R * 0.34, cy - R * 0.38, 0, cx - R * 0.34, cy - R * 0.38, R * 0.30);
    cl.addColorStop(0, 'rgba(255,255,255,0.95)');
    cl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = cl;
    ctx.beginPath(); ctx.arc(cx - R * 0.34, cy - R * 0.38, R * 0.3, 0, Math.PI * 2); ctx.fill();

    return toTexture(canvas, { wrap: false });
  });
}

export function eyeMaterial(color) {
  return cached(`eyemat:${color}`, () => new THREE.MeshPhysicalMaterial({
    map: irisTexture(color),
    roughness: 0.16,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
  }));
}

// ---------------------------------------------------------------------------
// Fabric
// ---------------------------------------------------------------------------

// Grayscale weave plus a normal map derived from the same height field, so
// cloth catches the key light along the thread direction instead of reading as
// a flat plastic shell.
function weaveMaps(kind) {
  return cached(`weave:${kind}`, () => {
    const S = 256;
    const height = new Float32Array(S * S);
    const [canvas, ctx] = makeCanvas(S, S);
    const img = ctx.createImageData(S, S);
    const rnd = rngFrom(hashSeed(kind));

    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let h;
        if (kind === 'denim') {
          // Diagonal twill with slubby yarn noise.
          const d = (x + y) % 6;
          h = 0.5 + (d < 3 ? 0.20 : -0.20) + (rnd() - 0.5) * 0.30;
          if ((x * 0.7 + y * 0.3) % 17 < 1) h -= 0.12;
        } else if (kind === 'knit') {
          const u = (x % 12) / 12, v = (y % 12) / 12;
          h = 0.5 + Math.sin(u * Math.PI * 2) * 0.16 * Math.sin(v * Math.PI) + (rnd() - 0.5) * 0.14;
        } else if (kind === 'leather') {
          const n = Math.sin(x * 0.31 + Math.sin(y * 0.19) * 3) * Math.cos(y * 0.27 + Math.sin(x * 0.23) * 3);
          h = 0.5 + n * 0.16 + (rnd() - 0.5) * 0.22;
        } else if (kind === 'satin') {
          h = 0.5 + Math.sin(y * 0.5) * 0.03 + (rnd() - 0.5) * 0.05;
        } else {
          // Plain cotton: over/under warp and weft.
          const over = ((x >> 1) + (y >> 1)) % 2 === 0;
          h = 0.5 + (over ? 0.16 : -0.16) + (rnd() - 0.5) * 0.22;
          if (x % 4 === 0 || y % 4 === 0) h -= 0.08;
        }
        height[y * S + x] = clamp(h, 0, 1);
      }
    }

    for (let i = 0; i < S * S; i++) {
      const v = 190 + height[i] * 62;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    const [ncanvas, nctx] = makeCanvas(S, S);
    const nimg = nctx.createImageData(S, S);
    const strength = kind === 'satin' ? 1.2 : kind === 'knit' ? 5.5 : 3.4;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const l = height[y * S + ((x - 1 + S) % S)], r = height[y * S + ((x + 1) % S)];
        const d = height[((y + 1) % S) * S + x], u = height[((y - 1 + S) % S) * S + x];
        const nx = (l - r) * strength, ny = (d - u) * strength, nz = 1;
        const len = Math.hypot(nx, ny, nz);
        const i = (y * S + x) * 4;
        nimg.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
        nimg.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
        nimg.data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
        nimg.data[i + 3] = 255;
      }
    }
    nctx.putImageData(nimg, 0, 0);
    return { map: toTexture(canvas), normal: toTexture(ncanvas, { srgb: false }) };
  });
}

const FABRIC_TUNE = {
  cotton: { roughness: 0.92, repeat: 9, normalScale: 0.75, sheen: 0.25 },
  denim: { roughness: 0.95, repeat: 11, normalScale: 0.9, sheen: 0.1 },
  knit: { roughness: 0.98, repeat: 6, normalScale: 1.1, sheen: 0.45 },
  satin: { roughness: 0.34, repeat: 5, normalScale: 0.35, sheen: 0.9 },
  leather: { roughness: 0.52, repeat: 7, normalScale: 0.8, sheen: 0.15 },
};

export function fabricMaterial(color, kind = 'cotton', repeatScale = 1) {
  const key = `fab:${color}:${kind}:${repeatScale}`;
  return cached(key, () => {
    const t = FABRIC_TUNE[kind] || FABRIC_TUNE.cotton;
    const { map, normal } = weaveMaps(kind);
    const m = map.clone(); m.needsUpdate = true;
    const n = normal.clone(); n.needsUpdate = true;
    const r = t.repeat * repeatScale;
    m.repeat.set(r, r);
    n.repeat.set(r, r);
    return new THREE.MeshPhysicalMaterial({
      color,
      map: m,
      normalMap: n,
      normalScale: new THREE.Vector2(t.normalScale, t.normalScale),
      roughness: t.roughness,
      metalness: 0,
      // Garments are open shells cut from the body profile, so both faces
      // are visible at a hem, a neckline or a sleeve opening.
      side: THREE.DoubleSide,
      sheen: t.sheen,
      sheenRoughness: 0.9,
      sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.6),
    });
  });
}

// ---------------------------------------------------------------------------
// Hair
// ---------------------------------------------------------------------------

// One alpha-tested strand card texture, reused by every hairstyle. Alpha test
// (not blending) keeps hair sorting-proof and lets it cast real shadows.
export function strandTexture() {
  return cached('strand', () => {
    const W = 128, H = 256;
    const [canvas, ctx] = makeCanvas(W, H);
    const rnd = rngFrom(99);
    ctx.clearRect(0, 0, W, H);

    // Solid-ish core first so the card silhouette does not read as loose hairs.
    const core = ctx.createLinearGradient(0, 0, 0, H);
    core.addColorStop(0, 'rgba(238,238,238,0.98)');
    core.addColorStop(0.60, 'rgba(210,210,210,0.85)');
    core.addColorStop(0.88, 'rgba(180,180,180,0.35)');
    core.addColorStop(1, 'rgba(150,150,150,0)');
    ctx.fillStyle = core;
    ctx.fillRect(W * 0.13, 0, W * 0.74, H);

    for (let i = 0; i < 26; i++) {
      const x = rnd() * W;
      const w = 1.5 + rnd() * 4.5;
      const top = rnd() * 18;
      const bottom = H - rnd() * H * 0.42;
      const bright = 0.55 + rnd() * 0.45;
      const g = ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, `rgba(255,255,255,${bright})`);
      const mid = Math.round(210 * bright);
      g.addColorStop(0.55, `rgba(${mid},${mid},${mid},1)`);
      g.addColorStop(1, 'rgba(120,120,120,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = w;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.bezierCurveTo(
        x + (rnd() - 0.5) * 16, H * 0.35,
        x + (rnd() - 0.5) * 22, H * 0.7,
        x + (rnd() - 0.5) * 26, bottom
      );
      ctx.stroke();
    }
    return toTexture(canvas, { wrap: false });
  });
}

export function hairCardMaterial(color) {
  return cached(`haircard:${color}`, () => new THREE.MeshPhysicalMaterial({
    color,
    map: strandTexture(),
    transparent: false,
    alphaTest: 0.42,
    side: THREE.DoubleSide,
    roughness: 0.38,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.28,
    sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xfff0d0), 0.55),
  }));
}

export function hairSolidMaterial(color) {
  return cached(`hairsolid:${color}`, () => new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.64,
    metalness: 0,
    sheen: 0.5,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xfff0d0), 0.45),
  }));
}

// ---------------------------------------------------------------------------
// Misc materials
// ---------------------------------------------------------------------------

export function simpleMaterial(color, roughness = 0.6, metalness = 0) {
  return cached(`simple:${color}:${roughness}:${metalness}`, () =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness }));
}

export function contactShadowTexture() {
  return cached('contact', () => {
    const [canvas, ctx] = makeCanvas(128, 128);
    const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
    g.addColorStop(0, 'rgba(0,0,0,0.85)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.38)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return toTexture(canvas, { wrap: false });
  });
}

// ---------------------------------------------------------------------------
// Wardrobe
//
// Hand-directed per houseguest so the cast reads as eight people who packed
// their own bags. Anyone not listed (the player, an online seat) gets a stable
// outfit derived from their id, so the same seat always looks the same.
// ---------------------------------------------------------------------------

const TOP_KINDS = ['tee', 'tank', 'polo', 'button', 'crop', 'blouse', 'henley'];

const WARDROBE = {
  marcus: {
    top: 'polo', sleeve: 'short', topColor: 0x2d4a74, trim: 0xe6eaf0, fabric: 'cotton',
    bottom: 'pants', bottomColor: 0x8a7a5e, bottomFabric: 'cotton',
    shoe: { upper: 0xf2f0ea, sole: 0xd8d3c6, kind: 'sneaker' }, eye: 0x4a3524,
  },
  rae: {
    top: 'tank', sleeve: 'none', topColor: 0x9c2f2a, trim: 0x2b2f26, fabric: 'cotton',
    bottom: 'shorts', bottomColor: 0x4a5038, bottomFabric: 'cotton',
    shoe: { upper: 0x2f3a2c, sole: 0x1d2119, kind: 'trainer' }, eye: 0x3d2b1f,
  },
  zoe: {
    top: 'crop', sleeve: 'short', topColor: 0xdb6fa0, trim: 0xfbe4ef, fabric: 'cotton',
    bottom: 'pants', bottomColor: 0x6d7580, bottomFabric: 'knit',
    shoe: { upper: 0xf6f3ee, sole: 0xe6b7cd, kind: 'sneaker' }, eye: 0x2f6b53,
  },
  flynn: {
    top: 'button', sleeve: 'short', topColor: 0xe8a33d, trim: 0xfdf6e6, fabric: 'satin',
    bottom: 'shorts', bottomColor: 0x25304a, bottomFabric: 'cotton',
    shoe: { upper: 0xf4f2ec, sole: 0xe8a33d, kind: 'sneaker' }, eye: 0x3e6ea8,
  },
  gus: {
    top: 'button', sleeve: 'long', topColor: 0x3f6b46, trim: 0xd8dccb, fabric: 'cotton',
    bottom: 'pants', bottomColor: 0x3a4b66, bottomFabric: 'denim',
    shoe: { upper: 0x5a4330, sole: 0x2b2019, kind: 'boot' }, eye: 0x55606b,
  },
  tessa: {
    top: 'blouse', sleeve: 'none', topColor: 0x8c6fd6, trim: 0xece4fb, fabric: 'satin',
    bottom: 'skirt', bottomColor: 0x2f2a3d, bottomFabric: 'cotton',
    shoe: { upper: 0xd6c2a8, sole: 0x9c8b73, kind: 'sandal' }, eye: 0x4a3a2c,
  },
  nash: {
    top: 'tee', sleeve: 'short', topColor: 0x1f7fa8, trim: 0xdff1f8, fabric: 'cotton',
    bottom: 'pants', bottomColor: 0x23242b, bottomFabric: 'denim',
    shoe: { upper: 0x23252c, sole: 0xe4e0d6, kind: 'sneaker' }, eye: 0x4f7a5c,
  },
  bev: {
    top: 'blouse', sleeve: 'short', topColor: 0xb44ac0, trim: 0xf6e2f8, fabric: 'satin',
    bottom: 'pants', bottomColor: 0x2b2733, bottomFabric: 'knit',
    shoe: { upper: 0xc8a06a, sole: 0x6d5438, kind: 'sandal' }, eye: 0x3a2a22,
  },
  you: {
    top: 'tee', sleeve: 'short', topColor: 0xf3f1ea, trim: 0xc8b98e, fabric: 'cotton',
    bottom: 'pants', bottomColor: 0x2b3448, bottomFabric: 'denim',
    shoe: { upper: 0x2e3340, sole: 0xe8e4d8, kind: 'sneaker' }, eye: 0x3c5a72,
  },
};

export function outfitFor(hg) {
  const preset = WARDROBE[hg.id];
  if (preset) return preset;
  // Unknown seat: deterministic but plausible, keyed off the id.
  const rnd = rngFrom(hashSeed(String(hg.id)));
  const fem = hg.gender === 'f';
  const top = TOP_KINDS[Math.floor(rnd() * (fem ? TOP_KINDS.length : 5))];
  const bottom = fem && rnd() < 0.3 ? 'skirt' : rnd() < 0.5 ? 'shorts' : 'pants';
  const base = new THREE.Color(hg.color || 0x8899aa);
  return {
    top,
    sleeve: top === 'tank' || top === 'blouse' ? 'none' : rnd() < 0.25 ? 'long' : 'short',
    topColor: base.clone().lerp(new THREE.Color(0x7f8c85), 0.22).getHex(),
    trim: shade(base, 0.7).getHex(),
    fabric: 'cotton',
    bottom,
    bottomColor: shade(base, -0.72).getHex(),
    bottomFabric: rnd() < 0.5 ? 'denim' : 'cotton',
    shoe: { upper: 0xe8e5dc, sole: 0x2b2b31, kind: 'sneaker' },
    eye: [0x4a3524, 0x3d5a7a, 0x3f6b46, 0x55606b][Math.floor(rnd() * 4)],
  };
}

// Face recipe derived from existing cast data — no new fields in cast.js.
export function faceSpecFor(hg) {
  const seed = hashSeed(String(hg.id) + ':face');
  const rnd = rngFrom(seed);
  const male = hg.gender === 'm';
  const age = hg.age || 28;
  const skin = new THREE.Color(hg.skin);
  const light = skin.r + skin.g + skin.b > 2.1;
  return {
    seed,
    skin: hg.skin,
    gender: hg.gender,
    age,
    lip: skin.clone()
      .lerp(new THREE.Color(hg.gender === 'f' ? 0xb0454f : 0x8e4a44), hg.gender === 'f' ? 0.52 : 0.34)
      .getHex(),
    beard: male ? (age > 45 ? 0.62 : 0.30 + rnd() * 0.26) : 0,
    beardColor: new THREE.Color(hg.hair).lerp(new THREE.Color(0x2a2018), 0.45).getHex(),
    freckles: light && rnd() < 0.45,
  };
}
