-- 002: institution structure (branches, Makatib, teachers, students),
-- file attachments and a transfer history.
-- Additive only: creates new tables and adds one nullable column to admissions.
-- Safe to run more than once. Can also be pasted into a Postgres / Supabase SQL editor.

-- Shared trigger that keeps updated_at current
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS branches (
  id             SERIAL PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name_en        TEXT NOT NULL,
  name_ur        TEXT,
  district       TEXT NOT NULL,
  tehsil         TEXT,
  town           TEXT,
  address        TEXT,
  manager_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone          TEXT,
  established_on DATE,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teachers (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  full_name   TEXT NOT NULL,
  name_ur     TEXT,
  father_name TEXT,
  gender      TEXT NOT NULL CHECK (gender IN ('male','female')),
  cnic        TEXT UNIQUE,
  phone       TEXT,
  qualification TEXT,
  branch_id   INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  maktab_id   INTEGER,  -- foreign key added below, after makatib exists
  joined_on   DATE,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','left')),
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS makatib (
  id                 SERIAL PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE,
  name_en            TEXT NOT NULL,
  name_ur            TEXT,
  district           TEXT NOT NULL,
  tehsil             TEXT,
  town               TEXT,
  address            TEXT,
  branch_id          INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  manager_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  primary_teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  phone              TEXT,
  established_on     DATE,
  classrooms         INTEGER CHECK (classrooms IS NULL OR classrooms >= 0),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teachers_maktab_fk') THEN
    ALTER TABLE teachers ADD CONSTRAINT teachers_maktab_fk FOREIGN KEY (maktab_id) REFERENCES makatib(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS students (
  id           SERIAL PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,              -- admission / GR number
  full_name    TEXT NOT NULL,
  name_ur      TEXT,
  father_name  TEXT,
  gender       TEXT NOT NULL CHECK (gender IN ('male','female')),
  dob          DATE,
  phone        TEXT,
  programme    TEXT,
  branch_id    INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  maktab_id    INTEGER REFERENCES makatib(id) ON DELETE SET NULL,
  admission_id INTEGER REFERENCES admissions(id) ON DELETE SET NULL,
  enrolled_on  DATE,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','graduated','left')),
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Photos and documents for branches and Makatib. Files live in the uploads/ folder;
-- only metadata is stored here.
CREATE TABLE IF NOT EXISTS attachments (
  id          SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('branch','maktab')),
  entity_id   INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('photo','document')),
  file_name   TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every move of a teacher or student between Makatib
CREATE TABLE IF NOT EXISTS transfers (
  id             SERIAL PRIMARY KEY,
  person_type    TEXT NOT NULL CHECK (person_type IN ('teacher','student')),
  person_id      INTEGER NOT NULL,
  from_maktab_id INTEGER REFERENCES makatib(id) ON DELETE SET NULL,
  to_maktab_id   INTEGER REFERENCES makatib(id) ON DELETE SET NULL,
  note           TEXT,
  transferred_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admissions can be linked to the Maktab the student applies to
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS maktab_id INTEGER REFERENCES makatib(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS branches_district_idx  ON branches (district);
CREATE INDEX IF NOT EXISTS branches_status_idx    ON branches (status);
CREATE INDEX IF NOT EXISTS makatib_branch_idx     ON makatib (branch_id);
CREATE INDEX IF NOT EXISTS makatib_district_idx   ON makatib (district);
CREATE INDEX IF NOT EXISTS makatib_status_idx     ON makatib (status);
CREATE INDEX IF NOT EXISTS teachers_branch_idx    ON teachers (branch_id);
CREATE INDEX IF NOT EXISTS teachers_maktab_idx    ON teachers (maktab_id);
CREATE INDEX IF NOT EXISTS students_branch_idx    ON students (branch_id);
CREATE INDEX IF NOT EXISTS students_maktab_idx    ON students (maktab_id);
CREATE INDEX IF NOT EXISTS students_status_idx    ON students (status);
CREATE INDEX IF NOT EXISTS attachments_entity_idx ON attachments (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS transfers_person_idx   ON transfers (person_type, person_id);
CREATE INDEX IF NOT EXISTS admissions_maktab_idx  ON admissions (maktab_id);

DROP TRIGGER IF EXISTS branches_updated_at ON branches;
CREATE TRIGGER branches_updated_at BEFORE UPDATE ON branches FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS makatib_updated_at ON makatib;
CREATE TRIGGER makatib_updated_at BEFORE UPDATE ON makatib FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS teachers_updated_at ON teachers;
CREATE TRIGGER teachers_updated_at BEFORE UPDATE ON teachers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS students_updated_at ON students;
CREATE TRIGGER students_updated_at BEFORE UPDATE ON students FOR EACH ROW EXECUTE FUNCTION set_updated_at();
