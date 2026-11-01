# API specification

Base path: `/api/v1`

| Method | Path            | Purpose                                                     |
| ------ | --------------- | ----------------------------------------------------------- |
| GET    | `/health`       | Minimal API process health response                         |
| GET    | `/health/ready` | API and PostgreSQL readiness check                          |
| POST   | `/auth/login`   | Verify credentials and issue a server-managed session       |
| POST   | `/auth/logout`  | Revoke the current session after Origin and CSRF validation |
| GET    | `/auth/me`      | Return the current user and active society memberships      |

Security guards can scan the QR generated from a visitor’s one-time pass code or enter that code manually. The API verifies the code for the active society and consumes it on successful check-in. Guards cannot create passes.

The health endpoint returns `{ "status": "ok", "service": "societyos-api", "timestamp": "..." }`.

Login expects `{ "email": "...", "password": "..." }`. The opaque session is sent only in an HttpOnly cookie; the response body never exposes it. Send the CSRF token returned by login or `/auth/me` as `X-CSRF-Token` on unsafe authenticated requests.

# Society management

## Authentication

- `POST /api/v1/auth/register` — create an unverified account and first society workspace (`email`, password of at least 12 characters, `societyName`, optional `city`) or create an account using an email-matched `inviteCode`. Returns a verification link in local development; production sends it through Resend. Limited to five attempts per hour per client IP.
- `POST /api/v1/auth/email-verification/request` — request a new one-time verification link. The response is generic; in local development it includes a preview URL.
- `POST /api/v1/auth/email-verification/confirm` — verify a 24-hour token, create the first signed-in session and return the CSRF token.
- `POST /api/v1/auth/password-reset/request` — request a single-use password-reset link for an email address. Always returns a generic accepted response for valid requests. In local development the response includes a preview URL; production sends email through the configured Resend account.
- `POST /api/v1/auth/password-reset/confirm` — accept a reset `token` and a new password of at least 12 characters; the token expires after 30 minutes and existing sessions are revoked.
- `POST /api/v1/auth/login` — create a session.
- `POST /api/v1/auth/logout` — revoke the current session.
- `GET /api/v1/auth/me` — return the authenticated user and active society memberships.

Password recovery is available through the sign-in screen and reset endpoints. Accounts created through registration must verify their email before login; existing accounts were grandfathered as verified by the migration.

Society administrators and platform super administrators can use authenticator-based MFA. TOTP secrets are encrypted in the database, and sign-in challenges are short-lived and single-use. Production deployments must configure a stable `MFA_ENCRYPTION_KEY`.

- `GET /api/v1/auth/mfa` — return MFA eligibility and enabled status for the current account.
- `POST /api/v1/auth/mfa/enroll` — verify `{ "password": "..." }`, then return a temporary authenticator secret and `otpauthUrl`.
- `POST /api/v1/auth/mfa/confirm` — enable MFA using `{ "code": "123456" }` from the authenticator app.
- `POST /api/v1/auth/mfa/disable` — disable MFA using the current password and authenticator code.
- `POST /api/v1/auth/mfa/verify` — complete a password-verified login using the short-lived challenge cookie and `{ "code": "123456" }`.

## Member access and invitations

Only active society administrators can list members and issue invitations. Invitations are scoped to one society and email address, expire after seven days, and store only a SHA-256 hash of the one-time code. The administrator receives the code once; the app generates a QR containing a registration link with that transient code. A phone camera opens registration directly, and the in-app scanner also accepts the QR link or raw code. When transactional email is configured, the invitee receives the same join link; in local development a preview link is returned. Delivery failures do not invalidate the invitation, and the admin can share the QR or code. Acceptance must use the invited email address. Users with memberships in multiple societies can switch workspaces in the client.

- `GET /api/v1/societies/:societyId/invitations/members` — list society memberships and unexpired invitations (administrator only).
- `POST /api/v1/societies/:societyId/invitations` — invite an email using role `COMMITTEE_MEMBER`, `ACCOUNTANT`, `RESIDENT`, or `SECURITY_GUARD`; returns the one-time `code`, `emailSent` state and, in local development, a `previewUrl`.
- `POST /api/v1/invitations/accept` — accept `{ "code": "..." }` for an existing authenticated account whose email matches the invitation.

## Platform administration

Platform administration routes require an authenticated `SUPER_ADMIN` account. All status changes also require same-origin CSRF validation. Society and account listings support case-insensitive search, optional `ACTIVE`/`SUSPENDED` filters, and cursor pagination (default 50, maximum 100).

- `GET /api/v1/platform-admin/overview` — real platform-wide society, account, and flat totals, including the current administrator ID.
- `GET /api/v1/platform-admin/societies` — list societies with membership, building, and flat counts.
- `GET /api/v1/platform-admin/users` — list accounts with platform role and membership counts.
- `GET /api/v1/platform-admin/audit-log` — read recent platform access changes and actor identities.
- `PATCH /api/v1/platform-admin/societies/:societyId/status` — activate or suspend a society.
- `PATCH /api/v1/platform-admin/users/:userId/status` — activate or suspend an account; suspension revokes its sessions. The last active super-admin and the current super-admin cannot be suspended.
- `GET /api/v1/platform-admin/subscription-plans` — list configured plans.
- `POST /api/v1/platform-admin/subscription-plans` — create a monthly or annual plan with an INR `price` string (stored as integer paise) and optional maximum building and flat counts.
- `PATCH /api/v1/platform-admin/subscription-plans/:planId` — update plan details or disable it for new assignments. Existing subscriptions preserve their price and interval snapshot.
- `GET /api/v1/platform-admin/subscriptions` — list society subscriptions with status, plan, price, interval, and assigning account.
- `POST /api/v1/platform-admin/societies/:societyId/subscriptions` — assign an active plan to an active society as `ACTIVE` or `TRIAL`; only one non-terminal subscription can exist at a time.
- `PATCH /api/v1/platform-admin/subscriptions/:subscriptionId/status` — transition subscription lifecycle status; canceled or expired subscriptions are terminal.

Platform status changes and their audit rows commit in one transaction. Platform scope is derived from the authenticated user's stored role; clients cannot provide a platform role or tenant scope.

Subscription plan prices and assigned price, interval, and quota snapshots are stored in integer paise and relational columns. Society row locks serialize concurrent subscription assignments, reactivations, building creation, and flat creation. Configured building and flat caps are enforced by the API. New building or flat creation is blocked when a society has subscription history but no current active or trial subscription; societies with no subscription history remain grandfathered without caps. These routes provide manual plan and lifecycle administration; they do not collect recurring subscription payments or automatically renew plans.

Building and flat creation returns `409 PLAN_LIMIT_REACHED` when an active plan quota is full and `402 SUBSCRIPTION_REQUIRED` when a society with subscription history has no current active or trial subscription.

## Expense records

Accountants and administrators can submit society expenses and attach up to ten PDF, PNG, or JPEG bill documents per expense (5 MB each). Files are stored as PostgreSQL bytea data and only available to society administrators and accountants. New expenses remain `SUBMITTED` until a different society administrator approves them or an administrator rejects them with a reason. Approved amounts are included in the approved total; rejected and pending items remain in the ledger for history.

- `POST /api/v1/societies/:societyId/expenses/:expenseId/attachments` — upload one bill document as a raw request body. Set its MIME `Content-Type`, `X-File-Name` (URL-encoded), and the session CSRF header.
- `GET /api/v1/societies/:societyId/expenses/:expenseId/attachments/:attachmentId` — download a document visible to that society’s financial staff.
- `POST /api/v1/societies/:societyId/expenses/:expenseId/approve` — administrator-only approval; the submitter cannot approve their own expense.
- `POST /api/v1/societies/:societyId/expenses/:expenseId/reject` — administrator-only rejection with `{ "reason": "..." }`.

All society endpoints require an authenticated server session. `POST` and `PATCH` also require the configured same-origin `Origin` and the session-bound `X-CSRF-Token` returned by `/api/v1/auth/login` or `/api/v1/auth/me`.

- `GET /api/v1/societies` — list active societies through the caller's active memberships.
- `POST /api/v1/societies` — create a society and its initial `SOCIETY_ADMIN` membership atomically. Accepts `name` and optional address and registration fields.
- `GET /api/v1/societies/:societyId` — return one society only when the caller has an active membership.
- `PATCH /api/v1/societies/:societyId` — update profile fields only for an active `SOCIETY_ADMIN` member.

Society IDs in request bodies do not grant access. Reads and updates resolve membership using the authenticated user ID. Unknown or inaccessible society IDs return the same `404` response.

## Buildings and flats

Every endpoint requires an active membership in the path society. Creation and edits require the `SOCIETY_ADMIN` role and a valid same-origin CSRF token. The society ID is always derived from the validated route plus the server-side membership; clients cannot assign records to another tenant.

- `GET /api/v1/societies/:societyId/buildings` — list buildings and real flat occupancy totals for the society.
- `POST /api/v1/societies/:societyId/buildings` — create a building.
- `PATCH /api/v1/societies/:societyId/buildings/:buildingId` — rename a building inside that society.
- `GET /api/v1/societies/:societyId/buildings/:buildingId/flats` — list flats in an accessible building.
- `POST /api/v1/societies/:societyId/buildings/:buildingId/flats` — create a flat with a unique number within its building.
- `PATCH /api/v1/societies/:societyId/buildings/:buildingId/flats/:flatId` — update flat number, floor, type, or occupancy.

Building and flat list endpoints accept an optional `limit` (1–100, default 50) and opaque UUID `cursor`; the response returns `nextCursor` when more records are available. PostgreSQL composite foreign keys ensure a flat's society and building belong to the same tenant. Floor numbers are constrained to -5 through 200 in both request validation and the database.

## Residents

Resident contact records are restricted to society administrators. Reads support `limit`, `cursor`, `status`, `flatId`, and `search`. Writes require a same-origin CSRF token, verify the target flat belongs to the active society, and create an audit event in the same transaction. Audit entries record the actor, event, resource type and ID; they deliberately omit resident contact details.

- `GET /api/v1/societies/:societyId/residents/me` — return active resident profiles linked to the signed-in resident account email, including their own flat details.
- `GET /api/v1/societies/:societyId/residents` — list and search resident records.
- `POST /api/v1/societies/:societyId/residents` — create an owner or tenant record assigned to a society flat.
- `PATCH /api/v1/societies/:societyId/residents/:residentId` — update the record or mark it inactive. Records are retained instead of deleted.

## Billing

Billing management endpoints are restricted to active society administrators and accountants. Writes require the same-origin CSRF token. Charges must target a flat in the route society. Each receipt is checked against the locked invoice balance, and invoice and receipt references carry composite society keys in PostgreSQL. Residents can view charges only for active resident records whose email matches their signed-in account.

- `GET /api/v1/societies/:societyId/billing/mine` — return the resident's linked homes, charges, balances, and recorded receipts.
- `GET /api/v1/societies/:societyId/billing` — list charges with receipts, paid amount, balance, and status.
- `POST /api/v1/societies/:societyId/billing/generate` — issue one monthly charge to each occupied home by default, or all homes when `scope` is `ALL`; unique flat, period, and description combinations are skipped safely.
- `POST /api/v1/societies/:societyId/billing` — issue a flat charge with description, `YYYY-MM` period, positive amount, and due date.
- `POST /api/v1/societies/:societyId/billing/:invoiceId/payments` — record a cash, bank transfer, UPI, cheque, or other receipt. Partial payments are supported; overpayments are rejected.
- `GET /api/v1/societies/:societyId/billing/payments/:paymentId/receipt` — return a printable receipt to society administrators/accountants or a resident linked to that payment's flat.
- `GET /api/v1/societies/:societyId/billing/razorpay-account` — return the configured public key ID to the society administrator without exposing secrets.
- `PUT /api/v1/societies/:societyId/billing/razorpay-account` — connect `{ "enabled": true, "keyId": "rzp_test_…", "keySecret": "…", "webhookSecret": "…" }` or disable online collections with `{ "enabled": false }`. Only society administrators may configure merchant credentials; secrets are write-only and encrypted at rest.

### Online resident payments

Razorpay orders are created only for an authenticated resident's own email-linked flat and the server-calculated outstanding balance. Each society uses its own merchant account so Razorpay settlement goes to the bank account registered with that account. A checkout callback is not trusted by itself: SocietyOS verifies its HMAC signature and fetches the provider payment with the credential version attached to that order, confirming the matching order, amount, INR currency, and captured status before creating a receipt. Merchant API and webhook secrets are encrypted with `RAZORPAY_ACCOUNT_ENCRYPTION_KEY`; society subscription billing uses separate platform-level Razorpay environment credentials.

- `GET /api/v1/societies/:societyId/payments/status` — report whether this society has an active merchant account for resident checkout.
- `POST /api/v1/societies/:societyId/payments/orders` — create or reuse an order for `{ "invoiceId": "..." }` based on the current balance.
- `POST /api/v1/societies/:societyId/payments/verify` — verify a captured payment callback and record the receipt idempotently.
- `POST /api/v1/societies/:societyId/payments/:orderId/cancel` — close an unused order when the resident dismisses checkout.
- `POST /api/v1/payments/webhooks/razorpay` — select the webhook secret associated with the referenced payment order, verify the raw-body signature, and process captured or failed events idempotently. Each society merchant configures this URL with its own webhook secret and the `payment.captured` and `payment.failed` events.

## Expenses

Expense records are visible to active society administrators and accountants. Creation requires same-origin CSRF validation and writes an audit event. Amounts are persisted in integer paise.

- `GET /api/v1/societies/:societyId/expenses` — list recent expenses and their recorded total.
- `POST /api/v1/societies/:societyId/expenses` — add an expense with category, description, date, amount, and optional vendor/reference.

## Notices

Every society member can view current notices and record a personal read receipt. Society administrators and committee members can publish notices. Expiry dates must follow publication dates; publishing is audited without copying notice contents into the audit event.

- `GET /api/v1/societies/:societyId/notices` — list current notices and the caller's read status.
- `POST /api/v1/societies/:societyId/notices` — publish a notice, optionally scheduled or expiring.
- `POST /api/v1/societies/:societyId/notices/:noticeId/read` — record or confirm the caller's read receipt.

## Complaints

Any society member can submit a complaint and view or discuss their own submissions. Society administrators and committee members can review the society queue and move a complaint through valid status transitions. Resolution requires a note. Reads, updates, replies, and audit events remain scoped to the route society.

- `GET /api/v1/societies/:societyId/complaints` — list the caller's complaints, or the society queue for authorized staff.
- `POST /api/v1/societies/:societyId/complaints` — submit a complaint with a category and priority.
- `POST /api/v1/societies/:societyId/complaints/:complaintId/attachments` — add one JPEG, PNG, or WebP image (up to 5 MB); up to five images per complaint. Only its submitter and society administrators or committee members can access it.
- `GET /api/v1/societies/:societyId/complaints/:complaintId/attachments/:attachmentId` — download an image after the same role and ownership checks.
- `PATCH /api/v1/societies/:societyId/complaints/:complaintId` — advance the complaint status and provide resolution details.
- `POST /api/v1/societies/:societyId/complaints/:complaintId/comments` — add a reply to a complaint visible to the caller.

## Facility bookings

Society members can request future slots at active facilities. The facility row is locked while the API checks and creates a request, preventing concurrent overlapping requests. Requests reserve the slot while pending; committee members or administrators can approve or reject. Members only see their own booking history.

- `GET /api/v1/societies/:societyId/facilities` — list facilities available to the member.
- `POST /api/v1/societies/:societyId/facilities` — register a facility (administrator only).
- `PATCH /api/v1/societies/:societyId/facilities/:facilityId` — activate or deactivate a facility (administrator only).
- `GET /api/v1/societies/:societyId/facilities/bookings` — list the caller's requests, or the queue for authorized staff.
- `POST /api/v1/societies/:societyId/facilities/bookings` — request a future time slot up to 12 hours.
- `PATCH /api/v1/societies/:societyId/facilities/bookings/:bookingId/status` — approve or reject a pending request.
- `POST /api/v1/societies/:societyId/facilities/bookings/:bookingId/cancel` — cancel a future request or approved booking.

## Visitors

Administrators and committee members can create passes for any society flat. A resident can create a pass only for a flat with an active resident record whose email matches their account. Passes use cryptographically random one-use codes; only a SHA-256 hash is stored. The plaintext code is returned once and encoded into a QR image in the browser. Security guards can scan that QR code or enter the code manually; the server validates and consumes it atomically. Codes expire six hours after expected arrival. Camera scanning requires browser camera permission and a secure context (localhost or HTTPS).

- `GET /api/v1/societies/:societyId/visitors/flats` — list eligible host flats for the current member.
- `GET /api/v1/societies/:societyId/visitors/passes` — list passes visible to the caller's role.
- `POST /api/v1/societies/:societyId/visitors/passes` — create a timed pass and return its one-time plaintext code.
- `POST /api/v1/societies/:societyId/visitors/verify` — validate a code and atomically check the visitor in.
- `POST /api/v1/societies/:societyId/visitors/passes/:passId/checkout` — record visitor exit.
- `POST /api/v1/societies/:societyId/visitors/passes/:passId/cancel` — cancel an unused future pass.
