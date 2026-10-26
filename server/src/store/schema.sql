-- Syncanvas persistence schema (stage 4).
--
-- Every statement is idempotent: the gateway runs this file on startup when a
-- database is configured, and the migration command runs it explicitly.
-- The CRDT document itself is not stored relationally — the append-only
-- operation log plus periodic snapshots are the source of truth.

CREATE TABLE IF NOT EXISTS users (
  id           text PRIMARY KEY,
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  owner_id   text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);

-- One row per accepted CRDT operation. `seq` is the broadcast watermark of
-- the batch it arrived in, not a merge rule; the envelope carries the HLC and
-- op id that decide conflicts inside the CRDT.
CREATE TABLE IF NOT EXISTS operations (
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  op_id       text NOT NULL,
  actor_id    text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seq         bigint NOT NULL,
  hlc_wall    bigint NOT NULL,
  hlc_counter integer NOT NULL,
  envelope    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, op_id)
);

CREATE INDEX IF NOT EXISTS operations_document_seq_idx
  ON operations (document_id, seq, op_id);

-- Full CRDT document at a known watermark (registers, tombstones, RGA order
-- and seen ids). Loading takes the newest snapshot and replays only the
-- operations after it; the projected scene alone would not be replay-safe.
CREATE TABLE IF NOT EXISTS snapshots (
  id          bigserial PRIMARY KEY,
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  state       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS snapshots_document_seq_idx
  ON snapshots (document_id, seq DESC, id DESC);
