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

// Towns the Jamia already serves. Offered as suggestions only: any new town can be typed in.
const REPORTED_TOWNS = [
  { en: "Bhiria Road", ur: "بھریا روڈ" },
  { en: "Paka Chang", ur: "پکا چانگ" },
  { en: "Akri Perosan", ur: "اکری پیروسن" },
  { en: "Kharrara", ur: "کھرڑا" },
  { en: "Padidan", ur: "پڈعیدن" },
  { en: "Kumb", ur: "کنب" },
];

const UNIT_STATUSES = ["active", "inactive", "archived"];
const TEACHER_STATUSES = ["active", "inactive", "left"];
const STUDENT_STATUSES = ["active", "inactive", "graduated", "left"];
const GENDERS = { male: "Male", female: "Female" };

/* Postgres gives timestamps as Date objects and DATE columns as "YYYY-MM-DD" */
function toDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T00:00:00Z" : s);
}
const TZ = "Asia/Karachi";

function fmtDate(s) {
  const d = toDate(s);
  const dateOnly = typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
  return d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: dateOnly ? "UTC" : TZ }) : "—";
}

function fmtDateTime(s) {
  const d = toDate(s);
  return d ? d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ }) : "—";
}

function money(n) { return "Rs " + Number(n || 0).toLocaleString("en-PK"); }

function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function fileSize(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ""; }

module.exports = {
  BRANCHES, PROGRAMMES, DONATION_KINDS, DONATION_METHODS, ROLE_LABELS,
  REPORTED_TOWNS, UNIT_STATUSES, TEACHER_STATUSES, STUDENT_STATUSES, GENDERS, fileSize,
  fmtDate, fmtDateTime, money, initials, cap,
};
