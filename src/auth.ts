import { db, newToken, now } from "./db";

export type User = {
  id: number;
  email: string;
  password_hash: string;
  name: string | null;
  is_admin: number;
  created_at: number;
  public_token: string | null;
  public_page_title: string | null;
};

const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 86_400_000;

// --- passwords -----------------------------------------------------------

/** Bun ships argon2id, so there is no dependency and no hand-rolled crypto. */
export const hashPassword = (plain: string) =>
  Bun.password.hash(plain, { algorithm: "argon2id" });

export const verifyPassword = (plain: string, hash: string) =>
  Bun.password.verify(plain, hash);

export const MIN_PASSWORD = 8;

/**
 * Deliberately permissive: the only thing that actually proves an address is
 * real is sending mail to it, and over-strict patterns reject valid addresses.
 */
export const looksLikeEmail = (s: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;

export function passwordProblem(pw: string): string | null {
  if (pw.length < MIN_PASSWORD)
    return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return "Password is too long.";
  return null;
}

// --- users ---------------------------------------------------------------

export const findUserByEmail = (email: string) =>
  db
    .query("SELECT * FROM users WHERE email = ?")
    .get(email.trim().toLowerCase()) as User | null;

export const findUserByPublicToken = (token: string) =>
  db.query("SELECT * FROM users WHERE public_token = ?").get(token) as
    | User
    | null;

export const getUser = (id: number) =>
  db.query("SELECT * FROM users WHERE id = ?").get(id) as User | null;

export const userCount = () =>
  (db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;

export async function createUser(opts: {
  email: string;
  password: string;
  name?: string | null;
}) {
  const hash = await hashPassword(opts.password);
  // The very first account to exist owns the instance.
  const isAdmin = userCount() === 0 ? 1 : 0;

  const info = db
    .query(
      `INSERT INTO users (email, password_hash, name, is_admin, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      opts.email.trim().toLowerCase(),
      hash,
      opts.name?.trim() || null,
      isAdmin,
      now(),
    );

  const id = Number(info.lastInsertRowid);
  if (isAdmin) adoptOrphans(id);
  return id;
}

/**
 * Upgrade path for instances that ran before accounts existed: services,
 * channels and the public status page created under the old single-password
 * scheme have no owner, so the first account created takes them over. Without
 * this, upgrading would appear to wipe every service.
 */
function adoptOrphans(userId: number) {
  const sites = db
    .query("UPDATE sites SET user_id = ? WHERE user_id IS NULL")
    .run(userId).changes;
  const hooks = db
    .query("UPDATE webhooks SET user_id = ? WHERE user_id IS NULL")
    .run(userId).changes;

  // The old global status-page token becomes this user's.
  const legacy = db
    .query("SELECT value FROM settings WHERE key = 'public_page_token'")
    .get() as { value: string } | undefined;
  if (legacy?.value) {
    db.query("UPDATE users SET public_token = ? WHERE id = ?").run(
      legacy.value,
      userId,
    );
    db.query("DELETE FROM settings WHERE key = 'public_page_token'").run();
  }
  const legacyTitle = db
    .query("SELECT value FROM settings WHERE key = 'public_page_title'")
    .get() as { value: string } | undefined;
  if (legacyTitle?.value) {
    db.query("UPDATE users SET public_page_title = ? WHERE id = ?").run(
      legacyTitle.value,
      userId,
    );
    db.query("DELETE FROM settings WHERE key = 'public_page_title'").run();
  }

  if (sites || hooks) {
    console.log(
      `[auth] adopted ${sites} pre-account service(s) and ${hooks} channel(s) into user ${userId}`,
    );
  }
}

// --- invites -------------------------------------------------------------

export type Invite = {
  token: string;
  created_by: number | null;
  created_at: number;
  note: string | null;
  expires_at: number | null;
  used_by: number | null;
  used_at: number | null;
};

/**
 * Registration is invite-only, with one exception: while the instance has no
 * accounts at all, the first signup claims it. Without that escape hatch a
 * fresh deployment could never be entered, since only an admin can mint an
 * invite.
 */
export const inviteRequired = () => userCount() > 0;

export function createInvite(opts: {
  createdBy: number;
  note?: string | null;
  days?: number | null;
}) {
  const token = newToken();
  db.query(
    "INSERT INTO invites (token, created_by, created_at, note, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    token,
    opts.createdBy,
    now(),
    opts.note?.trim() || null,
    opts.days ? now() + opts.days * 86_400_000 : null,
  );
  return token;
}

export const getInvite = (token: string) =>
  db.query("SELECT * FROM invites WHERE token = ?").get(token) as Invite | null;

export const listInvites = () =>
  db
    .query("SELECT * FROM invites ORDER BY used_at IS NOT NULL, created_at DESC")
    .all() as Invite[];

export const revokeInvite = (token: string) =>
  db.query("DELETE FROM invites WHERE token = ? AND used_at IS NULL").run(token)
    .changes;

/** Why an invite can't be used — null when it is good to redeem. */
export function inviteProblem(token: string): string | null {
  if (!token.trim()) return "An invite code is required to create an account.";
  const invite = getInvite(token.trim());
  // Same message for "never existed" and "already used" so the endpoint can't
  // be used to probe which codes are real.
  if (!invite || invite.used_at) return "That invite code is not valid.";
  if (invite.expires_at && invite.expires_at < now()) {
    return "That invite code has expired.";
  }
  return null;
}

export const redeemInvite = (token: string, userId: number) =>
  db
    .query(
      "UPDATE invites SET used_by = ?, used_at = ? WHERE token = ? AND used_at IS NULL",
    )
    .run(userId, now(), token.trim()).changes;

// --- sessions ------------------------------------------------------------

export function createSession(userId: number) {
  const token = newToken();
  db.query(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(token, userId, now(), now() + SESSION_MS);
  return token;
}

export function sessionUser(token: string | undefined): User | null {
  if (!token) return null;
  const row = db
    .query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, now()) as User | null;
  return row ?? null;
}

export const destroySession = (token: string | undefined) => {
  if (token) db.query("DELETE FROM sessions WHERE token = ?").run(token);
};

/** Called on boot and daily; expired rows are dead weight otherwise. */
export const pruneSessions = () =>
  db.query("DELETE FROM sessions WHERE expires_at < ?").run(now());

export const SESSION_MAX_AGE = SESSION_DAYS * 86400;

// --- login throttling ----------------------------------------------------
// In-memory is the right scope here: WebEye is a single process, and a restart
// clearing the counters is not a meaningful bypass for an online attack.

const attempts = new Map<string, { n: number; until: number }>();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60_000;

export function throttleCheck(key: string): number | null {
  const rec = attempts.get(key);
  if (rec && rec.n >= MAX_ATTEMPTS && rec.until > now()) {
    return Math.ceil((rec.until - now()) / 60_000);
  }
  return null;
}

export function noteFailure(key: string) {
  const rec = attempts.get(key) ?? { n: 0, until: 0 };
  rec.n++;
  rec.until = now() + LOCKOUT_MS;
  attempts.set(key, rec);
}

export const clearFailures = (key: string) => attempts.delete(key);
