-- Reclaimable verification claims preserve existing artifact rows and states.
ALTER TABLE artifacts ADD COLUMN verification_claim_id UUID;
ALTER TABLE artifacts ADD COLUMN verification_claimed_at TIMESTAMPTZ;
ALTER TABLE artifacts ADD COLUMN verification_claim_expires_at TIMESTAMPTZ;
ALTER TABLE artifacts ADD COLUMN verification_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE artifacts ADD COLUMN rejected_at TIMESTAMPTZ;
ALTER TABLE artifacts ADD CONSTRAINT artifact_verification_claim_complete CHECK (
  (verification_claim_id IS NULL AND verification_claimed_at IS NULL AND verification_claim_expires_at IS NULL)
  OR (verification_claim_id IS NOT NULL AND verification_claimed_at IS NOT NULL AND verification_claim_expires_at > verification_claimed_at)
);
CREATE INDEX artifacts_verification_expiry_idx ON artifacts(verification_claim_expires_at)
  WHERE state='reserved' AND verification_claim_id IS NOT NULL;
