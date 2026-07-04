// Offline dialogue engine — used when no API key is set (and as a safety net
// if the API fails repeatedly). Intent classification + personality-flavored
// templates. Produces the same { reply, effects } shape as Claude.

import { castById, PLAYER_ID } from '../game/cast.js';
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
  { key: 'smalltalk', rx: /.*/ },
];

function detectTargetId(g, msg) {
  const lower = msg.toLowerCase();
  for (const id of activeIds(g)) {
    if (id === PLAYER_ID) continue;
    if (lower.includes(nameOf(g, id).toLowerCase())) return id;
  }
  return null;
}

// Personality voices: short authored fragments keyed by npc id.
const VOICE = {
  marcus: {
    alliance: ["I've been thinking the same thing. Quietly, though — let's keep this between us.", "You and me? I could see that going far. Let's not tell a soul."],
    target: ["Interesting. Walk me through it — who benefits if they go?", "I hear you. Timing matters more than the target, though."],
    accuse: ["Hey — slow down. Tell me exactly what you heard, because that's not the whole story.", "I get why it looks that way. Let me explain what actually happened."],
    smalltalk: ["How are you holding up, really? This house wears on people.", "You know what I miss? Grading papers. Never thought I'd say that."],
    ask_info: ["Between us? Watch the quiet ones this week.", "I'll tell you what I know, but you didn't hear it from me."],
    deny: ["I'd be careful who you say that to. Not everyone in here is as understanding as I am."],
  },
  rae: {
    alliance: ["You want to roll with me? I don't break my word. Ever. Don't you break yours.", "I'm a soldier. You're either with me a hundred percent or not at all."],
    target: ["If they've been coming after us, I'll handle it in the comp. That's how I do things — face to face.", "I don't like sneaky moves. If we take a shot, we own it."],
    accuse: ["Whoa. WHOA. I have never gone back on my word in this game. Watch yourself.", "Say that again? Because I ride for my people, and everyone knows it."],
    smalltalk: ["Been up since five doing laps in the yard. Gotta stay ready.", "I miss my dogs, man. Three of 'em. They'd love this backyard."],
    ask_info: ["I keep my head down and my word clean. But I've seen some shady stuff this week.", "All I know is I'm winning that comp. You can build a plan around that."],
    deny: ["That's not loyalty, and I don't do disloyal. We're done talking about it."],
  },
  zoe: {
    alliance: ["Okay okay okay — but like a REAL alliance? Because I've been burned before and this is literally week whatever of jury and— yes. Yes, I'm in.", "This is such a good move for both of us. Statistically. I've thought about it a lot."],
    target: ["Oh my god, this is a backdoor setup, isn't it? I've seen this exact episode. Okay, tell me everything.", "If we do this we have to count votes FIRST. People always forget to count votes."],
    accuse: ["Wait, what? No no no, who told you that? Because people are twisting things and I'm freaking out.", "I literally have never said that. Okay I maybe said part of that. Context matters!"],
    smalltalk: ["Do you ever just lie awake doing eviction math? Just me? Cool cool cool.", "I've wanted to play this game since I was twelve. Even the paranoia. ESPECIALLY the paranoia."],
    ask_info: ["So I made a chart in my head. Want the chart? You want the chart.", "People are lying to you. Not me though. Probably not me."],
    deny: ["I can't be part of that, it's WAY too early for that move. Ask me next week."],
  },
  flynn: {
    alliance: ["Babe. BABE. This is so official. Consider it iconic — you and me, secret power couple of the season.", "Yes! Okay, we need a name. Everything real has a name."],
    target: ["Ooooh, messy. I love it. Tell me everything and I'll tell you... some things.", "Honestly? They'd do it to you first. I'm just saying what everyone's thinking."],
    accuse: ["Excuse me?? I am the most loyal person in this house, ask literally anyone I haven't voted out.", "Okay, that got twisted SO badly. Come here, let me give you the real tea."],
    smalltalk: ["I'm putting on a talent show Thursday whether this house likes it or not.", "If I have to eat slop one more week I'm unionizing this house."],
    ask_info: ["The walls have ears, darling, and I AM the walls. What do you want to know?", "I hear everything. The question is what you'll do for me."],
    deny: ["Mmm, I love that for you, but I'm going to stay out of this one. Publicly, anyway."],
  },
  gus: {
    alliance: ["Well, I'll tell ya — I don't make many deals, but you've been straight with me. I can shake on that.", "Folks underestimate a handshake these days. Mine still means somethin'."],
    target: ["I don't go huntin' first, friend. But if they come at me or mine, that's different.", "Careful now. Plans like that have a way of comin' back around."],
    accuse: ["Now hold on. I've been called a lot of things, but a liar ain't one of 'em. Not once in fifty-two years.", "If somebody told you that, they're sellin' you somethin'."],
    smalltalk: ["Mornin'. Fed the fish out back — don't tell production.", "I miss my porch. And my grandkids. Mostly the grandkids."],
    ask_info: ["I sit quiet and I listen. And I'll tell ya, some folks in here talk out both sides of their mouth.", "Keep your eye on the ones doin' all the huggin'."],
    deny: ["That don't sit right with me. I'd rather lose honest than win crooked."],
  },
  tessa: {
    alliance: ["Oh! Um, yeah, I mean — I'm kind of just voting with the house? But I like you. So... okay, quietly?", "As long as it doesn't put a target on me. You know how I feel about targets."],
    target: ["I don't really do targets... but if that's where the house is going, I'm not going to fight it.", "Can we not tell anyone I was part of this conversation? Like, at all?"],
    accuse: ["What? I literally never take sides. That's like my whole thing.", "Whoever said that is trying to start something. I don't start things. Ever."],
    smalltalk: ["I organized the whole bathroom shelf today. It was honestly the best part of my week.", "Is it weird that I kind of like laundry day here?"],
    ask_info: ["People forget I'm in the room. I hear a lot of stuff.", "I'm not saying anything... but maybe don't trust everything Flynn tells you."],
    deny: ["That sounds like drama, and I am allergic to drama. I'm going to go fold towels."],
  },
  nash: {
    alliance: ["An alliance? With ME? Bold. Terrible decision. I'm in.", "Sure. But I'm telling you right now, if it gets boring, I'm flipping something just to feel alive."],
    target: ["Finally, someone with a pulse. Yes. Let's light it up. Who's the victim?", "You know what I like about you? You just SAY it. Everyone else whispers."],
    accuse: ["Yeah, probably. I say a lot of stuff. What'd I say this time?", "Hey — at least I lie to your face. That's basically honesty."],
    smalltalk: ["I taught Gus a card trick. He hustled me twenty minutes later. Legend.", "This house needs a fight or a party. I'm flexible on which."],
    ask_info: ["Everyone's lying to you. Including me, probably. Isn't it great?", "Marcus is running this whole house and nobody wants to say it. There. Free of charge."],
    deny: ["Nah, that bores me. Come back with something spicier."],
  },
  bev: {
    alliance: ["Sweetheart, you don't ask Bev for an alliance. You earn one. Lucky for you — you're earning it. Come here, hug it out.", "I protect my people like a mama gator. Just don't ever cross me. I mean it, cher."],
    target: ["Mmm. I've had my eye on that one since week one. Snakes don't change their skin, they just shed it.", "If we do this, we do it LOUD. I don't do sneaky. Sneaky is for cowards."],
    accuse: ["Oh no no NO. You march yourself back here and say that to my face again, I dare you.", "Forty-eight years I've run a business on my name. My NAME. Don't you dare."],
    smalltalk: ["I'm making gumbo tonight and if Nash touches the pot before it's done, so help me.", "You eating enough, baby? You look thin. Sit. Eat."],
    ask_info: ["Honey, I see EVERYTHING from that kitchen. You want the menu or the gossip?", "That Flynn's been in three different rooms telling three different stories today. Count on it."],
    deny: ["No ma'am. That's ugly business and Bev doesn't do ugly business. Ask me something nice."],
  },
};

export function fallbackChat(g, npcId, playerMsg) {
  const intent = INTENTS.find((i) => i.rx.test(playerMsg)).key;
  const targetId = detectTargetId(g, playerMsg);
  const r = rel(g, npcId, PLAYER_ID);
  const c = castById(npcId);
  const v = VOICE[npcId];

  let bucket = 'smalltalk';
  let effects = {
    trustDelta: 0, bondDelta: 1, threatDelta: 0, promiseMade: null,
    allianceSignal: 'none', suspicionOfLie: false, secretShared: null,
    targetDiscussed: null, summary: `Casual chat about the house.`,
  };

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
      effects.trustDelta = -3;
      effects.bondDelta = -2;
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
    default:
      bucket = 'smalltalk';
  }

  const lines = v[bucket] || v.smalltalk;
  const reply = lines[Math.floor(Math.random() * lines.length)];
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
  const lines = OPENER_LINES[reason] || OPENER_LINES.hangout;
  return lines[Math.floor(Math.random() * lines.length)];
}

// Group chat without an API key: 1-2 members respond via the 1:1 engine,
// effects returned per member at reduced strength.
export function fallbackGroupChat(g, memberIds, playerMsg) {
  const talkers = [...memberIds].sort(() => Math.random() - 0.5).slice(0, Math.min(2, memberIds.length));
  const replies = [];
  const effects = {};
  let promiseMade = null;
  for (const id of memberIds) {
    const r = fallbackChat(g, id, playerMsg);
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
  if (/\b(alliance|work together|team up|final ?\d|ride together)\b/i.test(playerMsg)) {
    const decliners = memberIds.filter((id) => rel(g, id, PLAYER_ID).trust < 50);
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

export function fallbackJurorQuestion(g, jurorId, finalists) {
  const c = castById(jurorId);
  const bitter = c.personality.bitterness > 55;
  return {
    questionForPlayer: bitter
      ? `You looked me in the eye and made promises. Why should my vote reward the way you played me?`
      : `What was the single best move of your game, and why does it beat everything ${nameOf(g, finalists.find((f) => f !== PLAYER_ID) || finalists[1])} did?`,
    questionForOpponent: bitter
      ? `Everyone says you played a "quiet game." Convince me that wasn't just hiding.`
      : `What move are you most proud of, and who did it hurt?`,
    toneNote: bitter ? 'bitter' : 'respectful',
  };
}

export function fallbackJurorVote(g, jurorId, finalists, qa) {
  const [f1, f2] = finalists;
  const r1 = rel(g, jurorId, f1);
  const r2 = rel(g, jurorId, f2);
  const c = castById(jurorId);
  // bond + trust + (respect for threat if not bitter) + answer length heuristic
  const score = (r, ans) =>
    r.bond * 0.4 + r.trust * 0.4 + (c.personality.bitterness < 50 ? r.threat * 0.3 : -r.threat * 0.1) +
    Math.min(10, (ans || '').length / 30);
  const s1 = score(r1, qa.f1Answer) + Math.random() * 12;
  const s2 = score(r2, qa.f2Answer) + Math.random() * 12;
  const vote = s1 >= s2 ? f1 : f2;
  return {
    vote,
    reasoning: `My vote is for ${nameOf(g, vote)}. They played the game that mattered to me.`,
    answerQuality: { [f1]: Math.round(Math.min(10, s1 / 12)), [f2]: Math.round(Math.min(10, s2 / 12)) },
  };
}
