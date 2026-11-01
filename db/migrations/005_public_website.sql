-- 005: what the public website may show.
-- Additive only. Defaults keep everything private except a Maktab/branch's name and area.

-- Branches and Makatib: listed in the public directory? phone shown publicly? programmes offered
ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS public_listing BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS show_phone     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS programmes     TEXT;
ALTER TABLE makatib
  ADD COLUMN IF NOT EXISTS public_listing BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS show_phone     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS programmes     TEXT;

-- Photos approved for the website, with an optional caption.
ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS caption   TEXT;

-- Only branch and Maktab photographs can ever be public. Teacher and student photos and all
-- documents (CNIC, B-Form, certificates, letters) stay private, enforced by the database itself.
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_public_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_public_check
  CHECK (NOT is_public OR (kind = 'photo' AND entity_type IN ('branch','maktab')));

CREATE INDEX IF NOT EXISTS attachments_public_idx ON attachments (is_public) WHERE is_public;
