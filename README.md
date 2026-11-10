# Signal50 — LinkedIn Growth Studio

Live: **https://afrinam19.github.io/signal50/**

| Path | What it is |
|---|---|
| `index.html` | The studio (calendar, GIF/cheat-sheet builder, outlier vault, newsletter, retro, ops) |
| `data/outliers.json` | Verified outliers + per-creator baselines, refreshed by the scout |
| `data/watchlist.json` | 4-ring creator watchlist (35 creators) |
| `scout/scout.mjs` | Outlier scout — HarvestAPI primary, public LinkedIn pages as a capped fallback |
| `apps/<name>/` | Thu/Fri "Built with Antigravity" apps, each live at `/signal50/apps/<name>/` |
| `.github/workflows/scout.yml` | Runs the scout every 12h (06:17 & 18:17 UTC) and commits `data/outliers.json` |
| `.github/workflows/pages.yml` | Deploys the repo root to GitHub Pages on every push |

## How an outlier is identified (the actual model)

Per creator, over their own posts aged ≥ 24h:

```
weighted = reactions + 3 × comments × (comment-gated CTA ? 0.34 : 1) + 5 × reposts
median   = median(weighted)          MAD = median(|weighted − median|), floored at 10% of median
mult     = weighted / median         gate ≥ 3.0×
z        = (weighted − median) / (1.4826 × MAD)   gate ≥ 2.5
OUTLIER  = mult ≥ 3.0 and z ≥ 2.5 and n ≥ 4       WATCH = mult ≥ 1.5
type     = announcement (book / job / launch — not reusable) | playbook (reusable idea)
```

No ML model. Robust statistics only, so one viral post can't distort a creator's baseline and a
"Comment BOT to get it" post can't buy its way in on comment count.

## Data sources

1. **HarvestAPI** (primary) — `GET https://api.harvestapi.io/linkedin/profile-posts?profile=<handle>` with `X-API-Key`.
   ~100 posts per creator including repost counts. Set the repository secret **`HARVEST_API_KEY`**
   (Settings → Secrets and variables → Actions) and the scheduled scout covers the full watchlist.
2. **Public LinkedIn pages** (fallback, free, no login) — `linkedin.com/in/<handle>/recent-activity/all/`
   exposes the last ~9 posts. LinkedIn answers HTTP 999 after ~5–10 guest pages per IP, so this path is
   capped at `--public-max 5` creators per run.

Run locally:

```bash
HARVEST_API_KEY=… node scout/scout.mjs                 # full watchlist
node scout/scout.mjs --only michel-lieben,emollick     # a few creators (public fallback)
```
