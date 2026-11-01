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

const ROLE_LABELS = { admin: "Super Admin", manager: "Branch Manager", teacher: "Teacher", user: "Member" };

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
const TEACHER_STATUSES = ["active", "on_leave", "inactive", "left", "archived"];
const STUDENT_STATUSES = ["active", "inactive", "graduated", "left"];
const GENDERS = { male: "Male", female: "Female" };

const HIFZ_STATUSES = { hafiz: "Hafiz (complete)", in_progress: "Hifz in progress", partial: "Partial memorisation", none: "Not a Hafiz" };
const TAJWEED_STATUSES = { certified: "Certified", trained: "Trained", learning: "Learning", none: "Not yet" };
const EMPLOYMENT_TYPES = { permanent: "Permanent", contract: "Contract", part_time: "Part-time", volunteer: "Volunteer" };
const DESIGNATIONS = ["Mudarris", "Muallima", "Qari", "Nazim", "Senior Teacher", "Head Teacher"];
const EDUCATION_LEVELS = ["Not in school", "Nursery", "Primary", "Middle", "Matric", "Intermediate", "Graduate"];
const QURAN_LEVELS = ["Qaida", "Nazra", "Hifz", "Gardaan", "Completed Nazra", "Completed Hifz"];

const ATTENDANCE = { present: "Present", absent: "Absent", leave: "Leave", late: "Late" };
const SESSIONS = { morning: "Morning", evening: "Evening" };

const DOC_CATEGORIES = {
  teacher: { cnic_front: "CNIC front", cnic_back: "CNIC back", certificate: "Educational certificate", appointment_letter: "Appointment letter", other: "Other document" },
  student: { bform: "B-Form / CNIC", certificate: "Certificate / result", other: "Other document" },
};

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

/* "on_leave" → "On leave" */
function label(s) { return s ? cap(String(s).replace(/_/g, " ")) : ""; }

/* Today's date in Pakistan as YYYY-MM-DD (attendance is per local day) */
function todayPk() { return new Date().toLocaleDateString("en-CA", { timeZone: TZ }); }

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ""; }

module.exports = {
  BRANCHES, PROGRAMMES, DONATION_KINDS, DONATION_METHODS, ROLE_LABELS,
  REPORTED_TOWNS, UNIT_STATUSES, TEACHER_STATUSES, STUDENT_STATUSES, GENDERS, fileSize,
  HIFZ_STATUSES, TAJWEED_STATUSES, EMPLOYMENT_TYPES, DESIGNATIONS, EDUCATION_LEVELS, QURAN_LEVELS,
  ATTENDANCE, SESSIONS, DOC_CATEGORIES, label, todayPk,
  fmtDate, fmtDateTime, money, initials, cap,
};
