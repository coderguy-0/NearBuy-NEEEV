/*
 * NearBuy — end-to-end journey tests (zero dependencies).
 *
 *   node --test tests/journeys.test.cjs      (or simply `npm test`)
 *
 * Boots the real server on a spare port against a throwaway SQLite database and
 * walks the fifteen QA journeys from the master prompt across all four portals:
 * registration, location, search, price comparison, cart, checkout, payment,
 * seller delivery, inventory sync, runner assignment, delivery OTP, receipts,
 * returns/refunds, security isolation and responsive/accessible markup.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 4211;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nearbuy-journeys-'));

let child;

/* ------------------------------------------------------------------ */
/* tiny cookie + CSRF aware client                                     */
/* ------------------------------------------------------------------ */

function client() {
  let cookie = '';
  let csrf = '';
  return {
    get csrf() { return csrf; },
    set csrf(v) { csrf = v; },
    get cookie() { return cookie; },
    async req(pathname, { method, body, headers = {}, origin } = {}) {
      const h = { 'X-NearBuy-Request': '1', ...headers };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (cookie) h.Cookie = cookie;
      if (csrf) h['X-NearBuy-CSRF'] = csrf;
      if (origin) h.Origin = origin;
      const res = await fetch(BASE + pathname, {
        method: method || (body !== undefined ? 'POST' : 'GET'),
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual'
      });
      for (const raw of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const pair = raw.split(';')[0];
        if (/^nb_(session|partner_session|admin_session)=/.test(pair)) cookie = pair.endsWith('=') ? '' : pair;
      }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (json && json.user && json.user.csrf) csrf = json.user.csrf;
      else if (json && json.csrf) csrf = json.csrf;
      return { status: res.status, json, text, headers: res.headers };
    }
  };
}

const get = (c, p) => c.req(p, { method: 'GET' });
const must = (res, status, label) => {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} — ${(res.text || '').slice(0, 300)}`);
  return res.json;
};

before(async () => {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NEARBUY_DB: path.join(DATA_DIR, 'orders.sqlite'),
      NODE_ENV: 'development',
      DELIVERY_OFFER_SECONDS: '180'
    },
    stdio: 'ignore'
  });
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`${BASE}/api/customer/home`);
      if (res.ok) { await res.body?.cancel(); return; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('server did not start in time');
});

after(() => {
  if (child) child.kill();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

/* Shared state carried between journeys. */
const S = {
  customer: client(),
  other: client(),
  admin: client(),
  email: `journey-${Date.now()}@example.com`,
  phone: '98' + String(Date.now()).slice(-8),
  password: 'Journey123!'
};

const SELLERS = {
  'fresh-mart': { email: 'owner@nearbuy.demo', password: 'Seller123!' },
  'scribble-stationery': { email: 'stationery@nearbuy.demo', password: 'Seller123!' },
  'mediplus-pharmacy': { email: 'pharmacy@nearbuy.demo', password: 'Seller123!' }
};
const RUNNERS = [
  { email: 'rohan@nearbuy.demo', password: 'Runner123!' },
  { email: 'meera@nearbuy.demo', password: 'Runner123!' },
  { email: 'sameer@nearbuy.demo', password: 'Runner123!' }
];

/* ------------------------------------------------------------------ */
/* 1 · registration, verification, sign-in and password reset          */
/* ------------------------------------------------------------------ */

test('journey 1 — a customer registers, verifies, signs in and resets a password', async () => {
  const c = S.customer;

  must(await c.req('/api/customer/auth/register', { body: { name: 'A', email: 'nope', phone: '123', password: 'short', terms: false } }), 400, 'registration validation');
  const mismatch = await c.req('/api/customer/auth/register', {
    body: { name: 'Journey Tester', email: `x-${Date.now()}@example.com`, phone: '9812345678', password: 'Journey123!', confirmPassword: 'Different123!', terms: true }
  });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.json.error, /do not match/i);

  const registered = must(await c.req('/api/customer/auth/register', {
    body: { name: 'Journey Tester', email: S.email, phone: S.phone, password: S.password, confirmPassword: S.password, terms: true }
  }), 201, 'registration');
  assert.equal(registered.user.email, S.email);
  assert.ok(registered.user.csrf, 'registration hands back a CSRF token');
  assert.equal(registered.user.emailVerified, false);
  assert.ok(!('password_hash' in registered.user) && !('password' in registered.user), 'no password material is returned');

  const dupe = await client().req('/api/customer/auth/register', {
    body: { name: 'Journey Tester', email: S.email, phone: S.phone, password: S.password, confirmPassword: S.password, terms: true }
  });
  assert.equal(dupe.status, 409, 'duplicate accounts are refused');

  const me = must(await get(c, '/api/customer/auth/me'), 200, 'me');
  assert.equal(me.user.email, S.email, 'the session persists across requests');
  assert.equal(me.config.payments.onlineEnabled, false, 'the gateway is honestly reported as unconfigured');

  const otp = must(await c.req('/api/customer/auth/verify/request', { body: { channel: 'phone' } }), 200, 'otp request');
  assert.equal(otp.sent, false);
  assert.equal(otp.providerConfigured, false);
  assert.match(otp.message, /nothing was sent/i);
  assert.ok(otp.devCode, 'development mode exposes the code instead of pretending to send it');
  assert.equal((await c.req('/api/customer/auth/verify/confirm', { body: { channel: 'phone', code: '000000' } })).status, 400);
  const verified = must(await c.req('/api/customer/auth/verify/confirm', { body: { channel: 'phone', code: otp.devCode } }), 200, 'otp confirm');
  assert.equal(verified.user.phoneVerified, true);

  const forgot = must(await c.req('/api/customer/auth/forgot', { body: { email: S.email } }), 200, 'forgot');
  assert.ok(forgot.devResetToken, 'development reset token is returned instead of an email');
  must(await c.req('/api/customer/auth/reset', { body: { token: forgot.devResetToken, password: 'Reset1234!', confirmPassword: 'Reset1234!' } }), 200, 'reset');
  S.password = 'Reset1234!';

  assert.equal((await get(c, '/api/customer/auth/me')).json.user, null, 'a reset revokes existing sessions');
  assert.equal((await c.req('/api/customer/auth/login', { body: { identifier: S.email, password: 'Wrong1234!' } })).status, 401);
  must(await c.req('/api/customer/auth/login', { body: { identifier: S.email, password: S.password, remember: true } }), 200, 'login by email');
  must(await c.req('/api/customer/auth/login', { body: { identifier: S.phone, password: S.password } }), 200, 'login by mobile');

  S.otherEmail = `other-${Date.now()}@example.com`;
  must(await S.other.req('/api/customer/auth/register', {
    body: { name: 'Other Shopper', email: S.otherEmail, phone: '97' + String(Date.now()).slice(-8), password: 'Other1234!', confirmPassword: 'Other1234!', terms: true }
  }), 201, 'second registration');
});

/* ------------------------------------------------------------------ */
/* 2 · location selection and serviceability                           */
/* ------------------------------------------------------------------ */

test('journey 2 — choosing a locality decides which shops can serve the customer', async () => {
  const c = S.customer;
  const localities = must(await get(c, '/api/customer/localities'), 200, 'localities');
  assert.ok(localities.localities.length >= 10, 'seeded service areas are listed');
  const area = localities.localities.find((l) => l.pincode === '110016');
  assert.ok(area && Number.isFinite(area.lat), 'localities carry coordinates for distance maths');

  const coverage = must(await get(c, '/api/customer/serviceability?pincode=110016'), 200, 'serviceability');
  assert.equal(coverage.serviceable, true);
  assert.ok(coverage.shopCount >= 1);

  const elsewhere = must(await get(c, '/api/customer/serviceability?pincode=999999'), 200, 'unknown pincode');
  assert.equal(elsewhere.serviceable, false, 'an unserviceable PIN is reported instead of silently accepted');

  const shops = must(await get(c, '/api/customer/shops?pincode=110016&limit=48'), 200, 'shops');
  assert.ok(shops.shops.length >= 5);
  for (const shop of shops.shops.filter((s) => s.serviceable)) {
    assert.ok(Number.isFinite(shop.distanceKm), `${shop.name} has a real distance`);
    assert.ok(shop.servicePincodes.length > 0, `${shop.name} lists its service PINs`);
  }

  // Any shop returned by the API carries an explicit serviceability answer for the
  // selected PIN, and an unserved PIN never invents coverage.
  for (const shop of shops.shops) assert.equal(typeof shop.serviceable, 'boolean', 'serviceability is always explicit');
  const uncovered = must(await get(c, '/api/customer/shops?pincode=999999&limit=48'), 200, 'shops for an unserved area');
  assert.ok(uncovered.shops.every((s) => s.serviceable === false), 'an unserved PIN marks every shop unserviceable instead of pretending');
  S.shops = shops.shops;
});

/* ------------------------------------------------------------------ */
/* 3 · product search and suggestions                                  */
/* ------------------------------------------------------------------ */

test('journey 3 — search finds products, brands and shops with sorting and filters', async () => {
  const c = S.customer;
  const milk = must(await get(c, '/api/customer/products?q=milk&pincode=110016&limit=20'), 200, 'search milk');
  assert.ok(milk.products.length >= 1);
  assert.ok(milk.products.every((p) => `${p.name} ${p.brand} ${p.category}`.toLowerCase().includes('milk')), 'results are relevant');

  const byShop = must(await get(c, '/api/customer/products?q=fresh&pincode=110016&limit=20'), 200, 'search by shop');
  assert.ok(byShop.products.some((p) => p.shop.name.toLowerCase().includes('fresh')) || byShop.shops.some((s) => /fresh/i.test(s.name)));

  const suggest = must(await get(c, '/api/customer/search/suggest?q=mil&pincode=110016'), 200, 'suggestions');
  assert.ok(Array.isArray(suggest.products) && Array.isArray(suggest.shops) && Array.isArray(suggest.categories), 'suggestions answer with products, shops and categories');
  assert.equal((await get(c, '/api/customer/search/suggest?q=m&pincode=110016')).json.products.length, 0, 'suggestions stay quiet for one character');

  const sorted = must(await get(c, '/api/customer/products?q=milk&pincode=110016&sort=price_low&limit=20'), 200, 'sorted');
  const prices = sorted.products.map((p) => p.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b), 'price ascending sort happens on the server');

  const filtered = must(await get(c, '/api/customer/products?pincode=110016&maxPrice=120&limit=24'), 200, 'filters');
  assert.ok(filtered.products.length > 0 && filtered.products.every((p) => p.price <= 12000), 'price filters are applied in rupees');

  const categories = must(await get(c, '/api/customer/categories'), 200, 'categories');
  assert.ok(categories.categories.filter((x) => !x.parentSlug).length >= 20, 'all twenty top-level categories exist');

  const detail = must(await get(c, `/api/customer/products/${encodeURIComponent(milk.products[0].id)}?pincode=110016`), 200, 'product detail');
  assert.ok(detail.product.description, 'detail pages carry a description');
  assert.ok(Array.isArray(detail.product.highlights) && Array.isArray(detail.product.specs));
  assert.ok(detail.shop && detail.shop.name, 'the selling shop is included');
  assert.ok('compare' in detail, 'the detail page knows how many listings exist');
});

/* ------------------------------------------------------------------ */
/* 4 · price comparison                                                */
/* ------------------------------------------------------------------ */

test('journey 4 — equivalent products are compared across nearby shops', async () => {
  const c = S.customer;
  const list = must(await get(c, '/api/customer/products?pincode=110016&limit=48'), 200, 'catalogue');
  let comparison = null;
  let candidate = null;
  for (const product of list.products) {
    const res = await get(c, `/api/customer/products/${encodeURIComponent(product.id)}/compare?pincode=110016`);
    assert.equal(res.status, 200, 'compare endpoint answers');
    if (res.json.listings.length > 1) { comparison = res.json; candidate = product; break; }
  }
  assert.ok(comparison, 'the demo catalogue prices the same product at more than one shop');

  for (const l of comparison.listings) {
    assert.equal(l.compareKey, candidate.compareKey, 'only equivalent listings are compared');
    assert.ok(Number.isFinite(l.price), 'each row has a live price');
    assert.equal(typeof l.available, 'boolean', 'availability comes from real stock');
    assert.ok(l.shop && l.shop.name, 'each row names its shop');
    assert.ok('deliveryEnabled' in l && 'pickupEnabled' in l, 'fulfilment options are shown per shop');
    assert.ok(Number.isFinite(l.distanceKm) || l.distanceKm === null, 'distance is a real measurement or absent');
  }
  const shopSlugs = new Set(comparison.listings.map((l) => l.shop.slug));
  assert.equal(shopSlugs.size, comparison.listings.length, 'one row per shop');
  assert.ok(Number.isFinite(comparison.lowestPrice), 'the lowest live price is identified');
  assert.ok(comparison.equivalentNote, 'the UI is told what equivalence means');
  S.compareProduct = candidate;
});

/* ------------------------------------------------------------------ */
/* 5 · multi-shop cart                                                 */
/* ------------------------------------------------------------------ */

test('journey 5 — the cart keeps shops separate and re-prices every change', async () => {
  const c = S.customer;
  const serviceable = new Set(S.shops.filter((s) => s.serviceable && s.deliveryEnabled).map((s) => s.slug));
  const owned = Object.keys(SELLERS).filter((slug) => serviceable.has(slug));
  assert.ok(owned.length >= 2, `at least two seller-owned shops deliver to the test address (got ${owned.join(', ')})`);

  const catalogues = {};
  for (const slug of owned) {
    const res = must(await get(c, `/api/customer/products?shop=${encodeURIComponent(slug)}&pincode=110016&limit=48`), 200, `catalogue ${slug}`);
    catalogues[slug] = res.products.filter((p) => p.available);
  }
  const shopA = owned.find((slug) => catalogues[slug].length >= 1);
  const shopB = owned.find((slug) => slug !== shopA && catalogues[slug].length >= 1);
  const a = catalogues[shopA][0];
  const b = catalogues[shopB][0];
  const qtyFor = (p) => Math.max(1, Math.min(p.stock, Math.ceil(30000 / p.price)));

  must(await c.req('/api/customer/cart/items', { body: { productId: a.id, qty: qtyFor(a) } }), 200, 'add from shop A');
  let cart = must(await c.req('/api/customer/cart/items', { body: { productId: b.id, qty: qtyFor(b) } }), 200, 'add from shop B');
  assert.equal(cart.cart.groups.length, 2, 'one group per shop');
  const groupA = cart.cart.groups.find((g) => g.shop.slug === shopA);
  const groupB = cart.cart.groups.find((g) => g.shop.slug === shopB);
  assert.ok(groupA && groupB);
  assert.equal(groupA.subtotal, a.price * qtyFor(a));
  assert.equal(groupB.subtotal, b.price * qtyFor(b));
  assert.ok(groupA.items.every((i) => i.available), 'stock is available for what was added');

  const updated = must(await c.req(`/api/customer/cart/items/${encodeURIComponent(a.id)}`, { method: 'PATCH', body: { qty: 1 } }), 200, 'update quantity');
  assert.equal(updated.cart.groups.find((g) => g.shop.slug === shopA).subtotal, a.price);
  const removed = must(await c.req(`/api/customer/cart/items/${encodeURIComponent(b.id)}`, { method: 'DELETE' }), 200, 'remove item');
  assert.equal(removed.cart.groups.length, 1);
  assert.equal(removed.cart.itemCount, 1);

  const tooMany = await c.req('/api/customer/cart/items', { body: { productId: a.id, qty: a.stock + 50 } });
  assert.ok(tooMany.status === 400 || tooMany.status === 409, 'stock cannot be exceeded in the cart');

  must(await c.req(`/api/customer/cart/items/${encodeURIComponent(a.id)}`, { method: 'DELETE' }), 200, 'clear A');
  must(await c.req('/api/customer/cart/items', { body: { productId: a.id, qty: qtyFor(a) } }), 200, 're-add A');
  cart = must(await c.req('/api/customer/cart/items', { body: { productId: b.id, qty: qtyFor(b) } }), 200, 're-add B');
  assert.equal(cart.cart.groups.length, 2);
  assert.equal(cart.cart.itemCount, qtyFor(a) + qtyFor(b));
  S.pick = { a, b, qtyA: qtyFor(a), qtyB: qtyFor(b), shopA, shopB };
});

/* ------------------------------------------------------------------ */
/* 6 · checkout                                                        */
/* ------------------------------------------------------------------ */

test('journey 6 — checkout quotes delivery and pickup with totals that add up', async () => {
  const c = S.customer;
  const addr = must(await c.req('/api/customer/addresses', {
    body: {
      label: 'Home', receiver: 'Journey Tester', phone: S.phone, line1: 'B-12', line2: 'Second floor',
      locality: 'Hauz Khas', city: 'New Delhi', pincode: '110016', landmark: 'Near the market',
      instructions: 'Ring the bell twice', lat: 28.5494, lng: 77.2001
    }
  }), 201, 'address created');
  S.addressId = addr.address.id;
  assert.equal(addr.address.isDefault, true);

  const quote = must(await c.req('/api/customer/checkout/quote', { body: { addressId: S.addressId } }), 200, 'quote');
  S.quote = quote.quote;
  assert.equal(S.quote.groups.length, 2);
  assert.deepEqual(S.quote.issues, [], 'the basket is serviceable as-is');
  assert.equal(S.quote.total, S.quote.groups.reduce((t, g) => t + g.total, 0), 'the payable amount is the sum of per-shop totals');
  for (const g of S.quote.groups) {
    assert.equal(g.total, g.subtotal - g.discount + g.deliveryFee + g.tax, `${g.shop.name} maths must add up`);
    assert.ok(g.etaMinutes > 0, 'an ETA is derived from the shop preparation time');
  }

  const pickupBody = { addressId: S.addressId, fulfillment: Object.fromEntries(S.quote.groups.map((g) => [g.shop.id, 'pickup'])) };
  const pickup = must(await c.req('/api/customer/checkout/quote', { body: pickupBody }), 200, 'pickup quote');
  assert.ok(pickup.quote.groups.every((g) => g.fulfillment === 'pickup'));
  assert.ok(pickup.quote.paymentOptions.find((p) => p.id === 'pay_at_store').enabled, 'pay at store unlocks when every shop is pickup');
  const deliveryQuote = must(await c.req('/api/customer/checkout/quote', { body: { addressId: S.addressId } }), 200, 'delivery quote');
  assert.equal(deliveryQuote.quote.paymentOptions.find((p) => p.id === 'pay_at_store').enabled, false, 'pay at store stays off for delivery');

  // Expired coupons are never presented as active offers.
  const expired = await c.req('/api/customer/cart/coupon', { body: { code: 'EXPIRED10' } });
  assert.equal(expired.status, 400, 'an expired coupon is refused at the point of use');
  assert.match(expired.json.error, /expired/i);
  const afterExpired = must(await get(c, '/api/customer/cart'), 200, 'cart after expired coupon');
  assert.ok(!afterExpired.cart.coupon, 'expired coupons never stick to the basket');
  const offers = must(await get(c, '/api/customer/offers'), 200, 'offers');
  assert.ok(!offers.offers.some((o) => o.code === 'EXPIRED10'), 'the offers page hides expired coupons');
  assert.ok(offers.offers.every((o) => new Date(o.endsAt).getTime() > Date.now()), 'every listed offer is still in date');

  const valid = must(await c.req('/api/customer/cart/coupon', { body: { code: 'WELCOME10' } }), 200, 'valid coupon');
  assert.equal(valid.cart.coupon.code, 'WELCOME10');
  const discounted = must(await c.req('/api/customer/checkout/quote', { body: { addressId: S.addressId } }), 200, 'discounted quote');
  assert.ok(discounted.quote.discount > 0, 'the coupon reduced the amount');
  assert.ok(discounted.quote.total < S.quote.total, 'the discount reaches the payable total');
});

/* ------------------------------------------------------------------ */
/* 7 · payment and order creation                                      */
/* ------------------------------------------------------------------ */

test('journey 7 — payment options are honest and orders are idempotent', async () => {
  const c = S.customer;

  const online = await c.req('/api/customer/orders', { body: { addressId: S.addressId, paymentMethod: 'online', idempotencyKey: `online-${Date.now()}` } });
  assert.equal(online.status, 503, 'no online capture can happen without gateway keys');
  assert.match(online.json.error, /not configured/i);

  const key = `journey-${Date.now()}`;
  const created = must(await c.req('/api/customer/orders', {
    body: { addressId: S.addressId, paymentMethod: 'cod', idempotencyKey: key, note: 'Leave with the guard' }
  }), 201, 'order created');
  S.order = created.order;
  assert.equal(S.order.paymentStatus, 'pending', 'a cash order is never marked paid up front');
  assert.equal(S.order.status, 'placed');
  assert.equal(S.order.sellerOrders.length, 2, 'one parent order with one order per shop');
  assert.equal(S.order.address.pincode, '110016');
  assert.ok(S.order.events.some((e) => e.status === 'placed'), 'the timeline starts with the real placement event');
  assert.equal(S.order.itemCount, S.pick.qtyA + S.pick.qtyB);

  const replay = must(await c.req('/api/customer/orders', { body: { addressId: S.addressId, paymentMethod: 'cod', idempotencyKey: key } }), 200, 'idempotent replay');
  assert.equal(replay.duplicate, true);
  assert.equal(replay.order.code, S.order.code, 'the same key cannot create a second order');

  const empty = await c.req('/api/customer/orders', { body: { addressId: S.addressId, paymentMethod: 'cod', idempotencyKey: `empty-${Date.now()}` } });
  assert.equal(empty.status, 409, 'the cart is emptied after a successful order');

  const webhook = await fetch(`${BASE}/api/customer/payments/webhook`, { method: 'POST', body: '{}' });
  assert.equal(webhook.status, 503, 'the webhook refuses to run without a configured secret');
});

/* ------------------------------------------------------------------ */
/* helpers shared by the fulfilment journeys                           */
/* ------------------------------------------------------------------ */

const SELLER_CLIENTS = {};
async function sellerFor(slug) {
  if (SELLER_CLIENTS[slug]) return SELLER_CLIENTS[slug];
  const creds = SELLERS[slug];
  assert.ok(creds, `no demo seller credential for ${slug}`);
  const c = client();
  const login = must(await c.req('/api/partner/login', { body: creds }), 200, `seller login ${slug}`);
  assert.equal(login.user.role, 'seller');
  SELLER_CLIENTS[slug] = c;
  return c;
}

async function sellerOrderFor(slug, parentCode) {
  const c = await sellerFor(slug);
  const data = must(await get(c, '/api/partner/seller/orders?status=all'), 200, 'seller orders');
  return { client: c, shop: data.shop, order: data.orders.find((o) => o.parentCode === parentCode) };
}

async function act(c, code, action, extra = {}) {
  return c.req(`/api/partner/seller/orders/${encodeURIComponent(code)}/action`, { body: { action, ...extra } });
}

async function packAll(c, code) {
  const packing = must(await get(c, `/api/partner/seller/orders/${encodeURIComponent(code)}/packing`), 200, 'packing checklist');
  for (const item of packing.items) {
    must(await c.req(`/api/partner/seller/orders/${encodeURIComponent(code)}/packing`, { body: { itemId: item.orderItemId, packedQty: item.orderedQty, missingQty: 0, status: 'packed' } }), 200, 'mark packed');
  }
  const after = must(await get(c, `/api/partner/seller/orders/${encodeURIComponent(code)}/packing`), 200, 'packing complete');
  assert.equal(after.summary.complete, true, 'packing checklist is complete before ready');
}

async function addAndOrder(productId, qty) {
  const c = S.customer;
  must(await c.req('/api/customer/cart/items', { body: { productId, qty } }), 200, 'cart add');
  const quote = must(await c.req('/api/customer/checkout/quote', { body: { addressId: S.addressId } }), 200, 'quote');
  assert.deepEqual(quote.quote.issues, [], `quote must be clean: ${JSON.stringify(quote.quote.issues)}`);
  const created = must(await c.req('/api/customer/orders', {
    body: { addressId: S.addressId, paymentMethod: 'cod', idempotencyKey: `k-${Math.random().toString(36).slice(2)}` }
  }), 201, 'order');
  return created.order;
}

/* ------------------------------------------------------------------ */
/* 8 · seller integration                                              */
/* ------------------------------------------------------------------ */

test('journey 8 — the right shop receives only its own items', async () => {
  const { client: sellerA, order: soA } = await sellerOrderFor(S.pick.shopA, S.order.code);
  const { client: sellerB, order: soB } = await sellerOrderFor(S.pick.shopB, S.order.code);
  assert.ok(soA, `${S.pick.shopA} received its part of the order`);
  assert.ok(soB, `${S.pick.shopB} received its part of the order`);
  assert.notEqual(soA.code, soB.code, 'each shop gets its own fulfilment order');
  assert.deepEqual(soA.items.map((i) => i.name), [S.pick.a.name], 'shop A sees only its own product');
  assert.deepEqual(soB.items.map((i) => i.name), [S.pick.b.name], 'shop B sees only its own product');
  assert.equal(soA.total, S.order.sellerOrders.find((s) => s.code === soA.code).total, 'the shop total matches the parent breakdown');
  assert.ok(soA.receiptUrl, 'a printable seller receipt URL is issued');
  assert.equal(soA.status, 'placed');

  const overview = must(await get(sellerA, '/api/partner/seller/overview'), 200, 'seller overview');
  assert.ok(overview.counts.new >= 1, 'the Seller Hub shows the new order count');

  // The other shop cannot touch or read a stranger's order.
  const trespass = await act(sellerB, soA.code, 'accept');
  assert.equal(trespass.status, 404, 'a seller cannot act on another shop’s order');

  S.sellerA = sellerA;
  S.sellerB = sellerB;
  S.soA = soA;
  S.soB = soB;
});

/* ------------------------------------------------------------------ */
/* 9 · inventory synchronisation                                       */
/* ------------------------------------------------------------------ */

test('journey 9 — stock is reserved, deducted and released exactly once', async () => {
  const c = S.customer;
  const productId = S.pick.a.id;
  const qty = S.pick.qtyA;

  const during = must(await get(c, `/api/customer/products/${encodeURIComponent(productId)}?pincode=110016`), 200, 'product during order');
  assert.equal(during.product.stock, S.pick.a.stock - qty, 'placing an order reserves stock on the storefront');

  const accepted = must(await act(S.sellerA, S.soA.code, 'accept'), 200, 'seller accepts');
  assert.equal(accepted.status, 'accepted');
  const afterAccept = must(await get(c, `/api/customer/products/${encodeURIComponent(productId)}?pincode=110016`), 200, 'product after accept');
  assert.equal(afterAccept.product.stock, S.pick.a.stock - qty, 'accepting converts the reservation into a deduction');

  // A rejected order returns its units to the shelf.
  must(await act(S.sellerA, S.soA.code, 'prepare'), 200, 'prepare');
  await packAll(S.sellerA, S.soA.code);
  must(await act(S.sellerA, S.soA.code, 'ready'), 200, 'ready');

  const spare = S.pick.b;
  const order3 = await addAndOrder(spare.id, 1);
  const so3 = await sellerOrderFor(S.pick.shopB, order3.code);
  const beforeReject = must(await get(c, `/api/customer/products/${encodeURIComponent(spare.id)}?pincode=110016`), 200, 'product before reject');
  assert.equal(beforeReject.product.stock, spare.stock - S.pick.qtyB - 1, 'the second order also reserved its unit');

  const rejected = must(await act(so3.client, so3.order.code, 'reject', { reason: 'Item damaged in the shop' }), 200, 'seller rejects');
  assert.equal(rejected.status, 'rejected');
  const afterReject = must(await get(c, `/api/customer/products/${encodeURIComponent(spare.id)}?pincode=110016`), 200, 'product after reject');
  assert.equal(afterReject.product.stock, spare.stock - S.pick.qtyB, 'rejecting released exactly the rejected unit');

  const detail = must(await get(c, `/api/customer/orders/${order3.code}`), 200, 'rejected order');
  assert.equal(detail.order.sellerOrders[0].status, 'rejected');
  assert.equal(detail.order.status, 'cancelled', 'a fully rejected order becomes cancelled');
  const notifications = must(await get(c, '/api/customer/notifications'), 200, 'notifications');
  assert.ok(notifications.notifications.some((n) => /could not accept|cancel|reject/i.test(`${n.title} ${n.body}`)), 'the customer is told why the order ended');
  assert.ok(notifications.unread > 0, 'unread notifications are counted for the header badge');
});

/* ------------------------------------------------------------------ */
/* 10 · runner assignment                                             */
/* ------------------------------------------------------------------ */

test('journey 10 — a seller can request a runner and the customer sees the assignment', async () => {
  const requested = await act(S.sellerA, S.soA.code, 'request_runner');
  if (requested.status === 409) {
    // Honest failure path: no runner is online. The API must say so and offer alternatives.
    assert.match(requested.json.error, /no nearbuy runner/i);
    assert.ok(Array.isArray(requested.json.alternatives) && requested.json.alternatives.length >= 2, 'alternatives are offered');
  }
  assert.ok([200, 409].includes(requested.status), `request_runner answered with ${requested.status}`);

  // A runner goes online and receives the offer.
  const runnerClients = [];
  for (const creds of RUNNERS) {
    const rc = client();
    const login = await rc.req('/api/partner/login', { body: creds });
    if (login.status !== 200) continue;
    await rc.req('/api/partner/runner/status', { body: { status: 'online', lat: 28.549, lng: 77.201 } });
    runnerClients.push(rc);
  }
  assert.ok(runnerClients.length >= 2, 'the demo seeds delivery partners');

  if (requested.status === 409) {
    must(await act(S.sellerA, S.soA.code, 'request_runner'), 200, 'request_runner retried with partners online');
  }

  let offer = null;
  let runner = null;
  for (const rc of runnerClients) {
    const overview = must(await get(rc, '/api/partner/runner/overview'), 200, 'runner overview');
    const found = overview.offers.find((o) => o.orderCode === S.soA.code);
    if (found) { offer = found; runner = rc; break; }
  }
  assert.ok(offer, 'an eligible nearby runner receives the offer');
  assert.ok(offer.payout > 0, 'the offer carries a payout');
  assert.match(offer.deliveryArea, /after you accept/i, 'the customer address is withheld until acceptance');

  const accepted = must(await runner.req(`/api/partner/runner/offers/${encodeURIComponent(offer.id)}/accept`, { body: {} }), 200, 'runner accepts');
  assert.match(accepted.message, /handover/i);

  const customerView = must(await get(S.customer, `/api/customer/orders/${S.order.code}`), 200, 'customer order');
  const so = customerView.order.sellerOrders.find((s) => s.code === S.soA.code);
  assert.equal(so.status, 'runner_assigned');
  assert.ok(so.runner && so.runner.name, 'the customer sees the runner name');
  assert.match(so.runner.phoneMasked, /^••+/, 'the runner number stays masked');
  assert.ok(customerView.order.events.some((e) => e.status === 'runner_assigned'), 'the timeline records the real transition');

  S.runner = runner;
  S.runnerOffer = offer;
});

/* ------------------------------------------------------------------ */
/* 11 · delivery OTP                                                  */
/* ------------------------------------------------------------------ */

test('journey 11 — only a valid OTP can complete the delivery', async () => {
  const jobId = S.runnerOffer.id;
  const fresh = must(await get(S.sellerA, '/api/partner/seller/orders?status=active'), 200, 'seller active orders');
  const active = fresh.orders.find((o) => o.code === S.soA.code);
  assert.ok(active.handoverPin, 'the seller is given a handover PIN');

  const wrongPin = await S.runner.req(`/api/partner/runner/jobs/${encodeURIComponent(jobId)}/action`, { body: { action: 'picked_up', pickupPin: '0000' } });
  assert.equal(wrongPin.status, 400, 'pickup needs the shop handover PIN');
  const picked = must(await S.runner.req(`/api/partner/runner/jobs/${encodeURIComponent(jobId)}/action`, { body: { action: 'picked_up', pickupPin: active.handoverPin } }), 200, 'pickup');
  assert.match(picked.message, /handover pin/i);
  must(await S.runner.req(`/api/partner/runner/jobs/${encodeURIComponent(jobId)}/action`, { body: { action: 'out_for_delivery' } }), 200, 'out for delivery');

  const withOtp = must(await get(S.customer, `/api/customer/orders/${S.order.code}`), 200, 'customer order');
  const so = withOtp.order.sellerOrders.find((s) => s.code === S.soA.code);
  assert.equal(so.status, 'out_for_delivery');
  assert.match(String(so.deliveryOtp), /^\d{6}$/, 'the customer is shown their 6-digit delivery OTP');

  const wrong = await S.runner.req(`/api/partner/runner/jobs/${encodeURIComponent(jobId)}/action`, { body: { action: 'delivered', otp: '000000' } });
  assert.equal(wrong.status, 400, 'a wrong OTP cannot close the order');
  assert.match(wrong.json.error, /not correct/i);

  const delivered = must(await S.runner.req(`/api/partner/runner/jobs/${encodeURIComponent(jobId)}/action`, { body: { action: 'delivered', otp: so.deliveryOtp } }), 200, 'delivery');
  assert.match(delivered.message, /otp verification/i);

  const final = must(await get(S.customer, `/api/customer/orders/${S.order.code}`), 200, 'final order');
  const done = final.order.sellerOrders.find((s) => s.code === S.soA.code);
  assert.equal(done.status, 'delivered');
  assert.ok(done.deliveredAt, 'a real delivery time is recorded');
  const statuses = final.order.events.map((e) => e.status);
  for (const expected of ['placed', 'accepted', 'preparing', 'ready', 'runner_assigned', 'picked_up', 'out_for_delivery', 'delivered']) {
    assert.ok(statuses.includes(expected), `timeline records ${expected}`);
  }
  assert.equal(final.order.status, 'in_progress', 'the parent order waits for the other shop');
});

/* ------------------------------------------------------------------ */
/* 12 · receipts                                                      */
/* ------------------------------------------------------------------ */

test('journey 12 — customers and sellers can print a real receipt', async () => {
  const receipt = await get(S.customer, `/api/customer/orders/${S.order.code}/receipt`);
  assert.equal(receipt.status, 200);
  assert.match(receipt.headers.get('content-type') || '', /text\/html/);
  assert.match(receipt.text, new RegExp(S.order.code));
  assert.match(receipt.text, /NearBuy/);
  assert.match(receipt.text, /Shop Local\. Live Better\./);
  assert.match(receipt.text, /Delivery fee|Pickup charge/, 'the receipt itemises fees');

  const sellerReceipt = await get(S.sellerA, `/api/partner/seller/receipt/${S.soA.code}`);
  assert.equal(sellerReceipt.status, 200);
  assert.match(sellerReceipt.text, /Seller copy/);
  assert.match(sellerReceipt.text, new RegExp(S.soA.code));

  const stranger = await get(S.other, `/api/customer/orders/${S.order.code}/receipt`);
  assert.equal(stranger.status, 403, 'another customer cannot download this receipt');
  const anonymous = await fetch(`${BASE}/api/customer/orders/${S.order.code}/receipt`, { headers: { 'X-NearBuy-Request': '1' } });
  assert.equal(anonymous.status, 401, 'receipts need a session');
});

/* ------------------------------------------------------------------ */
/* 13 · returns, refunds and reviews                                  */
/* ------------------------------------------------------------------ */

test('journey 13 — a delivered order can be returned, refunded and reviewed', async () => {
  // Buy something returnable, then deliver it with the shop's own rider.
  const owned = Object.keys(SELLERS);
  let product = null;
  let slug = null;
  for (const s of owned) {
    const res = must(await get(S.customer, `/api/customer/products?shop=${encodeURIComponent(s)}&pincode=110016&limit=48`), 200, 'catalogue');
    const found = res.products.find((p) => p.returnDays >= 7 && p.available);
    if (found) { product = found; slug = s; break; }
  }
  assert.ok(product, 'the demo catalogue includes a returnable product');

  const order = await addAndOrder(product.id, Math.max(1, Math.ceil(30000 / product.price)));
  const { client: seller, order: so } = await sellerOrderFor(slug, order.code);
  assert.ok(so, 'the returnable order reached its shop');
  must(await act(seller, so.code, 'accept'), 200, 'accept');
  must(await act(seller, so.code, 'prepare'), 200, 'prepare');
  await packAll(seller, so.code);
  must(await act(seller, so.code, 'ready'), 200, 'ready');
  must(await act(seller, so.code, 'self_deliver'), 200, 'shop dispatches with its own rider');

  const outForDelivery = must(await get(S.customer, `/api/customer/orders/${order.code}`), 200, 'order');
  const otp = outForDelivery.order.sellerOrders[0].deliveryOtp;
  assert.match(String(otp), /^\d{6}$/);
  const wrong = await act(seller, so.code, 'deliver', { otp: '123456' });
  assert.equal(wrong.status, 400, 'self-delivery also needs the customer OTP');
  must(await act(seller, so.code, 'deliver', { otp }), 200, 'self-delivery completed');

  const delivered = must(await get(S.customer, `/api/customer/orders/${order.code}`), 200, 'delivered order');
  const deliveredSo = delivered.order.sellerOrders[0];
  assert.equal(deliveredSo.status, 'delivered');
  assert.ok(deliveredSo.canReturn, 'the item is inside its return window');
  assert.ok(deliveredSo.items.length >= 1);

  // Verified review.
  const review = await S.customer.req('/api/customer/reviews', {
    body: { orderCode: order.code, sellerOrderId: deliveredSo.id, productId: deliveredSo.items[0].productId, rating: 5, body: 'Packed neatly and delivered quickly by the shop itself.' }
  });
  assert.equal(review.status, 201, JSON.stringify(review.json));
  const mine = must(await get(S.customer, '/api/customer/reviews/mine'), 200, 'my reviews');
  assert.ok(mine.reviews.some((r) => r.verified && r.product), 'the review is marked as a verified purchase');
  const forged = await S.other.req('/api/customer/reviews', {
    body: { orderCode: order.code, sellerOrderId: deliveredSo.id, productId: deliveredSo.items[0].productId, rating: 5, body: 'I never bought this but here is a review.' }
  });
  assert.equal(forged.status, 403, 'only the buyer may review the purchase');

  // Return + refund chain.
  const item = deliveredSo.items[0];
  const returnReq = await S.customer.req(`/api/customer/orders/${order.code}/returns`, {
    body: { sellerOrderId: deliveredSo.id, itemId: item.id, reason: 'Damaged on arrival', comment: 'The box was crushed in the bag.' }
  });
  assert.equal(returnReq.status, 201, JSON.stringify(returnReq.json));
  const returnCode = returnReq.json.return.code;

  const sellerReturns = must(await get(seller, '/api/partner/seller/returns'), 200, 'seller returns');
  assert.ok(sellerReturns.returns.some((r) => r.code === returnCode), 'the shop sees the return request');

  must(await seller.req(`/api/partner/seller/returns/${encodeURIComponent(returnCode)}/action`, { body: { action: 'approve', note: 'Approved, sorry about the packaging.' } }), 200, 'seller approves');

  const admin = S.admin;
  must(await admin.req('/api/admin/login', { body: { email: 'admin@nearbuy.demo', password: 'Admin123!' } }), 200, 'admin signs in');
  const ledger = must(await get(admin, '/api/admin/returns'), 200, 'refund ledger');
  const refund = ledger.refunds.find((r) => (ledger.returns.find((x) => x.code === returnCode) || {}).id === r.return_id);
  assert.ok(refund, 'the refund is recorded against the return');
  assert.equal(refund.status, 'processing', 'approval moves the refund to processing, not to paid');
  must(await admin.req(`/api/admin/refunds/${encodeURIComponent(refund.id)}/status`, { body: { status: 'processing' } }), 200, 'processing acknowledged');
  must(await admin.req(`/api/admin/refunds/${encodeURIComponent(refund.id)}/status`, { body: { status: 'completed', reference: 'UTR-TEST-001' } }), 200, 'refund completed');

  const customerReturns = must(await get(S.customer, '/api/customer/returns'), 200, 'customer returns');
  const seen = customerReturns.returns.find((r) => r.code === returnCode);
  assert.ok(seen, 'the customer can follow the return');
  assert.equal(seen.status, 'completed');
  assert.ok(seen.decisionNote, 'the shop decision is visible to the customer');
});

/* ------------------------------------------------------------------ */
/* 14 · security and isolation                                        */
/* ------------------------------------------------------------------ */

test('journey 14 — roles, ownership and CSRF are enforced on the server', async () => {
  const stranger = S.other;

  assert.equal((await get(stranger, `/api/customer/orders/${S.order.code}`)).status, 403, 'another customer cannot read this order');
  assert.equal((await get(stranger, '/api/customer/orders')).status, 200);
  const strangerOrders = must(await get(stranger, '/api/customer/orders'), 200, 'own orders');
  assert.ok(!strangerOrders.orders.some((o) => o.code === S.order.code), 'the order list is scoped to the owner');

  assert.equal((await get(S.customer, '/api/partner/seller/orders')).status, 401, 'customers cannot read the Seller Hub');
  assert.equal((await get(S.customer, '/api/admin/overview')).status, 401, 'customers cannot read the Admin Portal');
  assert.equal((await get(S.sellerA, '/api/admin/overview')).status, 401, 'sellers cannot read the Admin Portal');
  assert.equal((await get(S.admin, '/api/partner/seller/orders')).status, 401, 'admins use their own session');
  assert.equal((await get(S.customer, '/api/admin/me')).json.user, null, 'an admin session is not a customer session');

  // CSRF and same-origin guards.
  const noHeader = await fetch(`${BASE}/api/customer/cart/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: S.customer.cookie, 'X-NearBuy-CSRF': S.customer.csrf },
    body: JSON.stringify({ productId: S.pick.a.id, qty: 1 })
  });
  assert.equal(noHeader.status, 403, 'mutations need the request header');
  await noHeader.body?.cancel();

  const noCsrf = await fetch(`${BASE}/api/customer/cart/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: S.customer.cookie, 'X-NearBuy-Request': '1' },
    body: JSON.stringify({ productId: S.pick.a.id, qty: 1 })
  });
  assert.equal(noCsrf.status, 403, 'a signed-in mutation needs the session CSRF token');
  await noCsrf.body?.cancel();

  const crossOrigin = await S.customer.req('/api/customer/cart/items', { body: { productId: S.pick.a.id, qty: 1 }, origin: 'https://evil.example' });
  assert.equal(crossOrigin.status, 403, 'cross-origin mutations are refused');
  assert.match(crossOrigin.json.error, /cross-origin|invalid origin/i, 'the refusal names the origin check');

  // The browser cannot dictate prices: forged amounts are ignored.
  await S.customer.req('/api/customer/cart/items', { body: { productId: S.pick.a.id, qty: Math.max(1, Math.ceil(30000 / S.pick.a.price)) } });
  const quote = must(await S.customer.req('/api/customer/checkout/quote', { body: { addressId: S.addressId } }), 200, 'quote');
  const forged = must(await S.customer.req('/api/customer/orders', {
    body: {
      addressId: S.addressId, paymentMethod: 'cod', idempotencyKey: `forged-${Date.now()}`,
      total: 100, subtotal: 100, items: [{ productId: S.pick.a.id, price: 1, qty: 1 }]
    }
  }), 201, 'forged order');
  assert.equal(forged.order.total, quote.quote.total, 'the server recalculates the total from the database');
  assert.notEqual(forged.order.total, 100);

  // Static serving never leaks server code or data.
  for (const p of ['/server/customer/api.js', '/data/orders.sqlite', '/server/customer/db.js']) {
    const res = await fetch(`${BASE}${p}`, { redirect: 'manual' });
    assert.ok([400, 404].includes(res.status), `${p} must not be served`);
    await res.body?.cancel();
  }
});

/* ------------------------------------------------------------------ */
/* 15 · responsive and accessible surfaces                            */
/* ------------------------------------------------------------------ */

test('journey 15 — every surface is responsive and reachable', () => {
  const htmlFiles = [
    'index.html', 'portal.html', 'seller.html', 'partner.html', 'business.html', 'delivery-admin.html',
    'customer/index.html', 'customer/login/index.html', 'seller/index.html', 'runner/index.html',
    'admin/index.html', 'about/index.html', 'help/index.html', 'roadmap/index.html'
  ];
  for (const file of htmlFiles) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(src, /<meta name="viewport"/, `${file} declares a viewport`);
    assert.match(src, /<html lang="/, `${file} declares its language`);
    assert.match(src, /<title>/, `${file} has a title`);
  }

  const customerCss = fs.readFileSync(path.join(ROOT, 'customer/app.css'), 'utf8');
  const partnerCss = fs.readFileSync(path.join(ROOT, 'partner/app.css'), 'utf8');
  for (const [name, css] of [['customer/app.css', customerCss], ['partner/app.css', partnerCss]]) {
    assert.ok((css.match(/@media/g) || []).length >= 3, `${name} has multiple breakpoints`);
    assert.match(css, /prefers-reduced-motion/, `${name} respects reduced motion`);
    assert.match(css, /:focus-visible/, `${name} shows keyboard focus`);
  }
  for (const token of ['#063B78', '#0866D9', '#EFF7FF', '#142D4B', '#18A957', '#E5484D']) {
    assert.match(customerCss.toLowerCase(), new RegExp(token.toLowerCase()), `brand palette includes ${token}`);
  }

  const core = fs.readFileSync(path.join(ROOT, 'customer/core.js'), 'utf8');
  assert.match(core, /Search for shops, products, groceries, medicines, stationery and more\.\.\./, 'the header search placeholder is exact');
  assert.match(core, /Delivering to/, 'the location selector is visible in the header');

  const views = ['views-home.js', 'views-shop.js', 'views-search.js', 'views-cart.js', 'views-orders.js', 'views-account.js']
    .map((f) => fs.readFileSync(path.join(ROOT, 'customer', f), 'utf8')).join('\n');
  for (const route of ['NB.view(/^\\/$/', 'NB.view(/^\\/categories', 'NB.view(/^\\/search', 'NB.view(/^\\/shops', 'NB.view(/^\\/offers', 'NB.view(/^\\/orders', 'NB.view(/^\\/wishlist', 'NB.view(/^\\/help', 'NB.view(/^\\/account', 'NB.view(/^\\/cart']) {
    assert.ok(views.includes(route), `the storefront registers ${route}`);
  }
  assert.doesNotMatch(views + core, /href="#"(\s|>)/, 'no dead "#" links are generated');
  assert.match(views, /Compare prices near you/i, 'price comparison is reachable from the product page');

  const partnerCore = fs.readFileSync(path.join(ROOT, 'partner/core.js'), 'utf8');
  for (const mode of ['seller', 'runner', 'admin']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'partner', `${mode}.js`)), `the ${mode} console exists`);
  }
  assert.match(partnerCore, /X-NearBuy-CSRF/, 'partner consoles send the CSRF token');
  assert.match(partnerCore, /\/api\/(partner|admin)/, 'partner consoles talk to the shared API');
});

/* ------------------------------------------------------------------ */
/* 16 · admin operations and support loop                             */
/* ------------------------------------------------------------------ */

test('journey 16 — the admin portal can run every platform queue', async () => {
  const admin = S.admin;

  const overview = must(await get(admin, '/api/admin/overview'), 200, 'overview');
  assert.ok(overview.counts.customers >= 2);
  assert.ok(overview.counts.orders >= 3);
  assert.ok(overview.gmv > 0);

  const customers = must(await get(admin, '/api/admin/customers'), 200, 'customers');
  const target = customers.customers.find((u) => u.email === S.otherEmail);
  assert.ok(target, 'registered customers appear for administration');
  must(await admin.req(`/api/admin/customers/${encodeURIComponent(target.id)}`, { method: 'PATCH', body: { status: 'suspended' } }), 200, 'suspend');
  assert.equal((await get(S.other, '/api/customer/auth/me')).json.user, null, 'suspension ends the session');
  assert.equal((await S.other.req('/api/customer/auth/login', { body: { identifier: S.otherEmail, password: 'Other1234!' } })).status, 403);
  must(await admin.req(`/api/admin/customers/${encodeURIComponent(target.id)}`, { method: 'PATCH', body: { status: 'active' } }), 200, 'reactivate');
  must(await S.other.req('/api/customer/auth/login', { body: { identifier: S.otherEmail, password: 'Other1234!' } }), 200, 'reactivated customer can sign in');

  const shops = must(await get(admin, '/api/admin/shops'), 200, 'shops');
  const shop = shops.shops.find((s) => s.slug === S.pick.shopA);
  assert.ok(shop && Number.isFinite(shop.radiusKm), 'shops expose their delivery radius');
  const verified = must(await admin.req(`/api/admin/shops/${encodeURIComponent(shop.slug)}`, { method: 'PATCH', body: { verified: true, radiusKm: 6 } }), 200, 'verify shop');
  assert.equal(verified.shop.verified, true);
  assert.equal(verified.shop.radiusKm, 6);

  const categories = must(await get(admin, '/api/admin/categories'), 200, 'admin categories');
  assert.ok(categories.categories.length >= 20);
  const created = await admin.req('/api/admin/categories', { body: { name: 'QA Pet Supplies', parentSlug: 'general-store', icon: '🐾' } });
  assert.equal(created.status, 201);
  assert.equal(created.json.slug, 'qa-pet-supplies');

  const areas = must(await get(admin, '/api/admin/service-areas'), 200, 'service areas');
  assert.ok(areas.areas.length >= 10);
  const newArea = await admin.req('/api/admin/service-areas', { body: { pincode: '110017', locality: 'QA Nagar', city: 'New Delhi', lat: 28.53, lng: 77.21 } });
  assert.equal(newArea.status, 201);
  const coverage = must(await get(S.customer, '/api/customer/serviceability?pincode=110017'), 200, 'new coverage');
  assert.equal(coverage.serviceable, true, 'the new area becomes shoppable immediately');

  const products = must(await get(admin, '/api/admin/products'), 200, 'admin products');
  assert.ok(products.products.length > 0);
  const listing = products.products.find((p) => p.shop.slug === S.pick.shopA);
  must(await admin.req(`/api/admin/products/${encodeURIComponent(listing.id)}`, { method: 'PATCH', body: { active: false } }), 200, 'hide listing');
  const hidden = must(await get(S.customer, `/api/customer/products/${encodeURIComponent(listing.id)}`), 404, 'hidden listings leave the storefront');
  assert.ok(hidden.error);
  must(await admin.req(`/api/admin/products/${encodeURIComponent(listing.id)}`, { method: 'PATCH', body: { active: true } }), 200, 'restore listing');

  const coupon = await admin.req('/api/admin/coupons', { body: { code: 'QATEST15', title: '15% for QA', type: 'percent', value: 15, minOrderPaise: 10000, days: 5 } });
  assert.equal(coupon.status, 201);
  const offers = must(await get(S.customer, '/api/customer/offers'), 200, 'offers');
  assert.ok(offers.offers.some((o) => o.code === 'QATEST15'), 'a new coupon is live for customers straight away');

  const banner = await admin.req('/api/admin/banners', { body: { title: 'QA banner', subtitle: 'Managed from the Admin Portal.', eyebrow: 'Test', ctaLabel: 'Shop', ctaLink: '#/shops' } });
  assert.equal(banner.status, 201);
  const home = must(await get(S.customer, '/api/customer/home'), 200, 'home');
  assert.ok(home.banners.some((b) => b.title === 'QA banner'), 'the homepage banner comes from the admin-managed table');

  const broadcast = must(await admin.req('/api/admin/notifications', { body: { title: 'QA broadcast', body: 'Platform update for testing.', audience: 'customers' } }), 201, 'broadcast');
  assert.ok(broadcast.recipients >= 1);
  assert.match(broadcast.message, /no sms or email provider is configured/i, 'delivery limits are stated honestly');

  // Support loop: customer ticket → admin reply → customer thread.
  const ticket = await S.customer.req('/api/customer/tickets', {
    body: { category: 'delivery', subject: 'Order arrived late', description: 'The delivery took much longer than the estimate shown at checkout.', orderCode: S.order.code }
  });
  assert.equal(ticket.status, 201, JSON.stringify(ticket.json));
  const ticketCode = ticket.json.ticket.code;
  const queue = must(await get(admin, '/api/admin/tickets'), 200, 'ticket queue');
  assert.ok(queue.tickets.some((t) => t.code === ticketCode));
  must(await admin.req(`/api/admin/tickets/${encodeURIComponent(ticketCode)}/reply`, { body: { body: 'Thanks for flagging this — the runner was delayed by traffic.' } }), 200, 'reply');
  const thread = must(await get(S.customer, `/api/customer/tickets/${encodeURIComponent(ticketCode)}`), 200, 'ticket thread');
  assert.ok(thread.ticket.messages.some((m) => m.authorRole === 'agent'), 'the reply reaches the customer thread');
  assert.equal(thread.ticket.status, 'awaiting_customer');

  const audit = must(await get(admin, '/api/admin/audit'), 200, 'audit log');
  assert.ok(audit.logs.some((l) => l.action === 'coupon_created'));
  assert.ok(audit.logs.some((l) => l.action === 'broadcast'));
  assert.ok(audit.logs.some((l) => l.action === 'admin_login'));

  // Wishlist is private and needs a session.
  const anon = await fetch(`${BASE}/api/customer/wishlist`, { headers: { 'X-NearBuy-Request': '1' } });
  assert.equal(anon.status, 401);
  await anon.body?.cancel();
  must(await S.customer.req(`/api/customer/wishlist/${encodeURIComponent(S.compareProduct.id)}`, { body: {} }), 200, 'wishlist add');
  const wishlist = must(await get(S.customer, '/api/customer/wishlist'), 200, 'wishlist');
  assert.ok(wishlist.products.some((i) => i.id === S.compareProduct.id), 'the wishlist stores the saved product');
});

test('seller and runner applications land in the admin queue and can be triaged', async () => {
  const submit = async (payload) => {
    const res = await fetch(`${BASE}/api/customer/enquiry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-NearBuy-Request': '1' },
      body: JSON.stringify(payload)
    });
    return { status: res.status, json: await res.json() };
  };
  const sellerApp = await submit({
    name: 'Sunita Rao', contact: 'sunita@example.com', topic: 'Seller application',
    message: 'Shop: Rao General Store\nLocality: Green Park, 110016\n\nGroceries with 4 km home delivery.'
  });
  assert.equal(sellerApp.status, 201, JSON.stringify(sellerApp.json));
  const runnerApp = await submit({
    name: 'Deepak Yadav', contact: 'deepak@example.com', topic: 'Delivery partner application',
    message: 'Vehicle: Scooter\nLocality: Hauz Khas, 110016\n\nEvenings and weekends up to 8 km.'
  });
  assert.equal(runnerApp.status, 201, JSON.stringify(runnerApp.json));

  const admin = S.admin;
  const queue = must(await get(admin, '/api/admin/enquiries'), 200, 'enquiry queue');
  const codes = queue.enquiries.map((e) => e.code);
  assert.ok(codes.includes(sellerApp.json.code) && codes.includes(runnerApp.json.code), 'both applications are queued');
  const sellerRow = queue.enquiries.find((e) => e.code === sellerApp.json.code);
  assert.equal(sellerRow.status, 'open');

  const triaged = await admin.req(`/api/admin/enquiries/${encodeURIComponent(sellerApp.json.code)}`, { method: 'PATCH', body: { status: 'in_review' } });
  assert.equal(triaged.status, 200, JSON.stringify(triaged.json));
  const after = must(await get(admin, '/api/admin/enquiries'), 200, 'enquiry queue');
  assert.equal(after.enquiries.find((e) => e.code === sellerApp.json.code).status, 'in_review');

  const bad = await admin.req(`/api/admin/enquiries/${encodeURIComponent(sellerApp.json.code)}`, { method: 'PATCH', body: { status: 'approved' } });
  assert.equal(bad.status, 400, 'only open / in review / closed are accepted');

  const anon = await fetch(`${BASE}/api/admin/enquiries`, { headers: { 'X-NearBuy-Request': '1' } });
  assert.equal(anon.status, 401, 'the queue is admin-only');
  await anon.body?.cancel();

  const audit = must(await get(admin, '/api/admin/audit'), 200, 'audit log');
  assert.ok(audit.logs.some((l) => l.action === 'enquiry_status'), 'triage is audited');
});
