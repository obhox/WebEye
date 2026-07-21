import { listWebhooks, type Webhook } from "./db";

export type Event =
  | { kind: "down"; site: string; url: string; cause: string }
  | { kind: "up"; site: string; url: string; downForMs: number }
  | { kind: "ssl"; site: string; url: string; daysLeft: number }
  | { kind: "test" };

function human(ms: number) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function text(e: Event) {
  switch (e.kind) {
    case "down":
      return `🔴 DOWN — ${e.site}\n${e.url}\n${e.cause}`;
    case "up":
      return `🟢 RECOVERED — ${e.site}\n${e.url}\nDown for ${human(e.downForMs)}`;
    case "ssl":
      return `⚠️ SSL expiring — ${e.site}\n${e.url}\nCertificate expires in ${e.daysLeft} day(s)`;
    case "test":
      return `✅ WebEye test alert — if you can read this, notifications are working.`;
  }
}

export async function deliver(w: Webhook, e: Event) {
  const body =
    w.type === "discord"
      ? { content: text(e) }
      : w.type === "telegram"
        ? { chat_id: w.chat_id, text: text(e) }
        : { ...e, message: text(e), at: new Date().toISOString() };

  const res = await fetch(w.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text().catch(() => "")}`.trim());
  }
}

/**
 * Fire-and-forget: a slow or broken webhook must never stall the scheduler,
 * and a failed delivery is logged rather than retried.
 *
 * `userId` is the owner of the service that changed state — an alert only ever
 * reaches the channels of the account that owns the service.
 */
export function notify(userId: number | null, e: Event) {
  if (userId === null) return; // orphaned service, pre-adoption
  for (const w of listWebhooks(userId)) {
    deliver(w, e).catch((err) =>
      console.error(`[notify] ${w.type} delivery failed:`, err.message),
    );
  }
}
