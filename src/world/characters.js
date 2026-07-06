// Stylized Sims-ish characters, v2 — proper humanoid proportions:
// pants + shirt, pivoted limbs with hands/shoes, neck, face (eyes, brows,
// nose, mouth), per-character hairstyles, name tag + status sprite.

import * as THREE from 'three';

function std(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.03, ...opts });
}

// Limb pivoted at the top so rotation.x swings like a shoulder/hip joint.
function limb(radius, length, material) {
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 4, 10), material);
  mesh.position.y = -length / 2 - radius * 0.5;
  mesh.castShadow = true;
  g.add(mesh);
  return g;
}

export function createCharacter(hg) {
  const g = new THREE.Group();
  const b = hg.build || { height: 1, width: 1 };
  const H = b.height, W = b.width;
  const shirtMat = std(hg.color);
  const pantsColor = hg.id === 'you' ? 0x33415c : darken(hg.color, 0.35);
  const pantsMat = std(pantsColor);
  const skinMat = std(hg.skin, { roughness: 0.55 });
  const hairMat = std(hg.hair, { roughness: 0.9 });

  // --- Legs (pivot at hip, y = 0.95H)
  const hipY = 0.92 * H;
  const legLen = hipY - 0.22;
  const legs = [];
  for (const s of [-1, 1]) {
    const l = limb(0.115, legLen * 0.72, pantsMat);
    l.position.set(s * 0.16 * W, hipY, 0);
    g.add(l);
    legs.push(l);
    // shoe
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, 0.34), std(0x2a2a30, { roughness: 0.4 }));
    shoe.position.set(0, -legLen + 0.02, 0.06);
    shoe.castShadow = true;
    l.add(shoe);
  }

  // --- Torso: hips + tapered shirt
  const hips = new THREE.Mesh(new THREE.CylinderGeometry(0.27 * W, 0.24 * W, 0.25, 12), pantsMat);
  hips.position.y = hipY + 0.08;
  hips.castShadow = true;
  g.add(hips);

  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.21 * W, 0.28 * W, 0.62 * H, 14), shirtMat);
  torso.position.y = hipY + 0.5 * H * 0.62 + 0.14;
  torso.castShadow = true;
  g.add(torso);
  const shoulderY = hipY + 0.62 * H + 0.11;
  // rounded shoulders
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.215 * W, 14, 10), shirtMat);
  chest.position.y = shoulderY - 0.04;
  chest.scale.set(1.25, 0.55, 0.85);
  chest.castShadow = true;
  g.add(chest);

  // --- Arms (pivot at shoulder) with skin hands
  const arms = [];
  const armLen = 0.52 * H;
  for (const s of [-1, 1]) {
    const a = limb(0.075, armLen * 0.72, shirtMat);
    a.position.set(s * (0.3 * W), shoulderY - 0.02, 0);
    a.rotation.z = s * 0.09; // slight natural splay
    g.add(a);
    arms.push(a);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), skinMat);
    hand.position.set(0, -armLen + 0.02, 0);
    hand.castShadow = true;
    a.add(hand);
  }

  // --- Neck + head
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.14, 10), skinMat);
  neck.position.y = shoulderY + 0.08;
  g.add(neck);

  const headY = shoulderY + 0.38;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 22, 18), skinMat);
  head.position.y = headY;
  head.scale.set(0.92, 1.05, 0.95);
  head.castShadow = true;
  g.add(head);

  // ears
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), skinMat);
    ear.position.set(s * 0.245, headY, 0);
    g.add(ear);
  }

  // --- Face
  const faceZ = 0.235;
  for (const s of [-1, 1]) {
    const white = new THREE.Mesh(new THREE.SphereGeometry(0.052, 10, 10), std(0xffffff, { roughness: 0.2 }));
    white.position.set(s * 0.095, headY + 0.03, faceZ);
    white.scale.set(1, 1.15, 0.5);
    g.add(white);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 8), new THREE.MeshBasicMaterial({ color: 0x22203a }));
    pupil.position.set(s * 0.095, headY + 0.03, faceZ + 0.028);
    g.add(pupil);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.022, 0.02), hairMat);
    brow.position.set(s * 0.095, headY + 0.115, faceZ + 0.01);
    brow.rotation.z = s * -0.12;
    g.add(brow);
  }
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), std(darken(hg.skin, 0.08), { roughness: 0.55 }));
  nose.position.set(0, headY - 0.03, faceZ + 0.035);
  nose.scale.set(0.8, 1, 0.9);
  g.add(nose);
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 8, 12, Math.PI * 0.9), std(0x8c4a4a, { roughness: 0.4 }));
  mouth.position.set(0, headY - 0.1, faceZ + 0.012);
  mouth.rotation.set(Math.PI, 0, Math.PI * 0.05);
  g.add(mouth);

  addHair(g, hg, headY, hairMat, skinMat);

  // Name tag sprite
  const tag = makeTag(hg.name);
  tag.userData = { name: hg.name };
  tag.position.y = headY + 0.75;
  g.add(tag);

  // Status sprite
  const status = makeStatusSprite();
  status.position.y = headY + 1.15;
  status.visible = false;
  g.add(status);

  g.userData = {
    id: hg.id,
    arms,
    legs,
    tag,
    status,
    headY,
    baseY: 0,
    walkPhase: Math.random() * Math.PI * 2,
    speaking: 0,
  };
  return g;
}

function darken(hex, amt) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(1 - amt);
  return c;
}

// Per-character hairstyles — mapped by hairStyle field (fallback by gender)
function addHair(g, hg, headY, hairMat, skinMat) {
  const style = hg.hairStyle || (hg.gender === 'f' ? 'long' : 'short');
  const add = (mesh) => {
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };

  if (style === 'balding') {
    // horseshoe: sides + back only
    const ring = add(new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.075, 10, 20, Math.PI * 1.25), hairMat));
    ring.position.set(0, headY + 0.02, -0.02);
    ring.rotation.set(Math.PI / 2, 0, Math.PI * 0.875);
    return;
  }
  if (style === 'afro' || style === 'curly') {
    const puff = add(new THREE.Mesh(new THREE.SphereGeometry(0.31, 12, 10), hairMat));
    puff.position.set(0, headY + 0.12, -0.03);
    puff.scale.set(1.05, 0.95, 1.0);
    for (const [x, y, z] of [[-0.2, 0.05, 0.1], [0.2, 0.05, 0.1], [0, 0.02, -0.2]]) {
      const c = add(new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), hairMat));
      c.position.set(x, headY + 0.12 + y, z);
    }
    return;
  }

  // base cap for remaining styles
  const cap = add(new THREE.Mesh(new THREE.SphereGeometry(0.285, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.52), hairMat));
  cap.position.set(0, headY + 0.035, -0.015);

  if (style === 'short') {
    cap.scale.set(1, 0.9, 1);
  } else if (style === 'messy') {
    cap.scale.set(1.04, 1.05, 1.04);
    for (const [x, z, r] of [[-0.15, 0.12, 0.09], [0.14, 0.05, 0.1], [0.02, -0.16, 0.11], [-0.05, 0.2, 0.07]]) {
      const tuft = add(new THREE.Mesh(new THREE.SphereGeometry(r, 7, 6), hairMat));
      tuft.position.set(x, headY + 0.26, z);
    }
  } else if (style === 'quiff') {
    const swoop = add(new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), hairMat));
    swoop.position.set(0, headY + 0.3, 0.13);
    swoop.scale.set(1.4, 0.75, 1.0);
    swoop.rotation.x = -0.35;
  } else if (style === 'ponytail') {
    const tail = add(new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.42, 4, 8), hairMat));
    tail.position.set(0, headY - 0.08, -0.3);
    tail.rotation.x = 0.5;
    const tie = add(new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), hairMat));
    tie.position.set(0, headY + 0.12, -0.24);
  } else if (style === 'long') {
    // hair falls to shoulders on sides + back
    const back = add(new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.55, 14, 1, true, Math.PI * 0.6, Math.PI * 1.8), hairMat));
    back.material = hairMat.clone();
    back.material.side = THREE.DoubleSide;
    back.position.set(0, headY - 0.18, -0.03);
    back.rotation.y = Math.PI;
  } else if (style === 'bob') {
    const bob = add(new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.31, 0.34, 14, 1, true, Math.PI * 0.55, Math.PI * 1.9), hairMat));
    bob.material = hairMat.clone();
    bob.material.side = THREE.DoubleSide;
    bob.position.set(0, headY - 0.06, -0.02);
    bob.rotation.y = Math.PI;
  }
}

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
  ctx.fillStyle = 'rgba(10,12,24,0.72)';
  roundRect(ctx, 4, 4, 248, 64, 18);
  ctx.fill();
  ctx.font = 'bold 38px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(name, 128, 38);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(1.55, 0.44, 1);
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

// Per-frame animation. Limbs are pivoted at shoulder/hip so rotation swings naturally.
export function animateCharacter(char, moving, dt, t) {
  const u = char.userData;
  u.walkPhase += dt * (moving ? 9 : 2.2);
  const [la, ra] = u.arms;
  const [ll, rl] = u.legs;
  if (moving) {
    const s = Math.sin(u.walkPhase);
    la.rotation.x = s * 0.75;
    ra.rotation.x = -s * 0.75;
    ll.rotation.x = -s * 0.65;
    rl.rotation.x = s * 0.65;
    char.position.y = u.baseY + Math.abs(Math.sin(u.walkPhase)) * 0.05;
  } else {
    la.rotation.x *= 0.85;
    ra.rotation.x *= 0.85;
    ll.rotation.x *= 0.85;
    rl.rotation.x *= 0.85;
    char.position.y = u.baseY + Math.sin(t * 1.6 + u.walkPhase) * 0.02;
  }
}
