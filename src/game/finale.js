import { PLAYER_ID } from './cast.js';
import { activeIds } from './state.js';

export function buildFinaleContext(g) {
  const finalists = activeIds(g);
  const jurors = (g.jury || []).slice(-7);
  const playerJurorIndex = jurors.indexOf(PLAYER_ID);
  const playerRole = finalists.includes(PLAYER_ID)
    ? 'finalist'
    : playerJurorIndex >= 0
      ? 'juror'
      : 'spectator';

  return { finalists, jurors, playerRole, playerJurorIndex };
}

export function countJuryVotes(finalists, votes) {
  const counts = Object.fromEntries(finalists.map((id) => [id, 0]));
  for (const vote of votes) {
    if (Object.prototype.hasOwnProperty.call(counts, vote.vote)) counts[vote.vote]++;
  }
  return counts;
}

export function winnerFromJuryVotes(finalists, votes) {
  const counts = countJuryVotes(finalists, votes);
  return [...finalists].sort((a, b) => counts[b] - counts[a])[0];
}

export function playerPlacement(g) {
  const idx = (g.evicted || []).indexOf(PLAYER_ID);
  return idx >= 0 ? g.houseguests.length - idx : 1;
}
