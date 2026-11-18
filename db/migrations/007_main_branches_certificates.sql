-- 007: the two main branches (Boys and Girls), admission-form details and issued certificates.
-- Additive only: new columns, a new table, and the two main branches when they do not exist yet.

-- Which main branch a branch belongs to: boys = Jamia Arabia Abdullah Bin Masood, girls = Jamia Arabia Aisha Siddiqa
ALTER TABLE branches ADD COLUMN IF NOT EXISTS section TEXT CHECK (section IS NULL OR section IN ('boys','girls'));
CREATE INDEX IF NOT EXISTS branches_section_idx ON branches (section);

-- Mark existing branches by name, then add the two main branches only if neither is there yet
UPDATE branches SET section = 'boys'  WHERE section IS NULL AND name_en ILIKE '%abdullah bin masood%';
UPDATE branches SET section = 'girls' WHERE section IS NULL AND name_en ILIKE '%aisha siddiqa%';
INSERT INTO branches (code, name_en, name_ur, district, town, section, status)
  SELECT 'JAABM-BOYS', 'Jamia Arabia Abdullah Bin Masood (Boys)', 'جامعہ عربیہ عبداللہ بن مسعود', 'Naushahro Feroze', 'Bhiria Road', 'boys', 'active'
  WHERE NOT EXISTS (SELECT 1 FROM branches WHERE section = 'boys') AND NOT EXISTS (SELECT 1 FROM branches WHERE code = 'JAABM-BOYS');
INSERT INTO branches (code, name_en, name_ur, district, town, section, status)
  SELECT 'JAAS-GIRLS', 'Jamia Arabia Aisha Siddiqa (Girls)', 'جامعہ عربیہ عائشہ صدیقہ', 'Naushahro Feroze', 'Bhiria Road', 'girls', 'active'
  WHERE NOT EXISTS (SELECT 1 FROM branches WHERE section = 'girls') AND NOT EXISTS (SELECT 1 FROM branches WHERE code = 'JAAS-GIRLS');

-- Admission-form details that have no column of their own (G.R. No, surname, guardian, religion, fees, ...)
ALTER TABLE students ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}';

-- Issued certificates: School Leaving Certificate and Shahadat al-Alamiyyah. data holds the printed fields.
CREATE TABLE IF NOT EXISTS certificates (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('leaving','alimiyyah')),
  serial_no   TEXT,
  student_id  INTEGER REFERENCES students(id) ON DELETE SET NULL,
  exam_id     INTEGER REFERENCES exams(id) ON DELETE SET NULL,
  data        JSONB NOT NULL DEFAULT '{}',
  issued_on   DATE NOT NULL DEFAULT CURRENT_DATE,
  issued_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS certificates_student_idx ON certificates (student_id);
DROP TRIGGER IF EXISTS certificates_updated_at ON certificates;
CREATE TRIGGER certificates_updated_at BEFORE UPDATE ON certificates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE certificates ENABLE ROW LEVEL SECURITY;
