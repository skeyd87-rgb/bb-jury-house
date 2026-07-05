// Social engine: applies Claude-proposed effects, simulates NPC<->NPC life
// between phases, spreads gossip, detects betrayals, and decides when an NPC
// should proactively approach the player.

import {
  PLAYER_ID,
} from './cast.js';
import {
  activeNpcIds,
  activeIds,
  clamp,
  rel,
  nameOf,
  sharedAlliance,
  allianceOf,
  logEvent,
} from './state.js';

// ---- Applying chat effects ------------------------------------------------
// effects: validated JSON from the AI layer:
// { trustDelta, bondDelta, threatDelta, promiseMade: {text, kind} | null,
//   allianceSignal: 'propose'|'accept'|'none', suspicionOfLie: bool,
//   secretShared: string|null, targetDiscussed: id|null }

// chatterId defaults to the single-player 'you'; online, it's the engine id of
// whichever human is talking, so effects/promises land on the right pair.
export function applyChatEffects(g, npcId, playerMsg, effects, chatterId = PLAYER_ID) {
  const chatterName = chatterId === PLAYER_ID ? 'You' : nameOf(g, chatterId);
  const r = rel(g, npcId, chatterId);
  r.trust = clamp(r.trust + num(effects.trustDelta, -8, 8));
  r.bond = clamp(r.bond + num(effects.bondDelta, -6, 6));
  r.threat = clamp(r.threat + num(effects.threatDelta, -5, 8));
  // Talking to an ally counts as maintenance (staves off alliance decay).
  touchAlliances(g, npcId);

  if (effects.suspicionOfLie) {
    r.trust = clamp(r.trust - 6);
    g.memory[npcId].grudges.push({
      againstId: chatterId,
      reason: 'caught what felt like a lie',
      week: g.week,
      severity: 1,
    });
  }

  if (effects.promiseMade && effects.promiseMade.text) {
    const p = {
      id: 'p' + (g.promises.length + 1),
      from: chatterId,
      to: npcId,
      text: String(effects.promiseMade.text).slice(0, 160),
      kind: effects.promiseMade.kind || 'safety',
      targetId: effects.promiseMade.targetId || null,
      week: g.week,
      status: 'open',
    };
    g.promises.push(p);
    g.memory[npcId].promisesHeard.push(p.id);
    logEvent(g, 'promise', `${chatterName} promised ${nameOf(g, npcId)}: "${p.text}"`, [npcId, chatterId]);
  }

  if (effects.allianceProposal && effects.allianceProposal.accepted) {
    formOfficialAlliance(g, npcId, effects.allianceProposal.name, effects.allianceProposal.memberIds || [], chatterId);
  } else if (effects.allianceSignal === 'accept' || effects.allianceSignal === 'propose') {
    maybeFormPlayerAlliance(g, npcId, chatterId);
  }

  if (effects.secretShared) {
    // The chatter told this NPC something sensitive; it may leak later.
    g.memory[npcId].gossipHeard.push({
      text: String(effects.secretShared).slice(0, 160),
      aboutId: effects.targetDiscussed || null,
      fromId: chatterId,
      week: g.week,
      believed: true,
      isPlayerSecret: true,
    });
  }

  if (effects.targetDiscussed && effects.targetDiscussed !== npcId) {
    const t = effects.targetDiscussed;
    if (g.social[npcId][t]) {
      // Talking targets plants seeds — small threat bump toward that person.
      g.social[npcId][t].threat = clamp(g.social[npcId][t].threat + 4);
    }
  }
}

function num(v, lo, hi) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function maybeFormPlayerAlliance(g, npcId, chatterId = PLAYER_ID) {
  const existing = g.alliances.find(
    (al) => !al.dead && al.members.includes(chatterId) && al.members.includes(npcId)
  );
  if (existing) return;
  const r = rel(g, npcId, chatterId);
  if (r.trust < 55) return; // they won't really commit at low trust
  const al = {
    id: 'al' + (g.alliances.length + 1),
    name: pickAllianceName(g),
    members: [chatterId, npcId],
    formedWeek: g.week,
    lastActive: g.week,
    dead: false,
  };
  g.alliances.push(al);
  if (chatterId === PLAYER_ID && !g.playerAlliances.includes(al.id)) g.playerAlliances.push(al.id);
  logEvent(g, 'alliance', `${chatterId === PLAYER_ID ? 'You' : nameOf(g, chatterId)} and ${nameOf(g, npcId)} formed "${al.name}".`, [npcId, chatterId]);
}

// How willing is npcId to join an alliance of [chatter + otherIds]?
// Returns { willing, reason }.
export function allianceWillingness(g, npcId, otherIds = [], chatterId = PLAYER_ID) {
  const rp = rel(g, npcId, chatterId);
  const p = personality(g, npcId);
  if (rp.trust < 48 - p.chaos * 0.15) return { willing: false, reason: 'does not trust you enough yet' };
  for (const other of otherIds) {
    if (other === npcId) continue;
    const ro = rel(g, npcId, other);
    if (ro.trust < 38) return { willing: false, reason: `will not work with ${nameOf(g, other)}` };
  }
  return { willing: true, reason: 'in' };
}

// Create (or dedupe) a formal alliance of the player + accepter + any other
// willing invitees. Returns { alliance, joined, declined:[{id,reason}] }.
export function formOfficialAlliance(g, accepterId, name, otherIds = [], chatterId = PLAYER_ID) {
  const joined = [accepterId];
  const declined = [];
  for (const id of otherIds) {
    if (id === accepterId || id === chatterId) continue;
    if (g.evicted.includes(id)) continue;
    const w = allianceWillingness(g, id, [accepterId, ...otherIds.filter((x) => x !== id)], chatterId);
    if (w.willing) joined.push(id);
    else declined.push({ id, reason: w.reason });
  }
  const members = [chatterId, ...joined];
  // Dedupe: same member set already exists?
  const existing = g.alliances.find(
    (al) => !al.dead && al.members.length === members.length && members.every((m) => al.members.includes(m))
  );
  if (existing) return { alliance: existing, joined, declined, existed: true };

  const al = {
    id: 'al' + (g.alliances.length + 1),
    name: (name && name.trim()) || pickAllianceName(g),
    members,
    formedWeek: g.week,
    lastActive: g.week,
    dead: false,
  };
  g.alliances.push(al);
  if (chatterId === PLAYER_ID && !g.playerAlliances.includes(al.id)) g.playerAlliances.push(al.id);
  // Founding bump between all members
  for (const a of members) {
    for (const b of members) {
      if (a === b || !g.social[a]?.[b]) continue;
      g.social[a][b].trust = clamp(g.social[a][b].trust + 6);
    }
  }
  logEvent(g, 'alliance', `"${al.name}" formed: ${members.map((m) => nameOf(g, m)).join(', ')}.`, members);
  return { alliance: al, joined, declined, existed: false };
}

// Mark every player-alliance containing npcId as freshly maintained this week.
export function touchAlliances(g, npcId) {
  for (const al of g.alliances) {
    if (al.dead || !al.members.includes(PLAYER_ID) || !al.members.includes(npcId)) continue;
    al.lastActive = g.week;
  }
}

// Player voluntarily quits an alliance. Soft betrayal: trust/bond hit + grudge
// scaled by each member's loyalty. Alliance dies if <2 members remain.
export function leaveAlliance(g, allianceId) {
  const al = g.alliances.find((a) => a.id === allianceId);
  if (!al || al.dead || !al.members.includes(PLAYER_ID)) return null;
  const others = al.members.filter((m) => m !== PLAYER_ID && !g.evicted.includes(m));
  for (const id of others) {
    const p = personality(g, id);
    const r = rel(g, id, PLAYER_ID);
    const hit = 10 + Math.round(p.loyalty * 0.25); // loyal members take it hardest
    r.trust = clamp(r.trust - hit);
    r.bond = clamp(r.bond - Math.round(hit * 0.6));
    r.threat = clamp(r.threat + 5);
    g.memory[id].grudges.push({
      againstId: PLAYER_ID,
      reason: `walked out on our alliance "${al.name}"`,
      week: g.week,
      severity: p.loyalty > 70 ? 2 : 1,
    });
  }
  al.members = al.members.filter((m) => m !== PLAYER_ID);
  g.playerAlliances = g.playerAlliances.filter((id) => id !== allianceId);
  if (al.members.filter((m) => !g.evicted.includes(m)).length < 2) al.dead = true;
  logEvent(g, 'alliance_leave', `You walked out of "${al.name}".`, others);
  return { name: al.name, others, collapsed: al.dead };
}

// Called each phase: player alliances left unmaintained slowly rot and fade.
export function decayAlliances(g, rand = Math.random) {
  for (const al of g.alliances) {
    if (al.dead || !al.members.includes(PLAYER_ID)) continue;
    if (al.lastActive == null) al.lastActive = g.week;
    const stale = g.week - al.lastActive;
    if (stale < 2) continue;
    // Bonds between player and members quietly cool
    for (const m of al.members) {
      if (m === PLAYER_ID || g.evicted.includes(m)) continue;
      const r = rel(g, m, PLAYER_ID);
      r.bond = clamp(r.bond - 3);
      r.trust = clamp(r.trust - 2);
    }
    if (stale >= 3 && rand() < 0.5) {
      al.dead = true;
      g.playerAlliances = g.playerAlliances.filter((id) => id !== al.id);
      logEvent(g, 'alliance_dead', `"${al.name}" has quietly fizzled out — you stopped tending it.`, al.members.filter((m) => m !== PLAYER_ID));
    }
  }
}

const ALLIANCE_NAMES = [
  'Final Answer', 'The Undertow', 'Smoke & Mirrors', 'The Long Game',
  'Backyard Deal', 'The Vault', 'Silent Majority', 'The Understudies',
];
function pickAllianceName(g) {
  const used = new Set(g.alliances.map((a) => a.name));
  return ALLIANCE_NAMES.find((n) => !used.has(n)) || 'Alliance ' + g.alliances.length;
}

// ---- Betrayal detection ----------------------------------------------------
// Called by season.js at nomination/veto/vote resolution.

export function recordBetrayalIfAny(g, actorId, action, victimId) {
  // action: 'nominated' | 'voted_against' | 'didnt_use_veto'
  const relevant = g.promises.filter(
    (p) =>
      p.status === 'open' &&
      p.from === actorId &&
      p.to === victimId &&
      (p.kind === 'safety' || p.kind === 'vote' || p.kind === 'final2' || p.kind === 'alliance')
  );
  const broke = relevant.length > 0;
  const allied = sharedAlliance(g, actorId, victimId);
  if (!broke && !allied) return false;

  for (const p of relevant) p.status = 'broken';

  const verb =
    action === 'nominated' ? 'nominated' : action === 'voted_against' ? 'voted against' : 'left on the block';

  // The victim (if NPC) takes it personally.
  if (victimId !== PLAYER_ID && g.memory[victimId]) {
    const sev = broke ? 3 : 2;
    g.memory[victimId].grudges.push({
      againstId: actorId,
      reason: `${verb} me${broke ? ' after promising safety' : ' despite our alliance'}`,
      week: g.week,
      severity: sev,
    });
    const r = rel(g, victimId, actorId);
    r.trust = clamp(r.trust - (broke ? 35 : 20));
    r.bond = clamp(r.bond - (broke ? 25 : 12));
  }

  // Witnesses: every active NPC notices public betrayals.
  for (const w of activeNpcIds(g)) {
    if (w === actorId || w === victimId) continue;
    g.memory[w].betrayalsWitnessed.push({
      byId: actorId,
      victimId,
      what: `${nameOf(g, actorId)} ${verb} ${nameOf(g, victimId)}${broke ? ' after a promise' : ''}`,
      week: g.week,
    });
    const r = rel(g, w, actorId);
    r.trust = clamp(r.trust - (broke ? 8 : 4));
    r.threat = clamp(r.threat + (broke ? 6 : 3));
  }

  logEvent(
    g,
    'betrayal',
    `${nameOf(g, actorId)} ${verb} ${nameOf(g, victimId)}${broke ? ' — breaking a promise' : ''}.`,
    [actorId, victimId]
  );
  return true;
}

export function markKeptPromises(g, actorId, action, protectedId) {
  // e.g. voted to keep someone you promised, or used veto on them
  for (const p of g.promises) {
    if (p.status !== 'open' || p.from !== actorId || p.to !== protectedId) continue;
    if ((action === 'voted_keep' && p.kind === 'vote') || (action === 'vetoed' && p.kind === 'safety')) {
      p.status = 'kept';
      if (protectedId !== PLAYER_ID && g.memory[protectedId]) {
        const r = rel(g, protectedId, actorId);
        r.trust = clamp(r.trust + 12);
        r.bond = clamp(r.bond + 8);
      }
      logEvent(g, 'promise_kept', `${nameOf(g, actorId)} kept a promise to ${nameOf(g, protectedId)}.`, [actorId, protectedId]);
    }
  }
}

// ---- Off-screen NPC life ----------------------------------------------------
// Called on every phase transition. Cheap, no API calls.

export function simulateHouseLife(g, rand = Math.random) {
  const npcs = activeNpcIds(g);
  decayAlliances(g, rand); // player alliances rot if left untended
  // 1) Random pairwise drift shaped by personality compatibility
  for (let i = 0; i < 6; i++) {
    const a = pick(npcs, rand);
    let b = pick(npcs, rand);
    if (a === b) continue;
    const pa = personality(g, a);
    const pb = personality(g, b);
    const compat =
      (pa.socialSkill + pb.socialSkill) / 200 - Math.abs(pa.chaos - pb.chaos) / 250;
    const drift = Math.round((rand() - 0.35 + compat * 0.4) * 6);
    g.social[a][b].bond = clamp(g.social[a][b].bond + drift);
    g.social[b][a].bond = clamp(g.social[b][a].bond + drift);
  }

  // 2) Gossip spread — one NPC shares something they know, maybe a player secret
  if (rand() < 0.55) {
    const teller = pick(npcs, rand);
    const mem = g.memory[teller];
    const secrets = mem.gossipHeard.filter((x) => x.isPlayerSecret && !x.leaked);
    const p = personality(g, teller);
    const leakChance = (100 - p.loyalty) / 130 + p.chaos / 300;
    if (secrets.length && rand() < leakChance) {
      const secret = secrets[Math.floor(rand() * secrets.length)];
      const listener = pick(npcs.filter((n) => n !== teller), rand);
      secret.leaked = true;
      g.memory[listener].gossipHeard.push({
        text: `${nameOf(g, teller)} says you told them: "${secret.text}"`,
        aboutId: PLAYER_ID,
        fromId: teller,
        week: g.week,
        believed: rand() < 0.8,
        isLeakOfPlayerSecret: true,
      });
      const r = rel(g, listener, PLAYER_ID);
      if (secret.aboutId === listener) {
        r.trust = clamp(r.trust - 18);
        r.bond = clamp(r.bond - 10);
        g.memory[listener].grudges.push({
          againstId: PLAYER_ID,
          reason: `heard from ${nameOf(g, teller)} that you were talking about them behind their back`,
          week: g.week,
          severity: 2,
        });
        logEvent(g, 'leak', `${nameOf(g, teller)} leaked what you said to ${nameOf(g, listener)} — and it was about them.`, [teller, listener]);
      } else {
        r.threat = clamp(r.threat + 6);
        logEvent(g, 'leak', `${nameOf(g, teller)} quietly passed along something you said to ${nameOf(g, listener)}.`, [teller, listener]);
      }
    }
  }

  // 3) Alliance health decay when members distrust each other
  for (const al of g.alliances) {
    if (al.dead) continue;
    const alive = al.members.filter((m) => !g.evicted.includes(m));
    if (alive.length < 2) {
      al.dead = true;
      continue;
    }
    let low = false;
    for (const [a, b] of pairwise(alive)) {
      if (a === PLAYER_ID || b === PLAYER_ID) continue;
      if (g.social[a][b].trust < 30) low = true;
    }
    if (low && rand() < 0.3) {
      al.dead = true;
      logEvent(g, 'alliance_dead', `Word around the house: "${al.name}" has fallen apart.`, alive);
    }
  }
}

function pairwise(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++)
    for (let j = i + 1; j < arr.length; j++) out.push([arr[i], arr[j]]);
  return out;
}

export function personality(g, id) {
  const h = g.houseguests.find((x) => x.id === id);
  return h && h.personality
    ? h.personality
    : { loyalty: 50, bitterness: 50, compSkill: 50, socialSkill: 50, chaos: 50, strategic: 50 };
}

function pick(arr, rand = Math.random) {
  return arr[Math.floor(rand() * arr.length)];
}

// ---- Proactive approaches ---------------------------------------------------
// Returns { npcId, reason, opener } | null. Called after phase transitions and
// periodically during social phases.

export function chooseApproacher(g, rand = Math.random) {
  const npcs = activeNpcIds(g);
  const candidates = [];

  const playerNominated = g.nominees.includes(PLAYER_ID);
  const playerIsHoh = g.hoh === PLAYER_ID;
  const playerHasVeto = g.vetoHolder === PLAYER_ID;

  for (const id of npcs) {
    const r = rel(g, id, PLAYER_ID);
    const p = personality(g, id);
    const inAlliance = sharedAlliance(g, id, PLAYER_ID);
    const nominated = g.nominees.includes(id);

    if (playerIsHoh && (g.phase === 'social_hoh' || g.phase === 'nominations_pending')) {
      // People come lobby the HoH
      const urgency = 40 + p.strategic * 0.4 + (100 - r.trust) * 0.2;
      candidates.push({
        npcId: id, weight: urgency,
        reason: 'lobby_hoh',
        opener: null,
      });
    }
    if (nominated && (g.phase === 'campaigning' || g.phase === 'social_veto')) {
      candidates.push({ npcId: id, weight: 90 + p.socialSkill * 0.3, reason: 'campaign', opener: null });
    }
    if (playerNominated && inAlliance && g.phase === 'campaigning') {
      candidates.push({ npcId: id, weight: 70, reason: 'ally_reassure', opener: null });
    }
    if (inAlliance && ['social_hoh', 'social_veto'].includes(g.phase)) {
      candidates.push({ npcId: id, weight: 35 + r.trust * 0.2, reason: 'ally_checkin', opener: null });
    }
    if (playerHasVeto && g.phase === 'social_veto' && nominated) {
      candidates.push({ npcId: id, weight: 100, reason: 'beg_veto', opener: null });
    }
    // Veto lobby: nominees beg the holder; others lobby about using it
    if (playerHasVeto && g.phase === 'veto_lobby') {
      candidates.push({ npcId: id, weight: nominated ? 110 : 30 + p.strategic * 0.3, reason: nominated ? 'beg_veto' : 'lobby_veto', opener: null });
    }
    // Renom scramble: player is HoH naming a replacement — everyone vulnerable pleads
    if (playerIsHoh && g.phase === 'renom_watch' && !nominated) {
      candidates.push({ npcId: id, weight: 55 + (100 - r.trust) * 0.4, reason: 'renom_scramble', opener: null });
    }
    // Confrontation over a fresh grudge
    const fresh = g.memory[id].grudges.find((gr) => gr.againstId === PLAYER_ID && gr.week === g.week && !gr.confronted);
    if (fresh && p.chaos + p.bitterness > 90) {
      candidates.push({ npcId: id, weight: 80 + p.chaos * 0.2, reason: 'confront', opener: null, grudge: fresh });
    }
    // Pure social visit
    if (r.bond > 60 && rand() < 0.3) {
      candidates.push({ npcId: id, weight: 20, reason: 'hangout', opener: null });
    }
    // Alliance pitch: strategic players who trust you but aren't aligned yet
    if (!inAlliance && r.trust > 56 && p.strategic > 55 && ['social_hoh', 'social_veto'].includes(g.phase)) {
      candidates.push({ npcId: id, weight: 30, reason: 'alliance_offer', opener: null });
    }
  }

  if (!candidates.length) return null;
  // Weighted pick, then a coin so approaches don't happen every single time
  const total = candidates.reduce((s, c) => s + c.weight, 0);
  if (rand() > Math.min(0.85, total / 260)) return null;
  let roll = rand() * total;
  for (const c of candidates) {
    roll -= c.weight;
    if (roll <= 0) {
      if (c.grudge) c.grudge.confronted = true;
      return c;
    }
  }
  return candidates[0];
}

export const APPROACH_REASON_TEXT = {
  lobby_hoh: 'wants a word with the HoH',
  campaign: 'is campaigning to stay',
  ally_reassure: 'wants to talk about the vote',
  ally_checkin: 'wants to check in',
  beg_veto: 'wants to talk about the veto',
  confront: 'has something to get off their chest',
  hangout: 'wants to hang out',
  alliance_offer: 'wants to talk about working together',
  lobby_veto: 'wants to talk about the veto decision',
  renom_scramble: 'is scrambling not to be the replacement',
};
