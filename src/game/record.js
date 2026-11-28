// The season as a document: everything that happened, readable top to bottom,
// with the raw save attached at the end. Built so a player can hand a whole
// game to someone else ("this reply was wrong — here is the season it came
// from") instead of describing it from memory.
//
// Pure: reads the game, returns text. No DOM. Works on a save from before the
// full transcript existed (it falls back to the per-houseguest threads, which
// only keep the last 24 lines each, and says so).

import { PLAYER_ID } from './cast.js';
import { nameOf } from './state.js';

const pad = (n) => String(n).padStart(2, '0');
const line = (ch = '-', n = 64) => ch.repeat(n);

function names(g, ids) {
  return (ids || []).map((id) => nameOf(g, id)).join(', ') || '—';
}

function byWeek(list, key = 'week') {
  const out = new Map();
  for (const x of list || []) {
    const w = x[key] ?? x.w ?? 0;
    if (!out.has(w)) out.set(w, []);
    out.get(w).push(x);
  }
  return out;
}

function scoreBoard(g, scores) {
  return Object.entries(scores || {})
    .filter(([, s]) => s >= 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, s]) => `${nameOf(g, id)} ${Math.round(s)}`)
    .join(', ');
}

// Online, the room server builds this for one player (`meta.viewerId`), and
// what goes in depends on `meta.scope`:
//   'viewer'  mid-season — only what that player could know: public events,
//             their own conversations, promises, alliances and intel. No
//             personality numbers, feelings, secret ballots or grudges.
//   'full'    the season is over (and always in single-player): everything.
// The transcript and intel are passed in (`meta.transcript`, `meta.intel`)
// because the server keeps them per player; the raw save is left out online
// (`meta.raw === false`) since it holds every other player's private chats.
export function buildSeasonRecord(g, meta = {}) {
  const L = [];
  const online = !!meta.viewerId;
  const viewer = meta.viewerId || PLAYER_ID;
  const full = meta.scope !== 'viewer';
  const me = online ? nameOf(g, viewer) : g.playerName || nameOf(g, PLAYER_ID);
  const who = (id) => (!online && (id === 'you' || id === PLAYER_ID) ? me : nameOf(g, id));
  const mine = (id) => (online ? id === viewer : id === 'you');
  const transcript = meta.transcript || g.transcript || [];
  const intel = meta.intel || g.intel || [];

  L.push('BB JURY HOUSE — SEASON RECORD');
  L.push(`Game version ${meta.version || '?'} · exported ${meta.exportedAt || new Date().toISOString()}`);
  L.push(`Player: ${me} · reached week ${g.week} · phase ${g.phase}${online ? ' · online game' : ''}`);
  if (!full) L.push('Exported mid-season: this holds only what you could know. The full record (every ballot, promise and grudge) is available once the season ends.');
  if (g.finale?.winner) L.push(`Winner: ${who(g.finale.winner)}  (finalists: ${names(g, g.finale.finalists)})`);
  L.push(`Evicted, in order: ${names(g, g.evicted)}`);
  L.push('');

  // ---- Houseguests -----------------------------------------------------------
  L.push('HOUSEGUESTS');
  L.push(line());
  for (const h of g.houseguests) {
    const p = h.personality;
    const feel = full && h.id !== viewer && g.social?.[h.id]?.[viewer];
    L.push(`${h.name}${h.id === viewer ? ' (you)' : ''} — ${h.job || ''}` +
      (p && full ? ` | loyalty ${p.loyalty}, bitterness ${p.bitterness}, strategic ${p.strategic}, chaos ${p.chaos}, comp ${p.compSkill}` : '') +
      (feel ? ` | toward you at export: trust ${feel.trust}, bond ${feel.bond}, threat ${feel.threat}` : ''));
  }
  L.push('');

  // ---- Week by week ------------------------------------------------------------
  const events = byWeek(g.events);
  const comps = byWeek(g.compHistory);
  const votes = byWeek(g.voteHistory);
  const talk = byWeek(transcript, 'w');
  const weeks = [...new Set([...events.keys(), ...comps.keys(), ...votes.keys(), ...talk.keys()])].sort((a, b) => a - b);
  for (const w of weeks) {
    L.push(`WEEK ${w}`);
    L.push(line('='));
    for (const c of comps.get(w) || []) {
      L.push(`[${c.type === 'hoh' ? 'HoH comp' : c.type === 'final_hoh' ? 'Final HoH' : 'Veto comp'}] won by ${who(c.winner)} — ${scoreBoard(g, c.scores)}`);
    }
    for (const e of events.get(w) || []) L.push(`[${e.phase}] ${e.text}`);
    for (const v of full ? votes.get(w) || [] : []) {
      const ballots = Object.entries(v.votes || {}).map(([voter, target]) => `${who(voter)}→${who(target)}`).join(', ');
      L.push(`[vote] ${ballots}${v.tally ? `  (tally: ${Object.entries(v.tally).map(([id, n]) => `${who(id)} ${n}`).join(', ')})` : ''}`);
    }
    const said = talk.get(w) || [];
    if (said.length) {
      L.push('');
      L.push(`  Conversations, week ${w}`);
      let last = '';
      for (const t of said) {
        const head = `${t.p} · ${t.k === 'diary' ? 'Diary Room' : t.k === 'group' ? `group with ${String(t.with).replace('group:', '').split(',').map(who).join(', ')}` : `with ${who(t.with)}`}`;
        if (head !== last) { L.push(`  -- ${head}`); last = head; }
        const tag = mine(t.who) ? '' : t.a === 1 ? ' [AI]' : t.a === 0 ? ' [offline writer]' : '';
        L.push(`     ${mine(t.who) ? me : t.who === 'dr' ? 'Diary Room' : t.who === 'note' ? '(game)' : who(t.who)}${tag}: ${t.t}`);
      }
    }
    L.push('');
  }

  // ---- Older saves: only the capped threads exist ------------------------------
  if (!online && !transcript.length) {
    L.push('CONVERSATIONS (from a save made before full transcripts were kept — only the last 24 lines with each houseguest survive)');
    L.push(line());
    for (const [id, thread] of Object.entries(g.threads || {})) {
      if (!thread?.length) continue;
      L.push(`-- with ${who(id)}`);
      for (const m of thread) L.push(`   ${m.week ? `[wk ${m.week} ${m.phase || ''}] ` : ''}${m.who === 'you' ? me : who(id)}: ${m.text}`);
    }
    if ((g.diary || []).length) {
      L.push('-- Diary Room');
      for (const m of g.diary) L.push(`   ${m.who === 'you' ? me : 'Diary Room'}: ${m.text}`);
    }
    L.push('');
  }

  // ---- Promises, alliances, memory -----------------------------------------------
  L.push('PROMISES');
  L.push(line());
  const promises = (g.promises || []).filter((p) => full || p.from === viewer || p.to === viewer);
  if (!promises.length) L.push('None recorded.');
  for (const p of promises) {
    L.push(`wk ${p.week} · ${who(p.from)} → ${who(p.to)} · ${p.kind} · ${String(p.status).toUpperCase()} · "${p.text}"`);
  }
  L.push('');
  L.push('ALLIANCES');
  L.push(line());
  for (const a of (g.alliances || []).filter((al) => full || al.members.includes(viewer))) L.push(`"${a.name}" — ${a.members.map(who).join(', ')} · formed ${a.formedWeek >= 1 ? `wk ${a.formedWeek}` : `before the season`}${a.dead ? ' · DEAD' : ''}`);
  L.push('');
  L.push('WHAT EACH HOUSEGUEST HELD AGAINST PEOPLE');
  L.push(line());
  if (!full) L.push('Not shown until the season ends.');
  for (const [id, mem] of full ? Object.entries(g.memory || {}) : []) {
    for (const gr of mem.grudges || []) L.push(`${who(id)} vs ${who(gr.againstId)} (wk ${gr.week}, severity ${gr.severity}): ${gr.reason}`);
  }
  L.push('');
  if (intel.length) {
    L.push('WHAT YOU OVERHEARD');
    L.push(line());
    for (const x of intel) L.push(`wk ${x.week} · ${names(g, x.sourceIds)} · ${x.text}`);
    L.push('');
  }

  // ---- Finale -----------------------------------------------------------------------
  if (g.finale) {
    L.push('FINALE');
    L.push(line('='));
    const [f1, f2] = g.finale.finalists || [];
    for (const [j, qa] of Object.entries(g.finale.qa || {})) {
      L.push(`${who(j)} to ${who(f1)}: ${qa.questionForF1}`);
      L.push(`   ${who(f1)}: ${qa.f1Answer}`);
      L.push(`${who(j)} to ${who(f2)}: ${qa.questionForF2}`);
      L.push(`   ${who(f2)}: ${qa.f2Answer}`);
    }
    L.push('');
    for (const v of g.finale.votes || []) L.push(`${who(v.juror)} voted for ${who(v.vote)} — ${v.reasoning || ''}`);
    L.push('');
  }

  // ---- Raw save ------------------------------------------------------------------------
  // Everything above is derived from this. Kept so a claim in the readable part
  // can be checked against the exact state the game held.
  if (meta.raw === false) {
    L.push('The raw save is not attached to an online record: it holds every other player\'s private conversations.');
    return L.join('\n');
  }
  L.push('RAW SAVE (JSON)');
  L.push(line('='));
  L.push(JSON.stringify(g));
  return L.join('\n');
}

export function recordFilename(g, name = g.playerName) {
  const d = new Date();
  const safe = String(name || 'season').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 20) || 'season';
  return `bb-jury-house-${safe}-week${g.week}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
}
