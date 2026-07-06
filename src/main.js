// Director: boots the world, runs the season, wires UI <-> engine <-> AI.

import { createScene } from './world/scene.js';
import { WorldController } from './world/movement.js';
import { createCharacter } from './world/characters.js';
import { PLAYER_ID } from './game/cast.js';
import {
  newGame, loadGame, saveGame, clearSave,
  activeIds, activeNpcIds, nameOf, logEvent,
} from './game/state.js';
import {
  resolveComp, decideNominations, applyNominations, vetoPlayers,
  decideVetoUse, decideReplacement, applyVeto, applyVetoSave, applyReplacement,
  resolveEviction, applyEviction, nextPhase, evictionDesire, phaseLabel,
} from './game/season.js';
import { chooseApproacher, APPROACH_REASON_TEXT, allianceWillingness, formOfficialAlliance, leaveAlliance } from './game/social.js';
import { randomCompType, COMP_NAMES, runComp } from './game/comps.js';
import {
  npcChat, diaryChat, npcSpeech, jurorQuestion, opponentJuryAnswer, jurorVote, npcOpener,
  groupChat, postGameAnalysis,
} from './ai/dialogue.js';
import { onAiStatusChange, setAiStatus } from './ai/status.js';
import {
  el, renderHud, showToast, clearToast, openChatPanel, closeChatPanel,
  cinematic, cinematicWait, pickHouseguests, cinematicTextInput, confetti, titleScreen,
  openLiveGroupPanel,
} from './ui/ui.js';
import { setMood, sting, setMusicEnabled, stopMusic } from './audio/music.js';
import { speak, stopSpeaking, isVoiceOn, setVoiceOn, voiceSupported } from './audio/voice.js';
import { buildSeasonStats, archiveSeason, loadArchivedSeason, showStatsPage } from './ui/stats.js';

// ---------- AI status indicator (tiny, unobtrusive) ----------
// A small dot fixed outside the HUD so frequent HUD rebuilds never wipe it.
const aiDot = document.createElement('div');
aiDot.id = 'ai-status-dot';
aiDot.title = 'Waiting for the first AI reply…';
document.body.append(aiDot);
onAiStatusChange((status) => {
  aiDot.classList.toggle('ai-on', status === 'ai');
  aiDot.classList.toggle('ai-off', status === 'offline');
  aiDot.title = status === 'ai' ? 'Claude AI active' : status === 'offline' ? 'Offline mode (built-in dialogue engine)' : 'Waiting for the first AI reply…';
});

// ---------- Boot ----------

const canvas = document.getElementById('scene');
const overlayRoot = document.getElementById('overlay-root');
const { renderer, scene, camera, resize, updateFx } = createScene(canvas);
const world = new WorldController(scene, camera, canvas);

let g = null; // game state
let busy = false; // an overlay/ceremony is running
let approachTimer = null;

function showTitle() {
  titleScreen({
    hasSave: !!loadGame(),
    archivedStats: loadArchivedSeason(),
    onShowStats: () => showStatsPage(loadArchivedSeason()),
    onNew: (name) => {
      clearSave();
      g = newGame(name);
      startWorld();
      weekIntro();
    },
    onContinue: () => {
      g = loadGame();
      startWorld();
      refresh();
      setMoodForPhase();
    },
    onOnline: () => openMultiplayer(),
  });
}
showTitle();

// ---------- Multiplayer ----------
let room = null;
let onlineGame = null; // authoritative game snapshot from the server
let onlineMode = false;

// Which engine houseguest id does THIS player control?
function myEngineId() {
  const hs = onlineGame?.humanSeats || {};
  for (const [engineId, pid] of Object.entries(hs)) {
    if (pid === room?.playerId) return engineId;
  }
  return null;
}

// Phase 2 Step 1: enter the shared house rendered from the server's game state.
// The season loop (comps, ceremonies, chat) is wired in later steps.
let onlineSeasonStarted = false;
function startOnlineSeason(game) {
  if (onlineSeasonStarted) { onlineGame = game; return; } // one-time world bootstrap only
  onlineSeasonStarted = true;
  onlineGame = game;
  onlineMode = true;
  const meId = myEngineId();
  const active = game.houseguests.filter((h) => !game.evicted.includes(h.id));

  // Build the world from the server roster. No seat (meId is null) means
  // this connection is a spectator: everyone renders as an NPC, no avatar of
  // our own, and the camera auto-orbits (see WorldController.update()).
  const me = meId ? active.find((h) => h.id === meId) : null;
  if (me) {
    const player = createCharacter(me);
    scene.add(player);
    world.setPlayer(player);
  }
  const rooms = ['living', 'kitchen', 'bedroom', 'backyard'];
  let i = 0;
  for (const hg of active) {
    if (me && hg.id === me.id) continue;
    world.addNpc(createCharacter(hg), rooms[i++ % rooms.length]);
  }
  world.onNpcClick = me ? (id) => openOnlineChat(id) : () => {};
  animate();
  renderOnlineHud();
  // Drive the interactive season from server turn broadcasts.
  room.onGame = (g) => handleOnlineTurn(g);
  // Incoming message from another human houseguest.
  room.onChatMsg = (from, fromName, text) => {
    showToast(`💬 <b>${fromName}</b>: "${text.slice(0, 80)}"`, [
      { label: 'Reply', style: 'gold', onClick: () => openOnlineChat(from) },
      { label: 'Later', style: '', onClick: () => {} },
    ]);
  };
  wireOnlineSocialHandlers();
  wireReconnectHandling();
  // Live position updates from other connected humans.
  room.onPos = (id, x, z, rotY) => world.setNetTarget(id, x, z, rotY);
  // The server reports whether each reply was actually AI-generated or the
  // offline fallback — feeds the same tiny indicator single-player uses.
  room.onAiStatus = (usedAi) => setAiStatus(usedAi);
  handleOnlineTurn(game);
}

// Online 1-on-1 conversation with a houseguest (AI via server Claude/engine,
// or another human via relay).
function openOnlineChat(targetId) {
  if (onlineOverlay || compRunning) return; // don't interrupt a ceremony/comp
  const hg = onlineGame.houseguests.find((h) => h.id === targetId);
  if (!hg || onlineGame.evicted.includes(targetId)) return;
  const isHuman = !!(onlineGame.humanSeats && onlineGame.humanSeats[targetId]);
  world.freezeNpc(targetId, true);
  world.focusOn(targetId);
  const panel = openChatPanel({
    title: hg.name,
    subtitle: `${hg.job}${isHuman ? ' · 🧑 human' : ' · 🤖 AI'}${onlineGame.hoh === targetId ? ' · HoH 👑' : ''}${onlineGame.nominees?.includes(targetId) ? ' · Nominated 🎯' : ''}`,
    color: hg.color,
    voice: { key: targetId, gender: hg.gender },
    thread: [],
    onSend: async (text) => {
      const { text: reply, note } = await room.sendChat(targetId, text);
      if (note) panel.addSystemMsg(note);
      return reply;
    },
    onClose: () => { world.freezeNpc(targetId, false); world.clearFocus(); },
  });
}

// ---- Online social tools (group chat, house meeting, alliances, diary) ----

let activeGroupId = null;
let groupPanel = null;

function wireOnlineSocialHandlers() {
  room.onGroupStart = (payload) => {
    activeGroupId = payload.groupId;
    const others = payload.members.filter((m) => m !== myEngineId());
    groupPanel = openLiveGroupPanel({
      title: payload.isHouseMeeting ? '📢 House Meeting' : `Group: ${payload.memberNames.filter((n, i) => payload.members[i] !== myEngineId()).join(', ')}`,
      subtitle: payload.isHouseMeeting ? 'Everyone. Everything on the record.' : 'All hear everything · /whisper <name> ... for a private aside',
      color: payload.isHouseMeeting ? 0xf5c542 : 0x7c5cff,
      onSend: (text) => room.sendGroupMsg(activeGroupId, text),
      onClose: () => { activeGroupId = null; groupPanel = null; },
    });
    if (payload.founder !== myEngineId()) {
      groupPanel.addSystemMsg(payload.isHouseMeeting ? `${payload.founderName} calls a house meeting.` : `${payload.founderName} pulls you and ${others.length > 1 ? 'others' : 'someone else'} aside.`);
    }
  };
  room.onGroupMsg = (groupId, id, name, text) => {
    if (groupId !== activeGroupId || !groupPanel) return;
    groupPanel.addLine(name, text, id === myEngineId());
  };
  room.onGroupSystem = (groupId, text) => {
    if ((groupId && groupId !== activeGroupId) || !groupPanel) return;
    groupPanel.addSystemMsg(text);
  };
  room.onGroupWhisper = (from, fromName, text) => {
    showToast(`🤫 <b>${fromName}</b> whispers: "${text.slice(0, 100)}"`);
  };
  room.onAllianceResult = (msg) => {
    let bodyHtml = '';
    if (msg.accepted.length) {
      bodyHtml += `<p>✅ In: <b>${msg.accepted.map((a) => a.name).join(', ')}</b></p>`;
      bodyHtml += msg.alliance
        ? (msg.alliance.existed ? `<p class="muted">You already had this exact group — deepened, not duplicated.</p>` : `<p><b>"${msg.alliance.name}"</b> is official.</p>`)
        : '';
    }
    for (const d of msg.declined) bodyHtml += `<p>❌ <b>${d.name}</b> passed — ${d.reason}.</p>`;
    if (!msg.accepted.length) bodyHtml += `<p class="muted">Nobody committed. Build more trust first.</p>`;
    cinematicWait({ kicker: 'Alliance Invites', title: msg.accepted.length ? 'The word comes back...' : 'Crickets.', bodyHtml, continueLabel: 'OK' });
  };
  room.onAllianceLeft = (msg) => {
    cinematicWait({
      kicker: 'Alliance Dissolved', title: `You left "${msg.name}".`,
      bodyHtml: `<p class="muted">${msg.collapsed ? 'With you gone, the alliance collapsed entirely.' : `${msg.others.join(', ')} will remember this.`}</p>`,
      continueLabel: 'OK',
    });
  };
}

function groupChatFlowOnline(presetIds = null) {
  if (onlineOverlay || compRunning || activeGroupId) return;
  const myEngine = myEngineId();
  if (presetIds) {
    if (presetIds.length < 1) return;
    room.startGroup(presetIds, true);
    return;
  }
  pickHouseguests(onlineRenderGame(onlineGame), {
    kicker: 'Group Conversation', title: 'Pull some people aside',
    bodyHtml: `<p class="muted">Everything said here is heard — and remembered — by everyone present.</p>`,
    ids: onlineActiveIds(onlineGame).filter((id) => id !== myEngine),
    count: { min: 2, max: 4 }, confirmLabel: 'Gather Them', cancelable: true,
  }).then((picked) => { if (picked && picked.length >= 2) room.startGroup(picked, false); });
}

function formAllianceFlowOnline() {
  if (onlineOverlay || compRunning) return;
  const myEngine = myEngineId();
  pickHouseguests(onlineRenderGame(onlineGame), {
    kicker: 'Form an Alliance', title: 'Who do you want in?',
    bodyHtml: `<p class="muted">Each invitee decides for themselves.</p>`,
    ids: onlineActiveIds(onlineGame).filter((id) => id !== myEngine),
    count: { min: 1, max: 3 }, confirmLabel: 'Send the Invites', cancelable: true,
  }).then(async (picked) => {
    if (!picked || !picked.length) return;
    const name = await cinematicTextInput({
      kicker: 'Form an Alliance', title: 'Name it', quote: 'Every real alliance has a name.',
      placeholder: 'e.g. The Blindside Brigade', submitLabel: 'Lock It In',
    });
    room.formAlliance(picked, name);
  });
}

function leaveAllianceFlowOnline(allianceId) {
  if (onlineOverlay || compRunning) return;
  const c = cinematic({ kicker: 'Leave Alliance', title: 'Walk out?', bodyHtml: `<p class="muted">Quitting is a soft betrayal — they'll lose trust and hold a grudge.</p>` });
  c.setActions([
    { label: 'Walk Away', style: 'danger', onClick: () => { c.close(); room.leaveAllianceOnline(allianceId); } },
    { label: 'Stay', style: 'primary', onClick: () => c.close() },
  ]);
}

// ---- Reconnection UX ----------------------------------------------------
// Only an UNEXPECTED close (network drop) triggers this — an intentional
// Leave/disconnect (winner screen, "Leave Room") skips reconnecting.

let reconnectOverlay = null;
let reconnectAttempts = 0;

function wireReconnectHandling() {
  room.onClose = (wasUnexpected) => {
    if (wasUnexpected) showReconnecting();
  };
  room.onOpen = () => {
    if (reconnectOverlay) { reconnectOverlay.close(); reconnectOverlay = null; }
    reconnectAttempts = 0;
  };
}

function showReconnecting() {
  if (reconnectOverlay) return;
  reconnectOverlay = cinematic({
    kicker: 'Connection Lost', title: 'Reconnecting…',
    bodyHtml: `<p class="muted">The AI is covering your seat while you're disconnected. Trying to get you back in...</p>`,
  });
  reconnectOverlay.setActions([{ label: '🚪 Give Up & Leave', style: '', onClick: () => location.reload() }]);
  attemptReconnect();
}

function attemptReconnect() {
  reconnectAttempts++;
  try { room.reconnect(); } catch {}
  setTimeout(() => {
    if (!reconnectOverlay) return; // already reconnected
    if (room.socket && room.socket.readyState === 1) return; // open — onOpen will clear it
    if (reconnectAttempts < 30) attemptReconnect();
    else if (reconnectOverlay) {
      reconnectOverlay.setActions([{ label: 'Back to Title', style: 'gold', onClick: () => location.reload() }]);
    }
  }, 3000);
}

function openDiaryOnline() {
  if (onlineOverlay || compRunning) return;
  openChatPanel({
    title: 'Diary Room', subtitle: 'Private. Nothing said here leaves this room.',
    color: 0xb04a4a, isDiary: true, thread: [],
    onSend: async (text) => room.sendDiary(text),
  });
}

// A spectator (joined after the season started) can take over any still-active
// houseguest nobody has claimed — AI covered them until now.
function takeOverFlowOnline(eligibleIds) {
  if (onlineOverlay || compRunning) return;
  pickHouseguests(onlineRenderGame(onlineGame), {
    kicker: 'Take Over', title: 'Choose a houseguest to play as',
    bodyHtml: `<p class="muted">AI has been playing them so far — you take over from here.</p>`,
    ids: eligibleIds, count: 1, confirmLabel: 'Take Over', cancelable: true,
  }).then(async (picked) => {
    if (!picked || !picked.length) return;
    const id = picked[0];
    const currentName = onlineGame.houseguests.find((h) => h.id === id)?.name || '';
    const typed = await cinematicTextInput({
      kicker: 'Take Over', title: 'Name your houseguest (or leave blank to keep it as-is)',
      placeholder: currentName, submitLabel: 'Confirm',
    });
    const name = typed === '(no answer)' ? currentName : typed;
    room.claimLiveSeat(id === PLAYER_ID ? 'newcomer' : id, name);
  });
}

// Once a spectator's claim goes through, myEngineId() resolves for the first
// time — swap the free-orbit spectator camera for a real controllable avatar.
function maybeUpgradeSpectator(game) {
  if (!onlineMode || world.player) return; // already have an avatar
  const meId = myEngineId();
  if (!meId) return; // still a spectator
  const hg = game.houseguests.find((h) => h.id === meId);
  if (!hg) return;
  if (world.npcs.has(meId)) world.removeNpc(meId); // was AI-driven as an NPC until now
  const player = createCharacter(hg);
  scene.add(player);
  world.setPlayer(player);
  world.onNpcClick = (id) => openOnlineChat(id);
  showToast(`🎮 You're now playing ${hg.name}!`);
}

// ---- Online turn renderer -------------------------------------------------
// Reacts to the server's authoritative `game.turn`, showing the right UI for
// THIS player (act if it's your move; watch otherwise) and sending actions.

let onlineOverlay = null;
let lastTurnSig = null;
let compRunning = false;

function closeOnlineOverlay() {
  if (onlineOverlay) { onlineOverlay.close(); onlineOverlay = null; }
  // Also clear any stale picker/cinematic modals (e.g. if the turn advanced
  // underneath us via a timer or host skip). Comps use .comp-box, not .cinematic.
  if (!compRunning) document.querySelectorAll('.cinematic').forEach((e) => e.remove());
}

function iAmHost() {
  return onlineGame && room && onlineGame.humanSeats && room.isHost && room.isHost();
}

let turnTimerInterval = null;
function updateTurnTimer(deadline) {
  if (turnTimerInterval) { clearInterval(turnTimerInterval); turnTimerInterval = null; }
  if (!deadline) return;
  const tick = () => {
    const timerEl = document.getElementById('online-timer');
    if (!timerEl) { clearInterval(turnTimerInterval); turnTimerInterval = null; return; }
    const remain = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    const mm = Math.floor(remain / 60), ss = remain % 60;
    timerEl.textContent = `⏱ ${mm}:${String(ss).padStart(2, '0')}`;
    timerEl.classList.toggle('urgent', remain <= 30);
    if (remain <= 0) { clearInterval(turnTimerInterval); turnTimerInterval = null; }
  };
  tick();
  turnTimerInterval = setInterval(tick, 1000);
}

function syncOnlineWorld(game) {
  // Remove evicted houseguests from the 3D house.
  for (const id of game.evicted) {
    if (world.npcs.has(id)) world.removeNpc(id);
  }
  // HUD: week / phase / who's HoH & nominated.
  const meId = myEngineId();
  const me = game.houseguests.find((h) => h.id === meId);
  const h = document.getElementById('hud');
  h.innerHTML = '';
  const top = el('div', 'hud-top');
  top.append(el('div', 'week', `Week ${game.week} — Online`));
  top.append(el('div', 'phase', phaseLabelOnline(game)));
  if (game.turn?.turnDeadline) {
    const timerEl = el('div', 'hud-timer', '');
    timerEl.id = 'online-timer';
    top.append(timerEl);
  }
  updateTurnTimer(game.turn?.turnDeadline || null);
  const bits = [];
  if (game.hoh) bits.push(`HoH: ${nm(game, game.hoh)}`);
  if (game.vetoHolder) bits.push(`Veto: ${nm(game, game.vetoHolder)}`);
  top.append(el('div', 'sub', `You are ${me ? me.name : '—'}${bits.length ? ' · ' + bits.join(' · ') : ''}`));
  h.append(top);
  const st = el('div', 'hud-status');
  if (game.nominees && game.nominees.length) {
    st.append(el('div', 'hud-line', `<span class="nom">On the block:</span> ${game.nominees.map((n) => nm(game, n)).join(' & ')}`));
  }
  if (game.jury && game.jury.length) {
    st.append(el('div', 'hud-line', `<b>Jury (${game.jury.length}):</b> ${game.jury.map((j) => nm(game, j)).join(', ')}`));
  }
  for (const a of (game.myAlliances || [])) {
    const line = el('div', 'hud-line', `<b>${a.name}:</b> ${a.memberNames.join(', ')} <span class="leave-al" title="Leave this alliance">✕</span>`);
    const x = line.querySelector('.leave-al');
    if (x) x.onclick = () => leaveAllianceFlowOnline(a.id);
    st.append(line);
  }
  for (const p of (game.myPromises || [])) {
    st.append(el('div', 'hud-line', `<span class="muted">${p.direction === 'made' ? `You promised ${p.withName}` : `${p.withName} promised you`}: "${p.text}"</span>`));
  }
  if (st.childNodes.length) h.append(st);

  // Leave Room (drop-in/out: AI covers your seat; rejoin with the same code)
  const btns = el('div', 'hud-buttons online-persistent-buttons');
  btns.style.left = 'auto';
  btns.style.right = 'calc(12px + var(--safe-right))';
  if (isSpectator()) {
    const eligible = onlineActiveIds(game).filter((id) => !(game.humanSeats && game.humanSeats[id]));
    if (eligible.length) {
      const to = el('button', 'bb gold', '🎮 Take Over a Houseguest');
      to.onclick = () => takeOverFlowOnline(eligible);
      btns.append(to);
    } else {
      btns.append(el('div', 'hud-hint', '👀 Spectating'));
    }
  } else if (meId) {
    const dr = el('button', 'bb', '🎥 Diary Room');
    dr.onclick = () => openDiaryOnline();
    btns.append(dr);
    const ga = el('button', 'bb', '🤝 Form Alliance');
    ga.onclick = () => formAllianceFlowOnline();
    btns.append(ga);
    const gc = el('button', 'bb', '💬 Group Talk');
    gc.onclick = () => groupChatFlowOnline();
    btns.append(gc);
    const hm = el('button', 'bb', '📢 House Meeting');
    hm.onclick = () => groupChatFlowOnline(onlineActiveIds(game).filter((id) => id !== meId));
    btns.append(hm);
  }
  const leave = el('button', 'bb', '🚪 Leave');
  leave.onclick = () => {
    if (isSpectator()) { room.disconnect(); location.reload(); return; }
    // Leaving must work even mid-ceremony (that's the point of drop-in/out) —
    // clear any showing overlay first so this doesn't stack on top of it.
    document.querySelectorAll('.cinematic').forEach((e) => e.remove());
    const c = cinematic({
      kicker: 'Step Away?',
      title: 'Leave the room',
      bodyHtml: `<p class="muted">The AI plays your houseguest while you're gone. Rejoin with code <b>${room?.code || ''}</b> to take back over.</p>`,
    });
    c.setActions([
      { label: '🚪 Leave (AI covers me)', style: 'gold', onClick: () => { try { room.disconnect(); } catch {} location.reload(); } },
      { label: 'Stay', style: 'primary', onClick: () => c.close() },
    ]);
  };
  btns.append(leave);
  if (iAmHost()) {
    const end = el('button', 'bb danger', '🛑 End Session');
    end.onclick = () => endSessionFlowOnline();
    btns.append(end);
  }
  h.append(btns);
}

// Host-only hard shutdown: ends the room for everyone, not just this seat.
function endSessionFlowOnline() {
  document.querySelectorAll('.cinematic').forEach((e) => e.remove());
  const c = cinematic({
    kicker: 'End Session',
    title: 'End this session for everyone?',
    bodyHtml: '<p class="muted">Nobody will be able to rejoin this room afterward — this closes it for the whole house, not just you.</p>',
  });
  c.setActions([
    { label: '🛑 End for Everyone', style: 'danger', onClick: () => { room.endSession(); c.close(); } },
    { label: 'Cancel', style: 'primary', onClick: () => c.close() },
  ]);
}

function isSpectator() {
  return !myEngineId();
}

function phaseLabelOnline(game) {
  const k = game.turn?.kind;
  const map = {
    intro: 'New Week', comp: game.turn?.comp === 'hoh' ? 'HoH Competition' : game.turn?.comp === 'veto' ? 'Veto Competition' : 'Final HoH',
    comp_result: 'Results', nominate: 'Nominations', noms_result: 'Nominations',
    veto_decision: 'Veto Ceremony', veto_result: 'Veto Ceremony', replacement: 'Replacement',
    vote: 'Live Eviction', eviction_result: 'Eviction', final3_intro: 'Final 3',
    final_cut: 'Final Eviction', final_cut_result: 'Final Eviction', winner: 'The Finale',
    jury_question: 'Jury Q&A', jury_answer: 'Jury Q&A', jury_answer_result: 'Jury Q&A',
    jury_vote: 'The Jury Votes', jury_vote_result: 'The Jury Votes',
  };
  return map[k] || 'The House';
}

function nm(game, id) {
  return game.houseguests.find((h) => h.id === id)?.name || id;
}

function handleOnlineTurn(game) {
  onlineGame = game;
  if (!game || game.phase === 'lobby') return;
  maybeUpgradeSpectator(game);
  syncOnlineWorld(game);
  const t = game.turn;
  if (!t) return;
  // Signature stable across waitingOn changes so we don't restart mid-action.
  const sig = [t.kind, game.week, game.phase, t.comp || '', (t.nominees || []).join(','), t.actor || '', t.winner || ''].join('|');
  const meActing = amIActing(game, t);
  const fullSig = sig + '|' + meActing;
  if (fullSig === lastTurnSig) return;
  lastTurnSig = fullSig;
  renderOnlineTurn(game, t);
}

function amIActing(game, t) {
  const myPid = room?.playerId;
  const myEngine = myEngineId();
  if (t.waitingOn && t.waitingOn.includes(myPid)) return true;
  if (['nominate', 'veto_decision', 'replacement', 'final_cut'].includes(t.kind) && t.actor === myEngine) return true;
  return false;
}

function renderOnlineTurn(game, t) {
  if (t.kind !== 'comp') compRunning = false; // never leave it stuck after a comp
  closeOnlineOverlay();
  document.getElementById('online-social-bar')?.remove();
  const myEngine = myEngineId();
  const host = iAmHost();

  const waitCard = (kicker, title, body) => {
    onlineOverlay = cinematic({ kicker, title, bodyHtml: body || '<p class="muted">Waiting on the house…</p>' });
    const acts = [];
    if (host && isResultKind(t.kind)) acts.push({ label: 'Continue ▶', style: 'gold', onClick: () => room.send('advanceTurn') });
    // Host can AI-cover players we're stuck waiting on.
    if (host && (t.waitingOn && t.waitingOn.length)) acts.push({ label: '⏩ Skip waiting (AI decides)', style: 'primary', onClick: () => room.send('forceResolve') });
    onlineOverlay.setActions(acts);
  };

  switch (t.kind) {
    case 'intro':
      onlineOverlay = cinematic({ kicker: `Week ${t.week}`, title: t.week === 1 ? 'Welcome to the Jury Phase' : 'A New Week', bodyHtml: `<p>${t.message}</p>` });
      onlineOverlay.setActions(host ? [{ label: 'Play HoH Comp ▶', style: 'gold', onClick: () => room.send('advanceTurn') }] : [{ label: '⏳ Waiting for host…', style: '', onClick: () => {} }]);
      break;

    case 'comp': {
      const inComp = t.players.includes(myEngine);
      const iSubmitted = t.scores && t.scores[myEngine] != null;
      const compName = { hoh: 'Head of Household', veto: 'Power of Veto', final_hoh: 'Final HoH' }[t.comp] || 'Competition';
      if (inComp && !iSubmitted && !compRunning) {
        compRunning = true;
        onlineOverlay = cinematic({ kicker: compName, title: COMP_NAMES[t.compType], bodyHtml: `<p class="muted">You're competing. Play for it!</p>` });
        onlineOverlay.setActions([{ label: 'Compete! ▶', style: 'gold', onClick: async () => {
          closeOnlineOverlay();
          const score = await runComp(t.compType, overlayRoot);
          compRunning = false;
          room.send('compScore', { score });
          onlineOverlay = cinematic({ kicker: compName, title: `You scored ${Math.round(score)}`, bodyHtml: '<p class="muted">Waiting for the other competitors…</p>' });
          onlineOverlay.setActions([]);
        } }]);
      } else {
        waitCard(compName, COMP_NAMES[t.compType] || 'Competition', inComp ? '<p class="muted">Score submitted. Waiting for others…</p>' : '<p class="muted">You\'re not in this comp. Watching…</p>');
      }
      break;
    }

    case 'comp_result':
      onlineOverlay = cinematic({ kicker: 'Results', title: `${t.winnerName} wins ${t.comp === 'veto' ? 'the Veto' : t.comp === 'final_hoh' ? 'the Final HoH' : 'HoH'}!`,
        bodyHtml: `<p>${t.board.map((b) => `${b.id === t.winner ? '👑 ' : ''}${b.name} — ${Math.round(b.score)}`).join('<br>')}</p>` });
      onlineOverlay.setActions(host ? [{ label: 'Continue ▶', style: 'gold', onClick: () => room.send('advanceTurn') }] : [{ label: '⏳ Waiting for host…', style: '', onClick: () => {} }]);
      break;

    case 'nominate':
      if (t.actor === myEngine) {
        pickHouseguests(onlineRenderGame(game), {
          kicker: 'Nomination Ceremony', title: 'Nominate two houseguests', bodyHtml: '<p class="muted">Everyone will see who you put up.</p>',
          ids: onlineActiveIds(game).filter((id) => id !== myEngine), count: 2, confirmLabel: 'Lock in Nominations',
        }).then((ids) => room.send('nominate', { ids }));
      } else {
        waitCard('Nomination Ceremony', `${t.actorName} is nominating…`, '<p class="muted">The HoH is choosing two houseguests.</p>');
      }
      break;

    case 'noms_result':
      onlineOverlay = cinematic({ kicker: 'Nomination Ceremony', title: `${nm(game, t.hoh)} nominated ${t.names.join(' and ')}`, bodyHtml: `<p class="muted">${t.nominees.includes(myEngine) ? "You're on the block. Win the veto." : 'The veto could change everything.'}</p>` });
      onlineOverlay.setActions(host ? [{ label: 'Play Veto Comp ▶', style: 'gold', onClick: () => room.send('advanceTurn') }] : [{ label: '⏳ Waiting for host…', style: '', onClick: () => {} }]);
      break;

    case 'veto_decision':
      if (t.actor === myEngine) {
        const c = cinematic({ kicker: 'Veto Ceremony', title: 'You hold the Power of Veto', bodyHtml: `<p>On the block: <b>${t.names.join('</b> and <b>')}</b>.</p>` });
        onlineOverlay = c;
        c.setActions([
          ...t.nominees.map((n, i) => ({ label: `Save ${t.names[i]}`, style: 'primary', onClick: () => room.send('vetoDecision', { use: true, savedId: n }) })),
          { label: 'Do NOT use', style: 'danger', onClick: () => room.send('vetoDecision', { use: false }) },
        ]);
      } else {
        waitCard('Veto Ceremony', `${t.actorName} decides on the veto…`, '<p class="muted">The veto holder is deciding.</p>');
      }
      break;

    case 'replacement':
      if (t.actor === myEngine) {
        pickHouseguests(onlineRenderGame(game), {
          kicker: 'Replacement Nominee', title: 'Name the replacement', bodyHtml: `<p class="muted">${t.savedName} came down. Someone takes their seat.</p>`,
          ids: onlineActiveIds(game).filter((id) => id !== myEngine && !game.nominees.includes(id) && id !== t.savedId), count: 1, confirmLabel: 'Confirm',
        }).then((ids) => room.send('replacement', { id: ids[0] }));
      } else {
        waitCard('Replacement Nominee', `${t.actorName} names a replacement…`);
      }
      break;

    case 'veto_result':
      onlineOverlay = cinematic({ kicker: 'Veto Ceremony', title: t.used ? `Veto used on ${t.savedName}` : 'Veto NOT used', bodyHtml: t.used ? `<p><b>${t.replacementName}</b> is the replacement.</p>` : '<p class="muted">Nominations stay the same.</p>' });
      onlineOverlay.setActions(host ? [{ label: 'Go to Eviction ▶', style: 'gold', onClick: () => room.send('advanceTurn') }] : [{ label: '⏳ Waiting for host…', style: '', onClick: () => {} }]);
      break;

    case 'vote': {
      const amVoter = t.voters.includes(myEngine);
      const iVoted = t.votes && t.votes[myEngine] != null;
      if (amVoter && !iVoted) {
        pickHouseguests(onlineRenderGame(game), {
          kicker: 'Live Eviction', title: 'Vote to EVICT', bodyHtml: '<p class="muted">Both nominees will hear how it fell.</p>',
          ids: t.nominees, count: 1, confirmLabel: 'Cast Vote',
        }).then((ids) => room.send('vote', { target: ids[0] }));
      } else {
        waitCard('Live Eviction', 'The house is voting…', amVoter ? '<p class="muted">Vote cast. Waiting…</p>' : (game.nominees.includes(myEngine) ? '<p class="muted">You\'re on the block. Your fate is in their hands.</p>' : '<p class="muted">Waiting for votes…</p>'));
      }
      break;
    }

    case 'eviction_result': {
      const lines = Object.entries(t.votes).map(([v, tg]) => `<div class="v"><b>${v}</b> → evict <b>${tg}</b></div>`).join('');
      onlineOverlay = cinematic({ kicker: 'Live Eviction', title: `${t.evictedName} has been evicted.`, bodyHtml: `<div class="votes-list">${lines}</div><p class="muted">${t.evictedName} joins the jury.</p>` });
      onlineOverlay.setActions(host ? [{ label: 'Continue ▶', style: 'gold', onClick: () => room.send('advanceTurn') }] : [{ label: '⏳ Waiting for host…', style: '', onClick: () => {} }]);
      break;
    }

    case 'final3_intro':
      onlineOverlay = cinematic({ kicker: 'Final 3', title: 'Three remain', bodyHtml: `<p>${t.three.join(' · ')}</p><p class="muted">One final HoH decides the Final 2.</p>` });
      onlineOverlay.setActions(host ? [{ label: 'Play Final HoH ▶', style: 'gold', onClick: () => room.send('advanceTurn') }] : [{ label: '⏳ Waiting for host…', style: '', onClick: () => {} }]);
      break;

    case 'final_cut':
      if (t.actor === myEngine) {
        pickHouseguests(onlineRenderGame(game), {
          kicker: 'Final Eviction', title: 'You won! Choose who to take to the end', bodyHtml: '<p class="muted">The one you cut becomes the final juror.</p>',
          ids: t.others, count: 1, confirmLabel: 'Evict',
        }).then((ids) => room.send('finalCut', { cutId: ids[0] }));
      } else {
        waitCard('Final Eviction', `${t.actorName} won the Final HoH…`, '<p class="muted">They\'re choosing who to take to the Final 2.</p>');
      }
      break;

    case 'final_cut_result':
      onlineOverlay = cinematic({ kicker: 'Final Eviction', title: `${t.finalHohName} evicts ${t.cutName}`, bodyHtml: `<p class="muted">${t.cutName} casts the final jury vote.</p>` });
      onlineOverlay.setActions(host ? [{ label: 'To the Jury Vote ▶', style: 'gold', onClick: () => room.send('advanceTurn') }] : [{ label: '⏳ Waiting for host…', style: '', onClick: () => {} }]);
      break;

    case 'jury_question':
      if (t.juror === myEngine) {
        cinematicTextInput({
          kicker: 'Jury Q&A', title: 'Ask the finalists one question',
          quote: `(Sent to both ${t.finalistNames.join(' and ')} — they'll each answer it in their own words.)`,
          placeholder: 'What do you want to know before you vote?',
          submitLabel: 'Ask',
        }).then((text) => room.send('juryQuestion', { text }));
      } else {
        waitCard('Jury Q&A', `${t.jurorName} is thinking of a question…`, `<p class="muted">Waiting on the juror.</p>`);
      }
      break;

    case 'jury_answer': {
      const q = t.questions[myEngine];
      const iAnswered = t.answers[myEngine] != null;
      if (t.finalists.includes(myEngine) && !iAnswered) {
        speak(q, t.juror);
        cinematicTextInput({
          kicker: `Juror: ${t.jurorName}`, title: `${t.jurorName} asks you:`, quote: `"${q}"`,
          placeholder: 'Own your game. This answer decides a vote...',
          submitLabel: 'Deliver Answer',
        }).then((text) => { stopSpeaking(); room.send('juryAnswer', { text }); });
      } else {
        waitCard(`Juror: ${t.jurorName}`, 'Waiting on the finalists to answer…');
      }
      break;
    }

    case 'jury_answer_result': {
      const [f1, f2] = t.finalists;
      const body = `<p><b>${nm(game, f1)}</b> was asked: "${t.questions[f1]}"<br>→ "${t.answers[f1]}"</p>
        <p><b>${nm(game, f2)}</b> was asked: "${t.questions[f2]}"<br>→ "${t.answers[f2]}"</p>`;
      onlineOverlay = cinematic({ kicker: `Juror: ${t.jurorName}`, title: 'Both finalists answered', bodyHtml: body });
      onlineOverlay.setActions(host ? [{ label: 'To the Vote ▶', style: 'gold', onClick: () => room.send('advanceTurn') }] : [{ label: '⏳ Waiting for host…', style: '', onClick: () => {} }]);
      break;
    }

    case 'jury_vote':
      if (t.juror === myEngine) {
        const [f1, f2] = t.finalists;
        const c = cinematic({
          kicker: 'Cast Your Vote', title: 'Who wins Big Brother?',
          bodyHtml: `<p><b>${nm(game, f1)}</b>: "${t.answers[f1]}"</p><p><b>${nm(game, f2)}</b>: "${t.answers[f2]}"</p>`,
        });
        onlineOverlay = c;
        c.setActions(t.finalists.map((fid, i) => ({
          label: `Vote for ${t.finalistNames[i]}`, style: 'gold',
          onClick: () => room.send('juryVote', { vote: fid, reasoning: '' }),
        })));
      } else {
        waitCard('The Jury Votes', `${t.jurorName} is deciding…`);
      }
      break;

    case 'jury_vote_result':
      onlineOverlay = cinematic({ kicker: 'Vote Cast', title: `${t.jurorName} votes for ${t.voteName}`, bodyHtml: `<p class="quote">"${t.reasoning}"</p>` });
      onlineOverlay.setActions(host ? [{ label: 'Next ▶', style: 'gold', onClick: () => room.send('advanceTurn') }] : [{ label: '⏳ Waiting for host…', style: '', onClick: () => {} }]);
      break;

    case 'social': {
      // Free roam — no modal. Walk the house and tap houseguests to talk.
      // Own bar, anchored under the top status panel — never share the bottom
      // strip with the persistent Diary/Alliance/Leave buttons (that overlap
      // was the mobile "buttons covering buttons" bug).
      onlineOverlay = null;
      const bar = el('div', 'online-social-bar');
      bar.id = 'online-social-bar';
      bar.append(el('span', '', `<b>${t.label}</b> — tap a houseguest to talk.`));
      if (host) {
        const adv = el('button', 'bb gold sm', t.next === 'nominations' ? '▶ Nominations' : t.next === 'veto_comp' ? '▶ Veto Comp' : '▶ Live Eviction');
        adv.onclick = () => room.send('advanceTurn');
        bar.append(adv);
      } else {
        bar.append(el('span', 'online-social-wait', '⏳ Host advances when ready'));
      }
      document.getElementById('hud').append(bar);
      break;
    }

    case 'winner': {
      const iWon = t.winner === myEngine;
      if (iWon) confetti();
      const votes = t.votes.map((v) => `<div class="jury-vote-card"><div><b>${v.jurorName}</b> → <b>${v.voteName}</b><div class="r">"${v.reasoning}"</div></div></div>`).join('');
      const s = t.stats;
      const statsHtml = s ? `
        <p class="muted">${s.weeks} weeks · ${s.compRecord.length} competitions · ${s.alliancesFormed} alliance${s.alliancesFormed === 1 ? '' : 's'} formed</p>
        <p class="muted">Promises kept: ${s.promisesKept} · broken: ${s.promisesBroken}</p>
        <p class="muted">Eviction order: ${s.evictionOrder.join(' → ')}</p>
      ` : '';
      onlineOverlay = cinematic({ kicker: 'Season Finale', title: `🏆 ${t.winnerName} wins Big Brother! (${Object.values(t.tally).join('–')})`, cardCls: 'stats-card',
        bodyHtml: `<div>${votes}</div>${statsHtml}<p>${iWon ? 'You did it.' : 'Better luck next season.'}</p>` });
      onlineOverlay.setActions([{ label: 'Back to Title', style: 'gold', onClick: () => { room.disconnect(); location.reload(); } }]);
      break;
    }

    default:
      break;
  }
}

function isResultKind(kind) {
  return ['comp_result', 'noms_result', 'veto_result', 'eviction_result', 'final3_intro', 'final_cut_result', 'intro', 'jury_answer_result', 'jury_vote_result'].includes(kind);
}

// A minimal game-shaped object so the existing pickHouseguests (which reads
// g.houseguests + g.memory) works from the online snapshot.
function onlineRenderGame(game) {
  return {
    houseguests: game.houseguests,
    memory: {},
    promises: [],
    evicted: game.evicted,
  };
}
function onlineActiveIds(game) {
  return game.houseguests.map((h) => h.id).filter((id) => !game.evicted.includes(id));
}

function renderOnlineHud() {
  const meId = myEngineId();
  const me = onlineGame.houseguests.find((h) => h.id === meId);
  const humanCount = Object.keys(onlineGame.humanSeats || {}).length;
  const h = document.getElementById('hud');
  h.innerHTML = '';
  const top = el('div', 'hud-top');
  top.append(el('div', 'week', `Week ${onlineGame.week} — Online`));
  top.append(el('div', 'phase', 'The House'));
  top.append(el('div', 'sub', `You are ${me ? me.name : '—'} · ${humanCount} human${humanCount !== 1 ? 's' : ''} in the house`));
  h.append(top);
  const hint = el('div', 'hud-hint', 'You\'re in the shared house. <b>Tap</b> to move, <b>drag</b> to look. Comps, chat & ceremonies are coming online next.');
  h.append(hint);
}

async function openMultiplayer() {
  const { showMultiplayerEntry, showLobby } = await import('./ui/lobby.js');
  showMultiplayerEntry({
    onBack: () => showTitle(),
    onEnter: (r, state) => {
      room = r;
      // Fires whether we're still in the lobby or already mid-season —
      // the host force-ended the room for everyone.
      room.onRoomClosed = (reason) => {
        document.querySelectorAll('.cinematic').forEach((e) => e.remove());
        const c = cinematic({
          kicker: 'Session Ended', title: reason || 'The host ended this session.',
          bodyHtml: '<p class="muted">Returning to the title screen…</p>',
        });
        c.setActions([{ label: 'OK', style: 'gold', onClick: () => location.reload() }]);
        setTimeout(() => location.reload(), 4000);
      };
      showLobby(room, state, {
        onLeave: () => { room = null; showTitle(); },
        onStart: () => {
          // Season started server-side; wait for the authoritative game snapshot
          // then drop into the shared house.
          if (room.lastGame) startOnlineSeason(room.lastGame);
          else room.onGame = (game) => startOnlineSeason(game);
        },
      });
    },
  });
}

// Debug/test hook (harmless in normal play)
window.__bb = {
  get g() { return g; },
  get room() { return room; },
  get onlineGame() { return onlineGame; },
  openOnlineChat: (id) => openOnlineChat(id),
  world,
  refresh: () => refresh(),
  advance: () => advance(),
  openChat: (id, opener, reason) => openNpcChat(id, opener, reason),
  testReveal: (votes, opp) => revealJuryVotes(votes, opp),
  openDiary: () => openDiary(),
  // test helper: evict ids without ceremony, then jump to final 3
  ff: async (ids) => {
    const { applyEviction } = await import('./game/season.js');
    for (const id of ids) {
      applyEviction(g, id, {});
      world.removeNpc(id);
    }
    refresh();
    if (activeIds(g).length <= 3) {
      g.phase = 'final3';
      busy = true;
      world.inputLocked = true;
      await runFinalThree();
      busy = false;
      world.inputLocked = false;
    }
  },
};

function startWorld() {
  const player = createCharacter(g.houseguests.find((h) => h.id === PLAYER_ID));
  scene.add(player);
  world.setPlayer(player);
  const rooms = ['living', 'kitchen', 'bedroom', 'backyard'];
  g.houseguests.forEach((hg, i) => {
    if (hg.id === PLAYER_ID) return;
    if (g.evicted.includes(hg.id)) return;
    world.addNpc(createCharacter(hg), rooms[i % rooms.length]);
  });
  world.onNpcClick = (id) => openNpcChat(id);
  animate();
  scheduleApproaches();
}

let lastPosSentAt = 0;
let lastPosSent = null;
function animate() {
  requestAnimationFrame(animate);
  resize();
  world.update();
  updateFx(world.clock.elapsedTime);
  renderer.render(scene, camera);

  // Broadcast our own position to other connected humans (throttled).
  if (onlineMode && room && world.player) {
    const now = performance.now();
    const p = world.player.position;
    const moved = !lastPosSent || Math.hypot(p.x - lastPosSent.x, p.z - lastPosSent.z) > 0.08;
    if (now - lastPosSentAt > 150 && moved) {
      lastPosSentAt = now;
      lastPosSent = { x: p.x, z: p.z };
      room.sendPos(p.x, p.z, world.player.rotation.y);
    }
  }
}

// ---------- HUD / shared ----------

function refresh() {
  renderHud(g, {
    onAdvance: () => advance(),
    onDiary: () => openDiary(),
    onFormAlliance: () => formAllianceFlow(),
    onGroupChat: () => groupChatFlow(),
    onHouseMeeting: () => groupChatFlow(activeNpcIds(g)),
    onLeaveAlliance: (id) => leaveAllianceFlow(id),
    onExit: () => exitToTitleFlow(),
    onToggleMusic: () => {
      g.settings.musicOn = !g.settings.musicOn;
      setMusicEnabled(g.settings.musicOn);
      if (g.settings.musicOn) setMoodForPhase();
      refresh();
    },
  });
  updateStatusSprites();
  saveGame(g);
}

function updateStatusSprites() {
  for (const [id, char] of world.npcs) {
    const s = char.userData.status;
    if (id === g.hoh) s.userData.setEmoji('hoh');
    else if (id === g.vetoHolder) s.userData.setEmoji('veto');
    else if (g.nominees.includes(id)) s.userData.setEmoji('nominee');
    else s.userData.setEmoji(null);
  }
}

function setMoodForPhase() {
  if (!g.settings.musicOn) return;
  const map = {
    week_intro: 'house', social_hoh: 'house', social_veto: 'house',
    veto_lobby: 'house', renom_watch: 'tension', campaigning: 'tension',
    hoh_comp: 'comp', veto_comp: 'comp',
    nominations: 'tension', veto_ceremony: 'tension', eviction: 'tension',
    final3: 'tension', finale: 'finale',
  };
  setMood(map[g.phase] || 'house');
}

// ---------- Conversations ----------

function openNpcChat(id, opener = null, approachReason = null) {
  if (busy) return;
  clearToast();
  // Any pending approacher stops trailing the moment a conversation starts.
  world.releaseAllFollowers();
  g.pendingApproach = null;
  world.freezeNpc(id, true);
  world.focusOn(id);
  const hg = g.houseguests.find((h) => h.id === id);
  const panel = openChatPanel({
    title: hg.name,
    subtitle: `${hg.job}${g.hoh === id ? ' · HoH 👑' : ''}${g.nominees.includes(id) ? ' · Nominated 🎯' : ''}${g.vetoHolder === id ? ' · Veto 🛡️' : ''}`,
    color: hg.color,
    voice: { key: id, gender: hg.gender },
    thread: g.threads[id] || [],
    onSend: async (text) => {
      // Who's in earshot BEFORE the exchange (positions are frozen during chat).
      const listeners = world.nearbyListeners(id, 6);
      const { reply, effects } = await npcChat(g, id, text);
      if (effects.promiseMade) panel.addSystemMsg(`📋 Promise recorded: "${effects.promiseMade.text}"`);
      if (effects.allianceSignal === 'accept') panel.addSystemMsg(`🤝 ${hg.name} is in. Check your alliances.`);
      if (effects.suspicionOfLie) panel.addSystemMsg(`👀 ${hg.name} didn't seem to buy that...`);
      const overheardBy = applyEavesdrop(id, listeners, text, effects);
      for (const eid of overheardBy) panel.addSystemMsg(`👂 ${nameOf(g, eid)} was close enough to catch that.`);
      refresh();
      return reply;
    },
    onClose: () => {
      world.freezeNpc(id, false);
      world.clearFocus();
    },
  });
  if (opener) panel.addSystemMsg(opener);
  const earshot = world.nearbyListeners(id, 6);
  if (earshot.length) {
    panel.addSystemMsg(`👂 Not private — ${earshot.map((l) => nameOf(g, l.id)).join(', ')} ${earshot.length > 1 ? 'are' : 'is'} within earshot. Move somewhere quieter for a real secret.`);
  }
  if (approachReason) {
    panel.themSpeak(async () => {
      const reply = await npcOpener(g, id, approachReason);
      saveGame(g);
      return reply;
    });
  }
}

// Roll eavesdropping for nearby NPCs. Closer = far likelier to overhear.
// Overheard strategy talk enters their memory and can sour them if it's
// about them. Returns the ids who actually caught it.
function applyEavesdrop(withId, listeners, text, effects) {
  const caught = [];
  for (const { id, dist } of listeners) {
    const chance = Math.max(0.1, 0.85 - dist * 0.12); // ~0.7 at 1m, ~0.1 at 6m
    if (Math.random() > chance) continue;
    caught.push(id);
    const aboutTarget = effects.targetDiscussed;
    const gist = effects.secretShared
      ? effects.secretShared
      : effects.summary || `something to ${nameOf(g, withId)}`;
    g.memory[id].gossipHeard.push({
      text: `overheard you tell ${nameOf(g, withId)}: "${String(gist).slice(0, 120)}"`,
      aboutId: aboutTarget || null,
      fromId: id,
      week: g.week,
      believed: true,
      overheard: true,
    });
    // If they overheard you scheming against THEM, it stings
    if (aboutTarget === id) {
      const r = g.social[id][PLAYER_ID];
      r.trust = Math.max(0, r.trust - 16);
      r.bond = Math.max(0, r.bond - 8);
      r.threat = Math.min(100, r.threat + 8);
      g.memory[id].grudges.push({
        againstId: PLAYER_ID,
        reason: `I overheard you pushing to target me`,
        week: g.week,
        severity: 2,
      });
    } else if (aboutTarget) {
      // They now know your target — a small trust ding for scheming near them
      g.social[id][PLAYER_ID].threat = Math.min(100, g.social[id][PLAYER_ID].threat + 4);
    }
  }
  return caught;
}

function openDiary() {
  if (busy) return;
  clearToast();
  world.releaseAllFollowers();
  g.pendingApproach = null;
  openChatPanel({
    title: 'Diary Room',
    subtitle: 'Private. Nothing said here leaves this room.',
    color: 0xb04a4a,
    isDiary: true,
    thread: g.diary,
    onSend: async (text) => {
      const reply = await diaryChat(g, text);
      saveGame(g);
      return reply;
    },
  });
}

// ---------- Form Alliance ----------

async function formAllianceFlow() {
  if (busy) return;
  closeChatPanel();
  clearToast();
  world.releaseAllFollowers();
  g.pendingApproach = null;
  const picked = await pickHouseguests(g, {
    kicker: 'Form an Alliance',
    title: 'Who do you want in?',
    bodyHtml: `<p class="muted">Each invitee decides for themselves — they weigh their trust in you AND in everyone else on the list.</p>`,
    ids: activeNpcIds(g),
    count: { min: 1, max: 3 },
    confirmLabel: 'Send the Invites',
    meta: (id) => metaLine(id),
    cancelable: true,
  });
  if (!picked || !picked.length) return;

  const name = await cinematicTextInput({
    kicker: 'Form an Alliance',
    title: 'Name it',
    quote: 'Every real alliance has a name. Make it iconic.',
    placeholder: 'e.g. The Blindside Brigade',
    submitLabel: 'Lock It In',
  });

  // Each invitee decides, knowing the full member list
  const accepts = [], declines = [];
  for (const id of picked) {
    const w = allianceWillingness(g, id, picked.filter((x) => x !== id));
    (w.willing ? accepts : declines).push({ id, reason: w.reason });
  }

  let bodyHtml = '';
  if (accepts.length) {
    const result = formOfficialAlliance(g, accepts[0].id, name, accepts.slice(1).map((a) => a.id));
    bodyHtml += `<p>✅ In: <b>${accepts.map((a) => nameOf(g, a.id)).join(', ')}</b></p>`;
    bodyHtml += result.existed
      ? `<p class="muted">You already had this exact group — deepened, not duplicated.</p>`
      : `<p><b>"${result.alliance.name}"</b> is official.</p>`;
  }
  for (const d of declines) {
    bodyHtml += `<p>❌ <b>${nameOf(g, d.id)}</b> passed — ${d.reason}.</p>`;
  }
  if (!accepts.length) bodyHtml += `<p class="muted">Nobody committed. Build more trust first — or pitch them one-on-one.</p>`;
  if (declines.length) bodyHtml += `<p class="muted">The ones who said no now know you're building something.</p>`;

  // Decliners get suspicious — you showed your hand
  for (const d of declines) {
    const r = g.social[d.id][PLAYER_ID];
    r.threat = Math.min(100, r.threat + 6);
  }

  sting(accepts.length ? 'chime' : 'knock');
  await cinematicWait({ kicker: 'Alliance Invites', title: accepts.length ? 'The word comes back...' : 'Crickets.', bodyHtml });
  refresh();
}

async function leaveAllianceFlow(allianceId) {
  if (busy) return;
  const al = g.alliances.find((a) => a.id === allianceId);
  if (!al) return;
  const others = al.members.filter((m) => m !== PLAYER_ID).map((m) => nameOf(g, m)).join(', ');
  const confirmed = await new Promise((resolve) => {
    const c = cinematic({
      kicker: 'Leave Alliance',
      title: `Walk out of "${al.name}"?`,
      bodyHtml: `<p>You'd be quitting on <b>${others}</b>.</p><p class="muted">Quitting is a soft betrayal — they'll lose trust and hold a grudge, the loyal ones most of all. Word gets around.</p>`,
    });
    c.setActions([
      { label: 'Walk Away', style: 'danger', onClick: () => { c.close(); resolve(true); } },
      { label: 'Stay', style: 'primary', onClick: () => { c.close(); resolve(false); } },
    ]);
  });
  if (!confirmed) return;
  const res = leaveAlliance(g, allianceId);
  sting('knock');
  await cinematicWait({
    kicker: 'Alliance Dissolved',
    title: `You left "${res.name}".`,
    bodyHtml: `<p class="muted">${res.collapsed ? 'With you gone, the alliance collapsed entirely.' : `${res.others.map((id) => nameOf(g, id)).join(', ')} will remember this.`}</p>`,
  });
  refresh();
}

// ---------- Group conversations ----------

async function groupChatFlow(presetIds = null) {
  if (busy) return;
  closeChatPanel();
  clearToast();
  world.releaseAllFollowers();
  g.pendingApproach = null;
  const isHouseMeeting = !!presetIds;
  const picked = presetIds || await pickHouseguests(g, {
    kicker: 'Group Conversation',
    title: 'Pull some people aside',
    bodyHtml: `<p class="muted">Everything said here is heard — and remembered — by everyone present. Promise carefully.</p>`,
    ids: activeNpcIds(g),
    count: { min: 2, max: 4 },
    confirmLabel: 'Gather Them',
    meta: (id) => metaLine(id),
    cancelable: true,
  });
  if (!picked || picked.length < 2) return;

  for (const id of picked) world.summonNpc(id);
  const history = [];
  const names = isHouseMeeting ? 'THE WHOLE HOUSE' : picked.map((id) => nameOf(g, id)).join(', ');
  if (isHouseMeeting) {
    sting('reveal');
    logEvent(g, 'house_meeting', `${g.playerName} called a house meeting.`, picked);
  }

  const panel = openChatPanel({
    title: isHouseMeeting ? '📢 House Meeting' : `Group: ${names}`,
    subtitle: isHouseMeeting
      ? 'Everyone. Everything on the record. No takebacks.'
      : 'All hear everything · /whisper <name> ... for a private aside',
    color: isHouseMeeting ? 0xf5c542 : 0x7c5cff,
    voice: { lookupGender: (name) => g.houseguests.find((h) => h.name === name)?.gender || null },
    thread: [],
    onSend: async (text) => {
      // Whisper: /whisper <name> <message> — only that member truly hears it,
      // but the rest of the room notices the huddle and grows suspicious.
      const wm = text.match(/^\/(?:whisper|w)\s+(\S+)\s+([\s\S]+)/i);
      if (wm) {
        const targetId = picked.find((id) => nameOf(g, id).toLowerCase() === wm[1].toLowerCase());
        if (!targetId) {
          panel.addSystemMsg(`(No one named "${wm[1]}" is in this group.)`);
          return [];
        }
        const secret = wm[2];
        history.push({ who: 'you', text: `🤫 (to ${nameOf(g, targetId)}) ${secret}` });
        const { reply } = await npcChat(g, targetId, secret);
        history.push({ who: 'them', id: targetId, text: reply });
        // Everyone else clocks the whispering
        for (const id of picked) {
          if (id === targetId) continue;
          const r = g.social[id][PLAYER_ID];
          r.threat = Math.min(100, r.threat + 5);
          r.trust = Math.max(0, r.trust - 3);
          g.memory[id].gossipHeard.push({
            text: `caught you whispering with ${nameOf(g, targetId)} in a group — didn't like it`,
            aboutId: PLAYER_ID, fromId: id, week: g.week, believed: true,
          });
        }
        panel.addSystemMsg(`🤫 You whispered to ${nameOf(g, targetId)}. ${picked.length > 1 ? 'The others noticed.' : ''}`);
        refresh();
        return [{ name: nameOf(g, targetId), text: reply }];
      }

      history.push({ who: 'you', text });
      const { replies, proposal, promiseMade } = await groupChat(g, picked, text, history);
      for (const r of replies) history.push({ who: 'them', id: r.id, text: r.reply });
      if (promiseMade) panel.addSystemMsg(`📋 Everyone here heard that promise: "${promiseMade.text}"`);
      if (proposal) {
        if (proposal.accepted) {
          const accepters = picked.filter((id) => !proposal.decliners.includes(id));
          if (accepters.length) {
            const result = formOfficialAlliance(g, accepters[0], proposal.name, accepters.slice(1));
            panel.addSystemMsg(`🤝 "${result.alliance.name}" is official: you + ${accepters.map((id) => nameOf(g, id)).join(', ')}${proposal.decliners.length ? ` (out: ${proposal.decliners.map((id) => nameOf(g, id)).join(', ')})` : ''}`);
          }
        } else {
          panel.addSystemMsg(`🚫 The room didn't commit. They'll remember you asked.`);
        }
      }
      refresh();
      return replies.map((r) => ({ name: nameOf(g, r.id), text: r.reply }));
    },
    onClose: () => {
      world.releaseAllFollowers();
    },
  });
  panel.addSystemMsg(
    isHouseMeeting
      ? `You call everyone to the living room. ${picked.map((id) => nameOf(g, id)).join(', ')} gather around. The floor is yours.`
      : `You pull ${names} aside. They're all listening.`
  );
}

// ---------- Exit to title ----------

function exitToTitleFlow() {
  // Guard against stacking on top of a ceremony/intro cinematic that's showing
  // even when `busy` isn't set (e.g. the week-intro screen awaiting a click).
  if (busy || document.querySelector('.cinematic')) return;
  closeChatPanel();
  const c = cinematic({
    kicker: 'Take a Break?',
    title: 'Exit to the title screen',
    bodyHtml: `<p class="muted">Your season auto-saves every phase — "Continue Season" picks up right here.</p>`,
  });
  c.setActions([
    { label: '💾 Exit (season saved)', style: 'gold', onClick: () => { saveGame(g); location.reload(); } },
    { label: '🗑️ Abandon season', style: 'danger', onClick: () => { clearSave(); location.reload(); } },
    { label: 'Keep playing', style: 'primary', onClick: () => c.close() },
  ]);
}

// ---------- Proactive approaches ----------

function scheduleApproaches() {
  clearInterval(approachTimer);
  approachTimer = setInterval(() => {
    if (busy || !g) return;
    if (!['social_hoh', 'social_veto', 'veto_lobby', 'renom_watch', 'campaigning', 'week_intro'].includes(g.phase)) return;
    if (document.getElementById('chat-panel')) return;
    if (g.pendingApproach) return;
    const ap = chooseApproacher(g);
    if (!ap) return;
    g.pendingApproach = ap;
    const char = world.npcs.get(ap.npcId);
    if (char) char.userData.status.userData.setEmoji('approach');
    world.summonNpc(ap.npcId);
    sting('knock');

    // If the player never responds, the NPC gives up rather than trailing them.
    const clearApproach = () => {
      if (g.pendingApproach !== ap) return; // already handled
      g.pendingApproach = null;
      world.releaseNpc(ap.npcId);
      updateStatusSprites();
    };
    const expireTimer = setTimeout(() => {
      clearApproach();
      clearToast();
    }, 22000);

    showToast(`<b>${nameOf(g, ap.npcId)}</b> ${APPROACH_REASON_TEXT[ap.reason] || 'wants to talk'}...`, [
      {
        label: 'Talk',
        style: 'gold',
        onClick: () => {
          clearTimeout(expireTimer);
          g.pendingApproach = null;
          updateStatusSprites();
          openNpcChat(ap.npcId, `${nameOf(g, ap.npcId)} came to find you — they ${APPROACH_REASON_TEXT[ap.reason] || 'want to talk'}.`, ap.reason);
        },
      },
      {
        label: 'Not now',
        style: '',
        onClick: () => {
          clearTimeout(expireTimer);
          clearApproach();
        },
      },
    ]);
  }, 14000);
}

// ---------- Phase advancement ----------

async function advance() {
  if (busy) return;
  busy = true;
  world.inputLocked = true;
  closeChatPanel();
  world.clearFocus();
  for (const [id] of world.npcs) world.freezeNpc(id, false);
  world.releaseAllFollowers();
  clearToast();
  g.pendingApproach = null;
  try {
    if (g.phase === 'week_intro') await runHohComp();
    else if (g.phase === 'social_hoh') await runNominations();
    else if (g.phase === 'social_veto') await runVetoComp();
    else if (g.phase === 'veto_lobby') await runVetoCeremony();
    else if (g.phase === 'renom_watch') await runRenomCeremony();
    else if (g.phase === 'campaigning') await runEviction();
  } catch (err) {
    console.error('phase error', err);
  }
  busy = false;
  world.inputLocked = false;
  refresh();
  setMoodForPhase();
}

function weekIntro() {
  refresh();
  setMoodForPhase();
  cinematicWait({
    kicker: `Week ${g.week}`,
    title: g.week === 1 ? 'Welcome to the Jury Phase' : 'A New Week Begins',
    bodyHtml:
      g.week === 1
        ? `<p>Nine houseguests remain. From this point on, everyone evicted joins the <b>jury</b> — and the jury decides who wins the $750,000.</p><p class="muted">Talk to people. Make deals. Every conversation is remembered.</p>`
        : `<p>${activeIds(g).length} houseguests remain. The house resets — new HoH, new targets, old grudges.</p>`,
    continueLabel: 'Play HoH Comp',
  }).then(() => advance());
}

// ---------- HoH comp ----------

async function runHohComp() {
  g.phase = 'hoh_comp';
  refresh();
  setMoodForPhase();
  const outgoing = g.lastHoh && !g.evicted.includes(g.lastHoh) ? g.lastHoh : null;
  const exclude = outgoing ? [outgoing] : [];
  const type = randomCompType();

  const playerOut = outgoing === PLAYER_ID;
  await cinematicWait({
    kicker: 'Head of Household',
    title: COMP_NAMES[type],
    bodyHtml: `<p>${exclude.length ? `As outgoing HoH, <b>${playerOut ? 'YOU' : nameOf(g, outgoing)}</b> sit${playerOut ? '' : 's'} this one out.` : 'Everyone competes.'}</p><p class="muted">Win, and you control nominations. Lose, and you'd better have friends.</p>`,
    continueLabel: playerOut ? 'Watch the Comp' : 'Compete!',
  });

  const playerScore = playerOut ? 0 : await runComp(type, overlayRoot);
  const { winner, scores } = resolveComp(g, playerScore, { excludeIds: exclude });
  g.hoh = winner;
  g.compHistory.push({ week: g.week, type: 'hoh', winner, scores });
  logEvent(g, 'hoh', `${nameOf(g, winner)} won HoH.`, [winner]);
  sting(winner === PLAYER_ID ? 'win' : 'reveal');

  const board = Object.entries(scores)
    .filter(([, s]) => s >= 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, s]) => `${id === winner ? '👑 ' : ''}${nameOf(g, id)} — ${Math.round(s)}`)
    .join('<br>');
  await cinematicWait({
    kicker: 'Results',
    title: `${nameOf(g, winner)} is the new Head of Household!`,
    bodyHtml: `<p>${board}</p>` + (winner === PLAYER_ID
      ? `<p class="muted">The house will come to you now. Listen to the pitches — then nominate two.</p>`
      : `<p class="muted">Time to get in ${nameOf(g, winner)}'s ear before nominations.</p>`),
  });

  g.phase = 'social_hoh';
}

// ---------- Nominations ----------

async function runNominations() {
  g.phase = 'nominations';
  refresh();
  setMoodForPhase();
  let nominees;
  if (g.hoh === PLAYER_ID) {
    nominees = await pickHouseguests(g, {
      kicker: 'Nomination Ceremony',
      title: 'Nominate two houseguests',
      bodyHtml: `<p class="muted">Promises you break here will follow you to the jury.</p>`,
      ids: activeNpcIds(g),
      count: 2,
      confirmLabel: 'Lock in Nominations',
      meta: (id) => metaLine(id),
    });
    applyNominations(g, PLAYER_ID, nominees);
    sting('reveal');
    await cinematicWait({
      kicker: 'Nomination Ceremony',
      title: `You nominated ${nominees.map((n) => nameOf(g, n)).join(' and ')}.`,
      bodyHtml: `<p class="muted">The house heard it. The nominees felt it. Expect visitors.</p>`,
    });
  } else {
    nominees = decideNominations(g, g.hoh);
    applyNominations(g, g.hoh, nominees);
    const speech = await npcSpeech(g, g.hoh, 'nomination', { nominees });
    sting('reveal');
    await cinematicWait({
      kicker: 'Nomination Ceremony',
      title: `${nameOf(g, g.hoh)} nominates ${nominees.map((n) => nameOf(g, n)).join(' and ')}${nominees.includes(PLAYER_ID) ? ' — including YOU' : ''}.`,
      quote: `"${speech}"`,
      bodyHtml: nominees.includes(PLAYER_ID)
        ? `<p class="muted">You're on the block. Win the veto, or start campaigning.</p>`
        : `<p class="muted">The veto can still change everything.</p>`,
    });
  }
  g.phase = 'social_veto';
}

function metaLine(id) {
  const grudges = g.memory[id]?.grudges.filter((x) => x.againstId === PLAYER_ID).length || 0;
  const promised = g.promises.some((p) => p.status === 'open' && p.from === PLAYER_ID && p.to === id);
  const bits = [];
  if (promised) bits.push('you promised them');
  if (grudges) bits.push(`${grudges} grudge${grudges > 1 ? 's' : ''}`);
  return bits.join(' · ') || g.houseguests.find((h) => h.id === id).job;
}

// ---------- Veto ----------

async function runVetoComp() {
  g.phase = 'veto_comp';
  refresh();
  setMoodForPhase();
  const players = vetoPlayers(g);
  const type = randomCompType();
  const playerIn = players.includes(PLAYER_ID);

  await cinematicWait({
    kicker: 'Power of Veto',
    title: COMP_NAMES[type],
    bodyHtml: `<p>Playing: ${players.map((p) => nameOf(g, p)).join(', ')}</p><p class="muted">${playerIn ? 'You drew a spot. Play for the gold.' : 'You were not drawn. Watch and pray.'}</p>`,
    continueLabel: playerIn ? 'Compete!' : 'Watch the Comp',
  });

  let playerScore = 0;
  if (playerIn) playerScore = await runComp(type, overlayRoot);
  const notPlaying = activeIds(g).filter((id) => !players.includes(id));
  const { winner, scores } = resolveComp(g, playerScore, { excludeIds: notPlaying, playerPlays: playerIn });
  g.vetoHolder = winner;
  g.compHistory.push({ week: g.week, type: 'veto', winner, scores });
  logEvent(g, 'veto_win', `${nameOf(g, winner)} won the Power of Veto.`, [winner]);
  sting(winner === PLAYER_ID ? 'win' : 'reveal');

  const holderIsYou = winner === PLAYER_ID;
  await cinematicWait({
    kicker: 'Veto Results',
    title: `${nameOf(g, winner)} wins the Power of Veto!`,
    bodyHtml: `<p>${Object.entries(scores).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]).map(([id, s]) => `${id === winner ? '🛡️ ' : ''}${nameOf(g, id)} — ${Math.round(s)}`).join('<br>')}</p>` +
      (holderIsYou
        ? `<p class="muted">The house will come lobbying before you decide. Go work the room, then hold the ceremony.</p>`
        : `<p class="muted">Time to get in ${nameOf(g, winner)}'s ear before the ceremony.</p>`),
  });

  // Social window: lobby the veto holder before the ceremony.
  g.phase = 'veto_lobby';
}

async function runVetoCeremony() {
  g.phase = 'veto_ceremony';
  refresh();
  setMoodForPhase();
  const holder = g.vetoHolder;

  if (holder === PLAYER_ID) {
    // Final 4: saving someone else would put YOU up as the only replacement —
    // unless you're the HoH (the HoH can never be nominated).
    const finalFourTrap = activeIds(g).length <= 4 && !g.nominees.includes(PLAYER_ID) && g.hoh !== PLAYER_ID;
    const choice = await new Promise((resolve) => {
      const c = cinematic({
        kicker: 'Veto Ceremony',
        title: 'You hold the Power of Veto',
        bodyHtml: `<p>On the block: <b>${g.nominees.map((n) => nameOf(g, n)).join('</b> and <b>')}</b>.</p><p class="muted">${finalFourTrap ? 'With four left, saving a nominee would put YOU on the block as the only replacement.' : "Use it, and the HoH names a replacement. Don't, and the nominations stay."}</p>`,
      });
      const acts = [
        ...(finalFourTrap ? [] : g.nominees.filter((n) => n !== PLAYER_ID).map((n) => ({
          label: `Save ${nameOf(g, n)}`,
          style: 'primary',
          onClick: () => { c.close(); resolve({ use: true, savedId: n }); },
        }))),
        ...(g.nominees.includes(PLAYER_ID)
          ? [{ label: 'Save MYSELF', style: 'gold', onClick: () => { c.close(); resolve({ use: true, savedId: PLAYER_ID }); } }]
          : []),
        { label: 'Do not use the Veto', style: 'danger', onClick: () => { c.close(); resolve({ use: false }); } },
      ];
      c.setActions(acts);
    });

    if (choice.use) {
      applyVetoSave(g, holder, choice.savedId);
      sting('reveal');
      await cinematicWait({
        kicker: 'Veto Ceremony',
        title: `You used the Veto on ${choice.savedId === PLAYER_ID ? 'yourself' : nameOf(g, choice.savedId)}.`,
        bodyHtml: g.hoh === PLAYER_ID
          ? `<p class="muted">Now you must name a replacement — but the house gets one last scramble first.</p>`
          : `<p class="muted"><b>${nameOf(g, g.hoh)}</b> must name a replacement. Expect a scramble.</p>`,
      });
      startRenomWatch(holder, choice.savedId);
      return;
    }
    applyVeto(g, holder, false);
    await cinematicWait({ kicker: 'Veto Ceremony', title: 'You kept the nominations the same.', bodyHtml: `<p class="muted">Two people just took notes.</p>` });
  } else {
    const d = decideVetoUse(g, holder);
    if (d.use) {
      const speech = await npcSpeech(g, holder, 'veto_use', { saved: d.savedId });
      applyVetoSave(g, holder, d.savedId);
      sting('reveal');
      await cinematicWait({
        kicker: 'Veto Ceremony',
        title: `${nameOf(g, holder)} used the Veto on ${d.savedId === holder ? 'themselves' : nameOf(g, d.savedId)}!`,
        quote: `"${speech}"`,
        bodyHtml: g.hoh === PLAYER_ID
          ? `<p class="muted">As HoH, you'll name the replacement — after the house makes its case.</p>`
          : `<p class="muted"><b>${nameOf(g, g.hoh)}</b> must now name a replacement.</p>`,
      });
      startRenomWatch(holder, d.savedId);
      return;
    }
    const speech = await npcSpeech(g, holder, 'veto_nouse');
    applyVeto(g, holder, false);
    await cinematicWait({
      kicker: 'Veto Ceremony',
      title: `${nameOf(g, holder)} did NOT use the Power of Veto.`,
      quote: `"${speech}"`,
    });
  }
  g.phase = 'campaigning';
}

// Social window after a veto is used, before the replacement is named.
function startRenomWatch(holder, savedId) {
  g.pendingRenom = { holder, savedId };
  g.phase = 'renom_watch';
}

async function runRenomCeremony() {
  const { holder, savedId } = g.pendingRenom || {};
  g.phase = 'veto_ceremony';
  refresh();
  let replacement;
  if (g.hoh === PLAYER_ID) {
    [replacement] = await pickHouseguests(g, {
      kicker: 'Replacement Nominee',
      title: 'Name the replacement nominee',
      bodyHtml: `<p class="muted">${nameOf(g, savedId)} is safe. Someone has to take that seat.</p>`,
      ids: activeNpcIds(g).filter((id) => !g.nominees.includes(id) && id !== savedId && id !== g.hoh),
      count: 1,
      confirmLabel: 'Confirm Replacement',
      meta: (id) => metaLine(id),
    });
  } else {
    replacement = decideReplacement(g, g.hoh, [...g.nominees, savedId, holder]);
  }
  applyReplacement(g, replacement);
  g.pendingRenom = null;
  sting('reveal');
  await cinematicWait({
    kicker: 'Replacement Nominee',
    title: `${nameOf(g, replacement)}${replacement === PLAYER_ID ? ' (YOU)' : ''} ${replacement === PLAYER_ID ? 'take' : 'takes'} the seat.`,
    bodyHtml: `<p>Final nominees: <b>${g.nominees.map((n) => nameOf(g, n)).join('</b> and <b>')}</b>${g.hoh !== PLAYER_ID ? `, courtesy of ${nameOf(g, g.hoh)}` : ''}.</p>`,
  });
  g.phase = 'campaigning';
}

// ---------- Eviction ----------

async function runEviction() {
  g.phase = 'eviction';
  refresh();
  setMoodForPhase();
  const [n1, n2] = g.nominees;
  const playerVotes = !g.nominees.includes(PLAYER_ID) && g.hoh !== PLAYER_ID;

  let playerVote = null;
  if (playerVotes) {
    [playerVote] = await pickHouseguests(g, {
      kicker: 'Live Eviction',
      title: 'Cast your vote to EVICT',
      bodyHtml: `<p class="muted">Both nominees will hear how the votes fell. Jurors remember who wrote their name down.</p>`,
      ids: [n1, n2],
      count: 1,
      confirmLabel: 'Cast Vote',
      meta: (id) => metaLine(id),
    });
  }

  let { votes, evicted, tally, tiedBrokenByHoh } = resolveEviction(g, playerVote);
  g.voteHistory.push({ week: g.week, votes: { ...votes }, tally: { ...tally } });

  if (tiedBrokenByHoh && evicted === null) {
    // Player is HoH and must break the tie
    [evicted] = await pickHouseguests(g, {
      kicker: 'Live Eviction',
      title: `It's a TIE. As HoH, you decide.`,
      bodyHtml: `<p>${tally[n1]} votes ${nameOf(g, n1)}, ${tally[n2]} votes ${nameOf(g, n2)}.</p><p class="muted">This one is entirely, publicly, on you.</p>`,
      ids: [n1, n2],
      count: 1,
      confirmLabel: 'Evict',
    });
    votes = { ...votes, [PLAYER_ID + '_tiebreak']: evicted };
  }

  // Reveal votes one by one
  sting('reveal');
  const voteLines = Object.entries(votes)
    .filter(([v]) => !v.endsWith('_tiebreak'))
    .map(([voter, target]) => `<div class="v"><b>${voter === PLAYER_ID ? 'You' : nameOf(g, voter)}</b> voted to evict <b>${nameOf(g, target)}</b></div>`)
    .join('');
  const goodbyeQuote = evicted !== PLAYER_ID ? await npcSpeech(g, evicted, 'eviction_goodbye') : null;

  applyEviction(g, evicted, Object.fromEntries(Object.entries(votes).filter(([v]) => !v.endsWith('_tiebreak'))));

  await cinematicWait({
    kicker: 'Live Eviction',
    title: `By a vote of ${tally[evicted]} to ${tally[evicted === n1 ? n2 : n1]}${tiedBrokenByHoh ? ' (tie broken by HoH)' : ''}...`,
    bodyHtml: `<div class="votes-list">${voteLines}</div><h2>${nameOf(g, evicted)}, you have been evicted.</h2>` +
      (goodbyeQuote ? `<div class="quote">"${goodbyeQuote}"</div>` : '') +
      `<p class="muted">${nameOf(g, evicted)} heads to the jury house — and remembers everything.</p>`,
    continueLabel: evicted === PLAYER_ID ? 'Face the Music' : 'Continue',
  });

  if (evicted === PLAYER_ID) return gameOverEvicted();

  world.removeNpc(evicted);

  if (activeIds(g).length <= 3) {
    g.phase = 'final3';
    await runFinalThree();
  } else {
    nextPhase(g); // -> week_intro (increments week)
    weekIntro();
  }
}

function gameOverEvicted() {
  stopMusic();
  sting('lose');
  const place = getOrdinal(activeIds(g).length + 1);
  const stats = buildSeasonStats(g, { result: 'evicted', place });
  archiveSeason(stats);
  const c = cinematic({
    kicker: 'Evicted',
    title: `Your game ends in ${place} place.`,
    bodyHtml: `<p>The house voted you out, Week ${g.week}. The season goes on without you.</p>
      <p class="muted">${g.events.filter((e) => e.type === 'betrayal').length} betrayals, ${g.promises.filter((p) => p.from === PLAYER_ID && p.status === 'broken').length} broken promises of your own, ${g.promises.filter((p) => p.from === PLAYER_ID && p.status === 'kept').length} kept.</p>`,
  });
  c.setActions([
    { label: '📊 Season Stats', style: 'primary', onClick: () => showStatsPage(stats) },
    { label: '🧠 Post-Game Analysis', style: 'primary', onClick: () => showAnalysis(stats) },
    { label: 'New Season', style: 'gold', onClick: () => { clearSave(); location.reload(); } },
  ]);
}

async function showAnalysis(stats) {
  const c = cinematic({
    kicker: 'Post-Game Analysis',
    title: 'The analyst reviews the tape...',
    bodyHtml: `<p class="muted">Reading every week of your season.</p>`,
  });
  let text = stats.analysis;
  if (!text) {
    text = await postGameAnalysis(g, stats);
    stats.analysis = text;
    archiveSeason(stats); // keep it with the season record
  }
  c.card.querySelector('div').innerHTML = text
    .split(/\n+/)
    .map((p) => `<p style="text-align:left">${p}</p>`)
    .join('');
  c.card.querySelector('h2').textContent = '🧠 Your Season, Diagnosed';
  c.setActions([{ label: 'Close', style: 'primary', onClick: () => c.close() }]);
}

function getOrdinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---------- Final 3 ----------

async function runFinalThree() {
  refresh();
  setMoodForPhase();
  const three = activeIds(g);
  await cinematicWait({
    kicker: 'Final 3',
    title: 'Three remain. One final HoH.',
    bodyHtml: `<p>${three.map((id) => nameOf(g, id)).join(' · ')}</p><p class="muted">The final Head of Household chooses who to take to the end — and who to send to the jury they'll face.</p>`,
    continueLabel: 'Play the Final HoH',
  });

  g.phase = 'final_hoh';
  refresh();
  setMood('comp');
  const type = randomCompType();
  const playerScore = await runComp(type, overlayRoot);
  const { winner, scores } = resolveComp(g, playerScore, { excludeIds: [] });
  g.hoh = winner;
  logEvent(g, 'final_hoh', `${nameOf(g, winner)} won the Final HoH.`, [winner]);
  sting(winner === PLAYER_ID ? 'win' : 'reveal');

  let cut;
  if (winner === PLAYER_ID) {
    [cut] = await pickHouseguests(g, {
      kicker: 'Final HoH',
      title: 'You won the Final HoH. Evict one houseguest.',
      bodyHtml: `<p class="muted">Whoever you cut becomes the 7th juror. Choose who you can beat.</p>`,
      ids: three.filter((id) => id !== PLAYER_ID),
      count: 1,
      confirmLabel: 'Evict',
      meta: (id) => metaLine(id),
    });
  } else {
    const others = three.filter((id) => id !== winner);
    // Winner cuts the bigger threat-to-win: uses evictionDesire between the two
    cut = evictionDesire(g, winner, others[0], others[1]) >= 0 ? others[0] : others[1];
  }

  recordFinalCut(winner, cut);
  const goodbye = cut !== PLAYER_ID ? await npcSpeech(g, cut, 'eviction_goodbye') : null;
  applyEviction(g, cut, {});
  world.removeNpc(cut);

  await cinematicWait({
    kicker: 'Final Eviction',
    title: `${nameOf(g, winner)} evicts ${cut === PLAYER_ID ? 'YOU' : nameOf(g, cut)}.`,
    quote: goodbye ? `"${goodbye}"` : null,
    bodyHtml: `<p class="muted">${nameOf(g, cut)} becomes the final member of the jury.</p>`,
    continueLabel: cut === PLAYER_ID ? 'Accept It' : 'To the Finale',
  });

  if (cut === PLAYER_ID) return gameOverEvicted();
  await runFinale();
}

function recordFinalCut(winner, cut) {
  if (cut !== PLAYER_ID && g.memory[cut]) {
    g.memory[cut].grudges.push({
      againstId: winner,
      reason: 'cut me at the Final 3',
      week: g.week,
      severity: 3,
    });
  }
  logEvent(g, 'final_cut', `${nameOf(g, winner)} evicted ${nameOf(g, cut)} at the Final 3.`, [winner, cut]);
}

// ---------- Finale: Jury Q&A + vote ----------

async function runFinale() {
  g.phase = 'finale';
  refresh();
  setMood('finale');
  const finalists = activeIds(g); // player + 1 NPC (player must be here to reach this code)
  const opp = finalists.find((id) => id !== PLAYER_ID);
  // Any promise still standing between the finalists was honored to the end.
  for (const p of g.promises) {
    if (p.status === 'open' && p.kind !== 'info') p.status = 'kept';
  }
  const jurors = g.jury.slice(-7); // the 7 jurors

  await cinematicWait({
    kicker: 'The Finale',
    title: `Final 2: You and ${nameOf(g, opp)}.`,
    bodyHtml: `<p>The jury — ${jurors.map((j) => nameOf(g, j)).join(', ')} — will question you both, then vote.</p><p class="muted">They remember every promise, every vote, every betrayal. Answer for your game.</p>`,
    continueLabel: 'Face the Jury',
  });

  const qaByJuror = {};
  for (const j of jurors) {
    const jHg = g.houseguests.find((h) => h.id === j);
    const q = await jurorQuestion(g, j, [PLAYER_ID, opp]);
    speak(q.questionForF1, j, jHg?.gender);
    // Player answers their question
    const playerAnswer = await cinematicTextInput({
      kicker: `Juror: ${nameOf(g, j)} (${q.toneNote || 'measured'})`,
      title: `${nameOf(g, j)} asks you:`,
      quote: `"${q.questionForF1}"`,
      placeholder: 'Own your game. This answer decides a vote...',
      submitLabel: 'Deliver Answer',
    });
    stopSpeaking();
    // Opponent answers theirs
    const oppAnswer = await opponentJuryAnswer(g, opp, j, q.questionForF2);
    speak(q.questionForF2, j, jHg?.gender);
    await cinematicWait({
      kicker: `Juror: ${nameOf(g, j)}`,
      title: `${nameOf(g, j)} turns to ${nameOf(g, opp)}:`,
      quote: `"${q.questionForF2}"`,
      bodyHtml: `<p><b>${nameOf(g, opp)}:</b> "${oppAnswer}"</p>`,
      continueLabel: jurors.indexOf(j) === jurors.length - 1 ? 'The Jury Votes' : 'Next Juror',
    });
    stopSpeaking();
    speak(oppAnswer, opp);
    qaByJuror[j] = { f1Answer: playerAnswer, f2Answer: oppAnswer };
    saveGame(g);
  }
  stopSpeaking();

  // Votes
  const votes = [];
  for (const j of jurors) {
    const v = await jurorVote(g, j, [PLAYER_ID, opp], qaByJuror[j]);
    votes.push({ juror: j, ...v });
  }

  // Reveal one by one
  await revealJuryVotes(votes, opp);
}

function revealJuryVotes(votes, opp) {
  return new Promise((resolve) => {
    setMood('tension');
    const need = Math.floor(votes.length / 2) + 1;
    const c = cinematic({
      kicker: 'The Jury Votes',
      title: `First to ${need} keys wins Big Brother.`,
      bodyHtml: `<div class="jury-tally"><div class="t" id="tally-you">You: 0</div><div class="t" id="tally-opp">${nameOf(g, opp)}: 0</div></div><div id="reveal-status"></div><div id="vote-cards"></div>`,
    });
    const cards = c.card.querySelector('#vote-cards');
    const statusEl = c.card.querySelector('#reveal-status');
    let youN = 0, oppN = 0, i = 0, decided = false, busyKey = false;

    function preLine() {
      if (youN === need - 1 && oppN === need - 1) return `${youN}–${oppN}. It all comes down to this key.`;
      if (youN === need - 1 || oppN === need - 1) return 'This key could seal it...';
      if (votes.length - i === 1) return 'The final key.';
      return '';
    }

    function next() {
      if (busyKey) return;
      if (i >= votes.length) return finish();
      busyKey = true;
      c.setActions([]);
      statusEl.textContent = preLine();
      const v = votes[i++];
      sting('reveal');
      const hg = g.houseguests.find((h) => h.id === v.juror);
      const card = document.createElement('div');
      card.className = 'jury-vote-card';
      card.innerHTML = `<span class="dot" style="background:#${hg.color.toString(16).padStart(6, '0')}"></span>
        <div><b>${hg.name}</b><div class="r">"${v.reasoning}"</div>
        <div class="key-line">votes for <b class="key-vote">…</b></div></div>`;
      cards.append(card);
      cards.scrollTop = cards.scrollHeight;
      speak(v.reasoning, v.juror, hg.gender);

      setTimeout(() => {
        card.querySelector('.key-vote').textContent = v.vote === PLAYER_ID ? 'YOU' : nameOf(g, v.vote);
        card.classList.add('revealed');
        if (v.vote === PLAYER_ID) youN++; else oppN++;
        const ty = c.card.querySelector('#tally-you');
        const to = c.card.querySelector('#tally-opp');
        ty.textContent = `You: ${youN}`;
        to.textContent = `${nameOf(g, opp)}: ${oppN}`;
        ty.classList.toggle('lead', youN >= oppN);
        to.classList.toggle('lead', oppN > youN);

        if (!decided && (youN >= need || oppN >= need)) {
          decided = true;
          sting(youN >= need ? 'win' : 'lose');
          statusEl.textContent = `That's ${need}. ${youN >= need ? 'YOU have' : nameOf(g, opp) + ' has'} won Big Brother!`;
        } else if (!decided) {
          statusEl.textContent = youN === oppN ? `Tied at ${youN}–${oppN}.` : '';
        }

        busyKey = false;
        c.setActions([{
          label: i >= votes.length ? 'Crown the Winner' : decided ? 'Reveal the Remaining Keys' : 'Pull the Next Key',
          style: 'gold',
          onClick: next,
        }]);
      }, 1300);
    }

    function finish() {
      setTimeout(() => {
        c.close();
        showWinner(youN > oppN ? PLAYER_ID : opp, youN, oppN, opp, votes);
        resolve();
      }, 400);
    }

    c.setActions([{ label: 'Pull the First Key', style: 'gold', onClick: next }]);
  });
}

function showWinner(winner, youN, oppN, opp, juryVoteList = []) {
  stopMusic();
  const won = winner === PLAYER_ID;
  sting(won ? 'win' : 'lose');
  if (won) confetti();

  const stats = buildSeasonStats(g, {
    result: won ? 'winner' : 'runner-up',
    place: won ? '1st' : '2nd',
    tally: { you: youN, opp: oppN, oppName: nameOf(g, opp) },
    juryVotes: juryVoteList.map((v) => {
      const hg = g.houseguests.find((h) => h.id === v.juror);
      return {
        name: hg.name,
        color: '#' + hg.color.toString(16).padStart(6, '0'),
        vote: v.vote === PLAYER_ID ? 'you' : nameOf(g, v.vote),
        reasoning: v.reasoning,
      };
    }),
  });
  archiveSeason(stats);

  const c = cinematic({
    kicker: 'Season Finale',
    title: won
      ? `🏆 By a vote of ${youN}–${oppN}, YOU are the winner of Big Brother!`
      : `By a vote of ${oppN}–${youN}, ${nameOf(g, opp)} wins Big Brother.`,
    bodyHtml: won
      ? `<p>$750,000. The jury respected your game — promises kept: ${g.promises.filter((p) => p.from === PLAYER_ID && p.status === 'kept').length}, promises broken: ${g.promises.filter((p) => p.from === PLAYER_ID && p.status === 'broken').length}.</p>`
      : `<p>Second place, $75,000. The jury had their reasons — ${oppN} of them.</p><p class="muted">Promises broken: ${g.promises.filter((p) => p.from === PLAYER_ID && p.status === 'broken').length}. The jury remembered.</p>`,
  });
  c.setActions([
    { label: '📊 Season Stats', style: 'primary', onClick: () => showStatsPage(stats) },
    { label: '🧠 Post-Game Analysis', style: 'primary', onClick: () => showAnalysis(stats) },
    { label: 'New Season', style: 'gold', onClick: () => { clearSave(); location.reload(); } },
  ]);
}
