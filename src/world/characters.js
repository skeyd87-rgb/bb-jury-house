// Houseguests, v3 — sculpted anatomy instead of stacked primitives.
//
// Each character is a real two-bone rig: pelvis and spine counter-rotate,
// knees and elbows bend, ankles roll, the chest breathes, the eyes blink and
// the head drifts and settles. Bodies come from `anatomy.js` (lofted torsos,
// tapered limbs, a sculpted skull), skin/cloth/eyes from `appearance.js`, and
// hairstyles from `hair.js`.
//
// The external contract is unchanged: createCharacter(hg) -> Object3D,
// animateCharacter(char, moving, dt, t), updateTagName(char, name), and
// userData.{ id, tag, status, headY, baseY }.

import * as THREE from 'three';
import {
  RIG, torsoRings, torsoGeometry, upperArmGeometry, forearmGeometry,
  thighGeometry, shinGeometry, handGeometry, shoeGeometry,
  headGeometry, earGeometry, loft, shellRings, displace, profileAt,
  mergeGeometries, ribbon, clamp, smooth01, lerp,
} from './anatomy.js';
import {
  skinMaterial, fabricMaterial, eyeMaterial, simpleMaterial, contactShadowTexture,
  outfitFor, faceSpecFor, hashSeed, rngFrom, sphUV,
} from './appearance.js';
import { buildHair, buildBrow } from './hair.js';

// Upper-lid swing, in radians of the lid cap's own pivot: parked just clear of
// the aperture, closing past its lower edge.
const LID_OPEN = -0.06;
const LID_SHUT = 0.66;

// Eyelids are paper-thin shells; without DoubleSide you see straight through
// the rim at a three-quarter angle.
const LID_MATS = new Map();
function lidMaterial(skin) {
  let m = LID_MATS.get(skin);
  if (!m) {
    m = skinMaterial(skin).clone();
    m.side = THREE.DoubleSide;
    LID_MATS.set(skin, m);
  }
  return m;
}

// Re-project a sub-mesh's UVs onto the head's equirectangular map so eyelids,
// eye surrounds and ears pick up the painted skin tone they sit in, instead of
// sampling whatever the primitive's own UVs happened to land on.
function projectHeadUV(geom, hx, hy, hz, offset = null) {
  const pos = geom.attributes.position;
  const uv = geom.attributes.uv;
  if (!uv) return geom;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + (offset ? offset.x : 0);
    const y = pos.getY(i) + (offset ? offset.y : 0);
    const z = pos.getZ(i) + (offset ? offset.z : 0);
    const [u, v] = sphUV(x / hx, y / hy, z / hz);
    uv.setXY(i, u, 1 - v);
  }
  uv.needsUpdate = true;
  return geom;
}

// The eye surround: a skin shell over the eyeball with an almond aperture cut
// through it. This, not the eyeball, is what makes an eye read as an eye — a
// bare sphere set in a socket always looks like a marble.
function eyeSocketGeometry(r, hA, vA, tilt, side) {
  const RAD = 40, RINGS = 5, SPREAD = 1.15;
  const pos = [], uv = [], idx = [];
  for (let ri = 0; ri <= RINGS; ri++) {
    for (let j = 0; j <= RAD; j++) {
      const a = (j / RAD) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const phiIn = 1 / Math.hypot(ca / hA, sa / vA);
      const phi = phiIn + (ri / RINGS) * SPREAD;
      const cr = Math.cos(tilt * side), sr = Math.sin(tilt * side);
      const dx = ca * cr - sa * sr, dy = ca * sr + sa * cr;
      const sp = Math.sin(phi);
      pos.push(sp * dx * r, sp * dy * r, Math.cos(phi) * r);
      uv.push(j / RAD, ri / RINGS);
    }
  }
  const cols = RAD + 1;
  for (let ri = 0; ri < RINGS; ri++) {
    for (let j = 0; j < RAD; j++) {
      const a = ri * cols + j;
      idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// A shoulder strap: front of the chest, up over the trapezius, down the back,
// riding the body surface the whole way. Every vertex is snapped back onto the
// padded body cross-section, because a flat ribbon laid across a curved chest
// lifts off it at the edges and reads as a floating rectangle.
function shoulderStrap(body, side, xs, width, frontY, backY, pad, H) {
  let ytop = 1.62 * H;
  for (let y = 1.90 * H; y > 1.62 * H; y -= 0.003 * H) {
    if (profileAt(body, y).rx >= xs) { ytop = y; break; }
  }
  const N = 22, COLS = 5;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const th = (t - 0.5) * Math.PI;         // -90 deg front -> 0 top -> +90 back
    const c = Math.cos(th), sn = Math.sin(th);
    const y0 = lerp(th < 0 ? frontY : backY, ytop, c);
    const p = profileAt(body, y0);
    const k = Math.min(1, xs / (p.rx + pad));
    const z = -sn * (p.rz + pad) * Math.sqrt(Math.max(0, 1 - k * k));
    // Over the top of the shoulder the surface normal points up, so that is
    // the direction the strap has to stand off in.
    const y = y0 + pad * 0.85 * c;
    // Across the strap: mostly lateral on the chest, front-to-back over the top.
    const sx = -sn * c * 0.35 + (1 - c) * 1.0;
    const sz = c;
    const conform = Math.abs(sn);
    for (let j = 0; j < COLS; j++) {
      const u = (j / (COLS - 1) - 0.5) * width;
      const rawX = side * xs + side * u * sx;
      const rawZ = z + u * sz;
      const s = Math.hypot(rawX / (p.rx + pad), rawZ / (p.rz + pad));
      const vx = s > 1e-4 ? lerp(rawX, rawX / s, conform) : rawX;
      const vz = s > 1e-4 ? lerp(rawZ, rawZ / s, conform) : rawZ;
      pos.push(vx, y, vz);
      uv.push(j / (COLS - 1), t);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < COLS - 1; j++) {
      const a = i * COLS + j;
      idx.push(a, a + COLS, a + 1, a + 1, a + COLS, a + COLS + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function mesh(geom, mat, { shadow = false, receive = false } = {}) {
  const m = new THREE.Mesh(geom, mat);
  m.castShadow = shadow;
  m.receiveShadow = receive;
  return m;
}

function mergeInto(geoms, mat, opts) {
  const g = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
  if (geoms.length > 1) geoms.forEach((x) => x.dispose());
  return mesh(g, mat, opts);
}

// Scoop a neckline out of a finished garment shell. The top band of the shell
// is *compressed* toward its lower edge rather than translated down: a
// translation slides the topmost ring past the rings beneath it and the surface
// folds into spikes, and it also drags the small neck-radius edge down inside
// the chest, where you end up looking at the inside of the shirt.
function neckline(geom, topY, dip, { power = 1.6, backDip = 0.25, sideDip = 0, H = 1 }) {
  const band = Math.max(0.11 * H, dip * 1.3);
  const yStart = topY - band;
  displace(geom, (v) => {
    if (v.y <= yStart) return;
    const r = Math.hypot(v.x, v.z) || 1;
    const fwd = Math.max(0, v.z / r);
    const back = Math.max(0, -v.z / r);
    const side = Math.abs(v.x) / r;
    const f = Math.min(1, Math.pow(fwd, power) + back * backDip + side * sideDip);
    const k = 1 - f * Math.min(0.9, dip / band);
    v.y = yStart + (v.y - yStart) * k;
  });
}

export function createCharacter(hg) {
  const g = new THREE.Group();
  const b = hg.build || { height: 1, width: 1 };
  const H = b.height, W = b.width;
  const fem = hg.gender === 'f';
  const seed = hashSeed(String(hg.id));
  const rnd = rngFrom(seed);

  const fit = outfitFor(hg);
  const faceSpec = faceSpecFor(hg);
  const skin = skinMaterial(hg.skin);
  const faceMat = skinMaterial(hg.skin, faceSpec);
  const topMat = fabricMaterial(fit.topColor, fit.fabric);
  const trimMat = fabricMaterial(fit.trim, fit.fabric === 'satin' ? 'satin' : 'cotton', 1.4);
  const botMat = fabricMaterial(fit.bottomColor, fit.bottomFabric);
  const shoeMat = simpleMaterial(fit.shoe.upper, fit.shoe.kind === 'boot' ? 0.55 : 0.68);
  const soleMat = simpleMaterial(fit.shoe.sole, 0.9);

  // --- Skeleton heights ------------------------------------------------------
  const Y = (v) => v * H;
  const hipY = Y(RIG.hip), waistY = Y(RIG.waist), shoulderY = Y(RIG.shoulder);
  const headY = Y(RIG.head), kneeY = Y(RIG.knee), ankleY = Y(RIG.ankle);
  const thighLen = hipY - kneeY;
  const shinLen = kneeY - ankleY;
  const upperArmLen = 0.420 * H;
  const foreArmLen = 0.330 * H;

  const lw = Math.pow(W, 0.65);          // limb girth follows build width, softly
  const armR = 0.058 * lw * H;
  const foreR = 0.050 * lw * H;
  const thighR = 0.094 * lw * H;
  const shinR = 0.070 * lw * H;
  const hipX = 0.098 * W * H;
  const shoulderX = (fem ? 0.178 : 0.193) * W * H;

  const body = torsoRings(W, hg.gender).map((r) => ({ ...r, y: r.y * H, rx: r.rx * H, rz: r.rz * H }));

  // Sculpted volumes the flat ring profile does not describe. Any shell that
  // covers one gets the same bump so the body never walks through the cloth.
  const bustBump = (v, yOff = 0) => {
    if (v.z <= 0) return;
    const bw = Math.sqrt(W);
    const b = Math.exp(-Math.pow((Math.abs(v.x) - 0.076 * bw * H) / (0.094 * bw * H), 2)
      - Math.pow((v.y + yOff - 1.582 * H) / (0.092 * H), 2));
    v.z += b * 0.040 * bw * H;
    v.y -= b * 0.010 * H;
  };
  const gluteBump = (v, yOff = 0) => {
    if (v.z >= 0) return;
    const b = Math.exp(-Math.pow((Math.abs(v.x) - 0.070 * W * H) / (0.100 * W * H), 2)
      - Math.pow((v.y + yOff - 1.105 * H) / (0.080 * H), 2));
    v.z -= b * (fem ? 0.052 : 0.038) * W * H;
  };

  // --- Root groups -----------------------------------------------------------
  // Legs hang off the pelvis; everything above the waist hangs off the spine.
  // Rotating the two in opposite directions is what makes a walk read as a
  // walk instead of a shuffle.
  const hips = new THREE.Group();
  hips.position.y = hipY;
  g.add(hips);

  const spine = new THREE.Group();
  spine.position.y = waistY;
  g.add(spine);
  const sy = (y) => y - waistY;   // world height -> spine-local

  // --- Torso + neck ----------------------------------------------------------
  // torsoGeometry is authored at H=1 (its sculpt brushes use absolute heights),
  // so scale the finished mesh and only then move it into spine-local space.
  const torsoGeom = torsoGeometry(W, hg.gender, seed);
  torsoGeom.scale(H, H, H);
  torsoGeom.translate(0, -waistY, 0);
  const neckR = 0.070 * W * H;
  const torsoMesh = mergeInto([torsoGeom], skin, { shadow: true });
  spine.add(torsoMesh);

  // --- Bottoms ---------------------------------------------------------------
  // The seat belongs to the pelvis, not the spine, and its lower edge is cut on
  // a curve — low at the outseam, high at the crotch — so the trouser legs can
  // emerge from underneath instead of meeting a flat horizontal hem.
  const seatTop = fit.bottom === 'skirt' ? 1.30 : 1.265;
  const hipYL = (y) => y - hipY;
  const botPad = 0.024 * H;
  const tubeTopR = 1.32 * thighR;
  const seatSpan = hipX + tubeTopR + 0.008 * H;

  if (fit.bottom !== 'skirt') {
    const seatRing = (y, rzScale = 1) => {
      const b = profileAt(body, y);
      // Only the crotch region needs widening out to clear the thighs; above
      // the hip the trousers hug the waist, or you see straight down inside them.
      const floor = y < 1.17 * H ? seatSpan : 0;
      return {
        y: hipYL(y),
        rx: Math.max(b.rx + botPad, floor),
        rz: Math.max((b.rz + botPad) * rzScale, tubeTopR * 1.16),
        sq: 0.14,
      };
    };
    const seat = loft([
      seatRing(seatTop * H), seatRing(1.210 * H), seatRing(1.155 * H),
      seatRing(1.100 * H, 0.98), seatRing(1.040 * H, 0.94), seatRing(0.970 * H, 0.90),
    ], { sections: 18, radial: 30, capTop: false, capBottom: false });
    const crotchRaise = 0.042 * H, crotchLow = hipYL(1.105 * H);
    displace(seat, (v) => {
      if (v.y > crotchLow) return;
      const t = smooth01((crotchLow - v.y) / (0.13 * H));
      const inner = Math.exp(-Math.pow(v.x / (hipX * 1.05), 2));
      v.y += t * inner * crotchRaise;
    });
    displace(seat, (v) => gluteBump(v, hipY));
    hips.add(mesh(seat, botMat, { shadow: true }));
  }

  // Waistband — a belt, not a trim stripe.
  const bandRing = profileAt(body, seatTop * H);
  const band = loft([
    { y: hipYL(seatTop * H - 0.038 * H), rx: bandRing.rx + botPad + 0.004 * H, rz: bandRing.rz + botPad + 0.004 * H, sq: 0.14 },
    { y: hipYL(seatTop * H), rx: bandRing.rx + botPad + 0.005 * H, rz: bandRing.rz + botPad + 0.005 * H, sq: 0.14 },
  ], { sections: 4, radial: 30, capTop: false, capBottom: false });
  hips.add(mesh(band, fabricMaterial(fit.bottom === 'skirt' ? fit.bottomColor : 0x241c16, 'leather')));

  if (fit.bottom === 'skirt') {
    const hipRing = profileAt(body, 1.17 * H);
    const sk = (y, extra, sq) => {
      const b = profileAt(body, y);
      return { y: hipYL(y), rx: Math.max(b.rx, hipRing.rx * 0.82) + botPad + extra, rz: Math.max(b.rz, hipRing.rz * 0.82) + botPad + extra, sq: Math.min(sq, 0.12) };
    };
    const skirt = loft([
      sk(seatTop * H, 0, 0.30),
      sk(1.240 * H, 0.004 * H, 0.30),
      sk(1.175 * H, 0.010 * H, 0.28),
      sk(1.090 * H, 0.038 * H, 0.22),
      sk(1.000 * H, 0.082 * H, 0.16),
      sk(0.945 * H, 0.112 * H, 0.10),
    ], { sections: 16, radial: 30, capTop: false, capBottom: false });
    hips.add(mesh(skirt, botMat, { shadow: true }));
  }

  // --- Tops ------------------------------------------------------------------
  const TOP_HEM = { crop: 1.435, blouse: 1.150, tank: 1.170, tee: 1.135, polo: 1.150, button: 1.130, henley: 1.150 };
  const strapped = fit.top === 'tank' || fit.top === 'blouse';
  const hemY = (TOP_HEM[fit.top] ?? 1.15) * H;
  const topY = strapped ? (fit.top === 'tank' ? 1.745 : 1.760) * H : 1.845 * H;
  const pad = (fit.fabric === 'satin' ? 0.030 : 0.026) * H;

  // Below the waist the shirt hangs over the trousers, so it has to clear the
  // seat shell by more than the loft's own interpolation error — otherwise the
  // two surfaces saw through each other along the hem.
  const shirtRings = shellRings(body, hemY, topY, pad, (t, y) => {
    let extra = fit.top === 'blouse' ? Math.sin(t * Math.PI) * 0.012 * H : 0;
    if (y < waistY) extra += 0.016 * H * smooth01((waistY - y) / (0.20 * H));
    extra += 0.020 * H * smooth01((y - 1.55 * H) / (0.15 * H));
    return extra;
  });
  if (fit.bottom !== 'skirt') {
    for (const r of shirtRings) {
      if (r.y >= 1.20 * H) continue;
      const ramp = smooth01((1.20 * H - r.y) / (0.09 * H));
      r.rx = Math.max(r.rx, (seatSpan + 0.016 * H) * ramp + r.rx * (1 - ramp));
      r.rz = Math.max(r.rz, (seatSpan * 0.66 + 0.016 * H) * ramp + r.rz * (1 - ramp));
    }
  }
  const shirt = loft(shirtRings, { sections: 20, radial: 30, capTop: false, capBottom: false });
  const strapDip = fit.top === 'blouse' ? 0.080 * H : 0.055 * H;
  if (!strapped) {
    // A neck hole sits close to the neck, so only a shallow scoop is safe; the
    // open-shirt read comes from the collar break and placket instead.
    const dip = fit.top === 'button' ? 0.042 * H : fit.top === 'polo' ? 0.034 * H : 0.026 * H;
    neckline(shirt, topY, dip, { power: fit.top === 'button' ? 2.4 : 1.6, H });
  } else {
    neckline(shirt, topY, strapDip, { power: 1.3, backDip: 0.6, sideDip: 0.75, H });
  }
  displace(shirt, (v) => {
    if (fem) bustBump(v);
    gluteBump(v);
  });
  shirt.translate(0, -waistY, 0);
  spine.add(mesh(shirt, topMat, { shadow: true }));

  if (strapped) {
    // Straps instead of a carved armhole — cheaper, and it reads better.
    const strapW = fit.top === 'blouse' ? 0.058 * H : 0.034 * H;
    const xs = profileAt(body, 1.75 * H).rx * 0.66;
    const straps = [];
    for (const s of [-1, 1]) {
      const g = shoulderStrap(body, s, xs, strapW,
        topY - strapDip - 0.012 * H, topY - strapDip * 0.55 - 0.012 * H, pad, H);
      g.translate(0, -waistY, 0);
      straps.push(g);
    }
    spine.add(mergeInto(straps, topMat, { shadow: true }));
  }

  // Collar + placket for the shirts that have one.
  if (fit.top === 'polo' || fit.top === 'button' || fit.top === 'henley') {
    const cr = profileAt(body, 1.838 * H);
    if (fit.top !== 'henley') {
      const cn = neckR * 1.16;
      const collar = loft([
        { y: sy(1.831 * H), rx: cn * 1.32, rz: cn * 1.24, sq: 0.3 },
        { y: sy(1.856 * H), rx: cn * 1.40, rz: cn * 1.34, sq: 0.35 },
        { y: sy(1.874 * H), rx: cn * 1.52, rz: cn * 1.46, sq: 0.4 },
      ], { sections: 6, radial: 24, capTop: false, capBottom: false });
      // Break the collar open at the front.
      displace(collar, (v) => {
        const r = Math.hypot(v.x, v.z) || 1;
        const fwd = Math.max(0, v.z / r);
        v.y -= Math.pow(fwd, 2.6) * 0.055 * H;
        v.z += Math.pow(fwd, 3) * 0.012 * H;
      });
      spine.add(mesh(collar, topMat));
    }
    const pl = [];
    const plHeight = fit.top === 'button' ? 0.44 * H : 0.17 * H;
    const plTop = 1.78 * H;
    for (let i = 0; i <= 8; i++) {
      const y = plTop - (i / 8) * plHeight;
      const r = profileAt(body, y);
      pl.push({ y: sy(y), rx: 0.013 * H, rz: 0.005 * H, z: r.rz + pad + 0.003 * H });
    }
    const placket = loft(pl, { sections: 10, radial: 10, capTop: true, capBottom: true });
    const buttons = [];
    const nBtn = fit.top === 'button' ? 5 : 2;
    for (let i = 0; i < nBtn; i++) {
      const y = plTop - 0.05 * H - (i / Math.max(1, nBtn - 0.2)) * plHeight * 0.85;
      const r = profileAt(body, y);
      const bg = new THREE.CylinderGeometry(0.0075 * H, 0.0075 * H, 0.0035 * H, 10);
      bg.rotateX(Math.PI / 2);
      bg.translate(0, sy(y), r.rz + pad + 0.009 * H);
      buttons.push(bg);
    }
    spine.add(mergeInto([placket], topMat, {}));
    if (buttons.length) spine.add(mergeInto(buttons, simpleMaterial(fit.trim, 0.35, 0.1), {}));
  }

  // --- Arms ------------------------------------------------------------------
  // How far a relaxed arm hangs from the body is not a style choice: hips are
  // broader than the shoulder joints, more so on a wide build, so a plumb arm
  // buries its hand in the trousers. Solve for the angle that puts the hand
  // just outside whatever the character is wearing.
  const handHalf = 0.052 * H;
  const bottomOuter = fit.bottom === 'skirt'
    ? profileAt(body, 1.17 * H).rx + 0.075 * H
    : hipX + 1.20 * thighR + botPad;
  const reach = upperArmLen + foreArmLen + 0.05 * H;
  const armRest = clamp(
    Math.asin(clamp((bottomOuter + handHalf + 0.010 * H - shoulderX) / reach, -1, 1)),
    0.04, 0.24
  );

  const sleeved = fit.sleeve !== 'none';
  const sleeveLong = fit.sleeve === 'long';
  const arms = [], elbows = [];

  for (const s of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(s * shoulderX, sy(shoulderY - 0.012 * H), 0);
    shoulder.rotation.z = s * armRest;
    spine.add(shoulder);
    arms.push(shoulder);

    const upper = upperArmGeometry(upperArmLen, armR, sleeved && sleeveLong);
    shoulder.add(mergeInto([upper], skin, { shadow: true }));

    if (sleeved) {
      const end = sleeveLong ? -upperArmLen - 0.005 * H : -upperArmLen * 0.52;
      const sleeveRings = [
        { y: 0.062 * upperArmLen, rx: armR * 0.10, rz: armR * 0.10 },
        { y: 0.030 * upperArmLen, rx: armR * 1.00, rz: armR * 0.96 },
        { y: -0.020 * upperArmLen, rx: armR * 1.42, rz: armR * 1.34 },
        { y: -0.100 * upperArmLen, rx: armR * 1.50, rz: armR * 1.42 },
        { y: end * 0.55, rx: armR * 1.34, rz: armR * 1.30 },
        { y: end, rx: armR * (sleeveLong ? 1.16 : 1.28), rz: armR * (sleeveLong ? 1.12 : 1.24) },
      ];
      // A long sleeve crosses the elbow, so it needs the same nose past the
      // pivot the arm itself has — the cuff (which is wider) hides it straight,
      // and it fills the gap when the elbow bends.
      if (sleeveLong) {
        sleeveRings.push({ y: end - 0.038 * H, rx: armR * 1.00, rz: armR * 0.98 });
        sleeveRings.push({ y: end - 0.064 * H, rx: armR * 0.60, rz: armR * 0.58 });
      }
      const sleeve = loft(sleeveRings, { sections: sleeveLong ? 22 : 18, radial: 20, capTop: true, capBottom: false });
      shoulder.add(mesh(sleeve, topMat, { shadow: true }));
    }

    const elbow = new THREE.Group();
    elbow.position.y = -upperArmLen;
    shoulder.add(elbow);
    elbows.push(elbow);

    const fore = forearmGeometry(foreArmLen, foreR, sleeveLong);
    const hand = handGeometry(H * 1.02);
    hand.translate(0, -foreArmLen + 0.004 * H, 0.002 * H);
    elbow.add(mergeInto([fore, hand], skin, { shadow: true }));

    if (sleeveLong) {
      const cuff = loft([
        { y: foreR * 0.4, rx: foreR * 1.30, rz: foreR * 1.28 },
        { y: -foreArmLen * 0.5, rx: foreR * 1.20, rz: foreR * 1.18 },
        { y: -foreArmLen * 0.86, rx: foreR * 1.10, rz: foreR * 1.08 },
      ], { sections: 10, radial: 18, capTop: false, capBottom: false });
      elbow.add(mesh(cuff, topMat, { shadow: true }));
    }
  }

  // --- Legs ------------------------------------------------------------------
  const legs = [], knees = [], ankles = [];
  const trouserFull = fit.bottom === 'pants';
  const trouserThigh = fit.bottom !== 'skirt';

  for (const s of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(s * hipX, 0, 0);
    hips.add(hip);
    legs.push(hip);

    hip.add(mergeInto([thighGeometry(thighLen, thighR)], skin, { shadow: true }));

    if (trouserThigh) {
      const end = trouserFull ? -thighLen : -thighLen * 0.62;
      const legRings = [
        { y: 0.055 * H, rx: tubeTopR, rz: tubeTopR * 0.98, sq: 0.22 },
        // Wide enough to clear the quadriceps bulge the ring profile does not
        // describe — otherwise the thigh z-fights its way through the cloth.
        { y: -thighLen * 0.22, rx: thighR * 1.26, rz: thighR * 1.24, sq: 0.18 },
        { y: end * 0.72, rx: thighR * (trouserFull ? 1.12 : 1.24), rz: thighR * (trouserFull ? 1.10 : 1.22) },
        { y: end, rx: thighR * (trouserFull ? 1.08 : 1.28), rz: thighR * (trouserFull ? 1.06 : 1.26) },
      ];
      if (trouserFull) {
        legRings.push({ y: end - 0.045 * H, rx: thighR * 0.96, rz: thighR * 0.94 });
        legRings.push({ y: end - 0.080 * H, rx: thighR * 0.62, rz: thighR * 0.60 });
      }
      const leg = loft(legRings, { sections: trouserFull ? 16 : 12, radial: 22, capTop: false, capBottom: false });
      hip.add(mesh(leg, botMat, { shadow: true }));
    }

    const knee = new THREE.Group();
    knee.position.y = -thighLen;
    hip.add(knee);
    knees.push(knee);
    knee.add(mergeInto([shinGeometry(shinLen, shinR)], skin, { shadow: true }));

    if (trouserFull) {
      const calf = loft([
        { y: 0.075 * H, rx: shinR * 0.55, rz: shinR * 0.55 },
        { y: 0.020 * H, rx: shinR * 1.26, rz: shinR * 1.26 },
        { y: -shinLen * 0.34, rx: shinR * 1.22, rz: shinR * 1.24 },
        { y: -shinLen * 0.78, rx: shinR * 1.05, rz: shinR * 1.06 },
        { y: -shinLen * 0.94, rx: shinR * 1.12, rz: shinR * 1.14 },
      ], { sections: 14, radial: 22, capTop: false, capBottom: false });
      knee.add(mesh(calf, botMat, { shadow: true }));
    }

    const ankle = new THREE.Group();
    ankle.position.y = -shinLen;
    knee.add(ankle);
    ankles.push(ankle);

    const shoe = shoeGeometry(fit.shoe.kind, H * 1.02);
    ankle.add(mesh(shoe.upper, shoeMat, { shadow: true }));
    ankle.add(mesh(shoe.sole, soleMat, { shadow: true }));
  }

  // --- Head ------------------------------------------------------------------
  const neckTop = new THREE.Group();
  neckTop.position.y = sy(shoulderY + 0.030 * H);
  spine.add(neckTop);

  const head = new THREE.Group();
  head.position.y = headY - (shoulderY + 0.030 * H);
  neckTop.add(head);

  // Head breadth 155mm / length 195mm / height 230mm at 1.80m, lightly enlarged
  // the way The Sims does so faces still read at gameplay camera distance.
  const hx = 0.107 * H * (0.97 + 0.03 * W);
  const hy = 0.156 * H;
  const hz = 0.130 * H;

  const headGeom = headGeometry({
    hx, hy, hz,
    gender: hg.gender,
    age: hg.age,
    nose: 0.76 + rnd() * 0.30,
    brow: 0.75 + rnd() * 0.5,
    jaw: 0.7 + rnd() * 0.6,
    chin: 0.75 + rnd() * 0.5,
    cheek: 0.7 + rnd() * 0.6,
    seedA: rnd() * 6.28,
    seedB: rnd() * 6.28,
  });

  const ears = [];
  for (const s of [-1, 1]) {
    const ear = earGeometry(hy * 0.26, hy * 0.145, hy * 0.075);
    ear.rotateY(s * 0.30);
    ear.rotateZ(s * -0.12);
    ear.translate(s * hx * 0.96, -hy * 0.10, -hz * 0.22);
    projectHeadUV(ear, hx, hy, hz);
    ears.push(ear);
  }
  head.add(mergeInto([headGeom, ...ears], faceMat, { shadow: true }));

  // --- Eyes ------------------------------------------------------------------
  const eyeR = 0.104 * hy;                 // 12mm eyeball on a 230mm head
  const eyeX = 0.400 * hx;                 // 63mm interpupillary
  const eyeYy = 0.045 * hy;
  const eyeZ = 0.845 * hz - eyeR * 1.14;
  const lids = [];
  const lidMat = lidMaterial(hg.skin);
  const lashMat = simpleMaterial(0x15100d, 0.5);
  const eyeBalls = [], sockets = [];

  for (const s of [-1, 1]) {
    const ball = new THREE.SphereGeometry(eyeR, 22, 18);
    ball.rotateY(s * 0.055);                // slight convergence, like real gaze
    ball.translate(s * eyeX, eyeYy, eyeZ);
    eyeBalls.push(ball);

    const socket = eyeSocketGeometry(eyeR * 1.14, 1.06, 0.44, 0.10, s);
    socket.translate(s * eyeX, eyeYy, eyeZ);
    projectHeadUV(socket, hx, hy, hz);
    sockets.push(socket);

    // Upper lid: parked just above the aperture, swinging shut on a blink.
    const upper = new THREE.Group();
    upper.position.set(s * eyeX, eyeYy, eyeZ);
    upper.rotation.x = LID_OPEN;
    const lidGeom = new THREE.SphereGeometry(eyeR * 1.19, 22, 12, 0, Math.PI * 2, 0, Math.PI * 0.44);
    const lidUv = lidGeom.attributes.uv;
    for (let i = 0; i < lidUv.count; i++) lidUv.setXY(i, 0.80, 0.44);
    lidUv.needsUpdate = true;
    upper.add(mesh(lidGeom, faceMat));
    const lash = new THREE.SphereGeometry(eyeR * 1.23, 22, 3, 0, Math.PI * 2, Math.PI * 0.415, Math.PI * 0.055);
    upper.add(mesh(lash, lashMat));
    head.add(upper);
    lids.push(upper);
  }
  head.add(mergeInto(eyeBalls, eyeMaterial(fit.eye)));
  head.add(mergeInto(sockets, faceMat));

  // --- Brows -----------------------------------------------------------------
  const browL = buildBrow(-1, { hx, hy, hz }, hg.hair, faceSpec);
  const browR = buildBrow(1, { hx, hy, hz }, hg.hair, faceSpec);
  head.add(mergeInto([browL.geometry, browR.geometry], browL.material));

  // --- Mouth interior (opens when speaking) ----------------------------------
  const mouthGeom = new THREE.SphereGeometry(1, 14, 10);
  mouthGeom.scale(0.155 * hy, 0.085 * hy, 0.050 * hy);
  const mouth = mesh(mouthGeom, simpleMaterial(0x33121a, 0.6));
  mouth.position.set(0, -0.505 * hy, 0.800 * hz);
  mouth.scale.y = 0.02;
  mouth.visible = false;
  head.add(mouth);

  // --- Hair ------------------------------------------------------------------
  const hair = buildHair(hg, {
    hx, hy, hz,
    neckY: -hy * 0.95,
    shoulderY: (shoulderY - headY) + 0.03 * H,
  }, seed);
  head.add(hair.group);

  // --- Contact shadow --------------------------------------------------------
  const blobGeom = new THREE.PlaneGeometry(0.86 * W * H, 0.66 * W * H);
  blobGeom.rotateX(-Math.PI / 2);
  const blob = new THREE.Mesh(blobGeom, new THREE.MeshBasicMaterial({
    map: contactShadowTexture(),
    color: 0x000000,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  }));
  blob.position.y = 0.014;
  blob.renderOrder = -1;
  g.add(blob);

  // --- Tag + status ----------------------------------------------------------
  const tag = makeTag(hg.name);
  tag.userData = { name: hg.name };
  tag.position.y = headY + 0.46;
  g.add(tag);

  const status = makeStatusSprite();
  status.position.y = headY + 0.78;
  status.visible = false;
  g.add(status);

  g.userData = {
    id: hg.id,
    hips, spine, neckTop, head, torsoMesh,
    arms, elbows, legs, knees, ankles,
    lids, mouth, blob,
    hairSwing: hair.swing,
    tag, status,
    headY,
    baseY: 0,
    height: H,
    armRest,
    gait: rnd() * Math.PI * 2,
    blend: 0,
    breath: rnd() * Math.PI * 2,
    idlePhase: rnd() * Math.PI * 2,
    blinkAt: 1 + rnd() * 4,
    blinkT: -1,
    // Countdown, not a timestamp: animateCharacter runs on the world clock,
    // which does not share an origin with performance.now().
    speakFor: 0,
    speakEnv: 0,
    setSpeaking: (seconds) => { g.userData.speakFor = Math.max(g.userData.speakFor, seconds || 1.6); },
    // Retained for compatibility with anything that poked at the old rig.
    speaking: 0,
  };
  return g;
}

// ---------------------------------------------------------------------------
// Name tag / status sprites (unchanged contract)
// ---------------------------------------------------------------------------

// Online: a houseguest's name can change after their mesh was already built
// (mid-season Take Over + rename). The tag sprite bakes its text into a
// canvas texture once, so redraw it with a fresh sprite instead of trying to
// mutate the old canvas in place.
export function updateTagName(char, newName) {
  const old = char.userData.tag;
  if (!old || old.userData?.name === newName) return;
  const fresh = makeTag(newName);
  fresh.userData = { name: newName };
  fresh.position.copy(old.position);
  fresh.visible = old.visible;
  fresh.renderOrder = old.renderOrder;
  char.remove(old);
  old.material.map?.dispose();
  old.material.dispose();
  char.add(fresh);
  char.userData.tag = fresh;
}

function makeTag(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 72;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(16,30,30,0.90)';
  roundRect(ctx, 4, 4, 248, 64, 10);
  ctx.fill();
  ctx.strokeStyle = 'rgba(220,198,146,0.45)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = '500 32px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f3f0e7';
  ctx.fillText(name, 128, 37, 228);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(1.4, 0.394, 1);
  sprite.renderOrder = 10;
  return sprite;
}

const STATUS_EMOJI = { hoh: '👑', veto: '🛡️', nominee: '🎯', talk: '💬', approach: '❗' };

function makeStatusSprite() {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(0.75, 0.75, 1);
  sprite.renderOrder = 11;
  sprite.userData.setEmoji = (kind) => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 96, 96);
    if (kind) {
      ctx.font = '72px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(STATUS_EMOJI[kind] || kind, 48, 54);
    }
    tex.needsUpdate = true;
    sprite.visible = !!kind;
  };
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

// Gait timing constants, in radians of the stride cycle.
const KNEE_PHASE = 2.15;   // peak flexion lands just after toe-off
const ANKLE_PHASE = 2.60;

export function animateCharacter(char, moving, dt, t) {
  const u = char.userData;
  if (!u.hips) return;

  const step = Math.min(dt, 0.05);
  u.blend += ((moving ? 1 : 0) - u.blend) * Math.min(1, step * 9);
  const k = u.blend;
  const idle = 1 - k;
  if (moving || k > 0.01) u.gait += step * lerp(4.0, 8.4, k);
  u.breath += step * lerp(1.05, 2.5, k);

  const p = u.gait;
  const s = Math.sin(p), c = Math.cos(p);
  const br = Math.sin(u.breath);
  const wob = Math.sin(t * 0.45 + u.idlePhase);        // slow weight shift
  const H = u.height || 1;

  const [hipL, hipR] = u.legs;
  const [kneeL, kneeR] = u.knees;
  const [ankL, ankR] = u.ankles;
  const [armL, armR] = u.arms;
  const [elbL, elbR] = u.elbows;

  // --- Legs
  const swing = 0.62;
  hipL.rotation.x = lerp(0.02 + Math.max(0, wob) * 0.05, -s * swing, k);
  hipR.rotation.x = lerp(0.02 + Math.max(0, -wob) * 0.05, s * swing, k);
  hipL.rotation.z = lerp(0, -0.03, k);
  hipR.rotation.z = lerp(0, 0.03, k);

  const flex = (ph) => 0.10 + Math.pow(Math.max(0, Math.sin(ph)), 1.5) * 1.05;
  kneeL.rotation.x = lerp(0.05 + Math.max(0, wob) * 0.16, flex(p + KNEE_PHASE), k);
  kneeR.rotation.x = lerp(0.05 + Math.max(0, -wob) * 0.16, flex(p + KNEE_PHASE + Math.PI), k);

  ankL.rotation.x = lerp(-0.04, -0.20 * Math.sin(p + ANKLE_PHASE) + 0.06, k);
  ankR.rotation.x = lerp(-0.04, -0.20 * Math.sin(p + ANKLE_PHASE + Math.PI) + 0.06, k);

  // --- Arms: opposite the legs, never fully straight
  const armSwing = 0.38;
  armL.rotation.x = lerp(-0.01 + Math.sin(t * 0.6 + u.idlePhase) * 0.025, s * armSwing, k);
  armR.rotation.x = lerp(-0.01 + Math.sin(t * 0.6 + u.idlePhase + 1.7) * 0.025, -s * armSwing, k);
  const rest = u.armRest;
  armL.rotation.z = -lerp(rest, rest * 0.8, k) - br * 0.006;
  armR.rotation.z = lerp(rest, rest * 0.8, k) + br * 0.006;
  elbL.rotation.x = -lerp(0.13, 0.20 + Math.max(0, -s) * 0.40, k);
  elbR.rotation.x = -lerp(0.13, 0.20 + Math.max(0, s) * 0.40, k);

  // --- Pelvis / spine counter-rotation and the vertical bob
  u.hips.rotation.y = lerp(0, -s * 0.10, k);
  u.hips.rotation.z = lerp(wob * 0.030, -s * 0.055, k);
  u.hips.position.x = lerp(wob * 0.012 * H, s * 0.016 * H, k);
  u.spine.rotation.y = lerp(Math.sin(t * 0.27 + u.idlePhase) * 0.025, s * 0.075, k);
  u.spine.rotation.x = lerp(0.012, 0.050, k);
  u.spine.rotation.z = lerp(wob * 0.018, -s * 0.020, k);
  u.spine.position.x = u.hips.position.x;

  char.position.y = u.baseY + lerp(
    Math.sin(t * 1.3 + u.idlePhase) * 0.006 * H,
    (-Math.cos(p * 2) * 0.5 + 0.5) * 0.030 * H,
    k
  );

  // --- Breathing: the chest expands, the shoulders ride up a hair
  if (u.torsoMesh) u.torsoMesh.scale.set(1 + br * 0.010, 1 + br * 0.004, 1 + br * 0.018);
  armL.position.y = armR.position.y = (armL.userData.baseY ??= armL.position.y) + br * 0.004 * H;

  // --- Head: counter the spine twist, then drift and settle
  const look = Math.sin(t * 0.31 + u.idlePhase) * 0.18 + Math.sin(t * 0.13 + u.idlePhase * 2) * 0.09;
  u.neckTop.rotation.y = lerp(look, -s * 0.06, k);
  u.neckTop.rotation.x = lerp(Math.sin(t * 0.23 + u.idlePhase) * 0.05, -0.035, k);
  u.neckTop.rotation.z = lerp(Math.sin(t * 0.17 + u.idlePhase) * 0.035, s * 0.03, k);

  // --- Blink
  if (u.blinkT < 0 && t > u.blinkAt) u.blinkT = 0;
  let closed = 0;
  if (u.blinkT >= 0) {
    u.blinkT += step;
    const d = 0.14;
    closed = u.blinkT < d * 0.4
      ? u.blinkT / (d * 0.4)
      : 1 - (u.blinkT - d * 0.4) / (d * 0.6);
    closed = clamp(closed, 0, 1);
    if (u.blinkT > d) {
      u.blinkT = -1;
      u.blinkAt = t + 1.8 + Math.random() * 4.5;
      closed = 0;
    }
  }
  for (const lid of u.lids) lid.rotation.x = lerp(LID_OPEN, LID_SHUT, smooth01(closed));

  // --- Speech
  u.speakFor = Math.max(0, u.speakFor - step);
  u.speakEnv += ((u.speakFor > 0 ? 1 : 0) - u.speakEnv) * Math.min(1, step * 12);
  if (u.mouth) {
    const open = u.speakEnv * (0.45 + Math.abs(Math.sin(t * 13.7)) * 0.55);
    u.mouth.visible = open > 0.02;
    u.mouth.scale.y = lerp(0.02, 1.2, open);
    u.mouth.scale.x = lerp(1, 0.90, open);
  }

  // --- Hair lag
  if (u.hairSwing) {
    const target = lerp(
      Math.sin(t * 0.6 + u.idlePhase) * 0.02,
      -0.10 + Math.sin(p) * 0.10,
      k
    );
    u.hairSwing.rotation.x += (target - u.hairSwing.rotation.x) * Math.min(1, step * 7);
    u.hairSwing.rotation.z += ((lerp(0, Math.sin(p * 0.5) * 0.07, k)) - u.hairSwing.rotation.z) * Math.min(1, step * 6);
  }

  // --- Keep the contact shadow pinned to the floor while the body bobs
  if (u.blob) {
    u.blob.position.y = 0.014 - char.position.y;
    u.blob.visible = char.position.y > -0.2;
  }
}
