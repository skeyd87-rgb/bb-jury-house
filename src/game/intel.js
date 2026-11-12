// What the player can know. The engine holds exact numbers for every
// relationship; a houseguest never gets to see those. This module turns the
// truth into the kind of read a person in the house would actually have:
// coarse tiers for how someone feels about you, a vote count limited to the
// people who trust you enough to tell you, and scraps overheard when two
// houseguests talk game within earshot.
//
// Everything here is read-only except recordIntel(), which appends to the
// player's own notebook (g.intel). No relationship is ever changed from here.

import { PLAYER_ID } from './cast.js';
import { activeIds, activeNpcIds, rel, nameOf, sharedAlliance } from './state.js';
import { nominationDesire, evictionDesire } from './season.js';

// The decision functions add noise on every call. A read should be the
// houseguest's lean right now, not one roll of the dice, so reads pass a flat
// 0.5 (zero noise). The real nomination or vote still rolls — a read is a
// forecast, never a guarantee.
const FLAT = () => 0.5;

const TIERS = {
  trust: ['Hostile', 'Wary', 'Undecided', 'Trusts you', 'All in'],
  bond: ['Cold', 'Distant', 'Friendly', 'Close', 'Family'],
  threat: ['Ignores you', 'Not worried', 'Watching you', 'Sees a threat', 'Wants you out'],
};

export function tier(v) {
  return v < 25 ? 0 : v < 42 ? 1 : v < 58 ? 2 : v < 75 ? 3 : 4;
}

// How one houseguest feels about the player, as the player would read it.
export function readHouseguest(g, id) {
  const r = rel(g, id, PLAYER_ID);
  const t = tier(r.trust), b = tier(r.bond), th = tier(r.threat);
  const grudges = (g.memory[id]?.grudges || []).filter((x) => x.againstId === PLAYER_ID);
  const open = g.promises.filter((p) => p.status === 'open');
  const score = t + b * 0.6 - th * 0.5 - grudges.length * 0.8;
  const allied = sharedAlliance(g, id, PLAYER_ID);
  // "Ally" has to be earned: a shared alliance that is actually healthy, or
  // someone all-in without one. A friendly stranger is only warm.
  const standing = (allied && score >= 3.4) || score >= 5.2 ? 'ally'
    : score >= 3.8 ? 'warm' : score >= 2.4 ? 'neutral' : score >= 1.2 ? 'cool' : 'hostile';
  return {
    id,
    trust: { level: t, label: TIERS.trust[t] },
    bond: { level: b, label: TIERS.bond[b] },
    threat: { level: th, label: TIERS.threat[th] },
    standing,
    allied,
    youPromised: open.filter((p) => p.from === PLAYER_ID && p.to === id).map((p) => p.text),
    promisedYou: open.filter((p) => p.from === id && p.to === PLAYER_ID).map((p) => p.text),
    grudges: grudges.map((x) => x.reason),
  };
}

export function readHouse(g) {
  return activeNpcIds(g).map((id) => readHouseguest(g, id));
}

// Will this houseguest tell the player the truth about their vote?
function confidesInPlayer(g, id) {
  return sharedAlliance(g, id, PLAYER_ID) || rel(g, id, PLAYER_ID).trust >= 58;
}

// The vote count as the player can piece it together. Only people who
// confide in you show a lean; everyone else is a question mark you have to
// go and earn. Returns null when there is no vote to count.
export function voteRead(g) {
  if (!g.nominees || g.nominees.length !== 2) return null;
  const [n1, n2] = g.nominees;
  const voters = activeIds(g).filter((id) => id !== g.hoh && !g.nominees.includes(id));
  const rows = [];
  const count = { [n1]: 0, [n2]: 0, torn: 0, unread: 0 };
  for (const v of voters) {
    if (v === PLAYER_ID) continue;
    if (!confidesInPlayer(g, v)) { rows.push({ id: v, lean: 'unread' }); count.unread++; continue; }
    const d = evictionDesire(g, v, n1, n2, FLAT);
    const lean = Math.abs(d) < 7 ? 'torn' : d > 0 ? n1 : n2;
    rows.push({ id: v, lean });
    count[lean]++;
  }
  return {
    nominees: [n1, n2], rows, count,
    playerVotes: voters.includes(PLAYER_ID),
    needed: Math.floor(voters.length / 2) + 1,
  };
}

// ---- Huddles: two houseguests talking game where you might hear it ---------

export function pickHuddlePair(g, rand = Math.random, excludeIds = []) {
  const npcs = activeNpcIds(g).filter((id) => !excludeIds.includes(id));
  if (npcs.length < 2) return null;
  const pairs = [];
  for (let i = 0; i < npcs.length; i++) {
    for (let j = i + 1; j < npcs.length; j++) {
      const a = npcs[i], b = npcs[j];
      let w = 8 + rel(g, a, b).bond * 0.25 + rel(g, b, a).trust * 0.15;
      if (sharedAlliance(g, a, b)) w += 40;
      if (g.nominees.includes(a) !== g.nominees.includes(b)) w += 14; // a nominee working a voter
      if (g.hoh === a || g.hoh === b) w += 10;
      pairs.push({ a, b, w });
    }
  }
  const total = pairs.reduce((s, p) => s + p.w, 0);
  let roll = rand() * total;
  for (const p of pairs) {
    roll -= p.w;
    if (roll <= 0) return rand() < 0.5 ? [p.a, p.b] : [p.b, p.a];
  }
  return [pairs[0].a, pairs[0].b];
}

function topTargets(g, id, exclude = []) {
  return activeIds(g)
    .filter((x) => x !== id && !exclude.includes(x))
    .map((x) => ({ id: x, d: nominationDesire(g, id, x, FLAT) }))
    .sort((p, q) => q.d - p.d);
}

const who = (g, id) => (id === PLAYER_ID ? 'you' : nameOf(g, id));

// One true thing the player could catch from a and b talking. Drawn from live
// state, so it is real information — and, like everything else in the house,
// it can be out of date by the time it matters.
export function huddleIntel(g, a, b, rand = Math.random) {
  const A = nameOf(g, a), B = nameOf(g, b);
  const known = new Set((g.intel || []).map((x) => x.key));
  const out = [];
  const add = (weight, kind, key, text, aboutId = null) => {
    out.push({ weight: known.has(key) ? weight * 0.15 : weight, kind, key, text, aboutId });
  };

  for (const al of g.alliances) {
    if (al.dead || al.members.includes(PLAYER_ID)) continue;
    if (!al.members.includes(a) || !al.members.includes(b)) continue;
    const rest = al.members.filter((m) => m !== a && m !== b && !g.evicted.includes(m)).map((m) => nameOf(g, m));
    add(55, 'alliance', `al:${al.id}`,
      `${A} and ${B} are working together — they call it "${al.name}"${rest.length ? `, with ${rest.join(' and ')}` : ''}.`);
  }

  const speaker = rand() < 0.5 ? a : b;
  const S = nameOf(g, speaker), L = speaker === a ? B : A;
  const listener = speaker === a ? b : a;
  const targets = topTargets(g, speaker, [listener]);

  if (g.hoh === speaker && g.phase === 'social_hoh' && targets.length >= 2) {
    const [t1, t2] = targets;
    add(75, 'plan', `noms:${g.week}:${speaker}`,
      `${S} told ${L} the plan: ${who(g, t1.id)} and ${who(g, t2.id)} on the block. Nothing is locked until the ceremony.`,
      t1.id);
  } else if (targets.length) {
    const t = targets[0];
    add(38, 'target', `tgt:${g.week}:${speaker}:${t.id}`,
      t.id === PLAYER_ID
        ? `${S} told ${L} that if they win power, you are the one going up.`
        : `${S} told ${L} that ${nameOf(g, t.id)} is the next one who has to go.`,
      t.id);
  }

  if (g.nominees.length === 2 && g.hoh !== speaker && !g.nominees.includes(speaker)) {
    const [n1, n2] = g.nominees;
    const d = evictionDesire(g, speaker, n1, n2, FLAT);
    add(48, 'vote', `vote:${g.week}:${speaker}`,
      Math.abs(d) < 7
        ? `${S} admitted to ${L} they still don't know how they're voting.`
        : `${S} told ${L} they're voting to evict ${who(g, d > 0 ? n1 : n2)}.`,
      d > 0 ? n1 : n2);
  }

  const r = rel(g, speaker, PLAYER_ID);
  if (r.trust < 40 || r.threat > 62) {
    add(30, 'you', `you:${g.week}:${speaker}`,
      r.threat > 62
        ? `${S} told ${L} you're playing too hard and somebody needs to take the shot.`
        : `${S} told ${L} they don't believe a word you say.`,
      PLAYER_ID);
  } else if (r.trust > 68) {
    add(18, 'you', `you:${g.week}:${speaker}`, `${S} vouched for you to ${L} — said you've been straight with them.`, PLAYER_ID);
  }

  if (!out.length) {
    add(1, 'nothing', `small:${g.week}:${a}:${b}`, `${A} and ${B} were only talking about home. Nothing you can use.`);
  }

  const total = out.reduce((s, x) => s + x.weight, 0);
  let roll = rand() * total;
  let pick = out[0];
  for (const x of out) { roll -= x.weight; if (roll <= 0) { pick = x; break; } }
  return { kind: pick.kind, key: pick.key, text: pick.text, aboutId: pick.aboutId, sourceIds: [a, b], week: g.week, phase: g.phase };
}

// The player's notebook. Newest last, capped.
export function recordIntel(g, item) {
  g.intel ||= [];
  g.intel.push(item);
  if (g.intel.length > 40) g.intel.splice(0, g.intel.length - 40);
  return item;
}
