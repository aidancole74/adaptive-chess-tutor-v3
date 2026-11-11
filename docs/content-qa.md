# Content QA report

Generated 2026-11-11T16:19:56.323Z by `npm run data:qa`. Counts are recomputed from the shipped shard files; legality is re-checked with chess.js.

| Pack | Items | Verified | Legal (re-checked) | Duplicates |
| --- | --- | --- | --- | --- |
| endgames | 1,107 | 100.0% | 100.0% | 0.09% |
| openings (names) | 3,865 | 100.0% | 100.0% | — |
| openings (traps) | 7 | 100.0% | 100.0% | — |
| strategy | 2,986 | 100.0% | 100.0% | 0.00% |
| tactics | 59,983 | 100.0% | 100.0% | 0.00% |

## Items per concept and tier

| Concept | T0 | T1 | T2 | T3 | T4 | T5 | T6 | Total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| endgames/drawing/fortress | 0 | 0 | 0 | 0 | 0 | 21 | 6 | 27 |
| endgames/mating/kqk | 79 | 0 | 0 | 0 | 0 | 0 | 0 | 79 |
| endgames/mating/krk | 80 | 0 | 0 | 0 | 0 | 0 | 0 | 80 |
| endgames/minor/knight-vs-bishop | 0 | 0 | 0 | 14 | 7 | 28 | 0 | 49 |
| endgames/minor/opposite-color-bishops | 0 | 0 | 0 | 16 | 16 | 20 | 0 | 52 |
| endgames/minor/same-color-bishops | 0 | 0 | 0 | 21 | 15 | 16 | 0 | 52 |
| endgames/minor/wrong-bishop | 0 | 0 | 27 | 40 | 13 | 0 | 0 | 80 |
| endgames/pawn/key-squares | 0 | 0 | 22 | 58 | 0 | 0 | 0 | 80 |
| endgames/pawn/opposition | 0 | 0 | 80 | 0 | 0 | 0 | 0 | 80 |
| endgames/pawn/outside-passed-pawn | 0 | 0 | 64 | 11 | 5 | 0 | 0 | 80 |
| endgames/pawn/pawn-race | 0 | 5 | 28 | 47 | 0 | 0 | 0 | 80 |
| endgames/pawn/rule-of-the-square | 4 | 49 | 27 | 0 | 0 | 0 | 0 | 80 |
| endgames/pawn/zugzwang | 0 | 0 | 0 | 0 | 0 | 80 | 0 | 80 |
| endgames/queen/kq-vs-kp | 0 | 0 | 31 | 33 | 4 | 0 | 0 | 68 |
| endgames/rook/cutting-off-king | 0 | 0 | 0 | 10 | 0 | 0 | 0 | 10 |
| endgames/rook/lucena | 0 | 0 | 79 | 1 | 0 | 0 | 0 | 80 |
| endgames/rook/philidor | 0 | 0 | 0 | 10 | 0 | 0 | 0 | 10 |
| endgames/rook/rook-behind-passed-pawn | 0 | 0 | 9 | 26 | 5 | 0 | 0 | 40 |
| openings/skills/structures | 0 | 0 | 71 | 0 | 0 | 0 | 0 | 71 |
| openings/skills/traps | 0 | 7 | 0 | 0 | 0 | 0 | 0 | 7 |
| strategy/planning/quiet-move | 0 | 0 | 236 | 1580 | 1170 | 0 | 0 | 2986 |
| tactics/attack/attackingF2F7 | 137 | 184 | 261 | 278 | 191 | 182 | 317 | 1550 |
| tactics/attack/exposedKing | 79 | 121 | 264 | 232 | 203 | 204 | 450 | 1553 |
| tactics/attack/kingsideAttack | 224 | 187 | 258 | 251 | 171 | 149 | 336 | 1576 |
| tactics/attack/queensideAttack | 207 | 181 | 249 | 257 | 173 | 153 | 328 | 1548 |
| tactics/attack/sacrifice | 109 | 138 | 240 | 210 | 201 | 189 | 461 | 1548 |
| tactics/basics/hangingPiece | 206 | 229 | 302 | 286 | 186 | 160 | 345 | 1714 |
| tactics/basics/mateIn1 | 338 | 237 | 272 | 287 | 206 | 186 | 22 | 1548 |
| tactics/double-attack/discoveredAttack | 152 | 219 | 308 | 283 | 198 | 182 | 353 | 1695 |
| tactics/double-attack/doubleCheck | 101 | 169 | 269 | 280 | 223 | 183 | 324 | 1549 |
| tactics/double-attack/fork | 183 | 394 | 548 | 385 | 207 | 167 | 432 | 2316 |
| tactics/double-attack/pin | 155 | 219 | 291 | 258 | 201 | 178 | 386 | 1688 |
| tactics/double-attack/skewer | 150 | 229 | 280 | 251 | 168 | 184 | 380 | 1642 |
| tactics/double-attack/xRayAttack | 87 | 189 | 278 | 275 | 207 | 213 | 304 | 1553 |
| tactics/mating/anastasiaMate | 245 | 347 | 369 | 367 | 146 | 63 | 11 | 1548 |
| tactics/mating/arabianMate | 236 | 264 | 376 | 286 | 208 | 116 | 62 | 1548 |
| tactics/mating/backRankMate | 296 | 288 | 284 | 289 | 176 | 138 | 77 | 1548 |
| tactics/mating/bodenMate | 302 | 601 | 364 | 170 | 79 | 23 | 5 | 1544 |
| tactics/mating/doubleBishopMate | 574 | 715 | 55 | 114 | 32 | 11 | 3 | 1504 |
| tactics/mating/dovetailMate | 78 | 266 | 412 | 397 | 223 | 111 | 61 | 1548 |
| tactics/mating/hookMate | 115 | 212 | 345 | 383 | 245 | 168 | 80 | 1548 |
| tactics/mating/mateIn2 | 294 | 203 | 240 | 243 | 170 | 178 | 220 | 1548 |
| tactics/mating/mateIn3 | 279 | 191 | 228 | 218 | 175 | 167 | 290 | 1548 |
| tactics/mating/mateIn4 | 14 | 221 | 282 | 249 | 215 | 208 | 358 | 1547 |
| tactics/mating/mateIn5 | 0 | 18 | 133 | 230 | 318 | 351 | 449 | 1499 |
| tactics/mating/smotheredMate | 133 | 239 | 483 | 522 | 150 | 19 | 1 | 1547 |
| tactics/pawns/advancedPawn | 238 | 185 | 252 | 233 | 158 | 143 | 354 | 1563 |
| tactics/pawns/promotion | 284 | 213 | 265 | 238 | 170 | 136 | 316 | 1622 |
| tactics/pawns/underPromotion | 12 | 80 | 71 | 85 | 118 | 184 | 159 | 709 |
| tactics/removing-defender/attraction | 121 | 175 | 262 | 241 | 175 | 183 | 434 | 1591 |
| tactics/removing-defender/capturingDefender | 31 | 136 | 271 | 284 | 202 | 213 | 440 | 1577 |
| tactics/removing-defender/clearance | 83 | 166 | 252 | 233 | 164 | 194 | 460 | 1552 |
| tactics/removing-defender/deflection | 115 | 176 | 280 | 260 | 180 | 174 | 447 | 1632 |
| tactics/removing-defender/interference | 19 | 158 | 270 | 261 | 194 | 208 | 441 | 1551 |
| tactics/removing-defender/intermezzo | 15 | 122 | 261 | 293 | 189 | 213 | 488 | 1581 |
| tactics/subtle/defensiveMove | 120 | 210 | 276 | 254 | 214 | 211 | 595 | 1880 |
| tactics/subtle/quietMove | 218 | 185 | 226 | 204 | 147 | 170 | 493 | 1643 |
| tactics/subtle/trappedPiece | 44 | 141 | 279 | 253 | 205 | 201 | 444 | 1567 |
| tactics/subtle/zugzwang | 111 | 185 | 239 | 216 | 167 | 178 | 462 | 1558 |

## Concepts with no shipped items

- tactics/awareness/noTactic
- endgames/pawn/triangulation
- openings/repertoire/white-lines
- openings/repertoire/black-lines
- openings/skills/deviation

Calculation, time-management, defence and sparring drills are generated at run time from the packs above (or from board geometry) and are not counted here.

### Openings book

Meta from the pipeline: {"month":"2026-10","gamesStreamed":2000000,"gamesAggregated":1263720}
