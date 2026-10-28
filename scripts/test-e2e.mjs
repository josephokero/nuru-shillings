import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";

process.loadEnvFile(".env");
const BASE = process.argv[2] || "https://norashillings.benuru.com";
const sql = neon(process.env.DATABASE_URL);
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const stamp = Date.now();
let failures = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  (${extra})` : ""}`);
};

async function makeUser(tag) {
  const email = `norashillings+e2e${tag}${stamp}@benuru.com`;
  const [u] = await sql`INSERT INTO users (email, name, last_login_at) VALUES (${email}, ${"E2E " + tag.toUpperCase()}, now()) RETURNING id`;
  const token = crypto.randomBytes(32).toString("base64url");
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${sha(token)}, ${u.id}, now() + interval '1 hour')`;
  await sql.transaction([
    sql`INSERT INTO balances (user_id, mode, amount) VALUES (${u.id}, 'test', 0), (${u.id}, 'live', 0)`,
  ]);
  return { id: u.id, email, cookie: `nsh_session=${token}` };
}
const call = async (who, method, path, data, extra = {}) => {
  const headers = { ...(who ? { Cookie: who.cookie } : {}), ...(data ? { "Content-Type": "application/json" } : {}), ...extra };
  const r = await fetch(`${BASE}${path}`, { method, headers, body: data ? JSON.stringify(data) : undefined, redirect: "manual" });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const api = (who, route, data) => call(who, data ? "POST" : "GET", `/api/${route}`, data);
const v1 = (key, method, path, data) => call(null, method, `/v1/${path}`, data, key ? { Authorization: `Bearer ${key}` } : {});

const A = await makeUser("a");
const B = await makeUser("b");
const ids = [A.id, B.id];

try {
  let r = await api(A, "me?mode=test");
  ok("me loads for a new account", r.status === 200 && r.json.email === A.email, `http ${r.status}`);
  ok("me hides admin for normal users", r.json.admin === false);
  await api(B, "me?mode=test");

  r = await call(null, "GET", "/api/me");
  ok("me without login is 401", r.status === 401);
  r = await call(null, "POST", "/api/wallet/send", { mode: "test" }, { Origin: "https://evil.example" });
  ok("cross-site POST blocked", r.status === 403, r.json.error);

  r = await api(A, "wallet/add", { mode: "test", usd: 20, method: "PayPal" });
  ok("sandbox add $20", r.status === 200, r.json.error);
  r = await api(A, "me?mode=test");
  ok("sandbox balance is 2,000 NSH", Number(r.json.balance?.test ?? r.json.balances?.test ?? r.json.balance) === 2000, JSON.stringify(r.json.balance ?? r.json.balances));

  r = await api(A, "wallet/send", { mode: "test", to: B.email, amount: "500" });
  ok("send 500 NSH to another account", r.status === 200, r.json.error);
  r = await api(A, "wallet/send", { mode: "test", to: B.email, amount: "999999" });
  ok("send more than balance refused", r.status === 400, r.json.error);
  r = await api(A, "wallet/send", { mode: "test", to: "nobody-here@benuru.com", amount: "10" });
  ok("send to unknown email refused", r.status === 404, r.json.error);

  r = await api(B, "wallet/withdraw", { mode: "test", amount: "200", method: "M-Pesa", destination: "+254700000000" });
  ok("sandbox M-Pesa withdrawal", r.status === 200 && r.json.status === "done", r.json.error || r.json.status);
  r = await api(B, "me?mode=test");
  ok("withdrawal shows in history", (r.json.withdrawals || []).some((w) => Number(w.amount) === 200 || Number(w.amount) === -200), `${(r.json.withdrawals || []).length} rows`);

  r = await api(B, "wallet/withdraw", { mode: "live", amount: "100", method: "M-Pesa", destination: "+254700000000" });
  ok("live withdrawal needs identity check", r.status === 403, r.json.error);

  r = await api(A, "admin/withdrawals");
  ok("admin API is hidden from normal users (404)", r.status === 404, r.json.error);

  r = await api(A, "dev/keys", { mode: "test" });
  const key = r.json.key;
  ok("create sandbox API key", r.status === 200 && /^nsh_test_/.test(key || ""), r.json.error);
  r = await api(A, "dev/keys", { mode: "live" });
  ok("live key needs identity check", r.status === 403, r.json.error);

  r = await v1("nsh_test_wrongwrongwrongwrongwrong", "GET", "payments/pay_x");
  ok("v1 rejects a bad key", r.status === 401, r.json.error);
  r = await v1(null, "GET", "payments/pay_x");
  ok("v1 rejects a missing key", r.status === 401);
  r = await v1(key, "POST", "payments", { amount: "1800", company: "E2E Shop", reference: "order_e2e" });
  const pay = r.json;
  ok("v1 create sandbox payment", r.status === 200 && pay.status === "paid" && /^pay_/.test(pay.id || ""), r.json.error || pay.status);
  r = await v1(key, "GET", `payments/${pay.id}`);
  ok("v1 fetch payment", r.status === 200 && r.json.id === pay.id);
  r = await v1(key, "POST", "payments", { amount: "abc", company: "X" });
  ok("v1 bad amount refused", r.status === 400, r.json.error);
  r = await v1(key, "POST", "refunds", { payment: pay.id });
  ok("v1 refund payment", r.status === 200 && r.json.status === "refunded", r.json.error || r.json.status);
  r = await v1(key, "POST", "refunds", { payment: pay.id });
  ok("v1 double refund refused", r.status === 400, r.json.error);
  r = await v1(key, "GET", "nope");
  ok("v1 unknown route is 404", r.status === 404);

  r = await v1(key, "POST", "webhooks", { url: "http://insecure.example.com/hook" });
  ok("webhook must be https", r.status === 400, r.json.error);
  r = await v1(key, "POST", "webhooks", { url: `${BASE}/api/e2e-webhook-sink` });
  ok("set sandbox webhook", r.status === 200 && r.json.url, r.json.error);
  r = await api(A, "dev/webhook/test", { mode: "test" });
  ok("send test webhook (delivery recorded)", r.status === 200, r.json.error || JSON.stringify(r.json).slice(0, 120));

  r = await api(A, "dev/overview?mode=test");
  ok("developer overview lists the payment", r.status === 200 && r.json.payments?.some((p) => p.id === pay.id), `http ${r.status}`);

  r = await api(A, "dev/apps", { name: "E2E App", website: "https://example.com", redirect_uris: ["https://example.com/nora/callback"], theme: "dark", brand_color: "#4f46e5", logo_url: "https://example.com/logo.png" });
  ok("create app", r.status === 200, r.json.error);
  r = await api(A, "dev/apps");
  const app = (r.json.apps || []).find((x) => x.name === "E2E App");
  ok("list apps", Boolean(app), `http ${r.status}`);

  r = await v1(key, "POST", "deposits", { app: app?.id, amount: "300", reference: "dep_e2e", return_url: "https://example.com/nora/callback" });
  const dep = r.json;
  ok("v1 create sandbox deposit", r.status === 200 && /^dep_/.test(dep.id || ""), r.json.error || r.json.message);
  r = await v1(key, "POST", "deposits", { app: app?.id, amount: "300", return_url: "https://evil.example/cb" });
  ok("deposit with unregistered return URL refused", r.status === 400, r.json.error?.message || r.json.error);
  r = await api(B, `deposit/info?id=${dep.id}`);
  ok("deposit window loads for payer", r.status === 200, r.json.error);
  r = await api(B, "deposit/confirm", { id: dep.id });
  ok("payer confirms deposit", r.status === 200 && r.json.status === "succeeded", r.json.error);
  r = await api(B, "deposit/confirm", { id: dep.id });
  ok("deposit cannot be confirmed twice", r.status === 409, r.json.error);
  r = await v1(key, "GET", `deposits/${dep.id}`);
  ok("v1 fetch deposit shows succeeded", r.status === 200 && r.json.status === "succeeded", r.json.status);
  r = await api(B, "apps/connected?mode=test");
  ok("payer sees the connected app", r.status === 200 && JSON.stringify(r.json).includes("E2E App"), `http ${r.status}`);
  await sql`UPDATE users SET verified_at = now(), country = 'Kenya' WHERE id = ${A.id}`;
  r = await api(A, "dev/payment", { mode: "live", amount: "250", company: "E2E Live Shop" });
  const live = r.json;
  ok("verified merchant creates live payment", r.status === 200 && live.status === "pending", r.json.error);
  r = await api(null, `checkout?id=${live.id}`);
  ok("public checkout page data", r.status === 200 && r.json.company === "E2E Live Shop" && r.json.amount === "250");
  r = await api(B, "checkout/pay", { id: live.id });
  ok("checkout refused with empty live balance", r.status === 400, r.json.error);
  await sql.transaction([
    sql`UPDATE balances SET amount = amount + 1000 WHERE user_id = ${B.id} AND mode = 'live'`,
    sql`INSERT INTO ledger (user_id, mode, kind, amount, counterparty) VALUES (${B.id}, 'live', 'add', 1000, 'E2E seed')`,
  ]);
  r = await api(B, "checkout/pay", { id: live.id });
  ok("buyer pays live checkout", r.status === 200 && r.json.status === "paid", r.json.error);
  r = await api(B, "checkout/pay", { id: live.id });
  ok("live checkout cannot be paid twice", r.status === 400, r.json.error);
  const [bal] = await sql`SELECT (SELECT amount FROM balances WHERE user_id = ${A.id} AND mode = 'live') AS a, (SELECT amount FROM balances WHERE user_id = ${B.id} AND mode = 'live') AS b`;
  ok("live balances moved (buyer -250, merchant +net)", Number(bal.b) === 750 && Number(bal.a) > 0 && Number(bal.a) < 250, `buyer ${bal.b}, merchant ${bal.a}`);

  r = await api(A, "dev/apps/delete", { id: app?.id });
  ok("delete app", r.status === 200, r.json.error);

  r = await call(null, "POST", "/api/auth/start", { email: `norashillings+e2elogin${stamp}@benuru.com` });
  ok("email sign-in link request accepted", r.status === 200, r.json.error);
  const [tok] = await sql`SELECT count(*)::int AS n FROM login_tokens WHERE email = ${`norashillings+e2elogin${stamp}@benuru.com`}`;
  ok("sign-in token stored", tok.n === 1);
} catch (err) {
  failures++;
  console.log("CRASH", err);
} finally {
  const apps = await sql`SELECT id FROM apps WHERE owner_id = ANY(${ids})`;
  const appIds = apps.map((a) => a.id);
  const conns = await sql`SELECT id FROM connections WHERE user_id = ANY(${ids}) OR app_id = ANY(${appIds})`;
  const connIds = conns.map((c) => c.id);
  await sql.transaction([
    sql`SELECT set_config('nsh.purge', 'on', true)`,
    sql`DELETE FROM app_moves WHERE connection_id = ANY(${connIds})`,
    sql`DELETE FROM connect_codes WHERE connection_id = ANY(${connIds})`,
    sql`DELETE FROM deposits WHERE owner_id = ANY(${ids}) OR user_id = ANY(${ids}) OR app_id = ANY(${appIds})`,
    sql`DELETE FROM connections WHERE id = ANY(${connIds})`,
    sql`DELETE FROM apps WHERE id = ANY(${appIds})`,
    sql`DELETE FROM payments WHERE merchant_id = ANY(${ids}) OR payer_id = ANY(${ids})`,
    sql`DELETE FROM withdrawals WHERE user_id = ANY(${ids})`,
    sql`DELETE FROM topups WHERE user_id = ANY(${ids})`,
    sql`DELETE FROM events WHERE user_id = ANY(${ids})`,
    sql`DELETE FROM ledger WHERE user_id = ANY(${ids})`,
    sql`DELETE FROM balances WHERE user_id = ANY(${ids})`,
    sql`DELETE FROM security_events WHERE user_id = ANY(${ids})`,
    sql`DELETE FROM api_keys WHERE user_id = ANY(${ids})`,
    sql`DELETE FROM sessions WHERE user_id = ANY(${ids})`,
    sql`DELETE FROM login_tokens WHERE email LIKE ${`norashillings+e2e%${stamp}@benuru.com`}`,
    sql`DELETE FROM users WHERE id = ANY(${ids})`,
  ]);
  const [left] = await sql`SELECT (SELECT count(*) FROM users WHERE id = ANY(${ids}))::int AS users, (SELECT count(*) FROM ledger WHERE user_id = ANY(${ids}))::int AS ledger`;
  console.log(`cleanup: ${left.users} users, ${left.ledger} ledger rows left`);
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
}
