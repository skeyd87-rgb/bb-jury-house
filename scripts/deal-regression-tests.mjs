// Deals: "I'll put Flynn up as the replacement", "use the veto and I'll
// backdoor Rae", "I'll use the veto on Gus". Each case below is from a real
// season (exported 2026-11-18) where the houseguest agreed to a deal, did
// something else, and the record said they had kept their word.
//   node scripts/deal-regression-tests.mjs
import assert from 'node:assert/strict';
import { newGame, rel } from '../src/game/state.js';
import { applyChatEffects, settleWeekPromises, readDeal } from '../src/game/social.js';
import { applyNominations, applyVeto, applyVetoSave, applyReplacement, decideReplacement, decideVetoUse } from '../src/game/season.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const none = { trustDelta: 0, bondDelta: 0, threatDelta: 0 };
const rate = (n, fn) => { let k = 0; for (let i = 0; i < n; i++) if (fn()) k++; return k / n; };

// Week 1 of that season: Rae is HoH with Nash and Gus up; the player holds the veto.
function weekOne() {
  const g = newGame('Brittany');
  g.hoh = 'rae'; g.phase = 'veto_lobby';
  applyNominations(g, 'rae', ['nash', 'gus']);
  g.vetoHolder = 'you';
  rel(g, 'rae', 'you').trust = 70;
  // Flynn is someone Rae would not otherwise pick, so a pick of Flynn is the deal at work.
  Object.assign(rel(g, 'rae', 'flynn'), { trust: 75, bond: 70, threat: 10 });
  return g;
}
const raeDeal = (g) => applyChatEffects(g, 'rae', 'Will you put Flynn up if I take Gus down?', {
  ...none,
  promiseMade: { text: 'If Brittany uses the veto on Gus, Rae will nominate Flynn as the replacement', kind: 'alliance' },
  npcPromise: { text: 'If Brittany takes Gus down with the veto, Rae will put Flynn up as the replacement nominee this week', kind: 'safety' },
});

test("the houseguest's deal is recorded once, as theirs, about the right person", () => {
  const g = weekOne(); raeDeal(g);
  assert.equal(g.promises.length, 1, 'the same deal was recorded twice');
  const p = g.promises[0];
  assert.deepEqual([p.from, p.to, p.kind, p.targetId, !!p.ifReplacement], ['rae', 'you', 'nominate', 'flynn', true]);
});

test('a loyal HoH who trusts you names the promised replacement', () => {
  const g = weekOne(); raeDeal(g);
  const r = rate(500, () => decideReplacement(g, 'rae', ['nash', 'gus', 'you']) === 'flynn');
  assert.ok(r > 0.85, `Rae named Flynn only ${Math.round(r * 100)}% of the time`);
  const before = (() => { const h = weekOne(); return rate(500, () => decideReplacement(h, 'rae', ['nash', 'gus', 'you']) === 'flynn'); })();
  assert.ok(before < 0.5, 'Flynn was the likely pick even without a deal; the test proves nothing');
});

test('...but not always: soured on you, she may not', () => {
  const g = weekOne(); raeDeal(g); rel(g, 'rae', 'you').trust = 10;
  const r = rate(500, () => decideReplacement(g, 'rae', ['nash', 'gus', 'you']) === 'flynn');
  assert.ok(r < 0.85, `a deal with someone she no longer trusts still held ${Math.round(r * 100)}% of the time`);
});

test('kept when she names Flynn; broken, with a grudge, when she names Bev', () => {
  const g = weekOne(); raeDeal(g);
  applyVetoSave(g, 'you', 'gus'); applyReplacement(g, 'flynn');
  assert.equal(g.promises[0].status, 'kept');
  const h = weekOne(); raeDeal(h);
  applyVetoSave(h, 'you', 'gus'); applyReplacement(h, 'bev');
  assert.equal(h.promises[0].status, 'broken', 'naming someone else was not a broken deal');
  assert.ok(h.events.some((e) => /broke a deal/.test(e.text)), 'the house was not told');
  assert.ok(!h.events.some((e) => /kept a promise/.test(e.text)), 'the record still claimed she kept her word');
});

test('a deal that hinges on the veto lapses, unjudged, when the veto is not used', () => {
  const g = weekOne(); raeDeal(g);
  applyVeto(g, 'you', false);
  settleWeekPromises(g);
  assert.equal(g.promises[0].status, 'void');
});

test("a promise that protects the player is not filed as the player's promise", () => {
  const g = newGame('Brittany');
  applyChatEffects(g, 'marcus', 'Protect me and I protect you.', { ...none,
    promiseMade: { text: 'Brittany expects Marcus to protect her from the block if he wins HOH', kind: 'safety', protectedIds: ['you'] } });
  assert.equal(g.promises.length, 0, `recorded: ${JSON.stringify(g.promises)}`);
});

test("the player's own offer is still the player's: 'I'll backdoor Rae if you use the veto'", () => {
  const g = newGame('Brittany');
  applyChatEffects(g, 'gus', 'If you use the veto I will backdoor Rae.', { ...none,
    promiseMade: { text: 'Brittany will backdoor Rae if Gus uses the veto', kind: 'vote_evict', targetId: 'rae' } });
  const p = g.promises[0];
  assert.deepEqual([p.from, p.to, p.kind, p.targetId, !!p.ifReplacement], ['you', 'gus', 'nominate', 'rae', true]);
});

test('a veto holder weighs the HoH offering to backdoor someone they want gone', () => {
  const setup = (offer) => {
    const g = newGame('Brittany');
    g.hoh = 'you'; applyNominations(g, 'you', ['marcus', 'zoe']); g.vetoHolder = 'gus';
    rel(g, 'gus', 'rae').trust = 25; rel(g, 'gus', 'rae').threat = 75; rel(g, 'gus', 'you').trust = 75;
    if (offer) applyChatEffects(g, 'gus', 'Use it and Rae goes up.', { ...none,
      promiseMade: { text: 'Brittany will backdoor Rae if Gus uses the veto', kind: 'nominate', targetId: 'rae' } });
    return g;
  };
  const a = setup(false), b = setup(true);
  const without = rate(400, () => decideVetoUse(a, 'gus').use), withOffer = rate(400, () => decideVetoUse(b, 'gus').use);
  assert.ok(withOffer > without + 0.35, `the offer moved Gus from ${Math.round(without * 100)}% to ${Math.round(withOffer * 100)}%`);
});

test('a holder who promised to use it on someone does, and breaking that is recorded', () => {
  const setup = () => {
    const g = newGame('Brittany');
    g.hoh = 'marcus'; applyNominations(g, 'marcus', ['gus', 'nash']); g.vetoHolder = 'bev';
    rel(g, 'bev', 'you').trust = 75;
    applyChatEffects(g, 'bev', 'Will you pull Gus off?', { ...none, npcPromise: { text: 'I will use the veto on Gus', kind: 'veto', targetId: 'gus' } });
    return g;
  };
  const g = setup();
  assert.equal(g.promises[0].kind, 'veto');
  const r = rate(400, () => { const d = decideVetoUse(g, 'bev'); return d.use && d.savedId === 'gus'; });
  assert.ok(r > 0.8, `Bev kept her veto deal only ${Math.round(r * 100)}% of the time`);
  const h = setup(); applyVeto(h, 'bev', false);
  assert.equal(h.promises[0].status, 'broken');
  const k = setup(); applyVetoSave(k, 'bev', 'gus');
  assert.equal(k.promises[0].status, 'kept');
});

test('"I won\'t nominate Rae" is still a safety promise, not a deal to nominate her', () => {
  const g = newGame('Brittany');
  assert.deepEqual(readDeal(g, "I won't nominate Rae", 'safety', null, ['bev']), {});
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.message); }
}
console.log(`${tests.length - failed}/${tests.length} deal regressions passed`);
if (failed) process.exitCode = 1;
