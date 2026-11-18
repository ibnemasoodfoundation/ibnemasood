/* Exams, results and result certificates.
   An exam covers all Makatib, one Maktab, or one school. Staff (within their scope) create exams,
   enter marks and publish; teachers enter marks for their own students while an exam is a draft;
   parents see their children's results and certificates once an exam is published. */
"use strict";
const express = require("express");
const { one, all, run, log } = require("../db");
const { checkCsrf, requireRole, STAFF_ROLES } = require("../auth");
const { withScope, maktabSql, schoolSql, personSql, inMaktab, inSchool, canSeePerson, ids } = require("../scope");
const { EXAM_TYPES, MAKTAB_SUBJECTS, gradeFor, todayPk } = require("../helpers");
const { helpers: h } = require("./institution");

const router = express.Router();
const staff = [requireRole(...STAFF_ROLES), withScope, checkCsrf];
const markers = [requireRole(...STAFF_ROLES, "teacher"), withScope, checkCsrf];
const viewers = [requireRole(...STAFF_ROLES, "teacher", "parent"), withScope, checkCsrf];
const { str, int, DATE_RE, forbidden } = h;

/* ---------- Who sees which exam ---------- */
function examSql(scope, alias = "e") {
  if (scope.all) return "TRUE";
  const parts = [`${alias}.maktab_id IN (${ids(scope.maktabIds)})`, `${alias}.school_id IN (${ids(scope.schoolIds)})`];
  if (scope.maktabIds.length) parts.push(`(${alias}.maktab_id IS NULL AND ${alias}.school_id IS NULL)`);
  return `(${parts.join(" OR ")})`;
}
function canSeeExam(scope, e) {
  if (scope.all) return true;
  if (e.school_id) return inSchool(scope, e.school_id);
  if (e.maktab_id) return inMaktab(scope, e.maktab_id);
  return scope.maktabIds.length > 0;
}
// "All Makatib" exams are for the Super Admin and the Makatib Nazim
const canCoverAllMakatib = (scope) => scope.all || scope.allMakatib || scope.wasAll;

async function loadExam(req) {
  const id = int(req.params.id);
  const e = id && await one(`SELECT e.*, m.name_en AS maktab, sc.name_en AS school, u.name AS created_by_name FROM exams e
    LEFT JOIN makatib m ON m.id = e.maktab_id LEFT JOIN schools sc ON sc.id = e.school_id LEFT JOIN users u ON u.id = e.created_by
    WHERE e.id = ?`, id);
  if (!e) return { missing: true };
  if (!canSeeExam(req.scope, e)) return { e, denied: true }; // the certificate route still needs it for parents
  return { e };
}
const coverage = (e) => e.school || e.maktab || "All Makatib";

/* Students who sit this exam, within the signed-in user's scope */
function examStudents(scope, e, f = {}) {
  const where = [personSql(scope, "s", "student"), `(s.status = 'active' OR s.id IN (SELECT student_id FROM results WHERE exam_id = ${Number(e.id)}))`], p = [];
  if (e.school_id) { where.push("s.school_id = ?"); p.push(e.school_id); }
  else if (e.maktab_id) { where.push("s.maktab_id = ?"); p.push(e.maktab_id); }
  else where.push("s.maktab_id IS NOT NULL");
  if (f.maktab) { where.push("s.maktab_id = ?"); p.push(f.maktab); }
  if (f.cls) { where.push("s.class_name = ?"); p.push(f.cls); }
  return all(`SELECT s.id, s.code, s.full_name, s.name_ur, s.father_name, s.class_name, s.maktab_id, s.school_id, s.branch_id, s.teacher_id,
      COALESCE(m.name_en, sc.name_en) AS unit
    FROM students s LEFT JOIN makatib m ON m.id = s.maktab_id LEFT JOIN schools sc ON sc.id = s.school_id
    WHERE ${where.join(" AND ")} ORDER BY unit NULLS LAST, s.class_name NULLS LAST, s.full_name`, ...p);
}

/* "Reading | 100" lines → [{ name, total }] */
function parseSubjects(text) {
  const out = [], bad = [];
  for (const line of String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 15)) {
    const m = line.match(/^(.{1,60}?)\s*[|:]\s*(\d{1,4})$/);
    if (m && Number(m[2]) > 0) out.push({ name: m[1].trim(), total: Number(m[2]) });
    else bad.push(line);
  }
  return { subjects: out, bad };
}
const subjectsText = (subjects) => (subjects || []).map((s) => `${s.name} | ${s.total}`).join("\n");

/* Positions within the same Maktab or school, highest percentage first; ties share a position */
async function positions(examId) {
  const rows = await all(`SELECT r.student_id, r.percentage, COALESCE('m' || s.maktab_id, 's' || s.school_id, 'x') AS grp
    FROM results r JOIN students s ON s.id = r.student_id WHERE r.exam_id = ? ORDER BY grp, r.percentage DESC`, examId);
  const pos = {}, sizes = {};
  let grp = null, rank = 0, seen = 0, last = null;
  for (const r of rows) {
    if (r.grp !== grp) { grp = r.grp; rank = 0; seen = 0; last = null; }
    seen++;
    if (Number(r.percentage) !== last) { rank = seen; last = Number(r.percentage); }
    pos[r.student_id] = rank;
    sizes[r.grp] = seen;
  }
  for (const r of rows) pos[r.student_id] = { rank: pos[r.student_id], of: sizes[r.grp] };
  return pos;
}

/* ================= Exams list ================= */
router.get("/results", markers, async (req, res) => {
  const rows = await all(`SELECT e.*, m.name_en AS maktab, sc.name_en AS school,
      (SELECT COUNT(*) FROM results r JOIN students s ON s.id = r.student_id WHERE r.exam_id = e.id AND ${personSql(req.scope, "s", "student")}) AS entered
    FROM exams e LEFT JOIN makatib m ON m.id = e.maktab_id LEFT JOIN schools sc ON sc.id = e.school_id
    WHERE ${examSql(req.scope, "e")} ORDER BY e.held_on DESC NULLS LAST, e.id DESC LIMIT 300`);
  res.render("app/results", { title: "Exams and results", rows, canCreate: req.scope.canManage });
});

/* ================= Create / edit an exam ================= */
async function examTargets(scope) {
  return {
    allMakatib: canCoverAllMakatib(scope),
    makatib: await h.maktabList(scope),
    schools: await all(`SELECT sc.id, sc.code, sc.name_en FROM schools sc WHERE sc.status <> 'archived' AND ${schoolSql(scope, "sc")} ORDER BY sc.name_en`),
  };
}
async function examForm(req, res, title, values, errors, status = 200) {
  res.status(status).render("app/exam-form", { title, values, errors, EXAM_TYPES, ...(await examTargets(req.scope)) });
}

function examFields(req, current) {
  const b = req.body;
  const v = {
    title: str(b.title, 120), exam_type: EXAM_TYPES[b.exam_type] ? b.exam_type : "annual", session_year: str(b.session_year, 20),
    held_on: str(b.held_on, 10), target: str(b.target, 20), subjects_text: str(b.subjects, 2000),
    pass_percent: str(b.pass_percent, 3) === "" ? 40 : int(b.pass_percent),
  };
  const e = {};
  if (v.title.length < 3) e.title = "Enter the exam title, e.g. Annual Exam 2026.";
  if (v.held_on && (!DATE_RE.test(v.held_on) || isNaN(Date.parse(v.held_on)))) e.held_on = "Enter a valid date.";
  if (v.pass_percent === null || v.pass_percent > 100) e.pass_percent = "Enter a pass mark from 0 to 100.";
  const { subjects, bad } = parseSubjects(v.subjects_text);
  v.subjects = subjects;
  if (bad.length) e.subjects = `Write each subject as "Name | total marks". Check: ${bad[0]}`;
  else if (!subjects.length) e.subjects = "Add at least one subject.";
  // Where the exam applies: "all", "m:<maktab id>" or "s:<school id>"
  v.maktab_id = null; v.school_id = null;
  if (current) { v.maktab_id = current.maktab_id; v.school_id = current.school_id; }
  else if (v.target === "all") { if (!canCoverAllMakatib(req.scope)) e.target = "Choose one of your Makatib or schools."; }
  else if (/^m:\d{1,9}$/.test(v.target)) { v.maktab_id = Number(v.target.slice(2)); if (!inMaktab(req.scope, v.maktab_id)) e.target = "Choose a Maktab you manage."; }
  else if (/^s:\d{1,9}$/.test(v.target)) { v.school_id = Number(v.target.slice(2)); if (!inSchool(req.scope, v.school_id)) e.target = "Choose a school you manage."; }
  else e.target = "Choose where this exam is held.";
  return [v, e];
}

router.get("/results/new", staff, async (req, res) => {
  const school = int(req.query.school), maktab = int(req.query.maktab);
  const target = school ? "s:" + school : maktab ? "m:" + maktab : canCoverAllMakatib(req.scope) ? "all" : "";
  await examForm(req, res, "New exam", {
    exam_type: "annual", session_year: todayPk().slice(0, 4), pass_percent: 40, target,
    subjects_text: school ? "" : MAKTAB_SUBJECTS,
  }, {});
});

router.post("/results", staff, async (req, res) => {
  const [v, e] = examFields(req, null);
  if (Object.keys(e).length) return examForm(req, res, "New exam", v, e, 400);
  const r = await one(`INSERT INTO exams (title, exam_type, session_year, held_on, maktab_id, school_id, subjects, pass_percent, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    v.title, v.exam_type, v.session_year || null, v.held_on || null, v.maktab_id, v.school_id, JSON.stringify(v.subjects), v.pass_percent, req.user.id);
  await log(req.user.id, "exam.create", v.title);
  req.flash("ok", "Exam created. Enter the marks below.");
  res.redirect("/app/results/" + r.id);
});

router.get("/results/:id/edit", staff, async (req, res, next) => {
  const { e, missing, denied } = await loadExam(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const hasResults = !!(await one("SELECT 1 FROM results WHERE exam_id = ? LIMIT 1", e.id));
  await examForm(req, res, "Edit " + e.title, { ...e, editId: e.id, subjects_text: subjectsText(e.subjects), hasResults, coverage: coverage(e) }, {});
});

router.post("/results/:id/edit", staff, async (req, res, next) => {
  const { e, missing, denied } = await loadExam(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const hasResults = !!(await one("SELECT 1 FROM results WHERE exam_id = ? LIMIT 1", e.id));
  if (hasResults) req.body.subjects = subjectsText(e.subjects); // marks are stored in subject order, so subjects are fixed once marks exist
  const [v, errs] = examFields(req, e);
  if (Object.keys(errs).length) return examForm(req, res, "Edit " + e.title, { ...v, editId: e.id, hasResults, coverage: coverage(e) }, errs, 400);
  await run("UPDATE exams SET title = ?, exam_type = ?, session_year = ?, held_on = ?, subjects = ?, pass_percent = ? WHERE id = ?",
    v.title, v.exam_type, v.session_year || null, v.held_on || null, JSON.stringify(v.subjects), v.pass_percent, e.id);
  // A new pass mark changes who passed
  if (v.pass_percent !== e.pass_percent) {
    for (const r of await all("SELECT id, percentage FROM results WHERE exam_id = ?", e.id)) {
      await run("UPDATE results SET grade = ? WHERE id = ?", gradeFor(Number(r.percentage), v.pass_percent), r.id);
    }
  }
  await log(req.user.id, "exam.update", v.title);
  req.flash("ok", "Exam saved.");
  res.redirect("/app/results/" + e.id);
});

router.post("/results/:id/publish", staff, async (req, res, next) => {
  const { e, missing, denied } = await loadExam(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const publish = req.body.publish === "1";
  await run("UPDATE exams SET status = ? WHERE id = ?", publish ? "published" : "draft", e.id);
  await log(req.user.id, publish ? "exam.publish" : "exam.unpublish", e.title);
  req.flash("ok", publish ? "Results published. Parents can now see them and print certificates." : "Results moved back to draft. Parents no longer see them.");
  res.redirect("/app/results/" + e.id);
});

router.post("/results/:id/delete", staff, async (req, res, next) => {
  const { e, missing, denied } = await loadExam(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  if (e.status === "published" && !req.scope.all) { req.flash("err", "Move the results back to draft before deleting this exam."); return res.redirect("/app/results/" + e.id); }
  // An exam covering all Makatib holds results from every branch, so only its owners delete it
  if (!e.maktab_id && !e.school_id && !canCoverAllMakatib(req.scope)) return forbidden(res);
  await run("DELETE FROM exams WHERE id = ?", e.id);
  await log(req.user.id, "exam.delete", e.title);
  req.flash("ok", `Exam “${e.title}” and its results were deleted.`);
  res.redirect("/app/results");
});

/* ================= Marks sheet ================= */
router.get("/results/:id", markers, async (req, res, next) => {
  const { e, missing, denied } = await loadExam(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const f = { maktab: int(req.query.maktab), cls: str(req.query.class, 60) };
  if (f.maktab && !inMaktab(req.scope, f.maktab)) return forbidden(res);
  // An all-Makatib exam with many Makatib: choose one first, like the attendance register
  if (!e.maktab_id && !e.school_id && !f.maktab && req.scope.teacherId && req.scope.maktabIds.length) f.maktab = req.scope.maktabIds[0];
  const needsChoice = !e.maktab_id && !e.school_id && !f.maktab;
  let overview = [];
  if (needsChoice) {
    overview = await all(`SELECT m.id, m.name_en, b.name_en AS branch,
        (SELECT COUNT(*) FROM students s WHERE s.maktab_id = m.id AND s.status = 'active') AS students,
        (SELECT COUNT(*) FROM results r JOIN students s ON s.id = r.student_id WHERE r.exam_id = ? AND s.maktab_id = m.id) AS entered
      FROM makatib m LEFT JOIN branches b ON b.id = m.branch_id
      WHERE m.status <> 'archived' AND ${maktabSql(req.scope, "m")} ORDER BY b.name_en NULLS LAST, m.name_en`, e.id);
  }
  const students = needsChoice ? [] : await examStudents(req.scope, e, f);
  const results = students.length ? await all(`SELECT * FROM results WHERE exam_id = ? AND student_id IN (${students.map((s) => s.id).join(",")})`, e.id) : [];
  const classes = [...new Set(students.map((s) => s.class_name).filter(Boolean))].sort();
  res.render("app/exam", {
    title: e.title, e, f, students, overview, needsChoice, classes, coverage: coverage(e),
    byStudent: Object.fromEntries(results.map((r) => [r.student_id, r])),
    canEdit: req.scope.canManage || e.status === "draft", canManage: req.scope.canManage,
    canDelete: req.scope.canManage && (e.maktab_id || e.school_id || canCoverAllMakatib(req.scope)),
    makatib: !e.maktab_id && !e.school_id ? await h.maktabList(req.scope) : [],
  });
});

router.post("/results/:id", markers, async (req, res, next) => {
  const { e, missing, denied } = await loadExam(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const back = `/app/results/${e.id}?${new URLSearchParams({ maktab: req.body.maktab || "", class: req.body.class || "" })}`;
  if (!req.scope.canManage && e.status !== "draft") { req.flash("err", "These results are published. Ask your manager to make changes."); return res.redirect(back); }
  const ids_ = [...new Set(Object.keys(req.body).map((k) => (k.match(/^m_(\d{1,9})_\d{1,2}$/) || [])[1]).filter(Boolean).map(Number))];
  if (!ids_.length) { req.flash("err", "Enter marks for at least one student."); return res.redirect(back); }
  const allowed = new Set((await examStudents(req.scope, e)).map((s) => s.id));
  const subjects = e.subjects || [];
  const total = subjects.reduce((t, s) => t + s.total, 0);
  let saved = 0, cleared = 0;
  const problems = [];
  for (const sid of ids_) {
    if (!allowed.has(sid)) return forbidden(res); // never write results outside your students
    const raw = subjects.map((_, i) => str(req.body[`m_${sid}_${i}`], 6));
    const remarks = str(req.body["remarks_" + sid], 200);
    if (raw.every((x) => x === "")) {
      // An emptied row removes that student's result
      if ((await run("DELETE FROM results WHERE exam_id = ? AND student_id = ? RETURNING id", e.id, sid)).length) cleared++;
      continue;
    }
    // Whole marks or one decimal place, from 0 up to the subject's total; an empty box counts as 0
    if (raw.some((x, i) => x !== "" && (!/^\d{1,4}(\.\d)?$/.test(x) || Number(x) > subjects[i].total))) { problems.push(sid); continue; }
    const marks = raw.map((x) => (x === "" ? 0 : Number(x)));
    const obtained = Math.round(marks.reduce((a, b) => a + b, 0));
    const pct = total ? Math.round((obtained / total) * 10000) / 100 : 0;
    await run(`INSERT INTO results (exam_id, student_id, marks, obtained, total, percentage, grade, remarks, entered_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (exam_id, student_id) DO UPDATE SET marks = EXCLUDED.marks, obtained = EXCLUDED.obtained, total = EXCLUDED.total,
        percentage = EXCLUDED.percentage, grade = EXCLUDED.grade, remarks = EXCLUDED.remarks, entered_by = EXCLUDED.entered_by`,
      e.id, sid, JSON.stringify(marks), obtained, total, pct, gradeFor(pct, e.pass_percent), remarks || null, req.user.id);
    saved++;
  }
  await log(req.user.id, "exam.marks", `${e.title}: ${saved} saved`);
  if (problems.length) req.flash("err", `Saved ${saved}. ${problems.length} student(s) had marks above the subject total or not a number, and were not saved.`);
  else req.flash("ok", `Marks saved for ${saved} student${saved === 1 ? "" : "s"}${cleared ? `, ${cleared} cleared` : ""}.`);
  res.redirect(back);
});

/* ================= Printable result sheet ================= */
router.get("/results/:id/report", markers, async (req, res, next) => {
  const { e, missing, denied } = await loadExam(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const f = { maktab: int(req.query.maktab), cls: str(req.query.class, 60) };
  if (f.maktab && !inMaktab(req.scope, f.maktab)) return forbidden(res);
  const students = await examStudents(req.scope, e, f);
  const results = students.length ? await all(`SELECT * FROM results WHERE exam_id = ? AND student_id IN (${students.map((s) => s.id).join(",")})`, e.id) : [];
  const byStudent = Object.fromEntries(results.map((r) => [r.student_id, r]));
  const pos = await positions(e.id);
  const rows = students.filter((s) => byStudent[s.id]).map((s) => ({ ...s, r: byStudent[s.id], pos: pos[s.id] }));
  const passed = rows.filter((x) => x.r.grade !== "Fail").length;
  const unit = f.maktab ? (await one("SELECT name_en FROM makatib WHERE id = ?", f.maktab) || {}).name_en : null;
  res.render("app/exam-report", { title: "Result sheet: " + e.title, e, rows, f, passed, coverage: unit || coverage(e), printedOn: todayPk() });
});

/* ================= Result certificate ================= */
router.get("/results/:id/certificate/:student", viewers, async (req, res, next) => {
  const { e, missing } = await loadExam(req);
  if (missing) return next();
  const sid = int(req.params.student);
  const s = sid && await one(`SELECT s.*, m.name_en AS maktab, sc.name_en AS school, b.name_en AS branch FROM students s
    LEFT JOIN makatib m ON m.id = s.maktab_id LEFT JOIN schools sc ON sc.id = s.school_id LEFT JOIN branches b ON b.id = s.branch_id WHERE s.id = ?`, sid);
  if (!s) return next();
  if (req.user.role === "parent") {
    if (s.parent_user_id !== req.user.id || e.status !== "published") return forbidden(res);
  } else if (!canSeeExam(req.scope, e) || !canSeePerson(req.scope, s, "student")) return forbidden(res);
  const r = await one("SELECT * FROM results WHERE exam_id = ? AND student_id = ?", e.id, s.id);
  if (!r) { req.flash("err", "No result has been entered for this student in this exam."); return res.redirect(req.user.role === "parent" ? "/app" : "/app/results/" + e.id); }
  const pos = (await positions(e.id))[s.id];
  res.render("app/certificate", { title: "Result certificate: " + s.full_name, e, s, r, pos, issuedOn: todayPk() });
});

module.exports = router;
module.exports.examSql = examSql;
