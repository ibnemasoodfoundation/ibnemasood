/* One parent login for several children: the Super Admin, a Branch Manager or a School Principal sees a parent's
   children and adds or removes one by Student ID. Staff other than the Super Admin only link students in their area. */
"use strict";
const express = require("express");
const { one, all, run, log } = require("../db");
const { checkCsrf, requireRole } = require("../auth");
const { withScope, canSeePerson } = require("../scope");
const { notify } = require("../notify");
const { helpers: h } = require("./institution");

const router = express.Router();
const guard = [requireRole("admin", "manager", "principal"), withScope, checkCsrf];
const { str, int, forbidden } = h;

async function loadParent(req) {
  const p = int(req.params.id) && await one("SELECT id, name, email, phone, status, role, created_at, last_login FROM users WHERE id = ?", int(req.params.id));
  if (!p || p.role !== "parent") return { missing: true };
  const kids = await all(`SELECT s.id, s.code, s.full_name, s.class_name, s.status, s.maktab_id, s.school_id, s.branch_id, s.teacher_id,
      COALESCE(m.name_en, sc.name_en, b.name_en) AS unit FROM students s
    LEFT JOIN makatib m ON m.id = s.maktab_id LEFT JOIN schools sc ON sc.id = s.school_id LEFT JOIN branches b ON b.id = s.branch_id
    WHERE s.parent_user_id = ? ORDER BY s.full_name`, p.id);
  const mine = kids.filter((k) => canSeePerson(req.scope, k, "student"));
  // Staff outside the Super Admin may manage a parent only if at least one child is theirs (or none is linked yet)
  if (!req.scope.all && kids.length && !mine.length) return { denied: true };
  return { p, kids: mine, hidden: kids.length - mine.length };
}

router.get("/parents/:id", guard, async (req, res, next) => {
  const { p, kids, hidden, missing, denied } = await loadParent(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  res.render("app/parent-children", { title: "Parent: " + p.name, p, kids, hidden });
});

router.post("/parents/:id/children", guard, async (req, res, next) => {
  const { p, missing, denied } = await loadParent(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const code = str(req.body.code, 20).toUpperCase();
  const s = code && await one("SELECT id, code, full_name, parent_user_id, maktab_id, school_id, branch_id, teacher_id FROM students WHERE code = ?", code);
  const back = `/app/parents/${p.id}`;
  if (!s || !canSeePerson(req.scope, s, "student")) { req.flash("err", `No student with ID ${code || "(empty)"} in your area.`); return res.redirect(back); }
  if (s.parent_user_id === p.id) { req.flash("ok", `${s.full_name} is already linked to this parent.`); return res.redirect(back); }
  const before = s.parent_user_id ? await one("SELECT email FROM users WHERE id = ?", s.parent_user_id) : null;
  await run("UPDATE students SET parent_user_id = ? WHERE id = ?", p.id, s.id);
  await log(req.user.id, "parent.link_child", `${p.email} ← ${s.code} ${s.full_name}`);
  await notify([p.id], { kind: "message", by: req.user.id, link: "/app", title: `${s.full_name} added to your account`, body: "You can now see this child's attendance, results and fees on your dashboard." });
  req.flash("ok", `${s.full_name} linked to ${p.name}.${before ? ` (Moved from ${before.email}.)` : ""}`);
  res.redirect(back);
});

router.post("/parents/:id/children/:sid/remove", guard, async (req, res, next) => {
  const { p, missing, denied } = await loadParent(req);
  if (missing) return next();
  if (denied) return forbidden(res);
  const s = int(req.params.sid) && await one("SELECT id, code, full_name, parent_user_id, maktab_id, school_id, branch_id, teacher_id FROM students WHERE id = ?", int(req.params.sid));
  if (!s || s.parent_user_id !== p.id || !canSeePerson(req.scope, s, "student")) return forbidden(res);
  await run("UPDATE students SET parent_user_id = NULL WHERE id = ?", s.id);
  await log(req.user.id, "parent.unlink_child", `${p.email} − ${s.code}`);
  req.flash("ok", `${s.full_name} removed from ${p.name}'s login.`);
  res.redirect(`/app/parents/${p.id}`);
});

module.exports = router;
