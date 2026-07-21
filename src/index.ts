import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  allWebhooks,
  createWebhook,
  db,
  getSite,
  getSiteByToken,
  getUserSetting,
  getWebhook,
  listPublicSites,
  listSites,
  newToken,
  now,
  recentIncidents,
  seedWebhooksFromEnv,
  setUserSetting,
  userTunable,
  type Site,
} from "./db";
import {
  clearFailures,
  createSession,
  createUser,
  destroySession,
  findUserByEmail,
  findUserByPublicToken,
  looksLikeEmail,
  noteFailure,
  passwordProblem,
  pruneSessions,
  sessionUser,
  throttleCheck,
  userCount,
  verifyPassword,
  SESSION_MAX_AGE,
  type User,
} from "./auth";
import { checkNow, startMonitor } from "./monitor";
import { deliver } from "./notify";
import { checkSiteTls, startTlsScheduler } from "./tls";
import {
  allStatuses,
  authPage,
  card,
  dashboardPage,
  landingPage,
  publicPage,
  settingsPage,
  siteStatus,
  sitePage,
} from "./ui";

const PORT = Number(process.env.PORT ?? 3000);
const SESSION_COOKIE = "webeye_session";

const app = new Hono<{ Variables: { user: User } }>();

// --- auth ---------------------------------------------------------------

/** Routes anyone may reach without an account. */
const PUBLIC_PATHS = new Set([
  "/",
  "/login",
  "/signup",
  "/logout",
  "/api/health",
  "/app.css",
  "/app.js",
  "/globe.json", // landing-page asset, must load before sign-in
]);

const isPublicPath = (path: string) =>
  PUBLIC_PATHS.has(path) ||
  // Public status pages authenticate via an unguessable token in the path,
  // validated by the route handler itself.
  path.startsWith("/p/") ||
  path.startsWith("/s/");

app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const user = sessionUser(getCookie(c, SESSION_COOKIE));
  if (user) c.set("user", user);

  if (isPublicPath(path)) return next();
  if (user) return next();

  if (path.startsWith("/api/")) return c.json({ error: "unauthorized" }, 401);
  return c.redirect("/login");
});

const setSession = (c: any, userId: number) => {
  setCookie(c, SESSION_COOKIE, createSession(userId), {
    httpOnly: true,
    sameSite: "Lax",
    secure: c.req.url.startsWith("https://"),
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
};

app.get("/signup", (c) =>
  c.get("user") ? c.redirect("/dashboard") : c.html(authPage("signup")),
);

app.post("/signup", async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? "").trim();
  const password = String(form.password ?? "");
  const name = String(form.name ?? "");

  const fail = (msg: string) =>
    c.html(authPage("signup", { error: msg, email, name }), 400);

  if (!looksLikeEmail(email)) return fail("Enter a valid email address.");
  const pwProblem = passwordProblem(password);
  if (pwProblem) return fail(pwProblem);
  if (findUserByEmail(email)) {
    return fail("An account with that email already exists.");
  }

  const id = await createUser({ email, password, name });
  setSession(c, id);
  return c.redirect("/dashboard");
});

app.get("/login", (c) =>
  c.get("user") ? c.redirect("/dashboard") : c.html(authPage("login")),
);

app.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? "").trim().toLowerCase();
  const password = String(form.password ?? "");

  const locked = throttleCheck(email);
  if (locked !== null) {
    return c.html(
      authPage("login", {
        error: `Too many failed attempts. Try again in ${locked} minute(s).`,
        email,
      }),
      429,
    );
  }

  const user = findUserByEmail(email);
  // Same message and same code path whether the email exists or the password
  // is wrong — otherwise this endpoint enumerates registered addresses.
  const ok = user ? await verifyPassword(password, user.password_hash) : false;

  if (!ok || !user) {
    noteFailure(email);
    return c.html(
      authPage("login", { error: "Incorrect email or password.", email }),
      401,
    );
  }

  clearFailures(email);
  setSession(c, user.id);
  return c.redirect("/dashboard");
});

app.get("/logout", (c) => {
  destroySession(getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/");
});

// --- static -------------------------------------------------------------

// `no-cache` means "revalidate", not "don't cache" — the browser still gets a
// 304 for unchanged files, but a redeploy never serves stale CSS/JS.
const serveFile = (path: string, type: string) => async (c: any) => {
  const file = Bun.file(`${import.meta.dir}/../public/${path}`);
  return new Response(file, {
    headers: { "content-type": type, "cache-control": "no-cache" },
  });
};

app.get("/app.css", serveFile("app.css", "text/css; charset=utf-8"));
app.get("/app.js", serveFile("app.js", "text/javascript; charset=utf-8"));
app.get("/globe.json", serveFile("globe.json", "application/json; charset=utf-8"));

// --- pages --------------------------------------------------------------

app.get("/", (c) =>
  c.html(landingPage({ signedIn: !!c.get("user"), accounts: userCount() })),
);

app.get("/dashboard", (c) => {
  const user = c.get("user");
  return c.html(dashboardPage(allStatuses(user.id), user));
});

app.get("/site/:id", (c) => {
  const user = c.get("user");
  const site = getSite(Number(c.req.param("id")), user.id);
  if (!site) return c.notFound();
  return c.html(sitePage(site, siteStatus(site), user));
});

app.get("/settings", (c) => {
  const user = c.get("user");
  return c.html(
    settingsPage({
      user,
      webhooks: allWebhooks(user.id),
      publicTitle: user.public_page_title ?? "Service Status",
      sslWarnDays: userTunable(user.id, "ssl_warn_days", "SSL_WARN_DAYS", 14),
      failuresBeforeDown: userTunable(
        user.id,
        "failures_before_down",
        "FAILURES_BEFORE_DOWN",
        2,
      ),
      defaultInterval: userTunable(
        user.id,
        "default_interval_seconds",
        "DEFAULT_INTERVAL",
        60,
      ),
      defaultTimeout: userTunable(
        user.id,
        "default_timeout_ms",
        "DEFAULT_TIMEOUT_MS",
        10000,
      ),
      siteCount: listSites(user.id).length,
      publicCount: listPublicSites(user.id).length,
    }),
  );
});

// --- settings api -------------------------------------------------------

/**
 * Only these keys are writable. Without the allowlist a crafted request could
 * write arbitrary keys into the same table that holds tokens.
 */
const WRITABLE_SETTINGS: Record<string, { min?: number; max?: number }> = {
  ssl_warn_days: { min: 1, max: 365 },
  failures_before_down: { min: 1, max: 10 },
  default_interval_seconds: { min: 10, max: 86400 },
  default_timeout_ms: { min: 1000, max: 120000 },
};

app.patch("/api/settings", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json()) as Record<string, unknown>;

  for (const [key, raw] of Object.entries(body)) {
    const value = String(raw ?? "").trim();

    // The status-page title lives on the user row, not the tunables table.
    if (key === "public_page_title") {
      db.query("UPDATE users SET public_page_title = ? WHERE id = ?").run(
        value || null,
        user.id,
      );
      continue;
    }

    const rule = WRITABLE_SETTINGS[key];
    if (!rule) return c.json({ error: `unknown setting: ${key}` }, 400);

    if (value === "") {
      setUserSetting(user.id, key, null); // fall back to env / default
      continue;
    }
    const n = Number(value);
    if (Number.isNaN(n) || n < (rule.min ?? -Infinity) || n > (rule.max ?? Infinity)) {
      return c.json(
        { error: `${key} must be between ${rule.min} and ${rule.max}` },
        400,
      );
    }
    setUserSetting(user.id, key, value);
  }

  return c.json({ ok: true });
});

// --- notification channels ----------------------------------------------

const HOOK_TYPES = ["discord", "telegram", "generic"];

app.post("/api/webhooks", async (c) => {
  const user = c.get("user");
  const b = (await c.req.json()) as Record<string, string>;
  const type = String(b.type ?? "");
  if (!HOOK_TYPES.includes(type)) return c.json({ error: "invalid type" }, 400);

  let url = String(b.url ?? "").trim();
  const chat_id = String(b.chat_id ?? "").trim() || null;

  if (type === "telegram") {
    if (!chat_id) return c.json({ error: "Telegram needs a chat ID" }, 400);
    // Accept a bare bot token and expand it into the full sendMessage URL.
    if (!url.startsWith("http")) {
      url = `https://api.telegram.org/bot${url}/sendMessage`;
    }
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("bad protocol");
    }
  } catch {
    return c.json({ error: "invalid URL" }, 400);
  }

  return c.json(
    { id: createWebhook({ type, url, chat_id, user_id: user.id }) },
    201,
  );
});

app.patch("/api/webhooks/:id", async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!getWebhook(id, user.id)) return c.notFound();
  const b = (await c.req.json()) as { enabled?: unknown };
  if (b.enabled === undefined) return c.json({ error: "nothing to update" }, 400);
  db.query("UPDATE webhooks SET enabled = ? WHERE id = ? AND user_id = ?").run(
    b.enabled ? 1 : 0,
    id,
    user.id,
  );
  return c.json({ ok: true });
});

app.delete("/api/webhooks/:id", (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const hook = getWebhook(id, user.id);
  if (!hook) return c.notFound();
  // An env-defined hook would simply reappear on the next boot; disabling is
  // the only change that actually sticks.
  if (hook.source === "env") {
    return c.json(
      {
        error:
          "This channel comes from an environment variable. Disable it here, or remove the variable and restart.",
      },
      400,
    );
  }
  db.query("DELETE FROM webhooks WHERE id = ? AND user_id = ?").run(id, user.id);
  return c.json({ ok: true });
});

app.post("/api/webhooks/:id/test", async (c) => {
  const user = c.get("user");
  const hook = getWebhook(Number(c.req.param("id")), user.id);
  if (!hook) return c.notFound();
  try {
    await deliver(hook, { kind: "test" });
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: String(err?.message ?? err) }, 502);
  }
});

// --- public status pages ------------------------------------------------
// Unauthenticated: possession of the token is the credential. Every response
// here goes through `card(s, true)` / `publicPage`, which strip error text,
// certificate data and monitored URLs.

app.get("/p/:token", (c) => {
  const owner = findUserByPublicToken(c.req.param("token"));
  if (!owner) return c.notFound();

  const statuses = listPublicSites(owner.id).map(siteStatus);
  return c.html(
    publicPage(
      owner.public_page_title ?? "Service Status",
      statuses,
      `/p/${c.req.param("token")}/grid`,
      listPublicSites(owner.id)
        .flatMap((s) => recentIncidents(s.id, 5))
        .sort((a, b) => b.started_at - a.started_at)
        .slice(0, 10),
    ),
  );
});

app.get("/p/:token/grid", (c) => {
  const owner = findUserByPublicToken(c.req.param("token"));
  if (!owner) return c.notFound();
  const statuses = listPublicSites(owner.id).map(siteStatus);
  return c.json({
    html:
      statuses.map((s) => card(s, true)).join("") ||
      `<p class="empty-state">No services are being published yet.</p>`,
    down: statuses.filter((s) => s.state === "down").length,
  });
});

app.get("/s/:token", (c) => {
  const site = getSiteByToken(c.req.param("token"));
  if (!site) return c.notFound();
  return c.html(
    publicPage(
      `${site.name} Status`,
      [siteStatus(site)],
      `/s/${c.req.param("token")}/grid`,
      recentIncidents(site.id, 10),
    ),
  );
});

app.get("/s/:token/grid", (c) => {
  const site = getSiteByToken(c.req.param("token"));
  if (!site) return c.notFound();
  const s = siteStatus(site);
  return c.json({ html: card(s, true), down: s.state === "down" ? 1 : 0 });
});

// --- sharing administration ---------------------------------------------

app.post("/api/public-page", (c) => {
  const user = c.get("user");
  let token = user.public_token;
  if (!token) {
    token = newToken();
    db.query("UPDATE users SET public_token = ? WHERE id = ?").run(
      token,
      user.id,
    );
  }
  return c.json({ url: `/p/${token}` });
});

app.delete("/api/public-page", (c) => {
  const user = c.get("user");
  db.query("UPDATE users SET public_token = NULL WHERE id = ?").run(user.id);
  return c.json({ ok: true });
});

app.post("/api/sites/:id/share", (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const site = getSite(id, user.id);
  if (!site) return c.notFound();

  const token = site.public_token ?? newToken();
  db.query("UPDATE sites SET public_token = ? WHERE id = ?").run(token, id);
  return c.json({ url: `/s/${token}` });
});

app.delete("/api/sites/:id/share", (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!getSite(id, user.id)) return c.notFound();
  db.query("UPDATE sites SET public_token = NULL WHERE id = ?").run(id);
  return c.json({ ok: true });
});

// --- api ----------------------------------------------------------------

app.get("/api/health", (c) =>
  c.json({ ok: true, uptime_s: Math.round(process.uptime()) }),
);

app.get("/api/status", (c) => {
  const user = c.get("user");
  return c.json({ sites: allStatuses(user.id), at: now() });
});

/** Pre-rendered grid fragment for the 15s poll — keeps card markup server-side only. */
app.get("/api/grid", (c) => {
  const user = c.get("user");
  const statuses = allStatuses(user.id);
  return c.json({
    html:
      statuses.map((s) => card(s)).join("") ||
      `<p class="empty-state">No services yet — add your first one above.</p>`,
    down: statuses.filter((s) => s.state === "down").length,
  });
});

app.post("/api/sites", async (c) => {
  const user = c.get("user");
  const b = (await c.req.json()) as Partial<Site>;
  if (!b.name || !b.url) return c.json({ error: "name and url required" }, 400);
  try {
    new URL(b.url);
  } catch {
    return c.json({ error: "invalid url" }, 400);
  }

  const info = db
    .query(
      `INSERT INTO sites (name, url, method, expected_status, keyword,
                          interval_seconds, timeout_ms, enabled, headers_json,
                          created_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      b.name,
      b.url,
      b.method ?? "GET",
      b.expected_status ?? 200,
      b.keyword || null,
      Math.max(
        10,
        Number(
          b.interval_seconds ??
            userTunable(
              user.id,
              "default_interval_seconds",
              "DEFAULT_INTERVAL",
              60,
            ),
        ),
      ),
      Number(
        b.timeout_ms ??
          userTunable(user.id, "default_timeout_ms", "DEFAULT_TIMEOUT_MS", 10000),
      ),
      b.headers_json ?? null,
      now(),
      user.id,
    );

  // Check the cert straight away rather than waiting for the daily sweep.
  const created = getSite(Number(info.lastInsertRowid), user.id);
  if (created) checkSiteTls(created).catch((e) => console.error("[tls]", e));

  return c.json({ id: Number(info.lastInsertRowid) }, 201);
});

app.patch("/api/sites/:id", async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!getSite(id, user.id)) return c.notFound();
  const b = (await c.req.json()) as Record<string, unknown>;

  const allowed = [
    "name",
    "url",
    "method",
    "expected_status",
    "keyword",
    "interval_seconds",
    "timeout_ms",
    "enabled",
    "headers_json",
    "is_public",
  ];
  const fields = Object.keys(b).filter((k) => allowed.includes(k));
  if (!fields.length) return c.json({ error: "nothing to update" }, 400);

  db.query(
    `UPDATE sites SET ${fields.map((f) => `${f} = ?`).join(", ")}
      WHERE id = ? AND user_id = ?`,
  ).run(...fields.map((f) => b[f] as any), id, user.id);

  return c.json({ ok: true });
});

app.delete("/api/sites/:id", (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!getSite(id, user.id)) return c.notFound();
  db.query("DELETE FROM sites WHERE id = ? AND user_id = ?").run(id, user.id);
  return c.json({ ok: true });
});

app.post("/api/sites/:id/check", (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!getSite(id, user.id)) return c.notFound();
  checkNow(id);
  return c.json({ ok: true });
});

// --- boot ---------------------------------------------------------------

seedWebhooksFromEnv();
pruneSessions();
setInterval(pruneSessions, 86_400_000);
startMonitor();
startTlsScheduler();

if (process.env.MONITOR_PASSWORD) {
  console.warn(
    "[auth] MONITOR_PASSWORD is set but no longer used — WebEye now has user accounts. Sign up at /signup.",
  );
}
if (userCount() === 0) {
  console.log("[auth] no accounts yet — the first signup claims this instance.");
}
console.log(`[http] listening on http://localhost:${PORT}`);

export default { port: PORT, fetch: app.fetch, idleTimeout: 30 };
