# NearBuy

**Shop Local. Live Better. · Smart Shopping. Right Nearby.**

A complete, working neighbourhood-commerce platform on one Node server: a public marketing site, a customer storefront,
a Seller Hub, a Runner (delivery partner) Portal and an Admin Portal. All four workspaces share **one SQLite database**,
so a basket placed in the storefront becomes an order the seller accepts, a job the runner delivers and a row the admin
can audit — with no mock data in the middle.

```bash
npm start      # http://localhost:4173
npm test       # 33 tests: security, catalogue, journeys and the site itself
```

Node 22.5 or newer. No npm dependencies, no build step. The server serves the static site and every API from one port
(`HOST` / `PORT`, default `0.0.0.0:4173`).

## Authentication repair and sandbox launcher

Open **`/demo/`** for four one-click, server-authenticated demo accounts. See
[IMPLEMENTATION-REPORT.md](IMPLEMENTATION-REPORT.md) for verified fixes, demo restrictions,
seeding/repair commands, test results and Netlify backend configuration. Netlify static hosting
alone cannot run the Node/SQLite API; the build requires `NEARBUY_API_ORIGIN`.

## Where things live

| Surface | URL | Sign-in |
| --- | --- | --- |
| Public marketing site | `/` | none |
| Customer storefront | `/customer/` | `customer@nearbuy.demo` / `Customer123!` |
| Seller Hub | `/seller/` | `owner@nearbuy.demo` / `Seller123!` |
| Runner Portal | `/runner/` | `rohan@nearbuy.demo` / `Runner123!` |
| Admin Portal | `/admin/` | `admin@nearbuy.demo` / `Admin123!` |
| Seller / delivery applications | `/seller/register/`, `/runner/register/` | none — reviewed in the Admin Portal |

Every sign-in screen has a *Fill in the demo sign-in* shortcut. Demo records carry a **DEMO DATA** label, and the
seed data is only created outside production unless `SEED_DEMO=1`.

The old browser-only prototype at `/portal.html` (localStorage) is still served for reference, but nothing on the site
links to it any more; every navigation path leads to the connected product above.

## Customer storefront (`/customer/`)

| Screen | Route | What it does |
| --- | --- | --- |
| Home | `#/` | Admin-managed hero banners, all 20 categories, serviceable shops near you, recommended products from live stock, active offers, how it works, local-business story, full footer |
| Categories | `#/categories`, `#/categories/:slug` | Category grid and per-category listings with admin-configured subcategories |
| Shops | `#/shops` | List **and** map view; filters for category, distance, rating, open now, delivery, pickup and verified |
| Shop profile | `#/shop/:slug` | Cover, logo, hours ("closed · opens 09:00"), policies, catalogue, offers and reviews |
| Products | `#/products` | Browse everything with the same filter rail and sorting |
| Search results | `#/search` | Flipkart-style SRP: breadcrumb + “Showing 1–24 of N results” meta, sticky faceted rail (price range, category, brand, rating, availability, shop) with removable filter chips, sort ribbon (relevance, popularity, price, rating, discount), horizontal list cards with spec bullets, rating pill, NearBuy Assured badge, wishlist toggle, add-to-compare tray (up to 4, side-by-side modal), sponsored in-feed offer strip, numbered pagination and a “Did you find what you were looking for?” feedback widget. All filters serialize into the URL, so links are shareable and back/forward works |
| Product | `#/product/:id` | Price, stock, delivery estimate, shop details, **Compare prices near you**, wishlist |
| Offers | `#/offers` | Only live, non-expired coupons, with the shops and minimum baskets they apply to |
| Cart | `#/cart` | One cart grouped by shop, delivery or free pickup per shop, server-quoted fees |
| Checkout | `#/checkout` | Address → per-shop fulfilment → summary → payment → place order |
| Orders | `#/orders`, `#/orders/:code` | Real status timeline, receipt download, reorder, cancel, return |
| Account | `#/account/…` | Profile, saved addresses, communication preferences, security |
| Wishlist | `#/wishlist` | Saved products with stock status |
| Notifications | `#/notifications` | Unread counts and a mark-all-read action |
| Help | `#/help`, `#/help/tickets(/:code)` | Searchable FAQs and real support-ticket threads |

**Browsing is public; checkout, wishlist, reviews and the account area need a session.** Registration uses a hashed,
time-limited OTP (HMAC-SHA256 with the key at `data/.nearbuy-otp-key` or `NEARBUY_OTP_SECRET`); passwords are scrypt
hashes; sessions are random tokens in an `HttpOnly` cookie with a CSRF token required for every mutation.

### Location and serviceability

The header selector takes a pincode or locality, "Use my location" (browser geolocation → nearest seeded service area)
or a manual address. The server decides serviceability from the `nb_service_areas` pincodes plus each shop's
`radius_km` and coordinates, measured with the haversine formula. Shops outside the zone are omitted from results
rather than shown as broken; shops serving the area but closed stay visible and are clearly marked.

### One order, several shops

A basket spanning three shops becomes **one parent order** (`NB-######`) and **one order per shop** (`ORD-######`) inside
a single `BEGIN IMMEDIATE` transaction. Stock is reserved for every line at checkout — all lines or none — and released
again if the shop rejects or the customer cancels before acceptance. Totals, discounts, taxes, delivery fees and stock
are always recalculated on the server: the browser never sends a price.

Checkout sends an idempotency key, so a double-submitted form cannot place two orders.

### Fulfilment loop

Each delivery order arrives at the seller as a decision:

1. **Accept / reject** (a rejection needs a reason and releases stock).
2. **Prepare → ready for handover.** The seller sees a **handover PIN**; the runner must present it at pickup.
3. **Request a NearBuy runner** (offers are ranked by distance and workload, expire after `DELIVERY_OFFER_SECONDS`,
   and assignment is a single conditional `UPDATE` so a job never has two owners) **or deliver it themselves**, or
   **complete a store pickup** against the customer's collection code.
4. **Pickup → out for delivery → delivered.** Delivery needs the customer's 6-digit OTP, which the server derives and
   only reveals to the customer once the parcel is out for delivery. It is never stored in plain text.

Only real transitions appear in the tracking timeline; nothing is faked.

### After the order

Cancellation before acceptance, returns with a reason and photo reference inside the product's `return_days` window,
refund tracking, a receipt (customer copy and seller copy), reorder, in-app notifications and **verified-purchase
reviews** — the review endpoint rejects anyone who did not buy the item.

## Seller Hub (`/seller/`)

Overview with today's numbers and what needs attention · live order queue with the accept → prepare → ready →
handover → complete actions · catalogue create/edit with stock and price changes · returns review · shop settings
(description, hours, delivery radius, pickup, policies). Stock changes are atomic and visible to the storefront
immediately.

## Runner Portal (`/runner/`)

Online/offline toggle · nearby offers with payout, distance and expiry · one active job at a time · pickup PIN entry,
"out for delivery", then the customer's OTP · earnings and delivery history. A runner cannot deliver without the
customer's OTP, and cannot pick up without the seller's PIN.

## Admin Portal (`/admin/`)

Platform overview · orders across all shops · customers (suspend / reactivate, which kills live sessions) · shops
(verify, open/closed, radius, service PINs) · catalogue moderation (hide a listing from the storefront) · deliveries ·
returns and refund status · support tickets and review moderation · coupons, banners and broadcasts · service areas,
seller/delivery applications and the audit log. Every administrative action is written to `nb_audit_logs`.

## What is real, and what still needs a provider

Nothing below pretends to be live; the interface says the same thing.

| Area | Current behaviour | To make it production |
| --- | --- | --- |
| Online payments | Cash on delivery and pay-at-store work. Card/UPI is offered **only** when Razorpay keys are set, and a payment counts as paid only after the signed webhook is verified | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` |
| SMS and email | No provider is configured, so no message is sent. In development the verification code is shown on screen (`devCodes`) and the delivery OTP appears in the customer's order page | An SMS/email provider |
| Google sign-in | Shown on the sign-in screen with an explanation; not enabled | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, callback `/api/customer/auth/google/callback` |
| Maps and routing | Shop list has a schematic map view; distances are straight-line × 1.35, stated in the UI | A maps/routing provider |
| Product photography | Seeded products use labelled placeholder cards | Real photography |
| Payouts | Seller receipts and settlement figures are recorded; no money moves | A payout provider |

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT`, `HOST` | Listen address | `4173`, `0.0.0.0` |
| `NODE_ENV` | `production` disables demo seeding and on-screen developer codes | unset |
| `SEED_DEMO` | `1` / `0` forces the demo dataset on or off | on outside production |
| `NEARBUY_DB` | SQLite file for the whole platform | `data/orders.sqlite` |
| `NEARBUY_OTP_SECRET` | HMAC key for OTPs and delivery codes | key file in `data/` |
| `DELIVERY_OFFER_SECONDS` | How long a runner offer stays open | `180` |
| `COOKIE_SECURE` | `1` forces the `Secure` cookie flag behind a TLS proxy | off |
| `DEV_MAIL_PREVIEW` | `1` shows developer codes even with `NODE_ENV=production` | off |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Online payments | unset (online disabled) |

## Tests

```bash
npm test                                  # everything
node --test tests/journeys.test.cjs       # the end-to-end journeys only
```

`tests/journeys.test.cjs` starts the real server on port 4211 with a temporary database and walks the whole platform
over HTTP with a cookie- and CSRF-aware client: registration and OTP, serviceability, search and filters, price
comparison, multi-shop cart re-pricing, checkout with coupons and expiry, payment and idempotency, seller splitting,
stock reserve/release, runner offers and assignment, pickup PIN and delivery OTP, receipts, verified reviews, the
return/refund chain, security (CSRF, origin, price forgery, static-file leaks), responsive and accessible markup, and
every admin queue — including seller and delivery applications.

`tests/orders.test.cjs` and `tests/site.test.cjs` cover the server's order rules and the public site's markup, assets
and links.

## Resetting, security and data

Stop the server and delete `data/` to start from a fresh seed. Passwords are scrypt hashes; OTPs and delivery codes
are derived with HMAC-SHA256 and never stored; sessions are random tokens stored hashed; every state-changing request
needs `X-NearBuy-Request: 1`, a same-origin `Origin`, and — when signed in — the `X-NearBuy-CSRF` token. Every query is
scoped to the signed-in user, shop or runner. Rate limits are in memory, so a multi-instance deployment needs a shared
store. `node:sqlite` is still marked experimental by Node; for production traffic move the same schema to a managed
database.
