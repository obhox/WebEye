import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH ?? "./data/monitor.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS sites (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  url              TEXT    NOT NULL,
  method           TEXT    NOT NULL DEFAULT 'GET',
  expected_status  INTEGER NOT NULL DEFAULT 200,
  keyword          TEXT,
  interval_seconds INTEGER NOT NULL DEFAULT 60,
  timeout_ms       INTEGER NOT NULL DEFAULT 10000,
  enabled          INTEGER NOT NULL DEFAULT 1,
  headers_json     TEXT,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  ok          INTEGER NOT NULL,
  status_code INTEGER,
  latency_ms  INTEGER,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_site_ts ON checks(site_id, ts);

CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  started_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  cause       TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_site ON incidents(site_id, resolved_at);

CREATE TABLE IF NOT EXISTS daily_stats (
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  day         TEXT    NOT NULL,
  up_count    INTEGER NOT NULL,
  down_count  INTEGER NOT NULL,
  avg_latency INTEGER,
  PRIMARY KEY (site_id, day)
);

CREATE TABLE IF NOT EXISTS tls_info (
  site_id    INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  issuer     TEXT,
  valid_from INTEGER,
  valid_to   INTEGER,
  checked_at INTEGER NOT NULL,
  error      TEXT,
  warned_at  INTEGER
);

CREATE TABLE IF NOT EXISTS webhooks (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  type    TEXT NOT NULL,
  url     TEXT NOT NULL,
  chat_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  email             TEXT    NOT NULL UNIQUE,
  password_hash     TEXT    NOT NULL,
  name              TEXT,
  is_admin          INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  public_token      TEXT,
  public_page_title TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_public_token
  ON users(public_token) WHERE public_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT    NOT NULL,
  value   TEXT,
  PRIMARY KEY (user_id, key)
);
`);

// --- migrations ----------------------------------------------------------
// Columns added after the initial release. CREATE TABLE IF NOT EXISTS won't
// add them to an existing database, so patch them in idempotently.

function addColumn(table: string, column: string, definition: string) {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** Per-site share link. NULL means the site has no individual public link. */
addColumn("sites", "public_token", "TEXT");
/** Whether the site appears on the combined public status page. */
addColumn("sites", "is_public", "INTEGER NOT NULL DEFAULT 0");
/**
 * 'env' rows are recreated from environment variables on every boot, so the UI
 * marks them read-only rather than letting a delete silently come back.
 */
addColumn("webhooks", "source", "TEXT NOT NULL DEFAULT 'ui'");

/**
 * Owner of a service / notification channel. Nullable so a database created
 * before accounts existed still opens; those orphans are adopted by the first
 * account created (see `adoptOrphans`).
 */
addColumn("sites", "user_id", "INTEGER REFERENCES users(id) ON DELETE CASCADE");
addColumn("webhooks", "user_id", "INTEGER REFERENCES users(id) ON DELETE CASCADE");

db.exec("CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id)");

db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_public_token ON sites(public_token) WHERE public_token IS NOT NULL",
);

export type Site = {
  id: number;
  name: string;
  url: string;
  method: string;
  expected_status: number;
  keyword: string | null;
  interval_seconds: number;
  timeout_ms: number;
  enabled: number;
  headers_json: string | null;
  created_at: number;
  public_token: string | null;
  is_public: number;
  user_id: number | null;
};

export type Webhook = {
  id: number;
  type: "discord" | "telegram" | "generic";
  url: string;
  chat_id: string | null;
  enabled: number;
  source: "env" | "ui";
  user_id: number | null;
};

export const now = () => Date.now();

/**
 * 192 bits of randomness, base64url-encoded. Public status links are protected
 * by unguessability alone, so this must come from a CSPRNG — never Math.random.
 */
export function newToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export const getSetting = (key: string): string | null =>
  (db.query("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined)?.value ?? null;

export const setSetting = (key: string, value: string | null) => {
  if (value === null) {
    db.query("DELETE FROM settings WHERE key = ?").run(key);
  } else {
    db.query(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }
};

/**
 * A tunable that can be changed in the UI without a restart.
 *
 * Precedence: value saved in Settings → environment variable → built-in
 * default. Read at the point of use (a SQLite point lookup is far cheaper than
 * the HTTP check it precedes), so edits take effect on the next check rather
 * than the next deploy.
 */
export const getUserSetting = (userId: number, key: string): string | null =>
  (
    db
      .query("SELECT value FROM user_settings WHERE user_id = ? AND key = ?")
      .get(userId, key) as { value: string } | undefined
  )?.value ?? null;

export const setUserSetting = (
  userId: number,
  key: string,
  value: string | null,
) => {
  if (value === null) {
    db.query("DELETE FROM user_settings WHERE user_id = ? AND key = ?").run(
      userId,
      key,
    );
  } else {
    db.query(
      `INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    ).run(userId, key, value);
  }
};

/** Per-account tunable: user's saved value → environment variable → default. */
export function userTunable(
  userId: number | null,
  key: string,
  envVar: string,
  fallback: number,
): number {
  if (userId !== null) {
    const saved = getUserSetting(userId, key);
    if (saved !== null && saved !== "" && !Number.isNaN(Number(saved))) {
      return Number(saved);
    }
  }
  return tunable(key, envVar, fallback);
}

export function tunable(key: string, envVar: string, fallback: number): number {
  const saved = getSetting(key);
  if (saved !== null && saved !== "" && !Number.isNaN(Number(saved))) {
    return Number(saved);
  }
  const env = process.env[envVar];
  if (env !== undefined && env !== "" && !Number.isNaN(Number(env))) {
    return Number(env);
  }
  return fallback;
}

/** Seed webhooks from env on boot so Coolify deploys need no UI step. */
export function seedWebhooksFromEnv() {
  const add = (type: string, url: string, chat_id: string | null = null) => {
    const existing = db
      .query("SELECT id FROM webhooks WHERE type = ? AND url = ?")
      .get(type, url);
    if (!existing) {
      db.query(
        "INSERT INTO webhooks (type, url, chat_id, enabled, source) VALUES (?, ?, ?, 1, 'env')",
      ).run(type, url, chat_id);
    }
  };

  if (process.env.DISCORD_WEBHOOK_URL) {
    add("discord", process.env.DISCORD_WEBHOOK_URL);
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    add(
      "telegram",
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      process.env.TELEGRAM_CHAT_ID,
    );
  }
  if (process.env.GENERIC_WEBHOOK_URL) {
    add("generic", process.env.GENERIC_WEBHOOK_URL);
  }
}

// --- queries -------------------------------------------------------------

/** Every site in the instance — for the scheduler, which runs across all users. */
export const allSites = () =>
  db.query("SELECT * FROM sites ORDER BY name").all() as Site[];

/** Sites owned by one user. Everything user-facing must go through this. */
export const listSites = (userId: number) =>
  db
    .query("SELECT * FROM sites WHERE user_id = ? ORDER BY name")
    .all(userId) as Site[];

/**
 * Ownership is enforced in the WHERE clause rather than by a check after the
 * fetch, so a mistyped call site fails closed (returns null) instead of
 * leaking another account's service.
 */
export const getSite = (id: number, userId: number) =>
  db
    .query("SELECT * FROM sites WHERE id = ? AND user_id = ?")
    .get(id, userId) as Site | null;

/** Owner lookup for the scheduler, which has a site but no session. */
export const siteOwner = (siteId: number) =>
  (
    db.query("SELECT user_id FROM sites WHERE id = ?").get(siteId) as
      | { user_id: number | null }
      | undefined
  )?.user_id ?? null;

export const getSiteByToken = (token: string) =>
  db
    .query("SELECT * FROM sites WHERE public_token = ?")
    .get(token) as Site | null;

/** Sites one user has opted in to their combined public status page. */
export const listPublicSites = (userId: number) =>
  db
    .query("SELECT * FROM sites WHERE is_public = 1 AND user_id = ? ORDER BY name")
    .all(userId) as Site[];

/**
 * Enabled channels belonging to one user — an alert about a service only ever
 * fans out to the channels of the account that owns it.
 */
export const listWebhooks = (userId: number) =>
  db
    .query("SELECT * FROM webhooks WHERE enabled = 1 AND user_id = ?")
    .all(userId) as Webhook[];

/** Every channel of one user, including disabled, for the settings screen. */
export const allWebhooks = (userId: number) =>
  db
    .query("SELECT * FROM webhooks WHERE user_id = ? ORDER BY id")
    .all(userId) as Webhook[];

export const getWebhook = (id: number, userId: number) =>
  db
    .query("SELECT * FROM webhooks WHERE id = ? AND user_id = ?")
    .get(id, userId) as Webhook | null;

export function createWebhook(w: {
  type: string;
  url: string;
  chat_id?: string | null;
  user_id: number;
}) {
  const info = db
    .query(
      "INSERT INTO webhooks (type, url, chat_id, enabled, source, user_id) VALUES (?, ?, ?, 1, 'ui', ?)",
    )
    .run(w.type, w.url, w.chat_id ?? null, w.user_id);
  return Number(info.lastInsertRowid);
}

export function recordCheck(r: {
  site_id: number;
  ok: boolean;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
}) {
  db.query(
    `INSERT INTO checks (site_id, ts, ok, status_code, latency_ms, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    r.site_id,
    now(),
    r.ok ? 1 : 0,
    r.status_code,
    r.latency_ms,
    r.error,
  );
}

export const openIncident = (site_id: number) =>
  db
    .query(
      "SELECT * FROM incidents WHERE site_id = ? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .get(site_id) as { id: number; started_at: number; cause: string } | null;

export function startIncident(site_id: number, cause: string) {
  if (openIncident(site_id)) return;
  db.query(
    "INSERT INTO incidents (site_id, started_at, cause) VALUES (?, ?, ?)",
  ).run(site_id, now(), cause);
}

export function resolveIncident(site_id: number) {
  db.query(
    "UPDATE incidents SET resolved_at = ? WHERE site_id = ? AND resolved_at IS NULL",
  ).run(now(), site_id);
}

const RETAIN_RAW_DAYS = Number(process.env.RETAIN_RAW_DAYS ?? 7);

const rawUptime = (site_id: number, since: number) =>
  db
    .query(
      `SELECT COALESCE(SUM(ok), 0) AS up, COALESCE(SUM(1 - ok), 0) AS down
         FROM checks WHERE site_id = ? AND ts >= ?`,
    )
    .get(site_id, since) as { up: number; down: number };

/**
 * Uptime % over a rolling window.
 *
 * Windows within the raw-retention period are computed from `checks` directly,
 * which is exact to the second. Longer windows read whole completed days from
 * the `daily_stats` rollup and only touch raw rows for the current day — so a
 * 30d figure never scans 43k rows. The two sources are kept strictly disjoint
 * (rollup covers `day < today`, raw covers `ts >= startOfToday`) so no check is
 * counted twice. This relies on `rollupAndPrune()` having run — `startMonitor()`
 * calls it at boot and hourly, so completed days are always in `daily_stats`.
 */
export function uptimePct(site_id: number, days: number): number | null {
  const cutoff = now() - days * 86_400_000;
  let up: number, total: number;

  if (days <= RETAIN_RAW_DAYS) {
    const raw = rawUptime(site_id, cutoff);
    up = raw.up;
    total = raw.up + raw.down;
  } else {
    const today = new Date(now()).toISOString().slice(0, 10);
    const rollupFrom = new Date(cutoff).toISOString().slice(0, 10);

    const agg = db
      .query(
        `SELECT COALESCE(SUM(up_count), 0) AS up, COALESCE(SUM(down_count), 0) AS down
           FROM daily_stats WHERE site_id = ? AND day >= ? AND day < ?`,
      )
      .get(site_id, rollupFrom, today) as { up: number; down: number };

    const raw = rawUptime(site_id, new Date(today).getTime());
    up = agg.up + raw.up;
    total = up + agg.down + raw.down;
  }

  return total === 0 ? null : (up / total) * 100;
}

export const recentChecks = (site_id: number, limit = 60) =>
  (
    db
      .query(
        "SELECT ts, ok, latency_ms, status_code, error FROM checks WHERE site_id = ? ORDER BY ts DESC LIMIT ?",
      )
      .all(site_id, limit) as {
      ts: number;
      ok: number;
      latency_ms: number | null;
      status_code: number | null;
      error: string | null;
    }[]
  ).reverse();

export const recentIncidents = (site_id: number, limit = 20) =>
  db
    .query(
      "SELECT * FROM incidents WHERE site_id = ? ORDER BY started_at DESC LIMIT ?",
    )
    .all(site_id, limit) as {
    id: number;
    started_at: number;
    resolved_at: number | null;
    cause: string;
  }[];

// --- dashboard aggregates ------------------------------------------------

export type Series = {
  /** Checks per bucket; 0 where no checks ran (a real value, not a gap). */
  volume: number[];
  /** Mean latency per bucket; null where nothing was measured. */
  latency: (number | null)[];
  /** Uptime % per bucket; null where nothing was measured. */
  uptime: (number | null)[];
  from: number;
  to: number;
};

/**
 * Bucketed history for the headline charts.
 *
 * The bucket width adapts to how much history exists rather than being fixed at
 * an hour: a monitor that booted five minutes ago still draws a real curve
 * instead of collapsing into a single point. Buckets never go below a minute,
 * so a long-running instance stays at ~`buckets` points across the window.
 */
export function series(userId: number, maxHours = 24, buckets = 40): Series {
  const windowStart = now() - maxHours * 3_600_000;
  const oldest = (
    db
      .query(
        `SELECT MIN(ts) AS m FROM checks
          WHERE ts >= ? AND site_id IN (SELECT id FROM sites WHERE user_id = ?)`,
      )
      .get(windowStart, userId) as { m: number | null }
  ).m;

  const to = now();
  if (oldest === null) return { volume: [], latency: [], uptime: [], from: to, to };

  const from = oldest;
  const bucketMs = Math.max(60_000, Math.ceil((to - from) / buckets));
  const count = Math.max(1, Math.ceil((to - from) / bucketMs));

  const rows = db
    .query(
      `SELECT CAST((ts - ?) / ? AS INTEGER)  AS idx,
              COUNT(*)                       AS total,
              SUM(ok)                        AS up,
              AVG(NULLIF(latency_ms, 0))     AS avg_latency
         FROM checks
        WHERE ts >= ? AND site_id IN (SELECT id FROM sites WHERE user_id = ?)
        GROUP BY idx
        ORDER BY idx`,
    )
    .all(from, bucketMs, from, userId) as {
    idx: number;
    total: number;
    up: number;
    avg_latency: number | null;
  }[];

  const volume = new Array(count).fill(0) as number[];
  const latency = new Array(count).fill(null) as (number | null)[];
  const uptime = new Array(count).fill(null) as (number | null)[];

  for (const r of rows) {
    if (r.idx < 0 || r.idx >= count) continue;
    volume[r.idx] = r.total;
    latency[r.idx] = r.avg_latency === null ? null : Math.round(r.avg_latency);
    uptime[r.idx] = r.total === 0 ? null : (r.up / r.total) * 100;
  }

  return { volume, latency, uptime, from, to };
}

export type Overview = {
  totalChecks: number;
  avgLatency: number | null;
  uptime: number | null;
  incidents: number;
};

export function overview(userId: number, hours = 24): Overview {
  const since = now() - hours * 3_600_000;
  const owned = "site_id IN (SELECT id FROM sites WHERE user_id = ?)";

  const c = db
    .query(
      `SELECT COUNT(*) AS total, SUM(ok) AS up, AVG(NULLIF(latency_ms, 0)) AS avg
         FROM checks WHERE ts >= ? AND ${owned}`,
    )
    .get(since, userId) as { total: number; up: number | null; avg: number | null };

  const i = db
    .query(
      `SELECT COUNT(*) AS n FROM incidents WHERE started_at >= ? AND ${owned}`,
    )
    .get(since, userId) as { n: number };

  return {
    totalChecks: c.total,
    avgLatency: c.avg === null ? null : Math.round(c.avg),
    uptime: c.total === 0 ? null : ((c.up ?? 0) / c.total) * 100,
    incidents: i.n,
  };
}

/** Sites whose certificate expires soonest, for the dashboard column. */
export const expiringCerts = (userId: number, limit = 5) =>
  db
    .query(
      `SELECT s.id, s.name, t.valid_to
         FROM tls_info t JOIN sites s ON s.id = t.site_id
        WHERE t.valid_to IS NOT NULL AND s.user_id = ?
        ORDER BY t.valid_to ASC
        LIMIT ?`,
    )
    .all(userId, limit) as { id: number; name: string; valid_to: number }[];

/** Most recent incidents across all sites, ongoing first. */
export const latestIncidents = (userId: number, limit = 5) =>
  db
    .query(
      `SELECT i.id, i.site_id, i.started_at, i.resolved_at, s.name
         FROM incidents i JOIN sites s ON s.id = i.site_id
        WHERE s.user_id = ?
        ORDER BY (i.resolved_at IS NULL) DESC, i.started_at DESC
        LIMIT ?`,
    )
    .all(userId, limit) as {
    id: number;
    site_id: number;
    started_at: number;
    resolved_at: number | null;
    name: string;
  }[];

/**
 * Roll completed days of raw checks into `daily_stats`, then prune raw rows
 * older than the retention window. Idempotent — safe to run on every boot and
 * once an hour thereafter.
 */
export function rollupAndPrune() {
  const cutoff = now() - RETAIN_RAW_DAYS * 86_400_000;
  const today = new Date(now()).toISOString().slice(0, 10);

  db.query(
    `INSERT INTO daily_stats (site_id, day, up_count, down_count, avg_latency)
     SELECT site_id,
            date(ts / 1000, 'unixepoch')          AS day,
            SUM(ok)                               AS up_count,
            SUM(1 - ok)                           AS down_count,
            CAST(AVG(latency_ms) AS INTEGER)      AS avg_latency
       FROM checks
      WHERE date(ts / 1000, 'unixepoch') < ?
      GROUP BY site_id, day
     ON CONFLICT(site_id, day) DO UPDATE SET
            up_count    = excluded.up_count,
            down_count  = excluded.down_count,
            avg_latency = excluded.avg_latency`,
  ).run(today);

  db.query("DELETE FROM checks WHERE ts < ?").run(cutoff);
}
