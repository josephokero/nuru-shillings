import fs from "node:fs";
import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";

for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.replace(/^\uFEFF/, "").match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const BASE = process.env.TEST_BASE || "http://localhost:4173";
const EMAIL = process.env.TEST_EMAIL || `norashillings+paytest${Date.now()}@benuru.com`;
const sql = neon(process.env.DATABASE_URL);
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const ok = (label, cond, extra = "") => console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  (${extra})` : ""}`);

const [user] = await sql`INSERT INTO users (email, last_login_at) VALUES (${EMAIL}, now()) RETURNING id`;
const token = crypto.randomBytes(32).toString("base64url");
await sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${sha(token)}, ${user.id}, now() + interval '1 day')`;
const headers = { Cookie: `nsh_session=${token}`, "Content-Type": "application/json" };
const post = async (route, data, extra = {}) => {
  const r = await fetch(`${BASE}/api/${route}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(data) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const get = async (route) => {
  const r = await fetch(`${BASE}/api/${route}`, { headers, redirect: "manual" });
  return { status: r.status, location: r.headers.get("location"), json: await r.json().catch(() => ({})) };
};

try {
  let r = await get("me?mode=live");
  ok("me reports payment methods", r.json.payments?.paypal && r.json.payments?.card && r.json.payments?.mpesa, JSON.stringify(r.json.payments));

  r = await post("topup/start", { mode: "test", method: "paypal", usd: 10 });
  ok("sandbox top-up refused (test money stays instant)", r.status === 400, r.json.error);
  r = await post("topup/start", { mode: "live", method: "paypal", usd: 10 });
  ok("unverified user refused", r.status === 403, r.json.error);

  await sql`UPDATE users SET name = 'Pay Test', country = 'Kenya', verified_at = now() WHERE id = ${user.id}`;
  r = await post("topup/start", { mode: "live", method: "bitcoin", usd: 10 });
  ok("unknown method refused", r.status === 400, r.json.error);
  r = await post("topup/start", { mode: "live", method: "paypal", usd: 0 });
  ok("zero amount refused", r.status === 400, r.json.error);
  r = await post("topup/start", { mode: "live", method: "mpesa", usd: 10, phone: "12345" });
  ok("bad M-Pesa number refused", r.status === 400, r.json.error);

  r = await post("topup/start", { mode: "live", method: "paypal", usd: 5 });
  const pp = r.json;
  ok("PayPal checkout created (live order, nothing charged)", r.status === 200 && /paypal\.com/.test(pp.redirect || ""), r.json.error || new URL(pp.redirect).host);

  r = await post("topup/start", { mode: "live", method: "card", usd: 5 });
  const card = r.json;
  ok("Card checkout created (PayPal guest card page)", r.status === 200 && /paypal\.com/.test(card.redirect || ""), r.json.error || new URL(card.redirect).host);

  if (pp.id) {
    r = await get(`topup/status?id=${pp.id}`);
    ok("unpaid PayPal order stays pending", r.json.status === "pending", r.json.status);

    r = await get(`topup/paypal/return?t=${pp.id}&token=WRONG`);
    const [still] = await sql`SELECT status FROM topups WHERE id = ${pp.id}`;
    ok("return with wrong token changes nothing", r.status === 302 && still.status === "pending", r.location);

    const [row] = await sql`SELECT provider_ref FROM topups WHERE id = ${pp.id}`;
    r = await post("webhooks/paypal", { event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: row.provider_ref } });
    const [after] = await sql`SELECT status FROM topups WHERE id = ${pp.id}`;
    ok("fake PayPal webhook does not credit (order re-checked with PayPal)", r.status !== 500 && after.status === "pending", `http ${r.status}, ${after.status}`);
  }
  if (card.id) {
    r = await get(`topup/paypal/cancel?t=${card.id}`);
    const s = await get(`topup/status?id=${card.id}`);
    ok("cancel on PayPal marks it cancelled", r.status === 302 && s.json.status === "cancelled", `${r.location} -> ${s.json.status}`);
  }

  const auth = process.env.PAYHERO_BASIC_TOKEN
    ? (process.env.PAYHERO_BASIC_TOKEN.startsWith("Basic ") ? process.env.PAYHERO_BASIC_TOKEN : `Basic ${process.env.PAYHERO_BASIC_TOKEN}`)
    : `Basic ${Buffer.from(`${process.env.PAYHERO_USERNAME}:${process.env.PAYHERO_PASSWORD}`).toString("base64")}`;
  const ph = await fetch("https://backend.payhero.co.ke/api/v2/transaction-status?reference=nsh-test-none", { headers: { Authorization: auth } });
  ok("PayHero credentials accepted", ph.status !== 401 && ph.status !== 403, `http ${ph.status}`);

  const mp = `top_test_${crypto.randomBytes(6).toString("hex")}`;
  await sql`INSERT INTO topups (id, user_id, mode, method, usd, nsh, kes, phone, provider_ref)
    VALUES (${mp}, ${user.id}, 'live', 'mpesa', 1, 100, 129, '254700000000', ${mp})`;
  r = await post("webhooks/payhero", { status: true, response: { ExternalReference: mp, ResultCode: 0, MpesaReceiptNumber: "FAKE123456", Amount: 129 } });
  let [m] = await sql`SELECT status FROM topups WHERE id = ${mp}`;
  ok("forged M-Pesa success callback does not credit", r.status === 200 && m.status === "pending", m.status);
  r = await post("webhooks/payhero", { status: false, response: { ExternalReference: mp, ResultCode: 1032, ResultDesc: "Request cancelled by user" } });
  [m] = await sql`SELECT status, failure FROM topups WHERE id = ${mp}`;
  ok("M-Pesa decline callback marks it failed", m.status === "failed", m.failure);

  const { completeTopup } = await import("../api/_pay.js");
  const paid = `top_test_${crypto.randomBytes(6).toString("hex")}`;
  await sql`INSERT INTO topups (id, user_id, mode, method, usd, nsh, kes, phone, provider_ref)
    VALUES (${paid}, ${user.id}, 'live', 'mpesa', 2, 200, 258, '254700000000', ${paid})`;
  await completeTopup(paid, { receipt: "TEST0RCPT1" });
  await completeTopup(paid, { receipt: "TEST0RCPT1" });
  const s = await get(`topup/status?id=${paid}`);
  const [led] = await sql`SELECT count(*)::int AS n FROM ledger WHERE user_id = ${user.id} AND ref = ${paid}`;
  const [mail] = await sql`SELECT emailed_at FROM topups WHERE id = ${paid}`;
  ok("confirmed payment credits wallet once", s.json.status === "paid" && s.json.balance === 200 && led.n === 1, `balance ${s.json.balance}, ledger rows ${led.n}`);
  ok("receipt email sent", Boolean(mail.emailed_at), EMAIL);
} finally {
  await sql`DELETE FROM ledger WHERE user_id = ${user.id}`;
  await sql`DELETE FROM balances WHERE user_id = ${user.id}`;
  await sql`DELETE FROM topups WHERE user_id = ${user.id}`;
  await sql`DELETE FROM sessions WHERE user_id = ${user.id}`;
  await sql`DELETE FROM users WHERE id = ${user.id}`;
}
