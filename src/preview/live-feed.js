/* ============================================================
   LIVE FEED — proposed visual direction, applied at runtime.
   Loaded only by /preview.html. It reads the live scene through
   window.__bb and mutates colours, lights and floor maps in
   place; it never imports into, or is imported by, the shipping
   game. Delete src/preview/ and preview.html and nothing changes.
   ============================================================ */

import * as THREE from 'three';
import { ROOMS, roomAt } from '../world/scene.js';
import { PLAYER_ID } from '../game/cast.js';

/* ---------- the package ---------- */

const SKY = { top: 0x05090A, mid: 0x0B1413, bot: 0x18231F };
const FOG = 0x0A100F;

// Rooms stop being flat pastel zones. Four desaturated tones plus brass for
// HoH and a dim red for the diary room; they read apart by their lighting.
const FLOOR = {
  living:   { base: '#4A4036', mode: 'plank', repeat: 4 },
  kitchen:  { base: '#394443', mode: 'tile',  repeat: 5 },
  bedroom:  { base: '#3C3A42', mode: 'plank', repeat: 4 },
  hoh:      { base: '#5E4E2E', mode: 'plank', repeat: 3 },
  diary:    { base: '#4A2520', mode: 'tile',  repeat: 3 },
  backyard: { base: '#2B382A', mode: 'grass', repeat: 8 },
};

// Warm practicals are the only warm light in the house.
const PRACTICAL = { living: 0xE8C184, kitchen: 0xCFE3DA, bedroom: 0xC9A86A, hoh: 0xF0CF93 };

// Eight hues pulled to one saturation and value so the cast can share a frame.
const HUE = {
  marcus: '#4E7CA1', rae: '#B4503F', zoe: '#C56C84', flynn: '#D79A3C',
  gus: '#6E8F52', tessa: '#7D6596', nash: '#4E9A93', bev: '#A85C8C',
  [PLAYER_ID]: '#ECE7DA',
};

// Which camera covers which room, so the feed tag means something.
const CAM = { living: '01', kitchen: '02', bedroom: '03', hoh: '04', diary: '05', backyard: '06' };

// Nameplate footprint, used to stack labels that would otherwise pile up.
const PLATE_W = 96;
const PLATE_H = 24;

// The set dressing uses the same stock web colours as the cast. Once the
// floors go quiet these are the loudest things on screen, so the gallery wall,
// the stools and the fruit bowl come along to the new palette.
const REMAP = new Map([
  [0x3b82f6, 0x4E7CA1], [0xdc2626, 0xB4503F], [0xec4899, 0xC56C84], [0xf59e0b, 0xD79A3C],
  [0x16a34a, 0x6E8F52], [0x8b5cf6, 0x7D6596], [0x0ea5e9, 0x4E9A93], [0xd946ef, 0xA85C8C],
  [0xfafafa, 0xECE7DA],
]);

// The phase machine already describes a week; turn it into a day number.
const PHASE_DAY = {
  week_intro: 1, hoh_comp: 1, social_hoh: 2, nominations: 2, social_veto: 3,
  veto_comp: 4, veto_lobby: 4, veto_ceremony: 5, renom_watch: 5, campaigning: 6, eviction: 7,
};

/* ---------- floors, repainted ---------- */

function floorTexture({ base, mode, repeat }) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = base;
  x.fillRect(0, 0, 256, 256);

  // grain, so a flat fill never reads as plastic
  for (let i = 0; i < 2400; i++) {
    x.fillStyle = `rgba(0,0,0,${Math.random() * 0.07})`;
    x.fillRect(Math.random() * 256, Math.random() * 256, 2, 1);
  }

  if (mode === 'plank') {
    x.strokeStyle = 'rgba(0,0,0,0.26)';
    x.lineWidth = 1;
    for (let y = 0; y < 256; y += 32) {
      x.beginPath(); x.moveTo(0, y + 0.5); x.lineTo(256, y + 0.5); x.stroke();
    }
    x.strokeStyle = 'rgba(255,255,255,0.045)';
    for (let y = 0; y < 256; y += 32) {
      x.beginPath(); x.moveTo(0, y + 1.5); x.lineTo(256, y + 1.5); x.stroke();
    }
  }
  if (mode === 'tile') {
    x.strokeStyle = 'rgba(255,255,255,0.055)';
    x.lineWidth = 1;
    for (let i = 0; i <= 256; i += 64) {
      x.beginPath(); x.moveTo(i + 0.5, 0); x.lineTo(i + 0.5, 256);
      x.moveTo(0, i + 0.5); x.lineTo(256, i + 0.5); x.stroke();
    }
  }
  if (mode === 'grass') {
    for (let i = 0; i < 4200; i++) {
      x.fillStyle = `rgba(${Math.random() > 0.5 ? '190,205,160' : '70,95,70'},${Math.random() * 0.14})`;
      x.fillRect(Math.random() * 256, Math.random() * 256, 1, 2);
    }
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  return t;
}

/* ---------- relight ---------- */

function relight(scene) {
  if (scene.fog) scene.fog.color.setHex(FOG);
  scene.background = null;

  // Rim: a cool back light from behind the default camera's view, opposite
  // the key. It puts a thin bright edge on shoulders and heads so people stop
  // dissolving into the floor at play distance. No shadows — one shadow
  // caster is enough, and a second doubles every contact shadow.
  if (!scene.getObjectByName('lf-rim')) {
    const rim = new THREE.DirectionalLight(0xC8DCE0, 1.15);
    rim.name = 'lf-rim';
    rim.position.set(-14, 18, -22);
    rim.castShadow = false;
    scene.add(rim);
  }

  const floorTargets = Object.entries(ROOMS).map(([name, r]) => ({ name, r }));

  scene.traverse((o) => {
    // sky dome
    if (o.isMesh && o.material?.isShaderMaterial && o.material.uniforms?.top) {
      o.material.uniforms.top.value.setHex(SKY.top);
      o.material.uniforms.mid.value.setHex(SKY.mid);
      o.material.uniforms.bot.value.setHex(SKY.bot);
    }

    // stars: a studio sky is not a planetarium
    if (o.isPoints && o.material) {
      o.material.color?.setHex(0xBFCBC2);
      o.material.opacity = 0.3;
      o.material.size = 0.5;
    }

    // ambient bounce: cool from above, warm off the floor
    if (o.isHemisphereLight) {
      o.color.setHex(0xB9CBC6);
      o.groundColor.setHex(0x3B3426);
      o.intensity = 1.25;
    }

    if (o.isDirectionalLight && o.name !== 'lf-rim') {
      if (o.intensity > 1.2) {           // the key
        o.color.setHex(0xFFF2DC);
        o.intensity = 2.3;
      } else {                            // the fill: keeps the yard off black
        o.color.setHex(0x86A5A1);
        o.intensity = 0.9;
      }
    }

    // room practicals
    if (o.isPointLight && Math.abs(o.position.y - 2.6) < 0.05) {
      let best = null, bd = Infinity;
      for (const { name, r } of floorTargets) {
        const d = (o.position.x - r.x) ** 2 + (o.position.z - r.z) ** 2;
        if (d < bd) { bd = d; best = name; }
      }
      if (best && PRACTICAL[best]) {
        o.color.setHex(PRACTICAL[best]);
        o.intensity = best === 'kitchen' ? 3.4 : 5.2;
        o.distance = 15;
      }
    }

    // room floors
    if (o.isMesh && o.material?.isMeshStandardMaterial && Math.abs(o.position.y - 0.02) < 0.01) {
      const hit = floorTargets.find(({ r }) =>
        Math.abs(o.position.x - r.x) < 0.02 && Math.abs(o.position.z - r.z) < 0.02);
      if (hit && FLOOR[hit.name]) {
        o.material.map?.dispose?.();
        o.material.map = floorTexture(FLOOR[hit.name]);
        o.material.color.setHex(0xffffff);
        o.material.roughness = hit.name === 'kitchen' ? 0.45 : 0.92;
        o.material.needsUpdate = true;
      }
    }

    // ground plate + circulation floor, pulled into the palette
    if (o.isMesh && o.material?.isMeshStandardMaterial && !o.material.map) {
      if (Math.abs(o.position.y + 0.5) < 0.01) o.material.color.setHex(0x0D1413);
      if (Math.abs(o.position.y - 0.015) < 0.005) o.material.color.setHex(0x6E7266);
    }

    // set dressing still wearing the stock cast hues
    if (o.isMesh && o.material?.color) {
      const to = REMAP.get(o.material.color.getHex());
      if (to !== undefined) {
        o.material.color.setHex(to);
        if (o.material.emissive && o.material.emissive.getHex() !== 0) o.material.emissive.setHex(to);
      }
    }
  });
}

/* ---------- injected chrome ---------- */

function buildChrome() {
  const root = document.createElement('div');
  root.id = 'lf-chrome';

  const vig = document.createElement('div');
  vig.style.cssText =
    'position:absolute;inset:0;pointer-events:none;' +
    'background:radial-gradient(ellipse 86% 86% at 50% 46%, transparent 46%, rgba(4,8,8,.42) 100%)';
  root.appendChild(vig);

  const tc = document.createElement('div');
  tc.id = 'lf-tc';
  tc.innerHTML =
    '<div class="live"><i></i>LIVE</div>' +
    '<div class="clock">DAY 01 · 00:00</div>' +
    '<div class="cam">CAM 01 — LIVING ROOM</div>';
  root.appendChild(tc);

  const plates = document.createElement('div');
  plates.id = 'lf-plates';
  plates.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  root.appendChild(plates);

  document.body.appendChild(root);

  const badge = document.createElement('div');
  badge.id = 'lf-badge';
  badge.textContent = 'Live Feed — proposed visual direction · the shipping build is at /';
  document.body.appendChild(badge);

  return {
    root,
    clock: tc.querySelector('.clock'),
    cam: tc.querySelector('.cam'),
    plates,
  };
}

/* ---------- nameplates ---------- */

const plateFor = (() => {
  const made = new Map();
  return (plates, id) => {
    let p = made.get(id);
    if (!p) {
      p = document.createElement('div');
      p.className = 'lf-plate';
      p.dataset.id = id;
      p.innerHTML = '<div class="lf-bar"><span class="lf-hue"></span><span class="lf-nm"></span></div><div class="lf-stem"></div>';
      plates.appendChild(p);
      made.set(id, {
        el: p,
        hue: p.querySelector('.lf-hue'),
        nm: p.querySelector('.lf-nm'),
        bar: p.querySelector('.lf-bar'),
        stem: p.querySelector('.lf-stem'),
        tag: null,
        tagKind: '',
      });
      p = made.get(id);
    }
    return p;
  };
})();

function setTag(p, kind, text) {
  if (p.tagKind === kind) return;
  p.tagKind = kind;
  if (p.tag) { p.tag.remove(); p.tag = null; }
  if (!kind) return;
  const t = document.createElement('span');
  t.className = `lf-tag ${kind}`;
  t.textContent = text;
  p.bar.appendChild(t);
  p.tag = t;
}

/* ---------- boot ---------- */

const v = new THREE.Vector3();

function start() {
  const bb = window.__bb;
  const world = bb?.world;
  const scene = world?.scene;
  const camera = world?.camera;
  const canvas = document.getElementById('scene');
  if (!scene || !camera || !canvas) return false;

  relight(scene);
  const ui = buildChrome();

  // The scene is rebuilt on a new season / online join; repaint it when the
  // houseguests change out from under us.
  let lastPopulation = '';

  function frame() {
    requestAnimationFrame(frame);

    const g = window.__bb?.g;
    const blocked = document.querySelector('.title-screen, .cinematic, .comp-box');
    ui.root.hidden = !!blocked || !g;
    // In a conversation close-up the camera sits a few feet off the face and
    // a nameplate projects straight onto the head. The game hides its own
    // sprites for the same reason; the panel already says who you're talking to.
    ui.plates.style.visibility = world.focusNpcId ? 'hidden' : '';
    document.body.classList.toggle('lf-clear', !!blocked);
    if (ui.root.hidden) return;

    const rect = canvas.getBoundingClientRect();
    const chars = [];
    if (world.player) chars.push([world.player.userData?.id ?? PLAYER_ID, world.player]);
    for (const [id, c] of world.npcs) chars.push([id, c]);

    const population = chars.map(([id]) => id).sort().join(',');
    if (population !== lastPopulation) {
      lastPopulation = population;
      relight(scene);
    }

    // Pass 1 — project every houseguest to screen space.
    const seen = new Set();
    const marks = [];
    for (const [id, char] of chars) {
      seen.add(id);
      const p = plateFor(ui.plates, id);

      // The game draws its own name sprite and HoH/veto/nominee icon over
      // every head. These plates replace both, so switch the sprites off at
      // the material — the world controller rewrites .visible every frame.
      const ud = char.userData;
      if (ud.tag?.material) ud.tag.material.visible = false;
      if (ud.status?.material) ud.status.material.visible = false;

      v.setFromMatrixPosition(char.matrixWorld);
      v.y += 2.0;
      const dist = camera.position.distanceTo(char.position);
      v.project(camera);

      if (v.z > 1) { p.el.style.opacity = '0'; continue; }

      marks.push({
        id, p, dist,
        x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
        y: (-v.y * 0.5 + 0.5) * rect.height + rect.top,
      });
    }

    // Pass 2 — stack plates that would sit on top of each other. Two people
    // talking in a doorway project to nearly the same pixel, and an unresolved
    // pile is worse than no label at all. Nearest to camera keeps its spot.
    marks.sort((a, b) => a.dist - b.dist);
    const placed = [];
    for (const m of marks) {
      let y = m.y;
      let moved = true;
      while (moved) {
        moved = false;
        for (const q of placed) {
          if (Math.abs(q.x - m.x) < PLATE_W && Math.abs(q.y - y) < PLATE_H) {
            y = q.y - PLATE_H;
            moved = true;
          }
        }
      }
      placed.push({ x: m.x, y });

      const { p, id } = m;
      const hg = g.houseguests?.find((h) => h.id === id);
      p.el.style.left = '0';
      p.el.style.top = '0';
      p.el.style.transform = `translate(-50%,-100%) translate(${m.x.toFixed(1)}px,${y.toFixed(1)}px)`;
      // Fade only the genuinely far side of the house. The orbit camera sits
      // ~26 units back and the house is 34 wide, so the useful range runs to
      // roughly 50 — a tighter falloff hides everyone but your own feet.
      p.el.style.opacity = String(Math.max(0, Math.min(1, (58 - m.dist) / 18)));
      // A plate that had to climb grows a longer leader back to its owner.
      p.stem.style.height = `${Math.max(10, m.y - y + 10).toFixed(0)}px`;

      const name = hg?.name ?? (id === PLAYER_ID ? 'You' : id);
      if (p.nm.textContent !== name) p.nm.textContent = name;
      const hue = HUE[id] ?? '#9AA7A1';
      if (p.hue.style.background !== hue) p.hue.style.background = hue;

      if (g.hoh === id) setTag(p, 'hoh', 'HOH');
      else if (g.nominees?.includes(id)) setTag(p, 'nom', 'NOM');
      else if (g.vetoHolder === id) setTag(p, 'vet', 'VETO');
      else if (id === PLAYER_ID) setTag(p, 'you', 'YOU');
      else setTag(p, '', '');
    }

    for (const el of ui.plates.children) {
      if (el.dataset.id && !seen.has(el.dataset.id)) el.style.opacity = '0';
    }

    // The lower third only earns the corner if it is actually showing intel.
    const intel = document.querySelector('.house-intel');
    if (intel && !intel.open) intel.open = true;

    // timecode
    const now = new Date();
    const day = (Math.max(1, g.week || 1) - 1) * 7 + (PHASE_DAY[g.phase] || 1);
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const clock = `DAY ${String(day).padStart(2, '0')} · ${hh}:${mm}`;
    if (ui.clock.textContent !== clock) ui.clock.textContent = clock;

    const pp = world.player?.position;
    const rn = pp ? roomAt(pp.x, pp.z) : null;
    const cam = rn
      ? `CAM ${CAM[rn] || '01'} — ${(ROOMS[rn]?.label || rn).toUpperCase()}`
      : 'CAM 07 — HOUSE WIDE';
    if (ui.cam.textContent !== cam) ui.cam.textContent = cam;
  }

  requestAnimationFrame(frame);
  return true;
}

// main.js builds the scene during its own module evaluation, so __bb is
// usually there already; poll briefly in case module order ever flips.
if (!start()) {
  let tries = 0;
  const t = setInterval(() => {
    if (start() || ++tries > 200) clearInterval(t);
  }, 50);
}
