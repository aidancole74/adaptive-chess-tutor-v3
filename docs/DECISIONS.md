# Decisions and assumptions

Newest at the bottom. Each entry: decision, then why.

1. **Version control via isomorphic-git.** System `git` is not installed on the build machine and
   installing system software unasked is out of bounds, so commits are made with the pure-JS
   `isomorphic-git` dev dependency through `scripts/git.mts` (`npm run commit -- "msg"`). The `.git`
   directory is a normal repository; real git can take over at any time.
2. **Rating scale.** All thetas and difficulties use the Lichess puzzle-rating scale; logistic scale
   constant is 400/ln(10) ≈ 173.7 (Elo/Glicko convention).
3. **zstd.** Lichess dumps are decompressed with Node's built-in `zlib.createZstdDecompress`
   (Node >= 22.15); no native dependency.
5. **Lichess dumps use skippable zstd frames.** Node's zstd decoder yields nothing on them; the tactics and openings pipelines decode frame by frame (found by the pipeline agents).
6. **Puzzle file has an extra `DailyDate` column.** Accepted explicitly; any other header change fails the build.
7. **Opening explorer requires a token** (anonymous request returns HTTP 401). The local book is the default; a user token is optional and never exported.
8. **Book filters:** blitz or slower (base + 40 × inc ≥ 180 s), Normal or time-forfeit terminations, month 2026-10, first 2,000,000 games streamed.
9. **Forgetting.** Besides Glicko sigma growth, a concept estimate drifts down by 55 × log2(1 + days/30) rating points without review. An assumption, not fitted.
10. **FSRS weights** are the published FSRS-4.5 defaults, not fitted to the user.
11. **Weakness sampling** is a Thompson draw damped to 60% of the posterior spread and weighted by n/(n+2), so untested concepts are handled by the exploration share rather than dominating the weakness share.
12. **Lesson cards** contain no free-text chess claims: they show the concept's place in the DAG and a worked example from verified content (solution, engine line or tablebase result).
13. **Lessons when starved.** A new learner has only lesson-stage concepts; lessons may then fill any slot, interleaved with practice.
14. **Cause inference:** a failed exercise answered in under 15% of its time budget is pre-tagged "discipline"; the user can change the tag.
15. **Simulation learning model** is deliberately neutral (gain per attempt independent of success), so the target band does not win by construction. Under it, random allocation beats the scheduler on estimate RMSE and skill gain; this is reported, not tuned away.
4. **Content packs are committed** under `public/packs/` so the app is demoable without running
   multi-hour pipelines; pipelines remain re-runnable and cache raw downloads in `.cache/`.
16. **Instant move** = under 3 s AND under 2% of the base time (the stricter of the two). The original "either" rule labelled most blitz mistakes as instant (52 of 101 in the fixture games).
17. **Deviation drills** accept the book replies scoring within 4 points of the best reply with at least 8% popularity; this is book data, not engine-verified, and the facts say so.
18. **Conversion / hold thresholds:** convert from +2.5 (up to +12), hold from -1.5 to -6; success = 75% of the advantage retained, or no more than 1.5 pawns lost, after 12 moves at Stockfish depth 12.
19. **Blunder-check drill** pairs a real puzzle blunder (unsafe, by the Lichess solution) with an engine-best quiet move (safe, |eval| <= 1.5); it only runs when both sources exist.
20. **Human-likeness (M14)** uses the fallback the spec allows: a softmax over Stockfish MultiPV (4 lines, depth 10) with temperature T(r) = 25 + 260·exp(-(r-600)/550) centipawns. Not fitted to human games; Maia via ONNX was not attempted (model weights and an ONNX runtime would add tens of MB and their licence terms would need review).
21. **AI explanations** call the Messages API from the browser with the official SDK (`dangerouslyAllowBrowser: true`), model `claude-opus-5-5`, low effort, server-side refusal fallback (`fallbacks: "default"`). Only the exercise's verified facts are sent; replies mentioning any move or square outside the facts are discarded. Off by default; the key never leaves the device except to api.anthropic.com and is never exported.
22. **Strategy bank selection:** MultiPV 4 at depth 14; best line's first 3 plies quiet (no capture, check or promotion); |eval| <= 4.0, no mates; best move >= 60 cp ahead of the second. A depth-8 pre-filter speeds this up about 3x but skips roughly 40% of positions the full rule would keep, biasing toward moves that stand out early. 2,986 positions from 8,000 games (both players >= 2200).
23. **Quiet-best-move concept** is the feature the best move gains for the mover when there is one, else `strategy/planning/quiet-move`. Who-is-better is one multi-select question (better side + the flags that favour it), only when |eval| >= 0.8, and says attribution is heuristic.
24. **Evaluate-trade is switched off.** Under the 60 cp margin rule no available trade can come within 30 cp of the best move, so the bank has 0 "good" trades (562 bad, 86 neutral); a drill whose answer is never "good" would teach the wrong lesson. Re-enable once trades are sourced from positions without the margin rule.
25. **Static pawn-structure concepts** (isolated, doubled, IQP, bishop pair, Carlsbad, Maroczy) have few or no strategy items because quiet best moves rarely change those flags; they are reached through other formats or remain thin (see docs/content-qa.md).
