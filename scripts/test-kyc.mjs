import fs from "node:fs";
import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";

for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.replace(/^\uFEFF/, "").match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const BASE = process.env.TEST_BASE || "http://localhost:4173";
const EMAIL = `norashillings+kyctest${Date.now()}@benuru.com`;
const sql = neon(process.env.DATABASE_URL);
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const ok = (label, cond, extra = "") => console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  (${extra})` : ""}`);

const [user] = await sql`INSERT INTO users (email, last_login_at) VALUES (${EMAIL}, now()) RETURNING id`;
const token = crypto.randomBytes(32).toString("base64url");
await sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${sha(token)}, ${user.id}, now() + interval '1 day')`;
const headers = { Cookie: `nsh_session=${token}`, "Content-Type": "application/json" };
const call = async (route, data) => {
  const r = await fetch(`${BASE}/api/${route}`, data ? { method: "POST", headers, body: JSON.stringify(data) } : { headers });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

let session = null;
try {
  let r = await call("me?mode=live");
  ok("new account starts unverified", r.json.verified === false && r.json.kyc === "none", `kyc=${r.json.kyc}`);
  ok("identity checks switched on", r.json.kyc_ready === true);

  r = await call("wallet/withdraw", { mode: "live", amount: "100", method: "PayPal", destination: "me@example.com" });
  ok("withdraw blocked until verified", r.status === 403, r.json.error);

  r = await call("wallet/verify", { name: "Fake Person", country: "Kenya" });
  ok("old self-typed verify is gone", r.status === 404, String(r.status));

  r = await call("wallet/verify/start", {});
  ok("Didit session created", r.status === 200 && /didit\.me$/.test(new URL(r.json.url || "http://x").host), r.json.error || new URL(r.json.url).host);
  const firstUrl = r.json.url;

  [session] = await sql`SELECT kyc_session, kyc_status FROM users WHERE id = ${user.id}`;
  ok("session stored on the account", /^[0-9a-f-]{36}$/.test(session.kyc_session || ""), session.kyc_status);

  r = await call("wallet/verify/status");
  ok("status read from Didit: not verified yet", r.json.verified === false && ["not_started", "in_progress"].includes(r.json.kyc), r.json.kyc);

  r = await call("wallet/verify/start", {});
  ok("starting again reuses the open session", r.json.url === firstUrl);

  const forged = await fetch(`${BASE}/api/webhooks/didit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ webhook_type: "status.updated", session_id: session.kyc_session, status: "Approved", vendor_data: user.id, decision: { status: "Approved" } }),
  });
  const [after] = await sql`SELECT verified_at FROM users WHERE id = ${user.id}`;
  ok("forged 'Approved' webhook does not verify", forged.status === 200 && !after.verified_at);

  r = await call("me?mode=live");
  ok("wallet still locked for withdrawals", r.json.verified === false, `kyc=${r.json.kyc}`);
} finally {
  if (session?.kyc_session) {
    const d = await fetch(`https://verification.didit.me/v3/session/${session.kyc_session}/delete/`, {
      method: "DELETE", headers: { "x-api-key": process.env.DIDIT_API_KEY },
    });
    console.log(`cleanup: Didit test session ${d.ok ? "deleted" : `not deleted (${d.status})`}`);
  }
  await sql`DELETE FROM sessions WHERE user_id = ${user.id}`;
  await sql`DELETE FROM ledger WHERE user_id = ${user.id}`;
  await sql`DELETE FROM balances WHERE user_id = ${user.id}`;
  await sql`DELETE FROM users WHERE id = ${user.id}`;
}
