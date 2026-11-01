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

function logDatabaseError(operation, err) {
  const code = typeof err?.code === "string" && /^[A-Z0-9_]{2,32}$/.test(err.code)
    ? err.code
    : "UNKNOWN";
  console.error(JSON.stringify({ event: "database_error", operation, code }));
}

function setupError(hint) {
  return Object.assign(new Error(hint), { setup: true, code: "CONFIG", hint });
}

/* Turns DATABASE_URL (+ optional DATABASE_PASSWORD) into pg settings,
   catching the common Supabase + Vercel mistakes with a clear hint */
function connectionConfig(env = process.env) {
  const raw = (env.DATABASE_URL || env.POSTGRES_URL || "").trim().replace(/^["']|["']$/g, "");
  if (!raw) throw setupError("DATABASE_URL is not set.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw setupError("DATABASE_URL is not a valid URL. If the password has characters like @ # / ? %, keep [YOUR-PASSWORD] in the URL and put the real password in DATABASE_PASSWORD.");
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw setupError("DATABASE_URL must start with postgresql://");

  // A separate password avoids URL-encoding problems; pg decodes it again
  if (env.DATABASE_PASSWORD) url.password = encodeURIComponent(env.DATABASE_PASSWORD);
  else if (/YOUR-PASSWORD/i.test(decodeURIComponent(url.password))) {
    throw setupError("DATABASE_URL still contains [YOUR-PASSWORD]. Put the real database password in the URL or in DATABASE_PASSWORD.");
  }

  // Supabase's direct host (db.<ref>.supabase.co) is IPv6-only; Vercel cannot reach it
  if (env.VERCEL && /^db\.[a-z0-9]+\.supabase\.co$/i.test(url.hostname)) {
    throw setupError("DATABASE_URL uses Supabase's direct connection (db.….supabase.co), which Vercel cannot reach. Use the Transaction pooler URL (….pooler.supabase.com:6543) from Supabase > Connect.");
  }
  // The shared pooler needs the project ref in the user name: postgres.<ref>
  if (/\.pooler\.supabase\.com$/i.test(url.hostname) && !decodeURIComponent(url.username).includes(".")) {
    throw setupError("For the Supabase pooler the user name must be postgres.<project-ref>, e.g. postgres.vrowqvxbwiwtdxtwepdt.");
  }

  // sslmode / pgbouncer in the URL would override or confuse the options below
  url.searchParams.delete("sslmode");
  url.searchParams.delete("pgbouncer");
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  return { connectionString: url.toString(), ssl: local ? false : { rejectUnauthorized: false } };
}

function getPool() {
  if (pool) return pool;
  pool = new Pool({
    ...connectionConfig(),
    max: process.env.VERCEL ? 2 : 10,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
  pool.on("error", (err) => logDatabaseError("pool", err));
  return pool;
}

/* Queries are written with ? placeholders and converted to $1, $2, ... */
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => "$" + ++i);
}

async function query(operation, sql, params) {
  try {
    return await getPool().query(sql, params);
  } catch (err) {
    logDatabaseError(operation, err);
    throw err;
  }
}

async function all(sql, ...params) { return (await query("query", toPg(sql), params)).rows; }
async function one(sql, ...params) { return (await all(sql, ...params))[0]; }
async function run(sql, ...params) { return query("query", toPg(sql), params); }

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
    readyPromise = Promise.resolve()
      .then(() => {
        const schema = fs.readFileSync(path.join(__dirname, "..", "supabase", "schema.sql"), "utf8");
        return getPool().query(schema);
      })
      .then(seedAdmin)
      .catch((err) => {
        logDatabaseError("schema_init", err);
        readyPromise = null; // try again on the next request
        throw err;
      });
  }
  return readyPromise;
}

/* Plain-language fixes for the errors people hit when connecting Vercel to Supabase */
const HINTS = {
  "28P01": "Supabase rejected the database password. Check the password in DATABASE_URL (or set DATABASE_PASSWORD). Reset it in Supabase > Project Settings > Database if unsure.",
  XX000: "Supabase did not recognise the user name. With the pooler it must be postgres.<project-ref>.",
  ENOTFOUND: "The database host name could not be found. Copy the Transaction pooler URL again from Supabase > Connect.",
  ENETUNREACH: "The database address is not reachable from here (usually the IPv6-only direct host). Use the Transaction pooler URL.",
  ETIMEDOUT: "The connection timed out. Use the Transaction pooler URL (port 6543) and check the Supabase project is not paused.",
  ECONNREFUSED: "The database refused the connection. Check the host and port (6543 for the Transaction pooler).",
};

/* Used by /api/health: never returns secrets, only a code and a hint */
async function health() {
  try {
    await ready();
    await getPool().query("SELECT 1");
    const admins = await one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
    return { ok: true, admin: admins.n > 0 };
  } catch (err) {
    const code = typeof err?.code === "string" && /^[A-Z0-9_]{2,32}$/.test(err.code) ? err.code : "UNKNOWN";
    const timeout = /timeout/i.test(err?.message || "");
    return { ok: false, code: timeout && code === "UNKNOWN" ? "ETIMEDOUT" : code, hint: err.hint || HINTS[code] || (timeout ? HINTS.ETIMEDOUT : "Check DATABASE_URL in Vercel and redeploy.") };
  }
}

module.exports = { one, all, run, log, ready, health, connectionConfig, logDatabaseError };
