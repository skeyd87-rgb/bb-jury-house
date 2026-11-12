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
- `src/game/intel.js` — **what the player is allowed to know**: tiered reads of each houseguest, the vote count (`voteRead`), and what a huddle gives up (`huddleIntel`). Read-only apart from `recordIntel` (the player's notebook, `g.intel`). Reads call `nominationDesire`/`evictionDesire` with a flat `rand` so they show the current lean without rolling the dice; the real decision still rolls. `src/ui/houseread.js` is its panel.
- `src/ai/claude.js` — direct-from-browser Claude API (`claude-sonnet-5`), key in localStorage `bbjury.apikey`
- `src/ai/prompts.js` — system prompts incl. the JSON effects contract; `src/ai/fallback.js` — offline engine (same output shape) used when no key / API fails
- `src/main.js` — director: boots world, runs ceremonies/finale, wires UI↔engine↔AI. `window.__bb` is a debug hook (`.g`, `.openChat(id)`, `.ff([ids])` fast-forward)
- `src/world/postfx.js` — the composer: render → GTAO (half res) → bloom → tone map → FXAA → grade. `createScene` returns `render(t)`; nothing calls `renderer.render` directly any more. Quality is a five-step ladder (4 High … 0 Fast) trading effects and render resolution for frame time; it steps down by itself when frames average over 24 ms, persists in localStorage `bbjury.gfx`, and is exposed as Menu → Graphics and `__bb.postfx.quality`.
- `src/world/scene.js` (house) + `src/world/movement.js` (controls, NPC wander, camera, **huddles**, **ceremony staging**, floor rings); `src/ui/ui.js` — all DOM panels; `src/audio/music.js` — synthesized adaptive score
- **Look: "Live Feed"** — the game is dressed as the broadcast watching it.
  - One palette, in `style.css` `:root`: `--ink` surfaces, brass `--gold` (the show speaking), bone `--text`, `--danger` reserved for block/eviction/betrayal. The same values are baked into `scene.js` (sky, fog, lights, floors, set dressing) and the `cast.js` hues — change one, change the others.
  - The Live Feed section sits **last** in `style.css`, unscoped, and wins over the older layers by source order. Phone overrides for anything the old phone block also set (chat bottom sheet, toast) must use that block's query, `(max-width: 760px), (max-height: 500px)`, or the unscoped rules beat them.
  - The HUD hangs off a ruled safe-area frame (`body::after`); House Intel is the lower third (open by default, fold state kept across HUD rebuilds).
  - `src/ui/broadcast.js` draws what follows the camera: screen-space **nameplates** (name, HOH/NOM/VETO/YOU chip, and `→ YOU` while `g.pendingApproach` targets you) and the timecode. They stack instead of overlapping, clamp to the screen, fade with distance, and hide in a conversation close-up.
  - There are **no name or status sprites on the rig** any more. Nameplates read names from game state every frame, so renames need no repaint. `main.js` `broadcastState()` adapts single-player `g` and online `onlineGame`, which tracks progress by `turn.kind`, not `phase`.
- **Houseguest visuals** are fully procedural — the project ships no models or textures:
  - `src/world/anatomy.js` — geometry. `loft()` builds a body part from a stack of control rings (elliptical, optionally superelliptical) resampled through a Catmull-Rom spline; `headGeometry()` sculpts a sphere into a skull (brow ridge, orbits, nasal bridge, cheekbones, jaw taper, chin, lips); `RIG` holds the anthropometric landmark heights everything is measured against.
  - `src/world/appearance.js` — canvas-painted skin/face maps, irises, fabric weave + normal maps, the hair-strand card texture, and the per-houseguest wardrobe table. Everything is cached by key, so eight cotton shirts share one texture.
  - `src/world/hair.js` — an opaque scalp shell cut to a real hairline plus alpha-tested strand cards swept along the skull and released into gravity; also builds eyebrows.
  - `src/world/characters.js` — assembly + the two-bone rig, and the animation (walk cycle, breathing, blinking, idle drift, hair lag).
- Status chip (top right, `#version-mark`): a colour-coded AI dot plus the build stamp. `vite.config.js` injects `__APP_VERSION__` (package.json) and `__BUILD_STAMP__` (config-eval time — server start in dev, build time in prod). Bump `package.json` version for anything a reviewer should be able to tell apart at a glance.
- **AI status has three failure-relevant states**, not two (`src/ai/status.js`): `ai` green, `grounded` amber — the model answered but `validateNarrative` refused the reply, so the offline engine wrote the line — and `offline` grey, genuinely unreachable. Collapsing `grounded` into `offline` sends you hunting a network fault that isn't there. `grounding.js` tags its rejections with `err.grounded`; transport failures raised by the audit call itself stay untagged.
- `/api/chat` rate limiting is **per-IP (60/min) plus a global backstop (400/min)**. Remember each houseguest line costs *two* calls — the reply and its factual audit — so a limit of N/min is only N/2 replies. A single global bucket meant one busy conversation locked out everyone.
- A dropped connection or timeout is a `TransportError` (retried once), **not** `NoKeyError`. `NoKeyError` means the server secret is unset and is deliberately never retried; conflating the two made every transient blip permanent. 429 is surfaced with its code and not retried — an immediate retry only deepens the queue.

## Invariants to preserve

- **A houseguest may only hold a betrayal against the player if one happened.** `scripts/betrayal-regression-tests.mjs` pins each way the engine used to manufacture one; run it after touching `social.js`, `season.js`, `fallback.js` or `describeNpcMind`. The rules behind it:
  - A safety promise protects a name only when that name is the *object* of the protection (`isProtectedInText`), never just because it appears in the sentence.
  - "This week" promises end with the week (`settleWeekPromises`, called from `nextPhase` and the server's `advanceWeek`). Open-ended ones stand.
  - `recordBetrayalIfAny` only breaks the promise kinds its action can break (`BREAKS`), and takes `{ forced }` when the actor had no non-ally alternative.
  - Only `allianceSignal: 'accept'` forms an alliance. `'propose'` is the houseguest's offer and needs the player's yes.
  - `suspicionOfLie` costs trust; it never files a grudge.
  - An AI-proposed `targetDiscussed` is ignored unless the player said that name (`mentionsHouseguest`).
  - Memory text that enters a prompt names the player; "you" in a prompt means the houseguest reading it.

- **Intel never moves the game.** Everything in `intel.js` except `recordIntel` must leave `g.social`, `g.promises` and `g.alliances` untouched; `sim.js` `checkIntel` compares them byte-for-byte every simulated week. The only cost of listening is `applySpotted` (social.js), when the player is caught.
- Huddles (`world.startHuddle` / `endHuddle`, ranges `LISTEN_R`/`SPOT_R`) must end at every phase boundary (`advance()`; online, any non-`social` turn), when either speaker is frozen for a chat, and on their own timeout.
- **Online, the server owns huddles and intel.** `party/server.js` picks the pair (AI-played seats only), publishes `game.huddle` to everyone, and answers `huddleHeard` / `huddleSpotted` — the text of what was said goes only to the listener. The driving client picks the spot and it reaches the others with the position batches. `this.huddle` is transient, never persisted.
- **House Read online is built per viewer on the server** (`houseReadView(g, viewerId, humanIds)` → `game.houseRead` in that viewer's slice only). Tiers, never numbers; no lean for anyone who would not confide in that viewer; nothing at all read off a seat a human has claimed. `src/ui/houseread.js` renders that view model and never sees game state — keep it that way, it is what makes the same panel safe in both modes.
- Everything in `intel.js` takes the viewer. Single-player passes nothing (viewer `'you'`, notebook `g.intel`); the server passes the engine id (notebook `g.intelBy[id]`).
- Staged ceremonies: `stageOn()`/`stageOff()` in main.js are idempotent and `advance()` always calls `stageOff()` — a ceremony that throws must not leave the house frozen in a line-up or `body.staging` set (it hides the HUD).
- **Never position HUD blocks with numbers that assume another block's size.** The lower third sits above the dock by measurement (`layoutHud` in ui.js, run on every HUD mutation, resize and menu toggle). Fixed offsets broke the moment the dock gained a button. New corner furniture also needs a rule for what yields when a toast (`body.toast-open`) or a chat (`body:has(#chat-panel)`) takes that corner.
- Online, a seat with a connected person (`world.setHumans`, from the room roster) is moved only by their position reports and never by local AI; players heartbeat their position once a second while still. AI-played houseguests are simulated by ONE client, the driver (`drivingClient()` in main.js: the connected human with the lowest seat id), which sends `npcPos` batches at 5 Hz including the live huddle spot; followers play them back through `setNetTarget` / `setRemoteHuddle` and fall back to local AI 2.5 s after the batches stop. `npcHold` stops an AI houseguest on every screen while someone talks to them. The server only bounds and relays these (and drops rows that name an active human's seat); they are never game state.
- Clear the HUD with `resetHud()` (ui.js), never `innerHTML = ''`: the toast lives inside `#hud` and `resetHud` carries a live one across the rebuild. Online the HUD is rebuilt on every snapshot, so a raw wipe eats alliance invites and intel the instant anyone does anything.
- **Online, "human" means connected.** A claimed seat whose player is offline is played by the AI in every respect, conversation included: server code that decides who answers or acts must use `isActiveHuman`, not `isHuman` (which only says the seat was ever claimed); the client equivalent is `seatOffline()`. An offline seat can be reclaimed by another connection only with a seated online player's approval (`takeoverRequest` / `takeoverResponse`), or freely when nobody else is online.
- Room identity is per room code (`bbjury.roomIds` in room.js): each room issues its own token for a player id, so one shared slot gets overwritten by the next room joined.
- The room server is a separate Cloudflare Worker (`npx wrangler deploy`), not part of the GitHub Pages deploy. Anything under `src/game/` or `party/` reaches online games only after that redeploy. The client must keep working against an older server: treat `game.houseRead` and `game.huddle` as optional.

- Diary Room must have **zero** game-state side effects.
- Jury notes are snapshotted at eviction (`snapshotJuryNotes`) — jurors judge from what they knew then.
- Nothing decision-level is deterministic: comps, noms, votes, jury all include noise/weighted sampling.
- Fallback and Claude paths must return the same `{ reply, effects }` shape; `sanitizeEffects()` is the only entry to state.
- Final-4 veto: a non-nominated holder cannot use the veto (they'd be the only replacement) — **unless they are the HoH** (HoH can't be nominated, so the 4th HG goes up). `decideVetoUse`/`runVetoCeremony` both special-case this.
- Week phases: `week_intro → hoh_comp → social_hoh → nominations → social_veto → veto_comp → veto_lobby → veto_ceremony → [renom_watch if veto used] → campaigning → eviction`. `veto_lobby` (lobby the holder) and `renom_watch` (scramble before replacement named) are free-roam social windows. Veto apply is split: `applyVetoSave` (pull nominee) then `applyReplacement` (name renom), with `g.pendingRenom` between.
- Outgoing HoH is barred from the next HoH comp via `g.lastHoh` (set at week rollover, since `g.hoh` is nulled).
- Promise kinds: `safety | vote | vote_evict | alliance | final2 | info`. On eviction, promises to/from the evictee become `void` (not broken) except `alliance` (→kept) and `final2` (kept for jury memory). `vote_evict` is judged at the actual vote.
- **Houseguests settle; they do not wander.** `pickHangout` (movement.js) sends them to authored `HANGOUTS` spots for a 1–3 minute stay, then mostly small shifts within the room; `STAY` holds the durations and `ROOM_PULL` the room weights. Anything that ends an interaction (huddle, private walk, ceremony) must set `pauseUntil` from `STAY`, not a couple of seconds, or that houseguest starts pacing again. Target: about 5% of time walking per houseguest.
- NPCs must never endlessly follow the player: `world.releaseAllFollowers()` is called at every conversation/phase boundary; proactive approaches auto-expire (~22s).
- Alliances: form via button or organic chat (`formOfficialAlliance`), leave via `leaveAlliance` (soft betrayal), and decay if untended (`decayAlliances` in `simulateHouseLife`, driven by `al.lastActive`).
- Group chat is public (all present hear/remember); `/whisper <name>` is private but the rest notice. 1-on-1s can be overheard by physically-near NPCs (`applyEavesdrop` + `world.nearbyListeners`).

## Rendering rules

- **Performance is bound by passes over the scene, not by pixels alone.** Measured on Intel Iris Xe: every pass (main, shadow, AO normals) redraws everything, so draw calls and houseguest triangles multiply. Hence: the static set is merged by `batchStatic` (only plain opaque, untextured, non-emissive, front-sided standard materials — give an animated prop an emissive, a texture or `userData.dynamic`); houseguests cast shadows from a capsule proxy, not their meshes; the shadow map redraws every other frame; sheen/clearcoat are High-only (`applyMaterialTier`). Adding a point light costs every lit pixel in the house.
- Timing in a hidden preview pane is unreliable: rAF is throttled and GPU timings vary run to run by 50%. Compare like with like in one run, and do not quote a frame rate from it.

- **Bloom only sees values above 1.0** (the composer is half-float, threshold 1.0). A light source that should glow is a `MeshBasicMaterial` whose colour is multiplied past 1 (bulbs, the HoH neon, the stage ring); anything pale and merely well-lit must stay below it or it blooms into a white blob — the pool rim, umbrella and old white walls all did.
- **The AO pass redraws the scene with one opaque material.** Anything transparent, alpha-tested or back-faced is hidden while it runs (`overrideVisibility` in postfx.js), or hair cards, glass, water and floor decals occlude as solid slabs. A new see-through object that isn't caught by those tests needs `userData.noAO = true`.
- A flat surface that sits inside a taller solid is invisible: the pool water has to sit above the rim box's top face (0.22), not at the old water height.

## Character-mesh rules (learned the hard way)

- **Garment shells are cut from the flat ring profile, which knows nothing about the body's sculpt.** Any shell covering a sculpted volume must get the same displacement — `bustBump` / `gluteBump` in `characters.js`. Add a new body bump, add it to the garments over it, or the body walks through the cloth.
- **Joints: the lower segment must be slightly wider than the upper one at the pivot**, so the upper segment's end cap is always buried. Each upper segment also runs a rounded nose ~10% past the pivot; straight it hides inside the lower segment, bent it is the surface that fills the outside of the joint. Bridge spheres do *not* work — at the same radius they intersect the limb and light as a separate bead.
- **…and cross at a shallow angle.** Two separate meshes always crease where they cross; the crossing angle decides whether you see it. The upper segment should hold its width into the joint (the condyles), not pinch to its narrowest at the pivot. The lower segment sits just inside it above the pivot and just outside its taper below, growing only ~3% across the crossing. A notch-then-bulge reads as a mannequin ring; a steep dome at the crossing catches the key light as a bright line. Garment shells obey the same rule — full trousers once ended 7% *wider* than the calf shell, and drew a band round every knee.
- **Weld normals after any vertex work.** `finish()` averages normals across co-located vertices; both lofts and spheres duplicate a column at the UV seam, and unwelded that seam lights as a bright hairline down every limb.
- **Check winding when hand-building an index buffer.** The scalp shell and the eye surround were both inside-out and silently invisible (backface-culled), which looked like "the feature never got built". `loft()` reads its ring direction off the geometry because a torso is authored bottom-up while a limb hangs top-down, and the winding depends on which — every limb was inside-out for a while. An inverted closed surface keeps its silhouette, so it does not look obviously broken: it just lights flat and shows a hole at every joint where the far wall gets drawn instead of the near one. To check: average `normal · radial` over a mesh; it should be strongly positive.
- **Limb rotation signs.** Positive `rotation.x` swings a limb toward −Z, which is *backward* for a character facing +Z. Correct for a knee (heel goes back), wrong for an elbow — flexion brings the hand forward, so elbows need negative values. The same sign trap caught finger curl.
- **Arms have to clear the hips**, which on a wide build are broader than the shoulder joints. The rest angle is solved per character (`armRest`), not authored, or hands end up buried in the trousers.
- Necklines are made by *compressing* the shell's top band toward its lower edge, never by translating it: a translation slides the top ring past the ones beneath it (spikes) and drags the small neck-radius edge inside the chest.
- The torso loft grows its own neck and ends above the jaw, where the head hides its cap. A separate neck cylinder leaves the torso's flat top cap in the open under the chin.
