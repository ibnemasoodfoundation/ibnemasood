/* Signed-in portal: role dashboards, admissions, donations, messages, announcements, users */
"use strict";
const crypto = require("node:crypto");
const express = require("express");
const { one, all, run, log } = require("../db");
const { ROLES, hashPassword, verifyPassword, checkCsrf, requireLogin, requireRole } = require("../auth");
const { BRANCHES, PROGRAMMES, DONATION_KINDS, DONATION_METHODS } = require("../helpers");

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
const count = (sql, ...p) => one(sql, ...p).n;

function announcementsFor(user, limit = 50) {
  return all(
    `SELECT a.*, u.name AS author FROM announcements a LEFT JOIN users u ON u.id = a.author_id
     WHERE a.audience = 'all' OR ? = 1 ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    isStaff(user) ? 1 : 0, limit
  );
}

/* ---------- Overview: one dashboard per role ---------- */
router.get("/", (req, res) => {
  const u = req.user;

  if (u.role === "user") {
    return res.render("app/home-user", {
      title: "My dashboard",
      admissions: all("SELECT * FROM admissions WHERE user_id = ? ORDER BY id DESC LIMIT 5", u.id),
      donations: all("SELECT * FROM donations WHERE user_id = ? ORDER BY id DESC LIMIT 5", u.id),
      given: one("SELECT COALESCE(SUM(amount),0) AS n FROM donations WHERE user_id = ? AND status = 'verified'", u.id).n,
      announcements: announcementsFor(u, 4),
    });
  }

  const stats = {
    pendingAdmissions: count("SELECT COUNT(*) AS n FROM admissions WHERE status = 'pending'"),
    students: count("SELECT COUNT(*) AS n FROM admissions WHERE status = 'approved'"),
    pendingDonations: count("SELECT COUNT(*) AS n FROM donations WHERE status = 'pending'"),
    monthTotal: count(`SELECT COALESCE(SUM(amount),0) AS n FROM donations WHERE status = 'verified'
                       AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`),
    newMessages: count("SELECT COUNT(*) AS n FROM messages WHERE status = 'new'"),
  };
  const byBranch = all(`SELECT branch, COUNT(*) AS n FROM admissions WHERE status = 'approved' GROUP BY branch`);
  const shared = {
    stats,
    byBranch: Object.keys(BRANCHES).map((k) => ({ key: k, n: (byBranch.find((b) => b.branch === k) || {}).n || 0 })),
    recentAdmissions: all("SELECT * FROM admissions WHERE status = 'pending' ORDER BY id DESC LIMIT 6"),
    recentDonations: all("SELECT * FROM donations ORDER BY id DESC LIMIT 6"),
    announcements: announcementsFor(u, 3),
  };

  if (u.role === "manager") return res.render("app/home-manager", { title: "Manager dashboard", ...shared });

  const roleCounts = Object.fromEntries(ROLES.map((r) => [r, count("SELECT COUNT(*) AS n FROM users WHERE role = ?", r)]));
  res.render("app/home-admin", {
    title: "Admin dashboard",
    ...shared,
    roleCounts,
    suspended: count("SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'"),
    newUsers: all("SELECT id, name, email, role, created_at FROM users ORDER BY id DESC LIMIT 6"),
    activity: all(`SELECT a.*, u.name FROM activity a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 8`),
    monthly: all(`SELECT strftime('%Y-%m', created_at) AS m, SUM(amount) AS total FROM donations
                  WHERE status = 'verified' AND created_at >= date('now', 'start of month', '-5 months')
                  GROUP BY m ORDER BY m`),
  });
});

/* ---------- Admissions ---------- */
router.get("/admissions", (req, res) => {
  const u = req.user;
  const status = ["pending", "approved", "waitlisted", "rejected"].includes(req.query.status) ? req.query.status : "";
  const branch = BRANCHES[req.query.branch] ? req.query.branch : "";
  const q = str(req.query.q, 80);
  const where = [], params = [];
  if (!isStaff(u)) { where.push("a.user_id = ?"); params.push(u.id); }
  if (status) { where.push("a.status = ?"); params.push(status); }
  if (branch) { where.push("a.branch = ?"); params.push(branch); }
  if (q) { where.push("(a.student_name LIKE ? OR a.father_name LIKE ? OR a.phone LIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = all(
    `SELECT a.*, u.name AS applicant FROM admissions a JOIN users u ON u.id = a.user_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.id DESC LIMIT 300`, ...params
  );
  res.render("app/admissions", { title: isStaff(u) ? "Admissions" : "My applications", rows, filters: { status, branch, q } });
});

router.get("/admissions/new", (req, res) => {
  res.render("app/admission-form", { title: "New admission application", values: { phone: req.user.phone || "" }, errors: {}, PROGRAMMES });
});

router.post("/admissions", (req, res) => {
  const v = {
    student_name: str(req.body.student_name, 80),
    father_name: str(req.body.father_name, 80),
    dob: str(req.body.dob, 10),
    branch: str(req.body.branch, 10),
    programme: str(req.body.programme, 60),
    phone: str(req.body.phone, 30),
    address: str(req.body.address, 300),
    notes: str(req.body.notes, 1000),
  };
  const errors = {};
  if (v.student_name.length < 2) errors.student_name = "Enter the student's name.";
  if (v.father_name.length < 2) errors.father_name = "Enter the father's or guardian's name.";
  if (v.dob && !/^\d{4}-\d{2}-\d{2}$/.test(v.dob)) errors.dob = "Enter a valid date.";
  if (!BRANCHES[v.branch]) errors.branch = "Choose a branch.";
  else if (!PROGRAMMES[v.branch].includes(v.programme)) errors.programme = "Choose a programme for this branch.";
  if (!/^[+\d][\d\s-]{6,19}$/.test(v.phone)) errors.phone = "Enter a valid phone number.";
  if (Object.keys(errors).length) {
    return res.status(400).render("app/admission-form", { title: "New admission application", values: v, errors, PROGRAMMES });
  }
  const r = run(
    `INSERT INTO admissions (user_id, student_name, father_name, dob, branch, programme, phone, address, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    req.user.id, v.student_name, v.father_name, v.dob || null, v.branch, v.programme, v.phone, v.address || null, v.notes || null
  );
  log(req.user.id, "admission.create", `#${r.lastInsertRowid} ${v.student_name}`);
  req.flash("ok", "Application submitted. The office will review it soon.");
  res.redirect("/app/admissions/" + r.lastInsertRowid);
});

router.get("/admissions/:id", (req, res, next) => {
  const a = one(
    `SELECT a.*, u.name AS applicant, u.email AS applicant_email, r.name AS reviewer
     FROM admissions a JOIN users u ON u.id = a.user_id LEFT JOIN users r ON r.id = a.reviewed_by WHERE a.id = ?`,
    Number(req.params.id)
  );
  if (!a || (!isStaff(req.user) && a.user_id !== req.user.id)) return next();
  res.render("app/admission", { title: "Application #" + a.id, a });
});

router.post("/admissions/:id/review", staff, (req, res, next) => {
  const a = one("SELECT * FROM admissions WHERE id = ?", Number(req.params.id));
  if (!a) return next();
  const status = str(req.body.status, 12);
  if (!["pending", "approved", "waitlisted", "rejected"].includes(status)) return res.redirect(back(req, "/app/admissions"));
  run(
    "UPDATE admissions SET status = ?, review_note = ?, reviewed_by = ?, updated_at = datetime('now') WHERE id = ?",
    status, str(req.body.note, 500) || null, req.user.id, a.id
  );
  log(req.user.id, "admission." + status, `#${a.id} ${a.student_name}`);
  req.flash("ok", `Application #${a.id} marked ${status}.`);
  res.redirect(back(req, "/app/admissions/" + a.id));
});

/* ---------- Donations ---------- */
router.get("/donations", (req, res) => {
  const u = req.user;
  const status = ["pending", "verified", "rejected"].includes(req.query.status) ? req.query.status : "";
  const where = [], params = [];
  if (!isStaff(u)) { where.push("user_id = ?"); params.push(u.id); }
  if (status) { where.push("status = ?"); params.push(status); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = all(`SELECT * FROM donations ${w} ORDER BY id DESC LIMIT 300`, ...params);
  const totals = one(
    `SELECT COALESCE(SUM(CASE WHEN status='verified' THEN amount END),0) AS verified,
            COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) AS pending
     FROM donations ${isStaff(u) ? "" : "WHERE user_id = ?"}`, ...(isStaff(u) ? [] : [u.id])
  );
  res.render("app/donations", { title: isStaff(u) ? "Donations" : "My donations", rows, totals, filters: { status } });
});

router.get("/donations/new", (req, res) => {
  res.render("app/donation-form", { title: "Record a donation", values: { donor_name: req.user.name }, errors: {}, DONATION_KINDS, DONATION_METHODS });
});

router.post("/donations", (req, res) => {
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
  const r = run(
    "INSERT INTO donations (user_id, donor_name, amount, kind, method, reference, status, verified_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    req.user.id, v.donor_name, v.amount, v.kind, v.method, v.reference || null, status, status === "verified" ? req.user.id : null
  );
  log(req.user.id, "donation.create", `#${r.lastInsertRowid} Rs ${v.amount} ${v.kind}`);
  req.flash("ok", status === "verified" ? "Donation recorded and verified." : "JazakAllah khair. Your donation is recorded and will be confirmed by the office.");
  res.redirect("/app/donations");
});

router.post("/donations/:id/status", staff, (req, res, next) => {
  const d = one("SELECT * FROM donations WHERE id = ?", Number(req.params.id));
  if (!d) return next();
  const status = str(req.body.status, 10);
  if (!["pending", "verified", "rejected"].includes(status)) return res.redirect(back(req, "/app/donations"));
  run("UPDATE donations SET status = ?, verified_by = ? WHERE id = ?", status, status === "pending" ? null : req.user.id, d.id);
  log(req.user.id, "donation." + status, `#${d.id} Rs ${d.amount}`);
  req.flash("ok", `Donation #${d.id} marked ${status}.`);
  res.redirect(back(req, "/app/donations"));
});

/* ---------- Contact messages (staff) ---------- */
router.get("/messages", staff, (req, res) => {
  const status = ["new", "read", "closed"].includes(req.query.status) ? req.query.status : "";
  const rows = status
    ? all("SELECT * FROM messages WHERE status = ? ORDER BY id DESC LIMIT 300", status)
    : all("SELECT * FROM messages ORDER BY id DESC LIMIT 300");
  res.render("app/messages", { title: "Messages", rows, filters: { status } });
});

router.post("/messages/:id/status", staff, (req, res, next) => {
  const m = one("SELECT id FROM messages WHERE id = ?", Number(req.params.id));
  if (!m) return next();
  const status = str(req.body.status, 10);
  if (["new", "read", "closed"].includes(status)) run("UPDATE messages SET status = ? WHERE id = ?", status, m.id);
  res.redirect(back(req, "/app/messages"));
});

/* ---------- Announcements ---------- */
router.get("/announcements", (req, res) => {
  res.render("app/announcements", { title: "Announcements", rows: announcementsFor(req.user), values: {}, errors: {} });
});

router.post("/announcements", staff, (req, res) => {
  const v = { title: str(req.body.title, 120), body: str(req.body.body, 4000), audience: req.body.audience === "staff" ? "staff" : "all" };
  const errors = {};
  if (v.title.length < 3) errors.title = "Add a short title.";
  if (v.body.length < 3) errors.body = "Write the announcement.";
  if (Object.keys(errors).length) {
    return res.status(400).render("app/announcements", { title: "Announcements", rows: announcementsFor(req.user), values: v, errors });
  }
  run("INSERT INTO announcements (title, body, audience, author_id) VALUES (?, ?, ?, ?)", v.title, v.body, v.audience, req.user.id);
  log(req.user.id, "announcement.create", v.title);
  req.flash("ok", "Announcement posted.");
  res.redirect("/app/announcements");
});

router.post("/announcements/:id/delete", staff, (req, res, next) => {
  const a = one("SELECT * FROM announcements WHERE id = ?", Number(req.params.id));
  if (!a) return next();
  if (req.user.role !== "admin" && a.author_id !== req.user.id) {
    req.flash("err", "Only the author or an admin can remove this announcement.");
    return res.redirect("/app/announcements");
  }
  run("DELETE FROM announcements WHERE id = ?", a.id);
  log(req.user.id, "announcement.delete", a.title);
  req.flash("ok", "Announcement removed.");
  res.redirect("/app/announcements");
});

/* ---------- Users (admin) ---------- */
router.get("/users", adminOnly, (req, res) => {
  const role = ROLES.includes(req.query.role) ? req.query.role : "";
  const q = str(req.query.q, 80);
  const where = [], params = [];
  if (role) { where.push("role = ?"); params.push(role); }
  if (q) { where.push("(name LIKE ? OR email LIKE ? OR phone LIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = all(
    `SELECT id, name, email, phone, role, status, created_at, last_login FROM users
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 500`, ...params
  );
  res.render("app/users", { title: "Users & roles", rows, filters: { role, q }, values: {}, errors: {} });
});

router.post("/users", adminOnly, (req, res) => {
  const v = {
    name: str(req.body.name, 80),
    email: str(req.body.email, 120).toLowerCase(),
    phone: str(req.body.phone, 30),
    role: ROLES.includes(req.body.role) ? req.body.role : "user",
  };
  const errors = {};
  if (v.name.length < 2) errors.name = "Enter a name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) errors.email = "Enter a valid email.";
  else if (one("SELECT id FROM users WHERE email = ?", v.email)) errors.email = "This email is already registered.";
  if (Object.keys(errors).length) {
    const rows = all("SELECT id, name, email, phone, role, status, created_at, last_login FROM users ORDER BY id DESC LIMIT 500");
    return res.status(400).render("app/users", { title: "Users & roles", rows, filters: {}, values: v, errors, openForm: true });
  }
  const password = crypto.randomBytes(6).toString("base64url");
  run("INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)",
    v.name, v.email, v.phone || null, hashPassword(password), v.role);
  log(req.user.id, "user.create", `${v.email} as ${v.role}`);
  req.flash("ok", `Account created for ${v.email}. Temporary password: ${password}`);
  res.redirect("/app/users");
});

function guardSelfOrLastAdmin(req, target, changingAway) {
  if (target.id === req.user.id) return "You cannot change or remove your own admin account here.";
  if (target.role === "admin" && changingAway && count("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'") <= 1) {
    return "At least one active admin must remain.";
  }
  return null;
}

router.post("/users/:id", adminOnly, (req, res, next) => {
  const t = one("SELECT * FROM users WHERE id = ?", Number(req.params.id));
  if (!t) return next();
  const role = ROLES.includes(req.body.role) ? req.body.role : t.role;
  const status = ["active", "suspended"].includes(req.body.status) ? req.body.status : t.status;
  const err = guardSelfOrLastAdmin(req, t, role !== "admin" || status !== "active");
  if (err) { req.flash("err", err); return res.redirect(back(req, "/app/users")); }
  run("UPDATE users SET role = ?, status = ? WHERE id = ?", role, status, t.id);
  log(req.user.id, "user.update", `${t.email}: ${t.role}/${t.status} → ${role}/${status}`);
  req.flash("ok", `${t.name} is now ${role}, ${status}.`);
  res.redirect(back(req, "/app/users"));
});

router.post("/users/:id/reset", adminOnly, (req, res, next) => {
  const t = one("SELECT * FROM users WHERE id = ?", Number(req.params.id));
  if (!t) return next();
  const password = crypto.randomBytes(6).toString("base64url");
  run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(password), t.id);
  log(req.user.id, "user.reset_password", t.email);
  req.flash("ok", `New temporary password for ${t.email}: ${password}`);
  res.redirect(back(req, "/app/users"));
});

router.post("/users/:id/delete", adminOnly, (req, res, next) => {
  const t = one("SELECT * FROM users WHERE id = ?", Number(req.params.id));
  if (!t) return next();
  const err = guardSelfOrLastAdmin(req, t, true);
  if (err) { req.flash("err", err); return res.redirect("/app/users"); }
  run("DELETE FROM users WHERE id = ?", t.id);
  log(req.user.id, "user.delete", t.email);
  req.flash("ok", `Deleted ${t.email}.`);
  res.redirect("/app/users");
});

router.get("/activity", adminOnly, (req, res) => {
  const rows = all(`SELECT a.*, u.name, u.email FROM activity a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300`);
  res.render("app/activity", { title: "Activity log", rows });
});

/* ---------- Profile ---------- */
router.get("/profile", (req, res) => {
  res.render("app/profile", { title: "My profile", values: req.user, errors: {} });
});

router.post("/profile", (req, res) => {
  const v = { name: str(req.body.name, 80), phone: str(req.body.phone, 30), email: req.user.email };
  const errors = {};
  if (v.name.length < 2) errors.name = "Enter your full name.";
  if (v.phone && !/^[+\d][\d\s-]{6,19}$/.test(v.phone)) errors.phone = "Enter a valid phone number.";
  if (Object.keys(errors).length) return res.status(400).render("app/profile", { title: "My profile", values: v, errors });
  run("UPDATE users SET name = ?, phone = ? WHERE id = ?", v.name, v.phone || null, req.user.id);
  req.flash("ok", "Profile saved.");
  res.redirect("/app/profile");
});

router.post("/profile/password", (req, res) => {
  const row = one("SELECT password_hash FROM users WHERE id = ?", req.user.id);
  const current = String(req.body.current || ""), next = String(req.body.password || ""), confirm = String(req.body.confirm || "");
  const errors = {};
  if (!verifyPassword(current, row.password_hash)) errors.current = "Current password is not correct.";
  if (next.length < 8) errors.password = "Use at least 8 characters.";
  if (next !== confirm) errors.confirm = "Passwords do not match.";
  if (Object.keys(errors).length) return res.status(400).render("app/profile", { title: "My profile", values: req.user, errors, pwOpen: true });
  run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(next), req.user.id);
  log(req.user.id, "user.change_password", req.user.email);
  req.flash("ok", "Password changed.");
  res.redirect("/app/profile");
});

module.exports = router;
