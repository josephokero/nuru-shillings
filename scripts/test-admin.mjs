/* Admin console checks against a local server started with:
     APP_URL=http://localhost:8799 RESEND_API_KEY= PORT=8799 node server.mjs
   Uses the real admin email. If that account already exists, only a temporary session is added and removed. */
import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";

process.loadEnvFile(".env");
const BASE = process.argv[2] || "http://localhost:8799";
const ADMIN_EMAIL = String(process.env.NSH_ADMIN_EMAIL || "").trim().toLowerCase();
if (!ADMIN_EMAIL) throw new Error("Set NSH_ADMIN_EMAIL in .env to run admin tests.");
const UA = "nsh-admin-test";
const sql = neon(process.env.DATABASE_URL);
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
let failures = 0;
const ok = (label, cond, extra = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  (${extra})` : ""}`); };

async function session(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at, mfa_at, user_agent) VALUES (${sha(token)}, ${userId}, now() + interval '1 hour', now(), ${UA})`;
  return { token, cookie: `nsh_session=${token}` };
}
async function makeUser(email, { verified = false, mfa = false, live = 5000 } = {}) {
  const [u] = await sql`INSERT INTO users (email, name, last_login_at, verified_at, totp_enabled_at, country)
    VALUES (${email}, 'Admin Test', now(), ${verified ? new Date() : null}, ${mfa ? new Date() : null}, 'Kenya') RETURNING id`;
  await sql.transaction([sql`INSERT INTO balances (user_id, mode, amount) VALUES (${u.id}, 'test', 1000), (${u.id}, 'live', ${live})`,
    sql`INSERT INTO ledger (user_id, mode, kind, amount, counterparty) VALUES (${u.id}, 'test', 'add', 1000, 'Admin test seed'), (${u.id}, 'live', 'add', ${live}, 'Admin test seed')`]);
  return { id: u.id, email, ...(await session(u.id)) };
}
const req = async (who, path, data, headers = {}) => {
  const r = await fetch(`${BASE}${path}`, {
    method: data ? "POST" : "GET", redirect: "manual",
    headers: { "User-Agent": UA, ...(who ? { Cookie: who.cookie } : {}), ...(data ? { "Content-Type": "application/json", Origin: BASE } : {}), ...headers },
    body: data ? JSON.stringify(data) : undefined,
  });
  const text = await r.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json, headers: r.headers };
};
const api = (who, route, data) => req(who, `/api/${route}`, data);
const live = async (u) => Number((await sql`SELECT amount FROM balances WHERE user_id = ${u.id} AND mode = 'live'`)[0].amount);

const started = new Date();
const stamp = Date.now();
const created = [];
let adminSession = null;
let testKey = null;
const [existing] = await sql`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`;
const U = await makeUser(`norashillings+admintest${stamp}@benuru.com`, { verified: true, mfa: true });
created.push(U.id);
let A;
if (existing) {
  A = { id: existing.id, email: ADMIN_EMAIL, ...(await session(existing.id)) };
  console.log("note: the real admin account exists; using a temporary session on it");
} else {
  A = await makeUser(ADMIN_EMAIL, { live: 0 });
  created.push(A.id);
}
adminSession = sha(A.token);

try {
  /* hidden from everyone else */
  for (const [who, label] of [[null, "signed out"], [U, "normal user"]]) {
    let r = await req(who, "/admin");
    ok(`${label}: /admin is the normal 404 page`, r.status === 404 && /Page not found/.test(r.text) && !/Admin console/.test(r.text), `http ${r.status}`);
    r = await req(who, "/admin/console.js");
    ok(`${label}: console script is 404`, r.status === 404 && !/faceCheck/.test(r.text), `http ${r.status}`);
    r = await req(who, "/api/admin/state");
    ok(`${label}: admin API is 404`, r.status === 404 && r.json.error === "Not found.", `http ${r.status}`);
    r = await req(who, "/api/admin/withdrawals");
    ok(`${label}: admin data API is 404`, r.status === 404, `http ${r.status}`);
  }
  let r = await req(null, "/admin.html");
  ok("old /admin.html is not served", r.status === 404 || (r.status === 301 && !/admin\.html/.test(r.headers.get("location") || "x.html")), `http ${r.status}`);
  r = await req(null, "/robots.txt");
  ok("robots.txt does not mention /admin", r.status === 200 && !/admin/i.test(r.text));
  r = await api(U, "me");
  ok("normal user is not marked admin", r.status === 200 && r.json.admin === false);

  /* admin sees the console */
  r = await req(A, "/admin");
  ok("admin gets the console page", r.status === 200 && /Admin console/.test(r.text), `http ${r.status}`);
  ok("console page is private (no-store, noindex)", /no-store/.test(r.headers.get("cache-control") || "") && /noindex/.test(r.headers.get("x-robots-tag") || ""));
  r = await req(A, "/admin/console.js");
  ok("admin gets the console script", r.status === 200 && /javascript/.test(r.headers.get("content-type") || "") && /faceCheck/.test(r.text));
  r = await req(A, "/admin/console.css");
  ok("admin gets the console styles", r.status === 200 && /text\/css/.test(r.headers.get("content-type") || ""));
  r = await req(A, "/admin/../.env");
  ok("no file escape through /admin", r.status === 404 || !/DATABASE_URL/.test(r.text));
  r = await api(A, "me");
  ok("admin account is marked admin", r.json.admin === true);

  /* face lock */
  const [{ n: keys }] = await sql`SELECT count(*)::int AS n FROM admin_keys WHERE email = ${ADMIN_EMAIL}`;
  r = await api(A, "admin/state");
  ok("state answers and is locked", r.status === 200 && r.json.unlocked === false && r.json.enrolled === (keys > 0), JSON.stringify(r.json).slice(0, 120));
  r = await api(A, "admin/overview");
  ok("data is locked until the face scan", r.status === 423 && r.json.code === "admin_locked", `http ${r.status}`);
  r = await api(A, "admin/withdrawals/approve", { id: "x", receipt: "ABCDEFGH12" });
  ok("actions are locked until the face scan", r.status === 423);
  if (!keys) {
    r = await api(A, "admin/face/unlock/options", {});
    ok("unlock needs a key first", r.status === 409, r.json.error);
    r = await api(A, "admin/face/enroll/options", {});
    ok("enroll options ask for a verified face (user verification required)", r.status === 200 && r.json.options?.authenticatorSelection?.userVerification === "required" && r.json.options?.rp?.id === new URL(BASE).hostname, JSON.stringify(r.json.options?.rp));
    const bad = await api(A, "admin/face/enroll", { ticket: r.json.ticket, response: { id: "x", rawId: "x", type: "public-key", response: {} } });
    ok("a fake enrollment is refused", bad.status === 400, bad.json.error);
    const again = await api(A, "admin/face/enroll", { ticket: r.json.ticket, response: {} });
    ok("an enrollment ticket works only once", again.status === 400 && /expired/.test(again.json.error || ""), again.json.error);

    testKey = `test-${stamp}`;
    await sql`INSERT INTO admin_keys (id, email, public_key, transports) VALUES (${testKey}, ${ADMIN_EMAIL}, 'cHVibGlj', ${["hybrid"]})`;
    let blocked = "";
    try { await sql`DELETE FROM admin_keys WHERE id = ${testKey}`; } catch (e) { blocked = e.message; }
    ok("database refuses to delete the face key", /permanent/.test(blocked), blocked);
    blocked = "";
    try { await sql`UPDATE admin_keys SET public_key = 'b3RoZXI' WHERE id = ${testKey}`; } catch (e) { blocked = e.message; }
    ok("database refuses to swap the face key", /permanent/.test(blocked), blocked);
    blocked = "";
    try { await sql`INSERT INTO admin_keys (id, email, public_key) VALUES (${`${testKey}-2`}, ${ADMIN_EMAIL}, 'eA')`; } catch (e) { blocked = e.message; }
    ok("database refuses a second face key", /duplicate|unique/i.test(blocked), blocked);
    r = await api(A, "admin/face/enroll/options", {});
    ok("site refuses to enroll again", r.status === 409 && /permanent/.test(r.json.error || ""), r.json.error);
    r = await api(A, "admin/face/unlock/options", {});
    ok("unlock options target only the enrolled key over the phone", r.status === 200 && r.json.options?.allowCredentials?.length === 1 && r.json.options.allowCredentials[0].transports.includes("hybrid"));
    const wrong = await api(A, "admin/face/unlock", { ticket: r.json.ticket, response: { id: "someone-else" } });
    ok("a different key cannot unlock", wrong.status === 400, wrong.json.error);
  } else {
    console.log("note: a real face key is enrolled; skipping enrollment and database guard checks");
  }

  /* unlocked (the face scan itself is covered by the browser test) */
  await sql`UPDATE sessions SET admin_at = now() WHERE token_hash = ${adminSession}`;
  r = await api(A, "admin/state");
  ok("state shows unlocked with an end time", r.json.unlocked === true && Boolean(r.json.until));
  await sql`UPDATE sessions SET admin_at = now() - interval '61 minutes' WHERE token_hash = ${adminSession}`;
  r = await api(A, "admin/overview");
  ok("unlock expires after an hour", r.status === 423);
  await sql`UPDATE sessions SET admin_at = now() WHERE token_hash = ${adminSession}`;

  r = await api(A, "admin/overview");
  ok("overview totals", r.status === 200 && r.json.totals.users >= 2 && typeof r.json.totals.live_balances === "number", `http ${r.status} ${r.json.error || ""}`);
  r = await api(A, `admin/users?q=${encodeURIComponent(`admintest${stamp}`)}`);
  ok("search finds the user", r.status === 200 && r.json.users.length === 1 && r.json.users[0].live === 5000, `${r.json.users?.length}`);
  r = await api(A, "admin/users?filter=money");
  ok("filter: has money", r.status === 200 && r.json.users.some((u) => u.id === U.id));
  r = await api(A, `admin/user?id=${U.id}`);
  ok("user detail with balances, ledger and sessions", r.status === 200 && r.json.balances.live === 5000 && r.json.ledger.length >= 2 && r.json.sessions.length === 1, r.json.error);
  ok("user detail hides secrets", !("totp_secret" in (r.json.user || {})) && !("recovery_codes" in (r.json.user || {})));
  r = await api(A, "admin/user?id=nope");
  ok("unknown user is a clear 404", r.status === 404 && /No user/.test(r.json.error || ""));

  /* withdrawals */
  r = await api(U, "wallet/withdraw", { mode: "live", amount: "1000", method: "PayPal", destination: "admin.test@example.com" });
  const pp = r.json.withdrawal?.id;
  ok("user asks for a live PayPal withdrawal", r.status === 200 && r.json.status === "pending", r.json.error);
  r = await api(A, "admin/withdrawals");
  ok("admin sees it waiting", r.status === 200 && r.json.open.some((w) => w.id === pp && w.user.id === U.id));
  r = await api(A, "admin/withdrawals/approve", { id: pp, receipt: "abc" });
  ok("bad receipt refused", r.status === 400 && /PayPal transaction ID/.test(r.json.error || ""));
  r = await api(A, "admin/withdrawals/approve", { id: pp, receipt: `5TY${stamp}`.slice(0, 17) });
  ok("admin marks it sent", r.status === 200 && r.json.withdrawal?.status === "paid", r.json.error);
  r = await api(A, "admin/withdrawals/approve", { id: pp, receipt: `5TY${stamp}`.slice(0, 17) });
  ok("cannot approve twice", r.status === 409);
  r = await api(U, "wallet/withdraw", { mode: "live", amount: "500", method: "M-Pesa", destination: "+254700000000" });
  const mp = r.json.withdrawal?.id;
  r = await api(A, "admin/withdrawals/return", { id: mp, reason: "That number isn’t registered for M-Pesa" });
  ok("admin returns an M-Pesa withdrawal", r.status === 200 && r.json.withdrawal?.status === "failed", r.json.error);
  ok("money is back (5,000 − 1,000 sent)", (await live(U)) === 4000, String(await live(U)));

  /* account controls */
  r = await api(A, "admin/users/freeze", { id: U.id, reason: "Admin test hold" });
  ok("put on hold", r.status === 200, r.json.error);
  r = await api(U, "wallet/withdraw", { mode: "live", amount: "200", method: "M-Pesa", destination: "+254700000000" });
  ok("held account cannot withdraw live money", r.status === 423, `http ${r.status} ${r.json.error || ""}`);
  r = await api(A, "admin/users/freeze", { id: U.id });
  ok("cannot hold twice", r.status === 409);
  r = await api(A, "admin/users/unfreeze", { id: U.id });
  ok("take off hold", r.status === 200);
  r = await api(A, "admin/users/freeze", { id: A.id });
  ok("admin account cannot be put on hold", r.status === 400);
  r = await api(A, "admin/users/signout", { id: U.id });
  ok("sign a user out everywhere", r.status === 200 && r.json.signed_out === 1, JSON.stringify(r.json));
  r = await api(U, "me");
  ok("their session is gone", r.status === 401);
  if (!existing) {
    r = await api(A, "admin/users/signout", { id: A.id });
    ok("signing out the admin keeps this session", r.status === 200 && (await api(A, "admin/state")).status === 200);
  }

  /* other lists */
  for (const route of ["admin/topups?mode=live", "admin/topups?mode=test", "admin/payments?mode=live", "admin/apps", "admin/security", "admin/security?type=admin_action"]) {
    r = await api(A, route);
    ok(`list ${route}`, r.status === 200, `http ${r.status} ${r.json.error || ""}`);
  }
  r = await api(A, "admin/security?type=admin_action");
  const actions = (r.json.events || []).filter((e) => e.user_agent === UA).map((e) => e.detail?.action);
  ok("every admin action is in the log", ["withdrawal_sent", "withdrawal_returned", "user_frozen", "user_unfrozen", "user_signed_out"].every((a) => actions.includes(a)), actions.join(","));
  r = await api(A, "admin/apps/remove", { id: "nope" });
  ok("removing an unknown app is a clear 404", r.status === 404);

  /* cross-site and lock */
  const csrf = await fetch(`${BASE}/api/admin/lock`, { method: "POST", headers: { Cookie: A.cookie, "Content-Type": "text/plain", Origin: "https://evil.example" }, body: "{}" });
  ok("cross-site POST refused", csrf.status === 403);
  r = await api(A, "admin/lock", {});
  ok("lock now", r.status === 200);
  r = await api(A, "admin/overview");
  ok("locked again after Lock", r.status === 423);
} catch (err) {
  failures++;
  console.log("CRASH", err);
} finally {
  const ids = created;
  await sql.transaction([
    sql`SELECT set_config('nsh.purge', 'on', true)`,
    sql`DELETE FROM admin_keys WHERE id LIKE ${`test-${stamp}%`}`,
    sql`DELETE FROM withdrawals WHERE user_id = ANY(${ids})`,
    sql`DELETE FROM ledger WHERE user_id = ANY(${ids})`,
    sql`DELETE FROM balances WHERE user_id = ANY(${ids})`,
    sql`DELETE FROM security_events WHERE user_id = ANY(${ids}) OR (user_id = ${A.id} AND user_agent = ${UA} AND created_at >= ${started})`,
    sql`DELETE FROM auth_challenges WHERE user_id = ANY(${ids}) OR (user_id = ${A.id} AND purpose LIKE 'admin-%' AND created_at >= ${started})`,
    sql`DELETE FROM sessions WHERE user_id = ANY(${ids}) OR token_hash = ${adminSession}`,
    sql`DELETE FROM users WHERE id = ANY(${ids})`,
  ]);
  const [left] = await sql`SELECT (SELECT count(*) FROM users WHERE id = ANY(${ids}))::int AS users,
    (SELECT count(*) FROM admin_keys WHERE id LIKE ${`test-${stamp}%`})::int AS keys`;
  console.log(`cleanup: ${left.users} users, ${left.keys} test keys left`);
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
}
