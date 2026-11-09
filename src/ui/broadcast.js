// Broadcast chrome that has to follow the camera: a nameplate over every
// houseguest, and the live timecode. The static chrome (safe-area frame, phase
// slate, lower third, dock) is plain CSS in style.css; this is the part that
// needs the scene.
//
// Nameplates replace the old 3D name sprites and emoji status icons. Those
// were sized in world units, so at a normal play zoom they grew into pills
// that covered the people they labelled. These stay one size at every zoom,
// fade over the far side of the house, and stack instead of piling up when
// two people stand in a doorway.
//
// update(state) takes plain data, not the game object, because single-player
// (`g`) and online (`onlineGame`) keep their state in different shapes —
// main.js builds the state from whichever one is live.

import * as THREE from 'three';
import { ROOMS, roomAt } from '../world/scene.js';

// Which camera covers which room, so the feed tag means something.
const CAM = { living: '01', kitchen: '02', bedroom: '03', hoh: '04', diary: '05', backyard: '06' };

// Day of the week each step lands on. Single-player phases and online turn
// kinds share one table; their keys don't collide.
const STEP_DAY = {
  week_intro: 1, hoh_comp: 1, social_hoh: 2, nominations: 2, social_veto: 3,
  veto_comp: 4, veto_lobby: 4, veto_ceremony: 5, renom_watch: 5, campaigning: 6, eviction: 7,
  week_ready: 1, intro: 1, comp_result: 1, nominate: 2, noms_result: 2,
  veto_decision: 5, veto_result: 5, replacement: 5, vote: 7, eviction_result: 7,
};

// Plate footprint, for stacking plates that would otherwise overlap.
const PLATE_W = 96;
const PLATE_H = 24;

const hex = (c) => '#' + (c ?? 0x9AA7A1).toString(16).padStart(6, '0');

export function createBroadcast({ world, canvas }) {
  const root = document.createElement('div');
  root.id = 'bc-chrome';
  root.hidden = true;
  root.innerHTML =
    '<div class="bc-vignette"></div>' +
    '<div id="bc-tc">' +
      '<div class="live"><i></i>LIVE</div>' +
      '<div class="clock"></div>' +
      '<div class="cam"></div>' +
    '</div>' +
    '<div id="bc-plates"></div>';
  document.body.appendChild(root);

  const clockEl = root.querySelector('.clock');
  const camEl = root.querySelector('.cam');
  const platesEl = root.querySelector('#bc-plates');
  const made = new Map();
  const v = new THREE.Vector3();

  function plateFor(id) {
    let p = made.get(id);
    if (p) return p;
    const el = document.createElement('div');
    el.className = 'bc-plate';
    el.dataset.id = id;
    el.innerHTML =
      '<div class="bc-bar"><span class="bc-hue"></span><span class="bc-nm"></span></div>' +
      '<div class="bc-stem"></div>';
    platesEl.appendChild(el);
    p = {
      el,
      bar: el.querySelector('.bc-bar'),
      hue: el.querySelector('.bc-hue'),
      nm: el.querySelector('.bc-nm'),
      stem: el.querySelector('.bc-stem'),
      chips: { status: null, approach: null },
    };
    made.set(id, p);
    return p;
  }

  // Two chip slots: standing in the game (HoH / nominee / veto / you), and
  // the transient "coming to talk to you", which used to be the ❗ sprite.
  function setChip(p, slot, kind, text) {
    const cur = p.chips[slot];
    if ((cur?.kind || '') === (kind || '')) return;
    cur?.el.remove();
    p.chips[slot] = null;
    if (!kind) return;
    const el = document.createElement('span');
    el.className = `bc-tag ${kind}`;
    el.textContent = text;
    p.bar.appendChild(el);
    p.chips[slot] = { kind, el };
  }

  function update(state) {
    const blocked = document.querySelector('.title-screen, .cinematic, .comp-box');
    root.hidden = !!blocked || !state;
    document.body.classList.toggle('bc-clear', !!blocked);
    if (root.hidden) return;

    // In a conversation close-up the camera sits a few feet off the face and
    // a plate projects straight onto the head; the panel says who it is.
    platesEl.style.visibility = world.focusNpcId ? 'hidden' : '';

    const camera = world.camera;
    const rect = canvas.getBoundingClientRect();
    const chars = [];
    if (world.player) chars.push([world.player.userData.id, world.player, true]);
    for (const [id, c] of world.npcs) chars.push([id, c, false]);

    // Pass 1: project everyone.
    const seen = new Set();
    const marks = [];
    for (const [id, char, isMe] of chars) {
      seen.add(id);
      const p = plateFor(id);
      v.setFromMatrixPosition(char.matrixWorld);
      v.y += 2.0;
      const dist = camera.position.distanceTo(char.position);
      v.project(camera);
      const x = (v.x * 0.5 + 0.5) * rect.width + rect.left;
      const y = (-v.y * 0.5 + 0.5) * rect.height + rect.top;
      // Behind the camera, or out of frame: no plate. (The edge clamp below
      // is for people near the edge, not a pointer to people off it.)
      if (v.z > 1 || x < 0 || x > window.innerWidth || y < 0 || y > window.innerHeight) {
        p.el.style.opacity = '0';
        continue;
      }
      marks.push({ id, p, dist, isMe, x, y });
    }

    // Pass 2: nearest to camera keeps its spot; anyone who would sit on top
    // of an already-placed plate climbs above it and grows a longer leader.
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
      // Keep the plate on screen when its owner is near the edge (a phone's
      // narrow frame cuts names in half otherwise); the stem still points down.
      const half = p.el.offsetWidth / 2 + 6;
      const x = Math.min(Math.max(m.x, half), window.innerWidth - half);
      p.el.style.transform = `translate(-50%,-100%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
      // The orbit camera sits ~26 units back and the house is 34 wide, so the
      // useful range runs to ~50; fade only the genuinely far side.
      p.el.style.opacity = String(Math.max(0, Math.min(1, (58 - m.dist) / 18)));
      p.stem.style.height = `${Math.max(10, m.y - y + 10).toFixed(0)}px`;

      // Names are read live, so a rename (Take Over, a late claim) shows on
      // the next frame — the sprites needed an explicit repaint for that.
      const hg = state.houseguests.find((h) => h.id === id);
      const name = hg?.name ?? '';
      if (p.nm.textContent !== name) p.nm.textContent = name;
      const hue = hex(hg?.color);
      if (p.hue.dataset.hue !== hue) { p.hue.style.background = hue; p.hue.dataset.hue = hue; }

      if (state.hoh === id) setChip(p, 'status', 'hoh', 'HOH');
      else if (state.nominees.includes(id)) setChip(p, 'status', 'nom', 'NOM');
      else if (state.vetoHolder === id) setChip(p, 'status', 'vet', 'VETO');
      else if (m.isMe) setChip(p, 'status', 'you', 'YOU');
      else setChip(p, 'status', '', '');
      setChip(p, 'approach', state.approachId === id ? 'app' : '', '→ YOU');
    }

    for (const [id, p] of made) if (!seen.has(id)) p.el.style.opacity = '0';

    // Timecode: the phase machine already describes a week; read it as days.
    const now = new Date();
    const day = (Math.max(1, state.week || 1) - 1) * 7 + (STEP_DAY[state.step] || 1);
    const clock = `DAY ${String(day).padStart(2, '0')} · ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (clockEl.textContent !== clock) clockEl.textContent = clock;

    const pp = world.player?.position;
    const rn = pp ? roomAt(pp.x, pp.z) : null;
    const cam = rn
      ? `CAM ${CAM[rn] || '01'} — ${(ROOMS[rn]?.label || rn).toUpperCase()}`
      : 'CAM 07 — HOUSE WIDE';
    if (camEl.textContent !== cam) camEl.textContent = cam;
  }

  return { update };
}
