// Interactive competition mini-games. Each returns a Promise<number 0-100>
// (the player's performance score). Rendered as DOM overlays.

export { COMP_TYPES, COMP_NAMES, randomCompType } from './competition-catalog.js';
import { memoryComp, orderComp, circuitComp } from './new-comps.js';

export function runComp(type, root) {
  if (type === 'timing') return timingComp(root);
  if (type === 'count' || type === 'memory') return memoryComp(root); // older online turns migrate safely
  if (type === 'order') return orderComp(root);
  if (type === 'circuit') return circuitComp(root);
  return reactionComp(root);
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

// --- Timing: stop the slider inside the target zone, 3 rounds -----------------

function timingComp(root) {
  return new Promise((resolve) => {
    const box = el('div', 'comp-box');
    box.append(el('h2', '', 'PRESSURE COOKER'));
    box.append(el('p', 'comp-desc', 'Stop the needle inside the gold zone. Three rounds. Click or press SPACE.'));
    const track = el('div', 'timing-track');
    const zone = el('div', 'timing-zone');
    const needle = el('div', 'timing-needle');
    track.append(zone, needle);
    const status = el('p', 'comp-status', 'Round 1 of 3');
    box.append(track, status);
    root.append(box);

    let round = 0, total = 0, pos = 0, dir = 1, speed = 1.35, raf = null, waiting = false;
    let zoneStart = 0.4, zoneW = 0.16;

    function setZone() {
      zoneW = 0.17 - round * 0.045;
      zoneStart = 0.15 + Math.random() * (0.7 - zoneW);
      zone.style.left = zoneStart * 100 + '%';
      zone.style.width = zoneW * 100 + '%';
      speed = 1.3 + round * 0.5;
    }
    setZone();

    function tick() {
      pos += dir * speed * 0.012;
      if (pos >= 1) { pos = 1; dir = -1; }
      if (pos <= 0) { pos = 0; dir = 1; }
      needle.style.left = pos * 100 + '%';
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    function stop() {
      if (waiting) return;
      waiting = true;
      cancelAnimationFrame(raf);
      const center = zoneStart + zoneW / 2;
      const dist = Math.abs(pos - center);
      const inZone = pos >= zoneStart && pos <= zoneStart + zoneW;
      const score = inZone ? 100 - (dist / (zoneW / 2)) * 25 : Math.max(0, 55 - dist * 220);
      total += score;
      status.textContent = inZone ? `Round ${round + 1}: NAILED IT (+${Math.round(score)})` : `Round ${round + 1}: missed (+${Math.round(score)})`;
      round++;
      setTimeout(() => {
        if (round >= 3) {
          cleanup();
          resolve(Math.round(total / 3));
        } else {
          status.textContent = `Round ${round + 1} of 3`;
          setZone();
          pos = 0; dir = 1;
          waiting = false;
          raf = requestAnimationFrame(tick);
        }
      }, 800);
    }

    function onKey(e) {
      if (e.code === 'Space') { e.preventDefault(); stop(); }
    }
    box.addEventListener('pointerdown', stop);
    window.addEventListener('keydown', onKey);
    function cleanup() {
      window.removeEventListener('keydown', onKey);
      box.remove();
    }
  });
}


// --- Reaction: click targets as they appear -----------------------------------

function reactionComp(root) {
  return new Promise((resolve) => {
    const box = el('div', 'comp-box comp-wide');
    box.append(el('h2', '', 'SNAP JUDGMENT'));
    box.append(el('p', 'comp-desc', 'Click the gold keys fast. Avoid the red Xs. 20 seconds.'));
    const field = el('div', 'reaction-field');
    const status = el('p', 'comp-status', '');
    box.append(field, status);
    root.append(box);

    let score = 0, hits = 0, misses = 0, timeLeft = 20, running = true;

    const timer = setInterval(() => {
      timeLeft--;
      status.textContent = `Score ${score} — ${timeLeft}s`;
      if (timeLeft <= 0) finish();
    }, 1000);

    function spawn() {
      if (!running) return;
      const bad = Math.random() < 0.3;
      const t = el('div', 'reaction-target' + (bad ? ' bad' : ''), bad ? '✕' : '🔑');
      const px = Math.random(), py = Math.random();
      t.style.left = `calc(${px * 100}% - ${px * 78}px + 8px)`;
      t.style.top = `calc(${py * 100}% - ${py * 78}px + 8px)`;
      field.append(t);
      const ttl = setTimeout(() => {
        if (!bad) misses++;
        t.remove();
      }, 900 + Math.random() * 500);
      t.addEventListener('pointerdown', () => {
        clearTimeout(ttl);
        if (bad) { score = Math.max(0, score - 8); } else { score += 10; hits++; }
        status.textContent = `Score ${score} — ${timeLeft}s`;
        t.remove();
      });
      setTimeout(spawn, 350 + Math.random() * 450);
    }
    spawn();
    status.textContent = `Score 0 — 20s`;

    function finish() {
      running = false;
      clearInterval(timer);
      setTimeout(() => {
        box.remove();
        resolve(Math.min(100, Math.round(score * 0.55)));
      }, 600);
    }
  });
}
