/* Student fees: who has paid for a month, recording payments (they go to the accounts as income),
   reminders to parents of unpaid students, receipts. For the Super Admin and the Accountant (everything),
   Branch Managers and School Principals (their own students). Undoing a payment is for Admins and Managers. */
"use strict";
const express = require("express");
const { one, all, run, log } = require("../db");
const { checkCsrf, requireRole } = require("../auth");
const { loadScope, personSql, schoolSql, maktabSql, canSeePerson } = require("../scope");
const { notifyParentsOf } = require("../notify");
const { PAYMENT_METHODS, JAMIAS, DARJAT, todayPk } = require("../helpers");
const { helpers: h } = require("./institution");

const router = express.Router();
const feeRoles = requireRole("admin", "accountant", "manager", "principal");
const { str, int, DATE_RE, forbidden } = h;

async function feeScope(req, res, next) {
  const sc = await loadScope(req.user, req.session.section);
  req.scope = req.user.role === "accountant" ? { ...sc, all: true } : sc; // the Accountant handles every student's fees
  res.locals.access = req.scope;
  next();
}
const guard = [feeRoles, feeScope, checkCsrf];

const monthOf = (v) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || "")) ? v : todayPk().slice(0, 7));
const monthName = (m) => new Date(m + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
/* What a student owes each month: the monthly fee, else the tuition fee from the admission form */
const dueOf = (s) => Number(s.monthly_fee) || Number(String((s.extra || {}).tuition_fee || "").replace(/[^\d]/g, "")) || 0;

/* Units the user can filter by: "j:<branch>" a Jamia's own students, "s:<school>", "m:<maktab>" */
async function units(sc) {
  return {
    jamias: (await all("SELECT id, section FROM branches WHERE section IS NOT NULL AND status <> 'archived' ORDER BY id")).filter((b) => sc.all || sc.branchIds.includes(b.id)),
    schools: await all(`SELECT sc.id, sc.name_en FROM schools sc WHERE sc.status <> 'archived' AND ${schoolSql(sc, "sc")} ORDER BY sc.name_en`),
    makatib: await all(`SELECT m.id, m.name_en FROM makatib m WHERE m.status <> 'archived' AND ${maktabSql(sc, "m")} ORDER BY m.name_en`),
  };
}
function unitWhere(unit) {
  let m;
  if ((m = String(unit).match(/^j:(\d{1,9})$/))) return ["s.branch_id = ? AND s.maktab_id IS NULL AND s.school_id IS NULL", Number(m[1])];
  if ((m = String(unit).match(/^s:(\d{1,9})$/))) return ["s.school_id = ?", Number(m[1])];
  if ((m = String(unit).match(/^m:(\d{1,9})$/))) return ["s.maktab_id = ?", Number(m[1])];
  return null;
}

async function feeRows(req, f) {
  const where = ["s.status = 'active'", personSql(req.scope, "s", "student")], p = [f.month];
  const u = unitWhere(f.unit);
  if (u) { where.push(u[0]); p.push(u[1]); }
  if (f.q) { where.push("(s.full_name ILIKE ? OR s.code ILIKE ? OR s.father_name ILIKE ?)"); p.push(h.like(f.q), h.like(f.q), h.like(f.q)); }
  const rows = await all(`SELECT s.id, s.code, s.full_name, s.father_name, s.class_name, s.monthly_fee, s.extra, s.parent_user_id,
      COALESCE(m.name_en, sc.name_en, b.name_en) AS unit, fp.id AS fee_id, fp.amount_due, fp.amount_paid, fp.paid_on, fp.receipt_no
    FROM students s LEFT JOIN fee_payments fp ON fp.student_id = s.id AND fp.month = ?
    LEFT JOIN makatib m ON m.id = s.maktab_id LEFT JOIN schools sc ON sc.id = s.school_id LEFT JOIN branches b ON b.id = s.branch_id
    WHERE ${where.join(" AND ")} ORDER BY unit NULLS LAST, s.class_name NULLS LAST, s.full_name LIMIT 3000`, ...p);
  for (const r of rows) {
    r.due = r.fee_id ? r.amount_due : dueOf(r);
    r.paid = r.amount_paid || 0;
    r.state = r.paid >= r.due && r.paid > 0 ? "paid" : r.paid > 0 ? "partial" : r.due > 0 ? "unpaid" : "nofee";
  }
  return f.status ? rows.filter((r) => r.state === f.status) : rows;
}

/* ================= Monthly fee list ================= */
router.get("/fees", guard, async (req, res) => {
  const f = { month: monthOf(req.query.month), unit: str(req.query.unit, 20), q: str(req.query.q, 80),
    status: ["paid", "partial", "unpaid", "nofee"].includes(req.query.status) ? req.query.status : "" };
  const all_ = await feeRows(req, { ...f, status: "" });
  const rows = f.status ? all_.filter((r) => r.state === f.status) : all_;
  const sum = (k) => all_.reduce((t, r) => t + (r[k] || 0), 0);
  const totals = { due: sum("due"), paid: sum("paid"), students: all_.length,
    paidCount: all_.filter((r) => r.state === "paid").length, unpaidCount: all_.filter((r) => r.state === "unpaid" || r.state === "partial").length,
    noFee: all_.filter((r) => r.state === "nofee").length };
  totals.outstanding = Math.max(0, totals.due - totals.paid);
  res.render("app/fees", { title: "Student fees", rows, f, totals, monthName: monthName(f.month), PAYMENT_METHODS, JAMIAS, DARJAT,
    canUndo: ["admin", "manager"].includes(req.user.role), ...(await units(req.scope)) });
});

/* ================= Record a payment ================= */
router.post("/fees/pay", guard, async (req, res) => {
  const month = monthOf(req.body.month), sid = int(req.body.student_id), amount = int(String(req.body.amount || "").replace(/[,\s]/g, ""));
  const back = `/app/fees?${new URLSearchParams({ month, unit: str(req.body.unit, 20), status: str(req.body.status, 10), q: str(req.body.q, 80) })}`;
  const s = sid && await one("SELECT * FROM students WHERE id = ?", sid);
  if (!s || !canSeePerson(req.scope, s, "student")) return forbidden(res);
  if (!amount) { req.flash("err", "Enter the amount received, in rupees."); return res.redirect(back); }
  const paidOn = DATE_RE.test(str(req.body.paid_on, 10)) && str(req.body.paid_on, 10) <= todayPk() ? str(req.body.paid_on, 10) : todayPk();
  const method = PAYMENT_METHODS.includes(req.body.method) ? req.body.method : "Cash", receipt = str(req.body.receipt_no, 40) || null;
  let fp = await one("SELECT * FROM fee_payments WHERE student_id = ? AND month = ?", s.id, month);
  if (!fp) fp = await one(`INSERT INTO fee_payments (student_id, month, amount_due, amount_paid, recorded_by) VALUES (?, ?, ?, 0, ?) RETURNING *`, s.id, month, dueOf(s), req.user.id);
  // Each payment is income in the accounts; the fee number in the description lets "Undo" find it again
  const fe = await one(`INSERT INTO finance_entries (entry_type, entry_date, category, description, amount, method, party, reference, branch_id, school_id, maktab_id, recorded_by)
    VALUES ('income', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    paidOn, s.school_id ? "School fees" : "Student fees", `Fee for ${monthName(month)} · ${s.code} (fee #${fp.id})`, amount, method, s.full_name, receipt,
    s.branch_id, s.school_id, s.maktab_id, req.user.id);
  const paid = fp.amount_paid + amount;
  await run("UPDATE fee_payments SET amount_paid = ?, paid_on = ?, method = ?, receipt_no = COALESCE(?, receipt_no), note = ?, finance_entry_id = ?, recorded_by = ? WHERE id = ?",
    paid, paidOn, method, receipt, str(req.body.note, 200) || null, fe.id, req.user.id, fp.id);
  await log(req.user.id, "fee.pay", `${s.code} ${monthName(month)} Rs ${amount}`);
  const left = Math.max(0, fp.amount_due - paid);
  await notifyParentsOf([s.id], { kind: "fee", by: req.user.id, link: `/app/fees/${fp.id}/receipt`,
    title: `Fee received: Rs ${amount.toLocaleString("en-PK")} for ${s.full_name}`,
    body: `${monthName(month)}${left ? `. Still due: Rs ${left.toLocaleString("en-PK")}.` : ". Paid in full. JazakAllah khair."}` });
  req.flash("ok", `Rs ${amount.toLocaleString("en-PK")} recorded for ${s.full_name} (${monthName(month)})${left ? `; Rs ${left.toLocaleString("en-PK")} still due` : ", paid in full"}.`);
  res.redirect(back);
});

/* ================= Undo a payment (Admins and Managers) ================= */
router.post("/fees/:id/delete", [requireRole("admin", "manager"), feeScope, checkCsrf], async (req, res, next) => {
  const fp = int(req.params.id) && await one("SELECT fp.*, s.code, s.full_name, s.maktab_id, s.school_id, s.branch_id, s.teacher_id FROM fee_payments fp JOIN students s ON s.id = fp.student_id WHERE fp.id = ?", int(req.params.id));
  if (!fp) return next();
  if (!canSeePerson(req.scope, fp, "student")) return forbidden(res);
  await run("DELETE FROM finance_entries WHERE entry_type = 'income' AND description LIKE ?", `%(fee #${fp.id})`);
  await run("DELETE FROM fee_payments WHERE id = ?", fp.id);
  await log(req.user.id, "fee.delete", `${fp.code} ${fp.month}`);
  req.flash("ok", `Fee record for ${fp.full_name} (${monthName(fp.month)}) removed, with its income entries.`);
  res.redirect(`/app/fees?month=${fp.month}`);
});

/* ================= Remind parents of unpaid fees ================= */
router.post("/fees/remind", guard, async (req, res) => {
  const f = { month: monthOf(req.body.month), unit: str(req.body.unit, 20), q: "", status: "" };
  const due = (await feeRows(req, f)).filter((r) => r.state === "unpaid" || r.state === "partial");
  let sent = 0, noLogin = 0;
  for (const r of due) {
    if (!r.parent_user_id) { noLogin++; continue; }
    sent += await notifyParentsOf([r.id], { kind: "fee", by: req.user.id, link: "/app",
      title: `Fee due for ${r.full_name}: ${monthName(f.month)}`,
      body: `Rs ${(r.due - r.paid).toLocaleString("en-PK")} is still due. Please pay at the office or by bank / JazzCash / EasyPaisa and share the receipt.` });
  }
  await log(req.user.id, "fee.remind", `${f.month} ${f.unit || "all"}: ${sent}`);
  req.flash("ok", `Reminder sent to ${sent} parent${sent === 1 ? "" : "s"}${noLogin ? `; ${noLogin} unpaid student${noLogin === 1 ? " has" : "s have"} no parent login` : ""}.`);
  res.redirect(`/app/fees?${new URLSearchParams({ month: f.month, unit: f.unit, status: "unpaid" })}`);
});

/* ================= Set the monthly fee for the shown students who have none ================= */
router.post("/fees/set-fee", guard, async (req, res) => {
  const amount = int(String(req.body.fee || "").replace(/[,\s]/g, ""));
  const f = { month: monthOf(req.body.month), unit: str(req.body.unit, 20), q: "", status: "nofee" };
  if (!amount) { req.flash("err", "Enter the monthly fee in rupees."); return res.redirect(`/app/fees?month=${f.month}&unit=${f.unit}`); }
  const rows = await feeRows(req, f);
  for (const r of rows) await run("UPDATE students SET monthly_fee = ? WHERE id = ?", amount, r.id);
  await log(req.user.id, "fee.set_monthly", `${f.unit || "all"}: Rs ${amount} × ${rows.length}`);
  req.flash("ok", `Monthly fee of Rs ${amount.toLocaleString("en-PK")} set for ${rows.length} student${rows.length === 1 ? "" : "s"}.`);
  res.redirect(`/app/fees?month=${f.month}&unit=${f.unit}`);
});

/* ================= Receipt (staff, and the student's parent) ================= */
router.get("/fees/:id/receipt", requireRole("admin", "accountant", "manager", "principal", "parent"), feeScope, async (req, res, next) => {
  const fp = int(req.params.id) && await one(`SELECT fp.*, s.code, s.full_name, s.father_name, s.class_name, s.parent_user_id, s.maktab_id, s.school_id, s.branch_id, s.teacher_id,
      COALESCE(m.name_en, sc.name_en, b.name_en) AS unit, u.name AS by_name
    FROM fee_payments fp JOIN students s ON s.id = fp.student_id LEFT JOIN makatib m ON m.id = s.maktab_id LEFT JOIN schools sc ON sc.id = s.school_id
    LEFT JOIN branches b ON b.id = s.branch_id LEFT JOIN users u ON u.id = fp.recorded_by WHERE fp.id = ?`, int(req.params.id));
  if (!fp) return next();
  if (req.user.role === "parent" ? fp.parent_user_id !== req.user.id : !canSeePerson(req.scope, fp, "student")) return forbidden(res);
  res.render("app/fee-receipt", { title: "Fee receipt", fp, monthName: monthName(fp.month), printedOn: todayPk() });
});

module.exports = router;
module.exports.dueOf = dueOf;
module.exports.monthName = monthName;
