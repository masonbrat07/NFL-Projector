# NBA projector (local tools, not part of the website)

Same workflow as the football side, run from the command line (Node 18+, no dependencies):

| Step | Command | Output |
|---|---|---|
| Refresh data (box scores, lines, injury reports) | `node nba/update.mjs` | `nba/data.json` |
| Project a date's games (before tip-off) | `node nba/project.mjs [YYYY-MM-DD]` | `nba/projections/<date>.json` |
| Grade prop lines from the betting app | `node nba/grade.mjs lines.txt [YYYY-MM-DD]` | `nba/picks/<date>.json` |
| Review a finished date | `node nba/review.mjs [YYYY-MM-DD]` | `nba/reviews/<date>.json` |
| Simulate each game 10,000 times (+ grade lines) | `node nba/sim.mjs [YYYY-MM-DD] [runs] [lines.txt]` | console |
| Backtest / tune the model | `node nba/backtest.mjs [from] [to] [PARAM=value]` | console |

`lines.txt`: one prop per line — `Player, stat, line, over price, under price` (prices as the app shows them: `54`, `54%` or `1.85x`).

## Model (`nba/model.mjs`)
Projection = projected minutes × per-minute rates, then:
- minutes: recent rotation role (half-life 3 games; coach's-decision DNPs count as 0), the active rotation rescaled to 240 when players are out, blowout trim from the spread, back-to-back trim;
- rates: weighted per-minute stats (half-life 20 games, last season at 0.35 weight), shrunk toward the position average;
- teammates out: usage and rebound share boosts; opponent: stat allowed vs league (^0.3); Vegas implied team points (^0.7);
- shaded to a typical game (0.94; 0.90 for 3PM/steals/blocks/turnovers) because box-score stats are right-skewed;
- over/under odds: normal distribution with the player's per-minute spread × projected minutes (×1.15 for calibration); Poisson for 3PM/steals/blocks/turnovers.

Backtest Dec 2025 – Nov 2026 (24,592 player-games), average miss vs a last-10-game average:
points 4.48 vs 4.74, rebounds 1.85 vs 1.94, assists 1.32 vs 1.39, 3PM 0.88 vs 0.92, PRA 5.89 vs 6.25, minutes 4.89 vs 5.19.

## Simulator (`nba/sim.mjs`)
Each run draws both team scores around the Vegas-implied points (sd 11.6, correlation 0.25, measured on 1,193 games; the market's
team totals beat the model's own sums, 9.25 vs 11.14 average miss), then each active player's minutes (blowouts cut starters)
and per-minute production (gamma noise sized from the player's own game-to-game spread), and splits the team's points across
its players. Player prop odds from the simulation score the same as the model's (Brier 0.2314 vs 0.2313) and are well calibrated
in the 30-70% range; the simulation adds win / cover / total odds and ranges for every player.
Live projections also treat as out anyone missing from the team's last 3 box scores (ESPN's injury report can lag).
