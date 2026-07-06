import { spawn } from 'node:child_process';
import PartySocket from 'partysocket';

const HOST = '127.0.0.1:8787';
const BASE_URL = `http://${HOST}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRoomCode(prefix = 'BB-T') {
  return prefix + Math.random().toString(36).slice(2, 6).toUpperCase();
}

async function waitForWorker() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(500) });
      if (res.status >= 200) return;
    } catch {}
    await delay(250);
  }
  throw new Error('local worker did not become ready');
}

function startWorker() {
  if (process.platform === 'win32') {
    return spawn(
      'cmd.exe',
      ['/d', '/s', '/c', 'npx wrangler dev --ip 127.0.0.1 --port 8787 --local --log-level error'],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }
  return spawn('npx', ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', '8787', '--local', '--log-level', 'error'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function openClient(code, label, pid, token = null) {
  const ws = new PartySocket({ host: HOST, party: 'room', room: code });
  const messages = [];
  const client = { code, label, pid, token, ws, messages, closed: false };
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', playerId: pid, token, name: label }));
  });
  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      messages.push(msg);
      if (msg.type === 'auth') client.token = msg.token;
    } catch {}
  });
  ws.addEventListener('close', () => {
    client.closed = true;
  });
  return client;
}

async function waitFor(client, predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = client.messages.find(predicate);
    if (hit) return hit;
    await delay(50);
  }
  throw new Error(`timeout waiting for ${client.label}`);
}

function send(client, msg) {
  try {
    client.ws.send(JSON.stringify(msg));
  } catch {}
}

function latest(client, type) {
  for (let i = client.messages.length - 1; i >= 0; i--) {
    if (client.messages[i].type === type) return client.messages[i];
  }
  return null;
}

function closeAll(...clients) {
  for (const client of clients) {
    try {
      client.ws.close();
    } catch {}
  }
}

async function waitTurn(client, kind) {
  return (await waitFor(client, (m) => m.type === 'game' && m.game?.turn?.kind === kind)).game.turn;
}

async function setupLobbyWithTwoHumans(prefix = 'BB-L') {
  const code = makeRoomCode(prefix);
  const host = openClient(code, 'HostYou', `host_${code}`);
  await waitFor(host, (m) => m.type === 'auth');
  await waitFor(host, (m) => m.type === 'state');
  send(host, { type: 'claimSeat', seatId: 'newcomer' });
  await delay(200);

  const rae = openClient(code, 'HumanRae', `rae_${code}`);
  await waitFor(rae, (m) => m.type === 'auth');
  await waitFor(rae, (m) => m.type === 'state');
  send(rae, { type: 'claimSeat', seatId: 'rae' });
  await delay(300);
  return { code, host, rae };
}

async function setupStartedRoom(prefix = 'BB-S') {
  const room = await setupLobbyWithTwoHumans(prefix);
  send(room.host, { type: 'startSeason', clientTime: Date.now() });
  await waitTurn(room.host, 'intro');
  return room;
}

async function testNoPrivateIdsInState() {
  const { host, rae } = await setupLobbyWithTwoHumans('BB-P');
  const hostState = latest(host, 'state')?.state;
  const raeState = latest(rae, 'state')?.state;
  const leakedToHost = JSON.stringify(hostState).includes(rae.pid);
  const leakedToRae = JSON.stringify(raeState).includes(host.pid);
  closeAll(host, rae);
  if (leakedToHost || leakedToRae) {
    throw new Error('state projection leaks peer player ids');
  }
}

async function testNoPrivateIdsInGame() {
  const { host, rae } = await setupStartedRoom('BB-G');
  const hostGame = latest(host, 'game')?.game;
  const raeGame = latest(rae, 'game')?.game;
  const leakedToHost = JSON.stringify(hostGame).includes(rae.pid);
  const leakedToRae = JSON.stringify(raeGame).includes(host.pid);
  closeAll(host, rae);
  if (leakedToHost || leakedToRae) {
    throw new Error('game projection leaks peer player ids');
  }
}

async function testSpoofedPidCannotReleaseSeat() {
  const { code, host, rae } = await setupLobbyWithTwoHumans('BB-R');
  const attacker = openClient(code, 'Attacker', rae.pid);
  await delay(700);
  send(attacker, { type: 'releaseSeat' });
  await delay(500);
  const raeState = latest(rae, 'state')?.state;
  const raeSeat = raeState?.seats?.rae;
  closeAll(host, rae, attacker);
  if (!raeSeat?.mine || !raeSeat?.occupied) {
    throw new Error('spoofed player id released another player seat');
  }
}

async function testSpoofedHostCannotEndSession() {
  const { code, host, rae } = await setupLobbyWithTwoHumans('BB-H');
  const attacker = openClient(code, 'SpoofedHost', host.pid);
  await delay(700);
  send(attacker, { type: 'endSession' });
  await delay(500);
  const killed = !!host.messages.find((m) => m.type === 'roomClosed') || host.closed;
  closeAll(host, rae, attacker);
  if (killed) throw new Error('spoofed host id ended the room');
}

async function testDisconnectedSeatCannotBeStolen() {
  const { code, host, rae } = await setupStartedRoom('BB-D');
  rae.ws.close();
  await delay(800);
  const attacker = openClient(code, 'Attacker', `attacker_${code}`);
  await waitFor(attacker, (m) => m.type === 'auth');
  await waitFor(attacker, (m) => m.type === 'state');
  send(attacker, { type: 'claimLiveSeat', seatId: 'rae', name: 'StolenRae' });
  await delay(500);
  const hostState = latest(host, 'state')?.state;
  const stolen = hostState?.seats?.rae?.occupantName === 'StolenRae';
  closeAll(host, attacker);
  if (stolen) throw new Error('disconnected human seat was stolen');
}

async function testLegitimateReconnectRestoresSeat() {
  const { code, host, rae } = await setupStartedRoom('BB-Q');
  const token = rae.token;
  if (!token) throw new Error('server did not issue auth token');
  rae.ws.close();
  await delay(800);
  const rejoined = openClient(code, 'HumanRae', rae.pid, token);
  await waitFor(rejoined, (m) => m.type === 'auth');
  await waitFor(rejoined, (m) => m.type === 'game' && m.game?.myEngineId === 'rae');
  const state = latest(rejoined, 'state')?.state;
  closeAll(host, rejoined);
  if (state?.mySeatId !== 'rae') throw new Error('legitimate reconnect did not restore seat');
}

async function testLateCompTakeoverGetsNotice() {
  const code = makeRoomCode('BB-C');
  const host = openClient(code, 'HostOnly', `host_${code}`);
  await waitFor(host, (m) => m.type === 'auth');
  await waitFor(host, (m) => m.type === 'state');
  send(host, { type: 'claimSeat', seatId: 'newcomer' });
  await delay(200);
  send(host, { type: 'startSeason', clientTime: Date.now() });
  await waitTurn(host, 'intro');
  send(host, { type: 'advanceTurn' });
  const comp = await waitTurn(host, 'comp');
  if (comp.scores?.rae == null) throw new Error('AI did not pre-score Rae');

  const late = openClient(code, 'LateJoiner', `late_${code}`);
  await waitFor(late, (m) => m.type === 'auth');
  await waitFor(late, (m) => m.type === 'state');
  send(late, { type: 'claimLiveSeat', seatId: 'rae', name: 'LateRae' });
  const notice = await waitFor(late, (m) => m.type === 'takeoverNotice');
  const game = latest(late, 'game')?.game;
  closeAll(host, late);
  if (!notice.text.includes('AI already played this competition')) {
    throw new Error('late comp takeover did not explain inherited AI score');
  }
  if (game?.turn?.waitingOn?.includes(late.pid)) {
    throw new Error('late comp takeover unexpectedly added player to waitingOn');
  }
}

async function testApiChatRejectsUnauthenticatedOriginlessPost() {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system: 'x', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 }),
  });
  if (res.status !== 403) throw new Error(`originless api chat returned ${res.status}, expected 403`);
}

async function testApiChatAllowsConfiguredOriginsToReachKeyCheck() {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
    body: JSON.stringify({ system: 'x', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 }),
  });
  if (res.status !== 503) throw new Error(`allowed-origin api chat returned ${res.status}, expected 503 without local key`);
}

const tests = [
  testNoPrivateIdsInState,
  testNoPrivateIdsInGame,
  testSpoofedPidCannotReleaseSeat,
  testSpoofedHostCannotEndSession,
  testDisconnectedSeatCannotBeStolen,
  testLegitimateReconnectRestoresSeat,
  testLateCompTakeoverGetsNotice,
  testApiChatRejectsUnauthenticatedOriginlessPost,
  testApiChatAllowsConfiguredOriginsToReachKeyCheck,
];

let worker = null;
try {
  if (!process.env.MP_TEST_EXTERNAL_WORKER) worker = startWorker();
  await waitForWorker();
  const results = [];
  for (const test of tests) {
    console.log(`RUN ${test.name}`);
    try {
      await test();
      results.push({ name: test.name, ok: true });
      console.log(`PASS ${test.name}`);
    } catch (error) {
      results.push({ name: test.name, ok: false, error: error.message });
      console.log(`FAIL ${test.name}: ${error.message}`);
    }
  }
  console.log(JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  process.exit(failed.length ? 1 : 0);
} finally {
  if (worker) worker.kill();
}
