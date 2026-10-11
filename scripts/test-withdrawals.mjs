import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";

process.loadEnvFile(".env");
const BASE = process.argv[2] || "http://127.0.0.1:8799";
const sql = neon(process.env.DATABASE_URL);
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
let failures = 0;
const ok = (label, cond, extra = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  (${extra})` : ""}`); };

async function makeUser(email, { verified = false, mfa = false } = {}) {
  const [u] = await sql`INSERT INTO users (email, name, last_login_at, verified_at, totp_enabled_at, country)
    VALUES (${email}, 'WD Test', now(), ${verified ? new Date() : null}, ${mfa ? new Date() : null}, 'Kenya') RETURNING id`;
  const token = crypto.randomBytes(32).toString("base64url");
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at, mfa_at) VALUES (${sha(token)}, ${u.id}, now() + interval '1 hour', now())`;
  await sql.transaction([sql`INSERT INTO balances (user_id, mode, amount) VALUES (${u.id}, 'test', 1000), (${u.id}, 'live', 5000)`,
    sql`INSERT INTO ledger (user_id, mode, kind, amount, counterparty) VALUES (${u.id}, 'test', 'add', 1000, 'WD seed'), (${u.id}, 'live', 'add', 5000, 'WD seed')`]);
  return { id: u.id, email, cookie: `nsh_session=${token}` };
}
const api = async (who, route, data) => {
  const r = await fetch(`${BASE}/api/${route}`, { method: data ? "POST" : "GET", headers: { Cookie: who.cookie, ...(data ? { "Content-Type": "application/json" } : {}) }, body: data ? JSON.stringify(data) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const live = async (u) => Number((await sql`SELECT amount FROM balances WHERE user_id = ${u.id} AND mode = 'live'`)[0].amount);

const stamp = Date.now();
const U = await makeUser(`norashillings+wduser${stamp}@benuru.com`, { verified: true, mfa: true });
const A = await makeUser("norashillings+e2eadmin@benuru.com");
const ids = [U.id, A.id];
try {
  let r = await api(U, "wallet/withdraw", { mode: "live", amount: "1000", method: "PayPal", destination: "wd.test@example.com" });
  ok("live PayPal withdrawal is accepted as pending (not sent instantly)", r.status === 200 && r.json.status === "pending" && r.json.withdrawal?.status === "pending", r.json.error || r.json.status);
  const pp = r.json.withdrawal?.id;
  const [row] = await sql`SELECT status, method, provider_ref FROM withdrawals WHERE id = ${pp || ""}`;
  ok("stored as pending PayPal with no PayPal payout started", row?.status === "pending" && row?.method === "PayPal" && !row?.provider_ref, JSON.stringify(row));
  ok("wallet debited 1,000 NSH", (await live(U)) === 4000, String(await live(U)));

  r = await api(U, "wallet/withdraw", { mode: "live", amount: "500", method: "PayPal", destination: "not-an-email" });
  ok("bad PayPal email refused", r.status === 400, r.json.error);
  r = await api(U, "wallet/withdraw", { mode: "live", amount: "50", method: "M-Pesa", destination: "+254700000000" });
  ok("under 100 NSH refused for every method", r.status === 400, r.json.error);
  r = await api(U, "wallet/withdraw", { mode: "live", amount: "200000", method: "M-Pesa", destination: "+254700000000" });
  ok("daily cap applies to M-Pesa too", r.status === 400 && /a day/.test(r.json.error || ""), r.json.error);

  r = await api(U, "me?mode=live");
  const mine = (r.json.withdrawals || []).find((w) => w.id === pp || w.ref === pp);
  ok("user sees it in history as pending", Boolean(mine) && /pending|processing/.test(mine.status), JSON.stringify(mine)?.slice(0, 120));

  r = await api(U, "admin/withdrawals");
  ok("normal user cannot open approvals", r.status === 403);
  r = await api(A, "admin/withdrawals");
  ok("admin sees the PayPal withdrawal waiting", r.status === 200 && r.json.open?.some((w) => w.id === pp && w.method === "PayPal"), `http ${r.status} ${r.json.error || ""}`);

  r = await api(A, "admin/withdrawals/approve", { id: pp, receipt: "abc" });
  ok("bad receipt asks for a PayPal transaction ID", r.status === 400 && /PayPal transaction ID/.test(r.json.error || ""), r.json.error);
  r = await api(A, "admin/withdrawals/approve", { id: pp, receipt: "5TY05013RG002845M" });
  ok("admin marks PayPal withdrawal sent", r.status === 200 && r.json.withdrawal?.status === "paid", r.json.error);
  r = await api(A, "admin/withdrawals/approve", { id: pp, receipt: "5TY05013RG002845M" });
  ok("cannot approve twice", r.status === 409, r.json.error);
  r = await api(U, "me?mode=live");
  const paid = (r.json.withdrawals || []).find((w) => w.id === pp || w.ref === pp);
  ok("user sees it paid with the PayPal transaction ID", paid?.status === "paid" && paid?.receipt === "5TY05013RG002845M", JSON.stringify(paid)?.slice(0, 160));

  r = await api(U, "wallet/withdraw", { mode: "live", amount: "500", method: "M-Pesa", destination: "+254700000000" });
  const mp = r.json.withdrawal?.id;
  ok("live M-Pesa withdrawal pending", r.status === 200 && r.json.status === "pending", r.json.error);
  r = await api(A, "admin/withdrawals/return", { id: mp, reason: "That number isn’t registered for M-Pesa" });
  ok("admin returns it to the wallet", r.status === 200 && r.json.withdrawal?.status === "failed", r.json.error);
  ok("wallet back to 4,000 NSH after return", (await live(U)) === 4000, String(await live(U)));

  r = await api(U, "wallet/withdraw", { mode: "test", amount: "100", method: "PayPal", destination: "wd.test@example.com" });
  ok("sandbox withdrawal still completes at once", r.status === 200 && r.json.status === "done", r.json.error);
} catch (err) {
  failures++;
  console.log("CRASH", err);
} finally {
  await sql.transaction([
    sql`SELECT set_config('nsh.purge', 'on', true)`,
    sql`DELETE FROM withdrawals WHERE user_id = ANY(${ids})`,
    sql`DELETE FROM ledger WHERE user_id = ANY(${ids})`,
    sql`DELETE FROM balances WHERE user_id = ANY(${ids})`,
    sql`DELETE FROM security_events WHERE user_id = ANY(${ids})`,
    sql`DELETE FROM sessions WHERE user_id = ANY(${ids})`,
    sql`DELETE FROM users WHERE id = ANY(${ids})`,
  ]);
  const [left] = await sql`SELECT count(*)::int AS n FROM users WHERE id = ANY(${ids})`;
  console.log(`cleanup: ${left.n} users left`);
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
}
