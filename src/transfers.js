/* Moving a teacher or student to another Maktab or branch, with a history record */
"use strict";
const { one, run, log } = require("./db");

/* toMaktabId: target Maktab (null = take them out of their Maktab).
   toBranchId: only used when there is no Maktab (a branch-level placement). */
async function movePerson(type, personId, toMaktabId, note, userId, toBranchId = null) {
  const table = type === "teacher" ? "teachers" : "students";
  const person = await one(`SELECT id, maktab_id, branch_id, full_name FROM ${table} WHERE id = ?`, personId);
  if (!person) return { error: "Record not found." };
  let target = null;
  if (toMaktabId) {
    target = await one("SELECT id, branch_id, name_en, status FROM makatib WHERE id = ?", toMaktabId);
    if (!target || target.status === "archived") return { error: "Choose an active Maktab." };
  }
  const newBranch = target ? target.branch_id : (toBranchId ?? person.branch_id);
  if ((person.maktab_id || null) === (target ? target.id : null) && (person.branch_id || null) === (newBranch || null)) {
    return { error: `${person.full_name} is already there.` };
  }
  await run(`UPDATE ${table} SET maktab_id = ?, branch_id = ? WHERE id = ?`, target ? target.id : null, newBranch || null, person.id);
  await run(`INSERT INTO transfers (person_type, person_id, from_maktab_id, to_maktab_id, note, transferred_by)
             VALUES (?, ?, ?, ?, ?, ?)`, type, person.id, person.maktab_id, target ? target.id : null, note || null, userId);
  const branch = !target && newBranch ? await one("SELECT name_en FROM branches WHERE id = ?", newBranch) : null;
  const where = target ? target.name_en : branch ? branch.name_en + " (no Maktab)" : "no Maktab";
  await log(userId, type + ".transfer", `${person.full_name} → ${where}`);
  return { ok: `${person.full_name} moved to ${where}.` };
}

module.exports = { movePerson };
