/*
 * Site regression tests — zero dependencies (node:test + global fetch).
 *
 *   npm test
 *
 * Boots server/index.js on an ephemeral port and asserts that:
 *   1. every documented clean URL and legacy page returns 200,
 *   2. every locally referenced asset (img / css / js / font) exists on disk,
 *   3. directory URLs redirect to their trailing-slash form,
 *   4. unknown paths return the styled 404 (not a server error),
 *   5. path traversal is refused.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;

let child;

before(async () => {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore'
  });
  // wait for the port to accept connections
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/`, { method: 'HEAD' });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error('server did not start in time');
});

after(() => {
  if (child) child.kill();
});

const PAGES = [
  '/',
  '/index.html',
  '/portal.html',
  '/seller.html',
  '/partner.html',
  '/business.html',
  '/delivery-admin.html',
  '/customer/',
  '/customer/index.html',
  '/customer/login/',
  '/seller/',
  '/seller/register/',
  '/runner/',
  '/runner/register/',
  '/fleet/',
  '/admin/',
  '/control-tower/',
  '/about/',
  '/help/',
  '/roadmap/',
  '/delivery/kit.css',
  '/delivery/logo.svg',
  '/delivery/fonts/dm-sans-latin-wght-normal.woff2',
  '/public/assets/nearbuy-logo.png',
  '/favicon.ico'
];

const ASSETS = [
  '/customer/app.css',
  '/customer/core.js',
  '/customer/views-home.js',
  '/customer/views-shop.js',
  '/customer/views-search.js',
  '/customer/views-cart.js',
  '/customer/views-orders.js',
  '/customer/views-account.js',
  '/home.css',
  '/home.js',
  '/nearbuy.css',
  '/nearbuy.js',
  '/seller.css',
  '/seller.js',
  '/network.css',
  '/network.js',
  '/public/assets/hero-neighbourhood.jpg',
  '/public/assets/portal-customer.jpg',
  '/public/assets/portal-seller.jpg',
  '/public/assets/portal-runner.jpg',
  '/public/assets/discover-local-market.jpg',
  '/public/assets/discover-milk.jpg',
  '/public/assets/discover-bananas.jpg',
  '/public/assets/discover-bread.jpg',
  '/public/assets/discover-eggs.jpg',
  '/public/assets/showcase-milk.jpg',
  '/public/assets/showcase-bananas.jpg',
  '/public/assets/showcase-bread.jpg',
  '/public/assets/showcase-eggs.jpg'
];

test('documented pages and front doors return 200', async () => {
  for (const p of PAGES) {
    const res = await fetch(BASE + p);
    assert.equal(res.status, 200, `expected 200 for ${p}, got ${res.status}`);
    await res.body?.cancel();
  }
});

test('stylesheets, scripts and images return 200', async () => {
  for (const p of ASSETS) {
    const res = await fetch(BASE + p);
    assert.equal(res.status, 200, `expected 200 for ${p}, got ${res.status}`);
    await res.body?.cancel();
  }
});

test('content types are correct', async () => {
  const cases = [
    ['/home.css', 'text/css'],
    ['/nearbuy.js', 'text/javascript'],
    ['/public/assets/nearbuy-logo.png', 'image/png'],
    ['/public/assets/hero-neighbourhood.jpg', 'image/jpeg'],
    ['/delivery/logo.svg', 'image/svg+xml'],
    ['/delivery/fonts/dm-sans-latin-wght-normal.woff2', 'font/woff2'],
    ['/about/', 'text/html']
  ];
  for (const [p, type] of cases) {
    const res = await fetch(BASE + p);
    assert.ok(
      (res.headers.get('content-type') || '').includes(type),
      `${p} should be ${type}, got ${res.headers.get('content-type')}`
    );
    await res.body?.cancel();
  }
});

test('extensionless directory URLs redirect to trailing slash', async () => {
  const res = await fetch(`${BASE}/about`, { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/about/');
});

test('unknown paths get the styled 404 page', async () => {
  const res = await fetch(`${BASE}/no-such-street/`);
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.match(html, /Page not found/);
  assert.match(html, /Back to NearBuy home/);
});

test('path traversal and internal server files are refused', async () => {
  const blocked = [
    '/%2e%2e%2fpackage.json',
    '/.gitignore',
    '/package.json',
    '/package-lock.json',
    '/server/index.js',
    '/server/orders.js',
    '/tools/render-logo.mjs',
    '/tests/site.test.cjs'
  ];
  for (const p of blocked) {
    const res = await fetch(`${BASE}${p}`, { redirect: 'manual' });
    assert.ok(res.status === 400 || res.status === 404, `${p} should be refused, got ${res.status}`);
    await res.body?.cancel();
  }
});

test('every asset referenced in the markup exists on disk', () => {
  const htmlFiles = [
    'index.html',
    'portal.html',
    'seller.html',
    'partner.html',
    'business.html',
    'delivery-admin.html',
    'about/index.html',
    'help/index.html',
    'roadmap/index.html',
    'customer/index.html',
    'seller/index.html',
    'runner/index.html'
  ];
  const refRe = /(?:href|src)\s*=\s*["'](\/[^"'#?]+)["']/gi;
  const missing = [];
  for (const f of htmlFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(refRe)) {
      const p = m[1];
      if (p.startsWith('//') || p === '/') continue;
      const local = path.join(ROOT, p.replace(/^\/+/, ''));
      const ok =
        fs.existsSync(local) ||
        fs.existsSync(local + '.html') ||
        fs.existsSync(path.join(local, 'index.html'));
      if (!ok) missing.push(`${f} -> ${p}`);
    }
  }
  assert.deepEqual(missing, [], `missing referenced files:\n${missing.join('\n')}`);
});

test('the public checklist keeps all 84 items', () => {
  const src = fs.readFileSync(path.join(ROOT, 'roadmap', 'index.html'), 'utf8');
  const items = (src.match(/class="rl-item"/g) || []).length;
  assert.equal(items, 84, `expected 84 checklist items, found ${items}`);
});

test('every HTML surface uses the universal logo and declares a favicon', () => {
  const htmlFiles = [
    'index.html',
    'portal.html',
    'seller.html',
    'partner.html',
    'business.html',
    'delivery-admin.html',
    'about/index.html',
    'help/index.html',
    'roadmap/index.html',
    'customer/index.html',
    'customer/login/index.html',
    'seller/index.html',
    'seller/register/index.html',
    'runner/index.html',
    'runner/register/index.html',
    'fleet/index.html',
    'admin/index.html',
    'control-tower/index.html'
  ];
  for (const f of htmlFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(src, /rel=["']icon["']/, `${f} should declare a favicon`);
    assert.match(src, /(?:\/public\/assets\/nearbuy-logo\.png|\/delivery\/logo\.svg)/, `${f} should reference universal logo`);
    assert.doesNotMatch(src, /M22 4\.5/, `${f} should not contain the legacy pin vector`);
  }
  const svgSrc = fs.readFileSync(path.join(ROOT, 'delivery', 'logo.svg'), 'utf8');
  assert.match(svgSrc, /data:image\/png;base64,/, 'delivery/logo.svg should embed universal badge PNG');
});

test('all NearBuy One icons and action hooks are registered', () => {
  const nbJs = fs.readFileSync(path.join(ROOT, 'nearbuy.js'), 'utf8');
  const portalHtml = fs.readFileSync(path.join(ROOT, 'portal.html'), 'utf8');

  const pathsBlock = nbJs.match(/const PATHS = \{([\s\S]*?)\n\};/);
  assert.ok(pathsBlock, 'PATHS icon map should exist in nearbuy.js');
  const registeredIcons = new Set([...pathsBlock[1].matchAll(/^\s*([a-zA-Z0-9_]+)\s*:/gm)].map((m) => m[1]));
  const missingIcons = [];
  for (const m of nbJs.matchAll(/\bicon\(\s*['"]([a-zA-Z0-9_]+)['"]/g)) {
    if (!registeredIcons.has(m[1])) missingIcons.push(m[1]);
  }
  assert.deepEqual([...new Set(missingIcons)], [], 'every icon() literal must exist in PATHS');

  const usedActs = new Set([...(nbJs + '\n' + portalHtml).matchAll(/data-act=["']([a-zA-Z0-9_-]+)["']/g)].map((m) => m[1]));
  const handledActs = new Set([
    ...[...nbJs.matchAll(/case\s+['"]([a-zA-Z0-9_-]+)['"]\s*:/g)].map((m) => m[1]),
    ...[...nbJs.matchAll(/act\s*===\s*['"]([a-zA-Z0-9_-]+)['"]/g)].map((m) => m[1]),
    ...[...nbJs.matchAll(/dataset\.act\s*===\s*['"]([a-zA-Z0-9_-]+)['"]/g)].map((m) => m[1]),
    ...[...nbJs.matchAll(/\[data-act=["']([a-zA-Z0-9_-]+)["']\]/g)].map((m) => m[1])
  ]);
  const unhandledActs = [...usedActs].filter((a) => !handledActs.has(a));
  assert.deepEqual(unhandledActs, [], `unhandled data-act attributes: ${unhandledActs.join(', ')}`);
});


test('seller hub shows both delivery choices and drops the marketing bands', () => {
  const nbJs = fs.readFileSync(path.join(ROOT, 'nearbuy.js'), 'utf8');

  assert.match(nbJs, /function sellFulfilmentPanel\(/, 'seller overview should render a delivery choice panel');
  assert.match(nbJs, /Assign a runner, or deliver it yourself/, 'panel should offer the two options');
  assert.match(nbJs, /data-act="own-delivery"/, 'seller must be able to choose own delivery');
  assert.match(nbJs, /data-act="deliver-order"/, 'seller must be able to mark an own delivery delivered');

  // The marketing blocks the user asked to hide must not come back.
  for (const banned of [
    'Grow your local business. Reach more customers.',
    'Your shop deserves to be discovered.',
    'Start selling on NearBuy',
    'WHY BECOME A NEARBUY DELIVERY PARTNER',
    'Your neighbourhood. Your delivery journey.',
    'Deliver locally. Earn fairly.',
    'WHY SELL ON NEARBUY'
  ]) {
    assert.ok(!nbJs.includes(banned), `seller/runner marketing copy should be removed: ${banned}`);
  }

  // The old unused benefit arrays are gone with the bands.
  assert.ok(!/const WHY_SELL =/.test(nbJs), 'WHY_SELL list should be removed');
  assert.ok(!/const WHY_DELIVER =/.test(nbJs), 'WHY_DELIVER list should be removed');
});

test('runner home enforces one delivery at a time with accept and decline', () => {
  const nbJs = fs.readFileSync(path.join(ROOT, 'nearbuy.js'), 'utf8');

  assert.match(nbJs, /function runnerFocusPanel\(/, 'runner home should render the single-offer panel');
  assert.match(nbJs, /DELIVERY OFFER · ONE AT A TIME/, 'runner panel should explain the one-at-a-time rule');

  // Accept/decline must be reachable from runner home even while a task is active:
  // the live task and the next offer are rendered as separate groups.
  const panel = nbJs.slice(nbJs.indexOf('function runnerFocusPanel('), nbJs.indexOf('function deliverHowStrip('));
  assert.match(panel, /offerForRunner\(r\)/, 'the offer must be computed independently of the active task');
  assert.match(panel, /On the road now/, 'the active delivery should be labelled');
  assert.match(panel, /Next offer for you/, 'the next offer should be shown alongside the active task');
  assert.match(nbJs, /data-act="decline-task"/, 'runner must be able to decline a request');
  assert.match(nbJs, /function declineTask\(/, 'decline handler should exist');

  // The queue must be empty while a delivery is active.
  const queue = nbJs.match(/const runnerQueue = \(\) =>([\s\S]*?);\n/);
  assert.ok(queue, 'runnerQueue selector should exist');
  assert.match(queue[1], /activeDelivery\(\)/, 'runnerQueue must short-circuit when a delivery is active');

  // Accepting a second task while one is active must be refused.
  const accept = nbJs.slice(nbJs.indexOf('function acceptTask('));
  assert.match(accept.slice(0, 500), /activeDelivery\(\)/, 'acceptTask should refuse a second concurrent delivery');

  // Declining keeps the task open for other runners instead of cancelling it.
  const decline = nbJs.slice(nbJs.indexOf('function declineTask(')).slice(0, 900);
  assert.match(decline, /declinedBy/, 'decline should record the runner locally');
  assert.ok(!/status = 'Cancelled'/.test(decline), 'declining must not cancel the task for everyone');
});

test('incoming order items are auto-detected and restored when declined', () => {
  const nbJs = fs.readFileSync(path.join(ROOT, 'nearbuy.js'), 'utf8');

  assert.match(nbJs, /function findProductForLine\(/, 'catalogue should match order lines to products');
  assert.match(nbJs, /function catalogueAutoDetect\(/, 'catalogue page should show detected order items');
  assert.match(nbJs, /function restockForOrder\(/, 'declined orders must return their items to stock');
  assert.match(nbJs, /function cancelOrderAndRestock\(/, 'a single path should cancel and restock');

  // Restoring is idempotent so a double decline cannot inflate stock.
  const fn = nbJs.slice(nbJs.indexOf('function cancelOrderAndRestock('));
  assert.match(fn.slice(0, 400), /stockReturned/, 'restock must be guarded against running twice');

  // The customer can decline too.
  assert.match(nbJs, /Decline this order/, 'customer order page should offer a decline action');

  // The standalone seller hub restores stock the same way.
  const sellerJs = fs.readFileSync(path.join(ROOT, 'seller.js'), 'utf8');
  assert.match(sellerJs, /function restockOrderItems\(/, 'seller hub should track restored stock');
  assert.match(sellerJs, /function autoDetectPanel\(/, 'seller hub catalogue should show detected items');
  assert.match(sellerJs, /function declineOrder\(/, 'seller decline should restore stock');
});

test('the classic storefront is gone from every surface', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'classic.html')), 'classic.html should be deleted');
  assert.ok(!fs.existsSync(path.join(ROOT, 'app.js')), 'the classic storefront script should be deleted');
  assert.ok(!fs.existsSync(path.join(ROOT, 'styles.css')), 'the classic storefront stylesheet should be deleted');

  const surfaces = ['nearbuy.js', 'seller.js', 'home.js', 'index.html', 'portal.html', 'README.md'];
  for (const f of surfaces) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/classic\.html/i.test(src), `${f} should not link to the classic storefront`);
    assert.ok(!/Classic storefront/i.test(src), `${f} should not advertise the classic storefront`);
  }
});

test('the removed classic storefront returns 404 instead of a stale page', async () => {
  for (const p of ['/classic.html', '/app.js', '/styles.css']) {
    const res = await fetch(`${BASE}${p}`, { redirect: 'manual' });
    assert.equal(res.status, 404, `${p} should be gone, got ${res.status}`);
    await res.body?.cancel();
  }
});

test('all HTML surfaces load the universal navy and orange brand theme', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['.git', 'node_modules', 'dist', 'data'].includes(entry.name)) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : entry.name.endsWith('.html') ? [full] : [];
  });
  for (const file of walk(ROOT)) {
    assert.match(fs.readFileSync(file, 'utf8'), /href="\/public\/assets\/brand\.css"/, file);
  }
  const theme = fs.readFileSync(path.join(ROOT, 'public/assets/brand.css'), 'utf8');
  assert.match(theme, /--brand-navy: #06245e/);
  assert.match(theme, /--brand-orange: #ff7900/);
});

test('customer and partner portals do not advertise other role workspaces', () => {
  for (const name of ['customer/core.js', 'customer/views-account.js', 'customer/views-home.js']) {
    const source = fs.readFileSync(path.join(ROOT, name), 'utf8');
    assert.doesNotMatch(source, /href="\/(seller|runner|demo)\//, name);
  }
  const partner = fs.readFileSync(path.join(ROOT, 'partner/core.js'), 'utf8');
  assert.doesNotMatch(partner, /href="\/(customer|demo)\//);
  assert.match(partner, /role: state.mode/);
  assert.match(partner, /state.user.role !== state.mode/);
});

test('footers retain branding without navigation tab groups or portal shortcuts', () => {
  for (const file of ['index.html', 'about/index.html', 'help/index.html', 'roadmap/index.html']) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const footer = html.match(/<footer\b[\s\S]*?<\/footer>/)?.[0] || '';
    assert.doesNotMatch(footer, /footer__cols|footer__admin|href="\/(customer|seller|runner|admin)\//, file);
  }
  const customer = fs.readFileSync(path.join(ROOT, 'customer/core.js'), 'utf8');
  assert.doesNotMatch(customer, /class="footer-col"/);
});
