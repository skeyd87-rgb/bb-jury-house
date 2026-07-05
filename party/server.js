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
import { simulateHouseLife } from '../src/game/social.js';
import { fallbackJurorVote } from '../src/ai/fallback.js';

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
    this.state = null;
    this.game = null;
    this.turn = null; // current interactive turn (comp/nominate/vote/etc.)
    this.connToPlayer = new Map(); // connId -> playerId
  }

  async onStart() {
    this.state = (await this.ctx.storage.get('state')) || this.freshLobby();
    this.game = (await this.ctx.storage.get('game')) || null;
    this.turn = (await this.ctx.storage.get('turn')) || null;
  }

  async saveGame() {
    await this.ctx.storage.put('game', this.game);
    await this.ctx.storage.put('turn', this.turn);
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

  // Render-safe projection of the authoritative game (no hidden social/memory
  // state — those stay server-side and are revealed only as the game dictates).
  projectGame() {
    const g = this.game;
    if (!g) return null;
    return {
      week: g.week,
      phase: g.phase,
      hoh: g.hoh,
      nominees: g.nominees,
      vetoHolder: g.vetoHolder,
      vetoUsed: g.vetoUsed,
      jury: g.jury,
      evicted: g.evicted,
      humanSeats: this.state.humanSeats,
      turn: this.turn || null,
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
  }

  broadcastGame() {
    const game = this.projectGame();
    if (game) this.broadcast(JSON.stringify({ type: 'game', game }));
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
    await this.commit();
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

  async enterFinale() {
    const g = this.game;
    g.phase = 'finale';
    const finalists = activeIds(g);
    const jurors = g.jury.slice(-7);
    // Engine-based jury vote (interactive Claude Q&A arrives with the Phase 3
    // social layer). Each juror votes via the fallback judgment.
    const votes = [];
    let a = 0, b = 0;
    const qa = { f1Answer: 'I owned my game and every move I made.', f2Answer: 'I played my heart out.' };
    for (const j of jurors) {
      const v = fallbackJurorVote(g, j, finalists, qa);
      votes.push({ juror: j, jurorName: nameOf(g, j), vote: v.vote, voteName: nameOf(g, v.vote), reasoning: v.reasoning });
      if (v.vote === finalists[0]) a++; else b++;
    }
    const winner = a >= b ? finalists[0] : finalists[1];
    await this.setTurn({
      kind: 'winner',
      finalists, finalistNames: finalists.map((f) => nameOf(g, f)),
      votes, tally: { [nameOf(g, finalists[0])]: a, [nameOf(g, finalists[1])]: b },
      winner, winnerName: nameOf(g, winner),
    });
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
        if (t.comp === 'hoh') return this.enterNominations();
        if (t.comp === 'veto') return this.enterVetoCeremony();
        if (t.comp === 'final_hoh') return this.enterFinalCut(t.winner);
        return;
      case 'noms_result': return this.enterVetoComp();
      case 'veto_result': return this.enterEviction();
      case 'eviction_result': return this.advanceWeek();
      case 'final3_intro': return this.enterFinalHoh();
      case 'final_cut_result': return this.enterFinale();
      default: return;
    }
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
  }

  // Duration (seconds) before the phase timer auto-covers absent players.
  turnTimerSeconds() {
    const t = this.turn;
    if (!t) return 0;
    if (['comp', 'nominate', 'veto_decision', 'replacement', 'vote', 'final_cut'].includes(t.kind)) {
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

  async persist() {
    await this.ctx.storage.put('state', this.state);
  }

  broadcastState() {
    this.broadcast(JSON.stringify({ type: 'state', state: this.state }));
  }

  onConnect(connection) {
    // Send current state immediately; seating happens on the client's `hello`.
    connection.send(JSON.stringify({ type: 'state', state: this.state }));
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
        this.connToPlayer.set(connection.id, pid);
        if (!s.players[pid]) s.players[pid] = { name: msg.name || 'Player', seatId: null, online: true };
        s.players[pid].online = true;
        if (msg.name) s.players[pid].name = String(msg.name).slice(0, 20);
        if (!s.hostPlayerId) s.hostPlayerId = pid; // first ever joiner = host
        if (s.players[pid].seatId && s.seats[s.players[pid].seatId]) {
          s.seats[s.players[pid].seatId].connected = true;
        }
        break;
      }

      case 'setName': {
        const pid = this.connToPlayer.get(connection.id);
        if (!pid || !s.players[pid]) return;
        s.players[pid].name = String(msg.name || 'Player').slice(0, 20);
        const seatId = s.players[pid].seatId;
        if (seatId && s.seats[seatId] && !s.seats[seatId].fixed) {
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
        }
        s.phase = 'playing';
        s.startedAt = msg.clientTime || 0;
        await this.persist();
        this.broadcastState();
        await this.beginSeason(); // kicks off week 1; commits + broadcasts game
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
      case 'forceResolve': {
        // Host override: AI-cover any players we're waiting on and move ahead.
        const pid = this.connToPlayer.get(connection.id);
        if (pid === this.state.hostPlayerId && this.turn) await this.forceResolveTurn();
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

// Worker entry: route /parties/room/:code to the Room Durable Object.
export default {
  async fetch(request, env) {
    return (await routePartykitRequest(request, env)) || new Response('BB Jury House room server', { status: 200 });
  },
};
