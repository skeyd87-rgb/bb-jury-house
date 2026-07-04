# BB Jury House — Online Multiplayer Design (2026-07-04)

Decisions locked with user: **online room-codes** (not couch mode), backend = **PartyKit on Cloudflare**.

## The core shift: authoritative server

Today the game is single-authority: one browser owns the `game` state object and mutates it directly. For
multiplayer that model has to invert:

- **The PartyKit room server becomes the single source of truth.** It holds the `game` state, runs the phase
  machine, resolves comps, makes NPC decisions, and calls Claude. One room = one season.
- **Clients become thin.** Each phone connects over WebSocket, **sends actions** ("nominate Rae", "cast vote",
  "here's my comp score", chat message) and **receives state snapshots + an event stream**, then renders the
  3D world + UI from that. Clients never mutate game state directly.
- **Single-player still works unchanged** — it stays client-authoritative. Multiplayer is an *added mode*, so
  we never break the working game. A `NetAdapter` abstraction lets `main.js` talk to either "local engine" or
  "remote room" behind one interface.

This is feasible because `src/game/*` and `src/ai/*` are already pure logic with no DOM/render coupling — they
move to a `shared/` folder imported by BOTH the client (local mode) and the PartyKit server (online mode).

## Seats

Nine houseguests = nine seats. In an online room:
- Humans **claim** seats at join; unclaimed seats are AI-controlled (existing NPC engine).
- Each connection controls exactly one seat. The player IS that houseguest — they chat, nominate, vote, and
  compete as them.
- The player seat's persona for AI-takeover is inferred from their play (relationships built, promises made).

## Join flow

1. Host: **"Host Online Season"** → client asks server to create a room → server returns a short **room code**
   (e.g. `BB-4KQ7`). Host shares it (text/airdrop).
2. Others: **"Join with Code"** → enter code → pick an open seat (or spectate if full) → connected.
3. Host configures: which seats are open to humans, phase timer lengths, and starts the season.

## Drop-in / drop-out (the workday feature)

- A player's socket dropping → their seat **flips to AI**, which plays in-character using that seat's
  accumulated memory + inferred profile. The house keeps moving.
- Reconnect (same identity token in localStorage) → **reclaim the seat**, AI hands control back, full memory
  intact.
- So people can dip in and out across a workday and the season never stalls.

## Phase advancement (multiple humans)

- **Social phases**: run on a **timer** (host sets length, e.g. 20 min). A live countdown shows on all phones.
  Host can **advance early** (override). Nobody is blocked waiting on an absent player.
- **Ceremonies** (noms, veto, eviction): **ready-checks** — each involved human acts; a per-player timeout
  auto-decides via the AI engine if someone's away, so the show goes on.
- **Comps**: every human plays the mini-game on their own screen; AI fills absent/AI seats; the server collects
  all scores and resolves the winner.

## API key

- Host's Anthropic key lives as a **PartyKit server secret** (set once at deploy). All Claude calls happen
  **server-side**; player phones never see or send the key.
- A per-room **spend meter** (tokens used) is surfaced to the host, with an optional cap.

## Chat routing

- **Human↔Human**: relayed directly through the room (no AI cost).
- **Human↔AI seat**: server calls Claude in-character. **Group chats / house meetings** mix both — humans see
  each other's lines live; AI seats reply via Claude.
- Whispers, eavesdropping, alliances, promises: same engine rules, now evaluated server-side and broadcast.

## Tech

- **Server**: `party/server.js` — a PartyKit `Server` class (Cloudflare Durable Object per room). Imports
  `shared/` game+AI logic. Holds `game` state in memory, persists to Durable Object storage so a room survives
  restarts. Handles `onConnect`, `onMessage` (actions), broadcasts snapshots, runs timers via alarms.
- **Client**: existing Vite app + a `NetAdapter` (WebSocket). New title-screen options: Host / Join. Existing
  local single-player untouched.
- **Deploy**: `npx partykit deploy` (server) → free Cloudflare account; client stays on GitHub Pages, pointed
  at the deployed PartyKit URL.

## Phased build plan (multi-session)

1. **Phase 1 — Foundations (this session):** move `src/game` + `src/ai` → `shared/`; add a `NetAdapter`
   seam so local mode still works identically; scaffold the PartyKit server; room create/join + seat claiming +
   lobby state sync. Deliverable: two browsers join a room and see a shared lobby. No gameplay yet.
2. **Phase 2 — Server-run season:** the phase machine + comps + eviction run server-side and broadcast to all
   clients; humans play comps locally and submit scores; ceremonies driven by the seat's human or AI fallback.
3. **Phase 3 — Social layer online:** human↔human + human↔AI chat, group/house meetings, alliances, promises,
   whispers, eavesdropping over the wire.
4. **Phase 4 — Drop-in/out + timers:** AI takeover on disconnect, reclaim on reconnect, phase timers +
   ready-checks + host override, spend meter.
5. **Phase 5 — Polish:** reconnection UX, spectators, edge cases, mobile pass for the lobby/join screens.

## Non-goals (for now)

Matchmaking/public rooms, accounts/logins (room code + localStorage identity is enough), voice, cross-room
persistence beyond a single season.
