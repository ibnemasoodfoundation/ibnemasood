/* Jamia Arabia Abdullah Bin Masood — web app server.
   Runs locally with `npm start`, and on Vercel through api/index.js. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// .env is for local runs only; on Vercel the dashboard's Environment Variables are the source of truth
if (!process.env.VERCEL && fs.existsSync(path.join(__dirname, ".env"))) process.loadEnvFile(path.join(__dirname, ".env"));

const express = require("express");
const cookieSession = require("cookie-session");
const { one, ready, health } = require("./src/db");
const { csrfToken } = require("./src/auth");
const helpers = require("./src/helpers");

const app = express();
const isProd = process.env.NODE_ENV === "production";

let secret = process.env.SESSION_SECRET;
if (!secret && !isProd) {
  secret = crypto.randomBytes(32).toString("hex");
  console.warn("SESSION_SECRET not set: using a temporary one, everyone is signed out on restart.");
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", 1);
app.disable("x-powered-by");

// Website pages, CSS and images never need the database, so serve them first.
// On Vercel the public/ folder is served by the CDN; this covers local runs.
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], maxAge: isProd ? "1d" : 0 }));

/* Missing settings on the host: say exactly what to add instead of crashing */
const missing = [];
if (!secret) missing.push("SESSION_SECRET");
if (missing.length) console.error("Missing environment variables: " + missing.join(", "));

/* Setup check for the site owner: open /api/health after each deploy */
app.get("/api/health", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (missing.length) return res.status(500).json({ ok: false, missing, hint: "Add these in Vercel > Settings > Environment Variables, then redeploy." });
  const db = await health();
  res.status(db.ok ? 200 : 500).json({ ok: db.ok, database: db });
});

app.use((req, res, next) => {
  if (!missing.length) return next();
  res.status(500).type("text").send(
    "The portal is not configured yet.\n\nAdd these Environment Variables in Vercel (Project > Settings > Environment Variables), then redeploy:\n  " +
    missing.join("\n  ")
  );
});

app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(express.json({ limit: "50kb" }));
app.use(cookieSession({
  name: "jaabm.sid",
  keys: [secret || "unset"],
  httpOnly: true,
  sameSite: "lax",
  secure: isProd,
  maxAge: 7 * 24 * 60 * 60 * 1000,
}));

app.use(async (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  Object.assign(res.locals, helpers);
  res.locals.user = null;

  await ready();
  req.user = null;
  if (req.session.uid) {
    const user = await one("SELECT id, name, email, phone, role, status, created_at, last_login FROM users WHERE id = ?", req.session.uid);
    if (user && user.status === "active") req.user = user;
    else req.session.uid = null;
  }
  res.locals.user = req.user;
  res.locals.csrf = csrfToken(req);
  res.locals.path = req.path;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  req.flash = (type, msg) => { req.session.flash = { type, msg }; };
  next();
});

app.use("/", require("./src/routes/auth"));
app.use("/api", require("./src/routes/api"));
app.use("/app", require("./src/routes/app"));


app.use((req, res) => res.status(404).render("error", { title: "Page not found", message: "We could not find that page." }));
app.use((err, req, res, next) => {
  const errorName = typeof err?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(err.name)
    ? err.name
    : "Error";
  console.error(JSON.stringify({ event: "request_error", name: errorName }));
  const message = /ECONNREFUSED|ENOTFOUND|password authentication|timeout/i.test(err.message)
    ? "The portal cannot reach its database right now. Please try again shortly. (Site admin: open /api/health for the reason.)"
    : "Please try again in a moment.";
  res.status(500).render("error", { title: "Something went wrong", message });
});

module.exports = app;

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, () => console.log("JAABM web app running on http://localhost:" + PORT));
}
