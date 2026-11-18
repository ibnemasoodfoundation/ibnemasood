/* The two Jamias, managed separately:
   boys  = Jamia Arabia Abdullah Bin Masood (Baneen), Darja-e-Ula to Daura-e-Hadith
   girls = Jamia Arabia Aisha Siddiqa (Banaat), Khasa Awwal to Aalamiya Dom
   A Jamia's students and teachers are the ones placed directly in its main branch (branches.section),
   not in a Maktab or school. The Super Admin manages both; a Branch Manager set as manager of a main
   branch manages only that Jamia. Baneen pages never show Banaat records and the other way round. */
"use strict";
const express = require("express");
const { one, all, run, log } = require("../db");
const { checkCsrf, requireRole } = require("../auth");
const { loadScope } = require("../scope");
const { JAMIAS, DARJAT, ATTENDANCE, SESSIONS, todayPk } = require("../helpers");
const { helpers: h } = require("./institution");

const router = express.Router();
const guard = [requireRole("admin", "manager"), checkCsrf];
const { str, int, PHONE_RE, DATE_RE, isUnique, forbidden } = h;
const CNIC_RE = /^\d{5}-?\d{7}-?\d$/;
const validDate = (d) => DATE_RE.test(d) && !isNaN(Date.parse(d));
// A Jamia's own students: in its main branch, not in one of its Makatib or schools
const OWN = (alias = "s") => `${alias}.branch_id = ? AND ${alias}.maktab_id IS NULL AND ${alias}.school_id IS NULL`;

/* The main branch of a Jamia, if the signed-in user may manage it.
   The Boys / Girls header switch does not apply here: these pages are already one Jamia. */
async function loadJamia(req) {
  const sec = req.params.sec;
  if (!JAMIAS[sec]) return { missing: true };
  const b = await one("SELECT * FROM branches WHERE section = ? AND status <> 'archived' ORDER BY id LIMIT 1", sec);
  if (!b) return { missing: true };
  const base = await loadScope(req.user);
  if (!base.all && !base.branchIds.includes(b.id)) return { denied: true };
  return { b, sec, J: JAMIAS[sec], darjat: DARJAT[sec] };
}
const darjaOf = (darjat, key) => darjat.find((d) => d[0] === key);

async function myJamias(user) {
  const base = await loadScope(user);
  const rows = await all("SELECT id, section FROM branches WHERE section IS NOT NULL AND status <> 'archived' ORDER BY id");
  const seen = new Set();
  return rows.filter((b) => (base.all || base.branchIds.includes(b.id)) && !seen.has(b.section) && seen.add(b.section)).map((b) => b.section);
}

/* ================= Overview of both Jamias ================= */
router.get("/jamia", guard, async (req, res) => {
  const mine = await myJamias(req.user);
  if (mine.length === 1) return res.redirect("/app/jamia/" + mine[0]);
  if (!mine.length) return forbidden(res);
  const cards = [];
  for (const sec of mine) {
    const b = await one("SELECT * FROM branches WHERE section = ? AND status <> 'archived' ORDER BY id LIMIT 1", sec);
    const c = await one(`SELECT COUNT(*) FILTER (WHERE s.status = 'active') AS students,
        COUNT(*) FILTER (WHERE s.status = 'graduated') AS graduated FROM students s WHERE ${OWN()}`, b.id);
    const t = await one("SELECT COUNT(*) AS n FROM teachers t WHERE t.branch_id = ? AND t.maktab_id IS NULL AND t.school_id IS NULL AND t.status = 'active'", b.id);
    cards.push({ sec, b, J: JAMIAS[sec], students: c.students, graduated: c.graduated, teachers: t.n, darjat: DARJAT[sec].length });
  }
  res.render("app/jamia-index", { title: "Jamias", cards });
});

/* ================= Dashboard ================= */
router.get("/jamia/:sec", guard, async (req, res, next) => {
  const { b, sec, J, darjat, missing, denied } = await loadJamia(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const today = todayPk();
  const counts = await all(`SELECT s.darja, COUNT(*) AS n,
      COUNT(*) FILTER (WHERE a.status = 'absent') AS absent, COUNT(a.id) AS marked
    FROM students s LEFT JOIN student_attendance a ON a.student_id = s.id AND a.att_date = ? AND a.session = 'morning'
    WHERE ${OWN()} AND s.status = 'active' GROUP BY s.darja`, today, b.id);
  const by = Object.fromEntries(counts.map((c) => [c.darja || "", c]));
  const rows = darjat.map(([key, name, year]) => ({ key, name, year, n: (by[key] || {}).n || 0, marked: (by[key] || {}).marked || 0, absent: (by[key] || {}).absent || 0 }));
  const noDarja = by[""] || null;
  const total = counts.reduce((t, c) => t + c.n, 0);
  const marked = counts.reduce((t, c) => t + c.marked, 0), absent = counts.reduce((t, c) => t + c.absent, 0);
  const [teachers, graduated, exams, wrongGender] = await Promise.all([
    one("SELECT COUNT(*) AS n FROM teachers t WHERE t.branch_id = ? AND t.maktab_id IS NULL AND t.school_id IS NULL AND t.status = 'active'", b.id),
    one(`SELECT COUNT(*) AS n FROM students s WHERE ${OWN()} AND s.status = 'graduated'`, b.id),
    all("SELECT id, title, exam_type, status, held_on FROM exams WHERE branch_id = ? ORDER BY id DESC LIMIT 6", b.id),
    one(`SELECT COUNT(*) AS n FROM students s WHERE ${OWN()} AND s.status = 'active' AND s.gender <> ?`, b.id, J.gender),
  ]);
  res.render("app/jamia", {
    title: `${J.name} (${J.group})`, b, sec, J, rows, noDarja, total, marked, absent, today,
    teachers: teachers.n, graduated: graduated.n, exams, wrongGender: wrongGender.n,
    chart: { labels: rows.map((r) => r.name), values: rows.map((r) => r.n) },
  });
});

/* ================= Students, darja-wise ================= */
router.get("/jamia/:sec/students", guard, async (req, res, next) => {
  const { b, sec, J, darjat, missing, denied } = await loadJamia(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const f = { darja: darjaOf(darjat, req.query.darja) ? req.query.darja : req.query.darja === "none" ? "none" : "", q: str(req.query.q, 80),
    status: ["active", "inactive", "graduated", "left", "all"].includes(req.query.status) ? req.query.status : "active" };
  const where = [OWN()], p = [b.id];
  if (f.status !== "all") { where.push("s.status = ?"); p.push(f.status); }
  if (f.darja === "none") where.push("s.darja IS NULL");
  else if (f.darja) { where.push("s.darja = ?"); p.push(f.darja); }
  if (f.q) { where.push("(s.full_name ILIKE ? OR s.name_ur ILIKE ? OR s.code ILIKE ? OR s.father_name ILIKE ?)"); p.push(...Array(4).fill(h.like(f.q))); }
  const rows = await all(`SELECT s.id, s.code, s.full_name, s.name_ur, s.father_name, s.darja, s.status, s.guardian_phone, s.enrolled_on, s.extra
    FROM students s WHERE ${where.join(" AND ")} ORDER BY s.darja NULLS LAST, s.full_name LIMIT 2000`, ...p);
  const order = Object.fromEntries(darjat.map((d, i) => [d[0], i]));
  rows.sort((a, c) => (order[a.darja] ?? 99) - (order[c.darja] ?? 99) || a.full_name.localeCompare(c.full_name));
  res.render("app/jamia-students", { title: `${J.group} students`, b, sec, J, darjat, rows, f });
});

/* ================= Register a Jamia student ================= */
function renderRegister(res, ctx, values, errors, status = 200) {
  res.status(status).render("app/jamia-register", { title: `Register student: ${ctx.J.name}`, ...ctx, values, errors });
}

router.get("/jamia/:sec/register", guard, async (req, res, next) => {
  const ctx = await loadJamia(req);
  if (ctx.missing) return next();
  if (ctx.denied) return forbidden(res);
  renderRegister(res, ctx, { darja: darjaOf(ctx.darjat, req.query.darja) ? req.query.darja : "", enrolled_on: todayPk(), residence: "" }, {});
});

router.post("/jamia/:sec/register", guard, async (req, res, next) => {
  const ctx = await loadJamia(req);
  if (ctx.missing) return next();
  if (ctx.denied) return forbidden(res);
  const b = req.body, { J, darjat } = ctx;
  const v = {
    full_name: str(b.full_name, 120), name_ur: str(b.name_ur, 120), father_name: str(b.father_name, 120), dob: str(b.dob, 10),
    cnic_bform: str(b.cnic_bform, 20), phone: str(b.phone, 30), guardian_phone: str(b.guardian_phone, 30), address: str(b.address, 300),
    previous_institution: str(b.previous_institution, 120), enrolled_on: str(b.enrolled_on, 10), darja: str(b.darja, 20),
    district: str(b.district, 80), residence: ["hostel", "day"].includes(b.residence) ? b.residence : "", notes: str(b.notes, 1000),
  };
  const e = {};
  if (v.full_name.length < 2) e.full_name = "Enter the student's name.";
  if (!darjaOf(darjat, v.darja)) e.darja = "Choose the darja.";
  if (v.dob && (!validDate(v.dob) || v.dob > todayPk())) e.dob = "Enter a valid date of birth.";
  if (v.enrolled_on && !validDate(v.enrolled_on)) e.enrolled_on = "Enter a valid date.";
  if (v.cnic_bform && !CNIC_RE.test(v.cnic_bform)) e.cnic_bform = "Enter the 13-digit number, e.g. 45101-1234567-1.";
  for (const k of ["phone", "guardian_phone"]) if (v[k] && !PHONE_RE.test(v[k])) e[k] = "Enter a valid phone number.";
  if (Object.keys(e).length) return renderRegister(res, ctx, v, e, 400);
  const extra = {};
  if (v.district) extra.district = v.district;
  if (v.residence) extra.residence = v.residence;
  let r;
  for (let i = 0; i < 3 && !r; i++) {
    try {
      r = await one(`INSERT INTO students (code, full_name, name_ur, father_name, gender, dob, cnic_bform, phone, guardian_phone, address,
          previous_institution, enrolled_on, programme, class_name, darja, branch_id, status, notes, extra)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?) RETURNING id, code`,
        await h.nextCode("students", ctx.sec === "boys" ? "JB" : "JG"), v.full_name, v.name_ur || null, v.father_name || null, J.gender,
        v.dob || null, v.cnic_bform || null, v.phone || null, v.guardian_phone || null, v.address || null, v.previous_institution || null,
        v.enrolled_on || null, ctx.sec === "boys" ? "Dars-e-Nizami" : "Alimah course", darjaOf(darjat, v.darja)[1], v.darja, ctx.b.id,
        v.notes || null, JSON.stringify(extra));
    } catch (err) {
      if (!isUnique(err)) throw err;
      if (/cnic/.test(err.constraint || err.message || "")) return renderRegister(res, ctx, v, { cnic_bform: "This B-Form / CNIC number is already registered." }, 400);
    }
  }
  await log(req.user.id, "jamia.register", `${r.code} ${v.full_name} (${J.group}, ${v.darja})`);
  req.flash("ok", `${v.full_name} registered in ${darjaOf(darjat, v.darja)[1]} as ${r.code}. Add the photograph and documents below.`);
  res.redirect("/app/students/" + r.id);
});

/* ================= Darja-wise attendance ================= */
function pickDate(v) { const d = str(v, 10); return validDate(d) && d <= todayPk() ? d : todayPk(); }

router.get("/jamia/:sec/attendance", guard, async (req, res, next) => {
  const { b, sec, J, darjat, missing, denied } = await loadJamia(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const f = { darja: darjaOf(darjat, req.query.darja) ? req.query.darja : darjat[0][0], date: pickDate(req.query.date), session: SESSIONS[req.query.session] ? req.query.session : "morning" };
  const students = await all(`SELECT s.id, s.code, s.full_name, s.name_ur, s.father_name, a.status AS mark, a.note
    FROM students s LEFT JOIN student_attendance a ON a.student_id = s.id AND a.att_date = ? AND a.session = ?
    WHERE ${OWN()} AND s.status = 'active' AND s.darja = ? ORDER BY s.full_name`, f.date, f.session, b.id, f.darja);
  const counts = { present: 0, absent: 0, leave: 0, late: 0 };
  students.forEach((s) => s.mark && counts[s.mark]++);
  res.render("app/jamia-attendance", { title: `${J.group} attendance`, b, sec, J, darjat, f, students, counts, ATTENDANCE, SESSIONS, today: todayPk() });
});

router.post("/jamia/:sec/attendance", guard, async (req, res, next) => {
  const { b, sec, darjat, missing, denied } = await loadJamia(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const date = str(req.body.date, 10), session = SESSIONS[req.body.session] ? req.body.session : "morning";
  const darja = darjaOf(darjat, req.body.darja) ? req.body.darja : darjat[0][0];
  const back = `/app/jamia/${sec}/attendance?${new URLSearchParams({ darja, date, session })}`;
  if (!validDate(date) || date > todayPk()) { req.flash("err", "Attendance can only be marked for today or an earlier date."); return res.redirect(back); }
  const entries = Object.entries(req.body).filter(([k, v]) => /^status_\d{1,9}$/.test(k) && ATTENDANCE[v]).map(([k, v]) => [Number(k.slice(7)), v]);
  if (!entries.length) { req.flash("err", "Mark at least one student."); return res.redirect(back); }
  const allowed = new Set((await all(`SELECT s.id FROM students s WHERE ${OWN()} AND s.status = 'active'`, b.id)).map((s) => s.id));
  for (const [id, status] of entries) {
    if (!allowed.has(id)) return forbidden(res); // never mark another Jamia's students
    await run(`INSERT INTO student_attendance (student_id, maktab_id, att_date, session, status, note, marked_by) VALUES (?, NULL, ?, ?, ?, ?, ?)
      ON CONFLICT (student_id, att_date, session) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, marked_by = EXCLUDED.marked_by`,
      id, date, session, status, str(req.body["note_" + id], 200) || null, req.user.id);
  }
  await log(req.user.id, "jamia.attendance", `${sec} ${darja} ${date}: ${entries.length}`);
  req.flash("ok", `Attendance saved for ${entries.length} student${entries.length === 1 ? "" : "s"}.`);
  res.redirect(back);
});

/* ================= Year-end promotion ================= */
router.get("/jamia/:sec/promote", guard, async (req, res, next) => {
  const { b, sec, J, darjat, missing, denied } = await loadJamia(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const from = darjaOf(darjat, req.query.darja) ? req.query.darja : darjat[0][0];
  const idx = darjat.findIndex((d) => d[0] === from);
  const students = await all(`SELECT s.id, s.code, s.full_name, s.father_name FROM students s WHERE ${OWN()} AND s.status = 'active' AND s.darja = ? ORDER BY s.full_name`, b.id, from);
  res.render("app/jamia-promote", { title: `Promote ${J.group} students`, b, sec, J, darjat, from, next: darjat[idx + 1] || null, students });
});

router.post("/jamia/:sec/promote", guard, async (req, res, next) => {
  const { b, sec, darjat, missing, denied } = await loadJamia(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const from = darjaOf(darjat, req.body.from) ? req.body.from : null;
  if (!from) return res.redirect(`/app/jamia/${sec}/promote`);
  const nxt = darjat[darjat.findIndex((d) => d[0] === from) + 1] || null;
  const chosen = [].concat(req.body.student || []).map(int).filter(Boolean);
  if (!chosen.length) { req.flash("err", "Tick the students to promote."); return res.redirect(`/app/jamia/${sec}/promote?darja=${from}`); }
  const ok = new Set((await all(`SELECT s.id FROM students s WHERE ${OWN()} AND s.status = 'active' AND s.darja = ?`, b.id, from)).map((s) => s.id));
  let moved = 0;
  for (const id of chosen) {
    if (!ok.has(id)) continue;
    if (nxt) await run("UPDATE students SET darja = ?, class_name = ? WHERE id = ?", nxt[0], nxt[1], id);
    else await run("UPDATE students SET status = 'graduated' WHERE id = ?", id);
    await run("INSERT INTO student_progress (student_id, recorded_on, quran_level, lesson, remarks, recorded_by) VALUES (?, ?, NULL, NULL, ?, ?)",
      id, todayPk(), nxt ? `Promoted from ${darjaOf(darjat, from)[1]} to ${nxt[1]}` : `Completed ${darjaOf(darjat, from)[1]} (graduated)`, req.user.id);
    moved++;
  }
  await log(req.user.id, "jamia.promote", `${sec} ${from} → ${nxt ? nxt[0] : "graduated"}: ${moved}`);
  req.flash("ok", nxt ? `${moved} student${moved === 1 ? "" : "s"} promoted to ${nxt[1]}.` : `${moved} student${moved === 1 ? "" : "s"} completed the final year and marked graduated.`);
  res.redirect(`/app/jamia/${sec}/promote?darja=${from}`);
});

/* ================= Teachers of the Jamia ================= */
router.get("/jamia/:sec/teachers", guard, async (req, res, next) => {
  const { b, sec, J, missing, denied } = await loadJamia(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const rows = await all(`SELECT t.id, t.code, t.full_name, t.name_ur, t.designation, t.phone, t.status, t.qualification FROM teachers t
    WHERE t.branch_id = ? AND t.maktab_id IS NULL AND t.school_id IS NULL AND t.status <> 'archived' ORDER BY t.full_name`, b.id);
  res.render("app/jamia-teachers", { title: `${J.group} teachers`, b, sec, J, rows });
});

/* ================= Printable darja report ================= */
router.get("/jamia/:sec/report", guard, async (req, res, next) => {
  const { b, sec, J, darjat, missing, denied } = await loadJamia(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(str(req.query.month, 7)) ? str(req.query.month, 7) : todayPk().slice(0, 7);
  const rows = await all(`SELECT s.darja, COUNT(DISTINCT s.id) AS students,
      COUNT(a.id) FILTER (WHERE a.status = 'present') AS present, COUNT(a.id) FILTER (WHERE a.status = 'late') AS late,
      COUNT(a.id) FILTER (WHERE a.status = 'absent') AS absent, COUNT(a.id) FILTER (WHERE a.status = 'leave') AS leave
    FROM students s LEFT JOIN student_attendance a ON a.student_id = s.id AND to_char(a.att_date, 'YYYY-MM') = ?
    WHERE ${OWN()} AND s.status = 'active' GROUP BY s.darja`, month, b.id);
  const by = Object.fromEntries(rows.map((r) => [r.darja || "", r]));
  const pct = (r) => { const d = r.present + r.late + r.absent; return d ? Math.round(((r.present + r.late) / d) * 100) : null; };
  const lines = darjat.map(([key, name, year]) => { const r = by[key] || { students: 0, present: 0, late: 0, absent: 0, leave: 0 }; return { key, name, year, ...r, pct: pct(r) }; });
  const students = await all(`SELECT s.code, s.full_name, s.father_name, s.darja, s.guardian_phone FROM students s
    WHERE ${OWN()} AND s.status = 'active' ORDER BY s.full_name`, b.id);
  res.render("app/jamia-report", { title: `${J.name}: darja report`, b, sec, J, darjat, lines, students, month, printedOn: todayPk(), withList: req.query.list === "1" });
});

module.exports = router;
