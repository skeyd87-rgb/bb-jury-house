# CLAUDE.md

**BB Jury House** — a Sims-style 3D Big Brother social-strategy game. Browser-based, Vite + Three.js + vanilla JS. Fresh project (2026-07-03); shares nothing with the older "Big Brother Game" Unity prototype.

Design spec: [docs/specs/2026-07-03-bb-jury-house-design.md](docs/specs/2026-07-03-bb-jury-house-design.md)

## Commands

```powershell
Set-Location "C:\Users\KeyHo\OneDrive\Desktop\Coding Projects\Projects\BB Jury House"
npm run dev      # dev server (use --port 5199)
npm run build    # production build
```

Headless logic test: open `/test.html` in a browser — runs 60 simulated seasons via `src/test/sim.js` and prints stats/errors as JSON. Run this after changing anything in `src/game/`.

## Architecture

**The engine owns all social truth; Claude only proposes.** `src/game/` is authoritative game state; `src/ai/` produces dialogue + candidate effects; `applyChatEffects()` in `social.js` clamps and applies them.

- `src/game/state.js` — game state, per-NPC memory (grudges, betrayals, promises, gossip, convo summaries), save/load (localStorage `bbjury.save.v1`)
- `src/game/cast.js` — 8 NPCs (original characters, BB10×BB16 archetypes) with personality numbers + persona prompts
- `src/game/social.js` — effect application, betrayal/promise bookkeeping, off-screen NPC drift + gossip leaks, proactive-approach picker
- `src/game/season.js` — phase machine; all nominations/votes are weighted-probabilistic over live social state (never scripted)
- `src/game/comps.js` — 3 DOM mini-games returning a 0–100 player score
- `src/ai/claude.js` — direct-from-browser Claude API (`claude-sonnet-5`), key in localStorage `bbjury.apikey`
- `src/ai/prompts.js` — system prompts incl. the JSON effects contract; `src/ai/fallback.js` — offline engine (same output shape) used when no key / API fails
- `src/main.js` — director: boots world, runs ceremonies/finale, wires UI↔engine↔AI. `window.__bb` is a debug hook (`.g`, `.openChat(id)`, `.ff([ids])` fast-forward)
- `src/world/` — Three.js house/characters/controls; `src/ui/ui.js` — all DOM panels; `src/audio/music.js` — synthesized adaptive score

## Invariants to preserve

- Diary Room must have **zero** game-state side effects.
- Jury notes are snapshotted at eviction (`snapshotJuryNotes`) — jurors judge from what they knew then.
- Nothing decision-level is deterministic: comps, noms, votes, jury all include noise/weighted sampling.
- Fallback and Claude paths must return the same `{ reply, effects }` shape; `sanitizeEffects()` is the only entry to state.
- Final-4 veto: a non-nominated holder cannot use the veto (they'd be the only replacement) — **unless they are the HoH** (HoH can't be nominated, so the 4th HG goes up). `decideVetoUse`/`runVetoCeremony` both special-case this.
- Week phases: `week_intro → hoh_comp → social_hoh → nominations → social_veto → veto_comp → veto_lobby → veto_ceremony → [renom_watch if veto used] → campaigning → eviction`. `veto_lobby` (lobby the holder) and `renom_watch` (scramble before replacement named) are free-roam social windows. Veto apply is split: `applyVetoSave` (pull nominee) then `applyReplacement` (name renom), with `g.pendingRenom` between.
- Outgoing HoH is barred from the next HoH comp via `g.lastHoh` (set at week rollover, since `g.hoh` is nulled).
- Promise kinds: `safety | vote | vote_evict | alliance | final2 | info`. On eviction, promises to/from the evictee become `void` (not broken) except `alliance` (→kept) and `final2` (kept for jury memory). `vote_evict` is judged at the actual vote.
- NPCs must never endlessly follow the player: `world.releaseAllFollowers()` is called at every conversation/phase boundary; proactive approaches auto-expire (~22s).
- Alliances: form via button or organic chat (`formOfficialAlliance`), leave via `leaveAlliance` (soft betrayal), and decay if untended (`decayAlliances` in `simulateHouseLife`, driven by `al.lastActive`).
- Group chat is public (all present hear/remember); `/whisper <name>` is private but the rest notice. 1-on-1s can be overheard by physically-near NPCs (`applyEavesdrop` + `world.nearbyListeners`).
