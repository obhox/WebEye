import tls from "node:tls";
import { allSites, db, now, userTunable, type Site } from "./db";
import { notify } from "./notify";

const DAY = 86_400_000;
const sslWarnDays = (userId: number | null) =>
  userTunable(userId, "ssl_warn_days", "SSL_WARN_DAYS", 14);

type Cert = { issuer: string; valid_from: number; valid_to: number };

function peerCert(hostname: string, port: number): Promise<Cert> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: hostname, port, servername: hostname, timeout: 10_000 },
      () => {
        const c = socket.getPeerCertificate();
        socket.end();
        if (!c || !c.valid_to) return reject(new Error("no peer certificate"));
        // Node types these as string | string[] — multi-valued RDNs are legal.
        const first = (v: string | string[] | undefined) =>
          Array.isArray(v) ? v[0] : v;
        resolve({
          issuer: first(c.issuer?.O) ?? first(c.issuer?.CN) ?? "unknown",
          valid_from: Date.parse(c.valid_from),
          valid_to: Date.parse(c.valid_to),
        });
      },
    );
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("tls handshake timed out"));
    });
  });
}

export function daysLeft(valid_to: number) {
  return Math.floor((valid_to - now()) / DAY);
}

export async function checkSiteTls(site: Site) {
  const url = new URL(site.url);
  if (url.protocol !== "https:") return;

  const port = url.port ? Number(url.port) : 443;
  try {
    const cert = await peerCert(url.hostname, port);
    db.query(
      `INSERT INTO tls_info (site_id, issuer, valid_from, valid_to, checked_at, error)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(site_id) DO UPDATE SET
         issuer = excluded.issuer, valid_from = excluded.valid_from,
         valid_to = excluded.valid_to, checked_at = excluded.checked_at,
         error = NULL`,
    ).run(site.id, cert.issuer, cert.valid_from, cert.valid_to, now());

    const left = daysLeft(cert.valid_to);
    if (left <= sslWarnDays(site.user_id)) {
      const row = db
        .query("SELECT warned_at FROM tls_info WHERE site_id = ?")
        .get(site.id) as { warned_at: number | null };
      // Warn at most once a day so a cert sitting at 3 days left doesn't spam.
      if (!row?.warned_at || now() - row.warned_at > DAY) {
        db.query("UPDATE tls_info SET warned_at = ? WHERE site_id = ?").run(
          now(),
          site.id,
        );
        notify(site.user_id, {
          kind: "ssl",
          site: site.name,
          url: site.url,
          daysLeft: left,
        });
      }
    } else {
      db.query("UPDATE tls_info SET warned_at = NULL WHERE site_id = ?").run(
        site.id,
      );
    }
  } catch (err: any) {
    db.query(
      `INSERT INTO tls_info (site_id, checked_at, error) VALUES (?, ?, ?)
       ON CONFLICT(site_id) DO UPDATE SET checked_at = excluded.checked_at,
                                          error = excluded.error`,
    ).run(site.id, now(), String(err?.message ?? err));
  }
}

/** Certs move slowly — one pass a day over every https site is plenty. */
export async function runTlsSweep() {
  for (const site of allSites()) {
    if (!site.enabled) continue;
    await checkSiteTls(site);
  }
}

export function startTlsScheduler() {
  runTlsSweep().catch((e) => console.error("[tls] sweep failed:", e));
  setInterval(
    () => runTlsSweep().catch((e) => console.error("[tls] sweep failed:", e)),
    DAY,
  );
}
