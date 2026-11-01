/* Teachers and students: registration, profiles, transfers, archive, teacher logins,
   educational progress, reports, printable profiles and student ID cards.
   Every route checks the signed-in user's scope (src/scope.js) on the server. */
"use strict";
const crypto = require("node:crypto");
const express = require("express");
const { one, all, run, log } = require("../db");
const { checkCsrf, requireRole, hashPassword } = require("../auth");
const { withScope, branchSql, maktabSql, personSql, inMaktab, inBranch, canSeePerson } = require("../scope");
const { movePerson } = require("../transfers");
const {
  GENDERS, TEACHER_STATUSES, STUDENT_STATUSES, HIFZ_STATUSES, TAJWEED_STATUSES, EMPLOYMENT_TYPES,
  DESIGNATIONS, EDUCATION_LEVELS, QURAN_LEVELS, PROGRAMMES, DOC_CATEGORIES, todayPk,
} = require("../helpers");
const { helpers: h } = require("./institution");

const router = express.Router();
const staff = [requireRole("admin", "manager"), withScope, checkCsrf];
const staffOrTeacher = [requireRole("admin", "manager", "teacher"), withScope, checkCsrf];
const admin = [requireRole("admin"), withScope, checkCsrf];
const { str, int, like, isUnique, PHONE_RE, DATE_RE, CODE_RE, forbidden } = h;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CNIC_RE = /^\d{5}-?\d{7}-?\d$/;

const PEOPLE = {
  teacher: {
    table: "teachers", plural: "teachers", prefix: "TC", statuses: TEACHER_STATUSES, label: "Teacher", labelPlural: "Teachers",
    cols: ["code", "full_name", "name_ur", "father_name", "gender", "dob", "cnic", "phone", "whatsapp", "email", "address", "district",
      "qualification", "contemporary_qualification", "hifz_status", "tajweed_status", "experience_years", "additional_qualifications",
      "designation", "joined_on", "employment_type", "salary", "status", "notes", "branch_id", "maktab_id"],
  },
  student: {
    table: "students", plural: "students", prefix: "ST", statuses: STUDENT_STATUSES, label: "Student", labelPlural: "Students",
    cols: ["code", "full_name", "name_ur", "father_name", "mother_name", "gender", "dob", "cnic_bform", "phone", "guardian_phone", "address",
      "education_level", "quran_level", "previous_institution", "hifz_status", "tajweed_status", "enrolled_on", "programme", "class_name",
      "teacher_id", "status", "notes", "branch_id", "maktab_id", "admission_id"],
  },
};

const validDate = (s) => DATE_RE.test(s) && !isNaN(Date.parse(s));

/* Reads and validates the form for a teacher or student; returns [values, errors] */
async function personFields(req, type) {
  const b = req.body, cfg = PEOPLE[type];
  const v = {};
  for (const c of cfg.cols) v[c] = str(b[c], c === "notes" || c === "additional_qualifications" ? 2000 : c === "address" ? 300 : 120);
  v.code = v.code.toUpperCase();
  v.gender = GENDERS[v.gender] ? v.gender : "";
  v.status = cfg.statuses.includes(v.status) ? v.status : "active";
  v.maktab_id = int(b.maktab_id);
  v.branch_id = int(b.branch_id);
  v.hifz_status = HIFZ_STATUSES[v.hifz_status] ? v.hifz_status : "";
  v.tajweed_status = TAJWEED_STATUSES[v.tajweed_status] ? v.tajweed_status : "";
  const e = {};

  if (!CODE_RE.test(v.code)) e.code = "Use 2–20 capital letters, numbers or dashes.";
  if (v.full_name.length < 2) e.full_name = "Enter the full name.";
  if (!v.gender) e.gender = "Choose male or female.";
  for (const k of ["phone", "whatsapp", "guardian_phone"]) if (v[k] !== undefined && v[k] && !PHONE_RE.test(v[k])) e[k] = "Enter a valid phone number.";
  for (const k of ["dob", "joined_on", "enrolled_on"]) if (v[k] && !validDate(v[k])) e[k] = "Enter a valid date.";
  if (v.dob && validDate(v.dob) && v.dob > todayPk()) e.dob = "Date of birth cannot be in the future.";

  if (type === "teacher") {
    if (v.cnic && !CNIC_RE.test(v.cnic)) e.cnic = "Enter the 13-digit CNIC, e.g. 45101-1234567-1.";
    if (v.email && !EMAIL_RE.test(v.email)) e.email = "Enter a valid email address.";
    v.email = v.email.toLowerCase();
    v.employment_type = EMPLOYMENT_TYPES[v.employment_type] ? v.employment_type : "";
    v.experience_years = v.experience_years === "" ? null : int(v.experience_years);
    if (str(b.experience_years) !== "" && (v.experience_years === null || v.experience_years > 70)) e.experience_years = "Enter years from 0 to 70.";
    v.salary = v.salary === "" ? null : int(String(v.salary).replace(/[,\s]/g, ""));
    if (str(b.salary) !== "" && v.salary === null) e.salary = "Enter the monthly salary in rupees, numbers only.";
  } else {
    if (v.cnic_bform && !CNIC_RE.test(v.cnic_bform)) e.cnic_bform = "Enter the 13-digit B-Form or CNIC number.";
    v.teacher_id = int(b.teacher_id);
    v.admission_id = int(b.admission_id);
    if (v.teacher_id) {
      const t = await one("SELECT id, maktab_id, branch_id FROM teachers WHERE id = ?", v.teacher_id);
      if (!t || !canSeePerson(req.scope, t, "teacher")) e.teacher_id = "Choose a teacher.";
    }
  }

  if (v.maktab_id) {
    const m = await one("SELECT branch_id, status FROM makatib WHERE id = ?", v.maktab_id);
    if (!m || m.status === "archived") e.maktab_id = "Choose an active Maktab.";
    else if (!inMaktab(req.scope, v.maktab_id)) e.maktab_id = "Choose a Maktab you manage.";
    else v.branch_id = m.branch_id; // a Maktab's branch always wins
  } else if (v.branch_id && !(await one("SELECT id FROM branches WHERE id = ?", v.branch_id))) e.branch_id = "Choose a branch.";
  if (!req.scope.all && !v.maktab_id && !inBranch(req.scope, v.branch_id)) e.maktab_id = "Choose a Maktab or branch you manage.";
  return [v, e];
}

const nullify = (v, cols) => cols.map((c) => (v[c] === "" || v[c] === undefined ? null : v[c]));

async function formOptions(req) {
  return {
    branches: await h.branchList(req.scope), makatib: await h.maktabList(req.scope),
    teachers: await all(`SELECT t.id, t.code, t.full_name, m.name_en AS maktab FROM teachers t LEFT JOIN makatib m ON m.id = t.maktab_id
                         WHERE t.status = 'active' AND ${personSql(req.scope, "t", "teacher")} ORDER BY t.full_name`),
    classes: (await all("SELECT DISTINCT class_name FROM students WHERE class_name IS NOT NULL ORDER BY 1")).map((r) => r.class_name),
    PROGRAMMES, HIFZ_STATUSES, TAJWEED_STATUSES, EMPLOYMENT_TYPES, DESIGNATIONS, EDUCATION_LEVELS, QURAN_LEVELS,
  };
}

async function loadPerson(req, type) {
  const cfg = PEOPLE[type];
  const id = int(req.params.id);
  const x = id && await one(`SELECT x.*, b.name_en AS branch, m.name_en AS maktab, m.name_ur AS maktab_ur
    ${type === "student" ? ", t.full_name AS teacher" : ", u.email AS login_email"}
    FROM ${cfg.table} x LEFT JOIN branches b ON b.id = x.branch_id LEFT JOIN makatib m ON m.id = x.maktab_id
    ${type === "student" ? "LEFT JOIN teachers t ON t.id = x.teacher_id" : "LEFT JOIN users u ON u.id = x.user_id"}
    WHERE x.id = ?`, id);
  if (!x) return { missing: true };
  if (!canSeePerson(req.scope, x, type)) return { denied: true };
  return { x };
}

const photoOf = (type, id) => one("SELECT id FROM attachments WHERE entity_type = ? AND entity_id = ? AND kind = 'photo' ORDER BY id DESC LIMIT 1", type, id);

/* Attendance summary: this month and all time. % counts present + late out of marked days, leave excluded */
async function attendanceSummary(type, id) {
  const table = type === "teacher" ? "teacher_attendance" : "student_attendance";
  const col = type === "teacher" ? "teacher_id" : "student_id";
  const q = (extra) => one(`SELECT
      COUNT(*) FILTER (WHERE status = 'present') AS present, COUNT(*) FILTER (WHERE status = 'late') AS late,
      COUNT(*) FILTER (WHERE status = 'absent') AS absent, COUNT(*) FILTER (WHERE status = 'leave') AS leave
    FROM ${table} WHERE ${col} = ? ${extra}`, id);
  const pct = (r) => { const d = r.present + r.late + r.absent; return d ? Math.round(((r.present + r.late) / d) * 100) : null; };
  const month = await q("AND att_date >= date_trunc('month', CURRENT_DATE)");
  const total = await q("");
  return { month: { ...month, pct: pct(month) }, total: { ...total, pct: pct(total) } };
}

for (const [type, cfg] of Object.entries(PEOPLE)) {
  const base = `/app/${cfg.plural}`;
  const renderForm = async (req, res, title, values, errors, status = 200) =>
    res.status(status).render("app/person-form", { title, values, errors, type, cfg, ...(await formOptions(req)) });

  /* ---------- List (students: teachers see their own, read-only) ---------- */
  router.get(`/${cfg.plural}`, type === "student" ? staffOrTeacher : staff, async (req, res) => {
    const f = {
      q: str(req.query.q, 80), branch: int(req.query.branch), maktab: int(req.query.maktab), teacher: int(req.query.teacher),
      gender: GENDERS[req.query.gender] ? req.query.gender : "", cls: str(req.query.class, 60),
      employment: EMPLOYMENT_TYPES[req.query.employment] ? req.query.employment : "",
      status: [...cfg.statuses, "all"].includes(req.query.status) ? req.query.status : "",
    };
    const where = [personSql(req.scope, "x", type)], p = [];
    if (f.status && f.status !== "all") { where.push("x.status = ?"); p.push(f.status); }
    else if (!f.status && type === "teacher") where.push("x.status <> 'archived'");
    if (f.branch) { where.push("x.branch_id = ?"); p.push(f.branch); }
    if (f.maktab) { where.push("x.maktab_id = ?"); p.push(f.maktab); }
    if (f.gender) { where.push("x.gender = ?"); p.push(f.gender); }
    if (type === "student" && f.teacher) { where.push("x.teacher_id = ?"); p.push(f.teacher); }
    if (type === "student" && f.cls) { where.push("x.class_name = ?"); p.push(f.cls); }
    if (type === "teacher" && f.employment) { where.push("x.employment_type = ?"); p.push(f.employment); }
    if (f.q) {
      where.push("(x.full_name ILIKE ? OR x.name_ur ILIKE ? OR x.code ILIKE ? OR x.father_name ILIKE ? OR x.phone ILIKE ?)");
      p.push(like(f.q), like(f.q), like(f.q), like(f.q), like(f.q));
    }
    const rows = await all(`SELECT x.*, b.name_en AS branch, m.name_en AS maktab,
        (SELECT a.id FROM attachments a WHERE a.entity_type = '${type}' AND a.entity_id = x.id AND a.kind = 'photo' ORDER BY a.id DESC LIMIT 1) AS photo_id
        ${type === "student" ? ", t.full_name AS teacher" : ""}
      FROM ${cfg.table} x LEFT JOIN branches b ON b.id = x.branch_id LEFT JOIN makatib m ON m.id = x.maktab_id
      ${type === "student" ? "LEFT JOIN teachers t ON t.id = x.teacher_id" : ""}
      WHERE ${where.join(" AND ")} ORDER BY x.full_name LIMIT 1000`, ...p);
    res.render("app/people", { title: req.user.role === "teacher" ? "My students" : cfg.labelPlural, rows, type, cfg, filters: f, ...(await formOptions(req)) });
  });

  /* ---------- Register ---------- */
  router.get(`/${cfg.plural}/new`, staff, async (req, res) => {
    const values = { code: await h.nextCode(cfg.table, cfg.prefix), status: "active", maktab_id: int(req.query.maktab) };
    // Registering an approved applicant: start from their admission details
    const adm = type === "student" && int(req.query.admission) && await one("SELECT * FROM admissions WHERE id = ?", int(req.query.admission));
    if (adm) Object.assign(values, {
      admission_id: adm.id, full_name: adm.student_name, father_name: adm.father_name, dob: adm.dob, guardian_phone: adm.phone,
      address: adm.address, programme: adm.programme, maktab_id: adm.maktab_id || values.maktab_id, enrolled_on: todayPk(),
      gender: adm.branch === "girls" ? "female" : adm.branch === "boys" ? "male" : "",
    });
    await renderForm(req, res, `Register ${cfg.label.toLowerCase()}`, values, {});
  });

  router.post(`/${cfg.plural}`, staff, async (req, res) => {
    const [v, e] = await personFields(req, type);
    if (Object.keys(e).length) return renderForm(req, res, `Register ${cfg.label.toLowerCase()}`, v, e, 400);
    const cols = cfg.cols.filter((c) => type === "student" || c !== "admission_id");
    let r;
    try {
      r = await one(`INSERT INTO ${cfg.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) RETURNING id`, ...nullify(v, cols));
    } catch (err) {
      if (isUnique(err)) {
        const field = /cnic/.test(err.constraint || err.message || "") ? "cnic" : "code";
        return renderForm(req, res, `Register ${cfg.label.toLowerCase()}`, v, { [field]: `This ${field === "cnic" ? "CNIC" : "code"} is already registered.` }, 400);
      }
      throw err;
    }
    await log(req.user.id, type + ".create", `${v.code} ${v.full_name}`);
    req.flash("ok", `${cfg.label} ${v.full_name} registered. Add a photograph and documents below.`);
    res.redirect(`${base}/${r.id}`);
  });

  /* ---------- Profile ---------- */
  router.get(`/${cfg.plural}/:id`, staffOrTeacher, async (req, res, next) => {
    const { x, missing, denied } = await loadPerson(req, type);
    if (missing) return next();
    if (denied) return forbidden(res);
    const [files, photo, att, transfers, extra] = await Promise.all([
      h.filesFor(type, x.id), photoOf(type, x.id), attendanceSummary(type, x.id),
      all(`SELECT tr.*, f.name_en AS from_name, t.name_en AS to_name, u.name AS by_name FROM transfers tr
           LEFT JOIN makatib f ON f.id = tr.from_maktab_id LEFT JOIN makatib t ON t.id = tr.to_maktab_id
           LEFT JOIN users u ON u.id = tr.transferred_by WHERE tr.person_type = ? AND tr.person_id = ? ORDER BY tr.id DESC`, type, x.id),
      type === "teacher"
        ? all("SELECT id, code, full_name, class_name, status FROM students WHERE teacher_id = ? ORDER BY full_name", x.id)
        : all(`SELECT p.*, u.name AS by_name FROM student_progress p LEFT JOIN users u ON u.id = p.recorded_by
               WHERE p.student_id = ? ORDER BY p.recorded_on DESC, p.id DESC`, x.id),
    ]);
    res.render("app/person", {
      title: x.full_name, x, type, cfg, files, photo, att, transfers,
      students: type === "teacher" ? extra : [], progress: type === "student" ? extra : [],
      makatib: req.scope.canManage ? (await h.maktabList(req.scope)).filter((m) => m.id !== x.maktab_id) : [],
      branches: req.scope.canManage ? await h.branchList(req.scope) : [],
      categories: DOC_CATEGORIES[type], canManage: req.scope.canManage,
      isSelf: type === "teacher" && req.scope.teacherId === x.id,
      HIFZ_STATUSES, TAJWEED_STATUSES, EMPLOYMENT_TYPES, QURAN_LEVELS, today: todayPk(),
    });
  });

  /* ---------- Edit ---------- */
  router.get(`/${cfg.plural}/:id/edit`, staff, async (req, res, next) => {
    const { x, missing, denied } = await loadPerson(req, type);
    if (missing) return next();
    if (denied) return forbidden(res);
    await renderForm(req, res, `Edit ${x.full_name}`, { ...x, editId: x.id }, {});
  });

  router.post(`/${cfg.plural}/:id`, staff, async (req, res, next) => {
    const { x, missing, denied } = await loadPerson(req, type);
    if (missing) return next();
    if (denied) return forbidden(res);
    const [v, e] = await personFields(req, type);
    if (Object.keys(e).length) return renderForm(req, res, `Edit ${x.full_name}`, { ...v, editId: x.id }, e, 400);
    // The Maktab moves through movePerson so the change lands in the transfer history
    const cols = cfg.cols.filter((c) => c !== "maktab_id" && c !== "admission_id" && c !== "branch_id");
    try {
      await run(`UPDATE ${cfg.table} SET ${cols.map((c) => c + " = ?").join(", ")} WHERE id = ?`, ...nullify(v, cols), x.id);
    } catch (err) {
      if (isUnique(err)) {
        const field = /cnic/.test(err.constraint || err.message || "") ? "cnic" : "code";
        return renderForm(req, res, `Edit ${x.full_name}`, { ...v, editId: x.id }, { [field]: `This ${field === "cnic" ? "CNIC" : "code"} is already registered.` }, 400);
      }
      throw err;
    }
    if ((v.maktab_id || null) !== (x.maktab_id || null) || (!v.maktab_id && (v.branch_id || null) !== (x.branch_id || null))) {
      await movePerson(type, x.id, v.maktab_id, "Changed on the edit form", req.user.id, v.branch_id);
    }
    await log(req.user.id, type + ".update", `${v.code} ${v.full_name}`);
    req.flash("ok", `${v.full_name} saved.`);
    res.redirect(`${base}/${x.id}`);
  });

  /* ---------- Transfer to another Maktab, or to a branch without a Maktab ---------- */
  router.post(`/${cfg.plural}/:id/transfer`, staff, async (req, res, next) => {
    const { x, missing, denied } = await loadPerson(req, type);
    if (missing) return next();
    if (denied) return forbidden(res);
    const toMaktab = int(req.body.maktab_id), toBranch = int(req.body.branch_id);
    if (toMaktab && !inMaktab(req.scope, toMaktab)) return forbidden(res);
    if (!toMaktab && toBranch && !req.scope.all && !inBranch(req.scope, toBranch)) return forbidden(res);
    if (!toMaktab && !toBranch) { req.flash("err", "Choose a Maktab or a branch."); return res.redirect(req.get("referer") || base); }
    const r = await movePerson(type, x.id, toMaktab, str(req.body.note, 300), req.user.id, toBranch);
    req.flash(r.error ? "err" : "ok", r.error || r.ok);
    const ref = req.get("referer");
    res.redirect(ref && new URL(ref).host === req.get("host") ? ref : `${base}/${x.id}`);
  });

  /* ---------- Printable profile ---------- */
  router.get(`/${cfg.plural}/:id/print`, staffOrTeacher, async (req, res, next) => {
    const { x, missing, denied } = await loadPerson(req, type);
    if (missing) return next();
    if (denied) return forbidden(res);
    res.render("app/person-print", {
      title: x.full_name, x, type, cfg, photo: await photoOf(type, x.id), att: await attendanceSummary(type, x.id),
      files: await h.filesFor(type, x.id), categories: DOC_CATEGORIES[type],
      HIFZ_STATUSES, TAJWEED_STATUSES, EMPLOYMENT_TYPES, printedOn: todayPk(),
    });
  });
}

/* ---------- Teachers: archive / restore ---------- */
router.post("/teachers/:id/archive", staff, async (req, res, next) => {
  const { x, missing, denied } = await loadPerson(req, "teacher");
  if (missing) return next();
  if (denied) return forbidden(res);
  const restore = req.body.restore === "1";
  await run("UPDATE teachers SET status = ? WHERE id = ?", restore ? "active" : "archived", x.id);
  // An archived teacher can no longer sign in
  if (x.user_id) await run("UPDATE users SET status = ? WHERE id = ?", restore ? "active" : "suspended", x.user_id);
  await log(req.user.id, restore ? "teacher.restore" : "teacher.archive", `${x.code} ${x.full_name}`);
  req.flash("ok", restore ? `${x.full_name} restored.` : `${x.full_name} archived.${x.user_id ? " Their login is suspended." : ""}`);
  res.redirect("/app/teachers/" + x.id);
});

/* ---------- Teachers: create a sign-in account (admins) ---------- */
router.post("/teachers/:id/login", admin, async (req, res, next) => {
  const { x, missing } = await loadPerson(req, "teacher");
  if (missing) return next();
  if (x.user_id) { req.flash("err", "This teacher already has a login."); return res.redirect("/app/teachers/" + x.id); }
  const email = str(req.body.email || x.email, 120).toLowerCase();
  if (!EMAIL_RE.test(email)) { req.flash("err", "Enter a valid email address for the login."); return res.redirect("/app/teachers/" + x.id + "#login"); }
  if (await one("SELECT id FROM users WHERE email = ?", email)) { req.flash("err", "That email already has an account."); return res.redirect("/app/teachers/" + x.id + "#login"); }
  const password = crypto.randomBytes(6).toString("base64url");
  const u = await one("INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'teacher') RETURNING id",
    x.full_name, email, x.phone, hashPassword(password));
  await run("UPDATE teachers SET user_id = ?, email = COALESCE(email, ?) WHERE id = ?", u.id, email, x.id);
  await log(req.user.id, "teacher.create_login", `${x.full_name} <${email}>`);
  req.flash("ok", `Login created for ${x.full_name}: ${email}, temporary password ${password}`);
  res.redirect("/app/teachers/" + x.id);
});

/* ---------- Teachers: update own contact details ---------- */
router.post("/teachers/:id/contact", requireRole("teacher"), withScope, checkCsrf, async (req, res, next) => {
  const id = int(req.params.id);
  if (!id || req.scope.teacherId !== id) return forbidden(res);
  const v = { phone: str(req.body.phone, 30), whatsapp: str(req.body.whatsapp, 30), email: str(req.body.email, 120).toLowerCase(), address: str(req.body.address, 300) };
  const bad = (v.phone && !PHONE_RE.test(v.phone)) || (v.whatsapp && !PHONE_RE.test(v.whatsapp)) || (v.email && !EMAIL_RE.test(v.email));
  if (bad) { req.flash("err", "Check the phone numbers and email address."); return res.redirect("/app/teachers/" + id); }
  await run("UPDATE teachers SET phone = ?, whatsapp = ?, email = ?, address = ? WHERE id = ?", v.phone || null, v.whatsapp || null, v.email || null, v.address || null, id);
  await log(req.user.id, "teacher.update_contact", "#" + id);
  req.flash("ok", "Your contact details are saved.");
  res.redirect("/app/teachers/" + id);
});

/* ---------- Students: progress log (staff and the student's teachers) ---------- */
router.post("/students/:id/progress", staffOrTeacher, async (req, res, next) => {
  const { x, missing, denied } = await loadPerson(req, "student");
  if (missing) return next();
  if (denied) return forbidden(res);
  const v = { recorded_on: str(req.body.recorded_on, 10) || todayPk(), quran_level: str(req.body.quran_level, 60), lesson: str(req.body.lesson, 200), remarks: str(req.body.remarks, 1000) };
  if (!validDate(v.recorded_on) || v.recorded_on > todayPk()) { req.flash("err", "Choose a valid date, not in the future."); return res.redirect(`/app/students/${x.id}#progress`); }
  if (!v.quran_level && !v.lesson && !v.remarks) { req.flash("err", "Write the lesson, level or a remark."); return res.redirect(`/app/students/${x.id}#progress`); }
  await run("INSERT INTO student_progress (student_id, recorded_on, quran_level, lesson, remarks, recorded_by) VALUES (?, ?, ?, ?, ?, ?)",
    x.id, v.recorded_on, v.quran_level || null, v.lesson || null, v.remarks || null, req.user.id);
  if (v.quran_level) await run("UPDATE students SET quran_level = ? WHERE id = ?", v.quran_level, x.id);
  await log(req.user.id, "student.progress", `${x.full_name}: ${v.lesson || v.quran_level || "remark"}`);
  req.flash("ok", "Progress recorded.");
  res.redirect(`/app/students/${x.id}#progress`);
});

/* ---------- Students: ID card ---------- */
router.get("/students/:id/card", staff, async (req, res, next) => {
  const { x, missing, denied } = await loadPerson(req, "student");
  if (missing) return next();
  if (denied) return forbidden(res);
  res.render("app/student-card", { title: "ID card: " + x.full_name, x, photo: await photoOf("student", x.id), issuedOn: todayPk() });
});

/* ---------- Teacher report (printable) ---------- */
router.get("/reports/teachers", staff, async (req, res) => {
  const branch = int(req.query.branch), status = TEACHER_STATUSES.includes(req.query.status) ? req.query.status : "";
  const where = [personSql(req.scope, "t", "teacher")], p = [];
  if (branch) { where.push("t.branch_id = ?"); p.push(branch); }
  if (status) { where.push("t.status = ?"); p.push(status); } else where.push("t.status <> 'archived'");
  const w = where.join(" AND ");
  const rows = await all(`SELECT t.*, b.name_en AS branch, m.name_en AS maktab,
      (SELECT COUNT(*) FROM students s WHERE s.teacher_id = t.id AND s.status = 'active') AS students,
      (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE a.status IN ('present','late')) / NULLIF(COUNT(*) FILTER (WHERE a.status <> 'leave'), 0))
         FROM teacher_attendance a WHERE a.teacher_id = t.id AND a.att_date >= date_trunc('month', CURRENT_DATE)) AS att_pct
    FROM teachers t LEFT JOIN branches b ON b.id = t.branch_id LEFT JOIN makatib m ON m.id = t.maktab_id
    WHERE ${w} ORDER BY b.name_en NULLS LAST, m.name_en NULLS LAST, t.full_name`, ...p);
  const group = (key) => Object.entries(rows.reduce((acc, r) => { const k = r[key] || "—"; acc[k] = (acc[k] || 0) + 1; return acc; }, {}));
  res.render("app/report-teachers", {
    title: "Teacher report", rows, filters: { branch, status }, branches: await h.branchList(req.scope),
    byBranch: group("branch"), byStatus: group("status"), byType: group("employment_type"), byGender: group("gender"),
    printedOn: todayPk(),
  });
});

module.exports = router;
module.exports.attendanceSummary = attendanceSummary;
