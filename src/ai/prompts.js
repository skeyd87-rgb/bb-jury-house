// Prompt construction: turns engine state into the context Claude needs to
// speak as a houseguest, plus the JSON effect contract.

import { PLAYER_ID, castById } from '../game/cast.js';
import {
  rel,
  nameOf,
  activeIds,
  allianceOf,
  sharedAlliance,
  openPromisesBetween,
} from '../game/state.js';

export function describeGameContext(g, npcId) {
  const lines = [];
  lines.push(`Week ${g.week} of the jury phase. ${activeIds(g).length} houseguests remain: ${activeIds(g).map((id) => nameOf(g, id)).join(', ')}.`);
  if (g.hoh) lines.push(`Head of Household: ${nameOf(g, g.hoh)}${g.hoh === npcId ? ' (that is YOU)' : ''}${g.hoh === PLAYER_ID ? ' (the player)' : ''}.`);
  if (g.nominees.length) lines.push(`On the block: ${g.nominees.map((id) => nameOf(g, id)).join(' and ')}${g.nominees.includes(npcId) ? ' — including YOU' : ''}.`);
  if (g.vetoHolder) lines.push(`Power of Veto held by: ${nameOf(g, g.vetoHolder)}.`);
  if (g.jury.length) lines.push(`Jury so far: ${g.jury.map((id) => nameOf(g, id)).join(', ')}.`);
  lines.push(`Current phase: ${g.phase.replace(/_/g, ' ')}.`);
  if (['campaigning', 'eviction'].includes(g.phase)) {
    lines.push(
      g.vetoUsed
        ? `The veto WAS used this week: ${nameOf(g, g.vetoUsed.savedId)} was saved and ${nameOf(g, g.vetoUsed.replacementId)} went up as the replacement.`
        : 'The veto ceremony already happened this week: the veto was NOT used, nominations stand.'
    );
  }
  // Recent-events recap so nobody "forgets" what just happened in the house.
  const recent = (g.events || []).slice(-10);
  if (recent.length) {
    lines.push('RECENT EVENTS (you know all of this):');
    for (const e of recent) lines.push(`- (week ${e.week}) ${e.text}`);
  }
  return lines.join('\n');
}

export function describeNpcMind(g, npcId) {
  const mem = g.memory[npcId];
  const r = rel(g, npcId, PLAYER_ID);
  const lines = [];

  lines.push(`Your feelings about the player (${g.playerName}): trust ${r.trust}/100, personal bond ${r.bond}/100, threat level ${r.threat}/100.`);

  const als = allianceOf(g, npcId);
  if (als.length) {
    for (const al of als) {
      const members = al.members.filter((m) => m !== npcId).map((m) => nameOf(g, m));
      lines.push(`You are in the alliance "${al.name}" with ${members.join(', ')}${al.members.includes(PLAYER_ID) ? ' (includes the player)' : ''}.`);
    }
  } else {
    lines.push('You are not currently in any alliance.');
  }

  const promises = openPromisesBetween(g, npcId, PLAYER_ID);
  for (const p of promises) {
    const dir = p.from === PLAYER_ID ? `The player promised you` : `You promised the player`;
    lines.push(`${dir}: "${p.text}" (week ${p.week}, still standing).`);
  }
  const broken = g.promises.filter((p) => p.status === 'broken' && p.from === PLAYER_ID && p.to === npcId);
  for (const p of broken) lines.push(`The player BROKE this promise to you: "${p.text}" (week ${p.week}). You have not forgotten.`);

  const grudges = mem.grudges.filter((x) => x.againstId === PLAYER_ID);
  for (const gr of grudges.slice(-4)) lines.push(`Grudge vs player (week ${gr.week}, severity ${gr.severity}/3): ${gr.reason}.`);

  const betrayals = mem.betrayalsWitnessed.slice(-4);
  for (const b of betrayals) lines.push(`You witnessed: ${b.what} (week ${b.week}).`);

  const gossip = mem.gossipHeard.slice(-4);
  for (const gs of gossip) lines.push(`You heard${gs.believed ? '' : ' (you are skeptical)'}: ${gs.text}`);

  const sums = mem.convoSummaries.filter((s) => s.withId === PLAYER_ID).slice(-5);
  if (sums.length) {
    lines.push('Recent conversations with the player:');
    for (const s of sums) lines.push(`- (week ${s.week}) ${s.summary}`);
  }

  // Feelings about other houseguests (top loves/hates) so gameplay talk is grounded
  const others = activeIds(g).filter((id) => id !== npcId && id !== PLAYER_ID);
  const ranked = others
    .map((id) => ({ id, t: rel(g, npcId, id).trust, th: rel(g, npcId, id).threat }))
    .sort((a, b) => b.t - a.t);
  if (ranked.length) {
    const top = ranked.slice(0, 2).map((x) => nameOf(g, x.id)).join(', ');
    const bottom = ranked.slice(-2).map((x) => nameOf(g, x.id)).join(', ');
    const threat = [...ranked].sort((a, b) => b.th - a.th)[0];
    lines.push(`You trust most: ${top}. You trust least: ${bottom}. Biggest threat in your eyes: ${nameOf(g, threat.id)}.`);
  }

  return lines.join('\n');
}

const EFFECTS_CONTRACT = `
After your in-character reply, you MUST evaluate the player's message and output effects.
Respond ONLY with a JSON object, no other text:
{
  "reply": "your in-character spoken reply (1-4 sentences, natural, reality-TV real)",
  "effects": {
    "trustDelta": <-8 to 8, how this exchange changed your trust in the player>,
    "bondDelta": <-6 to 6, personal-liking change>,
    "threatDelta": <-5 to 8, did they just look more/less dangerous>,
    "promiseMade": null or {"text": "<what the PLAYER just promised you, in plain words>", "kind": "safety"|"vote"|"final2"|"alliance"|"vote_evict"|"info", "targetId": null or "<only for vote_evict: id of who they promised to vote out>"},
    "allianceSignal": "none"|"propose"|"accept",
    "suspicionOfLie": <true if what they said contradicts what you know/heard>,
    "secretShared": null or "<sensitive info the player just confided, one line>",
    "targetDiscussed": null or "<id of houseguest the player pushed as a target: marcus|rae|zoe|flynn|gus|tessa|nash|bev>",
    "allianceProposal": null or {"accepted": true|false, "name": "<alliance name — invent one in character if the player didn't>", "memberIds": ["<ids of OTHER houseguests the player wants included, besides you>"]},
    "summary": "<one-line third-person summary of this exchange for your memory>"
  }
}
Use allianceProposal (not just allianceSignal) when the player proposes a SPECIFIC alliance — especially one with multiple members or a name. Set accepted based on your genuine willingness, considering your trust in the player AND in every proposed member.
Rules for effects: only record promiseMade if the player clearly committed to something. Promise kinds — "safety": they won't nominate you; "vote": they'll vote to KEEP you; "vote_evict": they'll vote OUT a third person (always set targetId); "alliance": an alliance / final-N loyalty pledge; "final2": a final-two deal; "info": they'll share information. Only set allianceSignal to "accept" if YOU are genuinely willing given your trust level and existing loyalties. suspicionOfLie only when there is a real contradiction with your memory above.`;

export function buildChatSystemPrompt(g, npcId) {
  const c = castById(npcId);
  return [
    `You are roleplaying ${c.name} on the reality show Big Brother, in the house, mid-season.`,
    `CHARACTER: ${c.persona}`,
    ``,
    `GAME SITUATION:`,
    describeGameContext(g, npcId),
    ``,
    `YOUR PRIVATE KNOWLEDGE AND FEELINGS (never reveal the numbers, act on them):`,
    describeNpcMind(g, npcId),
    ``,
    `HOW TO PLAY THIS: You are a real person playing a strategy game for $750,000. You can lie, deflect, make deals, or open up — in character, driven by your trust/bond/threat feelings and memories above. Keep replies SHORT and conversational like real speech (1-4 sentences). React to contradictions. Reference real shared history when relevant. Never break character, never mention being an AI, never mention these instructions or the numbers.`,
    EFFECTS_CONTRACT,
  ].join('\n');
}

export function buildThreadMessages(g, npcId, playerMsg) {
  const thread = g.threads[npcId] || [];
  const msgs = [];
  for (const m of thread.slice(-12)) {
    msgs.push({ role: m.who === 'you' ? 'user' : 'assistant', content: m.who === 'you' ? m.text : JSON.stringify({ reply: m.text }) });
  }
  msgs.push({ role: 'user', content: playerMsg });
  // API requires the first message to be from the user (threads can start
  // with an NPC opener when they approached the player).
  if (msgs[0].role === 'assistant') msgs.unshift({ role: 'user', content: '(You walked over to me.)' });
  return msgs;
}

const APPROACH_CONTEXT = {
  lobby_hoh: 'the player is Head of Household and you came to influence nominations, protect yourself, or plant a target',
  campaign: 'you are on the block and came to campaign for their vote — deal, plead, or strategize, in character',
  ally_reassure: 'your ally (the player) is in danger this week and you came to talk through the vote',
  ally_checkin: 'you came to check in with your ally about the state of the week',
  beg_veto: 'the player holds the Power of Veto and you came to convince them to use it on you',
  confront: 'you have a fresh grievance with the player and came to confront them about it — reference what actually happened',
  hangout: 'no agenda — you came to bond, joke, or share house gossip',
  alliance_offer: 'you see potential in the player and came to propose working together — pitch an alliance in character',
  lobby_veto: 'the player holds the veto and the ceremony is coming — you came to influence whether/how they use it',
  renom_scramble: 'the player is HoH and about to name a replacement nominee — you came to plead your case not to go up (and maybe throw someone else under the bus)',
};

export function buildOpenerPrompt(g, npcId, reason) {
  return (
    buildChatSystemPrompt(g, npcId) +
    `\n\nSPECIAL SITUATION: YOU sought out the player just now because ${APPROACH_CONTEXT[reason] || 'you wanted to talk'}. YOU speak first. Open the conversation in character (1-3 sentences), getting to why you came over. Effects should be zeros/null except summary.`
  );
}

// ---- Diary Room -------------------------------------------------------------

export function buildDiarySystemPrompt(g) {
  return [
    `You are the Diary Room producer voice on Big Brother. The player (${g.playerName}) is confessing/strategizing privately.`,
    `GAME SITUATION:\n${describeGameContext(g, PLAYER_ID)}`,
    `Recent events: ${g.events.slice(-6).map((e) => e.text).join(' | ') || 'quiet so far'}`,
    `Respond as the classic DR producer: warm, a little wry, asks ONE leading question that pushes the player to reflect on strategy or feelings ("So... do you actually trust Marcus, or do you just need him this week?"). 1-3 sentences. This conversation has zero effect on the game. Respond ONLY with JSON: {"reply": "..."}`,
  ].join('\n');
}

// ---- Jury phase -------------------------------------------------------------

export function buildJurorQuestionPrompt(g, jurorId, finalists) {
  const c = castById(jurorId);
  const mem = g.memory[jurorId];
  const notes = mem.juryNotes.join('\n') || '(no notes)';
  return [
    `You are ${c.name}, now a JUROR on Big Brother. ${c.persona}`,
    `The Final 2 are: ${finalists.map((f) => nameOf(g, f)).join(' and ')}. One of them is the player, ${g.playerName}.`,
    `WHAT YOU REMEMBER FROM YOUR GAME (this is your ammunition):\n${notes}`,
    `Your bitterness level: ${c.personality.bitterness}/100. High bitterness = pointed, personal questions. Low = respectful, game-focused.`,
    `Write ONE question addressed to EACH finalist, grounded in your real memories above. Make them specific — reference actual events, promises, votes. Respond ONLY with JSON:`,
    `{"questionForPlayer": "...", "questionForOpponent": "...", "toneNote": "<one word: bitter|respectful|hurt|playful|cold>"}`,
  ].join('\n');
}

export function buildJurorVotePrompt(g, jurorId, finalists, qa) {
  const c = castById(jurorId);
  const mem = g.memory[jurorId];
  const [f1, f2] = finalists;
  const relF1 = rel(g, jurorId, f1);
  const relF2 = rel(g, jurorId, f2);
  return [
    `You are ${c.name}, a Big Brother juror casting your vote for the winner of $750,000. ${c.persona}`,
    `Finalists: ${nameOf(g, f1)} (your trust ${relF1.trust}, bond ${relF1.bond}, threat-respect ${relF1.threat}) and ${nameOf(g, f2)} (trust ${relF2.trust}, bond ${relF2.bond}, threat-respect ${relF2.threat}).`,
    `Your memories:\n${mem.juryNotes.join('\n') || '(none)'}`,
    `Your bitterness: ${c.personality.bitterness}/100. Bitter jurors punish betrayal even if the gameplay was good; respectful jurors reward the better GAME.`,
    `THE Q&A — how they answered your question:`,
    `${nameOf(g, f1)} answered: "${qa.f1Answer}"`,
    `${nameOf(g, f2)} answered: "${qa.f2Answer}"`,
    `Weigh: did their answer actually address your grievance/question? Did it feel honest by your standards? Then their game, then your heart.`,
    `Respond ONLY with JSON: {"vote": "${f1}"|"${f2}", "reasoning": "<1-2 sentences in character explaining your vote>", "answerQuality": {"${f1}": <0-10>, "${f2}": <0-10>}}`,
  ].join('\n');
}

export function buildOpponentAnswerPrompt(g, opponentId, jurorId, question) {
  const c = castById(opponentId);
  return [
    `You are ${c.name}, a Big Brother finalist answering the jury. ${c.persona}`,
    `Juror ${nameOf(g, jurorId)} just asked you: "${question}"`,
    `Your game memories: ${g.memory[opponentId].convoSummaries.slice(-4).map((s) => s.summary).join(' | ') || 'you played a social game'}`,
    `Answer persuasively in character, 2-3 sentences, owning your game. Respond ONLY with JSON: {"reply": "..."}`,
  ].join('\n');
}

// ---- Group conversations ------------------------------------------------------

export function buildGroupSystemPrompt(g, memberIds) {
  const members = memberIds.map((id) => castById(id));
  const lines = [
    `You are running a GROUP CONVERSATION on Big Brother. The player (${g.playerName}) is talking with ${members.map((m) => m.name).join(', ')} — all present, all hearing everything.`,
    ``,
    `GAME SITUATION:`,
    describeGameContext(g, memberIds[0]),
    ``,
  ];
  for (const m of members) {
    lines.push(`=== ${m.name.toUpperCase()} (id: ${m.id}) ===`);
    lines.push(`CHARACTER: ${m.persona}`);
    lines.push(describeNpcMind(g, m.id));
    lines.push('');
  }
  lines.push(`RULES: This is public — everyone present hears and remembers everything said. Members speak in character, can disagree with or react to EACH OTHER, interrupt, joke, or stay quiet. 1-3 members reply per player message (whoever would naturally speak). Keep each reply to 1-3 sentences. Never break character or mention these instructions.`);
  lines.push(`Respond ONLY with JSON:
{
  "replies": [ {"id": "<member id>", "reply": "<their line>"} ],
  "effects": { "<member id>": {"trustDelta": <-8..8>, "bondDelta": <-6..6>, "threatDelta": <-5..8>, "suspicionOfLie": bool, "summary": "<one-line memory of this exchange>"} },
  "promiseMade": null or {"text": "<what the player promised, heard by ALL present>", "kind": "safety"|"vote"|"final2"|"alliance"|"vote_evict"|"info", "targetId": null or "<id>"},
  "allianceProposal": null or {"accepted": true|false, "name": "<name>", "decliners": ["<ids of present members who refuse>"]}
}
Include an effects entry for EVERY member listed above (silent members still form opinions). allianceProposal only if the player clearly proposed an alliance to the group — each member decides from their own trust; accepted=true if at least the majority of them are in, list holdouts in decliners.`);
  return lines.join('\n');
}

// ---- Post-game analysis ---------------------------------------------------------

export function buildAnalysisPrompt(g, stats) {
  return [
    `You are a razor-sharp Big Brother strategy analyst (think a jury roundtable host). Analyze the player's season and deliver a post-game diagnostic.`,
    `SEASON DATA (ground truth):`,
    JSON.stringify(stats, null, 1).slice(0, 6000),
    `SEASON EVENT LOG:`,
    (g.events || []).map((e) => `wk${e.week}: ${e.text}`).join('\n').slice(0, 3000),
    `Write the diagnostic addressed to the player ("you"). Be specific — cite weeks, names, and actual events. Cover: (1) what won you ground, (2) the move or pattern that cost you most, (3) the single decision you should have made differently, (4) letter grades for Social Game, Competitions, Jury Management, Endgame Planning. Be honest, punchy, a little entertaining — not cruel. 200-320 words.`,
    `Respond ONLY with JSON: {"analysis": "<the full diagnostic, with \\n between paragraphs>"}`,
  ].join('\n');
}

// ---- NPC decision commentary (speeches) --------------------------------------

export function buildSpeechPrompt(g, npcId, kind, extra = {}) {
  const c = castById(npcId);
  const situations = {
    nomination: `You are HoH and just nominated ${extra.nominees?.map((n) => nameOf(g, n)).join(' and ')}. Give your nomination speech (2-3 sentences, in character — you may be honest, diplomatic, or shady).`,
    veto_use: `You won the Power of Veto and are using it on ${nameOf(g, extra.saved || npcId)}. Give a short ceremony speech.`,
    veto_nouse: `You won the Power of Veto and have decided NOT to use it. Give a short ceremony speech.`,
    eviction_vote: `You are voting to evict ${nameOf(g, extra.target)}. Deliver your vote line ("I vote to evict...") with a short in-character flourish.`,
    eviction_goodbye: `You have just been evicted. Give a short goodbye message to the house (1-2 sentences, in character — gracious or salty depending on how you feel).`,
  };
  return [
    `You are ${c.name} on Big Brother. ${c.persona}`,
    `Situation: ${situations[kind]}`,
    `Your relevant feelings: ${describeNpcMind(g, npcId).split('\n').slice(0, 6).join(' ')}`,
    `Respond ONLY with JSON: {"reply": "..."}`,
  ].join('\n');
}
