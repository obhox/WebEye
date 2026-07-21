<div align="center">

# 👁 WebEye

**Simple open-source website monitoring.**
Know the moment your sites go down — and prove your uptime with a public status page.

*by [Obhox](https://github.com/obhox)*

[![CI](https://github.com/obhox/webeye/actions/workflows/ci.yml/badge.svg)](https://github.com/obhox/webeye/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/ghcr.io-obhox%2Fwebeye-blue?logo=docker)](https://github.com/obhox/webeye/pkgs/container/webeye)

</div>

---

WebEye watches your websites and projects from one lightweight container. One
process, one SQLite file, no build step, one runtime dependency. It runs
comfortably on the smallest VPS you can rent.

## Features

- **Uptime & response time** — HTTP(S) checks on a per-site interval, with
  optional status-code and keyword assertions.
- **SSL certificate expiry** — days remaining per site, checked daily, with
  warnings before it bites.
- **Incident history & uptime %** — 24h / 7d / 30d figures and a full incident
  log with cause and duration.
- **Alerts on state changes** — Discord, Telegram, or a generic JSON webhook.
  Fires when a site goes down or recovers, not on every failed request.
- **Shareable public status pages** — publish a combined status page or a
  single-site link on an unguessable URL. No login for viewers.
- **Accounts** — sign up, and your services, channels and status page are
  yours alone. One instance can serve several people without them seeing each
  other's monitors.
- **Fast, quiet UI** — search-first dashboard, live charts, and a one-click
  light/dark toggle. Responsive down to a phone. No framework, no bundler,
  no tracking.

## Why another uptime monitor?

Most self-hosted options are either a single PHP script with no history, or a
multi-container stack with Postgres, Redis and a job queue. WebEye is the
middle: real incident tracking and status pages, in one ~150MB container with a
single SQLite file you can copy as a backup.

---

## Quick start

### Option 1 — Docker (recommended)

```bash
docker run -d \
  --name webeye \
  -p 3000:3000 \
  -v webeye-data:/data \
  --restart unless-stopped \
  ghcr.io/obhox/webeye:latest
```

Open <http://localhost:3000> and click **Create account**. The first account
created claims the instance and becomes admin.

### Option 2 — Docker Compose

```bash
git clone https://github.com/obhox/webeye.git
cd webeye
cp .env.example .env      # optional — every value has a sensible default
docker compose up -d
```

### Option 3 — From source

Requires [Bun](https://bun.sh) 1.1+ (`curl -fsSL https://bun.sh/install | bash`).

```bash
git clone https://github.com/obhox/webeye.git
cd webeye
bun install
bun run dev            # http://localhost:3000, hot reload
```

For production from source, use `bun run start` behind the systemd unit below.

Then create your account, click **Add service**, paste a URL, and you're
monitoring.

> **Registration is open by default.** Anyone who can reach the URL can create
> an account (they will only ever see their own services). If the instance is
> internet-facing and you want it to yourself, sign up immediately after the
> first deploy, or keep it behind a VPN or your reverse proxy's auth.

---

## Deployment

### Coolify

1. **New Resource → Docker Compose** (or Dockerfile) pointing at your fork.
2. Set any webhook environment variables you want (none are required).
3. Add a **persistent volume** mounted at `/data`.
   Without this you lose all history on every redeploy.
4. Coolify picks up the container `HEALTHCHECK` on `/api/health` automatically.
5. Attach your domain — Coolify terminates TLS for you.

### Any VPS with Docker

```bash
# 1. Point a DNS A record at your server, e.g. status.example.com
# 2. Run WebEye bound to localhost only — the proxy handles the internet
docker run -d --name webeye \
  -p 127.0.0.1:3000:3000 \
  -v webeye-data:/data \
  --restart unless-stopped \
  ghcr.io/obhox/webeye:latest
```

Then put a reverse proxy in front for HTTPS. With **Caddy**, the entire config is:

```caddyfile
status.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

With **nginx**, after `certbot --nginx -d status.example.com`:

```nginx
server {
    server_name status.example.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> HTTPS matters here beyond the usual reasons: the **Copy** button for share
> links uses the clipboard API, which browsers only expose on secure origins.

### Bare metal with systemd

```bash
sudo useradd -r -s /usr/sbin/nologin webeye
sudo mkdir -p /opt/webeye /var/lib/webeye
sudo chown webeye:webeye /var/lib/webeye
git clone https://github.com/obhox/webeye.git /opt/webeye
cd /opt/webeye && bun install --production
```

`/etc/systemd/system/webeye.service`:

```ini
[Unit]
Description=WebEye website monitoring
After=network-online.target

[Service]
Type=simple
User=webeye
WorkingDirectory=/opt/webeye
Environment=DB_PATH=/var/lib/webeye/webeye.db
ExecStart=/usr/local/bin/bun src/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now webeye
sudo systemctl status webeye
```

### Updating

```bash
docker compose pull && docker compose up -d     # compose
# or
docker pull ghcr.io/obhox/webeye:latest && docker restart webeye
```

Schema migrations run automatically at startup and are idempotent — your
existing sites and history are preserved.

### Backups

Everything lives in one SQLite file. Back it up without stopping the service:

```bash
docker exec webeye sh -c 'bun --eval "
  const { Database } = require(\"bun:sqlite\");
  new Database(process.env.DB_PATH).exec(\"VACUUM INTO '\''/data/backup.db'\''\")
"'
docker cp webeye:/data/backup.db ./webeye-backup-$(date +%F).db
```

Restoring is copying that file back to `DB_PATH`. (Copying `monitor.db` while
running can miss data still in the write-ahead log — `VACUUM INTO` is safe.)

---

## Configuration

Everything is environment variables. See [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `./data/monitor.db` | SQLite file location (`/data/monitor.db` in Docker) |
| `DISCORD_WEBHOOK_URL` | — | Discord alerts |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | — | Telegram alerts |
| `GENERIC_WEBHOOK_URL` | — | POSTs the raw JSON event to any URL |
| `SSL_WARN_DAYS` | `14` | Warn when a certificate has fewer days left |
| `FAILURES_BEFORE_DOWN` | `2` | Consecutive failures before a site counts as down |
| `CONCURRENCY` | `10` | Maximum simultaneous checks |
| `RETAIN_RAW_DAYS` | `7` | How long individual check rows are kept |

Webhooks set via environment are registered on boot — nothing to click.

**Environment variables are the fallback, not the ceiling.** Everything in the
Settings screen (`SSL_WARN_DAYS`, `FAILURES_BEFORE_DOWN`, and the defaults for
new services) can be changed in the UI and takes effect on the next check —
no restart. Clear a field to fall back to the environment variable again.
Channels defined by environment variables are marked `env` in Settings and can
be disabled there but not deleted: they would reappear on the next boot, so
remove the variable instead.

Webhook URLs are treated as credentials — Settings shows only the host and a
last-4 fingerprint (`discord.com/••••CRET`), never a reusable URL.

### Setting up alerts

**Discord** — Server Settings → Integrations → Webhooks → New Webhook, copy the
URL into `DISCORD_WEBHOOK_URL`.

**Telegram** — message [@BotFather](https://t.me/botfather), `/newbot`, copy the
token into `TELEGRAM_BOT_TOKEN`. Then message your new bot once, open
`https://api.telegram.org/bot<TOKEN>/getUpdates`, and copy `chat.id` into
`TELEGRAM_CHAT_ID`.

**Anything else** — set `GENERIC_WEBHOOK_URL` and you'll receive:

```json
{
  "kind": "down",
  "site": "API",
  "url": "https://api.example.com",
  "cause": "expected HTTP 200, got 502",
  "message": "🔴 DOWN — API\nhttps://api.example.com\nexpected HTTP 200, got 502",
  "at": "2026-07-21T09:12:44.001Z"
}
```

---

## Public status pages

Two kinds of link, neither requiring a login from the viewer:

- **Combined status page** — click **Public page** on the dashboard, then tick
  *"Include this service on the combined public status page"* for each service
  you want listed. Good for a customer-facing `status.yourdomain.com`.
- **Single-service link** — on any service's page, **Create share link**. Useful
  for handing one client the status of just their project.

Both are protected by a 192-bit random token in the URL (`/p/<token>`,
`/s/<token>`), and **Revoke** kills the old link instantly. Pages are served
`noindex, nofollow`, so a shared link won't land in search results.

**Visitors see:** service name, up/degraded/down state, response time,
24h/7d/30d uptime, the history sparkline, and incident start/end times.

**Visitors never see:** error messages (which can contain internal hostnames,
paths and your keyword assertions), certificate details, the monitored URL,
check configuration, or any admin control. Public pages render through a
separate code path that never serialises the private status JSON.

---

## Accounts

Registration is open: the **first** account created claims the instance and is
flagged admin. Every account after that is a normal user.

Each account owns its own services, notification channels, monitoring defaults
and public status page. Ownership is enforced in the SQL `WHERE` clause rather
than checked after the fact, so a request for someone else's service returns
`404` rather than leaking it.

Passwords are hashed with **argon2id** (built into Bun — no dependency).
Sessions are server-side rows with a 30-day expiry, so logging out actually
revokes the session rather than just dropping a cookie. Repeated failed logins
lock an address out for 15 minutes.

**Upgrading from a pre-accounts version?** Your existing services, channels and
status page have no owner. The first account you create adopts all of them, so
sign up once immediately after upgrading and everything will be there.

## Using the dashboard

- **Search** — press `/` or click the box to drop down the full service list.
  Type to narrow it, arrow keys to move, `Enter` to open, `Esc` to close.
  Matching runs over names and URLs and filters the grid at the same time, and
  it survives the 15s background refresh.
- **Settings** (gear icon, top right) — add notification channels and send test
  alerts, name and publish the status page, and change monitoring defaults.
  Settings apply immediately; no restart.
- **Edit a service** — open it from the dashboard and choose *Edit
  configuration* to change the URL, interval, keyword, expected status or
  timeout, or to pause monitoring without losing history.
- **Theme** — the sun/moon button in the top right (floating on public and login
  pages). It defaults to your OS setting and follows it live; once you pick a
  theme explicitly, that choice wins and is remembered in `localStorage`. The
  theme is applied before first paint, so there's no white flash on a dark load.
- **Charts** — bucket widths adapt to the history that exists rather than being
  fixed at an hour, so a fresh instance draws a real curve after ~90 seconds
  instead of one flat point. The range chip reports the window actually charted,
  not a hardcoded "24 hours".
- **Pause a service** without deleting it: `PATCH /api/sites/:id` with
  `{"enabled": 0}`.

## How it works

**One scheduler, not N timers.** A single 1s tick scans an in-memory map of
`site_id → nextRunAt`. Due sites run through a concurrency semaphore, so 50
services never open 50 sockets at once.

**Down ≠ one failed request.** A service is confirmed `down` (and alerts fire)
only after `FAILURES_BEFORE_DOWN` consecutive failures. A service whose latest
check failed but hasn't hit that threshold shows as `degraded` — visible
immediately, but it won't wake you for a single blip. Alerts fire on
*transitions* only, never repeatedly while a service stays down.

**History stays small.** One service at a 60s interval writes ~43k rows a month.
An hourly job rolls completed days into `daily_stats` and prunes raw checks
older than `RETAIN_RAW_DAYS`. The 30-day uptime figure reads ~30 rollup rows
instead of scanning 43k, so the database stays a few MB no matter how long it
runs.

**Restart-safe.** Unresolved incidents are read back from SQLite on boot, so
restarting mid-outage doesn't fire a duplicate DOWN alert or a phantom recovery.

**Charts that work on day one.** Chart buckets adapt to the history that exists
rather than being fixed at an hour, so a fresh instance draws a real curve after
~90 seconds instead of a single flat point.

---

## API

Everything the UI does is available over HTTP. Authenticated routes need the
session cookie from `POST /login`.

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/health` | Always unauthenticated — for container healthchecks |
| `POST` | `/signup` · `/login` | Form posts; set a session cookie |
| `GET` | `/api/status` | Full JSON status of every service |
| `POST` | `/api/sites` | `{name, url, keyword?, interval_seconds?, expected_status?, timeout_ms?}` |
| `PATCH` | `/api/sites/:id` | Update any field, or `enabled: 0` to pause |
| `DELETE` | `/api/sites/:id` | Remove a service and its history |
| `POST` | `/api/sites/:id/check` | Force a check on the next tick |
| `PATCH` | `/api/settings` | Update monitoring defaults (allowlisted keys only) |
| `GET`/`POST` | `/api/webhooks` | List / add a notification channel |
| `PATCH`/`DELETE` | `/api/webhooks/:id` | Enable-disable / remove a channel |
| `POST` | `/api/webhooks/:id/test` | Send a test alert through that channel |
| `POST`/`DELETE` | `/api/public-page` | Create / revoke the combined page link |
| `POST`/`DELETE` | `/api/sites/:id/share` | Create / revoke a single-service link |
| `GET` | `/p/:token` · `/s/:token` | Public status pages — the token is the credential |

```bash
curl -X POST localhost:3000/api/sites \
  -H 'content-type: application/json' \
  -d '{"name":"API","url":"https://api.example.com/health","keyword":"ok"}'
```

---

## The landing page globe

The rotating halftone Earth is plain canvas — no d3, no WebGL, no runtime
fetch to a third party. Land outlines and the dot grid are baked into
`public/globe.json` (~40 KB) by `tools/build-globe.ts` from
[Natural Earth](https://www.naturalearthdata.com/) 110m land data (public
domain). Regenerate only if you change the source data:

```bash
curl -sSLo /tmp/land.json \
  https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/physical/ne_110m_land.json
bun tools/build-globe.ts /tmp/land.json
```

Baking rather than fetching keeps the page working on air-gapped installs,
avoids sending every visitor to a third-party host, and means the orthographic
projection is ~10 lines of arithmetic instead of a charting dependency. Drag to
rotate and scroll to zoom with a mouse; touch is left alone so the page still
scrolls, and auto-rotation pauses for `prefers-reduced-motion`.

## Project layout

```
src/
  index.ts     Hono app: routes, session middleware, public pages, CRUD
  auth.ts      Accounts, argon2id hashing, sessions, login throttling
  db.ts        Schema, migrations, queries, rollup + prune
  monitor.ts   Scheduler loop, check runner, up/down state machine
  tls.ts       Certificate expiry via node:tls
  notify.ts    Discord / Telegram / generic webhook adapters
  ui.ts        Server-rendered HTML, SVG charts, icons
public/
  app.css      All styling, light + dark
  app.js       Refresh polling, search filter, share controls, globe renderer
  globe.json   Baked land outlines + halftone dots (generated)
tools/
  build-globe.ts  Regenerates globe.json from Natural Earth data
```

**Stack:** Bun · [Hono](https://hono.dev) · `bun:sqlite` · server-rendered HTML.
No bundler, no framework, no ORM, no chart library, no icon font — charts and
icons are inline SVG.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for
how to run the project locally and what CI checks on every PR.

## License

[MIT](LICENSE) © 2026 Obhox — use it, fork it, sell it, just keep the notice.
