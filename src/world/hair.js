// Hairstyles built the way game hair is actually built: an opaque scalp shell
// cut to a real hairline, plus alpha-tested strand cards swept along the skull
// and then released into gravity. Every card for one head is merged into a
// single draw call; styles that should move (a ponytail, hair past the
// shoulders) hand back a separate pivot group the animator can swing.

import * as THREE from 'three';
import { ribbon, mergeGeometries, clamp, smooth01, lerp } from './anatomy.js';
import { hairCardMaterial, hairSolidMaterial, rngFrom, hashSeed } from './appearance.js';

// Hairline height (as a unit-sphere y) per azimuth: high across the forehead,
// low at the nape, in between at the temples.
function hairlineFor(style) {
  const table = {
    short: [0.60, 0.10, -0.42],
    messy: [0.58, 0.08, -0.44],
    quiff: [0.64, 0.14, -0.40],
    curly: [0.56, 0.06, -0.46],
    afro: [0.54, 0.04, -0.48],
    long: [0.58, -0.02, -0.55],
    bob: [0.58, 0.00, -0.50],
    ponytail: [0.60, 0.02, -0.48],
    balding: [0.90, 0.46, -0.42],
  };
  const [front, side, back] = table[style] || table.short;
  return (phi) => {
    const s = Math.sin(phi), c = Math.abs(Math.cos(phi));
    const f = Math.max(0, s), b = Math.max(0, -s);
    return front * f + back * b + side * c * (1 - Math.max(f, b) * 0.5);
  };
}

// Directions use the same convention as the head sculpt: +Z forward, +Y up.
function dirOf(theta, phi) {
  const st = Math.sin(theta);
  return new THREE.Vector3(st * Math.cos(phi), Math.cos(theta), st * Math.sin(phi));
}

export function buildHair(hg, dims, seed) {
  const style = hg.hairStyle || (hg.gender === 'f' ? 'long' : 'short');
  const rnd = rngFrom(hashSeed(String(hg.id) + ':hair' + seed));
  const { hx, hy, hz, neckY, shoulderY } = dims;
  const yMin = hairlineFor(style);

  // Place a unit direction on the scalp, pushed out by `off`.
  const surf = (d, off) => new THREE.Vector3(
    d.x * (hx + off), d.y * (hy + off), d.z * (hz + off)
  );

  // Keep strands out of the skull and off the shoulders.
  const collide = (p) => {
    const e = Math.hypot(p.x / (hx * 1.005), p.y / (hy * 1.005), p.z / (hz * 1.005));
    if (e < 1 && e > 1e-5) p.multiplyScalar(1 / e);
    if (p.y < neckY) {
      const t = clamp((neckY - p.y) / 0.26, 0, 1);
      const minR = lerp(0.085, 0.175, t);
      const r = Math.hypot(p.x, p.z);
      if (r < minR) {
        if (r < 1e-4) { p.x = minR * 0.4; p.z = -minR * 0.9; }
        else { p.x *= minR / r; p.z *= minR / r; }
      }
    }
    if (p.y < shoulderY - 0.02) p.y = shoulderY - 0.02 - (shoulderY - 0.02 - p.y) * 0.25;
  };

  // One strand card: hug the skull for a while, then fall.
  function card(root, flow, o) {
    const pts = [];
    const d0 = root.clone().normalize();
    const f = flow.clone().addScaledVector(d0, -flow.dot(d0));
    if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
    f.normalize();

    const hugSteps = Math.max(2, o.hugSteps);
    for (let i = 0; i <= hugSteps; i++) {
      const a = (i / hugSteps) * o.hugArc;
      const d = d0.clone().multiplyScalar(Math.cos(a)).addScaledVector(f, Math.sin(a));
      pts.push(surf(d, o.off + (i / hugSteps) * (o.offGrow || 0)));
    }

    if (o.fallSteps > 0) {
      const last = pts[pts.length - 1];
      const v = last.clone().sub(pts[pts.length - 2]).normalize();
      const down = new THREE.Vector3(0, -1, 0);
      const step = o.fallLen / o.fallSteps;
      const side = new THREE.Vector3().crossVectors(v, down).normalize();
      let p = last.clone();
      for (let i = 1; i <= o.fallSteps; i++) {
        v.lerp(down, o.gravity).normalize();
        p = p.clone().addScaledVector(v, step);
        if (o.curl) {
          p.addScaledVector(side, Math.sin(i * o.curlFreq + o.curlPhase) * o.curl);
          p.y += Math.cos(i * o.curlFreq + o.curlPhase) * o.curl * 0.35;
        }
        pts.push(p);
      }
    }
    pts.forEach(collide);
    return pts;
  }

  // Ribbon plane faces away from the head's vertical axis.
  const outward = (p) => {
    const v = new THREE.Vector3(p.x, p.y * 0.22, p.z);
    if (v.lengthSq() < 1e-5) v.set(0, 0.2, -1);
    return v.normalize();
  };

  const still = [];   // cards fixed to the skull
  const swing = [];   // cards that should lag behind the walk
  const pivot = new THREE.Vector3(0, hy * 0.20, -hz * 0.45);

  const emit = (pts, width, { moving = false, taper = 0.25 } = {}) => {
    const src = moving ? pts.map((p) => p.clone().sub(pivot)) : pts;
    const g = ribbon(src, (t) => width * (1 - smooth01(t) * (1 - taper)), outward);
    (moving ? swing : still).push(g);
  };

  // Roots on a jittered (theta, phi) grid, respecting the hairline.
  function roots(count, { minY = -2, maxY = 2, backOnly = false, part = 0 } = {}) {
    const out = [];
    const rings = Math.max(3, Math.round(Math.sqrt(count / 2)));
    const perRing = Math.max(6, Math.round(count / rings));
    for (let r = 0; r < rings; r++) {
      for (let k = 0; k < perRing; k++) {
        const phi = ((k + (r % 2) * 0.5 + rnd() * 0.35) / perRing) * Math.PI * 2;
        const lim = Math.acos(clamp(yMin(phi), -1, 1));
        const tt = (r + 0.5 + (rnd() - 0.5) * 0.7) / rings;
        const theta = clamp(tt, 0.02, 0.99) * lim;
        const d = dirOf(theta, phi);
        if (d.y < minY || d.y > maxY) continue;
        if (backOnly && d.z > 0.15) continue;
        // A centre part leaves a visible gap of scalp at the front.
        if (part && Math.abs(d.x) < part && d.z > 0.45) continue;
        out.push(d);
      }
    }
    return out;
  }

  const back = new THREE.Vector3(0, -0.35, -1).normalize();

  if (style === 'balding') {
    // Horseshoe only — and shorter, so the scalp reads as scalp.
    for (const d of roots(90)) {
      emit(card(d, back, {
        hugArc: 0.55 + rnd() * 0.3, hugSteps: 4, off: 0.006,
        fallLen: 0.02, fallSteps: 1, gravity: 0.6,
      }), 0.030 + rnd() * 0.012);
    }
  } else if (style === 'short') {
    for (const d of roots(130)) {
      const flow = back.clone().addScaledVector(new THREE.Vector3(rnd() - 0.5, 0, rnd() - 0.5), 0.5);
      emit(card(d, flow, {
        hugArc: 0.60 + rnd() * 0.35, hugSteps: 5, off: 0.007, offGrow: 0.004,
        fallLen: 0.018, fallSteps: 1, gravity: 0.5,
      }), 0.028 + rnd() * 0.014);
    }
  } else if (style === 'messy') {
    for (const d of roots(140)) {
      const up = rnd() < 0.35;
      const flow = new THREE.Vector3(rnd() - 0.5, up ? 0.8 : -0.3, rnd() - 0.5).normalize();
      emit(card(d, flow, {
        hugArc: 0.45 + rnd() * 0.5, hugSteps: 4, off: 0.008, offGrow: 0.012,
        fallLen: 0.035 + rnd() * 0.03, fallSteps: 2, gravity: up ? 0.12 : 0.55,
      }), 0.026 + rnd() * 0.018);
    }
  } else if (style === 'quiff') {
    for (const d of roots(120)) {
      const front = d.z > 0.35 && d.y > 0.25;
      const flow = front
        ? new THREE.Vector3((rnd() - 0.5) * 0.4, 0.9, -0.5).normalize()
        : back.clone().addScaledVector(new THREE.Vector3(rnd() - 0.5, 0, 0), 0.4);
      emit(card(d, flow, {
        hugArc: front ? 0.9 + rnd() * 0.3 : 0.55 + rnd() * 0.25,
        hugSteps: 5,
        off: front ? 0.012 : 0.006,
        offGrow: front ? 0.030 : 0.003,
        fallLen: front ? 0.055 : 0.015,
        fallSteps: front ? 3 : 1,
        gravity: front ? 0.08 : 0.5,
      }), front ? 0.030 + rnd() * 0.014 : 0.024 + rnd() * 0.012);
    }
  } else if (style === 'curly' || style === 'afro') {
    const big = style === 'afro';
    for (const d of roots(big ? 190 : 165)) {
      const flow = new THREE.Vector3(rnd() - 0.5, -0.2 + rnd() * 0.5, rnd() - 0.5).normalize();
      emit(card(d, flow, {
        hugArc: 0.42 + rnd() * 0.3, hugSteps: 4,
        off: big ? 0.020 : 0.010, offGrow: big ? 0.046 : 0.024,
        fallLen: big ? 0.075 : 0.05, fallSteps: 5, gravity: 0.25,
        curl: big ? 0.010 : 0.007, curlFreq: 1.3 + rnd() * 0.5, curlPhase: rnd() * 6.28,
      }), (big ? 0.050 : 0.044) + rnd() * 0.018, { taper: 0.7 });
    }
  } else if (style === 'ponytail') {
    for (const d of roots(130)) {
      emit(card(d, back, {
        hugArc: 0.9 + rnd() * 0.4, hugSteps: 6, off: 0.006, offGrow: 0.002,
        fallLen: 0.02, fallSteps: 1, gravity: 0.3,
      }), 0.022 + rnd() * 0.01);
    }
    // The tail itself: a bundle from the tie point, free to swing.
    const tie = new THREE.Vector3(0, 0.34, -0.92).normalize();
    for (let i = 0; i < 22; i++) {
      const jitter = new THREE.Vector3((rnd() - 0.5) * 0.10, (rnd() - 0.5) * 0.06, 0).normalize();
      const root = tie.clone().addScaledVector(jitter, 0.10).normalize();
      emit(card(root, new THREE.Vector3(0, -0.2, -1).normalize(), {
        hugArc: 0.18, hugSteps: 2, off: 0.030,
        fallLen: 0.30 + rnd() * 0.10, fallSteps: 7, gravity: 0.34,
        curl: 0.008, curlFreq: 1.6, curlPhase: rnd() * 6.28,
      }), 0.030 + rnd() * 0.018, { moving: true, taper: 0.35 });
    }
  } else if (style === 'bob') {
    for (const d of roots(150, { part: 0.05 })) {
      const fringe = d.z > 0.5 && d.y > 0.3;
      // A fringe stops above the brow. Travel is hugArc*hy plus fallLen, and
      // the hairline is only ~0.06 above the brow ridge, so it does not take
      // much to end up with hair hanging in the eyes.
      emit(card(d, fringe ? new THREE.Vector3(0.45 * Math.sign(d.x || 1), -0.25, 0.85).normalize() : back, {
        hugArc: fringe ? 0.16 : 0.85 + rnd() * 0.35, hugSteps: 5,
        off: 0.009, offGrow: 0.006,
        fallLen: fringe ? 0.020 : 0.22 + rnd() * 0.05,
        fallSteps: fringe ? 2 : 6,
        gravity: fringe ? 0.40 : 0.72,
      }), (fringe ? 0.024 : 0.030) + rnd() * 0.014, { moving: !fringe, taper: 0.5 });
    }
  } else {
    // long
    for (const d of roots(170, { part: 0.055 })) {
      const fall = 0.42 + rnd() * 0.16;
      emit(card(d, back, {
        hugArc: 0.8 + rnd() * 0.5, hugSteps: 5, off: 0.009, offGrow: 0.006,
        fallLen: fall, fallSteps: 9, gravity: 0.70,
        curl: 0.005, curlFreq: 1.2, curlPhase: rnd() * 6.28,
      }), 0.032 + rnd() * 0.018, { moving: true, taper: 0.45 });
    }
  }

  // Hairline fringe: short cards rooted on the hairline itself and swept up
  // over the scalp shell, so the shell's cut edge is never the silhouette.
  if (style !== 'balding') {
    const fringe = style === 'afro' || style === 'curly' ? 0.018 : 0.008;
    for (let k = 0; k < 150; k++) {
      const phi = (k / 150) * Math.PI * 2 + rnd() * 0.06;
      const lim = Math.acos(clamp(yMin(phi), -1, 1));
      const d = dirOf(lim * (0.90 + rnd() * 0.13), phi);
      emit(card(d, new THREE.Vector3(0, 1, 0), {
        hugArc: 0.30 + rnd() * 0.28, hugSteps: 4,
        off: 0.006, offGrow: fringe,
        fallLen: 0.012, fallSteps: 1, gravity: 0.3,
      }), 0.030 + rnd() * 0.016, { taper: 0.55 });
    }
  }

  // --- Scalp shell, cut to the hairline (skipped for balding: that's the point)
  const group = new THREE.Group();
  const solid = hairSolidMaterial(hg.hair);
  if (style !== 'balding') {
    const RAD = 40, ROWS = 16;
    const pos = [], uv = [], idx = [];
    const puff = style === 'afro' ? 0.032 : style === 'curly' ? 0.016 : 0.006;
    for (let r = 0; r <= ROWS; r++) {
      for (let j = 0; j <= RAD; j++) {
        const phi = (j / RAD) * Math.PI * 2;
        const lim = Math.acos(clamp(yMin(phi), -1, 1));
        const theta = (r / ROWS) * lim;
        const d = dirOf(theta, phi);
        const p = surf(d, 0.004 + puff * smooth01(1 - r / ROWS));
        pos.push(p.x, p.y, p.z);
        uv.push(j / RAD, r / ROWS);
      }
    }
    const cols = RAD + 1;
    for (let r = 0; r < ROWS; r++) {
      for (let j = 0; j < RAD; j++) {
        const a = r * cols + j;
        idx.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
      }
    }
    const cap = new THREE.BufferGeometry();
    cap.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    cap.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    cap.setIndex(idx);
    cap.computeVertexNormals();
    const capMesh = new THREE.Mesh(cap, solid);
    capMesh.castShadow = true;
    group.add(capMesh);
  }

  const cardMat = hairCardMaterial(hg.hair);
  if (still.length) {
    const g = mergeGeometries(still, false);
    still.forEach((x) => x.dispose());
    const m = new THREE.Mesh(g, cardMat);
    m.castShadow = true;
    group.add(m);
  }

  let swingGroup = null;
  if (swing.length) {
    const g = mergeGeometries(swing, false);
    swing.forEach((x) => x.dispose());
    swingGroup = new THREE.Group();
    swingGroup.position.copy(pivot);
    const m = new THREE.Mesh(g, cardMat);
    m.castShadow = true;
    swingGroup.add(m);
    group.add(swingGroup);
  }

  return { group, swing: swingGroup };
}

// Eyebrows: a tapered arc riding the brow ridge, built from the same ribbon
// machinery as hair so it picks up the strand texture.
export function buildBrow(side, dims, hairColor, spec) {
  const { hx, hy, hz } = dims;
  const pts = [];
  const N = 9;
  const thick = spec.gender === 'f' ? 0.80 : 1.15;
  const unit = hy / 0.156;   // keep brow gauge proportional to build height
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    // Inner head near the nose, arching up over the orbit, tapering outward.
    const x = lerp(0.14, 0.60, t) * side;
    const y = 0.200 + Math.sin(t * Math.PI) * 0.070 - t * 0.055;
    const z = Math.sqrt(Math.max(0.02, 1 - x * x - y * y));
    const d = new THREE.Vector3(x, y, z).normalize();
    pts.push(new THREE.Vector3(d.x * (hx + 0.0022), d.y * (hy + 0.0022), d.z * (hz + 0.0022)));
  }
  const g = ribbon(
    pts,
    (t) => (0.0055 + Math.sin(Math.min(1, t * 1.2) * Math.PI) * 0.0055) * thick * unit,
    (p) => new THREE.Vector3(p.x, p.y, p.z).normalize(),
    { vFlip: true }
  );
  const m = new THREE.Mesh(g, hairSolidMaterial(
    new THREE.Color(hairColor).lerp(new THREE.Color(0x140f0c), 0.34).getHex()
  ));
  m.material.side = THREE.DoubleSide;
  return m;
}
