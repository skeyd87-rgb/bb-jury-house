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

// ---- The speech queue -------------------------------------------------------
// Browser speech synthesis is unreliable in ways that all look the same from
// outside — a line simply is not spoken, or keeps going after it should have
// stopped. The ones handled here, all seen in Chrome:
//   * an utterance with no live reference can be garbage-collected mid-speech,
//     and then its `onend` never fires: the queue waits for ever;
//   * speak() called straight after cancel() is silently dropped;
//   * a cancelled utterance reports its end late, after the next has started;
//   * long lines are paused by the engine after ~15 s unless nudged.
// So: one utterance at a time, held in `current`; every callback checks it is
// still about the current utterance; a short gap after any cancel; a
// keep-alive while speaking; and a watchdog that moves on if an utterance
// never starts or never ends.

const queue = [];
let current = null;        // { u, token } — also what keeps the utterance alive
let token = 0;
let cancelledAt = 0;
let keepAlive = null;
let watchdog = null;
const quietWaiters = [];

function isBusy() {
  return !!current || queue.length > 0;
}

function settleQuiet() {
  if (isBusy()) return;
  while (quietWaiters.length) { try { quietWaiters.shift()(); } catch { /* a waiter's problem */ } }
}

// Call back once nothing is being spoken and nothing is queued. Used by the
// talk mode so the microphone never listens to the game's own voice.
export function whenQuiet(cb) {
  if (!synth() || !isVoiceOn() || !isBusy()) { setTimeout(cb, 0); return; }
  quietWaiters.push(cb);
}

// Speak a line as a character. Queued so multiple speakers take turns.
export function speak(text, characterKey = 'narrator', gender = null) {
  const s = synth();
  if (!s || !isVoiceOn() || !text) return;
  const clean = speakable(text);
  if (!clean) return;
  queue.push({ text: clean, characterKey, gender });
  pump();
}

function finish(mine) {
  if (!current || current.token !== mine) return; // a late callback from an utterance we already left
  current = null;
  clearInterval(keepAlive);
  clearTimeout(watchdog);
  if (queue.length) pump(); else settleQuiet();
}

function pump() {
  const s = synth();
  if (!s || current) return;
  // Chrome drops a speak() that follows a cancel() too closely.
  const sinceCancel = performance.now() - cancelledAt;
  if (sinceCancel < 120) { setTimeout(pump, 130 - sinceCancel); return; }
  const next = queue.shift();
  if (!next) { settleQuiet(); return; }

  const u = new SpeechSynthesisUtterance(next.text);
  const v = voiceFor(next.characterKey, next.gender);
  if (v.voice) u.voice = v.voice;
  u.pitch = v.pitch;
  u.rate = v.rate;
  const mine = ++token;
  current = { u, token: mine };
  let started = false;
  u.onstart = () => { started = true; };
  u.onend = () => finish(mine);
  u.onerror = () => finish(mine);

  clearInterval(keepAlive);
  keepAlive = setInterval(() => { if (s.speaking && !s.paused) { s.pause(); s.resume(); } }, 10000);
  // Never started within 2.5 s, or ran far past any plausible length: move on.
  const longest = 6000 + next.text.length * 110;
  clearTimeout(watchdog);
  watchdog = setTimeout(function check() {
    if (!current || current.token !== mine) return;
    if (!started && !s.speaking) { finish(mine); return; }
    watchdog = setTimeout(() => { if (current && current.token === mine) { s.cancel(); cancelledAt = performance.now(); finish(mine); } }, longest);
  }, 2500);

  try { s.resume(); s.speak(u); } catch { finish(mine); }
}

export function stopSpeaking() {
  const s = synth();
  queue.length = 0;
  quietWaiters.length = 0;
  current = null;
  token++; // orphan any callback still on its way
  clearInterval(keepAlive);
  clearTimeout(watchdog);
  if (s) { s.cancel(); cancelledAt = performance.now(); }
}

// ---- Listening (Chrome / Edge / Android; iOS Safari's recogniser is too
// flaky — iPhone users should use the keyboard's own microphone) --------------

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
const isIOS = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);

export function dictationSupported() {
  return !!SR && !isIOS;
}

// Fold a recogniser's result list into one sentence. Desktop Chrome reports
// separate pieces ("hi", "how are you"); Chrome on Android reports each piece
// as everything so far ("hi", "hi how", "hi how are you"). Joining the second
// kind naively gave "hi hi how hi how are you".
export function foldTranscripts(pieces) {
  let acc = '';
  for (const raw of pieces) {
    const t = String(raw || '').trim();
    if (!t) continue;
    const a = acc.toLowerCase(), b = t.toLowerCase();
    if (b.startsWith(a)) acc = t;                 // a longer version of what we have
    else if (!a.endsWith(b)) acc = `${acc} ${t}`; // genuinely new words
  }
  return acc.trim();
}

// Listen for one utterance. onInterim(text) fires as words arrive; onText(text)
// fires once with the final sentence (not at all if nothing was heard); then
// onEnd(heardSomething). Returns the recogniser (call .stop() to end early).
export function startDictation(onText, onEnd, onInterim) {
  if (!dictationSupported()) return null;
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let latest = '';
  let done = false;
  rec.onresult = (e) => {
    const pieces = [];
    for (let i = 0; i < e.results.length; i++) pieces.push(e.results[i][0]?.transcript);
    latest = foldTranscripts(pieces);
    if (onInterim) onInterim(latest);
  };
  const finish = () => {
    if (done) return;
    done = true;
    if (latest) onText(latest);
    onEnd && onEnd(!!latest);
  };
  rec.onend = finish;
  rec.onerror = finish;
  try { rec.start(); } catch { finish(); }
  return rec;
}
