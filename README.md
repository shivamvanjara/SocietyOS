# SocietyOS

SocietyOS is a JavaScript application for managing residential societies, their buildings, flats, residents, and maintenance billing. It uses a React/Vite web app, an Express API, and PostgreSQL.

## Requirements

- Node.js 22 or newer and npm 10 or newer
- PostgreSQL 15 or newer

## Local setup

1. Copy `.env.example` to `.env` and replace `SESSION_SECRET` with a random value of at least 32 characters.
2. Set `DATABASE_URL` to a PostgreSQL database that you control.
3. Start a local PostgreSQL 16 instance with `docker compose up -d postgres`, or configure your own PostgreSQL instance.
4. Install locked dependencies with `npm ci`.
5. Generate the Prisma client with `npm run db:generate`.
6. Apply the checked-in migration with `npm run db:deploy`.
7. For a first platform administrator, set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` temporarily in your secure environment, then run `npm run db:bootstrap-admin`. Remove the bootstrap password afterward.
8. Start the web app and API with `npm run dev`.

The web app runs at `http://localhost:5173`; the API runs at `http://localhost:4000`. `GET /api/v1/health` checks the API process; `GET /api/v1/health/ready` also checks PostgreSQL connectivity.

## Useful commands

- `npm run build` — build all workspaces
- `npm run db:validate` — validate the Prisma schema without connecting to PostgreSQL
- `npm run lint` — lint JavaScript source
- `npm test` — run API tests
- `npm run db:bootstrap-admin` — create the first platform super administrator once
- `npm run db:studio` — open Prisma Studio

Authentication supports account registration, email verification, login, logout, password recovery and the authenticated profile endpoint at `/api/v1/auth/me`. New accounts receive no session until their verification link is confirmed. Verification tokens are random, stored as hashes, expire after 24 hours and work once. Password reset tokens are random, stored as hashes, expire after 30 minutes, work once, and revoke existing sessions. Local development shows verification and reset links in the app; production sends through Resend and requires `EMAIL_API_KEY` and `EMAIL_FROM`. Society administrators can invite members by email and role; invite codes are shown once, stored only as hashes, expire after seven days, and can be used during registration or by an existing signed-in account. A user can belong to multiple societies and switch the active workspace. Invitations are not emailed automatically, so the administrator must share the code securely. Unsafe browser requests must include the CSRF token returned by email verification, login or `/me` in the `X-CSRF-Token` header. Society administrators can manage buildings, flats and resident records, issue flat charges, record partial or full payments, and review paid and outstanding totals. Resident accounts receive a resident home view with only the flats and charges linked to their account email. Society authorization is checked by the API, and composite PostgreSQL foreign keys keep flat charges and payments within their owning society.

## Current scope

The repository includes a React/Vite client, Express API, PostgreSQL/Prisma schema and migrations, Argon2id password hashing, hashed server-managed sessions, CSRF checks, verified account onboarding, one-time password recovery, administrator authenticator MFA, society onboarding/profile management, role-based member invitations with email, QR join links and in-app scanning, building and flat management, resident records with PII-free audit events, maintenance billing with integer-paise storage, printable payment receipts and PDF/image bill attachments, per-society Razorpay merchant credentials with encrypted secrets and versioned payment-order verification, resident-only views of invoices and their bill documents, society-configured bank transfer and UPI instructions, expense approval with PDF/image bill documents, member notices with read receipts, a tenant-scoped complaint queue with discussion, status transitions and image attachments, facility booking with collision checks and committee approval, one-use visitor passes with camera or manual guard check-in/out, and a platform super-admin console for society and account access, subscription plans, manual society subscription assignments, recurring Razorpay subscription checkout, renewal tracking, cancellation and platform audit history. Society admins and accountants can attach PDF/PNG/JPEG bill documents to invoices; active residents can download documents only for flats linked to their account email. Society administrators can configure bank or UPI transfer details, which are shown to active residents and accountants within that society. Resident online charges are created with that society's own Razorpay merchant credentials; Razorpay settles to the bank account configured in that merchant account. SocietyOS does not collect resident card or bank details. Subscription plan prices are stored in integer paise; assignments snapshot price, interval, and optional building and flat quotas. Configured building and flat quotas are enforced by the API. Society administrators can choose an active plan and open Razorpay-hosted checkout; only signed Razorpay subscription events activate or change paid subscription state. Charge records are idempotent by provider payment ID. Razorpay subscription checkout currently uses finite ten-year billing schedules (120 monthly or 10 annual cycles), reflecting Razorpay's maximum subscription duration. Online subscriptions require platform `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET`; the subscription webhook URL is `/api/v1/subscriptions/webhooks/razorpay`. Each society separately configures its own payment keys and webhook secret on its Billing page. Use Razorpay test credentials and verify test payments and webhook delivery before accepting live payments. Production requires separate `MFA_ENCRYPTION_KEY` and `RAZORPAY_ACCOUNT_ENCRYPTION_KEY` keys. Review the security and deployment guidance before using it with live resident or financial data.
