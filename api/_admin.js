import { readFile } from "node:fs/promises";
import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { db, send, fail, body, sha, secret, clientIp, mailAdmin, mailWithdrawal, mailSecurity, APP_URL } from "./_lib.js";
import { usdToKes, failWithdrawal } from "./_pay.js";
import { requireStepUp } from "./_security.js";

/* The admin console has one owner. Everyone else gets the normal 404 page, for the page, its files and its API.
   Opening it needs that account's email sign-in plus a face scan on the owner's phone (a passkey that must pass
   Face ID or the phone's own unlock). The phone key is enrolled once; the database refuses to delete or swap it. */

export const ADMIN_EMAIL = String(process.env.NSH_ADMIN_EMAIL || "").trim().toLowerCase();
export const isAdmin = (user) => Boolean(ADMIN_EMAIL) && String(user?.email || "").toLowerCase() === ADMIN_EMAIL;

const UNLOCK_MINUTES = 60;
const MAX_FAILS = 5;
const rp = () => { const u = new URL(APP_URL); return { id: u.hostname, origin: u.origin }; };
const ua = (req) => String(req.headers["user-agent"] || "").slice(0, 200);

/* ---------- hidden pages ---------- */

const FILES = {
  "admin-console": ["console.html", "text/html; charset=utf-8"],
  "admin-console/console.css": ["console.css", "text/css; charset=utf-8"],
  "admin-console/console.js": ["console.js", "text/javascript; charset=utf-8"],
};

const PRIVATE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" };

async function notFoundPage(res) {
  let html = "<!DOCTYPE html><title>Page not found · Nora Shillings</title><h1>Page not found</h1>";
  try { html = await readFile(new URL("../404.html", import.meta.url), "utf8"); } catch {}
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  for (const [k, v] of Object.entries(PRIVATE)) res.setHeader(k, v);
  res.end(html);
}

export async function adminPage(route, req, res, user) {
  const file = FILES[route];
  if (!file || req.method !== "GET" || !isAdmin(user)) return notFoundPage(res);
  const data = await readFile(new URL(`./_admin/${file[0]}`, import.meta.url));
  res.statusCode = 200;
  res.setHeader("Content-Type", file[1]);
  for (const [k, v] of Object.entries(PRIVATE)) res.setHeader(k, v);
  res.end(data);
}

/* ---------- log ---------- */

async function log(userId, req, type, detail = null) {
  await db()`INSERT INTO security_events (user_id, type, ip, user_agent, detail)
    VALUES (${userId}, ${type}, ${clientIp(req)}, ${ua(req)}, ${detail ? JSON.stringify(detail) : null})`
    .catch((err) => console.error("[admin] log", err));
}
const audit = (admin, req, action, target, extra = {}) => log(admin.id, req, "admin_action", { action, target, ...extra });

/* ---------- face lock ---------- */

const faceKey = async () => (await db()`SELECT * FROM admin_keys WHERE email = ${ADMIN_EMAIL}`)[0] || null;
const isUnlocked = (user) => Boolean(user.session_admin_at) && Date.now() - new Date(user.session_admin_at).getTime() < UNLOCK_MINUTES * 60000;

function requireUnlocked(user) {
  if (!isUnlocked(user)) fail(423, "Scan your face on your phone to open the admin console.", { code: "admin_locked" });
}

async function checkFails(userId) {
  const [r] = await db()`SELECT count(*)::int AS n FROM security_events
    WHERE user_id = ${userId} AND type = 'admin_face_failed' AND created_at > now() - interval '15 minutes'`;
  if (r.n >= MAX_FAILS) fail(429, "Too many failed face checks. Wait 15 minutes and try again.");
}

async function newTicket(purpose, userId, challenge) {
  const token = secret(32);
  await db()`INSERT INTO auth_challenges (id, user_id, purpose, challenge, data, expires_at)
    VALUES (${sha(token)}, ${userId}, ${purpose}, ${challenge}, '{}', now() + interval '5 minutes')`;
  return token;
}

async function takeTicket(token, purpose, userId) {
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(String(token || ""))) fail(400, "This step has expired. Start again.");
  const [c] = await db()`UPDATE auth_challenges SET used_at = now()
    WHERE id = ${sha(token)} AND purpose = ${purpose} AND user_id = ${userId} AND used_at IS NULL AND expires_at > now()
    RETURNING challenge`;
  if (!c) fail(400, "This step has expired. Start again.");
  return c.challenge;
}

const keyView = (k) => k && { created_at: k.created_at, last_used_at: k.last_used_at, synced: Boolean(k.backed_up), device_type: k.device_type };

async function state(req, res, user) {
  const key = await faceKey();
  const until = isUnlocked(user) ? new Date(new Date(user.session_admin_at).getTime() + UNLOCK_MINUTES * 60000) : null;
  send(res, 200, { email: ADMIN_EMAIL, name: user.name, enrolled: Boolean(key), unlocked: Boolean(until), until, key: keyView(key) });
}

async function enrollOptions(req, res, user) {
  if (await faceKey()) fail(409, "The face lock is already set up. It is permanent and can’t be replaced from the website.");
  requireStepUp(user);
  await checkFails(user.id);
  const options = await generateRegistrationOptions({
    rpName: "Nora Shillings admin",
    rpID: rp().id,
    userName: ADMIN_EMAIL,
    userDisplayName: "Nora admin console",
    userID: new TextEncoder().encode(`admin:${ADMIN_EMAIL}`),
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  send(res, 200, { ticket: await newTicket("admin-enroll", user.id, options.challenge), options });
}

async function enroll(req, res, user) {
  const b = await body(req);
  const challenge = await takeTicket(b.ticket, "admin-enroll", user.id);
  const { origin, id: rpID } = rp();
  let v = { verified: false };
  try {
    v = await verifyRegistrationResponse({
      response: b.response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    });
  } catch (err) {
    console.warn("[admin] enroll", err.message);
  }
  if (!v.verified) {
    await log(user.id, req, "admin_face_failed", { step: "enroll" });
    fail(400, "Your phone didn’t confirm the face scan. Try again.");
  }
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  const sql = db();
  const added = await sql`INSERT INTO admin_keys (id, email, public_key, counter, transports, device_type, backed_up)
    VALUES (${credential.id}, ${ADMIN_EMAIL}, ${Buffer.from(credential.publicKey).toString("base64url")}, ${credential.counter},
      ${credential.transports || null}, ${credentialDeviceType}, ${credentialBackedUp})
    ON CONFLICT DO NOTHING RETURNING id`;
  if (!added.length) fail(409, "The face lock is already set up. It is permanent and can’t be replaced from the website.");
  await sql`UPDATE sessions SET admin_at = now() WHERE token_hash = ${sha(user.session_token)}`;
  await log(user.id, req, "admin_enroll", { synced: credentialBackedUp });
  await mailSecurity(ADMIN_EMAIL, "Admin face lock is set up",
    "Your phone is now the key to the Nora admin console. Every time you open it, you scan your face on that phone. The key is permanent and can’t be replaced from the website.")
    .catch((err) => console.error("[admin] mail", err));
  send(res, 200, { ok: true });
}

async function unlockOptions(req, res, user) {
  const key = await faceKey();
  if (!key) fail(409, "Set up the face lock first.");
  await checkFails(user.id);
  const transports = [...new Set([...(key.transports || []), "hybrid"])];
  const options = await generateAuthenticationOptions({
    rpID: rp().id,
    userVerification: "required",
    allowCredentials: [{ id: key.id, transports }],
  });
  send(res, 200, { ticket: await newTicket("admin-unlock", user.id, options.challenge), options });
}

async function unlock(req, res, user) {
  const b = await body(req);
  const key = await faceKey();
  if (!key) fail(409, "Set up the face lock first.");
  await checkFails(user.id);
  const challenge = await takeTicket(b.ticket, "admin-unlock", user.id);
  const { origin, id: rpID } = rp();
  let v = { verified: false };
  if (String(b.response?.id || "") === key.id) {
    try {
      v = await verifyAuthenticationResponse({
        response: b.response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: key.id, publicKey: new Uint8Array(Buffer.from(key.public_key, "base64url")), counter: Number(key.counter), transports: key.transports || undefined },
      });
    } catch (err) {
      console.warn("[admin] unlock", err.message);
    }
  }
  if (!v.verified) {
    await log(user.id, req, "admin_face_failed", { step: "unlock" });
    fail(400, "That wasn’t the enrolled phone, or the face scan didn’t pass. Try again.");
  }
  const sql = db();
  await sql`UPDATE admin_keys SET counter = ${v.authenticationInfo.newCounter}, last_used_at = now(),
    backed_up = ${v.authenticationInfo.credentialBackedUp} WHERE id = ${key.id}`;
  await sql`UPDATE sessions SET admin_at = now() WHERE token_hash = ${sha(user.session_token)}`;
  await log(user.id, req, "admin_unlock");
  send(res, 200, { ok: true, until: new Date(Date.now() + UNLOCK_MINUTES * 60000) });
}

async function lock(req, res, user) {
  await db()`UPDATE sessions SET admin_at = NULL WHERE token_hash = ${sha(user.session_token)}`;
  send(res, 200, { ok: true });
}

/* ---------- withdrawals ---------- */

const wView = (w) => ({
  id: w.id,
  method: w.method,
  destination: w.destination,
  amount: Number(w.amount),
  kes: usdToKes(Number(w.amount) / 100),
  status: w.status,
  failure: w.failure,
  receipt: w.receipt,
  created_at: w.created_at,
  paid_at: w.paid_at,
  refunded_at: w.refunded_at,
  user: { id: w.user_id, name: w.name, email: w.email, country: w.country, verified: Boolean(w.verified_at) },
});

export async function notifyWithdrawal(w) {
  const usd = (Number(w.amount) / 100).toFixed(2);
  const nsh = `${Number(w.amount).toLocaleString("en-US")} NSH`;
  const who = w.user ? `${w.user} asked` : "A user asked";
  const after = `then open ${APP_URL}/admin and enter the ${w.method === "M-Pesa" ? "M-Pesa code" : "PayPal transaction ID"} to mark it sent. If you can't send it, return it to their wallet from the same page.\n\nWithdrawal: ${w.id}`;
  const [subject, text] = w.method === "M-Pesa"
    ? [`Approve M-Pesa withdrawal: KES ${usdToKes(Number(w.amount) / 100).toLocaleString("en-US")} to ${w.destination}`,
      `${who} to withdraw ${nsh} ($${usd}) to M-Pesa ${w.destination}.\n\nSend KES ${usdToKes(Number(w.amount) / 100).toLocaleString("en-US")} from M-Pesa, ${after}`]
    : w.method === "PayPal"
      ? [`Approve PayPal withdrawal: $${usd} to ${w.destination}`,
        `${who} to withdraw ${nsh} ($${usd}) to PayPal ${w.destination}.\n\nIn PayPal choose Send, enter ${w.destination} and $${usd} USD, ${after}`]
      : [`Approve ${w.method} withdrawal: $${usd} to ${w.destination}`, `${who} to withdraw ${nsh} ($${usd}) to ${w.method} ${w.destination}.\n\nSend it, ${after}`];
  await mailAdmin(subject, text).catch(() => {});
}

async function withUser(sql, id) {
  const [w] = await sql`SELECT w.*, u.email, u.name, u.country, u.verified_at FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = ${id}`;
  return w;
}

async function withdrawals(req, res) {
  const sql = db();
  const [open, recent] = await Promise.all([
    sql`SELECT w.*, u.email, u.name, u.country, u.verified_at FROM withdrawals w JOIN users u ON u.id = w.user_id
      WHERE w.mode = 'live' AND w.status IN ('pending', 'review') ORDER BY w.created_at`,
    sql`SELECT w.*, u.email, u.name, u.country, u.verified_at FROM withdrawals w JOIN users u ON u.id = w.user_id
      WHERE w.mode = 'live' AND w.status NOT IN ('pending', 'review')
      ORDER BY coalesce(w.paid_at, w.refunded_at, w.created_at) DESC LIMIT 50`,
  ]);
  send(res, 200, { open: open.map(wView), recent: recent.map(wView) });
}

async function approve(req, res, admin) {
  const sql = db();
  const b = await body(req);
  const id = String(b.id || "");
  const receipt = String(b.receipt || "").replace(/\s/g, "").toUpperCase();
  const [{ method } = {}] = await sql`SELECT method FROM withdrawals WHERE id = ${id}`;
  if (!/^[A-Z0-9]{8,20}$/.test(receipt)) {
    fail(400, method === "PayPal"
      ? "Enter the PayPal transaction ID from the payment details, like 5TY05013RG002845M."
      : "Enter the M-Pesa confirmation code from the SMS, like SJK3H2ABCD.");
  }
  const [used] = await sql`SELECT id FROM withdrawals WHERE receipt = ${receipt} AND id <> ${id} LIMIT 1`;
  if (used) fail(400, "That code is already on another withdrawal. Check it and try again.");
  const [w] = await sql`UPDATE withdrawals SET status = 'paid', receipt = ${receipt}, paid_at = now()
    WHERE id = ${id} AND mode = 'live' AND status IN ('pending', 'review') RETURNING id`;
  if (!w) fail(409, "Someone already handled this withdrawal. Refresh the list.");
  const full = await withUser(sql, id);
  await audit(admin, req, "withdrawal_sent", id, { receipt });
  await mailWithdrawal(full.email, full, "paid").catch((err) => console.error("[admin] mail", err.message));
  send(res, 200, { ok: true, withdrawal: wView(full) });
}

async function giveBack(req, res, admin) {
  const sql = db();
  const b = await body(req);
  const id = String(b.id || "");
  const why = String(b.reason || "").trim().slice(0, 200) || "We couldn’t send this withdrawal.";
  const w = await failWithdrawal(id, `${why.replace(/\.?$/, ".")} Your money is back in your wallet.`);
  if (!w) fail(409, "Someone already handled this withdrawal. Refresh the list.");
  const full = await withUser(sql, id);
  await audit(admin, req, "withdrawal_returned", id, { reason: why });
  await mailWithdrawal(full.email, full, "returned").catch((err) => console.error("[admin] mail", err.message));
  send(res, 200, { ok: true, withdrawal: wView(full) });
}

/* ---------- overview ---------- */

const num = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v)]));

async function overview(req, res) {
  const sql = db();
  const [[t], signups, events, open] = await Promise.all([
    sql`SELECT
      (SELECT count(*) FROM users) AS users,
      (SELECT count(*) FROM users WHERE verified_at IS NOT NULL) AS verified,
      (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days') AS new_7d,
      (SELECT count(*) FROM users WHERE frozen_at IS NOT NULL) AS frozen,
      (SELECT count(*) FROM users WHERE last_login_at > now() - interval '7 days') AS active_7d,
      (SELECT coalesce(sum(amount), 0) FROM balances WHERE mode = 'live') AS live_balances,
      (SELECT coalesce(sum(amount), 0) FROM balances WHERE mode = 'test') AS test_balances,
      (SELECT count(*) FROM withdrawals WHERE mode = 'live' AND status IN ('pending', 'review')) AS wd_open,
      (SELECT coalesce(sum(amount), 0) FROM withdrawals WHERE mode = 'live' AND status IN ('pending', 'review')) AS wd_open_amount,
      (SELECT coalesce(sum(amount), 0) FROM withdrawals WHERE mode = 'live' AND status = 'paid') AS wd_paid,
      (SELECT count(*) FROM withdrawals WHERE mode = 'live' AND status = 'paid') AS wd_paid_count,
      (SELECT count(*) FROM topups WHERE mode = 'live' AND status = 'paid') AS topups_paid,
      (SELECT coalesce(sum(nsh), 0) FROM topups WHERE mode = 'live' AND status = 'paid') AS topups_nsh,
      (SELECT coalesce(sum(nsh), 0) FROM topups WHERE mode = 'live' AND status = 'paid' AND paid_at > now() - interval '30 days') AS topups_30d,
      (SELECT count(*) FROM topups WHERE mode = 'live' AND status = 'pending') AS topups_pending,
      (SELECT count(*) FROM payments WHERE mode = 'live' AND status = 'paid') AS payments_paid,
      (SELECT coalesce(sum(amount), 0) FROM payments WHERE mode = 'live' AND status = 'paid') AS payments_volume,
      (SELECT coalesce(sum(fee), 0) FROM payments WHERE mode = 'live' AND status = 'paid') AS payment_fees,
      (SELECT coalesce(sum(fee), 0) FROM deposits WHERE mode = 'live' AND status = 'succeeded') AS deposit_fees,
      (SELECT coalesce(sum(amount), 0) FROM deposits WHERE mode = 'live' AND status = 'succeeded') AS deposits_volume,
      (SELECT count(*) FROM apps WHERE deleted_at IS NULL) AS apps,
      (SELECT count(*) FROM connections WHERE revoked_at IS NULL) AS connections`,
    sql`SELECT id, email, name, verified_at, created_at FROM users ORDER BY created_at DESC LIMIT 6`,
    sql`SELECT e.type, e.ip, e.detail, e.created_at, u.email FROM security_events e LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.created_at DESC LIMIT 8`,
    sql`SELECT w.*, u.email, u.name, u.country, u.verified_at FROM withdrawals w JOIN users u ON u.id = w.user_id
      WHERE w.mode = 'live' AND w.status IN ('pending', 'review') ORDER BY w.created_at LIMIT 5`,
  ]);
  send(res, 200, { totals: num(t), signups, events, open: open.map(wView) });
}

/* ---------- users ---------- */

const likeOf = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

async function users(req, res) {
  const url = new URL(req.url, "http://local");
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 100);
  const f = String(url.searchParams.get("filter") || "all");
  const rows = await db()`SELECT u.id, u.email, u.name, u.country, u.verified_at, u.frozen_at, u.created_at, u.last_login_at,
      u.totp_enabled_at IS NOT NULL AS totp, EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id) AS passkey,
      coalesce((SELECT amount FROM balances b WHERE b.user_id = u.id AND b.mode = 'live'), 0) AS live,
      coalesce((SELECT amount FROM balances b WHERE b.user_id = u.id AND b.mode = 'test'), 0) AS test
    FROM users u
    WHERE (${q} = '' OR u.email ILIKE ${likeOf(q)} OR coalesce(u.name, '') ILIKE ${likeOf(q)} OR u.id::text = ${q})
      AND (${f} <> 'verified' OR u.verified_at IS NOT NULL)
      AND (${f} <> 'unverified' OR u.verified_at IS NULL)
      AND (${f} <> 'frozen' OR u.frozen_at IS NOT NULL)
      AND (${f} <> 'money' OR EXISTS (SELECT 1 FROM balances b WHERE b.user_id = u.id AND b.mode = 'live' AND b.amount > 0))
    ORDER BY u.created_at DESC LIMIT 200`;
  send(res, 200, { users: rows.map((u) => ({ ...u, live: Number(u.live), test: Number(u.test), admin: isAdmin(u) })) });
}

async function userDetail(req, res) {
  const id = String(new URL(req.url, "http://local").searchParams.get("id") || "");
  const sql = db();
  const [u] = await sql`SELECT id, email, name, country, verified_at, kyc_status, created_at, last_login_at, frozen_at, frozen_reason,
      totp_enabled_at, webhook_test, webhook_live, cardinality(coalesce(recovery_codes, '{}')) AS recovery_left
    FROM users WHERE id::text = ${id}`;
  if (!u) fail(404, "No user with that id.");
  const [balances, ledger, wds, topups, payments, apps, sessions, events, keys, passkeys] = await Promise.all([
    sql`SELECT mode, amount FROM balances WHERE user_id = ${u.id}`,
    sql`SELECT mode, kind, amount, counterparty, method, status, ref, created_at FROM ledger WHERE user_id = ${u.id}
      ORDER BY created_at DESC, id DESC LIMIT 60`,
    sql`SELECT id, mode, method, amount, destination, status, receipt, failure, created_at, paid_at, refunded_at FROM withdrawals
      WHERE user_id = ${u.id} ORDER BY created_at DESC LIMIT 30`,
    sql`SELECT id, mode, method, usd, nsh, kes, phone, status, failure, provider_ref, receipt, created_at, paid_at FROM topups
      WHERE user_id = ${u.id} ORDER BY created_at DESC LIMIT 30`,
    sql`SELECT p.id, p.mode, p.amount, p.fee, p.company, p.reference, p.status, p.created_at, p.paid_at,
        CASE WHEN p.merchant_id = ${u.id} THEN 'merchant' ELSE 'payer' END AS role
      FROM payments p WHERE p.merchant_id = ${u.id} OR p.payer_id = ${u.id} ORDER BY p.created_at DESC LIMIT 30`,
    sql`SELECT a.id, a.name, a.website, a.created_at, a.deleted_at,
        (SELECT count(*)::int FROM connections c WHERE c.app_id = a.id AND c.revoked_at IS NULL) AS users
      FROM apps a WHERE a.owner_id = ${u.id} ORDER BY a.created_at DESC`,
    sql`SELECT created_at, last_seen_at, method, ip, user_agent, mfa_at FROM sessions WHERE user_id = ${u.id} AND expires_at > now()
      ORDER BY coalesce(last_seen_at, created_at) DESC LIMIT 20`,
    sql`SELECT type, ip, user_agent, detail, created_at FROM security_events WHERE user_id = ${u.id} ORDER BY created_at DESC LIMIT 30`,
    sql`SELECT mode, last4, created_at FROM api_keys WHERE user_id = ${u.id} AND revoked_at IS NULL`,
    sql`SELECT name, created_at, last_used_at FROM passkeys WHERE user_id = ${u.id} ORDER BY created_at`,
  ]);
  const bal = { test: 0, live: 0 };
  for (const b of balances) bal[b.mode] = Number(b.amount);
  send(res, 200, {
    user: { ...u, admin: isAdmin(u), recovery_left: Number(u.recovery_left) },
    balances: bal,
    ledger: ledger.map((l) => ({ ...l, amount: Number(l.amount) })),
    withdrawals: wds.map((w) => ({ ...w, amount: Number(w.amount) })),
    topups,
    payments: payments.map((p) => ({ ...p, amount: Number(p.amount), fee: Number(p.fee) })),
    apps, sessions, events, keys, passkeys,
  });
}

async function targetUser(sql, id) {
  const [u] = await sql`SELECT id, email, frozen_at FROM users WHERE id::text = ${String(id || "")}`;
  if (!u) fail(404, "No user with that id.");
  return u;
}

async function freeze(req, res, admin) {
  const b = await body(req);
  const sql = db();
  const u = await targetUser(sql, b.id);
  if (isAdmin(u)) fail(400, "You can’t put the admin account on hold.");
  const reason = String(b.reason || "").trim().slice(0, 200) || "Put on hold by Nora admin.";
  const [done] = await sql`UPDATE users SET frozen_at = now(), frozen_reason = ${reason} WHERE id = ${u.id} AND frozen_at IS NULL RETURNING id`;
  if (!done) fail(409, "This account is already on hold.");
  await audit(admin, req, "user_frozen", u.email, { reason });
  send(res, 200, { ok: true });
}

async function unfreeze(req, res, admin) {
  const b = await body(req);
  const sql = db();
  const u = await targetUser(sql, b.id);
  const [done] = await sql`UPDATE users SET frozen_at = NULL, frozen_reason = NULL WHERE id = ${u.id} AND frozen_at IS NOT NULL RETURNING id`;
  if (!done) fail(409, "This account isn’t on hold.");
  await audit(admin, req, "user_unfrozen", u.email);
  send(res, 200, { ok: true });
}

async function signOutUser(req, res, admin) {
  const b = await body(req);
  const sql = db();
  const u = await targetUser(sql, b.id);
  const gone = await sql`DELETE FROM sessions WHERE user_id = ${u.id} AND token_hash <> ${sha(admin.session_token)} RETURNING 1`;
  await audit(admin, req, "user_signed_out", u.email, { sessions: gone.length });
  send(res, 200, { ok: true, signed_out: gone.length });
}

/* ---------- money and apps ---------- */

const modeOf = (req) => {
  const m = new URL(req.url, "http://local").searchParams.get("mode");
  return m === "test" || m === "live" ? m : "live";
};

async function topups(req, res) {
  const rows = await db()`SELECT t.id, t.mode, t.method, t.usd, t.nsh, t.kes, t.phone, t.status, t.failure, t.provider_ref, t.receipt,
      t.created_at, t.paid_at, u.id AS user_id, u.email, u.name
    FROM topups t JOIN users u ON u.id = t.user_id WHERE t.mode = ${modeOf(req)} ORDER BY t.created_at DESC LIMIT 200`;
  send(res, 200, { topups: rows.map((t) => ({ ...t, nsh: Number(t.nsh) })) });
}

async function payments(req, res) {
  const rows = await db()`SELECT p.id, p.mode, p.amount, p.fee, p.company, p.reference, p.status, p.created_at, p.paid_at, p.refunded_at,
      m.id AS merchant_id, m.email AS merchant_email, pu.email AS payer_email
    FROM payments p JOIN users m ON m.id = p.merchant_id LEFT JOIN users pu ON pu.id = p.payer_id
    WHERE p.mode = ${modeOf(req)} ORDER BY p.created_at DESC LIMIT 200`;
  send(res, 200, { payments: rows.map((p) => ({ ...p, amount: Number(p.amount), fee: Number(p.fee) })) });
}

async function apps(req, res) {
  const sql = db();
  const [list, deposits] = await Promise.all([
    sql`SELECT a.id, a.name, a.website, a.created_at, a.deleted_at, u.id AS owner_id, u.email AS owner_email,
        (SELECT count(*)::int FROM connections c WHERE c.app_id = a.id AND c.revoked_at IS NULL) AS users,
        (SELECT coalesce(sum(d.amount), 0) FROM deposits d WHERE d.app_id = a.id AND d.mode = 'live' AND d.status = 'succeeded') AS live_volume
      FROM apps a JOIN users u ON u.id = a.owner_id ORDER BY a.deleted_at IS NOT NULL, a.created_at DESC LIMIT 200`,
    sql`SELECT d.id, d.mode, d.amount, d.fee, d.reference, d.status, d.created_at, d.completed_at, a.name AS app_name, u.email AS user_email
      FROM deposits d JOIN apps a ON a.id = d.app_id LEFT JOIN users u ON u.id = d.user_id
      ORDER BY d.created_at DESC LIMIT 100`,
  ]);
  send(res, 200, {
    apps: list.map((a) => ({ ...a, live_volume: Number(a.live_volume) })),
    deposits: deposits.map((d) => ({ ...d, amount: Number(d.amount), fee: Number(d.fee) })),
  });
}

async function removeApp(req, res, admin) {
  const id = String((await body(req)).id || "");
  const sql = db();
  const [a] = await sql`UPDATE apps SET deleted_at = now() WHERE id::text = ${id} AND deleted_at IS NULL RETURNING id, name`;
  if (!a) fail(404, "No active app with that id.");
  await sql`UPDATE connections SET revoked_at = now() WHERE app_id = ${a.id} AND revoked_at IS NULL`;
  await sql`UPDATE deposits SET status = 'declined', completed_at = now() WHERE app_id = ${a.id} AND status = 'pending'`;
  await audit(admin, req, "app_removed", a.id, { name: a.name });
  send(res, 200, { ok: true });
}

async function securityLog(req, res) {
  const type = String(new URL(req.url, "http://local").searchParams.get("type") || "");
  const rows = await db()`SELECT e.type, e.ip, e.user_agent, e.detail, e.created_at, u.id AS user_id, u.email
    FROM security_events e LEFT JOIN users u ON u.id = e.user_id
    WHERE (${type} = '' OR e.type = ${type}) ORDER BY e.created_at DESC LIMIT 200`;
  send(res, 200, { events: rows });
}

/* ---------- routes ---------- */

const OPEN = {
  "GET admin/state": state,
  "POST admin/face/enroll/options": enrollOptions,
  "POST admin/face/enroll": enroll,
  "POST admin/face/unlock/options": unlockOptions,
  "POST admin/face/unlock": unlock,
  "POST admin/lock": lock,
};

const LOCKED = {
  "GET admin/overview": overview,
  "GET admin/withdrawals": withdrawals,
  "POST admin/withdrawals/approve": approve,
  "POST admin/withdrawals/return": giveBack,
  "GET admin/users": users,
  "GET admin/user": userDetail,
  "POST admin/users/freeze": freeze,
  "POST admin/users/unfreeze": unfreeze,
  "POST admin/users/signout": signOutUser,
  "GET admin/topups": topups,
  "GET admin/payments": payments,
  "GET admin/apps": apps,
  "POST admin/apps/remove": removeApp,
  "GET admin/security": securityLog,
};

export async function adminHandler(route, req, res, user) {
  const key = `${req.method} ${route}`;
  if (!isAdmin(user) || !(OPEN[key] || LOCKED[key])) return send(res, 404, { error: "Not found." });
  if (OPEN[key]) return OPEN[key](req, res, user);
  requireUnlocked(user);
  return LOCKED[key](req, res, user);
}
