// Headless season simulator: runs full seasons with random player behavior
// using the fallback dialogue engine. Reports errors and stat sanity to the
// page + console. Open /test.html to run.

import { newGame, activeIds, activeNpcIds, nameOf } from '../game/state.js';
import {
  resolveComp, decideNominations, applyNominations, vetoPlayers,
  decideVetoUse, decideReplacement, applyVeto, resolveEviction, applyEviction,
  nextPhase, evictionDesire,
} from '../game/season.js';
import { simulateHouseLife, chooseApproacher } from '../game/social.js';
import { PLAYER_ID } from '../game/cast.js';
import { fallbackChat, fallbackJurorQuestion, fallbackJurorVote } from '../ai/fallback.js';
import { applyChatEffects } from '../game/social.js';

const PLAYER_LINES = [
  'Want to work together? Final two, you and me.',
  "I promise I won't put you up this week.",
  'I think we should target Marcus, he runs everything.',
  'Who are you voting for?',
  'You lied to me! You promised!',
  'I love hanging out with you, honestly.',
  'Please keep me this week, you have my word I will protect you.',
  'What is the plan for the veto?',
];

function chatRandomly(g, n = 4) {
  for (let i = 0; i < n; i++) {
    const npcs = activeNpcIds(g);
    const id = npcs[Math.floor(Math.random() * npcs.length)];
    const msg = PLAYER_LINES[Math.floor(Math.random() * PLAYER_LINES.length)];
    const { effects } = fallbackChat(g, id, msg);
    applyChatEffects(g, id, msg, effects);
    if (effects.summary) g.memory[id].convoSummaries.push({ withId: PLAYER_ID, week: g.week, summary: effects.summary });
  }
}

function simSeason(log) {
  const g = newGame('Sim');
  let guard = 0;
  while (activeIds(g).length > 3 && guard++ < 30) {
    // HoH — outgoing HoH sits out
    g.phase = 'hoh_comp';
    const outgoing = g.lastHoh && !g.evicted.includes(g.lastHoh) ? g.lastHoh : null;
    const exclude = outgoing ? [outgoing] : [];
    const hoh = resolveComp(g, Math.random() * 100, { excludeIds: exclude });
    if (outgoing && hoh.winner === outgoing) throw new Error('outgoing HoH won HoH again');
    g.hoh = hoh.winner;
    g.phase = 'social_hoh';
    chatRandomly(g);
    simulateHouseLife(g);
    chooseApproacher(g);

    // Noms
    g.phase = 'nominations';
    const noms = g.hoh === PLAYER_ID
      ? activeNpcIds(g).slice(0, 2)
      : decideNominations(g, g.hoh);
    if (noms.length !== 2) throw new Error('nominations != 2: ' + JSON.stringify(noms));
    applyNominations(g, g.hoh, noms);

    // Veto
    g.phase = 'veto_comp';
    const vp = vetoPlayers(g);
    const notPlaying = activeIds(g).filter((id) => !vp.includes(id));
    const veto = resolveComp(g, Math.random() * 100, { excludeIds: notPlaying, playerPlays: vp.includes(PLAYER_ID) });
    g.vetoHolder = veto.winner;
    const d = g.vetoHolder === PLAYER_ID
      ? { use: Math.random() < 0.4, savedId: g.nominees[0] }
      : decideVetoUse(g, g.vetoHolder);
    if (d.use) {
      const repl = decideReplacement(g, g.hoh, [...g.nominees, d.savedId, g.vetoHolder]);
      if (g.nominees.includes(repl) || repl === g.hoh || repl === d.savedId) throw new Error('bad replacement ' + repl);
      applyVeto(g, g.vetoHolder, true, d.savedId, repl);
    } else {
      applyVeto(g, g.vetoHolder, false);
    }
    if (g.nominees.length !== 2) throw new Error('nominees != 2 after veto');

    // Eviction
    g.phase = 'campaigning';
    chatRandomly(g, 2);
    g.phase = 'eviction';
    const playerVotes = !g.nominees.includes(PLAYER_ID) && g.hoh !== PLAYER_ID;
    const pv = playerVotes ? g.nominees[Math.floor(Math.random() * 2)] : null;
    let { votes, evicted, tiedBrokenByHoh } = resolveEviction(g, pv);
    if (evicted === null) evicted = g.nominees[0]; // player-HoH tie-break
    applyEviction(g, evicted, votes);
    if (evicted === PLAYER_ID) return { result: 'player_evicted', week: g.week, g };
    nextPhase(g);
  }
  if (guard >= 30) throw new Error('season did not converge');

  // Final 3
  const three = activeIds(g);
  if (three.length !== 3) throw new Error('final3 size ' + three.length);
  const fhoh = resolveComp(g, Math.random() * 100, { excludeIds: [] });
  const others = three.filter((id) => id !== fhoh.winner);
  const cut = fhoh.winner === PLAYER_ID
    ? others[Math.floor(Math.random() * 2)]
    : (evictionDesire(g, fhoh.winner, others[0], others[1]) >= 0 ? others[0] : others[1]);
  applyEviction(g, cut, {});
  if (cut === PLAYER_ID) return { result: 'player_cut_f3', week: g.week, g };

  // Finale
  const finalists = activeIds(g);
  if (finalists.length !== 2) throw new Error('finalists ' + finalists.length);
  const jurors = g.jury.slice(-7);
  if (jurors.length !== 7) throw new Error('jury size ' + g.jury.length);
  let playerVotesWon = 0;
  for (const j of jurors) {
    const q = fallbackJurorQuestion(g, j, finalists);
    if (!q.questionForF1) throw new Error('no juror question');
    const qa = { f1Answer: 'I owned my game and every promise I made mattered.', f2Answer: 'I played hard.' };
    const v = fallbackJurorVote(g, j, finalists, qa);
    if (!finalists.includes(v.vote)) throw new Error('bad jury vote');
    if (v.vote === PLAYER_ID) playerVotesWon++;
  }
  return {
    result: finalists.includes(PLAYER_ID) ? (playerVotesWon >= 4 ? 'player_wins' : 'player_f2_loss') : 'npc_final',
    votes: playerVotesWon,
    week: g.week,
    g,
  };
}

export function runSims(n = 60) {
  const out = { seasons: n, errors: [], results: {}, hohWinners: {}, evictionOrderSample: null, promises: 0, betrayals: 0, leaks: 0, approaches: 0 };
  for (let i = 0; i < n; i++) {
    try {
      const r = simSeason();
      out.results[r.result] = (out.results[r.result] || 0) + 1;
      if (r.result === 'player_evicted') out.evictWeeks = [...(out.evictWeeks || []), r.week];
      out.promises += r.g.promises.length;
      out.betrayals += r.g.events.filter((e) => e.type === 'betrayal').length;
      out.leaks += r.g.events.filter((e) => e.type === 'leak').length;
      for (const c of r.g.compHistory.filter((c) => c.type === 'hoh')) {
        out.hohWinners[c.winner] = (out.hohWinners[c.winner] || 0) + 1;
      }
      if (!out.evictionOrderSample) out.evictionOrderSample = r.g.evicted.map((id) => nameOf(r.g, id));
    } catch (e) {
      out.errors.push(String(e.message || e));
    }
  }
  return out;
}
