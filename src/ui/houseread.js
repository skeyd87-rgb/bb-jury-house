// House Read: the player's own picture of the house — how each houseguest
// reads toward them, the vote count as far as people will tell them, what
// they've overheard, and the promises still on the table.
//
// Pure presentation of a view model (intel.js houseReadView). Single-player
// builds the view from its own game; online, the room server builds it for
// each human and sends it in their private slice of the snapshot. The panel
// never sees game state, and opening it changes nothing.

import { cinematic, el } from './ui.js';

const hex = (c) => '#' + Number(c).toString(16).padStart(6, '0');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STANDING = { ally: 'Ally', warm: 'Warm', neutral: 'Neutral', cool: 'Cool', hostile: 'Hostile', human: 'Human player' };
const CHIP = { hoh: 'HOH', nom: 'NOM', vet: 'VETO' };

function meter(label, read, invert) {
  // Five pips. For threat, more is worse, so the colour ramp is inverted.
  const good = invert ? 4 - read.level : read.level;
  const tone = good >= 3 ? 'good' : good <= 1 ? 'bad' : 'mid';
  const pips = Array.from({ length: 5 }, (_, i) => `<i class="${i <= read.level ? 'on' : ''}"></i>`).join('');
  return `<div class="hr-meter ${tone}"><span>${label}</span><div class="hr-pips">${pips}</div><em>${read.label}</em></div>`;
}

function peopleTab(view) {
  const order = { ally: 0, warm: 1, neutral: 2, cool: 3, hostile: 4, human: 5 };
  return [...view.people].sort((a, b) => order[a.read.standing] - order[b.read.standing]).map((p) => {
    const r = p.read;
    const chips = p.chips.map((c) => `<b class="hr-chip ${c}">${CHIP[c]}</b>`);
    if (r.allied) chips.push('<b class="hr-chip al">ALLIANCE</b>');
    const notes = [];
    for (const t of r.youPromised || []) notes.push(`<div class="hr-note">You promised: “${esc(t)}”</div>`);
    for (const t of r.promisedYou || []) notes.push(`<div class="hr-note">They promised: “${esc(t)}”</div>`);
    for (const t of (r.grudges || []).slice(-2)) notes.push(`<div class="hr-note bad">Holds it against you: ${esc(t)}</div>`);
    const body = r.human
      ? `<div class="hr-note">Played by a person. There is nothing to read here — talk to them.</div>`
      : `<div class="hr-meters">${meter('Trust', r.trust)}${meter('Bond', r.bond)}${meter('Threat', r.threat, true)}</div>`;
    return `<div class="hr-row ${r.standing}">
      <div class="hr-who"><span class="hr-hue" style="background:${hex(p.color)}"></span>
        <div><div class="hr-name">${esc(p.name)} ${chips.join('')}</div><div class="hr-job">${esc(p.job)}</div></div>
        <span class="hr-standing">${STANDING[r.standing]}</span></div>
      ${body}${notes.join('')}
    </div>`;
  }).join('');
}

function voteTab(view) {
  const v = view.vote;
  if (!v) return `<p class="hr-empty">No one is on the block yet. The count starts when nominations are set.</p>`;
  const [a, b] = v.nominees;
  const rows = v.rows.map((r) => {
    const lean = r.lean === 'unread'
      ? `<span class="hr-lean unread">${r.human ? 'A person — ask them' : 'Won’t say — earn their trust'}</span>`
      : r.lean === 'torn'
        ? '<span class="hr-lean torn">Torn</span>'
        : `<span class="hr-lean set">Evict ${esc(r.leanName)}</span>`;
    return `<div class="hr-vote"><b>${esc(r.name)}</b>${lean}</div>`;
  }).join('');
  return `<div class="hr-tally">
      <div><span>Evict ${esc(a.name)}</span><b>${v.count[0]}</b></div>
      <div><span>Evict ${esc(b.name)}</span><b>${v.count[1]}</b></div>
      <div class="dim"><span>Torn</span><b>${v.count[2]}</b></div>
      <div class="dim"><span>Unknown</span><b>${v.count[3]}</b></div>
    </div>
    <p class="hr-sub">${v.needed} votes evict.${v.playerVotes ? ' Your own vote is not counted here.' : ''} Leans are what people say today — they can move before the vote.</p>
    ${rows}`;
}

function intelTab(view) {
  if (!view.intel.length) {
    return `<p class="hr-empty">Nothing overheard yet. When two houseguests step aside to talk, stand inside the gold ring to listen — but stay out of the red one, or they’ll see you.</p>`;
  }
  return view.intel.map((x) => `<div class="hr-intel ${esc(x.kind)}"><span>WK ${String(x.week).padStart(2, '0')} · ${esc(x.sources)}</span>${esc(x.text)}</div>`).join('');
}

function promiseTab(view) {
  if (!view.promises.length) return `<p class="hr-empty">No promises on the record. The jury will ask what your word was worth.</p>`;
  return view.promises.map((p) => `<div class="hr-promise ${esc(p.status)}"><span>${esc(p.dir)} · wk ${p.week}</span>“${esc(p.text)}”<b>${esc(String(p.status).toUpperCase())}</b></div>`).join('');
}

export function showHouseRead(view, startTab = 'people') {
  const c = cinematic({ kicker: 'House Read', title: 'Where you stand', cardCls: 'read-card' });
  const tabs = [
    ['people', 'Houseguests', peopleTab],
    ['votes', 'Vote count', voteTab],
    ['intel', `Overheard${view.intelCount ? ` (${view.intelCount})` : ''}`, intelTab],
    ['promises', 'Promises', promiseTab],
  ];
  const bar = el('div', 'hr-tabs');
  const body = el('div', 'hr-body');
  const show = (key) => {
    for (const b of bar.children) b.classList.toggle('on', b.dataset.tab === key);
    body.innerHTML = tabs.find((t) => t[0] === key)[2](view);
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
