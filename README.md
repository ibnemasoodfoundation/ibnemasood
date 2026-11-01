# Jamia Arabia Abdullah Bin Masood — Web App

The public website of Jamia Arabia Abdullah Bin Masood (Naushahro Feroze, Sindh), plus a signed-in portal with
**sign in / sign up** and three role dashboards: **Admin**, **Manager** and **User (member)**.

Built with Node.js, Express and EJS on PostgreSQL. For local development the database runs inside the app
(PGlite), so there is nothing to install or sign up for.

## Run it locally

Requires Node.js 22 or newer.

```bash
npm install
cp .env.example .env      # set SESSION_SECRET and ADMIN_PASSWORD
npm start                 # http://localhost:3000
```

- Data is saved in `data/pgdata` (git-ignored). Stop the server and delete that folder to start fresh.
- On start the app applies any new migrations from [db/migrations/](db/migrations/) (each once, in order,
  additive only) and creates the admin account from `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Sign in at `/login`.
- Branch and Maktab photos and documents are saved in `uploads/` (git-ignored) and are only served to staff.
- `/api/health` shows `"ok": true` when the database is working.
- `npm run dev` restarts the server automatically when you edit files.

## Moving to a hosted database later

The SQL is standard PostgreSQL. Set `DATABASE_URL` to a hosted Postgres connection string and the app uses it
instead of the local database, creating any missing tables on start. Local data is not copied over.

## Roles

| | Member | Teacher | Branch Manager | Super Admin |
|---|:-:|:-:|:-:|:-:|
| Sign up, own profile, password | ✓ | ✓ | ✓ | ✓ |
| Apply for admission, record own donations | ✓ | | ✓ | ✓ |
| See own Maktab and students, mark their attendance (last 7 days), record progress | | ✓ | ✓ | ✓ |
| Update own contact details | | ✓ | ✓ | ✓ |
| Teachers, students, Makatib, attendance and reports | | | own branches | everywhere |
| Register / edit / transfer / archive teachers and students, photos and documents | | | own branches | everywhere |
| Teacher attendance | | | own branches | everywhere |
| Admissions, donations, messages, announcements | | | ✓ | ✓ |
| Add branches, archive branches and Makatib | | | | ✓ |
| Users, roles, teacher logins, activity log | | | | ✓ |

- A **Branch Manager** manages the branches where they are set as manager (Branch → Edit → Branch manager), every
  Maktab in those branches, and any Maktab where they are set as Maktab manager. One manager can run several branches.
- A **Teacher** login is created by a Super Admin from the teacher's profile. Teachers see only their own teacher
  record (not colleagues' CNIC, salary or documents), their Maktab's students and students assigned to them.
- All of this is checked on the server for every request, not only by hiding menu items.

New sign-ups are always **Members**. A Super Admin changes roles under **Users & roles**.
The app always keeps at least one active admin, and admins cannot demote or delete themselves.

## Structure

```
server.js            Express app (exports the app; listens when run directly)
api/index.js         Vercel serverless entry, wraps server.js
vercel.json          Static files from public/, everything else to the app
db/migrations/       SQL migrations, applied in order on start (also usable in any Postgres SQL editor)
src/db.js            Local PGlite database (or Postgres via DATABASE_URL) and the migration runner
src/dashboard.js     Staff dashboard statistics and chart data
src/uploads.js       Photo and document uploads (type and size checks)
src/scope.js         Who can see and change what (enforced on every request)
src/routes/institution.js  Branches, Makatib, photo/document files
src/routes/people.js Teachers and students: profiles, transfers, logins, progress, print, ID cards
src/routes/attendance.js   Student and teacher attendance, monthly sheets, reports
src/auth.js          Password hashing (scrypt), CSRF, role guards, sign-in rate limit
src/routes/auth.js   /login, /signup, /logout
src/routes/app.js    /app/... dashboards and features
src/routes/api.js    /api/me, /api/contact (used by the public pages)
views/               EJS templates (auth pages, dashboards)
public/              The public website (HTML, CSS, JS, images)
data/                Local database files (git-ignored)
uploads/             Uploaded photos and documents (git-ignored)
```

The contact form on the website still opens WhatsApp, and also saves the message so staff see it under **Messages**.
