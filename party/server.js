// PartyKit room server — the authoritative multiplayer game.
// Phase 1: lobby only (seats, claim/release, host, start). Gameplay arrives in
// Phase 2. One PartyKit "room" (= URL id, the shareable code) is one season.

import { CAST } from '../src/game/cast.js';

// The 9 claimable houseguest seats: the 8 established cast + one "newcomer"
// seat (the single-player 'you' slot) whose occupant names their houseguest.
const SEAT_DEFS = [
  ...CAST.map((c) => ({ id: c.id, name: c.name, job: c.job, color: c.color, fixed: true })),
  { id: 'newcomer', name: 'Newcomer', job: 'Houseguest', color: 0xfafafa, fixed: false },
];

export default class Server {
  constructor(room) {
    this.room = room;
    this.state = null;
    // connId -> playerId (so we can free the right seat on disconnect)
    this.connToPlayer = new Map();
  }

  async onStart() {
    this.state = (await this.room.storage.get('state')) || this.freshLobby();
  }

  freshLobby() {
    const seats = {};
    for (const s of SEAT_DEFS) {
      seats[s.id] = { ...s, occupant: null, occupantName: null, connected: false };
    }
    return {
      code: this.room.id,
      phase: 'lobby', // 'lobby' | 'playing' (Phase 2)
      hostPlayerId: null,
      seats,
      settings: { phaseSeconds: 1200 },
      players: {}, // playerId -> { name, seatId, online }
    };
  }

  async persist() {
    await this.room.storage.put('state', this.state);
  }

  broadcast() {
    this.room.broadcast(JSON.stringify({ type: 'state', state: this.publicState() }));
  }

  // Nothing secret in lobby state yet; whole object is public.
  publicState() {
    return this.state;
  }

  onConnect(conn) {
    // Wait for the client's `hello` (with its persistent playerId) before seating.
    conn.send(JSON.stringify({ type: 'state', state: this.publicState() }));
  }

  async onMessage(raw, sender) {
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
        this.connToPlayer.set(sender.id, pid);
        if (!s.players[pid]) s.players[pid] = { name: msg.name || 'Player', seatId: null, online: true };
        s.players[pid].online = true;
        if (msg.name) s.players[pid].name = String(msg.name).slice(0, 20);
        // First player to ever join is the host.
        if (!s.hostPlayerId) s.hostPlayerId = pid;
        // Reconnect: re-mark their seat connected.
        if (s.players[pid].seatId && s.seats[s.players[pid].seatId]) {
          s.seats[s.players[pid].seatId].connected = true;
        }
        break;
      }

      case 'setName': {
        const pid = this.connToPlayer.get(sender.id);
        if (!pid || !s.players[pid]) return;
        s.players[pid].name = String(msg.name || 'Player').slice(0, 20);
        const seatId = s.players[pid].seatId;
        if (seatId && s.seats[seatId] && !s.seats[seatId].fixed) {
          s.seats[seatId].occupantName = s.players[pid].name;
        }
        break;
      }

      case 'claimSeat': {
        const pid = this.connToPlayer.get(sender.id);
        if (!pid || !s.players[pid]) return;
        if (s.phase !== 'lobby') return;
        const seat = s.seats[msg.seatId];
        if (!seat || seat.occupant) return; // taken or invalid
        // release any previous seat this player held
        this.releaseSeatOf(pid);
        seat.occupant = pid;
        seat.occupantName = seat.fixed ? seat.name : s.players[pid].name;
        seat.connected = true;
        s.players[pid].seatId = msg.seatId;
        break;
      }

      case 'releaseSeat': {
        const pid = this.connToPlayer.get(sender.id);
        if (pid) this.releaseSeatOf(pid);
        break;
      }

      case 'setSettings': {
        const pid = this.connToPlayer.get(sender.id);
        if (pid !== s.hostPlayerId) return;
        const secs = Number(msg.phaseSeconds);
        if (secs >= 60 && secs <= 7200) s.settings.phaseSeconds = Math.round(secs);
        break;
      }

      case 'startSeason': {
        const pid = this.connToPlayer.get(sender.id);
        if (pid !== s.hostPlayerId) return;
        if (s.phase !== 'lobby') return;
        // Need at least the host seated (and >=1 human). Phase 2 wires real play.
        const humansSeated = Object.values(s.seats).filter((x) => x.occupant).length;
        if (humansSeated < 1) return;
        s.phase = 'playing';
        s.startedAt = msg.clientTime || 0; // stamped client-side (no Date on worker journal)
        break;
      }

      default:
        return;
    }

    await this.persist();
    this.broadcast();
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

  async onClose(conn) {
    const pid = this.connToPlayer.get(conn.id);
    this.connToPlayer.delete(conn.id);
    if (!pid) return;
    const s = this.state;
    if (s.players[pid]) s.players[pid].online = false;
    // In lobby, a disconnect frees the seat. (In-game AI-takeover is Phase 4.)
    if (s.phase === 'lobby') {
      this.releaseSeatOf(pid);
    } else if (s.players[pid]?.seatId && s.seats[s.players[pid].seatId]) {
      s.seats[s.players[pid].seatId].connected = false;
    }
    await this.persist();
    this.broadcast();
  }
}
