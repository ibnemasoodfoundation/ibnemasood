/* SQLite database (built into Node 22.13+), schema and first-admin seed */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { hashPassword } = require("./auth");

const dbPath = path.resolve(process.env.DB_PATH || path.join(__dirname, "..", "data", "jaabm.db"));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','manager','user')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login    TEXT
);

CREATE TABLE IF NOT EXISTS admissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_name TEXT NOT NULL,
  father_name  TEXT NOT NULL,
  dob          TEXT,
  branch       TEXT NOT NULL CHECK (branch IN ('boys','girls','school')),
  programme    TEXT NOT NULL,
  phone        TEXT NOT NULL,
  address      TEXT,
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','waitlisted','rejected')),
  review_note  TEXT,
  reviewed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS donations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  donor_name  TEXT NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  kind        TEXT NOT NULL,
  method      TEXT NOT NULL,
  reference   TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  topic      TEXT,
  message    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','read','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  audience   TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','staff')),
  author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

function log(userId, action, detail) {
  run("INSERT INTO activity (user_id, action, detail) VALUES (?, ?, ?)", userId ?? null, action, detail ?? null);
}

/* Create the first admin if there is none yet */
function seedAdmin() {
  if (one("SELECT id FROM users WHERE role = 'admin' LIMIT 1")) return;
  const email = (process.env.ADMIN_EMAIL || "admin@jaabm.com").trim().toLowerCase();
  const name = process.env.ADMIN_NAME || "Administrator";
  let password = process.env.ADMIN_PASSWORD;
  const generated = !password;
  if (generated) password = crypto.randomBytes(9).toString("base64url");

  const existing = one("SELECT id FROM users WHERE email = ?", email);
  if (existing) {
    run("UPDATE users SET role = 'admin', status = 'active' WHERE id = ?", existing.id);
  } else {
    run("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')", name, email, hashPassword(password));
  }
  log(null, "seed.admin", email);
  console.log("\n  First admin account ready");
  console.log("  Email:    " + email);
  if (!existing) console.log("  Password: " + password + (generated ? "   (generated, change it after signing in)" : ""));
  console.log("");
}

module.exports = { db, one, all, run, log, seedAdmin };
