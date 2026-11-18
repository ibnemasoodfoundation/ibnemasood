/* Permanent deletion, for the Super Admin and Branch Managers only (managers within the branches they manage).
   Archiving stays available as the gentle option. A delete removes the record and what belongs only to it
   (photos and documents, attendance, results, transfer history); people of a deleted Maktab, school or branch
   are kept but left unassigned, so they never appear under another unit by mistake. Every delete is logged. */
"use strict";
const express = require("express");
const { one, all, run, log } = require("../db");
const { checkCsrf, requireRole } = require("../auth");
const { withScope, inMaktab, inSchool, inBranch, canSeePerson } = require("../scope");
const { removeFile } = require("../uploads");
const { helpers: h } = require("./institution");

const router = express.Router();
const managers = [requireRole("admin", "manager"), withScope, checkCsrf];
const adminOnly = [requireRole("admin"), withScope, checkCsrf];
const { int, forbidden } = h;

/* Photos and documents have no foreign key (they belong to several record types), so remove them by hand */
async function dropFiles(type, id) {
  for (const f of await all("SELECT stored_name FROM attachments WHERE entity_type = ? AND entity_id = ?", type, id)) removeFile(f.stored_name);
  await run("DELETE FROM attachments WHERE entity_type = ? AND entity_id = ?", type, id);
}
function done(req, res, msg, to) { req.flash("ok", msg); res.redirect(to); }

/* ---------- Branch (Super Admin only; the two main branches of the Jamias cannot be deleted) ---------- */
router.post("/branches/:id/delete", adminOnly, async (req, res, next) => {
  const b = int(req.params.id) && await one("SELECT * FROM branches WHERE id = ?", int(req.params.id));
  if (!b) return next();
  if (b.section) { req.flash("err", `${b.name_en} is a main branch (Jamia) and cannot be deleted. Archive it instead.`); return res.redirect("/app/branches/" + b.id); }
  await run("DELETE FROM exams WHERE branch_id = ?", b.id);
  await run("UPDATE teachers SET branch_id = NULL WHERE branch_id = ? AND maktab_id IS NULL AND school_id IS NULL", b.id);
  await run("UPDATE students SET branch_id = NULL WHERE branch_id = ? AND maktab_id IS NULL AND school_id IS NULL", b.id);
  await dropFiles("branch", b.id);
  await run("DELETE FROM branches WHERE id = ?", b.id); // its Makatib, schools and their people keep their records, without a branch
  await log(req.user.id, "branch.delete", `${b.code} ${b.name_en}`);
  done(req, res, `Branch ${b.name_en} deleted. Its Makatib and schools are kept without a branch.`, "/app/branches");
});

/* ---------- Maktab ---------- */
router.post("/makatib/:id/delete", managers, async (req, res, next) => {
  const m = int(req.params.id) && await one("SELECT * FROM makatib WHERE id = ?", int(req.params.id));
  if (!m) return next();
  if (!inMaktab(req.scope, m.id)) return forbidden(res);
  // Its own exams would otherwise turn into "all Makatib" exams
  await run("DELETE FROM exams WHERE maktab_id = ?", m.id);
  await run("UPDATE teachers SET branch_id = NULL WHERE maktab_id = ?", m.id);
  await run("UPDATE students SET branch_id = NULL WHERE maktab_id = ?", m.id);
  await dropFiles("maktab", m.id);
  await run("DELETE FROM makatib WHERE id = ?", m.id);
  await log(req.user.id, "maktab.delete", `${m.code} ${m.name_en}`);
  done(req, res, `Maktab ${m.name_en} deleted. Its teachers and students are kept, now unassigned.`, "/app/makatib");
});

/* ---------- School ---------- */
router.post("/schools/:id/delete", managers, async (req, res, next) => {
  const sc = int(req.params.id) && await one("SELECT * FROM schools WHERE id = ?", int(req.params.id));
  if (!sc) return next();
  if (!req.scope.all && !inBranch(req.scope, sc.branch_id)) return forbidden(res);
  await run("DELETE FROM exams WHERE school_id = ?", sc.id);
  await run("UPDATE teachers SET branch_id = NULL WHERE school_id = ?", sc.id);
  await run("UPDATE students SET branch_id = NULL WHERE school_id = ?", sc.id);
  await run("DELETE FROM schools WHERE id = ?", sc.id);
  await log(req.user.id, "school.delete", `${sc.code} ${sc.name_en}`);
  done(req, res, `School ${sc.name_en} deleted. Its teachers and students are kept, now unassigned.`, "/app/schools");
});

/* ---------- Teacher / student ---------- */
for (const type of ["teacher", "student"]) {
  router.post(`/${type}s/:id/delete`, managers, async (req, res, next) => {
    const x = int(req.params.id) && await one(`SELECT * FROM ${type}s WHERE id = ?`, int(req.params.id));
    if (!x) return next();
    if (!canSeePerson(req.scope, x, type)) return forbidden(res);
    await dropFiles(type, x.id);
    await run("DELETE FROM transfers WHERE person_type = ? AND person_id = ?", type, x.id);
    // Attendance, progress and results go with the record (ON DELETE CASCADE); certificates keep their printed details
    await run(`DELETE FROM ${type}s WHERE id = ?`, x.id);
    if (type === "teacher" && x.user_id) await run("UPDATE users SET status = 'suspended' WHERE id = ? AND role = 'teacher'", x.user_id);
    await log(req.user.id, `${type}.delete`, `${x.code} ${x.full_name}`);
    done(req, res, `${x.full_name} deleted${type === "teacher" && x.user_id ? "; their login is suspended" : ""}.`, `/app/${type}s`);
  });
}

/* ---------- Office records ---------- */
router.post("/admissions/:id/delete", managers, async (req, res, next) => {
  const a = int(req.params.id) && await one("SELECT * FROM admissions WHERE id = ?", int(req.params.id));
  if (!a) return next();
  await run("DELETE FROM admissions WHERE id = ?", a.id); // a student registered from it keeps the record (admission_id SET NULL)
  await log(req.user.id, "admission.delete", `#${a.id} ${a.student_name}`);
  done(req, res, `Application #${a.id} deleted.`, "/app/admissions");
});

router.post("/donations/:id/delete", managers, async (req, res, next) => {
  const d = int(req.params.id) && await one("SELECT * FROM donations WHERE id = ?", int(req.params.id));
  if (!d) return next();
  await run("DELETE FROM donations WHERE id = ?", d.id);
  await log(req.user.id, "donation.delete", `#${d.id} ${d.donor_name} Rs ${d.amount}`);
  done(req, res, `Donation #${d.id} deleted.`, "/app/donations");
});

router.post("/messages/:id/delete", managers, async (req, res, next) => {
  const m = int(req.params.id) && await one("SELECT id, name FROM messages WHERE id = ?", int(req.params.id));
  if (!m) return next();
  await run("DELETE FROM messages WHERE id = ?", m.id);
  await log(req.user.id, "message.delete", `#${m.id} ${m.name}`);
  done(req, res, "Message deleted.", "/app/messages");
});

module.exports = router;
