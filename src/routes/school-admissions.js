/* Iqra Islamia Public School: student registration laid out exactly like the printed admission form.
   For the School Principal (their school), the branch manager and Super Admin. Saving creates the student in
   the school, keeps every admission-form detail, and leads straight to printing the filled admission form. */
"use strict";
const express = require("express");
const { one, all, log } = require("../db");
const { checkCsrf, requireRole, STAFF_ROLES } = require("../auth");
const { withScope, schoolSql, inSchool } = require("../scope");
const { STUDENT_EXTRA, todayPk } = require("../helpers");
const { helpers: h } = require("./institution");
const { linkParent } = require("./people");

const router = express.Router();
const staff = [requireRole(...STAFF_ROLES), withScope, checkCsrf];
const { str, int, isUnique, PHONE_RE, DATE_RE, forbidden } = h;
const CNIC_RE = /^\d{5}-?\d{7}-?\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const validDate = (d) => DATE_RE.test(d) && !isNaN(Date.parse(d));

/* "Register student" in the principal's menu: straight to their school's form */
router.get("/school/register", staff, async (req, res) => {
  const schools = await all(`SELECT sc.id FROM schools sc WHERE sc.status = 'active' AND ${schoolSql(req.scope, "sc")} ORDER BY sc.name_en`);
  if (schools.length === 1) return res.redirect(`/app/schools/${schools[0].id}/register`);
  req.flash(schools.length ? "ok" : "err", schools.length ? "Choose the school, then Register student." : "No school is assigned to you yet. Ask an admin to set you as the school's principal.");
  res.redirect("/app/schools");
});

async function loadSchool(req) {
  const id = int(req.params.id);
  const sc = id && await one("SELECT * FROM schools WHERE id = ?", id);
  if (!sc) return { missing: true };
  if (!inSchool(req.scope, sc.id)) return { denied: true };
  return { sc };
}

function render(res, sc, values, errors, status = 200) {
  res.status(status).render("app/school-register", { title: "Register student: " + sc.name_en, sc, values, errors, STUDENT_EXTRA });
}

router.get("/schools/:id/register", staff, async (req, res, next) => {
  const { sc, missing, denied } = await loadSchool(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  render(res, sc, { enrolled_on: todayPk(), x: { religion: "Islam", nationality: "Pakistani", district: sc.district || "" } }, {});
});

router.post("/schools/:id/register", staff, async (req, res, next) => {
  const { sc, missing, denied } = await loadSchool(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const b = req.body;
  const v = {
    full_name: str(b.full_name, 120), father_name: str(b.father_name, 120), gender: ["male", "female"].includes(b.gender) ? b.gender : "",
    cnic_bform: str(b.cnic_bform, 20), dob: str(b.dob, 10), address: str(b.address, 300), phone: str(b.phone, 30),
    guardian_phone: str(b.guardian_phone, 30), previous_institution: str(b.previous_institution, 120),
    enrolled_on: str(b.enrolled_on, 10), class_name: str(b.class_name, 60),
    parent_email: str(b.parent_email, 120).toLowerCase(), parent_password: String(b.parent_password ?? "").slice(0, 200),
    x: {},
  };
  for (const [k] of STUDENT_EXTRA) { const val = str(b["x_" + k], 120); if (val) v.x[k] = val; }
  const e = {};
  if (v.full_name.length < 2) e.full_name = "Enter the student's name.";
  if (!v.gender) e.gender = "Choose male or female.";
  if (v.cnic_bform && !CNIC_RE.test(v.cnic_bform)) e.cnic_bform = "Enter the 13-digit number, e.g. 45101-1234567-1.";
  if (v.dob && (!validDate(v.dob) || v.dob > todayPk())) e.dob = "Enter a valid date of birth.";
  if (v.enrolled_on && !validDate(v.enrolled_on)) e.enrolled_on = "Enter a valid date.";
  for (const k of ["phone", "guardian_phone"]) if (v[k] && !PHONE_RE.test(v[k])) e[k] = "Enter a valid phone number.";
  for (const k of ["admission_fee", "tuition_fee", "security_fee", "form_fee"]) if (v.x[k] && !/^\d{1,7}$/.test(v.x[k].replace(/[,\s]/g, ""))) e["x_" + k] = "Rupees, numbers only.";
  if (v.parent_email && !EMAIL_RE.test(v.parent_email)) e.parent_email = "Enter a valid email address.";
  if (v.parent_password && v.parent_password.length < 8) e.parent_password = "Use at least 8 characters.";
  if (v.parent_email && !e.parent_email) {
    const u = await one("SELECT role FROM users WHERE email = ?", v.parent_email);
    if (u && u.role !== "parent") e.parent_email = "This email already belongs to a staff or member account.";
  }
  if (Object.keys(e).length) return render(res, sc, { ...v, parent_password: "" }, e, 400);

  let r;
  for (let attempt = 0; attempt < 3 && !r; attempt++) {
    const code = await h.nextCode("students", "ST");
    try {
      r = await one(`INSERT INTO students (code, full_name, father_name, gender, dob, cnic_bform, address, phone, guardian_phone,
          previous_institution, enrolled_on, class_name, school_id, branch_id, status, extra)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?) RETURNING id, code`,
        code, v.full_name, v.father_name || null, v.gender, v.dob || null, v.cnic_bform || null, v.address || null, v.phone || null,
        v.guardian_phone || null, v.previous_institution || null, v.enrolled_on || null, v.class_name || v.x.admission_class || null,
        sc.id, sc.branch_id, JSON.stringify(v.x));
    } catch (err) {
      if (!isUnique(err)) throw err;
      if (/cnic/.test(err.constraint || err.message || "")) return render(res, sc, { ...v, parent_password: "" }, { cnic_bform: "This B-Form / CNIC number is already registered." }, 400);
    }
  }
  await log(req.user.id, "student.create", `${r.code} ${v.full_name} (${sc.code})`);
  const parentNote = await linkParent(req, r.id, null, { ...v, parent_remove: false });
  req.flash("ok", `${v.full_name} registered in ${sc.name_en} as ${r.code}. Add the photograph, then print the admission form.${parentNote}`);
  res.redirect("/app/students/" + r.id);
});

module.exports = router;
