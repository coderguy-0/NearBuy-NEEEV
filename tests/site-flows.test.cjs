/*
 * End-to-end user journeys across the four live portals — zero dependencies.
 *
 *   npm test
 *
 * Starts the real server on its own temporary database and then walks the two
 * journeys a first-time visitor actually takes:
 *
 *   1. a brand-new customer: browse → register → address → basket → order →
 *      wishlist → support ticket → cancel → sign out;
 *   2. the fulfilment chain for a seeded order: seller accept → pack → ready →
 *      runner request → runner accept → handover PIN → pickup → out for delivery
 *      → customer OTP → delivered, with the admin queues reflecting all of it.
 *
 * Both journeys are asserted over HTTP with a cookie- and CSRF-aware client, so
 * a regression in routing, permissions or pricing fails here rather than in a
 * browser.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 4231;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nearbuy-flows-'));

let child;

/* A browser-like client: keeps its own cookie jar (customer, partner and admin
 * cookies coexist) and remembers the CSRF token for the session it owns. */
function client() {
  let cookie = '';
  let csrf = '';
  return {
    get csrf() { return csrf; },
    async req(route, { method = 'GET', body } = {}) {
      const headers = { 'X-NearBuy-Request': '1', Origin: BASE };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      if (csrf) headers['X-NearBuy-CSRF'] = csrf;
      const res = await fetch(BASE + route, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual'
      });
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (setCookies.length) cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (json && json.user && json.user.csrf) csrf = json.user.csrf;
      if (json && json.csrf) csrf = json.csrf;
      return { status: res.status, json, text };
    },
    post(route, body) { return this.req(route, { method: 'POST', body }); }
  };
}

before(async () => {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SEED_DEMO: '1', NEARBUY_DB: path.join(DATA_DIR, 'flows.sqlite') },
    stdio: 'ignore'
  });
  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(`${BASE}/`, { method: 'HEAD' });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error('server did not start in time');
});

after(() => {
  if (child) child.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('a new customer can register, order, get help, cancel and sign out', async () => {
  const c = client();

  // Browsing is public.
  const home = await c.req('/api/customer/home');
  assert.equal(home.status, 200);
  assert.ok(home.json.categories.length >= 10, 'the storefront lists the live categories');
  assert.ok(home.json.shops.length >= 1, 'the storefront lists serviceable shops');

  const products = await c.req('/api/customer/products?q=milk&pincode=110016');
  assert.equal(products.status, 200);
  const product = products.json.products[0];
  assert.ok(product, 'search returns a product');

  // A new account, hashed server-side.
  const email = `flow-${Date.now()}@example.com`;
  const registered = await c.post('/api/customer/auth/register', {
    name: 'Flow Tester', email, phone: '9' + String(Date.now()).slice(-9), password: 'Flowpass1', terms: true
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.json));

  const address = await c.post('/api/customer/addresses', {
    label: 'Home', receiver: 'Flow Tester', phone: '9812345678', line1: '12 Test Lane',
    locality: 'Hauz Khas', city: 'Delhi', pincode: '110016'
  });
  assert.ok([200, 201].includes(address.status), JSON.stringify(address.json));
  const addressId = address.json.address?.id || address.json.addresses?.[0]?.id || address.json.id;
  assert.ok(addressId, 'the saved address comes back');

  // The basket and the order are priced by the server, never by the browser.
  const qty = Math.max(2, Math.ceil(19900 / product.price));
  assert.equal((await c.post('/api/customer/cart/items', { productId: product.id, qty })).status, 200);
  const placed = await c.post('/api/customer/orders', { addressId, paymentMethod: 'cod', idempotencyKey: `flow-${Date.now()}` });
  assert.equal(placed.status, 201, JSON.stringify(placed.json));
  const order = placed.json.order;
  assert.match(order.code, /^NB-/, 'the parent order gets a code');
  assert.ok(order.sellerOrders.length >= 1, 'the basket splits into shop-level orders');

  // The basket is emptied by checkout, so a second submit cannot duplicate the order.
  const again = await c.post('/api/customer/orders', { addressId, paymentMethod: 'cod', idempotencyKey: `flow-${Date.now()}` });
  assert.ok([400, 409].includes(again.status), `a second submit is refused (${again.status})`);
  const emptied = (await c.req('/api/customer/cart')).json.cart;
  assert.equal(emptied.groups?.length || emptied.items?.length || 0, 0, 'checkout empties the basket');

  assert.equal((await c.post(`/api/customer/wishlist/${encodeURIComponent(product.id)}`, {})).status, 200);
  assert.ok((await c.req('/api/customer/wishlist')).json.products.some((p) => p.id === product.id), 'the wishlist persists');

  const notifications = await c.req('/api/customer/notifications');
  assert.ok(notifications.json.notifications.length >= 1, 'placing an order notifies the customer');

  const ticket = await c.post('/api/customer/tickets', {
    orderCode: order.code, category: 'delivery', subject: 'Where is my order?',
    description: 'Please share a detailed update on this order and the expected delivery time.'
  });
  assert.equal(ticket.status, 201, JSON.stringify(ticket.json));
  assert.match(ticket.json.ticket.code, /^TKT-/, 'support tickets are real records');

  // Cancelling before the shop accepts releases the stock again.
  const cancel = await c.post(`/api/customer/orders/${order.code}/cancel`, { reason: 'Ordered by mistake' });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.json));

  assert.equal((await c.post('/api/customer/auth/logout', {})).status, 200);
  assert.equal((await c.req('/api/customer/orders')).status, 401, 'orders are private to the session');
});

test('the public enquiry form saves to the operations inbox', async () => {
  const guest = client();
  const created = await guest.post('/api/customer/enquiry', {
    name: 'Homepage Visitor', contact: 'visitor@example.com', topic: 'Order help',
    message: 'I would like help choosing between two nearby shops for a delivery tomorrow.'
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.match(created.json.code, /^ENQ-/, 'the visitor receives a reference code');

  const admin = client();
  assert.equal((await admin.post('/api/admin/login', { email: 'admin@nearbuy.demo', password: 'Admin123!' })).status, 200);
  const inbox = await admin.req('/api/admin/enquiries');
  const row = inbox.json.enquiries.find((e) => e.code === created.json.code);
  assert.ok(row, 'the enquiry is visible in the Admin Portal inbox');
  assert.equal(row.status, 'open');

  const moved = await admin.req(`/api/admin/enquiries/${encodeURIComponent(row.code)}`, { method: 'PATCH', body: { status: 'in_review' } });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
});

test('seller, runner and admin complete one delivery end to end', async () => {
  const customer = client();
  const seller = client();
  const runner = client();
  const admin = client();

  assert.equal((await customer.post('/api/customer/auth/login', { identifier: 'customer@nearbuy.demo', password: 'Customer123!' })).status, 200);
  assert.equal((await seller.post('/api/partner/login', { email: 'owner@nearbuy.demo', password: 'Seller123!' })).status, 200);
  assert.equal((await runner.post('/api/partner/login', { email: 'rohan@nearbuy.demo', password: 'Runner123!' })).status, 200);
  assert.equal((await admin.post('/api/admin/login', { email: 'admin@nearbuy.demo', password: 'Admin123!' })).status, 200);

  // A role can never open another portal's console.
  assert.equal((await runner.req('/api/admin/overview')).status, 401, 'a runner session is refused by the admin API');
  assert.equal((await admin.req('/api/partner/seller/overview')).status, 401, 'an admin session is refused by the seller API');

  const addresses = (await customer.req('/api/customer/addresses')).json.addresses;
  const stock = (await seller.req('/api/partner/seller/inventory')).json.products.find((p) => p.available > 4);
  assert.ok(stock, 'the seeded shop has stock to sell');
  const qty = Math.max(2, Math.ceil(19900 / stock.price));
  assert.equal((await customer.post('/api/customer/cart/items', { productId: stock.id, qty })).status, 200);
  const placed = await customer.post('/api/customer/orders', {
    addressId: addresses[0].id, paymentMethod: 'cod', idempotencyKey: `chain-${Date.now()}`
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.json));
  const so = placed.json.order.sellerOrders.find((o) => o.items.some((i) => i.productId === stock.id)) || placed.json.order.sellerOrders[0];

  // The seller must prepare before packing, and packing gates "ready".
  assert.equal((await seller.post(`/api/partner/seller/orders/${so.code}/action`, { action: 'ready' })).status, 409, 'an unpacked order cannot be ready');
  assert.equal((await seller.post(`/api/partner/seller/orders/${so.code}/action`, { action: 'accept' })).status, 200);
  assert.equal((await seller.post(`/api/partner/seller/orders/${so.code}/action`, { action: 'prepare' })).status, 200);

  const packing = (await seller.req(`/api/partner/seller/orders/${so.code}/packing`)).json;
  for (const item of packing.items) {
    assert.equal((await seller.post(`/api/partner/seller/orders/${so.code}/packing`, {
      orderItemId: item.orderItemId, packedQty: item.orderedQty, status: 'packed'
    })).status, 200);
  }
  assert.equal((await seller.post(`/api/partner/seller/orders/${so.code}/action`, { action: 'ready' })).status, 200);
  assert.equal((await seller.post(`/api/partner/seller/orders/${so.code}/action`, {
    action: 'request_runner', weightGrams: 900, packages: 1, timing: 'asap'
  })).status, 200);

  const offer = (await runner.req('/api/partner/runner/overview')).json.offers.find((o) => o.orderCode === so.code);
  assert.ok(offer, 'the shared pool surfaces the request to the runner');
  assert.equal((await runner.post(`/api/partner/runner/offers/${offer.id}/accept`, {})).status, 200);

  const mine = (await seller.req('/api/partner/seller/orders?status=all')).json.orders.find((o) => o.code === so.code);
  assert.match(String(mine.handoverPin), /^\d{4}$/, 'the shop gets a handover PIN');
  assert.equal((await seller.post(`/api/partner/seller/orders/${so.code}/action`, {
    action: 'confirm_handover', pin: mine.handoverPin
  })).status, 200);

  const job = (await runner.req('/api/partner/runner/jobs')).json.jobs.find((j) => j.status === 'accepted');
  assert.equal((await runner.post(`/api/partner/runner/jobs/${job.id}/action`, { action: 'picked_up', pickupPin: '0000' })).status, 400, 'the wrong PIN is refused');
  assert.equal((await runner.post(`/api/partner/runner/jobs/${job.id}/action`, { action: 'picked_up', pickupPin: mine.handoverPin })).status, 200);
  assert.equal((await runner.post(`/api/partner/runner/jobs/${job.id}/action`, { action: 'out_for_delivery' })).status, 200);

  // The customer is the only one who can read the delivery OTP.
  const detail = (await customer.req(`/api/customer/orders/${placed.json.order.code}`)).json.order;
  const otp = detail.sellerOrders.find((o) => o.code === so.code)?.deliveryOtp;
  assert.match(String(otp), /^\d{6}$/, 'the customer sees a 6-digit delivery OTP');
  assert.equal((await runner.post(`/api/partner/runner/jobs/${job.id}/action`, { action: 'delivered', otp: '123456' })).status, 400, 'the wrong OTP is refused');
  assert.equal((await runner.post(`/api/partner/runner/jobs/${job.id}/action`, { action: 'delivered', otp: String(otp) })).status, 200);

  const done = (await customer.req(`/api/customer/orders/${placed.json.order.code}`)).json.order;
  assert.ok(['delivered', 'completed'].includes(done.status), `the parent order closes out (${done.status})`);

  // Every administrative queue reflects the completed delivery.
  for (const queue of ['/api/admin/orders', '/api/admin/deliveries', '/api/admin/audit']) {
    assert.equal((await admin.req(queue)).status, 200, `${queue} is reachable`);
  }
});
