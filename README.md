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
- On first start the app creates the tables from [db/schema.sql](db/schema.sql) and the admin account from
  `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Sign in at `/login`.
- `/api/health` shows `"ok": true` when the database is working.
- `npm run dev` restarts the server automatically when you edit files.

## Moving to a hosted database later

The SQL is standard PostgreSQL. Set `DATABASE_URL` to a hosted Postgres connection string and the app uses it
instead of the local database, creating any missing tables on start. Local data is not copied over.

## Roles

| | User (member) | Manager | Admin |
|---|:-:|:-:|:-:|
| Sign up, edit profile, change password | ✓ | ✓ | ✓ |
| Apply for admission, follow application status | ✓ | ✓ | ✓ |
| Record own donations, see own giving | ✓ | ✓ | ✓ |
| Read announcements | ✓ | ✓ | ✓ (incl. staff-only) |
| Review all admissions (approve / waitlist / reject) | | ✓ | ✓ |
| Verify or reject donations, record office donations | | ✓ | ✓ |
| Contact-form messages from the website | | ✓ | ✓ |
| Post announcements | | ✓ | ✓ |
| Add users, change roles, suspend, reset passwords, delete | | | ✓ |
| Activity log | | | ✓ |

New sign-ups are always **Users**. An admin promotes people to Manager or Admin from **Users & roles**.
The app always keeps at least one active admin, and admins cannot demote or delete themselves.

## Structure

```
server.js            Express app (exports the app; listens when run directly)
api/index.js         Vercel serverless entry, wraps server.js
vercel.json          Static files from public/, everything else to the app
db/schema.sql        Tables and indexes (created on start if missing; never dropped)
src/db.js            Local PGlite database, or Postgres via DATABASE_URL
src/auth.js          Password hashing (scrypt), CSRF, role guards, sign-in rate limit
src/routes/auth.js   /login, /signup, /logout
src/routes/app.js    /app/... dashboards and features
src/routes/api.js    /api/me, /api/contact (used by the public pages)
views/               EJS templates (auth pages, dashboards)
public/              The public website (HTML, CSS, JS, images)
data/                Local database files (git-ignored)
```

The contact form on the website still opens WhatsApp, and also saves the message so staff see it under **Messages**.
