// Central game state. The engine owns all social truth: trust, threat,
// promises, betrayals, grudges, alliances, gossip. Claude only proposes
// effects; applyEffects() in social.js is the sole mutator of relationships.

import { CAST, PLAYER_ID, playerContestant } from './cast.js';

const SAVE_KEY = 'bbjury.save.v1';

export function newGame(playerName) {
  const player = playerContestant(playerName);
  const houseguests = [player, ...CAST.map((c) => ({ ...c }))];
  const ids = houseguests.map((h) => h.id);

  const social = {};
  for (const a of ids) {
    social[a] = {};
    for (const b of ids) {
      if (a === b) continue;
      social[a][b] = {
        trust: 50 + jitter(12), // how much a trusts b
        threat: 30 + jitter(10), // how big a threat a thinks b is
        bond: 40 + jitter(15), // personal affection independent of game
      };
    }
  }
  seedPreexistingDynamics(social);

  return {
    version: 1,
    playerName: player.name,
    week: 1,
    phase: 'week_intro', // see season.js PHASES
    houseguests,
    evicted: [], // ids in eviction order; all go to jury (we start at jury phase)
    jury: [],
    hoh: null,
    lastHoh: null, // outgoing HoH — barred from the next HoH comp
    nominees: [],
    vetoHolder: null,
    vetoUsed: null, // { holderId, savedId, replacementId } | null
    pendingRenom: null, // { holder, savedId } while a replacement is being chosen
    // Per-NPC durable memory
    memory: initMemory(ids),
    // Alliances: { id, name, members:[], formedWeek, dead }
    alliances: [
      { id: 'al1', name: 'The Quiet Storm', members: ['marcus', 'rae', 'zoe'], formedWeek: -3, lastActive: 1, dead: false },
      { id: 'al2', name: 'House Money', members: ['flynn', 'nash', 'tessa'], formedWeek: -2, lastActive: 1, dead: false },
      { id: 'al3', name: 'The Day Ones', members: [PLAYER_ID, 'rae', 'bev'], formedWeek: -5, lastActive: 1, dead: false },
    ],
    playerAlliances: ['al3'], // alliance ids the player belongs to
    promises: [], // { id, from, to, text, week, kind, status: 'open'|'kept'|'broken' }
    events: [], // season log: { week, phase, type, text, actors }
    social,
    compHistory: [], // { week, type:'hoh'|'veto', winner, scores }
    voteHistory: [], // { week, evicted, votes: {voterId: nomineeId} }
    juryQA: null, // built during finale
    pendingApproach: null, // NPC who wants to talk to the player
    threads: {}, // per-npc chat transcript [{who:'you'|'them', text}]
    diary: [], // diary room transcript
    chatTurnsThisPhase: 0,
    settings: { musicOn: true },
    rngSeed: Math.floor(Math.random() * 1e9),
  };
}

function initMemory(ids) {
  const mem = {};
  for (const id of ids) {
    if (id === PLAYER_ID) continue;
    mem[id] = {
      grudges: [], // { againstId, reason, week, severity 1-3 }
      betrayalsWitnessed: [], // { byId, victimId, what, week }
      promisesHeard: [], // ids into promises[]
      gossipHeard: [], // { text, aboutId, fromId, week, believed }
      convoSummaries: [], // { withId, week, summary } — rolling, capped
      juryNotes: [], // filled when they enter jury: what they'll remember
      lastPlayerTopics: [],
    };
  }
  return mem;
}

// Starting-house texture: pre-jury history the player walks into.
function seedPreexistingDynamics(social) {
  const bump = (a, b, k, d) => {
    social[a][b][k] = clamp(social[a][b][k] + d);
  };
  // Quiet Storm alliance trust
  for (const [a, b] of pairs(['marcus', 'rae', 'zoe'])) {
    bump(a, b, 'trust', 22);
    bump(b, a, 'trust', 22);
  }
  // House Money alliance trust (looser)
  for (const [a, b] of pairs(['flynn', 'nash', 'tessa'])) {
    bump(a, b, 'trust', 14);
    bump(b, a, 'trust', 14);
  }
  // Rivalries and reads
  bump('bev', 'flynn', 'trust', -20); // Bev sees through Flynn
  bump('bev', 'flynn', 'bond', -15);
  bump('flynn', 'bev', 'threat', 10);
  bump('nash', 'marcus', 'threat', 18); // Nash smells the mastermind
  bump('zoe', 'nash', 'threat', 15); // chaos scares the superfan
  bump('gus', 'marcus', 'trust', -10); // Gus quietly doesn't buy it
  bump('rae', 'marcus', 'trust', 15); // Rae is all-in on Marcus
  bump('tessa', 'rae', 'threat', 12);
  // Everyone underestimates Gus and Tessa
  for (const s of Object.keys(social)) {
    if (s !== 'gus') bump(s, 'gus', 'threat', -12);
    if (s !== 'tessa') bump(s, 'tessa', 'threat', -10);
  }
  // The player didn't arrive from nowhere — they survived to jury phase.
  // Day Ones with Rae and Bev, generally liked, not yet seen as a comp threat.
  bump('rae', 'you', 'trust', 26);
  bump('rae', 'you', 'bond', 20);
  bump('bev', 'you', 'trust', 24);
  bump('bev', 'you', 'bond', 22);
  bump('gus', 'you', 'trust', 12);
  bump('gus', 'you', 'bond', 14);
  bump('marcus', 'you', 'trust', 10); // Marcus keeps assets close
  bump('zoe', 'you', 'bond', 8);
  bump('flynn', 'you', 'bond', 10);
  for (const s of Object.keys(social)) {
    if (s !== 'you') {
      bump(s, 'you', 'trust', 8);
      bump(s, 'you', 'threat', -8);
    }
  }
}

function pairs(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++)
    for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
  return out;
}

function jitter(n) {
  return Math.round((Math.random() * 2 - 1) * n);
}

export function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

// ---- Queries -------------------------------------------------------------

export function activeIds(g) {
  return g.houseguests.map((h) => h.id).filter((id) => !g.evicted.includes(id));
}

export function activeNpcIds(g) {
  return activeIds(g).filter((id) => id !== PLAYER_ID);
}

export function nameOf(g, id) {
  const h = g.houseguests.find((x) => x.id === id);
  return h ? h.name : id;
}

export function rel(g, a, b) {
  return g.social[a][b];
}

export function allianceOf(g, id) {
  return g.alliances.filter((al) => !al.dead && al.members.includes(id));
}

export function sharedAlliance(g, a, b) {
  return g.alliances.some((al) => !al.dead && al.members.includes(a) && al.members.includes(b));
}

export function openPromisesBetween(g, a, b) {
  return g.promises.filter(
    (p) => p.status === 'open' && ((p.from === a && p.to === b) || (p.from === b && p.to === a))
  );
}

export function logEvent(g, type, text, actors = []) {
  g.events.push({ week: g.week, phase: g.phase, type, text, actors });
}

// ---- Save / load ---------------------------------------------------------

export function saveGame(g) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(g));
  } catch (e) {
    console.warn('save failed', e);
  }
}

export function loadGame() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw);
    if (g.version !== 1) return null;
    return g;
  } catch {
    return null;
  }
}

export function clearSave() {
  localStorage.removeItem(SAVE_KEY);
}
