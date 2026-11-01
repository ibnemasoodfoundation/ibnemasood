/* Signed-in portal: role dashboards, admissions, donations, messages, announcements, users */
"use strict";
const crypto = require("node:crypto");
const express = require("express");
const { one, all, run, log } = require("../db");
const { ROLES, hashPassword, verifyPassword, checkCsrf, requireLogin, requireRole } = require("../auth");
const { BRANCHES, PROGRAMMES, DONATION_KINDS, DONATION_METHODS, todayPk } = require("../helpers");
const { dashboardData } = require("../dashboard");

const router = express.Router();
router.use(requireLogin, checkCsrf);

const staff = requireRole("admin", "manager");
const adminOnly = requireRole("admin");
const isStaff = (u) => u.role === "admin" || u.role === "manager";
const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const back = (req, fallback) => {
  const ref = req.get("referer");
  try { if (ref && new URL(ref).host === req.get("host")) return ref; } catch { /* ignore */ }
  return fallback;
};
const count = async (sql, ...p) => (await one(sql, ...p)).n;

function announcementsFor(user, limit = 50) {
  return all(
    `SELECT a.*, u.name AS author FROM announcements a LEFT JOIN users u ON u.id = a.author_id
     WHERE a.audience = 'all' OR ?::int = 1 ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    isStaff(user) ? 1 : 0, limit
  );
}

/* ---------- Overview: one dashboard per role ---------- */
router.get("/", async (req, res) => {
  const u = req.user;

  if (u.role === "user") {
    return res.render("app/home-user", {
      title: "My dashboard",
      admissions: await all("SELECT * FROM admissions WHERE user_id = ? ORDER BY id DESC LIMIT 5", u.id),
      donations: await all("SELECT * FROM donations WHERE user_id = ? ORDER BY id DESC LIMIT 5", u.id),
      given: await count("SELECT COALESCE(SUM(amount),0) AS n FROM donations WHERE user_id = ? AND status = 'verified'", u.id),
      announcements: await announcementsFor(u, 4),
    });
  }

  if (u.role === "teacher") {
    const teacher = await one(`SELECT t.*, m.name_en AS maktab, m.name_ur AS maktab_ur, b.name_en AS branch FROM teachers t
      LEFT JOIN makatib m ON m.id = t.maktab_id LEFT JOIN branches b ON b.id = t.branch_id WHERE t.user_id = ?`, u.id);
    const today = todayPk();
    const where = teacher ? `s.status = 'active' AND (s.maktab_id = ${Number(teacher.maktab_id) || 0} OR s.teacher_id = ${teacher.id})` : "FALSE";
    return res.render("app/home-teacher", {
      title: "Teacher dashboard", teacher, today,
      students: await all(`SELECT s.id, s.code, s.full_name, s.class_name, s.quran_level, a.status AS mark FROM students s
        LEFT JOIN student_attendance a ON a.student_id = s.id AND a.att_date = ? AND a.session = 'morning'
        WHERE ${where} ORDER BY s.class_name NULLS LAST, s.full_name`, today),
      announcements: await announcementsFor(u, 4),
    });
  }

  const data = await dashboardData(u);
  res.render("app/dashboard", { title: u.role === "admin" ? "Admin dashboard" : "Manager dashboard", ...data });
});

/* ---------- Admissions ---------- */
router.get("/admissions", async (req, res) => {
  const u = req.user;
  const status = ["pending", "approved", "waitlisted", "rejected"].includes(req.query.status) ? req.query.status : "";
  const branch = BRANCHES[req.query.branch] ? req.query.branch : "";
  const q = str(req.query.q, 80);
  const where = [], params = [];
  if (!isStaff(u)) { where.push("a.user_id = ?"); params.push(u.id); }
  if (status) { where.push("a.status = ?"); params.push(status); }
  if (branch) { where.push("a.branch = ?"); params.push(branch); }
  if (q) { where.push("(a.student_name ILIKE ? OR a.father_name ILIKE ? OR a.phone ILIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = await all(
    `SELECT a.*, u.name AS applicant FROM admissions a JOIN users u ON u.id = a.user_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.id DESC LIMIT 300`, ...params
  );
  res.render("app/admissions", { title: isStaff(u) ? "Admissions" : "My applications", rows, filters: { status, branch, q } });
});

const activeMakatib = () => all(`SELECT m.id, m.name_en, m.name_ur, m.town FROM makatib m WHERE m.status = 'active' ORDER BY m.name_en`);

router.get("/admissions/new", async (req, res) => {
  res.render("app/admission-form", {
    title: "New admission application", values: { phone: req.user.phone || "" }, errors: {}, PROGRAMMES, makatib: await activeMakatib(),
  });
});

router.post("/admissions", async (req, res) => {
  const v = {
    student_name: str(req.body.student_name, 80),
    father_name: str(req.body.father_name, 80),
    dob: str(req.body.dob, 10),
    branch: str(req.body.branch, 10),
    programme: str(req.body.programme, 60),
    phone: str(req.body.phone, 30),
    address: str(req.body.address, 300),
    notes: str(req.body.notes, 1000),
    maktab_id: /^\d{1,9}$/.test(String(req.body.maktab_id || "")) ? Number(req.body.maktab_id) : null,
  };
  const errors = {};
  if (v.maktab_id && !(await one("SELECT id FROM makatib WHERE id = ? AND status = 'active'", v.maktab_id))) errors.maktab_id = "Choose a Maktab from the list.";
  if (v.student_name.length < 2) errors.student_name = "Enter the student's name.";
  if (v.father_name.length < 2) errors.father_name = "Enter the father's or guardian's name.";
  if (v.dob && (!/^\d{4}-\d{2}-\d{2}$/.test(v.dob) || isNaN(Date.parse(v.dob)))) errors.dob = "Enter a valid date.";
  if (!BRANCHES[v.branch]) errors.branch = "Choose a branch.";
  else if (!PROGRAMMES[v.branch].includes(v.programme)) errors.programme = "Choose a programme for this branch.";
  if (!/^[+\d][\d\s-]{6,19}$/.test(v.phone)) errors.phone = "Enter a valid phone number.";
  if (Object.keys(errors).length) {
    return res.status(400).render("app/admission-form", {
      title: "New admission application", values: v, errors, PROGRAMMES, makatib: await activeMakatib(),
    });
  }
  const r = await one(
    `INSERT INTO admissions (user_id, student_name, father_name, dob, branch, programme, phone, address, notes, maktab_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    req.user.id, v.student_name, v.father_name, v.dob || null, v.branch, v.programme, v.phone, v.address || null, v.notes || null, v.maktab_id
  );
  await log(req.user.id, "admission.create", `#${r.id} ${v.student_name}`);
  req.flash("ok", "Application submitted. The office will review it soon.");
  res.redirect("/app/admissions/" + r.id);
});

router.get("/admissions/:id", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return next();
  const a = await one(
    `SELECT a.*, u.name AS applicant, u.email AS applicant_email, r.name AS reviewer, m.name_en AS maktab,
            (SELECT id FROM students s WHERE s.admission_id = a.id LIMIT 1) AS student_id
     FROM admissions a JOIN users u ON u.id = a.user_id LEFT JOIN users r ON r.id = a.reviewed_by
     LEFT JOIN makatib m ON m.id = a.maktab_id WHERE a.id = ?`, id
  );
  if (!a || (!isStaff(req.user) && a.user_id !== req.user.id)) return next();
  res.render("app/admission", { title: "Application #" + a.id, a });
});

router.post("/admissions/:id/review", staff, async (req, res, next) => {
  const id = Number(req.params.id);
  const a = Number.isInteger(id) && await one("SELECT * FROM admissions WHERE id = ?", id);
  if (!a) return next();
  const status = str(req.body.status, 12);
  if (!["pending", "approved", "waitlisted", "rejected"].includes(status)) return res.redirect(back(req, "/app/admissions"));
  await run(
    "UPDATE admissions SET status = ?, review_note = ?, reviewed_by = ?, updated_at = now() WHERE id = ?",
    status, str(req.body.note, 500) || null, req.user.id, a.id
  );
  await log(req.user.id, "admission." + status, `#${a.id} ${a.student_name}`);
  req.flash("ok", `Application #${a.id} marked ${status}.`);
  res.redirect(back(req, "/app/admissions/" + a.id));
});

/* ---------- Donations ---------- */
router.get("/donations", async (req, res) => {
  const u = req.user;
  const status = ["pending", "verified", "rejected"].includes(req.query.status) ? req.query.status : "";
  const where = [], params = [];
  if (!isStaff(u)) { where.push("user_id = ?"); params.push(u.id); }
  if (status) { where.push("status = ?"); params.push(status); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = await all(`SELECT * FROM donations ${w} ORDER BY id DESC LIMIT 300`, ...params);
  const totals = await one(
    `SELECT COALESCE(SUM(CASE WHEN status='verified' THEN amount END),0) AS verified,
            COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) AS pending
     FROM donations ${isStaff(u) ? "" : "WHERE user_id = ?"}`, ...(isStaff(u) ? [] : [u.id])
  );
  res.render("app/donations", { title: isStaff(u) ? "Donations" : "My donations", rows, totals, filters: { status } });
});

router.get("/donations/new", (req, res) => {
  res.render("app/donation-form", { title: "Record a donation", values: { donor_name: req.user.name }, errors: {}, DONATION_KINDS, DONATION_METHODS });
});

router.post("/donations", async (req, res) => {
  const v = {
    donor_name: str(req.body.donor_name, 80),
    amount: Math.round(Number(req.body.amount)),
    kind: str(req.body.kind, 40),
    method: str(req.body.method, 40),
    reference: str(req.body.reference, 80),
  };
  const errors = {};
  if (v.donor_name.length < 2) errors.donor_name = "Enter the donor's name.";
  if (!Number.isFinite(v.amount) || v.amount < 1 || v.amount > 100000000) errors.amount = "Enter an amount in rupees.";
  if (!DONATION_KINDS.includes(v.kind)) errors.kind = "Choose a donation type.";
  if (!DONATION_METHODS.includes(v.method)) errors.method = "Choose how you sent it.";
  if (Object.keys(errors).length) {
    return res.status(400).render("app/donation-form", { title: "Record a donation", values: v, errors, DONATION_KINDS, DONATION_METHODS });
  }
  // Staff entering a donation received at the office can mark it verified straight away
  const status = isStaff(req.user) && req.body.verified === "1" ? "verified" : "pending";
  const r = await one(
    "INSERT INTO donations (user_id, donor_name, amount, kind, method, reference, status, verified_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    req.user.id, v.donor_name, v.amount, v.kind, v.method, v.reference || null, status, status === "verified" ? req.user.id : null
  );
  await log(req.user.id, "donation.create", `#${r.id} Rs ${v.amount} ${v.kind}`);
  req.flash("ok", status === "verified" ? "Donation recorded and verified." : "JazakAllah khair. Your donation is recorded and will be confirmed by the office.");
  res.redirect("/app/donations");
});

router.post("/donations/:id/status", staff, async (req, res, next) => {
  const id = Number(req.params.id);
  const d = Number.isInteger(id) && await one("SELECT * FROM donations WHERE id = ?", id);
  if (!d) return next();
  const status = str(req.body.status, 10);
  if (!["pending", "verified", "rejected"].includes(status)) return res.redirect(back(req, "/app/donations"));
  await run("UPDATE donations SET status = ?, verified_by = ? WHERE id = ?", status, status === "pending" ? null : req.user.id, d.id);
  await log(req.user.id, "donation." + status, `#${d.id} Rs ${d.amount}`);
  req.flash("ok", `Donation #${d.id} marked ${status}.`);
  res.redirect(back(req, "/app/donations"));
});

/* ---------- Contact messages (staff) ---------- */
router.get("/messages", staff, async (req, res) => {
  const status = ["new", "read", "closed"].includes(req.query.status) ? req.query.status : "";
  const rows = status
    ? await all("SELECT * FROM messages WHERE status = ? ORDER BY id DESC LIMIT 300", status)
    : await all("SELECT * FROM messages ORDER BY id DESC LIMIT 300");
  res.render("app/messages", { title: "Messages", rows, filters: { status } });
});

router.post("/messages/:id/status", staff, async (req, res, next) => {
  const id = Number(req.params.id);
  const m = Number.isInteger(id) && await one("SELECT id FROM messages WHERE id = ?", id);
  if (!m) return next();
  const status = str(req.body.status, 10);
  if (["new", "read", "closed"].includes(status)) await run("UPDATE messages SET status = ? WHERE id = ?", status, m.id);
  res.redirect(back(req, "/app/messages"));
});

/* ---------- Announcements ---------- */
router.get("/announcements", async (req, res) => {
  res.render("app/announcements", { title: "Announcements", rows: await announcementsFor(req.user), values: {}, errors: {} });
});

router.post("/announcements", staff, async (req, res) => {
  const v = { title: str(req.body.title, 120), body: str(req.body.body, 4000), audience: req.body.audience === "staff" ? "staff" : "all" };
  const errors = {};
  if (v.title.length < 3) errors.title = "Add a short title.";
  if (v.body.length < 3) errors.body = "Write the announcement.";
  if (Object.keys(errors).length) {
    return res.status(400).render("app/announcements", { title: "Announcements", rows: await announcementsFor(req.user), values: v, errors });
  }
  await run("INSERT INTO announcements (title, body, audience, author_id) VALUES (?, ?, ?, ?)", v.title, v.body, v.audience, req.user.id);
  await log(req.user.id, "announcement.create", v.title);
  req.flash("ok", "Announcement posted.");
  res.redirect("/app/announcements");
});

router.post("/announcements/:id/delete", staff, async (req, res, next) => {
  const id = Number(req.params.id);
  const a = Number.isInteger(id) && await one("SELECT * FROM announcements WHERE id = ?", id);
  if (!a) return next();
  if (req.user.role !== "admin" && a.author_id !== req.user.id) {
    req.flash("err", "Only the author or an admin can remove this announcement.");
    return res.redirect("/app/announcements");
  }
  await run("DELETE FROM announcements WHERE id = ?", a.id);
  await log(req.user.id, "announcement.delete", a.title);
  req.flash("ok", "Announcement removed.");
  res.redirect("/app/announcements");
});

/* ---------- Users (admin) ---------- */
const USER_COLS = "id, name, email, phone, role, status, created_at, last_login";

router.get("/users", adminOnly, async (req, res) => {
  const role = ROLES.includes(req.query.role) ? req.query.role : "";
  const q = str(req.query.q, 80);
  const where = [], params = [];
  if (role) { where.push("role = ?"); params.push(role); }
  if (q) { where.push("(name ILIKE ? OR email ILIKE ? OR phone ILIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = await all(
    `SELECT ${USER_COLS} FROM users ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 500`, ...params
  );
  res.render("app/users", { title: "Users & roles", rows, filters: { role, q }, values: {}, errors: {} });
});

router.post("/users", adminOnly, async (req, res) => {
  const v = {
    name: str(req.body.name, 80),
    email: str(req.body.email, 120).toLowerCase(),
    phone: str(req.body.phone, 30),
    role: ROLES.includes(req.body.role) ? req.body.role : "user",
  };
  const errors = {};
  if (v.name.length < 2) errors.name = "Enter a name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) errors.email = "Enter a valid email.";
  else if (await one("SELECT id FROM users WHERE email = ?", v.email)) errors.email = "This email is already registered.";
  if (Object.keys(errors).length) {
    const rows = await all(`SELECT ${USER_COLS} FROM users ORDER BY id DESC LIMIT 500`);
    return res.status(400).render("app/users", { title: "Users & roles", rows, filters: {}, values: v, errors, openForm: true });
  }
  const password = crypto.randomBytes(6).toString("base64url");
  await run("INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)",
    v.name, v.email, v.phone || null, hashPassword(password), v.role);
  await log(req.user.id, "user.create", `${v.email} as ${v.role}`);
  req.flash("ok", `Account created for ${v.email}. Temporary password: ${password}`);
  res.redirect("/app/users");
});

async function guardSelfOrLastAdmin(req, target, changingAway) {
  if (target.id === req.user.id) return "You cannot change or remove your own admin account here.";
  if (target.role === "admin" && changingAway &&
      await count("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'") <= 1) {
    return "At least one active admin must remain.";
  }
  return null;
}

async function findUser(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) ? one("SELECT * FROM users WHERE id = ?", id) : null;
}

router.post("/users/:id", adminOnly, async (req, res, next) => {
  const t = await findUser(req);
  if (!t) return next();
  const role = ROLES.includes(req.body.role) ? req.body.role : t.role;
  const status = ["active", "suspended"].includes(req.body.status) ? req.body.status : t.status;
  const err = await guardSelfOrLastAdmin(req, t, role !== "admin" || status !== "active");
  if (err) { req.flash("err", err); return res.redirect(back(req, "/app/users")); }
  await run("UPDATE users SET role = ?, status = ? WHERE id = ?", role, status, t.id);
  await log(req.user.id, "user.update", `${t.email}: ${t.role}/${t.status} → ${role}/${status}`);
  req.flash("ok", `${t.name} is now ${role}, ${status}.`);
  res.redirect(back(req, "/app/users"));
});

router.post("/users/:id/reset", adminOnly, async (req, res, next) => {
  const t = await findUser(req);
  if (!t) return next();
  const password = crypto.randomBytes(6).toString("base64url");
  await run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(password), t.id);
  await log(req.user.id, "user.reset_password", t.email);
  req.flash("ok", `New temporary password for ${t.email}: ${password}`);
  res.redirect(back(req, "/app/users"));
});

router.post("/users/:id/delete", adminOnly, async (req, res, next) => {
  const t = await findUser(req);
  if (!t) return next();
  const err = await guardSelfOrLastAdmin(req, t, true);
  if (err) { req.flash("err", err); return res.redirect("/app/users"); }
  await run("DELETE FROM users WHERE id = ?", t.id);
  await log(req.user.id, "user.delete", t.email);
  req.flash("ok", `Deleted ${t.email}.`);
  res.redirect("/app/users");
});

router.get("/activity", adminOnly, async (req, res) => {
  const rows = await all("SELECT a.*, u.name, u.email FROM activity a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300");
  res.render("app/activity", { title: "Activity log", rows });
});

/* ---------- Profile ---------- */
router.get("/profile", (req, res) => {
  res.render("app/profile", { title: "My profile", values: req.user, errors: {} });
});

router.post("/profile", async (req, res) => {
  const v = { name: str(req.body.name, 80), phone: str(req.body.phone, 30), email: req.user.email };
  const errors = {};
  if (v.name.length < 2) errors.name = "Enter your full name.";
  if (v.phone && !/^[+\d][\d\s-]{6,19}$/.test(v.phone)) errors.phone = "Enter a valid phone number.";
  if (Object.keys(errors).length) return res.status(400).render("app/profile", { title: "My profile", values: v, errors });
  await run("UPDATE users SET name = ?, phone = ? WHERE id = ?", v.name, v.phone || null, req.user.id);
  req.flash("ok", "Profile saved.");
  res.redirect("/app/profile");
});

router.post("/profile/password", async (req, res) => {
  const row = await one("SELECT password_hash FROM users WHERE id = ?", req.user.id);
  const current = String(req.body.current || ""), next = String(req.body.password || ""), confirm = String(req.body.confirm || "");
  const errors = {};
  if (!verifyPassword(current, row.password_hash)) errors.current = "Current password is not correct.";
  if (next.length < 8) errors.password = "Use at least 8 characters.";
  if (next !== confirm) errors.confirm = "Passwords do not match.";
  if (Object.keys(errors).length) return res.status(400).render("app/profile", { title: "My profile", values: req.user, errors });
  await run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(next), req.user.id);
  await log(req.user.id, "user.change_password", req.user.email);
  req.flash("ok", "Password changed.");
  res.redirect("/app/profile");
});

module.exports = router;
