# BB Jury House — Design Spec (2026-07-03)

Approved by user 2026-07-03. Fresh project; nothing reused from the old "Big Brother Game" Unity prototype.

## Product

A single-player, browser-based, Sims-style 3D Big Brother social-strategy game. The season starts
at the **jury phase with 9 houseguests** (the player + 8 NPCs) and plays down to a Final 2 and a
full, interactive jury vote. The design thesis: **the social game decides everything** — comps,
nominations, votes, and the winner are all emergent from relationships and dialogue, never scripted.

## Stack

- **Vite + vanilla JS modules + Three.js** for the 3D world. No framework.
- **Claude API (claude-sonnet-5)** called directly from the browser
  (`anthropic-dangerous-direct-browser-access` header). API key entered once, stored in
  `localStorage`. Offline fallback: templated dialogue engine so the game runs without a key
  (used for dev verification too).
- **WebAudio** synthesized adaptive music. No audio assets.
- Save/load season state to `localStorage`.

## World

- Stylized low-poly toon-look house: living room, kitchen, two bedrooms, HoH suite, Diary Room,
  backyard/comp area. Color-coded rooms, warm lighting, orbit/zoom camera.
- Characters: capsule-ish stylized figures, distinct palette/hair/build, floating name tags +
  mood emoji. NPCs wander rooms, pair up into visible chats, idle bob/walk animations.
- Player: WASD/click-to-move. Approach NPC + `E`/click → chat panel.

## Cast — original characters from BB10 × BB16 archetypes

1. **Marcus** — calm mastermind/teacher; everyone's confidant (Dan/Derrick).
2. **Rae** — loyal soldier, comp beast, slightly delusional about her own game (Caleb).
3. **Zoe** — anxious superfan, over-strategizes, name-drops game jargon (Nicole).
4. **Flynn** — flamboyant social butterfly, plays every side, drama magnet (Frankie).
5. **Gus** — beloved folksy older outsider; wins hearts, not comps (Donny/Jerry).
6. **Tessa** — conflict-avoidant floater who drifts toward power (Victoria/April).
7. **Nash** — chaotic loose cannon; unpredictable votes, brutal honesty (Zach/Memphis).
8. **Bev** — eccentric, loud, motherly, emotional; long memory for slights (Renny/Libra).

Each NPC has personality numbers (loyalty, bitterness, compSkill, socialSkill, chaos,
strategic) + persona prompt for Claude.

## Social engine (engine owns state; Claude owns words)

Per-NPC persistent memory: trust/threat toward everyone, alliances, promises (made/received,
kept/broken), betrayals witnessed, grudges, conversation summaries, gossip heard. Chat pipeline:
player message + persona + memory + game context → Claude → JSON with `reply` **and** structured
effects (`trustDelta`, `promise`, `suspicion`, `infoLearned`, `allianceSignal`). Engine validates
and applies effects. Contradictions and witnessed betrayals permanently scar relationships.
NPC↔NPC off-screen socialization each phase (cheap simulated drift + occasional gossip leaks,
including leaking player secrets with probability tied to the confidant's loyalty).

## Non-determinism

- **Comps**: interactive mini-games (timing bar, memory sequence, reaction targets). Player's
  real performance scores; NPC scores = compSkill + noise.
- **Nominations/votes**: weighted probabilistic decisions over live social state — threat, trust,
  promises, alliance pressure, gossip. Never fixed.
- **Proactive NPCs**: context triggers make NPCs approach the player (ally check-in after noms,
  HoH summons, nominee campaigning, rumor confrontation).

## Season structure

Week loop: HoH comp → social → nominations → Veto comp → veto ceremony → campaigning → live
vote → eviction → evictee joins jury with full memory. 9 → 3, then 3-part-flavored final HoH,
Final 2, then **full jury Q&A**: each juror asks memory-grounded questions; player types real
answers; opponent answers via Claude; each juror votes from relationship history + bitterness
+ Claude's judgment of answer quality. Vote-by-vote reveal.

## Diary Room

Private confessional, zero game-state side effects. Producer-voice asks leading questions.

## Music

WebAudio adaptive score: ambient house loop, comp track, nomination/eviction tension stings,
jury reveal cue.

## Non-goals

Photorealism, voice acting, paid assets, multiplayer, pre-jury phase.
