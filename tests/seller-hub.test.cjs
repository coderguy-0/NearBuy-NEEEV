/*
 * NearBuy — Seller Hub journey tests (zero dependencies).
 *
 *   node --test tests/*.test.cjs      (or simply `npm test`)
 *
 * Boots the real server on its own spare port against a throwaway SQLite
 * database and walks the full Seller Hub lifecycle from the master prompt:
 * seller registration, KYC submission, admin verification gating, catalogue
 * management, barcode scanner idempotency, packing-gated fulfilment, shared
 * runner assignment with handover PIN and delivery OTP, settlements with
 * payout confirmation, staff permissions, support tickets and reports.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 4212;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nearbuy-sellerhub-'));

let child;

function client() {
  let cookie = '';
  let csrf = '';
  return {
    async req(pathname, { method, body } = {}) {
      const h = { 'X-NearBuy-Request': '1' };
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
      return { status: res.status, json, text };
    }
  };
}

async function must(promise, status, label) {
  const res = await promise;
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} — ${res.text?.slice(0, 260) || ''}`);
  return res.json;
}

before(async () => {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NEARBUY_DB: path.join(DATA_DIR, 'db.sqlite') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const started = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start in time')), 20000);
    child.stdout.on('data', (d) => { if (String(d).includes(`http://localhost:${PORT}`)) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', (d) => { if (String(d).includes('EADDRINUSE')) { clearTimeout(t); reject(new Error('port busy')); } });
  });
  await started;
});

after(async () => {
  if (child) child.kill('SIGTERM');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/* Shared state across journeys */
const S = {};

/* ------------------------------------------------------------------ */
/* 1 · registration + KYC + verification gating                       */
/* ------------------------------------------------------------------ */

test('seller hub — register, submit KYC and stay gated until approval', async () => {
  const guest = client();

  // Duplicate sign-up guards.
  const reg = await guest.req('/api/customer/seller/register', { body: {
    name: 'Meera Bazaar', mobile: '9898001122', email: 'meera@bazaar.test', password: 'Seller123!',
    confirmPassword: 'Seller123!', businessName: 'Meera Daily Bazaar', category: 'groceries', shopType: 'retail', terms: true
  } });
  assert.equal(reg.status, 201, 'registration succeeds');
  assert.match(reg.json.sellerId, /^NB-SELLER-/, 'a seller ID is issued');
  assert.match(reg.json.shopId, /^NB-SHOP-/, 'a shop ID is issued');
  assert.equal((await guest.req('/api/customer/seller/register', { body: {
    name: 'Meera Bazaar', mobile: '9898009999', email: 'meera@bazaar.test', password: 'Seller123!',
    confirmPassword: 'Seller123!', businessName: 'Dupe Shop', category: 'groceries', terms: true
  } })).status, 409, 'the email cannot be reused');

  // Missing documents are refused.
  const noDocs = await guest.req('/api/customer/seller/kyc', { body: { email: 'meera@bazaar.test', password: 'Seller123!', legalName: 'Meera Daily Bazaar', address: '5 Ring Road', city: 'Delhi', pincode: '110016', documents: [] } });
  assert.equal(noDocs.status, 400, 'KYC needs at least one document');

  const kyc = await guest.req('/api/customer/seller/kyc', { body: {
    email: 'meera@bazaar.test', password: 'Seller123!', legalName: 'Meera Daily Bazaar Pvt Ltd',
    address: '5 Ring Road, Hauz Khas', city: 'Delhi', state: 'Delhi', pincode: '110016', pan: 'AAAPM1234K',
    lat: 28.552, lng: 77.195,
    documents: [
      { type: 'pan', fileName: 'pan.pdf', fileType: 'application/pdf', fileSize: 40211 },
      { type: 'address_proof', fileName: 'rent-agreement.jpg', fileType: 'image/jpeg', fileSize: 980223 }
    ]
  } });
  assert.equal(kyc.status, 201, 'KYC is submitted for review');
  assert.equal(kyc.json.status, 'submitted');

  // Signing in already works — but selling stays locked.
  const seller = client();
  const login = await seller.req('/api/partner/login', { body: { email: 'meera@bazaar.test', password: 'Seller123!' } });
  assert.equal(login.status, 200, 'pending sellers can sign in to track verification');
  assert.equal(login.json.user.status, 'pending_verification');
  S.seller = seller;

  for (const locked of ['/api/partner/seller/orders?status=all', '/api/partner/seller/products', '/api/partner/seller/inventory']) {
    const res = await seller.req(locked);
    assert.equal(res.status, 403, `${locked} stays locked before approval`);
    assert.match(res.json.error, /verification/i, 'the refusal names verification');
  }
  for (const open of ['/api/partner/seller/profile', '/api/partner/seller/hours', '/api/partner/seller/notifications', '/api/partner/seller/support/faqs', '/api/partner/seller/settings']) {
    assert.equal((await seller.req(open)).status, 200, `${open} remains available while pending`);
  }

  const ver = await must(seller.req('/api/partner/seller/verification'), 200, 'verification status');
  assert.equal(ver.verification.status, 'submitted');
  assert.equal(ver.documents.length, 2, 'both KYC documents are stored');
});

/* ------------------------------------------------------------------ */
/* 2 · admin approval unlocks selling                                 */
/* ------------------------------------------------------------------ */

test('seller hub — admin approval activates the shop and issues codes', async () => {
  const admin = client();
  await must(admin.req('/api/admin/login', { body: { email: 'admin@nearbuy.demo', password: 'Admin123!' } }), 200, 'admin login');
  S.admin = admin;

  const queue = await must(admin.req('/api/admin/seller-applications'), 200, 'applications queue');
  const app = queue.applications.find((a) => a.owner.email === 'meera@bazaar.test');
  assert.ok(app, 'the application is visible to admins');
  assert.equal(app.status, 'submitted');
  assert.equal(app.pan, 'AAAPM1234K', 'KYC details travel with the application');
  assert.equal(app.documents.length, 2);

  // A rejection without reason is refused; approval goes through.
  assert.equal((await admin.req(`/api/admin/seller-applications/${app.id}`, { method: 'PATCH', body: { status: 'rejected' } })).status, 400);
  await must(admin.req(`/api/admin/seller-applications/${app.id}`, { method: 'PATCH', body: { status: 'approved' } }), 200, 'approval');

  const me = await must(S.seller.req('/api/partner/me'), 200, 'me after approval');
  assert.equal(me.user.status, 'active');
  assert.ok(me.shop.verified, 'shop flips to verified');

  const prof = await must(S.seller.req('/api/partner/seller/profile'), 200, 'profile');
  assert.equal(prof.shop.pincode, '110016', 'approval seeds the storefront address from KYC');
  assert.deepEqual(prof.shop.service_pincodes, ['110016'], 'approval seeds a serviceable PIN code');

  const areas = await must(S.seller.req('/api/partner/seller/service-areas'), 200, 'service areas');
  assert.ok(areas.areas.some((a) => a.pincode === '110016'), 'customers in 110016 become serviceable');

  // Selling endpoints unlock.
  assert.equal((await S.seller.req('/api/partner/seller/products')).status, 200, 'catalogue unlocked');
  assert.equal((await S.seller.req('/api/partner/seller/orders?status=all')).status, 200, 'orders unlocked');
});

/* ------------------------------------------------------------------ */
/* 3 · catalogue, SKU/barcodes and scanner idempotency                */
/* ------------------------------------------------------------------ */

test('seller hub — products, SKUs and scanners keep stock honest', async () => {
  const created = await must(S.seller.req('/api/partner/seller/products', { body: {
    name: 'Meera Milk 1L', category: 'groceries', price: 6600, mrp: 6800, stock: 20, lowStock: 6,
    sku: 'MDB-MILK-1L', barcode: '8907770001112', emoji: '🥛', unit: '1 litre', variant: '1 litre'
  } }), 201, 'create product');
  S.milk = created.productId;

  // SKU / barcode uniqueness per shop.
  assert.equal((await S.seller.req('/api/partner/seller/products', { body: { name: 'Copycat', category: 'groceries', price: 500, stock: 1, sku: 'MDB-MILK-1L' } })).status, 409, 'SKUs are unique');
  assert.equal((await S.seller.req('/api/partner/seller/products', { body: { name: 'Copycat 2', category: 'groceries', price: 500, stock: 1, barcode: '8907770001112' } })).status, 409, 'barcodes are unique');

  // Bulk import with per-row validation.
  const bulk = await must(S.seller.req('/api/partner/seller/products/bulk', { body: { rows: [
    { name: 'Meera Bread', category: 'groceries', price: 4500, stock: 10, sku: 'MDB-BREAD', emoji: '🍞' },
    { name: 'Broken Row', category: 'does-not-exist', price: 100, stock: 2 }
  ] } }), 201, 'bulk import');
  assert.equal(bulk.created, 1);
  assert.equal(bulk.errors.length, 1);
  assert.match(bulk.errors[0].message, /category/i);

  // Scanners: pairing, identification, idempotent events, confirm-before-commit.
  await must(S.seller.req('/api/partner/seller/scanner/devices', { body: { name: 'Counter wedge scanner', type: 'usb_keyboard', deviceId: 'SN-7741' } }), 201, 'register device');
  const devices = await must(S.seller.req('/api/partner/seller/scanner/devices'), 200, 'devices list');
  assert.equal(devices.devices[0].deviceId, 'SN-7741');

  const scan = await must(S.seller.req('/api/partner/seller/scanner/scan', { body: { code: '8907770001112', eventId: 'EVT-T1' } }), 201, 'first scan');
  assert.equal(scan.product.name, 'Meera Milk 1L', 'the barcode identifies the SKU');
  assert.equal(scan.event.status, 'pending', 'scanning alone never changes stock');

  const dup = await must(S.seller.req('/api/partner/seller/scanner/scan', { body: { code: '8907770001112', eventId: 'EVT-T1' } }), 200, 'duplicate scan');
  assert.ok(dup.duplicate, 'unique event IDs block duplicate scans');

  const before = (await must(S.seller.req('/api/partner/seller/inventory'), 200, 'inventory')).products.find((p) => p.id === S.milk);
  await must(S.seller.req(`/api/partner/seller/scanner/events/${scan.event.eventId}/confirm`, { body: { action: 'add', quantity: 4 } }), 200, 'confirm scan');
  const after = (await must(S.seller.req('/api/partner/seller/inventory'), 200, 'inventory')).products.find((p) => p.id === S.milk);
  assert.equal(after.available, before.available + 4, 'confirmed scan moves exactly the requested units');
  const movements = (await must(S.seller.req('/api/partner/seller/inventory'), 200, 'movements')).movements;
  assert.ok(movements.some((m) => m.type === 'opening' && m.delta === 20), 'opening stock recorded');
  assert.ok(movements.some((m) => m.delta === 4), 'scanner movement recorded');

  // Barcode search powers the scanner UI.
  const hit = await must(S.seller.req('/api/partner/seller/products?barcode=8907770001112'), 200, 'barcode lookup');
  assert.equal(hit.products.length, 1);
});

/* ------------------------------------------------------------------ */
/* 4 · packing gate + shared runner fulfilment                        */
/* ------------------------------------------------------------------ */

test('seller hub — orders are pack-gated and share the runner network', async () => {
  const customer = client();
  await must(customer.req('/api/customer/auth/login', { body: { identifier: 'customer@nearbuy.demo', password: 'Customer123!' } }), 200, 'customer login');
  const addr = (await must(customer.req('/api/customer/addresses'), 200, 'addresses')).addresses[0].id;
  await must(customer.req('/api/customer/cart/items', { body: { productId: S.milk, qty: 2 } }), 200, 'cart add');
  const placed = await must(customer.req('/api/customer/orders', { body: { addressId: addr, paymentMethod: 'cod', idempotencyKey: 'sh-loop-1' } }), 201, 'checkout');
  const parentCode = placed.order.code;
  const so = placed.order.sellerOrders.find((o) => o.items.some((i) => i.name === 'Meera Milk 1L'));
  assert.ok(so, 'the seller-specific order exists alongside the parent order');
  S.so = so.code;
  S.parent = parentCode;

  await must(S.seller.req(`/api/partner/seller/orders/${so.code}/action`, { body: { action: 'accept' } }), 200, 'accept');

  // Ready out of sequence is refused outright.
  assert.equal((await S.seller.req(`/api/partner/seller/orders/${so.code}/action`, { body: { action: 'ready' } })).status, 409, 'orders must be prepared before ready');

  await must(S.seller.req(`/api/partner/seller/orders/${so.code}/action`, { body: { action: 'prepare' } }), 200, 'prepare');

  // The packing gate: ready without packing is refused with detail.
  const blocked = await S.seller.req(`/api/partner/seller/orders/${so.code}/action`, { body: { action: 'ready' } });
  assert.equal(blocked.status, 409, 'unpacked orders cannot become ready');
  assert.deepEqual(blocked.json.packing, { ordered: 2, packed: 0, missing: 0 }, 'the refusal carries the packing summary');
  const packing = await must(S.seller.req(`/api/partner/seller/orders/${so.code}/packing`), 200, 'checklist');
  assert.equal(packing.summary.ordered, 2);
  // Packing short counts as incomplete unless partial fulfilment is declared.
  for (const item of packing.items) {
    await must(S.seller.req(`/api/partner/seller/orders/${so.code}/packing`, { body: { orderItemId: item.orderItemId, packedQty: Math.max(0, item.orderedQty - 1), status: 'pending' } }), 200, 'partial pack');
  }
  assert.equal((await S.seller.req(`/api/partner/seller/orders/${so.code}/action`, { body: { action: 'ready' } })).status, 409, 'short packs still block ready');

  // A shortfall unlocks ready only after every unit is accounted for AND the customer is told why.
  const rows = (await must(S.seller.req(`/api/partner/seller/orders/${so.code}/packing`), 200, 're-read checklist')).items;
  for (const item of rows) {
    await must(S.seller.req(`/api/partner/seller/orders/${so.code}/packing`, { body: { orderItemId: item.orderItemId, packedQty: Math.max(0, item.orderedQty - 1), missingQty: 1, status: 'missing', partial: true, partialNote: '' } }), 200, 'declare missing without note');
  }
  const noNote = await S.seller.req(`/api/partner/seller/orders/${so.code}/action`, { body: { action: 'ready' } });
  assert.equal(noNote.status, 409, 'partial fulfilment needs a customer-facing note');
  for (const item of rows) {
    await must(S.seller.req(`/api/partner/seller/orders/${so.code}/packing`, { body: { orderItemId: item.orderItemId, packedQty: Math.max(0, item.orderedQty - 1), missingQty: 1, status: 'missing', partial: true, partialNote: 'Batch expired this morning — refund issued for the missing unit.' } }), 200, 'declare missing with note');
  }
  await must(S.seller.req(`/api/partner/seller/orders/${so.code}/action`, { body: { action: 'ready' } }), 200, 'ready once the shortfall is resolved and explained');

  // Runner request flows into the shared pool the Runner Portal reads from.
  const requested = await must(S.seller.req(`/api/partner/seller/orders/${so.code}/action`, { body: { action: 'request_runner', weightGrams: 1200, packages: 1, timing: 'asap' } }), 200, 'request runner');
  assert.match(requested.message, /runner/i);

  const runner = client();
  await must(runner.req('/api/partner/login', { body: { email: 'rohan@nearbuy.demo', password: 'Runner123!' } }), 200, 'runner login');
  const offers = (await must(runner.req('/api/partner/runner/overview'), 200, 'offers')).offers;
  const offer = offers.find((o) => o.orderCode === so.code);
  assert.ok(offer, 'the same backend surfaces the request to runners');
  await must(runner.req(`/api/partner/runner/offers/${offer.id}/accept`, { body: {} }), 200, 'runner accepts');

  // Handover PIN is verified twice: seller confirms, runner quotes it at pickup.
  const mine = (await must(S.seller.req('/api/partner/seller/orders?status=all'), 200, 'orders')).orders.find((o) => o.code === so.code);
  assert.match(String(mine.handoverPin), /^\d{4}$/);
  assert.ok(mine.runner, 'assignment details reach the Seller Hub');
  await must(S.seller.req(`/api/partner/seller/orders/${so.code}/action`, { body: { action: 'confirm_handover', pin: mine.handoverPin } }), 200, 'handover confirmed');

  const job = (await must(runner.req('/api/partner/runner/jobs'), 200, 'jobs')).jobs.find((j) => j.status === 'accepted');
  assert.equal((await runner.req(`/api/partner/runner/jobs/${job.id}/action`, { body: { action: 'picked_up', pickupPin: '0000' } })).status, 400, 'wrong PIN rejected');
  await must(runner.req(`/api/partner/runner/jobs/${job.id}/action`, { body: { action: 'picked_up', pickupPin: mine.handoverPin } }), 200, 'pickup with PIN');
  await must(runner.req(`/api/partner/runner/jobs/${job.id}/action`, { body: { action: 'out_for_delivery' } }), 200, 'out for delivery');

  const otp = (await must(customer.req(`/api/customer/orders/${parentCode}`), 200, 'customer order')).order.sellerOrders[0].deliveryOtp;
  assert.match(String(otp), /^\d{6}$/);
  assert.equal((await runner.req(`/api/partner/runner/jobs/${job.id}/action`, { body: { action: 'delivered', otp: '123456' } })).status, 400, 'wrong OTP rejected');
  await must(runner.req(`/api/partner/runner/jobs/${job.id}/action`, { body: { action: 'delivered', otp: String(otp) } }), 200, 'OTP-verified delivery');

  const done = (await must(customer.req(`/api/customer/orders/${parentCode}`), 200, 'final state')).order;
  assert.ok(['delivered', 'completed'].includes(done.status), `the parent order closes out (${done.status})`);
  assert.equal(done.sellerOrders[0].status, 'delivered', 'the seller order is delivered');
  assert.equal(done.paymentStatus, 'paid', 'COD collection is recorded once delivered');
});

/* ------------------------------------------------------------------ */
/* 5 · settlements, receipts and reports                              */
/* ------------------------------------------------------------------ */

test('seller hub — settlements only complete on confirmed payouts', async () => {
  const gen = await must(S.seller.req('/api/partner/seller/settlements/generate', { body: { periodStart: '2020-01-01', periodEnd: '2030-01-01' } }), 201, 'generate');
  const list = await must(S.seller.req('/api/partner/seller/settlements'), 200, 'settlements list');
  const stl = list.settlements.find((x) => x.code === gen.code);
  assert.equal(stl.status, 'pending');
  assert.ok(stl.net > 0, 'net payable reflects the delivered order');

  // Never completed without a bank reference.
  assert.equal((await S.admin.req(`/api/admin/settlements/${stl.code}/status`, { body: { status: 'completed' } })).status, 400, 'payouts need a reference');
  await must(S.admin.req(`/api/admin/settlements/${stl.code}/status`, { body: { status: 'processing' } }), 200, 'processing');
  await must(S.admin.req(`/api/admin/settlements/${stl.code}/status`, { body: { status: 'completed', bankReference: 'UTR-HUB-01' } }), 200, 'completed');

  const detail = await must(S.seller.req(`/api/partner/seller/settlements/${stl.code}`), 200, 'statement detail');
  assert.equal(detail.settlement.status, 'completed');
  assert.equal(detail.items.length, 1, 'the statement links its orders');
  assert.equal(detail.settlement.bankReference, 'UTR-HUB-01');

  // Receipts print from authoritative data behind the seller session.
  const receipt = await S.seller.req(`/api/partner/seller/receipt/${S.so}`, { method: 'GET' });
  assert.equal(receipt.status, 200, 'seller receipt renders');
  assert.match(receipt.text, /Meera Milk 1L/, 'the receipt lists the sold item');
  assert.match(receipt.text, /Meera Daily Bazaar/, 'the receipt carries the shop identity');
});

/* ------------------------------------------------------------------ */
/* 6 · staff scoping, support and console coverage                    */
/* ------------------------------------------------------------------ */

test('seller hub — staff roles stay scoped and every section exists', async () => {
  // Owners manage staff; the packing role cannot.
  await must(S.seller.req('/api/partner/seller/staff', { body: { name: 'Packer Pal', email: 'packer@bazaar.test', phone: '9898002211', password: 'Pack123!!', role: 'packing_staff' } }), 201, 'add staff');
  const team = await must(S.seller.req('/api/partner/seller/staff'), 200, 'team list');
  const packer = team.staff.find((m) => m.email === 'packer@bazaar.test');
  assert.ok(!packer.permissions.includes('manage_settlements'), 'packing staff never inherit owner rights');

  const packerClient = client();
  await must(packerClient.req('/api/partner/login', { body: { email: 'packer@bazaar.test', password: 'Pack123!!' } }), 200, 'staff login');
  assert.equal((await packerClient.req('/api/partner/seller/settlements')).status, 403, 'settlements stay owner-only');
  assert.equal((await packerClient.req('/api/partner/seller/orders?status=all')).status, 200, 'packing staff see orders');

  // Support loop: ticket -> admin reply -> resolution.
  const ticket = await must(S.seller.req('/api/partner/seller/support/tickets', { body: { category: 'settlement', subject: 'When is my payout?', description: 'Statement STL shows pending.' } }), 201, 'ticket raised');
  await must(S.seller.req(`/api/partner/seller/support/tickets/${ticket.ticket.code}/reply`, { body: { body: 'Any update please?' } }), 200, 'seller replies');
  const adminQueue = await must(S.admin.req('/api/admin/seller-tickets'), 200, 'admin queue');
  assert.ok(adminQueue.tickets.some((t) => t.code === ticket.ticket.code), 'admins see seller tickets');
  await must(S.admin.req(`/api/admin/seller-tickets/${ticket.ticket.code}/reply`, { body: { body: 'Paid today.', assignTo: 'Ops' } }), 200, 'admin reply');
  await must(S.admin.req(`/api/admin/seller-tickets/${ticket.ticket.code}/status`, { body: { status: 'resolved' } }), 200, 'resolved');
  const thread = await must(S.seller.req(`/api/partner/seller/support/tickets/${ticket.ticket.code}`), 200, 'thread');
  assert.ok(thread.ticket.messages.length >= 2);
  assert.equal(thread.ticket.status, 'resolved');

  // Every sidebar section from the brief is registered in the console.
  const js = fs.readFileSync(path.join(ROOT, 'partner/seller.js'), 'utf8');
  for (const route of ['overview', 'orders', 'returns', 'products', 'inventory', 'scanner', 'categories', 'customers', 'delivery', 'runner', 'promotions', 'analytics', 'revenue', 'settlements', 'staff', 'profile', 'hours', 'reports', 'notifications', 'support', 'settings']) {
    const literal = String.raw`/^\/` + route + String.raw`$/`;
    assert.ok(js.includes(literal), `the console registers #/${route}`);
  }
  for (const label of ['Dashboard', 'Returns & Refunds', 'Barcode / QR Scanner', 'NearBuy Runner', 'Promotions & Offers', 'Staff Management', 'Business Hours', 'Support Centre']) {
    assert.ok(js.includes(label), `the sidebar advertises “${label}”`);
  }

  // The returns queue stays reachable from the hub (the refund chain itself is covered in journeys).
  assert.equal((await S.seller.req('/api/partner/seller/returns')).status, 200, 'returns queue reachable');
  assert.match(js, /Listening for scanner input/, 'live keyboard-wedge scanning is wired');
  assert.match(js, /scanning alone never changes stock/i, 'the scan-confirm rule is explained');

  // Registration surface runs the three-step flow.
  const reg = fs.readFileSync(path.join(ROOT, 'seller/register/index.html'), 'utf8');
  assert.match(reg, /\/api\/customer\/seller\/register/, 'step 1 posts to the registration API');
  assert.match(reg, /\/api\/customer\/seller\/kyc/, 'step 3 submits KYC');
  assert.match(reg, /KYC &amp; verification/i, 'the wizard names the verification step');
});
