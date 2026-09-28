-- Experimental RAE hosted-platform control-plane schema.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revisions (
  id UUID PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id UUID REFERENCES revisions(id),
  digest TEXT NOT NULL,
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, digest)
);
CREATE TABLE IF NOT EXISTS runs (
  id UUID PRIMARY KEY,
  project_id TEXT NOT NULL,
  revision_id UUID NOT NULL REFERENCES revisions(id),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  request JSONB NOT NULL,
  traceparent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS run_nodes (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'succeeded', 'failed', 'cancelled')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (run_id, node_key)
);
CREATE TABLE IF NOT EXISTS attempts (
  id UUID PRIMARY KEY,
  node_id UUID NOT NULL REFERENCES run_nodes(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  fence BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'expired')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  result JSONB,
  UNIQUE (node_id, fence)
);
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS leases (
  node_id UUID PRIMARY KEY REFERENCES run_nodes(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  fence BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS signals (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS artifacts (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt_id UUID NOT NULL REFERENCES attempts(id) ON DELETE RESTRICT,
  fence BIGINT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT,
  size_bytes BIGINT,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'verified', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  traceparent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY,
  topic TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS run_nodes_claim_idx ON run_nodes (state, id) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS events_run_idx ON events (run_id, id);
