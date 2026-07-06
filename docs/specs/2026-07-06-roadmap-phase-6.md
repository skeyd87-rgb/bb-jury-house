# Roadmap — Phase 6 (aspirational)

Status as of 2026-07-06: Phases 1–5 and 4.5 are done and deployed — server-authoritative
multiplayer season loop, full online social layer, drop-in/out, jury Q&A, reconnection/spectator,
mobile lobby, server-hosted API key, plus a run of live-testing fixes (duplicate houseguests,
Take Over overlay bug, mid-season rename tag refresh, human-to-human chat threading, room-code
badge, one-click rejoin). Nothing is currently blocking; this is groundwork for what's next, not a
committed plan — pick items freely, any order.

---

### 6.1 — Docs pass
- **Problem:** `docs/multiplayer-guide.md` still describes the old flow (only the Newcomer seat
  can be renamed; no mention of "rename any seat," host "End Session," or the room-code badge /
  rejoin list).
- **Fix:** rewrite the join/rename/leave sections to match current behavior.
- Size: small. Cost: free.

### 6.2 — Per-room AI spend visibility
- **Problem:** the original multiplayer design called for a host-visible token spend meter (and
  optional cap) since the server-hosted key is shared across all rooms; it was never built — right
  now a host has no idea how much a session is costing or any way to cap it.
- **Fix:** track tokens/requests per room (and/or globally) in the Durable Object, surface a small
  running count to the host, optional soft cap that degrades to the offline engine instead of
  hard-failing.
- Size: medium. Cost: free (just accounting).

### 6.3 — Room abuse gate
- **Problem:** the global `RateLimiter` caps total request volume, but any stranger who guesses or
  is handed a room code can join and start burning the shared API key — no room-level gate exists.
- **Fix:** optional host-set room password/PIN at creation, checked on join. Keep it optional so
  casual play with friends stays frictionless.
- Size: small–medium. Cost: free.

### 6.4 — Installable PWA
- **Problem:** 4.5.5 papered over browser storage eviction with a manual tip ("add to home screen
  makes storage sticky"), but the app isn't an actual installable PWA — no manifest, no offline
  shell, no proper "Add to Home Screen" prompt.
- **Fix:** add a web app manifest + minimal service worker (cache the shell, not game state) so the
  install prompt works properly and the icon/splash look native.
- Size: small–medium. Cost: free.

### 6.5 — Async play notifications
- **Problem:** the whole pitch of phase timers + drop-in/out is workday-paced async play, but
  there's no way to know it's your turn without having the tab open — someone has to remember to
  check back.
- **Fix:** browser push notifications (Web Push, opt-in) for "it's your move" (comp open, you're
  nominated, jury question waiting). No new backend beyond a subscription store per player.
- Size: large (Web Push plumbing + Cloudflare-side subscription storage). Cost: free.

### 6.6 — AI-controlled NPC position sync (previously pinned, revisit)
- **Problem:** only human-controlled movement syncs across clients today; AI wander is local-only
  per client, so two humans can see the same AI houseguest in different spots. Explicitly deferred
  earlier this session pending it becoming an actual problem.
- **Fix (if revisited):** server picks/broadcasts AI target positions periodically (coarse, not
  per-frame) so AI houseguests read the same to everyone; client-side interpolation smooths it.
- Size: medium. Cost: free. **Only pick this up if it's actually bothered someone in play** — the
  earlier call was that it wasn't worth building speculatively.

### 6.7 — More competition variety
- **Problem:** only 3 DOM mini-games exist; with repeat play (especially multi-season households)
  the same comps get stale.
- **Fix:** a few more comp types in the same 0–100-score contract (`src/game/comps.js`), reusing the
  existing scoring/broadcast plumbing — no architecture change, just more content.
- Size: medium (content, not systems work). Cost: free.

### 6.8 — Automated multiplayer regression suite
- **Problem:** every MP bug fix this session was verified by hand-written one-off scripts against
  `wrangler dev` (scripted WebSocket clients), then deleted. There's no standing test suite —
  the next fix starts from zero again.
- **Fix:** promote the best of those scripts (duplicate-seat join, take-over mid-comp, human-human
  chat threading, rename propagation) into a small `test/mp/` suite that can run in CI against a
  local `wrangler dev` instance.
- Size: medium. Cost: free.

---

No suggested build order — these are independent of each other. 6.1 is trivial and worth doing
regardless; 6.2/6.3 matter more the more this gets shared outside your own household; 6.5/6.8 are
the biggest lifts and only worth it if async play or fix-velocity actually becomes a pain point.
