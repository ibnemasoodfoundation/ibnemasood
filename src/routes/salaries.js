/* Teacher salaries, for the Accountant and the Super Admin: the monthly salary sheet for every teacher
   (Jamia, school and Makatib), paying one or all, salary slips. Each payment is an expense in the accounts
   and the teacher is notified (when they have a portal login). Removing a payment is for the Super Admin. */
"use strict";
const express = require("express");
const { one, all, run, log } = require("../db");
const { checkCsrf, requireRole } = require("../auth");
const { notify } = require("../notify");
const { PAYMENT_METHODS, JAMIAS, todayPk } = require("../helpers");
const { helpers: h } = require("./institution");

const router = express.Router();
const guard = [requireRole("admin", "accountant"), checkCsrf];
const { str, int, DATE_RE } = h;
const monthOf = (v) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || "")) ? v : todayPk().slice(0, 7));
const monthName = (m) => new Date(m + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const rs = (n) => "Rs " + Number(n || 0).toLocaleString("en-PK");

/* Where a teacher works: a school, a Maktab, a Jamia (main branch) or elsewhere */
const GROUP_SQL = `CASE WHEN t.school_id IS NOT NULL THEN 'school' WHEN t.maktab_id IS NOT NULL THEN 'maktab'
  WHEN b.section IS NOT NULL THEN 'jamia' ELSE 'other' END`;
const GROUPS = { jamia: "Jamia (institute)", school: "School", maktab: "Makatib", other: "Other / unassigned" };

async function sheet(month, group) {
  const rows = await all(`SELECT t.id, t.code, t.full_name, t.designation, t.salary, t.user_id, t.employment_type,
      ${GROUP_SQL} AS grp, COALESCE(sc.name_en, m.name_en, b.name_en) AS place, b.section,
      sp.id AS pay_id, sp.net, sp.paid_on, sp.basic, sp.allowance, sp.deduction
    FROM teachers t LEFT JOIN schools sc ON sc.id = t.school_id LEFT JOIN makatib m ON m.id = t.maktab_id LEFT JOIN branches b ON b.id = t.branch_id
    LEFT JOIN salary_payments sp ON sp.teacher_id = t.id AND sp.month = ?
    WHERE t.status IN ('active', 'on_leave') OR sp.id IS NOT NULL
    ORDER BY grp, place NULLS LAST, t.full_name`, month);
  return group ? rows.filter((r) => r.grp === group) : rows;
}

/* Pays one teacher for a month; returns the payment, or null if they were already paid */
async function pay(req, t, month, v) {
  if (await one("SELECT 1 FROM salary_payments WHERE teacher_id = ? AND month = ?", t.id, month)) return null;
  const net = Math.max(0, v.basic + v.allowance - v.deduction);
  const sp = await one(`INSERT INTO salary_payments (teacher_id, month, basic, allowance, deduction, net, paid_on, method, note, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`, t.id, month, v.basic, v.allowance, v.deduction, net, v.paidOn, v.method, v.note || null, req.user.id);
  if (net > 0) {
    const fe = await one(`INSERT INTO finance_entries (entry_type, entry_date, category, description, amount, method, party, branch_id, school_id, maktab_id, recorded_by)
      VALUES ('expense', ?, 'Teacher salaries', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      v.paidOn, `Salary for ${monthName(month)} · ${t.code} (salary #${sp.id})`, net, v.method, t.full_name, t.branch_id, t.school_id, t.maktab_id, req.user.id);
    await run("UPDATE salary_payments SET finance_entry_id = ? WHERE id = ?", fe.id, sp.id);
  }
  if (t.user_id) await notify([t.user_id], { kind: "salary", by: req.user.id, link: `/app/salaries/${sp.id}/slip`,
    title: `Salary paid: ${rs(net)} for ${monthName(month)}`, body: `Paid on ${v.paidOn} by ${v.method}. Open the salary slip for details.` });
  return sp;
}
function payFields(body) {
  const num = (k) => int(String(body[k] || "0").replace(/[,\s]/g, "")) || 0;
  const paidOn = DATE_RE.test(str(body.paid_on, 10)) && str(body.paid_on, 10) <= todayPk() ? str(body.paid_on, 10) : todayPk();
  return { basic: num("basic"), allowance: num("allowance"), deduction: num("deduction"), paidOn,
    method: PAYMENT_METHODS.includes(body.method) ? body.method : "Cash", note: str(body.note, 200) };
}

/* ================= Monthly salary sheet ================= */
router.get("/salaries", guard, async (req, res) => {
  const f = { month: monthOf(req.query.month), group: GROUPS[req.query.group] ? req.query.group : "", status: ["paid", "unpaid"].includes(req.query.status) ? req.query.status : "" };
  const allRows = await sheet(f.month, f.group);
  const rows = f.status ? allRows.filter((r) => (f.status === "paid" ? r.pay_id : !r.pay_id)) : allRows;
  const totals = {
    teachers: allRows.length, paid: allRows.filter((r) => r.pay_id).length,
    paidAmount: allRows.reduce((t, r) => t + (r.net || 0), 0),
    pendingAmount: allRows.filter((r) => !r.pay_id).reduce((t, r) => t + (r.salary || 0), 0),
    noSalary: allRows.filter((r) => !r.pay_id && !r.salary).length,
  };
  const byGroup = Object.keys(GROUPS).map((g) => {
    const list = (f.group ? allRows : allRows).filter((r) => r.grp === g);
    return { g, label: GROUPS[g], n: list.length, paid: list.filter((r) => r.pay_id).length, amount: list.reduce((t, r) => t + (r.net || 0), 0) };
  }).filter((x) => x.n);
  res.render("app/salaries", { title: "Teacher salaries", rows, f, totals, byGroup, GROUPS, JAMIAS, PAYMENT_METHODS, monthName: monthName(f.month), today: todayPk() });
});

router.post("/salaries/pay", guard, async (req, res) => {
  const month = monthOf(req.body.month);
  const back = `/app/salaries?${new URLSearchParams({ month, group: str(req.body.group, 10), status: str(req.body.status, 10) })}`;
  const t = int(req.body.teacher_id) && await one("SELECT * FROM teachers WHERE id = ?", int(req.body.teacher_id));
  if (!t) return res.redirect(back);
  const v = payFields(req.body);
  if (!v.basic && !v.allowance) { req.flash("err", `Enter ${t.full_name}'s salary amount.`); return res.redirect(back); }
  const sp = await pay(req, t, month, v);
  if (!sp) { req.flash("err", `${t.full_name} is already paid for ${monthName(month)}.`); return res.redirect(back); }
  await log(req.user.id, "salary.pay", `${t.code} ${monthName(month)} ${rs(sp.net)}`);
  req.flash("ok", `${t.full_name} paid ${rs(sp.net)} for ${monthName(month)}${t.user_id ? "; they have been notified" : ""}.`);
  res.redirect(back);
});

/* Pay every unpaid teacher shown who has a monthly salary on their profile */
router.post("/salaries/pay-all", guard, async (req, res) => {
  const month = monthOf(req.body.month), group = GROUPS[req.body.group] ? req.body.group : "";
  const v = payFields({ ...req.body, basic: "0" });
  let count = 0, total = 0;
  for (const r of (await sheet(month, group)).filter((x) => !x.pay_id && x.salary > 0)) {
    const t = await one("SELECT * FROM teachers WHERE id = ?", r.id);
    const sp = await pay(req, t, month, { ...v, basic: t.salary, allowance: 0, deduction: 0 });
    if (sp) { count++; total += sp.net; }
  }
  await log(req.user.id, "salary.pay_all", `${monthName(month)} ${group || "all"}: ${count}, ${rs(total)}`);
  req.flash("ok", count ? `${count} teacher${count === 1 ? "" : "s"} paid, ${rs(total)} in total, for ${monthName(month)}.` : "Nobody left to pay (teachers without a monthly salary on their profile are skipped).");
  res.redirect(`/app/salaries?${new URLSearchParams({ month, group })}`);
});

router.post("/salaries/:id/delete", [requireRole("admin"), checkCsrf], async (req, res, next) => {
  const sp = int(req.params.id) && await one("SELECT sp.*, t.full_name FROM salary_payments sp JOIN teachers t ON t.id = sp.teacher_id WHERE sp.id = ?", int(req.params.id));
  if (!sp) return next();
  await run("DELETE FROM finance_entries WHERE entry_type = 'expense' AND description LIKE ?", `%(salary #${sp.id})`);
  await run("DELETE FROM salary_payments WHERE id = ?", sp.id);
  await log(req.user.id, "salary.delete", `${sp.full_name} ${sp.month}`);
  req.flash("ok", `Salary payment of ${sp.full_name} for ${monthName(sp.month)} removed, with its expense entry.`);
  res.redirect(`/app/salaries?month=${sp.month}`);
});

/* ================= Salary slip (staff, and the teacher themself) ================= */
router.get("/salaries/:id/slip", requireRole("admin", "accountant", "teacher"), async (req, res, next) => {
  const sp = int(req.params.id) && await one(`SELECT sp.*, t.code, t.full_name, t.designation, t.cnic, t.user_id, t.employment_type,
      COALESCE(sc.name_en, m.name_en, b.name_en) AS place, u.name AS by_name
    FROM salary_payments sp JOIN teachers t ON t.id = sp.teacher_id LEFT JOIN schools sc ON sc.id = t.school_id LEFT JOIN makatib m ON m.id = t.maktab_id
    LEFT JOIN branches b ON b.id = t.branch_id LEFT JOIN users u ON u.id = sp.recorded_by WHERE sp.id = ?`, int(req.params.id));
  if (!sp) return next();
  if (req.user.role === "teacher" && sp.user_id !== req.user.id) return res.status(403).render("error", { title: "Not allowed", message: "This salary slip belongs to another teacher." });
  res.render("app/salary-slip", { title: "Salary slip", sp, monthName: monthName(sp.month), printedOn: todayPk() });
});

module.exports = router;
module.exports.monthName = monthName;
