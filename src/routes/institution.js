/* Institution structure for staff: branches, Makatib, teachers, students,
   transfers between Makatib, and photo/document uploads. */
"use strict";
const express = require("express");
const { one, all, run, log } = require("../db");
const { checkCsrf, requireRole } = require("../auth");
const { acceptUpload, filePath, removeFile } = require("../uploads");
const {
  REPORTED_TOWNS, UNIT_STATUSES, TEACHER_STATUSES, STUDENT_STATUSES, GENDERS, PROGRAMMES,
} = require("../helpers");

const router = express.Router();

// Guards are applied per route: this router is mounted on /app ahead of the member routes,
// so a router-wide staff guard would lock members out of their own dashboard.
const staff = [requireRole("admin", "manager"), checkCsrf];
const admin = [requireRole("admin"), checkCsrf];

const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const int = (v) => (/^\d{1,9}$/.test(String(v ?? "").trim()) ? Number(v) : null);
const PHONE_RE = /^[+\d][\d\s-]{6,19}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const CNIC_RE = /^\d{5}-?\d{7}-?\d$/;
const back = (req, fallback) => {
  const ref = req.get("referer");
  try { if (ref && new URL(ref).host === req.get("host")) return ref; } catch { /* ignore */ }
  return fallback;
};
const like = (q) => `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
const isUnique = (err) => err && err.code === "23505";

/* ---------- Shared lookups ---------- */
async function nextCode(table, prefix) {
  const row = await one(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM ${table}`);
  return prefix + "-" + String(row.n).padStart(3, "0");
}

async function locationOptions() {
  const rows = await all(`SELECT district, tehsil, town FROM branches UNION SELECT district, tehsil, town FROM makatib`);
  const uniq = (key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))].sort();
  const towns = new Set(uniq("town"));
  REPORTED_TOWNS.forEach((t) => towns.add(t.en));
  return { districts: uniq("district"), tehsils: uniq("tehsil"), towns: [...towns].sort() };
}

const staffUsers = () => all("SELECT id, name, role FROM users WHERE role IN ('admin','manager') AND status = 'active' ORDER BY name");
const branchList = () => all("SELECT id, code, name_en FROM branches WHERE status <> 'archived' ORDER BY name_en");
const maktabList = () => all(`SELECT m.id, m.code, m.name_en, m.branch_id, b.name_en AS branch FROM makatib m
                              LEFT JOIN branches b ON b.id = m.branch_id WHERE m.status <> 'archived' ORDER BY m.name_en`);

async function filesFor(type, id) {
  return all(`SELECT a.*, u.name AS uploader FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
              WHERE entity_type = ? AND entity_id = ? ORDER BY a.id DESC`, type, id);
}

/* Validates the fields branches and Makatib share; returns [values, errors] */
async function unitFields(body, extra = {}) {
  const v = {
    code: str(body.code, 20).toUpperCase(),
    name_en: str(body.name_en, 120),
    name_ur: str(body.name_ur, 120),
    district: str(body.district, 80),
    tehsil: str(body.tehsil, 80),
    town: str(body.town, 80),
    address: str(body.address, 300),
    manager_id: int(body.manager_id),
    phone: str(body.phone, 30),
    established_on: str(body.established_on, 10),
    status: ["active", "inactive"].includes(body.status) ? body.status : "active",
    notes: str(body.notes, 2000),
    ...extra,
  };
  const e = {};
  if (!CODE_RE.test(v.code)) e.code = "Use 2–20 capital letters, numbers or dashes, e.g. MK-014.";
  if (v.name_en.length < 2) e.name_en = "Enter the name in English.";
  if (v.district.length < 2) e.district = "Enter the district.";
  if (v.phone && !PHONE_RE.test(v.phone)) e.phone = "Enter a valid phone number.";
  if (v.established_on && (!DATE_RE.test(v.established_on) || isNaN(Date.parse(v.established_on)))) e.established_on = "Enter a valid date.";
  if (v.manager_id && !(await one("SELECT id FROM users WHERE id = ? AND role IN ('admin','manager')", v.manager_id))) {
    e.manager_id = "Choose a manager or admin account.";
  }
  return [v, e];
}

/* Moves a teacher or student to a Maktab (or out of one) and records the transfer */
async function movePerson(type, personId, toMaktabId, note, userId) {
  const table = type === "teacher" ? "teachers" : "students";
  const person = await one(`SELECT id, maktab_id, full_name FROM ${table} WHERE id = ?`, personId);
  if (!person) return { error: "Record not found." };
  let target = null;
  if (toMaktabId) {
    target = await one("SELECT id, branch_id, name_en, status FROM makatib WHERE id = ?", toMaktabId);
    if (!target || target.status === "archived") return { error: "Choose an active Maktab." };
  }
  if ((person.maktab_id || null) === (target ? target.id : null)) return { error: `${person.full_name} is already there.` };
  await run(`UPDATE ${table} SET maktab_id = ?, branch_id = COALESCE(?, branch_id) WHERE id = ?`,
    target ? target.id : null, target ? target.branch_id : null, person.id);
  await run(`INSERT INTO transfers (person_type, person_id, from_maktab_id, to_maktab_id, note, transferred_by)
             VALUES (?, ?, ?, ?, ?, ?)`, type, person.id, person.maktab_id, target ? target.id : null, note || null, userId);
  await log(userId, type + ".transfer", `${person.full_name} → ${target ? target.name_en : "no Maktab"}`);
  return { ok: `${person.full_name} moved to ${target ? target.name_en : "no Maktab"}.` };
}

/* ================= Branches ================= */
router.get("/branches", staff, async (req, res) => {
  const q = str(req.query.q, 80), district = str(req.query.district, 80);
  const status = [...UNIT_STATUSES, "all"].includes(req.query.status) ? req.query.status : "";
  const where = [], p = [];
  if (status && status !== "all") { where.push("b.status = ?"); p.push(status); }
  else if (!status) where.push("b.status <> 'archived'");
  if (district) { where.push("b.district = ?"); p.push(district); }
  if (q) { where.push("(b.name_en ILIKE ? OR b.name_ur ILIKE ? OR b.code ILIKE ? OR b.town ILIKE ?)"); p.push(like(q), like(q), like(q), like(q)); }
  const rows = await all(`
    SELECT b.*, u.name AS manager,
      (SELECT COUNT(*) FROM makatib m WHERE m.branch_id = b.id AND m.status <> 'archived') AS makatib,
      (SELECT COUNT(*) FROM teachers t WHERE t.branch_id = b.id AND t.status = 'active') AS teachers,
      (SELECT COUNT(*) FROM students s WHERE s.branch_id = b.id AND s.status = 'active') AS students
    FROM branches b LEFT JOIN users u ON u.id = b.manager_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY b.name_en LIMIT 500`, ...p);
  const districts = (await all("SELECT DISTINCT district FROM branches ORDER BY district")).map((r) => r.district);
  res.render("app/branches", { title: "Branches", rows, districts, filters: { q, district, status } });
});

async function branchForm(res, title, values, errors, status = 200) {
  res.status(status).render("app/branch-form", {
    title, values, errors, managers: await staffUsers(), locations: await locationOptions(),
  });
}

router.get("/branches/new", staff, async (req, res) => {
  await branchForm(res, "Add branch", { code: await nextCode("branches", "BR"), status: "active" }, {});
});

router.post("/branches", staff, async (req, res) => {
  const [v, e] = await unitFields(req.body);
  if (Object.keys(e).length) return branchForm(res, "Add branch", v, e, 400);
  try {
    const r = await one(`INSERT INTO branches (code, name_en, name_ur, district, tehsil, town, address, manager_id, phone, established_on, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      v.code, v.name_en, v.name_ur || null, v.district, v.tehsil || null, v.town || null, v.address || null,
      v.manager_id, v.phone || null, v.established_on || null, v.status, v.notes || null);
    await log(req.user.id, "branch.create", `${v.code} ${v.name_en}`);
    req.flash("ok", `Branch ${v.name_en} added.`);
    res.redirect("/app/branches/" + r.id);
  } catch (err) {
    if (isUnique(err)) return branchForm(res, "Add branch", v, { code: "This branch code is already used." }, 400);
    throw err;
  }
});

router.get("/branches/:id", staff, async (req, res, next) => {
  const b = int(req.params.id) && await one(`SELECT b.*, u.name AS manager FROM branches b LEFT JOIN users u ON u.id = b.manager_id WHERE b.id = ?`, int(req.params.id));
  if (!b) return next();
  const [makatib, teachers, students, files, stats, unassigned] = await Promise.all([
    all(`SELECT m.*, (SELECT COUNT(*) FROM students s WHERE s.maktab_id = m.id AND s.status = 'active') AS students,
         (SELECT COUNT(*) FROM teachers t WHERE t.maktab_id = m.id AND t.status = 'active') AS teachers
         FROM makatib m WHERE m.branch_id = ? ORDER BY m.status = 'archived', m.name_en`, b.id),
    all(`SELECT t.*, m.name_en AS maktab FROM teachers t LEFT JOIN makatib m ON m.id = t.maktab_id WHERE t.branch_id = ? ORDER BY t.full_name LIMIT 300`, b.id),
    all(`SELECT s.*, m.name_en AS maktab FROM students s LEFT JOIN makatib m ON m.id = s.maktab_id WHERE s.branch_id = ? ORDER BY s.full_name LIMIT 300`, b.id),
    filesFor("branch", b.id),
    one(`SELECT
      (SELECT COUNT(*) FROM makatib WHERE branch_id = ? AND status <> 'archived') AS makatib,
      (SELECT COUNT(*) FROM teachers WHERE branch_id = ? AND status = 'active') AS teachers,
      (SELECT COUNT(*) FROM students WHERE branch_id = ? AND status = 'active') AS students,
      (SELECT COUNT(*) FROM students WHERE branch_id = ? AND status = 'active' AND gender = 'male') AS male,
      (SELECT COUNT(*) FROM students WHERE branch_id = ? AND status = 'active' AND gender = 'female') AS female`, b.id, b.id, b.id, b.id, b.id),
    all(`SELECT m.id, m.code, m.name_en, b2.name_en AS branch FROM makatib m LEFT JOIN branches b2 ON b2.id = m.branch_id
         WHERE (m.branch_id IS NULL OR m.branch_id <> ?) AND m.status <> 'archived' ORDER BY m.name_en`, b.id),
  ]);
  res.render("app/branch", { title: b.name_en, b, makatib, teachers, students, files, stats, unassigned });
});

router.get("/branches/:id/edit", staff, async (req, res, next) => {
  const b = int(req.params.id) && await one("SELECT * FROM branches WHERE id = ?", int(req.params.id));
  if (!b) return next();
  await branchForm(res, "Edit " + b.name_en, { ...b, editId: b.id }, {});
});

router.post("/branches/:id", staff, async (req, res, next) => {
  const b = int(req.params.id) && await one("SELECT * FROM branches WHERE id = ?", int(req.params.id));
  if (!b) return next();
  const [v, e] = await unitFields(req.body);
  if (b.status === "archived") v.status = "archived"; // restore happens through the archive button
  if (Object.keys(e).length) return branchForm(res, "Edit " + b.name_en, { ...v, editId: b.id }, e, 400);
  try {
    await run(`UPDATE branches SET code = ?, name_en = ?, name_ur = ?, district = ?, tehsil = ?, town = ?, address = ?,
      manager_id = ?, phone = ?, established_on = ?, status = ?, notes = ? WHERE id = ?`,
      v.code, v.name_en, v.name_ur || null, v.district, v.tehsil || null, v.town || null, v.address || null,
      v.manager_id, v.phone || null, v.established_on || null, v.status, v.notes || null, b.id);
  } catch (err) {
    if (isUnique(err)) return branchForm(res, "Edit " + b.name_en, { ...v, editId: b.id }, { code: "This branch code is already used." }, 400);
    throw err;
  }
  await log(req.user.id, "branch.update", `${v.code} ${v.name_en}`);
  req.flash("ok", "Branch saved.");
  res.redirect("/app/branches/" + b.id);
});

router.post("/branches/:id/archive", admin, async (req, res, next) => {
  const b = int(req.params.id) && await one("SELECT * FROM branches WHERE id = ?", int(req.params.id));
  if (!b) return next();
  const restore = req.body.restore === "1";
  await run("UPDATE branches SET status = ? WHERE id = ?", restore ? "active" : "archived", b.id);
  await log(req.user.id, restore ? "branch.restore" : "branch.archive", `${b.code} ${b.name_en}`);
  req.flash("ok", restore ? `${b.name_en} restored.` : `${b.name_en} archived. Its Makatib, teachers and students are unchanged.`);
  res.redirect("/app/branches/" + b.id);
});

/* Assign an existing Maktab (and everyone in it) to this branch */
router.post("/branches/:id/makatib", staff, async (req, res, next) => {
  const b = int(req.params.id) && await one("SELECT * FROM branches WHERE id = ?", int(req.params.id));
  if (!b) return next();
  const m = int(req.body.maktab_id) && await one("SELECT * FROM makatib WHERE id = ?", int(req.body.maktab_id));
  if (!m) { req.flash("err", "Choose a Maktab to assign."); return res.redirect("/app/branches/" + b.id); }
  await run("UPDATE makatib SET branch_id = ? WHERE id = ?", b.id, m.id);
  await run("UPDATE teachers SET branch_id = ? WHERE maktab_id = ?", b.id, m.id);
  await run("UPDATE students SET branch_id = ? WHERE maktab_id = ?", b.id, m.id);
  await log(req.user.id, "maktab.assign_branch", `${m.name_en} → ${b.name_en}`);
  req.flash("ok", `${m.name_en} now belongs to ${b.name_en}.`);
  res.redirect("/app/branches/" + b.id);
});

/* ================= Makatib ================= */
router.get("/makatib", staff, async (req, res) => {
  const q = str(req.query.q, 80), district = str(req.query.district, 80), branch = int(req.query.branch);
  const status = [...UNIT_STATUSES, "all"].includes(req.query.status) ? req.query.status : "";
  const where = [], p = [];
  if (status && status !== "all") { where.push("m.status = ?"); p.push(status); }
  else if (!status) where.push("m.status <> 'archived'");
  if (district) { where.push("m.district = ?"); p.push(district); }
  if (branch) { where.push("m.branch_id = ?"); p.push(branch); }
  if (q) { where.push("(m.name_en ILIKE ? OR m.name_ur ILIKE ? OR m.code ILIKE ? OR m.town ILIKE ? OR m.tehsil ILIKE ?)"); p.push(like(q), like(q), like(q), like(q), like(q)); }
  const rows = await all(`
    SELECT m.*, b.name_en AS branch, t.full_name AS primary_teacher,
      (SELECT COUNT(*) FROM teachers x WHERE x.maktab_id = m.id AND x.status = 'active') AS teachers,
      (SELECT COUNT(*) FROM students s WHERE s.maktab_id = m.id AND s.status = 'active') AS students
    FROM makatib m LEFT JOIN branches b ON b.id = m.branch_id LEFT JOIN teachers t ON t.id = m.primary_teacher_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY m.name_en LIMIT 500`, ...p);
  const districts = (await all("SELECT DISTINCT district FROM makatib ORDER BY district")).map((r) => r.district);
  res.render("app/makatib", { title: "Makatib", rows, districts, branches: await branchList(), filters: { q, district, branch, status } });
});

async function maktabForm(res, title, values, errors, status = 200) {
  res.status(status).render("app/maktab-form", {
    title, values, errors, managers: await staffUsers(), branches: await branchList(), locations: await locationOptions(),
    teachers: await all(`SELECT t.id, t.code, t.full_name, m.name_en AS maktab FROM teachers t LEFT JOIN makatib m ON m.id = t.maktab_id
                         WHERE t.status = 'active' ORDER BY t.full_name`),
  });
}

async function maktabFields(body) {
  const [v, e] = await unitFields(body, {
    branch_id: int(body.branch_id),
    primary_teacher_id: int(body.primary_teacher_id),
    classrooms: str(body.classrooms, 4) === "" ? null : int(body.classrooms),
  });
  if (str(body.classrooms, 4) !== "" && (v.classrooms === null || v.classrooms > 200)) e.classrooms = "Enter a number from 0 to 200.";
  if (v.branch_id && !(await one("SELECT id FROM branches WHERE id = ?", v.branch_id))) e.branch_id = "Choose a branch.";
  if (v.primary_teacher_id && !(await one("SELECT id FROM teachers WHERE id = ?", v.primary_teacher_id))) e.primary_teacher_id = "Choose a teacher.";
  return [v, e];
}

router.get("/makatib/new", staff, async (req, res) => {
  await maktabForm(res, "Register Maktab", { code: await nextCode("makatib", "MK"), status: "active", branch_id: int(req.query.branch) }, {});
});

router.post("/makatib", staff, async (req, res) => {
  const [v, e] = await maktabFields(req.body);
  if (Object.keys(e).length) return maktabForm(res, "Register Maktab", v, e, 400);
  let r;
  try {
    r = await one(`INSERT INTO makatib (code, name_en, name_ur, district, tehsil, town, address, branch_id, manager_id, primary_teacher_id,
      phone, established_on, classrooms, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      v.code, v.name_en, v.name_ur || null, v.district, v.tehsil || null, v.town || null, v.address || null, v.branch_id,
      v.manager_id, v.primary_teacher_id, v.phone || null, v.established_on || null, v.classrooms, v.status, v.notes || null);
  } catch (err) {
    if (isUnique(err)) return maktabForm(res, "Register Maktab", v, { code: "This Maktab code is already used." }, 400);
    throw err;
  }
  await log(req.user.id, "maktab.create", `${v.code} ${v.name_en}`);
  // The primary teacher teaches here, so place them in this Maktab too
  if (v.primary_teacher_id) await movePerson("teacher", v.primary_teacher_id, r.id, "Primary teacher of new Maktab", req.user.id);
  req.flash("ok", `Maktab ${v.name_en} registered.`);
  res.redirect("/app/makatib/" + r.id);
});

router.get("/makatib/:id", staff, async (req, res, next) => {
  const id = int(req.params.id);
  const m = id && await one(`SELECT m.*, b.name_en AS branch, u.name AS manager, t.full_name AS primary_teacher
    FROM makatib m LEFT JOIN branches b ON b.id = m.branch_id LEFT JOIN users u ON u.id = m.manager_id
    LEFT JOIN teachers t ON t.id = m.primary_teacher_id WHERE m.id = ?`, id);
  if (!m) return next();
  const [teachers, students, admissions, files, transfers, otherTeachers, otherStudents, makatib] = await Promise.all([
    all("SELECT * FROM teachers WHERE maktab_id = ? ORDER BY status <> 'active', full_name", m.id),
    all("SELECT * FROM students WHERE maktab_id = ? ORDER BY status <> 'active', full_name LIMIT 500", m.id),
    all("SELECT * FROM admissions WHERE maktab_id = ? ORDER BY id DESC LIMIT 100", m.id),
    filesFor("maktab", m.id),
    all(`SELECT tr.*, COALESCE(t.full_name, s.full_name) AS person, f.name_en AS from_name, tm.name_en AS to_name, u.name AS by_name
         FROM transfers tr
         LEFT JOIN teachers t ON tr.person_type = 'teacher' AND t.id = tr.person_id
         LEFT JOIN students s ON tr.person_type = 'student' AND s.id = tr.person_id
         LEFT JOIN makatib f ON f.id = tr.from_maktab_id LEFT JOIN makatib tm ON tm.id = tr.to_maktab_id
         LEFT JOIN users u ON u.id = tr.transferred_by
         WHERE tr.from_maktab_id = ? OR tr.to_maktab_id = ? ORDER BY tr.id DESC LIMIT 30`, m.id, m.id),
    all(`SELECT t.id, t.code, t.full_name, x.name_en AS maktab FROM teachers t LEFT JOIN makatib x ON x.id = t.maktab_id
         WHERE (t.maktab_id IS NULL OR t.maktab_id <> ?) AND t.status = 'active' ORDER BY t.full_name`, m.id),
    all(`SELECT s.id, s.code, s.full_name, x.name_en AS maktab FROM students s LEFT JOIN makatib x ON x.id = s.maktab_id
         WHERE (s.maktab_id IS NULL OR s.maktab_id <> ?) AND s.status = 'active' ORDER BY s.full_name LIMIT 1000`, m.id),
    maktabList(),
  ]);
  res.render("app/maktab", {
    title: m.name_en, m, teachers, students, admissions, files, transfers, otherTeachers, otherStudents,
    makatib: makatib.filter((x) => x.id !== m.id),
  });
});

router.get("/makatib/:id/edit", staff, async (req, res, next) => {
  const m = int(req.params.id) && await one("SELECT * FROM makatib WHERE id = ?", int(req.params.id));
  if (!m) return next();
  await maktabForm(res, "Edit " + m.name_en, { ...m, editId: m.id }, {});
});

router.post("/makatib/:id", staff, async (req, res, next) => {
  const m = int(req.params.id) && await one("SELECT * FROM makatib WHERE id = ?", int(req.params.id));
  if (!m) return next();
  const [v, e] = await maktabFields(req.body);
  if (m.status === "archived") v.status = "archived";
  if (Object.keys(e).length) return maktabForm(res, "Edit " + m.name_en, { ...v, editId: m.id }, e, 400);
  try {
    await run(`UPDATE makatib SET code = ?, name_en = ?, name_ur = ?, district = ?, tehsil = ?, town = ?, address = ?, branch_id = ?,
      manager_id = ?, primary_teacher_id = ?, phone = ?, established_on = ?, classrooms = ?, status = ?, notes = ? WHERE id = ?`,
      v.code, v.name_en, v.name_ur || null, v.district, v.tehsil || null, v.town || null, v.address || null, v.branch_id,
      v.manager_id, v.primary_teacher_id, v.phone || null, v.established_on || null, v.classrooms, v.status, v.notes || null, m.id);
  } catch (err) {
    if (isUnique(err)) return maktabForm(res, "Edit " + m.name_en, { ...v, editId: m.id }, { code: "This Maktab code is already used." }, 400);
    throw err;
  }
  // Keep everyone in this Maktab under its (possibly new) branch
  if (v.branch_id !== m.branch_id) {
    await run("UPDATE teachers SET branch_id = ? WHERE maktab_id = ?", v.branch_id, m.id);
    await run("UPDATE students SET branch_id = ? WHERE maktab_id = ?", v.branch_id, m.id);
  }
  if (v.primary_teacher_id && v.primary_teacher_id !== m.primary_teacher_id) {
    const t = await one("SELECT maktab_id FROM teachers WHERE id = ?", v.primary_teacher_id);
    if (t.maktab_id !== m.id) await movePerson("teacher", v.primary_teacher_id, m.id, "Made primary teacher", req.user.id);
  }
  await log(req.user.id, "maktab.update", `${v.code} ${v.name_en}`);
  req.flash("ok", "Maktab saved.");
  res.redirect("/app/makatib/" + m.id);
});

router.post("/makatib/:id/archive", admin, async (req, res, next) => {
  const m = int(req.params.id) && await one("SELECT * FROM makatib WHERE id = ?", int(req.params.id));
  if (!m) return next();
  const restore = req.body.restore === "1";
  await run("UPDATE makatib SET status = ? WHERE id = ?", restore ? "active" : "archived", m.id);
  await log(req.user.id, restore ? "maktab.restore" : "maktab.archive", `${m.code} ${m.name_en}`);
  req.flash("ok", restore ? `${m.name_en} restored.` : `${m.name_en} archived. Its teachers and students keep their records.`);
  res.redirect("/app/makatib/" + m.id);
});

/* Assign a teacher or student to this Maktab (a transfer if they were elsewhere) */
for (const type of ["teacher", "student"]) {
  router.post(`/makatib/:id/${type}s`, staff, async (req, res, next) => {
    const m = int(req.params.id) && await one("SELECT id FROM makatib WHERE id = ?", int(req.params.id));
    if (!m) return next();
    const r = await movePerson(type, int(req.body.person_id), m.id, str(req.body.note, 300), req.user.id);
    req.flash(r.error ? "err" : "ok", r.error || r.ok);
    res.redirect(`/app/makatib/${m.id}#${type}s`);
  });

  /* Transfer from a person's row to another Maktab */
  router.post(`/${type}s/:id/transfer`, staff, async (req, res) => {
    const r = await movePerson(type, int(req.params.id), int(req.body.maktab_id), str(req.body.note, 300), req.user.id);
    req.flash(r.error ? "err" : "ok", r.error || r.ok);
    res.redirect(back(req, `/app/${type}s`));
  });
}

/* ================= Teachers & students ================= */
const PEOPLE = {
  teacher: { table: "teachers", plural: "teachers", prefix: "TC", statuses: TEACHER_STATUSES, label: "Teacher", labelPlural: "Teachers" },
  student: { table: "students", plural: "students", prefix: "ST", statuses: STUDENT_STATUSES, label: "Student", labelPlural: "Students" },
};

async function personFields(type, body) {
  const v = {
    code: str(body.code, 20).toUpperCase(),
    full_name: str(body.full_name, 120),
    name_ur: str(body.name_ur, 120),
    father_name: str(body.father_name, 120),
    gender: GENDERS[body.gender] ? body.gender : "",
    phone: str(body.phone, 30),
    maktab_id: int(body.maktab_id),
    branch_id: int(body.branch_id),
    status: PEOPLE[type].statuses.includes(body.status) ? body.status : "active",
    notes: str(body.notes, 2000),
  };
  const e = {};
  if (type === "teacher") {
    v.cnic = str(body.cnic, 15);
    v.qualification = str(body.qualification, 120);
    v.joined_on = str(body.joined_on, 10);
    if (v.cnic && !CNIC_RE.test(v.cnic)) e.cnic = "Enter the 13-digit CNIC, e.g. 45101-1234567-1.";
    if (v.joined_on && (!DATE_RE.test(v.joined_on) || isNaN(Date.parse(v.joined_on)))) e.joined_on = "Enter a valid date.";
  } else {
    v.dob = str(body.dob, 10);
    v.programme = str(body.programme, 60);
    v.enrolled_on = str(body.enrolled_on, 10);
    v.admission_id = int(body.admission_id);
    if (v.dob && (!DATE_RE.test(v.dob) || isNaN(Date.parse(v.dob)))) e.dob = "Enter a valid date.";
    if (v.enrolled_on && (!DATE_RE.test(v.enrolled_on) || isNaN(Date.parse(v.enrolled_on)))) e.enrolled_on = "Enter a valid date.";
  }
  if (!CODE_RE.test(v.code)) e.code = "Use 2–20 capital letters, numbers or dashes.";
  if (v.full_name.length < 2) e.full_name = "Enter the full name.";
  if (!v.gender) e.gender = "Choose male or female.";
  if (v.phone && !PHONE_RE.test(v.phone)) e.phone = "Enter a valid phone number.";
  if (v.maktab_id) {
    const m = await one("SELECT branch_id, status FROM makatib WHERE id = ?", v.maktab_id);
    if (!m || m.status === "archived") e.maktab_id = "Choose an active Maktab.";
    else v.branch_id = m.branch_id; // a Maktab's branch always wins
  }
  if (v.branch_id && !(await one("SELECT id FROM branches WHERE id = ?", v.branch_id))) e.branch_id = "Choose a branch.";
  return [v, e];
}

for (const [type, cfg] of Object.entries(PEOPLE)) {
  const formView = "app/person-form";
  const renderForm = async (res, title, values, errors, status = 200) => res.status(status).render(formView, {
    title, values, errors, type, cfg, branches: await branchList(), makatib: await maktabList(), PROGRAMMES,
  });

  router.get(`/${cfg.plural}`, staff, async (req, res) => {
    const q = str(req.query.q, 80), branch = int(req.query.branch), maktab = int(req.query.maktab);
    const gender = GENDERS[req.query.gender] ? req.query.gender : "";
    const status = [...cfg.statuses, "all"].includes(req.query.status) ? req.query.status : "";
    const where = [], p = [];
    if (status && status !== "all") { where.push("x.status = ?"); p.push(status); }
    if (branch) { where.push("x.branch_id = ?"); p.push(branch); }
    if (maktab) { where.push("x.maktab_id = ?"); p.push(maktab); }
    if (gender) { where.push("x.gender = ?"); p.push(gender); }
    if (q) { where.push("(x.full_name ILIKE ? OR x.name_ur ILIKE ? OR x.code ILIKE ? OR x.father_name ILIKE ? OR x.phone ILIKE ?)"); p.push(like(q), like(q), like(q), like(q), like(q)); }
    const rows = await all(`SELECT x.*, b.name_en AS branch, m.name_en AS maktab FROM ${cfg.table} x
      LEFT JOIN branches b ON b.id = x.branch_id LEFT JOIN makatib m ON m.id = x.maktab_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY x.id DESC LIMIT 500`, ...p);
    res.render("app/people", {
      title: cfg.labelPlural, rows, type, cfg, branches: await branchList(), makatib: await maktabList(),
      filters: { q, branch, maktab, gender, status },
    });
  });

  router.get(`/${cfg.plural}/new`, staff, async (req, res) => {
    const values = { code: await nextCode(cfg.table, cfg.prefix), status: "active", maktab_id: int(req.query.maktab) };
    // Registering an approved applicant: start from their admission details
    const adm = type === "student" && int(req.query.admission) && await one("SELECT * FROM admissions WHERE id = ?", int(req.query.admission));
    if (adm) Object.assign(values, {
      admission_id: adm.id, full_name: adm.student_name, father_name: adm.father_name, dob: adm.dob,
      phone: adm.phone, programme: adm.programme, maktab_id: adm.maktab_id || values.maktab_id,
      gender: adm.branch === "girls" ? "female" : adm.branch === "boys" ? "male" : "",
    });
    await renderForm(res, `Register ${cfg.label.toLowerCase()}`, values, {});
  });

  router.post(`/${cfg.plural}`, staff, async (req, res) => {
    const [v, e] = await personFields(type, req.body);
    if (Object.keys(e).length) return renderForm(res, `Register ${cfg.label.toLowerCase()}`, v, e, 400);
    let r;
    try {
      r = type === "teacher"
        ? await one(`INSERT INTO teachers (code, full_name, name_ur, father_name, gender, cnic, phone, qualification, branch_id, maktab_id, joined_on, status, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            v.code, v.full_name, v.name_ur || null, v.father_name || null, v.gender, v.cnic || null, v.phone || null, v.qualification || null,
            v.branch_id, v.maktab_id, v.joined_on || null, v.status, v.notes || null)
        : await one(`INSERT INTO students (code, full_name, name_ur, father_name, gender, dob, phone, programme, branch_id, maktab_id, admission_id, enrolled_on, status, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            v.code, v.full_name, v.name_ur || null, v.father_name || null, v.gender, v.dob || null, v.phone || null, v.programme || null,
            v.branch_id, v.maktab_id, v.admission_id, v.enrolled_on || null, v.status, v.notes || null);
    } catch (err) {
      if (isUnique(err)) {
        const field = /cnic/.test(err.constraint || err.message || "") ? "cnic" : "code";
        return renderForm(res, `Register ${cfg.label.toLowerCase()}`, v, { [field]: `This ${field === "cnic" ? "CNIC" : "code"} is already registered.` }, 400);
      }
      throw err;
    }
    await log(req.user.id, type + ".create", `${v.code} ${v.full_name}`);
    req.flash("ok", `${cfg.label} ${v.full_name} registered.`);
    res.redirect(v.maktab_id ? `/app/makatib/${v.maktab_id}#${cfg.plural}` : `/app/${cfg.plural}`);
  });

  router.get(`/${cfg.plural}/:id/edit`, staff, async (req, res, next) => {
    const x = int(req.params.id) && await one(`SELECT * FROM ${cfg.table} WHERE id = ?`, int(req.params.id));
    if (!x) return next();
    await renderForm(res, `Edit ${x.full_name}`, { ...x, editId: x.id }, {});
  });

  router.post(`/${cfg.plural}/:id`, staff, async (req, res, next) => {
    const x = int(req.params.id) && await one(`SELECT * FROM ${cfg.table} WHERE id = ?`, int(req.params.id));
    if (!x) return next();
    const [v, e] = await personFields(type, req.body);
    if (Object.keys(e).length) return renderForm(res, `Edit ${x.full_name}`, { ...v, editId: x.id }, e, 400);
    try {
      if (type === "teacher") {
        await run(`UPDATE teachers SET code = ?, full_name = ?, name_ur = ?, father_name = ?, gender = ?, cnic = ?, phone = ?, qualification = ?,
          joined_on = ?, status = ?, notes = ?, branch_id = ? WHERE id = ?`,
          v.code, v.full_name, v.name_ur || null, v.father_name || null, v.gender, v.cnic || null, v.phone || null, v.qualification || null,
          v.joined_on || null, v.status, v.notes || null, v.branch_id, x.id);
      } else {
        await run(`UPDATE students SET code = ?, full_name = ?, name_ur = ?, father_name = ?, gender = ?, dob = ?, phone = ?, programme = ?,
          enrolled_on = ?, status = ?, notes = ?, branch_id = ? WHERE id = ?`,
          v.code, v.full_name, v.name_ur || null, v.father_name || null, v.gender, v.dob || null, v.phone || null, v.programme || null,
          v.enrolled_on || null, v.status, v.notes || null, v.branch_id, x.id);
      }
    } catch (err) {
      if (isUnique(err)) {
        const field = /cnic/.test(err.constraint || err.message || "") ? "cnic" : "code";
        return renderForm(res, `Edit ${x.full_name}`, { ...v, editId: x.id }, { [field]: `This ${field === "cnic" ? "CNIC" : "code"} is already registered.` }, 400);
      }
      throw err;
    }
    // A changed Maktab is a transfer, so it goes through the transfer history
    if ((v.maktab_id || null) !== (x.maktab_id || null)) await movePerson(type, x.id, v.maktab_id, "Changed on edit form", req.user.id);
    await log(req.user.id, type + ".update", `${v.code} ${v.full_name}`);
    req.flash("ok", `${v.full_name} saved.`);
    res.redirect(`/app/${cfg.plural}`);
  });
}

/* ================= Photos & documents ================= */
for (const [route, type] of [["branches", "branch"], ["makatib", "maktab"]]) {
  // multer must parse the multipart body before the CSRF token in it can be checked
  router.post(`/${route}/:id/files`, requireRole("admin", "manager"), acceptUpload, checkCsrf, async (req, res, next) => {
    const id = int(req.params.id);
    const unit = id && await one(`SELECT id FROM ${route} WHERE id = ?`, id);
    if (!unit) { if (req.file) removeFile(req.file.filename); return next(); }
    const dest = `/app/${route}/${id}#files`;
    if (req.uploadError) { req.flash("err", req.uploadError); return res.redirect(dest); }
    await run(`INSERT INTO attachments (entity_type, entity_id, kind, file_name, stored_name, mime, size_bytes, uploaded_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      type, id, req.uploadKind, str(req.file.originalname, 200), req.file.filename, req.file.mimetype, req.file.size, req.user.id);
    await log(req.user.id, `${type}.upload_${req.uploadKind}`, `#${id} ${req.file.originalname}`);
    req.flash("ok", req.uploadKind === "photo" ? "Photo uploaded." : "Document uploaded.");
    res.redirect(dest);
  });
}

router.get("/files/:id", requireRole("admin", "manager"), async (req, res, next) => {
  const f = int(req.params.id) && await one("SELECT * FROM attachments WHERE id = ?", int(req.params.id));
  const p = f && filePath(f.stored_name);
  if (!p) return next();
  const inline = /^image\/|^application\/pdf$/.test(f.mime) && req.query.download !== "1";
  res.set("Cache-Control", "private, max-age=3600");
  res.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.file_name)}`);
  res.type(f.mime).sendFile(p, (err) => { if (err && !res.headersSent) next(); });
});

router.post("/files/:id/delete", staff, async (req, res, next) => {
  const f = int(req.params.id) && await one("SELECT * FROM attachments WHERE id = ?", int(req.params.id));
  if (!f) return next();
  await run("DELETE FROM attachments WHERE id = ?", f.id);
  removeFile(f.stored_name);
  await log(req.user.id, `${f.entity_type}.delete_file`, f.file_name);
  req.flash("ok", "File removed.");
  res.redirect(back(req, "/app"));
});

module.exports = router;
