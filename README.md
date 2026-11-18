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
| `DATABASE_URL` | Supabase > Connect > Transaction pooler URI, with the real database password (special characters percent-encoded). Not needed when the Supabase integration is installed on Vercel: its `POSTGRES_URL` is used first and stays correct after a password reset |
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

Every role has its own dashboard after signing in.

| | Member | Parent | Teacher | Accountant | School Principal | Makatib Nazim | Branch Manager | Super Admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Own profile, password, announcements | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Apply for admission, record own donations | ✓ | | | | | | ✓ | ✓ |
| Own children: attendance, progress, published results, certificates | | ✓ | | | | | | |
| Mark attendance and enter marks for own students | | | ✓ | | ✓ | ✓ | ✓ | ✓ |
| Teachers, students, attendance, exams, results, reports | | | | | own school | all Makatib | own branches | everywhere |
| Register Makatib | | | | | | ✓ | own branches | ✓ |
| Schools | | | | | edit own | | own branches | ✓ |
| Accounts: income, expenses, financial reports; verify donations | | | | ✓ | | | donations only | ✓ |
| Admissions, messages | | | | | | | ✓ | ✓ |
| Add branches, archive branches, Makatib and schools | | | | | | | | ✓ |
| Users, roles, teacher logins, activity log | | | | | | | | ✓ |

- A **Branch Manager** manages the branches where they are set as manager (Branch → Edit → Branch manager), every
  Maktab and school in those branches, and any Maktab where they are set as Maktab manager.
- A **Makatib Nazim** manages every Maktab with its teachers, students, attendance, reports and results.
- A **School Principal** manages the schools where they are set as principal (School → Edit → School Principal).
- An **Accountant** records income and expenses and prints financial reports. Verified donations count as income
  automatically, so they are never entered twice.
- A **Parent** login is created on the student's form (Parent portal access: email and password). Brothers and sisters
  share one login by entering the same email. Parents see only their own children, never CNIC numbers or documents.
- A **Teacher** login is created by a Super Admin from the teacher's profile. Teachers see only their own teacher
  record, their Maktab's or school's students and students assigned to them; they enter marks while an exam is a draft.
- Staff accounts for the other roles are created by a Super Admin under **Users & roles**.
- All of this is checked on the server for every request, not only by hiding menu items.

New sign-ups are always **Members**. The app always keeps at least one active admin, and admins cannot demote or
delete themselves.

## Exams, results and certificates

Create an exam for all Makatib, one Maktab or one school, with its subjects and total marks (suggested Makatib
subjects are filled in and can be changed). Enter marks per student, then **Publish**: parents then see the result and
can print the **result certificate**. The result sheet and certificates print or download as PDF. Grades: A+ 90%,
A 80%, B 70%, C 60%, D 50%, E below 50%, Fail below the exam's pass mark (40% unless changed).

## Main branches: Boys and Girls

The Jamia has two main branches: **Jamia Arabia Abdullah Bin Masood (Boys)** and **Jamia Arabia Aisha Siddiqa (Girls)**.
Every branch is marked as belonging to one of them (Branch → Edit → Main branch). The **All · Boys · Girls** switch in
the portal header then shows only that main branch everywhere: branches, Makatib, schools, teachers, students,
attendance, results and dashboards. Both main branches are created automatically if they do not exist.

## Printed documents

- **Admission form** (Iqra Islamia Public School): blank from Certificates → Blank admission form, or filled in from a
  student's profile → Admission form. The extra details (G.R. No, surname, guardian, religion, fees…) are under
  "Admission form details" on the student's form.
- **School Leaving Certificate** and **Shahadat al-Alamiyyah**: student's profile → Certificates. They are saved, so
  they can be reprinted with the same details and number. The Alamiyyah certificate takes its marks (out of 600) and
  Arabic grade from an exam result and is printed on the original certificate artwork, or text only for pre-printed paper.

## Backup and restore

Users & roles → **Backup** (Super Admin): download one file with all the data (optionally with photos and documents)
and restore it on this server (merge) or on a new server or local computer (replace everything). A restore runs in one
transaction, so a failed restore changes nothing. The backup holds private data: keep it safe.

## Working without internet

The portal installs as an app and keeps the pages you open on the device. Without internet those pages still open,
and forms you save (attendance, marks, progress, registrations) wait on the device and are sent automatically, in order,
when the connection returns. Pages never opened on that device are not available offline. Signing out removes the
saved pages from the device.

## Languages

- **Portal:** English or اردو from the switch in the header. Menus, roles and page titles are translated and the
  layout turns right-to-left; names and records stay as entered. Translation happens on the server, so no student data
  is sent to any outside service.
- **Public website:** English, اردو, سنڌي or العربية from the globe button in the header, using Google's page
  translation. Urdu and Arabic text, Quranic verses and the founder's name are marked so they are never machine-translated.

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
src/routes/schools.js      Schools and their principals
src/routes/results.js      Exams, marks, result sheets and certificates
src/routes/finance.js      Accounts: income, expenses, dashboard and financial reports
src/routes/parent.js       Parent portal: their children's details
src/i18n.js          Portal languages (English, Urdu)
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
