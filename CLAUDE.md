# Adaptive Chess Tutor — working conventions

Browser-only adaptive chess training app. No backend, no accounts, no tracking.
The adaptive engine (learner model + scheduler + curriculum) is the product.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server (http://localhost:5173) |
| `npm run build` | Typecheck + production build to `dist/` |
| `npm run typecheck` | `tsc --noEmit` over app, scripts and tests |
| `npm run lint` | ESLint (flat config) |
| `npm test` | Vitest unit tests |
| `npm run e2e` | Playwright end-to-end tests (builds + previews) |
| `npm run sim` | Scheduler simulation, writes `docs/sim-results.md` + `public/evidence/sim.json` |
| `npm run data:tactics` | Lichess puzzle DB -> `public/packs/tactics/` |
| `npm run data:endgames` | Procedural endgames verified by Lichess tablebase -> `public/packs/endgames/` |
| `npm run data:openings` | chess-openings names + opening book from a Lichess monthly dump -> `public/packs/openings/` |
| `npm run data:strategy` | Quiet-position bank via Stockfish MultiPV -> `public/packs/strategy/` |
| `npm run data:qa` | Content QA report -> `docs/content-qa.md` + `public/evidence/content-qa.json` |
| `npm run check` | typecheck + lint + test (run before every commit) |
| `npm run commit -- "msg"` | Stage all + commit (isomorphic-git wrapper; system git is not installed here) |

## Hard rules

1. **Never fabricate chess data.** Every position, line, puzzle and endgame comes from a
   pipeline script in `scripts/` or is generated and validated programmatically
   (chess.js legality, Stockfish, or tablebase). No opening theory or endgame claims
   written from memory into content files. Anything unverifiable is flagged
   `verified: false` and excluded from training by default.
2. Run `npm run check` before every commit. Commit after every milestone.
3. Update `docs/PROGRESS.md` at each milestone; record every assumption in `docs/DECISIONS.md`.
4. If context runs low: stop at a clean commit, write exact next steps in `docs/PROGRESS.md`.
5. Verify the UI with Playwright, not just unit tests.
6. Explain every scheduling decision to the user ("why this exercise").
7. Explanations are templates over verified facts only (engine lines, tablebase results,
   detected motifs/features). Heuristic attributions must say they are heuristic.
8. No network calls at runtime except: content packs (same origin), user-initiated game
   import (Lichess / Chess.com), tablebase lookups, optional user-keyed Anthropic API.

## Stack

TypeScript strict, React, Vite, Zustand, Dexie (IndexedDB), chess.js, react-chessboard,
Stockfish single-threaded WASM in a Web Worker (no threads / SharedArrayBuffer),
vite-plugin-pwa, Vitest, Playwright.

## Layout

```
src/engine      chess rules helpers, Stockfish worker client, tablebase client, feature extractors, motif detectors
src/model       learner model (Glicko-style nodes, pooling, FSRS memory, calibration), persistence (Dexie)
src/scheduler   candidate scoring, constraints, session templates, "why" lines
src/curriculum  concept taxonomy, prerequisite DAG, tiers, unlock logic, placement test, lesson cards
src/content     pack manifest/loader, shared content types
src/exercises   exercise builders per domain (pack item -> Exercise) and grading
src/diagnosis   game analysis queue, mistake classification, time-management analysis
src/importers   Lichess / Chess.com / PGN import
src/ui          React screens and components
scripts/        data pipelines, simulation, QA, git wrapper
docs/           ROADMAP, PROGRESS, DECISIONS, sim-results, content-qa
public/packs    generated content packs (versioned, lazily loaded)
```

## Code conventions

- Pure logic (model, scheduler, curriculum, detectors) has no React/DOM/Dexie imports and takes
  `now` and an RNG as parameters so it is deterministic in tests and in `npm run sim`.
- Ratings live on the Lichess puzzle-rating scale. P(solve) = 1/(1+exp(-(theta-difficulty)/SCALE)).
- Concept ids are `domain/skill/concept` strings (see `src/curriculum/concepts.ts`).
- Pack shard files are JSON arrays of compact tuples; decoders live next to the builders in `src/content`.
- Tests sit next to sources as `*.test.ts`; e2e tests live in `e2e/`.
- Scripts are TypeScript run with `tsx`; they cache downloads in `.cache/` (git-ignored).
