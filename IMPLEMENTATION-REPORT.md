# NearBuy repair report

## Scope and result

This is an authentication-first repair of the existing application, not a replacement. The existing Node/SQLite architecture, storefront, Seller Hub, Runner Portal, Admin Portal, product data and workflows are retained. The full requested site-wide redesign and browser/manual audit are **not complete**. No live Netlify deployment or external database was accessed or verified.

## Problems discovered and fixed

1. **Cross-portal CSRF selection:** customer, partner and admin cookies can coexist, but the API previously selected the first available cookie for mutation verification. A customer cookie could therefore cause a valid seller/admin request to fail. Verification now selects the session for the API namespace. Added a regression test using all cookies in one browser-like client.
2. **Stale session roles:** session restoration trusted the role copied into the session record. It now reads the current role from the user record, so role changes are reflected without waiting for expiry.
3. **Demo login friction:** added `/demo/` with four accessible, responsive cards. Each calls a server endpoint that finds a real seeded identity, checks role/demo status, writes a hashed-token database session, and sets an HttpOnly cookie. No frontend-only authentication state or passwords are sent by the launcher.
4. **Demo safety:** existing demo accounts cannot start sessions or restore sessions when demo mode is disabled. In production or explicit `DEMO_SANDBOX=1` mode, demo admins are denied protected API access when non-demo users/orders are present. The launcher always refuses mixed databases. Demo customers cannot start payment gateway intents, even if gateway keys exist. Use COD/pay-at-pickup for sample orders; this is not a simulated online payment gateway.
5. **Inactive admin login:** session creation now reloads the actual database user and verifies account status, including admin sign-ins.
6. **Seed recovery:** the existing startup seed skips any database with shops, which can leave missing identities unrepaired. Added an explicit administrative `seed:demo` command to verify/create the four identities, repair missing customer/runner profiles and missing seller ownership on Fresh Mart, without duplicating sample records or silently overwriting another owner. Conflicting roles/identities fail clearly. Existing startup seeding is unchanged. Password resets require `RESET_DEMO_PASSWORDS=1`; suspended accounts are not silently reactivated.
7. **Netlify hosting mismatch:** there was no Netlify configuration, and static hosting cannot execute this Node/SQLite backend. Added a public-file allowlist build and same-origin `/api/*` proxy generation. A missing backend origin fails the build instead of silently shipping dead APIs.

## Demo account guide

Use `/demo/` for one-click server-authenticated access on an isolated sandbox. Existing password login also remains available:

| Account | Role | Portal | Email | Seed password |
|---|---|---|---|---|
| Customer Demo | customer | `/customer/` | customer@nearbuy.demo | Customer123! |
| Seller Demo | seller | `/seller/` | owner@nearbuy.demo | Seller123! |
| Runner Demo | runner | `/runner/` | rohan@nearbuy.demo | Runner123! |
| Admin Demo | admin | `/admin/` | admin@nearbuy.demo | Admin123! |

Customer: browse/search/cart/checkout/order tracking/receipts. Seller: Fresh Mart catalogue, stock, orders and delivery choices. Runner: available assignments, pickup and delivery confirmations. Admin: sample-only operational queues and records. These features already existed and remain connected to the same database.

Restrictions: sample data is shared among visitors, not isolated per visitor. Do not enter personal information. Admin can mutate sandbox records but is not a production administrator. Sandbox isolation checks use non-demo users and orders; operators must still use a physically separate database/service, not import private records. Nonproduction development retains the existing unrestricted administrative testing workflow unless `DEMO_SANDBOX=1`; never expose that configuration publicly. Seller and runner share one partner cookie, so signing into one switches the other. Use different browser profiles for simultaneous seller/runner testing. Customer and admin have separate cookies.

## Database/backend changes

No destructive migration or schema replacement. Reuses existing `nb_users`, `nb_sessions`, profiles, shops, inventory, orders, deliveries and audit records. New endpoints: GET `/api/customer/auth/demo` (availability), POST same path with `{ "role": "customer|seller|runner|admin" }`. Existing request-header and origin validation remain enforced. Login endpoint is intentionally CSRF-token-exempt, like password login, but requires the verification header, same-origin validation, rate limit and demo-isolation checks.

The seed command can restore missing identities/profiles in an existing sandbox, but does not reconstruct arbitrary deleted order/catalogue data. Restore backups if Fresh Mart is missing. It refuses non-demo users or conflicting ownership.

## Frontend changes

New `/demo/` page with four cards, keyboard focus, live status/error feedback, loading/disabled states and single-column mobile layout. Added entry links on homepage and sign-in screens. Existing portal design and navigation preserved; no claim of a complete redesign or every-button audit.

## Local running and testing

Requires Node >=22.5 (tested using the workspace Node runtime), no external npm dependencies.

```sh
# Local, sample-only database (do not reuse production path)
SEED_DEMO=1 DEMO_SANDBOX=1 NEARBUY_DB=./data/demo.sqlite npm run seed:demo
SEED_DEMO=1 DEMO_SANDBOX=1 NEARBUY_DB=./data/demo.sqlite npm start
# Open /demo/ on port 4173
npm test
```

For an explicit password repair add `RESET_DEMO_PASSWORDS=1` to the seed command. Back up the database first. Repeating seeding preserves existing products/orders and account IDs. The original development startup also seeds a fresh default database automatically.

## Executed validation

- Baseline `npm test`: **39/39 passed** before edits.
- Final `npm test`: **42/42 passed**, no skipped tests.
- New HTTP tests: four real demo logins and correct portals; repeated session restoration; coexisting cookies; CSRF rejection; correct-token mutations; logout/login; invalid role rejection; repeatable administrative seed; refusing mixed-database demo launch/admin overview/seeding.
- Existing HTTP suites executed: registration/password reset, search, cart and checkout, idempotency, seller ownership, stock reservation/release, runner assignment and OTP-confirmed delivery, receipts, returns, admin queues, seller product/inventory/scanner workflows and static-site checks.
- `NEARBUY_API_ORIGIN=https://backend.example.test npm run build:netlify`: passed as a configuration-only build (this example domain was not contacted).
- Executed artifact assertions: server/data/tests/tools/.git/package.json excluded; demo HTML included; API rewrite has the configured origin.

These are HTTP and static-markup tests, not visual browser automation. Session restoration is tested by fresh HTTP requests with cookies, not an actual browser refresh. Existing receipt tests validate HTML/print receipts, not a native PDF download. No manual full-site/mobile/device or exhaustive security audit has been completed. Interim test failures introduced while editing were corrected; the final full suite passes.

## Deployment requirements and unverified items

Deploy the backend separately on a persistent Node host with durable storage. Netlify functions with ephemeral SQLite are not a safe substitute.

Netlify:
- Uses committed `netlify.toml`, build `npm run build:netlify`, publish `dist`.
- Set `NEARBUY_API_ORIGIN` to the actual HTTPS backend origin with no path, credentials or query string.
- No catch-all SPA rewrite: existing directory HTML plus hash routes are preserved.

Backend sandbox:
- `NODE_ENV=production`, `SEED_DEMO=1`, `DEMO_SANDBOX=1`.
- `NEARBUY_DB` points to a durable, dedicated sandbox volume/file, never a real customer DB.
- Stable private `NEARBUY_OTP_SECRET` (existing backend OTP implementation).
- `HOST=0.0.0.0`, host-assigned `PORT`, HTTPS and `COOKIE_SECURE=1` behind the proxy.
- Proxy must preserve browser-facing host in trusted `X-Forwarded-Host` and HTTPS in `X-Forwarded-Proto`; otherwise same-origin validation will correctly reject requests. Validate actual Netlify forwarding in staging. Lock direct backend access to trusted infrastructure where possible.
- No live payment keys on the demo backend. Production gateway keys, webhook secret and mail/SMS providers require separate configuration if used; not required for COD sandbox journeys.

Blocked/not verified: actual Netlify site settings/build logs/environment, backend hosting/storage, live domain/callback/proxy-cookie behavior, external payment/mail/SMS and production records. No live deployment success is claimed. After configuring services, rerun four-account login/refresh/logout from the actual Netlify domain, then the full Fresh Mart order → seller accept/prepare/runner request → runner pickup/OTP delivery → customer receipt journey across separate browser profiles.

## Remaining work against the master prompt

Full visual redesign; real-browser mobile and every-control testing; per-visitor sandbox partitioning if desired; complete audit of all production administrative controls; native PDF generation if needed; real deployment verification. This change deliberately prioritizes verified authentication repairs over claiming the entire product is finished.
