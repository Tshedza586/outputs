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

`npm run build` compiles TypeScript into `dist/`. SQLite data is stored in `dist/data/escape-villa.sqlite3` by default. Set `DATABASE_PATH` to choose a persistent location for deployment. Keep `ESCAPE_VILLA_SETUP_KEY` private; administrator setup becomes unavailable after the first admin exists.

## Current implementation scope

The TypeScript version includes separate public pages, client registration and login, protected customer/admin/staff routes, SQLite-backed bookings, overlap checks, contact enquiries, an administrator reports page with daily, weekly (Monday–Sunday), and monthly periods, period summaries and CSV booking exports, admin payment decision endpoint, basic automatic task assignment, staff task updates, and in-app notifications. Reports are calculated from saved event dates, bookings, payment statuses, and tasks. No real Escape Villa prices, contact channels, staff, testimonials, or payment details are seeded.

The master brief's full availability calendar, payment-proof file upload and review UI, booking-change approval UI, package/gallery editing, staff hours and leave, task templates, password reset, reminder scheduler, advanced reporting beyond the included period summaries, and complete audit history still need implementation. Payment approval is guarded so the backend cannot approve a booking unless evidence has first been recorded; the evidence upload workflow is not included in this TypeScript build yet. Outstanding balances cannot be calculated until expected prices are configured.

Before production, add HTTPS, tested data backups, CSRF protection, rate limiting, secure payment evidence handling, complete POPIA/terms text approved by the owner, provider credentials for email/WhatsApp, and an operational security review. Node's built-in SQLite support is documented as release candidate in Node 24.15; review its status when selecting a production runtime.

## Checks

- `npm run check` type-checks both TypeScript projects.
- `npm run build` compiles and copies the browser assets.

