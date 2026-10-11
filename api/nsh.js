import {
  db, send, fail, body, cookie, sessionCookie, clientIp, isEmail, isMode, amountOf, safeWebhook,
  sha, secret, newId, fee, mailLink, mailWelcome, deliver, publicPayment, HttpError,
  bunnyPut, bunnyGet, bunnyDelete,
  APP_URL, SESSION_COOKIE, SESSION_DAYS, SANDBOX_START,
} from "./_lib.js";

import {
  paypalReady, payheroReady, kesPerUsd, usdToKes, normalizePhone, paypalCreateOrder, paypalVerifyWebhook,
  payheroStk, mpesaReason, publicTopup, completeTopup, failTopup, settlePaypal, settleMpesa,
  paypalWithdraw, settleWithdrawal,
} from "./_pay.js";
import { appsHandler, v1Connections, v1Deposits } from "./_apps.js";
import { kycReady, startKyc, syncKyc, kycWebhook, KYC_DONE } from "./_kyc.js";

const AVATAR_DIR = "nuru-shillings/avatars";
const AVATAR_NAME = /^[A-Za-z0-9_-]{20,40}\.(jpg|png|webp)$/;
const avatarUrl = (key) => (key ? `/api/avatar?k=${encodeURIComponent(key.split("/").pop())}` : null);

function routeOf(req) {
  const url = new URL(req.url, "http://local");
  const fromQuery = url.searchParams.get("route");
  if (fromQuery) return fromQuery.replace(/^\/+|\/+$/g, "");
  return url.pathname.replace(/^\/(api\/)?/, "").replace(/^nsh\/?/, "").replace(/\/+$/, "");
}

async function sessionUser(req) {
  const token = cookie(req, SESSION_COOKIE);
  if (!token) return null;
  const sql = db();
  const [user] = await sql`SELECT u.*, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${sha(token)} AND s.expires_at > now()`;
  if (user) user.session_token = token;
  return user || null;
}

/* Sliding session: every visit pushes expiry a full year out, so people stay logged in until they log out. */
async function renewSession(user) {
  const left = new Date(user.session_expires).getTime() - Date.now();
  if (left > (SESSION_DAYS - 1) * 86400000) return {};
  await db()`UPDATE sessions SET expires_at = now() + make_interval(days => ${SESSION_DAYS}), last_seen_at = now()
    WHERE token_hash = ${sha(user.session_token)}`;
  return { "Set-Cookie": sessionCookie(user.session_token, SESSION_DAYS * 86400) };
}

async function needUser(req) {
  const user = await sessionUser(req);
  if (!user) fail(401, "Log in to continue.");
  return user;
}

async function keyUser(req) {
  const header = String(req.headers.authorization || "");
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!/^nsh_(test|live)_[A-Za-z0-9_-]{20,}$/.test(key)) fail(401, "Send your secret key as: Authorization: Bearer nsh_test_...");
  const sql = db();
  const [row] = await sql`SELECT k.mode, u.* FROM api_keys k JOIN users u ON u.id = k.user_id
    WHERE k.key_hash = ${sha(key)} AND k.revoked_at IS NULL`;
  if (!row) fail(401, "This key is not valid or was replaced.");
  if (row.mode === "live" && !row.verified_at) fail(403, "Verify the account before using the live key.");
  return row;
}

/* ---------- sign-in by email link ---------- */

async function authStart(req, res) {
  const b = await body(req);
  if (b.website) return send(res, 200, { ok: true });
  const email = String(b.email || "").trim().toLowerCase();
  if (!isEmail(email)) fail(400, "Enter a valid email address.");
  const sql = db();
  const ip = clientIp(req);
  const [limits] = await sql`SELECT
    (SELECT count(*) FROM login_tokens WHERE email = ${email} AND created_at > now() - interval '10 minutes')::int AS by_email,
    (SELECT count(*) FROM login_tokens WHERE ip = ${ip} AND created_at > now() - interval '10 minutes')::int AS by_ip`;
  if (limits.by_email >= 3 || limits.by_ip >= 10) fail(429, "Too many links requested. Wait a few minutes and try again.");

  const token = secret(32);
  await sql`INSERT INTO login_tokens (token_hash, email, ip, expires_at)
    VALUES (${sha(token)}, ${email}, ${ip}, now() + interval '20 minutes')`;
  const [existing] = await sql`SELECT id FROM users WHERE email = ${email}`;
  const ok = await mailLink(email, `${APP_URL}/auth#${token}`, !existing);
  if (!ok) fail(502, "We could not send the email. Try again in a minute.");
  send(res, 200, { ok: true });
}

async function authVerify(req, res) {
  const b = await body(req);
  const token = String(b.token || "");
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(token)) fail(400, "This link is not valid. Request a new one.");
  const sql = db();
  const used = await sql`UPDATE login_tokens SET used_at = now()
    WHERE token_hash = ${sha(token)} AND used_at IS NULL AND expires_at > now() RETURNING email`;
  if (!used.length) fail(400, "This link has expired or was already used. Request a new one.");

  const [user] = await sql`INSERT INTO users (email, last_login_at) VALUES (${used[0].email}, now())
    ON CONFLICT (email) DO UPDATE SET last_login_at = now() RETURNING id, (xmax = 0) AS created`;
  if (user.created) {
    await sql.transaction([
      sql`INSERT INTO balances (user_id, mode, amount) VALUES (${user.id}, 'test', ${SANDBOX_START}), (${user.id}, 'live', 0) ON CONFLICT DO NOTHING`,
      sql`INSERT INTO ledger (user_id, mode, kind, amount, counterparty) VALUES (${user.id}, 'test', 'add', ${SANDBOX_START}, 'Sandbox starting balance')`,
    ]);
    await mailWelcome(used[0].email).catch((err) => console.error("[auth] welcome", err));
  }
  const session = secret(32);
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${sha(session)}, ${user.id}, now() + make_interval(days => ${SESSION_DAYS}))`;
  send(res, 200, { ok: true, created: user.created }, { "Set-Cookie": sessionCookie(session, SESSION_DAYS * 86400) });
}

async function authLogout(req, res) {
  const token = cookie(req, SESSION_COOKIE);
  if (token) await db()`DELETE FROM sessions WHERE token_hash = ${sha(token)}`;
  send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
}

/* ---------- wallet ---------- */

async function me(req, res, mode) {
  const user = await needUser(req);
  const sql = db();
  const open = await sql`SELECT * FROM withdrawals WHERE user_id = ${user.id} AND status IN ('processing', 'unclaimed')
    ORDER BY created_at LIMIT 3`;
  await Promise.all(open.map((w) => settleWithdrawal(w).catch((err) => console.error("[withdraw] settle", w.id, err.message))));
  const [balances, activity, keys, withdrawals] = await Promise.all([
    sql`SELECT mode, amount FROM balances WHERE user_id = ${user.id}`,
    sql`SELECT l.kind, l.amount, l.counterparty, l.method, l.ref, l.created_at,
        CASE WHEN w.id IS NULL THEN l.status WHEN w.status = 'paid' THEN 'done' WHEN w.status = 'failed' THEN 'failed' ELSE 'pending' END AS status
      FROM ledger l LEFT JOIN withdrawals w ON l.kind = 'withdraw' AND w.id = l.ref
      WHERE l.user_id = ${user.id} AND l.mode = ${mode} ORDER BY l.created_at DESC, l.id DESC LIMIT 30`,
    sql`SELECT mode, last4, created_at FROM api_keys WHERE user_id = ${user.id} AND revoked_at IS NULL`,
    sql`SELECT coalesce(w.id, l.ref) AS id, -l.amount AS amount, l.method, l.counterparty AS destination, l.created_at,
        coalesce(w.status, CASE l.status WHEN 'pending' THEN 'pending' ELSE 'paid' END) AS status, w.failure, w.receipt, w.paid_at
      FROM ledger l LEFT JOIN withdrawals w ON w.id = l.ref
      WHERE l.user_id = ${user.id} AND l.mode = ${mode} AND l.kind = 'withdraw' ORDER BY l.created_at DESC, l.id DESC LIMIT 50`,
  ]);
  const bal = { test: 0, live: 0 };
  for (const b of balances) bal[b.mode] = Number(b.amount);
  const keyMap = { test: null, live: null };
  for (const k of keys) keyMap[k.mode] = { last4: k.last4, created: k.created_at };
  send(res, 200, {
    email: user.email,
    name: user.name,
    country: user.country,
    verified: Boolean(user.verified_at),
    kyc: user.verified_at ? "approved" : user.kyc_session ? user.kyc_status || "not_started" : "none",
    kyc_ready: kycReady(),
    avatar: avatarUrl(user.avatar_key),
    prefs: user.prefs || {},
    member_since: user.created_at,
    payments: { paypal: paypalReady(), card: paypalReady(), mpesa: payheroReady(), kes_per_usd: kesPerUsd() },
    balances: bal,
    activity: activity.map((a) => ({ ...a, amount: Number(a.amount) })),
    withdrawals: withdrawals.map((w) => ({ ...w, amount: Number(w.amount) })),
    keys: keyMap,
    webhooks: { test: user.webhook_test, live: user.webhook_live },
  }, await renewSession(user));
}

/* ---------- profile ---------- */

const IMAGE_TYPES = { jpeg: "jpg", png: "png", webp: "webp" };
function imageBytes(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) fail(400, "Choose a JPG, PNG, or WebP picture.");
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length < 100 || bytes.length > 400000) fail(400, "That picture is too large. Use one under 400 KB.");
  const sig = bytes.subarray(0, 12);
  const ok = m[1] === "jpeg" ? sig[0] === 0xff && sig[1] === 0xd8
    : m[1] === "png" ? sig.toString("hex", 0, 4) === "89504e47"
    : sig.toString("ascii", 0, 4) === "RIFF" && sig.toString("ascii", 8, 12) === "WEBP";
  if (!ok) fail(400, "That file is not a valid picture.");
  return { bytes, ext: IMAGE_TYPES[m[1]], type: `image/${m[1]}` };
}

async function setAvatar(req, res) {
  const user = await needUser(req);
  const { bytes, ext, type } = imageBytes((await body(req, 600000)).image);
  const key = `${AVATAR_DIR}/${secret(18)}.${ext}`;
  await bunnyPut(key, bytes, type);
  await db()`UPDATE users SET avatar_key = ${key} WHERE id = ${user.id}`;
  if (user.avatar_key) await bunnyDelete(user.avatar_key);
  send(res, 200, { avatar: avatarUrl(key) });
}

async function removeAvatar(req, res) {
  const user = await needUser(req);
  await db()`UPDATE users SET avatar_key = NULL WHERE id = ${user.id}`;
  if (user.avatar_key) await bunnyDelete(user.avatar_key);
  send(res, 200, { avatar: null });
}

async function getAvatar(req, res) {
  const name = new URL(req.url, "http://local").searchParams.get("k") || "";
  if (!AVATAR_NAME.test(name)) fail(404, "Not found.");
  const bytes = await bunnyGet(`${AVATAR_DIR}/${name}`);
  if (!bytes) fail(404, "Not found.");
  const ext = name.split(".").pop();
  res.statusCode = 200;
  res.setHeader("Content-Type", ext === "jpg" ? "image/jpeg" : `image/${ext}`);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(bytes);
}

async function savePrefs(req, res) {
  const user = await needUser(req);
  const b = await body(req);
  const clean = {};
  if (isMode(b.mode)) clean.mode = b.mode;
  if (METHODS.has(b.add_method)) clean.add_method = b.add_method;
  if (METHODS.has(b.withdraw_method)) clean.withdraw_method = b.withdraw_method;
  if (typeof b.withdraw_destination === "string") clean.withdraw_destination = b.withdraw_destination.trim().slice(0, 120);
  if (typeof b.mpesa_phone === "string" && /^[\d\s+]{9,16}$/.test(b.mpesa_phone.trim())) clean.mpesa_phone = b.mpesa_phone.trim();
  if (!Object.keys(clean).length) fail(400, "Nothing to save.");
  const [row] = await db()`UPDATE users SET prefs = COALESCE(prefs, '{}'::jsonb) || ${JSON.stringify(clean)}::jsonb
    WHERE id = ${user.id} RETURNING prefs`;
  send(res, 200, { prefs: row.prefs });
}

async function verifyStart(req, res) {
  const user = await needUser(req);
  send(res, 200, { url: await startKyc(user) });
}

async function verifyStatus(req, res) {
  let user = await needUser(req);
  if (!user.verified_at && user.kyc_session && !KYC_DONE.has(user.kyc_status)) user = await syncKyc(user);
  send(res, 200, {
    verified: Boolean(user.verified_at),
    kyc: user.verified_at ? "approved" : user.kyc_session ? user.kyc_status || "not_started" : "none",
  });
}

async function diditWebhook(req, res) {
  await kycWebhook(await body(req, 400000)).catch((err) => console.error("[didit] webhook", err));
  send(res, 200, { ok: true });
}

const METHODS = new Set(["PayPal", "Card", "M-Pesa"]);

async function addMoney(req, res) {
  const user = await needUser(req);
  const b = await body(req);
  const mode = isMode(b.mode) ? b.mode : fail(400, "Choose Sandbox or Live.");
  const usd = Number(b.usd);
  if (!Number.isInteger(usd) || usd < 1 || usd > 10000) fail(400, "Enter a whole amount from 1 to 10,000 USD.");
  const method = METHODS.has(b.method) ? b.method : fail(400, "Choose PayPal, Card, or M-Pesa.");
  if (mode === "live") {
    if (!user.verified_at) fail(403, "Verify your identity before adding live money.");
    fail(503, "Live top-ups through PayPal, card, and M-Pesa are not switched on yet. Your live balance can still receive payments and transfers.");
  }
  const amount = usd * 100;
  const sql = db();
  await sql.transaction([
    sql`UPDATE balances SET amount = amount + ${amount} WHERE user_id = ${user.id} AND mode = 'test'`,
    sql`INSERT INTO ledger (user_id, mode, kind, amount, counterparty, method) VALUES (${user.id}, 'test', 'add', ${amount}, 'Sandbox top-up', ${method})`,
  ]);
  send(res, 200, { ok: true });
}

async function sendMoney(req, res) {
  const user = await needUser(req);
  const b = await body(req);
  const mode = isMode(b.mode) ? b.mode : fail(400, "Choose Sandbox or Live.");
  const to = String(b.to || "").trim().toLowerCase();
  const amount = amountOf(b.amount);
  if (!isEmail(to)) fail(400, "Enter the email of a Nuru account.");
  if (to === user.email) fail(400, "You cannot send to yourself.");
  if (!amount) fail(400, "Enter an amount in NSH.");
  const sql = db();
  const [target] = await sql`SELECT id FROM users WHERE email = ${to}`;
  if (!target) fail(404, "No Nuru account uses that email. Ask them to sign up first.");
  const [done] = await sql`WITH debit AS (
      UPDATE balances SET amount = amount - ${amount}
      WHERE user_id = ${user.id} AND mode = ${mode} AND amount >= ${amount} RETURNING user_id
    ), credit AS (
      INSERT INTO balances (user_id, mode, amount) SELECT ${target.id}, ${mode}, ${amount} FROM debit
      ON CONFLICT (user_id, mode) DO UPDATE SET amount = balances.amount + EXCLUDED.amount RETURNING user_id
    ), out_row AS (
      INSERT INTO ledger (user_id, mode, kind, amount, counterparty) SELECT ${user.id}, ${mode}, 'send', ${-amount}, ${to} FROM debit
    ), in_row AS (
      INSERT INTO ledger (user_id, mode, kind, amount, counterparty) SELECT ${target.id}, ${mode}, 'receive', ${amount}, ${user.email} FROM debit
    ) SELECT count(*)::int AS n FROM debit`;
  if (!done.n) fail(400, "Your balance is too low for that amount.");
  send(res, 200, { ok: true });
}

async function withdraw(req, res) {
  const user = await needUser(req);
  const b = await body(req);
  const mode = isMode(b.mode) ? b.mode : fail(400, "Choose Sandbox or Live.");
  const amount = amountOf(b.amount);
  const method = METHODS.has(b.method) ? b.method : fail(400, "Choose PayPal, Card, or M-Pesa.");
  const destination = String(b.destination || "").trim().slice(0, 120);
  if (!amount) fail(400, "Enter an amount in NSH.");
  if (destination.length < 4) fail(400, `Enter your ${method === "M-Pesa" ? "M-Pesa phone number" : method === "PayPal" ? "PayPal email" : "card's last 4 digits"}.`);
  if (mode === "live" && !user.verified_at) fail(403, "Verify your identity before withdrawing. It’s free and done once.");
  if (mode === "live" && method === "PayPal") return send(res, 200, { ok: true, ...(await paypalWithdraw(user, amount, destination)) });
  const status = mode === "live" ? "pending" : "done";
  const id = newId("wd");
  const [done] = await db()`WITH debit AS (
      UPDATE balances SET amount = amount - ${amount}
      WHERE user_id = ${user.id} AND mode = ${mode} AND amount >= ${amount} RETURNING user_id
    ), w AS (
      INSERT INTO withdrawals (id, user_id, mode, method, amount, destination, status, paid_at)
      SELECT ${id}, user_id, ${mode}, ${method}, ${amount}, ${destination}, ${mode === "live" ? "pending" : "paid"}, CASE WHEN ${mode} = 'live' THEN NULL ELSE now() END FROM debit
    ), row AS (
      INSERT INTO ledger (user_id, mode, kind, amount, counterparty, method, status, ref)
      SELECT ${user.id}, ${mode}, 'withdraw', ${-amount}, ${destination}, ${method}, ${status}, ${id} FROM debit
    ) SELECT count(*)::int AS n FROM debit`;
  if (!done.n) fail(400, "Your balance is too low for that amount.");
  send(res, 200, { ok: true, status });
}

/* ---------- real top-ups: PayPal, card (PayPal guest checkout), M-Pesa (PayHero STK) ---------- */

const TOPUP_METHODS = new Set(["paypal", "card", "mpesa"]);

async function topupStart(req, res) {
  const user = await needUser(req);
  const b = await body(req);
  if (b.mode !== "live") fail(400, "Real payments are for Live. Sandbox top-ups are free test money.");
  const method = TOPUP_METHODS.has(b.method) ? b.method : fail(400, "Choose PayPal, Card, or M-Pesa.");
  const usd = Number(b.usd);
  if (!Number.isInteger(usd) || usd < 1 || usd > 10000) fail(400, "Enter a whole amount from 1 to 10,000 USD.");
  if (method === "mpesa" ? !payheroReady() : !paypalReady()) fail(503, `${method === "mpesa" ? "M-Pesa" : "PayPal"} is not available right now. Try another method.`);

  const sql = db();
  const [recent] = await sql`SELECT count(*)::int AS n FROM topups WHERE user_id = ${user.id} AND created_at > now() - interval '10 minutes'`;
  if (recent.n >= 8) fail(429, "Too many payment attempts. Wait a few minutes and try again.");

  const t = { id: newId("top"), user_id: user.id, mode: "live", method, usd, nsh: usd * 100, kes: null, phone: null };
  if (method === "mpesa") {
    t.phone = normalizePhone(b.phone);
    t.kes = usdToKes(usd);
    if (t.kes > 250000) fail(400, "M-Pesa allows up to KES 250,000 per payment. Use a smaller amount.");
  }
  await sql`INSERT INTO topups (id, user_id, mode, method, usd, nsh, kes, phone)
    VALUES (${t.id}, ${user.id}, 'live', ${method}, ${usd}, ${t.nsh}, ${t.kes}, ${t.phone})`;

  try {
    if (method === "mpesa") {
      const stk = await payheroStk(t);
      await sql`UPDATE topups SET provider_ref = ${t.id},
        meta = meta || ${JSON.stringify({ payhero_reference: stk.reference, checkout_request_id: stk.checkoutRequestId, stk_sent_at: new Date().toISOString() })}::jsonb
        WHERE id = ${t.id}`;
      return send(res, 200, { id: t.id, kes: t.kes, phone: publicTopup(t).phone });
    }
    const order = await paypalCreateOrder(t);
    await sql`UPDATE topups SET provider_ref = ${order.orderId} WHERE id = ${t.id}`;
    send(res, 200, { id: t.id, redirect: order.url });
  } catch (err) {
    await failTopup(t.id, err.message || "Could not start the payment.");
    throw err;
  }
}

async function ownTopup(req) {
  const user = await needUser(req);
  const id = new URL(req.url, "http://local").searchParams.get("id") || "";
  const [t] = await db()`SELECT * FROM topups WHERE id = ${id} AND user_id = ${user.id}`;
  if (!t) fail(404, "No payment with that id.");
  return t;
}

async function topupStatus(req, res) {
  let t = await ownTopup(req);
  if (t.status === "pending" && t.provider_ref) {
    const age = Date.now() - new Date(t.created_at).getTime();
    if (t.method === "mpesa" && age > 4000) t = await settleMpesa(t);
    else if (t.method !== "mpesa") t = await settlePaypal(t);
    if (t.status === "pending" && t.method === "mpesa" && age > 5 * 60000) {
      t = (await failTopup(t.id, "We did not get a confirmation from M-Pesa. If money left your account, contact support with this receipt number.")) || t;
    }
  }
  if (t.status === "paid") {
    const [bal] = await db()`SELECT amount FROM balances WHERE user_id = ${t.user_id} AND mode = ${t.mode}`;
    return send(res, 200, { ...publicTopup(t), balance: Number(bal?.amount || 0) });
  }
  send(res, 200, publicTopup(t));
}

function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader("Location", url);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

async function paypalReturn(req, res) {
  const url = new URL(req.url, "http://local");
  const id = url.searchParams.get("t") || "";
  const token = url.searchParams.get("token") || "";
  const [t] = await db()`SELECT * FROM topups WHERE id = ${id}`;
  if (t && t.provider_ref === token && t.status === "pending") {
    await settlePaypal(t).catch((err) => console.error("[paypal] return", err));
  }
  redirect(res, `${APP_URL}/dashboard?topup=${encodeURIComponent(id)}#add`);
}

async function paypalCancel(req, res) {
  const id = new URL(req.url, "http://local").searchParams.get("t") || "";
  await failTopup(id, "You cancelled the payment on PayPal.", "cancelled");
  redirect(res, `${APP_URL}/dashboard?topup=${encodeURIComponent(id)}#add`);
}

async function paypalWebhook(req, res) {
  const event = await body(req, 200000);
  const verified = await paypalVerifyWebhook(req, event).catch(() => false);
  if (verified === false) return send(res, 400, { error: "Signature check failed." });
  const r = event.resource || {};
  const sql = db();
  if (String(event.event_type || "").startsWith("PAYMENT.PAYOUTS")) {
    const batchId = r.payout_batch_id || r.batch_header?.payout_batch_id;
    const [w] = batchId ? await sql`SELECT * FROM withdrawals WHERE provider_ref = ${batchId}` : [];
    if (w) await settleWithdrawal(w);
    return send(res, 200, { ok: true });
  }
  const orderId = event.event_type === "CHECKOUT.ORDER.APPROVED" ? r.id : r.supplementary_data?.related_ids?.order_id;
  const [t] = orderId
    ? await sql`SELECT * FROM topups WHERE provider_ref = ${orderId}`
    : r.custom_id ? await sql`SELECT * FROM topups WHERE id = ${r.custom_id}` : [];
  if (t) {
    if (["CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"].includes(event.event_type)) {
      await settlePaypal(t);
    } else if (["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"].includes(event.event_type)) {
      await sql`UPDATE topups SET meta = meta || ${JSON.stringify({ reversed: event.event_type, reversed_at: event.create_time })}::jsonb WHERE id = ${t.id}`;
      console.warn("[paypal] capture reversed", t.id, event.event_type);
    }
  }
  send(res, 200, { ok: true });
}

async function payheroWebhook(req, res) {
  const raw = await body(req, 100000);
  const p = raw.response && typeof raw.response === "object" ? { ...raw, ...raw.response } : raw;
  const ref = String(p.ExternalReference || p.external_reference || p.reference || "");
  const [t] = ref ? await db()`SELECT * FROM topups WHERE id = ${ref} AND method = 'mpesa'` : [];
  if (!t || t.status === "paid") return send(res, 200, { ok: true });

  const code = Number(p.ResultCode ?? p.result_code ?? -1);
  let settled = t;
  for (let i = 0; i < 3 && settled.status !== "paid" && settled.status !== "cancelled"; i++) {
    if (i) await new Promise((r) => setTimeout(r, 2000));
    settled = await settleMpesa(settled);
  }
  // A callback alone never credits money: only PayHero's own status record can. A failure code may close it.
  if (settled.status === "pending" && code > 0) await failTopup(t.id, mpesaReason(code, p.ResultDesc));
  send(res, 200, { ok: true });
}

/* ---------- business tools (session) ---------- */

async function devOverview(req, res, mode) {
  const user = await needUser(req);
  const sql = db();
  const [payments, events] = await Promise.all([
    sql`SELECT * FROM payments WHERE merchant_id = ${user.id} AND mode = ${mode} ORDER BY created_at DESC LIMIT 20`,
    sql`SELECT id, type, payment_id, delivery_status, created_at FROM events WHERE user_id = ${user.id} AND mode = ${mode} ORDER BY created_at DESC LIMIT 20`,
  ]);
  send(res, 200, { payments: payments.map(publicPayment), events });
}

async function rollKey(req, res) {
  const user = await needUser(req);
  const b = await body(req);
  const mode = isMode(b.mode) ? b.mode : fail(400, "Choose Sandbox or Live.");
  if (mode === "live" && !user.verified_at) fail(403, "Verify your identity to get a live key.");
  const key = `nsh_${mode}_${secret(24)}`;
  const sql = db();
  await sql.transaction([
    sql`UPDATE api_keys SET revoked_at = now() WHERE user_id = ${user.id} AND mode = ${mode} AND revoked_at IS NULL`,
    sql`INSERT INTO api_keys (user_id, mode, key_hash, last4) VALUES (${user.id}, ${mode}, ${sha(key)}, ${key.slice(-4)})`,
  ]);
  send(res, 200, { key, mode });
}

async function setWebhook(user, mode, url) {
  const clean = String(url || "").trim();
  if (clean && !safeWebhook(clean)) fail(400, "Use a public https URL, for example https://your-site.com/nuru.");
  const sql = db();
  if (mode === "live") await sql`UPDATE users SET webhook_live = ${clean || null} WHERE id = ${user.id}`;
  else await sql`UPDATE users SET webhook_test = ${clean || null} WHERE id = ${user.id}`;
  return clean || null;
}

async function devWebhook(req, res) {
  const user = await needUser(req);
  const b = await body(req);
  const mode = isMode(b.mode) ? b.mode : fail(400, "Choose Sandbox or Live.");
  send(res, 200, { url: await setWebhook(user, mode, b.url) });
}

async function devWebhookTest(req, res) {
  const user = await needUser(req);
  const b = await body(req);
  const mode = isMode(b.mode) ? b.mode : fail(400, "Choose Sandbox or Live.");
  send(res, 200, await deliver(user.id, mode, "webhook.test", null));
}

/* ---------- payments ---------- */

async function createPayment(user, mode, b) {
  const amount = amountOf(b.amount);
  const company = String(b.company || "").trim().slice(0, 80);
  const reference = String(b.reference || "").trim().slice(0, 100) || null;
  if (!amount) fail(400, "amount must be a whole number of NSH as a string, for example \"1800\".");
  if (b.unit && b.unit !== "NSH") fail(400, "unit must be NSH.");
  if (!company) fail(400, "company is required. It is the name the buyer sees.");
  const sql = db();
  const id = newId("pay");
  const f = fee(amount);
  if (mode === "test") {
    const [p] = await sql`WITH p AS (
        INSERT INTO payments (id, merchant_id, mode, amount, fee, reference, company, status, paid_at)
        VALUES (${id}, ${user.id}, 'test', ${amount}, ${f}, ${reference}, ${company}, 'paid', now()) RETURNING *
      ), c AS (
        UPDATE balances SET amount = amount + ${amount - f} WHERE user_id = ${user.id} AND mode = 'test'
      ), l AS (
        INSERT INTO ledger (user_id, mode, kind, amount, counterparty, ref) VALUES (${user.id}, 'test', 'payment', ${amount - f}, ${company}, ${id})
      ) SELECT * FROM p`;
    await deliver(user.id, "test", "payment.paid", p);
    return p;
  }
  const [p] = await sql`INSERT INTO payments (id, merchant_id, mode, amount, fee, reference, company, status)
    VALUES (${id}, ${user.id}, 'live', ${amount}, ${f}, ${reference}, ${company}, 'pending') RETURNING *`;
  return p;
}

async function refund(user, mode, paymentId) {
  const sql = db();
  const id = String(paymentId || "");
  const [p] = await sql`SELECT * FROM payments WHERE id = ${id} AND merchant_id = ${user.id} AND mode = ${mode}`;
  if (!p) fail(404, "No payment with that id.");
  if (p.status !== "paid") fail(400, `Only a paid payment can be refunded. This one is ${p.status}.`);
  const net = Number(p.amount) - Number(p.fee);
  const [done] = await sql`WITH m AS (
      UPDATE balances SET amount = amount - ${net}
      WHERE user_id = ${user.id} AND mode = ${mode} AND amount >= ${net}
        AND EXISTS (SELECT 1 FROM payments WHERE id = ${id} AND status = 'paid' FOR UPDATE) RETURNING user_id
    ), r AS (
      UPDATE payments SET status = 'refunded', refunded_at = now() WHERE id = ${id} AND status = 'paid' AND EXISTS (SELECT 1 FROM m) RETURNING id
    ), b AS (
      UPDATE balances SET amount = amount + ${Number(p.amount)}
      WHERE user_id = ${p.payer_id} AND mode = ${mode} AND EXISTS (SELECT 1 FROM m) RETURNING user_id
    ), lm AS (
      INSERT INTO ledger (user_id, mode, kind, amount, counterparty, ref) SELECT ${user.id}, ${mode}, 'refund', ${-net}, ${p.company}, ${id} FROM m
    ), lb AS (
      INSERT INTO ledger (user_id, mode, kind, amount, counterparty, ref) SELECT ${p.payer_id}, ${mode}, 'refund', ${Number(p.amount)}, ${p.company}, ${id} FROM b
    ) SELECT (SELECT count(*) FROM m)::int AS n`;
  if (!done.n) fail(400, "Your balance is too low to refund this payment.");
  const [after] = await sql`SELECT * FROM payments WHERE id = ${id}`;
  await deliver(user.id, mode, "payment.refunded", after);
  return after;
}

async function devPayment(req, res) {
  const user = await needUser(req);
  const b = await body(req);
  const mode = isMode(b.mode) ? b.mode : fail(400, "Choose Sandbox or Live.");
  if (mode === "live" && !user.verified_at) fail(403, "Verify your identity first.");
  send(res, 200, publicPayment(await createPayment(user, mode, b)));
}

async function devRefund(req, res) {
  const user = await needUser(req);
  const b = await body(req);
  const mode = isMode(b.mode) ? b.mode : fail(400, "Choose Sandbox or Live.");
  send(res, 200, publicPayment(await refund(user, mode, b.payment)));
}

/* ---------- checkout (buyer pays a live payment) ---------- */

async function checkoutGet(req, res) {
  const id = new URL(req.url, "http://local").searchParams.get("id") || "";
  const [p] = await db()`SELECT id, company, amount, status, mode FROM payments WHERE id = ${id}`;
  if (!p) fail(404, "This payment does not exist.");
  send(res, 200, { id: p.id, company: p.company, amount: String(p.amount), unit: "NSH", status: p.status, mode: p.mode });
}

async function checkoutPay(req, res) {
  const user = await needUser(req);
  const b = await body(req);
  const id = String(b.id || "");
  const sql = db();
  const [p] = await sql`SELECT * FROM payments WHERE id = ${id} AND mode = 'live'`;
  if (!p) fail(404, "This payment does not exist.");
  if (p.status !== "pending") fail(400, `This payment is already ${p.status}.`);
  if (p.merchant_id === user.id) fail(400, "You cannot pay your own payment.");
  const amount = Number(p.amount);
  const net = amount - Number(p.fee);
  const [done] = await sql`WITH debit AS (
      UPDATE balances SET amount = amount - ${amount}
      WHERE user_id = ${user.id} AND mode = 'live' AND amount >= ${amount}
        AND EXISTS (SELECT 1 FROM payments WHERE id = ${id} AND status = 'pending' FOR UPDATE) RETURNING user_id
    ), pay AS (
      UPDATE payments SET status = 'paid', payer_id = ${user.id}, paid_at = now()
      WHERE id = ${id} AND status = 'pending' AND EXISTS (SELECT 1 FROM debit) RETURNING id
    ), credit AS (
      UPDATE balances SET amount = amount + ${net} WHERE user_id = ${p.merchant_id} AND mode = 'live' AND EXISTS (SELECT 1 FROM pay)
    ), l1 AS (
      INSERT INTO ledger (user_id, mode, kind, amount, counterparty, ref) SELECT ${user.id}, 'live', 'pay', ${-amount}, ${p.company}, ${id} FROM pay
    ), l2 AS (
      INSERT INTO ledger (user_id, mode, kind, amount, counterparty, ref) SELECT ${p.merchant_id}, 'live', 'payment', ${net}, ${p.company}, ${id} FROM pay
    ) SELECT (SELECT count(*) FROM debit)::int AS debited, (SELECT count(*) FROM pay)::int AS paid`;
  if (!done.debited) fail(400, "Your live balance is too low for this payment.");
  if (!done.paid) fail(409, "This payment was just completed elsewhere. Refresh the page.");
  const [after] = await sql`SELECT * FROM payments WHERE id = ${id}`;
  await deliver(p.merchant_id, "live", "payment.paid", after);
  send(res, 200, { ok: true, status: "paid" });
}

/* ---------- public API: /v1 ---------- */

async function v1(req, res, parts) {
  const user = await keyUser(req);
  const mode = user.mode;
  const [resource, id] = parts;
  if (resource === "connections") return await v1Connections(req, res, user, parts.slice(1));
  if (resource === "deposits") return await v1Deposits(req, res, user, parts.slice(1));
  if (resource === "payments" && !id && req.method === "POST") {
    return send(res, 200, publicPayment(await createPayment(user, mode, await body(req))));
  }
  if (resource === "payments" && id && req.method === "GET") {
    const [p] = await db()`SELECT * FROM payments WHERE id = ${id} AND merchant_id = ${user.id} AND mode = ${mode}`;
    if (!p) fail(404, "No payment with that id.");
    return send(res, 200, publicPayment(p));
  }
  if (resource === "refunds" && req.method === "POST") {
    const b = await body(req);
    return send(res, 200, publicPayment(await refund(user, mode, b.payment)));
  }
  if (resource === "webhooks" && !id && req.method === "POST") {
    const b = await body(req);
    return send(res, 200, { url: await setWebhook(user, mode, b.url), mode });
  }
  if (resource === "webhooks" && !id && req.method === "GET") {
    return send(res, 200, { url: mode === "live" ? user.webhook_live : user.webhook_test, mode });
  }
  if (resource === "webhooks" && id === "test" && req.method === "POST") {
    return send(res, 200, await deliver(user.id, mode, "webhook.test", null));
  }
  fail(404, "Unknown route. See https://norashillings.benuru.com/docs#endpoints");
}

/* ---------- router ---------- */

export default async function handler(req, res) {
  const route = routeOf(req);
  const url = new URL(req.url, "http://local");
  const mode = isMode(url.searchParams.get("mode")) ? url.searchParams.get("mode") : "test";
  const post = req.method === "POST";
  try {
    if (route.startsWith("v1/")) return await v1(req, res, route.slice(3).split("/").filter(Boolean));
    if (route === "auth/start" && post) return await authStart(req, res);
    if (route === "auth/verify" && post) return await authVerify(req, res);
    if (route === "auth/logout" && post) return await authLogout(req, res);
    if (route === "me" && req.method === "GET") return await me(req, res, mode);
    if (route === "wallet/verify/start" && post) return await verifyStart(req, res);
    if (route === "wallet/verify/status" && req.method === "GET") return await verifyStatus(req, res);
    if (route === "webhooks/didit" && post) return await diditWebhook(req, res);
    if (route === "profile/avatar" && post) return await setAvatar(req, res);
    if (route === "profile/avatar/remove" && post) return await removeAvatar(req, res);
    if (route === "profile/prefs" && post) return await savePrefs(req, res);
    if (route === "avatar" && req.method === "GET") return await getAvatar(req, res);
    if (route === "topup/start" && post) return await topupStart(req, res);
    if (route === "topup/status" && req.method === "GET") return await topupStatus(req, res);
    if (route === "topup/paypal/return" && req.method === "GET") return await paypalReturn(req, res);
    if (route === "topup/paypal/cancel" && req.method === "GET") return await paypalCancel(req, res);
    if (route === "webhooks/paypal" && post) return await paypalWebhook(req, res);
    if (route === "webhooks/payhero" && post) return await payheroWebhook(req, res);
    if (route === "wallet/add" && post) return await addMoney(req, res);
    if (route === "wallet/send" && post) return await sendMoney(req, res);
    if (route === "wallet/withdraw" && post) return await withdraw(req, res);
    if (route === "dev/overview" && req.method === "GET") return await devOverview(req, res, mode);
    if (route === "dev/keys" && post) return await rollKey(req, res);
    if (route === "dev/webhook" && post) return await devWebhook(req, res);
    if (route === "dev/webhook/test" && post) return await devWebhookTest(req, res);
    if (route === "dev/payment" && post) return await devPayment(req, res);
    if (route === "dev/refund" && post) return await devRefund(req, res);
    if (route === "checkout" && req.method === "GET") return await checkoutGet(req, res);
    if (route === "checkout/pay" && post) return await checkoutPay(req, res);
    const appRoute = appsHandler(req.method, route);
    if (appRoute) return await appRoute(req, res, { needUser, sessionUser });
    send(res, 404, { error: "Not found." });
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error("[nsh]", route, err);
    send(res, 500, { error: "Something went wrong. Try again." });
  }
}
