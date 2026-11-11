# Adaptive Chess Tutor

A browser-only chess trainer whose core is an adaptive engine: a hierarchical learner model that estimates your
skill per concept, a scheduler that targets weaknesses without repetition, and a curriculum that unlocks harder
material as foundations are mastered. Every exercise shows why it was chosen. No backend, accounts or tracking:
all data stays in your browser, with JSON export and import.

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. The content packs are committed under `public/packs/`, so no pipeline needs to run first.

| Command | What it does |
| --- | --- |
| `npm run dev` / `npm run build` / `npm run preview` | Develop, build (`dist/`), serve the build |
| `npm run check` | Typecheck + lint + unit tests |
| `npm run e2e` | Playwright tests against the production build (`npx playwright install chromium` once) |
| `npm run sim` | Scheduler simulation -> `docs/sim-results.md`, `public/evidence/sim.json` |
| `npm run data:tactics` | Lichess puzzle DB -> `public/packs/tactics/` (~310 MB download, resumable) |
| `npm run data:endgames` | Procedural endgames verified with the Lichess tablebase API (cached in `.cache/tablebase/`) |
| `npm run data:openings` | chess-openings names + book from the first 2M games of a Lichess monthly dump (streamed, stops early) |
| `npm run data:strategy` | Quiet-position bank from high-rated games via Stockfish MultiPV (parallel workers) |
| `npm run data:manifest` | Rebuild `public/packs/manifest.json` after any pipeline |
| `npm run data:qa` | Content QA -> `docs/content-qa.md`, `public/evidence/content-qa.json` |
| `npm run commit -- "msg"` | Commit via isomorphic-git (the build machine had no system git) |

## Architecture

```
src/engine      chess.js helpers; Stockfish Web Worker client (queue, FEN cache, limited strength);
                tablebase client (rate limit, cache, offline); static feature extractors; motif detectors
src/model       learner model, FSRS memory, calibration, settings, insights, Dexie persistence
src/scheduler   candidate scoring, hard constraints, session template, "why this exercise" lines
src/curriculum  concept taxonomy + prerequisite DAG, unlock/decay, placement test, lesson cards
src/content     pack loader (lazy, versioned, quota check), domain providers, pool
src/exercises   exercise contract, builders per domain, grading, template explanations
src/diagnosis   game analysis queue, mistake classification, time-management report
src/importers   Lichess, Chess.com and PGN import; optional explorer client
src/ui          React screens (onboarding, dashboard, training, review, repertoire, endgames,
                curriculum, settings, evidence, data)
scripts/        data pipelines, simulation, QA, git wrapper
```

**Learner model.** Nodes at four levels (overall > domain > skill > concept) plus context offsets (phase, colour,
time control). Each node keeps a rating θ, uncertainty σ and last-seen time on the Lichess puzzle-rating scale;
P(solve) = logistic((θ − difficulty) / (400/ln 10)). Each result updates every node on the chain with a
Glicko-style step; estimates are partially pooled (a concept with little evidence shrinks to its skill, domain and
overall level); σ grows and estimates drift down without practice. Item difficulty is the Lichess rating for
puzzles, and a tier prior plus a learned offset for generated content. Memorised material (opening nodes,
endgame technique, structure cards) also has an FSRS-style stability/difficulty state. Weakness is solve rate
relative to opportunities. A calibration log gives Brier score, ECE and reliability bins; confidence ratings
(1–5, asked before answering) feed a confidence-calibration model.

**Scheduler.** Score = closeness of predicted success to the target band + Thompson-sampled weakness +
uncertainty bonus + spaced-repetition due bonus + goal weighting + domain weight − variety × (recency +
similarity of themes, material, structure, source game). Hard constraints: no concept more than twice in any five,
at least four concepts and two formats per session; sessions run warm-up → core → challenge → cool-down; default
mix 55% weakness / 25% review / 20% strengths and exploration. If the pool is too small a constraint is relaxed
and the why-line says so.

**Curriculum.** A typed DAG (`requires` / `recommends`) over 99 concepts in tiers 0–6. A concept unlocks when its
prerequisites reach 60% conservative mastery with σ ≤ 190, and runs lesson → supported practice → unsupported
practice → 5-exercise mastery check. Mastery decays and sends a concept back to a check. Tier 3+ is gated on a
basic-blunder rate (hanging pieces, mate in 1) of 15% or less. Strong, well-estimated players place out of basics.
A 15-puzzle adaptive placement test seeds the model.

## Content and verification

Nothing in the content packs is written by hand. See `docs/content-qa.md` for current counts.

- **Tactics:** 59,983 Lichess puzzles (Popularity ≥ 80, RD ≤ 90), stratified by concept, 200-point band and
  length; every line replayed with chess.js, mate puzzles checked for mate. Formats: solve, spot-the-motif,
  find-the-defence, "is there a tactic?" (quiet negatives come from the strategy bank).
- **Endgames:** 1,107 positions generated from structural constraints across 18 concepts; every result, best-move
  set and DTM comes from the Lichess tablebase. Triangulation ships zero items (no candidate could be verified).
  Formats: best move, win-or-draw, play-out against the tablebase.
- **Openings:** names from lichess-org/chess-openings; a 14-ply book from 1.26M aggregated games per rating band;
  traps only when Stockfish (depth 16) confirms a 150 cp drop; structure cards from computed features. Repertoire
  builder, FSRS line training per node, deviation drills, book-exit detection on your games.
- **Strategy:** 2,986 quiet positions (no captures, checks or promotions in the first 3 plies of the depth-14 line,
  best move ≥ 60 cp ahead of the second) from 8,000 games with both players ≥ 2200, labelled with feature deltas.
  Formats: best quiet move, who is better (heuristic attribution, labelled), choose the plan. Evaluate-the-trade is
  built but switched off: under the margin rule no trade in the bank can be "good".
- **Calculation:** coordinates, square colours, knight paths (BFS), checks/captures lists (chess.js), forced lines
  with full commitment, hidden-board and blindfold variants of real puzzles.
- **Defence, conversion, sparring, process:** positions from your analysed games and the strategy bank, played out
  against limited-strength Stockfish and judged by evaluation retention; blunder-check and timed drills.

## Game diagnosis

Import from Lichess (`/api/games/user/{name}` NDJSON with clocks, evals and openings), Chess.com (public API; both
send CORS headers, confirmed) or pasted / uploaded PGN. Analysis runs in the Stockfish worker at depth 12,
using embedded evaluations when present; a mistake is a loss of ≥ 150 cp. Rule-based detectors (hanging piece, fork,
pin, skewer, discovered attack, back rank, mate in N, missed strategic feature) classify mistakes, and the screen
reports how many they classified (about half on the fixture games). Mistakes become "spot the mistake" exercises.

## Assumptions and limits

All decisions are logged in `docs/DECISIONS.md`. The main limits:

- The simulation (`docs/sim-results.md`) uses a deliberately neutral learning model. Under it, random allocation
  beats this scheduler on estimation error and raw skill gain; the scheduler is better calibrated than most
  baselines and avoids long streaks. Real learners may behave differently; this is not evidence of real-world benefit.
- FSRS weights are published defaults; forgetting rates are assumptions.
- Motif and feature detectors are heuristic; coverage is reported, not hidden.
- The opening explorer API needs a Lichess token (anonymous requests return 401); the local book is the default.
- Stockfish is the lite single-threaded build: strong, but analysis is slow on weak devices.
- Tablebase lookups at run time (play-outs) need the network; offline, those attempts are marked ungraded.

## Privacy

No accounts, analytics or tracking. Network requests happen only for same-origin content packs, imports you start,
tablebase lookups during endgame play-outs and, if you enable them, the optional explorer token or AI explanations
with your own key. Export never includes tokens or keys.

## Licence

GPL-3.0-or-later, because Stockfish (GPL-3.0) is distributed with the app. See `LICENSES.md`.
