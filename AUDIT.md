# NearBuy — full recreation, redesign & repair pass

Branch: `arena/9d30d791-nearbuy-neeev` (from `main` @ `0c40932`).

This pass audited **every** surface of the existing platform (four workspaces plus the public site), fixed the defects it
found, and left the architecture, identity, data model and workflows intact. Nothing was replaced with mock data; no
feature was removed.

## 1. What was audited, and how

| Area | Method |
| --- | --- |
| Public site `/`, `/about/`, `/help/`, `/roadmap/`, `/demo/`, styled 404 | Source review of each page + headless DOM render (jsdom against the live API) with console-error and failed-request capture |
| Customer storefront — 46 hash routes | Rendered as a guest **and** as `customer@nearbuy.demo`: home, shops (+ filters), shop profile, product, search with facets/sort/pagination, categories, empty categories, cart, checkout, orders, account, wishlist, notifications, help (+`?tab=tickets`), tickets, policies, login, register |
| Seller Hub — 20 routes | Rendered as seller: dashboard, orders, order detail, products, new/edit product, inventory, scanner, categories, customers, delivery, runner board, promotions, analytics, revenue, settlements, staff, profile, hours, reports, notifications, support, settings |
| Runner Portal — 9 routes | Rendered as runner: today, job detail, history, earnings, payouts, preferences, safety, notifications, profile |
| Admin Portal — 12 routes | Rendered as admin: overview, orders, customers, shops, catalogue, deliveries, runners, returns, **applications**, support, marketing, platform (service areas + audit) |
| Interactions | Real clicks + form submits: sign-in, add to cart, product create, application approve, location/pincode flow, sort ribbon, offline/online transitions |
| API + security | `npm test` (85 tests) and direct HTTP probes of demo sign-in for all four roles, role isolation, CSRF, enquiries, serviceability |

## 2. Defects found and fixed

1. **Admin Portal had no screen for seller applications.** `GET/PATCH /api/admin/seller-applications` was fully
   implemented server-side (documents, approval, rejection reason, notifications, audit log) but no view called it, so
   applications were only reachable by hand-crafting a request. Added a dedicated **Seller applications** page: KPIs,
   an "awaiting a decision" queue, a decided list, and a review dialog that shows owner, address, PAN/GST and the
   attached documents, then records the decision. Verified end-to-end (submit → approve → seller notified).
2. **Homepage footer had lost its navigation.** It contained only the logo and a motion toggle, while About/Help/Checklist
   carried a full four-column footer. All four public pages now render the **same** footer from one source
   (`tools/build-public-pages.mjs`), with only links that resolve.
3. **Homepage claimed "Three ways in"** although four workspaces exist, and the primary navigation never linked to the
   Admin Portal. Copy now reads "Four ways in", the Admin Portal is in the nav and the portals note links to it.
4. **Two front doors advertised a page that no longer exists.** `/seller/` and `/admin/` `<noscript>` blocks pointed at
   the retired `/portal.html` "offline demo shell" (which 301s to `/demo/`). They now link to real pages.
5. **Runner portal used two icons that were never registered** (`settlement`, `support` in `NAV`), so those two menu
   items silently fell back to a generic grid icon. Both are now in the shared icon map.
6. **Customer storefront footer was an empty shell** — the CSS defined a five-column footer, the markup emitted only the
   brand block. Rebuilt with Shop / Account / Help / NearBuy columns and a route back to the public site
   (About, Help centre, Checklist).
7. **No way back to the public site from the storefront.** The utility strip now links About NearBuy + Help & Support
   (deliberately *not* the Demo or role portals — a QA test guards against cross-workspace advertising).
8. **`/help?tab=tickets` deep links were ignored.** The footer/ticket links now scroll to the ticket desk and focus its
   first field (queued after the router's own focus so it wins).
9. **No connection state anywhere.** A dropped network turned every action into a generic failure toast and a wasted
   request. Both app shells now show a persistent, dismissible-by-recovery offline banner and refresh the current view
   when the browser comes back online.

## 3. Verified working (no change needed)

- Sessions: four separate `HttpOnly` cookies, a CSRF token per session returned by `/me`, server-side role isolation
  (a runner cookie is refused by `/api/admin/*`, an admin cookie by `/api/partner/*`).
- Full order chain over HTTP and in the console UI: accept → prepare → pack → ready → runner request → accept →
  handover PIN → pickup → out for delivery → customer OTP → delivered, with stock reserved/released.
- Server-authoritative pricing, coupons, minimum-order, and serviceability (pincode/locality + radius).
- Search: facets, removable chips, sort ribbon (all six keys persist in the URL and normalise unknown values),
  pagination, compare tray.
- Validation, empty states, skeletons, toasts and error+retry views on every console route.
- Location flow: "Detect my location", pincode → "Use this location" → header label and shop filtering all update.
- Zero console errors and zero failed requests on all 87 rendered routes/screens.

## 4. Test results

`npm test` → **85/85 passing** after every change in this pass (no test was modified to accommodate a change).

## 5. Remaining, explicitly out of scope (unchanged from before)

Online payments, SMS/email, Google sign-in, map tiles and payouts still require providers and are labelled as such in
the UI and README. The demo dataset stays shared between visitors. These are configuration limits, not defects.
