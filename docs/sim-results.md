# Simulation results

Generated 2026-11-11T16:22:59.162Z by `npm run sim` in 3.0 s.

Setup: 24 simulated learners, 30 daily 10-minute sessions, 40 concepts across domains, seed 1. Every policy sees the same learners. Hidden skill per concept = global + domain + concept offsets; each attempt adds 9 rating points with diminishing returns over a 450-point headroom, regardless of success; skills decay toward the start with a 45-day half-life. These are assumptions, chosen not to favour any particular target success band.

Policies: **adaptive** = this scheduler with the curriculum (concepts unlock over time); **adaptive-no-curriculum** = the same scheduler with every concept open; **random** = uniform concept and item; **weakest-only** = always the lowest-estimated concept at 50% predicted success; **fixed-curriculum** = concepts in tier order, 12 attempts each.

| Metric | adaptive | adaptive-no-curriculum | random | weakest-only | fixed-curriculum |
| --- | --- | --- | --- | --- | --- |
| Estimate RMSE, all concepts (lower is better) | 219.4 | 225.2 | 181.2 | 229.3 | 208.0 |
| Estimate RMSE, practised concepts (lower is better) | 214.2 | 223.8 | 181.2 | 224.9 | 197.8 |
| Brier score (lower is better) | 0.141 | 0.160 | 0.140 | 0.181 | 0.163 |
| Calibration error (ECE) (lower is better) | 0.040 | 0.044 | 0.042 | 0.051 | 0.064 |
| Max same-concept streak (lower is better) | 2.000 | 2.000 | 3.000 | 9.000 | 9.000 |
| Concept entropy (0-1) (higher is better) | 0.758 | 0.946 | 0.999 | 0.510 | 0.848 |
| Distinct concepts per session (higher is better) | 6.128 | 7.151 | 8.164 | 1.315 | 1.500 |
| Mean hidden-skill gain (higher is better) | 37.0 | 42.3 | 45.4 | 18.5 | 43.4 |
| Retention: P(solve tier item) after 21 idle days (higher is better) | 0.564 | 0.571 | 0.570 | 0.550 | 0.568 |
| Mean true success probability (higher is better) | 0.836 | 0.804 | 0.482 | 0.752 | 0.671 |

## Verdict per metric

- Estimate RMSE, all concepts: random is best (181.2); adaptive scores 219.4.
- Estimate RMSE, practised concepts: random is best (181.2); adaptive scores 214.2.
- Brier score: random is best (0.140); adaptive scores 0.141.
- Calibration error (ECE): the adaptive scheduler is best (0.040).
- Max same-concept streak: the adaptive scheduler is best (2.000).
- Concept entropy (0-1): random is best (0.999); adaptive scores 0.758.
- Distinct concepts per session: random is best (8.164); adaptive scores 6.128.
- Mean hidden-skill gain: random is best (45.4); adaptive scores 37.0.
- Retention: P(solve tier item) after 21 idle days: adaptive-no-curriculum is best (0.571); adaptive scores 0.564.
- Mean true success probability: the adaptive scheduler is best (0.836).

## Caveats

- The learning model is a simplification; real learners may benefit more (or less) from practice near a target success rate. Gains here come only from how practice is allocated across concepts and time.
- The adaptive policy with the curriculum deliberately starts with few concepts open, which raises its estimation error on concepts it has not reached yet; compare the "practised concepts" row.
- Estimation error is measured against the hidden skill at the end of the run.
