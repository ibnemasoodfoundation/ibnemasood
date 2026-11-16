/* Accounts: income and expense entries, the finance dashboard and printable financial reports.
   For the Super Admin and the Accountant. Verified donations from the Donations page are counted
   as income automatically, so they are never entered twice. */
"use strict";
const express = require("express");
const { one, all, run, log } = require("../db");
const { checkCsrf, requireRole } = require("../auth");
const { EXPENSE_CATEGORIES, INCOME_CATEGORIES, PAYMENT_METHODS, todayPk } = require("../helpers");
const { helpers: h } = require("./institution");

const router = express.Router();
const finance = [requireRole("admin", "accountant"), checkCsrf];
const { str, int, like, DATE_RE } = h;
const TYPES = { income: "Income", expense: "Expense" };
const validDate = (d) => DATE_RE.test(d) && !isNaN(Date.parse(d));

/* Period from ?from=&to= (defaults: this month) */
function period(q) {
  const today = todayPk();
  let from = str(q.from, 10), to = str(q.to, 10);
  if (!validDate(from)) from = today.slice(0, 8) + "01";
  if (!validDate(to)) to = today;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

/* Totals for a period: entries plus verified donations (counted by the date they were recorded) */
async function totals(from, to) {
  const r = await one(`SELECT
      (SELECT COALESCE(SUM(amount), 0) FROM finance_entries WHERE entry_type = 'income' AND entry_date BETWEEN ? AND ?) AS income,
      (SELECT COALESCE(SUM(amount), 0) FROM finance_entries WHERE entry_type = 'expense' AND entry_date BETWEEN ? AND ?) AS expense,
      (SELECT COALESCE(SUM(amount), 0) FROM donations WHERE status = 'verified'
         AND (created_at AT TIME ZONE 'Asia/Karachi')::date BETWEEN ? AND ?) AS donations`, from, to, from, to, from, to);
  const income = Number(r.income) + Number(r.donations);
  return { entries: Number(r.income), donations: Number(r.donations), income, expense: Number(r.expense), balance: income - Number(r.expense) };
}

async function byCategory(type, from, to) {
  const rows = await all(`SELECT category AS label, SUM(amount) AS v, COUNT(*) AS n FROM finance_entries
    WHERE entry_type = ? AND entry_date BETWEEN ? AND ? GROUP BY 1 ORDER BY v DESC`, type, from, to);
  if (type === "income") {
    const d = await all(`SELECT 'Donations in the portal: ' || kind AS label, SUM(amount) AS v, COUNT(*) AS n FROM donations
      WHERE status = 'verified' AND (created_at AT TIME ZONE 'Asia/Karachi')::date BETWEEN ? AND ? GROUP BY kind`, from, to);
    rows.push(...d);
    rows.sort((a, b) => Number(b.v) - Number(a.v));
  }
  return rows.map((r) => ({ label: r.label, v: Number(r.v), n: Number(r.n) }));
}

/* ================= Dashboard ================= */
async function dashboard(req, res) {
  const today = todayPk();
  const monthStart = today.slice(0, 8) + "01", yearStart = today.slice(0, 5) + "01-01";
  const [month, year, all12inc, all12exp, all12don, expenseCats, recent] = await Promise.all([
    totals(monthStart, today), totals(yearStart, today),
    all(`SELECT to_char(entry_date, 'YYYY-MM') AS m, SUM(amount) AS v FROM finance_entries WHERE entry_type = 'income'
         AND entry_date >= date_trunc('month', CURRENT_DATE) - interval '11 months' GROUP BY 1`),
    all(`SELECT to_char(entry_date, 'YYYY-MM') AS m, SUM(amount) AS v FROM finance_entries WHERE entry_type = 'expense'
         AND entry_date >= date_trunc('month', CURRENT_DATE) - interval '11 months' GROUP BY 1`),
    all(`SELECT to_char(created_at AT TIME ZONE 'Asia/Karachi', 'YYYY-MM') AS m, SUM(amount) AS v FROM donations WHERE status = 'verified'
         AND created_at >= date_trunc('month', now()) - interval '11 months' GROUP BY 1`),
    byCategory("expense", yearStart, today),
    all(`SELECT f.*, u.name AS by_name FROM finance_entries f LEFT JOIN users u ON u.id = f.recorded_by ORDER BY f.entry_date DESC, f.id DESC LIMIT 8`),
  ]);
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - (11 - i), 1));
    return { key: d.toISOString().slice(0, 7), label: d.toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }) };
  });
  const val = (rows, k) => Number((rows.find((r) => r.m === k) || {}).v || 0);
  const charts = {
    incomeMonthly: { labels: months.map((m) => m.label), values: months.map((m) => val(all12inc, m.key) + val(all12don, m.key)), money: true },
    expenseMonthly: { labels: months.map((m) => m.label), values: months.map((m) => val(all12exp, m.key)), money: true },
    expenseByCategory: { labels: expenseCats.map((c) => c.label), values: expenseCats.map((c) => c.v), money: true },
  };
  const pending = await one("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS v FROM donations WHERE status = 'pending'");
  res.render("app/finance-dashboard", { title: "Accounts dashboard", month, year, charts, recent, pending, TYPES });
}

router.get("/finance", finance, dashboard);

/* ================= Entries ================= */
router.get("/finance/entries", finance, async (req, res) => {
  const { from, to } = period(req.query);
  const f = { from, to, type: TYPES[req.query.type] ? req.query.type : "", category: str(req.query.category, 80), branch: int(req.query.branch), q: str(req.query.q, 80) };
  const where = ["f.entry_date BETWEEN ? AND ?"], p = [from, to];
  if (f.type) { where.push("f.entry_type = ?"); p.push(f.type); }
  if (f.category) { where.push("f.category = ?"); p.push(f.category); }
  if (f.branch) { where.push("f.branch_id = ?"); p.push(f.branch); }
  if (f.q) { where.push("(f.description ILIKE ? OR f.party ILIKE ? OR f.reference ILIKE ?)"); p.push(like(f.q), like(f.q), like(f.q)); }
  const rows = await all(`SELECT f.*, b.name_en AS branch, u.name AS by_name FROM finance_entries f
    LEFT JOIN branches b ON b.id = f.branch_id LEFT JOIN users u ON u.id = f.recorded_by
    WHERE ${where.join(" AND ")} ORDER BY f.entry_date DESC, f.id DESC LIMIT 1000`, ...p);
  const sum = (t) => rows.filter((r) => r.entry_type === t).reduce((a, r) => a + r.amount, 0);
  res.render("app/finance-entries", {
    title: "Income and expenses", rows, f, income: sum("income"), expense: sum("expense"), TYPES,
    categories: [...new Set([...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES, ...(await all("SELECT DISTINCT category FROM finance_entries ORDER BY 1")).map((r) => r.category)])],
    branches: await h.branchList({ all: true }),
  });
});

async function entryForm(res, title, values, errors, status = 200) {
  res.status(status).render("app/finance-form", {
    title, values, errors, TYPES, EXPENSE_CATEGORIES, INCOME_CATEGORIES, PAYMENT_METHODS,
    branches: await h.branchList({ all: true }), makatib: await h.maktabList({ all: true }),
    schools: await all("SELECT id, name_en FROM schools WHERE status <> 'archived' ORDER BY name_en"),
  });
}

async function entryFields(body) {
  const v = {
    entry_type: TYPES[body.entry_type] ? body.entry_type : "expense", entry_date: str(body.entry_date, 10), category: str(body.category, 80),
    description: str(body.description, 500), amount: int(String(body.amount ?? "").replace(/[,\s]/g, "")), method: str(body.method, 40),
    party: str(body.party, 120), reference: str(body.reference, 60),
    branch_id: int(body.branch_id), school_id: int(body.school_id), maktab_id: int(body.maktab_id),
  };
  const e = {};
  if (!validDate(v.entry_date)) e.entry_date = "Enter a valid date.";
  else if (v.entry_date > todayPk()) e.entry_date = "The date cannot be in the future.";
  if (v.category.length < 2) e.category = "Choose or type a category.";
  if (!v.amount) e.amount = "Enter the amount in rupees, whole numbers only.";
  if (v.branch_id && !(await one("SELECT id FROM branches WHERE id = ?", v.branch_id))) e.branch_id = "Choose a branch.";
  if (v.school_id && !(await one("SELECT id FROM schools WHERE id = ?", v.school_id))) e.school_id = "Choose a school.";
  if (v.maktab_id && !(await one("SELECT id FROM makatib WHERE id = ?", v.maktab_id))) e.maktab_id = "Choose a Maktab.";
  return [v, e];
}
const COLS = ["entry_type", "entry_date", "category", "description", "amount", "method", "party", "reference", "branch_id", "school_id", "maktab_id"];
const vals = (v) => COLS.map((c) => (v[c] === "" ? null : v[c]));

router.get("/finance/new", finance, async (req, res) => {
  const type = TYPES[req.query.type] ? req.query.type : "expense";
  await entryForm(res, type === "income" ? "Record income" : "Record expense", { entry_type: type, entry_date: todayPk() }, {});
});

router.post("/finance", finance, async (req, res) => {
  const [v, e] = await entryFields(req.body);
  if (Object.keys(e).length) return entryForm(res, v.entry_type === "income" ? "Record income" : "Record expense", v, e, 400);
  await run(`INSERT INTO finance_entries (${COLS.join(", ")}, recorded_by) VALUES (${COLS.map(() => "?").join(", ")}, ?)`, ...vals(v), req.user.id);
  await log(req.user.id, "finance." + v.entry_type, `${v.category} Rs ${v.amount}`);
  req.flash("ok", `${TYPES[v.entry_type]} of Rs ${v.amount.toLocaleString("en-PK")} recorded.`);
  res.redirect(req.body.another === "1" ? `/app/finance/new?type=${v.entry_type}` : "/app/finance/entries");
});

async function loadEntry(req) {
  const id = int(req.params.id);
  return id ? one("SELECT * FROM finance_entries WHERE id = ?", id) : null;
}

router.get("/finance/:id/edit", finance, async (req, res, next) => {
  const x = await loadEntry(req);
  if (!x) return next();
  await entryForm(res, "Edit entry", { ...x, editId: x.id }, {});
});

router.post("/finance/:id", finance, async (req, res, next) => {
  const x = await loadEntry(req);
  if (!x) return next();
  const [v, e] = await entryFields(req.body);
  if (Object.keys(e).length) return entryForm(res, "Edit entry", { ...v, editId: x.id }, e, 400);
  await run(`UPDATE finance_entries SET ${COLS.map((c) => c + " = ?").join(", ")} WHERE id = ?`, ...vals(v), x.id);
  await log(req.user.id, "finance.update", `#${x.id} ${v.category} Rs ${v.amount}`);
  req.flash("ok", "Entry saved.");
  res.redirect("/app/finance/entries");
});

router.post("/finance/:id/delete", finance, async (req, res, next) => {
  const x = await loadEntry(req);
  if (!x) return next();
  await run("DELETE FROM finance_entries WHERE id = ?", x.id);
  await log(req.user.id, "finance.delete", `#${x.id} ${x.entry_type} ${x.category} Rs ${x.amount}`);
  req.flash("ok", "Entry deleted.");
  res.redirect("/app/finance/entries");
});

/* ================= Printable financial report ================= */
router.get("/finance/report", finance, async (req, res) => {
  const { from, to } = period(req.query);
  const [t, income, expense, byBranch, entries] = await Promise.all([
    totals(from, to), byCategory("income", from, to), byCategory("expense", from, to),
    all(`SELECT COALESCE(b.name_en, 'General / no branch') AS name,
        SUM(CASE WHEN f.entry_type = 'income' THEN f.amount ELSE 0 END) AS income,
        SUM(CASE WHEN f.entry_type = 'expense' THEN f.amount ELSE 0 END) AS expense
      FROM finance_entries f LEFT JOIN branches b ON b.id = f.branch_id
      WHERE f.entry_date BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`, from, to),
    req.query.detail === "1"
      ? all(`SELECT f.*, b.name_en AS branch FROM finance_entries f LEFT JOIN branches b ON b.id = f.branch_id
             WHERE f.entry_date BETWEEN ? AND ? ORDER BY f.entry_date, f.id`, from, to)
      : [],
  ]);
  res.render("app/finance-report", { title: "Financial report", tot: t, income, expense, byBranch, entries, f: { from, to, detail: req.query.detail === "1" }, printedOn: todayPk() });
});

module.exports = router;
module.exports.dashboard = dashboard;
