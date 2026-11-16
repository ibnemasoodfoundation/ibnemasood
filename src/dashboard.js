/* Staff dashboard data: every number and chart comes straight from the database */
"use strict";
const { one, all } = require("./db");
const { loadScope, branchSql, maktabSql, schoolSql, personSql } = require("./scope");

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
  // Branch managers see institution numbers for their own branches only
  const sc = await loadScope(user);
  const B = branchSql(sc, "b"), M = maktabSql(sc, "m"), T = personSql(sc, "t", "teacher"), S = personSql(sc, "s", "student");
  const months = lastMonths();

  const stats = await one(`SELECT
    (SELECT COUNT(*) FROM branches b WHERE b.status <> 'archived' AND ${B}) AS branches,
    (SELECT COUNT(*) FROM makatib m WHERE m.status <> 'archived' AND ${M}) AS makatib,
    (SELECT COUNT(*) FROM schools sc WHERE sc.status <> 'archived' AND ${schoolSql(sc, "sc")}) AS schools,
    (SELECT COUNT(*) FROM exams) AS exams,
    (SELECT COALESCE(SUM(amount), 0) FROM finance_entries WHERE entry_type = 'expense' AND entry_date >= date_trunc('month', CURRENT_DATE)) AS expenses_month,
    (SELECT COALESCE(SUM(amount), 0) FROM finance_entries WHERE entry_type = 'income' AND entry_date >= date_trunc('month', CURRENT_DATE)) AS income_month,
    (SELECT COUNT(*) FROM teachers t WHERE t.status NOT IN ('left','archived') AND ${T}) AS teachers,
    (SELECT COUNT(*) FROM teachers t WHERE t.status = 'active' AND ${T}) AS active_teachers,
    (SELECT COUNT(*) FROM students s WHERE s.status NOT IN ('left','graduated') AND ${S}) AS students,
    (SELECT COUNT(*) FROM students s WHERE s.status = 'active' AND ${S}) AS active_students,
    (SELECT COUNT(*) FROM students s WHERE s.status NOT IN ('left','graduated') AND s.gender = 'male' AND ${S}) AS male_students,
    (SELECT COUNT(*) FROM students s WHERE s.status NOT IN ('left','graduated') AND s.gender = 'female' AND ${S}) AS female_students,
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
         WHERE s.status NOT IN ('left','graduated') AND ${S} GROUP BY 1 ORDER BY v DESC, label`),
    all(`SELECT COALESCE(b.name_en, 'No branch') AS label, COUNT(*) AS v FROM teachers t LEFT JOIN branches b ON b.id = t.branch_id
         WHERE t.status NOT IN ('left','archived') AND ${T} GROUP BY 1 ORDER BY v DESC, label`),
    all(`SELECT m.district AS label, COUNT(*) AS v FROM makatib m WHERE m.status <> 'archived' AND ${M} GROUP BY 1 ORDER BY v DESC, label`),
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
                         LEFT JOIN makatib m ON m.id = t.maktab_id WHERE ${T} ORDER BY t.id DESC LIMIT 5`),
    students: await all(`SELECT s.id, s.code, s.full_name, s.gender, s.status, s.created_at, m.name_en AS maktab FROM students s
                         LEFT JOIN makatib m ON m.id = s.maktab_id WHERE ${S} ORDER BY s.id DESC LIMIT 5`),
    donations: await all("SELECT id, donor_name, amount, kind, status, created_at FROM donations ORDER BY id DESC LIMIT 5"),
    messages: await all("SELECT id, name, topic, status, created_at FROM messages ORDER BY id DESC LIMIT 5"),
    activity: isAdmin
      ? await all("SELECT a.action, a.detail, a.created_at, u.name FROM activity a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 8")
      : [],
  };

  return { stats, charts, recent, isAdmin };
}

/* Makatib Nazim and School Principal dashboards: their Makatib or schools, people, today's attendance and exams */
async function unitDashboardData(user) {
  const sc = await loadScope(user);
  const nazim = user.role === "nazim";
  const T = personSql(sc, "t", "teacher"), S = personSql(sc, "s", "student");
  const unitWhere = nazim ? "s.maktab_id IS NOT NULL" : "s.school_id IS NOT NULL";
  const stats = await one(`SELECT
    (SELECT COUNT(*) FROM ${nazim ? "makatib m WHERE m.status <> 'archived' AND " + maktabSql(sc, "m") : "schools sc WHERE sc.status <> 'archived' AND " + schoolSql(sc, "sc")}) AS units,
    (SELECT COUNT(*) FROM teachers t WHERE t.status = 'active' AND ${T}) AS teachers,
    (SELECT COUNT(*) FROM students s WHERE s.status = 'active' AND ${S} AND ${unitWhere}) AS students,
    (SELECT COUNT(*) FROM students s WHERE s.status = 'active' AND s.gender = 'male' AND ${S} AND ${unitWhere}) AS boys,
    (SELECT COUNT(*) FROM students s WHERE s.status = 'active' AND s.gender = 'female' AND ${S} AND ${unitWhere}) AS girls,
    (SELECT COUNT(*) FROM student_attendance a JOIN students s ON s.id = a.student_id
       WHERE a.att_date = (now() AT TIME ZONE 'Asia/Karachi')::date AND a.session = 'morning' AND ${S}) AS marked_today,
    (SELECT COUNT(*) FROM student_attendance a JOIN students s ON s.id = a.student_id
       WHERE a.att_date = (now() AT TIME ZONE 'Asia/Karachi')::date AND a.status = 'absent' AND ${S}) AS absent_today,
    (SELECT COUNT(*) FROM teacher_attendance a JOIN teachers t ON t.id = a.teacher_id
       WHERE a.att_date = (now() AT TIME ZONE 'Asia/Karachi')::date AND a.status IN ('present','late') AND ${T}) AS teachers_present`);

  // Each Maktab or school with its students and today's morning register
  const units = nazim
    ? await all(`SELECT m.id, m.name_en AS name, m.district, b.name_en AS branch,
        (SELECT COUNT(*) FROM students s WHERE s.maktab_id = m.id AND s.status = 'active') AS students,
        (SELECT COUNT(*) FROM teachers t WHERE t.maktab_id = m.id AND t.status = 'active') AS teachers,
        (SELECT COUNT(*) FROM student_attendance a WHERE a.maktab_id = m.id AND a.att_date = (now() AT TIME ZONE 'Asia/Karachi')::date AND a.session = 'morning') AS marked
      FROM makatib m LEFT JOIN branches b ON b.id = m.branch_id WHERE m.status = 'active' AND ${maktabSql(sc, "m")} ORDER BY m.name_en`)
    : await all(`SELECT sc.id, sc.name_en AS name, sc.district, b.name_en AS branch,
        (SELECT COUNT(*) FROM students s WHERE s.school_id = sc.id AND s.status = 'active') AS students,
        (SELECT COUNT(*) FROM teachers t WHERE t.school_id = sc.id AND t.status = 'active') AS teachers,
        (SELECT COUNT(*) FROM student_attendance a JOIN students s ON s.id = a.student_id WHERE s.school_id = sc.id
           AND a.att_date = (now() AT TIME ZONE 'Asia/Karachi')::date AND a.session = 'morning') AS marked
      FROM schools sc LEFT JOIN branches b ON b.id = sc.branch_id WHERE sc.status = 'active' AND ${schoolSql(sc, "sc")} ORDER BY sc.name_en`);

  const examWhere = nazim ? "(e.school_id IS NULL)" : `e.school_id IN (${sc.schoolIds.join(",") || "NULL"})`;
  const exams = await all(`SELECT e.id, e.title, e.exam_type, e.status, e.held_on, COALESCE(m.name_en, sc.name_en, 'All Makatib') AS place
    FROM exams e LEFT JOIN makatib m ON m.id = e.maktab_id LEFT JOIN schools sc ON sc.id = e.school_id
    WHERE ${examWhere} ORDER BY e.id DESC LIMIT 6`);

  const byClass = await all(`SELECT COALESCE(s.class_name, 'No class') AS label, COUNT(*) AS v FROM students s
    WHERE s.status = 'active' AND ${S} AND ${unitWhere} GROUP BY 1 ORDER BY v DESC, label LIMIT 15`);
  const byDistrict = nazim ? await all(`SELECT m.district AS label, COUNT(*) AS v FROM makatib m
    WHERE m.status <> 'archived' AND ${maktabSql(sc, "m")} GROUP BY 1 ORDER BY v DESC, label`) : [];
  const toChart = (rows) => ({ labels: rows.map((r) => r.label), values: rows.map((r) => Number(r.v)) });
  const charts = {
    unitStudents: toChart([...units].sort((a, b) => b.students - a.students).slice(0, 12).map((u) => ({ label: u.name, v: u.students }))),
    byClass: toChart(byClass),
    byDistrict: toChart(byDistrict),
  };
  return { stats, units, exams, charts, nazim };
}

module.exports = { dashboardData, unitDashboardData };
