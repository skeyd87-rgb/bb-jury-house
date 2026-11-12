// A houseguest may only hold a betrayal against you if one happened.
// Each test here is a way the engine used to manufacture one.
import { newGame } from '../src/game/state.js';
import { applyChatEffects, recordBetrayalIfAny, settleWeekPromises, isProtectedInText } from '../src/game/social.js';
import { applyNominations, applyEviction, nextPhase } from '../src/game/season.js';
import { fallbackChat } from '../src/ai/fallback.js';
import { describeNpcMind } from '../src/ai/prompts.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const grudgesVsPlayer = (g, id) => g.memory[id].grudges.filter((x) => x.againstId === 'you');
const base = { trustDelta: 0, bondDelta: 0, threatDelta: 0 };
// A game with no pre-existing alliances, so only what the test sets up counts.
function bare() {
  const g = newGame('Sam');
  g.alliances = [];
  g.playerAlliances = [];
  return g;
}

function namingATargetDoesNotPromiseThemSafety() {
  const g = bare();
  const text = "You're safe with me, I'm going after Marcus";
  applyChatEffects(g, 'rae', text, { ...base, promiseMade: { text, kind: 'safety' } });
  assert(g.promises.length === 1 && g.promises[0].to === 'rae', `promise went to ${g.promises.map((p) => p.to)}`);
  assert(!recordBetrayalIfAny(g, 'you', 'nominated', 'marcus'), 'nominating the stated target counted as a betrayal');
  assert(grudgesVsPlayer(g, 'marcus').length === 0, 'Marcus holds a grudge for a promise never made to him');
}

function protectedNamesAreStillRead() {
  assert(isProtectedInText("I won't nominate Rae or put her up", 'Rae'), 'missed "won\'t nominate Rae"');
  assert(isProtectedInText('Rae and Bev are safe this week', 'Rae'), 'missed "Rae and Bev are safe" (Rae)');
  assert(isProtectedInText('Rae and Bev are safe this week', 'Bev'), 'missed "Rae and Bev are safe" (Bev)');
  assert(isProtectedInText("I'll protect Gus", 'Gus'), 'missed "protect Gus"');
  assert(!isProtectedInText("you're safe, Marcus is my target", 'Marcus'), 'a named target read as protected');
  assert(!isProtectedInText('I am putting Flynn up, not you', 'Flynn'), '"putting Flynn up" read as protection');
}

function thisWeekSafetyEndsWithTheWeek() {
  const g = bare();
  g.week = 2; g.hoh = 'marcus'; g.phase = 'eviction';
  const text = "I won't put you up this week";
  applyChatEffects(g, 'zoe', text, { ...base, promiseMade: { text, kind: 'safety' } });
  const t0 = g.social.zoe.you.trust;
  nextPhase(g); // week 2 -> 3
  const p = g.promises[0];
  assert(p.status === 'kept', `week-scoped promise is ${p.status} after the week ended`);
  assert(g.social.zoe.you.trust > t0, 'keeping the promise earned no trust');
  g.week = 5;
  assert(!recordBetrayalIfAny(g, 'you', 'nominated', 'zoe'), 'nominating her three weeks later counted as breaking a week-2 promise');
  assert(grudgesVsPlayer(g, 'zoe').length === 0, 'grudge for an expired promise');
}

function openEndedSafetyStillBinds() {
  const g = bare();
  const text = 'I will never nominate you';
  applyChatEffects(g, 'zoe', text, { ...base, promiseMade: { text, kind: 'safety' } });
  settleWeekPromises(g);
  assert(g.promises[0].status === 'open', 'an open-ended promise was settled as if week-scoped');
  assert(recordBetrayalIfAny(g, 'you', 'nominated', 'zoe'), 'breaking an open-ended promise was not recorded');
  assert(g.promises[0].status === 'broken', 'promise not marked broken');
}

function nominatingDoesNotBreakAVotePromise() {
  const g = bare();
  applyChatEffects(g, 'gus', 'You have my vote', { ...base, promiseMade: { text: 'to vote to keep them', kind: 'vote' } });
  assert(!recordBetrayalIfAny(g, 'you', 'nominated', 'gus'), 'a vote promise was broken by a nomination');
  assert(g.promises[0].status === 'open', `vote promise is ${g.promises[0].status}`);
}

function aHunchIsNotAGrudge() {
  const g = bare();
  applyChatEffects(g, 'nash', 'I never said that', { ...base, suspicionOfLie: true });
  assert(grudgesVsPlayer(g, 'nash').length === 0, 'suspicion alone filed a grudge');
}

function anOfferIsNotAnAlliance() {
  const g = bare();
  g.social.tessa.you.trust = 80;
  applyChatEffects(g, 'tessa', 'How are you?', { ...base, allianceSignal: 'propose' });
  assert(g.alliances.length === 0, 'an NPC offer formed an alliance without the player agreeing');
  assert(!recordBetrayalIfAny(g, 'you', 'voted_against', 'tessa'), 'voting against someone who only made an offer counted as betrayal');
  applyChatEffects(g, 'tessa', "I'm in, let's work together", { ...base, allianceSignal: 'accept' });
  assert(g.alliances.length === 1, 'accepting did not form the alliance');
}

function forcedNominationOfAnAllyIsNotBetrayal() {
  const g = bare();
  // Final four, player is HoH and allied with all three: two of them must go up.
  g.evicted = ['flynn', 'gus', 'tessa', 'nash', 'bev'];
  g.alliances = [{ id: 'alx', name: 'Everyone', members: ['you', 'marcus', 'rae', 'zoe'], formedWeek: 1, lastActive: 1, dead: false }];
  g.hoh = 'you';
  applyNominations(g, 'you', ['marcus', 'rae']);
  assert(grudgesVsPlayer(g, 'marcus').length === 0 && grudgesVsPlayer(g, 'rae').length === 0, 'forced nomination filed a betrayal grudge');
  assert(!g.events.some((e) => e.type === 'betrayal'), 'forced nomination logged as a betrayal');
}

function freeNominationOfAnAllyStillIs() {
  const g = bare();
  g.alliances = [{ id: 'alx', name: 'Us', members: ['you', 'rae'], formedWeek: 1, lastActive: 1, dead: false }];
  g.hoh = 'you';
  applyNominations(g, 'you', ['rae', 'marcus']);
  assert(grudgesVsPlayer(g, 'rae').length === 1, 'choosing to nominate an ally was not recorded');
}

function votingBetweenTwoAlliesIsNotBetrayal() {
  const g = bare();
  g.alliances = [{ id: 'alx', name: 'Us', members: ['you', 'rae', 'bev'], formedWeek: 1, lastActive: 1, dead: false }];
  g.hoh = 'marcus'; g.nominees = ['rae', 'bev']; g.phase = 'eviction';
  applyEviction(g, 'rae', { you: 'rae', zoe: 'rae', gus: 'bev' });
  assert(!g.events.some((e) => e.type === 'betrayal' && e.actors[0] === 'you'), 'a forced vote between two allies logged as betrayal');
  assert(g.social.bev.you.trust >= 50, 'survivor lost trust over a forced vote');
}

function talkingAboutSomeoneIsNotTargetingThem() {
  const g = bare();
  for (const msg of [
    'Do you think Marcus will nominate me?',
    'I would never target Rae.',
    'What are the votes looking like for Rae?',
    "I'm worried Zoe is coming after me",
  ]) {
    const { effects } = fallbackChat(g, 'gus', msg);
    assert(!effects.targetDiscussed, `"${msg}" was read as pushing ${effects.targetDiscussed} as a target`);
    assert(!effects.secretShared, `"${msg}" was stored as a secret: ${effects.secretShared}`);
  }
  const { effects } = fallbackChat(g, 'gus', 'We should target Marcus this week.');
  assert(effects.targetDiscussed === 'marcus', 'a real target push was missed');
}

function aGuessedTargetNeedsTheNameSaid() {
  const g = bare();
  applyChatEffects(g, 'gus', 'Somebody in here is playing too hard.', { ...base, targetDiscussed: 'rae', secretShared: 'wants Rae out' });
  const heard = g.memory.gus.gossipHeard.at(-1);
  assert(heard && heard.aboutId === null, 'gossip pinned on someone the player never named');
}

function thePromptStatesWhenNothingHappened() {
  const g = bare();
  g.social.flynn.you.trust = 20; // distrust with no facts behind it
  const mind = describeNpcMind(g, 'flynn');
  assert(/promises Sam broke to you: NONE/.test(mind), 'ledger missing the broken-promise count');
  assert(/nominated you: NEVER/.test(mind), 'ledger missing the nomination record');
  assert(/has NOT betrayed you/.test(mind), 'prompt does not rule out an invented betrayal');
  g.hoh = 'you';
  applyNominations(g, 'you', ['flynn', 'gus']);
  const after = describeNpcMind(g, 'flynn');
  assert(/nominated you: Week 1, THIS WEEK/.test(after), 'a real nomination is missing from the ledger');
  assert(!/has NOT betrayed you/.test(after), 'prompt still claims a clean record after a nomination');
}

const tests = [
  namingATargetDoesNotPromiseThemSafety, protectedNamesAreStillRead, thisWeekSafetyEndsWithTheWeek,
  openEndedSafetyStillBinds, nominatingDoesNotBreakAVotePromise, aHunchIsNotAGrudge, anOfferIsNotAnAlliance,
  forcedNominationOfAnAllyIsNotBetrayal, freeNominationOfAnAllyStillIs, votingBetweenTwoAlliesIsNotBetrayal,
  talkingAboutSomeoneIsNotTargetingThem, aGuessedTargetNeedsTheNameSaid, thePromptStatesWhenNothingHappened,
];

let failed = 0;
for (const test of tests) {
  try { test(); console.log(`PASS ${test.name}`); }
  catch (error) { failed++; console.log(`FAIL ${test.name}: ${error.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} betrayal regressions passed`);
if (failed) process.exit(1);
