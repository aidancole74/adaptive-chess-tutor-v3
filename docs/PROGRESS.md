# Progress log

## Status

| Milestone | State | Notes |
| --- | --- | --- |
| M0 scaffold | done | Vite/React/TS strict, ESLint, Vitest, Playwright, docs, isomorphic-git commits |
| M1 chess infrastructure | done | Board (drag, tap-tap, typed SAN/UCI, aria description, 4 themes), Stockfish lite single-threaded worker, tablebase client (cache, rate limit, offline), feature extractors (~0.01 ms/position), motif detectors |
| M2 learner model | done | Hierarchical Glicko nodes, partial pooling, sigma growth + forgetting drift, FSRS memory, calibration (Brier, ECE, reliability, confidence model), causes, Dexie, JSON export/import |
| M3 content + tactics | done | 59,983 Lichess puzzles, 100% chess.js validation, 0% duplicates after dedup |
| M4 scheduler + session | done | Scoring, hard constraints, template, mix, why-lines, lessons; e2e |
| M5 import + diagnosis | done | Lichess/Chess.com/PGN (live field names confirmed), analysis queue, detectors (51/101 mistakes classified on fixtures), time report, Review screen; e2e with real in-browser engine |
| M6 endgames | done | 1,107 tablebase-verified positions over 18 concepts (~3,800 API requests, all cached); triangulation 0 (unverifiable); library screen; e2e |
| M7 openings | done | 2M games streamed (2026-10), 3,865 names, 71 cards, 7 engine-confirmed traps; repertoire builder, FSRS line training, deviation drills, book exits; e2e |
| M8 strategy bank | done | 2,986 quiet positions (91,267 analysed at depth 14, MultiPV 4); evaluate-trade disabled (DECISIONS #24); lazy provider |
| M9 calc/defence/sparring/time | done | All drill types wired; conversion/hold from games + bank; sparring vs human-like engine; blunder-check, timed drills |
| M10 curriculum | done | DAG validation, unlock/decay, stages, gate, placement test, lesson cards |
| M11 dashboard etc. | done | Dashboard, all settings (tests prove they change scheduling), onboarding, explanations (concise/detailed/Socratic) |
| M12 sim/evidence/QA | done | `npm run sim`, evidence page, `npm run data:qa` |
| M13 PWA/perf/a11y/docs | done | Offline shell (e2e), 176 KB gzipped initial JS, mobile layout e2e, aria labels, README, LICENSES |
| M14 stretch | done | Human-likeness softmax over MultiPV; optional AI explanations with fact verifier |

## Log

- 2026-11-10: Session 1. Toolchain: Node 24.16, npm 11.13, no system git (DECISIONS #1).
- Pipelines ran as parallel agents; several usage-limit and stall interruptions were resumed from saved state.
- Simulation found a real bug (new learners got empty sessions); fixed with a regression test.
- E2E found UI bugs (placement test lost after puzzle 1; settings save lost on fast reload; summary hid last feedback; export download cancelled); fixed.

- 2026-11-11: Endgame and strategy packs integrated; strategy provider made lazy after e2e caught a slow session start. Final gate: 243 unit tests, 13 Playwright tests, sim and QA all pass.

## Next steps (open work)

1. Evaluate-trade needs a trade source without the 60 cp margin rule (DECISIONS #24).
2. Thin concepts: triangulation (0), cutting-off-king and philidor (10 each), static pawn-structure strategy concepts; see docs/content-qa.md.
3. Fit FSRS and forgetting constants to real usage; consider Maia (ONNX) for human-like sparring.
4. Detector coverage is about 50% of mistakes; discovered-attack may be over-eager.
5. Seed the learner from imported game ratings (`seedFromGames` exists, not wired into onboarding).
