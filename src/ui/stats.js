// Season stats: snapshot builder + full-screen stats page.
// A snapshot is archived to localStorage at season end (win, loss, or
// eviction) so it survives starting a new season.

import { PLAYER_ID } from '../game/cast.js';
import { nameOf, rel, activeIds } from '../game/state.js';
import { el, cinematic } from './ui.js';

const ARCHIVE_KEY = 'bbjury.lastSeason';

function hex(c) {
  return '#' + c.toString(16).padStart(6, '0');
}

// final: { result: 'winner'|'runner-up'|'evicted', tally?, oppId?, juryVotes?, place }
export function buildSeasonStats(g, final) {
  const npcName = (id) => (id === PLAYER_ID ? g.playerName : nameOf(g, id));
  const colorOf = (id) => hex(g.houseguests.find((h) => h.id === id)?.color ?? 0xffffff);

  // votes cast against the player across the season
  let votesAgainstYou = 0;
  for (const v of g.voteHistory || []) {
    for (const t of Object.values(v.votes)) if (t === PLAYER_ID) votesAgainstYou++;
  }

  // relationship extremes among everyone still holding opinions (all NPCs)
  let fan = null, enemy = null;
  for (const h of g.houseguests) {
    if (h.id === PLAYER_ID) continue;
    const r = rel(g, h.id, PLAYER_ID);
    const warmth = r.trust + r.bond;
    if (!fan || warmth > fan.score) fan = { name: h.name, color: colorOf(h.id), score: warmth, trust: r.trust, bond: r.bond };
    if (!enemy || warmth < enemy.score) enemy = { name: h.name, color: colorOf(h.id), score: warmth, trust: r.trust, bond: r.bond };
  }

  return {
    date: new Date().toLocaleDateString(),
    playerName: g.playerName,
    result: final.result,
    place: final.place,
    weeks: g.week,
    tally: final.tally || null, // { you, opp, oppName }
    juryVotes: final.juryVotes || null, // [{ name, color, vote ('you'|name), reasoning }]
    compRecord: (g.compHistory || []).map((c) => ({
      week: c.week,
      type: c.type,
      winner: npcName(c.winner),
      color: colorOf(c.winner),
      isYou: c.winner === PLAYER_ID,
    })),
    evictionOrder: g.evicted.map((id, i) => ({
      name: npcName(id),
      color: colorOf(id),
      isYou: id === PLAYER_ID,
      week: i + 1 <= 6 ? i + 1 : g.week,
    })),
    promises: g.promises
      .filter((p) => p.from === PLAYER_ID)
      .map((p) => ({ to: npcName(p.to), text: p.text, status: p.status, week: p.week })),
    betrayals: (g.events || [])
      .filter((e) => e.type === 'betrayal')
      .map((e) => ({ week: e.week, text: e.text, byYou: e.actors?.[0] === PLAYER_ID })),
    leaks: (g.events || []).filter((e) => e.type === 'leak').map((e) => ({ week: e.week, text: e.text })),
    alliances: g.alliances
      .filter((a) => a.members.includes(PLAYER_ID))
      .map((a) => ({ name: a.name, members: a.members.filter((m) => m !== PLAYER_ID).map(npcName), dead: a.dead })),
    votesAgainstYou,
    fan,
    enemy,
  };
}

export function archiveSeason(stats) {
  try {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(stats));
  } catch (e) {
    console.warn('archive failed', e);
  }
}

export function loadArchivedSeason() {
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---- Rendering ----------------------------------------------------------

function section(title, bodyEl) {
  const s = el('div', 'stats-section');
  s.append(el('h3', '', title));
  s.append(bodyEl);
  return s;
}

function dot(color) {
  return `<span class="s-dot" style="background:${color}"></span>`;
}

export function showStatsPage(stats, onClose) {
  const headline =
    stats.result === 'winner'
      ? `🏆 ${stats.playerName} — WINNER of Big Brother`
      : stats.result === 'runner-up'
      ? `🥈 ${stats.playerName} — Runner-up`
      : `${stats.playerName} — Evicted, ${stats.place} place`;

  const c = cinematic({
    kicker: `Season Stats — ${stats.date}`,
    title: headline,
    cardCls: 'stats-card',
  });

  const wrap = el('div', 'stats-wrap');

  // Headline numbers
  const grid = el('div', 'stats-grid');
  const compWins = stats.compRecord.filter((x) => x.isYou).length;
  const kept = stats.promises.filter((p) => p.status === 'kept').length;
  const broken = stats.promises.filter((p) => p.status === 'broken').length;
  const cells = [
    [stats.weeks, 'weeks in the house'],
    [compWins, 'comps won'],
    [stats.votesAgainstYou, 'votes cast against you'],
    [`${kept}/${kept + broken || 1}`, 'promises kept'],
    [stats.betrayals.filter((b) => b.byYou).length, 'betrayals committed'],
    [stats.leaks.length, 'secrets leaked'],
  ];
  for (const [n, label] of cells) {
    const cell = el('div', 'stats-cell');
    cell.append(el('div', 'n', String(n)));
    cell.append(el('div', 'l', label));
    grid.append(cell);
  }
  wrap.append(grid);

  // Jury votes
  if (stats.juryVotes && stats.juryVotes.length) {
    const jv = el('div');
    jv.innerHTML = `<div class="s-tally">Final tally: <b>You ${stats.tally.you}</b> — <b>${stats.tally.oppName} ${stats.tally.opp}</b></div>` +
      stats.juryVotes
        .map(
          (v) =>
            `<div class="s-row">${dot(v.color)}<b>${v.name}</b> → ${v.vote === 'you' ? '<b class="gold">YOU</b>' : v.vote}<div class="s-sub">"${v.reasoning}"</div></div>`
        )
        .join('');
    wrap.append(section('The Jury', jv));
  }

  // Comp record
  if (stats.compRecord.length) {
    const cr = el('div');
    cr.innerHTML = stats.compRecord
      .map((x) => `<div class="s-row">${dot(x.color)}Week ${x.week} ${x.type === 'hoh' ? '👑 HoH' : '🛡️ Veto'} — ${x.isYou ? '<b class="gold">YOU</b>' : x.winner}</div>`)
      .join('');
    wrap.append(section('Competition Record', cr));
  }

  // Eviction order
  if (stats.evictionOrder.length) {
    const eo = el('div');
    eo.innerHTML = stats.evictionOrder
      .map((x, i) => `<div class="s-row">${dot(x.color)}${i + 1}. ${x.isYou ? '<b class="gold">YOU</b>' : x.name}</div>`)
      .join('');
    wrap.append(section('Eviction Order', eo));
  }

  // Your promises
  if (stats.promises.length) {
    const icon = (s) => (s === 'kept' ? '✅' : s === 'broken' ? '❌' : s === 'void' ? '⚪' : '⏳');
    const pr = el('div');
    pr.innerHTML = stats.promises
      .map((p) => `<div class="s-row">${icon(p.status)} wk${p.week} to <b>${p.to}</b>: "${p.text}"</div>`)
      .join('');
    wrap.append(section('Your Promises (⚪ dissolved when they left the game)', pr));
  }

  // Betrayals
  if (stats.betrayals.length) {
    const bt = el('div');
    bt.innerHTML = stats.betrayals
      .map((b) => `<div class="s-row">${b.byYou ? '🔪' : '🩸'} wk${b.week}: ${b.text}</div>`)
      .join('');
    wrap.append(section('Betrayals (🔪 by you)', bt));
  }

  // Leaks
  if (stats.leaks.length) {
    const lk = el('div');
    lk.innerHTML = stats.leaks.map((l) => `<div class="s-row">🗣️ wk${l.week}: ${l.text}</div>`).join('');
    wrap.append(section('Information Leaks', lk));
  }

  // Alliances + hearts
  const al = el('div');
  al.innerHTML =
    (stats.alliances.length
      ? stats.alliances.map((a) => `<div class="s-row">${a.dead ? '💀' : '🤝'} <b>${a.name}</b> — ${a.members.join(', ')}</div>`).join('')
      : '<div class="s-row">No alliances. Lone wolf run.</div>') +
    (stats.fan ? `<div class="s-row">💛 Biggest fan at the end: ${dot(stats.fan.color)}<b>${stats.fan.name}</b> (trust ${stats.fan.trust}, bond ${stats.fan.bond})</div>` : '') +
    (stats.enemy ? `<div class="s-row">🧊 Coldest on you: ${dot(stats.enemy.color)}<b>${stats.enemy.name}</b> (trust ${stats.enemy.trust}, bond ${stats.enemy.bond})</div>` : '');
  wrap.append(section('Alliances & Hearts', al));

  c.card.insertBefore(wrap, c.actions);
  c.setActions([
    {
      label: 'Close',
      style: 'primary',
      onClick: () => {
        c.close();
        onClose && onClose();
      },
    },
  ]);
}
