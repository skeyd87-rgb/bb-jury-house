// Procedural anatomy: the geometry half of the houseguest rebuild.
//
// Nothing here is a primitive dressed up. Bodies are *lofted* — a stack of
// control rings (elliptical, optionally superelliptical, because a real torso
// is far wider than it is deep) resampled through a Catmull-Rom spline into a
// single seamless surface. Heads start as a sphere and are then sculpted:
// brow ridge, orbital sockets, nasal bridge and tip, cheekbones, jaw taper,
// chin, lips. Hair is built from alpha-tested strand cards the way game hair
// actually is, not from a ball of spheres.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

// Gaussian falloff with independent radii — the sculpting brush.
function brush(dx, dy, dz, sx, sy, sz) {
  const a = dx / sx, b = dy / sy, c = dz / sz;
  return Math.exp(-(a * a + b * b + c * c));
}

// ---------------------------------------------------------------------------
// Loft
// ---------------------------------------------------------------------------

// rings: [{ y, rx, rz, x?, z?, sq? }] ascending in y.
//   rx / rz  half-width and half-depth of the cross-section
//   x  / z   lateral offset of the section centre (lets a torso lean)
//   sq       0 = ellipse, 1 = distinctly slab-sided (superellipse exponent 4)
export function loft(rings, {
  sections = 22, radial = 26, capTop = true, capBottom = true, vRepeat = 1,
} = {}) {
  const n = rings.length;
  const at = (i) => rings[clamp(i, 0, n - 1)];
  const chan = (i, k) => (at(i)[k] !== undefined ? at(i)[k] : 0);

  const pos = [], uv = [], idx = [];
  const cols = radial + 1;
  const sampled = [];

  for (let s = 0; s < sections; s++) {
    const f = (s / (sections - 1)) * (n - 1);
    const i = Math.min(Math.floor(f), n - 2);
    const t = f - i;
    const get = (k) => catmull(chan(i - 1, k), chan(i, k), chan(i + 1, k), chan(i + 2, k), t);
    const y = get('y'), rx = Math.max(1e-4, get('rx')), rz = Math.max(1e-4, get('rz'));
    const cx = get('x'), cz = get('z'), sq = clamp(get('sq'), 0, 1);
    sampled.push({ y, rx, rz, cx, cz, sq });

    const e = 2 / (2 + sq * 2.2); // superellipse exponent
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const ux = Math.sign(ca) * Math.pow(Math.abs(ca), e);
      const uz = Math.sign(sa) * Math.pow(Math.abs(sa), e);
      pos.push(cx + ux * rx, y, cz + uz * rz);
      uv.push(j / radial, (s / (sections - 1)) * vRepeat);
    }
  }

  // Ring stacks come in both directions: a torso is authored bottom-up, a limb
  // hangs top-down from its joint. Winding depends on that direction, so read
  // it off the geometry rather than trusting the caller to sort. Get this
  // wrong and the surface is inside-out: it still has the right silhouette,
  // but it lights off inverted normals and every joint shows a hole where the
  // far wall is drawn instead of the near one.
  const ascending = sampled[sections - 1].y >= sampled[0].y;

  for (let s = 0; s < sections - 1; s++) {
    for (let j = 0; j < radial; j++) {
      const a = s * cols + j, b = a + 1, c = a + cols, d = c + 1;
      if (ascending) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }

  // Ring vertices run anticlockwise seen from +Y, so a fan of (centre, j, j+1)
  // faces down; reverse it for an upward-facing cap.
  const capAt = (s, up) => {
    const r = sampled[s];
    const centre = pos.length / 3;
    pos.push(r.cx, r.y, r.cz);
    uv.push(0.5, up ? vRepeat : 0);
    const base = s * cols;
    for (let j = 0; j < radial; j++) {
      if (up) idx.push(centre, base + j + 1, base + j);
      else idx.push(centre, base + j, base + j + 1);
    }
  };
  const loRing = ascending ? 0 : sections - 1;
  const hiRing = ascending ? sections - 1 : 0;
  if (capBottom) capAt(loRing, false);
  if (capTop) capAt(hiRing, true);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geom.setIndex(idx);
  geom.userData.loft = { cols, sections, radial };
  finish(geom);
  return geom;
}

// Recompute normals, then average them across co-located vertices. Both lofts
// and spheres duplicate a column of vertices at the UV seam; left alone that
// seam lights as a bright hairline straight down the side of every limb — and,
// on the head, straight down the temple.
export function weldNormals(geom, eps = 1e-4) {
  const p = geom.attributes.position;
  const n = geom.attributes.normal;
  if (!p || !n) return geom;
  const inv = 1 / eps;
  const buckets = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${Math.round(p.getX(i) * inv)},${Math.round(p.getY(i) * inv)},${Math.round(p.getZ(i) * inv)}`;
    const b = buckets.get(key);
    if (b) b.push(i); else buckets.set(key, [i]);
  }
  for (const group of buckets.values()) {
    if (group.length < 2) continue;
    let x = 0, y = 0, z = 0;
    for (const i of group) { x += n.getX(i); y += n.getY(i); z += n.getZ(i); }
    const l = Math.hypot(x, y, z);
    if (l < 1e-6) continue;
    for (const i of group) n.setXYZ(i, x / l, y / l, z / l);
  }
  n.needsUpdate = true;
  return geom;
}

export function finish(geom) {
  geom.computeVertexNormals();
  weldNormals(geom);
  geom.computeBoundingSphere();
  return geom;
}

// Per-vertex sculpting pass. fn(v, uv) mutates v in place.
export function displace(geom, fn) {
  const p = geom.attributes.position;
  const uvA = geom.attributes.uv;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    fn(v, uvA ? uvA.getX(i) : 0, uvA ? uvA.getY(i) : 0, i);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  p.needsUpdate = true;
  return finish(geom);
}

// Evaluate a ring stack at an arbitrary height — used to cut clothing shells
// that hug the body they cover.
export function profileAt(rings, y) {
  if (y <= rings[0].y) return { ...rings[0] };
  const last = rings[rings.length - 1];
  if (y >= last.y) return { ...last };
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i], b = rings[i + 1];
    if (y >= a.y && y <= b.y) {
      const t = (y - a.y) / (b.y - a.y || 1);
      return {
        y,
        rx: lerp(a.rx, b.rx, t),
        rz: lerp(a.rz, b.rz, t),
        x: lerp(a.x || 0, b.x || 0, t),
        z: lerp(a.z || 0, b.z || 0, t),
        sq: lerp(a.sq || 0, b.sq || 0, t),
      };
    }
  }
  return { ...last };
}

// A garment shell: the body profile between two heights, inflated by `pad`
// and optionally flared (a skirt) or cinched (a waistband).
export function shellRings(body, y0, y1, pad, shape = null) {
  const out = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = lerp(y0, y1, t);
    const p = profileAt(body, y);
    const extra = shape ? shape(t, y) : 0;
    out.push({
      y,
      rx: p.rx + pad + extra,
      rz: p.rz + pad + extra,
      x: p.x, z: p.z,
      // Cloth hangs rounder than the body underneath it; inheriting the
      // torso's squarer cross-section turns every top into a slab.
      sq: Math.min(p.sq, 0.10),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Torso
// ---------------------------------------------------------------------------

// Landmark heights for a 1.0-scale houseguest (multiplied by build.height).
// Roughly 6.6 heads tall: realistic proportions with a touch of stylisation so
// faces still read at gameplay camera distance.
export const RIG = {
  ankle: 0.095,
  knee: 0.595,
  hip: 1.130,      // femoral head, 0.509 of stature
  waist: 1.360,
  chest: 1.620,
  shoulder: 1.790, // acromion, 0.806 of stature
  neck: 1.815,
  chin: 1.909,
  head: 2.065,
  crown: 2.221,    // ~7.1 heads tall
};

// Half-breadths taken off standard anthropometry (breadth / stature, times
// 2.221 units of stature). Torsos read as blobs mostly because they get built
// too narrow and too circular; these are neither.
export function torsoRings(W, gender) {
  const fem = gender === 'f';
  const w = (v) => v * W;
  const hipW = fem ? 0.219 : 0.211;
  const waistW = fem ? 0.150 : 0.174;
  const chestW = fem ? 0.186 : 0.199;
  const shoulderW = fem ? 0.183 : 0.200;
  const chestD = fem ? 0.132 : 0.137;
  return [
    { y: 0.94, rx: w(hipW * 0.32), rz: w(0.056), sq: 0.06 },
    { y: 1.00, rx: w(hipW * 0.50), rz: w(0.076), sq: 0.08 },
    { y: 1.05, rx: w(hipW * 0.72), rz: w(0.101), sq: 0.12 },
    { y: 1.11, rx: w(hipW * 0.94), rz: w(0.126), sq: 0.16 },
    { y: 1.16, rx: w(hipW), rz: w(0.130), sq: 0.20 },
    { y: 1.27, rx: w(waistW * 1.10), rz: w(0.128), sq: 0.18 },
    { y: 1.36, rx: w(waistW), rz: w(0.124), sq: 0.16 },
    { y: 1.47, rx: w(waistW * 1.05), rz: w(0.130), sq: 0.18 },
    { y: 1.57, rx: w(chestW * 0.97), rz: w(chestD), sq: 0.22 },
    { y: 1.66, rx: w(chestW), rz: w(chestD), sq: 0.26 },
    { y: 1.75, rx: w(shoulderW), rz: w(0.124), sq: 0.30 },
    { y: 1.815, rx: w(shoulderW * 0.86), rz: w(0.104), sq: 0.26 },
    { y: 1.850, rx: w(0.114), rz: w(0.086), sq: 0.15 },
    { y: 1.880, rx: w(0.078), rz: w(0.073), sq: 0.06 },
    { y: 1.915, rx: w(0.070), rz: w(0.066) },
    { y: 1.950, rx: w(0.052), rz: w(0.050) },
    { y: 1.990, rx: w(0.022), rz: w(0.021) },
  ];
}

export function torsoGeometry(W, gender, seed) {
  const rings = torsoRings(W, gender);
  const geom = loft(rings, { sections: 34, radial: 30, capTop: true, capBottom: true });
  const fem = gender === 'f';
  displace(geom, (v) => {
    const nz = v.z, nx = v.x;
    const front = nz > 0;
    // Chest: a bust for female builds, pectoral plates otherwise.
    if (fem && front) {
      const bw = Math.sqrt(W);
      const b = brush(Math.abs(nx) - 0.076 * bw, v.y - 1.585, 0, 0.082 * bw, 0.080, 1);
      v.z += b * 0.042 * bw;
      v.y -= b * 0.010;
    } else if (front) {
      const b = brush(Math.abs(nx) - 0.086 * W, v.y - 1.620, 0, 0.080 * W, 0.062, 1);
      v.z += b * 0.024 * W;
    }
    // Clavicle hollow just under the throat.
    if (front) v.z -= brush(nx, v.y - 1.770, 0, 0.14 * W, 0.030, 1) * 0.022;
    // Glutes and the small of the back.
    if (!front) {
      v.z -= brush(Math.abs(nx) - 0.070 * W, v.y - 1.105, 0, 0.092 * W, 0.072, 1) * (fem ? 0.048 : 0.034) * W;
      v.z += brush(nx, v.y - 1.300, 0, 0.09 * W, 0.055, 1) * 0.016;
      // Spinal groove.
      v.z += brush(nx, 0, 0, 0.022 * W, 1, 1) * smooth01((v.y - 1.30) / 0.3) * 0.012;
    }
    // Trapezius ramp from neck to shoulder.
    v.y += brush(Math.abs(nx) - 0.11 * W, v.y - 1.815, 0, 0.10 * W, 0.06, 1) * 0.018;
  });
  return geom;
}

// ---------------------------------------------------------------------------
// Limbs
// ---------------------------------------------------------------------------

// All limb segments hang down -Y from their joint group, so rotation.x swings
// them like a real shoulder/hip.
export function upperArmGeometry(len, r, sleeve) {
  const g = loft([
    { y: 0.042 * len, rx: r * 0.06, rz: r * 0.06 },
    { y: 0.020 * len, rx: r * 0.90, rz: r * 0.88 },
    { y: -0.020 * len, rx: r * 1.26, rz: r * 1.20 },
    { y: -0.100 * len, rx: r * 1.36, rz: r * 1.28 },  // deltoid
    { y: -0.260 * len, rx: r * 1.14, rz: r * 1.10 },
    { y: -0.460 * len, rx: r * 1.00, rz: r * 0.98 },
    { y: -0.720 * len, rx: r * 0.86, rz: r * 0.86 },
    { y: -0.900 * len, rx: r * 0.82, rz: r * 0.82 },
    { y: -1.000 * len, rx: r * 0.80, rz: r * 0.80 },
    { y: -1.060 * len, rx: r * 0.72, rz: r * 0.72 },
    { y: -1.110 * len, rx: r * 0.44, rz: r * 0.44 },
  ], { sections: 28, radial: 20, capTop: true, capBottom: true });
  if (!sleeve) {
    // Biceps / triceps bellies.
    displace(g, (v) => {
      const s = brush(0, v.y + 0.46 * len, 0, 1, 0.16 * len, 1);
      const f = v.z > 0 ? 1 : 0.7;
      const n = Math.hypot(v.x, v.z) || 1;
      v.x += (v.x / n) * s * r * 0.14 * f;
      v.z += (v.z / n) * s * r * 0.14 * f;
    });
  }
  return g;
}

export function forearmGeometry(len, r, sleeve) {
  const g = loft([
    { y: 0.050 * len, rx: r * 0.45, rz: r * 0.45 },
    { y: 0.010 * len, rx: r * 1.00, rz: r * 0.98 },
    { y: -0.060 * len, rx: r * 1.10, rz: r * 1.06 },
    { y: -0.32 * len, rx: r * 0.96, rz: r * 0.92 },
    { y: -0.58 * len, rx: r * 0.80, rz: r * 0.75 },
    { y: -0.82 * len, rx: r * 0.66, rz: r * 0.60 },
    { y: -0.96 * len, rx: r * 0.58, rz: r * 0.53 },
    { y: -len, rx: r * 0.44, rz: r * 0.42 },
  ], { sections: 22, radial: 18, capTop: true, capBottom: true });
  if (!sleeve) {
    displace(g, (v) => {
      const s = brush(0, v.y + 0.24 * len, 0, 1, 0.20 * len, 1);
      const n = Math.hypot(v.x, v.z) || 1;
      v.x += (v.x / n) * s * r * 0.06;
      v.z += (v.z / n) * s * r * 0.06;
    });
  }
  return g;
}

export function thighGeometry(len, r) {
  const g = loft([
    { y: 0.13 * len, rx: r * 0.50, rz: r * 0.52, sq: 0.1 },
    { y: 0.05 * len, rx: r * 1.08, rz: r * 1.06, sq: 0.2 },
    { y: -0.06 * len, rx: r * 1.16, rz: r * 1.14, sq: 0.2 },
    { y: -0.34 * len, rx: r * 1.04, rz: r * 1.04, sq: 0.15 },
    { y: -0.62 * len, rx: r * 0.90, rz: r * 0.92 },
    { y: -0.88 * len, rx: r * 0.78, rz: r * 0.80 },
    { y: -0.96 * len, rx: r * 0.74, rz: r * 0.76 },
    { y: -1.00 * len, rx: r * 0.72, rz: r * 0.74 },
    { y: -1.05 * len, rx: r * 0.64, rz: r * 0.66 },
    { y: -1.10 * len, rx: r * 0.40, rz: r * 0.42 },
  ], { sections: 26, radial: 20, capTop: true, capBottom: true });
  displace(g, (v) => {
    // Quadriceps in front, hamstring behind, both riding higher than mid-thigh.
    const q = brush(0, v.y + 0.34 * len, 0, 1, 0.20 * len, 1);
    const n = Math.hypot(v.x, v.z) || 1;
    const front = v.z > 0 ? 1 : 0.85;
    v.x += (v.x / n) * q * r * 0.10 * front;
    v.z += (v.z / n) * q * r * 0.12 * front;
  });
  return g;
}

export function shinGeometry(len, r) {
  const g = loft([
    { y: 0.050 * len, rx: r * 0.45, rz: r * 0.46 },
    { y: 0.010 * len, rx: r * 1.06, rz: r * 1.07 },
    { y: -0.05 * len, rx: r * 1.12, rz: r * 1.12 },
    { y: -0.30 * len, rx: r * 0.95, rz: r * 0.96 },
    { y: -0.62 * len, rx: r * 0.68, rz: r * 0.72 },
    { y: -0.88 * len, rx: r * 0.56, rz: r * 0.58 },
    { y: -len, rx: r * 0.40, rz: r * 0.42 },
  ], { sections: 20, radial: 20, capTop: true, capBottom: true });
  displace(g, (v) => {
    // Calf: sits high and behind; the shin bone stays flat in front.
    if (v.z < 0) {
      const c = brush(0, v.y + 0.36 * len, 0, 1, 0.22 * len, 1);
      v.z -= c * r * 0.14;
    }
  });
  return g;
}

// ---------------------------------------------------------------------------
// Hands
// ---------------------------------------------------------------------------

// Palm plus four fingers and a thumb, merged into one geometry. At gameplay
// scale a finger is a few pixels, but in a conversation close-up the silhouette
// of a real hand is unmistakable next to a sphere.
export function handGeometry(scale = 1) {
  const s = scale;
  const parts = [];

  const palm = loft([
    { y: 0.012 * s, rx: 0.026 * s, rz: 0.017 * s, sq: 0.4 },
    { y: -0.022 * s, rx: 0.040 * s, rz: 0.020 * s, sq: 0.7 },
    { y: -0.062 * s, rx: 0.046 * s, rz: 0.021 * s, sq: 0.9 },
    { y: -0.098 * s, rx: 0.044 * s, rz: 0.019 * s, sq: 0.95 },
    { y: -0.112 * s, rx: 0.040 * s, rz: 0.017 * s, sq: 0.9 },
  ], { sections: 10, radial: 16 });
  parts.push(palm);

  const fingerLens = [0.084, 0.094, 0.089, 0.072].map((v) => v * s);
  const fingerX = [-0.029, -0.0098, 0.0098, 0.029].map((v) => v * s);
  const curl = [0.30, 0.22, 0.24, 0.34];
  fingerLens.forEach((len, i) => {
    const r = (i === 3 ? 0.0092 : 0.0112) * s;
    const f = loft([
      { y: 0, rx: r, rz: r * 0.92, sq: 0.3 },
      { y: -len * 0.42, rx: r * 0.92, rz: r * 0.86, sq: 0.25 },
      { y: -len * 0.78, rx: r * 0.82, rz: r * 0.78 },
      { y: -len, rx: r * 0.62, rz: r * 0.60 },
    ], { sections: 8, radial: 10 });
    // Fingers rest slightly curled and fanned — never board-flat.
    const m = new THREE.Matrix4()
      .makeTranslation(fingerX[i], -0.104 * s, 0.002 * s)
      .multiply(new THREE.Matrix4().makeRotationX(-curl[i]))
      .multiply(new THREE.Matrix4().makeRotationZ(-fingerX[i] * 3));
    f.applyMatrix4(m);
    parts.push(f);
  });

  const thumbR = 0.0125 * s, thumbLen = 0.062 * s;
  const thumb = loft([
    { y: 0, rx: thumbR, rz: thumbR * 0.9 },
    { y: -thumbLen * 0.5, rx: thumbR * 0.92, rz: thumbR * 0.86 },
    { y: -thumbLen, rx: thumbR * 0.66, rz: thumbR * 0.62 },
  ], { sections: 6, radial: 10 });
  thumb.applyMatrix4(new THREE.Matrix4()
    .makeTranslation(-0.034 * s, -0.040 * s, 0.014 * s)
    .multiply(new THREE.Matrix4().makeRotationZ(-0.45))
    .multiply(new THREE.Matrix4().makeRotationX(-0.35)));
  parts.push(thumb);

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  merged.computeVertexNormals();
  return merged;
}

// ---------------------------------------------------------------------------
// Footwear
// ---------------------------------------------------------------------------

// Built along +Y then laid forward, so the same loft machinery applies. Returns
// { upper, sole } — two geometries meant for two materials.
export function shoeGeometry(kind = 'sneaker', scale = 1) {
  const s = scale;
  const L = (kind === 'boot' ? 0.275 : 0.285) * s;
  const H = (kind === 'boot' ? 0.145 : kind === 'sandal' ? 0.055 : 0.085) * s;
  const W = 0.052 * s;

  // Upper: heel -> instep -> ball -> toe, laid out along +Y before rotation.
  const upper = loft([
    { y: -0.30 * L, rx: W * 0.80, rz: H * 0.62, z: H * 0.30, sq: 0.55 },
    { y: -0.16 * L, rx: W * 0.86, rz: H * 0.80, z: H * 0.18, sq: 0.5 },
    { y: 0.06 * L, rx: W * 0.92, rz: H * 0.94, z: H * 0.04, sq: 0.45 },
    { y: 0.30 * L, rx: W * 1.00, rz: H * 0.86, z: -H * 0.06, sq: 0.5 },
    { y: 0.52 * L, rx: W * 0.94, rz: H * 0.70, z: -H * 0.18, sq: 0.6 },
    { y: 0.66 * L, rx: W * 0.76, rz: H * 0.56, z: -H * 0.26, sq: 0.7 },
    { y: 0.70 * L, rx: W * 0.52, rz: H * 0.42, z: -H * 0.30, sq: 0.6 },
  ], { sections: 18, radial: 20 });

  const sole = loft([
    { y: -0.32 * L, rx: W * 0.86, rz: H * 0.24, z: -H * 0.50, sq: 0.8 },
    { y: -0.10 * L, rx: W * 0.92, rz: H * 0.22, z: -H * 0.52, sq: 0.85 },
    { y: 0.26 * L, rx: W * 1.05, rz: H * 0.22, z: -H * 0.52, sq: 0.85 },
    { y: 0.56 * L, rx: W * 1.00, rz: H * 0.21, z: -H * 0.50, sq: 0.8 },
    { y: 0.71 * L, rx: W * 0.60, rz: H * 0.18, z: -H * 0.48, sq: 0.7 },
  ], { sections: 12, radial: 18 });

  // Lay the foot forward: +Y becomes +Z, and drop it so the sole meets y=0.
  const lay = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  const shift = new THREE.Matrix4().makeTranslation(0, H * 0.72, 0.06 * s);
  upper.applyMatrix4(lay).applyMatrix4(shift);
  sole.applyMatrix4(lay).applyMatrix4(shift);
  upper.computeVertexNormals();
  sole.computeVertexNormals();
  return { upper, sole };
}

// ---------------------------------------------------------------------------
// Head
// ---------------------------------------------------------------------------

// A sculpted skull. Everything below works on the unit sphere first (so the
// FACE landmark directions in appearance.js line up with what gets painted)
// and only scales to head dimensions at the end.
export function headGeometry(v) {
  const geom = new THREE.SphereGeometry(1, 60, 44);
  const fem = v.gender === 'f';
  const age = clamp(((v.age || 28) - 30) / 30, 0, 1);

  const noseLen = v.nose;
  const browF = v.brow * (fem ? 0.68 : 1.0);
  const jawTaper = (fem ? 0.30 : 0.24) - v.jaw * 0.04;
  const gonion = v.jaw * (fem ? 0.60 : 1.0);
  const lipFull = fem ? 1.25 : 0.95;

  // Nose bridge profile, crown (y=+0.40) down to the base (y=-0.32).
  const profY = [0.42, 0.30, 0.16, 0.02, -0.10, -0.20, -0.30, -0.38];
  const profH = [0.00, 0.26, 0.50, 0.76, 1.00, 0.86, 0.34, 0.00];
  const noseProfile = (y) => {
    if (y > profY[0] || y < profY[profY.length - 1]) return 0;
    for (let i = 0; i < profY.length - 1; i++) {
      if (y <= profY[i] && y >= profY[i + 1]) {
        const t = (profY[i] - y) / (profY[i] - profY[i + 1]);
        return lerp(profH[i], profH[i + 1], smooth01(t));
      }
    }
    return 0;
  };

  const p = geom.attributes.position;
  const n = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    n.fromBufferAttribute(p, i);
    const x = n.x, y = n.y, z = n.z;
    const ax = Math.abs(x);
    let ox = 0, oy = 0, oz = 0;
    let sx = 1, sz = 1;

    // --- Skull
    const crownNarrow = smooth01((y - 0.55) / 0.45);
    sx -= crownNarrow * 0.07; sz -= crownNarrow * 0.06;
    oz -= brush(x, y - 0.06, z + 0.95, 0.85, 0.55, 0.6) * 0.055;   // occiput
    oz -= brush(ax - 0.80, y - 0.30, z - 0.42, 0.26, 0.30, 0.6) * 0.030; // temple
    ox -= Math.sign(x || 1) * brush(ax - 0.86, y - 0.30, z - 0.30, 0.24, 0.32, 0.7) * 0.026;

    // --- Jaw and chin
    const jt = smooth01((-y - 0.12) / 0.78);
    sx -= jt * jawTaper;
    sz -= jt * (z < 0 ? 0.24 : 0.08);
    const gon = brush(ax - 0.78, y + 0.44, z - 0.18, 0.22, 0.20, 0.55);
    ox += Math.sign(x || 1) * gon * 0.055 * gonion;
    oz += gon * 0.018 * gonion;
    const chin = brush(x, y + 0.78, z - 0.58, 0.30, 0.17, 0.50);
    oz += chin * 0.072 * v.chin;
    ox += Math.sign(x || 1) * chin * 0.030 * (fem ? 0.5 : 1) * v.chin;
    // Underside of the jaw sweeps back toward the neck.
    oz -= smooth01((-y - 0.70) / 0.30) * Math.max(0, z) * 0.30;

    // --- Brow, sockets, cheeks
    const brow = brush(ax - 0.40, y - 0.23, z - 0.80, 0.30, 0.13, 0.55);
    oz += brow * 0.068 * browF;
    oy -= brow * 0.010 * browF;
    oz += brush(x, y - 0.29, z - 0.90, 0.16, 0.10, 0.5) * 0.026 * browF; // glabella
    oz -= brush(ax - 0.40, y - 0.03, z - 0.82, 0.26, 0.19, 0.55) * 0.165; // orbit
    const cheek = brush(ax - 0.60, y + 0.06, z - 0.64, 0.30, 0.24, 0.58);
    const rad = Math.hypot(x, z) || 1;
    ox += (x / rad) * cheek * 0.062 * v.cheek;
    oz += (z / rad) * cheek * 0.052 * v.cheek;
    oz -= brush(ax - 0.55, y + 0.42, z - 0.55, 0.26, 0.24, 0.6) * (0.026 + age * 0.022);

    // --- Nose
    const wide = 0.100 + smooth01((-y + 0.02) / 0.28) * 0.070;
    const front = Math.max(0, z);
    const nasal = noseProfile(y) * Math.exp(-(x / wide) * (x / wide)) * front * front;
    oz += nasal * 0.235 * noseLen;
    oz += brush(x, y + 0.10, z - 0.98, 0.11, 0.10, 0.45) * 0.040 * noseLen;  // tip bulb
    const ala = brush(ax - 0.150, y + 0.180, z - 0.90, 0.070, 0.070, 0.4);
    ox += Math.sign(x || 1) * ala * 0.042 * noseLen;
    oz += ala * 0.020 * noseLen;
    oz -= brush(x, y + 0.265, z - 0.92, 0.09, 0.050, 0.4) * 0.042;  // under the septum

    // --- Mouth
    oz += brush(x, y + 0.45, z - 0.86, 0.26, 0.050, 0.5) * 0.034 * lipFull;
    oz += brush(x, y + 0.575, z - 0.84, 0.22, 0.060, 0.5) * 0.038 * lipFull;
    oz -= brush(x, y + 0.505, z - 0.86, 0.26, 0.020, 0.5) * 0.028;
    oz -= brush(ax - 0.215, y + 0.50, z - 0.80, 0.075, 0.08, 0.45) * 0.024;
    oz -= brush(x, y + 0.355, z - 0.90, 0.042, 0.065, 0.45) * 0.016;  // philtrum
    oz -= brush(x, y + 0.685, z - 0.74, 0.22, 0.045, 0.5) * 0.020;    // mentolabial

    // --- Asymmetry: nobody's face is mirrored, and a perfect one looks wrong.
    const wob = Math.sin(y * 5.1 + v.seedA) * Math.cos(x * 4.3 + v.seedB) * 0.008;
    ox += wob; oz += wob * 0.5;

    p.setXYZ(i, (x * sx + ox) * v.hx, (y + oy) * v.hy, (z * sz + oz) * v.hz);
  }
  p.needsUpdate = true;
  finish(geom);
  return geom;
}

// half-length, half-depth, half-thickness in world units. A real ear is about
// 60mm long, 32mm deep and stands ~15mm off the skull — a quarter of the size
// that scaling one number off the head lands on.
export function earGeometry(halfLen, halfDepth, halfThick) {
  const geom = new THREE.SphereGeometry(1, 20, 16);
  const p = geom.attributes.position;
  const n = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    n.fromBufferAttribute(p, i);
    const { x, y, z } = n;
    // Helix rim around the edge, concha bowl on the outer face, lobe at the base.
    const rim = brush(Math.hypot(y, z) - 0.86, 0, 0, 0.26, 1, 1);
    const bowl = brush(y + 0.02, z + 0.16, 0, 0.44, 0.42, 1);
    const lobe = smooth01((-y - 0.58) / 0.42);
    const sx = 1 + rim * 0.75 - bowl * 0.70 * Math.max(0, x);
    p.setXYZ(i,
      x * sx * halfThick,
      y * halfLen * (1 - lobe * 0.06) - lobe * halfLen * 0.04,
      (z - bowl * 0.10) * halfDepth * (1 - lobe * 0.30));
  }
  p.needsUpdate = true;
  finish(geom);
  return geom;
}

// ---------------------------------------------------------------------------
// Ribbons: hair cards, eyebrows, lashes
// ---------------------------------------------------------------------------

// Sweep a ribbon along a point list. `outward` orients the card's plane so it
// faces away from the head; width tapers root-to-tip.
export function ribbon(points, widthAt, outwardOf, { twist = 0, vFlip = false } = {}) {
  const m = points.length;
  const pos = [], uv = [], idx = [];
  const tangent = new THREE.Vector3();
  const out = new THREE.Vector3();
  const side = new THREE.Vector3();

  for (let i = 0; i < m; i++) {
    const t = i / (m - 1);
    const a = points[Math.max(0, i - 1)], b = points[Math.min(m - 1, i + 1)];
    tangent.subVectors(b, a).normalize();
    out.copy(outwardOf(points[i], t)).normalize();
    side.crossVectors(tangent, out);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    if (twist) {
      const q = new THREE.Quaternion().setFromAxisAngle(tangent, twist * t);
      side.applyQuaternion(q);
      out.applyQuaternion(q);
    }
    const w = widthAt(t) / 2;
    // A slight cup across the card keeps it from reading as a flat shard.
    const cup = out.clone().multiplyScalar(-w * 0.28);
    pos.push(
      points[i].x - side.x * w + cup.x, points[i].y - side.y * w + cup.y, points[i].z - side.z * w + cup.z,
      points[i].x, points[i].y, points[i].z,
      points[i].x + side.x * w + cup.x, points[i].y + side.y * w + cup.y, points[i].z + side.z * w + cup.z
    );
    const v = vFlip ? 1 - t : t;
    uv.push(0.04, v, 0.5, v, 0.96, v);
  }
  for (let i = 0; i < m - 1; i++) {
    const a = i * 3, b = a + 3;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
    idx.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export { clamp, smooth01, lerp, brush, mergeGeometries };
