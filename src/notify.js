/* In-app notifications: shown on the dashboard, under the bell in the header and, when the person allows it,
   as a browser notification while the portal is open. */
"use strict";
const { all, run, one } = require("./db");

const KINDS = ["message", "announcement", "fee", "salary", "result", "system"];

/* Sends one notification to each user id (duplicates and empty ids are skipped). Returns how many were sent. */
async function notify(userIds, n) {
  const ids = [...new Set(userIds.map(Number).filter((x) => Number.isInteger(x) && x > 0))];
  if (!ids.length) return 0;
  const kind = KINDS.includes(n.kind) ? n.kind : "message";
  const title = String(n.title || "").slice(0, 160), body = n.body ? String(n.body).slice(0, 1000) : null;
  const link = n.link && /^\/app(\/|$)/.test(n.link) ? n.link : null; // only links inside the portal
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    await run(`INSERT INTO notifications (user_id, kind, title, body, link, created_by) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`,
      ...chunk.flatMap((id) => [id, kind, title, body, link, n.by || null]));
  }
  return ids.length;
}

/* Everyone active in these roles */
async function notifyRoles(roles, n) {
  if (!roles.length) return 0;
  const users = await all(`SELECT id FROM users WHERE status = 'active' AND role IN (${roles.map(() => "?").join(", ")})`, ...roles);
  return notify(users.map((u) => u.id).filter((id) => id !== n.skip), n);
}

/* The parent logins of these students */
async function notifyParentsOf(studentIds, n) {
  const ids = studentIds.map(Number).filter(Number.isInteger);
  if (!ids.length) return 0;
  const parents = await all(`SELECT DISTINCT parent_user_id AS id FROM students WHERE parent_user_id IS NOT NULL AND id IN (${ids.join(",")})`);
  return notify(parents.map((p) => p.id), n);
}

const unreadCount = async (userId) => (await one("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", userId)).n;

module.exports = { notify, notifyRoles, notifyParentsOf, unreadCount, KINDS };
