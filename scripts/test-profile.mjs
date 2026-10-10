import fs from "node:fs";
import crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";

for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = line.replace(/^\uFEFF/, "").match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const BASE = process.env.TEST_BASE || "http://localhost:4173";
const EMAIL = process.env.TEST_EMAIL || "norashillings@benuru.com";
const sql = neon(process.env.DATABASE_URL);
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const ok = (label, cond, extra = "") => console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  (${extra})` : ""}`);

const [user] = await sql`SELECT id FROM users WHERE email = ${EMAIL}`;
if (!user) throw new Error("test user missing");
const token = crypto.randomBytes(32).toString("base64url");
await sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${sha(token)}, ${user.id}, now() + interval '10 days')`;
const headers = { Cookie: `nsh_session=${token}` };

try {
  let r = await fetch(`${BASE}/api/me?mode=test`, { headers });
  const setCookie = r.headers.get("set-cookie") || "";
  ok("me with session", r.status === 200, `status ${r.status}`);
  ok("session renewed (cookie re-sent for a year)", /Max-Age=31536000/.test(setCookie));
  const [s] = await sql`SELECT expires_at FROM sessions WHERE token_hash = ${sha(token)}`;
  ok("session expiry pushed ~365 days in DB", new Date(s.expires_at) - Date.now() > 360 * 864e5);

  const image = `data:image/jpeg;base64,${fs.readFileSync("img/emanuel.jpg").toString("base64")}`;
  r = await fetch(`${BASE}/api/profile/avatar`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ image }) });
  const up = await r.json();
  ok("avatar upload to Bunny", r.status === 200 && up.avatar, up.error || up.avatar);

  if (up.avatar) {
    r = await fetch(`${BASE}${up.avatar}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    ok("avatar served back", r.status === 200 && bytes.length > 1000, `${r.status}, ${bytes.length} bytes, ${r.headers.get("content-type")}`);
    r = await fetch(`${BASE}/api/me?mode=test`, { headers });
    const me = await r.json();
    ok("me returns avatar url", me.avatar === up.avatar);
  }

  r = await fetch(`${BASE}/api/profile/prefs`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "test", withdraw_method: "M-Pesa", withdraw_destination: "+254700000000", add_method: "Card" }) });
  const pr = await r.json();
  ok("prefs saved", r.status === 200 && pr.prefs?.withdraw_method === "M-Pesa", JSON.stringify(pr.prefs || pr));

  r = await fetch(`${BASE}/api/profile/avatar/remove`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
  ok("avatar removed", r.status === 200);
  if (up.avatar) {
    r = await fetch(`${BASE}${up.avatar}`);
    ok("removed avatar no longer served", r.status === 404, `status ${r.status}`);
  }
  r = await fetch(`${BASE}/api/avatar?k=../../etc`);
  ok("bad avatar key rejected", r.status === 404);
} finally {
  await sql`DELETE FROM sessions WHERE token_hash = ${sha(token)}`;
  await sql`UPDATE users SET prefs = '{}'::jsonb WHERE id = ${user.id}`;
}
