import {
  db, send, fail, body, isMode, amountOf, safeWebhook, sha, secret, newId, fee, mailDeposit, HttpError, APP_URL,
} from "./_lib.js";

export const SCOPES = ["deposits"];
const MAX_URIS = 5;
const DEPOSIT_MINUTES = 30;

class AppError extends HttpError {
  constructor(status, code, message) {
    super(status, message);
    this.code = code;
  }
}
const refuse = (status, code, message) => { throw new AppError(status, code, message); };

const domainOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; } };
const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

function redirectOk(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (uri.length > 400 || u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
}

function websiteOf(v) {
  const raw = String(v || "").trim();
  if (!raw) return null;
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(url);
    if (!["https:", "http:"].includes(u.protocol) || !u.hostname.includes(".")) throw 0;
    return u.origin;
  } catch {
    return fail(400, "Enter your website, for example https://your-site.com.");
  }
}

function urisOf(v) {
  const list = (Array.isArray(v) ? v : String(v || "").split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) fail(400, "Add at least one return URL, for example https://your-site.com/nuru/callback.");
  if (list.length > MAX_URIS) fail(400, `Use up to ${MAX_URIS} return URLs.`);
  for (const uri of list) if (!redirectOk(uri)) fail(400, `${uri} is not a valid return URL. Use https (or http://localhost while testing), with no #fragment.`);
  return [...new Set(list)];
}

const colorOf = (v) => {
  const s = String(v || "").trim();
  if (!s) return null;
  return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : fail(400, "Brand colour must be a hex colour like #4f46e5.");
};
const themeOf = (v) => (v === "light" ? "light" : "dark");
const logoOf = (v) => {
  const s = String(v || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol === "https:" && s.length <= 300) return s;
  } catch { /* falls through */ }
  return fail(400, "Logo must be an https image link, for example https://your-site.com/logo.png.");
};
const brandOf = (a) => ({ color: a.brand_color || null, theme: a.theme === "light" ? "light" : "dark", logo: a.logo_url || null });

async function emit(ownerId, mode, type, data) {
  const sql = db();
  const event = { id: newId("evt"), type, created: new Date().toISOString(), data };
  const [owner] = await sql`SELECT webhook_test, webhook_live FROM users WHERE id = ${ownerId}`;
  const url = mode === "live" ? owner?.webhook_live : owner?.webhook_test;
  let status = null;
  if (url && safeWebhook(url)) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "NuruShillings-Webhooks/1", "Nuru-Event-Id": event.id },
        body: JSON.stringify(event),
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      status = r.status;
    } catch {
      status = 0;
    }
  }
  await sql`INSERT INTO events (id, user_id, mode, type, payment_id, payload, delivery_status)
    VALUES (${event.id}, ${ownerId}, ${mode}, ${type}, ${null}, ${JSON.stringify(event)}, ${status})`;
}

function publicConnection(c) {
  return {
    id: c.id,
    object: "connection",
    status: c.revoked_at ? "disconnected" : "active",
    mode: c.mode,
    app: c.app_id,
    user: { name: c.user_name || null, email: c.user_email },
    created: c.created_at,
    disconnected: c.revoked_at || null,
  };
}

const statusOf = (d) => (d.status === "pending" && new Date(d.expires_at) <= new Date() ? "expired" : d.status);

function publicDeposit(d) {
  const status = statusOf(d);
  return {
    id: d.id,
    object: "deposit",
    status,
    mode: d.mode,
    app: d.app_id,
    amount: String(d.amount),
    unit: "NSH",
    fee: String(d.fee),
    net: String(Number(d.amount) - Number(d.fee)),
    reference: d.reference,
    description: d.description,
    connection: d.connection_id || null,
    user: d.user_email ? { name: d.user_name || null, email: d.user_email } : null,
    url: status === "pending" ? `${APP_URL}/deposit?id=${d.id}` : null,
    return_url: d.return_url || null,
    created: d.created_at,
    expires: d.expires_at,
    completed: d.completed_at || null,
  };
}

function backTo(d, status) {
  if (!d.return_url) return null;
  const url = new URL(d.return_url);
  url.searchParams.set("deposit", d.id);
  url.searchParams.set("status", status);
  if (d.reference) url.searchParams.set("reference", d.reference);
  return url.toString();
}

/* ---------- consent screen: connect without a deposit ---------- */

async function loadApp(id) {
  const [app] = await db()`SELECT * FROM apps WHERE id = ${String(id || "")} AND deleted_at IS NULL`;
  return app || fail(404, "This app does not exist or was removed by its developer.");
}

function checkRequest(app, q) {
  const redirect = String(q.redirect_uri || "");
  if (!app.redirect_uris.includes(redirect)) fail(400, "This link’s return address is not registered for the app, so we stopped here to keep your wallet safe.");
  return { redirect, mode: q.mode === "live" ? "live" : "test" };
}

const appInfo = (app) => ({ id: app.id, name: app.name, website: app.website, domain: domainOf(app.website), brand: brandOf(app) });

async function activeConnection(appId, userId, mode) {
  const [c] = await db()`SELECT * FROM connections WHERE app_id = ${appId} AND user_id = ${userId} AND mode = ${mode} AND revoked_at IS NULL`;
  return c || null;
}

async function connectInfo(req, res, { sessionUser }) {
  const q = Object.fromEntries(new URL(req.url, "http://local").searchParams);
  const [app, user] = await Promise.all([loadApp(q.app), sessionUser(req)]);
  const { redirect, mode } = checkRequest(app, q);
  const existing = user ? await activeConnection(app.id, user.id, mode) : null;
  send(res, 200, {
    app: appInfo(app),
    mode,
    scopes: SCOPES,
    redirect_uri: redirect,
    redirect_domain: domainOf(redirect),
    user: user ? { email: user.email, name: user.name, verified: Boolean(user.verified_at), own: user.id === app.owner_id } : null,
    existing: Boolean(existing),
  });
}

async function connect(app, user, mode) {
  const [c] = await db()`INSERT INTO connections (id, app_id, user_id, mode, scopes, daily_limit)
    VALUES (${newId("con")}, ${app.id}, ${user.id}, ${mode}, ${SCOPES}, 0)
    ON CONFLICT (app_id, user_id, mode) WHERE revoked_at IS NULL
    DO UPDATE SET scopes = EXCLUDED.scopes
    RETURNING *, (xmax = 0) AS created`;
  if (c.created) {
    await emit(app.owner_id, mode, "connection.created", publicConnection({ ...c, user_email: user.email, user_name: user.name }))
      .catch((err) => console.error("[apps] emit", err));
  }
  return c;
}

async function connectApprove(req, res, { needUser }) {
  const user = await needUser(req);
  const b = await body(req);
  const app = await loadApp(b.app);
  const { redirect, mode } = checkRequest(app, b);
  if (mode === "live" && user.id === app.owner_id) fail(400, "This is your own app. Connect a different Nuru account to it.");
  const c = await connect(app, user, mode);
  const code = secret(24);
  await db()`INSERT INTO connect_codes (code_hash, connection_id, expires_at) VALUES (${sha(code)}, ${c.id}, now() + interval '10 minutes')`;
  const back = new URL(redirect);
  back.searchParams.set("code", code);
  if (b.state) back.searchParams.set("state", String(b.state).slice(0, 200));
  send(res, 200, { redirect: back.toString(), app: app.name });
}

/* ---------- deposit popup: the user confirms or declines ---------- */

async function loadDeposit(id) {
  const [d] = await db()`SELECT d.*, a.name AS app_name, a.website, a.redirect_uris, a.brand_color, a.theme, a.logo_url, a.deleted_at AS app_deleted,
      c.user_id AS pinned_user, c.revoked_at AS pinned_revoked
    FROM deposits d JOIN apps a ON a.id = d.app_id LEFT JOIN connections c ON c.id = d.connection_id
    WHERE d.id = ${String(id || "")}`;
  return d || fail(404, "This deposit link does not exist. Go back to the app and try again.");
}

const originsOf = (d) => [...new Set([d.website, ...d.redirect_uris].map(originOf).filter(Boolean))];

function blockReason(d, user) {
  const status = statusOf(d);
  if (d.app_deleted) return "This app was removed by its developer.";
  if (status === "expired") return "This deposit request expired. Go back to the app and start again.";
  if (status !== "pending") return null;
  if (d.connection_id && d.pinned_revoked) return "You disconnected this app. Go back to the app and connect again.";
  if (user && d.pinned_user && d.pinned_user !== user.id) return "This deposit was started for a different Nuru account. Log in with that account, or start again in the app.";
  if (user && d.mode === "live" && user.id === d.owner_id) return "This is your own app. Use a different Nuru account to add money to it.";
  return null;
}

async function depositInfo(req, res, { sessionUser }) {
  const id = new URL(req.url, "http://local").searchParams.get("id");
  const [d, user] = await Promise.all([loadDeposit(id), sessionUser(req)]);
  let me = null;
  if (user) {
    const [[bal], connected] = await Promise.all([
      db()`SELECT amount FROM balances WHERE user_id = ${user.id} AND mode = ${d.mode}`,
      activeConnection(d.app_id, user.id, d.mode),
    ]);
    me = {
      email: user.email,
      name: user.name,
      verified: Boolean(user.verified_at),
      balance: Number(bal?.amount || 0),
      connected: Boolean(connected),
    };
  }
  send(res, 200, {
    id: d.id,
    status: statusOf(d),
    mode: d.mode,
    amount: Number(d.amount),
    reference: d.reference,
    description: d.description,
    expires: d.expires_at,
    app: { name: d.app_name, website: d.website, domain: domainOf(d.website), brand: brandOf(d) },
    origins: originsOf(d),
    return_url: d.return_url ? backTo(d, statusOf(d)) : null,
    blocked: blockReason(d, user),
    user: me,
  });
}

async function depositConfirm(req, res, { needUser }) {
  const user = await needUser(req);
  const d = await loadDeposit((await body(req)).id);
  const blocked = blockReason(d, user);
  if (blocked) fail(400, blocked);
  if (statusOf(d) !== "pending") fail(409, `This deposit is already ${statusOf(d)}.`);
  const amount = Number(d.amount);
  const net = amount - Number(d.fee);
  const sql = db();
  const [bal] = await sql`SELECT amount FROM balances WHERE user_id = ${user.id} AND mode = ${d.mode}`;
  if (Number(bal?.amount || 0) < amount) fail(402, "Your wallet balance is too low for this deposit. Add money to your wallet, then try again.");

  const c = await connect({ id: d.app_id, owner_id: d.owner_id }, user, d.mode);
  const [, [r]] = await sql.transaction([
    sql`SELECT id FROM deposits WHERE id = ${d.id} FOR UPDATE`,
    sql`WITH debit AS (
        UPDATE balances SET amount = amount - ${amount}
        WHERE user_id = ${user.id} AND mode = ${d.mode} AND amount >= ${amount}
          AND EXISTS (SELECT 1 FROM deposits WHERE id = ${d.id} AND status = 'pending' AND expires_at > now())
        RETURNING amount
      ), dep AS (
        UPDATE deposits SET status = 'succeeded', user_id = ${user.id}, connection_id = ${c.id}, completed_at = now()
        WHERE id = ${d.id} AND EXISTS (SELECT 1 FROM debit) RETURNING id
      ), credit AS (
        INSERT INTO balances (user_id, mode, amount) SELECT ${d.owner_id}, ${d.mode}, ${net} FROM dep
        ON CONFLICT (user_id, mode) DO UPDATE SET amount = balances.amount + EXCLUDED.amount
      ), mv AS (
        INSERT INTO app_moves (id, connection_id, kind, amount, fee, reference, description)
        SELECT ${d.id}, ${c.id}, 'deposit', ${amount}, ${Number(d.fee)}, ${d.reference}, ${d.description} FROM dep
      ), l1 AS (
        INSERT INTO ledger (user_id, mode, kind, amount, counterparty, ref)
        SELECT ${user.id}, ${d.mode}, 'app_deposit', ${-amount}, ${d.app_name}, ${d.id} FROM dep
      ), l2 AS (
        INSERT INTO ledger (user_id, mode, kind, amount, counterparty, ref)
        SELECT ${d.owner_id}, ${d.mode}, 'app_deposit_in', ${net}, ${user.email}, ${d.id} FROM dep
      ), touch AS (
        UPDATE connections SET last_used_at = now() WHERE id = ${c.id} AND EXISTS (SELECT 1 FROM dep)
      ) SELECT (SELECT count(*) FROM dep)::int AS n, (SELECT amount FROM debit) AS balance`,
  ]);
  if (!r.n) {
    const [now] = await sql`SELECT status, expires_at FROM deposits WHERE id = ${d.id}`;
    if (statusOf(now) !== "pending") fail(409, `This deposit is already ${statusOf(now)}.`);
    fail(402, "Your wallet balance is too low for this deposit. Add money to your wallet, then try again.");
  }

  const done = { ...d, status: "succeeded", user_id: user.id, connection_id: c.id, completed_at: new Date().toISOString(), user_email: user.email, user_name: user.name };
  const [owner] = await sql`SELECT email FROM users WHERE id = ${d.owner_id}`;
  const mail = { id: d.id, mode: d.mode, app: d.app_name, amount, fee: Number(d.fee), reference: d.reference, completed: done.completed_at };
  await Promise.allSettled([
    mailDeposit(user.email, { ...mail, balance: Number(r.balance) }, "payer"),
    owner && mailDeposit(owner.email, { ...mail, user: user.name || user.email }, "owner"),
    emit(d.owner_id, d.mode, "deposit.succeeded", publicDeposit(done)),
  ]).then((all) => all.forEach((x) => x.status === "rejected" && console.error("[apps] after deposit", x.reason)));

  send(res, 200, { status: "succeeded", id: d.id, amount, balance: Number(r.balance), app: d.app_name, return_url: backTo(d, "succeeded") });
}

async function depositDecline(req, res, { needUser }) {
  const user = await needUser(req);
  const d = await loadDeposit((await body(req)).id);
  if (d.pinned_user && d.pinned_user !== user.id) fail(403, "This deposit was started for a different Nuru account.");
  const [row] = await db()`UPDATE deposits SET status = 'declined', user_id = ${user.id}, completed_at = now()
    WHERE id = ${d.id} AND status = 'pending' RETURNING *`;
  if (row) {
    await emit(d.owner_id, d.mode, "deposit.declined", publicDeposit({ ...row, user_email: user.email, user_name: user.name }))
      .catch((err) => console.error("[apps] emit", err));
  }
  send(res, 200, { status: row ? "declined" : statusOf(d), return_url: backTo(d, "declined") });
}

/* ---------- wallet: connected apps ---------- */

async function connectedApps(req, res, { needUser }) {
  const user = await needUser(req);
  const asked = new URL(req.url, "http://local").searchParams.get("mode");
  const mode = isMode(asked) ? asked : "live";
  const sql = db();
  const rows = await sql`SELECT c.*, a.name AS app_name, a.website AS app_website, a.brand_color, a.theme, a.logo_url,
      COALESCE(sum(m.amount) FILTER (WHERE m.kind = 'deposit'), 0)::bigint AS added,
      count(m.id) FILTER (WHERE m.kind = 'deposit')::int AS deposits,
      max(m.created_at) AS last_move
    FROM connections c JOIN apps a ON a.id = c.app_id
    LEFT JOIN app_moves m ON m.connection_id = c.id
    WHERE c.user_id = ${user.id} AND c.mode = ${mode} AND c.revoked_at IS NULL AND a.deleted_at IS NULL
    GROUP BY c.id, a.name, a.website, a.brand_color, a.theme, a.logo_url ORDER BY COALESCE(max(m.created_at), c.created_at) DESC`;
  const ids = rows.map((r) => r.id);
  const moves = ids.length ? await sql`SELECT * FROM (
      SELECT m.*, row_number() OVER (PARTITION BY connection_id ORDER BY created_at DESC) AS n FROM app_moves m WHERE connection_id = ANY(${ids})
    ) t WHERE n <= 5 ORDER BY created_at DESC` : [];
  send(res, 200, {
    mode,
    apps: rows.map((r) => ({
      id: r.id,
      name: r.app_name,
      website: r.app_website,
      domain: domainOf(r.app_website),
      brand: brandOf(r),
      totals: { added: Number(r.added), deposits: r.deposits },
      connected: r.created_at,
      last_used: r.last_move || r.last_used_at || null,
      recent: moves.filter((m) => m.connection_id === r.id).map((m) => ({
        kind: m.kind, amount: Number(m.amount), description: m.description, reference: m.reference, created: m.created_at,
      })),
    })),
  });
}

async function disconnect(req, res, { needUser }) {
  const user = await needUser(req);
  const id = String((await body(req)).id || "");
  const [c] = await db()`SELECT c.*, a.owner_id FROM connections c JOIN apps a ON a.id = c.app_id WHERE c.id = ${id} AND c.user_id = ${user.id}`;
  if (!c) fail(404, "That app is not connected to your wallet.");
  if (c.revoked_at) return send(res, 200, { ok: true });
  const [done] = await db()`UPDATE connections SET revoked_at = now() WHERE id = ${c.id} AND revoked_at IS NULL RETURNING *`;
  if (done) {
    await db()`UPDATE deposits SET status = 'declined', completed_at = now() WHERE connection_id = ${c.id} AND status = 'pending'`;
    await emit(c.owner_id, c.mode, "connection.revoked", publicConnection({ ...done, user_email: user.email, user_name: user.name }))
      .catch((err) => console.error("[apps] emit", err));
  }
  send(res, 200, { ok: true });
}

/* ---------- business tools: the developer's apps ---------- */

async function devApps(req, res, { needUser }) {
  const user = await needUser(req);
  const rows = await db()`SELECT a.*,
      (SELECT count(*) FROM connections c WHERE c.app_id = a.id AND c.mode = 'test' AND c.revoked_at IS NULL)::int AS users_test,
      (SELECT count(*) FROM connections c WHERE c.app_id = a.id AND c.mode = 'live' AND c.revoked_at IS NULL)::int AS users_live,
      (SELECT COALESCE(sum(d.amount), 0) FROM deposits d WHERE d.app_id = a.id AND d.mode = 'live' AND d.status = 'succeeded')::bigint AS live_total
    FROM apps a WHERE a.owner_id = ${user.id} AND a.deleted_at IS NULL ORDER BY a.created_at`;
  send(res, 200, {
    apps: rows.map((a) => ({
      id: a.id, name: a.name, website: a.website, redirect_uris: a.redirect_uris, created: a.created_at, brand: brandOf(a),
      users: { test: a.users_test, live: a.users_live },
      live_total: Number(a.live_total),
    })),
    connect_base: `${APP_URL}/connect`,
    sdk: `${APP_URL}/nuru.js`,
  });
}

async function devAppSave(req, res, { needUser }) {
  const user = await needUser(req);
  const b = await body(req);
  const name = String(b.name || "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 60) fail(400, "Give your app a name people will recognise (2 to 60 characters).");
  const website = websiteOf(b.website);
  const uris = urisOf(b.redirect_uris);
  const color = colorOf(b.brand_color);
  const theme = themeOf(b.theme);
  const logo = logoOf(b.logo_url);
  const sql = db();
  if (b.id) {
    const [a] = await sql`UPDATE apps SET name = ${name}, website = ${website}, redirect_uris = ${uris},
        brand_color = ${color}, theme = ${theme}, logo_url = ${logo}
      WHERE id = ${String(b.id)} AND owner_id = ${user.id} AND deleted_at IS NULL RETURNING id`;
    if (!a) fail(404, "No app with that id.");
    return send(res, 200, { id: a.id });
  }
  const [count] = await sql`SELECT count(*)::int AS n FROM apps WHERE owner_id = ${user.id} AND deleted_at IS NULL`;
  if (count.n >= 10) fail(400, "You can have up to 10 apps.");
  const id = newId("app");
  await sql`INSERT INTO apps (id, owner_id, name, website, redirect_uris, brand_color, theme, logo_url)
    VALUES (${id}, ${user.id}, ${name}, ${website}, ${uris}, ${color}, ${theme}, ${logo})`;
  send(res, 200, { id });
}

async function devAppDelete(req, res, { needUser }) {
  const user = await needUser(req);
  const id = String((await body(req)).id || "");
  const sql = db();
  const [a] = await sql`UPDATE apps SET deleted_at = now() WHERE id = ${id} AND owner_id = ${user.id} AND deleted_at IS NULL RETURNING id`;
  if (!a) fail(404, "No app with that id.");
  await sql`UPDATE connections SET revoked_at = now() WHERE app_id = ${id} AND revoked_at IS NULL`;
  await sql`UPDATE deposits SET status = 'declined', completed_at = now() WHERE app_id = ${id} AND status = 'pending'`;
  send(res, 200, { ok: true });
}

async function devTestDeposit(req, res, { needUser }) {
  const user = await needUser(req);
  const b = await body(req);
  const d = await createDeposit({ id: user.id, mode: "test" }, { app: b.id, amount: String(b.amount || "500"), description: "Test deposit from Business tools" });
  send(res, 200, publicDeposit(d));
}

/* ---------- public API: /v1/deposits and /v1/connections ---------- */

async function createDeposit(owner, b) {
  const appId = String(b.app || "");
  if (!appId) refuse(400, "app_required", "app is required. Use the App ID from Business tools, for example app_123.");
  const [app] = await db()`SELECT * FROM apps WHERE id = ${appId} AND owner_id = ${owner.id} AND deleted_at IS NULL`;
  if (!app) refuse(404, "app_not_found", "No app with that id on this account.");
  const amount = amountOf(b.amount);
  if (!amount) refuse(400, "invalid_amount", "amount must be a whole number of NSH as a string, for example \"500\".");
  if (b.unit && b.unit !== "NSH") refuse(400, "invalid_amount", "unit must be NSH.");
  let connection = null;
  if (b.connection) {
    const [c] = await db()`SELECT id, revoked_at FROM connections WHERE id = ${String(b.connection)} AND app_id = ${app.id} AND mode = ${owner.mode}`;
    if (!c) refuse(404, "connection_not_found", "No connection with that id for this app. Sandbox keys only see Sandbox connections.");
    if (c.revoked_at) refuse(403, "connection_revoked", "The user disconnected this app. Send them a deposit without connection so they can connect again.");
    connection = c.id;
  }
  const returnUrl = b.return_url ? String(b.return_url) : null;
  if (returnUrl && !app.redirect_uris.includes(returnUrl)) refuse(400, "invalid_return_url", "return_url must be one of the return URLs registered for the app.");
  const id = newId("dep");
  const [d] = await db()`INSERT INTO deposits (id, app_id, owner_id, mode, connection_id, amount, fee, reference, description, return_url, expires_at)
    VALUES (${id}, ${app.id}, ${owner.id}, ${owner.mode}, ${connection}, ${amount}, ${fee(amount)},
      ${String(b.reference || "").trim().slice(0, 100) || null}, ${String(b.description || "").trim().slice(0, 140) || null},
      ${returnUrl}, now() + make_interval(mins => ${DEPOSIT_MINUTES}))
    RETURNING *`;
  return d;
}

async function keyDeposit(owner, id) {
  const [d] = await db()`SELECT d.*, u.email AS user_email, u.name AS user_name FROM deposits d LEFT JOIN users u ON u.id = d.user_id
    WHERE d.id = ${String(id || "")} AND d.owner_id = ${owner.id} AND d.mode = ${owner.mode}`;
  return d || refuse(404, "deposit_not_found", "No deposit with that id for this key. Sandbox keys only see Sandbox deposits.");
}

const apiErrors = (fn) => async (req, res, owner, parts) => {
  try {
    return await fn(req, res, owner, parts);
  } catch (err) {
    if (err instanceof AppError) return send(res, err.status, { error: err.message, code: err.code });
    throw err;
  }
};

export const v1Deposits = apiErrors(async (req, res, owner, parts) => {
  const [id, action] = parts;
  if (!id && req.method === "POST") return send(res, 200, publicDeposit(await createDeposit(owner, await body(req))));
  if (!id && req.method === "GET") {
    const rows = await db()`SELECT d.*, u.email AS user_email, u.name AS user_name FROM deposits d LEFT JOIN users u ON u.id = d.user_id
      WHERE d.owner_id = ${owner.id} AND d.mode = ${owner.mode} ORDER BY d.created_at DESC LIMIT 50`;
    return send(res, 200, { object: "list", data: rows.map(publicDeposit) });
  }
  if (id && !action && req.method === "GET") return send(res, 200, publicDeposit(await keyDeposit(owner, id)));
  if (id && action === "cancel" && req.method === "POST") {
    const d = await keyDeposit(owner, id);
    const [row] = await db()`UPDATE deposits SET status = 'cancelled', completed_at = now() WHERE id = ${d.id} AND status = 'pending' RETURNING *`;
    return send(res, 200, publicDeposit(row ? { ...d, ...row } : d));
  }
  refuse(404, "not_found", "Unknown route. See https://norashillings.benuru.com/docs#apps");
});

export const v1Connections = apiErrors(async (req, res, owner, parts) => {
  const [id, action] = parts;
  const sql = db();
  let target = id;
  if (id === "exchange" && !action && req.method === "POST") {
    const code = String((await body(req)).code || "");
    if (!/^[A-Za-z0-9_-]{20,60}$/.test(code)) refuse(400, "invalid_code", "code is missing or malformed.");
    const [row] = await sql`UPDATE connect_codes k SET used_at = now()
      FROM connections c JOIN apps a ON a.id = c.app_id
      WHERE k.code_hash = ${sha(code)} AND k.used_at IS NULL AND k.expires_at > now()
        AND c.id = k.connection_id AND a.owner_id = ${owner.id} AND c.mode = ${owner.mode}
      RETURNING c.id`;
    if (!row) refuse(400, "invalid_code", "This code is not valid, expired, or was already used. Codes last 10 minutes and work once.");
    target = row.id;
  } else if (!id) {
    refuse(404, "not_found", "Add a connection id, for example /v1/connections/con_123.");
  } else if (action || req.method !== "GET") {
    refuse(404, "not_found", "Apps can only request deposits, which the user confirms. Use POST /v1/deposits. See https://norashillings.benuru.com/docs#apps");
  }
  const [c] = await sql`SELECT c.*, u.email AS user_email, u.name AS user_name
    FROM connections c JOIN apps a ON a.id = c.app_id JOIN users u ON u.id = c.user_id
    WHERE c.id = ${String(target)} AND a.owner_id = ${owner.id} AND c.mode = ${owner.mode}`;
  if (!c) refuse(404, "connection_not_found", "No connection with that id for this key. Sandbox keys only see Sandbox connections.");
  send(res, 200, publicConnection(c));
});

/* ---------- session routes ---------- */

const ROUTES = {
  "GET connect/info": connectInfo,
  "POST connect/approve": connectApprove,
  "GET deposit/info": depositInfo,
  "POST deposit/confirm": depositConfirm,
  "POST deposit/decline": depositDecline,
  "GET apps/connected": connectedApps,
  "POST apps/disconnect": disconnect,
  "GET dev/apps": devApps,
  "POST dev/apps": devAppSave,
  "POST dev/apps/delete": devAppDelete,
  "POST dev/apps/test-deposit": devTestDeposit,
};

export const appsHandler = (method, route) => ROUTES[`${method} ${route}`];
