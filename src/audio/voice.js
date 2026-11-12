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

// A device's voice list mixes very different quality: neural voices that
// sound like people, older "desktop" voices that sound like a satnav, and
// (on Apple devices) a set of joke voices. The old picker chose from all of
// them at random and then shifted the pitch by up to 20%, which makes even a
// good voice sound synthetic. Now: rank the list, choose only from the best
// tier available, and leave a good voice at its natural pitch.
const GOOD_VOICE = /natural|neural|online|enhanced|premium|siri|wavenet|google (us|uk) english/i;
const POOR_VOICE = /desktop|espeak|compact|festival|pico|albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|jester|junior|organ|ralph|superstar|trinoids|whisper|wobble|zarvox|fred|kathy|princess|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley/i;
const FEMALE_VOICE = /female|woman|samantha|victoria|karen|moira|tessa|susan|zira|jenny|aria|libby|sonia|natasha|ava|allison|emma|olivia|michelle|ana\b|sara|nicky|serena|kate|hazel|catherine|fiona|clara|heather|linda|joanna|salli|kendra|kimberly|ivy|amy/i;
const MALE_VOICE = /\bmale|\bman\b|daniel|alex|david|mark|guy|ryan|thomas|james|george|andrew|brian|christopher|eric|roger|steffan|william|liam|oliver|aaron|arthur|gordon|nathan|\btom\b|rishi|\blee\b|matthew|joey|justin|kevin|russell/i;

function voiceScore(v) {
  let s = 0;
  if (GOOD_VOICE.test(v.name)) s += 3;
  if (v.localService === false) s += 1;        // network voices are the neural ones
  if (POOR_VOICE.test(v.name)) s -= 5;
  if (/^en-(US|GB|AU|IE|CA)/i.test(v.lang || '')) s += 0.5;
  return s;
}
function bestTier(list) {
  if (!list.length) return list;
  const top = Math.max(...list.map(voiceScore));
  return list.filter((v) => voiceScore(v) >= top - 1);
}

// Per-character vocal identity: a stable pick from the best voices, with only
// a slight pitch/rate offset. gender ('m'|'f') narrows the pick when the
// device's voice names make that possible.
function voiceFor(characterKey, gender) {
  const voices = englishVoices();
  const h = hash(characterKey);
  let pool = bestTier(voices);
  if (gender && voices.length > 1) {
    const rx = gender === 'f' ? FEMALE_VOICE : MALE_VOICE;
    const other = gender === 'f' ? MALE_VOICE : FEMALE_VOICE;
    const matched = voices.filter((v) => rx.test(v.name) && !other.test(v.name));
    // A matching voice from a clearly worse tier is not worth the match.
    const tier = bestTier(matched);
    if (tier.length && voiceScore(tier[0]) >= Math.max(...voices.map(voiceScore)) - 3) pool = tier;
  }
  const voice = pool.length ? pool[h % pool.length] : null;
  const natural = !!voice && voiceScore(voice) >= 3;
  return {
    voice,
    pitch: natural ? 0.98 + ((h >> 3) % 5) * 0.01 : 0.94 + ((h >> 3) % 7) * 0.02, // ±2% / ±6%
    rate: 0.98 + ((h >> 7) % 4) * 0.02,                                          // 0.98 – 1.04
  };
}

// What is written for the eye is not what should be read aloud: emoji and
// markdown asterisks get spoken as words by some engines.
function speakable(text) {
  return String(text)
    .replace(/\p{Extended_Pictographic}|\uFE0F/gu, '')
    .replace(/[*_~`#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

// For the menu: what this device is actually going to sound like.
export function voiceQuality() {
  const voices = englishVoices();
  if (!voices.length) return 'none';
  return Math.max(...voices.map(voiceScore)) >= 3 ? 'natural' : 'basic';
}

const queue = [];
let speaking = false;

// Speak a line as a character. Queued so multiple speakers take turns.
export function speak(text, characterKey = 'narrator', gender = null) {
  const s = synth();
  if (!s || !isVoiceOn() || !text) return;
  const clean = speakable(text);
  if (!clean) return;
  queue.push({ text: clean, characterKey, gender });
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
