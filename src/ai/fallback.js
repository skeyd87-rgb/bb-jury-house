// Offline dialogue engine — used when no API key is set (and as a safety net
// if the API fails repeatedly). Intent classification + personality-flavored
// templates. Produces the same { reply, effects } shape as Claude.

import { castById, PLAYER_ID } from '../game/cast.js';
import { knowledgeFor, evidenceFor } from '../game/knowledge.js';
import { rel, nameOf, activeIds } from '../game/state.js';

const INTENTS = [
  { key: 'promise_evict', rx: /\b(i'?ll|i will|i'?m going to|i'?m gonna|gonna) [^.!?]{0,14}vote [^.!?]{0,12}(evict|out|against)\b(?![^.!?]{0,6}you\b)/i },
  { key: 'promise_vote', rx: /\b(i'?ll vote (to keep|for) you|you have my vote|voting to keep you|i'?m keeping you|(won'?t|will not|never|not) [^.!?]{0,20}vote against you)\b/i },
  { key: 'promise_safety', rx: /\b(i (won'?t|will not|would never|never) [^.!?]{0,16}(nominate|put you up)|you'?re safe|i'?ll protect|i got you|keep you safe|i promise|i swear|you have my word|my word)\b/i },
  { key: 'alliance', rx: /\b(alliance|work together|team up|final ?2|final ?two|ride or die|ride together|stick together|us two|with me|we'?re a team)\b/i },
  { key: 'target', rx: /\b(target|put up|nominate|backdoor|get (him|her|them|rid)|evict|take (a )?shot at)\b/i },
  { key: 'ask_vote', rx: /\b(vote for me|keep me|save me|need your vote|have my back)\b/i },
  { key: 'ask_info', rx: /\b(who (are|is|do)|what (do|are) you|any idea|heard anything|what'?s the plan|thoughts on)\b/i },
  { key: 'accuse', rx: /\b(you lied|liar|betrayed|you promised|threw me|snake|two.?faced|behind my back)\b/i },
  { key: 'compliment', rx: /\b(love you|great|awesome|trust you|appreciate|thank|good (game|job)|impressive)\b/i },
  { key: 'strategy', rx: /\b(strategy|strategic|game plan|talk game|numbers|where'?s your head|what should|who should|votes?|nominations?|hoh|veto|jury)\b/i },
  { key: 'smalltalk', rx: /.*/ },
];

const deniesCommitment = text => /\bI\s+(?:never|did not|didn't|haven't|have not|don't|do not|can't|cannot|won't|will not)\s+(?:\w+\s+){0,3}(?:promise|promised|agree|agreed|commit|committed|work together|join)\b/i.test(text);

function detectTargetId(g, msg) {
  const lower = msg.toLowerCase();
  for (const id of activeIds(g)) {
    if (id === PLAYER_ID) continue;
    if (lower.includes(nameOf(g, id).toLowerCase())) return id;
  }
  return null;
}

function strategyLead(g, targetId) {
  if (targetId) return `Gamewise, ${nameOf(g, targetId)} is the name we need to count votes around.`;
  if (g.nominees?.length) return `Gamewise, this week is about the votes between ${g.nominees.map((id) => nameOf(g, id)).join(' and ')}.`;
  if (g.hoh) return `Gamewise, ${nameOf(g, g.hoh)} has the power right now, so the smart move is managing that relationship.`;
  return 'Gamewise, the numbers matter more than vibes right now.';
}

export function fallbackChat(g, npcId, playerMsg, chatterId = PLAYER_ID) {
  if (deniesCommitment(playerMsg)) return { reply: "I hear you. Let's be precise about what was actually agreed. I'm not treating that as a new commitment.", effects: { trustDelta: 0, bondDelta: 0, threatDelta: 0, suspicionOfLie: false } };
  const intent = INTENTS.find((i) => i.rx.test(playerMsg)).key;
  const targetId = detectTargetId(g, playerMsg);
  const r = rel(g, npcId, chatterId);
  const c = castById(npcId);


  let bucket = 'smalltalk';
  let effects = {
    trustDelta: 0, bondDelta: 1, threatDelta: 0, promiseMade: null,
    allianceSignal: 'none', suspicionOfLie: false, secretShared: null,
    targetDiscussed: null, summary: `Casual chat about the house.`,
  };

  // Factual questions/corrections must not be mistaken for attacks or new promises.
  if (!intent.startsWith('promise') && intent !== 'alliance' && /\b(veto|actually|remember|wrong|never promised|didn.t happen)\b/i.test(playerMsg)) {
    const requestedWeek = Number(playerMsg.match(/week\s+(\d+)/i)?.[1]) || g.week;
    const records = evidenceFor(g, npcId).filter(f => f.week === requestedWeek && ( /veto/i.test(playerMsg) ? f.kind.startsWith('veto') || f.kind === 'replacement' : f.kind !== 'rumor'));
    return { reply: records.length ? records.map(f => f.text).join(' ') + ' What part of that decision do you want to talk through?' : "I don't have a verified record of that. I shouldn't fill in the gaps. What are you referring to?", effects: { trustDelta: 0, bondDelta: 0, threatDelta: 0, suspicionOfLie: false } };
  }
  switch (intent) {
    case 'alliance': {
      const willing = r.trust >= 55;
      bucket = willing ? 'alliance' : 'deny';
      effects.trustDelta = willing ? 4 : -1;
      effects.allianceSignal = willing ? 'accept' : 'none';
      if (willing && /\bfinal ?(\d|two|three|four|five)\b/i.test(playerMsg)) {
        effects.promiseMade = { text: 'a final-stretch loyalty pledge', kind: 'alliance' };
      }
      effects.summary = willing ? 'Agreed to work together with the player.' : 'Player pitched an alliance; deflected.';
      break;
    }
    case 'promise_safety':
    case 'promise_vote': {
      bucket = r.trust >= 45 ? 'alliance' : 'ask_info';
      effects.trustDelta = 3;
      effects.promiseMade = {
        text: intent === 'promise_safety' ? 'to keep them safe / not nominate them' : 'to vote to keep them',
        kind: intent === 'promise_safety' ? 'safety' : 'vote',
      };
      effects.summary = 'Player made a promise; noted it.';
      break;
    }
    case 'promise_evict': {
      bucket = 'target';
      effects.trustDelta = 3;
      if (targetId) {
        effects.promiseMade = { text: `to vote out ${nameOf(g, targetId)}`, kind: 'vote_evict', targetId };
        effects.targetDiscussed = targetId;
        effects.summary = `Player promised to vote out ${nameOf(g, targetId)}.`;
      } else {
        effects.summary = 'Player promised a vote against someone.';
      }
      break;
    }
    case 'target': {
      bucket = 'target';
      effects.targetDiscussed = targetId;
      effects.threatDelta = 2;
      effects.trustDelta = r.trust > 50 ? 2 : -1;
      effects.secretShared = targetId ? `wants ${nameOf(g, targetId)} out` : null;
      effects.summary = targetId ? `Player pushed ${nameOf(g, targetId)} as a target.` : 'Player talked targets.';
      break;
    }
    case 'ask_vote': {
      bucket = r.trust >= 50 ? 'alliance' : 'deny';
      effects.trustDelta = 1;
      effects.summary = 'Player asked for their vote/support.';
      break;
    }
    case 'ask_info': {
      bucket = 'ask_info';
      effects.summary = 'Player fished for information.';
      break;
    }
    case 'accuse': {
      bucket = 'accuse';
      effects.trustDelta = 0;
      effects.bondDelta = 0;
      effects.summary = 'Player confronted/accused them.';
      break;
    }
    case 'compliment': {
      bucket = 'smalltalk';
      effects.bondDelta = 3;
      effects.trustDelta = 1;
      effects.summary = 'Player was warm/complimentary.';
      break;
    }
    case 'strategy': {
      bucket = targetId ? 'target' : 'ask_info';
      effects.trustDelta = 1;
      effects.targetDiscussed = targetId;
      effects.secretShared = targetId ? `talked strategy around ${nameOf(g, targetId)}` : null;
      effects.summary = targetId ? `Talked strategy around ${nameOf(g, targetId)}.` : 'Talked general strategy.';
      break;
    }
    default:
      bucket = 'smalltalk';
  }

  const answers = {
    alliance: r.trust >= 55 ? ["I'm open to working together. Let's be clear about what we're agreeing to.", "I can see a reason to cooperate. What do you need from me?"] : ["I've heard your commitment. I need to think about where that leaves me."],
    deny: ["I can't commit to that right now. I need to protect my own position.", "I'm not convinced yet. What's the risk for me?"],
    accuse: ["Tell me exactly which decision you mean. I want to get the facts straight before we argue about it."],
    target: ["Walk me through who benefits and what happens if the plan fails.", "What would we need to make that work, and who would we lose along the way?"],
    ask_info: ["What are you trying to work out? I can give you my read, but I won't pretend a rumor is a fact.", "Let's compare what we actually know. Where's your head at?"],
    smalltalk: ["How are you holding up? We can take a minute away from game talk.", "What do you want to talk about? I'm listening."],
  };
  const lines = answers[bucket] || answers.smalltalk;
  const baseReply = lines[Math.floor(Math.random() * lines.length)];
  const reply = intent === 'strategy' ? `${strategyLead(g, targetId)} ${baseReply}` : baseReply;
  return { reply, effects };
}

const OPENER_LINES = {
  lobby_hoh: [
    "Hey... got a minute before you lock anything in? I want to talk nominations.",
    "So. Big chair, big decisions. Where's your head at this week?",
  ],
  campaign: [
    "I'm not going to pretend I'm not sweating. I'm on the block and I need your vote.",
    "Hear me out before Thursday. Keeping me is better for YOUR game, and I can prove it.",
  ],
  ally_reassure: [
    "Hey — don't spiral. Let's count the votes together, right now.",
    "We're good. I need you to know we're good. Now let's make sure the numbers are there.",
  ],
  ally_checkin: [
    "Quick check-in. Anything I should know before things get loud this week?",
    "Just us for a second — are we still solid on the plan?",
  ],
  beg_veto: [
    "You have the veto. I wouldn't ask if it wasn't everything — please, use it on me.",
    "That medal around your neck could save my whole game. What do you need from me?",
  ],
  confront: [
    "We need to talk. Right now. And don't play dumb.",
    "I heard what's been going around, and it has your name all over it.",
  ],
  hangout: [
    "There you are! Come sit with me, I need a break from the scheming.",
    "Hey you. No game talk for five minutes — how are you actually doing?",
  ],
  alliance_offer: [
    "Can I be straight with you? I think you and I could run this thing together.",
    "I've been watching how you play. We should be working together — for real.",
  ],
  lobby_veto: [
    "You've got the veto and the whole house is holding its breath. Can we talk about what you're thinking?",
    "Before that ceremony — hear me out on what the smart play is with that veto.",
  ],
  renom_scramble: [
    "Please don't let it be me up there. Let me tell you who the real target should be.",
    "I know you've got a tough call on the replacement — just, please, not me. Here's why.",
  ],
};

export function fallbackOpener(g, npcId, reason) {
  if (['beg_veto', 'lobby_veto'].includes(reason) && (g.vetoUsed || g.vetoHolder !== PLAYER_ID || !['social_veto', 'veto_lobby', 'veto_ceremony'].includes(g.phase))) reason = 'hangout';
  if (reason === 'campaign' && !g.nominees.includes(npcId)) reason = 'hangout';
  if (reason === 'confront') {
    const evidence = evidenceFor(g, npcId).filter(f => f.actorId === PLAYER_ID && (f.targetIds.includes(npcId) || f.kind === 'veto_used')).at(-1);
    if (evidence) return `Can we talk about week ${evidence.week}? ${evidence.text} I want to understand your thinking.`;
    const rumor = knowledgeFor(g, npcId).rumors.at(-1);
    if (rumor) return `I heard something from ${rumor.sourceName}, but I can't verify it. Can we compare notes before I jump to conclusions?`;
    return "I feel uneasy about where we stand. Can we talk it through?";
  }
  const lines = OPENER_LINES[reason] || OPENER_LINES.hangout;
  return lines[Math.floor(Math.random() * lines.length)];
}

// Group chat without an API key: 1-2 members respond via the 1:1 engine,
// effects returned per member at reduced strength.
export function fallbackGroupChat(g, memberIds, playerMsg, chatterId = PLAYER_ID) {
  const talkers = [...memberIds].sort(() => Math.random() - 0.5).slice(0, Math.min(2, memberIds.length));
  const replies = [];
  const effects = {};
  let promiseMade = null;
  for (const id of memberIds) {
    const r = fallbackChat(g, id, playerMsg, chatterId);
    if (talkers.includes(id)) replies.push({ id, reply: r.reply });
    effects[id] = {
      trustDelta: Math.round((r.effects.trustDelta || 0) * 0.7),
      bondDelta: Math.round((r.effects.bondDelta || 0) * 0.7),
      threatDelta: r.effects.threatDelta || 0,
      suspicionOfLie: r.effects.suspicionOfLie,
      summary: r.effects.summary,
    };
    if (!promiseMade && r.effects.promiseMade) promiseMade = r.effects.promiseMade;
  }
  // Alliance pitch to the group?
  let allianceProposal = null;
  if (!deniesCommitment(playerMsg) && /\b(alliance|work together|team up|final ?\d|ride together)\b/i.test(playerMsg)) {
    const decliners = memberIds.filter((id) => rel(g, id, chatterId).trust < 50);
    allianceProposal = { accepted: decliners.length <= memberIds.length / 2, name: null, decliners };
  }
  return { replies, effects, promiseMade, allianceProposal };
}

export function fallbackAnalysis(stats) {
  const kept = stats.promises.filter((p) => p.status === 'kept').length;
  const broken = stats.promises.filter((p) => p.status === 'broken').length;
  const comps = stats.compRecord.filter((c) => c.isYou).length;
  const knives = stats.betrayals.filter((b) => b.byYou).length;
  const lines = [
    `You lasted ${stats.weeks} weeks and finished ${stats.place || stats.result}.`,
    comps >= 4
      ? `Winning ${comps} comps made you the biggest visible threat in the house — powerful, but it puts a number on your back at every cut.`
      : comps >= 1
      ? `${comps} comp win${comps > 1 ? 's' : ''} kept you dangerous without painting a huge target.`
      : `Zero comp wins meant your fate was always in other people's hands.`,
    broken > kept
      ? `The ledger hurt you: ${broken} broken promises against ${kept} kept. Every broken deal is a bitter juror or a wary ally.`
      : `You largely kept your word (${kept} kept vs ${broken} broken) — that's the currency endgames are bought with.`,
    knives >= 2
      ? `You swung the knife ${knives} times. Big moves win seasons, but each one needs a cover story and a soft landing — did yours have them?`
      : `You played clean — maybe too clean. Juries reward moves they can point to.`,
    `Grades — Comps: ${comps >= 4 ? 'A' : comps >= 2 ? 'B' : 'C'} · Promises: ${broken > kept ? 'D' : 'A'} · Endgame: ${stats.result === 'winner' ? 'A' : stats.result === 'runner-up' ? 'B' : 'D'}.`,
  ];
  return lines.join('\n\n');
}

export function fallbackDiary(g) {
  const qs = [
    "So... who do you actually trust in that house right now?",
    "Big week. What's the move — and what's it going to cost you?",
    "The jury is watching everything now. Are you playing a game they'll respect?",
    "Be honest with us — was that promise real, or just Tuesday?",
    "If you had to sit next to someone in the final two tomorrow, who wins?",
  ];
  return { reply: qs[Math.floor(Math.random() * qs.length)] };
}

export function fallbackSpeech(g, npcId, kind, extra = {}) {
  const name = (id) => nameOf(g, id);
  const map = {
    nomination: `My nominations are about protecting my game. ${extra.nominees ? extra.nominees.map(name).join(' and ') + ', please take a seat.' : ''} It's not personal — it's Big Brother.`,
    veto_use: `I've decided to USE the Power of Veto${extra.saved ? ' on ' + name(extra.saved) : ''}.`,
    veto_nouse: `I've decided NOT to use the Power of Veto. Ceremony adjourned.`,
    eviction_vote: `I vote to evict ${extra.target ? name(extra.target) : 'them'}.`,
    eviction_goodbye: `You got me. Play hard — I'll be watching from the jury house, and I remember everything.`,
  };
  return { reply: map[kind] || '...' };
}

// A juror may be the player/newcomer seat (no cast persona) in multiplayer.
function jurorPersonality(jurorId) {
  const c = castById(jurorId);
  return c ? c.personality : { loyalty: 50, bitterness: 50, compSkill: 50, socialSkill: 50, chaos: 50, strategic: 50 };
}

export function fallbackJurorQuestion(g, jurorId, finalists) {
  const k = knowledgeFor(g, jurorId);
  const refs = {};
  const question = (fid, index) => {
    const evidence = evidenceFor(g, jurorId);
    const personal = evidence.filter(e => e.actorId === fid && e.targetIds.includes(jurorId) && !['rumor', 'statement'].includes(e.kind));
    const record = personal.find(e => e.kind === 'promise' && e.status === 'broken') || personal.at(-1) || evidence.filter(e => e.actorId === fid && !['rumor', 'statement'].includes(e.kind)).at(-1);
    refs[index] = record ? [record.id] : [];
    if (record) return `In week ${record.week}: ${record.text} What were you trying to achieve, and why should that earn my vote?`;
    const rumor = k.rumors.find(r => r.aboutId === fid);
    if (rumor) {
      refs[index] = [rumor.id];
      return `I heard this from ${rumor.sourceName}: ${JSON.stringify(rumor.text)}. I don't know whether it's true. What is your response?`;
    }
    return `Which decision best demonstrates why you deserve my vote? Explain what you did and why it mattered.`;
  };
  const questionForF1 = question(finalists[0], 0), questionForF2 = question(finalists[1], 1);
  return { questionForF1, questionForF2, evidenceForF1: refs[0], evidenceForF2: refs[1], toneNote: jurorPersonality(jurorId).bitterness > 55 ? 'hurt' : 'respectful' };
}

export function fallbackJurorVote(g, jurorId, finalists, qa) {
  const k = knowledgeFor(g, jurorId);
  const [f1, f2] = finalists;
  const bitterness = jurorPersonality(jurorId).bitterness;
  const feelings = id => k.feelings[id] || { trust: 50, bond: 50, threat: 30 };
  // A bounded relevance/ownership heuristic, never an answer-length reward.
  const quality = (answer, id, question) => {
    const text = String(answer || '').toLowerCase();
    if (!text.trim()) return 0;
    const relevant = evidenceFor(g, jurorId).filter(e => e.actorId === id && !['rumor', 'statement'].includes(e.kind));
    const words = `${question || ''} ${relevant.map(e => e.text).join(' ')}`.toLowerCase().match(/\b[a-z]{5,}\b/g) || [];
    const overlap = [...new Set(words)].filter(w => text.includes(w)).length;
    return Math.min(6, overlap * 1.5) + (/\b(because|chose|risk|cost|protect|mistake|regret)\b/.test(text) ? 2 : 0);
  };
  const q1 = quality(qa.f1Answer, f1, qa.questionForF1), q2 = quality(qa.f2Answer, f2, qa.questionForF2);
  const score = (id, q) => {
    const r = feelings(id);
    return r.bond * .35 + r.trust * .35 + (bitterness < 50 ? r.threat * .2 : -r.threat * .05) + q * 3 + Math.random() * 12;
  };
  const vote = score(f1, q1) >= score(f2, q2) ? f1 : f2;
  const record = evidenceFor(g, jurorId).filter(e => e.actorId === vote && !['rumor', 'statement'].includes(e.kind)).at(-1);
  return {
    vote,
    reasoning: record ? `My vote is for ${nameOf(g, vote)}. In week ${record.week}, ${record.text} I weighed that decision, our relationship and the explanation tonight.` : `My vote is for ${nameOf(g, vote)}. I weighed our relationship at my eviction and how they explained their choices tonight.`,
    answerQuality: { [f1]: q1, [f2]: q2 }, evidenceIds: record ? [record.id] : [],
  };
}
