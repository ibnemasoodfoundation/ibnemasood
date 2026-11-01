/* Student and teacher attendance: daily registers, monthly sheets, reports.
   Teachers mark only students in their Maktab or assigned to them; managers only within
   their branches; admins everywhere. One mark per student/day/session and per teacher/day
   is enforced by UNIQUE constraints in the database (migration 004). */
"use strict";
const express = require("express");
const { one, all, run, log } = require("../db");
const { checkCsrf, requireRole } = require("../auth");
const { withScope, maktabSql, personSql, inMaktab, canSeePerson } = require("../scope");
const { ATTENDANCE, SESSIONS, todayPk } = require("../helpers");
const { helpers: h } = require("./institution");

const router = express.Router();
const staff = [requireRole("admin", "manager"), withScope, checkCsrf];
const staffOrTeacher = [requireRole("admin", "manager", "teacher"), withScope, checkCsrf];
const { str, int, DATE_RE, forbidden } = h;

const TEACHER_EDIT_DAYS = 7; // teachers may correct the last week; managers and admins any past date

function pickDate(v) {
  const d = str(v, 10);
  return DATE_RE.test(d) && !isNaN(Date.parse(d)) && d <= todayPk() ? d : todayPk();
}
function pickMonth(v) {
  const m = str(v, 7);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(m) && m <= todayPk().slice(0, 7) ? m : todayPk().slice(0, 7);
}
function daysOf(month) {
  const [y, mo] = month.split("-").map(Number);
  const n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const today = todayPk();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`).filter((d) => d <= today);
}
function shiftDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/* % = (present + late) / (present + late + absent); leave is not counted against the student */
const pct = (c) => { const d = c.present + c.late + c.absent; return d ? Math.round(((c.present + c.late) / d) * 100) : null; };
const emptyCounts = () => ({ present: 0, absent: 0, leave: 0, late: 0 });

async function classOptions(scope) {
  return (await all(`SELECT DISTINCT s.class_name FROM students s WHERE s.class_name IS NOT NULL AND ${personSql(scope, "s", "student")} ORDER BY 1`)).map((r) => r.class_name);
}
const teacherOptions = (scope) => all(`SELECT t.id, t.full_name, t.maktab_id FROM teachers t
  WHERE t.status IN ('active','on_leave') AND ${scope.canManage ? personSql(scope, "t", "teacher") : "FALSE"} ORDER BY t.full_name`);

/* Students on a register: active, in scope, optionally narrowed by Maktab / class / teacher */
function registerStudents(scope, f) {
  const where = ["s.status = 'active'", personSql(scope, "s", "student")], p = [];
  if (f.maktab) { where.push("s.maktab_id = ?"); p.push(f.maktab); }
  if (f.cls) { where.push("s.class_name = ?"); p.push(f.cls); }
  if (f.teacher) { where.push("s.teacher_id = ?"); p.push(f.teacher); }
  return all(`SELECT s.id, s.code, s.full_name, s.name_ur, s.father_name, s.class_name, s.maktab_id, m.name_en AS maktab
    FROM students s LEFT JOIN makatib m ON m.id = s.maktab_id WHERE ${where.join(" AND ")} ORDER BY m.name_en NULLS LAST, s.class_name NULLS LAST, s.full_name`, ...p);
}

function filtersFrom(req) {
  const f = {
    maktab: int(req.query.maktab), cls: str(req.query.class, 60), teacher: int(req.query.teacher),
    session: SESSIONS[req.query.session] ? req.query.session : "morning",
  };
  // A teacher's register defaults to their own Maktab
  if (req.user.role === "teacher" && !f.maktab && req.scope.maktabIds.length) f.maktab = req.scope.maktabIds[0];
  return f;
}

/* ================= Student attendance: daily register ================= */
router.get("/attendance", staffOrTeacher, async (req, res) => {
  const f = filtersFrom(req);
  f.date = pickDate(req.query.date);
  if (f.maktab && !inMaktab(req.scope, f.maktab)) return forbidden(res);
  const makatib = await h.maktabList(req.scope);

  // Staff without a Maktab chosen: today's overview across their Makatib
  let overview = null;
  if (!f.maktab && req.scope.canManage) {
    overview = await all(`SELECT m.id, m.name_en, b.name_en AS branch,
        (SELECT COUNT(*) FROM students s WHERE s.maktab_id = m.id AND s.status = 'active') AS students,
        (SELECT COUNT(*) FROM student_attendance a WHERE a.maktab_id = m.id AND a.att_date = ? AND a.session = ?) AS marked,
        (SELECT COUNT(*) FROM student_attendance a WHERE a.maktab_id = m.id AND a.att_date = ? AND a.session = ? AND a.status = 'absent') AS absent
      FROM makatib m LEFT JOIN branches b ON b.id = m.branch_id
      WHERE m.status <> 'archived' AND ${maktabSql(req.scope, "m")} ORDER BY b.name_en NULLS LAST, m.name_en`, f.date, f.session, f.date, f.session);
  }

  const students = f.maktab || !req.scope.canManage ? await registerStudents(req.scope, f) : [];
  const marks = students.length ? await all(`SELECT student_id, status, note FROM student_attendance
    WHERE att_date = ? AND session = ? AND student_id IN (${students.map((s) => s.id).join(",")})`, f.date, f.session) : [];
  const byStudent = Object.fromEntries(marks.map((m) => [m.student_id, m]));
  const counts = emptyCounts(); marks.forEach((m) => counts[m.status]++);
  const locked = req.user.role === "teacher" && f.date < shiftDays(todayPk(), -TEACHER_EDIT_DAYS);

  res.render("app/attendance", {
    title: "Student attendance", f, makatib, students, byStudent, counts, overview, locked,
    classes: await classOptions(req.scope), teachers: await teacherOptions(req.scope),
    ATTENDANCE, SESSIONS, today: todayPk(), editDays: TEACHER_EDIT_DAYS,
  });
});

router.post("/attendance", staffOrTeacher, async (req, res) => {
  const date = str(req.body.date, 10), session = SESSIONS[req.body.session] ? req.body.session : "morning";
  const back = `/app/attendance?${new URLSearchParams({ date, session, maktab: req.body.maktab || "", class: req.body.class || "", teacher: req.body.teacher || "" })}`;
  if (!DATE_RE.test(date) || isNaN(Date.parse(date)) || date > todayPk()) { req.flash("err", "Attendance can only be marked for today or an earlier date."); return res.redirect(back); }
  if (req.user.role === "teacher" && date < shiftDays(todayPk(), -TEACHER_EDIT_DAYS)) {
    req.flash("err", `Teachers can mark or correct attendance for the last ${TEACHER_EDIT_DAYS} days only. Ask your branch manager for older dates.`);
    return res.redirect(back);
  }
  const entries = Object.entries(req.body).filter(([k, v]) => /^status_\d{1,9}$/.test(k) && ATTENDANCE[v]).map(([k, v]) => [Number(k.slice(7)), v]);
  if (!entries.length) { req.flash("err", "Mark at least one student."); return res.redirect(back); }

  const students = await all(`SELECT id, maktab_id, branch_id, teacher_id, full_name FROM students WHERE status = 'active' AND id IN (${entries.map((e) => e[0]).join(",")})`);
  const byId = Object.fromEntries(students.map((s) => [s.id, s]));
  let saved = 0;
  for (const [id, status] of entries) {
    const s = byId[id];
    if (!s || !canSeePerson(req.scope, s, "student")) return forbidden(res); // never mark outside your students
    await run(`INSERT INTO student_attendance (student_id, maktab_id, att_date, session, status, note, marked_by)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (student_id, att_date, session) DO UPDATE
               SET status = EXCLUDED.status, note = EXCLUDED.note, marked_by = EXCLUDED.marked_by, maktab_id = EXCLUDED.maktab_id`,
      id, s.maktab_id, date, session, status, str(req.body["note_" + id], 200) || null, req.user.id);
    saved++;
  }
  await log(req.user.id, "attendance.students", `${saved} marks, ${date} ${session}`);
  req.flash("ok", `Attendance saved for ${saved} student${saved === 1 ? "" : "s"}.`);
  res.redirect(back);
});

/* ================= Student attendance: monthly sheet ================= */
router.get("/attendance/monthly", staffOrTeacher, async (req, res) => {
  const f = filtersFrom(req);
  f.month = pickMonth(req.query.month);
  if (f.maktab && !inMaktab(req.scope, f.maktab)) return forbidden(res);
  const days = daysOf(f.month);
  const students = f.maktab || f.cls || f.teacher || !req.scope.canManage ? await registerStudents(req.scope, f) : [];
  const marks = students.length && days.length ? await all(`SELECT student_id, att_date, status FROM student_attendance
    WHERE session = ? AND att_date BETWEEN ? AND ? AND student_id IN (${students.map((s) => s.id).join(",")})`, f.session, days[0], days[days.length - 1]) : [];
  const grid = {};
  for (const m of marks) (grid[m.student_id] ||= {})[m.att_date] = m.status;
  const rows = students.map((s) => {
    const c = emptyCounts();
    Object.values(grid[s.id] || {}).forEach((st) => c[st]++);
    return { ...s, marks: grid[s.id] || {}, counts: c, pct: pct(c) };
  });
  const total = rows.reduce((t, r) => { for (const k in t) t[k] += r.counts[k]; return t; }, emptyCounts());
  const maktab = f.maktab ? await one("SELECT name_en, name_ur FROM makatib WHERE id = ?", f.maktab) : null;
  res.render("app/attendance-monthly", {
    title: "Monthly attendance", f, days, rows, total, totalPct: pct(total), maktab,
    makatib: await h.maktabList(req.scope), classes: await classOptions(req.scope), teachers: await teacherOptions(req.scope),
    ATTENDANCE, SESSIONS, printedOn: todayPk(),
  });
});

/* ================= Student attendance: summary report ================= */
router.get("/attendance/report", staff, async (req, res) => {
  const month = pickMonth(req.query.month), by = ["maktab", "teacher", "class", "branch"].includes(req.query.by) ? req.query.by : "maktab";
  const days = daysOf(month);
  const group = {
    maktab: { key: "COALESCE(m.name_en, 'No Maktab')", label: "Maktab" },
    branch: { key: "COALESCE(b.name_en, 'No branch')", label: "Branch" },
    teacher: { key: "COALESCE(t.full_name, 'No teacher assigned')", label: "Teacher" },
    class: { key: "COALESCE(s.class_name, 'No class')", label: "Class" },
  }[by];
  const rows = days.length ? await all(`SELECT ${group.key} AS name,
      COUNT(DISTINCT s.id) AS students,
      COUNT(*) FILTER (WHERE a.status = 'present') AS present, COUNT(*) FILTER (WHERE a.status = 'late') AS late,
      COUNT(*) FILTER (WHERE a.status = 'absent') AS absent, COUNT(*) FILTER (WHERE a.status = 'leave') AS leave
    FROM student_attendance a JOIN students s ON s.id = a.student_id
    LEFT JOIN makatib m ON m.id = a.maktab_id LEFT JOIN branches b ON b.id = s.branch_id LEFT JOIN teachers t ON t.id = s.teacher_id
    WHERE a.att_date BETWEEN ? AND ? AND ${personSql(req.scope, "s", "student")}
    GROUP BY 1 ORDER BY 1`, days[0], days[days.length - 1]) : [];
  rows.forEach((r) => { r.pct = pct(r); });
  const total = rows.reduce((t, r) => { for (const k in t) t[k] += r[k]; return t; }, emptyCounts());
  res.render("app/attendance-report", { title: "Attendance report", rows, month, by, groupLabel: group.label, total, totalPct: pct(total), printedOn: todayPk() });
});

/* ================= Teacher attendance ================= */
router.get("/teacher-attendance", staff, async (req, res) => {
  const date = pickDate(req.query.date), branch = int(req.query.branch), maktab = int(req.query.maktab);
  const where = ["t.status IN ('active','on_leave')", personSql(req.scope, "t", "teacher")], p = [];
  if (branch) { where.push("t.branch_id = ?"); p.push(branch); }
  if (maktab) { where.push("t.maktab_id = ?"); p.push(maktab); }
  const teachers = await all(`SELECT t.id, t.code, t.full_name, t.designation, t.status, m.name_en AS maktab, b.name_en AS branch, a.status AS mark, a.note
    FROM teachers t LEFT JOIN makatib m ON m.id = t.maktab_id LEFT JOIN branches b ON b.id = t.branch_id
    LEFT JOIN teacher_attendance a ON a.teacher_id = t.id AND a.att_date = ?
    WHERE ${where.join(" AND ")} ORDER BY b.name_en NULLS LAST, m.name_en NULLS LAST, t.full_name`, date, ...p);
  const counts = emptyCounts(); teachers.forEach((t) => t.mark && counts[t.mark]++);
  res.render("app/teacher-attendance", {
    title: "Teacher attendance", teachers, counts, f: { date, branch, maktab },
    branches: await h.branchList(req.scope), makatib: await h.maktabList(req.scope), ATTENDANCE, today: todayPk(),
  });
});

router.post("/teacher-attendance", staff, async (req, res) => {
  const date = str(req.body.date, 10);
  const back = `/app/teacher-attendance?${new URLSearchParams({ date, branch: req.body.branch || "", maktab: req.body.maktab || "" })}`;
  if (!DATE_RE.test(date) || isNaN(Date.parse(date)) || date > todayPk()) { req.flash("err", "Attendance can only be marked for today or an earlier date."); return res.redirect(back); }
  const entries = Object.entries(req.body).filter(([k, v]) => /^status_\d{1,9}$/.test(k) && ATTENDANCE[v]).map(([k, v]) => [Number(k.slice(7)), v]);
  if (!entries.length) { req.flash("err", "Mark at least one teacher."); return res.redirect(back); }
  const teachers = await all(`SELECT id, maktab_id, branch_id FROM teachers WHERE id IN (${entries.map((e) => e[0]).join(",")})`);
  const byId = Object.fromEntries(teachers.map((t) => [t.id, t]));
  for (const [id, status] of entries) {
    const t = byId[id];
    if (!t || !canSeePerson(req.scope, t, "teacher")) return forbidden(res);
    await run(`INSERT INTO teacher_attendance (teacher_id, maktab_id, att_date, status, note, marked_by) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (teacher_id, att_date) DO UPDATE
               SET status = EXCLUDED.status, note = EXCLUDED.note, marked_by = EXCLUDED.marked_by, maktab_id = EXCLUDED.maktab_id`,
      id, t.maktab_id, date, status, str(req.body["note_" + id], 200) || null, req.user.id);
  }
  await log(req.user.id, "attendance.teachers", `${entries.length} marks, ${date}`);
  req.flash("ok", `Teacher attendance saved for ${entries.length}.`);
  res.redirect(back);
});

router.get("/teacher-attendance/monthly", staff, async (req, res) => {
  const month = pickMonth(req.query.month), branch = int(req.query.branch), maktab = int(req.query.maktab);
  const days = daysOf(month);
  const where = [personSql(req.scope, "t", "teacher"), "t.status <> 'archived'"], p = [];
  if (branch) { where.push("t.branch_id = ?"); p.push(branch); }
  if (maktab) { where.push("t.maktab_id = ?"); p.push(maktab); }
  const teachers = await all(`SELECT t.id, t.code, t.full_name, m.name_en AS maktab, b.name_en AS branch FROM teachers t
    LEFT JOIN makatib m ON m.id = t.maktab_id LEFT JOIN branches b ON b.id = t.branch_id
    WHERE ${where.join(" AND ")} ORDER BY b.name_en NULLS LAST, m.name_en NULLS LAST, t.full_name`, ...p);
  const marks = teachers.length && days.length ? await all(`SELECT teacher_id, att_date, status FROM teacher_attendance
    WHERE att_date BETWEEN ? AND ? AND teacher_id IN (${teachers.map((t) => t.id).join(",")})`, days[0], days[days.length - 1]) : [];
  const grid = {};
  for (const m of marks) (grid[m.teacher_id] ||= {})[m.att_date] = m.status;
  const rows = teachers.map((t) => {
    const c = emptyCounts();
    Object.values(grid[t.id] || {}).forEach((st) => c[st]++);
    return { ...t, marks: grid[t.id] || {}, counts: c, pct: pct(c) };
  });
  // Branch-wise and Maktab-wise totals
  const sum = (key) => Object.entries(rows.reduce((acc, r) => {
    const k = r[key] || (key === "branch" ? "No branch" : "No Maktab");
    acc[k] ||= emptyCounts(); for (const s in r.counts) acc[k][s] += r.counts[s]; return acc;
  }, {})).map(([name, c]) => ({ name, ...c, pct: pct(c) }));
  res.render("app/teacher-attendance-monthly", {
    title: "Teacher attendance, monthly", rows, days, f: { month, branch, maktab }, byBranch: sum("branch"), byMaktab: sum("maktab"),
    branches: await h.branchList(req.scope), makatib: await h.maktabList(req.scope), ATTENDANCE, printedOn: todayPk(),
  });
});

module.exports = router;
