# City Management Group

## Run locally

Install Node.js 18 or newer, fill in `.env` using `.env.example` as a guide, then run:

```sh
npm start
```

Open `http://localhost:3000`. Do not open `index.html` directly, because the form needs the API server.

## Email notifications

Fill in `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, and `MAIL_TO` in `.env`. For Gmail, create an App Password and use it for `SMTP_PASS`; do not use your regular account password. A request is saved even when email delivery is unavailable.

## Admin panel

Open `http://localhost:3000/admin` and sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD` from `.env` (use a unique password of at least 15 characters). The panel can search/filter inquiries, change their status, delete records, and export the current results as CSV. Sessions expire after eight hours. Keep `.env` private and use HTTPS before exposing the server publicly.

## Online deployment checklist

The application is deployable on a Node.js host with a managed PostgreSQL database. Configure the host to run `npm install` during build and `npm start` to launch. Set `NODE_ENV=production`, `HOST=0.0.0.0`, and provide `DATABASE_URL`, a non-default `ADMIN_USERNAME`, a unique `ADMIN_PASSWORD` of at least 15 characters, and the SMTP variables as private environment variables in the host dashboard. Use the provider's internal PostgreSQL URL when available and require TLS for the database connection.

When `DATABASE_URL` is set, startup creates the PostgreSQL schema and imports existing JSONL requests once. The original `.data/requests.jsonl` is left untouched as a backup. Production startup refuses to run without `DATABASE_URL` and a non-default administrator username. Terminate HTTPS at the hosting provider; the admin session cookie is marked `Secure` when `NODE_ENV=production`.

Before switching the live domain, verify the provider's health check at `/api/health`, submit a test request, confirm the email notification, sign in to `/admin`, and confirm data remains after a restart. Configure DNS and Google Search Console only after the host and domain are ready.

## API

- `GET /api/health` checks that the server is running.
- `POST /api/requests` accepts JSON fields `name`, `phone`, `service`, and `details`.
- `GET /api/admin/requests` returns inquiries to an authenticated administrator.

Requests are validated and stored in PostgreSQL when `DATABASE_URL` is present; otherwise they are appended to `.data/requests.jsonl` for local development. The data directory is excluded from Git because inquiries contain personal information. There is no public endpoint for reading submissions.

Set `PORT` to change the port. Set `HOST` to limit which network interface the server listens on.