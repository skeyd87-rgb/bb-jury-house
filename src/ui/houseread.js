// House Read: the player's own picture of the house — how each houseguest
// reads toward them, the vote count as far as people will tell them, what
// they've overheard, and the promises still on the table.
//
// It shows only what intel.js allows the player to know. Pure presentation:
// opening it changes nothing.

import { cinematic, el } from './ui.js';
import { nameOf } from '../game/state.js';
import { PLAYER_ID } from '../game/cast.js';
import { readHouse, voteRead } from '../game/intel.js';

const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STANDING = { ally: 'Ally', warm: 'Warm', neutral: 'Neutral', cool: 'Cool', hostile: 'Hostile' };

function meter(label, read, invert) {
  // Five pips. For threat, more is worse, so the colour ramp is inverted.
  const good = invert ? 4 - read.level : read.level;
  const tone = good >= 3 ? 'good' : good <= 1 ? 'bad' : 'mid';
  const pips = Array.from({ length: 5 }, (_, i) => `<i class="${i <= read.level ? 'on' : ''}"></i>`).join('');
  return `<div class="hr-meter ${tone}"><span>${label}</span><div class="hr-pips">${pips}</div><em>${read.label}</em></div>`;
}

function peopleTab(g) {
  const order = { ally: 0, warm: 1, neutral: 2, cool: 3, hostile: 4 };
  const reads = readHouse(g).sort((a, b) => order[a.standing] - order[b.standing]);
  return reads.map((r) => {
    const hg = g.houseguests.find((h) => h.id === r.id);
    const chips = [];
    if (g.hoh === r.id) chips.push('<b class="hr-chip hoh">HOH</b>');
    if (g.nominees.includes(r.id)) chips.push('<b class="hr-chip nom">NOM</b>');
    if (g.vetoHolder === r.id) chips.push('<b class="hr-chip vet">VETO</b>');
    if (r.allied) chips.push('<b class="hr-chip al">ALLIANCE</b>');
    const notes = [];
    for (const t of r.youPromised) notes.push(`<div class="hr-note">You promised: “${esc(t)}”</div>`);
    for (const t of r.promisedYou) notes.push(`<div class="hr-note">They promised: “${esc(t)}”</div>`);
    for (const t of r.grudges.slice(-2)) notes.push(`<div class="hr-note bad">Holds it against you: ${esc(t)}</div>`);
    return `<div class="hr-row ${r.standing}">
      <div class="hr-who"><span class="hr-hue" style="background:${hex(hg.color)}"></span>
        <div><div class="hr-name">${esc(hg.name)} ${chips.join('')}</div><div class="hr-job">${esc(hg.job || '')}</div></div>
        <span class="hr-standing">${STANDING[r.standing]}</span></div>
      <div class="hr-meters">${meter('Trust', r.trust)}${meter('Bond', r.bond)}${meter('Threat', r.threat, true)}</div>
      ${notes.join('')}
    </div>`;
  }).join('');
}

function voteTab(g) {
  const v = voteRead(g);
  if (!v) return `<p class="hr-empty">No one is on the block yet. The count starts when nominations are set.</p>`;
  const [n1, n2] = v.nominees;
  const nm = (id) => (id === PLAYER_ID ? 'You' : esc(nameOf(g, id)));
  const rows = v.rows.map((r) => {
    const lean = r.lean === 'unread'
      ? '<span class="hr-lean unread">Won’t say — earn their trust</span>'
      : r.lean === 'torn'
        ? '<span class="hr-lean torn">Torn</span>'
        : `<span class="hr-lean set">Evict ${nm(r.lean)}</span>`;
    return `<div class="hr-vote"><b>${nm(r.id)}</b>${lean}</div>`;
  }).join('');
  return `<div class="hr-tally">
      <div><span>Evict ${nm(n1)}</span><b>${v.count[n1]}</b></div>
      <div><span>Evict ${nm(n2)}</span><b>${v.count[n2]}</b></div>
      <div class="dim"><span>Torn</span><b>${v.count.torn}</b></div>
      <div class="dim"><span>Unknown</span><b>${v.count.unread}</b></div>
    </div>
    <p class="hr-sub">${v.needed} votes evict.${v.playerVotes ? ' Your own vote is not counted here.' : ''} Leans are what people say today — they can move before the vote.</p>
    ${rows}`;
}

function intelTab(g) {
  const items = (g.intel || []).slice(-12).reverse();
  if (!items.length) {
    return `<p class="hr-empty">Nothing overheard yet. When two houseguests step aside to talk, stand inside the gold ring to listen — but stay out of the red one, or they’ll see you.</p>`;
  }
  return items.map((x) => `<div class="hr-intel ${x.kind}"><span>WK ${String(x.week).padStart(2, '0')} · ${x.sourceIds.map((id) => esc(nameOf(g, id))).join(' + ')}</span>${esc(x.text)}</div>`).join('');
}

function promiseTab(g) {
  const mine = g.promises.filter((p) => p.from === PLAYER_ID || p.to === PLAYER_ID).slice(-14).reverse();
  if (!mine.length) return `<p class="hr-empty">No promises on the record. The jury will ask what your word was worth.</p>`;
  return mine.map((p) => {
    const dir = p.from === PLAYER_ID ? `You → ${esc(nameOf(g, p.to))}` : `${esc(nameOf(g, p.from))} → you`;
    return `<div class="hr-promise ${p.status}"><span>${dir} · wk ${p.week}</span>“${esc(p.text)}”<b>${p.status.toUpperCase()}</b></div>`;
  }).join('');
}

export function showHouseRead(g, startTab = 'people') {
  const c = cinematic({ kicker: 'House Read', title: 'Where you stand', cardCls: 'read-card' });
  const tabs = [
    ['people', 'Houseguests', peopleTab],
    ['votes', 'Vote count', voteTab],
    ['intel', `Overheard${g.intel?.length ? ` (${g.intel.length})` : ''}`, intelTab],
    ['promises', 'Promises', promiseTab],
  ];
  const bar = el('div', 'hr-tabs');
  const body = el('div', 'hr-body');
  const show = (key) => {
    for (const b of bar.children) b.classList.toggle('on', b.dataset.tab === key);
    body.innerHTML = tabs.find((t) => t[0] === key)[2](g);
    body.scrollTop = 0;
  };
  for (const [key, label] of tabs) {
    const b = el('button', 'hr-tab', label);
    b.type = 'button';
    b.dataset.tab = key;
    b.onclick = () => show(key);
    bar.append(b);
  }
  c.card.insertBefore(bar, c.actions);
  c.card.insertBefore(body, c.actions);
  c.setActions([{ label: 'Back to the house', onClick: () => c.close() }]);
  show(startTab);
  return c;
}
