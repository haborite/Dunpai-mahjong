---
name: project-tatemahjong
description: 盾麻雀 web game project — custom rules mahjong with shield tiles mechanic
metadata:
  type: project
---

Building 盾麻雀 (Tate Mahjong / Shield Mahjong) — a modified Japanese riichi mahjong web game.

**Location:** C:\Users\hosomi\Programs\original_mahjong

**Stack:** Node.js + Express + ws (WebSocket) + vanilla JS frontend

**Key custom rules:**
- Shield tiles (盾牌): each player has face-down shields; can exchange hand tile (goes face-up in shield area) for a shield tile (goes to river)
- A shield exchange can be used as the declaration discard for riichi or open riichi
- Shield exchange is operated by selecting a face-down shield first, then clicking a hand tile
- Face-up shield tiles provide tsumo defense if opponent's wait tile is in them
- Open riichi disables shield protection
- Riichi and open riichi both require a closed hand
- After riichi, non-winning draws are automatically discarded; only tsumo/ron and wait-preserving concealed kan interrupt auto-discard
- Passing ron causes temporary furiten until the next own draw; passing after riichi causes furiten for the rest of the round
- No fu scoring — han-only (1H:1200, 2H:2400, 3H:4800, 4H:9600, then +2400/han)
- No round/dealer wind rotation (seat winds fixed), no consecutive dealer
- Standard dora indicators and one red five in each suit
- No dead wall, no riichi sticks
- New yaku values: 清一色 fixed 5H, 混一色 fixed 2H
- Game ends when top-bottom score diff >50000 or 10 rounds played
- All start at 0 pts, minus pts allowed, no bankruptcy

**Architecture:**
- src/mahjong/tiles.js — tile types, creation, utilities
- src/mahjong/wall.js — tile bag shuffle/draw
- src/mahjong/hand-parser.js — win detection, shanten, tenpai tiles
- src/mahjong/yaku.js — yaku detection from win form
- src/mahjong/scoring.js — score calculation
- src/mahjong/game-engine.js — game state machine
- src/npc/ai.js — NPC AI (simple defensive)
- src/room.js — room management + NPC routing
- server.js — Express + WebSocket server
- public/ — client HTML/CSS/JS

**Known issues/TODOs:**
- NPC AI uses simple heuristic (no look-ahead), chi not implemented
- Shield selection UI could be more polished
- Client-side state sync could be more robust
- Missing: reconnection flow, room listing

Why: user request to build this custom mahjong game from scratch.
