// Player controls, NPC wandering, camera, proximity and obstacle-aware walking.

import * as THREE from 'three';
import { ROOMS, roomCenter, roomAt, hitsWall, inPool } from './scene.js';
import { animateCharacter } from './characters.js';
import { BOUNDS, findPath, turnToward, recoverPosition } from './navigation.js';

const WALK_SPEED = 4.2;
const NPC_SPEED = 1.8;

// Eavesdropping ranges, shared with the director (main.js). Inside LISTEN_R
// you can hear a huddle; inside SPOT_R they can see you doing it.
export const LISTEN_R = 4.6;
export const SPOT_R = 2.3;

// Where the house gathers for a ceremony: an arc north of the coffee table,
// facing the sofa (and the default camera).
const STAGE = { x: -6, z: 3.0, r: 3.5 };

function flatRing(inner, outer, color, opacity) {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 72),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.26;
  m.renderOrder = 2;
  m.visible = false;
  return m;
}

// ---- Where people hang out ---------------------------------------------------
// Houseguests used to pick a random point anywhere in the house, walk to it,
// wait 3-10 seconds and set off again: eight people in constant motion, which
// no room full of people looks like, and which made a private word impossible
// because someone was always walking past.
//
// Now a houseguest SETTLES: at a spot people would actually stand (by the
// sofa, at the island, on the patio), for a minute or three. When that runs
// out they usually just shift a few steps or drift over to someone in the same
// room, and only sometimes cross the house. While settled they turn to face
// whoever is nearby.
const HANGOUTS = {
  living: [[-8.8, 3.6], [-3.2, 3.6], [-9.6, 1], [-2.4, 1], [-6, 0.2], [-10, -1.2], [-2, -1.6], [-8, -0.6], [-4, -0.6]],
  kitchen: [[5.9, 3.95], [7, 3.95], [8.1, 3.95], [3.6, 1], [9.9, 4.4], [12.6, 1.6], [13.2, -2.4], [7.8, -1.6], [3, 5], [15.2, 3], [5, -0.6]],
  bedroom: [[-9, -6.4], [-6.3, -6.4], [-3.7, -6.4], [-1.2, -6], [-10.6, -5.4]],
  hoh: [[4.2, -6.9], [9.9, -6.9], [3, -10], [10.6, -10], [7, -5.6]],
  backyard: [[-9, 10.2], [-12.4, 13], [-5, 13], [-1, 12.6], [2.2, 15.4], [4, 10], [8, 9.3], [12.6, 11], [13, 16], [-3.6, 16.8], [0.5, 9.6]],
};
// How much each room draws people. The HoH suite and bedroom are quiet by
// design — they are where you go to be alone with someone.
const ROOM_PULL = { living: 3, kitchen: 3, backyard: 3, bedroom: 1.2, hoh: 0.8 };
let hangoutsChecked = false;
function hangouts() {
  if (!hangoutsChecked) {
    hangoutsChecked = true;
    for (const [room, list] of Object.entries(HANGOUTS)) {
      HANGOUTS[room] = list.filter(([x, z]) => !hitsWall(x, z, 0.5) && !inPool(x, z));
    }
  }
  return HANGOUTS;
}
const STAY = {
  afterRoomChange: [70, 200],  // seconds settled after crossing the house
  afterShift: [35, 95],        // ...after a small move within the room
  afterTalk: [25, 70],         // lingering where a conversation ended
};

function nearestRoom(x, z) {
  const direct = roomAt(x, z);
  if (direct) return direct;
  let best = null, bd = Infinity;
  for (const [name, r] of Object.entries(ROOMS)) {
    const d = (x - r.x) ** 2 + (z - r.z) ** 2;
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}

// Project blocked clicks to a free destination and route around furniture.
function routeTo(from, to) {
  return findPath(from, to).map(p => new THREE.Vector3(p.x, 0, p.z));
}

// Swimming: sink into the pool and wade slowly; pop back up on dry land.
function updateSwim(char) {
  const u = char.userData;
  const swimming = inPool(char.position.x, char.position.z);
  const targetBase = swimming ? -0.62 : 0;
  u.baseY += (targetBase - u.baseY) * 0.18;
  return swimming;
}

// Push overlapping bodies apart so characters can't walk through each other.
// aFrozen bodies (mid-conversation) hold their ground; the other takes the push.
function separateBodies(bodies, frozenIds) {
  const R = 0.72; // combined personal space
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      const dx = b.position.x - a.position.x;
      const dz = b.position.z - a.position.z;
      const d = Math.hypot(dx, dz);
      if (d >= R || d < 0.0001) continue;
      const push = (R - d) / 2;
      const nx = dx / d, nz = dz / d;
      const aFrozen = frozenIds.has(a.userData.id);
      const bFrozen = frozenIds.has(b.userData.id);
      const aPush = aFrozen ? 0 : bFrozen ? push * 2 : push;
      const bPush = bFrozen ? 0 : aFrozen ? push * 2 : push;
      if (aPush && !hitsWall(a.position.x - nx * aPush, a.position.z - nz * aPush)) {
        a.position.x -= nx * aPush;
        a.position.z -= nz * aPush;
      }
      if (bPush && !hitsWall(b.position.x + nx * bPush, b.position.z + nz * bPush)) {
        b.position.x += nx * bPush;
        b.position.z += nz * bPush;
      }
    }
  }
}

// Move a character with wall collision; blocked axes slide instead of stop.
function moveWithCollision(obj, dx, dz) {
  let moved = false;
  const p = obj.position;
  recoverPosition(p);
  if (dx && !hitsWall(p.x + dx, p.z)) { p.x += dx; moved = true; }
  if (dz && !hitsWall(p.x, p.z + dz)) { p.z += dz; moved = true; }
  p.x = THREE.MathUtils.clamp(p.x, BOUNDS.minX, BOUNDS.maxX);
  p.z = THREE.MathUtils.clamp(p.z, BOUNDS.minZ, BOUNDS.maxZ);
  return moved;
}

// Advance obj along a waypoint queue. Returns { moving, done, stuck }.
function followQueue(obj, queue, speed, dt) {
  if (!queue || !queue.length) return { moving: false, done: true, stuck: false };
  const target = queue[0];
  const to = target.clone().sub(obj.position);
  to.y = 0;
  const dist = to.length();
  const arriveDist = queue.length > 1 ? 0.06 : 0.10;
  if (dist <= arriveDist) {
    queue.shift();
    return { moving: true, done: queue.length === 0, stuck: false };
  }
  to.normalize();
  const stride = Math.min(dist, speed * dt);
  const moved = moveWithCollision(obj, to.x * stride, to.z * stride);
  turnToward(obj, Math.atan2(to.x, to.z), dt);
  return { moving: moved, done: false, stuck: !moved };
}

export class WorldController {
  constructor(scene, camera, canvas) {
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.player = null;
    this.npcs = new Map(); // id -> char group
    this.keys = {};
    this.moveQueue = null; // player waypoint queue
    this.npcState = new Map(); // id -> { queue, pauseUntil, frozen, approachPlayer, repathAt, stuckTime }
    this.camAngle = -0.38;
    this.camDist = 20;
    this.camHeight = 16;
    this.focusNpcId = null; // chat close-up target
    this.raycaster = new THREE.Raycaster();
    this.clock = new THREE.Clock();
    this.inputLocked = false;
    this.onNpcClick = null; // (id) => {}
    this.huddle = null;     // { a, b, x, z, until, ready }
    this.stage = null;      // { slots: Map<id,{x,z,rotY}>, t0 } while a ceremony is staged
    this.hoverId = null;

    // Floor feedback: who you'd click, where you're walking, where a
    // conversation can be overheard from.
    this.hoverRing = flatRing(0.46, 0.54, 0xC9A86A, 0.85);
    this.playerRing = flatRing(0.42, 0.47, 0xECE7DA, 0.4);
    this.moveRing = flatRing(0.22, 0.3, 0xECE7DA, 0.8);
    this.listenRing = flatRing(LISTEN_R - 0.07, LISTEN_R, 0xC9A86A, 0.55);
    this.spotRing = flatRing(SPOT_R - 0.06, SPOT_R, 0xD9483C, 0.6);
    this.moveRingAt = -10;
    for (const r of [this.hoverRing, this.playerRing, this.moveRing, this.listenRing, this.spotRing]) scene.add(r);

    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (this.uiBlocked()) return;
      this.keys[e.code] = true;
    });
    window.addEventListener('keyup', (e) => (this.keys[e.code] = false));
    window.addEventListener('blur', () => { this.keys = {}; this._pointers.clear(); });

    // Pointer handling supports mouse AND touch:
    //  tap/click       -> move / talk (handleClick)
    //  one-finger drag -> rotate camera
    //  two-finger pinch-> zoom
    this._pointers = new Map();
    this._dragging = false;
    this._pinchDist = 0;
    canvas.style.touchAction = 'none'; // stop iOS scroll/zoom hijacking the canvas

    canvas.addEventListener('pointerdown', (e) => {
      if (this.uiBlocked()) return;
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
      this._dragging = false;
      if (this._pointers.size === 2) {
        const [a, b] = [...this._pointers.values()];
        this._pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
      canvas.setPointerCapture?.(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (this.uiBlocked()) { this.setHover(null); return; }
      const p = this._pointers.get(e.pointerId);
      if (!p) {
        if (e.pointerType === 'mouse') this.setHover(this.pickNpc(e));
        return;
      }
      const dx = e.clientX - p.x;
      p.x = e.clientX;
      p.y = e.clientY;

      if (this._pointers.size === 2) {
        // pinch zoom
        const [a, b] = [...this._pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (this._pinchDist) {
          this.zoomBy((this._pinchDist - dist) * 0.06);
        }
        this._pinchDist = dist;
        this._dragging = true;
        return;
      }
      // one-pointer drag: rotate once past a small dead zone (so taps stay taps)
      const total = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
      if (this._dragging || total > 9) {
        this._dragging = true;
        this.camAngle -= dx * 0.008;
      }
    });

    const endPointer = (e) => {
      const p = this._pointers.get(e.pointerId);
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._pinchDist = 0;
      if (!p) return;
      // A short, still press = a tap/click
      if (!this._dragging && this._pointers.size === 0) this.handleClick(e);
      if (this._pointers.size === 0) this._dragging = false;
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', (e) => {
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._pinchDist = 0;
      if (this._pointers.size === 0) this._dragging = false;
    });

    canvas.addEventListener('wheel', (e) => { if (!this.uiBlocked()) this.zoomBy(e.deltaY * 0.02); }, { passive: true });
  }

  uiBlocked() {
    return this.inputLocked || !!document.querySelector('.cinematic, .title-screen, .chat-panel, .dock-menu[open]');
  }

  zoomBy(delta) {
    this.camDist = Math.max(7, Math.min(36, this.camDist + delta));
    this.camHeight = this.camDist * 0.75;
  }

  setPlayer(char) {
    this.player = char;
    char.position.set(-3, 0, 3);
  }

  addNpc(char, startRoom) {
    this.npcs.set(char.userData.id, char);
    const c = roomCenter(startRoom);
    // reroll spawn if it lands inside furniture
    let x = c.x, z = c.z;
    for (let i = 0; i < 12; i++) {
      x = c.x + rnd(-2, 2);
      z = c.z + rnd(-2, 2);
      if (!hitsWall(x, z, 0.5)) break;
    }
    char.position.set(x, 0, z);
    // Staggered, so the house does not all get up at the same moment.
    this.npcState.set(char.userData.id, { queue: null, pauseUntil: this.clock.elapsedTime + rnd(6, 80), frozen: false, stuckTime: 0 });
    this.scene.add(char);
  }

  removeNpc(id) {
    const char = this.npcs.get(id);
    if (char) {
      this.scene.remove(char);
      this.npcs.delete(id);
      this.npcState.delete(id);
    }
  }

  // Which houseguest is under the pointer? Tested against a capsule round
  // each body rather than the meshes: it is far cheaper than raycasting eight
  // sculpted characters on every mouse move, and more forgiving to click.
  pickNpc(e) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    let best = null, bestD = 0.5 * 0.5;
    for (const [id, char] of this.npcs) {
      a.copy(char.position); a.y += 0.25;
      b.copy(char.position); b.y += 1.75;
      const d = this.raycaster.ray.distanceSqToSegment(a, b);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  setHover(id) {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.canvas.style.cursor = id ? 'pointer' : '';
  }

  handleClick(e) {
    if (this.uiBlocked()) return;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);

    // NPC hit?
    for (const [id, char] of this.npcs) {
      const hits = this.raycaster.intersectObject(char, true);
      if (hits.length) {
        const d = char.position.distanceTo(this.player.position);
        if (d < 3.2 && this.onNpcClick) this.onNpcClick(id);
        else this.moveQueue = routeTo(this.player.position, char.position); // walk toward them
        return;
      }
    }
    // Ground click -> route there through doors
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const pt = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(plane, pt)) {
      pt.x = THREE.MathUtils.clamp(pt.x, BOUNDS.minX, BOUNDS.maxX);
      pt.z = THREE.MathUtils.clamp(pt.z, BOUNDS.minZ, BOUNDS.maxZ);
      this.moveQueue = routeTo(this.player.position, pt);
      const end = this.moveQueue.at(-1);
      if (end) {
        this.moveRing.position.set(end.x, 0.27, end.z);
        this.moveRingAt = this.clock.elapsedTime;
      }
    }
  }

  // ---- Huddles: two houseguests step aside to talk game --------------------

  // Send a and b to a quiet spot away from the player. Returns false if no
  // spot could be found this tick (the director just tries again later).
  startHuddle(a, b) {
    const sa = this.npcState.get(a), sb = this.npcState.get(b);
    if (!sa || !sb || sa.frozen || sb.frozen || this.huddle || this.stage) return false;
    const rooms = Object.keys(ROOMS).filter((r) => r !== 'diary');
    for (let i = 0; i < 24; i++) {
      const room = ROOMS[rooms[Math.floor(Math.random() * rooms.length)]];
      const x = room.x + rnd(-room.w / 2 + 2, room.w / 2 - 2);
      const z = room.z + rnd(-room.d / 2 + 2, room.d / 2 - 2);
      if (hitsWall(x - 0.5, z, 0.6) || hitsWall(x + 0.5, z, 0.6) || inPool(x, z)) continue;
      if (this.player && Math.hypot(x - this.player.position.x, z - this.player.position.z) < LISTEN_R + 3) continue;
      this.huddle = { a, b, x, z, until: this.clock.elapsedTime + 46, ready: false };
      sa.queue = null; sb.queue = null;
      sa.approachPlayer = false; sb.approachPlayer = false;
      return true;
    }
    return false;
  }

  endHuddle() {
    if (!this.huddle) return;
    const t = this.clock.elapsedTime;
    for (const id of [this.huddle.a, this.huddle.b]) {
      const st = this.npcState.get(id);
      if (st) { st.queue = null; st.pauseUntil = t + rnd(...STAY.afterTalk); }
    }
    this.huddle = null;
  }

  inHuddle(id) {
    return !!this.huddle && (this.huddle.a === id || this.huddle.b === id);
  }

  // ---- Somewhere private ------------------------------------------------------

  // The quietest reachable spot for two people: far from everyone else,
  // not too far to walk. Returns { x, z, room, clear } or null.
  findQuietSpot(partnerId, earshot = 6) {
    if (!this.player) return null;
    const others = [...this.npcs].filter(([id]) => id !== partnerId).map(([, c]) => c.position);
    let best = null;
    for (const [name, room] of Object.entries(ROOMS)) {
      if (name === 'diary') continue;
      for (let i = 0; i < 14; i++) {
        const x = room.x + rnd(-room.w / 2 + 1.6, room.w / 2 - 1.6);
        const z = room.z + rnd(-room.d / 2 + 1.6, room.d / 2 - 1.6);
        if (hitsWall(x, z, 0.7) || hitsWall(x + 1.1, z, 0.6) || inPool(x, z) || inPool(x + 1.1, z)) continue;
        const nearest = others.reduce((m, p) => Math.min(m, Math.hypot(p.x - x, p.z - z)), Infinity);
        const walk = Math.hypot(this.player.position.x - x, this.player.position.z - z);
        const score = Math.min(nearest, earshot + 5) * 2 - walk * 0.25;
        if (!best || score > best.score) best = { x, z, room: name, score, clear: nearest > earshot + 0.5 };
      }
    }
    return best;
  }

  // Walk the player to (x, z) and bring `id` along to stand beside them.
  // Input is locked for the walk; `privateDone()` says when both have arrived.
  goPrivate(id, x, z) {
    const st = this.npcState.get(id);
    if (!st || !this.player) return false;
    st.frozen = false;
    st.approachPlayer = false;
    st.holdUntil = 0;
    st.queue = null;
    st.lead = { x: x + 1.1, z };
    this.moveQueue = routeTo(this.player.position, new THREE.Vector3(x, 0, z));
    this.autoWalk = true;
    this.inputLocked = true;
    return true;
  }

  privateDone(id) {
    const st = this.npcState.get(id);
    return !this.moveQueue && (!st || !st.lead);
  }

  // keepLock: a ceremony started mid-walk and owns the input lock now.
  endPrivateWalk(id, keepLock = false) {
    const st = this.npcState.get(id);
    if (st) st.lead = null;
    this.autoWalk = false;
    if (!keepLock) this.inputLocked = false;
    this.moveQueue = null;
  }

  // Online, on a client that is following someone else's simulation: the
  // huddle's spot and readiness come from them, refreshed with every position
  // batch. It lapses by itself a few seconds after the batches stop.
  setRemoteHuddle(h) {
    this.huddle = { a: h.a, b: h.b, x: h.x, z: h.z, ready: !!h.ready, until: this.clock.elapsedTime + 6, remote: true };
  }

  // Online: someone, somewhere, is talking to this houseguest. They stand
  // still on every screen until released (or the hold lapses).
  holdNpc(id, on) {
    const st = this.npcState.get(id);
    if (st) { st.holdUntil = on ? this.clock.elapsedTime + 180 : 0; if (on) st.queue = null; }
  }
  releaseHolds() {
    for (const [, st] of this.npcState) st.holdUntil = 0;
  }

  // ---- Ceremonies: everyone to the living room -----------------------------

  beginStage(ids) {
    this.endHuddle();
    const slots = new Map();
    const n = ids.length;
    ids.forEach((id, i) => {
      const a = n > 1 ? (-1 + (2 * i) / (n - 1)) * 1.25 : 0; // spread across ~145 degrees
      const x = STAGE.x + Math.sin(a) * STAGE.r;
      const z = STAGE.z - Math.cos(a) * STAGE.r * 0.82;
      slots.set(id, { x, z, rotY: Math.atan2(STAGE.x - x, STAGE.z + 4 - z) });
    });
    this.stage = { slots, t0: this.clock.elapsedTime };
    this.moveQueue = null;
    const place = (char, id) => {
      const s = slots.get(id);
      if (!char || !s) return;
      char.position.set(s.x, 0, s.z);
      char.rotation.y = s.rotY;
    };
    if (this.player) place(this.player, this.player.userData.id);
    for (const [id, char] of this.npcs) place(char, id);
    // Cut, don't glide: a ceremony starts on a new shot.
    this.camera.position.set(STAGE.x + 2, 6.4, STAGE.z + 11.5);
  }

  endStage() {
    if (!this.stage) return;
    this.stage = null;
    const t = this.clock.elapsedTime;
    // A ceremony breaks up gradually: a few leave at once, most mill about.
    for (const [, st] of this.npcState) { st.queue = null; st.pauseUntil = t + rnd(2, 45); st.wantRoom = true; }
  }

  // Where a houseguest goes when a stay runs out. Mostly nowhere far: a few
  // steps, or over to someone in the same room. Sometimes another room.
  pickHangout(id, char, st) {
    const spots = hangouts();
    const here = nearestRoom(char.position.x, char.position.z);
    const others = [this.player, ...this.npcs.values()].filter((c) => c && c !== char);
    const free = (x, z, r = 1.0) => !hitsWall(x, z, 0.5) && !inPool(x, z) &&
      !others.some((c) => Math.hypot(c.position.x - x, c.position.z - z) < r);
    const changeRoom = st.wantRoom || Math.random() < 0.38 || !spots[here]?.length;
    st.wantRoom = false;

    if (!changeRoom) {
      // Drift over to someone already in this room...
      if (Math.random() < 0.4) {
        const mates = [...this.npcs].filter(([oid, c]) => oid !== id && !this.inHuddle(oid) &&
          nearestRoom(c.position.x, c.position.z) === here && c.position.distanceTo(char.position) > 2);
        if (mates.length) {
          const [, mate] = mates[Math.floor(Math.random() * mates.length)];
          for (let i = 0; i < 6; i++) {
            const a = Math.random() * Math.PI * 2;
            const x = mate.position.x + Math.cos(a) * 1.25, z = mate.position.z + Math.sin(a) * 1.25;
            if (free(x, z, 0.9)) return { x, z, stay: STAY.afterShift };
          }
        }
      }
      // ...or just shift a few steps.
      for (let i = 0; i < 8; i++) {
        const a = Math.random() * Math.PI * 2, d = rnd(1.2, 2.6);
        const x = char.position.x + Math.cos(a) * d, z = char.position.z + Math.sin(a) * d;
        if (nearestRoom(x, z) === here && free(x, z)) return { x, z, stay: STAY.afterShift };
      }
      return null;
    }

    // Another room, weighted by how much it draws people.
    const rooms = Object.keys(spots).filter((r) => r !== here && spots[r].length);
    let roll = Math.random() * rooms.reduce((s, r) => s + (ROOM_PULL[r] || 1), 0);
    let room = rooms[0];
    for (const r of rooms) { roll -= ROOM_PULL[r] || 1; if (roll <= 0) { room = r; break; } }
    const open = (spots[room] || []).filter(([x, z]) => free(x, z, 1.1));
    if (!open.length) return null;
    const [x, z] = open[Math.floor(Math.random() * open.length)];
    return { x: x + rnd(-0.25, 0.25), z: z + rnd(-0.25, 0.25), stay: STAY.afterRoomChange };
  }

  nearestNpc(maxDist = 3.2) {
    if (!this.player) return null;
    let best = null, bestD = maxDist;
    for (const [id, char] of this.npcs) {
      const d = char.position.distanceTo(this.player.position);
      if (d < bestD) { best = id; bestD = d; }
    }
    return best;
  }

  // NPCs (other than excludeId) within earshot of the player, nearest first.
  // Each: { id, dist }. Used for eavesdropping on 1-on-1 conversations.
  nearbyListeners(excludeId, radius = 6) {
    if (!this.player) return [];
    const out = [];
    for (const [id, char] of this.npcs) {
      if (id === excludeId) continue;
      const d = char.position.distanceTo(this.player.position);
      if (d <= radius) out.push({ id, dist: d });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  playerRoom() {
    if (!this.player) return null;
    return roomAt(this.player.position.x, this.player.position.z);
  }

  // Send an NPC walking to the player (for approaches)
  summonNpc(id) {
    const st = this.npcState.get(id);
    if (st) {
      st.queue = null;
      st.approachPlayer = true;
      st.repathAt = 0;
    }
  }

  releaseNpc(id) {
    const st = this.npcState.get(id);
    if (st) {
      st.approachPlayer = false;
      st.queue = null;
    }
  }

  // Clear the "walk to the player" flag on everyone — call at conversation and
  // phase boundaries so nobody is left endlessly trailing the player.
  releaseAllFollowers() {
    for (const [, st] of this.npcState) {
      if (st.approachPlayer) {
        st.approachPlayer = false;
        st.queue = null;
      }
    }
  }

  freezeNpc(id, frozen) {
    const st = this.npcState.get(id);
    if (st) st.frozen = frozen;
  }

  // Online: another connected human just reported their real position. Drive
  // that NPC there directly (bypassing local wander AI) instead of guessing.
  // Falls back to normal AI wander if updates stop arriving (they disconnected
  // or a message got dropped) after a short grace period.
  setNetTarget(id, x, z, rotY) {
    const st = this.npcState.get(id);
    if (!st) return;
    st.net = { x, z, rotY };
    st.netUntil = this.clock.elapsedTime + 2.5;
  }

  // Online: which houseguests are being played by a connected person right
  // now. Everyone else is the AI's to move.
  setHumans(ids) {
    for (const [id, st] of this.npcState) st.human = ids.has(id);
  }

  // Cinematic close-up on an NPC's face during conversation.
  focusOn(id) {
    this.focusNpcId = id;
  }

  clearFocus() {
    this.focusNpcId = null;
  }

  update() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    // --- Player movement
    let moving = false;
    if (this.uiBlocked()) this.keys = {};
    if (this.player && (!this.uiBlocked() || this.autoWalk)) {
      const dir = new THREE.Vector3();
      const fwd = new THREE.Vector3(Math.sin(this.camAngle + Math.PI), 0, Math.cos(this.camAngle + Math.PI));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      if (this.keys['KeyW'] || this.keys['ArrowUp']) dir.add(fwd);
      if (this.keys['KeyS'] || this.keys['ArrowDown']) dir.sub(fwd);
      if (this.keys['KeyA'] || this.keys['ArrowLeft']) dir.sub(right);
      if (this.keys['KeyD'] || this.keys['ArrowRight']) dir.add(right);
      if (this.keys['KeyQ']) this.camAngle += dt * 1.8;
      if (this.keys['KeyE'] && !this.nearestNpc()) this.camAngle -= dt * 1.8;

      const playerSpeed = inPool(this.player.position.x, this.player.position.z) ? WALK_SPEED * 0.45 : WALK_SPEED;
      if (dir.lengthSq() > 0) {
        dir.normalize();
        moving = moveWithCollision(this.player, dir.x * playerSpeed * dt, dir.z * playerSpeed * dt);
        turnToward(this.player, Math.atan2(dir.x, dir.z), dt);
        this.moveQueue = null;
      } else if (this.moveQueue) {
        const r = followQueue(this.player, this.moveQueue, playerSpeed, dt);
        moving = r.moving;
        if (r.done) this.moveQueue = null;
        else if (r.stuck) this.moveQueue = routeTo(this.player.position, this.moveQueue.at(-1));
      }
      updateSwim(this.player);
      animateCharacter(this.player, moving, dt, t);
    }

    // --- NPC movement
    const roomNames = Object.keys(ROOMS).filter((r) => r !== 'diary');
    for (const [id, char] of this.npcs) {
      const st = this.npcState.get(id);
      if (this.stage) {
        // Hold the ceremony line-up (collision can nudge people; ease back).
        const s = this.stage.slots.get(id);
        if (s) {
          char.position.x += (s.x - char.position.x) * Math.min(1, dt * 6);
          char.position.z += (s.z - char.position.z) * Math.min(1, dt * 6);
          turnToward(char, s.rotY, dt);
        }
        updateSwim(char);
        animateCharacter(char, false, dt, t);
        continue;
      }
      if (st.frozen) {
        animateCharacter(char, false, dt, t);
        if (this.player) {
          const to = this.player.position.clone().sub(char.position);
          turnToward(char, Math.atan2(to.x, to.z), dt);
        }
        continue;
      }
      // Online: a real human is reporting this NPC's position — drive there
      // directly instead of running local wander/approach AI on top of it.
      if (st.lead) {
        const far = Math.hypot(st.lead.x - char.position.x, st.lead.z - char.position.z);
        if (far > 0.45) {
          if (!st.queue || !st.queue.length) st.queue = routeTo(char.position, new THREE.Vector3(st.lead.x, 0, st.lead.z));
          const r = followQueue(char, st.queue, NPC_SPEED * 2.2, dt);
          if (r.stuck || r.done) st.queue = null;
          // The route can end short of the exact point (it projects out of
          // furniture). Close enough to talk is close enough.
          if (r.done && far < 1.6) st.lead = null;
          updateSwim(char);
          animateCharacter(char, r.moving, dt, t);
          continue;
        }
        st.lead = null;
        st.queue = null;
        st.pauseUntil = t + rnd(...STAY.afterTalk);
      }
      if ((st.holdUntil || 0) > t && !this.inHuddle(id)) {
        updateSwim(char);
        animateCharacter(char, false, dt, t);
        continue;
      }
      // A seat with a connected person in it (st.human, set from the room
      // roster) is theirs alone: it goes where they last reported and stays
      // there. It used to fall back to AI wandering 2.5 s after the last
      // update — and updates only come while they move, so anyone who stood
      // still was seen strolling off on everybody else's screen.
      if (st.human || (st.net && t < (st.netUntil || 0))) {
        const beforeX = char.position.x, beforeZ = char.position.z;
        if (st.net) {
          // Far behind (just joined, or a ceremony moved them): snap, don't glide through walls.
          const gap = Math.hypot(st.net.x - char.position.x, st.net.z - char.position.z);
          const k = gap > 6 ? 1 : Math.min(1, dt * 8);
          char.position.x += (st.net.x - char.position.x) * k;
          char.position.z += (st.net.z - char.position.z) * k;
          turnToward(char, st.net.rotY, dt);
        }
        const netMoving = Math.hypot(char.position.x - beforeX, char.position.z - beforeZ) > 0.001;
        updateSwim(char);
        animateCharacter(char, netMoving, dt, t);
        continue;
      }
      let npcMoving = false;
      const npcSpeed = inPool(char.position.x, char.position.z) ? NPC_SPEED * 0.45 : NPC_SPEED;

      if (this.inHuddle(id) && !st.approachPlayer) {
        const h = this.huddle;
        const side = h.a === id ? -0.5 : 0.5;
        const dx = h.x + side - char.position.x, dz = h.z - char.position.z;
        const far = Math.hypot(dx, dz);
        if (far > 0.3) {
          if (!st.queue || !st.queue.length) st.queue = routeTo(char.position, new THREE.Vector3(h.x + side, 0, h.z));
          const r = followQueue(char, st.queue, npcSpeed * 1.25, dt);
          npcMoving = r.moving;
          if (r.stuck) st.queue = null;
          st.huddleHere = false;
        } else {
          st.queue = null;
          st.huddleHere = true;
          // Face each other, with the small sway of someone mid-argument.
          turnToward(char, Math.atan2(-side, 0) + Math.sin(t * 1.3 + (side > 0 ? 2 : 0)) * 0.12, dt);
        }
      } else if (st.approachPlayer && this.player) {
        const dist = char.position.distanceTo(this.player.position);
        const sameRoom = nearestRoom(char.position.x, char.position.z) === nearestRoom(this.player.position.x, this.player.position.z);
        if (dist > 2.0 || !sameRoom) {
          if (!st.queue || !st.queue.length || t > (st.repathAt || 0)) {
            st.queue = routeTo(char.position, this.player.position);
            st.repathAt = t + 1.5; // player moves; re-route periodically
          }
          const r = followQueue(char, st.queue, npcSpeed * 1.6, dt);
          npcMoving = r.moving;
          if (r.stuck) st.queue = null;
        } else {
          // arrived: face the player and wait
          const to = this.player.position.clone().sub(char.position);
          turnToward(char, Math.atan2(to.x, to.z), dt);
          st.queue = null;
        }
      } else {
        if ((!st.queue || !st.queue.length) && t > st.pauseUntil) {
          const dest = this.pickHangout(id, char, st);
          if (dest) {
            st.queue = routeTo(char.position, new THREE.Vector3(dest.x, 0, dest.z));
            st.stayNext = dest.stay;
          } else {
            st.pauseUntil = t + rnd(8, 20); // nowhere better right now: stay put
          }
        } else if (!st.queue || !st.queue.length) {
          // Settled: turn toward whoever is standing closest, like a person would.
          let near = null, nd = 3.4;
          const consider = (c) => {
            if (!c || c === char) return;
            const d = Math.hypot(c.position.x - char.position.x, c.position.z - char.position.z);
            if (d < nd && d > 0.3) { nd = d; near = c; }
          };
          consider(this.player);
          for (const [, other] of this.npcs) consider(other);
          if (near) turnToward(char, Math.atan2(near.position.x - char.position.x, near.position.z - char.position.z), dt * 0.35);
        }
        if (st.queue && st.queue.length) {
          // No-progress watchdog: sliding along a wall counts as "moving",
          // so also require actual distance-to-waypoint progress.
          const target = st.queue[0];
          const distNow = char.position.distanceTo(target);
          if (st.progTarget !== target || distNow < st.progBest - 0.15) {
            st.progTarget = target;
            st.progBest = distNow;
            st.progSince = t;
          }
          const noProgress = t - (st.progSince || t) > 1.5;
          const r = followQueue(char, st.queue, npcSpeed, dt);
          npcMoving = r.moving;
          st.stuckTime = r.moving ? 0 : st.stuckTime + dt;
          if (r.done || r.stuck || st.stuckTime > 1.2 || noProgress) {
            st.queue = null;
            st.stuckTime = 0;
            st.progTarget = null;
            // Arrived: settle for the stay this move earned. Blocked: wait a
            // few seconds and think again, rather than marching at a wall.
            st.pauseUntil = t + (r.done ? rnd(...(st.stayNext || STAY.afterShift)) : rnd(3, 9));
          }
        }
      }
      updateSwim(char);
      animateCharacter(char, npcMoving, dt, t);
    }

    // --- Body collision: nobody walks through anybody
    if (this.player) {
      const frozenIds = new Set();
      for (const [id, st] of this.npcState) if (st.frozen) frozenIds.add(id);
      separateBodies([this.player, ...this.npcs.values()], frozenIds);
    }

    // --- Huddle bookkeeping
    if (this.huddle) {
      const h = this.huddle;
      const sa = this.npcState.get(h.a), sb = this.npcState.get(h.b);
      if (!sa || !sb || t > h.until || sa.frozen || sb.frozen) this.endHuddle();
      else if (!h.remote) h.ready = !!(sa.huddleHere && sb.huddleHere);
    }

    // --- Floor feedback
    const hov = this.hoverId ? this.npcs.get(this.hoverId) : null;
    this.hoverRing.visible = !!hov && !this.stage;
    if (hov) {
      this.hoverRing.position.set(hov.position.x, 0.27, hov.position.z);
      const s = 1 + Math.sin(t * 5) * 0.04;
      this.hoverRing.scale.set(s, s, 1);
    }
    this.playerRing.visible = !!this.player && !this.stage && !this.focusNpcId && !inPool(this.player.position.x, this.player.position.z);
    if (this.player) this.playerRing.position.set(this.player.position.x, 0.262, this.player.position.z);
    const mk = (t - this.moveRingAt) / 0.7;
    this.moveRing.visible = mk >= 0 && mk < 1 && !!this.moveQueue;
    if (this.moveRing.visible) {
      const s = 1.6 - mk * 0.9;
      this.moveRing.scale.set(s, s, 1);
      this.moveRing.material.opacity = 0.8 * (1 - mk);
    }
    const showHuddle = !!this.huddle?.ready && !this.focusNpcId;
    this.listenRing.visible = this.spotRing.visible = showHuddle;
    if (showHuddle) {
      this.listenRing.position.set(this.huddle.x, 0.265, this.huddle.z);
      this.spotRing.position.set(this.huddle.x, 0.268, this.huddle.z);
      this.listenRing.material.opacity = 0.4 + Math.sin(t * 2.4) * 0.15;
    }

    // --- Camera
    const focusChar = this.focusNpcId ? this.npcs.get(this.focusNpcId) : null;

    if (this.stage) {
      // Ceremony shot: low and wide across the sofa, drifting slowly.
      const k = t - this.stage.t0;
      const a = Math.sin(k * 0.11) * 0.3;
      const want = new THREE.Vector3(STAGE.x + Math.sin(a) * 11.5, 6.2 + Math.sin(k * 0.07) * 0.4, STAGE.z + Math.cos(a) * 11.5);
      this.camera.position.lerp(want, 0.04);
      this.camera.lookAt(STAGE.x, 1.15, STAGE.z - 1.6);
    } else if (focusChar && this.player) {
      // Slightly high over-the-shoulder shot framing the NPC's face; the
      // elevated angle keeps passers-by from filling the lens.
      const npcP = focusChar.position;
      const headY = focusChar.userData.headY || 1.8;
      const away = this.player.position.clone().sub(npcP).setY(0);
      if (away.lengthSq() < 0.01) away.set(0, 0, 1);
      away.normalize();
      const side = new THREE.Vector3(-away.z, 0, away.x);
      const camPos = npcP.clone()
        .addScaledVector(away, 2.9)
        .addScaledVector(side, 1.5)
        .add(new THREE.Vector3(0, headY + 1.15, 0));
      this.camera.position.lerp(camPos, 0.07);
      const look = new THREE.Vector3(npcP.x, headY + 0.05, npcP.z);
      this.camera.lookAt(look);
    } else if (this.player) {
      const px = this.player.position.x, pz = this.player.position.z;
      const cx = px + Math.sin(this.camAngle) * this.camDist;
      const cz = pz + Math.cos(this.camAngle) * this.camDist;
      this.camera.position.lerp(new THREE.Vector3(cx, this.camHeight, cz), 0.08);
      this.camera.lookAt(px, 1.2, pz);
    } else {
      // Spectator: no controlled avatar — slow automatic orbit over the house
      // so there's always something to watch instead of a static/black view.
      this.camAngle += dt * 0.06;
      const cx = Math.sin(this.camAngle) * 20;
      const cz = Math.cos(this.camAngle) * 20;
      this.camera.position.lerp(new THREE.Vector3(cx, 16, cz), 0.03);
      this.camera.lookAt(0, 0, 0);
    }

    return dt;
  }
}

function rnd(a, b) {
  return a + Math.random() * (b - a);
}
