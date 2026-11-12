// Adaptive WebAudio music: no samples, all synthesized.
//
// Each moment of the show has its own cue, so the music tells you what kind of
// moment it is before you read a word:
//   house     free roam            mellow lounge
//   comp      competitions         fast, four-on-the-floor, driving
//   tension   nominations, veto    low drone and a heartbeat
//   eviction  the live vote        slow, minor, timpani and a ticking clock
//   victory   you won something    bright, bouncy, major
//   finale    jury and the crown   big warm swells
// plus one-shot stings layered over whatever is playing.

let ctx = null;
let master = null;
let current = null; // { mood, stop() }
let enabled = true;

function ac() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.16;
    // The busier cues stack a dozen voices; a limiter keeps the sum from
    // clipping on a phone speaker.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 10;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.2;
    master.connect(limiter).connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function setMusicEnabled(on) {
  enabled = on;
  if (!on) stopMusic();
}

export function isMusicEnabled() {
  return enabled;
}

export function stopMusic() {
  if (current) {
    current.stop();
    current = null;
  }
}

const MOODS = {
  house: [houseBar, 2.4],
  comp: [compBar, 60 / 138 * 4],
  tension: [tensionBar, 3.2],
  eviction: [evictionBar, 4.0],
  victory: [victoryBar, 2.0],
  finale: [finaleBar, 2.8],
};

export function setMood(mood) {
  if (!enabled) return;
  if (current && current.mood === mood) return;
  const def = MOODS[mood];
  if (!def) return;
  stopMusic();
  current = loopScheduler(ac(), def[0], def[1], mood);
}

// Generic bar-based scheduler: fn(ctx, when, out, barIndex) writes one bar.
function loopScheduler(a, barFn, barLen, mood) {
  const out = a.createGain();
  out.gain.value = 0;
  out.connect(master);
  out.gain.linearRampToValueAtTime(1, a.currentTime + (mood === 'comp' || mood === 'victory' ? 0.25 : 1.2));
  let next = a.currentTime + 0.05;
  let alive = true;
  let barIdx = 0;
  let timer = null;
  function schedule() {
    if (!alive) return;
    while (next < a.currentTime + 3) {
      barFn(a, next, out, barIdx++);
      next += barLen;
    }
    timer = setTimeout(schedule, 500);
  }
  schedule();
  return {
    mood,
    stop() {
      alive = false;
      clearTimeout(timer);
      out.gain.cancelScheduledValues(a.currentTime);
      out.gain.setValueAtTime(out.gain.value, a.currentTime);
      out.gain.linearRampToValueAtTime(0, a.currentTime + 0.6);
      setTimeout(() => out.disconnect(), 900);
    },
  };
}

function tone(a, out, { freq, when, dur, type = 'sine', gain = 0.5, attack = 0.02, release = 0.3, detune = 0, slideTo = 0 }) {
  const o = a.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, when);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, when + dur);
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

function noise(a, out, { when, dur, gain = 0.2, freq = 800, type = 'bandpass', swell = false }) {
  const len = Math.ceil(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  // Decaying by default (a hit); swelling for a cymbal roll into a downbeat.
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (swell ? (i / len) ** 2 : 1 - i / len);
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(out);
  src.start(when);
}

// Drums. A kick is a sine that drops in pitch; that drop is the "thump".
const kick = (a, out, when, gain = 0.5, from = 150, to = 45, dur = 0.22) =>
  tone(a, out, { freq: from, slideTo: to, when, dur, type: 'sine', gain, attack: 0.003, release: dur * 0.7 });
const hat = (a, out, when, gain = 0.06) => noise(a, out, { when, dur: 0.05, gain, freq: 7000, type: 'highpass' });
const clap = (a, out, when, gain = 0.16) => {
  noise(a, out, { when, dur: 0.11, gain, freq: 1700 });
  noise(a, out, { when: when + 0.012, dur: 0.09, gain: gain * 0.7, freq: 2300 });
};

// chords in Hz
const Am = [220, 261.63, 329.63];
const F = [174.61, 220, 261.63];
const C = [130.81, 164.81, 196];
const G = [196, 246.94, 293.66];
const Em = [164.81, 196, 246.94];
const D = [146.83, 185, 220];
const Dm = [146.83, 174.61, 220];
const Bb = [116.54, 146.83, 174.61];
const Gm = [98, 116.54, 146.83];
const A = [110, 138.59, 164.81];

// --- House: mellow lounge — soft chords + sparse pluck melody
function houseBar(a, when, out, i) {
  const prog = [Am, F, C, G];
  const chord = prog[i % 4];
  for (const f of chord) {
    tone(a, out, { freq: f, when, dur: 2.3, type: 'triangle', gain: 0.10, attack: 0.4, release: 1.0 });
  }
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
  tone(a, out, { freq: 55, when, dur: 0.25, type: 'sine', gain: 0.25, attack: 0.005, release: 0.2 });
  tone(a, out, { freq: 55, when: when + 1.2, dur: 0.25, type: 'sine', gain: 0.18, attack: 0.005, release: 0.2 });
}

// --- Comp: 138 bpm. Four-on-the-floor kick, claps on two and four, hats on
// the off-beats, an octave-jumping bass and a sixteenth-note arpeggio. Every
// fourth bar a noise riser pulls into the next phrase.
function compBar(a, when, out, i) {
  const beat = 60 / 138;
  const prog = [Em, C, G, D];
  const chord = prog[i % 4];
  const root = chord[0] / 2;
  for (let b = 0; b < 4; b++) {
    kick(a, out, when + b * beat, 0.5);
    hat(a, out, when + b * beat + beat / 2, 0.07);
    if (i % 2) hat(a, out, when + b * beat + beat * 0.75, 0.035);
    if (b % 2) clap(a, out, when + b * beat, 0.15);
  }
  for (let k = 0; k < 8; k++) {
    // bass: root, root, octave, root ...
    const f = root * (k % 4 === 2 ? 2 : 1);
    tone(a, out, { freq: f, when: when + k * beat / 2, dur: beat * 0.42, type: 'sawtooth', gain: 0.12, attack: 0.005, release: 0.06 });
  }
  const up = [0, 1, 2, 1, 2, 0, 1, 2, 0, 1, 2, 1, 2, 1, 0, 2];
  for (let k = 0; k < 16; k++) {
    const f = chord[up[(k + i * 3) % 16]] * (k % 8 >= 4 ? 4 : 2);
    tone(a, out, { freq: f, when: when + k * beat / 4, dur: beat * 0.2, type: 'square', gain: 0.035, attack: 0.004, release: 0.05 });
  }
  // stabs on the "and" of two and of four give it the game-show bounce
  for (const b of [1.5, 3.5]) {
    for (const f of chord) tone(a, out, { freq: f * 2, when: when + b * beat, dur: beat * 0.35, type: 'sawtooth', gain: 0.04, attack: 0.004, release: 0.1 });
  }
  if (i % 4 === 3) noise(a, out, { when: when + beat * 2, dur: beat * 2, gain: 0.09, freq: 5000, type: 'highpass', swell: true });
}

// --- Tension: low drones + heartbeat
function tensionBar(a, when, out, i) {
  const root = i % 2 === 0 ? 110 : 103.83;
  tone(a, out, { freq: root, when, dur: 3.1, type: 'sawtooth', gain: 0.06, attack: 0.8, release: 1.2 });
  tone(a, out, { freq: root * 1.5, when, dur: 3.1, type: 'sine', gain: 0.05, attack: 1.0, release: 1.2, detune: 8 });
  tone(a, out, { freq: 48, when: when + 0.2, dur: 0.16, type: 'sine', gain: 0.35, attack: 0.004, release: 0.12 });
  tone(a, out, { freq: 44, when: when + 0.55, dur: 0.14, type: 'sine', gain: 0.25, attack: 0.004, release: 0.1 });
  if (Math.random() < 0.5) {
    tone(a, out, { freq: 880 + Math.random() * 440, when: when + Math.random() * 2, dur: 1.4, type: 'sine', gain: 0.03, attack: 0.6, release: 0.7 });
  }
}

// --- Eviction: the live vote. D minor, slow. Detuned low strings swell under
// a clock that ticks once a second; timpani land on one and three with a
// pickup into the next bar; a high tremolo creeps in on the back half of each
// phrase and a cymbal roll carries the last bar over.
function evictionBar(a, when, out, i) {
  const prog = [Dm, Bb, Gm, A];
  const chord = prog[i % 4];
  for (const f of chord) {
    tone(a, out, { freq: f, when, dur: 3.95, type: 'sawtooth', gain: 0.05, attack: 1.2, release: 1.4, detune: -7 });
    tone(a, out, { freq: f, when, dur: 3.95, type: 'sawtooth', gain: 0.05, attack: 1.2, release: 1.4, detune: 7 });
  }
  tone(a, out, { freq: chord[0] / 2, when, dur: 3.95, type: 'sine', gain: 0.2, attack: 0.5, release: 1.2 });
  // timpani
  kick(a, out, when, 0.55, 95, 52, 0.7);
  kick(a, out, when + 2, 0.4, 95, 52, 0.6);
  kick(a, out, when + 3.5, 0.3, 110, 60, 0.35);
  kick(a, out, when + 3.75, 0.36, 110, 60, 0.35);
  // the clock
  for (let s = 0; s < 4; s++) {
    tone(a, out, { freq: s % 2 ? 1568 : 2093, when: when + s + 0.5, dur: 0.05, type: 'square', gain: 0.035, attack: 0.002, release: 0.03 });
  }
  // tremolo strings, second half of the phrase
  if (i % 4 >= 2) {
    const top = chord[2] * 2;
    for (let k = 0; k < 32; k++) {
      tone(a, out, { freq: top, when: when + k * 0.125, dur: 0.11, type: 'sawtooth', gain: 0.012 + (k / 32) * 0.02, attack: 0.02, release: 0.05 });
    }
  }
  if (i % 4 === 3) noise(a, out, { when: when + 1.5, dur: 2.5, gain: 0.1, freq: 6000, type: 'highpass', swell: true });
}

// --- Victory: you won. C major at 120, bright and bouncy: a hopping bass,
// off-beat chord stabs, claps and a tambourine, and a tune that actually
// goes somewhere over four bars.
const VICTORY_TUNE = [
  [523.25, 659.25, 783.99, 659.25, 783.99, 1046.5, 0, 783.99],
  [698.46, 880, 1046.5, 880, 698.46, 880, 0, 698.46],
  [783.99, 987.77, 1174.66, 987.77, 783.99, 987.77, 1174.66, 1318.5],
  [1046.5, 0, 783.99, 659.25, 783.99, 1046.5, 0, 0],
];
function victoryBar(a, when, out, i) {
  const beat = 0.5;
  const prog = [C, F, G, C];
  const chord = prog[i % 4];
  const root = chord[0] / 2;
  for (let b = 0; b < 4; b++) {
    if (b % 2 === 0) kick(a, out, when + b * beat, 0.42);
    else clap(a, out, when + b * beat, 0.13);
    hat(a, out, when + b * beat + beat / 2, 0.05);            // tambourine on the off-beat
    tone(a, out, { freq: root * (b % 2 ? 1.5 : 1), when: when + b * beat, dur: beat * 0.6, type: 'triangle', gain: 0.2, attack: 0.006, release: 0.15 });
    for (const f of chord) {                                   // stab on the "and"
      tone(a, out, { freq: f * 2, when: when + b * beat + beat / 2, dur: beat * 0.35, type: 'triangle', gain: 0.06, attack: 0.005, release: 0.12 });
    }
  }
  const tune = VICTORY_TUNE[i % 4];
  tune.forEach((f, k) => {
    if (!f) return;
    tone(a, out, { freq: f, when: when + k * beat / 2, dur: beat * 0.42, type: 'square', gain: 0.045, attack: 0.005, release: 0.12 });
    tone(a, out, { freq: f * 2, when: when + k * beat / 2, dur: beat * 0.3, type: 'sine', gain: 0.03, attack: 0.005, release: 0.1 });
  });
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
    // dramatic "dun-dun"
    tone(a, master, { freq: 98, when, dur: 0.5, type: 'sawtooth', gain: 0.25, attack: 0.01, release: 0.35 });
    tone(a, master, { freq: 92.5, when: when + 0.45, dur: 1.2, type: 'sawtooth', gain: 0.28, attack: 0.01, release: 0.9 });
    noise(a, master, { when, dur: 0.4, gain: 0.1, freq: 500 });
  } else if (kind === 'win') {
    // a proper fanfare: three rising calls, then the chord held
    const calls = [[523.25, 0], [523.25, 0.13], [523.25, 0.26], [659.25, 0.42], [783.99, 0.6]];
    for (const [f, t] of calls) {
      tone(a, master, { freq: f, when: when + t, dur: 0.16, type: 'sawtooth', gain: 0.13, attack: 0.008, release: 0.08 });
      tone(a, master, { freq: f * 1.5, when: when + t, dur: 0.16, type: 'triangle', gain: 0.07, attack: 0.008, release: 0.08 });
    }
    for (const f of [523.25, 659.25, 783.99, 1046.5]) {
      tone(a, master, { freq: f, when: when + 0.8, dur: 1.3, type: 'sawtooth', gain: 0.09, attack: 0.02, release: 0.9 });
    }
    kick(a, master, when + 0.8, 0.5, 130, 50, 0.4);
    noise(a, master, { when: when + 0.8, dur: 1.2, gain: 0.08, freq: 6000, type: 'highpass' });
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
