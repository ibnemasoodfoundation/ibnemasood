# Jamia Arabia Abdullah Bin Masood — Web App

The public website of Jamia Arabia Abdullah Bin Masood (Naushahro Feroze, Sindh), plus a signed-in portal with
**sign in / sign up** and three role dashboards: **Admin**, **Manager** and **User (member)**.

Built with Node.js, Express and EJS. Data is stored in **Supabase** (Postgres). Deploys to **Vercel**.

## Deploy on Vercel with Supabase

1. **Supabase:** open your project → **Connect** → copy the **Transaction pooler** connection string
   (port `6543`) for Vercel's serverless runtime. Replace `[YOUR-PASSWORD]` with your database password.
   The direct database URL (port `5432`) is in `.env.example` for local environments that can reach it.
   Forgot it? **Project Settings → Database → Reset database password**.
2. **Vercel:** Project → **Settings → Environment Variables**, add:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the Transaction pooler connection string from step 1 |
   | `SESSION_SECRET` | any long random text (40+ characters) |
   | `ADMIN_EMAIL` | the first admin's email, e.g. `admin@jaabm.com` |
   | `ADMIN_PASSWORD` | the first admin's password |

3. **Redeploy:** Deployments → ⋯ on the latest → **Redeploy**.

The app uses the `pg` package to connect directly to Supabase Postgres; it does not use Supabase's browser API key.
Keep the database password only in local `.env` or Vercel's encrypted environment variables, never in client code.

On the first request the app creates its tables in Supabase (see [supabase/schema.sql](supabase/schema.sql)) and
the admin account. Sign in at `/login` and change the password from **My profile**.

Row Level Security is switched on for every table with no policies, so Supabase's public REST API and anon key
cannot read them. The app connects directly to Postgres and is not affected.

## Run it locally

Requires Node.js 22.

```bash
npm install
cp .env.example .env      # fill in DATABASE_URL, SESSION_SECRET, ADMIN_PASSWORD
npm start                 # http://localhost:3000
```

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
supabase/schema.sql  Tables, indexes and RLS (run automatically on start)
src/db.js            Supabase / Postgres connection and first-admin seed
src/auth.js          Password hashing (scrypt), CSRF, role guards, sign-in rate limit
src/routes/auth.js   /login, /signup, /logout
src/routes/app.js    /app/... dashboards and features
src/routes/api.js    /api/me, /api/contact (used by the public pages)
views/               EJS templates (auth pages, dashboards)
public/              The public website (HTML, CSS, JS, images)
```

The contact form on the website still opens WhatsApp, and also saves the message so staff see it under **Messages**.
