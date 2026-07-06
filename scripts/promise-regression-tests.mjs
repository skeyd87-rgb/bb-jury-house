import { newGame } from '../src/game/state.js';
import { applyChatEffects, recordBetrayalIfAny } from '../src/game/social.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function testNamedGroupSafetyPromiseOnlyProtectsNamedHouseguests() {
  const g = newGame('Sam');
  g.week = 3;
  const promiseMade = {
    text: 'Rae and Bev are safe from me this week',
    kind: 'safety',
    protectedIds: ['rae', 'bev'],
  };

  for (const listener of ['marcus', 'rae', 'zoe', 'flynn', 'tessa', 'bev']) {
    applyChatEffects(g, listener, promiseMade.text, { promiseMade }, 'you');
  }

  assert(g.promises.length === 2, `expected 2 protected promises, got ${g.promises.length}`);
  assert(g.promises.every((p) => ['rae', 'bev'].includes(p.to)), `unexpected promise recipients: ${g.promises.map((p) => p.to).join(',')}`);

  for (const nominee of ['marcus', 'zoe', 'flynn']) {
    const betrayed = recordBetrayalIfAny(g, 'you', 'nominated', nominee);
    assert(!betrayed, `${nominee} incorrectly counted as a broken safety promise`);
  }
  assert(g.promises.every((p) => p.status === 'open'), `named promises changed too early: ${g.promises.map((p) => `${p.to}:${p.status}`).join(',')}`);

  const betrayedRae = recordBetrayalIfAny(g, 'you', 'nominated', 'rae');
  assert(betrayedRae, 'nominating Rae should break her named safety promise');
  assert(g.promises.find((p) => p.to === 'rae')?.status === 'broken', 'Rae promise was not marked broken');
  assert(g.promises.find((p) => p.to === 'bev')?.status === 'open', 'Bev promise should remain open');
}

const tests = [
  testNamedGroupSafetyPromiseOnlyProtectsNamedHouseguests,
];

const results = [];
for (const test of tests) {
  try {
    test();
    results.push({ name: test.name, ok: true });
    console.log(`PASS ${test.name}`);
  } catch (error) {
    results.push({ name: test.name, ok: false, error: error.message });
    console.log(`FAIL ${test.name}: ${error.message}`);
  }
}

console.log(JSON.stringify(results, null, 2));
if (results.some((r) => !r.ok)) process.exit(1);
