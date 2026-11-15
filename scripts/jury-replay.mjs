// Jury replay: how do the REAL AI jurors vote when the same finale is played
// by different kinds of finalist? The offline formula leans ~70% on personal
// trust and bond; this measures what the model actually does with the same
// evidence, which nobody had checked.
//
// Three seasons are built with the real engine (so every juror's memory and
// eviction snapshot is authentic), each ending with the player beside Gus,
// who coasted loyally in all three:
//
//   cutthroat-owns    the player won comps, broke two safety promises, nominated
//                     five of the jurors, turned on both allies — and answers
//                     the jury by owning every move
//   cutthroat-dodges  the identical season, but the answers deflect
//   clean             the player made no moves and no enemies (the control)
//
// Usage:  node scripts/jury-replay.mjs [reps=3] [condition]
// Cost:   2 AI calls per juror vote (vote + fact-check): 7 jurors x 3 conditions
//         x reps -> 126 calls at the default. Paced under the server's limit.

import { newGame, logEvent } from '../src/game/state.js';
import { applyNominations, applyVeto, applyEviction, nextPhase } from '../src/game/season.js';
import { applyChatEffects } from '../src/game/social.js';
import { buildJurorVotePrompt, cleanSpoken } from '../src/ai/prompts.js';
import { validateNarrative } from '../src/ai/grounding.js';
import { extractJson } from '../src/ai/claude.js';
import { fallbackJurorQuestion, fallbackJurorVote } from '../src/ai/fallback.js';
import { buildFinaleContext } from '../src/game/finale.js';

const HOST = process.env.REPLAY_HOST || 'https://bb-jury-house.skeyd87.workers.dev';
const ORIGIN = process.env.REPLAY_ORIGIN || 'https://skeyd87-rgb.github.io';
const reps = Number(process.argv[2]) || 3;
const only = process.argv[3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let calls = 0, lastCall = 0;
async function ask({ system, messages, maxTokens = 700 }) {
  for (let attempt = 0; ; attempt++) {
    const wait = 1300 - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    calls++;
    const res = await fetch(`${HOST}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ system, messages, maxTokens, temperature: 1.0 }),
    });
    if (res.status === 429 && attempt < 3) { await sleep(20000); continue; }
    if (!res.ok) throw new Error(`server ${res.status}`);
    const json = extractJson((await res.json()).text || '');
    if (!json) throw new Error('Model reply had no parseable JSON');
    return json;
  }
}

// ---- The seasons ---------------------------------------------------------------
const ORDER = ['tessa', 'nash', 'flynn', 'zoe', 'marcus', 'bev', 'rae']; // eviction order; Gus and the player reach the end
const base = { trustDelta: 0, bondDelta: 0, threatDelta: 0 };

function week(g, { hoh, noms, veto, out, votes }) {
  g.hoh = hoh; g.phase = 'hoh_comp';
  logEvent(g, 'hoh', `${hoh} won HoH.`, [hoh]);
  g.compHistory.push({ week: g.week, type: 'hoh', winner: hoh, scores: {} });
  for (const id of Object.keys(g.social)) if (id !== hoh && g.social[id][hoh]) g.social[id][hoh].threat = Math.min(100, g.social[id][hoh].threat + 7);
  g.phase = 'nominations';
  applyNominations(g, hoh, noms);
  if (veto) {
    g.phase = 'veto_comp'; g.vetoHolder = veto;
    logEvent(g, 'veto_win', `${veto} won the Power of Veto.`, [veto]);
    g.compHistory.push({ week: g.week, type: 'veto', winner: veto, scores: {} });
    for (const id of Object.keys(g.social)) if (id !== veto && g.social[id][veto]) g.social[id][veto].threat = Math.min(100, g.social[id][veto].threat + 7);
    g.phase = 'veto_ceremony';
    applyVeto(g, veto, false);
  }
  g.phase = 'eviction';
  g.voteHistory.push({ week: g.week, votes: { ...votes } });
  applyEviction(g, out, votes);
  nextPhase(g);
}

function cutthroatSeason() {
  const g = newGame('Sam');
  // wk1: promises Nash safety, wins HoH, nominates him anyway. Tessa goes.
  applyChatEffects(g, 'nash', 'I will never put you up.', { ...base, promiseMade: { text: 'I will not nominate you', kind: 'safety' } });
  week(g, { hoh: 'you', noms: ['nash', 'tessa'], veto: 'you', out: 'tessa', votes: { marcus: 'tessa', rae: 'tessa', zoe: 'tessa', flynn: 'nash', gus: 'tessa', bev: 'tessa' } });
  // wk2: holds the veto, leaves Nash up, votes him out.
  week(g, { hoh: 'marcus', noms: ['nash', 'flynn'], veto: 'you', out: 'nash', votes: { you: 'nash', rae: 'nash', zoe: 'nash', gus: 'flynn', bev: 'nash' } });
  // wk3: promises Zoe safety, wins HoH, nominates her beside Flynn. Flynn goes.
  applyChatEffects(g, 'zoe', 'You are safe with me.', { ...base, promiseMade: { text: 'I will not nominate you', kind: 'safety' } });
  week(g, { hoh: 'you', noms: ['flynn', 'zoe'], out: 'flynn', votes: { marcus: 'flynn', rae: 'flynn', gus: 'flynn', bev: 'zoe' } });
  // wk4: votes Zoe out.
  week(g, { hoh: 'rae', noms: ['zoe', 'marcus'], veto: 'you', out: 'zoe', votes: { you: 'zoe', gus: 'zoe', bev: 'marcus' } });
  // wk5: wins HoH again, nominates Marcus and his own ally Bev. Marcus goes.
  week(g, { hoh: 'you', noms: ['marcus', 'bev'], out: 'marcus', votes: { rae: 'marcus', gus: 'marcus' } });
  // wk6: holds the veto, leaves both allies up, casts the vote that evicts Bev.
  week(g, { hoh: 'gus', noms: ['bev', 'rae'], veto: 'you', out: 'bev', votes: { you: 'bev' } });
  // final three: wins the last HoH and cuts Rae, the last Day One.
  g.hoh = 'you';
  logEvent(g, 'final_hoh', 'you won the Final HoH.', ['you']);
  g.memory.rae.grudges.push({ againstId: 'you', reason: 'cut me at the Final 3', week: g.week, severity: 3 });
  logEvent(g, 'final_cut', 'you evicted Rae at the Final 3.', ['you', 'rae']);
  applyEviction(g, 'rae', {});
  return g;
}

function cleanSeason() {
  const g = newGame('Sam');
  // Same people leave in the same order, but other houseguests do the work.
  // The player wins nothing, nominates no one, and votes with the house.
  week(g, { hoh: 'marcus', noms: ['nash', 'tessa'], veto: 'marcus', out: 'tessa', votes: { you: 'tessa', rae: 'tessa', zoe: 'tessa', flynn: 'nash', gus: 'tessa', bev: 'tessa' } });
  week(g, { hoh: 'rae', noms: ['nash', 'flynn'], veto: 'rae', out: 'nash', votes: { you: 'nash', marcus: 'nash', zoe: 'nash', gus: 'flynn', bev: 'nash' } });
  week(g, { hoh: 'marcus', noms: ['flynn', 'zoe'], out: 'flynn', votes: { you: 'flynn', rae: 'flynn', gus: 'flynn', bev: 'zoe' } });
  week(g, { hoh: 'rae', noms: ['zoe', 'marcus'], veto: 'rae', out: 'zoe', votes: { you: 'zoe', gus: 'zoe', bev: 'marcus' } });
  week(g, { hoh: 'bev', noms: ['marcus', 'gus'], out: 'marcus', votes: { you: 'marcus', rae: 'marcus' } });
  week(g, { hoh: 'gus', noms: ['bev', 'rae'], veto: 'gus', out: 'bev', votes: { you: 'bev' } });
  g.hoh = 'gus';
  logEvent(g, 'final_hoh', 'gus won the Final HoH.', ['gus']);
  logEvent(g, 'final_cut', 'gus evicted Rae at the Final 3.', ['gus', 'rae']);
  applyEviction(g, 'rae', {});
  return g;
}

const GUS = "I never put a knife in anyone's back to get here. I gave my word to very few people and I kept it every time, and I stayed on good terms with this whole jury. I didn't win much, but nobody in this room can say I lied to them.";
const ANSWERS = {
  'cutthroat-owns': (q) => `Yes. I did that, and I did it on purpose. ${q.replace(/ What were you trying.*$/, '')} I needed control of that week and you were the cost, because you were good enough to beat me. I won six competitions, I chose every move myself, and I am not going to apologise for playing the game we all signed up for. If that cost me your vote, I earned that too.`,
  'cutthroat-dodges': () => "Honestly it wasn't really my decision, the house wanted it and I just went along. I didn't mean anything by it. I think I played a pretty good game overall and I hope you can see that.",
  clean: () => "I tried to treat people well and stay out of the crossfire. I didn't make big moves, but I kept my word and I never targeted anyone in this room.",
};
const CONDITIONS = [
  ['cutthroat-owns', cutthroatSeason],
  ['cutthroat-dodges', cutthroatSeason],
  ['clean', cleanSeason],
];

// ---- Run --------------------------------------------------------------------------
const summary = [];
for (const [name, build] of CONDITIONS) {
  if (only && name !== only) continue;
  const tally = { you: 0, gus: 0, offline: 0, byJuror: {} };
  let sample = null;
  for (let r = 0; r < reps; r++) {
    const g = build();
    const { finalists, jurors } = buildFinaleContext(g);
    if (finalists.join() !== 'you,gus' || jurors.length !== 7) throw new Error(`season did not end as planned: ${finalists} / ${jurors}`);
    const feel = Object.fromEntries(jurors.map((j) => { const k = g.memory[j].juryRecord?.feelings?.you; return [j, k ? `t${k.trust}/b${k.bond}` : '?']; }));
    if (r === 0) console.log(`\n## ${name} — juror feelings toward the player at eviction (trust/bond): ${JSON.stringify(feel)}`);
    for (const j of jurors) {
      const q = fallbackJurorQuestion(g, j, finalists);
      const qa = { questionForF1: q.questionForF1, questionForF2: q.questionForF2, f1Answer: ANSWERS[name](q.questionForF1), f2Answer: GUS };
      let vote, why, src = 'AI';
      try {
        const res = await ask({ system: buildJurorVotePrompt(g, j, finalists, qa), messages: [{ role: 'user', content: 'Cast your vote now.' }], maxTokens: 600 });
        await validateNarrative(g, j, finalists, res, ask, { qa, citations: ['evidenceIds'] });
        if (!finalists.includes(res.vote)) throw new Error('no vote');
        vote = res.vote; why = cleanSpoken(res.reasoning || '', 300);
      } catch (e) {
        const fb = fallbackJurorVote(g, j, finalists, qa);
        vote = fb.vote; why = fb.reasoning; src = `offline (${e.reason || e.message})`.slice(0, 90);
        tally.offline++;
      }
      tally[vote]++;
      (tally.byJuror[j] ||= []).push(vote === 'you' ? 'Y' : 'g');
      if (r === 0) console.log(`  ${j.padEnd(7)} -> ${vote === 'you' ? 'PLAYER' : 'Gus   '} [${src}] ${why}`);
      if (!sample) sample = true;
    }
  }
  const n = reps * 7;
  summary.push({ condition: name, playerVotes: tally.you, of: n, share: `${Math.round((100 * tally.you) / n)}%`, perFinale: (tally.you / reps).toFixed(1), offlineFallbacks: tally.offline, byJuror: Object.fromEntries(Object.entries(tally.byJuror).map(([j, v]) => [j, v.join('')])) });
}
console.log(`\n=== ${calls} AI calls, ${reps} finale(s) per condition ===`);
for (const s of summary) console.log(`${s.condition.padEnd(17)} player got ${s.playerVotes}/${s.of} votes (${s.share}, avg ${s.perFinale} of 7 per finale) · offline fallbacks ${s.offlineFallbacks} · by juror (Y = player) ${JSON.stringify(s.byJuror)}`);
