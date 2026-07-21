import {
  allSites,
  siteOwner,
  openIncident,
  recordCheck,
  resolveIncident,
  rollupAndPrune,
  startIncident,
  now,
  userTunable,
  type Site,
} from "./db";
import { notify } from "./notify";

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10);

/**
 * Editable in Settings per account, so it is read per-check rather than
 * captured at boot.
 */
const failuresBeforeDown = (userId: number | null) =>
  userTunable(userId, "failures_before_down", "FAILURES_BEFORE_DOWN", 2);
const USER_AGENT = "WebEye/1.0 (+https://github.com/obhox/webeye)";

export type SiteState = "up" | "degraded" | "down" | "pending";

type State = {
  nextRunAt: number;
  consecutiveFailures: number;
  /**
   * Confirmed-down flag, used for alerting only. Requires FAILURES_BEFORE_DOWN
   * consecutive failures to become true, so a single blip never pages anyone.
   * null until the first check completes, so we never alert on boot.
   */
  isDown: boolean | null;
  /** Result of the most recent check — drives the *displayed* state. */
  lastOk: boolean | null;
  running: boolean;
};

const states = new Map<number, State>();
let inFlight = 0;

type Result = {
  ok: boolean;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
};

export async function runCheck(site: Site): Promise<Result> {
  const started = performance.now();
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    ...(site.headers_json ? JSON.parse(site.headers_json) : {}),
  };

  try {
    const res = await fetch(site.url, {
      method: site.method,
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(site.timeout_ms),
    });

    // Read the body only when a keyword assertion needs it.
    const body = site.keyword ? await res.text() : null;
    const latency_ms = Math.round(performance.now() - started);

    if (res.status !== site.expected_status) {
      return {
        ok: false,
        status_code: res.status,
        latency_ms,
        error: `expected HTTP ${site.expected_status}, got ${res.status}`,
      };
    }
    if (site.keyword && !body!.includes(site.keyword)) {
      return {
        ok: false,
        status_code: res.status,
        latency_ms,
        error: `keyword "${site.keyword}" not found in response`,
      };
    }
    return { ok: true, status_code: res.status, latency_ms, error: null };
  } catch (err: any) {
    const latency_ms = Math.round(performance.now() - started);
    const error =
      err?.name === "TimeoutError" || err?.name === "AbortError"
        ? `timed out after ${site.timeout_ms}ms`
        : String(err?.message ?? err);
    return { ok: false, status_code: null, latency_ms, error };
  }
}

async function checkAndRecord(site: Site, state: State) {
  const owner = site.user_id;
  const result = await runCheck(site);
  recordCheck({ site_id: site.id, ...result });
  state.lastOk = result.ok;

  if (result.ok) {
    state.consecutiveFailures = 0;
    // UP transition: close the incident and say so. `isDown === null` means
    // this is the first result since boot, which is not a recovery.
    if (state.isDown === true) {
      const incident = openIncident(site.id);
      resolveIncident(site.id);
      notify(owner, {
        kind: "up",
        site: site.name,
        url: site.url,
        downForMs: incident ? now() - incident.started_at : 0,
      });
    }
    state.isDown = false;
  } else {
    state.consecutiveFailures++;
    // Only a sustained failure counts as DOWN — a single blip is noise.
    if (state.consecutiveFailures >= failuresBeforeDown(owner) && !state.isDown) {
      startIncident(site.id, result.error ?? "check failed");
      notify(owner, {
        kind: "down",
        site: site.name,
        url: site.url,
        cause: result.error ?? "check failed",
      });
      state.isDown = true;
    } else if (state.isDown === null) {
      // Failing, but not yet confirmed down — surfaces as "degraded", never "up".
      state.isDown = false;
    }
  }
}

function tick() {
  const t = now();
  const sites = allSites();
  const live = new Set<number>();

  for (const site of sites) {
    live.add(site.id);
    if (!site.enabled) continue;

    let state = states.get(site.id);
    if (!state) {
      // Restore down-state from an unresolved incident so a restart mid-outage
      // doesn't fire a duplicate DOWN alert or a phantom recovery.
      const open = openIncident(site.id);
      state = {
        nextRunAt: 0,
        consecutiveFailures: open ? failuresBeforeDown(site.user_id) : 0,
        isDown: open ? true : null,
        lastOk: open ? false : null,
        running: false,
      };
      states.set(site.id, state);
    }

    if (state.running || t < state.nextRunAt) continue;
    if (inFlight >= CONCURRENCY) continue;

    state.running = true;
    state.nextRunAt = t + site.interval_seconds * 1000;
    inFlight++;

    checkAndRecord(site, state)
      .catch((e) => console.error(`[monitor] ${site.name}:`, e))
      .finally(() => {
        state!.running = false;
        inFlight--;
      });
  }

  for (const id of states.keys()) if (!live.has(id)) states.delete(id);
}

/** Force a site's next check to happen on the next tick. */
export function checkNow(siteId: number) {
  const state = states.get(siteId);
  if (state) state.nextRunAt = 0;
}

/**
 * Displayed state. Kept separate from the alerting flag: a site whose latest
 * check failed reads as "degraded" immediately, even though it takes
 * FAILURES_BEFORE_DOWN failures before it is confirmed "down" and alerts fire.
 */
export function siteState(siteId: number): SiteState {
  const s = states.get(siteId);
  if (!s || s.lastOk === null) return "pending";
  if (s.isDown) return "down";
  return s.lastOk ? "up" : "degraded";
}

export function startMonitor() {
  rollupAndPrune();
  setInterval(tick, 1000);
  setInterval(rollupAndPrune, 3_600_000);
  console.log(
    `[monitor] scheduler started (concurrency ${CONCURRENCY}, ${failuresBeforeDown(null)} failures before DOWN)`,
  );
}
