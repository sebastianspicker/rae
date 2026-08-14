-- Bind artifact reservations to the worker attempt that produced their bytes.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS attempt_id UUID REFERENCES attempts(id) ON DELETE RESTRICT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS fence BIGINT;
