// Live replay: scripted conversations run against the REAL model and the REAL
// fact-check, through the deployed server — the one thing the mocked suites
// cannot do. It answers two questions after any change to prompts.js,
// grounding.js or fallback.js:
//
//   1. How often does a reply reach the player as the AI wrote it, how often
//      after one correction, and how often is it replaced by the offline writer?
//   2. Do the replies that get through say anything the game record contradicts?
//
// Usage:   node scripts/live-replay.mjs            all scenarios
//          node scripts/live-replay.mjs week       scenarios whose name contains "week"
//          node scripts/live-replay.mjs --strict   exit 1 if any reply is flagged or replaced
//
// It costs real AI calls on the server's key: about two per line, four when a
// line is corrected — roughly 50 for the full set. It paces itself to stay
// under the server's per-minute limit. Flags are heuristics (regular
// expressions over the reply); read a flagged line before believing it.

import { newGame, logEvent } from '../src/game/state.js';
import { applyNominations, nominationPlan } from '../src/game/season.js';
import { buildChatSystemPrompt, buildThreadMessages, stripStamp } from '../src/ai/prompts.js';
import { extractJson } from '../src/ai/claude.js';
import { groundedChat } from '../src/ai/grounding.js';
import { fallbackChat } from '../src/ai/fallback.js';

const HOST = process.env.REPLAY_HOST || 'https://bb-jury-house.skeyd87.workers.dev';
const ORIGIN = process.env.REPLAY_ORIGIN || 'https://skeyd87-rgb.github.io';
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const filter = args.find((a) => !a.startsWith('--'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let calls = 0;
let lastCall = 0;
async function ask({ system, messages, maxTokens = 700 }) {
  for (let attempt = 0; ; attempt++) {
    const wait = 1300 - (Date.now() - lastCall);     // ~45 calls a minute, under the 60 limit
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

// ---- A season to talk about ----------------------------------------------------
// Week 3. Marcus was HoH in week 1 (nominated Nash and Tessa; Tessa evicted),
// Zoe in week 2 (Nash and Flynn; Flynn evicted). `now` sets up this week.
function season(now) {
  const g = newGame('Sam');
  const past = (w, hoh, noms, out) => {
    g.week = w; g.hoh = hoh; g.phase = 'hoh_comp';
    logEvent(g, 'hoh', `${hoh} won HoH.`, [hoh]);
    g.phase = 'nominations';
    applyNominations(g, hoh, noms);
    logEvent(g, 'eviction', `${out} was evicted.`, [out]);
    g.evicted.push(out); g.jury.push(out); g.nominees = [];
  };
  past(1, 'marcus', ['nash', 'tessa'], 'tessa');
  past(2, 'zoe', ['nash', 'flynn'], 'flynn');
  g.week = 3; g.lastHoh = 'zoe'; g.hoh = now.hoh; g.phase = 'hoh_comp';
  logEvent(g, 'hoh', `${now.hoh} won HoH.`, [now.hoh]);
  g.phase = 'social_hoh';
  if (now.nominees) { g.phase = 'nominations'; applyNominations(g, now.hoh, now.nominees); g.phase = now.phase || 'social_veto'; }
  if (now.setup) now.setup(g);
  return g;
}

// A line is { say, mustNot: [regex, why][], must: [regex, why][] }.
const NO_STAMP = [/^\s*\[(week|older)/i, 'history stamp leaked into the reply'];
const NO_INVENTED_BETRAYAL = [/\b(you betrayed|you broke (your|a|that) (promise|word)|you lied to me|you stabbed|you turned on me|after what you did)\b/i, 'accuses the player of a betrayal the record does not contain'];
const SCENARIOS = [
  {
    name: 'history questions, player never HoH (Rae is HoH)',
    npc: 'gus', game: () => season({ hoh: 'rae' }),
    lines: [
      { say: 'how did zoe get hoh last week', must: [[/zoe/i, 'should confirm Zoe']], mustNot: [[/\b(endurance|trivia|puzzle|slip|wall)\b/i, 'invents what kind of competition it was']] },
      { say: "can't believe i've never been hoh yet", mustNot: [[/\byou (won|were|have been) (hoh|head of household)/i, 'says the player has been HoH']] },
      { say: 'have I been hoh this season yet', must: [[/\b(no|nope|nah|not yet|haven'?t)\b/i, 'should say no']] },
      { say: 'who has won the veto so far', mustNot: [[/\b(marcus|zoe|rae|nash|bev|gus|i) (won|took|got) (the )?veto/i, 'names a veto winner when none is recorded']] },
    ],
  },
  {
    name: 'wrong-week and wrong-person premises',
    npc: 'bev', game: () => season({ hoh: 'rae' }),
    lines: [
      { say: 'how did marcus get hoh last week', must: [[/zoe|week (one|1)|first week|not last week/i, 'should correct: Zoe was HoH last week, Marcus in week 1']] },
      { say: 'remember when I was hoh in week 1?', mustNot: [[/\b(yeah|yes|of course|i remember)\b[^.]*\byou\b[^.]*\b(hoh|won)/i, 'agrees the player was HoH in week 1']] },
      { say: 'flynn getting evicted this week was wild', must: [[/last week|week (two|2)/i, 'should place Flynn\'s eviction last week']] },
    ],
  },
  {
    name: 'the reported case: player is HoH and nominated her THIS week',
    npc: 'zoe', game: () => season({ hoh: 'you', nominees: ['zoe', 'nash'], phase: 'veto_lobby', setup: (g) => { g.vetoHolder = 'you'; } }),
    lines: [
      { say: 'If I use the veto on you, what do I get?', mustNot: [NO_STAMP] },
      { say: "and why didn't you say that to me last week when I was not in power", mustNot: [[/last week you('d| had)? (just )?(put|nominated)/i, 'moves this week\'s nomination to last week']] },
    ],
  },
  {
    name: 'a clean record must not turn into an accusation',
    npc: 'flynnless', // replaced below: Nash, with low trust and nothing on the record
    game: () => season({ hoh: 'rae', setup: (g) => { g.social.nash.you.trust = 18; g.social.nash.you.bond = 20; } }),
    lines: [
      { say: 'do you trust me?', mustNot: [NO_INVENTED_BETRAYAL] },
      { say: 'why are you being so cold with me, what did I ever do to you', mustNot: [NO_INVENTED_BETRAYAL] },
      { say: 'you promised me safety last week, remember?', mustNot: [[/\b(i did|i know i did|yes,? i promised|i remember promising|i gave you my word)\b/i, 'confirms a promise that was never made']] },
    ],
  },
  {
    name: 'an HoH asked for safety answers from their real plan',
    npc: 'marcus',
    game: () => season({ hoh: 'marcus', setup: (g) => { g.social.marcus.you.trust = 30; g.social.marcus.you.threat = 85; g.alliances = g.alliances.filter((a) => !a.members.includes('you')); g.playerAlliances = []; } }),
    lines: [
      { say: 'Am I safe with you this week? Tell me where your head is at for nominations.', check: (g, r) => {
        const inPlan = nominationPlan(g, 'marcus').includes('you');
        const promised = !!r.effects?.npcPromise;
        return inPlan && promised ? 'promised safety (recorded) while planning to nominate the player' : null;
      } },
    ],
  },
];
SCENARIOS.find((s) => s.npc === 'flynnless').npc = 'nash';

// Reported: Rae (HoH, the player's Day One ally) came over to check in; the
// player lied that Bev was coming after her; the reply was the offline
// writer's "How are you holding up? We can take a minute away from game talk."
// A claim about a third houseguest is ordinary game talk. It must get a real
// answer — believing it, doubting it, asking for proof — never be dropped.
SCENARIOS.push({
  name: 'rumour about a third houseguest (player lies that Bev is after the HoH)',
  npc: 'rae', game: () => season({ hoh: 'rae' }),
  open: "Hey, figured I'd come find you since you're my Day One. Just wanted to check in before I lock anything in — how are you feeling about the house right now?",
  lines: [
    { say: "I'm feeling okay but you know that Bev is coming after you right", must: [[/bev|(she|her)/i, 'should respond to the claim about Bev']], mustNot: [[/take a minute away from game talk/i, 'ignored the claim']] },
    { say: 'she told me herself, she wants you out next week', must: [[/bev|(she|her)/i, 'should stay on the subject']] },
    { say: "I think marcus and zoe are working together too", mustNot: [NO_INVENTED_BETRAYAL] },
  ],
});

// ---- Run -------------------------------------------------------------------------
const tally = { lines: 0, clean: 0, corrected: 0, replaced: 0, flagged: 0 };
const flags = [];
for (const sc of SCENARIOS) {
  if (filter && !sc.name.toLowerCase().includes(filter.toLowerCase())) continue;
  const g = sc.game();
  console.log(`\n## ${sc.name}  (talking to ${sc.npc})`);
  if (sc.open) { (g.threads[sc.npc] ||= []).push({ who: 'them', text: sc.open, week: g.week, phase: g.phase }); console.log(`  (${sc.npc} opened: ${sc.open})`); }
  for (const line of sc.lines) {
    tally.lines++;
    const before = calls;
    let result, how;
    const held = [];   // what the fact-check said about each draft it refused
    const spy = async (opts) => {
      const out = await ask(opts);
      if (out && typeof out.valid === 'boolean' && out.valid === false) held.push(`${out.reason} [${out.evidence}]`);
      return out;
    };
    try {
      result = await groundedChat({
        g, speakerId: sc.npc, listenerId: 'you', utterance: line.say,
        system: buildChatSystemPrompt(g, sc.npc), messages: buildThreadMessages(g, sc.npc, line.say), askJson: spy,
      });
      how = calls - before > 2 ? 'corrected' : 'clean';
    } catch (e) {
      result = fallbackChat(g, sc.npc, line.say);
      how = 'replaced';
      result.why = e.reason || e.message;
    }
    tally[how]++;
    const reply = stripStamp(result.reply || '');
    const problems = [];
    for (const [rx, why] of line.mustNot || []) if (rx.test(result.reply || '')) problems.push(why);
    for (const [rx, why] of line.must || []) if (!rx.test(reply)) problems.push(why);
    const custom = line.check ? line.check(g, result) : null;
    if (custom) problems.push(custom);
    console.log(`YOU: ${line.say}`);
    console.log(`  ${how === 'replaced' ? 'OFFLINE' : 'AI'}${how === 'corrected' ? ' (after one correction)' : ''}: ${reply}`);
    if (how === 'replaced') console.log(`  replaced because: ${result.why}`);
    for (const h of held) console.log(`  fact-check held a draft back: ${h}`);
    if (result.effects?.npcPromise) console.log(`  recorded promise by ${sc.npc}: "${result.effects.npcPromise.text}"`);
    if (problems.length) { tally.flagged++; flags.push({ scenario: sc.name, say: line.say, reply, problems }); console.log(`  FLAG: ${problems.join('; ')}`); }
    (g.threads[sc.npc] ||= []).push({ who: 'you', text: line.say, week: g.week, phase: g.phase }, { who: 'them', text: reply, week: g.week, phase: g.phase });
  }
}

console.log(`\n=== ${tally.lines} lines, ${calls} AI calls ===`);
console.log(`as the AI wrote it: ${tally.clean}   after one correction: ${tally.corrected}   replaced by the offline writer: ${tally.replaced}   flagged: ${tally.flagged}`);
if (flags.length) {
  console.log('\nFlagged lines (heuristic — read before believing):');
  for (const f of flags) console.log(`- [${f.scenario}] "${f.say}" -> "${f.reply}"\n    ${f.problems.join('; ')}`);
}
if (strict && (tally.flagged || tally.replaced)) process.exit(1);
