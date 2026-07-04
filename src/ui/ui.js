// UI layer: HUD, chat panel, cinematic overlays, pickers, title screen.
// Pure DOM; the director (main.js) wires it to game logic.

import { nameOf, activeIds } from '../game/state.js';
import { PLAYER_ID } from '../game/cast.js';
import { phaseLabel } from '../game/season.js';

const hud = () => document.getElementById('hud');
const overlayRoot = () => document.getElementById('overlay-root');

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
  top.append(el('div', 'week', `Week ${g.week} — ${activeIds(g).length} left`));
  top.append(el('div', 'phase', phaseLabel(g.phase)));
  const sub = [];
  if (g.hoh) sub.push(`HoH: ${nameOf(g, g.hoh)}`);
  if (g.vetoHolder) sub.push(`Veto: ${nameOf(g, g.vetoHolder)}`);
  if (sub.length) top.append(el('div', 'sub', sub.join(' · ')));
  h.append(top);

  const st = el('div', 'hud-status');
  if (g.nominees.length) st.append(htmlLine(`<span class="nom">On the block:</span> ${g.nominees.map((n) => nameOf(g, n)).join(' & ')}`));
  if (g.jury.length) st.append(htmlLine(`<b>Jury (${g.jury.length}):</b> ${g.jury.map((j) => nameOf(g, j)).join(', ')}`));
  const als = g.alliances.filter((a) => !a.dead && a.members.includes(PLAYER_ID));
  for (const a of als) {
    const line = htmlLine(`<b>${a.name}:</b> ${a.members.filter((m) => m !== PLAYER_ID).map((m) => nameOf(g, m)).join(', ')} <span class="leave-al" title="Leave this alliance">✕</span>`);
    const x = line.querySelector('.leave-al');
    if (x) x.onclick = () => handlers.onLeaveAlliance && handlers.onLeaveAlliance(a.id);
    st.append(line);
  }
  if (!st.childNodes.length) st.innerHTML = '<span style="color:var(--muted)">No alliances yet. Go talk to people.</span>';
  h.append(st);

  const btns = el('div', 'hud-buttons');
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
  const dr = el('button', 'bb', '🎥 Diary Room');
  dr.onclick = handlers.onDiary;
  btns.append(dr);
  if (['week_intro', 'social_hoh', 'social_veto', 'veto_lobby', 'renom_watch', 'campaigning'].includes(g.phase)) {
    const ga = el('button', 'bb', '🤝 Form Alliance');
    ga.onclick = handlers.onFormAlliance;
    btns.append(ga);
    const gc = el('button', 'bb', '💬 Group Talk');
    gc.onclick = handlers.onGroupChat;
    btns.append(gc);
    const hm = el('button', 'bb', '📢 House Meeting');
    hm.onclick = handlers.onHouseMeeting;
    btns.append(hm);
  }
  const music = el('button', 'bb', g.settings.musicOn ? '🔊 Music' : '🔇 Music');
  music.onclick = handlers.onToggleMusic;
  btns.append(music);
  h.append(btns);

  const isTouch = matchMedia('(pointer: coarse)').matches;
  const hint = el(
    'div',
    'hud-hint',
    isTouch
      ? '<b>Tap</b> to move · <b>tap someone</b> to talk · <b>drag</b> to rotate · <b>pinch</b> to zoom'
      : '<b>WASD</b>/click to move · walk up to someone and <b>click them</b> to talk · <b>drag</b>/<b>Q E</b> rotate · scroll to zoom'
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
  return t;
}

export function clearToast() {
  document.getElementById('toast')?.remove();
}

// ---------- Chat panel ----------

export function openChatPanel({ title, subtitle, color, isDiary, thread, onSend, onClose }) {
  closeChatPanel();
  const panel = el('div', 'chat-panel');
  panel.id = 'chat-panel';

  const head = el('div', 'chat-head' + (isDiary ? ' diary' : ''));
  const av = el('div', 'chat-avatar');
  av.style.background = isDiary ? 'radial-gradient(circle at 35% 30%, #ff8f8f, #7a1515)' : `radial-gradient(circle at 35% 30%, #fff3, ${colorHex(color)})`;
  head.append(av);
  const names = el('div');
  names.append(el('div', 'who', title));
  names.append(el('div', 'role', subtitle));
  head.append(names);
  // Register onClose so it fires however the panel closes (✕, Esc, or a
  // programmatic closeChatPanel() from a phase advance / new conversation).
  panel._onClose = onClose;
  const x = el('button', 'bb close', '✕');
  x.onclick = () => closeChatPanel();
  head.append(x);
  panel.append(head);

  const log = el('div', 'chat-log');
  panel.append(log);
  for (const m of thread || []) addMsg(log, m.who, m.text);

  const inputRow = el('div', 'chat-input');
  const input = el('input');
  input.placeholder = isDiary ? 'Tell the Diary Room everything...' : 'Say something...';
  input.maxLength = 300;
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
          for (const r of reply.slice(1)) setNamedMsg(addMsg(log, 'them', ''), r.name, r.text);
        }
      } else {
        typing.textContent = reply;
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
    // NPC speaks unprompted (e.g. they approached the player): shows a typing
    // indicator while getText resolves.
    themSpeak: async (getText) => {
      const typing = addMsg(log, 'them typing', '');
      try {
        const text = await getText();
        typing.classList.remove('typing');
        typing.textContent = text;
      } catch (err) {
        typing.remove();
        console.error(err);
      }
      log.scrollTop = log.scrollHeight;
    },
  };
}

function addMsg(log, who, text) {
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
  const wrap = el('div', 'cinematic');
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
      const card = el('div', 'pick-card');
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

export function titleScreen({ hasSave, onNew, onContinue, savedKey, onSaveKey, archivedStats, onShowStats, onOnline }) {
  const wrap = el('div', 'title-screen');
  wrap.id = 'title-screen';
  const card = el('div', 'title-card');
  card.append(el('div', 'eye', '👁️'));
  card.append(el('h1', '', 'BIG <span>BROTHER</span>'));
  card.append(el('div', 'tag', 'JURY HOUSE — 9 remain. Every word matters.'));

  const nameInput = el('input');
  nameInput.placeholder = 'Your houseguest name';
  nameInput.maxLength = 16;
  nameInput.value = 'Sam';
  card.append(nameInput);

  const keyInput = el('input');
  keyInput.type = 'password';
  keyInput.placeholder = 'Anthropic API key (sk-ant-...) — powers houseguest AI';
  keyInput.value = savedKey || '';
  card.append(keyInput);
  card.append(el('div', 'keynote', 'With a key, houseguests are played by Claude — real conversations, real memory, real jury speeches.<br>Without one, a simpler built-in dialogue engine is used. Your key stays in this browser only.'));

  const row = el('div', 'cine-actions');
  const start = el('button', 'bb gold', '● New Season');
  start.onclick = () => {
    onSaveKey(keyInput.value.trim());
    wrap.remove();
    onNew(nameInput.value.trim() || 'Sam');
  };
  row.append(start);
  if (hasSave) {
    const cont = el('button', 'bb primary', '▶ Continue Season');
    cont.onclick = () => {
      onSaveKey(keyInput.value.trim());
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
    const ob = el('button', 'bb primary', '🌐 Play Online with Friends (Beta)');
    ob.onclick = () => { wrap.remove(); onOnline(); };
    onlineRow.append(ob);
    card.append(onlineRow);
  }
  wrap.append(card);
  document.body.append(wrap);
}
