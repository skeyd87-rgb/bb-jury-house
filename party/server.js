// Cloudflare Durable Object room server (partyserver) — the authoritative
// multiplayer game. Phase 1: lobby (seats, claim/release, host, start).
// One Durable Object instance = one room = one season.
//
// Client connects with party name "room" (kebab of the `Room` DO binding).

import { Server, routePartykitRequest } from 'partyserver';
import { CAST, PLAYER_ID } from '../src/game/cast.js';
import { newGame, activeIds, activeNpcIds, nameOf, logEvent } from '../src/game/state.js';
import {
  npcCompScore, decideNominations, applyNominations, vetoPlayers, decideVetoUse,
  decideReplacement, applyVetoSave, applyReplacement, applyVeto, evictionDesire,
  applyEviction, nextPhase, phaseLabel,
} from '../src/game/season.js';
import {
  simulateHouseLife, applyChatEffects, formOfficialAlliance, leaveAlliance, allianceWillingness,
} from '../src/game/social.js';
import { fallbackChat, fallbackDiary } from '../src/ai/fallback.js';
import {
  serverNpcChat, serverJurorQuestion, serverOpponentAnswer, serverJurorVote,
  serverGroupChat, serverDiaryChat,
} from './ai.js';

// Mirror of comps.js COMP_TYPES (kept here to avoid importing the DOM module).
const COMP_TYPES = ['timing', 'count', 'reaction'];
function randomCompType() {
  return COMP_TYPES[Math.floor(Math.random() * COMP_TYPES.length)];
}

// The 9 claimable houseguest seats: the 8 established cast + one "newcomer"
// seat (the single-player 'you' slot) whose occupant names their houseguest.
const SEAT_DEFS = [
  ...CAST.map((c) => ({ id: c.id, name: c.name, job: c.job, color: c.color, fixed: true })),
  { id: 'newcomer', name: 'Newcomer', job: 'Houseguest', color: 0xfafafa, fixed: false },
];

export class Room extends Server {
  constructor(ctx, env) {
    super(ctx, env);
    this.roomEnv = env;
    this.state = null;
    this.game = null;
    this.turn = null; // current interactive turn (comp/nominate/vote/etc.)
    this.connToPlayer = new Map(); // connId -> playerId
    this.playerTokens = {}; // playerId -> private reconnect token, never broadcast
  }

  async onStart() {
    this.state = (await this.ctx.storage.get('state')) || this.freshLobby();
    this.game = (await this.ctx.storage.get('game')) || null;
    this.turn = (await this.ctx.storage.get('turn')) || null;
    this.apiKey = (await this.ctx.storage.get('apiKey')) || null; // host's key, never broadcast
    this.playerTokens = (await this.ctx.storage.get('playerTokens')) || {};
  }

  // The host's own key if they gave one, else the operator's shared server
  // key (Phase 4.5.5) if configured, else null (engine fallback covers AI).
  get effectiveApiKey() {
    return this.apiKey || this.roomEnv?.ANTHROPIC_API_KEY || null;
  }

  async saveGame() {
    await this.ctx.storage.put('game', this.game);
    await this.ctx.storage.put('turn', this.turn);
  }

  async persistTokens() {
    await this.ctx.storage.put('playerTokens', this.playerTokens);
  }

  makePlayerToken() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Is a houseguest human-controlled?
  isHuman(engineId) {
    return !!(this.state.humanSeats && this.state.humanSeats[engineId]);
  }
  humanFor(engineId) {
    return this.state.humanSeats?.[engineId] || null;
  }
  // Human AND currently online — only these are prompted to act. A disconnected
  // human is played by AI until they reconnect (drop-in/out).
  isActiveHuman(engineId) {
    const pid = this.humanFor(engineId);
    return !!(pid && this.state.players[pid]?.online);
  }

  freshLobby() {
    const seats = {};
    for (const s of SEAT_DEFS) {
      seats[s.id] = { ...s, occupant: null, occupantName: null, connected: false };
    }
    return {
      code: this.name,
      phase: 'lobby', // 'lobby' | 'playing'
      hostPlayerId: null,
      seats,
      settings: { phaseSeconds: 1200 },
      players: {}, // playerId -> { name, seatId, online }
      humanSeats: {}, // engineHouseguestId -> playerId (who controls that houseguest)
    };
  }

  // Lobby seat id -> engine houseguest id. The 'newcomer' seat is the engine's
  // built-in 'you' slot; the 8 cast seats map to themselves.
  seatToEngineId(seatId) {
    return seatId === 'newcomer' ? PLAYER_ID : seatId;
  }

  projectState(viewerPid = null) {
    const s = this.state;
    const seats = {};
    for (const [id, seat] of Object.entries(s.seats || {})) {
      seats[id] = {
        id: seat.id,
        name: seat.name,
        job: seat.job,
        color: seat.color,
        fixed: seat.fixed,
        connected: !!seat.connected,
        occupantName: seat.occupantName,
        occupied: !!seat.occupant,
        mine: !!viewerPid && seat.occupant === viewerPid,
      };
    }
    return {
      code: s.code,
      phase: s.phase,
      settings: s.settings,
      startedAt: s.startedAt,
      aiPowered: s.aiPowered,
      seats,
      isHost: !!viewerPid && s.hostPlayerId === viewerPid,
      mySeatId: viewerPid ? (s.players?.[viewerPid]?.seatId || null) : null,
    };
  }

  projectTurn(viewerPid = null) {
    if (!this.turn) return null;
    const t = { ...this.turn };
    if (Array.isArray(this.turn.waitingOn)) {
      t.waitingOnCount = this.turn.waitingOn.length;
      t.waitingOnMe = !!viewerPid && this.turn.waitingOn.includes(viewerPid);
      t.waitingOn = t.waitingOnMe ? ['me'] : [];
    }
    return t;
  }

  // Render-safe projection of the authoritative game (no hidden social/memory
  // state — those stay server-side and are revealed only as the game dictates).
  // viewerEngineId, if given, adds a personalized slice: only that viewer's OWN
  // alliances and OWN open promises (never anyone else's — see invariant in
  // CLAUDE.md about not leaking hidden social state).
  projectGame(viewerEngineId = null, viewerPid = null) {
    const g = this.game;
    if (!g) return null;
    const humanSeats = Object.fromEntries(Object.keys(this.state.humanSeats || {}).map((id) => [id, true]));
    const base = {
      week: g.week,
      phase: g.phase,
      hoh: g.hoh,
      nominees: g.nominees,
      vetoHolder: g.vetoHolder,
      vetoUsed: g.vetoUsed,
      jury: g.jury,
      evicted: g.evicted,
      humanSeats,
      myEngineId: viewerEngineId || null,
      turn: this.projectTurn(viewerPid),
      houseguests: g.houseguests.map((h) => ({
        id: h.id,
        name: h.name,
        job: h.job,
        color: h.color,
        hair: h.hair,
        skin: h.skin,
        build: h.build,
        gender: h.gender,
        hairStyle: h.hairStyle,
      })),
    };
    if (viewerEngineId) {
      base.myAlliances = (g.alliances || [])
        .filter((a) => !a.dead && a.members.includes(viewerEngineId))
        .map((a) => ({ id: a.id, name: a.name, memberNames: a.members.filter((m) => m !== viewerEngineId).map((m) => nameOf(g, m)) }));
      base.myPromises = (g.promises || [])
        .filter((p) => p.status === 'open' && (p.from === viewerEngineId || p.to === viewerEngineId))
        .map((p) => ({
          text: p.text, kind: p.kind,
          withName: nameOf(g, p.from === viewerEngineId ? p.to : p.from),
          direction: p.from === viewerEngineId ? 'made' : 'received',
        }));
    }
    return base;
  }

  broadcastGame() {
    const g = this.game;
    if (!g) return;
    const spectatorPayload = JSON.stringify({ type: 'game', game: this.projectGame() });
    for (const c of this.getConnections()) {
      const pid = this.connToPlayer.get(c.id);
      const engineId = pid ? this.engineForPlayer(pid) : null;
      c.send(engineId ? JSON.stringify({ type: 'game', game: this.projectGame(engineId, pid) }) : spectatorPayload);
    }
  }

  async commit() {
    await this.saveGame();
    await this.persist();
    this.broadcastGame();
  }

  // ---- Season machine -------------------------------------------------------
  // The authoritative week loop. Human-controlled houseguests are prompted to
  // act (comp scores, noms, veto, votes); AI houseguests are resolved via the
  // shared engine. `this.turn` tells clients what (if anything) they must do.

  // Player ids for the ONLINE humans among these houseguests (who must act).
  humanPlayersAmong(ids) {
    return ids.filter((id) => this.isActiveHuman(id)).map((id) => this.humanFor(id));
  }

  async setTurn(turn) {
    this.turn = turn;
    this.applyTurnTimer();
    await this.commit();
  }

  // Stamps the current turn with a deadline (so clients can show a countdown)
  // and (re)schedules the Durable Object alarm that force-resolves it.
  applyTurnTimer() {
    if (!this.turn) return;
    const secs = this.turnTimerSeconds();
    if (secs > 0) this.turn.turnDeadline = Date.now() + secs * 1000;
    else delete this.turn.turnDeadline;
    this.scheduleTurnTimer();
  }

  async beginSeason() {
    await this.enterWeekIntro();
  }

  async enterWeekIntro() {
    const g = this.game;
    g.phase = 'week_intro';
    await this.setTurn({
      kind: 'intro',
      week: g.week,
      message: g.week === 1
        ? 'Welcome to the jury phase. 9 houseguests, every vote counts.'
        : `Week ${g.week}. ${activeIds(g).length} remain.`,
    });
  }

  async enterHohComp() {
    const g = this.game;
    g.phase = 'hoh_comp';
    const outgoing = g.lastHoh && !g.evicted.includes(g.lastHoh) ? g.lastHoh : null;
    const players = activeIds(g).filter((id) => id !== outgoing);
    await this.beginComp('hoh', players);
  }

  async enterVetoComp() {
    const g = this.game;
    g.phase = 'veto_comp';
    await this.beginComp('veto', vetoPlayers(g));
  }

  async beginComp(comp, players) {
    const g = this.game;
    const compType = randomCompType();
    const scores = {};
    for (const id of players) if (!this.isActiveHuman(id)) scores[id] = Math.round(npcCompScore(g, id));
    const waitingOn = this.humanPlayersAmong(players);
    this.turn = { kind: 'comp', comp, compType, players, scores, waitingOn };
    this.applyTurnTimer();
    if (waitingOn.length === 0) return this.resolveComp();
    await this.commit();
  }

  async submitCompScore(pid, score) {
    const t = this.turn;
    if (!t || t.kind !== 'comp') return;
    const engineId = this.engineForPlayer(pid);
    if (!engineId || !t.players.includes(engineId)) return;
    if (t.scores[engineId] != null && !t.waitingOn.includes(pid)) return;
    t.scores[engineId] = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
    t.waitingOn = t.waitingOn.filter((p) => p !== pid);
    if (t.waitingOn.length === 0) return this.resolveComp();
    await this.commit();
  }

  async resolveComp() {
    const g = this.game;
    const t = this.turn;
    const winner = t.players.slice().sort((a, b) => (t.scores[b] || 0) - (t.scores[a] || 0))[0];
    const board = t.players
      .map((id) => ({ id, name: nameOf(g, id), score: t.scores[id] || 0 }))
      .sort((a, b) => b.score - a.score);
    if (t.comp === 'hoh') {
      g.hoh = winner;
      logEvent(g, 'hoh', `${nameOf(g, winner)} won HoH.`, [winner]);
    } else {
      g.vetoHolder = winner;
      logEvent(g, 'veto_win', `${nameOf(g, winner)} won the Power of Veto.`, [winner]);
    }
    g.compHistory.push({ week: g.week, type: t.comp, winner, scores: t.scores });
    await this.setTurn({ kind: 'comp_result', comp: t.comp, winner, winnerName: nameOf(g, winner), board });
  }

  async enterNominations() {
    const g = this.game;
    g.phase = 'nominations';
    const hoh = g.hoh;
    if (this.isActiveHuman(hoh)) {
      await this.setTurn({ kind: 'nominate', actor: hoh, actorName: nameOf(g, hoh), waitingOn: [this.humanFor(hoh)] });
    } else {
      const noms = decideNominations(g, hoh);
      applyNominations(g, hoh, noms);
      await this.setTurn({ kind: 'noms_result', hoh, nominees: noms.slice(), names: noms.map((n) => nameOf(g, n)) });
    }
  }

  async submitNominations(pid, ids) {
    const g = this.game;
    const t = this.turn;
    if (!t || t.kind !== 'nominate') return;
    if (this.humanFor(g.hoh) !== pid) return;
    ids = (ids || []).filter((id) => activeIds(g).includes(id) && id !== g.hoh);
    if (new Set(ids).size !== 2) return;
    applyNominations(g, g.hoh, ids);
    await this.setTurn({ kind: 'noms_result', hoh: g.hoh, nominees: ids.slice(), names: ids.map((n) => nameOf(g, n)) });
  }

  async enterVetoCeremony() {
    const g = this.game;
    g.phase = 'veto_ceremony';
    const holder = g.vetoHolder;
    if (this.isActiveHuman(holder)) {
      await this.setTurn({ kind: 'veto_decision', actor: holder, actorName: nameOf(g, holder), nominees: g.nominees.slice(), names: g.nominees.map((n) => nameOf(g, n)), isHoh: holder === g.hoh });
    } else {
      const d = decideVetoUse(g, holder);
      if (d.use) {
        applyVetoSave(g, holder, d.savedId);
        await this.enterReplacement(d.savedId, holder);
      } else {
        applyVeto(g, holder, false);
        await this.setTurn({ kind: 'veto_result', used: false, holder });
      }
    }
  }

  async submitVetoDecision(pid, use, savedId) {
    const g = this.game;
    const t = this.turn;
    if (!t || t.kind !== 'veto_decision') return;
    if (this.humanFor(g.vetoHolder) !== pid) return;
    if (use) {
      if (!g.nominees.includes(savedId)) return;
      applyVetoSave(g, g.vetoHolder, savedId);
      await this.enterReplacement(savedId, g.vetoHolder);
    } else {
      applyVeto(g, g.vetoHolder, false);
      await this.setTurn({ kind: 'veto_result', used: false, holder: g.vetoHolder });
    }
  }

  async enterReplacement(savedId, holder) {
    const g = this.game;
    if (this.isActiveHuman(g.hoh)) {
      await this.setTurn({ kind: 'replacement', actor: g.hoh, actorName: nameOf(g, g.hoh), savedId, savedName: nameOf(g, savedId) });
    } else {
      const repl = decideReplacement(g, g.hoh, [...g.nominees, savedId, holder]);
      applyReplacement(g, repl);
      await this.setTurn({ kind: 'veto_result', used: true, savedId, savedName: nameOf(g, savedId), replacement: repl, replacementName: nameOf(g, repl), holder });
    }
  }

  async submitReplacement(pid, id) {
    const g = this.game;
    const t = this.turn;
    if (!t || t.kind !== 'replacement') return;
    if (this.humanFor(g.hoh) !== pid) return;
    if (!activeIds(g).includes(id) || g.nominees.includes(id) || id === g.hoh || id === t.savedId) return;
    applyReplacement(g, id);
    await this.setTurn({ kind: 'veto_result', used: true, savedId: t.savedId, savedName: t.savedName, replacement: id, replacementName: nameOf(g, id), holder: g.vetoHolder });
  }

  async enterEviction() {
    const g = this.game;
    g.phase = 'eviction';
    const [n1, n2] = g.nominees;
    const voters = activeIds(g).filter((id) => id !== g.hoh && !g.nominees.includes(id));
    const votes = {};
    for (const v of voters) if (!this.isActiveHuman(v)) votes[v] = evictionDesire(g, v, n1, n2) >= 0 ? n1 : n2;
    const waitingOn = this.humanPlayersAmong(voters);
    this.turn = { kind: 'vote', nominees: [n1, n2], names: [nameOf(g, n1), nameOf(g, n2)], voters, votes, waitingOn };
    this.applyTurnTimer();
    if (waitingOn.length === 0) return this.resolveEviction();
    await this.commit();
  }

  async submitVote(pid, target) {
    const g = this.game;
    const t = this.turn;
    if (!t || t.kind !== 'vote') return;
    const engineId = this.engineForPlayer(pid);
    if (!engineId || !t.voters.includes(engineId)) return;
    if (!t.nominees.includes(target)) return;
    t.votes[engineId] = target;
    t.waitingOn = t.waitingOn.filter((p) => p !== pid);
    if (t.waitingOn.length === 0) return this.resolveEviction();
    await this.commit();
  }

  async resolveEviction() {
    const g = this.game;
    const t = this.turn;
    const [n1, n2] = t.nominees;
    const tally = { [n1]: 0, [n2]: 0 };
    for (const tgt of Object.values(t.votes)) tally[tgt]++;
    let evicted;
    if (tally[n1] === tally[n2]) {
      // HoH breaks ties (AI HoH decides via engine; a human HoH tie is rare here
      // and also resolved by engine lean for the one-pass build).
      evicted = evictionDesire(g, g.hoh, n1, n2) >= 0 ? n1 : n2;
    } else {
      evicted = tally[n1] > tally[n2] ? n1 : n2;
    }
    applyEviction(g, evicted, { ...t.votes });
    g.voteHistory.push({ week: g.week, evicted, votes: { ...t.votes } });
    await this.setTurn({
      kind: 'eviction_result', evicted, evictedName: nameOf(g, evicted),
      tally: { [nameOf(g, n1)]: tally[n1], [nameOf(g, n2)]: tally[n2] },
      votes: Object.fromEntries(Object.entries(t.votes).map(([v, tg]) => [nameOf(g, v), nameOf(g, tg)])),
    });
  }

  async advanceWeek() {
    const g = this.game;
    if (activeIds(g).length <= 3) return this.enterFinal3();
    simulateHouseLife(g);
    g.week++;
    g.lastHoh = g.hoh;
    g.hoh = null;
    g.nominees = [];
    g.vetoHolder = null;
    g.vetoUsed = null;
    await this.enterWeekIntro();
  }

  async enterFinal3() {
    const g = this.game;
    g.phase = 'final3';
    await this.setTurn({ kind: 'final3_intro', three: activeIds(g).map((id) => nameOf(g, id)) });
  }

  async enterFinalHoh() {
    const g = this.game;
    g.phase = 'final_hoh';
    await this.beginComp('final_hoh', activeIds(g));
  }

  async enterFinalCut(finalHoh) {
    const g = this.game;
    const others = activeIds(g).filter((id) => id !== finalHoh);
    if (this.isActiveHuman(finalHoh)) {
      await this.setTurn({ kind: 'final_cut', actor: finalHoh, actorName: nameOf(g, finalHoh), others, names: others.map((o) => nameOf(g, o)) });
    } else {
      const cut = evictionDesire(g, finalHoh, others[0], others[1]) >= 0 ? others[0] : others[1];
      await this.doFinalCut(finalHoh, cut);
    }
  }

  async submitFinalCut(pid, cutId) {
    const g = this.game;
    const t = this.turn;
    if (!t || t.kind !== 'final_cut') return;
    if (this.humanFor(t.actor) !== pid) return;
    if (!t.others.includes(cutId)) return;
    await this.doFinalCut(t.actor, cutId);
  }

  async doFinalCut(finalHoh, cut) {
    const g = this.game;
    if (g.memory[cut]) g.memory[cut].grudges.push({ againstId: finalHoh, reason: 'cut me at the Final 3', week: g.week, severity: 3 });
    applyEviction(g, cut, {});
    await this.setTurn({ kind: 'final_cut_result', finalHoh, finalHohName: nameOf(g, finalHoh), cut, cutName: nameOf(g, cut) });
  }

  // ---- Interactive jury Q&A (Phase 5a) -------------------------------------
  // One question -> both finalists answer -> juror votes, repeated per juror.
  // Any of the three roles (juror, finalist A, finalist B) may be human or AI,
  // in any combination. `g.juryPhase` accumulates votes across the sequence.

  async enterFinale() {
    const g = this.game;
    g.phase = 'finale';
    const finalists = activeIds(g);
    const jurors = g.jury.slice(-7);
    g.juryPhase = { finalists, jurors, idx: 0, votes: [] };
    await this.enterJurorQuestion();
  }

  async enterJurorQuestion() {
    const g = this.game;
    const jp = g.juryPhase;
    if (jp.idx >= jp.jurors.length) return this.finishJury();
    const juror = jp.jurors[jp.idx];
    const finalists = jp.finalists;
    if (this.isActiveHuman(juror)) {
      await this.setTurn({
        kind: 'jury_question', juror, jurorName: nameOf(g, juror), finalists,
        finalistNames: finalists.map((f) => nameOf(g, f)), waitingOn: [this.humanFor(juror)],
      });
    } else {
      const q = await serverJurorQuestion(g, juror, finalists, this.effectiveApiKey);
      await this.beginJurorAnswer(juror, finalists, q.questionForF1, q.questionForF2, q.toneNote);
    }
  }

  async submitJurorQuestion(pid, text) {
    const g = this.game;
    const t = this.turn;
    if (!t || t.kind !== 'jury_question') return;
    if (this.humanFor(t.juror) !== pid) return;
    const q = String(text || '').slice(0, 300) || 'What was your best move, and why does it beat the other side of this final two?';
    await this.beginJurorAnswer(t.juror, t.finalists, q, q, 'measured');
  }

  async beginJurorAnswer(juror, finalists, qF1, qF2, toneNote) {
    const g = this.game;
    const [f1, f2] = finalists;
    const answers = {};
    const waitingOn = [];
    for (const [fid, q] of [[f1, qF1], [f2, qF2]]) {
      if (this.isActiveHuman(fid)) waitingOn.push(this.humanFor(fid));
      else answers[fid] = (await serverOpponentAnswer(g, fid, juror, q, this.effectiveApiKey)).reply;
    }
    this.turn = {
      kind: 'jury_answer', juror, jurorName: nameOf(g, juror), finalists,
      questions: { [f1]: qF1, [f2]: qF2 }, toneNote, answers, waitingOn,
    };
    this.applyTurnTimer();
    if (waitingOn.length === 0) return this.resolveJurorAnswer();
    await this.commit();
  }

  async submitJurorAnswer(pid, text) {
    const g = this.game;
    const t = this.turn;
    if (!t || t.kind !== 'jury_answer') return;
    const engineId = this.engineForPlayer(pid);
    if (!engineId || !t.finalists.includes(engineId)) return;
    if (t.answers[engineId] != null && !t.waitingOn.includes(pid)) return;
    t.answers[engineId] = String(text || '').slice(0, 500) || "I stand by how I played this game.";
    t.waitingOn = t.waitingOn.filter((p) => p !== pid);
    if (t.waitingOn.length === 0) return this.resolveJurorAnswer();
    await this.commit();
  }

  async resolveJurorAnswer() {
    const g = this.game;
    const t = this.turn;
    await this.setTurn({
      kind: 'jury_answer_result', juror: t.juror, jurorName: t.jurorName, finalists: t.finalists,
      questions: t.questions, answers: t.answers, toneNote: t.toneNote,
    });
  }

  async enterJurorVote() {
    const g = this.game;
    const t = this.turn; // the jury_answer_result we just showed
    const juror = t.juror;
    const finalists = t.finalists;
    if (this.isActiveHuman(juror)) {
      await this.setTurn({
        kind: 'jury_vote', juror, jurorName: nameOf(g, juror), finalists,
        finalistNames: finalists.map((f) => nameOf(g, f)), questions: t.questions, answers: t.answers,
        waitingOn: [this.humanFor(juror)],
      });
    } else {
      const qa = { f1Answer: t.answers[finalists[0]], f2Answer: t.answers[finalists[1]] };
      const v = await serverJurorVote(g, juror, finalists, qa, this.effectiveApiKey);
      await this.recordJurorVote(juror, finalists, v.vote, v.reasoning);
    }
  }

  async submitJurorVote(pid, vote, reasoning) {
    const g = this.game;
    const t = this.turn;
    if (!t || t.kind !== 'jury_vote') return;
    if (this.humanFor(t.juror) !== pid) return;
    if (!t.finalists.includes(vote)) return;
    await this.recordJurorVote(t.juror, t.finalists, vote, String(reasoning || '').slice(0, 300) || 'That is my vote.');
  }

  async recordJurorVote(juror, finalists, vote, reasoning) {
    const g = this.game;
    g.juryPhase.votes.push({ juror, jurorName: nameOf(g, juror), vote, voteName: nameOf(g, vote), reasoning });
    await this.setTurn({ kind: 'jury_vote_result', juror, jurorName: nameOf(g, juror), vote, voteName: nameOf(g, vote), reasoning });
  }

  async finishJury() {
    const g = this.game;
    const { finalists, votes } = g.juryPhase;
    let a = 0, b = 0;
    for (const v of votes) if (v.vote === finalists[0]) a++; else b++;
    const winner = a >= b ? finalists[0] : finalists[1];
    await this.setTurn({
      kind: 'winner',
      finalists, finalistNames: finalists.map((f) => nameOf(g, f)),
      votes, tally: { [nameOf(g, finalists[0])]: a, [nameOf(g, finalists[1])]: b },
      winner, winnerName: nameOf(g, winner),
      stats: this.buildOnlineStats(),
    });
  }

  // Post-game summary — the season is over, so the no-hidden-state invariant
  // no longer applies; every player sees the same full recap.
  buildOnlineStats() {
    const g = this.game;
    return {
      weeks: g.week,
      compRecord: (g.compHistory || []).map((c) => ({ week: c.week, type: c.type, winner: nameOf(g, c.winner) })),
      evictionOrder: g.evicted.map((id) => nameOf(g, id)),
      promisesKept: (g.promises || []).filter((p) => p.status === 'kept').length,
      promisesBroken: (g.promises || []).filter((p) => p.status === 'broken').length,
      alliancesFormed: (g.alliances || []).length,
    };
  }

  // Host (or the sole actor) advances a result/intro screen to the next phase.
  async advanceTurn(pid) {
    if (pid !== this.state.hostPlayerId) return; // host drives result/intro pacing
    return this.advanceResultTurn();
  }

  async advanceResultTurn() {
    const t = this.turn;
    if (!t) return;
    switch (t.kind) {
      case 'intro': return this.enterHohComp();
      case 'comp_result':
        if (t.comp === 'hoh') return this.enterSocial('nominations', 'Work the house before nominations.');
        if (t.comp === 'veto') return this.enterVetoCeremony();
        if (t.comp === 'final_hoh') return this.enterFinalCut(t.winner);
        return;
      case 'noms_result': return this.enterSocial('veto_comp', 'Campaign and scheme before the veto.');
      case 'veto_result': return this.enterSocial('eviction', 'Last chance to lock in votes before eviction.');
      case 'eviction_result': return this.advanceWeek();
      case 'final3_intro': return this.enterFinalHoh();
      case 'final_cut_result': return this.enterFinale();
      case 'jury_answer_result': return this.enterJurorVote();
      case 'jury_vote_result':
        this.game.juryPhase.idx++;
        return this.enterJurorQuestion();
      case 'social':
        if (t.next === 'nominations') return this.enterNominations();
        if (t.next === 'veto_comp') return this.enterVetoComp();
        if (t.next === 'eviction') return this.enterEviction();
        return;
      default: return;
    }
  }

  // Free-roam social window — everyone walks the house and talks; the host
  // advances when the room is ready.
  async enterSocial(next, label) {
    this.game.phase = next === 'nominations' ? 'social_hoh' : next === 'veto_comp' ? 'social_veto' : 'campaigning';
    await this.setTurn({ kind: 'social', next, label });
  }

  // ---- Drop-in/out + timers (Phase 4) --------------------------------------
  // AI covers absent humans so the season never stalls.

  // Fill ALL outstanding human actions in the current turn with AI decisions
  // and resolve it. Used by the host "skip" button and the phase timer.
  async forceResolveTurn() {
    const g = this.game;
    const t = this.turn;
    if (!t) return;
    switch (t.kind) {
      case 'comp':
        for (const id of t.players) if (t.scores[id] == null) t.scores[id] = Math.round(npcCompScore(g, id));
        t.waitingOn = [];
        return this.resolveComp();
      case 'nominate': {
        const noms = decideNominations(g, g.hoh);
        applyNominations(g, g.hoh, noms);
        return this.setTurn({ kind: 'noms_result', hoh: g.hoh, nominees: noms.slice(), names: noms.map((n) => nameOf(g, n)) });
      }
      case 'veto_decision': {
        const d = decideVetoUse(g, g.vetoHolder);
        if (d.use) { applyVetoSave(g, g.vetoHolder, d.savedId); return this.enterReplacement(d.savedId, g.vetoHolder); }
        applyVeto(g, g.vetoHolder, false);
        return this.setTurn({ kind: 'veto_result', used: false, holder: g.vetoHolder });
      }
      case 'replacement': {
        const repl = decideReplacement(g, g.hoh, [...g.nominees, t.savedId, g.vetoHolder]);
        applyReplacement(g, repl);
        return this.setTurn({ kind: 'veto_result', used: true, savedId: t.savedId, savedName: t.savedName, replacement: repl, replacementName: nameOf(g, repl), holder: g.vetoHolder });
      }
      case 'vote':
        for (const v of t.voters) if (t.votes[v] == null) t.votes[v] = evictionDesire(g, v, t.nominees[0], t.nominees[1]) >= 0 ? t.nominees[0] : t.nominees[1];
        t.waitingOn = [];
        return this.resolveEviction();
      case 'final_cut': {
        const cut = evictionDesire(g, t.actor, t.others[0], t.others[1]) >= 0 ? t.others[0] : t.others[1];
        return this.doFinalCut(t.actor, cut);
      }
      case 'jury_question': {
        const q = await serverJurorQuestion(g, t.juror, t.finalists, this.effectiveApiKey);
        return this.beginJurorAnswer(t.juror, t.finalists, q.questionForF1, q.questionForF2, q.toneNote);
      }
      case 'jury_answer': {
        for (const fid of t.finalists) {
          if (t.answers[fid] == null) t.answers[fid] = (await serverOpponentAnswer(g, fid, t.juror, t.questions[fid], this.effectiveApiKey)).reply;
        }
        t.waitingOn = [];
        return this.resolveJurorAnswer();
      }
      case 'jury_vote': {
        const qa = { f1Answer: t.answers[t.finalists[0]], f2Answer: t.answers[t.finalists[1]] };
        const v = await serverJurorVote(g, t.juror, t.finalists, qa, this.effectiveApiKey);
        return this.recordJurorVote(t.juror, t.finalists, v.vote, v.reasoning);
      }
      default:
        return this.advanceResultTurn(); // result/intro screens just advance
    }
  }

  // A specific disconnected houseguest's pending action is filled by AI.
  async coverDisconnected(engineId) {
    const g = this.game;
    const t = this.turn;
    if (!t) return;
    if (t.kind === 'comp' && t.players.includes(engineId) && t.scores[engineId] == null) {
      t.scores[engineId] = Math.round(npcCompScore(g, engineId));
      t.waitingOn = t.waitingOn.filter((p) => p !== this.humanFor(engineId));
      if (t.waitingOn.length === 0) return this.resolveComp();
      return this.commit();
    }
    if (t.kind === 'vote' && t.voters.includes(engineId) && t.votes[engineId] == null) {
      t.votes[engineId] = evictionDesire(g, engineId, t.nominees[0], t.nominees[1]) >= 0 ? t.nominees[0] : t.nominees[1];
      t.waitingOn = t.waitingOn.filter((p) => p !== this.humanFor(engineId));
      if (t.waitingOn.length === 0) return this.resolveEviction();
      return this.commit();
    }
    // Single-actor turns: if the actor left, AI decides.
    if (['nominate', 'veto_decision', 'replacement', 'final_cut'].includes(t.kind) && t.actor === engineId) {
      return this.forceResolveTurn();
    }
    if (t.kind === 'jury_question' && t.juror === engineId) {
      return this.forceResolveTurn();
    }
    if (t.kind === 'jury_answer' && t.finalists.includes(engineId) && t.answers[engineId] == null) {
      t.answers[engineId] = (await serverOpponentAnswer(g, engineId, t.juror, t.questions[engineId], this.effectiveApiKey)).reply;
      t.waitingOn = t.waitingOn.filter((p) => p !== this.humanFor(engineId));
      if (t.waitingOn.length === 0) return this.resolveJurorAnswer();
      return this.commit();
    }
    if (t.kind === 'jury_vote' && t.juror === engineId) {
      return this.forceResolveTurn();
    }
  }

  // Duration (seconds) before the phase timer auto-covers absent players.
  turnTimerSeconds() {
    const t = this.turn;
    if (!t) return 0;
    if (['comp', 'nominate', 'veto_decision', 'replacement', 'vote', 'final_cut', 'jury_question', 'jury_answer', 'jury_vote'].includes(t.kind)) {
      return this.state.settings.phaseSeconds || 1200;
    }
    return 180; // result/intro screens auto-advance if the host is away
  }

  scheduleTurnTimer() {
    const secs = this.turnTimerSeconds();
    if (secs > 0) this.ctx.storage.setAlarm(Date.now() + secs * 1000);
  }

  async alarm() {
    // Timer fired: cover any absent humans / advance a stalled screen.
    if (this.state?.phase === 'playing' && this.turn) {
      await this.forceResolveTurn();
    }
  }

  engineForPlayer(pid) {
    const hs = this.state.humanSeats || {};
    for (const [engineId, p] of Object.entries(hs)) if (p === pid) return engineId;
    return null;
  }

  // ---- Social chat (Phase 3) -----------------------------------------------

  sanitizeChatEffects(raw) {
    const e = raw && typeof raw === 'object' ? raw : {};
    const ids = this.game.houseguests.map((h) => h.id);
    const KINDS = ['safety', 'vote', 'final2', 'alliance', 'vote_evict', 'info'];
    const SIGNALS = ['none', 'propose', 'accept'];
    return {
      trustDelta: e.trustDelta ?? 0,
      bondDelta: e.bondDelta ?? 0,
      threatDelta: e.threatDelta ?? 0,
      promiseMade: e.promiseMade && e.promiseMade.text
        ? {
            text: String(e.promiseMade.text),
            kind: KINDS.includes(e.promiseMade.kind) ? e.promiseMade.kind : 'safety',
            targetId: ids.includes(e.promiseMade.targetId) ? e.promiseMade.targetId : null,
            protectedIds: Array.isArray(e.promiseMade.protectedIds) ? e.promiseMade.protectedIds.filter((id) => ids.includes(id)) : [],
          }
        : null,
      allianceSignal: SIGNALS.includes(e.allianceSignal) ? e.allianceSignal : 'none',
      suspicionOfLie: !!e.suspicionOfLie,
      secretShared: e.secretShared ? String(e.secretShared) : null,
      targetDiscussed: ids.includes(e.targetDiscussed) ? e.targetDiscussed : null,
      allianceProposal: e.allianceProposal && typeof e.allianceProposal === 'object'
        ? { accepted: !!e.allianceProposal.accepted, name: e.allianceProposal.name ? String(e.allianceProposal.name).slice(0, 40) : null, memberIds: Array.isArray(e.allianceProposal.memberIds) ? e.allianceProposal.memberIds.filter((id) => ids.includes(id)) : [] }
        : null,
      summary: e.summary ? String(e.summary).slice(0, 200) : null,
    };
  }

  // Human-human 1-on-1 history, kept SEPARATE from g.mpThreads (which is
  // fixed to a single human's "you"/"them" perspective and feeds AI prompt
  // building — ambiguous once both sides of a conversation are humans).
  // Keyed by the unordered pair so either side's client sees the same log
  // regardless of who opened it or which direction sent last.
  humanThreadKey(a, b) {
    return [a, b].sort().join(':');
  }

  async handleChat(chatterId, targetId, text, connection) {
    const g = this.game;
    if (!g || !text) return;
    if (!activeIds(g).includes(targetId) || targetId === chatterId) return;

    // Human target: relay the message to them (they reply from their own chat).
    if (this.isHuman(targetId)) {
      if (!g.mpHumanThreads) g.mpHumanThreads = {};
      const hKey = this.humanThreadKey(chatterId, targetId);
      const hThread = g.mpHumanThreads[hKey] || (g.mpHumanThreads[hKey] = []);
      hThread.push({ from: chatterId, text });
      if (hThread.length > 40) g.mpHumanThreads[hKey] = hThread.slice(-40);
      const payload = JSON.stringify({ type: 'chatMsg', from: chatterId, fromName: nameOf(g, chatterId), text });
      for (const c of this.getConnections()) {
        if (this.connToPlayer.get(c.id) === this.humanFor(targetId)) c.send(payload);
      }
      connection.send(JSON.stringify({ type: 'chatReply', npcId: targetId, text: null, relayed: true }));
      await this.saveGame();
      return;
    }

    if (!g.mpThreads) g.mpThreads = {};
    const key = chatterId + ':' + targetId;
    const thread = g.mpThreads[key] || (g.mpThreads[key] = []);
    thread.push({ who: 'you', text });

    // AI target: Claude (if key) or the built-in engine, effects applied server-side.
    let result;
    try {
      result = await serverNpcChat(g, targetId, text, chatterId, thread, this.effectiveApiKey);
    } catch {
      result = { ...fallbackChat(g, targetId, text, chatterId), usedAi: false };
    }
    const reply = String(result.reply || '…').slice(0, 600);
    const fx = this.sanitizeChatEffects(result.effects);
    applyChatEffects(g, targetId, text, fx, chatterId);
    if (fx.summary) {
      g.memory[targetId].convoSummaries.push({ withId: chatterId, week: g.week, summary: fx.summary });
      g.memory[targetId].convoSummaries = g.memory[targetId].convoSummaries.slice(-20);
    }
    thread.push({ who: 'them', text: reply });
    if (thread.length > 24) g.mpThreads[key] = thread.slice(-24);
    await this.saveGame();
    this.broadcastGame(); // in case effects touched alliances/promises (personalized panels)
    connection.send(JSON.stringify({
      type: 'chatReply', npcId: targetId, text: reply, usedAi: !!result.usedAi,
      note: fx.promiseMade ? `📋 Promise recorded: "${fx.promiseMade.text}"`
        : (fx.allianceProposal?.accepted || fx.allianceSignal === 'accept') ? `🤝 ${nameOf(g, targetId)} is in.`
        : fx.suspicionOfLie ? `👀 ${nameOf(g, targetId)} didn't seem to buy that…` : null,
    }));
  }

  // ---- Group conversations, alliances, diary (Phase 5b/5c) -----------------

  sendToPid(pid, obj) {
    const payload = JSON.stringify(obj);
    for (const c of this.getConnections()) {
      if (this.connToPlayer.get(c.id) === pid) c.send(payload);
    }
  }

  sendToEngine(engineId, obj) {
    const pid = this.humanFor(engineId);
    if (pid) this.sendToPid(pid, obj);
  }

  async handleStartGroup(pid, memberIds, isHouseMeeting) {
    const g = this.game;
    if (!g) return;
    const founder = this.engineForPlayer(pid);
    if (!founder) return;
    const ids = activeIds(g).filter((id) => id !== founder && memberIds.includes(id));
    if (ids.length < (isHouseMeeting ? 1 : 2)) return;
    if (!g.mpGroups) g.mpGroups = {};
    const groupId = 'grp' + (Object.keys(g.mpGroups).length + 1) + '_' + g.week;
    const members = [founder, ...ids];
    g.mpGroups[groupId] = { id: groupId, members, founder, isHouseMeeting: !!isHouseMeeting, log: [] };
    if (isHouseMeeting) logEvent(g, 'house_meeting', `${nameOf(g, founder)} called a house meeting.`, ids);
    const payload = {
      type: 'groupStart', groupId, members, memberNames: members.map((m) => nameOf(g, m)),
      founder, founderName: nameOf(g, founder), isHouseMeeting: !!isHouseMeeting,
    };
    for (const m of members) if (this.isHuman(m)) this.sendToEngine(m, payload);
    await this.saveGame();
  }

  async handleGroupMsg(pid, groupId, text) {
    const g = this.game;
    const grp = g?.mpGroups?.[groupId];
    if (!grp || !text) return;
    const senderId = this.engineForPlayer(pid);
    if (!senderId || !grp.members.includes(senderId)) return;

    // Whisper: /whisper <name> <msg> — only that member truly hears it, but the
    // rest of the group notices the huddle (matches the single-player mechanic).
    const wm = text.match(/^\/(?:whisper|w)\s+(\S+)\s+([\s\S]+)/i);
    if (wm) {
      const targetId = grp.members.find((id) => id !== senderId && nameOf(g, id).toLowerCase() === wm[1].toLowerCase());
      if (!targetId) {
        this.sendToPid(pid, { type: 'groupSystem', groupId, text: `(No one named "${wm[1]}" is in this group.)` });
        return;
      }
      const secret = wm[2];
      for (const m of grp.members) if (this.isHuman(m)) this.sendToEngine(m, { type: 'groupMsg', groupId, id: senderId, name: nameOf(g, senderId), text: `🤫 (whispers to ${nameOf(g, targetId)}) ${secret}` });
      let whisperReply = null;
      if (this.isHuman(targetId)) {
        this.sendToEngine(targetId, { type: 'groupWhisper', groupId, from: senderId, fromName: nameOf(g, senderId), text: secret });
      } else {
        const r = await serverNpcChat(g, targetId, secret, senderId, [], this.effectiveApiKey);
        whisperReply = String(r.reply || '…').slice(0, 400);
        const fx = this.sanitizeChatEffects(r.effects);
        applyChatEffects(g, targetId, secret, fx, senderId);
        for (const m of grp.members) if (this.isHuman(m)) this.sendToEngine(m, { type: 'groupMsg', groupId, id: targetId, name: nameOf(g, targetId), text: `🤫 ${whisperReply}`, usedAi: !!r.usedAi });
      }
      // Everyone else clocks the whispering.
      for (const id of grp.members) {
        if (id === senderId || id === targetId || !g.social[id]?.[senderId]) continue;
        g.social[id][senderId].threat = Math.min(100, g.social[id][senderId].threat + 5);
        g.social[id][senderId].trust = Math.max(0, g.social[id][senderId].trust - 3);
        g.memory[id]?.gossipHeard.push({
          text: `caught ${nameOf(g, senderId)} whispering with ${nameOf(g, targetId)} in a group — didn't like it`,
          aboutId: senderId, fromId: id, week: g.week, believed: true,
        });
        if (this.isHuman(id)) this.sendToEngine(id, { type: 'groupSystem', groupId, text: `🤫 You noticed ${nameOf(g, senderId)} whispering to ${nameOf(g, targetId)}.` });
      }
      await this.saveGame();
      return;
    }

    grp.log.push({ who: 'you', id: senderId, text });
    for (const m of grp.members) if (this.isHuman(m)) this.sendToEngine(m, { type: 'groupMsg', groupId, id: senderId, name: nameOf(g, senderId), text });

    const aiMembers = grp.members.filter((m) => !this.isHuman(m));
    let result;
    try {
      result = await serverGroupChat(g, aiMembers, senderId, text, grp.log, this.effectiveApiKey);
    } catch {
      result = null;
    }
    if (!result || !Array.isArray(result.replies)) return;

    const replies = result.replies.filter((r) => aiMembers.includes(r.id) && r.reply).slice(0, 3);
    for (const r of replies) {
      const reply = String(r.reply).slice(0, 400);
      grp.log.push({ who: 'them', id: r.id, text: reply });
      for (const m of grp.members) if (this.isHuman(m)) this.sendToEngine(m, { type: 'groupMsg', groupId, id: r.id, name: nameOf(g, r.id), text: reply, usedAi: !!result.usedAi });
    }
    for (const id of aiMembers) {
      const raw = (result.effects && result.effects[id]) || {};
      const fx = this.sanitizeChatEffects({ ...raw, promiseMade: result.promiseMade || null });
      fx.allianceSignal = 'none';
      fx.allianceProposal = null; // proposals are resolved once below, not per member
      applyChatEffects(g, id, text, fx, senderId);
      if (fx.summary) {
        g.memory[id].convoSummaries.push({ withId: senderId, week: g.week, summary: `(group) ${fx.summary}` });
        g.memory[id].convoSummaries = g.memory[id].convoSummaries.slice(-20);
      }
    }
    if (result.promiseMade) {
      for (const m of grp.members) if (this.isHuman(m)) this.sendToEngine(m, { type: 'groupSystem', groupId, text: `📋 Everyone here heard that promise: "${result.promiseMade.text}"` });
    }
    if (result.allianceProposal) {
      if (result.allianceProposal.accepted) {
        const decliners = (result.allianceProposal.decliners || []).filter((id) => aiMembers.includes(id));
        const accepters = grp.members.filter((id) => id !== senderId && !decliners.includes(id));
        if (accepters.length) {
          const alRes = formOfficialAlliance(g, accepters[0], result.allianceProposal.name, accepters.slice(1), senderId);
          for (const m of grp.members) if (this.isHuman(m)) this.sendToEngine(m, { type: 'groupSystem', groupId, text: `🤝 "${alRes.alliance.name}" is official: ${[senderId, ...accepters].map((id) => nameOf(g, id)).join(', ')}${decliners.length ? ` (out: ${decliners.map((id) => nameOf(g, id)).join(', ')})` : ''}` });
        }
      } else {
        for (const m of grp.members) if (this.isHuman(m)) this.sendToEngine(m, { type: 'groupSystem', groupId, text: `🚫 The room didn't commit. They'll remember it was asked.` });
      }
    }
    await this.saveGame();
    this.broadcastGame();
  }

  // Dedicated "Form Alliance" button flow: invite a specific list of members.
  // Online simplification: human invitees are auto-included (a real synchronous
  // accept/decline turn for humans is out of scope for this pass) while AI
  // invitees decide via allianceWillingness, exactly as single-player does.
  async handleFormAlliance(pid, memberIds, name) {
    const g = this.game;
    if (!g) return;
    const founder = this.engineForPlayer(pid);
    if (!founder) return;
    const picked = activeIds(g).filter((id) => id !== founder && memberIds.includes(id));
    if (!picked.length) return;
    const accepts = [], declines = [];
    for (const id of picked) {
      if (this.isHuman(id)) { accepts.push({ id, reason: 'in' }); continue; }
      const w = allianceWillingness(g, id, picked.filter((x) => x !== id), founder);
      (w.willing ? accepts : declines).push({ id, reason: w.reason });
    }
    let result = null;
    if (accepts.length) {
      result = formOfficialAlliance(g, accepts[0].id, name, accepts.slice(1).map((a) => a.id), founder);
    }
    for (const d of declines) {
      if (g.social[d.id]?.[founder]) g.social[d.id][founder].threat = Math.min(100, g.social[d.id][founder].threat + 6);
    }
    this.sendToPid(pid, {
      type: 'allianceResult', accepted: accepts.map((a) => ({ id: a.id, name: nameOf(g, a.id) })),
      declined: declines.map((d) => ({ id: d.id, name: nameOf(g, d.id), reason: d.reason })),
      alliance: result ? { id: result.alliance.id, name: result.alliance.name, existed: result.existed } : null,
    });
    for (const a of accepts) {
      if (a.id !== accepts[0].id && this.isHuman(a.id) && result) {
        this.sendToEngine(a.id, { type: 'groupSystem', groupId: null, text: `🤝 You joined "${result.alliance.name}" with ${nameOf(g, founder)}.` });
      }
    }
    await this.saveGame();
    this.broadcastGame();
  }

  async handleLeaveAlliance(pid, allianceId) {
    const g = this.game;
    if (!g) return;
    const engineId = this.engineForPlayer(pid);
    if (!engineId) return;
    const res = leaveAlliance(g, allianceId, engineId);
    if (!res) return;
    this.sendToPid(pid, { type: 'allianceLeft', name: res.name, others: res.others.map((id) => nameOf(g, id)), collapsed: res.collapsed });
    for (const id of res.others) {
      if (this.isHuman(id)) this.sendToEngine(id, { type: 'groupSystem', groupId: null, text: `💔 ${nameOf(g, engineId)} walked out of "${res.name}".` });
    }
    await this.saveGame();
    this.broadcastGame();
  }

  async handleDiary(pid, text) {
    const g = this.game;
    if (!g || !text) return;
    const engineId = this.engineForPlayer(pid);
    if (!engineId) return;
    if (!g.mpDiary) g.mpDiary = {};
    const log = g.mpDiary[engineId] || (g.mpDiary[engineId] = []);
    log.push({ who: 'you', text: String(text).slice(0, 400) });
    let reply, usedAi;
    try {
      ({ reply, usedAi } = await serverDiaryChat(g, engineId, log, this.effectiveApiKey));
    } catch {
      reply = fallbackDiary(g).reply;
      usedAi = false;
    }
    log.push({ who: 'them', text: reply });
    if (log.length > 30) g.mpDiary[engineId] = log.slice(-30);
    await this.saveGame();
    this.sendToPid(pid, { type: 'diaryReply', text: reply, usedAi });
  }

  // A late joiner takes over a still-active houseguest that's never been
  // claimed by any human (mid-season — the lobby-only claimSeat is for
  // before the season starts). AI covers everyone until someone claims them,
  // exactly like a Newcomer or cast seat left unclaimed at lobby time.
  async handleClaimLiveSeat(pid, seatId, customName) {
    const g = this.game;
    const s = this.state;
    if (!g || s.phase !== 'playing') return;
    const seatDef = SEAT_DEFS.find((sd) => sd.id === seatId);
    if (!seatDef) return;
    const engineId = this.seatToEngineId(seatId);
    if (!activeIds(g).includes(engineId)) return; // evicted/gone — nothing to take over
    if (this.isActiveHuman(engineId)) return; // someone's already actively playing them
    const currentOwner = s.humanSeats?.[engineId] || null;
    if (currentOwner && currentOwner !== pid) {
      this.sendToPid(pid, { type: 'takeoverNotice', text: 'That seat already belongs to a disconnected player. They can rejoin with the same room code.' });
      return;
    }
    if (!s.humanSeats) s.humanSeats = {};
    s.humanSeats[engineId] = pid;
    if (!s.players[pid]) s.players[pid] = { name: 'Player', seatId: null, online: true };
    s.players[pid].seatId = seatId;
    const name = (customName && String(customName).trim().slice(0, 20)) || seatDef.name;
    if (s.seats[seatId]) {
      s.seats[seatId].occupant = pid;
      s.seats[seatId].occupantName = name;
      s.seats[seatId].connected = true;
    }
    // Same as at season start: a custom name carries into the actual game,
    // not just the (mostly moot, post-lobby) seat card.
    const hg = g.houseguests.find((h) => h.id === engineId);
    if (hg && name !== hg.name) hg.name = name;
    await this.persist();
    await this.saveGame();
    this.broadcastState();
    this.broadcastGame();
    if (this.turn?.kind === 'comp' && this.turn.players?.includes(engineId) && this.turn.scores?.[engineId] != null) {
      this.sendToPid(pid, {
        type: 'takeoverNotice',
        text: `AI already played this competition for ${nameOf(g, engineId)}. You'll control them after this result.`,
      });
    }
  }

  async persist() {
    await this.ctx.storage.put('state', this.state);
  }

  broadcastState() {
    for (const c of this.getConnections()) {
      const pid = this.connToPlayer.get(c.id) || null;
      c.send(JSON.stringify({ type: 'state', state: this.projectState(pid) }));
    }
  }

  onConnect(connection) {
    // Send current state immediately; seating happens on the client's `hello`.
    connection.send(JSON.stringify({ type: 'state', state: this.projectState() }));
    const game = this.projectGame();
    if (game) connection.send(JSON.stringify({ type: 'game', game }));
  }

  async onMessage(connection, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const s = this.state;

    switch (msg.type) {
      case 'hello': {
        const pid = String(msg.playerId || '').slice(0, 64);
        if (!pid) return;
        const providedToken = String(msg.token || '');
        let expectedToken = this.playerTokens[pid];
        if (expectedToken && providedToken !== expectedToken) {
          connection.send(JSON.stringify({ type: 'authError', reason: 'bad_token' }));
          try { connection.close(); } catch {}
          return;
        }
        if (!expectedToken) {
          expectedToken = this.makePlayerToken();
          this.playerTokens[pid] = expectedToken;
          await this.persistTokens();
        }
        this.connToPlayer.set(connection.id, pid);
        if (!s.players[pid]) s.players[pid] = { name: msg.name || 'Player', seatId: null, online: true };
        s.players[pid].online = true;
        if (msg.name) s.players[pid].name = String(msg.name).slice(0, 20);
        if (!s.hostPlayerId) s.hostPlayerId = pid; // first ever joiner = host
        if (s.players[pid].seatId && s.seats[s.players[pid].seatId]) {
          s.seats[s.players[pid].seatId].connected = true;
        }
        connection.send(JSON.stringify({ type: 'auth', playerId: pid, token: expectedToken }));
        connection.send(JSON.stringify({ type: 'state', state: this.projectState(pid) }));
        const engineId = this.engineForPlayer(pid);
        const game = this.projectGame(engineId, pid);
        if (game) connection.send(JSON.stringify({ type: 'game', game }));
        break;
      }

      case 'setName': {
        const pid = this.connToPlayer.get(connection.id);
        if (!pid || !s.players[pid]) return;
        s.players[pid].name = String(msg.name || 'Player').slice(0, 20);
        // Renaming applies to whichever seat this player currently occupies —
        // any seat, cast member or Newcomer alike (only the occupant of that
        // seat can rename it, since seatId is looked up from their own player
        // record, not passed in by the client).
        const seatId = s.players[pid].seatId;
        if (seatId && s.seats[seatId] && s.seats[seatId].occupant === pid) {
          s.seats[seatId].occupantName = s.players[pid].name;
        }
        break;
      }

      case 'claimSeat': {
        const pid = this.connToPlayer.get(connection.id);
        if (!pid || !s.players[pid]) return;
        if (s.phase !== 'lobby') return;
        const seat = s.seats[msg.seatId];
        if (!seat || seat.occupant) return; // taken or invalid
        this.releaseSeatOf(pid); // drop any previous seat
        seat.occupant = pid;
        seat.occupantName = seat.fixed ? seat.name : s.players[pid].name;
        seat.connected = true;
        s.players[pid].seatId = msg.seatId;
        break;
      }

      case 'claimLiveSeat': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) await this.handleClaimLiveSeat(pid, msg.seatId, msg.name);
        return;
      }

      case 'releaseSeat': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) this.releaseSeatOf(pid);
        break;
      }

      case 'setSettings': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid !== s.hostPlayerId) return;
        const secs = Number(msg.phaseSeconds);
        if (secs >= 60 && secs <= 7200) s.settings.phaseSeconds = Math.round(secs);
        break;
      }

      case 'startSeason': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid !== s.hostPlayerId) return;
        if (s.phase !== 'lobby') return;
        const claimed = Object.values(s.seats).filter((x) => x.occupant);
        if (claimed.length < 1) return;

        // Build the authoritative game and seat the humans into houseguests.
        const newcomer = s.seats.newcomer;
        const playerName = (newcomer.occupant && newcomer.occupantName) || 'You';
        this.game = newGame(playerName);
        s.humanSeats = {};
        for (const seat of claimed) {
          s.humanSeats[this.seatToEngineId(seat.id)] = seat.occupant;
          // A renamed cast seat (e.g. "Rae" -> "Wife") carries that name into
          // the actual game — nameOf() reads g.houseguests everywhere (HUD,
          // dialogue, jury), so this isn't just a lobby-card cosmetic.
          if (seat.id !== 'newcomer' && seat.occupantName) {
            const hg = this.game.houseguests.find((h) => h.id === seat.id);
            if (hg) hg.name = seat.occupantName;
          }
        }
        s.phase = 'playing';
        s.startedAt = msg.clientTime || 0;
        if (msg.apiKey) { this.apiKey = String(msg.apiKey); await this.ctx.storage.put('apiKey', this.apiKey); }
        s.aiPowered = !!this.effectiveApiKey; // clients can show "Claude-powered" (no key value)
        await this.persist();
        this.broadcastState();
        await this.beginSeason(); // kicks off week 1; commits + broadcasts game
        return;
      }

      case 'chat': {
        const pid = this.connToPlayer.get(connection.id);
        const chatter = this.engineForPlayer(pid);
        if (chatter && msg.targetId) await this.handleChat(chatter, msg.targetId, String(msg.text || '').slice(0, 400), connection);
        return;
      }
      case 'getChatThread': {
        const pid = this.connToPlayer.get(connection.id);
        const chatter = this.engineForPlayer(pid);
        if (!chatter || !msg.targetId) return;
        const g = this.game;
        const hThread = (g?.mpHumanThreads && g.mpHumanThreads[this.humanThreadKey(chatter, msg.targetId)]) || [];
        connection.send(JSON.stringify({ type: 'chatThread', targetId: msg.targetId, entries: hThread }));
        return;
      }
      case 'pos': {
        // Ephemeral position relay — not persisted, not part of authoritative
        // game state, just a live broadcast so other humans see you walk around.
        const pid = this.connToPlayer.get(connection.id);
        const engineId = pid ? this.engineForPlayer(pid) : null;
        if (!engineId) return;
        const x = Number(msg.x), z = Number(msg.z), rotY = Number(msg.rotY);
        if (!isFinite(x) || !isFinite(z) || !isFinite(rotY)) return;
        const payload = JSON.stringify({ type: 'pos', id: engineId, x, z, rotY });
        for (const c of this.getConnections()) {
          if (c.id !== connection.id) c.send(payload);
        }
        return;
      }

      // ---- In-game player actions ----
      case 'advanceTurn': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) await this.advanceTurn(pid);
        return;
      }
      case 'compScore': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) await this.submitCompScore(pid, msg.score);
        return;
      }
      case 'nominate': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) await this.submitNominations(pid, msg.ids);
        return;
      }
      case 'vetoDecision': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) await this.submitVetoDecision(pid, msg.use, msg.savedId);
        return;
      }
      case 'replacement': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) await this.submitReplacement(pid, msg.id);
        return;
      }
      case 'vote': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) await this.submitVote(pid, msg.target);
        return;
      }
      case 'finalCut': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) await this.submitFinalCut(pid, msg.cutId);
        return;
      }
      case 'juryQuestion': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) await this.submitJurorQuestion(pid, msg.text);
        return;
      }
      case 'juryAnswer': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) await this.submitJurorAnswer(pid, msg.text);
        return;
      }
      case 'juryVote': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) await this.submitJurorVote(pid, msg.vote, msg.reasoning);
        return;
      }
      case 'startGroup': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) await this.handleStartGroup(pid, msg.memberIds || [], !!msg.isHouseMeeting);
        return;
      }
      case 'groupMsg': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) await this.handleGroupMsg(pid, msg.groupId, String(msg.text || '').slice(0, 400));
        return;
      }
      case 'formAlliance': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) await this.handleFormAlliance(pid, msg.memberIds || [], msg.name ? String(msg.name).slice(0, 40) : null);
        return;
      }
      case 'leaveAlliance': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) await this.handleLeaveAlliance(pid, msg.allianceId);
        return;
      }
      case 'diary': {
        const pid = this.connToPlayer.get(connection.id);
        if (pid) await this.handleDiary(pid, msg.text);
        return;
      }
      case 'forceResolve': {
        // Host override: AI-cover any players we're waiting on and move ahead.
        const pid = this.connToPlayer.get(connection.id);
        if (pid === this.state.hostPlayerId && this.turn) await this.forceResolveTurn();
        return;
      }

      case 'endSession': {
        // Hard shutdown, distinct from Leave: ends the room for EVERYONE, not
        // just the host's own seat. Host-only, works in the lobby or mid-game.
        const pid = this.connToPlayer.get(connection.id);
        if (pid === this.state.hostPlayerId) await this.endSession();
        return;
      }

      default:
        return;
    }

    await this.persist();
    this.broadcastState();
  }

  releaseSeatOf(pid) {
    const s = this.state;
    const player = s.players[pid];
    if (!player || !player.seatId) return;
    const seat = s.seats[player.seatId];
    if (seat && seat.occupant === pid) {
      seat.occupant = null;
      seat.occupantName = null;
      seat.connected = false;
      if (!seat.fixed) seat.name = 'Newcomer';
    }
    player.seatId = null;
  }

  // Host force-shutdown: end the room for everyone right now. Tells every
  // connection why, then resets storage to a clean lobby so a stray
  // reconnect with the same code doesn't resurrect stale state, and finally
  // drops every socket.
  async endSession() {
    const payload = JSON.stringify({ type: 'roomClosed', reason: 'The host ended this session.' });
    for (const c of this.getConnections()) {
      try { c.send(payload); } catch {}
    }
    this.state = this.freshLobby();
    this.game = null;
    this.turn = null;
    this.apiKey = null;
    this.playerTokens = {};
    await this.ctx.storage.deleteAll();
    for (const c of this.getConnections()) {
      try { c.close(); } catch {}
    }
    this.connToPlayer.clear();
  }

  async onClose(connection) {
    const pid = this.connToPlayer.get(connection.id);
    this.connToPlayer.delete(connection.id);
    if (!pid) return;
    const s = this.state;
    // Player may have another live tab; only mark offline if no other conn.
    const stillConnected = [...this.connToPlayer.values()].includes(pid);
    if (stillConnected) return;
    if (s.players[pid]) s.players[pid].online = false;

    if (s.phase === 'lobby') {
      this.releaseSeatOf(pid); // in lobby, a drop frees the seat
      await this.persist();
      this.broadcastState();
      return;
    }

    // In-game: seat stays theirs (they can reclaim), but AI covers them now.
    if (s.players[pid]?.seatId && s.seats[s.players[pid].seatId]) {
      s.seats[s.players[pid].seatId].connected = false;
    }
    // Reassign host so result screens can still advance.
    if (pid === s.hostPlayerId) {
      const nextHost = Object.entries(s.players).find(([id, p]) => id !== pid && p.online && p.seatId);
      if (nextHost) s.hostPlayerId = nextHost[0];
    }
    await this.persist();
    this.broadcastState();
    // AI-cover their pending action so the game doesn't stall.
    const engineId = this.engineForPlayer(pid);
    if (engineId && this.turn) await this.coverDisconnected(engineId);
    else this.broadcastGame();
  }
}

// ---- Server-hosted AI key (Phase 4.5.5) ------------------------------------
// A single global secret (set via `wrangler secret put ANTHROPIC_API_KEY`)
// powers single-player Claude calls for every device — nobody has to type a
// key in ever again. If the secret isn't configured, callers get a 503 and
// the client falls back to its own key (or the built-in offline engine),
// exactly like before this existed. Since the page is public, a light global
// rate gate (RateLimiter DO) protects the operator's key from abuse.

const ALLOWED_API_ORIGINS = new Set([
  'https://skeyd87-rgb.github.io',
]);

function allowedApiOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  if (ALLOWED_API_ORIGINS.has(origin)) return origin;
  try {
    const url = new URL(origin);
    const isLocal = (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && /^https?:$/.test(url.protocol);
    return isLocal ? origin : null;
  } catch {
    return null;
  }
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Vary': 'Origin',
  };
}

function jsonResponse(body, status = 200, origin = null) {
  const headers = { 'content-type': 'application/json' };
  if (origin) Object.assign(headers, corsHeaders(origin));
  return new Response(JSON.stringify(body), { status, headers });
}

async function handleApiChat(request, env) {
  const origin = allowedApiOrigin(request);
  if (!origin) return jsonResponse({ error: 'forbidden_origin' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405, origin);
  if (!env.ANTHROPIC_API_KEY) return jsonResponse({ error: 'no_server_key' }, 503, origin);

  if (env.RATE_LIMITER) {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName('global'));
    const gate = await (await stub.fetch('https://rate-limiter/check')).json();
    if (!gate.allowed) return jsonResponse({ error: 'rate_limited' }, 429, origin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'bad_request' }, 400, origin);
  }
  const { system, messages, maxTokens, temperature } = body || {};
  if (!system || !Array.isArray(messages)) return jsonResponse({ error: 'bad_request' }, 400, origin);

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: Math.min(Number(maxTokens) || 700, 1200),
        temperature: temperature ?? 1.0,
        system: String(system).slice(0, 20000),
        messages: messages.slice(0, 24),
      }),
    });
  } catch {
    return jsonResponse({ error: 'upstream_unreachable' }, 502, origin);
  }
  if (!res.ok) return jsonResponse({ error: 'upstream', status: res.status }, 502, origin);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return jsonResponse({ text }, 200, origin);
}

// Minimal global request counter — resets every 60s. Not per-user (there's no
// auth), just enough to stop the shared key from being hammered.
export class RateLimiter {
  constructor(state) {
    this.state = state;
    this.count = 0;
    this.windowStart = 0;
  }
  async fetch() {
    const now = Date.now();
    if (now - this.windowStart > 60000) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count++;
    return new Response(JSON.stringify({ allowed: this.count <= 30 }), { headers: { 'content-type': 'application/json' } });
  }
}

// Worker entry: route /parties/room/:code to the Room Durable Object;
// /api/chat to the server-hosted-key proxy; everything else falls through.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/chat') return handleApiChat(request, env);
    return (await routePartykitRequest(request, env)) || new Response('BB Jury House room server', { status: 200 });
  },
};
