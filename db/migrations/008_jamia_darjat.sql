-- 008: the two Jamias' academic levels (darjat) and exams for a whole Jamia.
-- Additive only: new nullable columns; the exam "one place" rule now also allows a Jamia (branch).

-- A Jamia student's darja, e.g. 'ula' (Darja-e-Ula) or 'khasa_awwal' (Khasa Awwal). See src/helpers.js DARJAT.
ALTER TABLE students ADD COLUMN IF NOT EXISTS darja TEXT;
CREATE INDEX IF NOT EXISTS students_darja_idx ON students (branch_id, darja);

-- Exams can cover a whole Jamia (its main branch); still at most one of Maktab, school or Jamia
ALTER TABLE exams ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE exams DROP CONSTRAINT IF EXISTS exams_check;
ALTER TABLE exams DROP CONSTRAINT IF EXISTS exams_one_place_check;
ALTER TABLE exams ADD CONSTRAINT exams_one_place_check CHECK (num_nonnulls(maktab_id, school_id, branch_id) <= 1);
