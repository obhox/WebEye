// Refresh strategy: the server already renders cards, so the client just swaps
// in a freshly rendered fragment. No client-side templating, no diffing library.
const grid = document.getElementById("grid");
const stamp = document.getElementById("stamp");
const BASE_TITLE = document.title.replace(/^\(\d+ down\)\s*/, "");

async function refresh() {
  if (!grid || document.hidden) return;
  // Public pages poll their own token-scoped endpoint, private ones /api/grid.
  const endpoint = grid.dataset.endpoint;
  if (!endpoint) return;
  try {
    const res = await fetch(endpoint, { headers: { accept: "text/html" } });
    if (!res.ok) return;
    const { html, down } = await res.json();
    grid.innerHTML = html;
    applyFilter(); // the grid was just replaced — re-apply the active search
    const sum = document.querySelector(".sum");
    if (sum) {
      sum.className = "sum " + (down ? "bad" : "ok");
      sum.textContent = down ? `${down} down` : "All systems operational";
    }
    // BASE_TITLE is captured at load so public pages keep their own name.
    document.title = down ? `(${down} down) ${BASE_TITLE}` : BASE_TITLE;
    if (stamp) stamp.textContent = "updated " + new Date().toLocaleTimeString();
  } catch {
    /* transient network error — the next tick will catch up */
  }
}

// --- landing statement overlay ---
// Opening a topic fills the viewport without navigating, so the landing page
// stays a single page.

const rv = document.getElementById("rv");
if (rv) initStatements();

function initStatements() {
  const topics = JSON.parse(document.getElementById("rv-data").textContent);
  const sheet = rv.querySelector(".rv-sheet");
  const el = {
    pill: document.getElementById("rv-pill"),
    statement: document.getElementById("rv-statement"),
    label: document.getElementById("rv-note-label"),
    num: document.getElementById("rv-note-num"),
    note: document.getElementById("rv-note-text"),
    index: document.getElementById("rv-index"),
  };

  let current = 0;
  let opener = null;

  function show(i) {
    current = (i + topics.length) % topics.length;
    const t = topics[current];
    el.pill.textContent = `${t.label} /${t.num}`;
    el.statement.innerHTML = t.statement; // server-escaped, chips are ours
    el.label.textContent = t.label;
    el.num.textContent = `/${t.num}`;
    el.note.textContent = t.note;
    el.index.textContent = t.num;
    // Restart the entrance animation on every change.
    sheet.classList.remove("in");
    void sheet.offsetWidth;
    sheet.classList.add("in");
  }

  function open(id, trigger) {
    const i = topics.findIndex((t) => t.id === id);
    if (i < 0) return;
    opener = trigger ?? null;
    show(i);
    rv.hidden = false;
    document.body.classList.add("rv-open"); // lock background scroll
    document.getElementById("rv-close").focus();
  }

  function close() {
    rv.hidden = true;
    document.body.classList.remove("rv-open");
    opener?.focus(); // return focus where the reader left it
    opener = null;
  }

  document.querySelectorAll("[data-topic]").forEach((btn) => {
    btn.addEventListener("click", () => open(btn.dataset.topic, btn));
  });

  document.getElementById("rv-close").addEventListener("click", close);
  document.getElementById("rv-prev").addEventListener("click", () => show(current - 1));
  document.getElementById("rv-next").addEventListener("click", () => show(current + 1));

  // No backdrop-click here on purpose: the sheet fills the viewport, so there
  // is no margin to click. Close is the button or Escape.
  document.addEventListener("keydown", (e) => {
    if (rv.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowRight") {
      show(current + 1);
    } else if (e.key === "ArrowLeft") {
      show(current - 1);
    } else if (e.key === "Tab") {
      // Keep focus inside the dialog while it is open.
      const focusable = rv.querySelectorAll("button, [href]");
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}

// --- landing globe ---
// Orthographic projection by hand: the maths is ~10 lines, so pulling in d3-geo
// (and a runtime fetch of Natural Earth GeoJSON from GitHub) would cost far more
// than it saves. Land outlines and the halftone dot grid are baked into
// /globe.json by tools/build-globe.ts.

const globeCanvas = document.getElementById("globe");
if (globeCanvas) initGlobe(globeCanvas);

async function initGlobe(canvas) {
  const ctx = canvas.getContext("2d");
  const RAD = Math.PI / 180;

  let data;
  try {
    data = await fetch("/globe.json").then((r) => r.json());
  } catch {
    canvas.remove(); // the page reads fine without it
    return;
  }

  const decode = (b64) => {
    const bin = atob(b64);
    const buf = new ArrayBuffer(bin.length);
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Int16Array(buf);
  };

  /** lng/lat pairs (deg x100) -> unit vectors, so each frame is pure multiply. */
  const toVectors = (i16) => {
    const n = i16.length / 2;
    const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lng = (i16[i * 2] / 100) * RAD;
      const lat = (i16[i * 2 + 1] / 100) * RAD;
      const c = Math.cos(lat);
      x[i] = c * Math.cos(lng);
      y[i] = c * Math.sin(lng);
      z[i] = Math.sin(lat);
    }
    return { x, y, z, n };
  };

  const dots = toVectors(decode(data.dots));
  const rings = data.outlines.map((b) => toVectors(decode(b)));

  // Graticule: meridians every 30°, parallels every 30°.
  const graticule = [];
  for (let lng = -180; lng < 180; lng += 30) {
    const pts = [];
    for (let lat = -90; lat <= 90; lat += 3) pts.push(lng * 100, lat * 100);
    graticule.push(toVectors(Int16Array.from(pts)));
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const pts = [];
    for (let lng = -180; lng <= 180; lng += 3) pts.push(lng * 100, lat * 100);
    graticule.push(toVectors(Int16Array.from(pts)));
  }

  let W = 0, H = 0, R = 0, cx = 0, cy = 0, zoom = 1;
  let yaw = 2.6, pitch = -0.18;
  let colors = { sea: "#111", line: "#fff", dot: "#9a9a9a" };

  const readColors = () => {
    const s = getComputedStyle(canvas);
    colors = {
      sea: s.getPropertyValue("--globe-sea").trim() || "#111",
      line: s.getPropertyValue("--globe-line").trim() || "#fff",
      dot: s.getPropertyValue("--globe-dot").trim() || "#9a9a9a",
    };
  };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = rect.width;
    H = rect.width; // square
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = W / 2;
    cy = H / 2;
    R = (Math.min(W, H) / 2) * 0.92;
    readColors();
  }

  /** Draws a polyline, breaking it wherever it passes behind the limb. */
  function strokePath(set, cyaw, syaw, cpit, spit, r) {
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < set.n; i++) {
      const x0 = set.x[i], y0 = set.y[i], z0 = set.z[i];
      const x1 = x0 * cyaw + y0 * syaw;
      const y1 = -x0 * syaw + y0 * cyaw;
      const x2 = x1 * cpit + z0 * spit;
      if (x2 <= 0) { pen = false; continue; }
      const z2 = -x1 * spit + z0 * cpit;
      const px = cx + r * y1;
      const py = cy - r * z2;
      if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      pen = true;
    }
    ctx.stroke();
  }

  function draw() {
    if (!W) return;
    const cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
    const cpit = Math.cos(pitch), spit = Math.sin(pitch);
    const r = R * zoom;

    ctx.clearRect(0, 0, W, H);

    // ocean disc
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = colors.sea;
    ctx.fill();
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // graticule
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();

    ctx.strokeStyle = colors.line;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 1;
    for (const g of graticule) strokePath(g, cyaw, syaw, cpit, spit, r);

    // land outlines
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1;
    for (const ring of rings) strokePath(ring, cyaw, syaw, cpit, spit, r);
    ctx.globalAlpha = 1;

    // halftone land fill — one path, one fill
    const size = Math.max(1, r * 0.0075);
    ctx.beginPath();
    for (let i = 0; i < dots.n; i++) {
      const x0 = dots.x[i], y0 = dots.y[i], z0 = dots.z[i];
      const x1 = x0 * cyaw + y0 * syaw;
      const x2 = x1 * cpit + z0 * spit;
      if (x2 <= 0.02) continue;
      const y1 = -x0 * syaw + y0 * cyaw;
      const z2 = -x1 * spit + z0 * cpit;
      ctx.rect(cx + r * y1 - size, cy - r * z2 - size, size * 2, size * 2);
    }
    ctx.fillStyle = colors.dot;
    ctx.fill();
    ctx.restore();
  }

  // --- motion ---
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let spinning = !reduced.matches;
  let last = performance.now();

  function frame(now) {
    const dt = Math.min(now - last, 100);
    last = now;
    if (spinning) yaw += dt * 0.00011;
    draw();
    requestAnimationFrame(frame);
  }

  // --- drag to rotate (mouse only: hijacking touch would break page scroll) ---
  let dragging = false, lastX = 0, lastY = 0, resume;

  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse") return;
    dragging = true;
    spinning = false;
    clearTimeout(resume);
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    yaw += (e.clientX - lastX) * 0.006;
    pitch = Math.max(-1.2, Math.min(1.2, pitch + (e.clientY - lastY) * 0.006));
    lastX = e.clientX;
    lastY = e.clientY;
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    if (!reduced.matches) resume = setTimeout(() => (spinning = true), 1200);
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // Wheel zoom, but only inside the drawn disc — over the rest of the canvas the
  // page keeps scrolling, so the globe can't trap the reader mid-page.
  canvas.addEventListener(
    "wheel",
    (e) => {
      const rect = canvas.getBoundingClientRect();
      const dx = e.clientX - (rect.left + W / 2);
      const dy = e.clientY - (rect.top + H / 2);
      if (Math.hypot(dx, dy) > R * zoom) return;
      e.preventDefault();
      zoom = Math.max(0.7, Math.min(2.2, zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
    },
    { passive: false },
  );

  new ResizeObserver(resize).observe(canvas);
  new MutationObserver(readColors).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  resize();
  requestAnimationFrame(frame);
}

// --- landing clock ---
const clock = document.getElementById("bp-clock");
if (clock) {
  const tick = () =>
    (clock.textContent = new Date().toLocaleTimeString(undefined, {
      hour12: false,
    }));
  tick();
  setInterval(tick, 1000);
}

// --- theme toggle ---
// The inline head script already resolved and applied the theme before paint;
// this only handles clicks and keeps the OS in sync when nothing was chosen.
const root = document.documentElement;

document.getElementById("theme-btn")?.addEventListener("click", () => {
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try {
    localStorage.setItem("webeye-theme", next);
  } catch {
    /* private mode — the theme still applies for this page view */
  }
});

// Follow the OS if the visitor has never picked a theme explicitly.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  let stored = null;
  try {
    stored = localStorage.getItem("webeye-theme");
  } catch {}
  if (stored !== "light" && stored !== "dark") {
    root.dataset.theme = e.matches ? "dark" : "light";
  }
});

// --- search filter ---
const filterInput = document.getElementById("filter");

function applyFilter() {
  const q = (filterInput?.value ?? "").trim().toLowerCase();
  let shown = 0;
  grid?.querySelectorAll(".card").forEach((c) => {
    const hit =
      !q ||
      (c.dataset.name ?? "").includes(q) ||
      (c.dataset.url ?? "").includes(q);
    c.hidden = !hit;
    if (hit) shown++;
  });

  let none = document.getElementById("no-match");
  if (q && shown === 0) {
    if (!none) {
      none = document.createElement("p");
      none.id = "no-match";
      none.className = "empty-state";
      grid.appendChild(none);
    }
    none.textContent = `No services match "${q}".`;
  } else none?.remove();
}

// --- search dropdown ---
// Built from the rendered cards rather than a second copy of the data, so the
// list can never disagree with the grid it describes.
const results = document.getElementById("search-results");
let activeIndex = -1;

function services() {
  return [...(grid?.querySelectorAll(".card") ?? [])].map((c) => ({
    id: c.dataset.id,
    name: c.querySelector("h2")?.textContent.trim() ?? "",
    url: c.dataset.url ?? "",
    state: [...c.classList].find((k) =>
      ["up", "down", "degraded", "pending", "paused"].includes(k),
    ),
    meta: c.querySelector(".metrics dd")?.textContent.trim() ?? "",
  }));
}

function renderResults() {
  if (!results) return;
  const q = (filterInput?.value ?? "").trim().toLowerCase();
  const matches = services().filter(
    (s) => !q || s.name.toLowerCase().includes(q) || s.url.includes(q),
  );

  activeIndex = -1;
  results.innerHTML = matches.length
    ? matches
        .map(
          (s, i) =>
            `<a class="sr-row" role="option" data-i="${i}" href="/site/${s.id}">
        <span class="dot ${s.state}"></span>
        <span class="label">${s.name}</span>
        <span class="meta">${s.meta}</span>
      </a>`,
        )
        .join("")
    : `<div class="sr-row empty">No services match “${q.replace(/[<>&]/g, "")}”</div>`;

  results.hidden = false;
  filterInput?.setAttribute("aria-expanded", "true");
}

function closeResults() {
  if (!results) return;
  results.hidden = true;
  activeIndex = -1;
  filterInput?.setAttribute("aria-expanded", "false");
}

function moveActive(step) {
  const rows = [...results.querySelectorAll(".sr-row:not(.empty)")];
  if (!rows.length) return;
  activeIndex = (activeIndex + step + rows.length) % rows.length;
  rows.forEach((r, i) => r.classList.toggle("on", i === activeIndex));
  rows[activeIndex].scrollIntoView({ block: "nearest" });
}

// Focusing the box — by click or by "/" — lists every service straight away.
filterInput?.addEventListener("focus", renderResults);
filterInput?.addEventListener("input", () => {
  applyFilter();
  renderResults();
});

filterInput?.addEventListener("keydown", (e) => {
  if (results?.hidden && ["ArrowDown", "ArrowUp"].includes(e.key)) {
    renderResults();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    moveActive(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveActive(-1);
  } else if (e.key === "Enter") {
    const row = results?.querySelector(".sr-row.on");
    if (row) {
      e.preventDefault();
      location.href = row.href;
    }
  }
});

// A click on a result must land before blur hides the list.
filterInput?.addEventListener("blur", () => setTimeout(closeResults, 150));

/**
 * True when the keystroke landed in something editable — a "/" typed into a
 * URL field is a slash, not a shortcut. Checks the event's own target rather
 * than document.activeElement so it reflects where the key actually went.
 */
function isTyping(target) {
  const el = target || document.activeElement;
  if (!el || !el.tagName) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable === true
  );
}

// "/" focuses search, Escape closes the list then clears it.
document.addEventListener("keydown", (e) => {
  if (
    e.key === "/" &&
    // Only claim the key when there is actually a search box to focus.
    // Pages without one (settings, service detail, landing, sign-in) must let
    // the slash through instead of swallowing it.
    filterInput &&
    !isTyping(e.target) &&
    !e.isComposing &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey
  ) {
    e.preventDefault();
    filterInput.focus();
  } else if (e.key === "Escape" && document.activeElement === filterInput) {
    if (!results?.hidden) {
      closeResults();
    } else {
      filterInput.value = "";
      applyFilter();
      filterInput.blur();
    }
  }
});

document.getElementById("refresh-btn")?.addEventListener("click", () => location.reload());

setInterval(refresh, 15000);
document.addEventListener("visibilitychange", () => !document.hidden && refresh());
refresh();

// --- add site ---
const addBtn = document.getElementById("add-btn");
const addForm = document.getElementById("add-form");
const addCancel = document.getElementById("add-cancel");

if (addBtn && addForm) {
  addBtn.addEventListener("click", () => {
    addForm.hidden = !addForm.hidden;
    if (!addForm.hidden) addForm.querySelector("input").focus();
  });
  addCancel?.addEventListener("click", () => (addForm.hidden = true));

  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(addForm));
    data.interval_seconds = Number(data.interval_seconds) || 60;
    const res = await fetch("/api/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      addForm.reset();
      addForm.hidden = true;
      refresh();
      if (window.falorb) { window.falorb.track("monitor_added"); }
    } else {
      const { error } = await res.json().catch(() => ({}));
      alert("Could not add site: " + (error || res.status));
    }
  });
}

// --- sharing ---
// Links are stored as paths; show them as absolute URLs so they can be pasted
// straight into a message.
function absolutise(input) {
  if (input && input.value.startsWith("/")) {
    input.value = location.origin + input.value;
  }
}
document.querySelectorAll("#public-url, #site-url").forEach(absolutise);

document.querySelectorAll("[data-copy]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const input = document.getElementById(btn.dataset.copy);
    if (!input) return;
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select(); // clipboard API needs HTTPS; fall back to selecting
    }
    const original = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = original), 1500);
  });
});

const sharePanel = document.getElementById("share-panel");
document.getElementById("share-btn")?.addEventListener("click", () => {
  sharePanel.hidden = !sharePanel.hidden;
});

async function shareAction(method, url) {
  const res = await fetch(url, { method });
  if (res.ok) location.reload();
  else alert("Request failed: " + res.status);
}

document
  .getElementById("create-public")
  ?.addEventListener("click", () => {
    if (window.falorb) window.falorb.track("status_page_published");
    shareAction("POST", "/api/public-page");
  });

document.getElementById("revoke-public")?.addEventListener("click", () => {
  if (confirm("Revoke the public status page? The existing link stops working."))
    shareAction("DELETE", "/api/public-page");
});

const panelId = document.querySelector(".panel[data-id]")?.dataset.id;

document
  .getElementById("create-site-link")
  ?.addEventListener("click", () =>
    shareAction("POST", `/api/sites/${panelId}/share`),
  );

document.getElementById("revoke-site")?.addEventListener("click", () => {
  if (confirm("Revoke this share link? The existing link stops working."))
    shareAction("DELETE", `/api/sites/${panelId}/share`);
});

document.getElementById("is-public")?.addEventListener("change", async (e) => {
  const res = await fetch(`/api/sites/${panelId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ is_public: e.target.checked ? 1 : 0 }),
  });
  if (!res.ok) {
    e.target.checked = !e.target.checked;
    alert("Could not update: " + res.status);
  }
});

// --- settings page ---

/** Brief inline confirmation on a button, instead of an alert() interruption. */
async function flash(btn, label, ms = 1600) {
  const original = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, ms);
}

async function saveSettings(form, btn) {
  const body = Object.fromEntries(new FormData(form));
  const res = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    flash(btn, "Saved");
  } else {
    const { error } = await res.json().catch(() => ({}));
    alert("Could not save: " + (error || res.status));
  }
}

for (const id of ["monitoring-form", "public-form"]) {
  document.getElementById(id)?.addEventListener("submit", (e) => {
    e.preventDefault();
    saveSettings(e.target, e.target.querySelector("button[type=submit]"));
  });
}

// Telegram needs a chat ID; the other types don't. Swap the fields to match.
const hookType = document.getElementById("hook-type");
const hookChat = document.getElementById("hook-chat");
const hookUrl = document.getElementById("hook-url");
const hookHelp = document.getElementById("hook-help");

const HOOK_HINTS = {
  discord: {
    placeholder: "https://discord.com/api/webhooks/...",
    help: "Discord: Server Settings → Integrations → Webhooks → New Webhook.",
  },
  telegram: {
    placeholder: "Bot token from @BotFather",
    help: "Telegram: create a bot with @BotFather, message it once, then find your chat ID at api.telegram.org/bot<TOKEN>/getUpdates.",
  },
  generic: {
    placeholder: "https://example.com/hooks/webeye",
    help: "Generic: receives the raw JSON event as a POST body.",
  },
};

hookType?.addEventListener("change", () => {
  const hint = HOOK_HINTS[hookType.value];
  hookUrl.placeholder = hint.placeholder;
  hookHelp.textContent = hint.help;
  hookChat.hidden = hookType.value !== "telegram";
  hookChat.required = hookType.value === "telegram";
});

document.getElementById("hook-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const res = await fetch("/api/webhooks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    if (window.falorb) window.falorb.track("alert_channel_connected", { type: body.type });
    location.reload();
  } else {
    const { error } = await res.json().catch(() => ({}));
    alert("Could not add channel: " + (error || res.status));
  }
});

document.getElementById("hook-rows")?.addEventListener("click", async (e) => {
  const row = e.target.closest("tr[data-id]");
  if (!row) return;
  const id = row.dataset.id;

  const testBtn = e.target.closest(".hook-test");
  if (testBtn) {
    testBtn.disabled = true;
    testBtn.textContent = "Sending…";
    const res = await fetch(`/api/webhooks/${id}/test`, { method: "POST" });
    testBtn.disabled = false;
    if (res.ok) {
      flash(testBtn, "Sent ✓", 2000);
    } else {
      const { error } = await res.json().catch(() => ({}));
      testBtn.textContent = "Test";
      alert("Test failed: " + (error || res.status));
    }
    return;
  }

  if (e.target.closest(".hook-delete")) {
    if (!confirm("Delete this notification channel?")) return;
    const res = await fetch(`/api/webhooks/${id}`, { method: "DELETE" });
    if (res.ok) row.remove();
    else {
      const { error } = await res.json().catch(() => ({}));
      alert(error || "Delete failed");
    }
  }
});

document.getElementById("hook-rows")?.addEventListener("change", async (e) => {
  if (!e.target.classList.contains("hook-enabled")) return;
  const id = e.target.closest("tr[data-id]").dataset.id;
  const res = await fetch(`/api/webhooks/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: e.target.checked ? 1 : 0 }),
  });
  if (!res.ok) {
    e.target.checked = !e.target.checked;
    alert("Could not update channel");
  }
});

// --- invites (admin settings) ---

document.getElementById("invite-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  const res = await fetch("/api/invites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: data.note, days: data.days }),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    alert("Could not generate invite: " + (error || res.status));
    return;
  }
  const { url } = await res.json();
  // Put the link on the clipboard immediately — generating one is almost
  // always followed by sending it to somebody.
  try {
    await navigator.clipboard.writeText(location.origin + url);
  } catch {
    /* needs a secure origin; the row's Copy button is the fallback */
  }
  location.reload();
});

document.getElementById("invite-rows")?.addEventListener("click", async (e) => {
  const row = e.target.closest("tr[data-token]");
  if (!row) return;
  const token = row.dataset.token;

  const copyBtn = e.target.closest(".invite-copy");
  if (copyBtn) {
    const link = `${location.origin}/signup?invite=${token}`;
    try {
      await navigator.clipboard.writeText(link);
      flash(copyBtn, "Copied");
    } catch {
      prompt("Copy this invite link:", link);
    }
    return;
  }

  if (e.target.closest(".invite-revoke")) {
    if (!confirm("Revoke this invite? The code stops working immediately.")) return;
    const res = await fetch(`/api/invites/${encodeURIComponent(token)}`, {
      method: "DELETE",
    });
    if (res.ok) row.remove();
    else {
      const { error } = await res.json().catch(() => ({}));
      alert(error || "Could not revoke");
    }
  }
});

// --- edit a service (detail page) ---

const editPanel = document.getElementById("edit-panel");
document.getElementById("edit-btn")?.addEventListener("click", () => {
  editPanel.hidden = !editPanel.hidden;
  if (!editPanel.hidden) editPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
});
document.getElementById("edit-cancel")?.addEventListener("click", () => {
  editPanel.hidden = true;
});

document.getElementById("edit-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));

  const body = {
    name: data.name,
    url: data.url,
    method: data.method,
    expected_status: Number(data.expected_status),
    interval_seconds: Number(data.interval_seconds),
    timeout_ms: Number(data.timeout_ms),
    // An empty keyword means "no assertion", which the API stores as NULL.
    keyword: String(data.keyword ?? "").trim() || null,
    // Unchecked checkboxes are absent from FormData entirely.
    enabled: form.querySelector("[name=enabled]").checked ? 1 : 0,
  };

  const res = await fetch(`/api/sites/${editPanel.dataset.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) location.reload();
  else {
    const { error } = await res.json().catch(() => ({}));
    alert("Could not save: " + (error || res.status));
  }
});

// --- delete site (detail page) ---
const deleteBtn = document.getElementById("delete-btn");
deleteBtn?.addEventListener("click", async () => {
  if (!confirm("Delete this site and all of its history?")) return;
  const res = await fetch(`/api/sites/${deleteBtn.dataset.id}`, {
    method: "DELETE",
  });
  if (res.ok) location.href = "/";
  else alert("Delete failed: " + res.status);
});
