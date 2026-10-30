/* Supabase (Postgres) connection, schema setup and first-admin seed */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { Pool, types } = require("pg");
const { hashPassword } = require("./auth");

// COUNT() and SUM(integer) come back as int8; amounts here fit safely in a JS number
types.setTypeParser(20, (v) => Number(v));
// Keep DATE columns (date of birth) as plain "YYYY-MM-DD" so no timezone shift
types.setTypeParser(1082, (v) => v);

let pool = null;

function getPool() {
  if (pool) return pool;
  const raw = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!raw) throw Object.assign(new Error("DATABASE_URL is not set"), { setup: true });
  // sslmode in the URL would override the ssl option below, so drop it
  const url = new URL(raw);
  url.searchParams.delete("sslmode");
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  pool = new Pool({
    connectionString: url.toString(),
    ssl: local ? false : { rejectUnauthorized: false },
    max: process.env.VERCEL ? 2 : 10,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
  pool.on("error", (err) => console.error("Postgres pool error:", err.message));
  return pool;
}

/* Queries are written with ? placeholders and converted to $1, $2, ... */
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => "$" + ++i);
}

async function all(sql, ...params) { return (await getPool().query(toPg(sql), params)).rows; }
async function one(sql, ...params) { return (await all(sql, ...params))[0]; }
async function run(sql, ...params) { return getPool().query(toPg(sql), params); }

async function log(userId, action, detail) {
  await run("INSERT INTO activity (user_id, action, detail) VALUES (?, ?, ?)", userId ?? null, action, detail ?? null);
}

/* Create the first admin if there is none yet */
async function seedAdmin() {
  if (await one("SELECT id FROM users WHERE role = 'admin' LIMIT 1")) return;
  const email = (process.env.ADMIN_EMAIL || "admin@jaabm.com").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.warn("No admin account yet. Set ADMIN_EMAIL and ADMIN_PASSWORD to create one.");
    return;
  }
  const existing = await one("SELECT id FROM users WHERE email = ?", email);
  if (existing) await run("UPDATE users SET role = 'admin', status = 'active' WHERE id = ?", existing.id);
  else await run("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
    process.env.ADMIN_NAME || "Administrator", email, hashPassword(password));
  await log(null, "seed.admin", email);
  console.log("First admin account ready: " + email);
}

/* Runs once per server instance: create tables (safe to repeat), then seed */
let readyPromise = null;
function ready() {
  if (!readyPromise) {
    const schema = fs.readFileSync(path.join(__dirname, "..", "supabase", "schema.sql"), "utf8");
    readyPromise = getPool().query(schema).then(seedAdmin).catch((err) => {
      readyPromise = null; // try again on the next request
      throw err;
    });
  }
  return readyPromise;
}

module.exports = { one, all, run, log, ready };
