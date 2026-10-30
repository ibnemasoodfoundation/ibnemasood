/* Jamia Arabia Abdullah Bin Masood — web app server */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

if (fs.existsSync(path.join(__dirname, ".env"))) process.loadEnvFile(path.join(__dirname, ".env"));

const express = require("express");
const cookieSession = require("cookie-session");
const { one, seedAdmin } = require("./src/db");
const { csrfToken } = require("./src/auth");
const helpers = require("./src/helpers");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === "production";

let secret = process.env.SESSION_SECRET;
if (!secret) {
  if (isProd) { console.error("SESSION_SECRET must be set in production."); process.exit(1); }
  secret = crypto.randomBytes(32).toString("hex");
  console.warn("SESSION_SECRET not set: using a temporary one, everyone is signed out on restart.");
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(express.json({ limit: "50kb" }));
app.use(cookieSession({
  name: "jaabm.sid",
  keys: [secret],
  httpOnly: true,
  sameSite: "lax",
  secure: isProd,
  maxAge: 7 * 24 * 60 * 60 * 1000,
}));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  req.user = null;
  if (req.session.uid) {
    const user = one("SELECT id, name, email, phone, role, status, created_at, last_login FROM users WHERE id = ?", req.session.uid);
    if (user && user.status === "active") req.user = user;
    else req.session.uid = null;
  }
  res.locals.user = req.user;
  res.locals.csrf = csrfToken(req);
  res.locals.path = req.path;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  req.flash = (type, msg) => { req.session.flash = { type, msg }; };
  Object.assign(res.locals, helpers);
  next();
});

app.use("/", require("./src/routes/auth"));
app.use("/api", require("./src/routes/api"));
app.use("/app", require("./src/routes/app"));

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], maxAge: isProd ? "1d" : 0 }));

app.use((req, res) => res.status(404).render("error", { title: "Page not found", message: "We could not find that page." }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render("error", { title: "Something went wrong", message: "Please try again in a moment." });
});

seedAdmin();
app.listen(PORT, () => console.log("JAABM web app running on http://localhost:" + PORT));
