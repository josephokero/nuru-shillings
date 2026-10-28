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
const run = (q) => sql.query(q);

/* ---------- two-step sign-in, passkeys, security log ---------- */

await run(`ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_secret text,
  ADD COLUMN IF NOT EXISTS totp_enabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS totp_last_step bigint,
  ADD COLUMN IF NOT EXISTS recovery_codes text[],
  ADD COLUMN IF NOT EXISTS frozen_at timestamptz,
  ADD COLUMN IF NOT EXISTS frozen_reason text`);

await run(`ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS mfa_at timestamptz,
  ADD COLUMN IF NOT EXISTS method text,
  ADD COLUMN IF NOT EXISTS ip text,
  ADD COLUMN IF NOT EXISTS user_agent text`);

await run(`CREATE TABLE IF NOT EXISTS passkeys (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key text NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[],
  name text NOT NULL DEFAULT 'Passkey',
  device_type text,
  backed_up boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
)`);
await run(`CREATE INDEX IF NOT EXISTS passkeys_user_idx ON passkeys (user_id)`);

await run(`CREATE TABLE IF NOT EXISTS auth_challenges (
  id text PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  challenge text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
)`);
await run(`CREATE INDEX IF NOT EXISTS auth_challenges_exp_idx ON auth_challenges (expires_at)`);

await run(`CREATE TABLE IF NOT EXISTS security_events (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  ip text,
  user_agent text,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
)`);
await run(`CREATE INDEX IF NOT EXISTS security_events_user_idx ON security_events (user_id, created_at DESC)`);

/* ---------- money integrity, enforced by the database itself ---------- */

// Test clean-up scripts may delete their own rows inside a transaction that sets nsh.purge = on. The app never does.
await run(`CREATE OR REPLACE FUNCTION nsh_purging() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('nsh.purge', true), '') = 'on' $$`);

await run(`CREATE OR REPLACE FUNCTION nsh_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND nsh_purging() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'ledger is append-only: rows cannot be changed or deleted' USING ERRCODE = 'P0001';
END $$`);
await run(`DROP TRIGGER IF EXISTS ledger_append_only ON ledger`);
await run(`CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON ledger
  FOR EACH ROW EXECUTE FUNCTION nsh_ledger_guard()`);

// Checked at commit: a balance can only ever equal the sum of its ledger rows.
await run(`CREATE OR REPLACE FUNCTION nsh_balance_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cur bigint; total bigint;
BEGIN
  SELECT amount INTO cur FROM balances WHERE user_id = NEW.user_id AND mode = NEW.mode;
  SELECT coalesce(sum(amount), 0) INTO total FROM ledger WHERE user_id = NEW.user_id AND mode = NEW.mode;
  IF coalesce(cur, 0) <> total THEN
    RAISE EXCEPTION 'balance % does not match ledger % for %/%', coalesce(cur, 0), total, NEW.user_id, NEW.mode USING ERRCODE = 'P0002';
  END IF;
  RETURN NULL;
END $$`);
await run(`DROP TRIGGER IF EXISTS balances_match_ledger ON balances`);
await run(`CREATE CONSTRAINT TRIGGER balances_match_ledger AFTER INSERT OR UPDATE ON balances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nsh_balance_matches_ledger()`);
await run(`DROP TRIGGER IF EXISTS ledger_matches_balance ON ledger`);
await run(`CREATE CONSTRAINT TRIGGER ledger_matches_balance AFTER INSERT ON ledger
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nsh_balance_matches_ledger()`);

await run(`CREATE OR REPLACE FUNCTION nsh_money_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF nsh_purging() THEN RETURN OLD; END IF;
    RAISE EXCEPTION '% rows are permanent records and cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;

  IF TG_TABLE_NAME = 'topups' THEN
    IF NEW.user_id <> OLD.user_id OR NEW.mode <> OLD.mode OR NEW.method <> OLD.method OR NEW.usd <> OLD.usd OR NEW.nsh <> OLD.nsh
       OR NEW.kes IS DISTINCT FROM OLD.kes OR NEW.phone IS DISTINCT FROM OLD.phone
       OR (OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref)
       OR (OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt) THEN
      RAISE EXCEPTION 'top-up % amounts, owner and provider records cannot be changed', OLD.id USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status IN ('paid', 'reversed') AND NEW.status <> OLD.status AND NOT (OLD.status = 'paid' AND NEW.status = 'reversed') THEN
      RAISE EXCEPTION 'top-up % is % and cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'P0001';
    END IF;

  ELSIF TG_TABLE_NAME = 'payments' THEN
    IF NEW.merchant_id <> OLD.merchant_id OR NEW.mode <> OLD.mode OR NEW.amount <> OLD.amount OR NEW.fee <> OLD.fee
       OR (OLD.payer_id IS NOT NULL AND NEW.payer_id IS DISTINCT FROM OLD.payer_id) THEN
      RAISE EXCEPTION 'payment % amounts and parties cannot be changed', OLD.id USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status <> OLD.status AND NOT ((OLD.status = 'pending' AND NEW.status = 'paid') OR (OLD.status = 'paid' AND NEW.status = 'refunded')) THEN
      RAISE EXCEPTION 'payment % cannot go from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'P0001';
    END IF;

  ELSIF TG_TABLE_NAME = 'deposits' THEN
    IF NEW.app_id <> OLD.app_id OR NEW.owner_id <> OLD.owner_id OR NEW.mode <> OLD.mode OR NEW.amount <> OLD.amount OR NEW.fee <> OLD.fee
       OR (OLD.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id)
       OR (OLD.connection_id IS NOT NULL AND NEW.connection_id IS DISTINCT FROM OLD.connection_id) THEN
      RAISE EXCEPTION 'deposit % amounts and parties cannot be changed', OLD.id USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status <> OLD.status AND OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'deposit % is already %', OLD.id, OLD.status USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$`);
for (const t of ["topups", "payments", "deposits"]) {
  await run(`DROP TRIGGER IF EXISTS ${t}_guard ON ${t}`);
  await run(`CREATE TRIGGER ${t}_guard BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION nsh_money_guard()`);
}

const [check] = await sql`SELECT count(*)::int AS bad FROM balances b
  LEFT JOIN (SELECT user_id, mode, sum(amount) AS total FROM ledger GROUP BY 1, 2) l USING (user_id, mode)
  WHERE b.amount <> coalesce(l.total, 0)`;
console.log(`security migration done; balances not matching ledger: ${check.bad}`);
