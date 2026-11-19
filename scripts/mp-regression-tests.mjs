import { spawn, spawnSync } from 'node:child_process';
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
  await waitTurn(room.host, 'week_ready');
  send(room.host, { type: 'advanceTurn' });
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

// A houseguest whose player is away is played by the AI — including when you
// talk to them. They used to be treated as present: the message was relayed
// to nobody and no reply ever came.
async function testAwayPlayersHouseguestStillAnswers() {
  const { host, rae } = await setupSocialRoom('BB-A');
  send(host, { type: 'chat', targetId: 'rae', text: 'Hi, how are you holding up?' });
  const relayed = await waitFor(host, (m) => m.type === 'chatReply' && m.npcId === 'rae');
  if (relayed.text !== null) throw new Error('a connected human was answered by the AI');
  rae.ws.close();
  await delay(800);
  host.messages.length = 0;
  send(host, { type: 'chat', targetId: 'rae', text: 'Hi, how are you holding up?' });
  const reply = await waitFor(host, (m) => m.type === 'chatReply' && m.npcId === 'rae', 20000);
  closeAll(host);
  if (!reply.text || typeof reply.text !== 'string') throw new Error("an away player's houseguest did not answer");
}

// An offline player's seat is never handed over on request alone: a seated
// player who is online is asked, and declining (or ignoring) leaves it alone.
async function testDisconnectedSeatCannotBeStolen() {
  const { code, host, rae } = await setupStartedRoom('BB-D');
  rae.ws.close();
  await delay(800);
  const attacker = openClient(code, 'Attacker', `attacker_${code}`);
  await waitFor(attacker, (m) => m.type === 'auth');
  await waitFor(attacker, (m) => m.type === 'state');
  send(attacker, { type: 'claimLiveSeat', seatId: 'rae', name: 'StolenRae' });
  const ask = await waitFor(host, (m) => m.type === 'takeoverRequest');
  await delay(300);
  const beforeAnswer = latest(host, 'state')?.state?.seats?.rae?.occupantName === 'StolenRae';
  send(attacker, { type: 'takeoverResponse', reqId: ask.reqId, allow: true }); // approving your own request
  await delay(300);
  const selfApproved = latest(host, 'state')?.state?.seats?.rae?.occupantName === 'StolenRae';
  send(host, { type: 'takeoverResponse', reqId: ask.reqId, allow: false });
  await waitFor(attacker, (m) => m.type === 'takeoverNotice' && /declined/.test(m.text));
  await delay(300);
  const afterDecline = latest(host, 'state')?.state?.seats?.rae?.occupantName === 'StolenRae';
  closeAll(host, attacker);
  if (beforeAnswer) throw new Error('seat handed over before anyone approved');
  if (selfApproved) throw new Error('the requester approved their own takeover');
  if (afterDecline) throw new Error('seat handed over after the request was declined');
}

// The real case: the same person back on another browser. A seated player
// approves and they get their houseguest back, name and all.
async function testApprovedReclaimHandsTheSeatOver() {
  const { code, host, rae } = await setupStartedRoom('BB-K');
  rae.ws.close();
  await delay(800);
  const back = openClient(code, 'RaeAgain', `raeagain_${code}`);
  await waitFor(back, (m) => m.type === 'auth');
  await waitFor(back, (m) => m.type === 'state');
  send(back, { type: 'claimLiveSeat', seatId: 'rae', name: '' });
  const ask = await waitFor(host, (m) => m.type === 'takeoverRequest');
  send(host, { type: 'takeoverResponse', reqId: ask.reqId, allow: true });
  await waitFor(back, (m) => m.type === 'game' && m.game?.myEngineId === 'rae');
  const seat = latest(host, 'state')?.state?.seats?.rae;
  closeAll(host, back);
  if (!seat?.connected) throw new Error('reclaimed seat is not shown as connected');
}

// Alone in the room, there is nobody to ask and nobody to wrong.
async function testLoneReturnerGetsTheirSeatWithoutApproval() {
  const code = makeRoomCode('BB-O');
  const first = openClient(code, 'Solo', `solo_${code}`);
  await waitFor(first, (m) => m.type === 'auth');
  await waitFor(first, (m) => m.type === 'state');
  send(first, { type: 'claimSeat', seatId: 'newcomer' });
  await delay(200);
  send(first, { type: 'startSeason', clientTime: Date.now() });
  await waitTurn(first, 'week_ready');
  first.ws.close();
  await delay(800);
  const again = openClient(code, 'SoloAgain', `soloagain_${code}`);
  await waitFor(again, (m) => m.type === 'auth');
  await waitFor(again, (m) => m.type === 'state');
  send(again, { type: 'claimLiveSeat', seatId: 'newcomer', name: '' });
  const got = await waitFor(again, (m) => m.type === 'game' && m.game?.myEngineId === 'you');
  closeAll(again);
  if (!got) throw new Error('a lone returning player could not get their seat back');
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
  await waitTurn(host, 'week_ready');
  send(host, { type: 'advanceTurn' });
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

// Two humans (the newcomer seat and Rae) played through to the first
// free-roam window, where House Read and huddles are live.
async function setupSocialRoom(prefix) {
  const room = await setupStartedRoom(prefix);
  send(room.host, { type: 'advanceTurn' });
  await waitTurn(room.host, 'comp');
  send(room.host, { type: 'compScore', score: 10 });
  send(room.rae, { type: 'compScore', score: 10 });
  await waitTurn(room.host, 'comp_result');
  send(room.host, { type: 'advanceTurn' });
  await waitTurn(room.host, 'social');
  await waitTurn(room.rae, 'social');
  return room;
}

async function testHouseReadIsPrivateTieredAndBlindToHumans() {
  const { code, host, rae } = await setupSocialRoom('BB-R');
  const spectator = openClient(code, 'Watcher', `watch_${code}`);
  await waitFor(spectator, (m) => m.type === 'game');
  const hostRead = latest(host, 'game')?.game?.houseRead;
  const raeRead = latest(rae, 'game')?.game?.houseRead;
  const watcherGame = latest(spectator, 'game')?.game;
  closeAll(host, rae, spectator);
  if (!hostRead || !raeRead) throw new Error('a seated human got no House Read');
  if (watcherGame?.houseRead) throw new Error('a spectator was sent a House Read');
  if (hostRead.people.some((p) => p.id === 'you')) throw new Error("the host's read includes themselves");
  if (raeRead.people.some((p) => p.id === 'rae')) throw new Error("Rae's read includes herself");
  const raeSeenByHost = hostRead.people.find((p) => p.id === 'rae');
  if (!raeSeenByHost?.read.human || raeSeenByHost.read.trust) throw new Error('a human seat was read out to another player');
  for (const p of hostRead.people) {
    if (p.read.human) continue;
    for (const k of ['trust', 'bond', 'threat']) {
      const lv = p.read[k]?.level;
      if (!Number.isInteger(lv) || lv < 0 || lv > 4) throw new Error(`${p.id} ${k} is not a tier: ${JSON.stringify(p.read[k])}`);
    }
  }
  // Tiers only: no raw relationship numbers anywhere in the projection.
  if (/"(trust|bond|threat)":\s*\d/.test(JSON.stringify(hostRead))) throw new Error('raw relationship numbers leaked into House Read');
}

async function testHuddleIntelGoesOnlyToTheListener() {
  const { host, rae } = await setupSocialRoom('BB-H');
  send(host, { type: 'huddleRequest' });
  const withHuddle = await waitFor(rae, (m) => m.type === 'game' && m.game?.huddle);
  const h = withHuddle.game.huddle;
  if ([h.a, h.b].some((id) => id === 'rae' || id === 'you')) throw new Error('a human seat was put in a huddle');
  if (h.a === h.b) throw new Error('huddle pair is one person');

  send(host, { type: 'huddleHeard', id: h.id });
  const intel = await waitFor(host, (m) => m.type === 'huddleIntel');
  if (!intel.text || /undefined|NaN/.test(intel.text)) throw new Error('bad intel text: ' + intel.text);
  send(host, { type: 'huddleHeard', id: h.id }); // a second claim on the same huddle
  await delay(400);
  const hostIntel = host.messages.filter((m) => m.type === 'huddleIntel').length;
  const raeIntel = rae.messages.filter((m) => m.type === 'huddleIntel').length;
  const hostBook = latest(host, 'game')?.game?.houseRead?.intel || [];
  const raeBook = latest(rae, 'game')?.game?.houseRead?.intel || [];
  if (hostIntel !== 1) throw new Error(`listener received ${hostIntel} intel messages for one huddle`);
  if (raeIntel !== 0) throw new Error('intel was sent to a player who did not listen');
  if (hostBook.length !== 1 || raeBook.length !== 0) throw new Error(`notebooks: host ${hostBook.length}, rae ${raeBook.length}`);

  // Rae gets caught: the huddle ends for everyone, and only she is told.
  send(rae, { type: 'huddleSpotted', id: h.id });
  await waitFor(rae, (m) => m.type === 'huddleSpotted');
  await delay(300);
  const ended = !latest(host, 'game')?.game?.huddle && !latest(rae, 'game')?.game?.huddle;
  const hostTold = host.messages.some((m) => m.type === 'huddleSpotted');
  closeAll(host, rae);
  if (!ended) throw new Error('huddle still live after someone was spotted');
  if (hostTold) throw new Error('the wrong player was told they were spotted');
}

async function testHuddlesOnlyDuringFreeRoam() {
  const { host } = await setupStartedRoom('BB-N'); // still on the week intro card
  send(host, { type: 'huddleRequest' });
  await delay(500);
  const huddle = latest(host, 'game')?.game?.huddle;
  closeAll(host);
  if (huddle) throw new Error('a huddle started outside a free-roam window');
}

async function testNpcPositionsRelayButNeverMoveAHuman() {
  const { host, rae } = await setupSocialRoom('BB-M');
  send(rae, { type: 'npcPos', list: [['marcus', 3.5, -1, 0.5], ['you', 9, 9, 0], ['gus', 'x', 1, 0], ['zoe', 1, 2, 3]], h: { a: 'marcus', b: 'zoe', x: 1, z: 2, ready: true } });
  const batch = await waitFor(host, (m) => m.type === 'npcPos');
  send(host, { type: 'npcHold', id: 'marcus', on: true });
  const hold = await waitFor(rae, (m) => m.type === 'npcHold');
  await delay(200);
  const echoed = rae.messages.some((m) => m.type === 'npcPos');
  closeAll(host, rae);
  const ids = batch.list.map((r) => r[0]);
  if (!ids.includes('marcus') || !ids.includes('zoe')) throw new Error('AI positions were not relayed: ' + ids);
  if (ids.includes('you')) throw new Error("a batch was allowed to move another human's houseguest");
  if (ids.includes('gus')) throw new Error('a malformed row was relayed');
  if (!batch.h || batch.h.a !== 'marcus' || !batch.h.ready) throw new Error('huddle spot was not relayed');
  if (hold.id !== 'marcus' || hold.on !== true) throw new Error('conversation hold was not relayed');
  if (echoed) throw new Error('the sender got its own batch back');
}

async function testLeavingAHumanChatTellsOnlyTheOtherPerson() {
  const { code, host, rae } = await setupSocialRoom('BB-Q');
  const watcher = openClient(code, 'Watcher', `watch_${code}`);
  await waitFor(watcher, (m) => m.type === 'game');
  send(host, { type: 'chatPresence', targetId: 'rae', open: true });
  const opened = await waitFor(rae, (m) => m.type === 'chatPresence' && m.open === true);
  send(host, { type: 'chatPresence', targetId: 'rae', open: false });
  const left = await waitFor(rae, (m) => m.type === 'chatPresence' && m.open === false);
  send(host, { type: 'chatPresence', targetId: 'marcus', open: false }); // an AI seat: nobody to tell
  await delay(300);
  const hostEcho = host.messages.some((m) => m.type === 'chatPresence');
  const watcherSaw = watcher.messages.some((m) => m.type === 'chatPresence');
  const count = rae.messages.filter((m) => m.type === 'chatPresence').length;
  closeAll(host, rae, watcher);
  if (opened.from !== 'you' || left.from !== 'you' || !left.fromName) throw new Error('presence did not name who left');
  if (hostEcho) throw new Error('the person leaving was told about themselves');
  if (watcherSaw) throw new Error('a third party was told about a private conversation');
  if (count !== 2) throw new Error(`expected 2 presence messages, got ${count}`);
}

async function testOverhearingIsRolledByTheServerAndNeverByAHuman() {
  const { host, rae } = await setupSocialRoom('BB-O');
  const raeName = latest(host, 'game').game.houseguests.find((h) => h.id === 'rae').name;
  // Everyone at arm's length: five AI houseguests at 85% each, and one person.
  send(host, { type: 'chat', targetId: 'marcus', text: 'I want Tessa out this week.', listeners: [['tessa', 0], ['zoe', 0], ['gus', 0], ['bev', 0], ['nash', 0], ['rae', 0], ['nobody', 0], ['flynn', 99]] });
  const reply = await waitFor(host, (m) => m.type === 'chatReply' && m.npcId === 'marcus', 15000);
  send(host, { type: 'chat', targetId: 'marcus', text: 'Just checking in.' }); // an older client sends no listeners
  await delay(200);
  const second = await waitFor(host, (m) => m.type === 'chatReply' && m.npcId === 'marcus' && m !== reply, 15000);
  const leaked = rae.messages.some((m) => m.type === 'chatReply');
  closeAll(host, rae);
  if (!Array.isArray(reply.overheard) || !reply.overheard.length) throw new Error('nobody overheard a conversation held in a crowd');
  if (reply.overheard.includes(raeName)) throw new Error('a houseguest played by a person was said to overhear');
  if (reply.overheard.some((n) => /flynn/i.test(n))) throw new Error('someone out of earshot overheard');
  if (!Array.isArray(second.overheard) || second.overheard.length) throw new Error('a chat with nobody near was overheard');
  if (leaked) throw new Error("another player received someone else's private reply");
}

async function testTakingAHouseguestAsideMovesThemOnEveryScreen() {
  const { host, rae } = await setupSocialRoom('BB-V');
  send(host, { type: 'goPrivate', targetId: 'marcus', x: 2.5, z: -1.5, witnesses: ['zoe', 'rae'] });
  const lead = await waitFor(rae, (m) => m.type === 'npcLead');
  send(host, { type: 'goPrivate', targetId: 'rae', x: 1, z: 1, witnesses: [] }); // a person cannot be led
  send(host, { type: 'goPrivate', targetId: 'marcus', x: 'x', z: 1, witnesses: [] });
  await delay(300);
  const leads = rae.messages.filter((m) => m.type === 'npcLead').length;
  const echoed = host.messages.some((m) => m.type === 'npcLead');
  closeAll(host, rae);
  if (lead.id !== 'marcus' || lead.x !== 2.5 || lead.z !== -1.5) throw new Error('the walk was not relayed as sent');
  if (leads !== 1) throw new Error(`expected one relayed walk, got ${leads}`);
  if (echoed) throw new Error('the player who asked got their own walk back');
}

async function testExportIsThePlayersOwnRecord() {
  const { host, rae } = await setupSocialRoom('BB-X');
  send(host, { type: 'chat', targetId: 'marcus', text: 'Pineapple is my secret word.' });
  await waitFor(host, (m) => m.type === 'chatReply' && m.npcId === 'marcus', 15000);
  send(host, { type: 'exportRecord' });
  send(rae, { type: 'exportRecord' });
  const mine = await waitFor(host, (m) => m.type === 'exportRecord');
  const theirs = await waitFor(rae, (m) => m.type === 'exportRecord');
  closeAll(host, rae);
  if (!/BB JURY HOUSE/.test(mine.text) || !/online game/.test(mine.text)) throw new Error('not a season record');
  if (!mine.text.includes('Pineapple is my secret word.')) throw new Error("the player's own conversation is missing");
  if (theirs.text.includes('Pineapple')) throw new Error("another player's conversation was exported");
  if (mine.full !== false || !/Exported mid-season/.test(mine.text)) throw new Error('a mid-season export was not marked as partial');
  for (const hidden of ['loyalty ', 'toward you at export', 'RAW SAVE (JSON)\n=', '"social"']) {
    if (mine.text.includes(hidden)) throw new Error('a mid-season export gave away hidden state: ' + hidden);
  }
  if (!mine.filename || !/\.txt$/.test(mine.filename)) throw new Error('no filename');
}

// The picker is weighted chance, so an approach may not come in the time a
// test can wait. When one does, the whole exchange is checked; when none
// does, that is reported rather than passed off as coverage.
async function testAnApproachSummonsOnEveryScreenAndOpensWithTheirLine() {
  const { host, rae } = await setupSocialRoom('BB-K');
  let ap = null;
  for (let i = 0; i < 4 && !ap; i++) {
    send(host, { type: 'approachRequest' });
    await delay(600);
    ap = host.messages.find((m) => m.type === 'approach');
    if (!ap && i < 3) await delay(12100);
  }
  if (!ap) { closeAll(host, rae); console.log('  (no approach was rolled in four tries; exchange not exercised this run)'); return; }
  const seenByOther = await waitFor(rae, (m) => m.type === 'npcSummon' && m.on === true);
  const askedTwice = host.messages.filter((m) => m.type === 'approach').length;
  send(host, { type: 'approachAnswer', id: ap.id, accept: true });
  const opener = await waitFor(host, (m) => m.type === 'approachOpener', 15000);
  const released = await waitFor(rae, (m) => m.type === 'npcSummon' && m.on === false);
  const leaked = rae.messages.some((m) => m.type === 'approach' || m.type === 'approachOpener');
  closeAll(host, rae);
  if (ap.npcId === 'rae') throw new Error('a houseguest played by a person was sent to approach');
  if (seenByOther.id !== ap.npcId || seenByOther.to !== 'you') throw new Error('the other screen was not told who is walking to whom');
  if (askedTwice !== 1) throw new Error('more than one approach at a time');
  if (opener.npcId !== ap.npcId || !opener.text) throw new Error('no opening line');
  if (released.id !== ap.npcId) throw new Error('the houseguest was not released');
  if (leaked) throw new Error("another player was sent someone else's approach");
}

const tests = [
  testOverhearingIsRolledByTheServerAndNeverByAHuman,
  testTakingAHouseguestAsideMovesThemOnEveryScreen,
  testExportIsThePlayersOwnRecord,
  testAnApproachSummonsOnEveryScreenAndOpensWithTheirLine,
  testLeavingAHumanChatTellsOnlyTheOtherPerson,
  testNpcPositionsRelayButNeverMoveAHuman,
  testHouseReadIsPrivateTieredAndBlindToHumans,
  testHuddleIntelGoesOnlyToTheListener,
  testHuddlesOnlyDuringFreeRoam,
  testNoPrivateIdsInState,
  testNoPrivateIdsInGame,
  testSpoofedPidCannotReleaseSeat,
  testSpoofedHostCannotEndSession,
  testAwayPlayersHouseguestStillAnswers,
  testDisconnectedSeatCannotBeStolen,
  testApprovedReclaimHandsTheSeatOver,
  testLoneReturnerGetsTheirSeatWithoutApproval,
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
  process.exitCode = failed.length ? 1 : 0; // not process.exit(): the finally below must stop the worker
} finally {
  // On Windows the worker runs under cmd.exe; killing that leaves wrangler and
  // workerd running, and a few test runs used up the machine's memory.
  if (worker) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(worker.pid), '/T', '/F'], { stdio: 'ignore' });
      // npx starts wrangler through a shell that exits, so the tree is broken:
      // stop every node/workerd for this test port, and their children.
      const ps = "$all = Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='workerd.exe'\"; " +
        "$hit = @($all | Where-Object { $_.CommandLine -like '*wrangler*' -and $_.CommandLine -like '*8787*' } | ForEach-Object { $_.ProcessId }); " +
        "$kids = @($all | Where-Object { $hit -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId }); " +
        "($hit + $kids) | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }";
      spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
    }
    else worker.kill();
  }
  // Open test sockets would keep the process alive; the worker is stopped now.
  process.exit(process.exitCode ?? 0);
}
