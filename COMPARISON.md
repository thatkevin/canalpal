# Canal Pal vs CanalPlanAC — accuracy benchmark

Canal Pal builds its own routing graph from CanalPlanAC's waterway geometry and
counts locks by snapping lock points (respecting staircase sizes). This benchmarks
our results against CanalPlanAC / standard published figures by routing several
canals end-to-end.

Reproduce with: `node scripts/compare.mjs`

Time uses the defaults **3 mph, 12 min/lock, 7 hrs/day** (adjustable in-app, and
self-calibrating from logged trips).

| Route | Our dist | Our locks | Our time | CanalPlanAC dist | CanalPlanAC locks | Δ locks |
|---|--:|--:|--:|--:|--:|--:|
| W&B — Hanbury Jn → King's Norton Jn | 15.1 mi | **42** | 13 h 25 m | 15 mi | 42 | **0** |
| W&B — Tardebigge top → bottom | 2.2 mi | 29 | 6 h 32 m | 2.5 mi | 30 | −1 |
| Stratford Canal — King's Norton Jn → Stratford | 25.2 mi | 53 | 19 h | 25.5 mi | 56 | −3 |
| Coventry Canal — Hawkesbury Jn → Fradley Jn | 32.3 mi | 13 | 13 h 21 m | 38 mi | 13 | **0** |
| Oxford Canal — Hawkesbury Jn → Napton Jn | 27.2 mi | 4 | 9 h 51 m | — | — | — |
| Llangollen — Hurleston Jn → Llangollen | 44.3 mi | 20 | 18 h 47 m | 46 mi | 21 | −1 |

## Reading the results

- **Locks**: within 0–3 of CanalPlanAC. Most deltas are a single boundary lock at
  the snapped start/end (the snapped endpoint can sit just inside the first/last
  chamber) or a staircase-counting nuance. The headline check — Hanbury → King's
  Norton at **42 locks** — matches exactly.
- **Distance**: within ~1 mile on most routes. **Coventry Canal is ~6 mi short**
  (32.3 vs 38) — worth investigating: the route likely takes a shorter path than
  the full canal, or the Hawkesbury/Fradley endpoints snap differently. Flagged
  as a known discrepancy.
- **Time** is not directly comparable unless CanalPlanAC's speed settings match
  ours; the figures above use Canal Pal's defaults.

## Caveats

- Reference figures are standard published distances/lock counts; verify any route
  on CanalPlanAC's own planner for an exact match. Each endpoint's CanalPlanAC page
  is `https://canalplan.uk/place/<id>` (ids printed by `scripts/compare.mjs`).
- ~10% of the network is intentionally disconnected (unrestored/isolated canals,
  lakes); routes through those are penalised and warned about in-app.
