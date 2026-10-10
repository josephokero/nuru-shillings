import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.replace(/^\uFEFF/, "").match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const sql = neon(process.env.DATABASE_URL);
await sql.query(`ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_key text,
  ADD COLUMN IF NOT EXISTS prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS kyc_session text,
  ADD COLUMN IF NOT EXISTS kyc_status text`);
await sql.query(`CREATE INDEX IF NOT EXISTS users_kyc_session_idx ON users (kyc_session)`);
await sql.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz`);

const [{ data_type: idType }] = await sql.query(`SELECT data_type FROM information_schema.columns
  WHERE table_name = 'users' AND column_name = 'id'`);
await sql.query(`CREATE TABLE IF NOT EXISTS topups (
  id text PRIMARY KEY,
  user_id ${idType} NOT NULL REFERENCES users(id),
  mode text NOT NULL,
  method text NOT NULL,
  usd integer NOT NULL,
  nsh bigint NOT NULL,
  kes integer,
  phone text,
  provider_ref text UNIQUE,
  receipt text,
  status text NOT NULL DEFAULT 'pending',
  failure text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  emailed_at timestamptz
)`);
await sql.query(`CREATE INDEX IF NOT EXISTS topups_user_idx ON topups (user_id, created_at DESC)`);

console.log("users.id type:", idType);
console.log("paypal mode:", process.env.PAYPAL_MODE || "(unset)");
const cols = await sql.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'topups' ORDER BY ordinal_position`);
console.log("topups:", cols.map((c) => c.column_name).join(", "));
