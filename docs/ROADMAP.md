# Roadmap

Each milestone ends with `npm run check` green and a commit. Status lives in `PROGRESS.md`.

- [ ] **M0 Scaffold** — Vite+React+TS strict, ESLint, Vitest, Playwright, docs. *Accept:* `dev`, `build`, `check` run clean.
- [ ] **M1 Chess infrastructure** — board component (touch, keyboard move entry, aria), Stockfish worker client, tablebase client with cache + offline degradation, static feature extractors, motif detectors. *Accept:* unit tests for features/detectors/tablebase cache; engine returns a best move in the browser (e2e).
- [ ] **M2 Learner model** — hierarchical nodes (domain > skill > concept + context), Glicko-style updates, partial pooling, sigma growth, FSRS memory model, calibration log (Brier, reliability bins), confidence calibration, error causes, Dexie persistence, JSON export/import. *Accept:* unit tests for updates, pooling, forgetting, calibration; export/import round-trip.
- [ ] **M3 Content framework + tactics pack** — manifest, lazy shard loader, quota check; `data:tactics` builds ~60k stratified puzzles. *Accept:* pack validates (every solution line legal in chess.js); QA counts.
- [ ] **M4 Scheduler + session runner** — scoring, hard constraints, template, mix, why-lines; tactics vertical slice (solve, spot-the-motif, find-the-defense, tactic-or-not). *Accept:* scheduler constraint tests; e2e completes a session.
- [ ] **M5 Game import + diagnosis** — Lichess NDJSON, Chess.com, PGN; analysis queue (depth 12, FEN cache, embedded evals); mistake = cp loss >= 150; rule-based classification with coverage report; spot-the-mistake exercises. *Accept:* importer/detector tests; e2e PGN paste -> review.
- [ ] **M6 Endgames** — procedural generators verified by tablebase; best-move, win-or-draw, play-out. *Accept:* 100% of shipped positions tablebase-verified; e2e.
- [ ] **M7 Openings** — names from chess-openings; book from monthly dump; repertoire builder; FSRS line training; deviation handling; book-exit detection; structure cards; transpositions; traps. *Accept:* book built by script; repertoire e2e.
- [ ] **M8 Strategy bank** — quiet positions via MultiPV with feature deltas; best-move, who-is-better, choose-plan, evaluate-trade. *Accept:* bank built by script; extractor tests.
- [ ] **M9 Calculation, defense/conversion, sparring, time management.** *Accept:* each format playable; tests for grading.
- [ ] **M10 Curriculum** — typed prerequisite DAG, tiers 0-6, unlock + decay, lesson -> supported -> unsupported -> mastery check, blunder gate, 15-puzzle placement. *Accept:* unlock tests; placement e2e.
- [ ] **M11 Dashboard, settings, onboarding, explanations.** *Accept:* tests prove settings change scheduler behaviour; e2e for onboarding and settings.
- [ ] **M12 Simulation, evidence, content QA.** *Accept:* `npm run sim` writes `docs/sim-results.md`; evidence page renders it; `data:qa` report.
- [ ] **M13 PWA, performance, accessibility, README, LICENSES.** *Accept:* initial load < 3 MB excluding packs; offline after pack download; licences documented.
- [ ] **M14 Stretch** — human-likeness model (rating-conditioned softmax over MultiPV), optional LLM explainer behind a flag with fact verifier.
