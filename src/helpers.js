/* Formatting helpers and option lists shared by routes and views */
"use strict";

const BRANCHES = {
  boys: "Jamia Arabia Abdullah Bin Masood (Boys)",
  girls: "Jamia Arabia Aisha Siddiqa (Girls)",
  school: "Iqra Islamia Public School",
};

const PROGRAMMES = {
  boys: ["Qaida", "Nazra", "Hifz-ul-Quran", "Gardaan", "Dars-e-Nizami"],
  girls: ["Qaida", "Nazra", "Tahaffuz-ul-Quran", "Gardaan", "Alimah course"],
  school: ["Nursery", "Primary", "Middle"],
};

const DONATION_KINDS = ["Sadaqah", "Zakat", "General donation", "Fitrana", "Student sponsorship", "Construction"];
const DONATION_METHODS = ["Bank Al Habib", "JazzCash", "EasyPaisa", "Cash at the Jamia"];

const ROLE_LABELS = { admin: "Admin", manager: "Manager", user: "Member" };

/* SQLite stores UTC as "YYYY-MM-DD HH:MM:SS" */
function toDate(s) { return s ? new Date(String(s).replace(" ", "T") + (String(s).endsWith("Z") ? "" : "Z")) : null; }

function fmtDate(s) {
  const d = toDate(s);
  return d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—";
}

function fmtDateTime(s) {
  const d = toDate(s);
  return d ? d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}

function money(n) { return "Rs " + Number(n || 0).toLocaleString("en-PK"); }

function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ""; }

module.exports = {
  BRANCHES, PROGRAMMES, DONATION_KINDS, DONATION_METHODS, ROLE_LABELS,
  fmtDate, fmtDateTime, money, initials, cap,
};
