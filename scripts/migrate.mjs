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

await sql.query(`CREATE TABLE IF NOT EXISTS withdrawals (
  id text PRIMARY KEY,
  user_id ${idType} NOT NULL REFERENCES users(id),
  mode text NOT NULL,
  method text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  destination text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  provider_ref text UNIQUE,
  receipt text,
  failure text,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  refunded_at timestamptz
)`);
await sql.query(`CREATE INDEX IF NOT EXISTS withdrawals_user_idx ON withdrawals (user_id, created_at DESC)`);
await sql.query(`CREATE INDEX IF NOT EXISTS withdrawals_open_idx ON withdrawals (status) WHERE status IN ('processing', 'unclaimed')`);
// Amount, owner and destination never change, and a finished payout never reopens.
await sql.query(`CREATE OR REPLACE FUNCTION nsh_withdrawal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('nsh.purge', true), '') = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'withdrawals are permanent records and cannot be deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.mode <> OLD.mode OR NEW.method <> OLD.method OR NEW.amount <> OLD.amount
     OR NEW.destination <> OLD.destination OR (OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref) THEN
    RAISE EXCEPTION 'withdrawal % amount, owner and destination cannot be changed', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('paid', 'failed') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'withdrawal % is % and cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$`);
await sql.query(`DROP TRIGGER IF EXISTS withdrawals_guard ON withdrawals`);
await sql.query(`CREATE TRIGGER withdrawals_guard BEFORE UPDATE OR DELETE ON withdrawals FOR EACH ROW EXECUTE FUNCTION nsh_withdrawal_guard()`);

console.log("users.id type:", idType);
console.log("paypal mode:", process.env.PAYPAL_MODE || "(unset)");
const cols = await sql.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'topups' ORDER BY ordinal_position`);
console.log("topups:", cols.map((c) => c.column_name).join(", "));
