/* Portal interface languages: English (default) and Urdu.
   Menus, roles, page titles and common buttons are translated here; names and records stay as entered.
   The choice is kept in the session (/lang/ur, /lang/en). The public website uses its own switcher. */
"use strict";

const LANGS = { en: { name: "English", dir: "ltr" }, ur: { name: "اردو", dir: "rtl" } };

const UR = {
  // Navigation and sections
  "Overview": "جائزہ", "My dashboard": "میرا ڈیش بورڈ", "Institution": "ادارہ", "Branches": "شاخیں", "Makatib": "مکاتب",
  "Schools": "اسکول", "Teachers": "اساتذہ", "Students": "طلبہ", "Attendance": "حاضری", "Student attendance": "طلبہ کی حاضری",
  "Teacher attendance": "اساتذہ کی حاضری", "Reports": "رپورٹس", "Results": "نتائج", "Exams and results": "امتحانات اور نتائج",
  "Office": "دفتر", "Admissions": "داخلے", "My applications": "میری درخواستیں", "Donations": "عطیات", "My donations": "میرے عطیات",
  "Messages": "پیغامات", "Announcements": "اعلانات", "Users & roles": "صارفین اور ذمہ داریاں", "Activity log": "سرگرمیوں کا ریکارڈ",
  "My profile": "میری پروفائل", "Accounts": "حسابات", "Income and expenses": "آمدن اور اخراجات", "Financial report": "مالیاتی رپورٹ",
  "My students": "میرے طلبہ", "Mark attendance": "حاضری لگائیں", "Monthly sheet": "ماہانہ شیٹ", "My children": "میرے بچے",
  "Public website": "ویب سائٹ", "Sign out": "لاگ آؤٹ", "portal": "پورٹل", "Language": "زبان", "Open menu": "مینو کھولیں",
  "Skip to content": "مواد پر جائیں",
  // Roles
  "Super Admin": "سپر ایڈمن", "Branch Manager": "برانچ منیجر", "Makatib Nazim": "ناظمِ مکاتب", "School Principal": "اسکول پرنسپل",
  "Accountant": "اکاؤنٹنٹ", "Teacher": "استاد", "Parent": "والدین", "Member": "رکن",
  // Page titles
  "Admin dashboard": "ایڈمن ڈیش بورڈ", "Manager dashboard": "منیجر ڈیش بورڈ", "Teacher dashboard": "استاد کا ڈیش بورڈ",
  "Parent dashboard": "والدین کا ڈیش بورڈ", "Makatib dashboard": "مکاتب کا ڈیش بورڈ", "School dashboard": "اسکول کا ڈیش بورڈ",
  "Accounts dashboard": "حسابات کا ڈیش بورڈ", "Monthly attendance": "ماہانہ حاضری", "Attendance report": "حاضری کی رپورٹ",
  "Teacher attendance, monthly": "اساتذہ کی ماہانہ حاضری", "New exam": "نیا امتحان", "Add school": "اسکول شامل کریں",
  "Record expense": "خرچ درج کریں", "Record income": "آمدن درج کریں", "Edit entry": "اندراج میں ترمیم",
  "Register Maktab": "مکتب رجسٹر کریں", "Add branch": "شاخ شامل کریں", "Register teacher": "استاد رجسٹر کریں",
  "Register student": "طالب علم رجسٹر کریں", "New admission application": "داخلے کی نئی درخواست", "Record a donation": "عطیہ درج کریں",
  "Teacher report": "اساتذہ کی رپورٹ",
  // Sign-in pages
  "Sign in": "سائن اِن", "Create account": "اکاؤنٹ بنائیں", "Email": "ای میل", "Password": "پاس ورڈ",
};

const DICTS = { ur: UR };

function translator(lang) {
  const dict = DICTS[lang];
  return dict ? (s) => (s in dict ? dict[s] : s) : (s) => s;
}

/* Express middleware: res.locals.lang, dir, t() */
function i18n(req, res, next) {
  const lang = req.session && LANGS[req.session.lang] ? req.session.lang : "en";
  res.locals.lang = lang;
  res.locals.dir = LANGS[lang].dir;
  res.locals.LANGS = LANGS;
  res.locals.t = translator(lang);
  next();
}

module.exports = { i18n, LANGS, translator };
