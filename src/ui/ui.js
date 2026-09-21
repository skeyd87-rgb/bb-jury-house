// UI layer: HUD, chat panel, cinematic overlays, pickers, title screen.
// Pure DOM; the director (main.js) wires it to game logic.

import { nameOf, activeIds } from '../game/state.js';
import { PLAYER_ID } from '../game/cast.js';
import { phaseLabel } from '../game/season.js';
import { isVoiceOn, setVoiceOn, voiceSupported, speak, stopSpeaking, dictationSupported, startDictation } from '../audio/voice.js';

const hud = () => document.getElementById('hud');
const overlayRoot = () => document.getElementById('overlay-root');

// Keep keyboard navigation inside the active overlay, away from the playfield.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !document.querySelector('.cinematic')) {
    closeChatPanel();
    document.querySelectorAll('.dock-menu[open], .house-intel[open]').forEach((menu) => { menu.open = false; });
  }
  if (event.key !== 'Tab') return;
  const surface = [...document.querySelectorAll('.cinematic')].at(-1) || document.querySelector('.chat-panel') || document.querySelector('.title-screen');
  if (!surface) return;
  const nodes = [...surface.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea, select, summary, [tabindex="0"]')].filter((node) => node.getClientRects().length);
  const first = nodes[0], last = nodes.at(-1);
  if (!first) return;
  if (event.shiftKey && (document.activeElement === first || !surface.contains(document.activeElement))) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !surface.contains(document.activeElement))) {
    event.preventDefault(); first.focus();
  }
});

export function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function colorHex(c) {
  return '#' + c.toString(16).padStart(6, '0');
}

function htmlLine(html) {
  const d = el('div', 'hud-line');
  d.innerHTML = html;
  return d;
}

// ---------- HUD ----------

export function renderHud(g, handlers) {
  const h = hud();
  h.innerHTML = '';

  const top = el('div', 'hud-top');
  top.append(el('div', 'week', `<span class="live-dot"></span> Week ${String(g.week).padStart(2, '0')} · ${activeIds(g).length} houseguests`));
  top.append(el('div', 'phase', phaseLabel(g.phase)));
  const sub = [];
  if (g.hoh) sub.push(`HoH: ${nameOf(g, g.hoh)}`);
  if (g.vetoHolder) sub.push(`Veto: ${nameOf(g, g.vetoHolder)}`);
  if (sub.length) top.append(el('div', 'sub', sub.join(' · ')));
  h.append(top);

  const st = el('details', 'hud-status house-intel');
  st.append(el('summary', '', 'House intel'));
  if (g.nominees.length) st.append(htmlLine(`<span class="nom">On the block:</span> ${g.nominees.map((n) => nameOf(g, n)).join(' & ')}`));
  if (g.jury.length) st.append(htmlLine(`<b>Jury (${g.jury.length}):</b> ${g.jury.map((j) => nameOf(g, j)).join(', ')}`));
  const als = g.alliances.filter((a) => !a.dead && a.members.includes(PLAYER_ID));
  for (const a of als) {
    const line = htmlLine(`<b>${a.name}:</b> ${a.members.filter((m) => m !== PLAYER_ID).map((m) => nameOf(g, m)).join(', ')} <span class="leave-al" title="Leave this alliance">✕</span>`);
    const x = line.querySelector('.leave-al');
    if (x) x.onclick = () => handlers.onLeaveAlliance && handlers.onLeaveAlliance(a.id);
    st.append(line);
  }
  if (st.childNodes.length === 1) st.append(el('div', 'hud-line', 'No alliances yet. Start a conversation.'));
  h.append(st);

  const btns = el('div', 'hud-buttons');
  const social = el('details', 'dock-menu');
  social.append(el('summary', '', 'Social game'));
  const socialActions = el('div', 'dock-popover');
  social.append(socialActions);
  const settings = el('details', 'dock-menu');
  settings.append(el('summary', '', 'Menu'));
  const menuActions = el('div', 'dock-popover');
  settings.append(menuActions);
  const advanceLabels = {
    week_intro: '▶ Start the Week',
    social_hoh: '▶ Nomination Ceremony',
    social_veto: '▶ Play Veto Comp',
    veto_lobby: '▶ Hold Veto Ceremony',
    renom_watch: g.hoh === PLAYER_ID ? '▶ Name Replacement' : '▶ See the Replacement',
    campaigning: '▶ Go to Eviction',
  };
  if (advanceLabels[g.phase]) {
    const b = el('button', 'bb gold', advanceLabels[g.phase]);
    b.onclick = handlers.onAdvance;
    btns.append(b);
  }
  const dr = el('button', 'bb', 'Diary Room');
  dr.onclick = handlers.onDiary;
  btns.append(dr);
  if (['week_intro', 'social_hoh', 'social_veto', 'veto_lobby', 'renom_watch', 'campaigning'].includes(g.phase)) {
    const ga = el('button', 'bb', 'Form Alliance');
    ga.onclick = handlers.onFormAlliance;
    socialActions.append(ga);
    const gc = el('button', 'bb', 'Group Talk');
    gc.onclick = handlers.onGroupChat;
    socialActions.append(gc);
    const hm = el('button', 'bb', 'House Meeting');
    hm.onclick = handlers.onHouseMeeting;
    socialActions.append(hm);
    btns.append(social);
  }
  const music = el('button', 'bb', g.settings.musicOn ? '🔊 Music' : '🔇 Music');
  music.onclick = handlers.onToggleMusic;
  menuActions.append(music);
  if (voiceSupported()) {
    const vb = el('button', 'bb', isVoiceOn() ? '🗣️ Voice On' : '🤐 Voice Off');
    vb.title = 'Houseguests speak their replies aloud';
    vb.onclick = () => {
      setVoiceOn(!isVoiceOn());
      vb.textContent = isVoiceOn() ? '🗣️ Voice On' : '🤐 Voice Off';
    };
    menuActions.append(vb);
  }
  const exit = el('button', 'bb', '🚪 Exit');
  exit.onclick = handlers.onExit;
  menuActions.append(exit);
  const help = el('button', 'bb', 'How to play');
  help.onclick = () => {
    const c = cinematic({ kicker: 'Your social game', title: 'Every conversation counts.', bodyHtml: '<div class="help-steps"><p><b>01 · Build relationships</b>Click a houseguest to approach and talk. Make deals, share information, or listen.</p><p><b>02 · Fight for safety</b>Win HoH to nominate. Win the veto to change the block. Use the gold action when you are ready to advance.</p><p><b>03 · Remember the jury</b>Evicted houseguests decide the winner. Your promises and betrayals follow you to the finale.</p></div><p class="muted">Move: WASD or click · Camera: drag or Q/E · Zoom: scroll or pinch<br>Diary Room conversations are private and never affect the game.</p>' });
    c.setActions([{ label: 'Back to the house', onClick: () => c.close() }]);
  };
  menuActions.prepend(help);
  btns.append(settings);
  for (const menu of [social, settings]) {
    menu.addEventListener('toggle', () => {
      if (menu.open) for (const other of [social, settings]) if (other !== menu) other.open = false;
    });
    menu.addEventListener('click', (e) => { if (e.target.closest('button')) menu.open = false; });
  }
  h.append(btns);

  const isTouch = matchMedia('(pointer: coarse)').matches;
  const hint = el(
    'div',
    'hud-hint',
    isTouch
      ? '<b>Tap</b> to move · <b>tap someone</b> to talk · <b>drag</b> to rotate · <b>pinch</b> to zoom'
      : '<kbd>W A S D</kbd> move <span>·</span> Click a houseguest to talk <span>·</span> Drag to orbit'
  );
  h.append(hint);
}

export function showToast(html, actions = []) {
  clearToast();
  const t = el('div', 'toast');
  t.id = 'toast';
  t.append(el('span', '', html));
  for (const a of actions) {
    const b = el('button', 'bb ' + (a.style || 'primary'), a.label);
    b.onclick = () => {
      clearToast();
      a.onClick && a.onClick();
    };
    t.append(b);
  }
  hud().append(t);
  // On a phone the toast owns the top row and the HUD cluster slides under it
  // (see .toast-open in style.css). Its height varies — the text wraps and the
  // buttons rewrap at narrow widths — so measure it rather than guessing.
  document.body.classList.add('toast-open');
  document.documentElement.style.setProperty('--toast-h', `${t.offsetHeight}px`);
  return t;
}

export function clearToast() {
  document.getElementById('toast')?.remove();
  document.body.classList.remove('toast-open');
  document.documentElement.style.removeProperty('--toast-h');
}

// ---------- Chat panel ----------

export function openChatPanel({ title, subtitle, color, isDiary, thread, onSend, onClose, voice }) {
  closeChatPanel();
  const panel = el('div', 'chat-panel');
  panel.id = 'chat-panel';
  // voice: { key, gender } for 1-on-1, or { lookupGender(name) } for group chats
  // where each reply names a different speaker.
  const speakAs = (text, name) => {
    if (!voiceSupported() || !isVoiceOn() || isDiary) return;
    const gender = name && voice?.lookupGender ? voice.lookupGender(name) : voice?.gender || null;
    speak(text, name || voice?.key || title, gender);
  };

  const head = el('div', 'chat-head' + (isDiary ? ' diary' : ''));
  const av = el('div', 'chat-avatar');
  av.textContent = isDiary ? 'DR' : title.slice(0, 1);
  av.style.background = isDiary ? 'radial-gradient(circle at 35% 30%, #ff8f8f, #7a1515)' : `radial-gradient(circle at 35% 30%, #fff3, ${colorHex(color)})`;
  head.append(av);
  const names = el('div');
  names.append(el('div', 'who', title));
  names.append(el('div', 'role', subtitle));
  head.append(names);
  // Voice toggle — houseguests speak their replies aloud
  if (voiceSupported() && !isDiary) {
    const vt = el('button', 'bb close', isVoiceOn() ? '🔊' : '🔈');
    vt.title = 'Voice mode: houseguests speak replies aloud';
    vt.onclick = () => {
      setVoiceOn(!isVoiceOn());
      vt.textContent = isVoiceOn() ? '🔊' : '🔈';
      if (isVoiceOn()) speak('Voice on.', 'narrator');
    };
    head.append(vt);
  }
  // Register onClose so it fires however the panel closes (✕, Esc, or a
  // programmatic closeChatPanel() from a phase advance / new conversation).
  panel._onClose = () => { stopSpeaking(); onClose && onClose(); };
  const x = el('button', 'bb close', '✕');
  x.setAttribute('aria-label', 'Close conversation');
  x.onclick = () => closeChatPanel();
  head.append(x);
  panel.append(head);

  const log = el('div', 'chat-log');
  panel.append(log);
  for (const m of thread || []) addMsg(log, m.who, m.text);
  if (!thread?.length) {
    log.append(el('div', 'chat-starter', isDiary
      ? '<span>BEHIND CLOSED DOORS</span><h3>Your side of the story.</h3><p>Think out loud. Celebrate a move. Vent about the house. This conversation stays with you.</p>'
      : '<span>THE SOCIAL GAME</span><h3>Start a conversation.</h3><p>Check in, compare notes, or make your case. Trust is built one conversation at a time.</p>'));
  }

  const inputRow = el('div', 'chat-input');
  const input = el('input');
  input.setAttribute('aria-label', 'Your message');
  input.placeholder = isDiary ? 'Tell the Diary Room everything...' : 'Say something...';
  input.maxLength = 300;
  // Dictation mic (Chrome/Edge/Android; iOS users: use the keyboard's 🎤)
  if (dictationSupported()) {
    const mic = el('button', 'bb', '🎤');
    mic.title = 'Dictate your message';
    let rec = null;
    mic.onclick = () => {
      if (rec) { try { rec.stop(); } catch {} rec = null; mic.textContent = '🎤'; return; }
      mic.textContent = '🔴';
      rec = startDictation(
        (text) => { input.value = (input.value ? input.value + ' ' : '') + text; },
        () => { rec = null; mic.textContent = '🎤'; input.focus(); }
      );
    };
    inputRow.append(mic);
  }
  const send = el('button', 'bb primary', 'Send');
  let busy = false;
  async function submit() {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    input.value = '';
    input.disabled = true;
    send.disabled = true;
    addMsg(log, 'you', text);
    const typing = addMsg(log, 'them typing', '');
    try {
      const reply = await onSend(text);
      typing.classList.remove('typing');
      if (Array.isArray(reply)) {
        // group conversation: several named speakers
        if (reply.length === 0) {
          typing.textContent = '(silence — read the room)';
        } else {
          setNamedMsg(typing, reply[0].name, reply[0].text);
          speakAs(reply[0].text, reply[0].name);
          for (const r of reply.slice(1)) {
            setNamedMsg(addMsg(log, 'them', ''), r.name, r.text);
            speakAs(r.text, r.name);
          }
        }
      } else if (reply == null) {
        // Human target: there's no reply yet (they'll answer in their own
        // time) — don't fake a "them" bubble with a system confirmation text.
        typing.remove();
      } else {
        typing.textContent = reply;
        speakAs(reply);
      }
    } catch (err) {
      typing.classList.remove('typing');
      typing.textContent = '(they seem distracted — try again)';
      console.error(err);
    }
    log.scrollTop = log.scrollHeight;
    busy = false;
    input.disabled = false;
    send.disabled = false;
    input.focus();
  }
  send.onclick = submit;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') closeChatPanel();
  });
  inputRow.append(input, send);
  panel.append(inputRow);

  overlayRoot().append(panel);
  input.focus();
  log.scrollTop = log.scrollHeight;
  return {
    addSystemMsg: (text) => { addMsg(log, 'sys', text); log.scrollTop = log.scrollHeight; },
    // A message arrived from the other side while this panel is already
    // open (online human-to-human chat) — append it live, no "typing" delay.
    addTheirMsg: (text) => {
      addMsg(log, 'them', text);
      log.scrollTop = log.scrollHeight;
      speakAs(text);
    },
    // NPC speaks unprompted (e.g. they approached the player): shows a typing
    // indicator while getText resolves.
    themSpeak: async (getText) => {
      const typing = addMsg(log, 'them typing', '');
      try {
        const text = await getText();
        typing.classList.remove('typing');
        typing.textContent = text;
        speakAs(text);
      } catch (err) {
        typing.remove();
        console.error(err);
      }
      log.scrollTop = log.scrollHeight;
    },
  };
}

// A group-chat panel fed by server pushes rather than request/response: any
// member (human or AI) may speak at any time, so lines arrive out of band
// instead of as a reply to `onSend`. Used for online Group Talk/House Meeting.
export function openLiveGroupPanel({ title, subtitle, color, onSend, onClose }) {
  closeChatPanel();
  const panel = el('div', 'chat-panel');
  panel.id = 'chat-panel';

  const head = el('div', 'chat-head');
  const av = el('div', 'chat-avatar');
  av.style.background = `radial-gradient(circle at 35% 30%, #fff3, ${colorHex(color)})`;
  head.append(av);
  const names = el('div');
  names.append(el('div', 'who', title));
  names.append(el('div', 'role', subtitle));
  head.append(names);
  panel._onClose = () => { onClose && onClose(); };
  const x = el('button', 'bb close', '✕');
  x.onclick = () => closeChatPanel();
  head.append(x);
  panel.append(head);

  const log = el('div', 'chat-log');
  panel.append(log);

  const inputRow = el('div', 'chat-input');
  const input = el('input');
  input.placeholder = 'Say something... (/whisper <name> <msg> for a private aside)';
  input.maxLength = 300;
  if (dictationSupported()) {
    const mic = el('button', 'bb', '🎤');
    mic.title = 'Dictate your message';
    let rec = null;
    mic.onclick = () => {
      if (rec) { try { rec.stop(); } catch {} rec = null; mic.textContent = '🎤'; return; }
      mic.textContent = '🔴';
      rec = startDictation(
        (text) => { input.value = (input.value ? input.value + ' ' : '') + text; },
        () => { rec = null; mic.textContent = '🎤'; input.focus(); }
      );
    };
    inputRow.append(mic);
  }
  const send = el('button', 'bb primary', 'Send');
  function submit() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    onSend(text);
    input.focus();
  }
  send.onclick = submit;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') closeChatPanel();
  });
  inputRow.append(input, send);
  panel.append(inputRow);

  overlayRoot().append(panel);
  input.focus();
  return {
    addLine: (name, text, isSelf) => {
      setNamedMsg(addMsg(log, isSelf ? 'you' : 'them', ''), name, text);
      log.scrollTop = log.scrollHeight;
    },
    addSystemMsg: (text) => { addMsg(log, 'sys', text); log.scrollTop = log.scrollHeight; },
  };
}

function addMsg(log, who, text) {
  if (who !== 'sys') log.querySelector('.chat-starter')?.remove();
  const m = el('div', 'msg ' + who, '');
  m.textContent = text;
  log.append(m);
  log.scrollTop = log.scrollHeight;
  return m;
}

function setNamedMsg(msgEl, name, text) {
  msgEl.textContent = '';
  const b = el('b', '', '');
  b.textContent = name + ': ';
  msgEl.append(b, document.createTextNode(text));
}

export function closeChatPanel() {
  const panel = document.getElementById('chat-panel');
  if (!panel) return;
  const cb = panel._onClose;
  panel._onClose = null; // guard against double-fire
  panel.remove();
  cb && cb();
}

// ---------- Cinematic overlays ----------

export function cinematic({ kicker, title, bodyHtml, quote, actions, cardCls }) {
  const previousFocus = document.activeElement;
  const wrap = el('div', 'cinematic');
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-label', title || kicker || 'Season event');
  const card = el('div', 'cine-card' + (cardCls ? ' ' + cardCls : ''));
  if (kicker) card.append(el('h1', '', kicker));
  if (title) card.append(el('h2', '', title));
  if (quote) card.append(el('div', 'quote', quote));
  if (bodyHtml) {
    const b = el('div');
    b.innerHTML = bodyHtml;
    card.append(b);
  }
  const actRow = el('div', 'cine-actions');
  card.append(actRow);
  wrap.append(card);
  overlayRoot().append(wrap);

  return {
    el: wrap,
    card,
    actions: actRow,
    setActions(list) {
      actRow.innerHTML = '';
      for (const a of list) {
        const b = el('button', 'bb ' + (a.style || 'primary'), a.label);
        b.onclick = a.onClick;
        actRow.append(b);
      }
    },
    close() {
      wrap.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
    },
  };
}

// Simple "continue" card that resolves when clicked.
export function cinematicWait(opts) {
  return new Promise((resolve) => {
    const c = cinematic(opts);
    c.setActions([{ label: opts.continueLabel || 'Continue', onClick: () => { c.close(); resolve(); } }]);
  });
}

// Pick houseguests from a list. `count` is an exact number or {min,max}.
// Resolves with array of ids, or null if cancelable and canceled.
export function pickHouseguests(g, { kicker, title, bodyHtml, ids, count, confirmLabel, meta, cancelable }) {
  const min = typeof count === 'object' ? count.min : count;
  const max = typeof count === 'object' ? count.max : count;
  return new Promise((resolve) => {
    const c = cinematic({ kicker, title, bodyHtml });
    const grid = el('div', 'pick-grid');
    const selected = new Set();
    const confirm = el('button', 'bb gold', confirmLabel || 'Confirm');
    confirm.disabled = true;

    for (const id of ids) {
      const hg = g.houseguests.find((h) => h.id === id);
      const card = el('button', 'pick-card');
      card.type = 'button';
      card.setAttribute('aria-pressed', 'false');
      card.append(el('span', 'dot', ''));
      card.querySelector('.dot').style.background = colorHex(hg.color);
      card.append(el('div', 'nm', hg.name));
      card.append(el('div', 'meta', (meta && meta(id)) || hg.job || ''));
      card.onclick = () => {
        if (selected.has(id)) {
          selected.delete(id);
          card.classList.remove('selected');
        } else {
          if (selected.size >= max) return;
          selected.add(id);
          card.classList.add('selected');
        }
        confirm.disabled = selected.size < min || selected.size > max;
        card.setAttribute('aria-pressed', String(selected.has(id)));
      };
      grid.append(card);
    }
    c.card.insertBefore(grid, c.actions);
    confirm.onclick = () => {
      c.close();
      resolve([...selected]);
    };
    c.actions.append(confirm);
    if (cancelable) {
      const cancel = el('button', 'bb', 'Cancel');
      cancel.onclick = () => {
        c.close();
        resolve(null);
      };
      c.actions.append(cancel);
    }
  });
}

// Free-text answer inside a cinematic (jury answers)
export function cinematicTextInput({ kicker, title, quote, placeholder, submitLabel }) {
  return new Promise((resolve) => {
    const c = cinematic({ kicker, title, quote });
    const ta = el('textarea');
    ta.placeholder = placeholder || 'Your answer...';
    ta.maxLength = 400;
    Object.assign(ta.style, {
      width: '100%', minHeight: '90px', background: '#171b30', color: 'var(--text)',
      border: '1px solid var(--panel-border)', borderRadius: '10px', padding: '12px',
      fontSize: '14px', fontFamily: 'inherit', resize: 'vertical', outline: 'none',
    });
    c.card.insertBefore(ta, c.actions);
    c.setActions([
      {
        label: submitLabel || 'Answer',
        style: 'gold',
        onClick: () => {
          const v = ta.value.trim() || '(no answer)';
          c.close();
          resolve(v);
        },
      },
    ]);
    ta.focus();
  });
}

export function confetti() {
  const emojis = ['🎉', '✨', '🎊', '⭐', '💛'];
  for (let i = 0; i < 60; i++) {
    const s = el('div', 'confetti', emojis[i % emojis.length]);
    s.style.left = Math.random() * 100 + 'vw';
    s.style.animationDuration = 2.5 + Math.random() * 3 + 's';
    s.style.animationDelay = Math.random() * 1.5 + 's';
    document.body.append(s);
    setTimeout(() => s.remove(), 7000);
  }
}

// ---------- Title screen ----------

export function titleScreen({ hasSave, onNew, onContinue, archivedStats, onShowStats, onOnline }) {
  const wrap = el('div', 'title-screen season-title');
  wrap.id = 'title-screen';
  const card = el('div', 'title-card');
  card.append(el('div', 'brand-line', '<span class="brand-eye" aria-hidden="true"></span> BIG BROTHER · A SOCIAL STRATEGY GAME'));
  card.append(el('div', 'title-eyebrow', 'The doors are open.'));
  card.append(el('h1', '', 'JURY<br><span>HOUSE</span><i>.</i>'));
  card.append(el('div', 'tag', 'Nine houseguests. One winner.<br>Make them trust you. Give them a reason to vote for you.'));
  const label = el('label', 'name-label', 'YOUR HOUSEGUEST');
  label.htmlFor = 'houseguest-name';
  card.append(label);

  const nameInput = el('input');
  nameInput.id = 'houseguest-name';
  nameInput.placeholder = 'Your houseguest name';
  nameInput.maxLength = 16;
  nameInput.value = 'Sam';
  card.append(nameInput);

  const row = el('div', 'cine-actions');
  const start = el('button', 'bb gold', 'Enter the house →');
  start.onclick = () => {
    wrap.remove();
    onNew(nameInput.value.trim() || 'Sam');
  };
  row.append(start);
  if (hasSave) {
    const cont = el('button', 'bb primary', '▶ Continue Season');
    cont.onclick = () => {
      wrap.remove();
      onContinue();
    };
    row.append(cont);
  }
  if (archivedStats && onShowStats) {
    const st = el('button', 'bb', '📊 Last Season');
    st.onclick = () => onShowStats();
    row.append(st);
  }
  card.append(row);
  if (onOnline) {
    const onlineRow = el('div', 'cine-actions');
    const ob = el('button', 'bb', 'Play with friends ↗');
    ob.onclick = () => { wrap.remove(); onOnline(); };
    onlineRow.append(ob);
    card.append(onlineRow);
  }
  wrap.append(card);
  wrap.append(el('div', 'title-scene-caption', '<span class="live-dot"></span> THE HOUSE <span class="caption-rule"></span> Where loyalty gets complicated.'));
  wrap.append(el('div', 'title-footer', '<span>ALLIANCES. BETRAYALS. CONSEQUENCES.</span><span>Single player + online multiplayer</span>'));
  document.body.append(wrap);
}
