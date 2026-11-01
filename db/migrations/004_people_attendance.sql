-- 004: full teacher and student profiles, teacher logins, photos/documents for people,
-- student progress, and student / teacher attendance.
-- Additive only: adds columns and tables, and widens CHECK constraints. No data is removed.

-- Teacher accounts
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','manager','teacher','user'));

-- Teachers: personal, qualification and employment details
ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS dob DATE,
  ADD COLUMN IF NOT EXISTS whatsapp TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS district TEXT,
  ADD COLUMN IF NOT EXISTS contemporary_qualification TEXT,
  ADD COLUMN IF NOT EXISTS hifz_status TEXT,
  ADD COLUMN IF NOT EXISTS tajweed_status TEXT,
  ADD COLUMN IF NOT EXISTS experience_years INTEGER CHECK (experience_years IS NULL OR experience_years BETWEEN 0 AND 70),
  ADD COLUMN IF NOT EXISTS additional_qualifications TEXT,
  ADD COLUMN IF NOT EXISTS designation TEXT,
  ADD COLUMN IF NOT EXISTS employment_type TEXT,
  ADD COLUMN IF NOT EXISTS salary INTEGER CHECK (salary IS NULL OR salary >= 0),
  ADD COLUMN IF NOT EXISTS user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL;
COMMENT ON COLUMN teachers.qualification IS 'Religious education qualification';
COMMENT ON COLUMN teachers.joined_on IS 'Appointment date';

ALTER TABLE teachers DROP CONSTRAINT IF EXISTS teachers_status_check;
ALTER TABLE teachers ADD CONSTRAINT teachers_status_check CHECK (status IN ('active','on_leave','inactive','left','archived'));

-- Students: family, education and placement details
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS mother_name TEXT,
  ADD COLUMN IF NOT EXISTS cnic_bform TEXT,
  ADD COLUMN IF NOT EXISTS guardian_phone TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS education_level TEXT,
  ADD COLUMN IF NOT EXISTS quran_level TEXT,
  ADD COLUMN IF NOT EXISTS previous_institution TEXT,
  ADD COLUMN IF NOT EXISTS hifz_status TEXT,
  ADD COLUMN IF NOT EXISTS tajweed_status TEXT,
  ADD COLUMN IF NOT EXISTS class_name TEXT,
  ADD COLUMN IF NOT EXISTS teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL;
COMMENT ON COLUMN students.enrolled_on IS 'Admission date';

-- Photos and documents for teachers and students too; category = CNIC front, certificate, ...
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_entity_type_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_entity_type_check CHECK (entity_type IN ('branch','maktab','teacher','student'));
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS category TEXT;

-- Educational progress log
CREATE TABLE IF NOT EXISTS student_progress (
  id          SERIAL PRIMARY KEY,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  recorded_on DATE NOT NULL DEFAULT CURRENT_DATE,
  quran_level TEXT,
  lesson      TEXT,
  remarks     TEXT,
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One mark per student, day and session
CREATE TABLE IF NOT EXISTS student_attendance (
  id         SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  maktab_id  INTEGER REFERENCES makatib(id) ON DELETE SET NULL,
  att_date   DATE NOT NULL,
  session    TEXT NOT NULL DEFAULT 'morning' CHECK (session IN ('morning','evening')),
  status     TEXT NOT NULL CHECK (status IN ('present','absent','leave','late')),
  note       TEXT,
  marked_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, att_date, session)
);

-- One mark per teacher and day
CREATE TABLE IF NOT EXISTS teacher_attendance (
  id         SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  maktab_id  INTEGER REFERENCES makatib(id) ON DELETE SET NULL,
  att_date   DATE NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('present','absent','leave','late')),
  note       TEXT,
  marked_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (teacher_id, att_date)
);

CREATE INDEX IF NOT EXISTS students_teacher_idx         ON students (teacher_id);
CREATE INDEX IF NOT EXISTS students_class_idx           ON students (class_name);
CREATE INDEX IF NOT EXISTS student_progress_student_idx ON student_progress (student_id, recorded_on);
CREATE INDEX IF NOT EXISTS student_att_maktab_date_idx  ON student_attendance (maktab_id, att_date);
CREATE INDEX IF NOT EXISTS student_att_date_idx         ON student_attendance (att_date);
CREATE INDEX IF NOT EXISTS teacher_att_date_idx         ON teacher_attendance (att_date);
CREATE INDEX IF NOT EXISTS teacher_att_maktab_idx       ON teacher_attendance (maktab_id, att_date);

DROP TRIGGER IF EXISTS student_attendance_updated_at ON student_attendance;
CREATE TRIGGER student_attendance_updated_at BEFORE UPDATE ON student_attendance FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS teacher_attendance_updated_at ON teacher_attendance;
CREATE TRIGGER teacher_attendance_updated_at BEFORE UPDATE ON teacher_attendance FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE student_progress   ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_attendance ENABLE ROW LEVEL SECURITY;
