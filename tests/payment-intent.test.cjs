/*
 * NearBuy — payment intent idempotency, attempt retention & cancellation tests.
 *
 *   node --test tests/payment-intent.test.cjs      (or `npm test`)
 *
 * Boots the real NearBuy server against a throwaway SQLite database and a local
 * mock Razorpay HTTP server so we can verify:
 *   1. Sequential retries reuse the existing active payment intent without
 *      creating extra Razorpay orders (including after payment.authorized).
 *   2. Simultaneous /payments/intent requests coalesce into a single gateway
 *      order and return the same gatewayOrderId to every caller.
 *   3. Retrying after a failed payment retains individual payment-attempt
 *      records so signed webhooks still recognize both old and new references.
 *   4. Gateway failures release the in-flight lock so subsequent retries recover.
 *   5. Cancelled orders (customer cancel, seller cancel, seller reject, and
 *      concurrent cancellation while the gateway call is in flight) are rejected
 *      with 409, and demo / other-account / already-paid orders are refused.
 *   6. Switching from COD to online and partially cancelled multi-shop orders
 *      preserve attempt history and never reuse stale amounts.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createHmac } = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nearbuy-payments-'));

const KEY_ID = 'rzp_test_nearbuy_key';
const KEY_SECRET = 'rzp_test_nearbuy_secret';
const WEBHOOK_SECRET = 'rzp_test_webhook_secret';

let PORT;
let BASE;
let child;
let gatewayServer;
let gatewayPort;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const gateway = {
  seq: 0,
  delayMs: 0,
  failNext: null,
  onOrderRequest: null,
  calls: [],
  resetControls() {
    this.delayMs = 0;
    this.failNext = null;
    this.onOrderRequest = null;
  }
};

function startMockGateway() {
  return new Promise((resolve) => {
    gatewayServer = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/orders') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { description: 'Not found' } }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const expectedAuth = 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { description: 'Invalid key credentials' } }));
        return;
      }

      const hook = gateway.onOrderRequest;
      if (hook) {
        gateway.onOrderRequest = null;
        await hook(body);
      }

      if (gateway.delayMs > 0) {
        await new Promise((r) => setTimeout(r, gateway.delayMs));
      }

      if (gateway.failNext) {
        const failure = gateway.failNext;
        gateway.failNext = null;
        gateway.calls.push({ body, failed: true });
        res.writeHead(failure.status || 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { description: failure.message || 'Simulated gateway outage' } }));
        return;
      }

      gateway.seq += 1;
      const id = `order_mock_${String(gateway.seq).padStart(4, '0')}`;
      gateway.calls.push({ id, body, failed: false });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id,
        entity: 'order',
        amount: body.amount,
        currency: body.currency || 'INR',
        receipt: body.receipt,
        status: 'created'
      }));
    });
    gatewayServer.listen(0, '127.0.0.1', () => {
      gatewayPort = gatewayServer.address().port;
      resolve();
    });
  });
}

function client() {
  let cookie = '';
  let csrf = '';
  return {
    get csrf() { return csrf; },
    async req(pathname, { method, body, headers = {} } = {}) {
      const h = { 'X-NearBuy-Request': '1', ...headers };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (cookie) h.Cookie = cookie;
      if (csrf) h['X-NearBuy-CSRF'] = csrf;
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
      return { status: res.status, json, text };
    }
  };
}

const get = (c, p) => c.req(p, { method: 'GET' });
const must = (res, status, label) => {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} — ${(res.text || '').slice(0, 300)}`);
  return res.json;
};

async function sendWebhook(eventName, { orderId, amount, currency = 'INR', paymentId = `pay_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, status, eventId }) {
  const payload = JSON.stringify({
    event: eventName,
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount,
          currency,
          status: status || (eventName === 'payment.captured' ? 'captured' : eventName === 'payment.failed' ? 'failed' : 'authorized')
        }
      }
    }
  });
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
  const headers = { 'content-type': 'application/json', 'x-razorpay-signature': sig };
  if (eventId) headers['x-razorpay-event-id'] = eventId;
  const res = await fetch(`${BASE}/api/customer/payments/webhook`, {
    method: 'POST',
    headers,
    body: payload
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

const S = {
  customerA: client(),
  customerB: client(),
  demoCustomer: client(),
  sellerA: client(),
  addressA: null,
  addressB: null,
  prodA: null,
  prodB: null,
  qtyA: 1,
  qtyB: 1
};

async function createAddress(c, label = 'Home') {
  const created = must(await c.req('/api/customer/addresses', {
    body: {
      label,
      receiver: 'Payment Tester',
      phone: '9811122334',
      line1: '14 Hauz Khas Enclave',
      locality: 'Hauz Khas',
      city: 'New Delhi',
      pincode: '110016',
      lat: 28.5494,
      lng: 77.2001,
      isDefault: true
    }
  }), 201, 'create address');
  return created.address.id;
}

async function placeOrder(c, addressId, items, paymentMethod = 'online') {
  for (const { productId, qty } of items) {
    must(await c.req('/api/customer/cart/items', { body: { productId, qty } }), 200, 'add cart item');
  }
  const quote = must(await c.req('/api/customer/checkout/quote', { body: { addressId } }), 200, 'checkout quote');
  assert.deepEqual(quote.quote.issues, [], `expected clean quote, got ${JSON.stringify(quote.quote.issues)}`);
  const created = must(await c.req('/api/customer/orders', {
    body: {
      addressId,
      paymentMethod,
      idempotencyKey: `paytest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    }
  }), 201, 'place order');
  return created.order;
}

before(async () => {
  await startMockGateway();
  PORT = await getFreePort();
  BASE = `http://127.0.0.1:${PORT}`;

  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NEARBUY_DB: path.join(DATA_DIR, 'payments.sqlite'),
      NODE_ENV: 'development',
      RAZORPAY_KEY_ID: KEY_ID,
      RAZORPAY_KEY_SECRET: KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      RAZORPAY_API_BASE: `http://127.0.0.1:${gatewayPort}`
    },
    stdio: 'ignore'
  });

  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`${BASE}/api/customer/home`);
      if (res.ok) { await res.body?.cancel(); ready = true; break; }
    } catch { /* waiting for startup */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  if (!ready) throw new Error('server did not start in time');

  // Register two customer accounts, then mark them as real (non-demo) users in the test DB
  // while keeping demo accounts active so we can test both real payments and demo rejection.
  const stamp = String(Date.now());
  const emailA = `pay-a-${stamp}@example.com`;
  const emailB = `pay-b-${stamp}@example.com`;
  must(await S.customerA.req('/api/customer/auth/register', {
    body: {
      name: 'Payment Tester A',
      email: emailA,
      phone: '96' + stamp.slice(-8),
      password: 'PayPassword1!',
      confirmPassword: 'PayPassword1!',
      terms: true
    }
  }), 201, 'register customer A');

  must(await S.customerB.req('/api/customer/auth/register', {
    body: {
      name: 'Payment Tester B',
      email: emailB,
      phone: '95' + stamp.slice(-8),
      password: 'PayPassword1!',
      confirmPassword: 'PayPassword1!',
      terms: true
    }
  }), 201, 'register customer B');

  const promote = spawnSync(process.execPath, [
    '-e',
    `const { db } = require('./server/customer/db');
     db.prepare('UPDATE nb_users SET is_demo=0 WHERE email IN (?,?)').run(process.argv[1], process.argv[2]);`,
    emailA, emailB
  ], {
    cwd: ROOT,
    env: { ...process.env, NEARBUY_DB: path.join(DATA_DIR, 'payments.sqlite') },
    encoding: 'utf8'
  });
  assert.equal(promote.status, 0, promote.stderr);

  must(await S.demoCustomer.req('/api/customer/auth/login', {
    body: { identifier: 'customer@nearbuy.demo', password: 'Customer123!' }
  }), 200, 'demo customer login');

  S.addressA = await createAddress(S.customerA);
  S.addressB = await createAddress(S.customerB);

  // Pick two in-stock products from two different serviceable shops (fresh-mart + scribble-stationery).
  const shopA = must(await get(S.customerA, '/api/customer/shops/fresh-mart?pincode=110016'), 200, 'shop A');
  const shopB = must(await get(S.customerA, '/api/customer/shops/scribble-stationery?pincode=110016'), 200, 'shop B');
  S.prodA = shopA.products.find((p) => p.stock >= 25 && p.price >= 5000);
  S.prodB = shopB.products.find((p) => p.stock >= 25 && p.price >= 5000);
  assert.ok(S.prodA && S.prodB, 'seeded shops must provide serviceable in-stock products');
  S.qtyA = Math.max(1, Math.ceil((shopA.shop.minOrder || 20000) / S.prodA.price));
  S.qtyB = Math.max(1, Math.ceil((shopB.shop.minOrder || 20000) / S.prodB.price));

  // Ensure our test products have generous stock for all test cases.
  const restock = spawnSync(process.execPath, [
    '-e',
    `const { db } = require('./server/customer/db');
     db.prepare('UPDATE nb_products SET stock=200 WHERE id IN (?,?)').run(process.argv[1], process.argv[2]);`,
    S.prodA.id, S.prodB.id
  ], {
    cwd: ROOT,
    env: { ...process.env, NEARBUY_DB: path.join(DATA_DIR, 'payments.sqlite') },
    encoding: 'utf8'
  });
  assert.equal(restock.status, 0, restock.stderr);

  // Sign in the Fresh Mart demo seller so we can test seller-side reject & cancel.
  must(await S.sellerA.req('/api/partner/login', {
    body: { email: 'owner@nearbuy.demo', password: 'Seller123!' }
  }), 200, 'seller login');
});

after(() => {
  if (child) child.kill();
  if (gatewayServer) gatewayServer.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

/* ------------------------------------------------------------------ */
/* 1 · sequential retries reuse the active payment intent              */
/* ------------------------------------------------------------------ */

test('retries reuse the active payment intent without creating a new Razorpay order', async () => {
  gateway.resetControls();
  const callsBefore = gateway.calls.length;
  const order = await placeOrder(S.customerA, S.addressA, [{ productId: S.prodA.id, qty: S.qtyA }], 'online');

  const first = must(await S.customerA.req('/api/customer/payments/intent', { body: { orderCode: order.code } }), 201, 'first intent');
  assert.equal(first.reused, false);
  assert.equal(first.orderCode, order.code);
  assert.equal(first.amount, order.total);
  assert.equal(first.currency, 'INR');
  assert.equal(first.keyId, KEY_ID);
  assert.ok(first.gatewayOrderId && first.paymentId);
  assert.equal(gateway.calls.length - callsBefore, 1, 'exactly one gateway order should be created');

  // Retrying while active must reuse the same intent and make zero extra gateway calls.
  const retry1 = must(await S.customerA.req('/api/customer/payments/intent', { body: { orderCode: order.code } }), 200, 'second intent');
  const retry2 = must(await S.customerA.req('/api/customer/payments/intent', { body: { orderCode: order.code } }), 200, 'third intent');
  assert.equal(retry1.reused, true);
  assert.equal(retry2.reused, true);
  assert.equal(retry1.gatewayOrderId, first.gatewayOrderId);
  assert.equal(retry2.gatewayOrderId, first.gatewayOrderId);
  assert.equal(retry1.paymentId, first.paymentId);
  assert.equal(gateway.calls.length - callsBefore, 1, 'retries must not create additional gateway orders');

  // An intermediate payment.authorized webhook moves the attempt to pending; retry must STILL reuse it.
  const authHook = await sendWebhook('payment.authorized', { orderId: first.gatewayOrderId, amount: first.amount, status: 'authorized' });
  assert.equal(authHook.status, 200);
  const retryPending = must(await S.customerA.req('/api/customer/payments/intent', { body: { orderCode: order.code } }), 200, 'retry while pending');
  assert.equal(retryPending.reused, true);
  assert.equal(retryPending.gatewayOrderId, first.gatewayOrderId);
  assert.equal(retryPending.status, 'pending');
  assert.equal(gateway.calls.length - callsBefore, 1, 'pending authorized intent must still be reused');

  const detail = must(await get(S.customerA, `/api/customer/orders/${encodeURIComponent(order.code)}`), 200, 'order detail');
  assert.equal(detail.order.payments.length, 1, 'no duplicate payment records created by retries');
  assert.equal(detail.order.payments[0].reference, first.gatewayOrderId);
});

/* ------------------------------------------------------------------ */
/* 2 · simultaneous requests coalesce into a single gateway order      */
/* ------------------------------------------------------------------ */

test('simultaneous /payments/intent requests create only one Razorpay order and return the same reference', async () => {
  gateway.resetControls();
  const order = await placeOrder(S.customerA, S.addressA, [{ productId: S.prodA.id, qty: S.qtyA }], 'online');

  // Delay the mock gateway so all concurrent requests overlap while the first request is in flight.
  gateway.delayMs = 150;
  const callsBefore = gateway.calls.length;

  const responses = await Promise.all(
    Array.from({ length: 6 }, () =>
      S.customerA.req('/api/customer/payments/intent', { body: { orderCode: order.code } })
    )
  );
  gateway.delayMs = 0;

  assert.equal(gateway.calls.length - callsBefore, 1, 'simultaneous requests must invoke Razorpay exactly once');

  const statuses = responses.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 201], 'one caller creates (201) and all concurrent callers reuse (200)');

  const ids = new Set(responses.map((r) => r.json.gatewayOrderId));
  const paymentIds = new Set(responses.map((r) => r.json.paymentId));
  assert.equal(ids.size, 1, 'every concurrent caller must receive the same gatewayOrderId');
  assert.equal(paymentIds.size, 1, 'every concurrent caller must receive the same paymentId');

  const detail = must(await get(S.customerA, `/api/customer/orders/${encodeURIComponent(order.code)}`), 200, 'order after burst');
  assert.equal(detail.order.payments.length, 1, 'only one payment attempt record should exist');
  assert.equal(detail.order.payments[0].reference, responses[0].json.gatewayOrderId);
  assert.equal(detail.order.payments[0].status, 'created');
});

/* ------------------------------------------------------------------ */
/* 3 · retries after failure retain individual attempt records         */
/* ------------------------------------------------------------------ */

test('retrying after a failed payment retains attempt history and webhooks recognize both old and new references', async () => {
  gateway.resetControls();

  // Subcase A: Attempt 1 fails -> Attempt 2 created -> Attempt 2 captured.
  const orderA = await placeOrder(S.customerA, S.addressA, [{ productId: S.prodA.id, qty: S.qtyA }], 'online');
  const attempt1 = must(await S.customerA.req('/api/customer/payments/intent', { body: { orderCode: orderA.code } }), 201, 'attempt 1');

  const failedHook = await sendWebhook('payment.failed', { orderId: attempt1.gatewayOrderId, amount: attempt1.amount });
  assert.equal(failedHook.status, 200);

  const attempt2 = must(await S.customerA.req('/api/customer/payments/intent', { body: { orderCode: orderA.code } }), 201, 'attempt 2 after failure');
  assert.equal(attempt2.reused, false);
  assert.notEqual(attempt2.gatewayOrderId, attempt1.gatewayOrderId, 'a new Razorpay order is created after failure');
  assert.notEqual(attempt2.paymentId, attempt1.paymentId, 'the retry gets its own payment-attempt record');

  // Retrying while Attempt 2 is active reuses Attempt 2 without creating Attempt 3.
  const callsBeforeReuse = gateway.calls.length;
  const attempt2Reuse = must(await S.customerA.req('/api/customer/payments/intent', { body: { orderCode: orderA.code } }), 200, 'reuse attempt 2');
  assert.equal(attempt2Reuse.reused, true);
  assert.equal(attempt2Reuse.gatewayOrderId, attempt2.gatewayOrderId);
  assert.equal(gateway.calls.length, callsBeforeReuse);

  const midDetail = must(await get(S.customerA, `/api/customer/orders/${encodeURIComponent(orderA.code)}`), 200, 'order with 2 attempts');
  assert.equal(midDetail.order.payments.length, 2, 'both attempt records are retained');
  assert.equal(midDetail.order.payments[0].reference, attempt1.gatewayOrderId);
  assert.equal(midDetail.order.payments[0].status, 'failed');
  assert.equal(midDetail.order.payments[1].reference, attempt2.gatewayOrderId);
  assert.equal(midDetail.order.payments[1].status, 'created');

  // Capture Attempt 2 via signed webhook.
  const capture2 = await sendWebhook('payment.captured', { orderId: attempt2.gatewayOrderId, amount: attempt2.amount });
  assert.equal(capture2.status, 200);
  assert.equal(capture2.json.ignored, undefined);

  const paidDetail = must(await get(S.customerA, `/api/customer/orders/${encodeURIComponent(orderA.code)}`), 200, 'paid order');
  assert.equal(paidDetail.order.paymentStatus, 'paid');
  assert.equal(paidDetail.order.payments.length, 2, 'failed attempt remains in history after capture');
  assert.equal(paidDetail.order.payments[0].status, 'failed');
  assert.equal(paidDetail.order.payments[1].status, 'paid');

  // Once paid, /payments/intent rejects with 409 without hitting the gateway.
  const callsBeforePaid = gateway.calls.length;
  const afterPaid = await S.customerA.req('/api/customer/payments/intent', { body: { orderCode: orderA.code } });
  assert.equal(afterPaid.status, 409);
  assert.equal(gateway.calls.length, callsBeforePaid);

  // Subcase B: Attempt 1 fails -> Attempt 2 created -> late webhook captures OLD Attempt 1 reference!
  const orderB = await placeOrder(S.customerA, S.addressA, [{ productId: S.prodA.id, qty: S.qtyA }], 'online');
  const oldAttempt = must(await S.customerA.req('/api/customer/payments/intent', { body: { orderCode: orderB.code } }), 201, 'old attempt');
  assert.equal((await sendWebhook('payment.failed', { orderId: oldAttempt.gatewayOrderId, amount: oldAttempt.amount })).status, 200);

  const newAttempt = must(await S.customerA.req('/api/customer/payments/intent', { body: { orderCode: orderB.code } }), 201, 'new attempt');
  assert.notEqual(newAttempt.gatewayOrderId, oldAttempt.gatewayOrderId);

  // Late capture arrives for the OLD reference — webhook must STILL recognize it!
  const lateCapture = await sendWebhook('payment.captured', { orderId: oldAttempt.gatewayOrderId, amount: oldAttempt.amount });
  assert.equal(lateCapture.status, 200);
  assert.equal(lateCapture.json.ignored, undefined, 'old attempt reference must still be recognized by webhook');

  const lateDetail = must(await get(S.customerA, `/api/customer/orders/${encodeURIComponent(orderB.code)}`), 200, 'late-captured order');
  assert.equal(lateDetail.order.paymentStatus, 'paid');
  assert.equal(lateDetail.order.payments.length, 2);
  assert.equal(lateDetail.order.payments[0].reference, oldAttempt.gatewayOrderId);
  assert.equal(lateDetail.order.payments[0].status, 'paid');
  assert.equal(lateDetail.order.payments[1].reference, newAttempt.gatewayOrderId);
  assert.equal(lateDetail.order.payments[1].status, 'superseded');

  // Replaying an out-of-order failed webhook for the already-paid record must not downgrade it.
  assert.equal((await sendWebhook('payment.failed', { orderId: oldAttempt.gatewayOrderId, amount: oldAttempt.amount })).status, 200);
  const stillPaid = must(await get(S.customerA, `/api/customer/orders/${encodeURIComponent(orderB.code)}`), 200, 'still paid');
  assert.equal(stillPaid.order.paymentStatus, 'paid');
  assert.equal(stillPaid.order.payments[0].status, 'paid');
});

/* ------------------------------------------------------------------ */
/* 4 · gateway failure releases in-flight lock for clean retry         */
/* ------------------------------------------------------------------ */

test('a transient gateway error releases the in-flight lock so a retry succeeds cleanly', async () => {
  gateway.resetControls();
  const order = await placeOrder(S.customerA, S.addressA, [{ productId: S.prodA.id, qty: S.qtyA }], 'online');

  gateway.delayMs = 80;
  gateway.failNext = { status: 500, message: 'Temporary Razorpay outage' };
  const failedPair = await Promise.all([
    S.customerA.req('/api/customer/payments/intent', { body: { orderCode: order.code } }),
    S.customerA.req('/api/customer/payments/intent', { body: { orderCode: order.code } })
  ]);
  gateway.delayMs = 0;

  assert.equal(failedPair[0].status, 502);
  assert.equal(failedPair[1].status, 502);

  // Subsequent retry succeeds cleanly.
  const recovered = must(await S.customerA.req('/api/customer/payments/intent', { body: { orderCode: order.code } }), 201, 'recovered intent');
  assert.equal(recovered.reused, false);
  assert.ok(recovered.gatewayOrderId);
});

/* ------------------------------------------------------------------ */
/* 5 · cancelled & rejected orders are rejected across every path      */
/* ------------------------------------------------------------------ */

test('payment initiation is rejected after customer cancellation, seller rejection, and seller cancellation', async () => {
  gateway.resetControls();

  // 5a. Customer cancels BEFORE initiating payment.
  const order1 = await placeOrder(S.customerB, S.addressB, [{ productId: S.prodA.id, qty: S.qtyA }], 'online');
  must(await S.customerB.req(`/api/customer/orders/${encodeURIComponent(order1.code)}/cancel`, {
    body: { reason: 'Ordered by mistake' }
  }), 200, 'customer cancel before intent');

  const callsBefore1 = gateway.calls.length;
  const payAfterCancel1 = await S.customerB.req('/api/customer/payments/intent', { body: { orderCode: order1.code } });
  assert.equal(payAfterCancel1.status, 409, 'cancelled order must reject payment initiation');
  assert.match(payAfterCancel1.json.error, /cancelled/i);
  assert.equal(gateway.calls.length, callsBefore1, 'must not contact gateway for a cancelled order');

  // 5b. Customer creates an active intent, THEN cancels the order, THEN retries /payments/intent.
  const order2 = await placeOrder(S.customerB, S.addressB, [{ productId: S.prodA.id, qty: S.qtyA }], 'online');
  const intent2 = must(await S.customerB.req('/api/customer/payments/intent', { body: { orderCode: order2.code } }), 201, 'intent before cancel');

  must(await S.customerB.req(`/api/customer/orders/${encodeURIComponent(order2.code)}/cancel`, {
    body: { reason: 'Found a better option' }
  }), 200, 'customer cancel after intent');

  const callsBefore2 = gateway.calls.length;
  const payAfterCancel2 = await S.customerB.req('/api/customer/payments/intent', { body: { orderCode: order2.code } });
  assert.equal(payAfterCancel2.status, 409, 'must not reuse an intent once the order is cancelled');
  assert.match(payAfterCancel2.json.error, /cancelled/i);
  assert.equal(gateway.calls.length, callsBefore2, 'must not contact gateway when retrying on cancelled order');

  // The cancelled intent's reference is still retained in payment records so a late capture webhook is recognized and refunded.
  const cancelledDetail = must(await get(S.customerB, `/api/customer/orders/${encodeURIComponent(order2.code)}`), 200, 'cancelled order detail');
  assert.equal(cancelledDetail.order.payments[0].reference, intent2.gatewayOrderId);
  assert.equal(cancelledDetail.order.payments[0].status, 'cancelled');
  const lateCancelledCapture = await sendWebhook('payment.captured', { orderId: intent2.gatewayOrderId, amount: intent2.amount });
  assert.equal(lateCancelledCapture.status, 200);
  assert.equal(lateCancelledCapture.json.ignored, undefined, 'webhook still recognizes cancelled attempt reference');
  const returnsAndRefunds = must(await get(S.customerB, '/api/customer/returns'), 200, 'refunds after late capture');
  assert.ok(returnsAndRefunds.refunds.some((r) => r.amount === intent2.amount && r.status === 'processing'), 'late capture on a cancelled order initiates a refund');

  // 5c. Seller REJECTS the order -> customer cannot initiate payment.
  const order3 = await placeOrder(S.customerB, S.addressB, [{ productId: S.prodA.id, qty: S.qtyA }], 'online');
  const sellerOrder3 = order3.sellerOrders[0].code;
  must(await S.sellerA.req(`/api/partner/seller/orders/${encodeURIComponent(sellerOrder3)}/action`, {
    body: { action: 'reject', reason: 'Item out of stock at counter' }
  }), 200, 'seller rejects order');

  const callsBefore3 = gateway.calls.length;
  const payAfterReject = await S.customerB.req('/api/customer/payments/intent', { body: { orderCode: order3.code } });
  assert.equal(payAfterReject.status, 409, 'seller-rejected order must reject payment initiation');
  assert.match(payAfterReject.json.error, /cancelled/i);
  assert.equal(gateway.calls.length, callsBefore3, 'must not contact gateway for a seller-rejected order');

  // 5d. Seller CANCELS the order -> customer cannot initiate payment.
  const order4 = await placeOrder(S.customerB, S.addressB, [{ productId: S.prodA.id, qty: S.qtyA }], 'online');
  const sellerOrder4 = order4.sellerOrders[0].code;
  must(await S.sellerA.req(`/api/partner/seller/orders/${encodeURIComponent(sellerOrder4)}/action`, {
    body: { action: 'cancel', reason: 'Shop closing early' }
  }), 200, 'seller cancels order');

  const callsBefore4 = gateway.calls.length;
  const payAfterSellerCancel = await S.customerB.req('/api/customer/payments/intent', { body: { orderCode: order4.code } });
  assert.equal(payAfterSellerCancel.status, 409, 'seller-cancelled order must reject payment initiation');
  assert.equal(gateway.calls.length, callsBefore4);
});

test('cancelling an order while /payments/intent is in flight rejects the intent and retains the gateway reference', async () => {
  gateway.resetControls();
  const order = await placeOrder(S.customerB, S.addressB, [{ productId: S.prodA.id, qty: S.qtyA }], 'online');

  // Trigger cancellation as soon as the mock gateway receives POST /v1/orders,
  // while multiple simultaneous /payments/intent requests are waiting on it.
  let cancelResult = null;
  gateway.onOrderRequest = async () => {
    await new Promise((r) => setTimeout(r, 40));
    cancelResult = await S.customerB.req(`/api/customer/orders/${encodeURIComponent(order.code)}/cancel`, {
      body: { reason: 'Cancelled mid-flight' }
    });
  };

  const callsBefore = gateway.calls.length;
  const results = await Promise.all([
    S.customerB.req('/api/customer/payments/intent', { body: { orderCode: order.code } }),
    S.customerB.req('/api/customer/payments/intent', { body: { orderCode: order.code } }),
    S.customerB.req('/api/customer/payments/intent', { body: { orderCode: order.code } })
  ]);
  assert.equal(cancelResult?.status, 200, 'concurrent cancellation should succeed');
  assert.equal(gateway.calls.length - callsBefore, 1, 'simultaneous in-flight requests only hit gateway once');
  for (const intentRes of results) {
    assert.equal(intentRes.status, 409, 'every in-flight caller must receive 409 once the order is cancelled');
    assert.match(intentRes.json.error, /cancelled/i);
  }

  const detail = must(await get(S.customerB, `/api/customer/orders/${encodeURIComponent(order.code)}`), 200, 'cancelled mid-flight order');
  const gatewayRecord = detail.order.payments.find((p) => p.provider === 'razorpay' && p.reference);
  assert.ok(gatewayRecord, 'gateway reference created during in-flight race must still be retained for webhooks/audit');
  assert.equal(gatewayRecord.status, 'cancelled');
});

/* ------------------------------------------------------------------ */
/* 6 · COD switch, partial cancellation & access-control eligibility   */
/* ------------------------------------------------------------------ */

test('switching COD to online, partial cancellation, and access-control checks behave safely', async () => {
  gateway.resetControls();

  // 6a. Switching an unpaid COD order to online retains the COD record and creates a dedicated Razorpay attempt.
  const codOrder = await placeOrder(S.customerB, S.addressB, [{ productId: S.prodA.id, qty: S.qtyA }], 'cod');
  const codIntent1 = must(await S.customerB.req('/api/customer/payments/intent', { body: { orderCode: codOrder.code } }), 201, 'switch cod to online');
  const codIntent2 = must(await S.customerB.req('/api/customer/payments/intent', { body: { orderCode: codOrder.code } }), 200, 'reuse online intent after cod switch');
  assert.equal(codIntent2.gatewayOrderId, codIntent1.gatewayOrderId);
  assert.equal(codIntent2.reused, true);

  const codDetail = must(await get(S.customerB, `/api/customer/orders/${encodeURIComponent(codOrder.code)}`), 200, 'cod switched order');
  assert.equal(codDetail.order.paymentMethod, 'online');
  assert.equal(codDetail.order.payments.length, 2, 'original COD record and new Razorpay attempt are both kept');
  assert.equal(codDetail.order.payments[0].method, 'cod');
  assert.equal(codDetail.order.payments[0].status, 'superseded');
  assert.equal(codDetail.order.payments[1].method, 'online');
  assert.equal(codDetail.order.payments[1].reference, codIntent1.gatewayOrderId);
  assert.equal(codDetail.order.payments[1].status, 'created');

  // 6b. Multi-shop order: partial cancellation supersedes stale-amount intent and charges only active shops.
  const multi = await placeOrder(S.customerB, S.addressB, [
    { productId: S.prodA.id, qty: S.qtyA },
    { productId: S.prodB.id, qty: S.qtyB }
  ], 'online');
  assert.equal(multi.sellerOrders.length, 2);

  const fullIntent = must(await S.customerB.req('/api/customer/payments/intent', { body: { orderCode: multi.code } }), 201, 'full multi-shop intent');
  assert.equal(fullIntent.amount, multi.total);

  // Cancel just one shop's seller order.
  const [soFirst, soSecond] = multi.sellerOrders;
  must(await S.customerB.req(`/api/customer/orders/${encodeURIComponent(multi.code)}/cancel`, {
    body: { sellerOrderId: soFirst.code, reason: 'Cancel first shop only' }
  }), 200, 'cancel first shop');

  const partialIntent = must(await S.customerB.req('/api/customer/payments/intent', { body: { orderCode: multi.code } }), 201, 'intent for remaining active shop');
  assert.equal(partialIntent.reused, false, 'must not reuse stale full-order intent after partial cancellation');
  assert.notEqual(partialIntent.gatewayOrderId, fullIntent.gatewayOrderId);
  assert.equal(partialIntent.amount, soSecond.total, 'must charge only the remaining active shop total');

  const partialDetail = must(await get(S.customerB, `/api/customer/orders/${encodeURIComponent(multi.code)}`), 200, 'partially cancelled order');
  assert.equal(partialDetail.order.payments.length, 2, 'superseded full-amount intent is retained alongside the new intent');
  assert.equal(partialDetail.order.payments[0].reference, fullIntent.gatewayOrderId);
  assert.equal(partialDetail.order.payments[0].status, 'superseded');
  assert.equal(partialDetail.order.payments[1].reference, partialIntent.gatewayOrderId);
  assert.equal(partialDetail.order.payments[1].status, 'created');

  // Cancel the second (final) shop -> now the entire order is cancelled and payment is rejected.
  must(await S.customerB.req(`/api/customer/orders/${encodeURIComponent(multi.code)}/cancel`, {
    body: { sellerOrderId: soSecond.code, reason: 'Cancel remaining shop too' }
  }), 200, 'cancel second shop');
  const callsBeforeFinal = gateway.calls.length;
  const afterAllCancelled = await S.customerB.req('/api/customer/payments/intent', { body: { orderCode: multi.code } });
  assert.equal(afterAllCancelled.status, 409);
  assert.equal(gateway.calls.length, callsBeforeFinal);

  // 6c. Ownership, demo, auth & unknown-order checks.
  const wrongCustomer = await S.customerA.req('/api/customer/payments/intent', { body: { orderCode: codOrder.code } });
  assert.equal(wrongCustomer.status, 403);
  const demoPay = await S.demoCustomer.req('/api/customer/payments/intent', { body: { orderCode: codOrder.code } });
  assert.equal(demoPay.status, 403);
  const anonPay = await client().req('/api/customer/payments/intent', { body: { orderCode: codOrder.code } });
  assert.equal(anonPay.status, 401);
  const missingOrder = await S.customerB.req('/api/customer/payments/intent', { body: { orderCode: 'NB-DOES-NOT-EXIST' } });
  assert.equal(missingOrder.status, 404);
});
