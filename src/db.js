/* Database: local Postgres (PGlite, saved in ./data/pgdata) for development.
   Set DATABASE_URL to use any hosted Postgres instead; the SQL is the same. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { hashPassword } = require("./auth");

const SCHEMA = path.join(__dirname, "..", "db", "schema.sql");

// COUNT() and SUM(integer) come back as int8 (type 20); amounts fit safely in a JS number.
// DATE (type 1082) stays "YYYY-MM-DD" so dates of birth never shift with time zones.
const PARSERS = { 20: Number, 1082: (v) => v };

function logDatabaseError(operation, err) {
  const code = typeof err?.code === "string" && /^[A-Z0-9_]{2,32}$/.test(err.code)
    ? err.code
    : "UNKNOWN";
  console.error(JSON.stringify({ event: "database_error", operation, code }));
}

/* One client per process: { query(sql, params) -> rows, exec(sql) } */
let clientPromise = null;
function getClient() {
  if (!clientPromise) clientPromise = (process.env.DATABASE_URL ? postgresClient() : localClient()).catch((err) => {
    clientPromise = null;
    throw err;
  });
  return clientPromise;
}

async function localClient() {
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = path.resolve(process.env.DB_DIR || path.join(__dirname, "..", "data", "pgdata"));
  fs.mkdirSync(dir, { recursive: true });
  const db = await PGlite.create(dir, { parsers: PARSERS });
  return {
    query: async (sql, params) => (await db.query(sql, params)).rows,
    exec: (sql) => db.exec(sql),
  };
}

async function postgresClient() {
  const { Pool, types } = require("pg");
  for (const [oid, fn] of Object.entries(PARSERS)) types.setTypeParser(Number(oid), fn);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.delete("sslmode"); // would override the ssl option below
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  const pool = new Pool({
    connectionString: url.toString(),
    ssl: local ? false : { rejectUnauthorized: false },
    max: process.env.VERCEL ? 2 : 10,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
  pool.on("error", (err) => logDatabaseError("pool", err));
  return {
    query: async (sql, params) => (await pool.query(sql, params)).rows,
    exec: (sql) => pool.query(sql),
  };
}

/* Queries are written with ? placeholders and converted to $1, $2, ... */
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => "$" + ++i);
}

async function all(sql, ...params) {
  try {
    return await (await getClient()).query(toPg(sql), params);
  } catch (err) {
    logDatabaseError("query", err);
    throw err;
  }
}
async function one(sql, ...params) { return (await all(sql, ...params))[0]; }
const run = all;

async function log(userId, action, detail) {
  await run("INSERT INTO activity (user_id, action, detail) VALUES (?, ?, ?)", userId ?? null, action, detail ?? null);
}

/* Create the first admin if there is none yet */
async function seedAdmin() {
  if (await one("SELECT id FROM users WHERE role = 'admin' LIMIT 1")) return;
  const email = (process.env.ADMIN_EMAIL || "admin@jaabm.com").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.warn("No admin account yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env to create one.");
    return;
  }
  const existing = await one("SELECT id FROM users WHERE email = ?", email);
  if (existing) await run("UPDATE users SET role = 'admin', status = 'active' WHERE id = ?", existing.id);
  else await run("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
    process.env.ADMIN_NAME || "Administrator", email, hashPassword(password));
  await log(null, "seed.admin", email);
  console.log("First admin account ready: " + email);
}

/* Runs once per server: create missing tables (never drops or changes data), then seed */
let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = getClient()
      .then((db) => db.exec(fs.readFileSync(SCHEMA, "utf8")))
      .then(seedAdmin)
      .catch((err) => {
        logDatabaseError("schema_init", err);
        readyPromise = null; // try again on the next request
        throw err;
      });
  }
  return readyPromise;
}

/* Used by /api/health: never returns secrets, only status and an error code */
async function health() {
  try {
    await ready();
    const admins = await one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
    return { ok: true, engine: process.env.DATABASE_URL ? "postgres" : "local", admin: admins.n > 0 };
  } catch (err) {
    const code = typeof err?.code === "string" && /^[A-Z0-9_]{2,32}$/.test(err.code) ? err.code : "UNKNOWN";
    return { ok: false, code };
  }
}

module.exports = { one, all, run, log, ready, health, logDatabaseError };
