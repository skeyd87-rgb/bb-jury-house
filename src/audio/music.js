// Adaptive WebAudio music: no samples, all synthesized.
// Moods: 'house' (ambient), 'comp' (driving), 'tension' (noms/eviction),
// 'finale' (jury reveal), plus one-shot stings.

let ctx = null;
let master = null;
let current = null; // { mood, stop() }
let enabled = true;

function ac() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.16;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function setMusicEnabled(on) {
  enabled = on;
  if (!on) stopMusic();
}

export function stopMusic() {
  if (current) {
    current.stop();
    current = null;
  }
}

export function setMood(mood) {
  if (!enabled) return;
  if (current && current.mood === mood) return;
  stopMusic();
  const a = ac();
  if (mood === 'house') current = loopScheduler(a, houseBar, 2.4, mood);
  else if (mood === 'comp') current = loopScheduler(a, compBar, 1.85, mood);
  else if (mood === 'tension') current = loopScheduler(a, tensionBar, 3.2, mood);
  else if (mood === 'finale') current = loopScheduler(a, finaleBar, 2.8, mood);
}

// Generic bar-based scheduler: fn(ctx, when, out) writes one bar of audio.
function loopScheduler(a, barFn, barLen, mood) {
  const out = a.createGain();
  out.gain.value = 0;
  out.connect(master);
  out.gain.linearRampToValueAtTime(1, a.currentTime + 1.2);
  let next = a.currentTime + 0.05;
  let alive = true;
  let barIdx = 0;
  function schedule() {
    if (!alive) return;
    while (next < a.currentTime + 3) {
      barFn(a, next, out, barIdx++);
      next += barLen;
    }
    timer = setTimeout(schedule, 500);
  }
  let timer = null;
  schedule();
  return {
    mood,
    stop() {
      alive = false;
      clearTimeout(timer);
      out.gain.linearRampToValueAtTime(0, a.currentTime + 0.8);
      setTimeout(() => out.disconnect(), 1000);
    },
  };
}

function tone(a, out, { freq, when, dur, type = 'sine', gain = 0.5, attack = 0.02, release = 0.3, detune = 0 }) {
  const o = a.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.detune.value = detune;
  const g = a.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(gain, when + attack);
  g.gain.setValueAtTime(gain, when + Math.max(attack, dur - release));
  g.gain.linearRampToValueAtTime(0.0001, when + dur);
  o.connect(g).connect(out);
  o.start(when);
  o.stop(when + dur + 0.05);
}

function noise(a, out, { when, dur, gain = 0.2, freq = 800 }) {
  const len = Math.ceil(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(out);
  src.start(when);
}

// chords in Hz
const Am = [220, 261.63, 329.63];
const F = [174.61, 220, 261.63];
const C = [130.81, 164.81, 196];
const G = [196, 246.94, 293.66];
const Dm = [146.83, 174.61, 220];
const E = [164.81, 207.65, 246.94];

// --- House: mellow lounge — soft chords + sparse pluck melody
function houseBar(a, when, out, i) {
  const prog = [Am, F, C, G];
  const chord = prog[i % 4];
  for (const f of chord) {
    tone(a, out, { freq: f, when, dur: 2.3, type: 'triangle', gain: 0.10, attack: 0.4, release: 1.0 });
  }
  // pluck melody notes from pentatonic
  const penta = [440, 523.25, 587.33, 659.25, 783.99];
  for (let k = 0; k < 3; k++) {
    if (Math.random() < 0.6) {
      tone(a, out, {
        freq: penta[Math.floor(Math.random() * penta.length)],
        when: when + 0.3 + k * 0.7,
        dur: 0.5, type: 'sine', gain: 0.12, attack: 0.01, release: 0.4,
      });
    }
  }
  // soft kick pulse
  tone(a, out, { freq: 55, when, dur: 0.25, type: 'sine', gain: 0.25, attack: 0.005, release: 0.2 });
  tone(a, out, { freq: 55, when: when + 1.2, dur: 0.25, type: 'sine', gain: 0.18, attack: 0.005, release: 0.2 });
}

// --- Comp: driving pulse
function compBar(a, when, out, i) {
  const prog = [Am, Am, F, G];
  const chord = prog[i % 4];
  const step = 1.85 / 8;
  for (let k = 0; k < 8; k++) {
    const f = chord[k % chord.length] * (k % 4 === 3 ? 2 : 1);
    tone(a, out, { freq: f, when: when + k * step, dur: step * 0.9, type: 'sawtooth', gain: 0.07, attack: 0.01, release: 0.08 });
  }
  for (let k = 0; k < 4; k++) {
    tone(a, out, { freq: 60, when: when + k * (1.85 / 4), dur: 0.18, type: 'sine', gain: 0.3, attack: 0.004, release: 0.14 });
  }
  noise(a, out, { when: when + 1.85 / 2, dur: 0.12, gain: 0.12, freq: 3000 }); // snare-ish
}

// --- Tension: low drones + heartbeat
function tensionBar(a, when, out, i) {
  const root = i % 2 === 0 ? 110 : 103.83;
  tone(a, out, { freq: root, when, dur: 3.1, type: 'sawtooth', gain: 0.06, attack: 0.8, release: 1.2 });
  tone(a, out, { freq: root * 1.5, when, dur: 3.1, type: 'sine', gain: 0.05, attack: 1.0, release: 1.2, detune: 8 });
  // heartbeat
  tone(a, out, { freq: 48, when: when + 0.2, dur: 0.16, type: 'sine', gain: 0.35, attack: 0.004, release: 0.12 });
  tone(a, out, { freq: 44, when: when + 0.55, dur: 0.14, type: 'sine', gain: 0.25, attack: 0.004, release: 0.1 });
  // random high shimmer
  if (Math.random() < 0.5) {
    tone(a, out, { freq: 880 + Math.random() * 440, when: when + Math.random() * 2, dur: 1.4, type: 'sine', gain: 0.03, attack: 0.6, release: 0.7 });
  }
}

// --- Finale: big warm swells
function finaleBar(a, when, out, i) {
  const prog = [C, G, Am, F];
  const chord = prog[i % 4];
  for (const f of chord) {
    tone(a, out, { freq: f, when, dur: 2.7, type: 'triangle', gain: 0.11, attack: 0.5, release: 1.2 });
    tone(a, out, { freq: f * 2, when, dur: 2.7, type: 'sine', gain: 0.05, attack: 0.7, release: 1.2, detune: 6 });
  }
  tone(a, out, { freq: chord[0] / 2, when, dur: 2.7, type: 'sine', gain: 0.18, attack: 0.3, release: 1.0 });
}

// --- One-shot stings ---------------------------------------------------------

export function sting(kind) {
  if (!enabled) return;
  const a = ac();
  const when = a.currentTime + 0.02;
  if (kind === 'reveal') {
    // dramatic BB "dun-dun"
    tone(a, master, { freq: 98, when, dur: 0.5, type: 'sawtooth', gain: 0.25, attack: 0.01, release: 0.35 });
    tone(a, master, { freq: 92.5, when: when + 0.45, dur: 1.2, type: 'sawtooth', gain: 0.28, attack: 0.01, release: 0.9 });
    noise(a, master, { when, dur: 0.4, gain: 0.1, freq: 500 });
  } else if (kind === 'win') {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => tone(a, master, { freq: f, when: when + i * 0.14, dur: 0.8, type: 'triangle', gain: 0.2, attack: 0.01, release: 0.5 }));
  } else if (kind === 'lose') {
    tone(a, master, { freq: 220, when, dur: 0.5, type: 'sine', gain: 0.2, attack: 0.01, release: 0.3 });
    tone(a, master, { freq: 196, when: when + 0.4, dur: 0.7, type: 'sine', gain: 0.2, attack: 0.01, release: 0.5 });
    tone(a, master, { freq: 146.83, when: when + 0.9, dur: 1.2, type: 'sine', gain: 0.22, attack: 0.01, release: 0.9 });
  } else if (kind === 'chime') {
    tone(a, master, { freq: 880, when, dur: 0.35, type: 'sine', gain: 0.15, attack: 0.005, release: 0.25 });
    tone(a, master, { freq: 1174.66, when: when + 0.1, dur: 0.4, type: 'sine', gain: 0.12, attack: 0.005, release: 0.3 });
  } else if (kind === 'knock') {
    noise(a, master, { when, dur: 0.08, gain: 0.35, freq: 250 });
    noise(a, master, { when: when + 0.18, dur: 0.08, gain: 0.3, freq: 220 });
  }
}
