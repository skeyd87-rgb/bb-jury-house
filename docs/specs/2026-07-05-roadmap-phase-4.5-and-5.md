# Roadmap — Phase 4.5 (Single-Player AI Hardening) & Phase 5 (MP Online Completion)

Status as of 2026-07-05: Phases 1–4 done & deployed (lobby, server-authoritative season,
social chat over the wire, drop-in/out). Sequencing decision: **harden the AI in single-player
first** (fast to iterate + fully testable), then carry every improvement into multiplayer in
Phase 5.

Deploy reminder: the game engine + AI live in `src/` and are shared — single-player runs them in
the browser; the multiplayer server (`party/`) imports the same files. So Phase 4.5 fixes in
`src/ai/*` and `src/game/*` improve BOTH modes; Phase 5 wires the online-specific UI/flows around
them. Client changes ship on `git push` (GitHub Pages); server changes also need `wrangler deploy`.

---

## Phase 4.5 — Single-Player AI Hardening

Goal: make houseguest dialogue and the jury feel genuinely human and grounded, plus a small UX
gap. Items are prompt/logic work in `src/ai/*` (free, verifiable in single-player) plus one HUD fix.

### 4.5.0 — Exit-to-menu (quick UX)
- **Problem:** no in-game way to quit; player must close the tab/app.
- **Fix:** a HUD menu button (☰) → "Exit to Title". Single-player: auto-save already persists every
  phase, so exiting drops to the menu and "Continue Season" resumes; also offer quit-to-new-season.
  Online: becomes "Leave Room" (disconnect → AI takes over the seat via Phase 4; reclaim on rejoin).
- Size: small. Client-only (ships on push; online-leave uses existing server behavior). Cost: free.

### 4.5.1 — Fix group/house-meeting AI (BUG, highest priority)
- **Problem:** group chats and house meetings silently fall back to canned template lines even
  with a valid API key. Cause: the group call asks Claude for a large nested JSON (a reply +
  effects for every member + alliance data) that truncates at the token cap / fails to parse, so
  the code drops to `fallbackGroupChat`.
- **Fix:** raise `maxTokens` for group/house-meeting/jury calls; simplify the required JSON shape;
  make the parser recover partial responses instead of bailing; surface a visible "(offline reply)"
  tag when a fallback DOES fire so failures stop being invisible.
- Size: medium. Cost: free-ish (a few more tokens per group call).

### 4.5.2 — Stop NPCs inventing events (anti-hallucination)
- **Problem:** NPCs reference promises/votes/conversations that never happened. Their real memory
  IS in the prompt, but the model fills gaps by confabulating.
- **Fix:** strict grounding instruction ("ONLY reference events explicitly listed in your memory
  below; never invent promises, votes, or history"); feed more complete/accurate context so there's
  less gap to fill; consider a light post-check that flags obviously invented specifics.
- **Honest limit:** LLMs can't be made perfectly factual — target is "rare," not "never."
- Size: medium. Cost: free.

### 4.5.3 — Detailed, grounded jury reasoning
- **Problem:** jurors often give the generic "My vote is for X. They played the game that mattered
  to me" instead of citing real events.
- **Fix:** strengthen `buildJurorVotePrompt` to demand a specific, personal reason tied to an actual
  logged event (a broken promise, a betrayal, a kept deal); raise the token limit so reasons don't
  truncate to a stub; rewrite the fallback jury vote to cite that juror's real grudges/promises so
  even keyless votes read specific.
- Size: small–medium. Cost: free-ish.

### 4.5.4 — Voice for the jury (pinned idea, now scoped in)
- iPhone keyboard dictation already lets you speak answers today (free, reliable on iOS).
- Add jurors *speaking* their questions aloud via text-to-speech (browser `speechSynthesis` free;
  optional premium per-character AI voices cost $). Optional in-app 🎤 button (Web Speech API —
  great on Chrome/Android, unreliable on iOS Safari, degrades gracefully).
- Goal: a spoken jury exchange — you dictate answers, they reply aloud.
- Size: medium. Cost: free (browser TTS) or small $ (premium voices).

**Suggested build order:** 4.5.1 → 4.5.2 → 4.5.3 → 4.5.4.

---

## Phase 5 — Multiplayer Online Completion

Goal: bring the full richness of single-player into online play. Each item wires online UI/flows
around the (now-hardened) shared engine. Client + server; ships on push + `wrangler deploy`.

### 5.1 — Port all Phase 4.5 AI gains to the server
- The server AI (`party/ai.js`, using the shared prompts) inherits 4.5's grounding, token, and
  parsing fixes automatically — but verify online group/jury calls specifically.

### 5.2 — Online jury Q&A (NEW — not built anywhere yet)
- Online finale is currently engine-only (a winner is chosen, no Q&A).
- Build the interactive jury round online, and design the multi-human interaction:
  - **Human jurors** type (or dictate) their own question to the finalists and cast their own vote.
  - **AI jurors** ask/vote via the (hardened) engine.
  - **Human finalist(s)** answer live; an AI finalist answers via Claude.
  - Vote-by-vote reveal to all connected players.
- Size: large. Cost: free-ish (Claude for AI jurors/finalist).

### 5.3 — Online social tools
- Bring Form Alliance, Group Talk, House Meeting, whispers, and eavesdropping online (currently
  single-player only; online has 1-on-1 chat that can form alliances via AI effects, but no
  dedicated multi-person tools). Server-routed, effects applied server-side.
- Size: large. Cost: free-ish.

### 5.4 — Diary Room online
- Wire the private confessional into multiplayer (zero game-state side effects, per invariant).
- Size: small.

### 5.5 — Real-time movement sync
- Broadcast player positions so humans see each other walk the house and cluster live (currently
  each sees only their own avatar; others mill as AI).
- Size: medium (position streaming + interpolation). Cost: free.

### 5.6 — Online status & stats
- Show jury list, alliances, promise tracking, and the post-game Season Stats + Post-Game Analysis
  screens live in multiplayer (single-player only today). Respect the render-safe projection
  (don't leak hidden social state).
- Size: medium.

### 5.7 — Phase timers (async workday pacing)
- Proper server-driven countdown per phase (removed in Phase 4 for stalling; reimplement carefully),
  so "nominations by 5pm" async play works without someone hitting Continue. Host override kept.
- Size: medium.

### 5.8 — Reconnection UX + spectators
- Clean "reconnecting…" flow; spectator mode when all 9 seats are taken.
- Size: medium.

### 5.9 — Mobile lobby tuning
- Responsive pass on the lobby/join/seat screens (the game world already got one).
- Size: small.

**Suggested Phase 5 order:** 5.2 (jury Q&A) → 5.3 (social tools) → 5.5 (movement) → 5.7 (timers)
→ the rest as polish.
