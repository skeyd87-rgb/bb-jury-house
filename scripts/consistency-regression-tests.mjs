// A houseguest should do what they said they would, unless something changed
// their mind. Each test pins one part of that.
import { newGame, activeIds } from '../src/game/state.js';
import { nominationPlan, decideNominations, applyNominations, resolveEviction, nominationDesire } from '../src/game/season.js';
import { applyChatEffects } from '../src/game/social.js';
import { huddleIntel } from '../src/game/intel.js';
import { fallbackChat } from '../src/ai/fallback.js';
import { describeNpcMind } from '../src/ai/prompts.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const base = { trustDelta: 0, bondDelta: 0, threatDelta: 0 };
function hohGame(hoh = 'marcus') {
  const g = newGame('Sam');
  g.hoh = hoh;
  g.phase = 'social_hoh';
  return g;
}

function thePlanDoesNotChangeByItself() {
  for (let s = 0; s < 40; s++) {
    const g = hohGame();
    const first = nominationPlan(g, 'marcus');
    for (let i = 0; i < 25; i++) {
      const again = nominationPlan(g, 'marcus');
      assert(again.join() === first.join(), `plan changed with nothing happening: ${first} -> ${again}`);
    }
    const actual = decideNominations(g, 'marcus');
    assert(actual.join() === first.join(), `ceremony ignored the plan: said ${first}, did ${actual}`);
  }
}

function plansStillVaryBetweenSeasons() {
  const seen = new Set();
  for (let s = 0; s < 60; s++) seen.add(nominationPlan(hohGame(), 'marcus').slice().sort().join('+'));
  assert(seen.size >= 4, `only ${seen.size} distinct plans in 60 seasons — the roll has gone deterministic`);
}

function whatYouOverhearIsWhatHappens() {
  let checked = 0;
  for (let s = 0; s < 200 && checked < 40; s++) {
    const g = hohGame();
    const item = huddleIntel(g, 'marcus', 'nash', () => 0.2); // 0.2: Marcus speaks; no shared alliance, so the plan line is picked
    if (item.kind !== 'plan') continue;
    checked++;
    const actual = decideNominations(g, 'marcus');
    for (const n of actual) {
      const name = n === 'you' ? 'you' : g.houseguests.find((h) => h.id === n).name;
      assert(item.text.includes(name), `overheard "${item.text}" but ${name} was nominated`);
    }
  }
  assert(checked >= 20, `only ${checked} plan huddles sampled`);
}

function aPromiseOfSafetySparesYou() {
  let spared = 0, tried = 0;
  for (let s = 0; s < 300 && tried < 40; s++) {
    const g = hohGame('rae'); // Rae: loyalty 95
    // Make the player a likely nominee, then see whether her word outweighs it.
    g.social.rae.you.threat = 80; g.social.rae.you.trust = 35;
    g.alliances = []; g.playerAlliances = [];
    if (!nominationPlan(g, 'rae').includes('you')) continue;
    tried++;
    applyChatEffects(g, 'rae', 'Am I safe?', { ...base, npcPromise: { text: 'not to nominate you this week', kind: 'safety' } });
    assert(g.promises.some((p) => p.from === 'rae' && p.to === 'you' && p.kind === 'safety'), 'her promise was not recorded');
    if (!decideNominations(g, 'rae').includes('you')) spared++;
  }
  assert(tried >= 20, `only ${tried} cases where the player started in the plan`);
  assert(spared / tried > 0.9, `a loyal HoH kept her word only ${spared}/${tried} times`);
}

function aBrokenWordIsOnTheRecord() {
  const g = hohGame('flynn');
  applyChatEffects(g, 'flynn', 'Am I safe?', { ...base, npcPromise: { text: 'not to nominate you', kind: 'safety' } });
  applyNominations(g, 'flynn', ['you', 'gus']);
  const p = g.promises.find((x) => x.from === 'flynn' && x.to === 'you');
  assert(p.status === 'broken', `promise is ${p.status} after he nominated the player`);
  assert(g.events.some((e) => e.type === 'betrayal' && e.actors[0] === 'flynn'), 'no betrayal logged against him');
  assert(/YOU broke this promise to Sam/.test(describeNpcMind(g, 'flynn')), 'his prompt does not own the broken promise');
}

function aVotePromiseHoldsALoyalVoter() {
  let kept = 0;
  const N = 200;
  for (let s = 0; s < N; s++) {
    const g = newGame('Sam');
    g.alliances = []; g.playerAlliances = [];
    g.hoh = 'marcus'; g.nominees = ['you', 'gus']; g.phase = 'campaigning';
    g.social.rae.you.trust = 55; g.social.rae.gus.trust = 60; // mildly prefers Gus
    applyChatEffects(g, 'rae', 'Keep me', { ...base, npcPromise: { text: 'to vote to keep you this week', kind: 'vote' } });
    if (resolveEviction(g, null).votes.rae === 'gus') kept++;
  }
  assert(kept / N > 0.85, `a loyal voter kept a vote promise only ${kept}/${N} times`);
}

function offlineAnswersComeFromTheRealDecision() {
  let promised = 0, refused = 0;
  for (let s = 0; s < 200; s++) {
    const g = hohGame('marcus');
    const inPlan = nominationPlan(g, 'marcus').includes('you');
    const { reply, effects } = fallbackChat(g, 'marcus', 'Am I safe with you this week?');
    if (inPlan) {
      refused++;
      assert(!effects.npcPromise, `promised safety to someone in the plan: "${reply}"`);
      assert(!/won't put you up/i.test(reply), `said safe while planning to nominate: "${reply}"`);
    } else if (effects.npcPromise) {
      promised++;
      assert(!decideNominations(g, 'marcus').includes('you'), 'promised safety, then nominated the player');
    }
  }
  assert(promised > 20, `offline HoH almost never commits (${promised}/200)`);
  const g = hohGame('marcus');
  const notHoh = fallbackChat(g, 'gus', 'Am I safe with you this week?');
  assert(!notHoh.effects.npcPromise, 'a houseguest who is not HoH promised safety from nominations');
  void refused;
}

function thePromptCarriesTheDecision() {
  const g = hohGame('marcus');
  const plan = nominationPlan(g, 'marcus');
  const mind = describeNpcMind(g, 'marcus');
  for (const id of plan) {
    const name = g.houseguests.find((h) => h.id === id).name;
    assert(mind.includes(name), `the HoH's prompt does not name planned nominee ${name}`);
  }
  assert(/YOUR DECISIONS THIS WEEK/.test(mind), 'no decisions block in the HoH prompt');
  g.nominees = ['nash', 'tessa']; g.phase = 'campaigning';
  assert(/Your vote/.test(describeNpcMind(g, 'gus')), "a voter's prompt does not state their vote");
  assert(!/Your vote/.test(describeNpcMind(g, 'nash')), 'a nominee was told how they are voting');
}

function strongNewFeelingsCanStillChangeThePlan() {
  const g = hohGame('marcus');
  const plan = nominationPlan(g, 'marcus');
  const outsider = activeIds(g).find((id) => id !== 'marcus' && !plan.includes(id));
  g.social.marcus[outsider].threat = 100; g.social.marcus[outsider].trust = 0; g.social.marcus[outsider].bond = 0;
  g.alliances = g.alliances.filter((a) => !(a.members.includes('marcus') && a.members.includes(outsider)));
  assert(nominationDesire(g, 'marcus', outsider, () => 0.5) > 60, 'test setup: outsider is not a strong target');
  assert(nominationPlan(g, 'marcus').includes(outsider), 'the HoH ignored someone they now badly want out');
}

const tests = [
  thePlanDoesNotChangeByItself, plansStillVaryBetweenSeasons, whatYouOverhearIsWhatHappens,
  aPromiseOfSafetySparesYou, aBrokenWordIsOnTheRecord, aVotePromiseHoldsALoyalVoter,
  offlineAnswersComeFromTheRealDecision, thePromptCarriesTheDecision, strongNewFeelingsCanStillChangeThePlan,
];
let failed = 0;
for (const test of tests) {
  try { test(); console.log(`PASS ${test.name}`); }
  catch (error) { failed++; console.log(`FAIL ${test.name}: ${error.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} consistency regressions passed`);
if (failed) process.exit(1);
