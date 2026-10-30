/* Sign in, sign up, sign out */
"use strict";
const express = require("express");
const { one, run, log } = require("../db");
const {
  hashPassword, verifyPassword, checkCsrf, tooManyAttempts, recordFailure, clearFailures,
} = require("../auth");

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function safeNext(next) {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/app";
}

router.get("/login", (req, res) => {
  if (req.user) return res.redirect("/app");
  res.render("auth/login", { title: "Sign in", values: {}, errors: {}, next: safeNext(req.query.next) });
});

router.post("/login", checkCsrf, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const next = safeNext(req.body.next);
  const key = req.ip + "|" + email;
  const fail = (msg) => res.status(400).render("auth/login", { title: "Sign in", values: { email }, errors: { form: msg }, next });

  if (tooManyAttempts(key)) return fail("Too many attempts. Wait 15 minutes and try again.");
  const user = await one("SELECT * FROM users WHERE email = ?", email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordFailure(key);
    return fail("That email and password do not match an account.");
  }
  if (user.status !== "active") return fail("This account is suspended. Please contact the Jamia office.");

  clearFailures(key);
  await run("UPDATE users SET last_login = now() WHERE id = ?", user.id);
  await log(user.id, "auth.login", user.email);
  req.session.uid = user.id;
  req.flash("ok", "Assalamu Alaikum, " + user.name.split(" ")[0] + ".");
  res.redirect(next);
});

router.get("/signup", (req, res) => {
  if (req.user) return res.redirect("/app");
  res.render("auth/signup", { title: "Create account", values: {}, errors: {} });
});

router.post("/signup", checkCsrf, async (req, res) => {
  const values = {
    name: String(req.body.name || "").trim(),
    email: String(req.body.email || "").trim().toLowerCase(),
    phone: String(req.body.phone || "").trim(),
  };
  const password = String(req.body.password || "");
  const confirm = String(req.body.confirm || "");
  const errors = {};

  if (values.name.length < 2 || values.name.length > 80) errors.name = "Enter your full name.";
  if (!EMAIL_RE.test(values.email) || values.email.length > 120) errors.email = "Enter a valid email address.";
  else if (await one("SELECT id FROM users WHERE email = ?", values.email)) errors.email = "An account with this email already exists.";
  if (values.phone && !/^[+\d][\d\s-]{6,19}$/.test(values.phone)) errors.phone = "Enter a valid phone number.";
  if (password.length < 8) errors.password = "Use at least 8 characters.";
  if (password !== confirm) errors.confirm = "Passwords do not match.";

  if (Object.keys(errors).length) return res.status(400).render("auth/signup", { title: "Create account", values, errors });

  const created = await one(
    "INSERT INTO users (name, email, phone, password_hash, role, last_login) VALUES (?, ?, ?, ?, 'user', now()) RETURNING id",
    values.name, values.email, values.phone || null, hashPassword(password)
  );
  await log(created.id, "auth.signup", values.email);
  req.session.uid = created.id;
  req.flash("ok", "Your account is ready. Welcome to the Jamia portal.");
  res.redirect("/app");
});

router.post("/logout", checkCsrf, async (req, res) => {
  if (req.user) await log(req.user.id, "auth.logout", req.user.email);
  req.session = null;
  res.redirect("/login");
});

module.exports = router;
