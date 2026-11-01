/* Staff dashboard data: every number and chart comes straight from the database */
"use strict";
const { one, all } = require("./db");

/* Last 12 calendar months as "YYYY-MM" keys with labels, oldest first (UTC) */
function lastMonths(n = 12) {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1 - i), 1));
    return { key: d.toISOString().slice(0, 7), label: d.toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }) };
  });
}

function series(months, rows) {
  return months.map((m) => Number((rows.find((r) => r.m === m.key) || {}).v || 0));
}

async function dashboardData(user) {
  const isAdmin = user.role === "admin";
  const months = lastMonths();

  const stats = await one(`SELECT
    (SELECT COUNT(*) FROM branches WHERE status <> 'archived')                    AS branches,
    (SELECT COUNT(*) FROM makatib  WHERE status <> 'archived')                    AS makatib,
    (SELECT COUNT(*) FROM teachers WHERE status <> 'left')                        AS teachers,
    (SELECT COUNT(*) FROM teachers WHERE status = 'active')                       AS active_teachers,
    (SELECT COUNT(*) FROM students WHERE status NOT IN ('left','graduated'))      AS students,
    (SELECT COUNT(*) FROM students WHERE status = 'active')                       AS active_students,
    (SELECT COUNT(*) FROM students WHERE status NOT IN ('left','graduated') AND gender = 'male')   AS male_students,
    (SELECT COUNT(*) FROM students WHERE status NOT IN ('left','graduated') AND gender = 'female') AS female_students,
    (SELECT COUNT(*) FROM admissions)                                             AS applications,
    (SELECT COUNT(*) FROM admissions WHERE status = 'pending')                    AS pending_applications,
    (SELECT COUNT(*) FROM admissions WHERE status = 'approved')                   AS approved_applications,
    (SELECT COUNT(*) FROM admissions WHERE status = 'rejected')                   AS rejected_applications,
    (SELECT COALESCE(SUM(amount), 0) FROM donations WHERE status = 'verified')    AS donations_total,
    (SELECT COUNT(*) FROM donations WHERE status = 'pending')                     AS donations_pending,
    (SELECT COALESCE(SUM(amount), 0) FROM donations WHERE status = 'verified'
       AND created_at >= date_trunc('month', now()))                              AS donations_month,
    (SELECT COUNT(*) FROM users WHERE role = 'admin')                             AS admins,
    (SELECT COUNT(*) FROM users WHERE role = 'manager')                           AS managers,
    (SELECT COUNT(*) FROM users WHERE status = 'suspended')                       AS suspended,
    (SELECT COUNT(*) FROM messages WHERE status = 'new')                          AS new_messages`);

  const [studentsByBranch, teachersByBranch, makatibByDistrict, admissionsMonthly, donationsMonthly] = await Promise.all([
    all(`SELECT COALESCE(b.name_en, 'No branch') AS label, COUNT(*) AS v FROM students s LEFT JOIN branches b ON b.id = s.branch_id
         WHERE s.status NOT IN ('left','graduated') GROUP BY 1 ORDER BY v DESC, label`),
    all(`SELECT COALESCE(b.name_en, 'No branch') AS label, COUNT(*) AS v FROM teachers t LEFT JOIN branches b ON b.id = t.branch_id
         WHERE t.status <> 'left' GROUP BY 1 ORDER BY v DESC, label`),
    all(`SELECT district AS label, COUNT(*) AS v FROM makatib WHERE status <> 'archived' GROUP BY 1 ORDER BY v DESC, label`),
    all(`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS m, COUNT(*) AS v FROM admissions
         WHERE created_at >= date_trunc('month', now()) - interval '11 months' GROUP BY 1`),
    all(`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM') AS m, SUM(amount) AS v FROM donations
         WHERE status = 'verified' AND created_at >= date_trunc('month', now()) - interval '11 months' GROUP BY 1`),
  ]);

  const toChart = (rows) => ({ labels: rows.map((r) => r.label), values: rows.map((r) => Number(r.v)) });
  const charts = {
    studentsByBranch: toChart(studentsByBranch),
    studentsByGender: { labels: ["Male", "Female"], values: [stats.male_students, stats.female_students] },
    teachersByBranch: toChart(teachersByBranch),
    makatibByDistrict: toChart(makatibByDistrict),
    admissionsMonthly: { labels: months.map((m) => m.label), values: series(months, admissionsMonthly) },
    donationsMonthly: { labels: months.map((m) => m.label), values: series(months, donationsMonthly), money: true },
  };

  const recent = {
    admissions: await all("SELECT id, student_name, branch, programme, status, created_at FROM admissions ORDER BY id DESC LIMIT 5"),
    teachers: await all(`SELECT t.id, t.code, t.full_name, t.status, t.created_at, m.name_en AS maktab FROM teachers t
                         LEFT JOIN makatib m ON m.id = t.maktab_id ORDER BY t.id DESC LIMIT 5`),
    students: await all(`SELECT s.id, s.code, s.full_name, s.gender, s.status, s.created_at, m.name_en AS maktab FROM students s
                         LEFT JOIN makatib m ON m.id = s.maktab_id ORDER BY s.id DESC LIMIT 5`),
    donations: await all("SELECT id, donor_name, amount, kind, status, created_at FROM donations ORDER BY id DESC LIMIT 5"),
    messages: await all("SELECT id, name, topic, status, created_at FROM messages ORDER BY id DESC LIMIT 5"),
    activity: isAdmin
      ? await all("SELECT a.action, a.detail, a.created_at, u.name FROM activity a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 8")
      : [],
  };

  return { stats, charts, recent, isAdmin };
}

module.exports = { dashboardData };
