/* Backup and restore (Super Admin only).
   Export: one JSON file with every table (and optionally every uploaded photo/document), to keep safe or to move
   the portal to another server or to a local computer. Import: restores such a file into this server's database,
   either merging (add or update by id) or replacing everything, inside one transaction. */
"use strict";
const crypto = require("node:crypto");
const express = require("express");
const multer = require("multer");
const { one, all, log, execScript } = require("../db");
const { checkCsrf, requireRole } = require("../auth");
const { readStored, writeStored } = require("../uploads");

const router = express.Router();
const admin = [requireRole("admin"), checkCsrf];

// Parents before children, so foreign keys are satisfied while rows go in
const TABLES = [
  "users", "branches", "makatib", "schools", "teachers", "admissions", "students", "donations", "messages", "announcements",
  "activity", "attachments", "transfers", "student_progress", "student_attendance", "teacher_attendance",
  "finance_entries", "exams", "results", "certificates",
];
// Columns that point "forwards" (makatib → teachers) are filled in a second pass
const LATE = { makatib: ["primary_teacher_id"] };

async function columnsOf(table) {
  return (await all(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?
    ORDER BY ordinal_position`, table)).map((r) => r.column_name);
}
const q = (name) => `"${name.replace(/"/g, '""')}"`;

router.get("/backup", admin, async (req, res) => {
  const counts = {};
  for (const t of TABLES) counts[t] = (await one(`SELECT COUNT(*) AS n FROM ${q(t)}`)).n;
  const files = (await one("SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM attachments")) || { n: 0, bytes: 0 };
  res.render("app/backup", { title: "Backup", counts, files, TABLES });
});

/* Streams the backup so a large one does not have to fit in memory at once */
router.get("/backup/export", admin, async (req, res) => {
  const withFiles = req.query.files === "1";
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  res.set("Content-Type", "application/json; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="jaabm-backup-${stamp}${withFiles ? "-with-files" : ""}.json"`);
  res.set("Cache-Control", "no-store");
  const migrations = (await all("SELECT name FROM schema_migrations ORDER BY name")).map((r) => r.name);
  res.write(`{"app":"jaabm","version":1,"exported_at":${JSON.stringify(new Date().toISOString())},"migrations":${JSON.stringify(migrations)},"tables":{`);
  for (let i = 0; i < TABLES.length; i++) {
    const rows = await all(`SELECT * FROM ${q(TABLES[i])} ORDER BY id`);
    res.write(`${i ? "," : ""}${JSON.stringify(TABLES[i])}:${JSON.stringify(rows)}`);
  }
  res.write("}");
  if (withFiles) {
    res.write(`,"files":{`);
    let first = true;
    for (const f of await all("SELECT stored_name, mime FROM attachments ORDER BY id")) {
      const buf = await readStored(f.stored_name);
      if (!buf) continue;
      res.write(`${first ? "" : ","}${JSON.stringify(f.stored_name)}:${JSON.stringify({ mime: f.mime, data: buf.toString("base64") })}`);
      first = false;
    }
    res.write("}");
  }
  res.end("}");
  await log(req.user.id, "backup.export", withFiles ? "with files" : "data only");
});

/* ---------- Restore ---------- */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024, files: 1, fields: 5 } }).single("file");

router.post("/backup/import", requireRole("admin"), (req, res, next) => upload(req, res, (err) => {
  if (err) { req.flash("err", err.code === "LIMIT_FILE_SIZE" ? "That backup file is too large." : "The file could not be read."); return res.redirect("/app/backup"); }
  next();
}), checkCsrf, async (req, res) => {
  const fail = (msg) => { req.flash("err", msg); res.redirect("/app/backup"); };
  if (!req.file) return fail("Choose a backup file (.json) exported from this portal.");
  let data;
  try { data = JSON.parse(req.file.buffer.toString("utf8")); } catch { return fail("This is not a valid backup file."); }
  if (!data || data.app !== "jaabm" || typeof data.tables !== "object") return fail("This file is not a backup from this portal.");
  const replace = req.body.mode === "replace";
  if (replace && String(req.body.confirm || "").trim().toUpperCase() !== "REPLACE") return fail('To replace everything, type REPLACE in the box.');
  const users = Array.isArray(data.tables.users) ? data.tables.users : [];
  if (replace && !users.some((u) => u.role === "admin" && u.status === "active")) return fail("This backup has no active admin account, so replacing would lock everyone out. Nothing was changed.");

  // Rows go in as JSON inside a dollar-quoted literal; the tag is random so the data can never close it
  const tag = "$jb" + crypto.randomBytes(6).toString("hex") + "$";
  const lit = (rows) => `${tag}${JSON.stringify(rows)}${tag}::jsonb`;
  const parts = ["BEGIN;"];
  if (replace) parts.push(`TRUNCATE ${TABLES.map(q).join(", ")} RESTART IDENTITY CASCADE;`);
  const late = [];
  let total = 0;
  for (const t of TABLES) {
    const rows = Array.isArray(data.tables[t]) ? data.tables[t] : [];
    if (!rows.length) continue;
    const have = new Set(await columnsOf(t));
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => have.has(c));
    if (!cols.includes("id")) continue;
    const lateCols = (LATE[t] || []).filter((c) => cols.includes(c));
    const sel = cols.map((c) => (lateCols.includes(c) ? `NULL AS ${q(c)}` : `x.${q(c)}`)).join(", ");
    const upd = cols.filter((c) => c !== "id").map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(", ");
    parts.push(`INSERT INTO ${q(t)} (${cols.map(q).join(", ")}) SELECT ${sel} FROM jsonb_populate_recordset(NULL::${q(t)}, ${lit(rows)}) x
      ON CONFLICT (id) DO ${upd ? "UPDATE SET " + upd : "NOTHING"};`);
    if (lateCols.length) {
      late.push(`UPDATE ${q(t)} t SET ${lateCols.map((c) => `${q(c)} = x.${q(c)}`).join(", ")}
        FROM jsonb_populate_recordset(NULL::${q(t)}, ${lit(rows.map((r) => Object.fromEntries([["id", r.id], ...lateCols.map((c) => [c, r[c] ?? null])])))}) x WHERE t.id = x.id;`);
    }
    total += rows.length;
  }
  parts.push(...late);
  // New records continue numbering after the restored ones
  for (const t of TABLES) {
    parts.push(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${q(t)}), 0), 1), (SELECT COUNT(*) > 0 FROM ${q(t)}));`);
  }
  parts.push("COMMIT;");
  try {
    await execScript(parts.join("\n"));
  } catch (err) {
    const code = typeof err?.code === "string" ? err.code : "";
    return fail(`Restore failed and nothing was changed${code ? ` (database code ${code})` : ""}. ${code === "23505" ? "Some records clash with existing ones (same email or code with a different id): use “Replace everything” to restore onto a new server." : ""}`);
  }

  let restoredFiles = 0;
  if (data.files && typeof data.files === "object") {
    for (const [name, f] of Object.entries(data.files)) {
      try { if (f && f.data && await writeStored(name, Buffer.from(f.data, "base64"), f.mime)) restoredFiles++; } catch { /* keep going */ }
    }
  }
  await log(req.user.id, replace ? "backup.restore_replace" : "backup.restore_merge", `${total} records, ${restoredFiles} files`);
  req.flash("ok", `Backup restored: ${total} records${restoredFiles ? ` and ${restoredFiles} files` : ""}${replace ? ". Everything was replaced: sign in with an account from the backup." : "."}`);
  // After a full replace the account numbers come from the backup, so this sign-in no longer means the same person
  if (replace) { req.session.uid = null; return res.redirect("/login"); }
  res.redirect("/app/backup");
});

module.exports = router;
