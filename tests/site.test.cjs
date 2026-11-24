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
  '/customer/',
  '/customer/index.html',
  '/customer/login/',
  '/seller/',
  '/seller/register/',
  '/runner/',
  '/runner/register/',
  '/admin/',
  '/demo/',
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
  '/public/assets/brand.css',
  '/partner/app.css',
  '/partner/core.js',
  '/partner/seller.js',
  '/partner/runner.js',
  '/partner/admin.js',
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
    ['/partner/core.js', 'text/javascript'],
    ['/customer/core.js', 'text/javascript'],
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
    'about/index.html',
    'help/index.html',
    'roadmap/index.html',
    'customer/index.html',
    'seller/index.html',
    'runner/index.html',
    'admin/index.html',
    'demo/index.html'
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
    'about/index.html',
    'help/index.html',
    'roadmap/index.html',
    'customer/index.html',
    'customer/login/index.html',
    'seller/index.html',
    'seller/register/index.html',
    'runner/index.html',
    'runner/register/index.html',
    'admin/index.html',
    'demo/index.html'
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

test('every console icon and navigation item resolves to a registered route', () => {
  for (const [file, part] of [['partner/core.js', 'core'], ['partner/seller.js', 'seller'], ['partner/runner.js', 'runner'], ['partner/admin.js', 'admin']]) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');

    // Icons: every icon('name') literal must exist in the core ICONS map.
    if (part !== 'core') {
      const core = fs.readFileSync(path.join(ROOT, 'partner/core.js'), 'utf8');
      const iconsBlock = core.match(/const ICONS = \{([\s\S]*?)\n  \};/);
      assert.ok(iconsBlock, 'the shared ICONS map should exist in partner/core.js');
      const registered = new Set([...iconsBlock[1].matchAll(/^\s{4}([a-zA-Z0-9_]+)\s*:/gm)].map((m) => m[1]));
      const missing = [...new Set([...src.matchAll(/\bPA\.icon\(\s*'([a-zA-Z0-9_]+)'/g)].map((m) => m[1]))]
        .filter((name) => !registered.has(name));
      assert.deepEqual(missing, [], `${file}: unregistered icons ${missing.join(', ')}`);
    }

    // Routes: every `href="#/x"` the console renders must be in its PA.start({routes}).
    // partner/core.js is the shared shell: it owns no routes of its own.
    const routesBlock = src.match(/routes: \[([\s\S]*?)\n {4}\]/);
    if (part === 'core') { assert.equal(routesBlock, null, 'the shared shell owns no routes'); continue; }
    const registered = new Set([...routesBlock[1].matchAll(/\[\/\^\\\/([a-z0-9-]+)/g)].map((m) => m[1]));
    for (const m of src.matchAll(/href="#\/([a-z0-9-]+)"/g)) {
      assert.ok(registered.has(m[1]), `${file}: "${m[0]}" has no registered route`);
    }
  }
});

test('the seller hub keeps both delivery choices and hides marketing bands', () => {
  const seller = fs.readFileSync(path.join(ROOT, 'partner/seller.js'), 'utf8');

  // Fulfilment: the seller may hand over to a runner or deliver it themselves.
  assert.match(seller, /request_runner/, 'seller must be able to request a NearBuy runner');
  assert.match(seller, /own_delivery|self_delivery|confirm_handover/, 'seller must be able to complete fulfilment themselves');
  assert.match(seller, /handoverPin|handover/i, 'the handover PIN must be surfaced to the seller');

  // Marketing blocks the owner asked to remove must not come back on either console.
  const surfaces = seller + '\n' + fs.readFileSync(path.join(ROOT, 'partner/runner.js'), 'utf8');
  for (const banned of [
    'Grow your local business. Reach more customers.',
    'Your shop deserves to be discovered.',
    'Start selling on NearBuy',
    'WHY BECOME A NEARBUY DELIVERY PARTNER',
    'Your neighbourhood. Your delivery journey.',
    'Deliver locally. Earn fairly.'
  ]) {
    assert.ok(!surfaces.includes(banned), `seller/runner marketing copy should stay removed: ${banned}`);
  }
});

test('the runner portal enforces one delivery at a time with accept and decline', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'partner/runner.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server/customer/api.js'), 'utf8');

  // The console offers accept and decline on each offer.
  assert.match(runner, /runner\/offers\/\$\{encodeURIComponent\(btn\.dataset\.id\)\}/, 'the runner acts on an offer by id');
  assert.match(runner, /dataset\.offer/, 'the runner chooses accept or decline for that offer');
  assert.match(runner, /accept/i, 'accepting is offered');
  assert.match(runner, /decline/i, 'declining is offered');

  // The server is what actually prevents stacking: one active job per runner.
  assert.match(server, /route\.match\(\/\^\\\/runner\\\/offers\\\/\[a-zA-Z0-9-\]\+\\\/\(accept\|decline\)\$\//,
    'the server exposes accept and decline for a runner offer');
  assert.match(server, /already have an active|one delivery at a time|active delivery/i,
    'the API refuses a second concurrent delivery on the server, not only in the UI');

  // Delivery needs the customer OTP and pickup needs the seller PIN — never faked.
  assert.match(server, /pickupPin/, 'pickup is gated by the shop handover PIN');
  assert.match(server, /otp/i, 'delivery is gated by the customer OTP');
});

test('inventory is restocked when an order is declined or cancelled', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server/customer/api.js'), 'utf8');
  assert.match(server, /releaseStockForSellerOrder/, 'cancelled or rejected seller orders release their stock');
  assert.match(server, /reserved/, 'stock reservations are tracked in the database');

  // The seller console offers a reject path with a reason.
  const seller = fs.readFileSync(path.join(ROOT, 'partner/seller.js'), 'utf8');
  assert.match(seller, /reject/, 'the seller can reject an order');
  assert.match(seller, /reason/i, 'a rejection carries a reason');
});

test('the classic storefront is gone from every surface', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'classic.html')), 'classic.html should be deleted');
  assert.ok(!fs.existsSync(path.join(ROOT, 'app.js')), 'the classic storefront script should be deleted');
  assert.ok(!fs.existsSync(path.join(ROOT, 'styles.css')), 'the classic storefront stylesheet should be deleted');

  const surfaces = ['home.js', 'index.html', 'about/index.html', 'help/index.html', 'README.md'];
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

test('footers keep branding and never link to a retired prototype', () => {
  for (const file of ['index.html', 'about/index.html', 'help/index.html', 'roadmap/index.html']) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const footer = html.match(/<footer\b[\s\S]*?<\/footer>/)?.[0] || '';
    // Every footer link must be a page that exists (or a hash on the same page).
    for (const m of footer.matchAll(/href="(\/[^"#?]*)"/g)) {
      const target = path.join(ROOT, m[1].replace(/^\/+/, ''));
      const ok = m[1] === '/' || fs.existsSync(target) || fs.existsSync(target + '.html') || fs.existsSync(path.join(target, 'index.html'));
      assert.ok(ok, `${file} footer links to a missing page: ${m[1]}`);
    }
    // Retired browser-only surfaces must never be advertised again.
    assert.doesNotMatch(footer, /portal\.html|seller\.html|business\.html|partner\.html|delivery-admin\.html|control-tower|\/fleet\//, file);
  }
  const customer = fs.readFileSync(path.join(ROOT, 'customer/core.js'), 'utf8');
  assert.doesNotMatch(customer, /href="\/(seller|runner|admin)\//, 'the storefront footer keeps to the customer journey');
});

test('retired prototype surfaces redirect to the live portals', async () => {
  const expected = {
    '/portal.html': '/demo/',
    '/seller.html': '/seller/',
    '/business.html': '/seller/',
    '/partner.html': '/runner/',
    '/delivery-admin.html': '/admin/',
    '/fleet/': '/admin/',
    '/control-tower/': '/admin/'
  };
  for (const [from, to] of Object.entries(expected)) {
    const res = await fetch(BASE + from, { redirect: 'manual' });
    assert.equal(res.status, 301, `${from} should redirect, got ${res.status}`);
    assert.equal(res.headers.get('location'), to, `${from} should redirect to ${to}`);
    await res.body?.cancel();
  }
  // The retired scripts and stylesheets are gone, not merely unlinked.
  for (const p of ['/nearbuy.js', '/nearbuy.css', '/seller.js', '/seller.css', '/network.js', '/network.css']) {
    const res = await fetch(BASE + p, { redirect: 'manual' });
    assert.equal(res.status, 404, `${p} should no longer be served`);
    await res.body?.cancel();
  }
});
