/*
 * NearBuy — shop map contract tests (zero dependencies).

 *   node --test tests/*.test.cjs      (or simply `npm test`)
 *
 * The storefront map is only useful if the customer API actually ships the four
 * things the shopper asked to see next to each pin: distance, phone number, owner
 * name and the shop's location. These tests pin that payload, pin the projection
 * maths that turns lat/lng into kilometres (so the distance rings stay honest), and
 * pin the client wiring that renders it.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PORT = 4214;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nearbuy-shopmap-'));
let child;

/* The demo shopper stands in Hauz Khas; the seeded shops fan out around Delhi. */
const SHOPPER = { lat: 28.5494, lng: 77.2001, pincode: '110016' };

function client() {
  let cookie = '';
  return {
    async req(pathname, { body, headers, method } = {}) {
      const h = { 'X-NearBuy-Request': '1', Origin: BASE, ...(headers || {}) };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (cookie) h.Cookie = cookie;
      const res = await fetch(BASE + pathname, {
        method: method || (body === undefined ? 'GET' : 'POST'),
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual'
      });
      for (const raw of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const pair = raw.split(';')[0];
        if (/^nb_(session|partner_session)=/.test(pair)) cookie = pair.endsWith('=') ? '' : pair;
      }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: res.status, json, text };
    }
  };
}

before(async () => {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NEARBUY_DB: path.join(DATA_DIR, 'db.sqlite') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start in time')), 20000);
    child.stdout.on('data', (d) => { if (String(d).includes(`http://localhost:${PORT}`)) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', (d) => { if (String(d).includes('EADDRINUSE')) { clearTimeout(t); reject(new Error('port busy')); } });
  });
});

after(async () => {
  if (child) child.kill('SIGTERM');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* API payload                                                          */
/* ------------------------------------------------------------------ */

test('the shops endpoint ships phone, owner name and a directions link', async () => {
  const c = client();
  await c.req('/api/customer/auth/demo', { body: { role: 'customer' } });
  const qs = new URLSearchParams({ lat: SHOPPER.lat, lng: SHOPPER.lng, pincode: SHOPPER.pincode, limit: '12' });
  const res = await c.req(`/api/customer/shops?${qs}`);
  assert.equal(res.status, 200, `shops: ${res.status} ${res.text.slice(0, 200)}`);
  const shops = res.json.shops;
  assert.ok(Array.isArray(shops) && shops.length >= 5, 'expected several shops');

  const withPhone = shops.filter((s) => s.phone);
  assert.ok(withPhone.length >= shops.length - 1,
    `every seeded shop should publish a phone (got ${withPhone.length}/${shops.length})`);
  for (const s of withPhone) {
    assert.match(String(s.phone), /^\+?[\d-]{8,15}$/, `${s.name}: implausible phone "${s.phone}"`);
  }

  const owners = shops.filter((s) => s.ownerName);
  assert.ok(owners.length >= 5, `owner names missing (got ${owners.length}/${shops.length})`);
  for (const s of owners) assert.ok(s.ownerName.trim().length >= 3, `${s.name}: owner name too short`);

  for (const s of shops) {
    assert.ok(Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)), `${s.name}: missing coordinates`);
    assert.match(s.directionsUrl, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/,
      `${s.name}: directionsUrl must open Google Maps directions`);
    assert.ok(s.directionsUrl.includes(`${s.lat}%2C${s.lng}`) || s.directionsUrl.includes(`${s.lat},${s.lng}`),
      `${s.name}: directionsUrl must target the shop's own coordinates`);
  }
});

test('every shop carries a distance from the shopper, ordered nearest first', async () => {
  const c = client();
  await c.req('/api/customer/auth/demo', { body: { role: 'customer' } });
  const qs = new URLSearchParams({ lat: SHOPPER.lat, lng: SHOPPER.lng, pincode: SHOPPER.pincode, limit: '12', sort: 'distance' });
  const { json } = await c.req(`/api/customer/shops?${qs}`);
  const dists = json.shops.map((s) => s.distanceKm);
  assert.ok(dists.every((d) => Number.isFinite(d)), `every shop needs a numeric distanceKm — got ${dists.join(',')}`);
  assert.ok(dists.every((d) => d >= 0), 'distances cannot be negative');
  for (let i = 1; i < dists.length; i++) {
    assert.ok(dists[i] >= dists[i - 1] - 1e-9, `not sorted nearest-first: ${dists.join(',')}`);
  }
  /* straight-line Hauz Khas → Saket is ~6 km; a wild number means the maths broke */
  assert.ok(dists[0] <= 25, `nearest shop is implausibly far: ${dists[0]} km`);
});

test('a shop without a seller account still reports its proprietor', async () => {
  const c = client();
  await c.req('/api/customer/auth/demo', { body: { role: 'customer' } });
  const { json } = await c.req('/api/customer/shops?limit=12');
  /* Green Basket Market has no owner_user_id row — the name comes from the shop record */
  const green = json.shops.find((s) => s.slug === 'green-basket');
  assert.ok(green, 'green-basket should be seeded');
  assert.match(String(green.ownerName), /\S/, 'proprietor name must survive without a linked seller account');
});

test('saving an unrelated profile field keeps the phone formatting', async () => {
  const c = client();
  await c.req('/api/customer/auth/demo', { body: { role: 'seller' } });
  const before = await c.req('/api/partner/seller/profile');
  assert.equal(before.status, 200, `profile: ${before.status}`);
  const shop = before.json.shop;
  const phone = String(shop.phone || '');
  if (!phone.includes('-')) return;   // nothing to preserve on this fixture

  const me = await c.req('/api/partner/me');
  const csrf = me.json?.user?.csrf;
  assert.ok(csrf, 'partner session must ship a CSRF token');
  /* The Seller Hub form submits every field, including the phone it just displayed.
   * Saving an unrelated edit must not reformat that number. */
  const res = await c.req('/api/partner/seller/profile', {
    method: 'PATCH',
    body: { ownerName: shop.proprietor_name || shop.name, phone },
    headers: { 'X-NearBuy-CSRF': csrf }
  });
  assert.equal(res.status, 200, `patch: ${res.status} ${res.text.slice(0, 200)}`);
  assert.equal(res.json.shop.phone, phone, `phone formatting must survive an unrelated save (${phone} → ${res.json.shop.phone})`);
});

test('the single-shop endpoint carries the same map details', async () => {
  const c = client();
  await c.req('/api/customer/auth/demo', { body: { role: 'customer' } });
  const qs = new URLSearchParams({ lat: SHOPPER.lat, lng: SHOPPER.lng, pincode: SHOPPER.pincode });
  const list = await c.req(`/api/customer/shops?${qs}&limit=3`);
  const slug = list.json.shops[0].slug;
  const res = await c.req(`/api/customer/shops/${slug}?${qs}`);
  assert.equal(res.status, 200, `shop detail: ${res.status}`);
  const s = res.json.shop;
  assert.ok(s.phone, 'shop detail must include a phone number');
  assert.ok(s.ownerName, 'shop detail must include an owner name');
  assert.ok(Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)), 'shop detail must include coordinates');
  assert.ok(Number.isFinite(s.distanceKm), 'shop detail must include a distance from the shopper');
  assert.match(s.directionsUrl, /google\.com\/maps\/dir/, 'shop detail must include a directions link');
});

/* ------------------------------------------------------------------ */
/* Projection maths                                                     */
/* ------------------------------------------------------------------ */

/* Load just the map helpers from customer/core.js without booting the SPA. */
function loadMapHelpers() {
  const src = fs.readFileSync(path.join(ROOT, 'customer/core.js'), 'utf8');
  const start = src.indexOf('const KM_PER_DEG_LAT');
  const end = src.indexOf('NB.wireShopMap =');
  assert.ok(start > 0 && end > start, 'could not locate the map helpers in customer/core.js');
  const NB = {
    state: { location: null },
    /* minimal stand-ins for the two template helpers the panel markup uses */
    esc: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    icon: () => '<svg class="ic"></svg>',
    $$: () => [],
    $: () => null
  };
  const ctx = { NB };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + '\nthis.__NB = NB;', ctx);
  return ctx.__NB;
}

test('the projection is isotropic: 1 km north and 1 km east are the same number of pixels', () => {
  const NB = loadMapHelpers();
  /* one layout holding a point 1 km north AND a point 1 km east of the centre */
  const north = { lat: SHOPPER.lat + 1 / 111.32, lng: SHOPPER.lng };
  const east = { lat: SHOPPER.lat, lng: SHOPPER.lng + 1 / (111.32 * Math.cos(SHOPPER.lat * Math.PI / 180)) };
  const centre = { lat: SHOPPER.lat, lng: SHOPPER.lng };
  const lay = NB.mapLayout([north, east, centre], { width: 600, height: 400, centre });

  assert.ok(lay.scale > 0, 'scale must be positive');
  const dy = lay.y(SHOPPER.lat) - lay.y(north.lat);   // +y is down, north is up
  const dx = lay.x(east.lng) - lay.x(SHOPPER.lng);
  assert.ok(dy > 0 && dx > 0, `north/east must project away from the centre (dy=${dy}, dx=${dx})`);
  /* if these differ, the distance rings render as ellipses and the map lies */
  assert.ok(Math.abs(dx - dy) < 1e-6, `1 km north and 1 km east must be equal: ${dy}px vs ${dx}px`);
  assert.ok(Math.abs(dx - lay.scale) < 1e-6, `scale must equal pixels per km: ${lay.scale} vs ${dx}`);
  /* and it really is kilometres: the pin for a shop 1 km away is `scale` px out */
  assert.ok(Math.abs(lay.px(1) - dx) < 1e-6, 'px(1) must agree with the projection');
});

test('every shop fits inside the canvas', () => {
  const NB = loadMapHelpers();
  const shops = [
    { lat: 28.5494, lng: 77.2001 }, { lat: 28.5300, lng: 77.2200 },
    { lat: 28.6100, lng: 77.1800 }, { lat: 28.5700, lng: 77.2600 }
  ];
  for (const [w, h] of [[640, 430], [320, 190], [1200, 430]]) {
    const lay = NB.mapLayout(shops, { width: w, height: h });
    for (const s of shops) {
      const x = lay.x(s.lng);
      const y = lay.y(s.lat);
      assert.ok(x >= 0 && x <= w, `${w}x${h}: x=${x} outside canvas`);
      assert.ok(y >= 0 && y <= h, `${w}x${h}: y=${y} outside canvas`);
    }
  }
});

test('distance rings only use values that are legible at the current zoom', () => {
  const NB = loadMapHelpers();
  const shops = [{ lat: 28.5494, lng: 77.2001 }, { lat: 28.5700, lng: 77.2600 }];
  for (const zoom of [1, 1.6, 2.56, 0.6]) {
    const lay = NB.mapLayout(shops, { width: 640, height: 430, zoom });
    const rings = [0.2, 0.5, 1, 2, 3, 5, 10, 20, 50]
      .filter((km) => lay.px(km) >= 40 && lay.px(km) <= Math.max(lay.width, lay.height) * 0.95)
      .slice(0, 4);
    assert.ok(rings.length >= 1 && rings.length <= 4, `zoom ${zoom}: ${rings.length} rings`);
    for (let i = 1; i < rings.length; i++) assert.ok(rings[i] > rings[i - 1], 'rings must ascend');
  }
});

test('an invalid location degrades instead of throwing', () => {
  const NB = loadMapHelpers();
  assert.equal(NB.mapLayout([], { width: 400, height: 300 }), null, 'no shops → null');
  assert.equal(NB.mapLayout([{ lat: 'x', lng: null }], { width: 400, height: 300 }), null, 'no coordinates → null');
  const lay = NB.mapLayout([{ lat: 28.5, lng: 77.2 }], { width: 0, height: 0 });
  assert.ok(lay && lay.width > 0 && lay.height > 0 && lay.scale > 0,
    `degenerate canvas must still yield a usable layout (got ${lay && lay.width}x${lay && lay.height})`);
  assert.ok(lay && Number.isFinite(lay.x(77.2)) && Number.isFinite(lay.y(28.5)), 'degenerate layout must project without NaN');
  assert.equal(NB.mapDistance(null), null);
  assert.equal(NB.mapDistance(0.04), '<0.1 km');
  assert.equal(NB.mapDistance(1.22), '1.22 km');
});

/* ------------------------------------------------------------------ */
/* Client wiring                                                        */
/* ------------------------------------------------------------------ */

test('the map markup renders every required field with safe escaping', () => {
  const NB = loadMapHelpers();
  const shop = {
    slug: 'a&b', name: 'Corner <Shop>', tone: 'green', emoji: '🏪', rating: 4.5, reviewCount: 12,
    isOpen: true, distanceKm: 1.25, phone: '011-42541798', ownerName: 'Riya <Sharma>',
    address: '14, Market Rd', locality: 'Hauz Khas', city: 'New Delhi', pincode: '110016',
    opensAt: '07:00', closesAt: '23:00', directionsUrl: 'https://www.google.com/maps/dir/?api=1&destination=28.5,77.2'
  };
  const html = NB.shopMap([shop], { selected: shop.slug });
  for (const needle of ['data-nbmap-canvas', 'data-nbmap-panel', 'data-nbmap-act="in"', 'data-nbmap-act="out"', 'data-nbmap-act="fit"', 'data-nbmap-scale']) {
    assert.ok(html.includes(needle), `map markup missing ${needle}`);
  }
  assert.ok(html.includes('aria-label="Map of 1 nearby shop'), 'canvas needs an accessible label');

  const panel = NB.mapPanel(shop);
  assert.match(panel, /1\.25 km from you/, 'panel must state the distance');
  assert.match(panel, /href="tel:01142541798"/, 'panel must link the phone number');
  assert.match(panel, /011-42541798/, 'panel must print the phone number');
  assert.match(panel, /Owner/, 'panel must have an owner row');
  assert.match(panel, /Riya &lt;Sharma&gt;/, 'owner name must be escaped');
  assert.match(panel, /14, Market Rd/, 'panel must print the address');
  assert.match(panel, /New Delhi/, 'panel must print the city');
  assert.match(panel, /110016/, 'panel must print the pincode');
  assert.match(panel, /rel="noopener noreferrer"/, 'external directions link must not leak the opener');
  assert.ok(!panel.includes('<Shop>'), 'shop name must be escaped');
});

test('a shop with no phone or owner renders honest placeholders', () => {
  const NB = loadMapHelpers();
  const panel = NB.mapPanel({ slug: 'x', name: 'X', rating: 4, reviewCount: 1, isOpen: true, tone: 'blue', distanceKm: null, locality: 'Saket' });
  assert.match(panel, /In Saket/, 'falls back to the locality when there is no distance');
  assert.match(panel, /Not listed/, 'missing phone/owner must say "Not listed"');
  assert.ok(!panel.includes('tel:'), 'no phone → no tel: link');
});

test('the shops page and the shop page both mount the map', () => {
  const views = fs.readFileSync(path.join(ROOT, 'customer/views-shop.js'), 'utf8');
  assert.match(views, /NB\.shopMap\(/, '#/shops must render NB.shopMap');
  assert.match(views, /NB\.wireShopMap\(/, 'the map must be wired up');
  assert.match(views, /NB\.shopMap\(\[s\]/, 'the single-shop page must render its own map');
  assert.match(views, /NB\.wireShopMap\(root, \[s\]\)/, 'the single-shop map must be wired in after()');
  assert.match(views, /<dt>Owner<\/dt>/, 'the shop information card must list the owner');
  const css = fs.readFileSync(path.join(ROOT, 'customer/app.css'), 'utf8');
  for (const cls of ['.nbmap-pin', '.nbmap__ring', '.nbmap__user', '.nbmap__panel', '.nbmap__scalebar', '.nbmap__ctl']) {
    assert.ok(css.includes(cls), `app.css is missing ${cls}`);
  }
});
