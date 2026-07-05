// Tiny shared indicator of whether Claude is actually answering right now, or
// the built-in offline dialogue engine has taken over. Updated live by every
// AI-eligible call (single-player direct, or reported back from the
// multiplayer server) — never inferred from key presence, since the app now
// always tries AI first regardless of any key ever being entered.

let status = 'unknown'; // 'ai' | 'offline' | 'unknown'
const listeners = new Set();

export function setAiStatus(ok) {
  const next = ok ? 'ai' : 'offline';
  if (next === status) return;
  status = next;
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
