# World Cup 2026 Challenge Tracker

A simple, free, static website that tracks our World Cup auction challenge — who owns which
teams, how they're doing, and the running money standings.

## How it works
- **Pure static site** (`index.html` + `style.css` + `app.js` + `data.js`). No backend, no build step, no API keys.
- On load, the browser pulls **live data straight from ESPN's free API**:
  - Group standings (records, points, advancement)
  - All fixtures & results (group stage through the final)
- It maps each team to its owner (`data.js`, generated from `WC26.csv`) and computes the money standings in the browser. Auto-refreshes every 90s; there's also a **Refresh** button.

## Scoring (organizer's payout rules)
A team's payout is based on how far it advances:

| Outcome | Payout |
|---|---|
| Lose in Round of 16 | $21.60 |
| Lose in Quarterfinal | $43.20 |
| 4th place | $70.40 |
| 3rd place | $86.40 |
| 2nd place (lose final) | $109.60 |
| 1st place | $188.00 |

**Standing = winnings − team cost.** During the group stage no payouts are earned yet, so everyone
is "down" by their total buy-in (cost). The total prize pool is $800. Each team's **Cost** is its
Silver Bulletin expected value (so cost ≈ what the team is projected to earn).

## Tabs
- **Leaderboard** — everyone ranked by net standing (winnings − cost), plus a **Biggest Steals / Busts**
  panel. During the group stage it ranks teams by performance vs price (how many spots a team is
  doing better/worse than its cost implied); once payouts begin it switches to real profit
  (winnings − cost), so a cheap deep run becomes the top steal and a pricey early exit the top bust.
- **By Person** — each owner's teams, group record (W-D-L), and live status.
- **Groups** — all 12 group tables with owner color tags.
- **Fixtures** — results & upcoming matches, owned teams highlighted.

## Run locally
```bash
cd worldcup_gambling
python3 -m http.server 8000
# open http://localhost:8000
```
(Use a server, not file://, so the browser can fetch ESPN.)

## Deploy free (GitHub Pages)
1. Create a GitHub repo and push these files (`index.html`, `style.css`, `app.js`, `data.js`).
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick `main` / root.
3. Your site goes live at `https://<user>.github.io/<repo>/`.

Cloudflare Pages or Netlify (drag-and-drop the folder) also work and are free.

## Updating the roster
The roster lives in `data.js`. To regenerate from a new CSV, re-run the small parser used to build it,
or edit `TEAMS` / `OWNER_NAMES` / `OWNER_COLORS` directly. Set `OWNER_NAMES` to show full names instead
of initials.

## Notes
- ESPN's API is unofficial but reliable and sends CORS headers, so the browser can call it directly.
- The knockout payout engine reads each round from ESPN's match data (`round-of-16`, `quarterfinals`,
  `final`, etc.) and is verified against synthetic bracket results; it activates automatically once the
  Round of 16 begins (Jul 4, 2026).
