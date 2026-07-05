// Voice mode: houseguests speak their lines aloud via the browser's built-in
// speech synthesis (free, works well on iOS). Each character gets a stable,
// slightly different voice (pitch/rate + a voice from the device's list).
// Also exposes optional dictation via the Web Speech API where reliable.

const VOICE_KEY = 'bbjury.voiceOn';

export function isVoiceOn() {
  return localStorage.getItem(VOICE_KEY) === '1';
}

export function setVoiceOn(on) {
  localStorage.setItem(VOICE_KEY, on ? '1' : '0');
  if (!on) stopSpeaking();
}

function synth() {
  return typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
}

export function voiceSupported() {
  return !!synth();
}

let cachedVoices = null;
function englishVoices() {
  const s = synth();
  if (!s) return [];
  const all = s.getVoices();
  if (all.length) cachedVoices = all.filter((v) => v.lang && v.lang.startsWith('en'));
  return cachedVoices || [];
}
// voices load async on some browsers
if (voiceSupported()) {
  speechSynthesis.onvoiceschanged = () => englishVoices();
  englishVoices();
}

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Per-character vocal identity: stable voice pick + pitch/rate offsets.
// gender hint ('m'|'f') biases the voice choice when names allow it.
function voiceFor(characterKey, gender) {
  const voices = englishVoices();
  const h = hash(characterKey);
  let pool = voices;
  if (gender && voices.length > 3) {
    const fRx = /female|woman|samantha|victoria|karen|moira|tessa|susan|zira|jenny|aria|libby|sonia|natasha/i;
    const mRx = /male|man|daniel|alex|fred|david|mark|guy|ryan|thomas|james|george/i;
    const rx = gender === 'f' ? fRx : mRx;
    const matched = voices.filter((v) => rx.test(v.name));
    if (matched.length) pool = matched;
  }
  const voice = pool.length ? pool[h % pool.length] : null;
  return {
    voice,
    pitch: 0.8 + ((h >> 3) % 9) * 0.05, // 0.8 – 1.2
    rate: 0.95 + ((h >> 7) % 4) * 0.05, // 0.95 – 1.1
  };
}

const queue = [];
let speaking = false;

// Speak a line as a character. Queued so multiple speakers take turns.
export function speak(text, characterKey = 'narrator', gender = null) {
  const s = synth();
  if (!s || !isVoiceOn() || !text) return;
  queue.push({ text: String(text).slice(0, 500), characterKey, gender });
  pump();
}

function pump() {
  const s = synth();
  if (!s || speaking) return;
  const next = queue.shift();
  if (!next) return;
  speaking = true;
  const u = new SpeechSynthesisUtterance(next.text);
  const v = voiceFor(next.characterKey, next.gender);
  if (v.voice) u.voice = v.voice;
  u.pitch = v.pitch;
  u.rate = v.rate;
  u.onend = u.onerror = () => {
    speaking = false;
    pump();
  };
  s.speak(u);
}

export function stopSpeaking() {
  const s = synth();
  queue.length = 0;
  speaking = false;
  if (s) s.cancel();
}

// ---- Dictation (optional; reliable on Chrome/Edge/Android, flaky on iOS
// Safari — iOS users should use the keyboard's built-in 🎤 instead) ----------

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
const isIOS = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);

export function dictationSupported() {
  return !!SR && !isIOS;
}

// Start one dictation capture; calls onText(finalTranscript) then onEnd().
export function startDictation(onText, onEnd) {
  if (!dictationSupported()) return null;
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    const t = e.results?.[0]?.[0]?.transcript;
    if (t) onText(t);
  };
  rec.onend = () => onEnd && onEnd();
  rec.onerror = () => onEnd && onEnd();
  rec.start();
  return rec;
}
