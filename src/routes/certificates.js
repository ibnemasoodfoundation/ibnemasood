/* Printed documents: the Iqra Islamia Public School admission form (blank or filled from a student),
   the School Leaving Certificate, and the Jamia's Shahadat al-Alamiyyah certificate.
   Certificates are stored (certificates table) so they can be reprinted with the same details and number. */
"use strict";
const express = require("express");
const { one, all, run, log } = require("../db");
const { checkCsrf, requireRole, STAFF_ROLES } = require("../auth");
const { withScope, personSql, canSeePerson } = require("../scope");
const { todayPk } = require("../helpers");
const { helpers: h } = require("./institution");

const router = express.Router();
const staff = [requireRole(...STAFF_ROLES), withScope, checkCsrf];
const { str, int, DATE_RE, forbidden } = h;

const KINDS = { leaving: "School Leaving Certificate", alimiyyah: "Shahadat al-Alamiyyah" };
const LEAVING_FIELDS = [
  ["gr_no", "G.R. No"], ["certificate_no", "Certificate No"], ["name", "Name of pupil"], ["father_name", "Father's name"],
  ["caste", "Caste"], ["religion", "Religion"], ["place_of_birth", "Place of birth"], ["dob", "Date of birth (in figure)"],
  ["dob_words", "Date of birth (in words)"], ["last_school", "Last school attended"], ["admission_date", "Date of admission"],
  ["class_admitted", "Class in which admitted"], ["class_studying", "Class in which studying"], ["since_when", "Since when"],
  ["leaving_date", "Date of leaving school"], ["progress", "Progress"], ["conduct", "Conduct"],
  ["reason", "Reason of leaving school"], ["remarks", "Remarks"],
];
const ALIMIYYAH_FIELDS = [
  ["name", "Student name (Arabic/Urdu script) — الطالب"], ["father_name", "Father's name — بن"], ["place", "From (town / district) — من"],
  ["birth_year", "Year of birth — المولودة فی عام"], ["exam_year", "Year of final exam — عام"], ["grade", "Grade — بتقدير"],
  ["marks", "Marks out of 600 — الدرجات"], ["issue_date", "Date of issue — تاريخ الاصدار"],
];
const FIELDS = { leaving: LEAVING_FIELDS, alimiyyah: ALIMIYYAH_FIELDS };
// Iqra Islamia Public School documents are for school students; the Alimiyyah is for the Jamia's (Makatib) students
const kindsFor = (s) => (s.school_id ? ["leaving"] : ["alimiyyah"]);
const ARABIC_GRADES = ["ممتاز", "جيد جدا", "جيد", "مقبول", "راسب"];

/* ---------- Formatting ---------- */
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen",
  "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const ORD = { One: "First", Two: "Second", Three: "Third", Five: "Fifth", Eight: "Eighth", Nine: "Ninth", Twelve: "Twelfth" };
function words(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
  if (n < 1000) return ONES[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + words(n % 100) : "");
  return words(Math.floor(n / 1000)) + " Thousand" + (n % 1000 ? " " + words(n % 1000) : "");
}
function ordinal(n) {
  const w = words(n).split(" "), last = w.pop();
  const o = ORD[last] || (last.endsWith("y") ? last.slice(0, -1) + "ieth" : last + "th");
  return [...w, o].join(" ");
}
/* "2015-03-05" → "Fifth March Two Thousand Fifteen" */
function dateInWords(d) {
  if (!DATE_RE.test(d || "")) return "";
  const [y, m, day] = d.split("-").map(Number);
  const month = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  return `${ordinal(day)} ${month} ${words(y)}`;
}
const dmy = (d) => (DATE_RE.test(d || "") ? d.split("-").reverse().join("-") : d || "");
/* Western digits → the Urdu/Persian digits used on the Arabic certificate (۰۱۲۳۴۵۶۷۸۹) */
const urduDigits = (s) => String(s ?? "").replace(/\d/g, (c) => "۰۱۲۳۴۵۶۷۸۹"[c]);
function arabicGrade(pct, pass) {
  if (pct < pass) return "راسب";
  if (pct >= 80) return "ممتاز";
  if (pct >= 70) return "جيد جدا";
  if (pct >= 60) return "جيد";
  return "مقبول";
}

/* ---------- Loading ---------- */
async function loadStudent(req, id) {
  const s = id && await one(`SELECT s.*, m.name_en AS maktab, m.town AS maktab_town, sc.name_en AS school, b.name_en AS branch, b.section
    FROM students s LEFT JOIN makatib m ON m.id = s.maktab_id LEFT JOIN schools sc ON sc.id = s.school_id
    LEFT JOIN branches b ON b.id = s.branch_id WHERE s.id = ?`, id);
  if (!s) return { missing: true };
  if (!canSeePerson(req.scope, s, "student")) return { denied: true };
  s.extra = s.extra || {};
  return { s };
}

async function nextNumber(kind) {
  const r = await one("SELECT COUNT(*) AS n FROM certificates WHERE kind = ?", kind);
  return String(Number(r.n) + 1);
}

/* Starting values for a new certificate, taken from the student record (and a result, for the Alimiyyah) */
async function prefill(kind, s, examId) {
  const x = s.extra;
  if (kind === "leaving") {
    return {
      gr_no: x.gr_no || "", certificate_no: await nextNumber("leaving"), name: s.full_name, father_name: s.father_name || "",
      caste: x.caste || "", religion: x.religion || "Islam", place_of_birth: x.place_of_birth || "", dob: dmy(s.dob),
      dob_words: dateInWords(s.dob), last_school: s.previous_institution || "", admission_date: dmy(s.enrolled_on),
      class_admitted: x.admission_class || "", class_studying: s.class_name || "", since_when: "", leaving_date: dmy(todayPk()),
      progress: "", conduct: "", reason: "", remarks: "",
    };
  }
  const v = {
    name: s.name_ur || s.full_name, father_name: x.father_name_ur || s.father_name || "", place: x.place_of_birth || s.maktab_town || x.district || "",
    birth_year: s.dob ? urduDigits(String(s.dob).slice(0, 4)) : "", exam_year: urduDigits(todayPk().slice(0, 4)), grade: "", marks: "",
    issue_date: urduDigits(dmy(todayPk()).replace(/-/g, "/")),
  };
  const r = examId && await one(`SELECT r.*, e.pass_percent, e.session_year FROM results r JOIN exams e ON e.id = r.exam_id
    WHERE r.exam_id = ? AND r.student_id = ?`, examId, s.id);
  if (r) {
    const pct = Number(r.percentage);
    v.grade = arabicGrade(pct, r.pass_percent);
    v.marks = urduDigits(r.total === 600 ? r.obtained : Math.round(pct * 6));
    if (r.session_year && /^\d{4}$/.test(r.session_year)) v.exam_year = urduDigits(r.session_year);
  }
  return v;
}

function readFields(kind, body) {
  const v = {};
  for (const [k] of FIELDS[kind]) v[k] = str(body[k], k === "remarks" || k === "reason" ? 300 : 160);
  return v;
}

/* ================= List ================= */
router.get("/certificates", staff, async (req, res) => {
  // A principal sees the school's leaving certificates; the Makatib Nazim sees Alimiyyah certificates
  const only = req.user.role === "principal" ? "leaving" : req.user.role === "nazim" ? "alimiyyah" : KINDS[req.query.kind] ? req.query.kind : "";
  const rows = await all(`SELECT c.*, s.full_name, s.code FROM certificates c LEFT JOIN students s ON s.id = c.student_id
    WHERE (c.student_id IS NULL OR ${personSql(req.scope, "s", "student")}) ${only ? "AND c.kind = ?" : ""} ORDER BY c.id DESC LIMIT 300`, ...(only ? [only] : []));
  res.render("app/certificates", { title: only === "leaving" ? "School leaving certificates" : "Certificates", rows, KINDS, only });
});

/* ================= Admission form ================= */
router.get("/forms/admission", staff, (req, res) => {
  res.render("app/print-admission", { title: "Admission form", s: null, x: {} });
});

router.get("/students/:id/admission-form", staff, async (req, res, next) => {
  const { s, missing, denied } = await loadStudent(req, int(req.params.id));
  if (missing) return next();
  if (denied) return forbidden(res);
  if (!s.school_id) { req.flash("err", "The admission form is for Iqra Islamia Public School students."); return res.redirect("/app/students/" + s.id); }
  const photo = await one("SELECT id FROM attachments WHERE entity_type = 'student' AND entity_id = ? AND kind = 'photo' ORDER BY id DESC LIMIT 1", s.id);
  res.render("app/print-admission", { title: "Admission form: " + s.full_name, s, x: s.extra, photo, dobWords: dateInWords(s.dob), dmy });
});

/* ================= Issue a certificate ================= */
router.get("/students/:id/certificates/new", staff, async (req, res, next) => {
  const { s, missing, denied } = await loadStudent(req, int(req.params.id));
  if (missing) return next();
  if (denied) return forbidden(res);
  const kinds = kindsFor(s);
  const kind = kinds.includes(req.query.kind) ? req.query.kind : kinds[0];
  const exams = await all(`SELECT e.id, e.title, r.obtained, r.total, r.grade FROM results r JOIN exams e ON e.id = r.exam_id
    WHERE r.student_id = ? ORDER BY e.id DESC`, s.id);
  const examId = int(req.query.exam) || (kind === "alimiyyah" && exams[0] ? exams[0].id : null);
  res.render("app/certificate-form", {
    title: "Issue " + KINDS[kind], kind, kinds, s, values: await prefill(kind, s, examId), fields: FIELDS[kind], KINDS, exams, examId,
    issued_on: todayPk(), ARABIC_GRADES, action: `/app/students/${s.id}/certificates?kind=${kind}`,
  });
});

router.post("/students/:id/certificates", staff, async (req, res, next) => {
  const { s, missing, denied } = await loadStudent(req, int(req.params.id));
  if (missing) return next();
  if (denied) return forbidden(res);
  const kind = kindsFor(s).includes(req.query.kind) ? req.query.kind : null;
  if (!kind) return forbidden(res);
  const v = readFields(kind, req.body);
  const issued = DATE_RE.test(str(req.body.issued_on, 10)) ? str(req.body.issued_on, 10) : todayPk();
  if (!v.name) { req.flash("err", "Enter the student's name."); return res.redirect(`/app/students/${s.id}/certificates/new?kind=${kind}`); }
  const r = await one(`INSERT INTO certificates (kind, serial_no, student_id, exam_id, data, issued_on, issued_by)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    kind, v.certificate_no || null, s.id, int(req.body.exam_id), JSON.stringify(v), issued, req.user.id);
  await log(req.user.id, "certificate." + kind, `${s.code} ${s.full_name}`);
  req.flash("ok", `${KINDS[kind]} issued. Print it or download the PDF.`);
  res.redirect("/app/certificates/" + r.id);
});

async function loadCert(req) {
  const id = int(req.params.id);
  const c = id && await one("SELECT * FROM certificates WHERE id = ?", id);
  if (!c) return { missing: true };
  if (c.student_id) {
    const s = await one("SELECT id, maktab_id, school_id, branch_id, teacher_id FROM students WHERE id = ?", c.student_id);
    if (s && !canSeePerson(req.scope, s, "student")) return { denied: true };
  }
  return { c };
}

router.get("/certificates/:id", staff, async (req, res, next) => {
  const { c, missing, denied } = await loadCert(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  res.render(c.kind === "leaving" ? "app/print-leaving" : "app/print-alimiyyah", { title: KINDS[c.kind], c, d: c.data || {}, dmy, paper: req.query.paper === "1" });
});

router.get("/certificates/:id/edit", staff, async (req, res, next) => {
  const { c, missing, denied } = await loadCert(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const s = c.student_id ? await one("SELECT id, code, full_name FROM students WHERE id = ?", c.student_id) : null;
  res.render("app/certificate-form", {
    title: "Edit " + KINDS[c.kind], kind: c.kind, kinds: [c.kind], s, values: c.data || {}, fields: FIELDS[c.kind], KINDS, exams: [], examId: c.exam_id,
    issued_on: c.issued_on, ARABIC_GRADES, action: `/app/certificates/${c.id}`, editing: true,
  });
});

router.post("/certificates/:id", staff, async (req, res, next) => {
  const { c, missing, denied } = await loadCert(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const v = readFields(c.kind, req.body);
  const issued = DATE_RE.test(str(req.body.issued_on, 10)) ? str(req.body.issued_on, 10) : c.issued_on;
  await run("UPDATE certificates SET data = ?, serial_no = ?, issued_on = ? WHERE id = ?", JSON.stringify(v), v.certificate_no || c.serial_no, issued, c.id);
  await log(req.user.id, "certificate.update", `#${c.id}`);
  req.flash("ok", "Certificate saved.");
  res.redirect("/app/certificates/" + c.id);
});

router.post("/certificates/:id/delete", [requireRole("admin"), withScope, checkCsrf], async (req, res, next) => {
  const { c, missing } = await loadCert(req);
  if (missing) return next();
  await run("DELETE FROM certificates WHERE id = ?", c.id);
  await log(req.user.id, "certificate.delete", `#${c.id} ${c.kind}`);
  req.flash("ok", "Certificate deleted.");
  res.redirect("/app/certificates");
});

module.exports = router;
module.exports.dateInWords = dateInWords;
