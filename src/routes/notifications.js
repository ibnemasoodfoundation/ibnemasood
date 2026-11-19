/* Notifications: everyone's own list, plus "Send message" for staff to reach parents, teachers or staff.
   Parents receive fee notices, results and messages from their child's Jamia, school or Maktab. */
"use strict";
const express = require("express");
const { one, all, run, log } = require("../db");
const { checkCsrf, requireLogin, requireRole } = require("../auth");
const { withScope, loadScope, schoolSql, maktabSql, ids } = require("../scope");
const { notify } = require("../notify");
const { JAMIAS, DARJAT } = require("../helpers");
const { helpers: h } = require("./institution");

const router = express.Router();
const signedIn = [requireLogin, checkCsrf];
const senders = [requireRole("admin", "manager", "nazim", "principal", "accountant"), withScope, checkCsrf];
const { str, int } = h;

/* ---------- My notifications ---------- */
router.get("/notifications", signedIn, async (req, res) => {
  const rows = await all("SELECT n.*, u.name AS sender FROM notifications n LEFT JOIN users u ON u.id = n.created_by WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 100", req.user.id);
  res.render("app/notifications", { title: "Notifications", rows, canSend: ["admin", "manager", "nazim", "principal", "accountant"].includes(req.user.role) });
});

/* Small feed for the bell and browser notifications (polled while the portal is open) */
router.get("/notifications.json", requireLogin, async (req, res) => {
  const latest = await all("SELECT id, kind, title, body FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY id DESC LIMIT 5", req.user.id);
  const unread = (await one("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", req.user.id)).n;
  res.set("Cache-Control", "no-store").json({ unread, latest });
});

router.get("/notifications/:id/open", signedIn, async (req, res, next) => {
  const n = int(req.params.id) && await one("SELECT * FROM notifications WHERE id = ? AND user_id = ?", int(req.params.id), req.user.id);
  if (!n) return next();
  if (!n.read_at) await run("UPDATE notifications SET read_at = now() WHERE id = ?", n.id);
  res.redirect(n.link && /^\/app(\/|$)/.test(n.link) ? n.link : "/app/notifications");
});

router.post("/notifications/read-all", signedIn, async (req, res) => {
  await run("UPDATE notifications SET read_at = now() WHERE user_id = ? AND read_at IS NULL", req.user.id);
  req.flash("ok", "All notifications marked as read.");
  res.redirect("/app/notifications");
});

/* ---------- Send a message ---------- */
// Who can be reached from where: "p:" parents of students in a unit, "t:" teachers of a unit, "r:" a staff role
async function audiences(req) {
  const sc = req.user.role === "accountant" ? { ...(await loadScope(req.user)), all: true } : req.scope;
  const jamias = (await all("SELECT id, section FROM branches WHERE section IS NOT NULL AND status <> 'archived' ORDER BY id"))
    .filter((b) => sc.all || sc.branchIds.includes(b.id));
  const schools = await all(`SELECT sc.id, sc.name_en FROM schools sc WHERE sc.status <> 'archived' AND ${schoolSql(sc, "sc")} ORDER BY sc.name_en`);
  const makatib = await all(`SELECT m.id, m.name_en FROM makatib m WHERE m.status <> 'archived' AND ${maktabSql(sc, "m")} ORDER BY m.name_en`);
  return { sc, jamias, schools, makatib };
}

/* Student and teacher conditions for a unit key such as "j:1", "j:1:ula", "s:3", "m:7" or "all" */
function unitWhere(key, alias) {
  let m;
  if (key === "all") return { sql: "TRUE", p: [] };
  if ((m = key.match(/^j:(\d{1,9})(?::([a-z_]{2,20}))?$/))) {
    const p = [Number(m[1])]; let sql = `${alias}.branch_id = ? AND ${alias}.maktab_id IS NULL AND ${alias}.school_id IS NULL`;
    if (m[2] && alias === "s") { sql += ` AND ${alias}.darja = ?`; p.push(m[2]); }
    return { sql, p };
  }
  if ((m = key.match(/^s:(\d{1,9})$/))) return { sql: `${alias}.school_id = ?`, p: [Number(m[1])] };
  if ((m = key.match(/^m:(\d{1,9})$/))) return { sql: `${alias}.maktab_id = ?`, p: [Number(m[1])] };
  return null;
}

router.get("/notifications/send", senders, async (req, res) => {
  const a = await audiences(req);
  res.render("app/notify-send", { title: "Send a message", ...a, JAMIAS, DARJAT, values: { to: req.query.to || "", kind: "message" }, errors: {} });
});

router.post("/notifications/send", senders, async (req, res) => {
  const a = await audiences(req);
  const v = { to: str(req.body.to, 40), kind: ["message", "fee", "result", "announcement"].includes(req.body.kind) ? req.body.kind : "message",
    title: str(req.body.title, 160), body: str(req.body.body, 1000), student: str(req.body.student, 20).toUpperCase() };
  const e = {};
  if (v.title.length < 3) e.title = "Write a short title.";
  if (v.body.length < 3) e.body = "Write the message.";
  let userIds = [], label = "";
  if (!Object.keys(e).length) {
    let m;
    if (v.to === "student") {
      // One student's parent, by Student ID
      const s = v.student && await one("SELECT id, full_name, parent_user_id, maktab_id, school_id, branch_id, teacher_id FROM students WHERE code = ?", v.student);
      const { canSeePerson } = require("../scope");
      if (!s || !(a.sc.all || canSeePerson(a.sc, s, "student"))) e.student = "No student with this ID in your area.";
      else if (!s.parent_user_id) e.student = `${s.full_name} has no parent login yet. Add one on the student's form.`;
      else { userIds = [s.parent_user_id]; label = `parent of ${s.full_name}`; }
    } else if ((m = v.to.match(/^r:(admin|manager|nazim|principal|accountant|teacher|parent)$/))) {
      if (!a.sc.all && !["teacher"].includes(m[1])) e.to = "Choose one of your groups.";
      else {
        // Teachers of the sender's own area only, unless the sender sees everything
        const rows = m[1] === "teacher" && !a.sc.all
          ? await all(`SELECT t.user_id AS id FROM teachers t WHERE t.user_id IS NOT NULL AND (t.maktab_id IN (${ids(a.sc.maktabIds)}) OR t.school_id IN (${ids(a.sc.schoolIds)}) OR t.branch_id IN (${ids(a.sc.branchIds)}))`)
          : await all("SELECT id FROM users WHERE status = 'active' AND role = ?", m[1]);
        userIds = rows.map((r) => r.id); label = `all ${m[1]}s`;
      }
    } else if ((m = v.to.match(/^([pt]):(.+)$/))) {
      const unit = unitWhere(m[2], m[1] === "p" ? "s" : "t");
      const okUnit = unit && (m[2] === "all" ? a.sc.all
        : m[2].startsWith("j:") ? a.jamias.some((j) => `j:${j.id}` === m[2].split(":").slice(0, 2).join(":"))
        : m[2].startsWith("s:") ? a.schools.some((s) => `s:${s.id}` === m[2]) : a.makatib.some((x) => `m:${x.id}` === m[2]));
      if (!okUnit) e.to = "Choose one of your groups.";
      else if (m[1] === "p") {
        userIds = (await all(`SELECT DISTINCT s.parent_user_id AS id FROM students s WHERE s.status = 'active' AND s.parent_user_id IS NOT NULL AND ${unit.sql}`, ...unit.p)).map((r) => r.id);
        label = "parents";
      } else {
        userIds = (await all(`SELECT t.user_id AS id FROM teachers t WHERE t.status = 'active' AND t.user_id IS NOT NULL AND ${unit.sql}`, ...unit.p)).map((r) => r.id);
        label = "teachers";
      }
    } else e.to = "Choose who should receive it.";
  }
  if (!Object.keys(e).length && !userIds.length) e.to = "Nobody in this group has a portal login yet, so the message would reach no one.";
  if (Object.keys(e).length) return res.status(400).render("app/notify-send", { title: "Send a message", ...a, JAMIAS, DARJAT, values: v, errors: e });
  const sent = await notify(userIds, { kind: v.kind, title: v.title, body: v.body, link: "/app/notifications", by: req.user.id });
  await log(req.user.id, "notify.send", `${v.title} → ${label} (${sent})`);
  req.flash("ok", `Message sent to ${sent} ${label === "parents" || label === "teachers" ? label : "people (" + label + ")"}. They see it on their dashboard.`);
  res.redirect("/app/notifications/send");
});

module.exports = router;
