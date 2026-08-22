/**
 * Boot-time schema bootstrap for the initial phase: idempotent CREATE TABLE
 * IF NOT EXISTS statements matching src/db/schema.ts exactly. Tests run this
 * against PGlite; the server runs it on boot. Real migration history moves to
 * drizzle-kit (see drizzle.config.ts) once the schema stops churning.
 */

import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

const STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    display_name text,
    home_region text NOT NULL DEFAULT 'iad',
    features text[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Databases bootstrapped before Phase 2 lack the feature-flag column.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS features text[] NOT NULL DEFAULT '{}'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS compute_mode text NOT NULL DEFAULT 'cloud'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS home_device_id uuid`,
  `CREATE TABLE IF NOT EXISTS invites (
    code text PRIMARY KEY,
    email text,
    note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    redeemed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    redeemed_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS passkeys (
    id text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key text NOT NULL,
    prf_capable boolean NOT NULL DEFAULT false,
    sign_count integer NOT NULL DEFAULT 0,
    label text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
  )`,
  // Databases bootstrapped before Phase 1 lack the counter column.
  `ALTER TABLE passkeys ADD COLUMN IF NOT EXISTS sign_count integer NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    platform text NOT NULL,
    device_public_key text NOT NULL UNIQUE,
    enrolled_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    revocation_reason text,
    last_seen_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS spaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    color text NOT NULL,
    position integer NOT NULL DEFAULT 0,
    egress_policy text NOT NULL DEFAULT 'direct',
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS key_wrappers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    kind text NOT NULL,
    credential_id text NOT NULL,
    salt text NOT NULL DEFAULT '',
    wrapped text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS key_wrappers_space_kind_credential_idx
    ON key_wrappers (space_id, kind, credential_id)`,
  `CREATE TABLE IF NOT EXISTS enrollment_codes (
    code_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    redeemed_at timestamptz,
    wrap_salt text,
    wrappers jsonb
  )`,
  // Databases bootstrapped before key-transfer lack the wrapper columns.
  `ALTER TABLE enrollment_codes ADD COLUMN IF NOT EXISTS wrap_salt text`,
  `ALTER TABLE enrollment_codes ADD COLUMN IF NOT EXISTS wrappers jsonb`,
  `CREATE TABLE IF NOT EXISTS assistant_link_codes (
    code_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    redeemed_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS channel_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel text NOT NULL,
    account_id text NOT NULL,
    external_user_id text NOT NULL,
    display_name text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_links_external_identity_idx
    ON channel_links (channel, account_id, external_user_id)`,
  `CREATE INDEX IF NOT EXISTS channel_links_user_created_idx
    ON channel_links (user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS assistant_policies (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    model text NOT NULL,
    enabled_tool_groups text[] NOT NULL,
    max_steps integer NOT NULL,
    daily_wake_minutes integer NOT NULL,
    auto_suspend_minutes integer NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS machines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    state text NOT NULL,
    region text NOT NULL,
    cpu_kind text NOT NULL,
    cpus integer NOT NULL,
    memory_mb integer NOT NULL,
    agent_address text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_transition_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Databases bootstrapped before the Fly provider lack the address column.
  `ALTER TABLE machines ADD COLUMN IF NOT EXISTS agent_address text`,
  `CREATE TABLE IF NOT EXISTS machine_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    machine_id uuid NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    from_state text NOT NULL,
    to_state text NOT NULL,
    reconstructed boolean NOT NULL DEFAULT false,
    detail text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS machine_activity (
    machine_id uuid PRIMARY KEY REFERENCES machines(id) ON DELETE CASCADE,
    clients_attached integer NOT NULL DEFAULT 0,
    processes jsonb NOT NULL DEFAULT '[]'::jsonb,
    active_transfers integer NOT NULL DEFAULT 0,
    last_interaction_at timestamptz NOT NULL,
    awake_ms_accrued bigint NOT NULL DEFAULT 0,
    last_report_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS usage_samples (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    machine_id uuid NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    period_start timestamptz NOT NULL,
    awake_ms bigint NOT NULL DEFAULT 0,
    proxied_bytes bigint NOT NULL DEFAULT 0,
    storage_gb double precision NOT NULL DEFAULT 0,
    source text NOT NULL DEFAULT 'agent',
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Databases bootstrapped before the agent/gateway metering split lack the
  // reporting-plane column; defaulting them to 'agent' retires the egress
  // figures the VM could have reported (I-3).
  `ALTER TABLE usage_samples ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'agent'`,
  `CREATE INDEX IF NOT EXISTS usage_samples_user_period_idx
    ON usage_samples (user_id, period_start)`,
  `CREATE TABLE IF NOT EXISTS inference_usage (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id uuid,
    path text NOT NULL,
    model text,
    status integer NOT NULL,
    input_tokens integer,
    output_tokens integer,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS inference_usage_user_created_idx
    ON inference_usage (user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS revocation_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    device_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    attempts integer NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path text NOT NULL,
    size_bytes bigint NOT NULL DEFAULT 0,
    file_hash text NOT NULL,
    content_type text,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS files_user_path_idx ON files (user_id, path)`,
  // "offset" is a reserved word in Postgres, hence the quoting.
  `CREATE TABLE IF NOT EXISTS file_chunks (
    file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    idx integer NOT NULL,
    hash text NOT NULL,
    "offset" bigint NOT NULL,
    length integer NOT NULL,
    PRIMARY KEY (file_id, idx)
  )`,
  `CREATE INDEX IF NOT EXISTS file_chunks_hash_idx ON file_chunks (hash)`,
  `CREATE TABLE IF NOT EXISTS chunks (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hash text NOT NULL,
    size_bytes integer NOT NULL,
    ref_count integer NOT NULL DEFAULT 0,
    stored_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, hash)
  )`,
  `CREATE TABLE IF NOT EXISTS transfers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url text NOT NULL,
    dest_path text NOT NULL,
    state text NOT NULL,
    received_bytes bigint NOT NULL DEFAULT 0,
    total_bytes bigint NOT NULL DEFAULT 0,
    origin_device_id uuid,
    error text,
    started_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS transfers_user_started_idx ON transfers (user_id, started_at)`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_device_id uuid,
    type text NOT NULL,
    payload jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS audit_events_user_created_idx
    ON audit_events (user_id, created_at)`,
];

export async function ensureSchema(db: Db): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
}
