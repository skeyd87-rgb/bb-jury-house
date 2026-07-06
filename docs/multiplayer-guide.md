# Playing BB Jury House Online — Setup & Session Guide

## 1. One-time setup (you, the host/operator)

The game is already deployed and live — nobody else needs to install anything.

- **Client:** GitHub Pages, auto-deploys from `main`.
- **Server:** Cloudflare Worker at `bb-jury-house.skeyd87.workers.dev`.

**Optional but recommended — turn on AI for everyone with zero setup per player:**

```powershell
npx wrangler secret put ANTHROPIC_API_KEY
```

Paste your Anthropic key when prompted. Once set, every single-player game *and*
every multiplayer room automatically gets Claude-powered houseguests — no
player, ever, on any device, has to paste in a key (there's no key field in the
app at all). If you skip this, the game still works fine — a built-in offline
dialogue engine covers AI houseguests instead. A tiny dot in the top-left
corner of the screen shows which mode is active: green means Claude is
answering, gray means the offline engine has taken over for that reply.

## 2. Hosting a session

1. Whoever hosts opens the game and clicks **Play Online with Friends**.
2. Click **Host New House**. You'll land in a lobby with a room code like `BB-XY4Q`.
3. Click **Copy Invite** — this puts a ready-to-paste message (with the link and
   code) on your clipboard. Send it to your group via text/Discord/whatever.
4. Everyone else opens the game, clicks **Play Online with Friends → Join with
   Code**, types their name and the room code, and lands in the same lobby.

## 3. Seating

- There are 9 seats: the 8 established houseguests (Marcus, Rae, Zoe, Flynn,
  Gus, Tessa, Nash, Bev) plus one **Newcomer** seat.
- Anyone can claim any open seat by tapping **Claim**. Whoever you are, you
  play as that seat's houseguest.
- **If you claim Newcomer**, you get to name your own houseguest — a "Rename"
  box appears on your seat card once you've claimed it, exactly like naming
  your character in single-player.
- **Unclaimed seats are played by AI** for the whole season — you don't need
  a full 9 people. Even a 2-person game works (everyone else is AI).
- If more than 9 people show up, extras who don't grab a seat automatically
  become **spectators** once the host starts — they watch the house from a
  free-floating camera and can't act, but they see everything live.
- **Joining after the season already started?** You'll land as a spectator
  too — but if any houseguest is still active and nobody's claimed them yet,
  a **🎮 Take Over a Houseguest** button appears. Pick one and you're playing
  them from that moment on (AI covered whatever happened before you joined).
- The host can set the **social phase length** (5 min to 2 hours) — this is
  how long each free-roam window lasts before the timer auto-advances (see
  §5). Good for a same-room game night (5–10 min) vs. an async group-chat-style
  game played over a day (1–2 hours).
- Whoever created the room is the **host** — only they can start the season,
  and only they see the "Continue ▶" button on result screens (see §5).

## 4. Starting the season

Once at least one seat is claimed, the host clicks **▶ Start the Season**.
From here the game plays exactly like single-player, except every human-played
houseguest is controlled by whoever claimed that seat, and AI covers the rest.

## 5. How a live session actually plays out

Each week cycles through the same phases as single-player:

**Intro → HoH Comp → Social → Nominations → Social → Veto Comp → Social →
Veto Ceremony → (Replacement if used) → Campaigning → Eviction → next week.**

- **Comps:** if you're in the comp, you get a "Compete!" button and play the
  actual mini-game (timing/count/reaction). Everyone not competing just waits.
- **Nominations / Veto / Eviction:** only the HoH, veto holder, or voters (as
  applicable) get an action prompt. Everyone else sees a "waiting on X" card.
- **Social phases (free-roam):** no modal — walk the house, tap a houseguest
  to talk 1-on-1, or use the persistent buttons (bottom-right) for:
  - **🎥 Diary Room** — private, zero effect on the game.
  - **🤝 Form Alliance** — invite specific people; each decides individually.
  - **💬 Group Talk** — pull 2–4 people into a shared conversation everyone in
    it can see and reply to live (human or AI). Type `/whisper <name> <msg>`
    inside a group to say something privately to one member — everyone else
    in the group notices you whispered, even though they can't read it.
  - **📢 House Meeting** — same as Group Talk but with the whole house.
  - **🚪 Leave** — steps away; AI takes over your seat until you rejoin with
    the same room code (see §6).
  - The host has a **▶ Continue** button to advance past the current free-roam
    window whenever they're ready (e.g. "▶ Nominations").
- **Result screens** (comp results, nomination reveal, veto ceremony, eviction
  reveal, etc.) are shown to everyone; only the **host** can click Continue to
  move to the next phase.
- **Jury phase (final 7 evicted onward):** evicted players join the jury and
  can no longer act, but rejoin at the finale to question the finalists and
  vote — human jurors type their own question and cast their own vote with
  reasoning; AI jurors do the same via the engine.
- **Timers:** every action has a countdown shown at the top of the screen
  (based on the host's chosen social-phase length). If it runs out before
  everyone acts, AI automatically covers whoever hasn't. The host can also
  force this early with **⏩ Skip waiting** if someone's clearly AFK.

## 6. Dropping in and out mid-season

- Click **🚪 Leave** any time (even mid-comp or mid-ceremony) — AI immediately
  takes over your seat so the game never stalls.
- To come back, just reopen the game, click **Join with Code**, and enter the
  **same room code**. You'll be reunited with your original seat automatically.
- If your connection just drops (phone locks, wifi hiccups, tab closes), the
  game shows a "Reconnecting…" screen and retries on its own; AI covers your
  seat in the meantime exactly the same way.

## 7. Winning

At the finale, the jury questions and votes on the Final 2 live (see §5), and
a season summary (comp wins, promises kept/broken, eviction order, alliances
formed) is shown to everyone before returning to the title screen.

## 8. Good formats to try

- **Same-room game night:** everyone on their own phone/laptop in the same
  room, 5–10 min social phases, play a full season in an evening.
- **Async "workday" game:** 1–2 hour social phases, everyone checks in
  between other things over a day or two — nobody has to be online at the
  same moment except to act when it's their turn (which the timer/AI-cover
  makes optional anyway).
- **Mixed human/AI house:** 2–4 real players claiming a few seats, AI filling
  the rest — a lighter-weight way to try it with a small group.
