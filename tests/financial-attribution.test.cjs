'use strict';
/*
 * NearBuy — cross-shop financial attribution regression tests.
 *
 * Run with:
 *   node --test tests/financial-attribution.test.cjs      (or `npm test`)
 *
 * Verifies that payments and refunds on multi-shop parent orders are allocated
 * and attributed strictly to the owning seller order across:
 *   1. Seller revenue dashboard & transaction list (/seller/revenue)
 *   2. Seller overview & analytics (/seller/overview, /seller/analytics)
 *   3. Seller settlement generation, detail & CSV (/seller/settlements/*)
 *   4. Seller CSV reports (/seller/reports/payments.csv, refunds.csv, settlements.csv)
 *   5. Return refunds, post-payment cancellations, mid-flight cancellations,
 *      COD partial rejections, retried/failed payments, duplicate captures,
 *      and deterministic largest-remainder paise allocation.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nearbuy-finattr-'));
const DB_PATH = path.join(DATA_DIR, 'finattr.sqlite');
const WEBHOOK_SECRET = 'whsec_test_finattr_secret_777';
const KEY_ID = 'rzp_test_finattr';
const KEY_SECRET = 'rzp_secret_finattr';

let PORT = 0;
let BASE = '';
let server;
let gateway;

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

function startMockRazorpay() {
  return new Promise((resolve, reject) => {
    let seq = 0;
    const calls = [];
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
        if (req.method === 'POST' && req.url === '/v1/orders') {
          seq += 1;
          const id = `order_fin_${seq}_${Date.now()}`;
          calls.push({ id, body });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id,
            entity: 'order',
            amount: body.amount,
            currency: body.currency || 'INR',
            receipt: body.receipt,
            status: 'created'
          }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { description: 'Not found' } }));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise((r) => srv.close(() => r()))
      });
    });
    srv.on('error', reject);
  });
}

function client() {
  const cookies = new Map();
  let csrf = '';
  const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  async function req(urlPath, { method, body } = {}) {
    const m = method || (body !== undefined ? 'POST' : 'GET');
    const headers = { 'X-NearBuy-Request': '1', Origin: BASE };
    if (cookies.size) headers.Cookie = cookieHeader();
    if (csrf && m !== 'GET') headers['X-NearBuy-CSRF'] = csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${urlPath}`, {
      method: m,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) {
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        if (v) cookies.set(k, v); else cookies.delete(k);
      }
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* CSV or HTML */ }
    if (json?.user?.csrf) csrf = json.user.csrf;
    return { status: res.status, json, text, headers: res.headers };
  }

  return { req };
}

function must(res, expected, label) {
  assert.equal(res.status, expected, `${label}: expected ${expected}, got ${res.status} — ${res.text?.slice(0, 300)}`);
  return res.json;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return lines.map((line) => {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === ',') {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  });
}

async function waitForServer(timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/api/customer/home`);
      if (r.ok) { await r.body?.cancel(); return; }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`NearBuy server did not come up on ${BASE}`);
}

async function postWebhook(bodyObj, { eventId } = {}) {
  const raw = JSON.stringify(bodyObj);
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  const headers = {
    'Content-Type': 'application/json',
    'x-razorpay-signature': sig
  };
  if (eventId) headers['x-razorpay-event-id'] = eventId;
  const res = await fetch(`${BASE}/api/customer/payments/webhook`, {
    method: 'POST',
    headers,
    body: raw
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text };
}

function runDb(script, ...args) {
  const out = execFileSync(process.execPath, ['-e', script, DB_PATH, ...args], {
    cwd: ROOT,
    env: { ...process.env, NEARBUY_DB: DB_PATH },
    encoding: 'utf8'
  });
  return out ? JSON.parse(out) : null;
}

const S = {};

async function registerAndApproveSeller({ name, mobile, email, password, businessName, pan, commissionRate }) {
  const guest = client();
  must(await guest.req('/api/customer/seller/register', {
    body: { name, mobile, email, password, confirmPassword: password, businessName, category: 'groceries', terms: true }
  }), 201, `register ${businessName}`);
  must(await guest.req('/api/customer/seller/kyc', {
    body: {
      email, password, legalName: `${businessName} Pvt Ltd`,
      address: '10 Hauz Khas Market', city: 'Delhi', state: 'Delhi', pincode: '110016', pan,
      lat: 28.552, lng: 77.195,
      documents: [{ type: 'pan', fileName: 'pan.pdf', fileType: 'application/pdf', fileSize: 20480 }]
    }
  }), 201, `kyc ${businessName}`);

  const apps = must(await S.admin.req('/api/admin/seller-applications'), 200, 'applications');
  const app = apps.applications.find((a) => a.owner.email === email);
  assert.ok(app, `application for ${email}`);
  must(await S.admin.req(`/api/admin/seller-applications/${app.id}`, {
    method: 'PATCH',
    body: { status: 'approved' }
  }), 200, `approve ${businessName}`);

  const seller = client();
  must(await seller.req('/api/partner/login', { body: { email, password } }), 200, `login ${businessName}`);
  const me = must(await seller.req('/api/partner/me'), 200, `me ${businessName}`);

  // Configure exact zero fees / min order and known commission rate for crystal-clear paise assertions.
  runDb(`
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.prepare('UPDATE nb_shops SET commission_rate=?, delivery_fee_paise=0, pickup_fee_paise=0, min_order_paise=0, pickup_enabled=1, delivery_enabled=1 WHERE id=?')
      .run(Number(process.argv[3]), process.argv[2]);
    process.stdout.write('true');
  `, me.shop.id, String(commissionRate));

  return { seller, shopId: me.shop.id, shopName: me.shop.name };
}

async function placeTwoShopOrder(customer, items, { paymentMethod = 'online', fulfillment } = {}) {
  await customer.req('/api/customer/cart', { method: 'DELETE' });
  for (const it of items) {
    must(await customer.req('/api/customer/cart/items', { body: { productId: it.productId, qty: it.qty } }), 200, 'add cart item');
  }
  const res = must(await customer.req('/api/customer/orders', {
    body: {
      addressId: S.addressId,
      paymentMethod,
      fulfillment: fulfillment || { [S.alpha.shopId]: 'pickup', [S.beta.shopId]: 'pickup' },
      idempotencyKey: `finattr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    }
  }), 201, 'place two-shop order');
  return res.order;
}

async function completePickupSellerOrder(sellerClient, customerClient, parentOrderCode, sellerOrderCode) {
  must(await sellerClient.req(`/api/partner/seller/orders/${encodeURIComponent(sellerOrderCode)}/action`, {
    body: { action: 'accept' }
  }), 200, `accept ${sellerOrderCode}`);
  must(await sellerClient.req(`/api/partner/seller/orders/${encodeURIComponent(sellerOrderCode)}/action`, {
    body: { action: 'prepare' }
  }), 200, `prepare ${sellerOrderCode}`);

  const packState = must(await sellerClient.req(`/api/partner/seller/orders/${encodeURIComponent(sellerOrderCode)}/packing`), 200, `packing ${sellerOrderCode}`);
  for (const item of packState.items) {
    must(await sellerClient.req(`/api/partner/seller/orders/${encodeURIComponent(sellerOrderCode)}/packing`, {
      body: { orderItemId: item.orderItemId, packedQty: item.orderedQty, missingQty: 0, status: 'packed' }
    }), 200, `pack item ${item.orderItemId}`);
  }
  must(await sellerClient.req(`/api/partner/seller/orders/${encodeURIComponent(sellerOrderCode)}/action`, {
    body: { action: 'ready' }
  }), 200, `ready ${sellerOrderCode}`);

  const detail = must(await customerClient.req(`/api/customer/orders/${encodeURIComponent(parentOrderCode)}`), 200, `order detail ${parentOrderCode}`);
  const so = detail.order.sellerOrders.find((x) => x.code === sellerOrderCode);
  assert.ok(so && so.pickupCode, `pickupCode for ${sellerOrderCode}`);

  must(await sellerClient.req(`/api/partner/seller/orders/${encodeURIComponent(sellerOrderCode)}/action`, {
    body: { action: 'complete_pickup', otp: String(so.pickupCode) }
  }), 200, `complete pickup ${sellerOrderCode}`);
}

before(async () => {
  PORT = await getFreePort();
  BASE = `http://127.0.0.1:${PORT}`;
  gateway = await startMockRazorpay();
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'development',
      NEARBUY_DB: DB_PATH,
      RAZORPAY_KEY_ID: KEY_ID,
      RAZORPAY_KEY_SECRET: KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      RAZORPAY_API_BASE: gateway.url
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForServer();

  // Admin login
  S.admin = client();
  must(await S.admin.req('/api/admin/login', {
    body: { email: 'admin@nearbuy.demo', password: 'Admin123!' }
  }), 200, 'admin login');

  // Create two isolated brand-new shops: Shop Alpha (10% commission) and Shop Beta (5% commission).
  S.alpha = await registerAndApproveSeller({
    name: 'Asha Alpha', mobile: '9811001101', email: 'alpha@finattr.test', password: 'Seller123!',
    businessName: 'Alpha Provision Store', pan: 'AAAPA1111A', commissionRate: 10
  });
  S.beta = await registerAndApproveSeller({
    name: 'Bala Beta', mobile: '9811001102', email: 'beta@finattr.test', password: 'Seller123!',
    businessName: 'Beta Fresh Mart', pan: 'AAAPB2222B', commissionRate: 5
  });

  // Create zero-tax, returnable products so ₹600 + ₹400 = ₹1,000 splits cleanly.
  S.prodA1 = must(await S.alpha.seller.req('/api/partner/seller/products', {
    body: { name: 'Alpha Olive Oil 500ml', category: 'groceries', price: 20000, stock: 50, taxRate: 0, returnDays: 7, unit: '500 ml' }
  }), 201, 'create prodA1').productId;
  S.prodA2 = must(await S.alpha.seller.req('/api/partner/seller/products', {
    body: { name: 'Alpha Basmati Rice 5kg', category: 'groceries', price: 40000, stock: 50, taxRate: 0, returnDays: 7, unit: '5 kg' }
  }), 201, 'create prodA2').productId;
  S.prodB1 = must(await S.beta.seller.req('/api/partner/seller/products', {
    body: { name: 'Beta Raw Honey 1kg', category: 'groceries', price: 40000, stock: 50, taxRate: 0, returnDays: 7, unit: '1 kg' }
  }), 201, 'create prodB1').productId;

  // Register a real (non-demo) customer with a serviceable Hauz Khas address.
  S.customer = client();
  const reg = must(await S.customer.req('/api/customer/auth/register', {
    body: {
      name: 'Riya Shopper',
      email: 'riya@finattr.test',
      phone: '9811001199',
      password: 'Password123!',
      confirmPassword: 'Password123!',
      terms: true
    }
  }), 201, 'register customer');
  if (reg.devCodes?.email) {
    must(await S.customer.req('/api/customer/auth/verify', {
      body: { channel: 'email', code: reg.devCodes.email }
    }), 200, 'verify customer email');
  }
  runDb(`
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.prepare('UPDATE nb_users SET is_demo=0 WHERE email=?').run(process.argv[2]);
    process.stdout.write('true');
  `, 'riya@finattr.test');

  const addr = must(await S.customer.req('/api/customer/addresses', {
    body: {
      label: 'Home', receiver: 'Riya Shopper', phone: '9811001199',
      line1: 'A-42 Hauz Khas', locality: 'Hauz Khas', city: 'New Delhi',
      pincode: '110016', lat: 28.552, lng: 77.195, isDefault: true
    }
  }), 201, 'customer address');
  S.addressId = addr.address.id;
});

after(async () => {
  if (server && !server.killed) server.kill('SIGTERM');
  if (gateway) await gateway.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 1 · Two-shop ₹1,000 order split ₹600/₹400 — ONLY Shop A refunds    */
/* ------------------------------------------------------------------ */

test('two-shop basket (₹600 / ₹400) allocates payments per shop and isolates a single-shop refund across revenue, overview, analytics, settlements and CSV reports', async () => {
  // Basket: Shop Alpha = ₹200 + ₹400 = ₹600 (60000p), Shop Beta = ₹400 (40000p) -> Parent = ₹1,000 (100000p).
  const order = await placeTwoShopOrder(S.customer, [
    { productId: S.prodA1, qty: 1 },
    { productId: S.prodA2, qty: 1 },
    { productId: S.prodB1, qty: 1 }
  ], { paymentMethod: 'online' });

  assert.equal(order.total, 100000, 'parent order total is ₹1,000');
  const soAlpha = order.sellerOrders.find((so) => so.shop.id === S.alpha.shopId);
  const soBeta = order.sellerOrders.find((so) => so.shop.id === S.beta.shopId);
  assert.equal(soAlpha.total, 60000, 'Shop Alpha seller order is ₹600');
  assert.equal(soBeta.total, 40000, 'Shop Beta seller order is ₹400');

  // Even while payment is pending, each seller's revenue summary sees only its own share (not ₹1,000).
  const revAlphaPending = must(await S.alpha.seller.req('/api/partner/seller/revenue'), 200, 'alpha pending revenue');
  const revBetaPending = must(await S.beta.seller.req('/api/partner/seller/revenue'), 200, 'beta pending revenue');
  assert.equal(revAlphaPending.dashboard.pending, 60000, 'Shop Alpha pending is ₹600, not ₹1,000');
  assert.equal(revAlphaPending.dashboard.successful, 0);
  assert.equal(revBetaPending.dashboard.pending, 40000, 'Shop Beta pending is ₹400, not ₹1,000');
  assert.equal(revBetaPending.dashboard.successful, 0);

  // Start online payment for ₹1,000 and capture it via webhook.
  const intent = must(await S.customer.req('/api/customer/payments/intent', {
    body: { orderCode: order.code }
  }), 201, 'online payment intent');
  assert.equal(intent.amount, 100000);

  const cap = await postWebhook({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: { id: 'pay_two_shop_1', order_id: intent.gatewayOrderId, amount: 100000, currency: 'INR', status: 'captured' }
      }
    }
  }, { eventId: 'evt_two_shop_cap_1' });
  assert.equal(cap.status, 200);

  // Immediately after capture: Shop Alpha = ₹600 collected (10% comm = ₹60), Shop Beta = ₹400 collected (5% comm = ₹20).
  const revAlphaPaid = must(await S.alpha.seller.req('/api/partner/seller/revenue'), 200, 'alpha paid revenue');
  const revBetaPaid = must(await S.beta.seller.req('/api/partner/seller/revenue'), 200, 'beta paid revenue');
  assert.equal(revAlphaPaid.dashboard.successful, 60000, 'Shop Alpha collected ₹600, not ₹1,000');
  assert.equal(revAlphaPaid.dashboard.commission, 6000);
  assert.equal(revAlphaPaid.dashboard.payableBalance, 54000);
  assert.equal(revBetaPaid.dashboard.successful, 40000, 'Shop Beta collected ₹400, not ₹1,000');
  assert.equal(revBetaPaid.dashboard.commission, 2000);
  assert.equal(revBetaPaid.dashboard.payableBalance, 38000);

  // Complete both seller orders so both are eligible for returns and settlement.
  await completePickupSellerOrder(S.alpha.seller, S.customer, order.code, soAlpha.code);
  await completePickupSellerOrder(S.beta.seller, S.customer, order.code, soBeta.code);

  // Customer returns ONLY the ₹200 Olive Oil from Shop Alpha. Shop Beta has NO return or refund!
  const itemA1 = soAlpha.items.find((i) => i.productId === S.prodA1);
  const ret = must(await S.customer.req(`/api/customer/orders/${encodeURIComponent(order.code)}/returns`, {
    body: { sellerOrderId: soAlpha.id, itemId: itemA1.id, reason: 'Seal damaged on pickup' }
  }), 201, 'request return on Shop Alpha');

  // Shop Alpha approves and completes the return (which completes its ₹200 refund).
  must(await S.alpha.seller.req(`/api/partner/seller/returns/${encodeURIComponent(ret.return.code)}/action`, {
    body: { action: 'approve', note: 'Approved at counter' }
  }), 200, 'alpha approve return');
  must(await S.alpha.seller.req(`/api/partner/seller/returns/${encodeURIComponent(ret.return.code)}/action`, {
    body: { action: 'complete', note: 'Refund completed' }
  }), 200, 'alpha complete return');

  // ---- Verify Shop Alpha (refunding shop): ₹600 gross, ₹200 refund, ₹60 commission, ₹340 net ----
  const alphaOverview = must(await S.alpha.seller.req('/api/partner/seller/overview'), 200, 'alpha overview');
  assert.equal(alphaOverview.revenue, 60000);
  assert.equal(alphaOverview.grossSales, 60000);
  assert.equal(alphaOverview.refunds, 20000);
  assert.equal(alphaOverview.netSales, 40000);

  const alphaAnalytics = must(await S.alpha.seller.req('/api/partner/seller/analytics?range=30d'), 200, 'alpha analytics');
  assert.equal(alphaAnalytics.metrics.grossSales, 60000);
  assert.equal(alphaAnalytics.metrics.refunds, 20000);
  assert.equal(alphaAnalytics.metrics.netSales, 40000);

  const alphaRevenue = must(await S.alpha.seller.req('/api/partner/seller/revenue'), 200, 'alpha revenue after refund');
  assert.equal(alphaRevenue.dashboard.successful, 60000);
  assert.equal(alphaRevenue.dashboard.refunds, 20000);
  assert.equal(alphaRevenue.dashboard.commission, 6000);
  assert.equal(alphaRevenue.dashboard.payableBalance, 34000);
  assert.equal(alphaRevenue.transactions.length, 1);
  assert.equal(alphaRevenue.transactions[0].sellerOrderCode, soAlpha.code);
  assert.equal(alphaRevenue.transactions[0].gross, 60000);
  assert.equal(alphaRevenue.transactions[0].refund, 20000);
  assert.equal(alphaRevenue.transactions[0].commission, 6000);
  assert.equal(alphaRevenue.transactions[0].netPayable, 34000);

  const alphaSettleGen = must(await S.alpha.seller.req('/api/partner/seller/settlements/generate', {
    body: { periodStart: '2020-01-01', periodEnd: '2030-01-01' }
  }), 201, 'alpha generate settlement');
  const alphaSettle = must(await S.alpha.seller.req(`/api/partner/seller/settlements/${encodeURIComponent(alphaSettleGen.code)}`), 200, 'alpha settlement detail');
  assert.equal(alphaSettle.settlement.gross, 60000);
  assert.equal(alphaSettle.settlement.refunds, 20000);
  assert.equal(alphaSettle.settlement.commission, 6000);
  assert.equal(alphaSettle.settlement.net, 34000);
  assert.equal(alphaSettle.items.length, 1);
  assert.equal(alphaSettle.items[0].orderCode, soAlpha.code);
  assert.equal(alphaSettle.items[0].gross, 60000);
  assert.equal(alphaSettle.items[0].refund, 20000);
  assert.equal(alphaSettle.items[0].net, 34000);

  const alphaPayCsv = parseCsv((await S.alpha.seller.req('/api/partner/seller/reports/payments.csv')).text);
  assert.equal(alphaPayCsv.length, 2, 'alpha payments.csv has header + 1 row');
  assert.equal(alphaPayCsv[1][2], soAlpha.code);
  assert.equal(alphaPayCsv[1][4], '600.00', 'alpha payments.csv reports ₹600.00 share, not ₹1,000.00');

  const alphaRefCsv = parseCsv((await S.alpha.seller.req('/api/partner/seller/reports/refunds.csv')).text);
  assert.equal(alphaRefCsv.length, 2, 'alpha refunds.csv has header + 1 refund');
  assert.equal(alphaRefCsv[1][2], soAlpha.code);
  assert.equal(alphaRefCsv[1][3], '200.00');

  const alphaStlCsv = parseCsv((await S.alpha.seller.req('/api/partner/seller/reports/settlements.csv')).text);
  assert.equal(alphaStlCsv.length, 2);
  assert.equal(alphaStlCsv[1][2], '600.00');
  assert.equal(alphaStlCsv[1][3], '200.00');
  assert.equal(alphaStlCsv[1][4], '60.00');
  assert.equal(alphaStlCsv[1][5], '340.00');

  // ---- Verify Shop Beta (non-refunding shop): ₹400 gross, ₹0 refund, ₹20 commission, ₹380 net ----
  const betaOverview = must(await S.beta.seller.req('/api/partner/seller/overview'), 200, 'beta overview');
  assert.equal(betaOverview.revenue, 40000);
  assert.equal(betaOverview.grossSales, 40000);
  assert.equal(betaOverview.refunds, 0, 'Shop Alpha refund must NOT appear in Shop Beta overview');
  assert.equal(betaOverview.netSales, 40000);

  const betaAnalytics = must(await S.beta.seller.req('/api/partner/seller/analytics?range=30d'), 200, 'beta analytics');
  assert.equal(betaAnalytics.metrics.grossSales, 40000);
  assert.equal(betaAnalytics.metrics.refunds, 0, 'Shop Alpha refund must NOT appear in Shop Beta analytics');
  assert.equal(betaAnalytics.metrics.netSales, 40000);

  const betaRevenue = must(await S.beta.seller.req('/api/partner/seller/revenue'), 200, 'beta revenue after alpha refund');
  assert.equal(betaRevenue.dashboard.successful, 40000, 'Shop Beta collected ₹400, not ₹1,000');
  assert.equal(betaRevenue.dashboard.refunds, 0, 'Shop Alpha refund must NOT reduce Shop Beta revenue');
  assert.equal(betaRevenue.dashboard.commission, 2000);
  assert.equal(betaRevenue.dashboard.payableBalance, 38000);
  assert.equal(betaRevenue.transactions.length, 1);
  assert.equal(betaRevenue.transactions[0].sellerOrderCode, soBeta.code);
  assert.equal(betaRevenue.transactions[0].gross, 40000);
  assert.equal(betaRevenue.transactions[0].refund, 0, 'Shop Beta transaction row must show ₹0 refund');
  assert.equal(betaRevenue.transactions[0].commission, 2000);
  assert.equal(betaRevenue.transactions[0].netPayable, 38000);

  const betaSettleGen = must(await S.beta.seller.req('/api/partner/seller/settlements/generate', {
    body: { periodStart: '2020-01-01', periodEnd: '2030-01-01' }
  }), 201, 'beta generate settlement');
  const betaSettle = must(await S.beta.seller.req(`/api/partner/seller/settlements/${encodeURIComponent(betaSettleGen.code)}`), 200, 'beta settlement detail');
  assert.equal(betaSettle.settlement.gross, 40000);
  assert.equal(betaSettle.settlement.refunds, 0, 'Shop Alpha refund must NOT deduct from Shop Beta settlement');
  assert.equal(betaSettle.settlement.commission, 2000);
  assert.equal(betaSettle.settlement.net, 38000);
  assert.equal(betaSettle.items.length, 1);
  assert.equal(betaSettle.items[0].orderCode, soBeta.code);
  assert.equal(betaSettle.items[0].refund, 0);
  assert.equal(betaSettle.items[0].net, 38000);

  const betaPayCsv = parseCsv((await S.beta.seller.req('/api/partner/seller/reports/payments.csv')).text);
  assert.equal(betaPayCsv.length, 2, 'beta payments.csv has header + 1 row');
  assert.equal(betaPayCsv[1][2], soBeta.code);
  assert.equal(betaPayCsv[1][4], '400.00', 'beta payments.csv reports ₹400.00 share, not ₹1,000.00');

  const betaRefCsv = parseCsv((await S.beta.seller.req('/api/partner/seller/reports/refunds.csv')).text);
  assert.equal(betaRefCsv.length, 1, 'beta refunds.csv must have header only — zero rows from Shop Alpha');

  const betaStlCsv = parseCsv((await S.beta.seller.req('/api/partner/seller/reports/settlements.csv')).text);
  assert.equal(betaStlCsv.length, 2);
  assert.equal(betaStlCsv[1][2], '400.00');
  assert.equal(betaStlCsv[1][3], '0.00');
  assert.equal(betaStlCsv[1][4], '20.00');
  assert.equal(betaStlCsv[1][5], '380.00');

  // Statement CSVs match too.
  const betaStmtCsv = (await S.beta.seller.req(`/api/partner/seller/settlements/${encodeURIComponent(betaSettleGen.code)}/statement.csv`)).text;
  assert.match(betaStmtCsv, /400\.00,0\.00,20\.00,380\.00/);
});

/* ------------------------------------------------------------------ */
/* 2 · Post-payment & mid-flight single-shop cancellations            */
/* ------------------------------------------------------------------ */

test('single-shop cancellation refunds (post-capture and mid-flight) never deduct from the sibling shop', async () => {
  // Record baselines before this test.
  const betaBefore = must(await S.beta.seller.req('/api/partner/seller/revenue'), 200, 'beta baseline').dashboard;
  const alphaBefore = must(await S.alpha.seller.req('/api/partner/seller/revenue'), 200, 'alpha baseline').dashboard;

  // 2a. Post-capture cancellation of ONLY Shop Alpha on a ₹1,000 (₹600/₹400) paid order.
  const orderPost = await placeTwoShopOrder(S.customer, [
    { productId: S.prodA1, qty: 1 },
    { productId: S.prodA2, qty: 1 },
    { productId: S.prodB1, qty: 1 }
  ], { paymentMethod: 'online' });
  const soAlpha1 = orderPost.sellerOrders.find((so) => so.shop.id === S.alpha.shopId);
  const soBeta1 = orderPost.sellerOrders.find((so) => so.shop.id === S.beta.shopId);

  const intent1 = must(await S.customer.req('/api/customer/payments/intent', {
    body: { orderCode: orderPost.code }
  }), 201, 'intent post-cancel');
  assert.equal((await postWebhook({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_post_cancel_1', order_id: intent1.gatewayOrderId, amount: 100000, currency: 'INR', status: 'captured' } } }
  }, { eventId: 'evt_post_cancel_1' })).status, 200);

  // Customer cancels ONLY Shop Alpha.
  must(await S.customer.req(`/api/customer/orders/${encodeURIComponent(orderPost.code)}/cancel`, {
    body: { sellerOrderId: soAlpha1.code, reason: 'Changed mind on Alpha items' }
  }), 200, 'cancel only alpha');

  // Admin completes that ₹600 refund.
  const adminLedger1 = must(await S.admin.req('/api/admin/returns'), 200, 'admin ledger 1');
  const cancelRefund1 = adminLedger1.refunds.find((r) => r.order_id === orderPost.id);
  assert.ok(cancelRefund1, 'cancellation refund created');
  assert.equal(cancelRefund1.seller_order_id, soAlpha1.id, 'refund is explicitly attributed to Shop Alpha seller order');
  assert.equal(cancelRefund1.amount_paise, 60000);
  must(await S.admin.req(`/api/admin/refunds/${encodeURIComponent(cancelRefund1.id)}/status`, {
    body: { status: 'completed', reference: 'UTR-CANCEL-A1' }
  }), 200, 'complete alpha cancel refund');

  // Shop Beta fulfills its part and generates a settlement.
  await completePickupSellerOrder(S.beta.seller, S.customer, orderPost.code, soBeta1.code);
  const betaStl1Gen = must(await S.beta.seller.req('/api/partner/seller/settlements/generate', {
    body: { periodStart: '2020-01-01', periodEnd: '2030-01-01' }
  }), 201, 'beta settlement after alpha cancel');
  const betaStl1 = must(await S.beta.seller.req(`/api/partner/seller/settlements/${encodeURIComponent(betaStl1Gen.code)}`), 200, 'beta stl1 detail');
  assert.equal(betaStl1.settlement.gross, 40000);
  assert.equal(betaStl1.settlement.refunds, 0, 'Shop Alpha cancellation refund must NOT reduce Shop Beta settlement');
  assert.equal(betaStl1.settlement.net, 38000);

  // 2b. Mid-flight cancellation of ONLY Shop Alpha BEFORE webhook captures ₹1,000.
  const orderMid = await placeTwoShopOrder(S.customer, [
    { productId: S.prodA1, qty: 1 },
    { productId: S.prodA2, qty: 1 },
    { productId: S.prodB1, qty: 1 }
  ], { paymentMethod: 'online' });
  const soAlpha2 = orderMid.sellerOrders.find((so) => so.shop.id === S.alpha.shopId);
  const soBeta2 = orderMid.sellerOrders.find((so) => so.shop.id === S.beta.shopId);

  const intent2 = must(await S.customer.req('/api/customer/payments/intent', {
    body: { orderCode: orderMid.code }
  }), 201, 'intent mid-flight');

  // Cancel Shop Alpha BEFORE capture webhook arrives.
  must(await S.customer.req(`/api/customer/orders/${encodeURIComponent(orderMid.code)}/cancel`, {
    body: { sellerOrderId: soAlpha2.code, reason: 'Cancel Alpha mid-flight' }
  }), 200, 'cancel alpha mid-flight');

  // Webhook captures full ₹1,000 for the already-issued gateway order.
  assert.equal((await postWebhook({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_mid_cancel_2', order_id: intent2.gatewayOrderId, amount: 100000, currency: 'INR', status: 'captured' } } }
  }, { eventId: 'evt_mid_cancel_2' })).status, 200);

  const adminLedger2 = must(await S.admin.req('/api/admin/returns'), 200, 'admin ledger 2');
  const midRefunds = adminLedger2.refunds.filter((r) => r.order_id === orderMid.id);
  assert.equal(midRefunds.length, 1, 'exactly one cancellation refund created');
  assert.equal(midRefunds[0].seller_order_id, soAlpha2.id, 'mid-flight cancellation refund attributed strictly to Shop Alpha');
  assert.equal(midRefunds[0].amount_paise, 60000);
  must(await S.admin.req(`/api/admin/refunds/${encodeURIComponent(midRefunds[0].id)}/status`, {
    body: { status: 'completed', reference: 'UTR-MID-A2' }
  }), 200, 'complete mid-flight refund');

  await completePickupSellerOrder(S.beta.seller, S.customer, orderMid.code, soBeta2.code);
  const betaStl2Gen = must(await S.beta.seller.req('/api/partner/seller/settlements/generate', {
    body: { periodStart: '2020-01-01', periodEnd: '2030-01-01' }
  }), 201, 'beta settlement after mid-flight alpha cancel');
  const betaStl2 = must(await S.beta.seller.req(`/api/partner/seller/settlements/${encodeURIComponent(betaStl2Gen.code)}`), 200, 'beta stl2 detail');
  assert.equal(betaStl2.settlement.gross, 40000);
  assert.equal(betaStl2.settlement.refunds, 0);
  assert.equal(betaStl2.settlement.net, 38000);

  const betaAfter = must(await S.beta.seller.req('/api/partner/seller/revenue'), 200, 'beta after').dashboard;
  const alphaAfter = must(await S.alpha.seller.req('/api/partner/seller/revenue'), 200, 'alpha after').dashboard;
  assert.equal(betaAfter.successful - betaBefore.successful, 80000, 'Shop Beta collected 2 × ₹400');
  assert.equal(betaAfter.refunds - betaBefore.refunds, 0, 'Shop Beta still has ₹0 refunds');
  assert.equal(alphaAfter.successful - alphaBefore.successful, 120000, 'Shop Alpha collected 2 × ₹600');
  assert.equal(alphaAfter.refunds - alphaBefore.refunds, 120000, 'Shop Alpha refunded 2 × ₹600');

  // Shop Beta's refund CSV still contains zero rows!
  const betaRefCsv = parseCsv((await S.beta.seller.req('/api/partner/seller/reports/refunds.csv')).text);
  assert.equal(betaRefCsv.length, 1, 'Shop Beta refunds.csv still has header only');
});

/* ------------------------------------------------------------------ */
/* 3 · Two-shop COD order with partial rejection & active settlement  */
/* ------------------------------------------------------------------ */

test('two-shop COD order allocates pending & collected cash per shop and shrinks on single-shop rejection', async () => {
  const alphaBefore = must(await S.alpha.seller.req('/api/partner/seller/revenue'), 200, 'alpha before cod').dashboard;
  const betaBefore = must(await S.beta.seller.req('/api/partner/seller/revenue'), 200, 'beta before cod').dashboard;

  const order = await placeTwoShopOrder(S.customer, [
    { productId: S.prodA1, qty: 1 },
    { productId: S.prodA2, qty: 1 },
    { productId: S.prodB1, qty: 1 }
  ], { paymentMethod: 'cod' });
  const soAlpha = order.sellerOrders.find((so) => so.shop.id === S.alpha.shopId);
  const soBeta = order.sellerOrders.find((so) => so.shop.id === S.beta.shopId);

  // While pending: COD is split ₹600 / ₹400, never ₹1,000 each.
  const alphaMid = must(await S.alpha.seller.req('/api/partner/seller/revenue'), 200, 'alpha pending cod').dashboard;
  const betaMid = must(await S.beta.seller.req('/api/partner/seller/revenue'), 200, 'beta pending cod').dashboard;
  assert.equal(alphaMid.pending - alphaBefore.pending, 60000);
  assert.equal(alphaMid.cod - alphaBefore.cod, 60000);
  assert.equal(betaMid.pending - betaBefore.pending, 40000);
  assert.equal(betaMid.cod - betaBefore.cod, 40000);

  // Shop Alpha rejects its part while COD is still unpaid -> Shop Alpha's pending/COD drops back to baseline.
  must(await S.alpha.seller.req(`/api/partner/seller/orders/${encodeURIComponent(soAlpha.code)}/action`, {
    body: { action: 'reject', reason: 'Out of stock for pickup' }
  }), 200, 'alpha rejects cod order');

  const alphaRejected = must(await S.alpha.seller.req('/api/partner/seller/revenue'), 200, 'alpha after reject').dashboard;
  assert.equal(alphaRejected.pending, alphaBefore.pending, 'rejected unpaid seller order is removed from Shop Alpha pending');
  assert.equal(alphaRejected.cod, alphaBefore.cod, 'rejected unpaid seller order is removed from Shop Alpha COD');

  // Shop Beta completes its pickup -> only Shop Beta's ₹400 is marked paid!
  await completePickupSellerOrder(S.beta.seller, S.customer, order.code, soBeta.code);

  const alphaFinal = must(await S.alpha.seller.req('/api/partner/seller/revenue'), 200, 'alpha final cod').dashboard;
  const betaFinal = must(await S.beta.seller.req('/api/partner/seller/revenue'), 200, 'beta final cod').dashboard;
  assert.equal(alphaFinal.successful, alphaBefore.successful, 'Shop Alpha receives ₹0 collected for rejected COD order');
  assert.equal(betaFinal.successful - betaBefore.successful, 40000, 'Shop Beta receives its exact ₹400 collected');
  assert.equal(betaFinal.cod - betaBefore.cod, 40000);
  assert.equal(betaFinal.pending, betaBefore.pending);
});

/* ------------------------------------------------------------------ */
/* 4 · Failed/retried payment, duplicate capture & rounding invariant */
/* ------------------------------------------------------------------ */

test('failed retry and duplicate gateway capture never inflate seller revenue or inject bogus refunds, and paise allocation conserves totals', async () => {
  const alphaBefore = must(await S.alpha.seller.req('/api/partner/seller/revenue'), 200, 'alpha baseline 4').dashboard;
  const betaBefore = must(await S.beta.seller.req('/api/partner/seller/revenue'), 200, 'beta baseline 4').dashboard;

  const order = await placeTwoShopOrder(S.customer, [
    { productId: S.prodA1, qty: 1 },
    { productId: S.prodA2, qty: 1 },
    { productId: S.prodB1, qty: 1 }
  ], { paymentMethod: 'online' });

  // Attempt 1 fails -> allocated failed amount is ₹600 for Alpha, ₹400 for Beta (never ₹1,000 each).
  const attempt1 = must(await S.customer.req('/api/customer/payments/intent', {
    body: { orderCode: order.code }
  }), 201, 'attempt 1');
  assert.equal((await postWebhook({
    event: 'payment.failed',
    payload: { payment: { entity: { id: 'pay_fail_retry_1', order_id: attempt1.gatewayOrderId, amount: 100000, currency: 'INR', status: 'failed' } } }
  }, { eventId: 'evt_fail_retry_1' })).status, 200);

  const alphaAfterFail = must(await S.alpha.seller.req('/api/partner/seller/revenue'), 200, 'alpha after fail');
  const betaAfterFail = must(await S.beta.seller.req('/api/partner/seller/revenue'), 200, 'beta after fail');
  assert.equal(alphaAfterFail.dashboard.failed - alphaBefore.failed, 60000, 'Alpha failed is ₹600, not ₹1,000');
  assert.equal(betaAfterFail.dashboard.failed - betaBefore.failed, 40000, 'Beta failed is ₹400, not ₹1,000');
  const failTxAlpha = alphaAfterFail.transactions.find((t) => t.reference === attempt1.gatewayOrderId);
  assert.equal(failTxAlpha.gross, 60000);
  assert.equal(failTxAlpha.commission, 0, 'failed attempt has zero commission');
  assert.equal(failTxAlpha.refund, 0, 'failed attempt has zero refund');
  assert.equal(failTxAlpha.netPayable, 0, 'failed attempt has zero netPayable');

  // Attempt 2 captures -> collected is ₹600 for Alpha, ₹400 for Beta.
  const attempt2 = must(await S.customer.req('/api/customer/payments/intent', {
    body: { orderCode: order.code }
  }), 201, 'attempt 2');
  assert.equal((await postWebhook({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_ok_retry_2', order_id: attempt2.gatewayOrderId, amount: 100000, currency: 'INR', status: 'captured' } } }
  }, { eventId: 'evt_ok_retry_2' })).status, 200);

  // Late duplicate capture arrives for Attempt 1 AFTER Attempt 2 already paid the order ->
  // creates a platform-level duplicate-payment refund (seller_order_id = NULL) and zeroes duplicate allocations
  // so neither shop's revenue is doubled nor reduced by a spurious refund.
  assert.equal((await postWebhook({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_late_dup_1', order_id: attempt1.gatewayOrderId, amount: 100000, currency: 'INR', status: 'captured' } } }
  }, { eventId: 'evt_late_dup_1' })).status, 200);

  const dupLedger = must(await S.admin.req('/api/admin/returns'), 200, 'dup ledger');
  const dupRefund = dupLedger.refunds.find((r) => r.order_id === order.id && r.reason === 'duplicate_payment');
  assert.ok(dupRefund, 'duplicate payment refund recorded for customer');
  assert.equal(dupRefund.seller_order_id, null, 'duplicate gateway refund is not attributed to any seller order');
  must(await S.admin.req(`/api/admin/refunds/${encodeURIComponent(dupRefund.id)}/status`, {
    body: { status: 'completed', reference: 'UTR-DUP-1' }
  }), 200, 'complete duplicate payment refund');

  const alphaAfterDup = must(await S.alpha.seller.req('/api/partner/seller/revenue'), 200, 'alpha after dup').dashboard;
  const betaAfterDup = must(await S.beta.seller.req('/api/partner/seller/revenue'), 200, 'beta after dup').dashboard;
  assert.equal(alphaAfterDup.successful - alphaBefore.successful, 60000, 'Alpha collected stays ₹600 (not doubled to ₹1,200)');
  assert.equal(alphaAfterDup.refunds - alphaBefore.refunds, 0, 'duplicate gateway refund does not deduct from Alpha');
  assert.equal(betaAfterDup.successful - betaBefore.successful, 40000, 'Beta collected stays ₹400 (not doubled to ₹800)');
  assert.equal(betaAfterDup.refunds - betaBefore.refunds, 0, 'duplicate gateway refund does not deduct from Beta');

  // Verify largest-remainder paise conservation directly on non-divisible splits.
  const splits = runDb(`
    const { allocateAmountAcrossSellerOrders } = require('./server/customer/db');
    const a = allocateAmountAcrossSellerOrders(100, [
      { id: 'so1', shop_id: 's1', total_paise: 333, created_at: '2026-01-01T00:00:00Z' },
      { id: 'so2', shop_id: 's2', total_paise: 333, created_at: '2026-01-01T00:00:01Z' },
      { id: 'so3', shop_id: 's3', total_paise: 333, created_at: '2026-01-01T00:00:02Z' }
    ]);
    const b = allocateAmountAcrossSellerOrders(100000, [
      { id: 'soA', shop_id: 'sA', total_paise: 60000, created_at: '2026-01-01T00:00:00Z' },
      { id: 'soB', shop_id: 'sB', total_paise: 40000, created_at: '2026-01-01T00:00:01Z' }
    ]);
    process.stdout.write(JSON.stringify({ a, b }));
  `);
  assert.deepEqual(splits.a.map((x) => x.amountPaise), [34, 33, 33], 'largest-remainder preserves exact 100 paise sum');
  assert.equal(splits.a.reduce((s, x) => s + x.amountPaise, 0), 100);
  assert.deepEqual(splits.b.map((x) => x.amountPaise), [60000, 40000], 'exact ₹600 / ₹400 split');
});

/* ------------------------------------------------------------------ */
/* 5 · Legacy DB migration & startup backfill                         */
/* ------------------------------------------------------------------ */

test('opening a legacy database without nb_payment_allocations or nb_refunds.seller_order_id migrates and backfills cleanly', async () => {
  const legacyDb = path.join(DATA_DIR, 'legacy-upgrade.sqlite');
  const ts = '2026-01-15T10:00:00.000Z';

  // Build a minimal pre-migration schema & multi-shop order + payment + return refund.
  execFileSync(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    const ts = process.argv[2];
    db.exec(\`
      CREATE TABLE nb_users (id TEXT PRIMARY KEY, role TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT, password_hash TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0, phone_verified INTEGER NOT NULL DEFAULT 0, avatar TEXT, status TEXT NOT NULL DEFAULT 'active', is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE nb_categories (slug TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, tone TEXT NOT NULL DEFAULT 'blue', parent_slug TEXT, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE nb_shops (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, owner_user_id TEXT, name TEXT NOT NULL, category_slug TEXT NOT NULL, address TEXT NOT NULL, locality TEXT NOT NULL, city TEXT NOT NULL, pincode TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE nb_orders (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, customer_id TEXT NOT NULL, status TEXT NOT NULL, payment_method TEXT NOT NULL, payment_status TEXT NOT NULL, address_json TEXT NOT NULL, subtotal_paise INTEGER NOT NULL, discount_paise INTEGER NOT NULL DEFAULT 0, delivery_fee_paise INTEGER NOT NULL DEFAULT 0, tax_paise INTEGER NOT NULL DEFAULT 0, total_paise INTEGER NOT NULL, coupon_code TEXT, note TEXT, idempotency_key TEXT UNIQUE, is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE nb_seller_orders (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, order_id TEXT NOT NULL, shop_id TEXT NOT NULL, status TEXT NOT NULL, fulfillment TEXT NOT NULL, subtotal_paise INTEGER NOT NULL, discount_paise INTEGER NOT NULL DEFAULT 0, delivery_fee_paise INTEGER NOT NULL DEFAULT 0, tax_paise INTEGER NOT NULL DEFAULT 0, total_paise INTEGER NOT NULL, prep_minutes INTEGER NOT NULL DEFAULT 15, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE nb_payment_records (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, seller_order_id TEXT, provider TEXT NOT NULL, method TEXT NOT NULL, amount_paise INTEGER NOT NULL, status TEXT NOT NULL, reference TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE nb_returns (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, customer_id TEXT NOT NULL, order_id TEXT NOT NULL, seller_order_id TEXT NOT NULL, item_id TEXT NOT NULL, reason TEXT NOT NULL, comment TEXT, images_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, refund_amount_paise INTEGER NOT NULL DEFAULT 0, decision_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE nb_refunds (id TEXT PRIMARY KEY, return_id TEXT, order_id TEXT NOT NULL, amount_paise INTEGER NOT NULL, status TEXT NOT NULL, reference TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    \`);
    db.prepare("INSERT INTO nb_users VALUES('u1','customer','Legacy Buyer','legacy@test.local',NULL,'hash',1,1,NULL,'active',0,?)").run(ts);
    db.prepare("INSERT INTO nb_categories VALUES('groceries','Groceries','basket','blue',NULL,1,1)").run();
    db.prepare("INSERT INTO nb_shops VALUES('shopA','shop-a',NULL,'Shop A','groceries','Addr','Loc','Delhi','110016',28.5,77.2,?)").run(ts);
    db.prepare("INSERT INTO nb_shops VALUES('shopB','shop-b',NULL,'Shop B','groceries','Addr','Loc','Delhi','110016',28.5,77.2,?)").run(ts);
    db.prepare("INSERT INTO nb_orders VALUES('ord1','NB-LEG-1','u1','completed','online','paid','{}',100000,0,0,0,100000,NULL,NULL,NULL,0,?,?)").run(ts, ts);
    db.prepare("INSERT INTO nb_seller_orders VALUES('soA','ORD-LEG-A','ord1','shopA','completed','pickup',60000,0,0,0,60000,15,?,?)").run(ts, ts);
    db.prepare("INSERT INTO nb_seller_orders VALUES('soB','ORD-LEG-B','ord1','shopB','completed','pickup',40000,0,0,0,40000,15,?,?)").run(ts, ts);
    db.prepare("INSERT INTO nb_payment_records VALUES('pr1','ord1',NULL,'razorpay','online',100000,'paid','rzp_leg_1',?,?)").run(ts, ts);
    db.prepare("INSERT INTO nb_returns VALUES('ret1','RTN-LEG-1','u1','ord1','soA','itemA','Damaged',NULL,'[]','completed',20000,NULL,?,?)").run(ts, ts);
    db.prepare("INSERT INTO nb_refunds VALUES('ref1','ret1','ord1',20000,'completed','UTR-LEG-1',?,?)").run(ts, ts);
  `, legacyDb, ts], { cwd: ROOT });

  // Requiring server/customer/db.js must migrate columns/tables and backfill cleanly without error.
  const migrated = JSON.parse(execFileSync(process.execPath, ['-e', `
    const { db } = require('./server/customer/db');
    const allocs = db.prepare('SELECT seller_order_id, shop_id, amount_paise FROM nb_payment_allocations WHERE payment_record_id=? ORDER BY seller_order_id').all('pr1');
    const refund = db.prepare('SELECT id, seller_order_id, reason, amount_paise FROM nb_refunds WHERE id=?').get('ref1');
    process.stdout.write(JSON.stringify({ allocs, refund }));
  `], { cwd: ROOT, env: { ...process.env, NEARBUY_DB: legacyDb }, encoding: 'utf8' }));

  assert.deepEqual(migrated.allocs, [
    { seller_order_id: 'soA', shop_id: 'shopA', amount_paise: 60000 },
    { seller_order_id: 'soB', shop_id: 'shopB', amount_paise: 40000 }
  ], 'legacy payment record backfilled to exact ₹600 / ₹400 seller-order allocations');
  assert.equal(migrated.refund.seller_order_id, 'soA', 'legacy return refund backfilled with owning seller_order_id');
  assert.equal(migrated.refund.reason, 'return');
});
