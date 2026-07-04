// Season state machine. Phases flow:
// week_intro -> hoh_comp -> social_hoh -> nominations -> social_veto ->
// veto_comp -> veto_ceremony -> campaigning -> eviction -> (next week | final3 | finale)
//
// All NPC decisions are probabilistic over live social state — never scripted.

import { PLAYER_ID } from './cast.js';
import {
  activeIds,
  activeNpcIds,
  nameOf,
  rel,
  clamp,
  sharedAlliance,
  openPromisesBetween,
  logEvent,
} from './state.js';
import { personality, recordBetrayalIfAny, markKeptPromises, simulateHouseLife } from './social.js';

export const PHASES = [
  'week_intro',
  'hoh_comp',
  'social_hoh',
  'nominations',
  'social_veto',
  'veto_comp',
  'veto_lobby',
  'veto_ceremony',
  'renom_watch',
  'campaigning',
  'eviction',
];

export function phaseLabel(phase) {
  return {
    week_intro: 'New Week',
    hoh_comp: 'HoH Competition',
    social_hoh: 'The House Reacts',
    nominations: 'Nomination Ceremony',
    social_veto: 'Before the Veto',
    veto_comp: 'Veto Competition',
    veto_lobby: 'Before the Ceremony',
    veto_ceremony: 'Veto Ceremony',
    renom_watch: 'Renom Watch',
    campaigning: 'Campaign Time',
    eviction: 'Live Eviction',
    final3: 'Final 3',
    final_hoh: 'Final HoH',
    final_eviction: 'Final Eviction',
    jury_qa: 'Jury Questioning',
    jury_vote: 'The Jury Votes',
    winner: 'Season Finale',
  }[phase] || phase;
}

// ---- Comp scoring -----------------------------------------------------------

export function npcCompScore(g, id, rand = Math.random) {
  const p = personality(g, id);
  // skill base + wide noise; a weak comp player can still upset
  return p.compSkill * 0.6 + rand() * 55;
}

// Resolve a comp given the player's normalized performance (0-100).
export function resolveComp(g, playerScore, { excludeIds = [], playerPlays = true } = {}) {
  const contenders = activeIds(g).filter((id) => !excludeIds.includes(id));
  const scores = {};
  for (const id of contenders) {
    scores[id] = id === PLAYER_ID
      ? (playerPlays ? playerScore + Math.random() * 8 : -1)
      : npcCompScore(g, id);
  }
  const winner = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  // Winning comps paints a target: everyone else sees the winner as more dangerous.
  for (const id of activeIds(g)) {
    if (id === winner || id === PLAYER_ID) continue;
    if (g.social[id][winner]) g.social[id][winner].threat = clamp(g.social[id][winner].threat + 7);
  }
  return { winner, scores };
}

// ---- Nominations ------------------------------------------------------------
// HoH ranks everyone by nomination desire = threat + distrust + grudges
// - alliance/promise protection, then samples 2 via weighted randomness.

export function nominationDesire(g, hohId, targetId) {
  const r = rel(g, hohId, targetId);
  const p = personality(g, hohId);
  let d = r.threat * (0.5 + p.strategic / 200) + (100 - r.trust) * 0.45 + (60 - r.bond) * 0.25;

  if (sharedAlliance(g, hohId, targetId)) d -= 45;
  if (openPromisesBetween(g, hohId, targetId).some((pr) => pr.from === hohId && pr.kind !== 'info')) {
    d -= 55 * (p.loyalty / 100); // promises restrain loyal players far more
  }
  const grudges = g.memory[hohId]?.grudges.filter((x) => x.againstId === targetId) || [];
  d += grudges.reduce((s, x) => s + x.severity * 12, 0) * (0.5 + p.bitterness / 150);
  d += (Math.random() - 0.5) * 18; // never deterministic
  return d;
}

export function decideNominations(g, hohId) {
  const pool = activeIds(g).filter((id) => id !== hohId);
  const ranked = pool
    .map((id) => ({ id, d: nominationDesire(g, hohId, id) }))
    .sort((a, b) => b.d - a.d);
  // Weighted sample from top of the list so it's probabilistic, not fixed
  const nominees = [];
  const bag = ranked.slice(0, Math.min(4, ranked.length));
  while (nominees.length < 2 && bag.length) {
    const total = bag.reduce((s, x) => s + Math.max(5, x.d), 0);
    let roll = Math.random() * total;
    for (let i = 0; i < bag.length; i++) {
      roll -= Math.max(5, bag[i].d);
      if (roll <= 0) {
        nominees.push(bag[i].id);
        bag.splice(i, 1);
        break;
      }
    }
  }
  return nominees;
}

export function applyNominations(g, hohId, nominees) {
  g.nominees = nominees;
  for (const n of nominees) {
    recordBetrayalIfAny(g, hohId, 'nominated', n);
    if (n !== PLAYER_ID) {
      const r = rel(g, n, hohId);
      r.trust = clamp(r.trust - 12);
      r.bond = clamp(r.bond - 8);
    }
  }
  logEvent(g, 'nominations', `${nameOf(g, hohId)} nominated ${nominees.map((n) => nameOf(g, n)).join(' and ')}.`, [hohId, ...nominees]);
}

// ---- Veto ---------------------------------------------------------------

export function vetoPlayers(g) {
  // HoH + 2 nominees + up to 3 random others
  const base = [g.hoh, ...g.nominees];
  const others = activeIds(g).filter((id) => !base.includes(id));
  shuffle(others);
  return [...base, ...others.slice(0, 3)];
}

export function decideVetoUse(g, holderId) {
  // Returns { use: bool, savedId } — engine decision for NPC holders.
  if (g.nominees.includes(holderId)) return { use: true, savedId: holderId };
  // Final 4: a non-nominated holder who uses the veto becomes the replacement —
  // nobody does that to themselves. Exception: the HoH can't be nominated, so
  // an HoH veto holder is free to use it (the 4th houseguest goes up).
  if (activeIds(g).length <= 4 && g.hoh !== holderId) return { use: false };
  const p = personality(g, holderId);
  let best = null;
  for (const nom of g.nominees) {
    const r = rel(g, holderId, nom);
    let want = (r.trust - 55) * 0.8 + (r.bond - 50) * 0.5 - r.threat * 0.25;
    if (sharedAlliance(g, holderId, nom)) want += 30;
    if (openPromisesBetween(g, holderId, nom).some((pr) => pr.from === holderId && pr.kind === 'safety'))
      want += 40 * (p.loyalty / 100);
    want -= 15; // using the veto paints a target; default is keep noms
    want += (Math.random() - 0.5) * 16;
    if (!best || want > best.want) best = { savedId: nom, want };
  }
  return { use: best.want > 10, savedId: best.savedId };
}

export function decideReplacement(g, hohId, excluded) {
  let pool = activeIds(g).filter((id) => id !== hohId && !excluded.includes(id));
  // Final-4 safety: if exclusions empty the pool, the veto holder goes up.
  if (!pool.length) pool = activeIds(g).filter((id) => id !== hohId && !g.nominees.includes(id));
  const ranked = pool.map((id) => ({ id, d: nominationDesire(g, hohId, id) })).sort((a, b) => b.d - a.d);
  // softly weighted top pick
  const bag = ranked.slice(0, Math.min(3, ranked.length));
  const total = bag.reduce((s, x) => s + Math.max(5, x.d), 0);
  let roll = Math.random() * total;
  for (const x of bag) {
    roll -= Math.max(5, x.d);
    if (roll <= 0) return x.id;
  }
  return bag[0].id;
}

export function applyVeto(g, holderId, use, savedId, replacementId) {
  if (!use) {
    g.vetoUsed = null;
    // nominees who begged and were left: light resentment if bonded
    logEvent(g, 'veto', `${nameOf(g, holderId)} did not use the Power of Veto.`, [holderId]);
    return;
  }
  applyVetoSave(g, holderId, savedId);
  applyReplacement(g, replacementId);
}

// Part 1 of a used veto: pull the saved nominee off the block. The replacement
// is named separately (applyReplacement) so a "renom watch" social window can
// sit between the two.
export function applyVetoSave(g, holderId, savedId) {
  markKeptPromises(g, holderId, 'vetoed', savedId);
  g.nominees = g.nominees.filter((n) => n !== savedId);
  g.vetoUsed = { holderId, savedId, replacementId: null };
  if (savedId !== PLAYER_ID && savedId !== holderId) {
    const r = rel(g, savedId, holderId);
    r.trust = clamp(r.trust + 20);
    r.bond = clamp(r.bond + 15);
  }
  logEvent(g, 'veto', `${nameOf(g, holderId)} used the Power of Veto on ${nameOf(g, savedId)}.`, [holderId, savedId]);
}

// Part 2: HoH names the replacement nominee.
export function applyReplacement(g, replacementId) {
  g.nominees.push(replacementId);
  if (g.vetoUsed) g.vetoUsed.replacementId = replacementId;
  recordBetrayalIfAny(g, g.hoh, 'nominated', replacementId);
  if (replacementId !== PLAYER_ID) {
    const r = rel(g, replacementId, g.hoh);
    r.trust = clamp(r.trust - 15);
    r.bond = clamp(r.bond - 10);
  }
  logEvent(g, 'veto', `${nameOf(g, g.hoh)} named ${nameOf(g, replacementId)} as the replacement nominee.`, [g.hoh, replacementId]);
}

// ---- Eviction vote -----------------------------------------------------------

export function evictionDesire(g, voterId, nomineeId, otherNomineeId) {
  const r = rel(g, voterId, nomineeId);
  const ro = rel(g, voterId, otherNomineeId);
  const p = personality(g, voterId);
  // Want to evict nominee = their threat & my distrust, relative to the other nominee
  let d = (r.threat - ro.threat) * (0.4 + p.strategic / 250)
        + (ro.trust - r.trust) * 0.5
        + (ro.bond - r.bond) * 0.35;
  if (sharedAlliance(g, voterId, nomineeId)) d -= 30;
  if (sharedAlliance(g, voterId, otherNomineeId)) d += 30;
  // vote promises
  if (openPromisesBetween(g, voterId, nomineeId).some((pr) => pr.from === voterId && pr.kind === 'vote'))
    d -= 45 * (p.loyalty / 100);
  if (openPromisesBetween(g, voterId, otherNomineeId).some((pr) => pr.from === voterId && pr.kind === 'vote'))
    d += 45 * (p.loyalty / 100);
  const grudges = g.memory[voterId]?.grudges.filter((x) => x.againstId === nomineeId) || [];
  d += grudges.reduce((s, x) => s + x.severity * 10, 0);
  d += (Math.random() - 0.5) * (10 + p.chaos * 0.3); // chaos players are swingy
  return d;
}

// Returns { votes: {voterId: evictedTargetId}, evicted, tally, tiedBrokenByHoh }
export function resolveEviction(g, playerVote /* nominee id or null if player is nominee/HoH */) {
  const [n1, n2] = g.nominees;
  const voters = activeIds(g).filter((id) => id !== g.hoh && !g.nominees.includes(id));
  const votes = {};
  for (const v of voters) {
    if (v === PLAYER_ID) {
      votes[v] = playerVote || n1;
      continue;
    }
    const d1 = evictionDesire(g, v, n1, n2);
    votes[v] = d1 >= 0 ? n1 : n2;
  }
  const tally = { [n1]: 0, [n2]: 0 };
  for (const t of Object.values(votes)) tally[t]++;

  let evicted, tiedBrokenByHoh = false;
  if (tally[n1] === tally[n2]) {
    tiedBrokenByHoh = true;
    if (g.hoh === PLAYER_ID) {
      evicted = null; // UI must ask the player to break the tie
    } else {
      evicted = evictionDesire(g, g.hoh, n1, n2) >= 0 ? n1 : n2;
    }
  } else {
    evicted = tally[n1] > tally[n2] ? n1 : n2;
  }
  return { votes, evicted, tally, tiedBrokenByHoh };
}

export function applyEviction(g, evicted, votes) {
  const survivor = g.nominees.find((n) => n !== evicted);

  // Resolve third-party vote promises ("I'll vote to evict X") for this week.
  for (const p of g.promises) {
    if (p.status !== 'open' || p.kind !== 'vote_evict' || !p.targetId) continue;
    if (!g.nominees.includes(p.targetId)) continue; // their target wasn't up
    const cast = votes[p.from];
    if (!cast) {
      p.status = 'void'; // promiser had no vote (HoH/nominee) — deal can't be judged
      continue;
    }
    p.status = cast === p.targetId ? 'kept' : 'broken';
    if (p.to !== PLAYER_ID && g.memory[p.to] && !g.evicted.includes(p.to)) {
      const r = rel(g, p.to, p.from);
      if (p.status === 'kept') {
        r.trust = clamp(r.trust + 10);
        r.bond = clamp(r.bond + 5);
      } else {
        r.trust = clamp(r.trust - 20);
        g.memory[p.to].grudges.push({
          againstId: p.from,
          reason: `promised to vote out ${nameOf(g, p.targetId)} and didn't`,
          week: g.week,
          severity: 2,
        });
      }
    }
    if (p.status === 'kept') logEvent(g, 'promise_kept', `${nameOf(g, p.from)} kept a promise to ${nameOf(g, p.to)} (voted out ${nameOf(g, p.targetId)}).`, [p.from, p.to]);
  }

  for (const [voter, target] of Object.entries(votes)) {
    if (target === evicted) {
      recordBetrayalIfAny(g, voter, 'voted_against', evicted);
    } else {
      markKeptPromises(g, voter, 'voted_keep', target === survivor ? evicted : survivor);
      // Keep-votes warm the survivor toward the voter
      if (survivor !== PLAYER_ID && voter !== survivor && g.social[survivor]?.[voter]) {
        // (voting to evict the OTHER nominee = voting to keep survivor)
      }
    }
  }
  // Survivor gratitude toward those who kept them
  if (survivor !== PLAYER_ID) {
    for (const [voter, target] of Object.entries(votes)) {
      if (target === evicted && g.social[survivor]?.[voter]) {
        g.social[survivor][voter].trust = clamp(g.social[survivor][voter].trust + 8);
        g.social[survivor][voter].bond = clamp(g.social[survivor][voter].bond + 5);
      }
    }
  }

  g.evicted.push(evicted);
  g.jury.push(evicted);
  // Freeze jury memory: what this juror carries to the end
  if (evicted !== PLAYER_ID) snapshotJuryNotes(g, evicted, votes);
  // Retire open promises to/from the evicted. Leaving the house dissolves a
  // deal — it is VOID, not broken (jurors only resent promises actually
  // violated). Alliance pledges you never turned on count as honored.
  for (const p of g.promises) {
    if (p.status !== 'open' || (p.from !== evicted && p.to !== evicted)) continue;
    if (p.kind === 'final2') continue; // jurors remember final-two deals
    p.status = p.kind === 'alliance' ? 'kept' : 'void';
  }
  logEvent(g, 'eviction', `${nameOf(g, evicted)} was evicted and joins the jury.`, [evicted]);
  g.nominees = [];
  g.vetoHolder = null;
  g.vetoUsed = null;
}

function snapshotJuryNotes(g, jurorId, votes) {
  const mem = g.memory[jurorId];
  const notes = [];
  const r = rel(g, jurorId, PLAYER_ID);
  notes.push(`Final feelings toward the player when evicted: trust ${r.trust}, bond ${r.bond}, respect-for-threat ${r.threat}.`);
  for (const gr of mem.grudges) notes.push(`Grudge vs ${nameOf(g, gr.againstId)} (wk ${gr.week}): ${gr.reason}.`);
  for (const b of mem.betrayalsWitnessed.slice(-6)) notes.push(`Saw: ${b.what} (wk ${b.week}).`);
  const brokenToMe = g.promises.filter((p) => p.status === 'broken' && p.to === jurorId);
  for (const p of brokenToMe) notes.push(`${nameOf(g, p.from)} broke a promise to me: "${p.text}".`);
  const keptToMe = g.promises.filter((p) => p.status === 'kept' && p.to === jurorId);
  for (const p of keptToMe) notes.push(`${nameOf(g, p.from)} kept a promise: "${p.text}".`);
  for (const s of mem.convoSummaries.slice(-6)) notes.push(`(wk ${s.week}) with ${nameOf(g, s.withId)}: ${s.summary}`);
  const whoVotedMeOut = Object.entries(votes).filter(([, t]) => t === jurorId).map(([v]) => nameOf(g, v));
  if (whoVotedMeOut.length) notes.push(`Voted to evict me: ${whoVotedMeOut.join(', ')}.`);
  mem.juryNotes = notes.slice(0, 18);
}

// ---- Week / phase advancement --------------------------------------------------

export function nextPhase(g) {
  simulateHouseLife(g);
  g.chatTurnsThisPhase = 0;
  const idx = PHASES.indexOf(g.phase);
  if (g.phase === 'eviction') {
    if (activeIds(g).length <= 3) {
      g.phase = 'final3';
    } else {
      g.week++;
      g.lastHoh = g.hoh; // outgoing HoH can't compete for HoH twice in a row
      g.hoh = null;
      g.phase = 'week_intro';
    }
  } else if (idx >= 0 && idx < PHASES.length - 1) {
    g.phase = PHASES[idx + 1];
  }
  return g.phase;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}
