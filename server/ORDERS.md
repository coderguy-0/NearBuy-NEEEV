# Shared order service (foundation, not production-ready)

The existing portal checkout and seller/runner screens still use their local demo data. They are **not connected** to this API. Do not use this service for real orders or payments yet. There is no identity verification, rate limiting, password recovery, secure deployment configuration, real-time push, payment/refund provider, pickup or delivery proof, cancellation, returns, runner matching, timeout/retry, tracking, or delivery completion. Pickup is deliberately blocked until verification is implemented. Registered runner accounts are not vetted and the runner list only excludes runners with an active assignment; it does not establish availability or suitability.

Run `npm start` on Node 22.5 or newer. SQLite data defaults to `data/orders.sqlite` (ignored by Git); `NEARBUY_DB` changes its location. The server must be deployed as a single process with persistent storage. Registration creates an unverified role; these accounts must not be treated as trusted business identities. Use TLS and protect tokens when experimenting.

All endpoints accept/return JSON. Register with `POST /api/register` (`name`, `email`, `password` at least 12 characters, `role` buyer/seller/runner). Log in with `POST /api/login` (`email`, `password`), then supply `Authorization: Bearer <token>` for authenticated endpoints. Tokens expire after 24 hours.

- `GET /api/sellers` lists seller IDs; `GET /api/runners` lists unassigned runner IDs for sellers.
- `POST /api/orders` (buyer): `sellerId`, `address`, `method` (`delivery` or `pickup`), `items` (array of `{name, quantity}`). Payment is always marked **Not processed**; item prices are not validated or stored.
- `GET /api/orders` returns orders belonging to the authenticated participant and their event history. `GET /api/notifications` returns that account's latest 200 logged notifications.
- `POST /api/orders/:id/transition` changes status with `status`, optionally `detail` (required for rejection). Seller: Order Received → Order Accepted or Order Rejected; Order Accepted → Order Processing → Ready for Pickup → Delivery Method Selected (include `deliveryMethod`: `self` or `runner`); then Runner Requested or Out for Delivery respectively. A runner may move Runner Assigned → Runner Accepted or Runner Rejected → Reached Pickup Location. Runner rejection returns the order to Runner Requested. Collection remains blocked without proof.
- `POST /api/orders/:id/assign` (owning seller) with `runnerId` assigns an unassigned runner to an order in Runner Requested. Transactions prevent conflicting assignments in the single SQLite database.

Notifications are persisted records, not push notifications; clients must fetch them. Completion of this foundation requires integration with all three portals, a trusted catalogue and account onboarding, real-time delivery, and the missing workflows above.
