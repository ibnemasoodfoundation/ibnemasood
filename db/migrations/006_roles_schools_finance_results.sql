-- 006: new access roles, schools, parent logins, accounts (income and expenses), exams and results.
-- Additive only: creates new tables, adds nullable columns and widens CHECK constraints. No data is removed.

-- Roles: Makatib Nazim, School Principal, Accountant and Parent join the existing ones
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','manager','nazim','principal','accountant','teacher','parent','user'));

-- Announcements can also be addressed to parents only
ALTER TABLE announcements DROP CONSTRAINT IF EXISTS announcements_audience_check;
ALTER TABLE announcements ADD CONSTRAINT announcements_audience_check CHECK (audience IN ('all','staff','parents'));

-- Schools belong to a branch and are run by a principal
CREATE TABLE IF NOT EXISTS schools (
  id             SERIAL PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name_en        TEXT NOT NULL,
  name_ur        TEXT,
  branch_id      INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  principal_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  district       TEXT NOT NULL,
  town           TEXT,
  address        TEXT,
  phone          TEXT,
  levels         TEXT,
  established_on DATE,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schools_branch_idx ON schools (branch_id);
CREATE INDEX IF NOT EXISTS schools_principal_idx ON schools (principal_id);
DROP TRIGGER IF EXISTS schools_updated_at ON schools;
CREATE TRIGGER schools_updated_at BEFORE UPDATE ON schools FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE teachers ADD COLUMN IF NOT EXISTS school_id INTEGER REFERENCES schools(id) ON DELETE SET NULL;
ALTER TABLE students ADD COLUMN IF NOT EXISTS school_id INTEGER REFERENCES schools(id) ON DELETE SET NULL;
-- A parent login sees only their own children; one parent can have several children
ALTER TABLE students ADD COLUMN IF NOT EXISTS parent_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS teachers_school_idx ON teachers (school_id);
CREATE INDEX IF NOT EXISTS students_school_idx ON students (school_id);
CREATE INDEX IF NOT EXISTS students_parent_idx ON students (parent_user_id);

-- Accounts: every income and expense entry. Verified donations are counted separately from the donations table.
CREATE TABLE IF NOT EXISTS finance_entries (
  id          SERIAL PRIMARY KEY,
  entry_type  TEXT NOT NULL CHECK (entry_type IN ('income','expense')),
  entry_date  DATE NOT NULL,
  category    TEXT NOT NULL,
  description TEXT,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  method      TEXT,
  party       TEXT,
  reference   TEXT,
  branch_id   INTEGER REFERENCES branches(id) ON DELETE SET NULL,
  school_id   INTEGER REFERENCES schools(id) ON DELETE SET NULL,
  maktab_id   INTEGER REFERENCES makatib(id) ON DELETE SET NULL,
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_date_idx ON finance_entries (entry_date);
CREATE INDEX IF NOT EXISTS finance_type_idx ON finance_entries (entry_type, category);
DROP TRIGGER IF EXISTS finance_updated_at ON finance_entries;
CREATE TRIGGER finance_updated_at BEFORE UPDATE ON finance_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Exams: for all Makatib (maktab_id and school_id both empty), one Maktab, or one school.
-- subjects is a list of {"name": "...", "total": 100}.
CREATE TABLE IF NOT EXISTS exams (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  exam_type    TEXT NOT NULL DEFAULT 'annual' CHECK (exam_type IN ('monthly','quarterly','half_yearly','annual','other')),
  session_year TEXT,
  held_on      DATE,
  maktab_id    INTEGER REFERENCES makatib(id) ON DELETE SET NULL,
  school_id    INTEGER REFERENCES schools(id) ON DELETE SET NULL,
  subjects     JSONB NOT NULL DEFAULT '[]',
  pass_percent INTEGER NOT NULL DEFAULT 40 CHECK (pass_percent BETWEEN 0 AND 100),
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (maktab_id IS NULL OR school_id IS NULL)
);
DROP TRIGGER IF EXISTS exams_updated_at ON exams;
CREATE TRIGGER exams_updated_at BEFORE UPDATE ON exams FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One result per student per exam. marks holds the obtained marks in the exam's subject order.
CREATE TABLE IF NOT EXISTS results (
  id          SERIAL PRIMARY KEY,
  exam_id     INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  marks       JSONB NOT NULL DEFAULT '[]',
  obtained    INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  percentage  NUMERIC(5,2) NOT NULL DEFAULT 0,
  grade       TEXT,
  remarks     TEXT,
  entered_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (exam_id, student_id)
);
CREATE INDEX IF NOT EXISTS results_student_idx ON results (student_id);
DROP TRIGGER IF EXISTS results_updated_at ON results;
CREATE TRIGGER results_updated_at BEFORE UPDATE ON results FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Same protection as 003: closed to Supabase's public API, open to the app's own server
ALTER TABLE schools         ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE exams           ENABLE ROW LEVEL SECURITY;
ALTER TABLE results         ENABLE ROW LEVEL SECURITY;
