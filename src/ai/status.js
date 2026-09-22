// Tiny shared indicator of whether Claude is actually answering right now, or
// the built-in offline dialogue engine has taken over. Updated live by every
// AI-eligible call (single-player direct, or reported back from the
// multiplayer server) — never inferred from key presence, since the app now
// always tries AI first regardless of any key ever being entered.

// 'grounded' is deliberately distinct from 'offline': the model DID answer,
// the factual audit refused the reply, and the offline engine wrote the line
// instead. Reporting that as an outage sends you hunting a network problem
// that isn't there.
const STATES = new Set(['ai', 'grounded', 'offline']);
let status = 'unknown'; // 'ai' | 'grounded' | 'offline' | 'unknown'
const listeners = new Set();

// Accepts a state name, or a boolean from callers that only know ai/offline
// (the multiplayer server reports one bit).
export function setAiStatus(next) {
  const value = next === true ? 'ai' : next === false ? 'offline' : next;
  if (!STATES.has(value) || value === status) return;
  status = value;
  for (const fn of listeners) fn(status);
}

export function getAiStatus() {
  return status;
}

// Returns an unsubscribe function.
export function onAiStatusChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
