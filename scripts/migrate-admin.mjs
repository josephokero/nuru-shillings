/* Admin face lock: one phone passkey per admin email, enrolled once and never replaced from the site.
   Run: node scripts/migrate-admin.mjs */
import { neon } from "@neondatabase/serverless";
process.loadEnvFile(".env");
const sql = neon(process.env.DATABASE_URL);

await sql`CREATE TABLE IF NOT EXISTS admin_keys (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  public_key text NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[],
  device_type text,
  backed_up boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
)`;

await sql`CREATE OR REPLACE FUNCTION admin_keys_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('nsh.purge', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'The admin face key is permanent and cannot be removed';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.email IS DISTINCT FROM OLD.email
    OR NEW.public_key IS DISTINCT FROM OLD.public_key OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'The admin face key is permanent and cannot be changed';
  END IF;
  RETURN NEW;
END $$`;

await sql`DROP TRIGGER IF EXISTS admin_keys_guard ON admin_keys`;
await sql`CREATE TRIGGER admin_keys_guard BEFORE UPDATE OR DELETE ON admin_keys FOR EACH ROW EXECUTE FUNCTION admin_keys_guard()`;
await sql`DROP TRIGGER IF EXISTS admin_keys_no_truncate ON admin_keys`;
await sql`CREATE TRIGGER admin_keys_no_truncate BEFORE TRUNCATE ON admin_keys FOR EACH STATEMENT EXECUTE FUNCTION admin_keys_guard()`;

await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS admin_at timestamptz`;

const [t] = await sql`SELECT count(*)::int AS n FROM admin_keys`;
console.log(`admin_keys ready (${t.n} enrolled), sessions.admin_at ready`);
