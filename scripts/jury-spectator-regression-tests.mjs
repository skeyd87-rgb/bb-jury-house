import { newGame } from '../src/game/state.js';
import { applyEviction } from '../src/game/season.js';
import {
  buildFinaleContext,
  countJuryVotes,
  winnerFromJuryVotes,
} from '../src/game/finale.js';
import { PLAYER_ID } from '../src/game/cast.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function evictToFinalTwoWithPlayerOnJury() {
  const g = newGame('Sam');
  const evictionOrder = [PLAYER_ID, 'marcus', 'rae', 'zoe', 'flynn', 'tessa', 'gus'];
  for (const id of evictionOrder) {
    g.nominees = [id, g.houseguests.find((h) => !g.evicted.includes(h.id) && h.id !== id)?.id].filter(Boolean);
    applyEviction(g, id, {});
  }
  return g;
}

function testPlayerEvictionCreatesJuryFinaleContext() {
  const g = evictToFinalTwoWithPlayerOnJury();
  const ctx = buildFinaleContext(g);

  assert(ctx.playerRole === 'juror', `expected playerRole juror, got ${ctx.playerRole}`);
  assert(ctx.finalists.length === 2, `expected 2 finalists, got ${ctx.finalists.length}`);
  assert(!ctx.finalists.includes(PLAYER_ID), 'evicted player should not be a finalist');
  assert(ctx.jurors.includes(PLAYER_ID), 'evicted player should remain in jury list');
  assert(ctx.playerJurorIndex >= 0, 'expected player juror index');
}

function testNpcFinalTwoVoteCountingDoesNotAssumePlayerFinalist() {
  const g = evictToFinalTwoWithPlayerOnJury();
  const { finalists } = buildFinaleContext(g);
  const votes = [
    { juror: PLAYER_ID, vote: finalists[0] },
    { juror: 'marcus', vote: finalists[0] },
    { juror: 'rae', vote: finalists[1] },
    { juror: 'zoe', vote: finalists[0] },
  ];

  const counts = countJuryVotes(finalists, votes);
  const winner = winnerFromJuryVotes(finalists, votes);

  assert(counts[finalists[0]] === 3, `expected ${finalists[0]} to have 3 votes`);
  assert(counts[finalists[1]] === 1, `expected ${finalists[1]} to have 1 vote`);
  assert(winner === finalists[0], `expected ${finalists[0]} to win, got ${winner}`);
}

const tests = [
  testPlayerEvictionCreatesJuryFinaleContext,
  testNpcFinalTwoVoteCountingDoesNotAssumePlayerFinalist,
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
