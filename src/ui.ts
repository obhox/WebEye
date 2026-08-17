import {
  db,
  expiringCerts,
  latestIncidents,
  listSites,
  overview,
  recentChecks,
  recentIncidents,
  series,
  uptimePct,
  type Site,
  type Webhook,
} from "./db";
import type { Invite, User } from "./auth";
import { siteState } from "./monitor";
import { daysLeft } from "./tls";

/** Cache-buster fixed at process start, so a redeploy never serves stale assets. */
const ASSET_V = Date.now().toString(36);

export const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// --- icons ---------------------------------------------------------------
// Inline so the page stays a single request with no icon font or sprite sheet.

const I = {
  logo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4.9 19.1a10 10 0 0 1 0-14.2M7.8 16.2a6 6 0 0 1 0-8.4"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M19.1 4.9a10 10 0 0 1 0 14.2"/></svg>`,
  pulse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  share: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.6 6.8-4M8.6 13.4l6.8 4"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5 8 12l7 7"/></svg>`,
  sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>`,
  moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3 3 10.5l7 3 3 7L21 3Z"/></svg>`,
  github: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.9 10.9c.6.1.8-.25.8-.55v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.75.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0C17 4.7 18 5 18 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.65.8.55A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z"/></svg>`,
};

const REPO_URL = "https://github.com/obhox/webeye";

/** Sun/moon swap is CSS-driven off `data-theme`; JS only flips the attribute. */
const themeButton = (float = false) =>
  `<button id="theme-btn" class="theme-btn${float ? " theme-float" : ""}" title="Switch theme" aria-label="Switch theme">
  <span class="i-moon">${I.moon}</span><span class="i-sun">${I.sun}</span>
</button>`;

/**
 * Applied before first paint, so a user who chose dark never sees a white
 * flash. Resolving the OS preference here too means `data-theme` is always
 * present for JS-enabled visitors, which is what drives the icon swap.
 */
const THEME_BOOT = `<script>(function(){try{var t=localStorage.getItem('webeye-theme');
if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}
document.documentElement.dataset.theme=t}catch(e){}})()</script>`;

// --- status model --------------------------------------------------------

export type SiteStatus = {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  state: "up" | "degraded" | "down" | "pending" | "paused";
  latency_ms: number | null;
  status_code: number | null;
  error: string | null;
  last_checked: number | null;
  uptime24h: number | null;
  uptime7d: number | null;
  uptime30d: number | null;
  ssl: { daysLeft: number; issuer: string; error: string | null } | null;
  history: { ok: number; latency_ms: number | null }[];
  isPublic: boolean;
  publicToken: string | null;
};

export function siteStatus(site: Site): SiteStatus {
  const history = recentChecks(site.id, 60);
  const last = history[history.length - 1] ?? null;

  const tls = db
    .query("SELECT * FROM tls_info WHERE site_id = ?")
    .get(site.id) as
    | { issuer: string | null; valid_to: number | null; error: string | null }
    | null;

  return {
    id: site.id,
    name: site.name,
    url: site.url,
    enabled: !!site.enabled,
    state: site.enabled ? siteState(site.id) : "paused",
    latency_ms: last?.latency_ms ?? null,
    status_code: last?.status_code ?? null,
    error: last?.error ?? null,
    last_checked: last?.ts ?? null,
    uptime24h: uptimePct(site.id, 1),
    uptime7d: uptimePct(site.id, 7),
    uptime30d: uptimePct(site.id, 30),
    ssl:
      tls && tls.valid_to
        ? {
            daysLeft: daysLeft(tls.valid_to),
            issuer: tls.issuer ?? "unknown",
            error: tls.error,
          }
        : null,
    history: history.map((h) => ({ ok: h.ok, latency_ms: h.latency_ms })),
    isPublic: !!site.is_public,
    publicToken: site.public_token,
  };
}

export const allStatuses = (userId: number) =>
  listSites(userId).map(siteStatus);

const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}%`);

// --- charts --------------------------------------------------------------

/**
 * Area chart drawn as an SVG path. `preserveAspectRatio="none"` lets it stretch
 * to any card width; `vector-effect` keeps the stroke 1.5px despite that scaling.
 * Gaps (null) split the line rather than being drawn as zero.
 */
function areaChart(values: (number | null)[], height = 74) {
  const pts = values.filter((v): v is number => v !== null);
  if (pts.length < 2) return `<div class="nodata">Not enough data</div>`;

  const W = 300;
  const max = Math.max(...pts);
  const min = Math.min(...pts);
  const span = max - min;
  const pad = 8;
  const usable = height - pad * 2;

  const x = (i: number) => (i / (values.length - 1)) * W;
  // A perfectly flat series (e.g. uptime pinned at 100%) has no range to scale
  // against — draw it through the middle rather than pinned to an edge.
  const y = (v: number) =>
    span === 0 ? pad + usable / 2 : pad + (1 - (v - min) / span) * usable;

  let line = "";
  let started = false;
  values.forEach((v, i) => {
    if (v === null) {
      started = false;
      return;
    }
    line += `${started ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    started = true;
  });

  const firstIdx = values.findIndex((v) => v !== null);
  const lastIdx = values.length - 1 - [...values].reverse().findIndex((v) => v !== null);
  const fill = `M${x(firstIdx).toFixed(1)} ${height} ${line.replace(/^M/, "L")} L${x(lastIdx).toFixed(1)} ${height} Z`;

  const grid = [0.25, 0.5, 0.75]
    .map(
      (f) =>
        `<line class="chart-grid" x1="0" y1="${(height * f).toFixed(1)}" x2="${W}" y2="${(height * f).toFixed(1)}" vector-effect="non-scaling-stroke"/>`,
    )
    .join("");

  return `<svg class="chart" viewBox="0 0 ${W} ${height}" height="${height}" width="100%" preserveAspectRatio="none">
  ${grid}
  <path class="chart-fill" d="${fill}"/>
  <path class="chart-line" d="${line}" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
</svg>`;
}

/** Percentage change between the first and second half of a series. */
function trend(values: (number | null)[]): number | null {
  const pts = values.filter((v): v is number => v !== null);
  if (pts.length < 4) return null;
  const mid = Math.floor(pts.length / 2);
  const avg = (a: number[]) => a.reduce((s, n) => s + n, 0) / a.length;
  const before = avg(pts.slice(0, mid));
  const after = avg(pts.slice(mid));
  if (before === 0) return null;
  return ((after - before) / before) * 100;
}

/** `higherIsBetter` decides the colour: slower responses trending up is bad. */
function deltaTag(t: number | null, higherIsBetter = true) {
  if (t === null || Math.abs(t) < 0.05) return "";
  const rising = t > 0;
  const good = rising === higherIsBetter;
  return `<span class="delta ${good ? "up" : "down"}">${rising ? "↗" : "↘"} ${Math.abs(t).toFixed(1)}%</span>`;
}

function metric(
  label: string,
  value: string,
  opts: { delta?: string; chart?: string; wide?: boolean } = {},
) {
  return `<article class="metric${opts.wide ? " wide" : ""}">
  <div class="k">${esc(label)}</div>
  <div class="v">${value}${opts.delta ?? ""}</div>
  ${opts.chart ?? `<div class="nodata">No data yet</div>`}
</article>`;
}

// --- site cards ----------------------------------------------------------

/** Inline SVG bar sparkline — no chart library, no client-side rendering. */
export function sparkline(history: { ok: number; latency_ms: number | null }[]) {
  if (!history.length) return `<div class="spark empty"></div>`;

  // Scale to the 95th percentile, not the max: one cold-start outlier would
  // otherwise squash every other bar into an unreadable flat line.
  const latencies = history
    .filter((h) => h.ok)
    .map((h) => h.latency_ms ?? 0)
    .sort((a, b) => a - b);
  const ceiling = Math.max(latencies[Math.floor(latencies.length * 0.95)] ?? 0, 1);

  const bars = history
    .map((h, i) => {
      // Failures always render full height — a fast failure is still a failure.
      const frac = h.ok ? Math.min((h.latency_ms ?? 0) / ceiling, 1) : 1;
      // One decimal is well below a pixel here; the raw float would otherwise
      // emit 15 digits per bar, in 60 bars, on every card.
      const bh = Math.max(3, frac * 28).toFixed(1);
      return `<rect x="${i * 4}" y="${(30 - Number(bh)).toFixed(1)}" width="3" height="${bh}" class="${h.ok ? "b-up" : "b-down"}"><title>${h.ok ? "up" : "down"} · ${h.latency_ms ?? "?"}ms</title></rect>`;
    })
    .join("");

  return `<svg class="spark" viewBox="0 0 ${Math.max(history.length * 4, 4)} 30" preserveAspectRatio="none">${bars}</svg>`;
}

function sslBadge(s: SiteStatus) {
  if (!s.ssl) return "";
  const d = s.ssl.daysLeft;
  const cls = d < 0 ? "bad" : d <= 14 ? "warn" : "";
  return `<span class="badge ${cls}" title="${esc(s.ssl.issuer)}">${d < 0 ? "SSL expired" : `SSL ${d}d`}</span>`;
}

/**
 * `isPublic` strips everything a visitor shouldn't see: raw error text (which
 * can leak internal hostnames, keywords and paths), the certificate badge, and
 * the link into the admin detail page. State and uptime numbers remain.
 */
/**
 * `showHeader: false` is for the service detail page, where the page heading
 * already carries the name and state — repeating them in the card reads as a
 * duplicate rather than a summary.
 */
export function card(s: SiteStatus, isPublic = false, showHeader = true) {
  const title = isPublic
    ? esc(s.name)
    : `<a href="/site/${s.id}">${esc(s.name)}</a>`;

  return `
<article class="card ${s.state}" data-id="${s.id}" data-name="${esc(s.name.toLowerCase())}" data-url="${isPublic ? "" : esc(s.url.toLowerCase())}">
  ${
    showHeader
      ? `<header>
    <span class="pill ${s.state}">${s.state}</span>
    <h2>${title}</h2>
    ${isPublic ? "" : sslBadge(s)}
  </header>`
      : ""
  }
  ${
    isPublic
      ? ""
      : `<a class="url" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.url)}</a>`
  }
  ${sparkline(s.history)}
  <dl class="metrics">
    <div><dt>Response</dt><dd>${s.latency_ms === null ? "—" : `${s.latency_ms} ms`}</dd></div>
    <div><dt>24h</dt><dd>${pct(s.uptime24h)}</dd></div>
    <div><dt>7d</dt><dd>${pct(s.uptime7d)}</dd></div>
    <div><dt>30d</dt><dd>${pct(s.uptime30d)}</dd></div>
  </dl>
  ${!isPublic && s.error ? `<p class="err">${esc(s.error)}</p>` : ""}
</article>`;
}

// --- shell ---------------------------------------------------------------

function layout(title: string, body: string, noindex = false, user?: User) {
  return `<!doctype html>
<html lang="en"><head>
<script defer src="https://a.falorb.com/t.js" data-project="prj_f052fed23a35a1393deb9eecdaa1c4c2"></script>
${
  user
    ? `<script>window.falorb && window.falorb.identify(${JSON.stringify(String(user.id))}, ${JSON.stringify({ email: user.email })});</script>`
    : ""
}
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${noindex ? `<meta name="robots" content="noindex, nofollow">` : ""}
${THEME_BOOT}
<link rel="stylesheet" href="/app.css?v=${ASSET_V}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📡</text></svg>">
</head><body>${body}</body></html>`;
}

/** App chrome: a single top bar. Public pages pass `chrome: false`. */
function shell(body: string, opts: { chrome?: boolean; user?: User } = {}) {
  const chrome = opts.chrome !== false;

  const top = chrome
    ? `<header class="topbar">
  <a class="brand" href="/dashboard">${I.logo} WebEye</a>
  <div class="grow"></div>
  ${opts.user ? `<span class="who" title="${esc(opts.user.email)}">${esc(opts.user.name || opts.user.email)}</span>` : ""}
  <a class="icon-btn" href="/settings" title="Settings" aria-label="Settings">${I.gear}</a>
  ${themeButton()}
  <a class="btn ghost" href="/logout">Log out</a>
</header>`
    : "";

  // Public pages have no top bar, so the toggle floats in the corner instead.
  const floating = chrome ? "" : themeButton(true);

  return `<div class="page">${top}${floating}<div class="content">${body}</div></div>`;
}

const chev = `<span class="chev">${I.chevron}</span>`;

function listRow(
  label: string,
  meta: string,
  opts: { href?: string; dot?: string } = {},
) {
  const inner = `${opts.dot ? `<span class="dot ${opts.dot}"></span>` : ""}
    <span class="label">${label}</span>
    ${meta ? `<span class="meta">${meta}</span>` : ""}
    ${opts.href ? chev : ""}`;
  return opts.href
    ? `<a class="row" href="${esc(opts.href)}">${inner}</a>`
    : `<div class="row">${inner}</div>`;
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
};

const dur = (ms: number) => {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
};

// --- dashboard -----------------------------------------------------------

export function dashboardPage(statuses: SiteStatus[], user: User) {
  const publicToken = user.public_token;
  const down = statuses.filter((s) => s.state === "down").length;
  const degraded = statuses.filter((s) => s.state === "degraded").length;
  const up = statuses.filter((s) => s.state === "up").length;
  const paused = statuses.filter((s) => s.state === "paused").length;

  const headline = down
    ? `${down} service${down > 1 ? "s" : ""} down`
    : degraded
      ? "Partial degradation"
      : statuses.length
        ? "All systems operational"
        : "No services yet";

  const summary = down
    ? `<span class="sum bad">${down} down</span>`
    : degraded
      ? `<span class="sum warn">${degraded} degraded</span>`
      : `<span class="sum ok">All systems operational</span>`;

  // --- headline charts
  const ov = overview(user.id, 24);
  const { volume, latency, uptime: upSeries, from, to } = series(user.id, 24);

  // The chip reflects the window actually charted, which on a young instance
  // is shorter than 24h.
  const spanMin = Math.round((to - from) / 60000);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const rangeLabel =
    volume.length === 0
      ? "No data yet"
      : spanMin >= 1380
        ? "Last 24 hours"
        : spanMin >= 90
          ? `Last ${plural(Math.round(spanMin / 60), "hour")}`
          : `Last ${plural(Math.max(spanMin, 1), "minute")}`;

  const certs = expiringCerts(user.id, 5);
  const incidents = latestIncidents(user.id, 5);
  const openIncidents = incidents.filter((i) => !i.resolved_at).length;

  const metricCards = [
    metric(
      "Checks run",
      ov.totalChecks.toLocaleString(),
      {
        delta: deltaTag(trend(volume)),
        chart: areaChart(volume),
        wide: true,
      },
    ),
    metric(
      "Avg response",
      ov.avgLatency === null ? "—" : `${ov.avgLatency} ms`,
      {
        delta: deltaTag(trend(latency), false),
        chart: areaChart(latency),
        wide: true,
      },
    ),
    metric("Uptime", ov.uptime === null ? "—" : `${ov.uptime.toFixed(2)}%`, {
      chart: areaChart(upSeries),
    }),
    metric("Services up", `${up}/${statuses.length}`, {
      chart: `<div class="nodata">${[
        `${down} down`,
        `${degraded} degraded`,
        ...(paused ? [`${paused} paused`] : []),
      ].join(" · ")}</div>`,
    }),
    metric("Incidents", String(ov.incidents), {
      chart: `<div class="nodata">${openIncidents} open right now</div>`,
    }),
    metric(
      "Cert expiry",
      certs.length ? `${daysLeft(certs[0]!.valid_to)}d` : "—",
      {
        chart: `<div class="nodata">${certs.length ? `soonest: ${esc(certs[0]!.name)}` : "no certificates yet"}</div>`,
      },
    ),
  ].join("");

  // --- three columns
  const serviceRows =
    statuses
      .slice(0, 5)
      .map((s) =>
        listRow(esc(s.name), s.latency_ms === null ? "" : `${s.latency_ms} ms`, {
          href: `/site/${s.id}`,
          dot: s.state,
        }),
      )
      .join("") || `<div class="row empty">No services yet</div>`;

  const incidentRows =
    incidents
      .map((i) =>
        listRow(
          esc(i.name),
          i.resolved_at
            ? dur(i.resolved_at - i.started_at)
            : `<span class="sum bad">ongoing</span>`,
          { href: `/site/${i.site_id}`, dot: i.resolved_at ? "up" : "down" },
        ),
      )
      .join("") || `<div class="row empty">No incidents recorded</div>`;

  const certRows =
    certs
      .map((c) => {
        const d = daysLeft(c.valid_to);
        return listRow(esc(c.name), `${d}d left`, {
          href: `/site/${c.id}`,
          dot: d < 0 ? "down" : d <= 14 ? "degraded" : "up",
        });
      })
      .join("") || `<div class="row empty">No certificates checked yet</div>`;

  const publicCount = statuses.filter((s) => s.isPublic).length;
  const sharePanel = `
<section id="share-panel" class="share-panel" hidden>
  <h3>Public status page</h3>
  ${
    publicToken
      ? `<p class="muted">Anyone with this link can see the ${publicCount} service(s) you marked public — no login required.</p>
         <div class="share-row">
           <input id="public-url" readonly value="${esc(`/p/${publicToken}`)}">
           <button class="btn" data-copy="public-url">Copy</button>
           <button class="btn danger" id="revoke-public">Revoke</button>
         </div>
         <p class="muted">Mark services public from each service's page. Revoking breaks the old link immediately.</p>`
      : `<p class="muted">Publish a combined status page showing the services you choose. The link is a long random URL — unguessable, and revocable at any time.</p>
         <button class="btn" id="create-public">Create public page</button>`
  }
</section>`;

  return layout(
    down ? `(${down} down) WebEye` : "WebEye",
    shell(`
<section class="hero">
  <div class="hero-pill">${I.pulse} ${plural(statuses.length, "service")} monitored · ${plural(ov.totalChecks, "check")} in ${esc(rangeLabel.replace(/^Last /, "the last "))}</div>
  <h1>${esc(headline)}</h1>

  <div class="searchbox">
    <span class="icon">${I.search}</span>
    <input id="filter" type="text" placeholder="Search services" autocomplete="off"
           role="combobox" aria-expanded="false" aria-controls="search-results" aria-autocomplete="list">
    <kbd>/</kbd>
    <!-- Populated from the rendered service cards, so it never goes stale
         against the grid it is describing. -->
    <div id="search-results" class="search-results" role="listbox" hidden></div>
  </div>

  <div class="columns">
    <div>
      <div class="col-head">Services <span class="count">${statuses.length}</span></div>
      ${serviceRows}
    </div>
    <div id="incidents">
      <div class="col-head">Incidents ${incidents.length ? `<span class="count">${openIncidents ? `${openIncidents} open` : incidents.length}</span>` : ""}</div>
      ${incidentRows}
    </div>
    <div>
      <div class="col-head">Certificates ${certs.length ? `<span class="count">${certs.length}</span>` : ""}</div>
      ${certRows}
    </div>
  </div>
</section>

<div class="sec-head" id="analytics">
  <h2>Analytics</h2>
  <div class="grow"></div>
  <span class="btn ghost">${I.calendar} ${esc(rangeLabel)}</span>
  <button class="btn ghost" id="refresh-btn" title="Refresh">${I.refresh}</button>
</div>
<div class="metrics-grid">${metricCards}</div>

<div class="sec-head" id="services">
  <h2>Services</h2>
  <div class="grow"></div>
  <button id="share-btn" class="btn">${I.share} Public page</button>
  <button id="add-btn" class="btn primary">${I.plus} Add service</button>
</div>

${sharePanel}

<form id="add-form" class="add-form" hidden>
  <input type="text" name="name" placeholder="Name" required>
  <input name="url" placeholder="https://example.com" type="url" required>
  <input type="text" name="keyword" placeholder="Keyword (optional)">
  <input name="interval_seconds" type="number" min="10" value="60" title="Interval (seconds)">
  <button class="btn primary" type="submit">Save</button>
  <button class="btn ghost" type="button" id="add-cancel">Cancel</button>
</form>

<main id="grid" class="grid" data-endpoint="/api/grid">
  ${statuses.map((s) => card(s)).join("") || `<p class="empty-state">No services yet — add your first one above.</p>`}
</main>
<footer class="foot">Auto-refreshes every 15s · <span id="stamp"></span></footer>
<script src="/app.js?v=${ASSET_V}"></script>`, { user }),
    false,
    user,
  );
}

// --- site detail ---------------------------------------------------------

export function sitePage(site: Site, s: SiteStatus, user: User) {
  const incidents = recentIncidents(site.id);
  const fmt = (t: number) => new Date(t).toLocaleString();

  const rows =
    incidents
      .map(
        (i) => `<tr>
      <td>${fmt(i.started_at)}</td>
      <td>${i.resolved_at ? fmt(i.resolved_at) : `<span class="pill down">ongoing</span>`}</td>
      <td>${dur((i.resolved_at ?? Date.now()) - i.started_at)}</td>
      <td class="cause">${esc(i.cause)}</td>
    </tr>`,
      )
      .join("") ||
    `<tr><td colspan="4" class="muted">No incidents recorded.</td></tr>`;

  return layout(
    `${site.name} · WebEye`,
    shell(`
<div class="sec-head" style="margin-top:0">
  <a class="btn ghost" href="/dashboard">${I.back} Back</a>
  <h2>${esc(site.name)}</h2>
  <span class="pill ${s.state}">${s.state}</span>
  <div class="grow"></div>
  <button class="btn danger" id="delete-btn" data-id="${site.id}">Delete</button>
</div>

<section class="detail">
  ${card(s, false, false)}
  <div class="panel">
    <h3>Certificate</h3>
    ${
      s.ssl
        ? `<p>Issuer: <strong>${esc(s.ssl.issuer)}</strong><br>Expires in <strong>${s.ssl.daysLeft} day(s)</strong></p>`
        : `<p class="muted">No certificate data (HTTP site, or not yet checked).</p>`
    }
    <h3>Configuration</h3>
    <p class="muted">
      ${esc(site.method)} · expects HTTP ${site.expected_status} ·
      every ${site.interval_seconds}s · timeout ${site.timeout_ms}ms
      ${site.keyword ? `· keyword "${esc(site.keyword)}"` : ""}
    </p>
    <button class="btn" id="edit-btn">Edit configuration</button>
  </div>
</section>

<section class="panel" id="edit-panel" data-id="${site.id}" style="margin-bottom:14px" hidden>
  <h3>Edit service</h3>
  <form id="edit-form" class="edit-grid">
    <label class="field"><span>Name</span>
      <input type="text" name="name" value="${esc(site.name)}" required></label>
    <label class="field"><span>URL</span>
      <input type="url" name="url" value="${esc(site.url)}" required></label>
    <label class="field"><span>Method</span>
      <select name="method">
        ${["GET", "HEAD", "POST"]
          .map(
            (m) =>
              `<option value="${m}"${site.method === m ? " selected" : ""}>${m}</option>`,
          )
          .join("")}
      </select></label>
    <label class="field"><span>Expected status</span>
      <input type="number" name="expected_status" min="100" max="599" value="${site.expected_status}"></label>
    <label class="field"><span>Check every (seconds)</span>
      <input type="number" name="interval_seconds" min="10" max="86400" value="${site.interval_seconds}"></label>
    <label class="field"><span>Timeout (ms)</span>
      <input type="number" name="timeout_ms" min="1000" max="120000" value="${site.timeout_ms}"></label>
    <label class="field wide"><span>Keyword must appear in the response (optional)</span>
      <input type="text" name="keyword" value="${esc(site.keyword ?? "")}" placeholder="e.g. ok"></label>
    <label class="check wide">
      <input type="checkbox" name="enabled" ${site.enabled ? "checked" : ""}>
      Monitoring enabled — uncheck to pause without losing history
    </label>
    <div class="wide">
      <button class="btn primary" type="submit">Save changes</button>
      <button class="btn ghost" type="button" id="edit-cancel">Cancel</button>
    </div>
  </form>
</section>

<section class="panel" data-id="${site.id}" style="margin-bottom:14px">
  <h3>Sharing</h3>
  <label class="check">
    <input type="checkbox" id="is-public" ${site.is_public ? "checked" : ""}>
    Include this service on the combined public status page
  </label>

  <h3>Direct link to this service</h3>
  ${
    site.public_token
      ? `<div class="share-row">
           <input id="site-url" readonly value="${esc(`/s/${site.public_token}`)}">
           <button class="btn" data-copy="site-url">Copy</button>
           <button class="btn danger" id="revoke-site">Revoke</button>
         </div>`
      : `<p class="muted">Not shared. Creating a link generates an unguessable URL that shows this service's status without a login.</p>
         <button class="btn" id="create-site-link">${I.share} Create share link</button>`
  }
  <p class="muted">Public views never show error details, certificate info, or the monitored URL.</p>
</section>

<section class="panel">
  <h3>Incidents</h3>
  <table class="incidents">
    <thead><tr><th>Started</th><th>Resolved</th><th>Duration</th><th>Cause</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>
<script src="/app.js?v=${ASSET_V}"></script>`, { user }),
    false,
    user,
  );
}

// --- settings ------------------------------------------------------------

const WEBHOOK_LABEL: Record<string, string> = {
  discord: "Discord",
  telegram: "Telegram",
  generic: "Webhook",
};

/**
 * Webhook URLs are credentials — a Discord webhook URL grants posting rights,
 * and a Telegram URL embeds the bot token. Show enough to tell two channels
 * apart, never enough to reuse from a screenshot or a shoulder-surf.
 */
function maskUrl(raw: string) {
  let host: string;
  try {
    host = new URL(raw).host;
  } catch {
    return "••••••";
  }
  // No path segment is ever shown: for Telegram the *first* segment is the bot
  // token, and for Discord the last two are the id and secret. A last-4
  // fingerprint is enough to tell two channels on the same host apart.
  return `${host}/••••${raw.slice(-4)}`;
}

export function settingsPage(opts: {
  user: User;
  webhooks: Webhook[];
  publicTitle: string;
  sslWarnDays: number;
  failuresBeforeDown: number;
  defaultInterval: number;
  defaultTimeout: number;
  siteCount: number;
  publicCount: number;
  /** null for non-admins — invites are instance-wide. */
  invites: Invite[] | null;
  contact: string;
}) {
  const publicToken = opts.user.public_token;

  const fmtDay = (t: number) =>
    new Date(t).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });

  const inviteRows =
    opts.invites
      ?.map((inv) => {
        const expired = inv.expires_at && inv.expires_at < Date.now();
        const status = inv.used_at
          ? `<span class="pill up">used</span>`
          : expired
            ? `<span class="pill down">expired</span>`
            : `<span class="pill pending">unused</span>`;
        return `<tr data-token="${esc(inv.token)}">
      <td class="mono trunc">${esc(inv.token)}</td>
      <td>${esc(inv.note ?? "—")}</td>
      <td>${status}</td>
      <td class="muted nowrap">${
        inv.used_at
          ? `used ${fmtDay(inv.used_at)}`
          : inv.expires_at
            ? `expires ${fmtDay(inv.expires_at)}`
            : "no expiry"
      }</td>
      <td class="right nowrap">
        ${
          inv.used_at
            ? ""
            : `<button class="btn ghost invite-copy" data-token="${esc(inv.token)}">Copy link</button>
               <button class="btn ghost danger invite-revoke" title="Revoke">${I.trash}</button>`
        }
      </td>
    </tr>`;
      })
      .join("") ??
    "";

  const invitesSection = opts.invites
    ? `
<section class="panel" id="invites">
  <h3>Invites</h3>
  <p class="muted">Registration is closed: a new account can only be created with an unused invite code. Send someone a link and they land on the sign-up form with the code already filled in.</p>

  <form id="invite-form" class="add-form">
    <input type="text" name="note" placeholder="Who is this for? (optional)">
    <input type="number" name="days" min="1" max="365" placeholder="Expires in days (optional)">
    <button class="btn primary" type="submit">${I.plus} Generate invite</button>
  </form>

  <table class="settings-table">
    <thead><tr><th>Code</th><th>For</th><th>Status</th><th></th><th></th></tr></thead>
    <tbody id="invite-rows">${
      inviteRows ||
      `<tr><td colspan="5" class="muted">No invites yet. Generate one to let somebody in.</td></tr>`
    }</tbody>
  </table>
  <p class="muted">People without a code are told to email <strong>${esc(opts.contact)}</strong> on the landing page.</p>
</section>`
    : "";
  const hookRows =
    opts.webhooks
      .map(
        (w) => `<tr data-id="${w.id}">
      <td><strong>${esc(WEBHOOK_LABEL[w.type] ?? w.type)}</strong>${
        w.source === "env"
          ? ` <span class="badge" title="Defined by an environment variable">env</span>`
          : ""
      }</td>
      <td class="mono trunc" title="Hidden — webhook URLs are credentials">${esc(maskUrl(w.url))}${w.chat_id ? ` <span class="muted">· chat ${esc(w.chat_id)}</span>` : ""}</td>
      <td>
        <label class="check">
          <input type="checkbox" class="hook-enabled" ${w.enabled ? "checked" : ""}>
          <span class="muted">Enabled</span>
        </label>
      </td>
      <td class="right nowrap">
        <button class="btn ghost hook-test" title="Send a test alert">${I.send} Test</button>
        ${
          w.source === "env"
            ? ""
            : `<button class="btn ghost danger hook-delete" title="Delete">${I.trash}</button>`
        }
      </td>
    </tr>`,
      )
      .join("") ||
    `<tr><td colspan="4" class="muted">No notification channels yet. Add one below and you'll be alerted the moment a service goes down.</td></tr>`;

  return layout(
    "Settings · WebEye",
    shell(`
<div class="sec-head" style="margin-top:0">
  <a class="btn ghost" href="/dashboard">${I.back} Back</a>
  <h2>Settings</h2>
</div>

<section class="panel" id="notifications">
  <h3>Notification channels</h3>
  <p class="muted">Alerts fire when a service changes state — goes down, or recovers — and when a certificate is close to expiring. They are never sent repeatedly while a service stays down.</p>

  <table class="settings-table">
    <thead><tr><th>Type</th><th>Destination</th><th>Status</th><th></th></tr></thead>
    <tbody id="hook-rows">${hookRows}</tbody>
  </table>

  <h3>Add a channel</h3>
  <form id="hook-form" class="add-form">
    <select name="type" id="hook-type">
      <option value="discord">Discord</option>
      <option value="telegram">Telegram</option>
      <option value="generic">Generic webhook</option>
    </select>
    <input type="text" name="url" id="hook-url" placeholder="https://discord.com/api/webhooks/..." required>
    <input type="text" name="chat_id" id="hook-chat" placeholder="Telegram chat ID" hidden>
    <button class="btn primary" type="submit">Add channel</button>
  </form>
  <p class="muted" id="hook-help">Discord: Server Settings → Integrations → Webhooks → New Webhook.</p>
</section>

<section class="panel" id="public">
  <h3>Public status page</h3>
  <p class="muted">${opts.publicCount} of ${opts.siteCount} service${opts.siteCount === 1 ? "" : "s"} ${opts.publicCount === 1 ? "is" : "are"} marked public. Choose which appear from each service's own page.</p>

  <form id="public-form">
    <label class="field">
      <span>Page title</span>
      <input type="text" name="public_page_title" value="${esc(opts.publicTitle)}" placeholder="Service Status">
    </label>
    <button class="btn primary" type="submit">Save title</button>
  </form>

  <h3>Link</h3>
  ${
    publicToken
      ? `<div class="share-row">
           <input id="public-url" readonly value="${esc(`/p/${publicToken}`)}">
           <button class="btn" data-copy="public-url">Copy</button>
           <button class="btn danger" id="revoke-public">Revoke</button>
         </div>
         <p class="muted">Revoking breaks the existing link immediately and issues a new one next time you create it.</p>`
      : `<p class="muted">No public page yet. The link is a long random URL — unguessable, and revocable at any time.</p>
         <button class="btn" id="create-public">${I.share} Create public page</button>`
  }
</section>

<section class="panel" id="monitoring">
  <h3>Monitoring defaults</h3>
  <p class="muted">These apply immediately — no restart needed. Environment variables act as the fallback when a field is left empty.</p>

  <form id="monitoring-form">
    <label class="field">
      <span>Failures before a service is marked down</span>
      <input type="number" name="failures_before_down" min="1" max="10" value="${opts.failuresBeforeDown}">
      <small>Higher values ignore brief blips at the cost of slower alerts.</small>
    </label>
    <label class="field">
      <span>Warn when a certificate has fewer days left than</span>
      <input type="number" name="ssl_warn_days" min="1" max="365" value="${opts.sslWarnDays}">
    </label>
    <label class="field">
      <span>Default check interval for new services (seconds)</span>
      <input type="number" name="default_interval_seconds" min="10" max="86400" value="${opts.defaultInterval}">
    </label>
    <label class="field">
      <span>Default timeout for new services (ms)</span>
      <input type="number" name="default_timeout_ms" min="1000" max="120000" value="${opts.defaultTimeout}">
    </label>
    <button class="btn primary" type="submit">Save settings</button>
  </form>
</section>

${invitesSection}

<section class="panel" id="access">
  <h3>Access</h3>
  <p>Signed in as <strong>${esc(opts.user.email)}</strong>${opts.user.is_admin ? ` · <span class="badge">admin</span>` : ""}</p>
  <p class="muted">Your services, notification channels and status page belong to this account. Nobody else signed in to this instance can see them.</p>
  <a class="btn" href="/logout">Log out</a>
</section>

<footer class="foot"><span>WebEye by Obhox · <a href="https://github.com/obhox/webeye" target="_blank" rel="noopener noreferrer">Documentation &amp; source</a></span></footer>
<script src="/app.js?v=${ASSET_V}"></script>`, { user: opts.user }),
    false,
    opts.user,
  );
}

// --- public status page --------------------------------------------------

/**
 * Public status page — served without authentication to anyone holding the
 * token. Renders through `card(s, true)`, so error text, certificate details,
 * target URLs and admin links never reach a visitor. Incident rows show timing
 * only; the `cause` column is deliberately omitted.
 */
export function publicPage(
  title: string,
  statuses: SiteStatus[],
  endpoint: string,
  incidents?: { started_at: number; resolved_at: number | null }[],
) {
  const down = statuses.filter((s) => s.state === "down").length;
  const degraded = statuses.filter((s) => s.state === "degraded").length;

  const headline = down
    ? `${down} service${down > 1 ? "s" : ""} down`
    : degraded
      ? "Partial degradation"
      : "All systems operational";

  // The h1 already states the overall state — this line adds scope, not an echo.
  const subline = `${statuses.length} service${statuses.length === 1 ? "" : "s"} monitored${
    degraded ? ` · <span class="sum warn">${degraded} degraded</span>` : ""
  }`;

  const fmt = (t: number) => new Date(t).toLocaleString();

  const incidentSection = incidents
    ? `<div class="sec-head"><h2>Recent incidents</h2></div>
<section class="panel">
  <table class="incidents">
    <thead><tr><th>Started</th><th>Resolved</th><th>Duration</th></tr></thead>
    <tbody>${
      incidents
        .map(
          (i) => `<tr>
      <td>${fmt(i.started_at)}</td>
      <td>${i.resolved_at ? fmt(i.resolved_at) : `<span class="pill down">ongoing</span>`}</td>
      <td>${dur((i.resolved_at ?? Date.now()) - i.started_at)}</td>
    </tr>`,
        )
        .join("") ||
      `<tr><td colspan="3" class="muted">No incidents recorded.</td></tr>`
    }</tbody>
  </table>
</section>`
    : "";

  return layout(
    title,
    shell(
      `
<section class="hero">
  <div class="hero-pill">${I.logo} ${esc(title)}</div>
  <h1>${esc(headline)}</h1>
  <p class="muted" style="margin-top:-14px">${subline}</p>
</section>

<main id="grid" class="grid" data-endpoint="${esc(endpoint)}">
  ${statuses.map((s) => card(s, true)).join("") || `<p class="empty-state">No services are being published yet.</p>`}
</main>
${incidentSection}
<footer class="foot">
  Auto-refreshes every 15s · <span id="stamp"></span>
  <span class="powered">Powered by <a href="https://github.com/obhox/webeye" target="_blank" rel="noopener noreferrer">WebEye</a></span>
</footer>
<script src="/app.js?v=${ASSET_V}"></script>`,
      { chrome: false },
    ),
    true, // noindex — a shared link shouldn't end up in search results
  );
}

// --- landing -------------------------------------------------------------

/**
 * Blueprint-style hero.
 *
 * Desktop draws a fixed 1600×900 "drafting canvas": annotations are absolutely
 * positioned in that coordinate space and an SVG overlay of the same viewBox
 * draws the elbow connectors, so labels and lines can never drift apart at any
 * width. Below 900px the canvas collapses to a normal stacked flow and the
 * connectors are dropped — leader lines to nothing would be noise on a phone.
 */
/**
 * Statement panels behind the landing page's callouts and thread list.
 *
 * `{{chip}}` tokens are replaced with inline boxed glyphs so the big type gets
 * the same punctuation-by-object feel as the reference layout.
 */
const CHIPS: Record<string, string> = {
  grid: `<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="1" y="1" width="38" height="38"/><rect x="7" y="7" width="26" height="26"/><rect x="13" y="13" width="14" height="14"/><rect x="17.5" y="17.5" width="5" height="5"/><path d="M1 1 13 13M39 1 27 13M1 39 13 27M39 39 27 27"/></svg>`,
  spark: `<svg viewBox="0 0 40 40" aria-hidden="true" class="solid"><path d="M20 0l4.2 12.6L36 8l-6.8 10.8L40 20l-10.8 4.2L36 32l-11.8-4.6L20 40l-4.2-12.6L4 32l6.8-10.8L0 20l10.8-4.2L4 8l11.8 4.6z"/></svg>`,
  pulse: `<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="1" y="1" width="38" height="38"/><path d="M6 20h6l4 10 6-20 4 10h8"/></svg>`,
};

const TOPICS = [
  {
    id: "uptime",
    num: "01",
    label: "UPTIME & RESPONSE TIME",
    statement:
      "Uptime {{grid}} isn’t a number you publish — it’s something you measure, one check at a time.",
    note: "EVERY CHECK IS RECORDED. THE 24H, 7D AND 30D FIGURES ARE READ BACK FROM THAT RECORD, NEVER ESTIMATED.",
  },
  {
    id: "process",
    num: "02",
    label: "ONE SMALL PROCESS",
    statement:
      "Watching fifty services {{pulse}} shouldn’t cost more than running one of them.",
    note: "A SINGLE 1S TICK SCHEDULES EVERY CHECK THROUGH A CONCURRENCY LIMIT. ONE PROCESS, ONE SQLITE FILE, NO QUEUE.",
  },
  {
    id: "ssl",
    num: "03",
    label: "SSL CERTIFICATE EXPIRY",
    statement:
      "A certificate {{grid}} will not warn you before it expires. That is the job of something that is watching.",
    note: "CERTIFICATES ARE CHECKED DAILY AND WARNED ON WEEKS BEFORE THEY LAPSE — NOT ON THE MORNING THEY DO.",
  },
  {
    id: "incidents",
    num: "04",
    label: "INCIDENTS & UPTIME %",
    statement:
      "An outage {{spark}} you can’t describe afterwards is an outage you can’t prevent.",
    note: "STATE CHANGES OPEN AND CLOSE INCIDENTS. CAUSE AND DURATION ARE KEPT, SO THE HISTORY ANSWERS FOR ITSELF.",
  },
  {
    id: "status",
    num: "05",
    label: "PUBLIC STATUS PAGES",
    statement:
      "Trust {{grid}} isn’t claimed. It’s shown, continuously, to anyone who asks.",
    note: "PUBLISH A STATUS PAGE ON AN UNGUESSABLE LINK. VISITORS SEE STATE AND UPTIME — NEVER YOUR ERRORS OR URLS.",
  },
];

const renderStatement = (s: string) =>
  esc(s).replace(
    /\{\{(\w+)\}\}/g,
    (_, k: string) => `<i class="rv-chip">${CHIPS[k] ?? ""}</i>`,
  );

export function landingPage(opts: {
  signedIn: boolean;
  /** True only until the first account claims the instance. */
  open: boolean;
  contact: string;
}) {
  const mailto = `mailto:${encodeURIComponent(opts.contact)}?subject=${encodeURIComponent(
    "WebEye access request",
  )}&body=${encodeURIComponent(
    "Hi Joy,\n\nI'd like an invite to WebEye.\n\nWhat I want to monitor:\n",
  )}`;

  const cta = opts.signedIn
    ? `<a class="bp-btn solid" href="/dashboard">OPEN DASHBOARD</a>`
    : opts.open
      ? `<a class="bp-btn solid" href="/signup">CLAIM THIS INSTANCE</a>
         <a class="bp-btn" href="/login">SIGN IN</a>`
      : `<a class="bp-btn solid" href="${esc(mailto)}">REQUEST ACCESS</a>
         <a class="bp-btn" href="/login">SIGN IN</a>`;

  /**
   * Coordinates live in the canvas's 1600×900 space.
   *
   * `anchor` is where the leader line terminates. The label is then pinned to
   * that point and vertically centred on it (`translateY(-50%)` in CSS) rather
   * than positioned by its top edge — so the line always meets the middle of
   * the label's left/right edge and can never cut through the text, at any
   * viewport width or font size.
   */
  const annotations: {
    node: [number, number];
    anchor: [number, number];
    side: "left" | "right";
    text?: string;
    topic?: string;
  }[] = [
    {
      node: [1015, 255],
      anchor: [1215, 120],
      side: "left",
      text: "EVERY CHECK RECORDED,<br>SO UPTIME IS MEASURED<br>NOT GUESSED",
      topic: "uptime",
    },
    {
      node: [575, 430],
      anchor: [385, 300],
      side: "right",
      text: "FROM ONE SMALL PROCESS,<br>FIFTY SERVICES WATCHED<br>AT ONCE",
      topic: "process",
    },
    // Leader for the etymology card, which is positioned by CSS on the right.
    { node: [1105, 545], anchor: [1245, 400], side: "left" },
    {
      node: [800, 795],
      anchor: [1040, 855],
      side: "left",
      text: "CERTIFICATES CHECKED DAILY,<br>WARNED WEEKS BEFORE<br>THEY LAPSE",
      topic: "ssl",
    },
  ];

  const connectors = annotations
    .map(({ node, anchor, side }) => {
      const dir = side === "left" ? 1 : -1;
      const jogStart = node[0] + 70 * dir;
      const jogEnd = node[0] + 150 * dir;
      return `<polyline points="${node[0]},${node[1]} ${jogStart},${node[1]} ${jogEnd},${anchor[1]} ${anchor[0]},${anchor[1]}"/>`;
    })
    .join("");

  const nodes = annotations
    .map(
      ({ node }) =>
        `<rect x="${node[0] - 11}" y="${node[1] - 11}" width="22" height="22" class="bp-node"/>
         <rect x="${node[0] - 4}" y="${node[1] - 4}" width="8" height="8" class="bp-node-fill"/>`,
    )
    .join("");

  const textAnnos = annotations
    .filter((a) => a.text)
    .map((a) => {
      const yPct = (a.anchor[1] / 900) * 100;
      const pos =
        a.side === "left"
          ? `left:${(a.anchor[0] / 1600) * 100}%`
          : `right:${100 - (a.anchor[0] / 1600) * 100}%`;
      const topic = a.topic ? ` data-topic="${a.topic}"` : "";
      return `<button type="button" class="bp-anno ${a.side === "right" ? "to-right" : ""}" style="${pos}; top:${yPct}%"${topic}>${a.text}</button>`;
    })
    .join("");

  return layout(
    "WebEye — Simple open-source website monitoring",
    `<div class="bp">
  <header class="bp-top">
    <span class="bp-brand">WEBEYE</span>
    <span class="bp-pill">${I.logo} SELF-HOSTED UPTIME</span>
    <span class="bp-time">
      <small>LOCAL TIME</small>
      <b id="bp-clock">--:--:--</b>
    </span>
    <a class="bp-icon" href="${REPO_URL}" target="_blank" rel="noopener noreferrer"
       title="View source on GitHub" aria-label="View source on GitHub">${I.github}</a>
    ${themeButton()}
  </header>

  <h1 class="bp-h1">UPTIME,<br>BY DESIGN.</h1>

  <div class="bp-canvas">
    <svg class="bp-lines" viewBox="0 0 1600 900" preserveAspectRatio="none" aria-hidden="true">
      ${connectors}
    </svg>
    <svg class="bp-marks" viewBox="0 0 1600 900" aria-hidden="true">
      ${nodes}
    </svg>

    <!-- The object under inspection: a rotating halftone Earth on a plinth of
         uptime bars. The globe is drawn on canvas from a locally baked land
         dataset — see public/app.js and tools/build-globe.ts. -->
    <figure class="bp-object">
      <canvas id="globe" class="bp-globe-canvas"
              aria-label="Rotating globe showing monitored regions"></canvas>
      <svg class="bp-bars-svg" viewBox="0 0 600 56" preserveAspectRatio="none" aria-hidden="true">
        ${[...Array(34)]
          .map((_, i) => {
            // Deterministic pattern — no RNG, so markup is identical each render.
            const h = 14 + ((i * 37) % 42);
            const down = i === 9 || i === 23;
            return `<rect x="${58 + i * 14}" y="${52 - h}" width="7" height="${h}" class="${down ? "bar-down" : "bar-up"}"/>`;
          })
          .join("")}
      </svg>
      <figcaption class="bp-obj-caption">
        <span>30-DAY HISTORY</span>
        <span class="bp-hint">DRAG TO ROTATE</span>
        <span>99.97%</span>
      </figcaption>
    </figure>

    ${textAnnos}

    <aside class="bp-card bp-etym">
      <header><b>WEBEYE</b><small>/01</small></header>
      <p>WEB (THE INTERNET)<br>+ EYE (TO WATCH)</p>
      <p>→ WATCHING THE WEB</p>
    </aside>
  </div>

  <section class="bp-foot">
    <div class="bp-threads">
      <h2>[ WHAT IT WATCHES ]</h2>
      <ol>
        ${TOPICS.map(
          (t) => `<li><button type="button" class="thread" data-topic="${t.id}">
          <span>${t.num}.</span><span class="thread-label">${esc(t.label)}</span>
          <span class="thread-go">${I.chevron}</span>
        </button></li>`,
        ).join("")}
      </ol>
    </div>

    <aside class="bp-card bp-note">
      <header><b>NOT A SAAS — YOUR SERVER</b></header>
      <p>WebEye is open source and runs as a single container with one SQLite
      file. No queue, no cluster, no per-monitor pricing.</p>
      <p>${
        opts.open
          ? "Nobody has claimed this instance yet — the first account created becomes its admin."
          : `Accounts on this instance are invite-only. Email <a href="${esc(mailto)}">${esc(opts.contact)}</a> and you'll get a code.`
      }</p>
      <div class="bp-actions">
        ${cta}
        <a class="bp-btn" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">${I.github} GITHUB</a>
      </div>
      <p class="bp-meta">${
        opts.open
          ? "NO ACCOUNTS YET — THE FIRST SIGNUP CLAIMS THIS INSTANCE"
          : `BY INVITATION — <a href="${esc(mailto)}">${esc(opts.contact.toUpperCase())}</a>`
      }</p>
    </aside>
  </section>
</div>

<!-- Statement overlay. Rendered once and filled by JS from the payload below,
     so opening a topic never leaves the page — this stays a one-pager. -->
<div class="rv" id="rv" hidden>
  <div class="rv-sheet" role="dialog" aria-modal="true" aria-labelledby="rv-statement">
    <header class="rv-top">
      <span class="bp-brand">WEBEYE</span>
      <span class="bp-pill" id="rv-pill"></span>
      <button type="button" class="rv-close" id="rv-close" aria-label="Close">
        <span>CLOSE</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>
      </button>
    </header>

    <div class="rv-body">
      <h2 class="rv-statement" id="rv-statement"></h2>
      <aside class="bp-card rv-note">
        <header><b id="rv-note-label"></b><small id="rv-note-num"></small></header>
        <p id="rv-note-text"></p>
      </aside>
    </div>

    <nav class="rv-nav">
      <button type="button" id="rv-prev" class="bp-btn">← PREV</button>
      <span class="rv-count"><b id="rv-index"></b> / ${TOPICS.length}</span>
      <button type="button" id="rv-next" class="bp-btn">NEXT →</button>
    </nav>
  </div>
</div>

<script type="application/json" id="rv-data">${JSON.stringify(
      TOPICS.map((t) => ({
        id: t.id,
        num: t.num,
        label: t.label,
        statement: renderStatement(t.statement),
        note: t.note,
      })),
      // `<` would otherwise let a "</script>" inside the data close this tag early.
    ).replace(/</g, "\\u003c")}</script>
<script src="/app.js?v=${ASSET_V}"></script>`,
  );
}

// --- signup / login ------------------------------------------------------

export function authPage(
  mode: "login" | "signup",
  opts: {
    error?: string;
    email?: string;
    name?: string;
    invite?: string;
    needsInvite?: boolean;
  } = {},
) {
  const isSignup = mode === "signup";
  const needsInvite = isSignup && opts.needsInvite !== false;

  return layout(
    isSignup ? "Create account · WebEye" : "Sign in · WebEye",
    `${themeButton(true)}
<div class="auth-wrap">
  <a class="auth-brand" href="/">${I.logo} WEBEYE</a>

  <div class="auth-card">
    <header class="auth-head">
      <b>${isSignup ? "CREATE ACCOUNT" : "SIGN IN"}</b>
      <small>${isSignup ? "/NEW" : "/RETURN"}</small>
    </header>

    ${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ""}

    <form method="post" action="${isSignup ? "/signup" : "/login"}" class="auth-form">
      ${
        needsInvite
          ? `<label class="field"><span>INVITE CODE</span>
        <input type="text" name="invite" class="mono" value="${esc(opts.invite ?? "")}" required
               autocomplete="off" spellcheck="false"
               ${opts.invite ? "" : "autofocus"}></label>`
          : ""
      }
      ${
        isSignup
          ? `<label class="field"><span>NAME (OPTIONAL)</span>
        <input type="text" name="name" value="${esc(opts.name ?? "")}" autocomplete="name"></label>`
          : ""
      }
      <label class="field"><span>EMAIL</span>
        <input type="email" name="email" value="${esc(opts.email ?? "")}" required autocomplete="email"
               ${needsInvite ? "" : "autofocus"}></label>
      <label class="field"><span>PASSWORD</span>
        <input type="password" name="password" required minlength="8"
               autocomplete="${isSignup ? "new-password" : "current-password"}"></label>
      ${isSignup ? `<p class="auth-hint">Minimum 8 characters.</p>` : ""}
      <button class="btn primary auth-submit" type="submit">
        ${isSignup ? "CREATE ACCOUNT" : "SIGN IN"}
      </button>
    </form>
  </div>

  <p class="auth-alt">
    ${
      isSignup
        ? `Already have an account? <a href="/login">Sign in</a>`
        : `No account yet? <a href="/signup">Create one</a>`
    }
  </p>
</div>
<script src="/app.js?v=${ASSET_V}"></script>`,
  );
}

