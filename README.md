# Signal50 — LinkedIn Growth Studio

Live: **https://afrinam19.github.io/signal50/**

| Path | What it is |
|---|---|
| `index.html` | The studio (calendar, GIF/cheat-sheet builder, outlier vault, newsletter, retro, ops) |
| `assets/factory.js` | GIF Lab "Factory" canvas layout (hub + 5 stations conveyor loop) |
| `assets/matrix.js` | GIF Lab "Matrix" canvas layout — products × decisions comparison cheat sheet (see below) |
| `data/outliers.json` | Verified outliers + per-creator baselines, refreshed by the scout |
| `data/watchlist.json` | 4-ring creator watchlist (35 creators) |
| `scout/scout.mjs` | Outlier scout — HarvestAPI primary, public LinkedIn pages as a capped fallback |
| `apps/<name>/` | Thu/Fri "Built with Antigravity" apps, each live at `/signal50/apps/<name>/` |
| `.github/workflows/scout.yml` | Runs the scout every 12h (06:17 & 18:17 UTC) and commits `data/outliers.json` |
| `.github/workflows/pages.yml` | Deploys the repo root to GitHub Pages on every push |

## Matrix cheat sheet (GIF Lab → Visual Density → Matrix)

A 1080×1350 "Same N decisions. Different answers." table: up to 5 product columns × 6 decision rows, brand-tinted cells, a PM-takeaway strip under every row, a closing banner and the footer. The GIF reveals one row per frame; the PNG is the final frame.

1. GIF Lab tab → **Visual Density: Matrix** (the preset jumps to *Personal Agents*).
2. Edit the **System Spec** box. Format, one line each:
   ```
   COLS: Muse (Meta) #0866FF | Claude Duet (Anthropic) #D97757 | dots (OpenAI) #6D5DF6
   CORNER: What each team chose
   CHIP: Snapshot · Nov 10, 2026
   01 · When does it ask you first? | cell | cell | cell | 👉 PM takeaway (≤ 90 chars)
   NOTE: bold closing line        ALSO: footnote        SOURCES: one-line credit
   ```
   Headline: `{braces}` = gradient accent, `||` = line break.
3. **Product images** — one per column, chosen from your device (official brand cards or your own screenshots). Nothing is uploaded; without an image the tile shows the brand-colored initial. A `https://…` URL on a `COLS:` entry also works when the host allows CORS.
4. **Generate 1080×1350 .PNG** (the post image) or **Generate & Save Animated .GIF** (row-by-row reveal, encoded at 1080×1350).
5. **Copy research prompt → new matrix** gives Antigravity/Gemini a prompt that returns a new spec in exactly this format, with a source URL per cell. Paste the result back into the System Spec box.

New matrix presets live in `assets/matrix.js` → `PRESETS` (`{ brand, title, subtitle, cta, spec }`) plus a matching `GIF_PRESETS` entry and `<option>` in `index.html`.

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
