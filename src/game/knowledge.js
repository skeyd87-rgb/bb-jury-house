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
  return facts;
}

export function captureKnowledge(g, id) {
  const mem = g.memory[id] || {};
  return clone({
    version: 1, week: g.week, phase: g.phase,
    publicFacts: publicFacts(g),
    statements: (mem.convoSummaries || []).filter(s => s.source === 'quoted_statement'),
    promises: (g.promises || []).filter(p => p.from === id || p.to === id || mem.promisesHeard?.includes(p.id)).map(p => ['vote', 'vote_evict'].includes(p.kind) && p.from !== id ? { ...p, status: 'outcome unverified; individual ballots are secret' } : p),
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
  return evidenceFor(g, id).map(f => `[${f.id}] Week ${f.week}: ${f.text}`).join('\n') || 'No recorded events. Ask an open question; do not invent a shared history.';
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
