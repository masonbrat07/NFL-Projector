# NFL Projector — notes for Claude

Static site on GitHub Pages: https://masonbrat07.github.io/NFL-Projector/ (served from `main`, repo root).
No build step, no dependencies. Pushing to `main` deploys in ~1–2 minutes.

## Files
- `index.html` — the entire app (HTML + CSS + JS in one file). Edit it in place.
- `data.json` — shared data snapshot the app loads on open (games, player game logs as column arrays, rosters, depth charts, weather). Regenerate with `node scripts/update-data.mjs`; never hand-edit.
- `news-feed.json` — Claude-written news that can adjust projections; format in README.md.
- `markets.json`, `markets/<season>-wk<NN>.json` — Kalshi/Polymarket prices from `scripts/update-markets.mjs` (format in its header comment). The archive keeps each game's last pre-kickoff prices.
- `reviews.json`, `reviews/<season>-wk<NN>.json` — weekly review notes and the numbers behind them (`scripts/weekly-review.py` calls the page's `weekReview()` in headless Chromium).
- `projections/<season>-wk<NN>.json` — the next week's projections saved before kickoff by `scripts/week-projections.py` (calls the page's `weekProjections()` in headless Chromium; non-backup players projected for 1.5+ FanDuel points, so depth backs are in for the simulator).
- `scripts/update-data.mjs` — Node 18+ script that refreshes `data.json` from ESPN + Open-Meteo. Its parsing must stay in sync with `parseBox`/`fetchRosters`/`fetchDepth`/`fetchWeather` in `index.html`.
- A scheduled Claude routine (8 AM / 5 PM ET) runs both update scripts, writes `news-feed.json`, and commits. A weekly routine (Tuesday 8 AM ET) refreshes the data, runs the review, writes `reviews.json`, applies backtested model fixes, then saves the new week's projections. Don't change those file formats without updating the routine prompt and the app together.

## NBA (local tools in `nba/`, not on the website)
- `nba/update.mjs` (data → `nba/data.json`), `nba/project.mjs`, `nba/grade.mjs` (prop lines → `nba/picks/`), `nba/review.mjs`, `nba/backtest.mjs`; model in `nba/model.mjs`. Details and backtest numbers in `nba/README.md`.
- Simulators: `nba/sim.mjs` (NBA, per date) and `scripts/sim-week.mjs` (NFL, per week, built on `projections/<season>-wk<NN>.json` + `data.json`; `OUT=Name` rules a player out and hands their work to same-position teammates).
- After changing the NBA model, run `node nba/backtest.mjs` and report MAE vs the previous version.

## Betting picks (NFL only) — do this every time, without being asked
The user sends prop lines (screen recordings/screenshots of a betting app) and asks for picks. NFL only; no NBA picks.
1. Refresh data (`node scripts/update-data.mjs`) and check ESPN's injury report and news for the game; trust the app's
   player list over a stale IR tag until official inactives.
2. Run `node scripts/matchup-report.mjs AWAY@HOME` and use it: both offenses and both defenses, season and last 4,
   league ranks, what each defense allows by position (RB rush, QB rush, WR/TE/RB receiving), weather, ATS/O-U trends.
   Mention defensive matchups and trends in the picks unprompted (e.g. a bottom-5 run defense vs a lead back).
3. Grade lines with the stats model (page `gradeLine`), not the simulators (`scripts/sim-week.mjs` is not used for picks).
   Show blended odds (25% model + 75% market price — best calibrated on 1,335 archived lines) so edges are realistic.
4. Check each pick against the player's last 10 games and history vs the opponent; drop picks where they disagree.
5. Known model biases (2026 market archive): it under-rates Overs (~5 pts overall). Do not recommend Unders on receptions,
   pass attempts/completions, rush attempts, passing yards or rush+rec yards. TD Unders are a proven edge (TDs went
   Over 27% vs 34% priced); reception and passing-yard Overs beat their prices this season (56% / 60%).
6. Role changes (starter out for 2+ games) are under-weighted by the model — skip that team's backfield/role props
   unless the market agrees. Big favorites' lead backs are Over candidates, not Under.
7. Weather: wind 15+ mph or real precipitation -> cut passing expectations, favor Unders on totals/passing.

## How the app works (index.html)
- Data: ESPN public JSON (`site.api.espn.com`, core API for depth charts), Open-Meteo for weather. Stored per visitor in IndexedDB (`nfl_projector`). `loadSnapshot()` seeds it from `data.json` when that is newer than the visitor's last sync.
- Model: final projection = blend of a recent-form model (`project` → `P.form`: weighted baseline × defense^0.5 × matchup history × Vegas × home) and a usage model (`usageProj`: team volume × role share × efficiency, with injury redistribution via `teamCtx`, game script, depth-chart QB). Weights `W_USE` (pass .7 / other .25), `DEF_W` .5, `TYPICAL` .9 (`TYPICAL_QB` 1.0 since 2026 wk4; RB/WR/TE non-TD stats use `TYPICAL_YDS` .82 since 2026 wk10; no extra pass volume for underdogs since 2026 wk11; `WO_W` .3 since 2026 wk12: teammates' target/carry shares from recent games without today's missing players) were tuned on 2024–2025 backtests (Accuracy tab). Weather applied last (`wxEffect`).
- UI: Projections has QB/RB/WR/TE tabs with per-position columns (`POS_COLS`); player drawer (`showDetail`); Line finder (PrizePicks/FanDuel lines, `gradeLine`); Over/Under performers (top 10 each way per stat — rec yds, rush yds, pass yds, rush+rec TDs (`OU_STATS`) — projection vs. form baseline `ouNormal(P,stat)`, `renderOU`; starters only via `ouStarter` (QB1/RB1/WR1-2/TE1 by depth chart, or a backup when someone ahead is out/doubtful or the news feed boosts them); the weekly review scores the top 5 each way per stat); Line finder also has a Prediction markets card (`renderMarkets`, `mkCompare`); Accuracy has the Weekly report card (`weekReview`, `renderReview`); News (ESPN news + injury report + `news-feed.json`); Defense rankings; Accuracy (backtest); Data.
- Auto-updates in the browser at 8 AM / 5 PM local while open (`autoCheck`).

## Conventions
- Keep it a single self-contained `index.html`; match the existing compact code style.
- Colors are CSS tokens on `:root` with light/dark variants; keep both themes working and the layout usable at 375px wide.
- After changing the model, run the Accuracy backtest for 2024 and 2025 and report MAE vs the previous version.
- Refer to players with neutral wording (they/them) in UI text.
