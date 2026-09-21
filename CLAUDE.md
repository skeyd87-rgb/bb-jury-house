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
- `src/world/scene.js` (house) + `src/world/movement.js` (controls, NPC wander, camera); `src/ui/ui.js` — all DOM panels; `src/audio/music.js` — synthesized adaptive score
- **Houseguest visuals** are fully procedural — the project ships no models or textures:
  - `src/world/anatomy.js` — geometry. `loft()` builds a body part from a stack of control rings (elliptical, optionally superelliptical) resampled through a Catmull-Rom spline; `headGeometry()` sculpts a sphere into a skull (brow ridge, orbits, nasal bridge, cheekbones, jaw taper, chin, lips); `RIG` holds the anthropometric landmark heights everything is measured against.
  - `src/world/appearance.js` — canvas-painted skin/face maps, irises, fabric weave + normal maps, the hair-strand card texture, and the per-houseguest wardrobe table. Everything is cached by key, so eight cotton shirts share one texture.
  - `src/world/hair.js` — an opaque scalp shell cut to a real hairline plus alpha-tested strand cards swept along the skull and released into gravity; also builds eyebrows.
  - `src/world/characters.js` — assembly + the two-bone rig, and the animation (walk cycle, breathing, blinking, idle drift, hair lag).
- Version watermark: `vite.config.js` injects `__APP_VERSION__` (package.json) and `__BUILD_STAMP__` (config-eval time — server start in dev, build time in prod); `src/main.js` paints them into `#version-mark`. Bump `package.json` version for anything a reviewer should be able to tell apart at a glance.

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

## Character-mesh rules (learned the hard way)

- **Garment shells are cut from the flat ring profile, which knows nothing about the body's sculpt.** Any shell covering a sculpted volume must get the same displacement — `bustBump` / `gluteBump` in `characters.js`. Add a new body bump, add it to the garments over it, or the body walks through the cloth.
- **Joints: the lower segment must be slightly wider than the upper one at the pivot**, so the upper segment's end cap is always buried. Each upper segment also runs a rounded nose ~10% past the pivot; straight it hides inside the lower segment, bent it is the surface that fills the outside of the joint. Bridge spheres do *not* work — at the same radius they intersect the limb and light as a separate bead.
- **Weld normals after any vertex work.** `finish()` averages normals across co-located vertices; both lofts and spheres duplicate a column at the UV seam, and unwelded that seam lights as a bright hairline down every limb.
- **Check winding when hand-building an index buffer.** The scalp shell and the eye surround were both inside-out and silently invisible (backface-culled), which looked like "the feature never got built". `loft()` reads its ring direction off the geometry because a torso is authored bottom-up while a limb hangs top-down, and the winding depends on which — every limb was inside-out for a while. An inverted closed surface keeps its silhouette, so it does not look obviously broken: it just lights flat and shows a hole at every joint where the far wall gets drawn instead of the near one. To check: average `normal · radial` over a mesh; it should be strongly positive.
- **Limb rotation signs.** Positive `rotation.x` swings a limb toward −Z, which is *backward* for a character facing +Z. Correct for a knee (heel goes back), wrong for an elbow — flexion brings the hand forward, so elbows need negative values. The same sign trap caught finger curl.
- **Arms have to clear the hips**, which on a wide build are broader than the shoulder joints. The rest angle is solved per character (`armRest`), not authored, or hands end up buried in the trousers.
- Necklines are made by *compressing* the shell's top band toward its lower edge, never by translating it: a translation slides the top ring past the ones beneath it (spikes) and drags the small neck-radius edge inside the chest.
- The torso loft grows its own neck and ends above the jaw, where the head hides its cap. A separate neck cylinder leaves the torso's flat top cap in the open under the chin.
