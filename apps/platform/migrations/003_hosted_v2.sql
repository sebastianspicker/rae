-- Hosted v2 control-plane additions. Revisions are immutable and activation is explicit.
CREATE TABLE IF NOT EXISTS platform_revisions (
  id UUID PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('workflow','profile')),
  digest TEXT NOT NULL, document JSONB NOT NULL, validation JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, kind, digest)
);
CREATE TABLE IF NOT EXISTS active_revisions (project_id TEXT NOT NULL, kind TEXT NOT NULL, revision_id UUID NOT NULL REFERENCES platform_revisions(id), digest TEXT NOT NULL, activated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (project_id, kind));
ALTER TABLE runs ADD COLUMN IF NOT EXISTS workflow_revision_id UUID REFERENCES platform_revisions(id);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS profile_revision_id UUID REFERENCES platform_revisions(id);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS pinned_worker_id TEXT REFERENCES workers(id);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS repository_digest TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS worktree_digest TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE run_nodes ADD COLUMN IF NOT EXISTS access TEXT NOT NULL DEFAULT 'read' CHECK (access IN ('read','write'));
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS expected_sha256 TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS expected_size_bytes BIGINT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS quarantine_key TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS object_version_id TEXT;
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_object_key_key;
CREATE INDEX IF NOT EXISTS platform_revisions_project_idx ON platform_revisions(project_id, kind, created_at);
CREATE INDEX IF NOT EXISTS leases_expiry_idx ON leases(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_attempt_object_idx ON artifacts(attempt_id, fence, object_key);
