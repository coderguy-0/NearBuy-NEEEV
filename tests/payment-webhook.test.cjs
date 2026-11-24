/*
 * NearBuy — payment webhook replay safety, amount/currency validation &
 * explicit state-transition tests.
 *
 *   node --test tests/payment-webhook.test.cjs      (or `npm test`)
 *
 * Boots the real NearBuy server against a throwaway SQLite database and a local
 * mock Razorpay HTTP server so we can verify:
 *   1. Duplicate payment.captured webhooks (same x-razorpay-event-id, omitted
 *      event ID with same payment, different event ID on already-paid record,
 *      and simultaneous duplicate deliveries) are deduplicated and emit only
 *      one customer notification.
 *   2. Delayed payment.failed and payment.authorized events arriving after
 *      capture never downgrade a paid payment record or emit failure notices,
 *      and delayed payment.authorized after failure never resurrects a failed
 *      attempt.
 *   3. Unrelated gateway events (refund.created, refund.processed, order.paid,
 *      payment.dispute.created, settlement.processed, or missing event name)
 *      are ignored even when they carry payload.payment.entity, neither
 *      marking unpaid orders paid nor downgrading paid records.
 *   4. Mismatched amounts (underpaid, overpaid, zero, negative, non-integer,
 *      string, missing), mismatched/missing currency, and contradictory
 *      entity status are rejected with 400 without mutating order/payment
 *      state or poisoning subsequent legitimate capture webhooks.
 *   5. Invalid HMAC signatures (401), invalid JSON (400), and unknown order
 *      references (200 ignored) behave cleanly.
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nearbuy-webhooks-'));
const DB_FILE = path.join(DATA_DIR, 'webhooks.sqlite');

const KEY_ID = 'rzp_test_webhook_key';
const KEY_SECRET = 'rzp_test_webhook_key_secret';
const WEBHOOK_SECRET = 'rzp_test_webhook_signing_secret';

let PORT;
let BASE;
let child;
let gatewayServer;
let gatewayPort;
let gatewaySeq = 0;

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
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      gatewaySeq += 1;
      const id = `order_wh_${String(gatewaySeq).padStart(4, '0')}`;
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

async function postRawWebhook(rawBody, { signature, eventId } = {}) {
  const sig = signature !== undefined
    ? signature
    : createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  const headers = {
    'content-type': 'application/json',
    'x-razorpay-signature': sig
  };
  if (eventId) headers['x-razorpay-event-id'] = eventId;
  const res = await fetch(`${BASE}/api/customer/payments/webhook`, {
    method: 'POST',
    headers,
    body: rawBody
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
}

function postWebhook(bodyObj, opts = {}) {
  return postRawWebhook(JSON.stringify(bodyObj), opts);
}

const S = {
  customer: client(),
  addressId: null,
  product: null,
  qty: 1
};

async function placeOrderWithIntent() {
  must(await S.customer.req('/api/customer/cart/items', { body: { productId: S.product.id, qty: S.qty } }), 200, 'add item');
  const created = must(await S.customer.req('/api/customer/orders', {
    body: {
      addressId: S.addressId,
      paymentMethod: 'online',
      idempotencyKey: `wh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    }
  }), 201, 'create order');
  const intent = must(await S.customer.req('/api/customer/payments/intent', {
    body: { orderCode: created.order.code }
  }), 201, 'create intent');
  return { order: created.order, intent };
}

async function paymentNotificationsFor(orderCode) {
  const res = must(await get(S.customer, '/api/customer/notifications'), 200, 'notifications');
  return res.notifications.filter((n) => n.type === 'payment' && String(n.body || '').includes(orderCode));
}

function queryDb(sql, ...params) {
  const run = spawnSync(process.execPath, [
    '-e',
    `const { db } = require('./server/customer/db');
     const rows = db.prepare(process.argv[1]).all(...JSON.parse(process.argv[2]));
     console.log(JSON.stringify(rows));`,
    sql,
    JSON.stringify(params)
  ], {
    cwd: ROOT,
    env: { ...process.env, NEARBUY_DB: DB_FILE },
    encoding: 'utf8'
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim() || '[]');
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
      NEARBUY_DB: DB_FILE,
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

  const stamp = String(Date.now());
  const email = `webhook-${stamp}@example.com`;
  must(await S.customer.req('/api/customer/auth/register', {
    body: {
      name: 'Webhook Tester',
      email,
      phone: '94' + stamp.slice(-8),
      password: 'Webhook123!',
      confirmPassword: 'Webhook123!',
      terms: true
    }
  }), 201, 'register customer');

  const promote = spawnSync(process.execPath, [
    '-e',
    `const { db } = require('./server/customer/db');
     db.prepare('UPDATE nb_users SET is_demo=0 WHERE email=?').run(process.argv[1]);`,
    email
  ], { cwd: ROOT, env: { ...process.env, NEARBUY_DB: DB_FILE }, encoding: 'utf8' });
  assert.equal(promote.status, 0, promote.stderr);

  const addr = must(await S.customer.req('/api/customer/addresses', {
    body: {
      label: 'Home',
      receiver: 'Webhook Tester',
      phone: '9411122334',
      line1: '18 Hauz Khas Enclave',
      locality: 'Hauz Khas',
      city: 'New Delhi',
      pincode: '110016',
      lat: 28.5494,
      lng: 77.2001,
      isDefault: true
    }
  }), 201, 'create address');
  S.addressId = addr.address.id;

  const shop = must(await get(S.customer, '/api/customer/shops/fresh-mart?pincode=110016'), 200, 'shop');
  S.product = shop.products.find((p) => p.price >= 5000);
  assert.ok(S.product, 'seeded product available');
  S.qty = Math.max(1, Math.ceil((shop.shop.minOrder || 20000) / S.product.price));

  const restock = spawnSync(process.execPath, [
    '-e',
    `const { db } = require('./server/customer/db');
     db.prepare('UPDATE nb_products SET stock=200 WHERE id=?').run(process.argv[1]);`,
    S.product.id
  ], { cwd: ROOT, env: { ...process.env, NEARBUY_DB: DB_FILE }, encoding: 'utf8' });
  assert.equal(restock.status, 0, restock.stderr);
});

after(() => {
  if (child) child.kill();
  if (gatewayServer) gatewayServer.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

/* ------------------------------------------------------------------ */
/* 1 · duplicate capture events (replay safety)                        */
/* ------------------------------------------------------------------ */

test('duplicate capture events are deduplicated and never send duplicate notifications', async () => {
  const { order, intent } = await placeOrderWithIntent();
  const capturePayload = {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_dup_001',
          order_id: intent.gatewayOrderId,
          amount: intent.amount,
          currency: 'INR',
          status: 'captured'
        }
      }
    }
  };

  // First delivery processes cleanly.
  const first = await postWebhook(capturePayload, { eventId: 'evt_capture_001' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { ok: true });

  // Exact replay with the same x-razorpay-event-id is deduplicated.
  const replaySameHeader = await postWebhook(capturePayload, { eventId: 'evt_capture_001' });
  assert.equal(replaySameHeader.status, 200);
  assert.equal(replaySameHeader.json.ok, true);
  assert.equal(replaySameHeader.json.duplicate, true);

  // Replay without x-razorpay-event-id (same payment.id + order_id) is also deduplicated.
  const replayNoHeader1 = await postWebhook(capturePayload);
  assert.equal(replayNoHeader1.status, 200);
  assert.equal(replayNoHeader1.json.duplicate, true);
  const replayNoHeader2 = await postWebhook(capturePayload);
  assert.equal(replayNoHeader2.status, 200);
  assert.equal(replayNoHeader2.json.duplicate, true);

  // Duplicate capture with a brand-new event ID & payment ID on the already-paid record is a duplicate no-op.
  const replayDifferentEvent = await postWebhook({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_dup_002',
          order_id: intent.gatewayOrderId,
          amount: intent.amount,
          currency: 'INR',
          status: 'captured'
        }
      }
    }
  }, { eventId: 'evt_capture_002' });
  assert.equal(replayDifferentEvent.status, 200);
  assert.equal(replayDifferentEvent.json.duplicate, true);

  const detail = must(await get(S.customer, `/api/customer/orders/${encodeURIComponent(order.code)}`), 200, 'paid order');
  assert.equal(detail.order.paymentStatus, 'paid');
  assert.equal(detail.order.payments[0].status, 'paid');

  const notifs = await paymentNotificationsFor(order.code);
  assert.equal(notifs.length, 1, 'duplicate captures must emit exactly one Payment successful notification');
  assert.match(notifs[0].title, /Payment successful/i);

  const audits = queryDb("SELECT action FROM nb_audit_logs WHERE entity='order' AND entity_id=? AND action='payment_captured'", order.id);
  assert.equal(audits.length, 1, 'duplicate captures must emit only one payment_captured audit log');

  // Simultaneous burst of identical capture webhooks: only one processes, the rest are duplicates.
  const { order: burstOrder, intent: burstIntent } = await placeOrderWithIntent();
  const burstBody = {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_burst_001',
          order_id: burstIntent.gatewayOrderId,
          amount: burstIntent.amount,
          currency: 'INR',
          status: 'captured'
        }
      }
    }
  };
  const burstResults = await Promise.all(
    Array.from({ length: 5 }, () => postWebhook(burstBody, { eventId: 'evt_burst_capture' }))
  );
  assert.ok(burstResults.every((r) => r.status === 200 && r.json.ok === true));
  assert.equal(burstResults.filter((r) => !r.json.duplicate).length, 1, 'exactly one concurrent delivery should process');
  assert.equal(burstResults.filter((r) => r.json.duplicate === true).length, 4, 'other concurrent deliveries should be deduplicated');
  assert.equal((await paymentNotificationsFor(burstOrder.code)).length, 1, 'concurrent burst emits only one notification');
});

/* ------------------------------------------------------------------ */
/* 2 · failure-after-capture & invalid payment-state transitions       */
/* ------------------------------------------------------------------ */

test('delayed failure or authorized events after capture cannot downgrade a paid payment record', async () => {
  const { order, intent } = await placeOrderWithIntent();

  // Capture payment first.
  const cap = await postWebhook({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_term_001',
          order_id: intent.gatewayOrderId,
          amount: intent.amount,
          currency: 'INR',
          status: 'captured'
        }
      }
    }
  }, { eventId: 'evt_term_cap_1' });
  assert.equal(cap.status, 200);
  assert.equal(cap.json.duplicate, undefined);

  // Delayed payment.failed arrives AFTER capture — must NOT downgrade record or notify failure.
  const failAfterCap = await postWebhook({
    event: 'payment.failed',
    payload: {
      payment: {
        entity: {
          id: 'pay_term_fail_1',
          order_id: intent.gatewayOrderId,
          amount: intent.amount,
          currency: 'INR',
          status: 'failed'
        }
      }
    }
  }, { eventId: 'evt_term_fail_after_cap' });
  assert.equal(failAfterCap.status, 200);
  assert.equal(failAfterCap.json.ignored, true);
  assert.equal(failAfterCap.json.reason, 'invalid_transition');

  // Replaying that same ignored failure event is deduplicated.
  const failReplay = await postWebhook({
    event: 'payment.failed',
    payload: {
      payment: {
        entity: {
          id: 'pay_term_fail_1',
          order_id: intent.gatewayOrderId,
          amount: intent.amount,
          currency: 'INR',
          status: 'failed'
        }
      }
    }
  }, { eventId: 'evt_term_fail_after_cap' });
  assert.equal(failReplay.status, 200);
  assert.equal(failReplay.json.duplicate, true);

  // Delayed payment.authorized arrives AFTER capture — must NOT downgrade paid -> pending.
  const authAfterCap = await postWebhook({
    event: 'payment.authorized',
    payload: {
      payment: {
        entity: {
          id: 'pay_term_auth_1',
          order_id: intent.gatewayOrderId,
          amount: intent.amount,
          currency: 'INR',
          status: 'authorized'
        }
      }
    }
  }, { eventId: 'evt_term_auth_after_cap' });
  assert.equal(authAfterCap.status, 200);
  assert.equal(authAfterCap.json.ignored, true);
  assert.equal(authAfterCap.json.reason, 'invalid_transition');

  const detail = must(await get(S.customer, `/api/customer/orders/${encodeURIComponent(order.code)}`), 200, 'order after delayed events');
  assert.equal(detail.order.paymentStatus, 'paid', 'parent order stays paid');
  assert.equal(detail.order.payments[0].status, 'paid', 'payment record stays paid and is never downgraded');

  const notifs = await paymentNotificationsFor(order.code);
  assert.equal(notifs.length, 1, 'no failure notification should be sent after capture');
  assert.match(notifs[0].title, /Payment successful/i);

  // Also verify payment.authorized arriving AFTER payment.failed cannot resurrect a failed record.
  const { order: order2, intent: intent2 } = await placeOrderWithIntent();
  const fail2 = await postWebhook({
    event: 'payment.failed',
    payload: {
      payment: {
        entity: {
          id: 'pay_fail_only_1',
          order_id: intent2.gatewayOrderId,
          amount: intent2.amount,
          currency: 'INR',
          status: 'failed'
        }
      }
    }
  }, { eventId: 'evt_fail_only_1' });
  assert.equal(fail2.status, 200);

  const authAfterFail = await postWebhook({
    event: 'payment.authorized',
    payload: {
      payment: {
        entity: {
          id: 'pay_fail_only_auth',
          order_id: intent2.gatewayOrderId,
          amount: intent2.amount,
          currency: 'INR',
          status: 'authorized'
        }
      }
    }
  }, { eventId: 'evt_auth_after_fail' });
  assert.equal(authAfterFail.status, 200);
  assert.equal(authAfterFail.json.ignored, true);
  assert.equal(authAfterFail.json.reason, 'invalid_transition');

  const detail2 = must(await get(S.customer, `/api/customer/orders/${encodeURIComponent(order2.code)}`), 200, 'failed order');
  assert.equal(detail2.order.payments[0].status, 'failed', 'delayed authorized event must not resurrect a failed record');
});

/* ------------------------------------------------------------------ */
/* 3 · unrelated gateway events                                        */
/* ------------------------------------------------------------------ */

test('unrelated gateway events are ignored even when carrying payment entities', async () => {
  const { order, intent } = await placeOrderWithIntent();

  // Unrelated events before capture must NOT mark the unpaid order as paid or alter status.
  const unrelatedBefore = [
    {
      event: 'refund.created',
      payload: {
        payment: {
          entity: { id: 'pay_unrel_1', order_id: intent.gatewayOrderId, amount: intent.amount, currency: 'INR', status: 'captured' }
        },
        refund: { entity: { id: 'rfnd_1', payment_id: 'pay_unrel_1', amount: intent.amount } }
      }
    },
    {
      event: 'payment.dispute.created',
      payload: {
        payment: {
          entity: { id: 'pay_unrel_2', order_id: intent.gatewayOrderId, amount: intent.amount, currency: 'INR', status: 'captured' }
        }
      }
    },
    {
      event: 'order.paid',
      payload: {
        payment: {
          entity: { id: 'pay_unrel_3', order_id: intent.gatewayOrderId, amount: intent.amount, currency: 'INR', status: 'captured' }
        }
      }
    },
    {
      event: 'settlement.processed',
      payload: { settlement: { entity: { id: 'setl_1', amount: intent.amount } } }
    },
    {
      // Missing event name with payment.status = 'captured' must still be ignored.
      payload: {
        payment: {
          entity: { id: 'pay_unrel_4', order_id: intent.gatewayOrderId, amount: intent.amount, currency: 'INR', status: 'captured' }
        }
      }
    }
  ];

  for (const body of unrelatedBefore) {
    const res = await postWebhook(body);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.ignored, true);
    assert.equal(res.json.reason, 'unsupported_event');
  }

  const stillPending = must(await get(S.customer, `/api/customer/orders/${encodeURIComponent(order.code)}`), 200, 'order still pending');
  assert.equal(stillPending.order.paymentStatus, 'pending', 'unrelated events must not mark order paid');
  assert.equal(stillPending.order.payments[0].status, 'created', 'unrelated events must not mutate payment record');
  assert.equal((await paymentNotificationsFor(order.code)).length, 0);

  // Capture legitimately.
  const cap = await postWebhook({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: { id: 'pay_real_cap', order_id: intent.gatewayOrderId, amount: intent.amount, currency: 'INR', status: 'captured' }
      }
    }
  }, { eventId: 'evt_unrel_real_cap' });
  assert.equal(cap.status, 200);

  // Unrelated refund.processed (where payment.entity.status is 'refunded') must NOT downgrade 'paid' -> 'pending'!
  const refundProcessed = await postWebhook({
    event: 'refund.processed',
    payload: {
      payment: {
        entity: { id: 'pay_real_cap', order_id: intent.gatewayOrderId, amount: intent.amount, currency: 'INR', status: 'refunded' }
      },
      refund: { entity: { id: 'rfnd_2', payment_id: 'pay_real_cap', amount: intent.amount } }
    }
  }, { eventId: 'evt_refund_processed' });
  assert.equal(refundProcessed.status, 200);
  assert.equal(refundProcessed.json.ignored, true);
  assert.equal(refundProcessed.json.reason, 'unsupported_event');

  const stillPaid = must(await get(S.customer, `/api/customer/orders/${encodeURIComponent(order.code)}`), 200, 'order stays paid');
  assert.equal(stillPaid.order.paymentStatus, 'paid');
  assert.equal(stillPaid.order.payments[0].status, 'paid', 'refund.processed must not downgrade payment record to pending');
  assert.equal((await paymentNotificationsFor(order.code)).length, 1);
});

/* ------------------------------------------------------------------ */
/* 4 · mismatched amount, mismatched currency & payload integrity      */
/* ------------------------------------------------------------------ */

test('mismatched amounts, currencies and contradictory statuses are rejected without mutating state', async () => {
  const { order, intent } = await placeOrderWithIntent();

  const invalidCases = [
    { label: 'underpayment', entity: { id: 'pay_bad_1', order_id: intent.gatewayOrderId, amount: intent.amount - 100, currency: 'INR', status: 'captured' }, code: 'amount_mismatch' },
    { label: 'overpayment', entity: { id: 'pay_bad_2', order_id: intent.gatewayOrderId, amount: intent.amount + 100, currency: 'INR', status: 'captured' }, code: 'amount_mismatch' },
    { label: 'zero amount', entity: { id: 'pay_bad_3', order_id: intent.gatewayOrderId, amount: 0, currency: 'INR', status: 'captured' }, code: 'amount_mismatch' },
    { label: 'negative amount', entity: { id: 'pay_bad_4', order_id: intent.gatewayOrderId, amount: -intent.amount, currency: 'INR', status: 'captured' }, code: 'amount_mismatch' },
    { label: 'fractional amount', entity: { id: 'pay_bad_5', order_id: intent.gatewayOrderId, amount: intent.amount + 0.5, currency: 'INR', status: 'captured' }, code: 'amount_mismatch' },
    { label: 'string amount', entity: { id: 'pay_bad_6', order_id: intent.gatewayOrderId, amount: String(intent.amount), currency: 'INR', status: 'captured' }, code: 'amount_mismatch' },
    { label: 'missing amount', entity: { id: 'pay_bad_7', order_id: intent.gatewayOrderId, currency: 'INR', status: 'captured' }, code: 'amount_mismatch' },
    { label: 'wrong currency USD', entity: { id: 'pay_bad_8', order_id: intent.gatewayOrderId, amount: intent.amount, currency: 'USD', status: 'captured' }, code: 'currency_mismatch' },
    { label: 'missing currency', entity: { id: 'pay_bad_9', order_id: intent.gatewayOrderId, amount: intent.amount, status: 'captured' }, code: 'currency_mismatch' },
    { label: 'contradictory status', entity: { id: 'pay_bad_10', order_id: intent.gatewayOrderId, amount: intent.amount, currency: 'INR', status: 'failed' }, code: 'status_mismatch' }
  ];

  for (const c of invalidCases) {
    const res = await postWebhook({ event: 'payment.captured', payload: { payment: { entity: c.entity } } });
    assert.equal(res.status, 400, `${c.label}: expected 400, got ${res.status} (${res.text})`);
    assert.equal(res.json.code, c.code, `${c.label}: expected error code ${c.code}`);
  }

  // Order and payment record must still be untouched after all rejected webhooks.
  const untouched = must(await get(S.customer, `/api/customer/orders/${encodeURIComponent(order.code)}`), 200, 'untouched order');
  assert.equal(untouched.order.paymentStatus, 'pending');
  assert.equal(untouched.order.payments[0].status, 'created');
  assert.equal((await paymentNotificationsFor(order.code)).length, 0);

  // Rejections were audited without blocking a subsequent valid capture.
  const rejectedAudits = queryDb("SELECT action FROM nb_audit_logs WHERE entity='order' AND entity_id=? AND action='payment_webhook_rejected'", order.id);
  assert.equal(rejectedAudits.length, invalidCases.length);

  // A subsequent valid payment.captured with matching amount and INR succeeds cleanly.
  const validCapture = await postWebhook({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: { id: 'pay_valid_after_bad', order_id: intent.gatewayOrderId, amount: intent.amount, currency: 'INR', status: 'captured' }
      }
    }
  }, { eventId: 'evt_valid_after_bad' });
  assert.equal(validCapture.status, 200);
  assert.deepEqual(validCapture.json, { ok: true });

  const paid = must(await get(S.customer, `/api/customer/orders/${encodeURIComponent(order.code)}`), 200, 'validly paid order');
  assert.equal(paid.order.paymentStatus, 'paid');
  assert.equal(paid.order.payments[0].status, 'paid');
});

/* ------------------------------------------------------------------ */
/* 5 · signature, malformed JSON & unknown reference guards            */
/* ------------------------------------------------------------------ */

test('invalid signature, malformed JSON, and unknown payment references are handled safely', async () => {
  const { order, intent } = await placeOrderWithIntent();

  const badSig = await postWebhook({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: { id: 'pay_badsig', order_id: intent.gatewayOrderId, amount: intent.amount, currency: 'INR', status: 'captured' }
      }
    }
  }, { signature: 'deadbeef'.repeat(8) });
  assert.equal(badSig.status, 401);

  const badJson = await postRawWebhook('{not-valid-json');
  assert.equal(badJson.status, 400);

  const unknownRef = await postWebhook({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: { id: 'pay_unknown', order_id: 'order_does_not_exist', amount: 10000, currency: 'INR', status: 'captured' }
      }
    }
  }, { eventId: 'evt_unknown_ref' });
  assert.equal(unknownRef.status, 200);
  assert.equal(unknownRef.json.ignored, true);
  assert.equal(unknownRef.json.reason, 'unknown_reference');

  const stillPending = must(await get(S.customer, `/api/customer/orders/${encodeURIComponent(order.code)}`), 200, 'unaffected order');
  assert.equal(stillPending.order.paymentStatus, 'pending');
  assert.equal(stillPending.order.payments[0].status, 'created');
});
