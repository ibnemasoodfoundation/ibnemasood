-- 009: student fees, teacher salaries and in-app notifications.
-- Additive only: one new column and three new tables.

-- The fee a student pays each month (school students may also have a tuition fee on their admission form)
ALTER TABLE students ADD COLUMN IF NOT EXISTS monthly_fee INTEGER CHECK (monthly_fee IS NULL OR monthly_fee >= 0);

-- One fee record per student per month. amount_paid below amount_due means partly paid.
CREATE TABLE IF NOT EXISTS fee_payments (
  id               SERIAL PRIMARY KEY,
  student_id       INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  month            TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount_due       INTEGER NOT NULL DEFAULT 0 CHECK (amount_due >= 0),
  amount_paid      INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  paid_on          DATE,
  method           TEXT,
  receipt_no       TEXT,
  note             TEXT,
  finance_entry_id INTEGER REFERENCES finance_entries(id) ON DELETE SET NULL,
  recorded_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, month)
);
CREATE INDEX IF NOT EXISTS fee_payments_month_idx ON fee_payments (month);
DROP TRIGGER IF EXISTS fee_payments_updated_at ON fee_payments;
CREATE TRIGGER fee_payments_updated_at BEFORE UPDATE ON fee_payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One salary payment per teacher per month: net = basic + allowance - deduction
CREATE TABLE IF NOT EXISTS salary_payments (
  id               SERIAL PRIMARY KEY,
  teacher_id       INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  month            TEXT NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  basic            INTEGER NOT NULL DEFAULT 0 CHECK (basic >= 0),
  allowance        INTEGER NOT NULL DEFAULT 0 CHECK (allowance >= 0),
  deduction        INTEGER NOT NULL DEFAULT 0 CHECK (deduction >= 0),
  net              INTEGER NOT NULL DEFAULT 0 CHECK (net >= 0),
  paid_on          DATE NOT NULL,
  method           TEXT,
  note             TEXT,
  finance_entry_id INTEGER REFERENCES finance_entries(id) ON DELETE SET NULL,
  recorded_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (teacher_id, month)
);
CREATE INDEX IF NOT EXISTS salary_payments_month_idx ON salary_payments (month);

-- In-app notifications, shown on the dashboard and under the bell in the header
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message','announcement','fee','salary','result','system')),
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, read_at, id DESC);

ALTER TABLE fee_payments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications   ENABLE ROW LEVEL SECURITY;
