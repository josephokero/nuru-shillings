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

await sql.query(`CREATE TABLE IF NOT EXISTS apps (
  id text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  website text,
  redirect_uris text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
)`);
await sql.query(`CREATE INDEX IF NOT EXISTS apps_owner_idx ON apps (owner_id) WHERE deleted_at IS NULL`);

await sql.query(`CREATE TABLE IF NOT EXISTS connections (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id),
  user_id uuid NOT NULL REFERENCES users(id),
  mode text NOT NULL,
  scopes text[] NOT NULL,
  daily_limit bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
)`);
await sql.query(`CREATE UNIQUE INDEX IF NOT EXISTS connections_live_idx ON connections (app_id, user_id, mode) WHERE revoked_at IS NULL`);
await sql.query(`CREATE INDEX IF NOT EXISTS connections_user_idx ON connections (user_id, mode)`);

await sql.query(`CREATE TABLE IF NOT EXISTS connect_codes (
  code_hash text PRIMARY KEY,
  connection_id text NOT NULL REFERENCES connections(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
)`);

await sql.query(`CREATE TABLE IF NOT EXISTS app_moves (
  id text PRIMARY KEY,
  connection_id text NOT NULL REFERENCES connections(id),
  kind text NOT NULL,
  amount bigint NOT NULL,
  fee bigint NOT NULL DEFAULT 0,
  reference text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
)`);
await sql.query(`CREATE INDEX IF NOT EXISTS app_moves_conn_idx ON app_moves (connection_id, created_at DESC)`);

await sql.query(`ALTER TABLE apps ADD COLUMN IF NOT EXISTS brand_color text`);
await sql.query(`ALTER TABLE apps ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'dark'`);
await sql.query(`ALTER TABLE apps ADD COLUMN IF NOT EXISTS logo_url text`);

await sql.query(`CREATE TABLE IF NOT EXISTS deposits (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  mode text NOT NULL,
  connection_id text REFERENCES connections(id),
  user_id uuid REFERENCES users(id),
  amount bigint NOT NULL,
  fee bigint NOT NULL,
  reference text,
  description text,
  return_url text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz
)`);
await sql.query(`CREATE INDEX IF NOT EXISTS deposits_owner_idx ON deposits (owner_id, mode, created_at DESC)`);
await sql.query(`CREATE INDEX IF NOT EXISTS deposits_user_idx ON deposits (user_id, created_at DESC)`);

for (const t of ["apps", "connections", "connect_codes", "app_moves", "deposits"]) {
  const cols = await sql.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [t]);
  console.log(`${t}:`, cols.map((c) => c.column_name).join(", "));
}
