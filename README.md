# Escape Villa · TypeScript

This project now uses TypeScript for both the browser application (`app.ts`) and the HTTP/SQLite backend (`server.ts`). The server uses Node.js built-in `node:sqlite` and the public pages and portal UI are emitted as browser JavaScript during the build.

## Run locally

1. Install Node.js 24.15 or newer and npm. This uses the built-in `node:sqlite` API, which Node currently documents as release candidate in 24.15.
2. In this folder run `npm install`.
3. Set a one-time setup key and a private session secret. In PowerShell:

   ```powershell
   $env:ESCAPE_VILLA_SETUP_KEY = "use-a-long-random-one-time-value"
   $env:ESCAPE_VILLA_SECRET = "use-a-long-random-secret"
   npm start
   ```

4. Open http://127.0.0.1:8000 and go to `/admin/setup` to create the first administrator. Customers can register at `/register`.

If the browser-based one-time setup key is unavailable, stop the server and run `npm run setup:admin` in this folder. It builds the app and prompts locally for the first administrator's name, email, and password. Then restart the server and sign in at `/admin/login`.

To recover a forgotten administrator login when exactly one admin account exists, set a private `ESCAPE_VILLA_ADMIN_RECOVERY_KEY` of at least 32 characters in the hosting environment and redeploy. Open `/admin/recover`, enter that key and the replacement name, email, and password. Remove the recovery key from the hosting environment as soon as recovery is complete. The admin dashboard also includes settings for later email and password changes; those require the current password.

For a full account reset, configure both `ESCAPE_VILLA_SETUP_KEY` and a private `ESCAPE_VILLA_RESET_ALL_KEY` (at least 32 characters) in the hosting environment, then redeploy. Visit `/admin/reset-all`, enter the reset key and type `ERASE ALL ACCOUNTS`. This removes all users, bookings, payment records, staff assignments and tasks, booking changes, notifications, and activity history. It retains services, site settings, and contact enquiries. Create the new administrator at `/admin/setup`, then remove `ESCAPE_VILLA_RESET_ALL_KEY` from the hosting environment. The reset rotates the session signing secret to invalidate existing login cookies.

`npm run build` compiles TypeScript into `dist/`. For local development, the app uses SQLite at `dist/data/escape-villa.sqlite3` by default; set `DATABASE_PATH` to select another local file. For hosted deployments, set both `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to use a persistent Turso database. Set neither to use local SQLite. Do not commit or share the Turso token. Keep `ESCAPE_VILLA_SETUP_KEY` private; administrator setup becomes unavailable after the first admin exists.

## Current implementation scope

The TypeScript version includes separate public pages, client registration and login, protected customer/admin/staff routes, SQLite-backed bookings, overlap checks, contact enquiries, an administrator reports page with daily, weekly (Monday–Sunday), and monthly periods, period summaries and CSV booking exports, payment-proof upload and admin review controls, automatic skill-based staff assignment on approval, staff task updates, and in-app notifications. Approving a payment marks the customer booking as “Booking approved”; the admin dashboard then attempts to assign an available staff member. Reports are calculated from saved event dates, bookings, payment statuses, and tasks. The booking catalog includes the proposed photography, videography, event planning, makeup and private-dinner packages with ZAR prices; venue hire, catering, décor rentals and supplier costs are quoted separately unless explicitly included.

Approval emails are sent through Resend when `RESEND_API_KEY` and `ESCAPE_VILLA_EMAIL_FROM` are configured in the hosting environment. The sender address must be verified with Resend for customer delivery. If email is not configured or delivery fails, the admin still sees that booking approval succeeded and is told that the email was not sent. Manual staff assignment, booking-change approval UI, package price/content editing, gallery editing, staff hours and leave, task templates, password reset, reminder scheduler, and advanced reporting beyond the included period summaries still need implementation. Outstanding balance reporting and payment reconciliation still need implementation.

Before production, add HTTPS, tested data backups, CSRF protection, rate limiting, secure payment evidence handling, complete POPIA/terms text approved by the owner, provider credentials for email/WhatsApp, and an operational security review. Node's built-in SQLite support is documented as release candidate in Node 24.15; review its status when selecting a production runtime.

## Checks

- `npm run check` type-checks both TypeScript projects.
- `npm run build` compiles and copies the browser assets.

