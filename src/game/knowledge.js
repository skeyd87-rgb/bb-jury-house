// Evidence read models. Public event ownership comes from engine IDs, never AI prose.
import { nameOf } from './state.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const PUBLIC = new Set(['hoh', 'veto_win', 'nominations', 'veto', 'eviction', 'final_hoh', 'final_cut']);

export function publicFacts(g, endIndex = (g.events || []).length - 1) {
  const facts = [];
  (g.events || []).forEach((e, index) => {
    if (index > endIndex || !PUBLIC.has(e.type)) return;
    const [actorId, ...targets] = e.actors || [];
    if (!actorId) return;
    const actor = nameOf(g, actorId);
    let text, kind = e.type;
    if (kind === 'hoh') text = `${actor} won Head of Household.`;
    if (kind === 'veto_win') text = `${actor} won the Power of Veto.`;
    if (kind === 'nominations') text = `${actor} nominated ${targets.map(id => nameOf(g, id)).join(' and ')}.`;
    if (kind === 'eviction') text = `${actor} was evicted and joined the jury.`;
    if (kind === 'final_hoh') text = `${actor} won the Final Head of Household.`;
    if (kind === 'final_cut') text = `${actor} evicted ${nameOf(g, targets[0])} at the Final 3.`;
    if (kind === 'veto') {
      if (/replacement nominee/.test(e.text)) {
        kind = 'replacement'; text = `${actor} named ${nameOf(g, targets[0])} as replacement nominee.`;
      } else if (/did not use/.test(e.text)) {
        kind = 'veto_unused'; text = `${actor} did not use the Power of Veto.`;
      } else if (targets[0]) {
        kind = 'veto_used'; text = `${actor} used the Power of Veto to save ${nameOf(g, targets[0])}.`;
      }
    }
    if (text) facts.push({ id: `event:${index}`, week: e.week, kind, actorId, targetIds: targets, text });
  });
  // Older saves/spectator simulations may record compHistory without a log entry.
  const cutoffWeek = g.events?.[endIndex]?.week ?? g.week;
  for (const [index, c] of (g.compHistory || []).entries()) {
    if (c.week > cutoffWeek || (endIndex < g.events.length - 1 && c.week === cutoffWeek) || !['hoh', 'veto'].includes(c.type)) continue;
    const kind = c.type === 'hoh' ? 'hoh' : 'veto_win';
    if (facts.some(f => f.week === c.week && f.kind === kind)) continue;
    facts.push({ id: `comp:${index}`, week: c.week, kind, actorId: c.winner, targetIds: [], text: `${nameOf(g, c.winner)} won ${kind === 'hoh' ? 'Head of Household' : 'the Power of Veto'}.` });
  }
  // Eviction ballots are secret, as on the show: each houseguest votes alone
  // and only the count is announced. The house knows the count, who was HoH
  // and who was on the block (nominees and the HoH do not vote). Each
  // houseguest also knows their own ballot (myBallots in captureKnowledge).
  const lastIsEviction = g.events?.[endIndex]?.type === 'eviction';
  for (const [index, v] of (g.voteHistory || []).entries()) {
    if (v.week > cutoffWeek || (endIndex < (g.events || []).length - 1 && v.week === cutoffWeek && !lastIsEviction)) continue;
    const ballots = Object.entries(v.votes || {}).filter(([voter]) => !voter.endsWith('_tiebreak'));
    if (!ballots.length) continue;
    const evicted = v.evicted || (g.events || []).find(e => e.type === 'eviction' && e.week === v.week)?.actors?.[0];
    const hoh = (g.compHistory || []).find(c => c.type === 'hoh' && c.week === v.week)?.winner;
    const tie = Object.keys(v.votes || {}).some((voter) => voter.endsWith('_tiebreak'));
    const count = voteCount(v, g);
    const noms = Object.keys(count);
    const kept = noms.find((n) => n !== evicted);
    const text = 'Week ' + v.week + ' eviction: ' + (evicted ? nameOf(g, evicted) + ' was evicted' : 'the house voted') +
      (kept ? ' by a vote of ' + (count[evicted] || 0) + ' to ' + (count[kept] || 0) + ' over ' + nameOf(g, kept) : '') + '.' +
      (tie ? ' It was a tie and ' + nameOf(g, hoh) + ', the HoH, broke it.' : '') +
      ' Ballots are cast in secret; only the count is announced.' +
      (hoh ? ' ' + nameOf(g, hoh) + ' was HoH and did not vote' + (tie ? ' except to break the tie' : '') + ';' : '') +
      (noms.length ? ' ' + noms.map((n) => nameOf(g, n)).join(' and ') + ' were on the block and did not vote.' : '');
    facts.push({ id: 'votes:' + index, week: v.week, kind: 'eviction_vote', actorId: evicted || hoh || ballots[0][0], targetIds: noms, count: Object.fromEntries(noms.map((n) => [nameOf(g, n), count[n] || 0])), text });
  }
  return facts;
}

// Who was on the block at the vote: the week's nominations, less a veto save,
// plus the replacement. For votes stored without their nominees.
export function nomineesAt(g, week) {
  let noms = [];
  for (const e of (g?.events || []).filter((x) => x.week === week)) {
    const [actor, ...targets] = e.actors || [];
    if (e.type === 'nominations') noms = targets.slice();
    else if (e.type === 'veto' && /replacement nominee/.test(e.text) && targets[0]) noms.push(targets[0]);
    else if (e.type === 'veto' && !/did not use/.test(e.text) && targets[0]) noms = noms.filter((n) => n !== targets[0]);
    void actor;
  }
  return noms;
}

// Votes per nominee. Single-player stores a tally; online the ballots (and,
// from 0.6.4, the nominees). Pass g to recover the nominees of an older vote.
export function voteCount(v, g = null) {
  const count = {};
  const noms = v.nominees || (v.tally && Object.keys(v.tally)) || (g ? nomineesAt(g, v.week) : []);
  for (const n of noms) count[n] = 0;
  for (const [voter, target] of Object.entries(v.votes || {})) if (!voter.endsWith('_tiebreak')) count[target] = (count[target] || 0) + 1;
  if (v.evicted && count[v.evicted] == null) count[v.evicted] = 0;
  return count;
}

// The ballots this houseguest cast: theirs alone to know.
export function myBallots(g, id) {
  return (g.voteHistory || []).filter((v) => v.votes?.[id]).map((v) => ({ week: v.week, votedToEvict: v.votes[id], name: nameOf(g, v.votes[id]) }));
}

export function captureKnowledge(g, id) {
  const mem = g.memory[id] || {};
  return clone({
    version: 1, week: g.week, phase: g.phase,
    publicFacts: publicFacts(g),
    myBallots: myBallots(g, id),
    statements: (mem.convoSummaries || []).filter(s => s.source === 'quoted_statement'),
    promises: (g.promises || []).filter(p => p.from === id || p.to === id || mem.promisesHeard?.includes(p.id)).map(p => ['vote', 'vote_evict'].includes(p.kind) && p.from !== id && !p.known ? { ...p, status: 'outcome unverified; individual ballots are secret' } : p),
    rumors: (mem.gossipHeard || []).map((r, index) => ({ ...r, id: `rumor:${id}:${index}`, status: 'unverified', sourceName: nameOf(g, r.fromId) || 'unknown source' })),
    interpretations: (mem.grudges || []).map(r => ({ ...r, status: 'subjective reaction, not proof' })),
    feelings: g.social[id] || {},
  });
}

export function knowledgeFor(g, id) {
  const mem = g.memory[id] || {};
  if (!(g.evicted || []).includes(id)) return captureKnowledge(g, id);
  if (mem.juryRecord?.version === 1) return clone(mem.juryRecord);
  // Read-only compatibility for existing saves. Never grant an old juror later events.
  const evictionIndex = (g.events || []).findIndex(e => e.type === 'eviction' && e.actors?.[0] === id);
  const week = evictionIndex >= 0 ? g.events[evictionIndex].week : (g.voteHistory || []).find(v => v.evicted === id)?.week;
  const before = Number.isFinite(week) ? week : -Infinity;
  return {
    version: 1, legacy: true, week: Number.isFinite(week) ? week : null,
    publicFacts: evictionIndex >= 0 ? publicFacts(g, evictionIndex) : publicFacts(g).filter(f => f.week < before),
    statements: (mem.convoSummaries || []).filter(s => s.source === 'quoted_statement' && s.week <= before),
    // Older promises lack status-change timestamps; do not assume their final status was known at eviction.
    promises: (g.promises || []).filter(p => p.week <= before && (p.from === id || p.to === id || mem.promisesHeard?.includes(p.id))).map(p => ({ ...p, status: 'recorded; outcome at eviction unknown' })),
    myBallots: myBallots(g, id).filter((b) => b.week <= before),
    rumors: (mem.gossipHeard || []).filter(r => r.week <= before).map((r, index) => ({ ...r, id: `rumor:${id}:${index}`, status: 'unverified', sourceName: nameOf(g, r.fromId) || 'unknown source' })),
    interpretations: [], feelings: clone(g.social[id] || {}),
  };
}

export function evidenceFor(g, id) {
  const k = knowledgeFor(g, id);
  return [
    ...k.publicFacts,
    ...(k.statements || []).map((s, index) => ({ id: `statement:${id}:${index}`, week: s.week, kind: 'statement', actorId: s.withId, targetIds: [id], text: `Recorded conversation excerpt: ${s.summary}. This establishes what was said, not whether the claim is true.` })),
    ...k.promises.map(p => ({ id: `promise:${p.id}`, week: p.week, kind: 'promise', actorId: p.from, targetIds: [p.to], status: p.status, text: `${nameOf(g, p.from)} promised ${nameOf(g, p.to)}: ${JSON.stringify(p.text)}. Recorded status: ${p.status}.` })),
    ...k.rumors.map(r => ({ id: r.id, week: r.week, kind: 'rumor', actorId: r.fromId, targetIds: r.aboutId ? [r.aboutId] : [], text: `UNVERIFIED: ${r.sourceName} reportedly said ${JSON.stringify(r.text)}. Belief is not proof.` })),
  ];
}

export function formatEvidence(g, id) {
  // Each houseguest's own ballot sits beside the count: it is theirs to know,
  // and to lie about if they choose.
  const own = (f) => {
    if (f.kind !== 'eviction_vote') return '';
    const v = (g.voteHistory || []).find((x) => x.week === f.week)?.votes?.[id];
    return v ? ` Your own secret ballot (${nameOf(g, id)}): to evict ${nameOf(g, v)}.` : '';
  };
  return evidenceFor(g, id).map(f => `[${f.id}] Week ${f.week}: ${f.text}${own(f)}`).join('\n') || 'No recorded events. Ask an open question; do not invent a shared history.';
}

export function currentSituation(g) {
  return {
    week: g.week, phase: g.phase,
    hoh: g.hoh ? { id: g.hoh, name: nameOf(g, g.hoh) } : null,
    vetoWinner: g.vetoHolder ? { id: g.vetoHolder, name: nameOf(g, g.vetoHolder) } : null,
    vetoUse: g.vetoUsed ? { ...g.vetoUsed } : null,
    pendingReplacement: !!g.pendingRenom,
    nominees: [...g.nominees],
  };
}

export function rememberExchange(g, npcId, speakerId, text) {
  const mem = g.memory[npcId];
  if (!mem) return;
  mem.convoSummaries.push({ withId: speakerId, week: g.week, source: 'quoted_statement', summary: `${nameOf(g, speakerId)} said: ${JSON.stringify(String(text).slice(0, 300))}` });
  mem.convoSummaries = mem.convoSummaries.slice(-20);
}
