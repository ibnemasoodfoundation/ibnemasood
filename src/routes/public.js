/* Public website pages backed by the database: Makatib and branch directories, gallery.
   Only approved information is selected: names, area, programmes, the contact number when
   "show publicly" is ticked, and photos approved for the website. Never addresses, managers,
   notes, teachers, students or documents. */
"use strict";
const express = require("express");
const { one, all } = require("../db");
const { filePath } = require("../uploads");

const router = express.Router();
const str = (v, max = 80) => String(v ?? "").trim().slice(0, max);
const like = (q) => `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;

// Figures approved by the Jamia; shown until the directory holds every Maktab
const APPROVED = { makatib: 190, students: 5000 };

const PUBLIC_MAKTAB = `m.status = 'active' AND m.public_listing AND (m.branch_id IS NULL OR b.status <> 'archived')`;
const MAKTAB_COLS = `m.id, m.code, m.name_en, m.name_ur, m.district, m.tehsil, m.town, m.programmes,
  CASE WHEN m.show_phone THEN m.phone END AS phone, b.code AS branch_code, b.name_en AS branch, b.name_ur AS branch_ur`;
const coverPhoto = (type, alias) => `(SELECT a.id FROM attachments a WHERE a.entity_type = '${type}' AND a.entity_id = ${alias}.id
  AND a.is_public AND a.kind = 'photo' ORDER BY a.id DESC LIMIT 1) AS photo_id`;
const publicPhotos = (type, id) => all(`SELECT id, caption FROM attachments
  WHERE entity_type = ? AND entity_id = ? AND is_public AND kind = 'photo' ORDER BY id DESC`, type, id);

const notFound = (res) => res.status(404).render("error", { title: "Page not found", message: "We could not find that page." });

/* ---------- Makatib directory ---------- */
router.get("/makatib", async (req, res) => {
  const f = { q: str(req.query.q), district: str(req.query.district), branch: str(req.query.branch, 20).toUpperCase() };
  const where = [PUBLIC_MAKTAB], p = [];
  if (f.q) { where.push("(m.name_en ILIKE ? OR m.name_ur ILIKE ? OR m.town ILIKE ? OR m.tehsil ILIKE ? OR m.district ILIKE ?)"); p.push(like(f.q), like(f.q), like(f.q), like(f.q), like(f.q)); }
  if (f.district) { where.push("m.district = ?"); p.push(f.district); }
  if (f.branch) { where.push("b.code = ?"); p.push(f.branch); }
  const [rows, districts, branches, listed] = await Promise.all([
    all(`SELECT ${MAKTAB_COLS}, ${coverPhoto("maktab", "m")} FROM makatib m LEFT JOIN branches b ON b.id = m.branch_id
         WHERE ${where.join(" AND ")} ORDER BY m.district, m.town NULLS LAST, m.name_en LIMIT 500`, ...p),
    all(`SELECT DISTINCT m.district FROM makatib m LEFT JOIN branches b ON b.id = m.branch_id WHERE ${PUBLIC_MAKTAB} ORDER BY 1`),
    all("SELECT code, name_en FROM branches WHERE status = 'active' AND public_listing ORDER BY name_en"),
    one(`SELECT COUNT(*) AS n FROM makatib m LEFT JOIN branches b ON b.id = m.branch_id WHERE ${PUBLIC_MAKTAB}`),
  ]);
  res.render("public/makatib", {
    title: "Makatib directory", navOn: "makatib", rows, f, districts: districts.map((d) => d.district), branches, listed: listed.n, APPROVED,
  });
});

router.get("/makatib/:code", async (req, res) => {
  const code = str(req.params.code, 20).toUpperCase();
  if (!CODE_RE.test(code)) return notFound(res);
  const m = await one(`SELECT ${MAKTAB_COLS}, m.branch_id FROM makatib m LEFT JOIN branches b ON b.id = m.branch_id
                       WHERE m.code = ? AND ${PUBLIC_MAKTAB}`, code);
  if (!m) return notFound(res);
  const [photos, nearby] = await Promise.all([
    publicPhotos("maktab", m.id),
    m.branch_id ? all(`SELECT m.code, m.name_en, m.town FROM makatib m LEFT JOIN branches b ON b.id = m.branch_id
                       WHERE m.branch_id = ? AND m.id <> ? AND ${PUBLIC_MAKTAB} ORDER BY m.name_en LIMIT 12`, m.branch_id, m.id) : [],
  ]);
  res.render("public/maktab", { title: m.name_en, navOn: "makatib", m, photos, nearby });
});

/* ---------- Branch directory ---------- */
const PUBLIC_BRANCH = "b.status = 'active' AND b.public_listing";
const BRANCH_COLS = `b.id, b.code, b.name_en, b.name_ur, b.district, b.tehsil, b.town, b.programmes, CASE WHEN b.show_phone THEN b.phone END AS phone`;

router.get("/branches", async (req, res) => {
  const rows = await all(`SELECT ${BRANCH_COLS}, ${coverPhoto("branch", "b")},
      (SELECT COUNT(*) FROM makatib m WHERE m.branch_id = b.id AND m.status = 'active' AND m.public_listing) AS makatib
    FROM branches b WHERE ${PUBLIC_BRANCH} ORDER BY b.district, b.name_en`);
  res.render("public/branches", { title: "Branches", navOn: "makatib", rows, APPROVED });
});

router.get("/branches/:code", async (req, res) => {
  const code = str(req.params.code, 20).toUpperCase();
  if (!CODE_RE.test(code)) return notFound(res);
  const b = await one(`SELECT ${BRANCH_COLS} FROM branches b WHERE b.code = ? AND ${PUBLIC_BRANCH}`, code);
  if (!b) return notFound(res);
  const [photos, makatib] = await Promise.all([
    publicPhotos("branch", b.id),
    all(`SELECT ${MAKTAB_COLS}, ${coverPhoto("maktab", "m")} FROM makatib m LEFT JOIN branches b ON b.id = m.branch_id
         WHERE m.branch_id = ? AND ${PUBLIC_MAKTAB} ORDER BY m.town NULLS LAST, m.name_en`, b.id),
  ]);
  res.render("public/branch", { title: b.name_en, navOn: "makatib", b, photos, makatib });
});

/* ---------- Gallery ---------- */
router.get("/gallery", async (req, res) => {
  const photos = await all(`SELECT a.id, a.caption, a.entity_type, COALESCE(m.name_en, b.name_en) AS place,
      COALESCE(m.code, b.code) AS code
    FROM attachments a
    LEFT JOIN makatib m ON a.entity_type = 'maktab' AND m.id = a.entity_id AND m.status = 'active' AND m.public_listing
    LEFT JOIN branches b ON a.entity_type = 'branch' AND b.id = a.entity_id AND b.status = 'active' AND b.public_listing
    WHERE a.is_public AND a.kind = 'photo' AND (m.id IS NOT NULL OR b.id IS NOT NULL)
    ORDER BY a.id DESC LIMIT 200`);
  res.render("public/gallery", { title: "Gallery", navOn: "gallery", photos });
});

/* ---------- Approved photos only ---------- */
router.get("/media/:id", async (req, res) => {
  const id = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : null;
  const f = id && await one(`SELECT a.stored_name, a.mime FROM attachments a
    LEFT JOIN makatib m ON a.entity_type = 'maktab' AND m.id = a.entity_id AND m.status = 'active' AND m.public_listing
    LEFT JOIN branches b ON a.entity_type = 'branch' AND b.id = a.entity_id AND b.status = 'active' AND b.public_listing
    WHERE a.id = ? AND a.is_public AND a.kind = 'photo' AND (m.id IS NOT NULL OR b.id IS NOT NULL)`, id);
  const p = f && filePath(f.stored_name);
  if (!p) return res.status(404).end();
  res.set("Cache-Control", "public, max-age=86400");
  res.type(f.mime).sendFile(p, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

module.exports = router;
