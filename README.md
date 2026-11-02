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

## Public website

- Static pages in `public/` (Home, About with the founder's biography, Education, Donations, Contact).
- Live pages from the database: `/makatib` (searchable directory), `/makatib/<code>`, `/branches`,
  `/branches/<code>`, `/gallery`.
- Only approved details are public: name, area, programmes, the contact number when "Show its contact number
  publicly" is ticked, and photos marked "Show on website". Addresses, managers, notes, teachers, students and
  documents are never shown. Teacher and student photos and all documents can never be made public: the database
  rejects it (`attachments_public_check`).
- The figures "≈190 Makatib" and "5,000+ students" are institution-approved and shown until the directory is complete.

## Deploying on Vercel with Supabase

Vercel's disk is read-only, so online the app needs a hosted database and file storage. Add these in
Vercel > Project > Settings > Environment Variables, then redeploy:

| Name | Value |
|---|---|
| `SESSION_SECRET` | long random text (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | the first admin account |
| `DATABASE_URL` | Supabase > Connect > Transaction pooler URI, with the real database password (special characters percent-encoded) |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | Supabase > Project Settings > API Keys > Secret key (`sb_secret_...`) |

- Tables are created by the app itself on first start (from [db/migrations/](db/migrations/)); do not run
  `supabase db push` for them.
- Photos and documents go to a private Storage bucket named `uploads`, created automatically. They are served only
  through the app's permission checks, never by public Supabase links.
- The publishable key and `@supabase/supabase-js` are not used: the browser never talks to Supabase directly.
- `/api/health` shows `"ok": true` and `"files": "supabase-storage"` when everything is connected.
- Local data is not copied to Supabase.

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
src/routes/public.js Public Makatib/branch directory, gallery, approved photos (/media)
views/               EJS templates (auth pages, dashboards)
public/              The public website (HTML, CSS, JS, images)
data/                Local database files (git-ignored)
uploads/             Uploaded photos and documents (git-ignored)
```

The contact form on the website still opens WhatsApp, and also saves the message so staff see it under **Messages**.
