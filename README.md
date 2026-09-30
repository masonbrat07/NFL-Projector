# NFL Projector

NFL player stat projections built from ESPN box scores, adjusted for role (share of targets/carries),
opponent defense, injuries, depth charts, game script, weather and Vegas lines. Includes a
PrizePicks/FanDuel line finder and a news feed.

**Site:** https://masonbrat07.github.io/NFL-Projector/

## Files

| File | What it is |
|---|---|
| `index.html` | The whole web app. Stores its working database in each visitor's browser. |
| `data.json` | Shared data snapshot (games, player game logs, rosters, depth charts, weather). Visitors load it on open. |
| `news-feed.json` | News that may affect projections, written by the twice-daily Claude routine from ESPN and CBS Sports. |
| `scripts/update-data.mjs` | Refreshes `data.json` from ESPN and Open-Meteo. Run with `node scripts/update-data.mjs` (Node 18+). |

## Updates

A Claude routine runs every day at 8 AM and 5 PM Eastern. It runs `scripts/update-data.mjs`,
reviews ESPN and CBS Sports news, writes `news-feed.json`, and commits both files. GitHub Pages
then serves the new data to everyone.

### `news-feed.json` format

```json
{
  "generated_at": "2026-10-01T12:05:00Z",
  "items": [
    {
      "player": "Full Name", "team": "DET", "position": "RB",
      "status": "Out | Doubtful | Questionable | Active | null",
      "impact": "high | watch | info",
      "direction": "out | up | down | none",
      "multiplier": 0.85,
      "headline": "One-line summary",
      "summary": "Two or three sentences on why it matters for this week's projection.",
      "sources": [{ "name": "CBS Sports", "url": "https://..." }],
      "published": "2026-10-01T11:40:00Z"
    }
  ]
}
```

`multiplier` (0.6–1.3) scales the player's whole projection for 36 hours; `direction: "out"`
removes the player and redistributes their targets and carries to teammates.

Data comes from ESPN's public site feeds and Open-Meteo; news summaries link to their sources.
