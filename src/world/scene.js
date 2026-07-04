// Three.js scene v2: stylized BB house with procedural textures, sky dome,
// richer furniture/props, and tuned lighting. Collision data (WALLS,
// OBSTACLES, POOL) lives here so rendering and physics never drift apart.

import * as THREE from 'three';

export const ROOMS = {
  living: { x: -6, z: 2, w: 12, d: 10, color: 0xc9b8a3, label: 'Living Room', floor: 0x9c8468 },
  kitchen: { x: 7, z: 2, w: 10, d: 10, color: 0xbcd1d8, label: 'Kitchen', floor: 0x8aa5ad },
  bedroom: { x: -6, z: -8, w: 12, d: 8, color: 0xc7b9d9, label: 'Bedroom', floor: 0x8d7ba8 },
  hoh: { x: 7, z: -8, w: 10, d: 8, color: 0xd9c17a, label: 'HoH Suite', floor: 0xb39b4f },
  diary: { x: 15, z: -8, w: 5, d: 8, color: 0xb04a4a, label: 'Diary Room', floor: 0x8a3535 },
  backyard: { x: 0, z: 13, w: 34, d: 10, color: 0x7fb069, label: 'Backyard', floor: 0x6a9a55 },
};

export function roomCenter(name) {
  const r = ROOMS[name];
  return new THREE.Vector3(r.x, 0, r.z);
}

// Wall AABBs, shared by rendering (scene) and collision (movement).
const WALL_T = 0.4;
export const WALLS = [
  // outer box of interior area x:[-12..20] z:[-12..7]
  { x: 4, z: -12, w: 32, d: WALL_T },
  { x: -12, z: -2.5, w: WALL_T, d: 19 },
  { x: 20, z: -2.5, w: WALL_T, d: 19 },
  // front wall pieces with a gap (door to backyard)
  { x: -7, z: 7, w: 10.4, d: WALL_T },
  { x: 13, z: 7, w: 14.4, d: WALL_T },
  // divider living/kitchen with doorway
  { x: 0.5, z: 4.5, w: WALL_T, d: 5 },
  { x: 0.5, z: -2, w: WALL_T, d: 4 },
  // divider bedrooms/common with doorways
  { x: -8.5, z: -4, w: 7, d: WALL_T },
  { x: 3, z: -4, w: 8, d: WALL_T },
  { x: 16, z: -4, w: 8, d: WALL_T },
  // divider bedroom/hoh
  { x: 0.5, z: -8.5, w: WALL_T, d: 7 },
  // divider hoh/diary
  { x: 12.4, z: -9.5, w: WALL_T, d: 5 },
];

// Furniture AABBs — kept in sync with the props built below.
export const OBSTACLES = [
  { x: -6, z: 5.2, w: 6, d: 1.8 },      // sofa
  { x: -6, z: 2.5, w: 2.2, d: 2.2 },    // coffee table
  { x: -6, z: -2.55, w: 2.8, d: 0.8 },  // TV stand
  { x: 7, z: 6.1, w: 7, d: 1.4 },       // kitchen counter
  { x: 7, z: 2, w: 3.4, d: 1.6 },       // kitchen island
  { x: 10.5, z: -1, w: 3, d: 3 },       // dining table
  { x: -10.2, z: -9.5, w: 1.6, d: 3 },  // beds
  { x: -7.6, z: -9.5, w: 1.6, d: 3 },
  { x: -5, z: -9.5, w: 1.6, d: 3 },
  { x: -2.4, z: -9.5, w: 1.6, d: 3 },
  { x: 7, z: -9.3, w: 3.4, d: 3.6 },    // HoH bed
  { x: 15, z: -9.5, w: 1.8, d: 1.6 },   // Diary Room chair
  { x: 8, z: 13.5, w: 6.6, d: 6.6 },    // comp stage
  { x: -1, z: 15.5, w: 3.6, d: 3.6 },   // hot tub
  { x: -15.5, z: 16, w: 0.7, d: 0.7 },  // palm trunks
  { x: 15.5, z: 16, w: 0.7, d: 0.7 },
  { x: 0, z: 17.3, w: 0.7, d: 0.7 },
  { x: -14.2, z: 11.5, w: 1.2, d: 2.6 }, // loungers
  { x: -14.2, z: 14.8, w: 1.2, d: 2.6 },
  { x: -11.3, z: 6.2, w: 0.6, d: 0.6 },  // plants
  { x: 19.3, z: 6.2, w: 0.6, d: 0.6 },
  { x: -11.3, z: -3.2, w: 0.6, d: 0.6 },
];

// The pool is walkable — you fall in and swim. Used by movement.js.
export const POOL = { x: -9, z: 13, w: 6, d: 3.6 };

export function inPool(x, z) {
  return Math.abs(x - POOL.x) < POOL.w / 2 && Math.abs(z - POOL.z) < POOL.d / 2;
}

// True if a circle of `radius` at (x,z) overlaps any wall or furniture.
export function hitsWall(x, z, radius = 0.45) {
  for (const w of WALLS) {
    if (Math.abs(x - w.x) < w.w / 2 + radius && Math.abs(z - w.z) < w.d / 2 + radius) return true;
  }
  for (const o of OBSTACLES) {
    if (Math.abs(x - o.x) < o.w / 2 + radius && Math.abs(z - o.z) < o.d / 2 + radius) return true;
  }
  return false;
}

export function roomAt(x, z) {
  for (const [name, r] of Object.entries(ROOMS)) {
    if (Math.abs(x - r.x) <= r.w / 2 && Math.abs(z - r.z) <= r.d / 2) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------

function canvasTex(size, draw, repeatX = 1, repeatY = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 4;
  return tex;
}

function woodTex(base = '#a97c50', dark = '#8a6238') {
  return canvasTex(256, (ctx, s) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, s, s);
    const plankH = s / 8;
    for (let i = 0; i < 8; i++) {
      const shade = i % 2 ? 0.06 : 0;
      ctx.fillStyle = `rgba(0,0,0,${0.04 + shade * Math.random()})`;
      ctx.fillRect(0, i * plankH, s, plankH);
      // grain streaks
      for (let k = 0; k < 14; k++) {
        ctx.strokeStyle = `rgba(60,35,15,${0.05 + Math.random() * 0.09})`;
        ctx.lineWidth = 1;
        const y = i * plankH + Math.random() * plankH;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(s * 0.3, y + 3, s * 0.6, y - 3, s, y + 1);
        ctx.stroke();
      }
      ctx.fillStyle = dark;
      ctx.fillRect(0, i * plankH, s, 2);
      // plank seams
      const off = (i % 2) * s * 0.5;
      ctx.fillRect((off + s * 0.33) % s, i * plankH, 2, plankH);
      ctx.fillRect((off + s * 0.78) % s, i * plankH, 2, plankH);
    }
  }, 3, 3);
}

function tileTex(base = '#b9cdd4', line = '#93aab2') {
  return canvasTex(256, (ctx, s) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, s, s);
    const n = 4, t = s / n;
    for (let i = 0; i <= n; i++) {
      ctx.fillStyle = line;
      ctx.fillRect(i * t - 1, 0, 3, s);
      ctx.fillRect(0, i * t - 1, s, 3);
    }
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.08})`;
        ctx.fillRect(i * t + 2, j * t + 2, t - 4, t - 4);
      }
  }, 4, 4);
}

function carpetTex(base) {
  return canvasTex(128, (ctx, s) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${Math.random() * 0.07})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 1.6, 1.6);
    }
  }, 5, 5);
}

function grassTex() {
  return canvasTex(256, (ctx, s) => {
    ctx.fillStyle = '#5d8f4a';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 3000; i++) {
      const g = 120 + Math.random() * 70;
      ctx.strokeStyle = `rgba(${40 + Math.random() * 40},${g},${45 + Math.random() * 30},0.35)`;
      const x = Math.random() * s, y = Math.random() * s;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (Math.random() - 0.5) * 3, y - 3 - Math.random() * 4);
      ctx.stroke();
    }
  }, 6, 3);
}

function plasterTex(tint = '#efe9dc') {
  return canvasTex(128, (ctx, s) => {
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.03})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
  }, 2, 1);
}

function bbEyeTex() {
  return canvasTex(256, (ctx, s) => {
    ctx.fillStyle = '#141a30';
    ctx.fillRect(0, 0, s, s);
    const cx = s / 2, cy = s / 2;
    // eye shape
    ctx.fillStyle = '#f5f0e6';
    ctx.beginPath();
    ctx.ellipse(cx, cy, 100, 58, 0, 0, Math.PI * 2);
    ctx.fill();
    const iris = ctx.createRadialGradient(cx, cy, 8, cx, cy, 46);
    iris.addColorStop(0, '#8ad4ff');
    iris.addColorStop(0.6, '#2f6bff');
    iris.addColorStop(1, '#1a2c8f');
    ctx.fillStyle = iris;
    ctx.beginPath();
    ctx.arc(cx, cy, 46, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0b0e1c';
    ctx.beginPath();
    ctx.arc(cx, cy, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(cx - 12, cy - 12, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#f5c542';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 100, 58, 0, 0, Math.PI * 2);
    ctx.stroke();
  });
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const fxCallbacks = [];

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x10142a, 60, 110);

  const camera = new THREE.PerspectiveCamera(46, 2, 0.1, 300);
  camera.position.set(0, 22, 26);

  addSky(scene);
  addLights(scene);
  buildHouse(scene);

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  // Per-frame ambient effects (water shimmer, lamp flicker)
  function updateFx(t) {
    for (const fn of fxCallbacks) fn(t);
  }

  return { renderer, scene, camera, resize, updateFx };
}

function addSky(scene) {
  // Gradient dome
  const skyGeo = new THREE.SphereGeometry(140, 24, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x0a0e24) },
      mid: { value: new THREE.Color(0x1c2450) },
      bot: { value: new THREE.Color(0x3b2d5e) },
    },
    vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vPos; uniform vec3 top; uniform vec3 mid; uniform vec3 bot;
      void main(){ float h = normalize(vPos).y; vec3 c = h > 0.25 ? mix(mid, top, smoothstep(0.25,1.0,h)) : mix(bot, mid, smoothstep(-0.2,0.25,h)); gl_FragColor = vec4(c,1.0); }`,
  });
  scene.add(new THREE.Mesh(skyGeo, skyMat));

  // Stars
  const starGeo = new THREE.BufferGeometry();
  const pts = [];
  for (let i = 0; i < 320; i++) {
    const a = Math.random() * Math.PI * 2;
    const h = 0.25 + Math.random() * 0.7;
    const r = 130;
    const y = r * h;
    const rr = Math.sqrt(r * r - y * y);
    pts.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
  }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const stars = new THREE.Points(
    starGeo,
    new THREE.PointsMaterial({ color: 0xcfd8ff, size: 0.7, sizeAttenuation: true, transparent: true, opacity: 0.85 })
  );
  scene.add(stars);
  fxCallbacks.push((t) => {
    stars.material.opacity = 0.7 + Math.sin(t * 0.7) * 0.15;
  });

  // Moon
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(4.5, 20, 20),
    new THREE.MeshBasicMaterial({ color: 0xf4f0dc })
  );
  moon.position.set(-70, 65, -80);
  scene.add(moon);
  const moonGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: canvasTex(128, (ctx, s) => {
        const g = ctx.createRadialGradient(s / 2, s / 2, 6, s / 2, s / 2, s / 2);
        g.addColorStop(0, 'rgba(244,240,220,0.9)');
        g.addColorStop(0.3, 'rgba(244,240,220,0.25)');
        g.addColorStop(1, 'rgba(244,240,220,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, s, s);
      }),
      transparent: true,
      depthWrite: false,
    })
  );
  moonGlow.scale.set(28, 28, 1);
  moonGlow.position.copy(moon.position);
  scene.add(moonGlow);
}

function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0x8ea0ff, 0x3a2f22, 0.55));
  const sun = new THREE.DirectionalLight(0xffe9c9, 1.5);
  sun.position.set(14, 26, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -30;
  sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 30;
  sun.shadow.camera.bottom = -30;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x7f9dff, 0.35);
  fill.position.set(-15, 12, -12);
  scene.add(fill);
}

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, ...opts });
}

const FLOOR_TEX = {
  living: () => woodTex('#a97c50', '#84603a'),
  kitchen: () => tileTex(),
  bedroom: () => carpetTex('#8d7ba8'),
  hoh: () => carpetTex('#a8904a'),
  diary: () => carpetTex('#7c3030'),
  backyard: () => grassTex(),
};

function buildHouse(scene) {
  const house = new THREE.Group();

  // Ground plate under everything
  const ground = new THREE.Mesh(new THREE.BoxGeometry(64, 1, 54), mat(0x1b1d28, { roughness: 1 }));
  ground.position.y = -0.5;
  ground.receiveShadow = true;
  house.add(ground);

  // Room floors with procedural textures
  for (const [name, r] of Object.entries(ROOMS)) {
    const tex = FLOOR_TEX[name]();
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(r.w, 0.24, r.d),
      new THREE.MeshStandardMaterial({ map: tex, roughness: name === 'kitchen' ? 0.5 : 0.9, metalness: 0.02 })
    );
    floor.position.set(r.x, 0.02, r.z);
    floor.receiveShadow = true;
    house.add(floor);
  }

  // Round rugs in living + bedroom
  for (const [x, z, color] of [[-6, 2.5, 0x7c5cbf], [7, -8.6, 0x8f6f2a]]) {
    const rug = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.05, 28), mat(color, { roughness: 1 }));
    rug.position.set(x, 0.17, z);
    rug.receiveShadow = true;
    house.add(rug);
  }

  // Walls with plaster texture + baseboards + top trim
  const wallTexMat = new THREE.MeshStandardMaterial({ map: plasterTex(), roughness: 0.95 });
  const baseMat = mat(0x5c5648, { roughness: 0.7 });
  const trimMat = mat(0xfaf6ea, { roughness: 0.6 });
  const wallH = 2.6;
  for (const w of WALLS) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w.w, wallH, w.d), wallTexMat);
    m.position.set(w.x, wallH / 2, w.z);
    m.castShadow = true;
    m.receiveShadow = true;
    house.add(m);
    const base = new THREE.Mesh(new THREE.BoxGeometry(w.w + 0.06, 0.3, w.d + 0.06), baseMat);
    base.position.set(w.x, 0.15, w.z);
    house.add(base);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(w.w + 0.08, 0.1, w.d + 0.08), trimMat);
    trim.position.set(w.x, wallH + 0.05, w.z);
    house.add(trim);
  }

  // BB eye logo on the north exterior wall (visible over the memory wall)
  const eye = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 3.2),
    new THREE.MeshBasicMaterial({ map: bbEyeTex(), transparent: false })
  );
  eye.position.set(4, 1.7, -11.75);
  house.add(eye);

  addLivingRoom(house);
  addKitchen(house);
  addBedroom(house);
  addHoh(house);
  addDiary(house);
  addBackyard(house);
  addRoomLights(house);

  scene.add(house);
}

function addTo(house) {
  return (mesh, x, y, z, ry = 0) => {
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    mesh.traverse?.((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    house.add(mesh);
    return mesh;
  };
}

function addLivingRoom(house) {
  const add = addTo(house);

  // Sofa: seat, back, arms, cushions
  const sofa = new THREE.Group();
  const sofaMat = mat(0x7c3aed, { roughness: 0.95 });
  const darkSofa = mat(0x6425d1, { roughness: 0.95 });
  const seat = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.55, 1.7), darkSofa);
  seat.position.y = 0.45;
  sofa.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(5.6, 1.1, 0.45), sofaMat);
  back.position.set(0, 0.95, -0.72);
  sofa.add(back);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.85, 1.7), sofaMat);
    arm.position.set(s * 3.0, 0.7, 0);
    sofa.add(arm);
  }
  for (let i = 0; i < 3; i++) {
    const cushion = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.28, 1.5), sofaMat);
    cushion.position.set(-1.85 + i * 1.85, 0.83, 0.05);
    sofa.add(cushion);
    const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.5, 0.25), mat([0xf5c542, 0xec4899, 0x38bdf8][i]));
    pillow.position.set(-1.85 + i * 1.85, 1.15, -0.55);
    pillow.rotation.x = -0.2;
    sofa.add(pillow);
  }
  add(sofa, -6, 0, 5.2, Math.PI);

  // Coffee table: glass top + wooden legs
  const table = new THREE.Group();
  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(1.05, 1.05, 0.09, 24),
    new THREE.MeshStandardMaterial({ color: 0xbcd6d8, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.7 })
  );
  top.position.y = 0.55;
  table.add(top);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.55, 8), mat(0x6b4e30));
    leg.position.set(Math.cos(a) * 0.7, 0.27, Math.sin(a) * 0.7);
    table.add(leg);
  }
  const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), mat(0xdc2626));
  bowl.rotation.x = Math.PI;
  bowl.position.y = 0.68;
  table.add(bowl);
  add(table, -6, 0, 2.5);

  // TV + stand on the north side, facing the sofa
  const tv = new THREE.Group();
  const stand = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 0.6), mat(0x3a2f26));
  stand.position.y = 0.25;
  tv.add(stand);
  const screen = new THREE.Mesh(
    new THREE.BoxGeometry(2.3, 1.25, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x0a0f1e, roughness: 0.15, metalness: 0.4, emissive: 0x16305a, emissiveIntensity: 0.7 })
  );
  screen.position.y = 1.25;
  tv.add(screen);
  const tvRef = screen;
  fxCallbacks.push((t) => {
    tvRef.material.emissiveIntensity = 0.55 + Math.sin(t * 3.1) * 0.12 + Math.sin(t * 7.7) * 0.06;
  });
  add(tv, -6, 0, -2.55);

  // Memory wall: gold-framed portrait tiles
  const wallPanel = new THREE.Group();
  const frameMat = mat(0xc7a63c, { metalness: 0.6, roughness: 0.3 });
  const colors = [0x3b82f6, 0xdc2626, 0xec4899, 0xf59e0b, 0x16a34a, 0x8b5cf6, 0x0ea5e9, 0xd946ef, 0xfafafa];
  for (let i = 0; i < 9; i++) {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.2, 0.06), frameMat);
    frame.position.set((i % 3 - 1) * 1.18, Math.floor(i / 3) * 1.32, 0);
    wallPanel.add(frame);
    const p = new THREE.Mesh(
      new THREE.BoxGeometry(0.86, 1.06, 0.09),
      new THREE.MeshStandardMaterial({ color: colors[i], emissive: colors[i], emissiveIntensity: 0.12, roughness: 0.4 })
    );
    p.position.copy(frame.position);
    p.position.z += 0.03;
    wallPanel.add(p);
  }
  add(wallPanel, -8.2, 1.0, -11.55);

  // Plants
  addPlant(house, -11.3, 6.2);
  addPlant(house, -11.3, -3.2);

  // Floor lamp by the sofa
  addFloorLamp(house, -9.8, 4.2);
}

function addPlant(house, x, z) {
  const add = addTo(house);
  const plant = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.2, 0.4, 12), mat(0xb0562e));
  pot.position.y = 0.2;
  plant.add(pot);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.7, 6), mat(0x3d6b2f));
  stem.position.y = 0.7;
  plant.add(stem);
  for (let i = 0; i < 5; i++) {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), mat(0x3f9142));
    const a = (i / 5) * Math.PI * 2;
    leaf.position.set(Math.cos(a) * 0.22, 1.05 + (i % 2) * 0.16, Math.sin(a) * 0.22);
    leaf.scale.set(1, 0.7, 1);
    plant.add(leaf);
  }
  add(plant, x, 0, z);
}

function addFloorLamp(house, x, z) {
  const add = addTo(house);
  const lamp = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, 2.0, 8), mat(0x2b2b33, { metalness: 0.5, roughness: 0.4 }));
  pole.position.y = 1.0;
  lamp.add(pole);
  const shade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.42, 0.45, 12, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xf3e2b8, emissive: 0xffd98c, emissiveIntensity: 0.9, side: THREE.DoubleSide })
  );
  shade.position.y = 2.05;
  lamp.add(shade);
  const light = new THREE.PointLight(0xffd9a0, 4, 8);
  light.position.y = 2.0;
  lamp.add(light);
  fxCallbacks.push((t) => {
    light.intensity = 3.8 + Math.sin(t * 1.3 + x) * 0.25;
  });
  add(lamp, x, 0, z);
}

function addKitchen(house) {
  const add = addTo(house);

  // Counter run with cabinet faces + steel top
  const counter = new THREE.Group();
  const cab = new THREE.Mesh(new THREE.BoxGeometry(7, 0.95, 1.4), mat(0x39465c));
  cab.position.y = 0.48;
  counter.add(cab);
  const ctop = new THREE.Mesh(
    new THREE.BoxGeometry(7.15, 0.12, 1.5),
    new THREE.MeshStandardMaterial({ color: 0xb9c2cc, metalness: 0.7, roughness: 0.25 })
  );
  ctop.position.y = 1.02;
  counter.add(ctop);
  for (let i = 0; i < 4; i++) {
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.05), mat(0xd7dde5, { metalness: 0.8, roughness: 0.2 }));
    handle.position.set(-2.6 + i * 1.7, 0.75, 0.74);
    counter.add(handle);
  }
  // Sink + faucet
  const sink = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.8), mat(0x8b98a5, { metalness: 0.8, roughness: 0.2 }));
  sink.position.set(1.6, 1.06, 0);
  counter.add(sink);
  const faucet = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.035, 8, 14, Math.PI), mat(0xcfd6dd, { metalness: 0.9, roughness: 0.15 }));
  faucet.position.set(1.6, 1.2, -0.35);
  counter.add(faucet);
  // Stove
  for (let i = 0; i < 4; i++) {
    const burner = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.03, 14), mat(0x1c2230));
    burner.position.set(-1.8 + (i % 2) * 0.6, 1.1, -0.25 + Math.floor(i / 2) * 0.5);
    counter.add(burner);
  }
  add(counter, 7, 0, 6.1);

  // Fridge in the corner
  const fridge = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.2, 1.0), mat(0xc9d2da, { metalness: 0.6, roughness: 0.3 }));
  body.position.y = 1.1;
  fridge.add(body);
  const fh = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.8, 0.06), mat(0x7c8794, { metalness: 0.8 }));
  fh.position.set(-0.52, 1.4, 0.45);
  fridge.add(fh);
  add(fridge, 11.3, 0, 6.0);

  // Island with stools
  const island = new THREE.Group();
  const ibase = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.9, 1.6), mat(0x4c5a70));
  ibase.position.y = 0.45;
  island.add(ibase);
  const itop = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.12, 1.8), mat(0xd8cbb2, { roughness: 0.35 }));
  itop.position.y = 0.98;
  island.add(itop);
  add(island, 7, 0, 2);
  for (const sx of [-1, 0, 1]) {
    const stool = new THREE.Group();
    const sSeat = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.1, 12), mat(0xdc2626, { roughness: 0.5 }));
    sSeat.position.y = 0.72;
    stool.add(sSeat);
    const sLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.7, 8), mat(0x2b2b33, { metalness: 0.6 }));
    sLeg.position.y = 0.36;
    stool.add(sLeg);
    add(stool, 7 + sx * 1.15, 0, 3.15);
  }

  // Dining table + chairs
  const table = new THREE.Group();
  const ttop = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 0.12, 22), woodMesh());
  ttop.position.y = 1.02;
  table.add(ttop);
  const tleg = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.3, 1.0, 10), mat(0x5c4326));
  tleg.position.y = 0.5;
  table.add(tleg);
  add(table, 10.5, 0, -1);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const chair = new THREE.Group();
    const cseat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.5), mat(0x8a6238));
    cseat.position.y = 0.55;
    chair.add(cseat);
    const cback = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.07), mat(0x8a6238));
    cback.position.set(0, 0.9, -0.22);
    chair.add(cback);
    for (const [lx, lz] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) {
      const cl = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.55, 6), mat(0x5c4326));
      cl.position.set(lx, 0.27, lz);
      chair.add(cl);
    }
    add(chair, 10.5 + Math.cos(a) * 2.0, 0, -1 + Math.sin(a) * 2.0, -a + Math.PI / 2);
  }

  function woodMesh() {
    return new THREE.MeshStandardMaterial({ map: woodTex('#b58a5c', '#8d6a42'), roughness: 0.6 });
  }
}

function addBedroom(house) {
  const add = addTo(house);
  const blanketColors = [0xef4444, 0x3b82f6, 0x22c55e, 0xeab308];
  for (let i = 0; i < 4; i++) {
    const bed = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.35, 3.1), mat(0x6b5844));
    frame.position.y = 0.22;
    bed.add(frame);
    const mattress = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.28, 2.9), mat(0xf2ead9));
    mattress.position.y = 0.5;
    bed.add(mattress);
    const blanket = new THREE.Mesh(new THREE.BoxGeometry(1.58, 0.14, 1.9), mat(blanketColors[i], { roughness: 1 }));
    blanket.position.set(0, 0.66, 0.5);
    bed.add(blanket);
    const pillow = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.22, 0.55), mat(0xffffff, { roughness: 1 }));
    pillow.position.set(0, 0.7, -1.05);
    pillow.rotation.x = -0.12;
    bed.add(pillow);
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.9, 0.12), mat(0x5b4936));
    head.position.set(0, 0.7, -1.52);
    bed.add(head);
    add(bed, -10.2 + i * 2.6, 0, -9.5);
  }
  // Shared nightstand + lamp glow
  const stand = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.55, 0.5), mat(0x6b5844));
  box.position.y = 0.28;
  stand.add(box);
  const lampBase = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.25, 8), mat(0x333a4a));
  lampBase.position.y = 0.66;
  stand.add(lampBase);
  const lampShade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.18, 0.2, 10, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xf3e2b8, emissive: 0xffd98c, emissiveIntensity: 0.8, side: THREE.DoubleSide })
  );
  lampShade.position.y = 0.85;
  stand.add(lampShade);
  add(stand, -11.3, 0, -7.2);
}

function addHoh(house) {
  const add = addTo(house);
  // Lux bed
  const bed = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.5, 3.7), mat(0x22262e));
  frame.position.y = 0.3;
  bed.add(frame);
  const mattress = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.35, 3.4), mat(0xe8e0ce));
  mattress.position.y = 0.72;
  bed.add(mattress);
  const duvet = new THREE.Mesh(
    new THREE.BoxGeometry(3.32, 0.16, 2.1),
    new THREE.MeshStandardMaterial({ color: 0xd9c17a, emissive: 0x332a10, emissiveIntensity: 0.25, roughness: 0.7 })
  );
  duvet.position.set(0, 0.92, 0.6);
  bed.add(duvet);
  for (const s of [-1, 1]) {
    const pillow = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.28, 0.6), mat(0xfff8e8));
    pillow.position.set(s * 0.8, 0.95, -1.2);
    pillow.rotation.x = -0.15;
    bed.add(pillow);
  }
  const head = new THREE.Mesh(new THREE.BoxGeometry(3.5, 1.3, 0.15), mat(0x1a1e26, { roughness: 0.4, metalness: 0.2 }));
  head.position.set(0, 1.0, -1.85);
  bed.add(head);
  add(bed, 7, 0, -9.3);

  // Neon HoH ring on the wall
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.3, 0.07, 10, 44),
    new THREE.MeshBasicMaterial({ color: 0xffd76a })
  );
  ring.position.set(7, 2.1, -11.6);
  house.add(ring);
  const ringGlow = new THREE.PointLight(0xffd76a, 5, 9);
  ringGlow.position.set(7, 2.1, -11.0);
  house.add(ringGlow);
  fxCallbacks.push((t) => {
    ringGlow.intensity = 4.5 + Math.sin(t * 2.2) * 0.8;
  });

  // Snack basket
  const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.28, 0.3, 10), mat(0x9a6f3f));
  add(basket, 4.4, 0.15, -6.2);
}

function addDiary(house) {
  const add = addTo(house);
  // Iconic chair: tufted red with gold trim
  const chair = new THREE.Group();
  const redMat = mat(0xb91c1c, { emissive: 0x400808, emissiveIntensity: 0.35, roughness: 0.6 });
  const goldMat = mat(0xc7a63c, { metalness: 0.6, roughness: 0.3 });
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.45, 1.3), redMat);
  seat.position.y = 0.5;
  chair.add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.7, 0.4), redMat);
  back.position.set(0, 1.15, -0.6);
  chair.add(back);
  for (let i = 0; i < 6; i++) {
    const button = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), goldMat);
    button.position.set(-0.4 + (i % 3) * 0.4, 0.95 + Math.floor(i / 3) * 0.5, -0.38);
    chair.add(button);
  }
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.65, 1.3), redMat);
    arm.position.set(s * 0.9, 0.62, 0);
    chair.add(arm);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.08, 1.32), goldMat);
    cap.position.set(s * 0.9, 0.97, 0);
    chair.add(cap);
  }
  add(chair, 15, 0, -9.5);

  // Camera "lens" on the wall the chair faces
  const lens = new THREE.Group();
  const lensBody = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.3, 14), mat(0x14161f));
  lensBody.rotation.x = Math.PI / 2;
  lens.add(lensBody);
  const glass = new THREE.Mesh(
    new THREE.CircleGeometry(0.16, 14),
    new THREE.MeshStandardMaterial({ color: 0x0a2a4a, emissive: 0x1a66aa, emissiveIntensity: 0.9, roughness: 0.1 })
  );
  glass.position.z = 0.16;
  lens.add(glass);
  add(lens, 15, 1.8, -5.0, Math.PI);

  const drLight = new THREE.PointLight(0xff6a6a, 6, 8);
  drLight.position.set(15, 2.4, -8.5);
  house.add(drLight);
  fxCallbacks.push((t) => {
    drLight.intensity = 5.5 + Math.sin(t * 1.7) * 0.7;
  });
}

function addBackyard(house) {
  const add = addTo(house);

  // Pool: animated water + deck rim
  const rim = new THREE.Mesh(new THREE.BoxGeometry(POOL.w + 0.9, 0.22, POOL.d + 0.9), mat(0xd9d3c5, { roughness: 0.6 }));
  rim.position.set(POOL.x, 0.11, POOL.z);
  house.add(rim);
  const waterTex = canvasTex(128, (ctx, s) => {
    ctx.fillStyle = '#2fa8d8';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 26; i++) {
      ctx.strokeStyle = `rgba(255,255,255,${0.10 + Math.random() * 0.14})`;
      ctx.lineWidth = 1.5 + Math.random() * 1.5;
      const y = Math.random() * s;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(s * 0.3, y + 8, s * 0.6, y - 8, s, y + 3);
      ctx.stroke();
    }
  }, 2, 1.4);
  const water = new THREE.Mesh(
    new THREE.BoxGeometry(POOL.w, 0.24, POOL.d),
    new THREE.MeshStandardMaterial({
      map: waterTex, color: 0x9adfff, roughness: 0.1, metalness: 0.25,
      emissive: 0x0b4b66, emissiveIntensity: 0.5, transparent: true, opacity: 0.92,
    })
  );
  water.position.set(POOL.x, 0.12, POOL.z);
  house.add(water);
  fxCallbacks.push((t) => {
    waterTex.offset.x = t * 0.03;
    waterTex.offset.y = Math.sin(t * 0.6) * 0.05;
  });
  const poolGlow = new THREE.PointLight(0x54c8f0, 4, 9);
  poolGlow.position.set(POOL.x, 0.8, POOL.z);
  house.add(poolGlow);

  // Loungers + umbrella west of the pool
  for (const [z] of [[11.5], [14.8]]) {
    const lounger = new THREE.Group();
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.12, 2.2), mat(0xf59e0b, { roughness: 0.9 }));
    seat.position.y = 0.35;
    lounger.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.12, 0.9), mat(0xf59e0b, { roughness: 0.9 }));
    back.position.set(0, 0.62, -1.35);
    back.rotation.x = -0.7;
    lounger.add(back);
    for (const [lx, lz] of [[-0.4, -0.8], [0.4, -0.8], [-0.4, 0.8], [0.4, 0.8]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.35, 6), mat(0xffffff));
      leg.position.set(lx, 0.17, lz);
      lounger.add(leg);
    }
    add(lounger, -14.2, 0, z);
  }
  const umb = new THREE.Group();
  const upole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 8), mat(0xe8e2d5));
  upole.position.y = 1.3;
  umb.add(upole);
  const canopy = new THREE.Mesh(new THREE.ConeGeometry(1.5, 0.6, 10), mat(0xdc2626, { roughness: 0.8 }));
  canopy.position.y = 2.7;
  umb.add(canopy);
  add(umb, -14.2, 0, 13.2);

  // Comp stage: metallic platform + gold trim + podiums
  const stage = new THREE.Group();
  const plat = new THREE.Mesh(
    new THREE.CylinderGeometry(3.3, 3.7, 0.6, 8),
    new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0x3d2703, emissiveIntensity: 0.3, roughness: 0.4, metalness: 0.3 })
  );
  plat.position.y = 0.3;
  stage.add(plat);
  const stageRing = new THREE.Mesh(new THREE.TorusGeometry(3.35, 0.06, 8, 32), mat(0xffd76a, { metalness: 0.7, roughness: 0.2 }));
  stageRing.rotation.x = Math.PI / 2;
  stageRing.position.y = 0.62;
  stage.add(stageRing);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const podium = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.2, 0.7), mat(0x2c3a52, { roughness: 0.5, metalness: 0.2 }));
    podium.position.set(Math.cos(a) * 2.6, 0.9, Math.sin(a) * 2.6);
    stage.add(podium);
    const podTop = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.06, 0.75), mat(0xffd76a, { metalness: 0.6, roughness: 0.3 }));
    podTop.position.set(Math.cos(a) * 2.6, 1.53, Math.sin(a) * 2.6);
    stage.add(podTop);
  }
  add(stage, 8, 0, 13.5);
  const stageLight = new THREE.PointLight(0xffc46a, 5, 12);
  stageLight.position.set(8, 3.2, 13.5);
  house.add(stageLight);

  // Hot tub with steam-ish glow
  const tub = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, 0.9, 16), mat(0x8d6e63, { roughness: 0.8 }));
  add(tub, -1, 0.45, 15.5);
  const tubWater = new THREE.Mesh(
    new THREE.CylinderGeometry(1.3, 1.3, 0.1, 16),
    new THREE.MeshStandardMaterial({ color: 0x67e8f9, emissive: 0x155e6b, emissiveIntensity: 0.6, roughness: 0.15 })
  );
  tubWater.position.set(-1, 0.88, 15.5);
  house.add(tubWater);
  fxCallbacks.push((t) => {
    tubWater.position.y = 0.88 + Math.sin(t * 2.4) * 0.015;
  });

  // Palms
  for (const [x, z] of [[-15.5, 16], [15.5, 16], [0, 17.3]]) {
    const palm = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.3, 3.2, 8), mat(0x7a5b3a, { roughness: 1 }));
    trunk.position.y = 1.6;
    trunk.rotation.z = (Math.random() - 0.5) * 0.15;
    palm.add(trunk);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const frond = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.9, 6), mat(0x3f9142, { roughness: 1 }));
      frond.position.set(Math.cos(a) * 0.85, 3.3, Math.sin(a) * 0.85);
      frond.rotation.z = Math.cos(a) * 1.25;
      frond.rotation.x = Math.sin(a) * 1.25;
      palm.add(frond);
    }
    const coco = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 8), mat(0x4f7a3a));
    coco.position.y = 3.25;
    palm.add(coco);
    add(palm, x, 0, z);
  }

  // Fence around the yard + string lights
  const fenceMat = mat(0x4a4640, { roughness: 0.9 });
  for (let x = -16.5; x <= 16.5; x += 1.5) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.7, 0.14), fenceMat);
    post.position.set(x, 0.85, 17.9);
    house.add(post);
  }
  const rail = new THREE.Mesh(new THREE.BoxGeometry(34, 0.12, 0.12), fenceMat);
  rail.position.set(0, 1.5, 17.9);
  house.add(rail);

  // String lights: posts + sagging bulb runs
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffdf9e });
  for (const x of [-16, 16]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 3.4, 6), mat(0x333333));
    post.position.set(x, 1.7, 9);
    house.add(post);
    const glow = new THREE.PointLight(0xffd9a0, 3.2, 12);
    glow.position.set(x, 3.4, 9);
    house.add(glow);
  }
  const bulbCount = 14;
  for (let i = 0; i <= bulbCount; i++) {
    const f = i / bulbCount;
    const x = -16 + f * 32;
    const sag = Math.sin(f * Math.PI) * 0.8;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 6), bulbMat);
    bulb.position.set(x, 3.4 - sag, 9);
    house.add(bulb);
  }
}

function addRoomLights(house) {
  const lights = [
    [-6, 2, 0xffe6c4, 4.5, 14],   // living
    [7, 2, 0xd7f0ff, 4, 14],      // kitchen
    [-6, -8, 0xc9b8ff, 3, 12],    // bedroom
    [7, -8, 0xffe2a8, 3.5, 12],   // hoh
  ];
  for (const [x, z, color, intensity, dist] of lights) {
    const l = new THREE.PointLight(color, intensity, dist);
    l.position.set(x, 2.6, z);
    house.add(l);
  }
}
