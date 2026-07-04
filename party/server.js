// Cloudflare Durable Object room server (partyserver) — the authoritative
// multiplayer game. Phase 1: lobby (seats, claim/release, host, start).
// One Durable Object instance = one room = one season.
//
// Client connects with party name "room" (kebab of the `Room` DO binding).

import { Server, routePartykitRequest } from 'partyserver';
import { CAST } from '../src/game/cast.js';

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
    this.connToPlayer = new Map(); // connId -> playerId
  }

  async onStart() {
    this.state = (await this.ctx.storage.get('state')) || this.freshLobby();
  }

  freshLobby() {
    const seats = {};
    for (const s of SEAT_DEFS) {
      seats[s.id] = { ...s, occupant: null, occupantName: null, connected: false };
    }
    return {
      code: this.name,
      phase: 'lobby', // 'lobby' | 'playing' (Phase 2)
      hostPlayerId: null,
      seats,
      settings: { phaseSeconds: 1200 },
      players: {}, // playerId -> { name, seatId, online }
    };
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
        const humansSeated = Object.values(s.seats).filter((x) => x.occupant).length;
        if (humansSeated < 1) return;
        s.phase = 'playing';
        s.startedAt = msg.clientTime || 0;
        break;
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
    if (s.players[pid]) s.players[pid].online = false;
    if (s.phase === 'lobby') {
      this.releaseSeatOf(pid); // in lobby, a drop frees the seat
    } else if (s.players[pid]?.seatId && s.seats[s.players[pid].seatId]) {
      s.seats[s.players[pid].seatId].connected = false; // in-game AI takeover is Phase 4
    }
    await this.persist();
    this.broadcastState();
  }
}

// Worker entry: route /parties/room/:code to the Room Durable Object.
export default {
  async fetch(request, env) {
    return (await routePartykitRequest(request, env)) || new Response('BB Jury House room server', { status: 200 });
  },
};
