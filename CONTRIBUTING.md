# Contributing to WebEye

Thanks for helping out. WebEye aims to stay *simple*: one process, one file of
data, no build step. Please keep that in mind when proposing changes.

## Getting set up

```bash
git clone https://github.com/obhox/webeye.git
cd webeye
bun install
bun run dev          # http://localhost:3000 with hot reload
```

There's no build step and no test framework to install — `bun run dev` runs the
TypeScript directly.

## Before you open a PR

```bash
bun run typecheck    # must be clean
```

CI additionally boots the app, adds a real site, and asserts it reaches the `up`
state, then builds the Docker image and hits its healthcheck. You can run the
same smoke test locally:

```bash
bun src/index.ts &
sleep 4
curl -fsS localhost:3000/api/health
curl -fsS -X POST localhost:3000/api/sites -H 'content-type: application/json' \
  -d '{"name":"Test","url":"https://example.com","interval_seconds":10}'
sleep 12
curl -s localhost:3000/api/status | grep -q '"state":"up"' && echo PASS
```

A useful manual check for monitoring changes: add `https://localhost:9/` as a
service. It fails instantly, so you can watch `degraded → down`, the incident
opening, and the alert firing without waiting on a real outage.

## Things to be careful about

**Public pages must not leak.** Anything rendered for `/p/:token` or `/s/:token`
goes through `card(s, true)`, which strips error text, certificate data,
monitored URLs and admin links. If you add a field to the service card, decide
explicitly whether a public visitor should see it — error strings routinely
contain internal hostnames and keyword assertions. Never serialise the private
status JSON on a public route.

**Alerting is transition-based.** `isDown` is the alerting flag and requires
`FAILURES_BEFORE_DOWN` consecutive failures; `lastOk` drives the *displayed*
state. Keep them separate — collapsing them either spams alerts on every blip or
shows a failing service as "up".

**History must stay bounded.** Raw checks are pruned and rolled into
`daily_stats` hourly. If you add a query over `checks`, make sure it can't scan
an unbounded range on a long-running instance.

**Every query must be scoped to the session user.** WebEye is multi-tenant:
`getSite(id, userId)` and friends put ownership in the `WHERE` clause so a
mistyped call site fails closed with a 404 instead of leaking another account's
service. Never fetch by id and then check ownership afterwards, and never add a
route that trusts an id from the request without the user filter. The scheduler
is the one exception — it uses `allSites()` because it runs for everyone — and
it resolves `site.user_id` before sending any alert.

**Settings are allowlisted.** `PATCH /api/settings` writes into the same
key/value table that holds `public_page_token`. Only keys in
`WRITABLE_SETTINGS` (`src/index.ts`) may be written — without that check a
crafted request could mint itself a public status-page link. Add new keys there
deliberately, with a range where the value is numeric.

**Webhook URLs are credentials.** A Discord webhook URL grants posting rights
and a Telegram URL embeds the bot token, so the settings screen renders them
through `maskUrl()` and never emits a reusable URL. Don't add a view that
prints `webhooks.url` raw.

**Theming goes through the tokens.** Colours are declared once in `:root` with
`light-dark(light, dark)` and switched by flipping `color-scheme` — there is no
duplicated dark palette. Add new colours as tokens rather than hardcoding hex
values in component rules, or they'll break in one of the two themes.

**Migrations are additive.** `CREATE TABLE IF NOT EXISTS` won't alter an
existing table — use the `addColumn()` helper in `src/db.ts`, and test against a
database created by the previous version.

## Style

Match the surrounding code: no semicolon-free style changes, no new
dependencies without a good reason, comments that explain *why* rather than
restating the code.

## Reporting security issues

Please don't open a public issue for security problems. Email the maintainer
instead so it can be fixed before disclosure.
