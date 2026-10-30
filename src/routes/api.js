/* Small JSON endpoints used by the public pages */
"use strict";
const express = require("express");
const { run } = require("../db");

const router = express.Router();

/* Lets the static pages show "Dashboard" instead of "Sign in" */
router.get("/me", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ user: req.user ? { name: req.user.name, role: req.user.role } : null });
});

/* Contact form: saved for staff, then the page still opens WhatsApp */
router.post("/contact", async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim().slice(0, 80);
  const phone = String(b.phone || "").trim().slice(0, 30);
  const topic = String(b.topic || "").trim().slice(0, 80);
  const message = String(b.message || "").trim().slice(0, 4000);
  if (!name || !phone || !message) return res.status(400).json({ ok: false });
  await run("INSERT INTO messages (name, phone, topic, message) VALUES (?, ?, ?, ?)", name, phone, topic, message);
  res.json({ ok: true });
});

module.exports = router;
