/* Who can see and change what. Enforced on the server for every request.

   admin   (Super Administrator) — everything
   manager (Branch Manager / Administrator) — the branches they manage (branches.manager_id),
           every Maktab in those branches, and any Maktab they manage directly (makatib.manager_id)
   teacher — their own teacher record, their Maktab, and students in that Maktab or assigned to them
   user    (member) — none of the institution data */
"use strict";
const { one, all } = require("./db");

async function loadScope(user) {
  if (!user) return { none: true, branchIds: [], maktabIds: [] };
  if (user.role === "admin") return { all: true, canManage: true };
  if (user.role === "manager") {
    const branchIds = (await all("SELECT id FROM branches WHERE manager_id = ?", user.id)).map((r) => r.id);
    const maktabIds = (await all(
      `SELECT id FROM makatib WHERE manager_id = ?${branchIds.length ? ` OR branch_id IN (${ids(branchIds)})` : ""}`, user.id
    )).map((r) => r.id);
    return { branchIds, maktabIds, canManage: true };
  }
  if (user.role === "teacher") {
    const t = await one("SELECT id, maktab_id FROM teachers WHERE user_id = ?", user.id);
    return { teacherId: t ? t.id : null, branchIds: [], maktabIds: t && t.maktab_id ? [t.maktab_id] : [], canManage: false };
  }
  return { none: true, branchIds: [], maktabIds: [] };
}

/* Integer id list for SQL IN (...). Ids always come from the database, never from input. */
function ids(list) {
  return list.length ? list.map((n) => Number(n)).filter(Number.isInteger).join(",") || "NULL" : "NULL";
}

/* SQL conditions (no user input inside, safe to interpolate) */
function branchSql(scope, alias = "b") {
  if (scope.all) return "TRUE";
  return `(${alias}.id IN (${ids(scope.branchIds)}) OR ${alias}.id IN (SELECT branch_id FROM makatib WHERE id IN (${ids(scope.maktabIds)})))`;
}
function maktabSql(scope, alias = "m") {
  if (scope.all) return "TRUE";
  return `${alias}.id IN (${ids(scope.maktabIds)})`;
}
function personSql(scope, alias, type) {
  if (scope.all) return "TRUE";
  // A teacher sees only their own teacher record (colleagues' CNIC, salary and documents stay private)
  if (!scope.canManage && type === "teacher") return scope.teacherId ? `${alias}.id = ${Number(scope.teacherId)}` : "FALSE";
  const parts = [`${alias}.maktab_id IN (${ids(scope.maktabIds)})`];
  if (scope.branchIds.length) parts.push(`${alias}.branch_id IN (${ids(scope.branchIds)})`);
  if (scope.teacherId) parts.push(type === "teacher" ? `${alias}.id = ${Number(scope.teacherId)}` : `${alias}.teacher_id = ${Number(scope.teacherId)}`);
  return `(${parts.join(" OR ")})`;
}

/* Single-record checks */
function inMaktab(scope, maktabId) { return scope.all || (maktabId != null && scope.maktabIds.includes(Number(maktabId))); }
function inBranch(scope, branchId) { return scope.all || (branchId != null && scope.branchIds.includes(Number(branchId))); }
function canSeePerson(scope, rec, type) {
  if (!rec) return false;
  if (scope.all) return true;
  if (!scope.canManage && type === "teacher") return !!scope.teacherId && rec.id === scope.teacherId;
  if (inMaktab(scope, rec.maktab_id) || inBranch(scope, rec.branch_id)) return true;
  if (scope.teacherId) return type === "teacher" ? rec.id === scope.teacherId : rec.teacher_id === scope.teacherId;
  return false;
}
async function canSeeBranch(scope, branchId) {
  if (scope.all) return true;
  if (inBranch(scope, branchId)) return true;
  return !!(await one(`SELECT 1 FROM makatib WHERE branch_id = ? AND id IN (${ids(scope.maktabIds)})`, branchId));
}

/* Express middleware: attaches req.scope */
async function withScope(req, res, next) {
  req.scope = await loadScope(req.user);
  res.locals.access = req.scope; // not "scope": EJS reserves that name
  next();
}

module.exports = { loadScope, withScope, branchSql, maktabSql, personSql, inMaktab, inBranch, canSeePerson, canSeeBranch, ids };
