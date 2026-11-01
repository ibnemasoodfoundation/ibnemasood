/* Branches, Makatib, and photo/document files for every record type.
   Every route checks the signed-in user's scope (src/scope.js) on the server. */
"use strict";
const express = require("express");
const { one, all, run, log } = require("../db");
const { checkCsrf, requireRole } = require("../auth");
const { acceptUpload, filePath, removeFile } = require("../uploads");
const { withScope, branchSql, maktabSql, personSql, inMaktab, inBranch, canSeePerson, canSeeBranch } = require("../scope");
const { movePerson } = require("../transfers");
const { REPORTED_TOWNS, UNIT_STATUSES, DOC_CATEGORIES } = require("../helpers");

const router = express.Router();

// Guards are applied per route: this router is mounted on /app ahead of the member routes,
// so a router-wide guard would lock members out of their own dashboard.
const staff = [requireRole("admin", "manager"), withScope, checkCsrf];
const admin = [requireRole("admin"), withScope, checkCsrf];

const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const int = (v) => (/^\d{1,9}$/.test(String(v ?? "").trim()) ? Number(v) : null);
const PHONE_RE = /^[+\d][\d\s-]{6,19}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const like = (q) => `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
const isUnique = (err) => err && err.code === "23505";
const forbidden = (res) => res.status(403).render("error", { title: "Not allowed", message: "This record is outside the branches you manage." });

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
const branchList = (scope) => all(`SELECT b.id, b.code, b.name_en FROM branches b WHERE b.status <> 'archived' AND ${branchSql(scope, "b")} ORDER BY b.name_en`);
const maktabList = (scope) => all(`SELECT m.id, m.code, m.name_en, m.branch_id, b.name_en AS branch FROM makatib m
  LEFT JOIN branches b ON b.id = m.branch_id WHERE m.status <> 'archived' AND ${maktabSql(scope, "m")} ORDER BY m.name_en`);

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
    programmes: str(body.programmes, 300),
    public_listing: body.public_listing === "1",
    show_phone: body.show_phone === "1",
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

/* ================= Branches ================= */
router.get("/branches", staff, async (req, res) => {
  const q = str(req.query.q, 80), district = str(req.query.district, 80);
  const status = [...UNIT_STATUSES, "all"].includes(req.query.status) ? req.query.status : "";
  const where = [branchSql(req.scope, "b")], p = [];
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
    WHERE ${where.join(" AND ")} ORDER BY b.name_en LIMIT 500`, ...p);
  const districts = (await all(`SELECT DISTINCT b.district FROM branches b WHERE ${branchSql(req.scope, "b")} ORDER BY 1`)).map((r) => r.district);
  res.render("app/branches", { title: "Branches", rows, districts, filters: { q, district, status } });
});

async function branchForm(res, title, values, errors, status = 200) {
  res.status(status).render("app/branch-form", {
    title, values, errors, managers: await staffUsers(), locations: await locationOptions(),
  });
}

async function loadBranch(req) {
  const id = int(req.params.id);
  const b = id && await one(`SELECT b.*, u.name AS manager FROM branches b LEFT JOIN users u ON u.id = b.manager_id WHERE b.id = ?`, id);
  if (!b) return { missing: true };
  if (!(await canSeeBranch(req.scope, b.id))) return { denied: true };
  // Managers edit only branches they manage; a Maktab manager can view the branch but not change it
  return { b, canEdit: req.scope.all || inBranch(req.scope, b.id) };
}

router.get("/branches/new", admin, async (req, res) => {
  await branchForm(res, "Add branch", { code: await nextCode("branches", "BR"), status: "active", public_listing: true }, {});
});

router.post("/branches", admin, async (req, res) => {
  const [v, e] = await unitFields(req.body);
  if (Object.keys(e).length) return branchForm(res, "Add branch", v, e, 400);
  try {
    const r = await one(`INSERT INTO branches (code, name_en, name_ur, district, tehsil, town, address, manager_id, phone, established_on, status, notes,
      programmes, public_listing, show_phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      v.code, v.name_en, v.name_ur || null, v.district, v.tehsil || null, v.town || null, v.address || null,
      v.manager_id, v.phone || null, v.established_on || null, v.status, v.notes || null, v.programmes || null, v.public_listing, v.show_phone);
    await log(req.user.id, "branch.create", `${v.code} ${v.name_en}`);
    req.flash("ok", `Branch ${v.name_en} added.`);
    res.redirect("/app/branches/" + r.id);
  } catch (err) {
    if (isUnique(err)) return branchForm(res, "Add branch", v, { code: "This branch code is already used." }, 400);
    throw err;
  }
});

router.get("/branches/:id", staff, async (req, res, next) => {
  const { b, canEdit, missing, denied } = await loadBranch(req);
  if (missing) return next();
  if (denied) return forbidden(res);
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
    // Managers may only pull in Makatib they already manage or that have no branch yet
    all(`SELECT m.id, m.code, m.name_en, b2.name_en AS branch FROM makatib m LEFT JOIN branches b2 ON b2.id = m.branch_id
         WHERE (m.branch_id IS NULL OR m.branch_id <> ?) AND m.status <> 'archived'
           AND (${maktabSql(req.scope, "m")} OR m.branch_id IS NULL) ORDER BY m.name_en`, b.id),
  ]);
  res.render("app/branch", { title: b.name_en, b, makatib, teachers, students, files, stats, unassigned: canEdit ? unassigned : [], canEdit });
});

router.get("/branches/:id/edit", staff, async (req, res, next) => {
  const { b, canEdit, missing, denied } = await loadBranch(req);
  if (missing) return next();
  if (denied || !canEdit) return forbidden(res);
  await branchForm(res, "Edit " + b.name_en, { ...b, editId: b.id }, {});
});

router.post("/branches/:id", staff, async (req, res, next) => {
  const { b, canEdit, missing, denied } = await loadBranch(req);
  if (missing) return next();
  if (denied || !canEdit) return forbidden(res);
  const [v, e] = await unitFields(req.body);
  if (b.status === "archived") v.status = "archived"; // restore happens through the archive button
  if (Object.keys(e).length) return branchForm(res, "Edit " + b.name_en, { ...v, editId: b.id }, e, 400);
  try {
    await run(`UPDATE branches SET code = ?, name_en = ?, name_ur = ?, district = ?, tehsil = ?, town = ?, address = ?,
      manager_id = ?, phone = ?, established_on = ?, status = ?, notes = ?, programmes = ?, public_listing = ?, show_phone = ? WHERE id = ?`,
      v.code, v.name_en, v.name_ur || null, v.district, v.tehsil || null, v.town || null, v.address || null,
      v.manager_id, v.phone || null, v.established_on || null, v.status, v.notes || null, v.programmes || null, v.public_listing, v.show_phone, b.id);
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
  const { b, canEdit, missing, denied } = await loadBranch(req);
  if (missing) return next();
  if (denied || !canEdit) return forbidden(res);
  const m = int(req.body.maktab_id) && await one("SELECT * FROM makatib WHERE id = ?", int(req.body.maktab_id));
  if (!m) { req.flash("err", "Choose a Maktab to assign."); return res.redirect("/app/branches/" + b.id); }
  if (m.branch_id && !inMaktab(req.scope, m.id)) return forbidden(res);
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
  const where = [maktabSql(req.scope, "m")], p = [];
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
    WHERE ${where.join(" AND ")} ORDER BY m.name_en LIMIT 500`, ...p);
  const districts = (await all(`SELECT DISTINCT m.district FROM makatib m WHERE ${maktabSql(req.scope, "m")} ORDER BY 1`)).map((r) => r.district);
  res.render("app/makatib", { title: "Makatib", rows, districts, branches: await branchList(req.scope), filters: { q, district, branch, status } });
});

async function maktabForm(req, res, title, values, errors, status = 200) {
  res.status(status).render("app/maktab-form", {
    title, values, errors, managers: await staffUsers(), locations: await locationOptions(),
    // Managers can only place a Maktab in a branch they manage
    branches: req.scope.all ? await branchList(req.scope)
      : await all(`SELECT id, code, name_en FROM branches WHERE status <> 'archived' AND id IN (${req.scope.branchIds.join(",") || "NULL"}) ORDER BY name_en`),
    teachers: await all(`SELECT t.id, t.code, t.full_name, m.name_en AS maktab FROM teachers t LEFT JOIN makatib m ON m.id = t.maktab_id
                         WHERE t.status = 'active' AND ${personSql(req.scope, "t", "teacher")} ORDER BY t.full_name`),
  });
}

async function maktabFields(req) {
  const body = req.body;
  const [v, e] = await unitFields(body, {
    branch_id: int(body.branch_id),
    primary_teacher_id: int(body.primary_teacher_id),
    classrooms: str(body.classrooms, 4) === "" ? null : int(body.classrooms),
  });
  if (str(body.classrooms, 4) !== "" && (v.classrooms === null || v.classrooms > 200)) e.classrooms = "Enter a number from 0 to 200.";
  if (v.branch_id && !(await one("SELECT id FROM branches WHERE id = ?", v.branch_id))) e.branch_id = "Choose a branch.";
  if (!req.scope.all && !inBranch(req.scope, v.branch_id)) e.branch_id = "Choose one of the branches you manage.";
  if (v.primary_teacher_id) {
    const t = await one("SELECT id, maktab_id, branch_id FROM teachers WHERE id = ?", v.primary_teacher_id);
    if (!t || !canSeePerson(req.scope, t, "teacher")) e.primary_teacher_id = "Choose a teacher.";
  }
  return [v, e];
}

async function loadMaktab(req) {
  const id = int(req.params.id);
  const m = id && await one(`SELECT m.*, b.name_en AS branch, u.name AS manager, t.full_name AS primary_teacher
    FROM makatib m LEFT JOIN branches b ON b.id = m.branch_id LEFT JOIN users u ON u.id = m.manager_id
    LEFT JOIN teachers t ON t.id = m.primary_teacher_id WHERE m.id = ?`, id);
  if (!m) return { missing: true };
  if (!inMaktab(req.scope, m.id)) return { denied: true };
  return { m };
}

router.get("/makatib/new", staff, async (req, res) => {
  if (!req.scope.all && !req.scope.branchIds.length) return forbidden(res);
  await maktabForm(req, res, "Register Maktab", { code: await nextCode("makatib", "MK"), status: "active", public_listing: true, branch_id: int(req.query.branch) }, {});
});

router.post("/makatib", staff, async (req, res) => {
  if (!req.scope.all && !req.scope.branchIds.length) return forbidden(res);
  const [v, e] = await maktabFields(req);
  if (Object.keys(e).length) return maktabForm(req, res, "Register Maktab", v, e, 400);
  let r;
  try {
    r = await one(`INSERT INTO makatib (code, name_en, name_ur, district, tehsil, town, address, branch_id, manager_id, primary_teacher_id,
      phone, established_on, classrooms, status, notes, programmes, public_listing, show_phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      v.code, v.name_en, v.name_ur || null, v.district, v.tehsil || null, v.town || null, v.address || null, v.branch_id,
      v.manager_id, v.primary_teacher_id, v.phone || null, v.established_on || null, v.classrooms, v.status, v.notes || null,
      v.programmes || null, v.public_listing, v.show_phone);
  } catch (err) {
    if (isUnique(err)) return maktabForm(req, res, "Register Maktab", v, { code: "This Maktab code is already used." }, 400);
    throw err;
  }
  await log(req.user.id, "maktab.create", `${v.code} ${v.name_en}`);
  // The primary teacher teaches here, so place them in this Maktab too
  if (v.primary_teacher_id) await movePerson("teacher", v.primary_teacher_id, r.id, "Primary teacher of new Maktab", req.user.id);
  req.flash("ok", `Maktab ${v.name_en} registered.`);
  res.redirect("/app/makatib/" + r.id);
});

router.get("/makatib/:id", staff, async (req, res, next) => {
  const { m, missing, denied } = await loadMaktab(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const [teachers, students, admissions, files, transfers, otherTeachers, otherStudents, makatib, att] = await Promise.all([
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
         WHERE (t.maktab_id IS NULL OR t.maktab_id <> ?) AND t.status = 'active' AND ${personSql(req.scope, "t", "teacher")} ORDER BY t.full_name`, m.id),
    all(`SELECT s.id, s.code, s.full_name, x.name_en AS maktab FROM students s LEFT JOIN makatib x ON x.id = s.maktab_id
         WHERE (s.maktab_id IS NULL OR s.maktab_id <> ?) AND s.status = 'active' AND ${personSql(req.scope, "s", "student")} ORDER BY s.full_name LIMIT 1000`, m.id),
    maktabList(req.scope),
    // Attendance in the last 30 days
    one(`SELECT COUNT(*) FILTER (WHERE status IN ('present','late')) AS attended,
                COUNT(*) FILTER (WHERE status = 'absent') AS absent,
                COUNT(DISTINCT att_date) AS days
         FROM student_attendance WHERE maktab_id = ? AND att_date >= CURRENT_DATE - 30`, m.id),
  ]);
  res.render("app/maktab", {
    title: m.name_en, m, teachers, students, admissions, files, transfers, otherTeachers, otherStudents, att,
    makatib: makatib.filter((x) => x.id !== m.id),
  });
});

router.get("/makatib/:id/edit", staff, async (req, res, next) => {
  const { m, missing, denied } = await loadMaktab(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  await maktabForm(req, res, "Edit " + m.name_en, { ...m, editId: m.id }, {});
});

router.post("/makatib/:id", staff, async (req, res, next) => {
  const { m, missing, denied } = await loadMaktab(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const [v, e] = await maktabFields(req);
  if (m.status === "archived") v.status = "archived";
  // A manager who only manages this Maktab (not its branch) keeps its current branch
  if (!req.scope.all && !inBranch(req.scope, v.branch_id) && v.branch_id === m.branch_id) delete e.branch_id;
  if (Object.keys(e).length) return maktabForm(req, res, "Edit " + m.name_en, { ...v, editId: m.id }, e, 400);
  try {
    await run(`UPDATE makatib SET code = ?, name_en = ?, name_ur = ?, district = ?, tehsil = ?, town = ?, address = ?, branch_id = ?,
      manager_id = ?, primary_teacher_id = ?, phone = ?, established_on = ?, classrooms = ?, status = ?, notes = ?,
      programmes = ?, public_listing = ?, show_phone = ? WHERE id = ?`,
      v.code, v.name_en, v.name_ur || null, v.district, v.tehsil || null, v.town || null, v.address || null, v.branch_id,
      v.manager_id, v.primary_teacher_id, v.phone || null, v.established_on || null, v.classrooms, v.status, v.notes || null,
      v.programmes || null, v.public_listing, v.show_phone, m.id);
  } catch (err) {
    if (isUnique(err)) return maktabForm(req, res, "Edit " + m.name_en, { ...v, editId: m.id }, { code: "This Maktab code is already used." }, 400);
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
    const { m, missing, denied } = await loadMaktab(req);
    if (missing) return next();
    if (denied) return forbidden(res);
    const table = type === "teacher" ? "teachers" : "students";
    const person = int(req.body.person_id) && await one(`SELECT id, maktab_id, branch_id, teacher_id FROM ${table} WHERE id = ?`, int(req.body.person_id));
    if (!person || !canSeePerson(req.scope, person, type)) return forbidden(res);
    const r = await movePerson(type, person.id, m.id, str(req.body.note, 300), req.user.id);
    req.flash(r.error ? "err" : "ok", r.error || r.ok);
    res.redirect(`/app/makatib/${m.id}#${type}s`);
  });
}

/* ================= Photos & documents (branches, Makatib, teachers, students) ================= */
const ENTITIES = {
  branches: { type: "branch", table: "branches" },
  makatib: { type: "maktab", table: "makatib" },
  teachers: { type: "teacher", table: "teachers" },
  students: { type: "student", table: "students" },
};

/* Can this user see (or, with manage = true, change) the record a file belongs to? */
async function canAccessEntity(req, type, id, manage) {
  if (manage && !req.scope.canManage) return false;
  if (type === "branch") return canSeeBranch(req.scope, id);
  if (type === "maktab") return inMaktab(req.scope, id);
  const rec = await one(`SELECT id, maktab_id, branch_id${type === "student" ? ", teacher_id" : ""} FROM ${type}s WHERE id = ?`, id);
  return canSeePerson(req.scope, rec, type);
}

for (const [route, cfg] of Object.entries(ENTITIES)) {
  // multer must parse the multipart body before the CSRF token in it can be checked
  router.post(`/${route}/:id/files`, requireRole("admin", "manager"), withScope, acceptUpload, checkCsrf, async (req, res, next) => {
    const id = int(req.params.id);
    const exists = id && await one(`SELECT id FROM ${cfg.table} WHERE id = ?`, id);
    const fail = (status, msg) => {
      if (req.file) removeFile(req.file.filename);
      if (req.get("x-requested-with") === "fetch") return res.status(status).json({ ok: false, error: msg });
      if (status === 404) return next();
      if (status === 403) return forbidden(res);
      req.flash("err", msg);
      return res.redirect(`/app/${route}/${id}#files`);
    };
    if (!exists) return fail(404, "Not found.");
    if (!(await canAccessEntity(req, cfg.type, id, true))) return fail(403, "Not allowed.");
    if (req.uploadError) return fail(400, req.uploadError);
    const categories = DOC_CATEGORIES[cfg.type] || {};
    const category = req.uploadKind === "document" && categories[req.body.category] ? req.body.category : null;
    const r = await one(`INSERT INTO attachments (entity_type, entity_id, kind, category, file_name, stored_name, mime, size_bytes, uploaded_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      cfg.type, id, req.uploadKind, category, str(req.file.originalname, 200), req.file.filename, req.file.mimetype, req.file.size, req.user.id);
    // A teacher or student has one profile photo: a new upload replaces the old one
    if (req.uploadKind === "photo" && (cfg.type === "teacher" || cfg.type === "student")) {
      const old = await all("SELECT id, stored_name FROM attachments WHERE entity_type = ? AND entity_id = ? AND kind = 'photo' AND id <> ?", cfg.type, id, r.id);
      for (const o of old) { await run("DELETE FROM attachments WHERE id = ?", o.id); removeFile(o.stored_name); }
    }
    await log(req.user.id, `${cfg.type}.upload_${req.uploadKind}`, `#${id} ${req.file.originalname}`);
    if (req.get("x-requested-with") === "fetch") return res.json({ ok: true, id: r.id, url: `/app/files/${r.id}` });
    req.flash("ok", req.uploadKind === "photo" ? "Photo uploaded." : "Document uploaded.");
    res.redirect(`/app/${route}/${id}#files`);
  });
}

router.get("/files/:id", requireRole("admin", "manager", "teacher"), withScope, async (req, res, next) => {
  const f = int(req.params.id) && await one("SELECT * FROM attachments WHERE id = ?", int(req.params.id));
  const p = f && filePath(f.stored_name);
  if (!p) return next();
  if (!(await canAccessEntity(req, f.entity_type, f.entity_id, false))) return forbidden(res);
  const inline = /^image\/|^application\/pdf$/.test(f.mime) && req.query.download !== "1";
  res.set("Cache-Control", "private, max-age=3600");
  res.set("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.file_name)}`);
  res.type(f.mime).sendFile(p, (err) => { if (err && !res.headersSent) next(); });
});

/* Approve (or withdraw) a branch / Maktab photo for the public website, with a caption */
router.post("/files/:id/public", staff, async (req, res, next) => {
  const f = int(req.params.id) && await one("SELECT * FROM attachments WHERE id = ?", int(req.params.id));
  if (!f) return next();
  if (!(await canAccessEntity(req, f.entity_type, f.entity_id, true))) return forbidden(res);
  const publish = req.body.is_public === "1";
  if (publish && !(f.kind === "photo" && (f.entity_type === "branch" || f.entity_type === "maktab"))) {
    req.flash("err", "Only branch and Maktab photographs can appear on the website.");
  } else {
    await run("UPDATE attachments SET is_public = ?, caption = ? WHERE id = ?", publish, str(req.body.caption, 160) || null, f.id);
    await log(req.user.id, publish ? "file.publish" : "file.unpublish", f.file_name);
    req.flash("ok", publish ? "Photo will show on the public website." : "Photo removed from the public website.");
  }
  const back = req.get("referer");
  res.redirect(back && new URL(back).host === req.get("host") ? back : "/app");
});

router.post("/files/:id/delete", staff, async (req, res, next) => {
  const f = int(req.params.id) && await one("SELECT * FROM attachments WHERE id = ?", int(req.params.id));
  if (!f) return next();
  if (!(await canAccessEntity(req, f.entity_type, f.entity_id, true))) return forbidden(res);
  await run("DELETE FROM attachments WHERE id = ?", f.id);
  removeFile(f.stored_name);
  await log(req.user.id, `${f.entity_type}.delete_file`, f.file_name);
  req.flash("ok", f.kind === "photo" ? "Photo removed." : "File removed.");
  const back = req.get("referer");
  res.redirect(back && new URL(back).host === req.get("host") ? back : "/app");
});

module.exports = router;
module.exports.helpers = { nextCode, branchList, maktabList, filesFor, forbidden, str, int, like, isUnique, PHONE_RE, DATE_RE, CODE_RE };
