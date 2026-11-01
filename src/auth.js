/* Password hashing, session helpers and role guards */
"use strict";
const crypto = require("node:crypto");

const ROLES = ["admin", "manager", "teacher", "user"];

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return "scrypt$" + salt.toString("hex") + "$" + hash.toString("hex");
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/* Per-session token, checked on every POST from the dashboard */
function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(18).toString("base64url");
  return req.session.csrf;
}

function checkCsrf(req, res, next) {
  if (req.method !== "POST") return next();
  const sent = req.body && req.body._csrf;
  const expected = req.session && req.session.csrf;
  if (sent && expected && sent.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) return next();
  res.status(403).render("error", { title: "Session expired", message: "Your form expired. Go back, refresh the page and try again." });
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
}

/* requireRole("admin") or requireRole("admin", "manager") */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
    if (roles.includes(req.user.role)) return next();
    res.status(403).render("error", { title: "Not allowed", message: "Your account does not have access to this page." });
  };
}

/* Simple in-memory limit on failed sign-ins: 8 per 15 minutes per IP + email */
const attempts = new Map();
const WINDOW = 15 * 60 * 1000;
function tooManyAttempts(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW) return false;
  return a.count >= 8;
}
function recordFailure(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW) attempts.set(key, { first: Date.now(), count: 1 });
  else a.count++;
}
function clearFailures(key) { attempts.delete(key); }

module.exports = {
  ROLES, hashPassword, verifyPassword, csrfToken, checkCsrf,
  requireLogin, requireRole, tooManyAttempts, recordFailure, clearFailures,
};
