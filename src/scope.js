/* Who can see and change what. Enforced on the server for every request.

   admin      (Super Administrator) — everything
   manager    (Branch Manager) — the branches they manage (branches.manager_id), every Maktab and school in those
              branches, and any Maktab they manage directly (makatib.manager_id)
   nazim      (Makatib Nazim) — every Maktab, with its teachers, students, attendance and results
   principal  (School Principal) — the schools where they are principal (schools.principal_id)
   teacher    — their own teacher record, their Maktab or school, and students there or assigned to them
   parent     — their own children only (students.parent_user_id), read-only, through the parent pages
   accountant — accounts and donations only; none of the people records
   user       (member) — none of the institution data */
"use strict";
const { one, all } = require("./db");

const EMPTY = { branchIds: [], maktabIds: [], schoolIds: [] };

async function loadScope(user) {
  if (!user) return { none: true, ...EMPTY };
  if (user.role === "admin") return { all: true, canManage: true, role: "admin", ...EMPTY };
  if (user.role === "manager") {
    const branchIds = (await all("SELECT id FROM branches WHERE manager_id = ?", user.id)).map((r) => r.id);
    const inBranches = branchIds.length ? ` OR branch_id IN (${ids(branchIds)})` : "";
    const maktabIds = (await all(`SELECT id FROM makatib WHERE manager_id = ?${inBranches}`, user.id)).map((r) => r.id);
    const schoolIds = branchIds.length ? (await all(`SELECT id FROM schools WHERE branch_id IN (${ids(branchIds)})`)).map((r) => r.id) : [];
    return { branchIds, maktabIds, schoolIds, canManage: true, role: "manager" };
  }
  if (user.role === "nazim") {
    const maktabIds = (await all("SELECT id FROM makatib")).map((r) => r.id);
    return { ...EMPTY, maktabIds, allMakatib: true, canManage: true, role: "nazim" };
  }
  if (user.role === "principal") {
    const schoolIds = (await all("SELECT id FROM schools WHERE principal_id = ?", user.id)).map((r) => r.id);
    return { ...EMPTY, schoolIds, canManage: true, role: "principal" };
  }
  if (user.role === "teacher") {
    const t = await one("SELECT id, maktab_id, school_id FROM teachers WHERE user_id = ?", user.id);
    return {
      teacherId: t ? t.id : null, branchIds: [],
      maktabIds: t && t.maktab_id ? [t.maktab_id] : [], schoolIds: t && t.school_id ? [t.school_id] : [],
      canManage: false, role: "teacher",
    };
  }
  if (user.role === "parent") {
    const childIds = (await all("SELECT id FROM students WHERE parent_user_id = ?", user.id)).map((r) => r.id);
    return { none: true, ...EMPTY, childIds, role: "parent" };
  }
  return { none: true, ...EMPTY, role: user.role };
}

/* Integer id list for SQL IN (...). Ids always come from the database, never from input. */
function ids(list) {
  return list.length ? list.map((n) => Number(n)).filter(Number.isInteger).join(",") || "NULL" : "NULL";
}

/* SQL conditions (no user input inside, safe to interpolate) */
function branchSql(scope, alias = "b") {
  if (scope.all) return "TRUE";
  return `(${alias}.id IN (${ids(scope.branchIds)}) OR ${alias}.id IN (SELECT branch_id FROM makatib WHERE id IN (${ids(scope.maktabIds)}))` +
    ` OR ${alias}.id IN (SELECT branch_id FROM schools WHERE id IN (${ids(scope.schoolIds)})))`;
}
function maktabSql(scope, alias = "m") {
  if (scope.all) return "TRUE";
  return `${alias}.id IN (${ids(scope.maktabIds)})`;
}
function schoolSql(scope, alias = "sc") {
  if (scope.all) return "TRUE";
  return `${alias}.id IN (${ids(scope.schoolIds)})`;
}
function personSql(scope, alias, type) {
  if (scope.all) return "TRUE";
  // A teacher sees only their own teacher record (colleagues' CNIC, salary and documents stay private)
  if (!scope.canManage && type === "teacher") return scope.teacherId ? `${alias}.id = ${Number(scope.teacherId)}` : "FALSE";
  const parts = [`${alias}.maktab_id IN (${ids(scope.maktabIds)})`];
  if (scope.schoolIds.length) parts.push(`${alias}.school_id IN (${ids(scope.schoolIds)})`);
  if (scope.branchIds.length) parts.push(`${alias}.branch_id IN (${ids(scope.branchIds)})`);
  if (scope.teacherId) parts.push(type === "teacher" ? `${alias}.id = ${Number(scope.teacherId)}` : `${alias}.teacher_id = ${Number(scope.teacherId)}`);
  return `(${parts.join(" OR ")})`;
}

/* Single-record checks */
function inMaktab(scope, maktabId) { return scope.all || (maktabId != null && scope.maktabIds.includes(Number(maktabId))); }
function inSchool(scope, schoolId) { return scope.all || (schoolId != null && scope.schoolIds.includes(Number(schoolId))); }
function inBranch(scope, branchId) { return scope.all || (branchId != null && scope.branchIds.includes(Number(branchId))); }
function canSeePerson(scope, rec, type) {
  if (!rec) return false;
  if (scope.all) return true;
  if (!scope.canManage && type === "teacher") return !!scope.teacherId && rec.id === scope.teacherId;
  if (inMaktab(scope, rec.maktab_id) || inSchool(scope, rec.school_id) || inBranch(scope, rec.branch_id)) return true;
  if (scope.teacherId) return type === "teacher" ? rec.id === scope.teacherId : rec.teacher_id === scope.teacherId;
  return false;
}
async function canSeeBranch(scope, branchId) {
  if (scope.all) return true;
  if (inBranch(scope, branchId)) return true;
  return !!(await one(`SELECT 1 FROM makatib WHERE branch_id = ? AND id IN (${ids(scope.maktabIds)})
    UNION SELECT 1 FROM schools WHERE branch_id = ? AND id IN (${ids(scope.schoolIds)})`, branchId, branchId));
}

/* Express middleware: attaches req.scope */
async function withScope(req, res, next) {
  req.scope = await loadScope(req.user);
  res.locals.access = req.scope; // not "scope": EJS reserves that name
  next();
}

module.exports = {
  loadScope, withScope, branchSql, maktabSql, schoolSql, personSql,
  inMaktab, inSchool, inBranch, canSeePerson, canSeeBranch, ids,
};
