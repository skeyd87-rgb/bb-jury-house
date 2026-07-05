// Claude API client (direct-from-browser) with an offline fallback engine.
// The engine never trusts the model with game state — replies come back as
// JSON { reply, effects } and social.js clamps/validates every effect.

const KEY_STORAGE = 'bbjury.apikey';
const MODEL = 'claude-sonnet-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

export function getApiKey() {
  return localStorage.getItem(KEY_STORAGE) || '';
}
export function setApiKey(k) {
  if (k) localStorage.setItem(KEY_STORAGE, k.trim());
  else localStorage.removeItem(KEY_STORAGE);
}
export function hasApiKey() {
  return !!getApiKey();
}

export async function askClaude({ system, messages, maxTokens = 700, temperature = 1.0 }) {
  const key = getApiKey();
  if (!key) throw new NoKeyError();
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature,
      system,
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return text;
}

export class NoKeyError extends Error {
  constructor() {
    super('No API key configured');
    this.noKey = true;
  }
}

// Extract the first JSON object from a model reply (tolerates prose/fences).
// If the JSON was truncated mid-stream (token cap), attempts a repair by
// closing open strings/brackets so partial group replies still parse.
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start === -1) return null;
  // scan for balanced braces (respecting strings)
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          break; // fall through to repair
        }
      }
    }
  }
  return repairTruncatedJson(candidate.slice(start));
}

// Best-effort repair of JSON cut off mid-generation: trim a dangling partial
// value, then close any open string/arrays/objects in stack order.
export function repairTruncatedJson(s) {
  // Track bracket/string state over the whole fragment.
  const stack = [];
  let inStr = false, esc = false, lastGood = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; if (!inStr) lastGood = i + 1; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') { stack.pop(); lastGood = i + 1; }
    else if (ch === ',' ) lastGood = i; // safe cut point (before the comma)
  }
  if (!stack.length && !inStr) return null; // wasn't truncation — give up
  let base = s.slice(0, Math.max(lastGood, 1));
  // strip a trailing comma / dangling "key": fragment
  base = base.replace(/,\s*$/, '').replace(/,?\s*"[^"]*"?\s*:?\s*$/, '');
  // re-derive open stack for the trimmed base
  const stack2 = [];
  inStr = false; esc = false;
  for (let i = 0; i < base.length; i++) {
    const ch = base[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack2.push(ch);
    else if (ch === '}' || ch === ']') stack2.pop();
  }
  let repaired = base + (inStr ? '"' : '');
  for (let i = stack2.length - 1; i >= 0; i--) repaired += stack2[i] === '{' ? '}' : ']';
  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

// Retry wrapper: one retry on transient failure, then throw.
export async function askClaudeJson(opts) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await askClaude(opts);
      const json = extractJson(text);
      if (json) return json;
      lastErr = new Error('Model reply had no parseable JSON');
    } catch (e) {
      if (e.noKey) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}
