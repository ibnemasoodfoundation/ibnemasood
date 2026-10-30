# Jamia Arabia Abdullah Bin Masood — Web App

The public website of Jamia Arabia Abdullah Bin Masood (Naushahro Feroze, Sindh), plus a signed-in portal with
**sign in / sign up** and three role dashboards: **Admin**, **Manager** and **User (member)**.

Built with Node.js, Express, EJS and SQLite (built into Node, nothing to install separately).

## Run it

Requires **Node.js 22.13 or newer**.

```bash
npm install
cp .env.example .env      # then edit SESSION_SECRET and ADMIN_PASSWORD
npm start                 # http://localhost:3000
```

On first start the app creates the admin account from `ADMIN_EMAIL` / `ADMIN_PASSWORD`. If no password is set,
one is generated and printed in the console once. Sign in at `/login` and change it from **My profile**.

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
server.js            Express app, sessions, security headers
src/db.js            SQLite schema and first-admin seed
src/auth.js          Password hashing (scrypt), CSRF, role guards, sign-in rate limit
src/routes/auth.js   /login, /signup, /logout
src/routes/app.js    /app/... dashboards and features
src/routes/api.js    /api/me, /api/contact (used by the public pages)
views/               EJS templates (auth pages, dashboards)
public/              The public website (HTML, CSS, JS, images)
data/                SQLite database file (not committed)
```

The contact form on the website still opens WhatsApp, and now also saves the message so staff see it under **Messages**.

## Deploying

Any host that runs Node and keeps files on disk works (a VPS, Render or Railway with a persistent disk, etc.).
Set `NODE_ENV=production`, a long random `SESSION_SECRET`, and point `DB_PATH` to the persistent disk.
Serverless hosts with read-only or temporary filesystems will lose the database, so they are not suitable as-is.
