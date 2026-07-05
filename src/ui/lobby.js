// Multiplayer lobby UI (Phase 1): host/join entry, seat claiming, room code,
// host controls. Renders live from server state broadcasts.

import { el } from './ui.js';
import { Room, makeRoomCode, normalizeCode, getPlayerId } from '../net/room.js';

function colorHex(c) {
  return '#' + (c || 0xffffff).toString(16).padStart(6, '0');
}

const LAST_NAME_KEY = 'bbjury.playerName';

// Entry: choose Host or Join. onEnter(room) fires once connected & in a lobby.
export function showMultiplayerEntry({ onEnter, onBack }) {
  const wrap = el('div', 'title-screen');
  const card = el('div', 'title-card');
  card.append(el('div', 'eye', '👁️'));
  card.append(el('h1', '', 'PLAY <span>ONLINE</span>'));
  card.append(el('div', 'tag', 'Host a house, or join with a code.'));

  const nameInput = el('input');
  nameInput.placeholder = 'Your name';
  nameInput.maxLength = 20;
  nameInput.value = localStorage.getItem(LAST_NAME_KEY) || '';
  card.append(nameInput);

  const codeInput = el('input');
  codeInput.placeholder = 'Room code (to join)';
  codeInput.maxLength = 10;
  codeInput.style.textTransform = 'uppercase';
  card.append(codeInput);

  const status = el('div', 'keynote', 'Your name is how the house knows you.');
  card.append(status);

  const row = el('div', 'cine-actions');
  const hostBtn = el('button', 'bb gold', '＋ Host New House');
  const joinBtn = el('button', 'bb primary', '→ Join with Code');
  const backBtn = el('button', 'bb', '← Back');
  row.append(hostBtn, joinBtn, backBtn);
  card.append(row);
  wrap.append(card);
  document.body.append(wrap);

  function begin(code) {
    const name = nameInput.value.trim() || 'Player';
    localStorage.setItem(LAST_NAME_KEY, name);
    status.textContent = 'Connecting…';
    const room = new Room();
    let entered = false;
    room.onState = (state) => {
      if (!entered) {
        entered = true;
        wrap.remove();
        onEnter(room, state);
      }
    };
    room.onClose = () => {
      if (!entered) status.innerHTML = '<span style="color:#ff8f8f">Could not connect. Is the server running?</span>';
    };
    room.connect(code, name);
  }

  hostBtn.onclick = () => begin(makeRoomCode());
  joinBtn.onclick = () => {
    const raw = codeInput.value.trim();
    if (!raw) {
      status.innerHTML = '<span style="color:#ff8f8f">Enter a room code to join.</span>';
      return;
    }
    begin(normalizeCode(raw));
  };
  backBtn.onclick = () => {
    wrap.remove();
    onBack && onBack();
  };
}

// The live lobby. Re-renders on every server state push.
export function showLobby(room, initialState, { onStart, onLeave }) {
  const wrap = el('div', 'title-screen');
  wrap.id = 'lobby-screen';
  const card = el('div', 'title-card lobby-card');
  wrap.append(card);
  document.body.append(wrap);

  function render(state) {
    const meId = getPlayerId();
    const isHost = state.hostPlayerId === meId;
    const mySeat = state.players[meId]?.seatId || null;
    const seated = Object.values(state.seats).filter((s) => s.occupant);

    card.innerHTML = '';
    card.append(el('div', 'eye', '👁️'));
    const code = el('div', 'lobby-code', `ROOM CODE: <b>${state.code}</b>`);
    card.append(code);

    // Copy-invite: puts a ready-to-paste message on the clipboard.
    const gameUrl = location.href.split('#')[0].split('?')[0];
    const invite = `Join my Big Brother house! 👁️\nGo to ${gameUrl}\nTap "Play Online" and enter room code: ${state.code}`;
    const inviteBtn = el('button', 'bb primary sm', '📋 Copy Invite');
    inviteBtn.style.margin = '4px auto 0';
    inviteBtn.onclick = async () => {
      let ok = false;
      try {
        await navigator.clipboard.writeText(invite);
        ok = true;
      } catch {
        // Fallback for browsers/contexts without the async clipboard API
        const ta = document.createElement('textarea');
        ta.value = invite;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.append(ta);
        ta.select();
        try { ok = document.execCommand('copy'); } catch {}
        ta.remove();
      }
      inviteBtn.textContent = ok ? '✓ Invite Copied!' : '⚠ Copy failed — code above';
      setTimeout(() => (inviteBtn.textContent = '📋 Copy Invite'), 2200);
    };
    card.append(inviteBtn);

    card.append(el('div', 'tag', `${seated.length}/9 seats claimed · share the code to invite`));

    const grid = el('div', 'seat-grid');
    for (const seat of Object.values(state.seats)) {
      const mine = seat.occupant === meId;
      const s = el('div', 'seat-card' + (seat.occupant ? ' taken' : '') + (mine ? ' mine' : ''));
      const dot = el('span', 'dot', '');
      dot.style.background = colorHex(seat.color);
      const head = el('div', 'seat-head');
      head.append(dot, el('span', 'seat-name', seat.occupantName || seat.name));
      s.append(head);
      s.append(el('div', 'seat-sub', seat.occupant ? (mine ? '⭐ You' : '🧑 Human') : '🤖 AI if unclaimed'));
      if (!seat.occupant && !mySeat) {
        const claim = el('button', 'bb primary sm', 'Claim');
        claim.onclick = () => room.claimSeat(seat.id);
        s.append(claim);
      } else if (mine) {
        const leave = el('button', 'bb sm', 'Leave seat');
        leave.onclick = () => room.releaseSeat();
        s.append(leave);
      }
      grid.append(s);
    }
    card.append(grid);

    // Host controls
    if (isHost) {
      const ctrl = el('div', 'lobby-ctrl');
      const label = el('label', '', 'Social phase length: ');
      const sel = el('select');
      for (const [secs, txt] of [[300, '5 min'], [600, '10 min'], [1200, '20 min'], [3600, '1 hour'], [7200, '2 hours']]) {
        const o = el('option', '', txt);
        o.value = secs;
        if (secs === state.settings.phaseSeconds) o.selected = true;
        sel.append(o);
      }
      sel.onchange = () => room.setSettings(Number(sel.value));
      label.append(sel);
      ctrl.append(label);
      const start = el('button', 'bb gold', '▶ Start the Season');
      start.disabled = seated.length < 1;
      start.onclick = () => room.startSeason();
      ctrl.append(start);
      card.append(ctrl);
      card.append(el('div', 'keynote', 'You are the host. Unclaimed seats are played by AI. You can start whenever.'));
    } else if (!mySeat && seated.length >= 9) {
      card.append(el('div', 'keynote', `All 9 seats are taken — you'll watch as a spectator once the season starts.`));
    } else {
      card.append(el('div', 'keynote', `Waiting for the host to start…`));
    }

    const leaveRow = el('div', 'cine-actions');
    const leave = el('button', 'bb', '← Leave Room');
    leave.onclick = () => {
      room.disconnect();
      wrap.remove();
      onLeave && onLeave();
    };
    leaveRow.append(leave);
    card.append(leaveRow);
  }

  render(initialState);
  room.onState = (state) => {
    if (state.phase === 'playing') {
      wrap.remove();
      onStart && onStart(state);
    } else {
      render(state);
    }
  };
}
