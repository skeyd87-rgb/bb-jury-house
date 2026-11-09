// Player controls, NPC wandering, camera, proximity and obstacle-aware walking.

import * as THREE from 'three';
import { ROOMS, roomCenter, roomAt, hitsWall, inPool } from './scene.js';
import { animateCharacter } from './characters.js';
import { BOUNDS, findPath, turnToward, recoverPosition } from './navigation.js';

const WALK_SPEED = 4.2;
const NPC_SPEED = 1.8;

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
      if (this.uiBlocked()) return;
      const p = this._pointers.get(e.pointerId);
      if (!p) return;
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
    this.npcState.set(char.userData.id, { queue: null, pauseUntil: 0, frozen: false, stuckTime: 0 });
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
    }
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
    if (this.player && !this.uiBlocked()) {
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
      if (st.net && t < (st.netUntil || 0)) {
        const beforeX = char.position.x, beforeZ = char.position.z;
        char.position.x += (st.net.x - char.position.x) * Math.min(1, dt * 8);
        char.position.z += (st.net.z - char.position.z) * Math.min(1, dt * 8);
        turnToward(char, st.net.rotY, dt);
        const netMoving = Math.hypot(char.position.x - beforeX, char.position.z - beforeZ) > 0.001;
        updateSwim(char);
        animateCharacter(char, netMoving, dt, t);
        continue;
      }
      let npcMoving = false;
      const npcSpeed = inPool(char.position.x, char.position.z) ? NPC_SPEED * 0.45 : NPC_SPEED;

      if (st.approachPlayer && this.player) {
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
          const room = ROOMS[roomNames[Math.floor(Math.random() * roomNames.length)]];
          const dest = new THREE.Vector3(
            room.x + rnd(-room.w / 2 + 1.2, room.w / 2 - 1.2),
            0,
            room.z + rnd(-room.d / 2 + 1.2, room.d / 2 - 1.2)
          );
          if (!hitsWall(dest.x, dest.z, 0.7)) st.queue = routeTo(char.position, dest);
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
            st.pauseUntil = t + rnd(r.done ? 3 : 0.5, r.done ? 10 : 2);
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

    // --- Camera
    const focusChar = this.focusNpcId ? this.npcs.get(this.focusNpcId) : null;

    if (focusChar && this.player) {
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
