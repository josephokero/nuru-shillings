import {
  db, send, fail, body, cookie, sessionCookie, clientIp, isEmail, isMode, amountOf, safeWebhook,
  sha, secret, newId, fee, mailLink, deliver, publicPayment, HttpError,
  APP_URL, SESSION_COOKIE, SESSION_DAYS, SANDBOX_START,
} from "./_lib.js";

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
  const [user] = await sql`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${sha(token)} AND s.expires_at > now()`;
  return user || null;
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
  const [balances, activity, keys] = await Promise.all([
    sql`SELECT mode, amount FROM balances WHERE user_id = ${user.id}`,
    sql`SELECT kind, amount, counterparty, method, status, ref, created_at FROM ledger
      WHERE user_id = ${user.id} AND mode = ${mode} ORDER BY created_at DESC, id DESC LIMIT 30`,
    sql`SELECT mode, last4, created_at FROM api_keys WHERE user_id = ${user.id} AND revoked_at IS NULL`,
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
    balances: bal,
    activity: activity.map((a) => ({ ...a, amount: Number(a.amount) })),
    keys: keyMap,
    webhooks: { test: user.webhook_test, live: user.webhook_live },
  });
}

async function verify(req, res) {
  const user = await needUser(req);
  const b = await body(req);
  const name = String(b.name || "").trim().replace(/\s+/g, " ");
  const country = String(b.country || "").trim();
  if (name.length < 3 || name.length > 80 || !name.includes(" ")) fail(400, "Enter your first and last name.");
  if (country.length < 2 || country.length > 60) fail(400, "Choose your country.");
  await db()`UPDATE users SET name = ${name}, country = ${country}, verified_at = COALESCE(verified_at, now()) WHERE id = ${user.id}`;
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
    if (!user.verified_at) fail(403, "Verify your name and country before adding live money.");
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
  if (mode === "live" && !user.verified_at) fail(403, "Verify your name and country before sending live money.");
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
  if (mode === "live" && !user.verified_at) fail(403, "Verify your name and country before withdrawing.");
  const status = mode === "live" ? "pending" : "done";
  const [done] = await db()`WITH debit AS (
      UPDATE balances SET amount = amount - ${amount}
      WHERE user_id = ${user.id} AND mode = ${mode} AND amount >= ${amount} RETURNING user_id
    ), row AS (
      INSERT INTO ledger (user_id, mode, kind, amount, counterparty, method, status)
      SELECT ${user.id}, ${mode}, 'withdraw', ${-amount}, ${destination}, ${method}, ${status} FROM debit
    ) SELECT count(*)::int AS n FROM debit`;
  if (!done.n) fail(400, "Your balance is too low for that amount.");
  send(res, 200, { ok: true, status });
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
  if (mode === "live" && !user.verified_at) fail(403, "Verify your name and country to get a live key.");
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
  if (mode === "live" && !user.verified_at) fail(403, "Verify your name and country first.");
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
  if (!user.verified_at) fail(403, "Verify your name and country in your wallet before paying.");
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
    if (route === "wallet/verify" && post) return await verify(req, res);
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
    send(res, 404, { error: "Not found." });
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error("[nsh]", route, err);
    send(res, 500, { error: "Something went wrong. Try again." });
  }
}
