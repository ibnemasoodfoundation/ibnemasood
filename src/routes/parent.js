/* Parent portal: a parent sees only their own children (students.parent_user_id), read-only:
   profile basics, attendance, progress, published results and certificates, and announcements. */
"use strict";
const express = require("express");
const { one, all } = require("../db");
const { checkCsrf, requireRole } = require("../auth");
const { attendanceSummary } = require("./people");
const { helpers: h } = require("./institution");

const router = express.Router();
const parentOnly = [requireRole("parent"), checkCsrf];

/* Only columns a parent should see; CNIC, notes and documents stay with the office */
const CHILD_COLS = `s.id, s.code, s.full_name, s.name_ur, s.father_name, s.gender, s.dob, s.class_name, s.programme, s.quran_level,
  s.hifz_status, s.status, s.enrolled_on, m.name_en AS maktab, m.name_ur AS maktab_ur, sc.name_en AS school, b.name_en AS branch, t.full_name AS teacher`;
const CHILD_FROM = `FROM students s LEFT JOIN makatib m ON m.id = s.maktab_id LEFT JOIN schools sc ON sc.id = s.school_id
  LEFT JOIN branches b ON b.id = s.branch_id LEFT JOIN teachers t ON t.id = s.teacher_id`;

const children = (userId) => all(`SELECT ${CHILD_COLS} ${CHILD_FROM} WHERE s.parent_user_id = ? ORDER BY s.full_name`, userId);
const photoOf = (id) => one("SELECT id FROM attachments WHERE entity_type = 'student' AND entity_id = ? AND kind = 'photo' ORDER BY id DESC LIMIT 1", id);
const publishedResults = (id, limit = 50) => all(`SELECT r.exam_id, r.obtained, r.total, r.percentage, r.grade, e.title, e.exam_type, e.session_year, e.held_on
  FROM results r JOIN exams e ON e.id = r.exam_id WHERE r.student_id = ? AND e.status = 'published'
  ORDER BY e.held_on DESC NULLS LAST, e.id DESC LIMIT ?`, id, limit);

/* Dashboard data for every child of this parent */
async function parentHome(user) {
  const kids = await children(user.id);
  for (const k of kids) {
    const [photo, att, recent, results, progress] = await Promise.all([
      photoOf(k.id), attendanceSummary("student", k.id),
      all("SELECT att_date, session, status FROM student_attendance WHERE student_id = ? ORDER BY att_date DESC, session LIMIT 10", k.id),
      publishedResults(k.id, 3),
      all("SELECT recorded_on, quran_level, lesson, remarks FROM student_progress WHERE student_id = ? ORDER BY recorded_on DESC, id DESC LIMIT 3", k.id),
    ]);
    Object.assign(k, { photo, att, recent, results, progress });
  }
  return kids;
}

router.get("/children/:id", parentOnly, async (req, res, next) => {
  const id = h.int(req.params.id);
  const k = id && await one(`SELECT ${CHILD_COLS} ${CHILD_FROM} WHERE s.id = ? AND s.parent_user_id = ?`, id, req.user.id);
  if (!k) return next(); // another family's child looks exactly like a missing page
  const [photo, att, attendance, progress, results] = await Promise.all([
    photoOf(k.id), attendanceSummary("student", k.id),
    all(`SELECT att_date, session, status, note FROM student_attendance WHERE student_id = ?
         AND att_date >= CURRENT_DATE - 60 ORDER BY att_date DESC, session`, k.id),
    all("SELECT recorded_on, quran_level, lesson, remarks FROM student_progress WHERE student_id = ? ORDER BY recorded_on DESC, id DESC LIMIT 50", k.id),
    publishedResults(k.id),
  ]);
  res.render("app/child", { title: k.full_name, k, photo, att, attendance, progress, results });
});

module.exports = router;
module.exports.parentHome = parentHome;
