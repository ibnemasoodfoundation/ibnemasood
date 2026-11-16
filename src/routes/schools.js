/* Schools: each belongs to a branch and is run by a School Principal.
   Admins add and archive schools; a Branch Manager adds and edits schools in their branches;
   a principal sees and edits the details of their own school (not its branch or principal). */
"use strict";
const express = require("express");
const { one, all, run, log } = require("../db");
const { checkCsrf, requireRole, STAFF_ROLES } = require("../auth");
const { withScope, schoolSql, inSchool, inBranch } = require("../scope");
const { UNIT_STATUSES, GENDERS } = require("../helpers");
const { helpers: h } = require("./institution");

const router = express.Router();
const staff = [requireRole(...STAFF_ROLES), withScope, checkCsrf];
const admin = [requireRole("admin"), withScope, checkCsrf];
const { str, int, like, isUnique, PHONE_RE, DATE_RE, CODE_RE, forbidden } = h;

const principals = () => all("SELECT id, name, email FROM users WHERE role = 'principal' AND status = 'active' ORDER BY name");
const canAdd = (scope) => scope.all || scope.branchIds.length > 0;
// Only admins and the branch's manager may move a school or change its principal
const canAssign = (scope, branchId) => scope.all || inBranch(scope, branchId);

async function loadSchool(req) {
  const id = int(req.params.id);
  const sc = id && await one(`SELECT sc.*, b.name_en AS branch, u.name AS principal, u.email AS principal_email
    FROM schools sc LEFT JOIN branches b ON b.id = sc.branch_id LEFT JOIN users u ON u.id = sc.principal_id WHERE sc.id = ?`, id);
  if (!sc) return { missing: true };
  if (!inSchool(req.scope, sc.id)) return { denied: true };
  return { sc };
}

async function schoolFields(req, current) {
  const b = req.body;
  const v = {
    code: str(b.code, 20).toUpperCase(), name_en: str(b.name_en, 120), name_ur: str(b.name_ur, 120),
    branch_id: int(b.branch_id), principal_id: int(b.principal_id), district: str(b.district, 80), town: str(b.town, 80),
    address: str(b.address, 300), phone: str(b.phone, 30), levels: str(b.levels, 200), established_on: str(b.established_on, 10),
    status: ["active", "inactive"].includes(b.status) ? b.status : "active", notes: str(b.notes, 2000),
  };
  // A principal keeps the school's branch and principal as they are
  if (current && !canAssign(req.scope, current.branch_id)) { v.branch_id = current.branch_id; v.principal_id = current.principal_id; }
  const e = {};
  if (!CODE_RE.test(v.code)) e.code = "Use 2–20 capital letters, numbers or dashes, e.g. SC-001.";
  if (v.name_en.length < 2) e.name_en = "Enter the school name in English.";
  if (v.district.length < 2) e.district = "Enter the district.";
  if (v.phone && !PHONE_RE.test(v.phone)) e.phone = "Enter a valid phone number.";
  if (v.established_on && (!DATE_RE.test(v.established_on) || isNaN(Date.parse(v.established_on)))) e.established_on = "Enter a valid date.";
  if (v.branch_id && !(await one("SELECT id FROM branches WHERE id = ? AND status <> 'archived'", v.branch_id))) e.branch_id = "Choose a branch.";
  if ((!current || canAssign(req.scope, current.branch_id)) && !req.scope.all && !inBranch(req.scope, v.branch_id)) e.branch_id = "Choose one of the branches you manage.";
  if (v.principal_id && !(await one("SELECT id FROM users WHERE id = ? AND role = 'principal'", v.principal_id))) e.principal_id = "Choose a School Principal account.";
  return [v, e];
}

async function schoolForm(req, res, title, values, errors, status = 200) {
  res.status(status).render("app/school-form", {
    title, values, errors, principals: await principals(),
    branches: req.scope.all ? await h.branchList(req.scope)
      : await all(`SELECT id, code, name_en FROM branches WHERE status <> 'archived' AND id IN (${req.scope.branchIds.join(",") || "NULL"}) ORDER BY name_en`),
    canAssign: !values.editId || canAssign(req.scope, values.branch_id),
  });
}

router.get("/schools", staff, async (req, res) => {
  const q = str(req.query.q, 80), branch = int(req.query.branch);
  const status = [...UNIT_STATUSES, "all"].includes(req.query.status) ? req.query.status : "";
  const where = [schoolSql(req.scope, "sc")], p = [];
  if (status && status !== "all") { where.push("sc.status = ?"); p.push(status); }
  else if (!status) where.push("sc.status <> 'archived'");
  if (branch) { where.push("sc.branch_id = ?"); p.push(branch); }
  if (q) { where.push("(sc.name_en ILIKE ? OR sc.name_ur ILIKE ? OR sc.code ILIKE ? OR sc.town ILIKE ?)"); p.push(like(q), like(q), like(q), like(q)); }
  const rows = await all(`SELECT sc.*, b.name_en AS branch, u.name AS principal,
      (SELECT COUNT(*) FROM teachers t WHERE t.school_id = sc.id AND t.status = 'active') AS teachers,
      (SELECT COUNT(*) FROM students s WHERE s.school_id = sc.id AND s.status = 'active') AS students
    FROM schools sc LEFT JOIN branches b ON b.id = sc.branch_id LEFT JOIN users u ON u.id = sc.principal_id
    WHERE ${where.join(" AND ")} ORDER BY sc.name_en LIMIT 500`, ...p);
  res.render("app/schools", { title: "Schools", rows, branches: await h.branchList(req.scope), filters: { q, branch, status }, canAdd: canAdd(req.scope) });
});

router.get("/schools/new", staff, async (req, res) => {
  if (!canAdd(req.scope)) return forbidden(res);
  await schoolForm(req, res, "Add school", { code: await h.nextCode("schools", "SC"), status: "active", branch_id: int(req.query.branch) }, {});
});

router.post("/schools", staff, async (req, res) => {
  if (!canAdd(req.scope)) return forbidden(res);
  const [v, e] = await schoolFields(req, null);
  if (Object.keys(e).length) return schoolForm(req, res, "Add school", v, e, 400);
  let r;
  try {
    r = await one(`INSERT INTO schools (code, name_en, name_ur, branch_id, principal_id, district, town, address, phone, levels, established_on, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      v.code, v.name_en, v.name_ur || null, v.branch_id, v.principal_id, v.district, v.town || null, v.address || null,
      v.phone || null, v.levels || null, v.established_on || null, v.status, v.notes || null);
  } catch (err) {
    if (isUnique(err)) return schoolForm(req, res, "Add school", v, { code: "This school code is already used." }, 400);
    throw err;
  }
  await log(req.user.id, "school.create", `${v.code} ${v.name_en}`);
  req.flash("ok", `School ${v.name_en} added.`);
  res.redirect("/app/schools/" + r.id);
});

router.get("/schools/:id", staff, async (req, res, next) => {
  const { sc, missing, denied } = await loadSchool(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const [teachers, students, exams] = await Promise.all([
    all("SELECT id, code, full_name, gender, phone, designation, status FROM teachers WHERE school_id = ? ORDER BY status <> 'active', full_name", sc.id),
    all("SELECT id, code, full_name, gender, class_name, father_name, status FROM students WHERE school_id = ? ORDER BY status <> 'active', class_name NULLS LAST, full_name", sc.id),
    all("SELECT id, title, exam_type, status, held_on FROM exams WHERE school_id = ? ORDER BY id DESC LIMIT 10", sc.id),
  ]);
  const classes = Object.entries(students.filter((s) => s.status === "active")
    .reduce((acc, s) => { const k = s.class_name || "No class"; acc[k] = (acc[k] || 0) + 1; return acc; }, {}));
  res.render("app/school", { title: sc.name_en, sc, teachers, students, exams, classes, GENDERS, canEdit: true, canArchive: req.scope.all });
});

router.get("/schools/:id/edit", staff, async (req, res, next) => {
  const { sc, missing, denied } = await loadSchool(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  await schoolForm(req, res, "Edit " + sc.name_en, { ...sc, editId: sc.id }, {});
});

router.post("/schools/:id", staff, async (req, res, next) => {
  const { sc, missing, denied } = await loadSchool(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const [v, e] = await schoolFields(req, sc);
  if (sc.status === "archived") v.status = "archived";
  if (Object.keys(e).length) return schoolForm(req, res, "Edit " + sc.name_en, { ...v, editId: sc.id }, e, 400);
  try {
    await run(`UPDATE schools SET code = ?, name_en = ?, name_ur = ?, branch_id = ?, principal_id = ?, district = ?, town = ?, address = ?,
      phone = ?, levels = ?, established_on = ?, status = ?, notes = ? WHERE id = ?`,
      v.code, v.name_en, v.name_ur || null, v.branch_id, v.principal_id, v.district, v.town || null, v.address || null,
      v.phone || null, v.levels || null, v.established_on || null, v.status, v.notes || null, sc.id);
  } catch (err) {
    if (isUnique(err)) return schoolForm(req, res, "Edit " + sc.name_en, { ...v, editId: sc.id }, { code: "This school code is already used." }, 400);
    throw err;
  }
  // Keep everyone in this school under its (possibly new) branch
  if (v.branch_id !== sc.branch_id) {
    await run("UPDATE teachers SET branch_id = ? WHERE school_id = ?", v.branch_id, sc.id);
    await run("UPDATE students SET branch_id = ? WHERE school_id = ?", v.branch_id, sc.id);
  }
  await log(req.user.id, "school.update", `${v.code} ${v.name_en}`);
  req.flash("ok", "School saved.");
  res.redirect("/app/schools/" + sc.id);
});

router.post("/schools/:id/archive", admin, async (req, res, next) => {
  const sc = int(req.params.id) && await one("SELECT * FROM schools WHERE id = ?", int(req.params.id));
  if (!sc) return next();
  const restore = req.body.restore === "1";
  await run("UPDATE schools SET status = ? WHERE id = ?", restore ? "active" : "archived", sc.id);
  await log(req.user.id, restore ? "school.restore" : "school.archive", `${sc.code} ${sc.name_en}`);
  req.flash("ok", restore ? `${sc.name_en} restored.` : `${sc.name_en} archived. Its teachers and students keep their records.`);
  res.redirect("/app/schools/" + sc.id);
});

module.exports = router;
