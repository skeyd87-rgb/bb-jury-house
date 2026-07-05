// Client-side room connection (PartySocket wrapper). Phase 1: lobby.
// The room "code" is the PartyKit room id — shareable, human-friendly.

import PartySocket from 'partysocket';

// Where the PartyKit server lives. Local `partykit dev` serves on :1999;
// production points at the deployed worker (set VITE_PARTYKIT_HOST at build).
// The deployed Cloudflare Worker host, or localhost for `wrangler dev`.
// Updated with the real workers.dev URL after the first deploy.
const PARTY_HOST =
  import.meta.env?.VITE_PARTYKIT_HOST ||
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'localhost:1999'
    : 'bb-jury-house.skeyd87.workers.dev'); // deployed Cloudflare Worker

const PID_KEY = 'bbjury.playerId';

export function getPlayerId() {
  let id = localStorage.getItem(PID_KEY);
  if (!id) {
    id = 'p_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
    localStorage.setItem(PID_KEY, id);
  }
  return id;
}

const CODE_CHARS = 'ACDEFGHJKMNPQRSTUVWXYZ2345679'; // no ambiguous chars
export function makeRoomCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return 'BB-' + c;
}

// Normalize user-typed codes: uppercase, ensure BB- prefix, strip junk.
export function normalizeCode(input) {
  let c = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.startsWith('BB')) c = c.slice(2);
  return 'BB-' + c;
}

export class Room {
  constructor() {
    this.socket = null;
    this.code = null;
    this.playerId = getPlayerId();
    this.onState = null; // (state) => {}
    this.onGame = null; // (game) => {}  authoritative game snapshot
    this.onChatMsg = null; // (from, fromName, text) => {}  incoming human message
    this.onOpen = null;
    this.onClose = null;
    this.lastState = null;
    this.lastGame = null;
    this._chatWaiters = {}; // npcId -> resolve fn
  }

  connect(code, name) {
    this.code = code;
    this.socket = new PartySocket({ host: PARTY_HOST, party: 'room', room: code });

    this.socket.addEventListener('open', () => {
      this.send('hello', { playerId: this.playerId, name });
      this.onOpen && this.onOpen();
    });
    this.socket.addEventListener('message', (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'state') {
        this.lastState = msg.state;
        this.onState && this.onState(msg.state);
      } else if (msg.type === 'game') {
        this.lastGame = msg.game;
        this.onGame && this.onGame(msg.game);
      } else if (msg.type === 'chatReply') {
        const w = this._chatWaiters[msg.npcId];
        if (w) { delete this._chatWaiters[msg.npcId]; w({ text: msg.text, note: msg.note }); }
      } else if (msg.type === 'chatMsg') {
        this.onChatMsg && this.onChatMsg(msg.from, msg.fromName, msg.text);
      }
    });
    this.socket.addEventListener('close', () => this.onClose && this.onClose());
    return this;
  }

  send(type, payload = {}) {
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(JSON.stringify({ type, ...payload }));
    }
  }

  // Send a chat message to a houseguest; resolves with { text, note } reply.
  sendChat(targetId, text) {
    return new Promise((resolve) => {
      this._chatWaiters[targetId] = resolve;
      this.send('chat', { targetId, text });
      setTimeout(() => {
        if (this._chatWaiters[targetId]) { delete this._chatWaiters[targetId]; resolve({ text: '(no reply — try again)' }); }
      }, 30000);
    });
  }

  claimSeat(seatId) { this.send('claimSeat', { seatId }); }
  releaseSeat() { this.send('releaseSeat'); }
  setName(name) { this.send('setName', { name }); }
  setSettings(phaseSeconds) { this.send('setSettings', { phaseSeconds }); }
  startSeason() {
    // The host's Anthropic key (if any) powers server-side houseguest AI. It's
    // stored server-side only, never broadcast to other players.
    const apiKey = localStorage.getItem('bbjury.apikey') || '';
    this.send('startSeason', { clientTime: Date.now(), apiKey });
  }

  isHost() {
    return this.lastState && this.lastState.hostPlayerId === this.playerId;
  }

  mySeatId() {
    const p = this.lastState?.players?.[this.playerId];
    return p ? p.seatId : null;
  }

  disconnect() {
    this.socket && this.socket.close();
    this.socket = null;
  }
}
