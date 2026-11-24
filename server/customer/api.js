'use strict';
/*
 * NearBuy Customer Portal API + shared seller/runner workflow.
 *
 *   /api/customer/*   customer session (browse is public, mutations need a session)
 *   /api/partner/*    seller and runner sessions on the same records
 *   /api/admin/*      role-protected platform administration
 *
 * Security model
 *   - scrypt password hashes, random session tokens stored hashed, HttpOnly cookie
 *   - every mutation needs X-NearBuy-Request: 1 (CSRF guard) and a same-origin check
 *   - signed-in mutations also need the per-session X-NearBuy-CSRF token
 *   - prices, stock, discounts and totals are always recalculated on the server
 *   - stock moves inside BEGIN IMMEDIATE transactions with conditional updates
 *   - delivery OTPs are derived with HMAC and never stored in plain text
 */
const { createHmac, randomBytes, randomUUID } = require('node:crypto');
const {
  db, now, uid, sha, makePassword, checkPassword, deriveCode, safeEqual,
  transaction, audit, pincodeArea, haversineKm,
  allocateAmountAcrossSellerOrders, syncPaymentAllocations, resolveSellerOrdersForPaymentRecord
} = require('./db');
const seed = require('./seed');

const SESSION_COOKIE = 'nb_session';
const PARTNER_COOKIE = 'nb_partner_session';
const ADMIN_COOKIE = 'nb_admin_session';
const SESSION_HOURS = 24 * 7;
const DEMO = process.env.NODE_ENV !== 'production' || process.env.SEED_DEMO === '1';
const DEV_CODES = process.env.NODE_ENV !== 'production' || process.env.DEV_MAIL_PREVIEW === '1';
const GATEWAY = {
  provider: 'razorpay',
  keyId: process.env.RAZORPAY_KEY_ID || '',
  keySecret: process.env.RAZORPAY_KEY_SECRET || '',
  apiBase: (process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com').replace(/\/+$/, ''),
  get configured() { return Boolean(this.keyId && this.keySecret); }
};
const inFlightPaymentIntents = new Map();

/* Seed once, at startup, without blocking the server if it fails. */
try { seed(); } catch (err) { console.error('[nearbuy] seed failed:', err.message); }

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || null;
  }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

// A demo administrator is only safe on a separate, sample-only database.
function demoIsIsolated() {
  return !db.prepare('SELECT 1 FROM nb_users WHERE is_demo=0 LIMIT 1').get()
    && !db.prepare('SELECT 1 FROM nb_orders WHERE is_demo=0 LIMIT 1').get();
}
function assertDemoIsolation() {
  if (!demoIsIsolated()) fail(403, 'Demo access requires a separate sample-only database. Real accounts or records were detected.');
}

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload === undefined ? null : payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    'Content-Length': body.length
  });
  res.end(body);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > limit) {
        done = true;
        req.resume();
        reject(new HttpError(413, 'Request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new HttpError(400, 'A JSON object is required'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const at = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < at) { b = { count: 0, reset: at + windowMs }; buckets.set(key, b); }
  b.count += 1;
  if (b.count > limit) fail(429, 'Too many attempts. Please wait a moment and try again.');
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.reset < at) buckets.delete(k);
  }
}

const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
const cookieAttrs = (req) => {
  const secure = isHttps(req) || process.env.COOKIE_SECURE === '1';
  return `Path=/; HttpOnly; SameSite=${secure ? 'None' : 'Lax'}${secure ? '; Secure; Partitioned' : ''}`;
};

function startSession(req, user, cookieName = SESSION_COOKIE, hours = SESSION_HOURS) {
  user = db.prepare('SELECT * FROM nb_users WHERE id=?').get(user.id);
  if (!user || !['active', 'pending_verification'].includes(user.status)) fail(403, 'This account is not active. Contact support.');
  if (user.is_demo && !DEMO) fail(403, 'Demo accounts are disabled on this deployment.');
  if (user.is_demo && user.role === 'admin' && (process.env.NODE_ENV === 'production' || process.env.DEMO_SANDBOX === '1')) assertDemoIsolation();
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO nb_sessions(token_hash,user_id,role,csrf,created_at,expires_at,user_agent,ip) VALUES(?,?,?,?,?,?,?,?)')
    .run(sha(token), user.id, user.role, csrf,
      now(), new Date(Date.now() + hours * 3600e3).toISOString(), String(req.headers['user-agent'] || '').slice(0, 200), clientIp(req));
  return { cookie: `${cookieName}=${token}; ${cookieAttrs(req)}; Max-Age=${hours * 3600}`, csrf, token };
}

function sessionFor(req, cookieName = SESSION_COOKIE) {
  const token = parseCookies(req)[cookieName];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = db.prepare(`SELECT s.user_id, u.role, s.csrf, s.expires_at, u.is_demo, u.name, u.email, u.phone, u.avatar, u.status
    FROM nb_sessions s JOIN nb_users u ON u.id=s.user_id WHERE s.token_hash=?`).get(sha(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM nb_sessions WHERE token_hash=?').run(sha(token));
    return null;
  }
  if (row.is_demo && !DEMO) return null;
  if (row.status !== 'active' && !(cookieName === PARTNER_COOKIE && row.status === 'pending_verification')) return null;
  return { ...row, token };
}

function requireUser(req, roles, cookieName = SESSION_COOKIE) {
  const s = sessionFor(req, cookieName);
  if (!s) fail(401, 'Please sign in to continue');
  if (roles && !roles.includes(s.role)) fail(403, 'You do not have access to this area. Return to your own dashboard.');
  if (s.is_demo && s.role === 'admin' && (process.env.NODE_ENV === 'production' || process.env.DEMO_SANDBOX === '1')) assertDemoIsolation();
  return s;
}

function requireCustomer(req) { return requireUser(req, ['customer']); }

function checkMutation(req, session) {
  if (req.headers['x-nearbuy-request'] !== '1') fail(403, 'Request verification header is missing');
  const origin = req.headers.origin;
  if (origin) {
    try {
      const host = new URL(origin).host;
      const expected = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      if (expected && host !== expected) fail(403, 'Cross-origin request refused');
    } catch { fail(403, 'Invalid origin'); }
  }
  if (session && req.headers['x-nearbuy-csrf'] !== session.csrf) {
    fail(403, 'Your session security token is missing. Refresh the page and try again.');
  }
}

const str = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max;
const emailOk = (v) => typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());
const phoneOk = (v) => {
  const digits = String(v || '').replace(/[^\d]/g, '').replace(/^91(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(digits);
};
const normalPhone = (v) => String(v || '').replace(/[^\d]/g, '').replace(/^91(?=\d{10}$)/, '');
const pincodeOk = (v) => /^[1-9]\d{5}$/.test(String(v || ''));
const clampInt = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const NB_SLUG = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/* ------------------------------------------------------------------ */
/* Serialisers                                                         */
/* ------------------------------------------------------------------ */

const STATUS_LABELS = {
  placed: 'Order placed',
  accepted: 'Seller accepted',
  preparing: 'Preparing order',
  ready: 'Ready for pickup',
  ready_dispatch: 'Ready for dispatch',
  runner_requested: 'Finding a delivery partner',
  runner_assigned: 'Delivery partner assigned',
  picked_up: 'Picked up',
  out_for_delivery: 'Out for delivery',
  arriving_soon: 'Arriving soon',
  delivered: 'Delivered',
  completed: 'Completed',
  rejected: 'Rejected by seller',
  cancelled: 'Cancelled',
  return_requested: 'Return requested',
  returned: 'Returned',
  payment_failed: 'Payment failed'
};

function insertRow(table, columns, values) {
  if (columns.length !== values.length) {
    throw new Error(`insertRow(${table}): ${values.length} values for ${columns.length} columns`);
  }
  db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...values);
}

function shopRow(row) {
  if (!row) return null;
  let pins = [];
  try { pins = String(row.service_pincodes || '').split(',').map((s) => s.trim()).filter(Boolean); } catch { pins = []; }
  return { ...row, service_pincodes: pins };
}

function shopCard(row, location) {
  if (!row) return null;
  let distanceKm = null;
  if (location && Number.isFinite(Number(location.lat)) && Number.isFinite(Number(location.lng))) {
    distanceKm = haversineKm(Number(location.lat), Number(location.lng), row.lat, row.lng);
  }
  let serviceable = true;
  if (location && location.pincode) {
    const pins = String(row.service_pincodes || '').split(',').map((s) => s.trim()).filter(Boolean);
    serviceable = pins.includes(String(location.pincode)) && (distanceKm == null || distanceKm <= row.radius_km + 0.75);
  }
  const counts = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN stock-reserved>0 THEN 1 ELSE 0 END) AS in_stock FROM nb_products WHERE shop_id=? AND active=1').get(row.id);
  /* The shop's own phone line and the name of the seller who runs it. Both are public
   * business details the storefront shows next to the map pin, so they are safe to
   * expose to a browsing guest. No personal seller data (email, payout, KYC) leaks.
   * `proprietor_name` covers shops whose seller has no NearBuy account of their own. */
  const owner = row.owner_user_id
    ? db.prepare('SELECT name FROM nb_users WHERE id=?').get(row.owner_user_id)
    : null;
  /* The explicitly-set proprietor name wins: it is the public, editable field shown
   * on the customer map. The linked account's display name is only a fallback for
   * shops that predate that column. */
  const ownerName = row.proprietor_name || owner?.name || null;
  const phone = row.phone || row.support_contact || null;
  const hasCoords = Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lng));
  const directionsUrl = hasCoords
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${row.lat},${row.lng}`)}`
    : null;
  return {
    id: row.id, slug: row.slug, name: row.name, categorySlug: row.category_slug,
    category: db.prepare('SELECT name FROM nb_categories WHERE slug=?').get(row.category_slug)?.name || row.category_slug,
    tagline: row.tagline, description: row.description, emoji: row.emoji, tone: row.tone,
    rating: row.rating, reviewCount: row.review_count, verified: Boolean(row.verified), isOpen: Boolean(row.is_open),
    opensAt: row.opens_at, closesAt: row.closes_at, prepMinutes: row.prep_minutes,
    deliveryEnabled: Boolean(row.delivery_enabled), pickupEnabled: Boolean(row.pickup_enabled),
    deliveryFee: row.delivery_fee_paise, freeDeliveryOver: row.free_delivery_over_paise,
    pickupFee: row.pickup_fee_paise, minOrder: row.min_order_paise, radiusKm: row.radius_km,
    address: row.address, locality: row.locality, city: row.city, pincode: row.pincode,
    lat: row.lat, lng: row.lng, distanceKm, serviceable, servicePincodes: row.service_pincodes,
    badge: row.badge, productCount: Number(counts?.total || 0), inStockCount: Number(counts?.in_stock || 0),
    phone, ownerName, directionsUrl
  };
}

function productCard(row, opts = {}) {
  if (!row) return null;
  const shop = opts.shop || db.prepare('SELECT * FROM nb_shops WHERE id=?').get(row.shop_id);
  const available = Math.max(0, Number(row.stock) - Number(row.reserved || 0));
  const discount = row.mrp_paise && row.mrp_paise > row.price_paise
    ? Math.round(((row.mrp_paise - row.price_paise) / row.mrp_paise) * 100) : 0;
  return {
    id: row.id, name: row.name, brand: row.brand, categorySlug: row.category_slug,
    category: db.prepare('SELECT name FROM nb_categories WHERE slug=?').get(row.category_slug)?.name || row.category_slug,
    compareKey: row.compare_key, unit: row.unit, packSize: row.pack_size, emoji: row.emoji,
    imageUrl: row.image_url, price: row.price_paise, mrp: row.mrp_paise, discount,
    taxRate: row.tax_rate, stock: available, lowStock: available > 0 && available <= row.low_stock,
    available: available > 0, returnDays: row.return_days, rating: row.rating, reviewCount: row.review_count,
    highlights: parseJsonArray(row.highlights).slice(0, 3), specs: parseJsonArray(row.specs).slice(0, 3),
    shop: shop ? { id: shop.id, slug: shop.slug, name: shop.name, emoji: shop.emoji, tone: shop.tone, rating: shop.rating, verified: Boolean(shop.verified), isOpen: Boolean(shop.is_open) } : null,
    distanceKm: opts.location && shop ? haversineKm(Number(opts.location.lat), Number(opts.location.lng), shop.lat, shop.lng) : null,
    deliveryEnabled: shop ? Boolean(shop.delivery_enabled) : false,
    pickupEnabled: shop ? Boolean(shop.pickup_enabled) : false,
    isDemo: Boolean(row.is_demo)
  };
}

function userPayload(s) {
  if (!s) return null;
  const profile = db.prepare('SELECT * FROM nb_customer_profiles WHERE user_id=?').get(s.user_id);
  return {
    id: s.user_id, role: s.role, name: s.name, email: s.email, phone: s.phone, avatar: s.avatar || '👤',
    emailVerified: Boolean(db.prepare('SELECT email_verified FROM nb_users WHERE id=?').get(s.user_id)?.email_verified),
    phoneVerified: Boolean(db.prepare('SELECT phone_verified FROM nb_users WHERE id=?').get(s.user_id)?.phone_verified),
    marketingOptIn: profile ? Boolean(profile.marketing_opt_in) : true,
    orderUpdates: profile ? Boolean(profile.order_updates) : true,
    csrf: s.csrf
  };
}

function categoryList() {
  return db.prepare('SELECT * FROM nb_categories WHERE active=1 ORDER BY sort').all().map((c) => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM nb_products WHERE category_slug=? AND active=1').get(c.slug);
    const shops = db.prepare('SELECT COUNT(DISTINCT shop_id) AS n FROM nb_products WHERE category_slug=? AND active=1').get(c.slug);
    return { slug: c.slug, name: c.name, icon: c.icon, tone: c.tone, productCount: Number(count?.n || 0), shopCount: Number(shops?.n || 0) };
  });
}

function locationFromQuery(q) {
  const pincode = q.get('pincode') || '';
  const lat = Number(q.get('lat'));
  const lng = Number(q.get('lng'));
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
  let locality = q.get('locality') || '';
  let city = q.get('city') || 'New Delhi';
  let resolvedPin = pincode;
  if (pincodeOk(pincode)) {
    const area = pincodeArea(pincode);
    if (area) {
      locality = locality || area.locality;
      city = area.city;
      if (!hasCoords) return { pincode, locality, city, lat: area.lat, lng: area.lng };
    }
  }
  if (!hasCoords && !pincode) return null;
  return {
    pincode: resolvedPin || '',
    locality, city,
    lat: hasCoords ? lat : null,
    lng: hasCoords ? lng : null
  };
}

function pincodeMatchesShop(shop, pincode) {
  if (!pincode) return true;
  return String(shop.service_pincodes || '').split(',').map((s) => s.trim()).includes(String(pincode));
}

/* ------------------------------------------------------------------ */
/* Catalogue queries                                                   */
/* ------------------------------------------------------------------ */

function queryShops({ location, category, q, sort = 'distance', open, delivery, pickup, verified, minRating, maxDistance, includeUnserviceable, limit = 12, page = 1 }) {
  const where = [];
  const params = [];
  if (category) { where.push('s.category_slug=?'); params.push(category); }
  if (q) {
    where.push('(LOWER(s.name) LIKE ? OR LOWER(s.tagline) LIKE ? OR LOWER(s.locality) LIKE ? OR LOWER(s.category_slug) LIKE ?)');
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like, like);
  }
  if (open === '1') where.push('s.is_open=1');
  if (delivery === '1') where.push('s.delivery_enabled=1');
  if (pickup === '1') where.push('s.pickup_enabled=1');
  if (verified === '1') where.push('s.verified=1');
  if (minRating) { where.push('s.rating>=?'); params.push(Number(minRating)); }
  const sql = `SELECT s.* FROM nb_shops s ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  let rows = db.prepare(sql).all(...params).map(shopRow);
  let cards = rows.map((r) => shopCard(r, location));
  if (location) {
    if (!includeUnserviceable) cards = cards.filter((c) => c.serviceable);
    if (maxDistance) cards = cards.filter((c) => c.distanceKm == null || c.distanceKm <= Number(maxDistance));
  } else if (maxDistance) {
    cards = cards.filter(() => true);
  }
  if (sort === 'rating') cards.sort((a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount);
  else if (sort === 'name') cards.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'prep') cards.sort((a, b) => a.prepMinutes - b.prepMinutes);
  else cards.sort((a, b) => (a.distanceKm == null ? 99 : a.distanceKm) - (b.distanceKm == null ? 99 : b.distanceKm) || b.rating - a.rating);
  const total = cards.length;
  const start = (Math.max(1, page) - 1) * limit;
  return { shops: cards.slice(start, start + limit), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

function queryProducts({ location, q, category, shop, brand, minPrice, maxPrice, rating, available, delivery, pickup, sort = 'relevance', limit = 12, page = 1, compareKey }) {
  const where = ['p.active=1', 's.is_open IN (0,1)'];
  const params = [];
  if (compareKey) { where.push('p.compare_key=?'); params.push(compareKey); }
  if (category) { where.push('p.category_slug=?'); params.push(category); }
  if (shop) { where.push('s.slug=?'); params.push(shop); }
  if (brand) { where.push('LOWER(p.brand)=?'); params.push(String(brand).toLowerCase()); }
  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    where.push('(LOWER(p.name) LIKE ? OR LOWER(p.brand) LIKE ? OR LOWER(p.category_slug) LIKE ? OR LOWER(p.description) LIKE ? OR LOWER(s.name) LIKE ?)');
    params.push(like, like, like, like, like);
  }
  if (minPrice) { where.push('p.price_paise>=?'); params.push(Math.round(Number(minPrice) * 100)); }
  if (maxPrice) { where.push('p.price_paise<=?'); params.push(Math.round(Number(maxPrice) * 100)); }
  if (rating) { where.push('p.rating>=?'); params.push(Number(rating)); }
  if (available === '1') where.push('(p.stock-p.reserved)>0');
  if (delivery === '1') where.push('s.delivery_enabled=1');
  if (pickup === '1') where.push('s.pickup_enabled=1');
  const rows = db.prepare(`SELECT p.*, s.name AS shop_name, s.slug AS shop_slug, s.lat AS shop_lat, s.lng AS shop_lng,
      s.delivery_enabled, s.pickup_enabled, s.service_pincodes, s.radius_km, s.is_open, s.rating AS shop_rating
    FROM nb_products p JOIN nb_shops s ON s.id=p.shop_id
    WHERE ${where.join(' AND ')}`).all(...params);
  let items = rows.map((r) => productCard(r, { location }));
  if (location && location.pincode) {
    items = items.filter((i) => {
      const s = rows.find((r) => r.id === i.id);
      return pincodeMatchesShop(s, location.pincode);
    });
  }
  if (sort === 'price_low') items.sort((a, b) => a.price - b.price);
  else if (sort === 'price_high') items.sort((a, b) => b.price - a.price);
  else if (sort === 'rating') items.sort((a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount);
  else if (sort === 'popularity') items.sort((a, b) => b.reviewCount - a.reviewCount || b.rating - a.rating);
  else if (sort === 'discount') items.sort((a, b) => b.discount - a.discount);
  else if (sort === 'distance') items.sort((a, b) => (a.distanceKm == null ? 99 : a.distanceKm) - (b.distanceKm == null ? 99 : b.distanceKm));
  else if (sort === 'nearest') items.sort((a, b) => (a.distanceKm == null ? 99 : a.distanceKm) - (b.distanceKm == null ? 99 : b.distanceKm));
  else items.sort((a, b) => (b.available - a.available) || b.rating - a.rating);
  const total = items.length;
  const start = (Math.max(1, page) - 1) * limit;
  return { products: items.slice(start, start + limit), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

function activeOffers(location) {
  const at = now();
  const rows = db.prepare(`SELECT * FROM nb_coupons WHERE active=1 AND starts_at<=? AND ends_at>=? AND (usage_limit IS NULL OR used_count<usage_limit) ORDER BY ends_at ASC`).all(at, at);
  return rows.map((c) => {
    const shop = c.shop_id ? db.prepare('SELECT name, slug FROM nb_shops WHERE id=?').get(c.shop_id) : null;
    const redemptions = db.prepare('SELECT COUNT(*) AS n FROM nb_coupon_redemptions WHERE coupon_code=?').get(c.code);
    return {
      code: c.code, title: c.title, description: c.description, type: c.type, value: c.value,
      minOrder: c.min_order_paise, maxDiscount: c.max_discount_paise,
      shop: shop ? { name: shop.name, slug: shop.slug } : null,
      endsAt: c.ends_at, startsAt: c.starts_at, usedCount: Number(redemptions?.n || 0),
      usageLimit: c.usage_limit,
      savingsLabel: (c.promo_type === 'bogo' || c.type === 'bogo')
        ? `Buy ${c.buy_qty || 1} get ${c.get_qty || 1} free`
        : c.type === 'percent' ? `${c.value}% off${c.max_discount_paise ? ' up to ₹' + Math.round(c.max_discount_paise / 100) : ''}`
          : c.type === 'fixed' ? `₹${Math.round(c.value / 100)} off` : 'Free delivery',
      expiringSoon: new Date(c.ends_at).getTime() - Date.now() < 3 * 864e5
    };
  });
}

/* ------------------------------------------------------------------ */
/* Cart + pricing                                                      */
/* ------------------------------------------------------------------ */

function getCartRow(userId, create = false) {
  let row = db.prepare('SELECT * FROM nb_carts WHERE user_id=?').get(userId);
  if (!row && create) {
    db.prepare('INSERT INTO nb_carts(user_id,coupon_code,updated_at) VALUES(?,NULL,?)').run(userId, now());
    row = db.prepare('SELECT * FROM nb_carts WHERE user_id=?').get(userId);
  }
  return row;
}

function cartLines(userId) {
  return db.prepare(`SELECT ci.qty, p.*, s.name AS shop_name, s.slug AS shop_slug, s.emoji AS shop_emoji, s.tone AS shop_tone,
      s.is_open AS shop_open, s.delivery_enabled, s.pickup_enabled, s.delivery_fee_paise, s.free_delivery_over_paise,
      s.pickup_fee_paise, s.min_order_paise, s.prep_minutes, s.service_pincodes, s.radius_km, s.lat AS shop_lat, s.lng AS shop_lng
    FROM nb_cart_items ci JOIN nb_products p ON p.id=ci.product_id JOIN nb_shops s ON s.id=p.shop_id
    WHERE ci.user_id=? ORDER BY s.name, ci.created_at`).all(userId);
}

function parseJsonArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return String(v).split(',').map((s) => s.trim()).filter(Boolean); }
}

function couponEligibleRows(coupon, cartRows) {
  let rows = coupon.shop_id ? cartRows.filter((r) => r.shop_id === coupon.shop_id) : cartRows.slice();
  const productIds = parseJsonArray(coupon.product_ids);
  const categorySlugs = parseJsonArray(coupon.category_slugs);
  if (productIds.length) rows = rows.filter((r) => productIds.includes(r.id));
  else if (categorySlugs.length) rows = rows.filter((r) => categorySlugs.includes(r.category_slug));
  return rows;
}

function couponUsable(coupon, userId, cartRows, subtotal) {
  if (!coupon || !coupon.active) return { ok: false, message: 'This coupon is not valid.' };
  const at = Date.now();
  if (new Date(coupon.starts_at).getTime() > at) return { ok: false, message: 'This offer has not started yet.' };
  if (new Date(coupon.ends_at).getTime() < at) return { ok: false, message: 'This coupon has expired.' };
  if (coupon.usage_limit != null && coupon.used_count >= coupon.usage_limit) return { ok: false, message: 'This coupon has reached its usage limit.' };
  const mine = db.prepare('SELECT COUNT(*) AS n FROM nb_coupon_redemptions WHERE coupon_code=? AND user_id=?').get(coupon.code, userId);
  if (coupon.per_customer_limit && Number(mine?.n || 0) >= coupon.per_customer_limit) return { ok: false, message: 'You have already used this coupon.' };
  if (coupon.shop_id) {
    const has = cartRows.some((r) => r.shop_id === coupon.shop_id);
    if (!has) return { ok: false, message: 'This coupon only applies to items from a specific shop.' };
  }
  const eligible = couponEligibleRows(coupon, cartRows);
  const eligibleSubtotal = eligible.reduce((t, r) => t + r.price_paise * r.qty, 0);
  const productIds = parseJsonArray(coupon.product_ids);
  const categorySlugs = parseJsonArray(coupon.category_slugs);
  if ((productIds.length || categorySlugs.length) && !eligible.length) {
    return { ok: false, message: `This offer only applies to ${productIds.length ? 'selected products' : 'selected categories'}.` };
  }
  const baseForMin = (productIds.length || categorySlugs.length) ? eligibleSubtotal : (coupon.shop_id ? eligibleSubtotal : subtotal);
  if (baseForMin < coupon.min_order_paise) {
    const scope = coupon.shop_id ? ' from this shop' : '';
    return { ok: false, message: `Add ₹${Math.ceil((coupon.min_order_paise - baseForMin) / 100)} more${scope} to use ${coupon.code}.` };
  }
  if (coupon.promo_type === 'bogo' || coupon.type === 'bogo') {
    const buy = Number(coupon.buy_qty || 1);
    const get = Number(coupon.get_qty || 1);
    const units = [];
    for (const r of eligible) for (let i = 0; i < r.qty; i++) units.push(r.price_paise);
    units.sort((a, b) => a - b);
    const groups = Math.floor(units.length / (buy + get));
    if (groups < 1) return { ok: false, message: `Add ${buy + get} eligible items to use this buy-one-get-one offer.` };
  }
  return { ok: true, eligibleSubtotal };
}

function bogoDiscount(coupon, eligibleRows) {
  const buy = Number(coupon.buy_qty || 1);
  const get = Number(coupon.get_qty || 1);
  const units = [];
  for (const r of eligibleRows) for (let i = 0; i < r.qty; i++) units.push(r.price_paise);
  units.sort((a, b) => a - b);
  const groups = Math.floor(units.length / (buy + get));
  let discount = 0;
  for (let g = 0; g < groups; g++) {
    for (let i = 0; i < get; i++) discount += units[g * (buy + get) + i] || 0;
  }
  if (coupon.max_discount_paise) discount = Math.min(discount, coupon.max_discount_paise);
  return discount;
}

function priceCart(userId, opts = {}) {
  const rows = cartLines(userId);
  const cart = getCartRow(userId);
  const couponCode = opts.couponCode !== undefined ? opts.couponCode : cart?.coupon_code;
  const location = opts.location || null;
  const fulfillmentMap = opts.fulfillment || {};
  const coupon = couponCode ? db.prepare('SELECT * FROM nb_coupons WHERE code=?').get(couponCode) : null;
  const subtotal = rows.reduce((t, r) => t + r.price_paise * r.qty, 0);
  const couponCheck = coupon ? couponUsable(coupon, userId, rows, subtotal) : null;
  const usableCoupon = couponCheck?.ok ? coupon : null;

  const byShop = new Map();
  for (const r of rows) {
    if (!byShop.has(r.shop_id)) byShop.set(r.shop_id, []);
    byShop.get(r.shop_id).push(r);
  }

  const shopCoupon = usableCoupon?.shop_id || null;
  const eligibleSubtotal = couponCheck?.eligibleSubtotal != null ? couponCheck.eligibleSubtotal : subtotal;
  const eligibleRows = usableCoupon ? couponEligibleRows(usableCoupon, rows) : [];
  const isBogo = usableCoupon && (usableCoupon.promo_type === 'bogo' || usableCoupon.type === 'bogo');
  const platformDiscountTotal = usableCoupon && !shopCoupon && usableCoupon.type !== 'free_delivery'
    ? (isBogo ? bogoDiscount(usableCoupon, eligibleRows)
      : Math.min(usableCoupon.type === 'percent' ? Math.floor((eligibleSubtotal * usableCoupon.value) / 100) : usableCoupon.value,
        usableCoupon.max_discount_paise || Infinity, eligibleSubtotal))
    : 0;

  const groups = [];
  for (const [shopId, lines] of byShop) {
    const first = lines[0];
    const shopSubtotal = lines.reduce((t, r) => t + r.price_paise * r.qty, 0);
    const fulfillment = fulfillmentMap[shopId] === 'pickup' ? 'pickup' : 'delivery';
    let discount = 0;
    if (usableCoupon && shopCoupon === shopId && usableCoupon.type !== 'free_delivery') {
      const shopEligible = eligibleRows.filter((r) => r.shop_id === shopId);
      const shopEligibleSub = shopEligible.reduce((t, r) => t + r.price_paise * r.qty, 0);
      discount = isBogo ? bogoDiscount(usableCoupon, shopEligible)
        : Math.min(usableCoupon.type === 'percent' ? Math.floor((shopEligibleSub * usableCoupon.value) / 100) : usableCoupon.value,
          usableCoupon.max_discount_paise || Infinity, shopEligibleSub);
    } else if (platformDiscountTotal > 0) {
      discount = subtotal > 0 ? Math.round((platformDiscountTotal * shopSubtotal) / subtotal) : 0;
    }
    const freeDelivery = usableCoupon?.type === 'free_delivery';
    let deliveryFee = 0;
    if (fulfillment === 'delivery') {
      deliveryFee = first.delivery_fee_paise;
      if (first.free_delivery_over_paise != null && shopSubtotal - discount >= first.free_delivery_over_paise) deliveryFee = 0;
      if (freeDelivery) deliveryFee = 0;
    } else {
      deliveryFee = first.pickup_fee_paise;
    }
    let tax = 0;
    for (const r of lines) {
      const line = r.price_paise * r.qty;
      const share = shopSubtotal > 0 ? line / shopSubtotal : 0;
      const taxable = Math.max(0, line - discount * share);
      tax += Math.round((taxable * r.tax_rate) / 100);
    }
    const available = lines.map((r) => Math.max(0, r.stock - r.reserved) >= r.qty).every(Boolean);
    const minOrderMet = shopSubtotal >= first.min_order_paise;
    groups.push({
      shop: {
        id: shopId, name: first.shop_name, slug: first.shop_slug, emoji: first.shop_emoji, tone: first.shop_tone,
        isOpen: Boolean(first.shop_open), deliveryEnabled: Boolean(first.delivery_enabled), pickupEnabled: Boolean(first.pickup_enabled),
        deliveryFee: first.delivery_fee_paise, freeDeliveryOver: first.free_delivery_over_paise,
        pickupFee: first.pickup_fee_paise, minOrder: first.min_order_paise, prepMinutes: first.prep_minutes
      },
      fulfillment,
      fulfillmentOptions: [
        ...(first.delivery_enabled ? ['delivery'] : []),
        ...(first.pickup_enabled ? ['pickup'] : [])
      ],
      subtotal: shopSubtotal, discount, deliveryFee, tax,
      total: Math.max(0, shopSubtotal - discount + deliveryFee + tax),
      minOrderMet, minOrder: first.min_order_paise,
      available,
      etaMinutes: first.prep_minutes + (fulfillment === 'delivery' ? 18 : 0),
      items: lines.map((r) => ({
        productId: r.id, name: r.name, brand: r.brand, emoji: r.emoji, imageUrl: r.image_url,
        unit: r.unit, price: r.price_paise, mrp: r.mrp_paise, qty: r.qty, moveToWishlist: false,
        stock: Math.max(0, r.stock - r.reserved), available: Math.max(0, r.stock - r.reserved) >= r.qty,
        lineTotal: r.price_paise * r.qty, taxRate: r.tax_rate, categorySlug: r.category_slug
      }))
    });
  }

  const discountTotal = groups.reduce((t, g) => t + g.discount, 0);
  const deliveryTotal = groups.reduce((t, g) => t + g.deliveryFee, 0);
  const taxTotal = groups.reduce((t, g) => t + g.tax, 0);
  const total = groups.reduce((t, g) => t + g.total, 0);
  const itemCount = rows.reduce((t, r) => t + r.qty, 0);
  const issues = [];
  for (const g of groups) {
    if (!g.fulfillmentOptions.includes(g.fulfillment)) issues.push(`${g.shop.name} does not offer ${g.fulfillment}.`);
    if (!g.minOrderMet) issues.push(`${g.shop.name} has a minimum order of ₹${Math.round(g.minOrder / 100)}. Add ₹${Math.ceil((g.minOrder - g.subtotal) / 100)} more.`);
    if (!g.available) issues.push(`Some items from ${g.shop.name} are no longer available in the quantity requested.`);
  }
  if (coupon && !usableCoupon) issues.push(couponCheck.message);

  return {
    items: rows.length, itemCount, subtotal, discount: discountTotal, deliveryFee: deliveryTotal,
    tax: taxTotal, total, groups, issues,
    coupon: usableCoupon ? {
      code: usableCoupon.code, title: usableCoupon.title, type: usableCoupon.type,
      promoType: usableCoupon.promo_type || usableCoupon.type,
      value: usableCoupon.value, shopId: usableCoupon.shop_id,
      description: usableCoupon.description, endsAt: usableCoupon.ends_at
    } : null,
    rejectedCoupon: coupon && !usableCoupon ? { code: coupon.code, message: couponCheck.message } : null,
    freeDelivery: usableCoupon?.type === 'free_delivery'
  };
}

/* ------------------------------------------------------------------ */
/* Notifications, events, OTP                                          */
/* ------------------------------------------------------------------ */

function notify(userId, title, body, type = 'order', link = '#/orders') {
  if (!userId) return;
  db.prepare('INSERT INTO nb_notifications(user_id,title,body,type,link,is_read,created_at) VALUES(?,?,?,?,?,0,?)')
    .run(userId, title, body, type, link, now());
}

function addEvent(orderId, sellerOrderId, status, label, detail, actor = 'system') {
  db.prepare('INSERT INTO nb_order_events(order_id,seller_order_id,status,label,detail,actor,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(orderId, sellerOrderId, status, label, detail || null, actor, now());
  db.prepare('UPDATE nb_orders SET updated_at=? WHERE id=?').run(now(), orderId);
}

function orderEvents(orderId) {
  return db.prepare('SELECT * FROM nb_order_events WHERE order_id=? ORDER BY id ASC').all(orderId).map((e) => ({
    status: e.status, label: e.label, detail: e.detail, actor: e.actor, at: e.created_at, sellerOrderId: e.seller_order_id
  }));
}



/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */

const PARENT_ORDER = {
  placed: 'Order placed', accepted: 'Seller accepted', preparing: 'Preparing order',
  ready: 'Ready', runner_requested: 'Finding a delivery partner', runner_assigned: 'Delivery partner assigned',
  picked_up: 'Picked up', out_for_delivery: 'Out for delivery', delivered: 'Delivered',
  completed: 'Completed', delivered: 'Delivered', in_progress: 'Partially delivered',
  cancelled: 'Cancelled', partially_cancelled: 'Partially cancelled'
};

function deriveStatus(sellerOrders) {
  if (!sellerOrders.length) return 'placed';
  const active = sellerOrders.filter((o) => !['cancelled', 'rejected'].includes(o.status));
  if (!active.length) return 'cancelled';
  const dead = sellerOrders.filter((o) => ['cancelled', 'rejected'].includes(o.status));
  if (active.every((o) => ['completed', 'delivered'].includes(o.status))) {
    return active.every((o) => o.status === 'completed') ? 'completed' : 'delivered';
  }
  if (active.some((o) => ['delivered', 'completed'].includes(o.status))) return 'in_progress';
  if (active.some((o) => ['out_for_delivery', 'picked_up', 'arriving_soon'].includes(o.status))) return 'out_for_delivery';
  if (active.some((o) => o.status === 'runner_assigned')) return 'runner_assigned';
  if (active.some((o) => o.status === 'runner_requested')) return 'runner_requested';
  if (active.some((o) => o.status === 'ready')) return 'ready';
  if (active.some((o) => o.status === 'preparing')) return 'preparing';
  if (active.some((o) => o.status === 'accepted')) return dead.length ? 'partially_cancelled' : 'accepted';
  return dead.length ? 'partially_cancelled' : 'placed';
}

function maskedPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d]/g, '');
  return digits.length >= 10 ? `••••••${digits.slice(-4)}` : null;
}

function fulfillmentLabel(sellerOrder) {
  return sellerOrder.fulfillment === 'pickup' ? 'Store pickup' : 'Home delivery';
}

function sellerOrderDetail(so, opts = {}) {
  const order = db.prepare('SELECT * FROM nb_orders WHERE id=?').get(so.order_id);
  const shop = db.prepare('SELECT * FROM nb_shops WHERE id=?').get(so.shop_id);
  const items = db.prepare('SELECT * FROM nb_order_items WHERE seller_order_id=? ORDER BY id').all(so.id).map((i) => ({
    id: i.id, productId: i.product_id, name: i.name, brand: i.brand, unit: i.unit, qty: i.qty,
    price: i.price_paise, mrp: i.mrp_paise, lineTotal: i.line_total_paise, emoji: i.emoji,
    imageUrl: i.image_url, taxRate: i.tax_rate, compareKey: i.compare_key
  }));
  const events = db.prepare(`SELECT * FROM nb_order_events WHERE (seller_order_id=? OR (order_id=? AND seller_order_id IS NULL)) ORDER BY id`).all(so.id, order.id)
    .map((e) => ({ status: e.status, label: e.label, detail: e.detail, at: e.created_at, actor: e.actor }));
  const runner = so.runner_id ? db.prepare(`SELECT u.name, u.phone, u.avatar, r.vehicle, r.rating, r.lat, r.lng
    FROM nb_users u LEFT JOIN nb_runners r ON r.user_id=u.id WHERE u.id=?`).get(so.runner_id) : null;
  const lastTracking = db.prepare('SELECT * FROM nb_delivery_tracking WHERE seller_order_id=? ORDER BY id DESC LIMIT 1').get(so.id);
  const canCancel = ['placed', 'accepted'].includes(so.status);
  const deliveredAt = so.delivered_at || so.completed_at;
  const alreadyReturned = new Set(db.prepare("SELECT item_id FROM nb_returns WHERE seller_order_id=? AND status NOT IN ('rejected','cancelled')").all(so.id).map((r) => r.item_id));
  const returnableItems = items.filter((i) => {
    if (alreadyReturned.has(i.id)) return false;
    const product = db.prepare('SELECT return_days FROM nb_products WHERE id=?').get(i.productId);
    const days = product ? product.return_days : 0;
    if (!days || !deliveredAt) return false;
    return Date.now() - new Date(deliveredAt).getTime() <= days * 864e5;
  });
  const canReturn = returnableItems.length > 0;
  let deliveryOtp = null;
  let pickupCode = null;
  if (opts.includeCodes) {
    if (so.fulfillment === 'delivery' && ['runner_assigned', 'picked_up', 'out_for_delivery', 'arriving_soon'].includes(so.status)) {
      deliveryOtp = deriveCode('delivery', so.id, 6);
    }
    if (so.fulfillment === 'pickup' && ['ready', 'ready_dispatch'].includes(so.status)) {
      pickupCode = deriveCode('pickup', so.id, 6);
    }
  }
  return {
    id: so.id, code: so.code, parentCode: order.code, shop: shopCard(shop, null),
    status: so.status,
    statusLabel: so.status === 'ready' ? (so.fulfillment === 'delivery' ? 'Ready for dispatch' : 'Ready for pickup') : STATUS_LABELS[so.status] || so.status,
    fulfillment: so.fulfillment, fulfillmentLabel: fulfillmentLabel(so),
    subtotal: so.subtotal_paise, discount: so.discount_paise, deliveryFee: so.delivery_fee_paise,
    tax: so.tax_paise, total: so.total_paise, prepMinutes: so.prep_minutes,
    readyAt: so.ready_at, acceptedAt: so.accepted_at, rejectedReason: so.rejected_reason,
    cancelledAt: so.cancelled_at, deliveredAt, createdAt: so.created_at, updatedAt: so.updated_at,
    items, events, canCancel, canReturn, returnableItemIds: returnableItems.map((i) => i.id),
    runner: runner ? {
      name: runner.name, avatar: runner.avatar || '🛵', phoneMasked: maskedPhone(runner.phone),
      vehicle: runner.vehicle, rating: runner.rating,
      lastLocation: lastTracking && lastTracking.lat != null ? { lat: lastTracking.lat, lng: lastTracking.lng, at: lastTracking.created_at } : null
    } : null,
    deliveryOtp, pickupCode,
    estimatedOver: so.fulfillment === 'delivery' ? 18 : 0
  };
}

function orderSummary(order, opts = {}) {
  const sellerOrders = db.prepare('SELECT * FROM nb_seller_orders WHERE order_id=? ORDER BY created_at').all(order.id);
  const status = deriveStatus(sellerOrders);
  const shops = sellerOrders.map((so) => {
    const shop = db.prepare('SELECT * FROM nb_shops WHERE id=?').get(so.shop_id);
    return {
      id: so.id, code: so.code, shop: shop ? { id: shop.id, slug: shop.slug, name: shop.name, emoji: shop.emoji } : null,
      status: so.status, statusLabel: STATUS_LABELS[so.status] || so.status, fulfillment: so.fulfillment,
      total: so.total_paise, items: db.prepare('SELECT * FROM nb_order_items WHERE seller_order_id=?').all(so.id).map((i) => ({
        name: i.name, qty: i.qty, emoji: i.emoji, imageUrl: i.image_url, price: i.price_paise
      }))
    };
  });
  const itemCount = db.prepare('SELECT SUM(qty) AS n FROM nb_order_items WHERE order_id=?').get(order.id);
  return {
    id: order.id, code: order.code, status, statusLabel: PARENT_ORDER[status] || status,
    createdAt: order.created_at, updatedAt: order.updated_at,
    paymentMethod: order.payment_method, paymentStatus: order.payment_status,
    subtotal: order.subtotal_paise, discount: order.discount_paise, deliveryFee: order.delivery_fee_paise,
    tax: order.tax_paise, total: order.total_paise, couponCode: order.coupon_code,
    isDemo: Boolean(order.is_demo), itemCount: Number(itemCount?.n || 0), shops,
    canCancelAny: sellerOrders.some((s) => ['placed', 'accepted'].includes(s.status)),
    canReturnAny: sellerOrders.some((s) => ['delivered', 'completed'].includes(s.status)),
    hasReviewPrompt: sellerOrders.some((s) => ['delivered', 'completed'].includes(s.status))
  };
}

function orderDetail(order, opts = {}) {
  const summary = orderSummary(order);
  const address = JSON.parse(order.address_json);
  const sellerOrders = db.prepare('SELECT * FROM nb_seller_orders WHERE order_id=? ORDER BY created_at').all(order.id);
  const payments = db.prepare('SELECT * FROM nb_payment_records WHERE order_id=? ORDER BY created_at ASC, rowid ASC').all(order.id).map((p) => ({
    id: p.id, provider: p.provider, method: p.method, amount: p.amount_paise, status: p.status, reference: p.reference, at: p.created_at, updatedAt: p.updated_at
  }));
  return {
    ...summary, address, note: order.note, events: orderEvents(order.id),
    sellerOrders: sellerOrders.map((so) => sellerOrderDetail(so, opts)),
    payments,
    receiptUrl: `/api/customer/orders/${encodeURIComponent(order.code)}/receipt`
  };
}

function orderByCode(code, userId) {
  const order = db.prepare('SELECT * FROM nb_orders WHERE code=?').get(code);
  if (!order) fail(404, 'Order not found');
  if (userId && order.customer_id !== userId) fail(403, 'This order belongs to another account');
  return order;
}

function addressDetail(row) {
  if (!row) return null;
  return {
    id: row.id, label: row.label, receiver: row.receiver, phone: row.phone, line1: row.line1, line2: row.line2,
    locality: row.locality, city: row.city, pincode: row.pincode, landmark: row.landmark,
    instructions: row.instructions, lat: row.lat, lng: row.lng, isDefault: Boolean(row.is_default)
  };
}

function addressList(userId) {
  return db.prepare('SELECT * FROM nb_addresses WHERE user_id=? ORDER BY is_default DESC, created_at DESC').all(userId).map(addressDetail);
}

function selectAddress(userId, addressId) {
  const address = db.prepare('SELECT * FROM nb_addresses WHERE id=? AND user_id=?').get(String(addressId || ''), userId);
  if (!address) fail(400, 'Choose a delivery address saved to your account');
  return address;
}

function quoteFor(userId, payload) {
  const address = selectAddress(userId, payload.addressId);
  const fulfillment = payload.fulfillment && typeof payload.fulfillment === 'object' ? payload.fulfillment : {};
  const priced = priceCart(userId, { fulfillment, couponCode: payload.couponCode, location: { pincode: address.pincode, lat: address.lat, lng: address.lng } });
  if (!priced.groups.length) fail(409, 'Your cart is empty');
  const serviceIssues = [];
  for (const g of priced.groups) {
    const shop = db.prepare('SELECT * FROM nb_shops WHERE id=?').get(g.shop.id);
    if (!shop.is_open) serviceIssues.push(`${shop.name} is currently closed.`);
    if (g.fulfillment === 'delivery') {
      const distance = haversineKm(address.lat, address.lng, shop.lat, shop.lng);
      const pins = String(shop.service_pincodes || '').split(',').map((s) => s.trim());
      const inArea = pins.includes(address.pincode);
      const inRadius = distance == null || distance <= shop.radius_km + 0.75;
      if (!inArea || !inRadius) {
        serviceIssues.push(`${shop.name} does not deliver to ${address.pincode}${distance != null ? ` (${distance} km away)` : ''}. Choose store pickup or another shop.`);
      }
    }
  }
  const paymentOptions = [
    { id: 'cod', label: 'Cash on delivery', enabled: true, note: 'Pay the seller or runner in cash when your order arrives.' },
    { id: 'pay_at_store', label: 'Pay at store', enabled: priced.groups.every((g) => g.fulfillment === 'pickup'), note: priced.groups.every((g) => g.fulfillment === 'pickup') ? 'Pay at the counter when you collect.' : 'Only available when every shop in this order is set to store pickup.' },
    { id: 'online', label: 'UPI, cards, net banking & wallets', enabled: GATEWAY.configured, note: GATEWAY.configured ? 'Secured by Razorpay. Payment is confirmed by the gateway webhook.' : 'Online payment is not configured for this deployment. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET on the server to enable it.' }
  ];
  return {
    address: addressDetail(address), groups: priced.groups, subtotal: priced.subtotal, discount: priced.discount,
    deliveryFee: priced.deliveryFee, tax: priced.tax, total: priced.total, coupon: priced.coupon,
    rejectedCoupon: priced.rejectedCoupon, issues: [...priced.issues, ...serviceIssues],
    serviceIssues, paymentOptions, itemCount: priced.itemCount
  };
}

function newOrderCode() {
  const d = new Date();
  const stamp = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  for (let i = 0; i < 8; i++) {
    const code = `NB-${stamp}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
    if (!db.prepare('SELECT 1 FROM nb_orders WHERE code=?').get(code)) return code;
  }
  return `NB-${stamp}-${Date.now().toString().slice(-4)}`;
}
function newSellerCode() {
  for (let i = 0; i < 8; i++) {
    const code = `ORD-${String(Math.floor(Math.random() * 900000) + 100000)}`;
    if (!db.prepare('SELECT 1 FROM nb_seller_orders WHERE code=?').get(code)) return code;
  }
  return `ORD-${Date.now().toString().slice(-6)}`;
}

function releaseStockForSellerOrder(so) {
  const items = db.prepare('SELECT product_id, qty FROM nb_order_items WHERE seller_order_id=?').all(so.id);
  for (const item of items) {
    if (['accepted', 'preparing', 'ready', 'runner_requested', 'runner_assigned', 'picked_up', 'out_for_delivery'].includes(so.status)) {
      db.prepare('UPDATE nb_products SET stock=stock+? WHERE id=?').run(item.qty, item.product_id);
    } else {
      db.prepare('UPDATE nb_products SET reserved=MAX(0,reserved-?) WHERE id=?').run(item.qty, item.product_id);
    }
  }
}

function cancelOpenPaymentRecords(orderId) {
  db.prepare("UPDATE nb_payment_records SET status='cancelled',updated_at=? WHERE order_id=? AND status IN ('pending','created')")
    .run(now(), orderId);
}

function paymentAllocationsForRecord(record, sellerOrders = null) {
  const existing = db.prepare(
    'SELECT seller_order_id AS sellerOrderId, shop_id AS shopId, amount_paise AS amountPaise FROM nb_payment_allocations WHERE payment_record_id=?'
  ).all(record.id);
  if (existing.length) return existing;
  const targets = sellerOrders || resolveSellerOrdersForPaymentRecord(record);
  return allocateAmountAcrossSellerOrders(record.amount_paise, targets);
}

function syncPendingOfflinePayment(orderId) {
  const ts = now();
  const active = db.prepare(
    "SELECT * FROM nb_seller_orders WHERE order_id=? AND status NOT IN ('cancelled','rejected') ORDER BY created_at, id"
  ).all(orderId);
  if (!active.length) return;
  const paidSoIds = new Set(db.prepare(`SELECT DISTINCT pa.seller_order_id
    FROM nb_payment_allocations pa
    JOIN nb_payment_records pr ON pr.id=pa.payment_record_id
    WHERE pa.order_id=? AND pr.status='paid' AND pa.amount_paise > 0`).all(orderId).map((r) => r.seller_order_id));
  const unpaidActive = active.filter((so) => !paidSoIds.has(so.id));
  const pendingRecords = db.prepare(`SELECT * FROM nb_payment_records
    WHERE order_id=? AND seller_order_id IS NULL AND status='pending' AND reference IS NULL`).all(orderId);
  for (const rec of pendingRecords) {
    if (!unpaidActive.length) {
      db.prepare("UPDATE nb_payment_records SET status='superseded',updated_at=? WHERE id=?").run(ts, rec.id);
      syncPaymentAllocations(rec.id, orderId, active, 0, ts);
    } else {
      const remainingTotal = unpaidActive.reduce((sum, so) => sum + Number(so.total_paise || 0), 0);
      db.prepare('UPDATE nb_payment_records SET amount_paise=?,updated_at=? WHERE id=?').run(remainingTotal, ts, rec.id);
      syncPaymentAllocations(rec.id, orderId, unpaidActive, remainingTotal, ts);
    }
  }
  if (!unpaidActive.length && active.every((so) => ['delivered', 'completed'].includes(so.status))) {
    db.prepare("UPDATE nb_orders SET payment_status='paid',updated_at=? WHERE id=? AND payment_status<>'paid'").run(ts, orderId);
  }
}

function allocatedPaidPaiseForSellerOrder(so) {
  const paidRecords = db.prepare("SELECT * FROM nb_payment_records WHERE order_id=? AND status='paid'").all(so.order_id);
  if (!paidRecords.length) {
    const order = db.prepare('SELECT payment_status FROM nb_orders WHERE id=?').get(so.order_id);
    return order && order.payment_status === 'paid' ? Number(so.total_paise || 0) : 0;
  }
  let total = 0;
  for (const pr of paidRecords) {
    const allocs = paymentAllocationsForRecord(pr);
    for (const a of allocs) {
      if (a.sellerOrderId === so.id) total += Number(a.amountPaise || 0);
    }
  }
  return total;
}

function sellerOrderRefundableAmount(so) {
  const paid = allocatedPaidPaiseForSellerOrder(so);
  if (paid <= 0) return 0;
  const existing = db.prepare(`SELECT COALESCE(SUM(r.amount_paise),0) AS n
    FROM nb_refunds r
    LEFT JOIN nb_returns ret ON ret.id=r.return_id
    WHERE COALESCE(r.seller_order_id, ret.seller_order_id)=? AND r.status <> 'rejected'`).get(so.id);
  return Math.max(0, paid - Number(existing?.n || 0));
}

function completedRefundTotalForShop(shopId, { fromIso = null, toIso = null } = {}) {
  let sql = `SELECT COALESCE(SUM(r.amount_paise),0) AS n
    FROM nb_refunds r
    LEFT JOIN nb_returns ret ON ret.id=r.return_id
    JOIN nb_seller_orders so ON so.id=COALESCE(r.seller_order_id, ret.seller_order_id)
    WHERE so.shop_id=? AND r.status='completed'`;
  const args = [shopId];
  if (fromIso) { sql += ' AND r.created_at>=?'; args.push(fromIso); }
  if (toIso) { sql += ' AND r.created_at<=?'; args.push(toIso); }
  return Number(db.prepare(sql).get(...args)?.n || 0);
}

function completedRefundTotalForSellerOrder(sellerOrderId) {
  const row = db.prepare(`SELECT COALESCE(SUM(r.amount_paise),0) AS n
    FROM nb_refunds r
    LEFT JOIN nb_returns ret ON ret.id=r.return_id
    WHERE COALESCE(r.seller_order_id, ret.seller_order_id)=? AND r.status='completed'`).get(sellerOrderId);
  return Number(row?.n || 0);
}

function sellerRefundRowsForShop(shopId, limit = 500) {
  return db.prepare(`SELECT r.id, r.order_id, r.return_id, r.amount_paise, r.status, r.reason, r.reference, r.created_at, r.updated_at,
      o.code AS order_code, so.id AS seller_order_id, so.code AS seller_order_code
    FROM nb_refunds r
    LEFT JOIN nb_returns ret ON ret.id=r.return_id
    JOIN nb_seller_orders so ON so.id=COALESCE(r.seller_order_id, ret.seller_order_id)
    JOIN nb_orders o ON o.id=r.order_id
    WHERE so.shop_id=?
    ORDER BY r.created_at DESC, r.rowid DESC
    LIMIT ?`).all(shopId, limit);
}

function sellerPaymentRowsForShop(shopId, limit = null) {
  const persisted = db.prepare(`SELECT pr.id, pr.order_id, pr.provider, pr.method, pr.status, pr.reference, pr.created_at, pr.updated_at,
      pr.amount_paise AS parent_amount_paise,
      pa.amount_paise AS allocated_paise,
      pa.seller_order_id,
      so.code AS seller_code, so.shop_id, so.total_paise AS seller_total_paise,
      so.discount_paise AS seller_discount_paise, so.status AS seller_status,
      o.code AS order_code, o.payment_method, o.total_paise AS order_total
    FROM nb_payment_allocations pa
    JOIN nb_payment_records pr ON pr.id=pa.payment_record_id
    JOIN nb_seller_orders so ON so.id=pa.seller_order_id
    JOIN nb_orders o ON o.id=pr.order_id
    WHERE pa.shop_id=? AND pa.amount_paise > 0
    ORDER BY pr.created_at DESC, pr.rowid DESC`).all(shopId);

  const unallocated = db.prepare(`SELECT pr.*, o.code AS order_code, o.payment_method, o.total_paise AS order_total
    FROM nb_payment_records pr
    JOIN nb_orders o ON o.id=pr.order_id
    WHERE NOT EXISTS (SELECT 1 FROM nb_payment_allocations pa WHERE pa.payment_record_id=pr.id)
      AND (
        (pr.seller_order_id IS NOT NULL AND EXISTS (SELECT 1 FROM nb_seller_orders so WHERE so.id=pr.seller_order_id AND so.shop_id=?))
        OR (pr.seller_order_id IS NULL AND EXISTS (SELECT 1 FROM nb_seller_orders so WHERE so.order_id=pr.order_id AND so.shop_id=?))
      )
    ORDER BY pr.created_at DESC, pr.rowid DESC`).all(shopId, shopId);

  if (!unallocated.length) {
    return limit != null ? persisted.slice(0, limit) : persisted;
  }

  const combined = [...persisted];
  for (const pr of unallocated) {
    const targets = resolveSellerOrdersForPaymentRecord(pr);
    const byId = new Map(targets.map((so) => [so.id, so]));
    for (const alloc of allocateAmountAcrossSellerOrders(pr.amount_paise, targets)) {
      if (alloc.shopId !== shopId || alloc.amountPaise <= 0) continue;
      const so = byId.get(alloc.sellerOrderId);
      if (!so) continue;
      combined.push({
        id: pr.id, order_id: pr.order_id, provider: pr.provider, method: pr.method, status: pr.status,
        reference: pr.reference, created_at: pr.created_at, updated_at: pr.updated_at,
        parent_amount_paise: pr.amount_paise, allocated_paise: alloc.amountPaise,
        seller_order_id: so.id, seller_code: so.code, shop_id: so.shop_id,
        seller_total_paise: so.total_paise, seller_discount_paise: so.discount_paise, seller_status: so.status,
        order_code: pr.order_code, payment_method: pr.payment_method, order_total: pr.order_total
      });
    }
  }
  combined.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return limit != null ? combined.slice(0, limit) : combined;
}

function recordOfflinePaymentPaid(order) {
  const ts = now();
  const activeSellerOrders = db.prepare(
    "SELECT * FROM nb_seller_orders WHERE order_id=? AND status NOT IN ('cancelled','rejected') ORDER BY created_at, id"
  ).all(order.id);
  const paidSoIds = new Set(db.prepare(`SELECT DISTINCT pa.seller_order_id
    FROM nb_payment_allocations pa
    JOIN nb_payment_records pr ON pr.id=pa.payment_record_id
    WHERE pa.order_id=? AND pr.status='paid' AND pa.amount_paise > 0`).all(order.id).map((r) => r.seller_order_id));

  if (activeSellerOrders.length && activeSellerOrders.every((so) => paidSoIds.has(so.id))) {
    db.prepare("UPDATE nb_payment_records SET status='superseded',updated_at=? WHERE order_id=? AND status IN ('pending','created')")
      .run(ts, order.id);
    return;
  }
  const existingParentPaid = db.prepare("SELECT id FROM nb_payment_records WHERE order_id=? AND seller_order_id IS NULL AND status='paid' LIMIT 1").get(order.id);
  if (existingParentPaid) return;

  const targetSellerOrders = activeSellerOrders.length
    ? activeSellerOrders.filter((so) => !paidSoIds.has(so.id))
    : [];
  const paidAmount = targetSellerOrders.length
    ? targetSellerOrders.reduce((sum, so) => sum + Number(so.total_paise || 0), 0)
    : Number(order.total_paise);

  const pendingOffline = db.prepare(`SELECT id FROM nb_payment_records
    WHERE order_id=? AND seller_order_id IS NULL AND provider IN ('cash','store') AND status='pending' AND reference IS NULL
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(order.id);
  if (pendingOffline) {
    db.prepare("UPDATE nb_payment_records SET amount_paise=?,status='paid',updated_at=? WHERE id=?").run(paidAmount, ts, pendingOffline.id);
    db.prepare("UPDATE nb_payment_records SET status='superseded',updated_at=? WHERE order_id=? AND id<>? AND status IN ('pending','created')")
      .run(ts, order.id, pendingOffline.id);
    if (targetSellerOrders.length) syncPaymentAllocations(pendingOffline.id, order.id, targetSellerOrders, paidAmount, ts);
  } else {
    db.prepare("UPDATE nb_payment_records SET status='superseded',updated_at=? WHERE order_id=? AND status IN ('pending','created')")
      .run(ts, order.id);
    const method = order.payment_method === 'pay_at_store' ? 'pay_at_store' : 'cod';
    const provider = method === 'pay_at_store' ? 'store' : 'cash';
    const paymentId = uid();
    db.prepare(`INSERT INTO nb_payment_records(id,order_id,seller_order_id,provider,method,amount_paise,status,reference,created_at,updated_at)
      VALUES(?,?,NULL,?,?,?,'paid',NULL,?,?)`).run(paymentId, order.id, provider, method, paidAmount, ts, ts);
    if (targetSellerOrders.length) syncPaymentAllocations(paymentId, order.id, targetSellerOrders, paidAmount, ts);
  }
}

function validatePaymentEligibility(order) {
  if (!order) fail(404, 'Order not found');
  if (order.is_demo) {
    fail(403, 'Demo orders cannot start real payments. Use cash on delivery or pay at pickup; no money is collected in this sandbox.');
  }
  const paidRecord = db.prepare("SELECT id FROM nb_payment_records WHERE order_id=? AND status='paid' LIMIT 1").get(order.id);
  if (order.payment_status === 'paid' || paidRecord) {
    fail(409, 'There is nothing left to pay for this order.');
  }
  const sellerOrders = db.prepare('SELECT * FROM nb_seller_orders WHERE order_id=? ORDER BY created_at').all(order.id);
  const derivedStatus = sellerOrders.length ? deriveStatus(sellerOrders) : order.status;
  if (['cancelled', 'rejected'].includes(order.status) || derivedStatus === 'cancelled') {
    fail(409, 'This order has been cancelled and cannot be paid.');
  }
  if (['completed', 'delivered'].includes(order.status) || ['completed', 'delivered'].includes(derivedStatus)) {
    fail(409, 'This order is already completed and can no longer start an online payment.');
  }
  const activeSellerOrders = sellerOrders.filter((so) => !['cancelled', 'rejected'].includes(so.status));
  const payableAmount = sellerOrders.length
    ? (activeSellerOrders.length === sellerOrders.length
      ? Number(order.total_paise)
      : activeSellerOrders.reduce((sum, so) => sum + Number(so.total_paise || 0), 0))
    : Number(order.total_paise);
  if (!(payableAmount > 0)) {
    fail(409, 'There is nothing left to pay for this order.');
  }
  return { sellerOrders, activeSellerOrders, derivedStatus, payableAmount };
}

function findActivePaymentIntent(orderId) {
  return db.prepare(`SELECT * FROM nb_payment_records
    WHERE order_id=? AND provider='razorpay' AND reference IS NOT NULL AND status IN ('created','pending')
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(orderId);
}

function paymentIntentResponse(order, record, reused) {
  return {
    gatewayOrderId: record.reference,
    keyId: GATEWAY.keyId,
    amount: record.amount_paise,
    orderCode: order.code,
    currency: 'INR',
    paymentId: record.id,
    status: record.status,
    reused: Boolean(reused)
  };
}

function cancelSellerOrder(so, reason, actor = 'customer') {
  const order = db.prepare('SELECT * FROM nb_orders WHERE id=?').get(so.order_id);
  releaseStockForSellerOrder(so);
  const ts = now();
  db.prepare('UPDATE nb_seller_orders SET status=?,cancelled_at=?,updated_at=? WHERE id=?').run('cancelled', ts, ts, so.id);
  db.prepare('UPDATE nb_orders SET updated_at=? WHERE id=?').run(ts, so.order_id);
  addEvent(so.order_id, so.id, 'cancelled', 'Order cancelled', `${reason || 'Cancelled'}${actor === 'customer' ? ' (requested by customer)' : ''}`, actor);
  const shop = db.prepare('SELECT name FROM nb_shops WHERE id=?').get(so.shop_id);
  notify(order.customer_id, `Your ${shop.name} order was cancelled`, `${so.code}: ${reason || 'Cancelled'}`, 'order', `#/orders/${order.code}`);
  if (order.payment_status === 'paid') {
    const refundAmount = sellerOrderRefundableAmount(so);
    if (refundAmount > 0) {
      db.prepare('INSERT INTO nb_refunds(id,return_id,order_id,seller_order_id,reason,amount_paise,status,reference,created_at,updated_at) VALUES(?,NULL,?,?,?,?,?,NULL,?,?)')
        .run(uid(), order.id, so.id, 'cancellation', refundAmount, 'processing', ts, ts);
      notify(order.customer_id, 'Refund initiated', `₹${Math.round(refundAmount / 100)} for ${so.code} is being returned to the original payment method.`, 'refund', '#/orders');
    }
  }
  const siblings = db.prepare('SELECT * FROM nb_seller_orders WHERE order_id=?').all(order.id);
  if (siblings.every((s) => ['cancelled', 'rejected'].includes(s.status))) {
    db.prepare('UPDATE nb_orders SET status=?,updated_at=? WHERE id=?').run('cancelled', ts, order.id);
    cancelOpenPaymentRecords(order.id);
  } else if (order.payment_status !== 'paid') {
    syncPendingOfflinePayment(order.id);
  }
}

/* ------------------------------------------------------------------ */
/* Printable receipt                                                   */
/* ------------------------------------------------------------------ */

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (paise) => '₹' + (Number(paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });

function receiptHtml(order, sellerOrder, shop, customer, audience = 'customer') {
  const items = db.prepare('SELECT * FROM nb_order_items WHERE seller_order_id=?').all(sellerOrder.id);
  const address = JSON.parse(order.address_json);
  const rows = items.map((i) => `<tr><td>${esc(i.name)}<br><span class="muted">${esc(i.unit || '')}</span></td><td class="r">${i.qty}</td><td class="r">${inr(i.price_paise)}</td><td class="r">${inr(i.line_total_paise)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Receipt ${esc(sellerOrder.code)} · NearBuy</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px; background: #eff7ff; color: #142d4b; font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; }
  .sheet { max-width: 760px; margin: 0 auto; background: #fff; border: 1px solid #dce8f5; border-radius: 18px; padding: 30px 32px; box-shadow: 0 18px 48px rgba(6,59,120,.10); }
  .top { display: flex; justify-content: space-between; gap: 20px; border-bottom: 2px solid #0866d9; padding-bottom: 16px; }
  .brand { font-weight: 800; font-size: 24px; color: #063b78; letter-spacing: -.02em; }
  .brand span { color: #0866d9; }
  .muted { color: #6b7f98; font-size: 12px; }
  h1 { font-size: 17px; margin: 22px 0 4px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin: 18px 0; }
  .card { background: #f7fbff; border: 1px solid #e2eefb; border-radius: 12px; padding: 12px 14px; }
  .card b { display: block; font-size: 11px; letter-spacing: .09em; text-transform: uppercase; color: #5a7694; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0 4px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #5a7694; border-bottom: 1px solid #dce8f5; padding: 8px 6px; }
  td { padding: 9px 6px; border-bottom: 1px solid #eef5fc; vertical-align: top; }
  .r { text-align: right; }
  .totals { margin-left: auto; width: 300px; margin-top: 12px; }
  .totals div { display: flex; justify-content: space-between; padding: 5px 0; }
  .totals .grand { border-top: 2px solid #0866d9; margin-top: 6px; padding-top: 10px; font-weight: 800; font-size: 17px; color: #063b78; }
  .pill { display: inline-block; padding: 3px 9px; border-radius: 999px; background: #e7f2ff; color: #0866d9; font-size: 11px; font-weight: 700; }
  .demo { background: #fff8e6; border: 1px solid #f5d58b; color: #8a5b00; border-radius: 10px; padding: 8px 12px; font-size: 12px; margin-top: 16px; }
  .actions { max-width: 760px; margin: 16px auto 0; display: flex; gap: 10px; justify-content: flex-end; }
  .actions button, .actions a { border: 0; border-radius: 10px; padding: 10px 18px; background: #0866d9; color: #fff; font: 600 13px system-ui; cursor: pointer; text-decoration: none; }
  .actions a { background: #e7f2ff; color: #063b78; }
  @media print { body { background: #fff; padding: 0; } .sheet { border: 0; box-shadow: none; border-radius: 0; } .actions { display: none; } }
</style><link rel="stylesheet" href="/public/assets/brand.css" />
</head><body>
<div class="actions"><a href="javascript:history.back()">Back</a><button onclick="window.print()">Print / save as PDF</button></div>
<div class="sheet">
  <div class="top">
    <div><div class="brand">Near<span>Buy</span></div><div class="muted">Shop Local. Live Better.</div></div>
    <div style="text-align:right"><span class="pill">${esc(audience === 'seller' ? 'Seller copy' : 'Customer receipt')}</span>
      <div class="muted" style="margin-top:6px">Receipt ${esc(sellerOrder.code)}<br>${new Date(sellerOrder.created_at).toLocaleString('en-IN')}</div></div>
  </div>
  <h1>${esc(shop.name)}</h1>
  <div class="muted">${esc(shop.address)}, ${esc(shop.locality)}, ${esc(shop.city)} — ${esc(shop.pincode)}${shop.phone ? ' · ' + esc(shop.phone) : ''}</div>
  <div class="grid">
    <div class="card"><b>Customer</b>${esc(customer.name)}<br>${esc(customer.email)}${audience === 'seller' ? '<br>' + esc(customer.phone || '') : ''}</div>
    <div class="card"><b>${sellerOrder.fulfillment === 'pickup' ? 'Pickup at' : 'Deliver to'}</b>${sellerOrder.fulfillment === 'pickup' ? esc(shop.address + ', ' + shop.locality + ', ' + shop.pincode) : esc([address.line1, address.line2, address.locality, address.city, address.pincode].filter(Boolean).join(', '))}<br><span class="muted">${esc(address.receiver || customer.name)} · ${esc(address.phone || customer.phone || '')}</span></div>
  </div>
  <table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="totals">
    <div><span>Subtotal</span><span>${inr(sellerOrder.subtotal_paise)}</span></div>
    ${sellerOrder.discount_paise ? `<div><span>Discount${order.coupon_code ? ' (' + esc(order.coupon_code) + ')' : ''}</span><span>−${inr(sellerOrder.discount_paise)}</span></div>` : ''}
    <div><span>${sellerOrder.fulfillment === 'pickup' ? 'Pickup charge' : 'Delivery fee'}</span><span>${sellerOrder.delivery_fee_paise ? inr(sellerOrder.delivery_fee_paise) : 'Free'}</span></div>
    <div><span>Tax</span><span>${inr(sellerOrder.tax_paise)}</span></div>
    <div class="grand"><span>Total</span><span>${inr(sellerOrder.total_paise)}</span></div>
  </div>
  <p class="muted">Payment: ${esc(order.payment_method === 'cod' ? 'Cash on delivery' : order.payment_method === 'pay_at_store' ? 'Pay at store' : 'Online')} · Status: ${esc(order.payment_status)}<br>
  Order ${esc(order.code)} · ${esc(sellerOrder.code)} · ${esc(fulfillmentLabel(sellerOrder))}</p>
  ${order.is_demo ? '<div class="demo"><b>Demo data.</b> This receipt belongs to the sample storefront. It is not a tax invoice and no payment provider processed money for it.</div>' : ''}
</div>
</body></html>`;
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

async function handle(req, res) {
  const url = new URL(req.url, 'http://nearbuy.local');
  const path = url.pathname;
  const method = req.method;
  if (!/^\/api\/(customer|partner|admin)\//.test(path)) return false;
  const q = url.searchParams;

  try {
    /* Gateway webhook: signature-verified raw body, no session. */
    if (method === 'POST' && path === '/api/customer/payments/webhook') {
      await paymentWebhook(req, res);
      return true;
    }

    let payload = {};
    if (!['GET', 'HEAD'].includes(method)) payload = await readBody(req, 320000);
    const session = sessionFor(req);
    const partnerSession = sessionFor(req, PARTNER_COOKIE);
    const adminSession = sessionFor(req, ADMIN_COOKIE);
    const requestSession = path.startsWith('/api/admin/') ? adminSession : path.startsWith('/api/partner/') ? partnerSession : session;
    const authPath = /\/auth\/(login|register|forgot|reset)$/.test(path) || path === '/api/partner/login' || path === '/api/admin/login' || path === '/api/customer/auth/demo';
    if (!['GET', 'HEAD'].includes(method)) checkMutation(req, authPath ? null : requestSession);
    const base = path.startsWith('/api/customer') ? '/api/customer' : path.startsWith('/api/partner') ? '/api/partner' : '/api/admin';
    const route = path.slice(base.length) || '/';
    /* Customer routes only match /api/customer/*, so an admin or partner path with
     * the same tail (for example /api/admin/orders) can never fall into a customer
     * handler that expects a customer session. */
    const custRoute = base === '/api/customer' ? route : '\u0000';

    const page = clampInt(q.get('page') || 1, 1, 1000);
    const limit = clampInt(q.get('limit') || 12, 1, 48);

    if (method === 'GET' && custRoute === '/auth/demo') {
      send(res, 200, { enabled: DEMO && demoIsIsolated() });
      return true;
    }
    if (method === 'POST' && custRoute === '/auth/demo') {
      if (!DEMO) fail(404, 'Demo access is disabled on this deployment.');
      assertDemoIsolation();
      rateLimit(`demo-login:${clientIp(req)}`, 40, 900e3);
      const accounts = {
        customer: ['customer@nearbuy.demo', SESSION_COOKIE, '/customer/'],
        seller: ['owner@nearbuy.demo', PARTNER_COOKIE, '/seller/'],
        runner: ['rohan@nearbuy.demo', PARTNER_COOKIE, '/runner/'],
        admin: ['admin@nearbuy.demo', ADMIN_COOKIE, '/admin/']
      };
      const account = Object.hasOwn(accounts, payload.role) ? accounts[payload.role] : null;
      if (!account) fail(400, 'Choose Customer, Seller, Runner or Admin.');
      const user = db.prepare('SELECT * FROM nb_users WHERE email=? AND role=? AND is_demo=1').get(account[0], payload.role);
      if (!user) fail(503, 'This demo account has not been seeded. Ask the operator to run npm run seed:demo on the sandbox database.');
      const sess = startSession(req, user, account[1]);
      audit(user.role, user.id, 'demo_login', 'user', user.id, 'Sandbox demo session started');
      send(res, 200, { portal: account[2], role: user.role }, { 'Set-Cookie': sess.cookie });
      return true;
    }

    /* ---------------------------- auth ----------------------------- */
    if (method === 'POST' && custRoute === '/auth/register') {
      rateLimit(`register:${clientIp(req)}`, 12, 3600e3);
      const name = String(payload.name || '').trim();
      const email = String(payload.email || '').trim().toLowerCase();
      const phone = normalPhone(payload.phone);
      if (!str(name, 2, 80)) fail(400, 'Please enter your full name (2–80 characters).');
      if (!emailOk(email)) fail(400, 'Please enter a valid email address.');
      if (!phoneOk(phone)) fail(400, 'Please enter a valid 10-digit Indian mobile number.');
      if (typeof payload.password !== 'string' || payload.password.length < 8 || payload.password.length > 128) {
        fail(400, 'Your password must be 8–128 characters long.');
      }
      if (!/[A-Za-z]/.test(payload.password) || !/\d/.test(payload.password)) {
        fail(400, 'Please use at least one letter and one number in your password.');
      }
      if (payload.confirmPassword !== undefined && payload.confirmPassword !== payload.password) {
        fail(400, 'The two passwords do not match.');
      }
      if (payload.terms !== true) fail(400, 'Please accept the Terms of Use and Privacy Policy.');
      if (db.prepare('SELECT 1 FROM nb_users WHERE email=?').get(email)) fail(409, 'An account with this email already exists. Try signing in instead.', { field: 'email' });
      if (db.prepare('SELECT 1 FROM nb_users WHERE phone=?').get(phone)) fail(409, 'An account with this mobile number already exists.', { field: 'phone' });
      const id = uid();
      const created = now();
      transaction(() => {
        db.prepare(`INSERT INTO nb_users(id,role,name,email,phone,password_hash,email_verified,phone_verified,avatar,status,is_demo,created_at)
          VALUES(?, 'customer', ?, ?, ?, ?, 0, 0, '👤', 'active', ?, ?)`).run(id, name, email, phone, makePassword(payload.password), DEMO ? 1 : 0, created);
        db.prepare('INSERT INTO nb_customer_profiles(user_id,marketing_opt_in,order_updates,created_at) VALUES(?,?,1,?)').run(id, payload.marketing ? 1 : 0, created);
      });
      notify(id, 'Welcome to NearBuy', 'Shop local, compare prices and support neighbourhood businesses. Add your address to see shops that deliver to you.', 'account', '#/account/addresses');
      audit('customer', id, 'register', 'user', id, 'Customer account created');
      const user = { id, role: 'customer', name, email, phone, avatar: '👤' };
      const sess = startSession(req, user);
      send(res, 201, { user: { ...userPayload({ ...user, user_id: id, csrf: sess.csrf }), csrf: sess.csrf }, message: 'Welcome to NearBuy!' }, { 'Set-Cookie': sess.cookie });
      return true;
    }

    if (method === 'POST' && custRoute === '/auth/login') {
      rateLimit(`login:${clientIp(req)}`, 30, 900e3);
      const identifier = String(payload.identifier || payload.email || payload.phone || '').trim();
      rateLimit(`login-id:${sha(identifier.toLowerCase()).slice(0, 16)}`, 8, 900e3);
      if (!identifier || typeof payload.password !== 'string') fail(400, 'Enter your email or mobile number and password.');
      const digits = normalPhone(identifier);
      const user = emailOk(identifier)
        ? db.prepare('SELECT * FROM nb_users WHERE email=?').get(identifier.toLowerCase())
        : phoneOk(digits) ? db.prepare('SELECT * FROM nb_users WHERE phone=?').get(digits) : null;
      const ok = user ? checkPassword(payload.password, user.password_hash) : checkPassword(payload.password, makePassword('not-a-real-password'));
      if (!user || !ok) fail(401, 'Those details do not match an account. Check your email/mobile and password.');
      if (user.role !== 'customer') fail(403, 'This is a customer sign-in. Sellers and delivery partners should use their partner console.');
      if (user.status !== 'active') fail(403, 'This account is not active. Contact support.');
      const sess = startSession(req, user, SESSION_COOKIE, payload.remember === false ? 24 : SESSION_HOURS);
      audit('customer', user.id, 'login', 'user', user.id, 'Customer signed in');
      send(res, 200, { user: userPayload({ user_id: user.id, role: user.role, name: user.name, email: user.email, phone: user.phone, avatar: user.avatar, csrf: sess.csrf }), message: `Welcome back, ${user.name.split(' ')[0]}.` }, { 'Set-Cookie': sess.cookie });
      return true;
    }

    if (method === 'POST' && custRoute === '/auth/logout') {
      if (session) db.prepare('DELETE FROM nb_sessions WHERE token_hash=?').run(sha(session.token));
      send(res, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; ${cookieAttrs(req)}; Max-Age=0` });
      return true;
    }

    if (method === 'GET' && custRoute === '/auth/me') {
      if (!session || session.role !== 'customer') {
        send(res, 200, { user: null, config: publicConfig() });
        return true;
      }
      send(res, 200, { user: userPayload(session), config: publicConfig() });
      return true;
    }

    if (method === 'POST' && custRoute === '/auth/verify/request') {
      const s = requireCustomer(req);
      rateLimit(`verify:${s.user_id}`, 6, 600e3);
      const channel = payload.channel === 'phone' ? 'phone' : 'email';
      const user = db.prepare('SELECT * FROM nb_users WHERE id=?').get(s.user_id);
      const code = String(Math.floor(100000 + Math.random() * 900000));
      db.prepare('INSERT INTO nb_otp_codes(id,user_id,channel,purpose,target,code_hash,expires_at,attempts,created_at) VALUES(?,?,?,?,?,?,?,0,?)')
        .run(uid(), s.user_id, channel, 'verify_account', channel === 'phone' ? user.phone : user.email, sha(code), new Date(Date.now() + 10 * 60000).toISOString(), now());
      send(res, 200, {
        channel, sent: false, providerConfigured: false,
        message: `No ${channel === 'phone' ? 'SMS' : 'email'} provider is configured for this deployment, so nothing was sent.${DEV_CODES ? ' In development the code is shown here.' : ''}`,
        ...(DEV_CODES ? { devCode: code } : {})
      });
      return true;
    }

    if (method === 'POST' && custRoute === '/auth/verify/confirm') {
      const s = requireCustomer(req);
      const channel = payload.channel === 'phone' ? 'phone' : 'email';
      const code = String(payload.code || '');
      const row = db.prepare("SELECT * FROM nb_otp_codes WHERE user_id=? AND channel=? AND purpose='verify_account' AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1").get(s.user_id, channel);
      if (!row) fail(400, 'Request a new verification code first.');
      if (new Date(row.expires_at).getTime() < Date.now()) fail(400, 'That code has expired. Request a new one.');
      if (row.attempts >= 5) fail(429, 'Too many incorrect codes. Request a new one.');
      if (!safeEqual(sha(code), row.code_hash)) {
        db.prepare('UPDATE nb_otp_codes SET attempts=attempts+1 WHERE id=?').run(row.id);
        fail(400, 'That code is not correct.');
      }
      db.prepare('UPDATE nb_otp_codes SET consumed_at=? WHERE id=?').run(now(), row.id);
      db.prepare(`UPDATE nb_users SET ${channel === 'phone' ? 'phone_verified' : 'email_verified'}=1 WHERE id=?`).run(s.user_id);
      send(res, 200, { message: `${channel === 'phone' ? 'Mobile number' : 'Email address'} verified.`, user: userPayload(sessionFor(req)) });
      return true;
    }

    if (method === 'POST' && custRoute === '/auth/forgot') {
      rateLimit(`forgot:${clientIp(req)}`, 8, 3600e3);
      const email = String(payload.email || '').trim().toLowerCase();
      const generic = { message: 'If an account exists for that email, a password reset link has been created. Check your inbox.' };
      if (!emailOk(email)) fail(400, 'Enter the email address on your account.');
      const user = db.prepare("SELECT * FROM nb_users WHERE email=? AND role='customer'").get(email);
      if (user) {
        const token = randomBytes(24).toString('hex');
        db.prepare('INSERT INTO nb_password_resets(token_hash,user_id,expires_at,used_at) VALUES(?,?,?,NULL)')
          .run(sha(token), user.id, new Date(Date.now() + 3600e3).toISOString());
        audit('customer', user.id, 'password_reset_requested', 'user', user.id, 'Reset link created');
        if (DEV_CODES) {
          generic.devResetToken = token;
          generic.message = 'Email delivery is not configured in this environment. Use the development reset link below.';
          generic.resetUrl = `#/reset?token=${token}`;
        }
      }
      send(res, 200, generic);
      return true;
    }

    if (method === 'POST' && custRoute === '/auth/reset') {
      rateLimit(`reset:${clientIp(req)}`, 10, 3600e3);
      const token = String(payload.token || '');
      if (!/^[a-f0-9]{48}$/.test(token)) fail(400, 'This reset link is not valid.');
      const row = db.prepare('SELECT * FROM nb_password_resets WHERE token_hash=?').get(sha(token));
      if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) fail(400, 'This reset link has expired. Request a new one.');
      if (typeof payload.password !== 'string' || payload.password.length < 8 || !/[A-Za-z]/.test(payload.password) || !/\d/.test(payload.password)) {
        fail(400, 'Choose a password of at least 8 characters with a letter and a number.');
      }
      if (payload.confirmPassword !== undefined && payload.confirmPassword !== payload.password) fail(400, 'The two passwords do not match.');
      db.prepare('UPDATE nb_users SET password_hash=? WHERE id=?').run(makePassword(payload.password), row.user_id);
      db.prepare('UPDATE nb_password_resets SET used_at=? WHERE token_hash=?').run(now(), sha(token));
      db.prepare('DELETE FROM nb_sessions WHERE user_id=?').run(row.user_id);
      audit('customer', row.user_id, 'password_reset', 'user', row.user_id, 'Password changed through reset link');
      send(res, 200, { message: 'Your password has been changed. Sign in with the new password.' }, { 'Set-Cookie': `${SESSION_COOKIE}=; ${cookieAttrs(req)}; Max-Age=0` });
      return true;
    }

    /* -------------------------- bootstrap -------------------------- */
    if (method === 'GET' && custRoute === '/bootstrap') {
      const customer = session && session.role === 'customer' ? session : null;
      const cart = customer ? priceCart(customer.user_id) : { itemCount: 0, total: 0, items: 0 };
      const wishlist = customer ? db.prepare('SELECT COUNT(*) AS n FROM nb_wishlist WHERE user_id=?').get(customer.user_id) : { n: 0 };
      const unread = customer ? db.prepare('SELECT COUNT(*) AS n FROM nb_notifications WHERE user_id=? AND is_read=0').get(customer.user_id) : { n: 0 };
      send(res, 200, {
        user: customer ? userPayload(customer) : null,
        config: publicConfig(),
        categories: categoryList(),
        counts: { cart: cart.itemCount, wishlist: Number(wishlist?.n || 0), unread: Number(unread?.n || 0) },
        cartSummary: { subtotal: cart.subtotal || 0, total: cart.total || 0, itemCount: cart.itemCount || 0 },
        demoAccounts: DEMO ? {
          customer: { email: 'customer@nearbuy.demo', password: 'Customer123!' },
          seller: { email: 'owner@nearbuy.demo', password: 'Seller123!' },
          runner: { email: 'rohan@nearbuy.demo', password: 'Runner123!' }
        } : null
      });
      return true;
    }

    /* --------------------------- home ------------------------------ */
    if (method === 'GET' && custRoute === '/home') {
      const location = locationFromQuery(q);
      const banners = db.prepare('SELECT * FROM nb_banners WHERE active=1 ORDER BY sort, id').all().map((b) => ({
        id: b.id, title: b.title, subtitle: b.subtitle, eyebrow: b.eyebrow, ctaLabel: b.cta_label,
        ctaLink: b.cta_link, imageUrl: b.image_url, theme: b.theme
      }));
      const shopResult = queryShops({ location, limit: 8, sort: 'distance' });
      const productResult = queryProducts({ location, limit: 12, sort: 'relevance', available: '1' });
      const categorySet = categoryList();
      const stats = {
        shops: Number(db.prepare('SELECT COUNT(*) AS n FROM nb_shops').get().n),
        products: Number(db.prepare('SELECT COUNT(*) AS n FROM nb_products WHERE active=1').get().n),
        categories: categorySet.length,
        localities: Number(db.prepare('SELECT COUNT(DISTINCT locality) AS n FROM nb_service_areas').get().n)
      };
      const recentOrders = session && session.role === 'customer'
        ? db.prepare('SELECT * FROM nb_orders WHERE customer_id=? ORDER BY created_at DESC LIMIT 2').all(session.user_id).map((o) => orderSummary(o))
        : [];
      send(res, 200, {
        banners, categories: categorySet, shops: shopResult.shops, products: productResult.products,
        offers: activeOffers(location).slice(0, 4), stats, location, recentOrders,
        howItWorks: [
          { title: 'Find nearby shops', body: 'Share your locality or pincode and see the shops that actually deliver to you.' },
          { title: 'Discover products', body: 'Browse real catalogues, live stock and today’s prices from each seller.' },
          { title: 'Compare prices', body: 'Check the same product across nearby shops before you buy.' },
          { title: 'Cart & checkout', body: 'One basket across shops, delivery or pickup per shop, clear totals.' },
          { title: 'Track every step', body: 'Follow acceptance, preparation and delivery with a real status timeline.' },
          { title: 'Receive your order', body: 'Confirm handover with your delivery OTP and rate the shops you love.' }
        ]
      });
      return true;
    }

    if (method === 'GET' && custRoute === '/categories') {
      send(res, 200, { categories: categoryList() });
      return true;
    }

    if (method === 'GET' && custRoute === '/localities') {
      const search = String(q.get('q') || '').toLowerCase();
      const rows = db.prepare(`SELECT pincode, locality, city, lat, lng FROM nb_service_areas WHERE active=1
        ${search ? 'AND (LOWER(locality) LIKE ? OR pincode LIKE ?)' : ''} ORDER BY locality LIMIT 20`)
        .all(...(search ? [`%${search}%`, `%${search}%`] : []));
      send(res, 200, { localities: rows });
      return true;
    }

    if (method === 'GET' && custRoute === '/serviceability') {
      const pincode = String(q.get('pincode') || '');
      if (!pincodeOk(pincode)) fail(400, 'Enter a valid 6-digit pincode.');
      const area = pincodeArea(pincode);
      const location = area ? { pincode, locality: area.locality, city: area.city, lat: area.lat, lng: area.lng } : { pincode, lat: null, lng: null };
      const result = queryShops({ location, limit: 48 });
      const products = db.prepare('SELECT COUNT(*) AS n FROM nb_products p JOIN nb_shops s ON s.id=p.shop_id WHERE p.active=1').get();
      send(res, 200, {
        pincode, area: area ? { locality: area.locality, city: area.city, lat: area.lat, lng: area.lng } : null,
        serviceable: result.shops.length > 0, shops: result.shops, shopCount: result.total,
        productCount: Number(products?.n || 0),
        message: result.shops.length ? `${result.shops.length} shops deliver to ${area ? area.locality : pincode}.` : 'We are not live in this pincode yet. Try Hauz Khas (110016) or Saket (110017).'
      });
      return true;
    }

    /* --------------------------- shops ----------------------------- */
    if (method === 'GET' && custRoute === '/shops') {
      const location = locationFromQuery(q);
      const out = queryShops({
        location, category: q.get('category') || '', q: q.get('q') || '',
        sort: q.get('sort') || 'distance', open: q.get('open'), delivery: q.get('delivery'),
        pickup: q.get('pickup'), verified: q.get('verified'), minRating: q.get('minRating'),
        maxDistance: q.get('maxDistance'), includeUnserviceable: q.get('all') === '1', limit, page
      });
      send(res, 200, { ...out, location, categories: categoryList() });
      return true;
    }

    if (method === 'GET' && (custRoute.match(/^\/shops\/([a-z0-9-]+)$/))) {
      const slug = route.split('/')[2];
      const row = db.prepare('SELECT * FROM nb_shops WHERE slug=?').get(slug);
      if (!row) fail(404, 'Shop not found');
      const location = locationFromQuery(q);
      const card = shopCard(row, location);
      const products = db.prepare('SELECT * FROM nb_products WHERE shop_id=? AND active=1 ORDER BY category_slug, name').all(row.id)
        .map((p) => productCard(p, { location, shop: row }));
      const grouped = {};
      for (const p of products) {
        if (!grouped[p.categorySlug]) grouped[p.categorySlug] = { slug: p.categorySlug, name: p.category, products: [] };
        grouped[p.categorySlug].products.push(p);
      }
      const reviews = db.prepare(`SELECT r.*, u.name AS customer_name FROM nb_reviews r JOIN nb_users u ON u.id=r.customer_id
        WHERE r.shop_id=? AND r.status='published' ORDER BY r.created_at DESC LIMIT 12`).all(row.id).map((r) => ({
        id: r.id, rating: r.shop_rating, title: r.title, body: r.body, images: JSON.parse(r.images_json || '[]'),
        customerName: r.customer_name.split(' ')[0] + ' ' + (r.customer_name.split(' ')[1] || '').slice(0, 1) + '.',
        verified: Boolean(r.verified_purchase), at: r.created_at, productId: r.product_id
      }));
      const offers = activeOffers(location).filter((o) => !o.shop || o.shop.slug === slug);
      send(res, 200, {
        shop: card, categories: Object.values(grouped), products, reviews, offers, location,
        policies: {
          delivery: row.delivery_enabled ? `Home delivery within ${row.radius_km} km for ${inr(row.delivery_fee_paise)}${row.free_delivery_over_paise ? `, free over ${inr(row.free_delivery_over_paise)}` : ''}.` : 'Home delivery is not offered by this shop.',
          pickup: row.pickup_enabled ? (row.pickup_fee_paise ? `Store pickup for ${inr(row.pickup_fee_paise)}.` : 'Free store pickup.') : 'Store pickup is not offered by this shop.',
          returns: 'Return windows are shown per product. Perishables are only returnable if damaged on arrival.'
        }
      });
      return true;
    }

    /* -------------------------- products --------------------------- */
    if (method === 'GET' && custRoute === '/products') {
      const location = locationFromQuery(q);
      const out = queryProducts({
        location, q: q.get('q') || '', category: q.get('category') || '', shop: q.get('shop') || '',
        brand: q.get('brand') || '', minPrice: q.get('minPrice'), maxPrice: q.get('maxPrice'),
        rating: q.get('rating'), available: q.get('available'), delivery: q.get('delivery'),
        pickup: q.get('pickup'), sort: q.get('sort') || 'relevance', limit, page
      });
      const brands = db.prepare('SELECT DISTINCT brand FROM nb_products WHERE active=1 AND brand IS NOT NULL ORDER BY brand').all().map((b) => b.brand);
      const shops = db.prepare('SELECT id, slug, name, emoji FROM nb_shops ORDER BY name').all();
      const price = db.prepare('SELECT MIN(price_paise) AS min, MAX(price_paise) AS max FROM nb_products WHERE active=1').get();
      send(res, 200, { ...out, location, brands, shops, priceRange: { min: price.min, max: price.max }, categories: categoryList() });
      return true;
    }

    if (method === 'GET' && custRoute.match(/^\/products\/([a-zA-Z0-9_-]+)\/compare$/)) {
      const id = route.split('/')[2];
      const product = db.prepare('SELECT * FROM nb_products WHERE id=?').get(id);
      if (!product) fail(404, 'Product not found');
      const location = locationFromQuery(q);
      const rows = db.prepare(`SELECT p.*, s.name AS shop_name, s.slug AS shop_slug, s.is_open, s.delivery_enabled,
          s.pickup_enabled, s.lat AS shop_lat, s.lng AS shop_lng, s.service_pincodes, s.radius_km, s.rating AS shop_rating, s.verified
        FROM nb_products p JOIN nb_shops s ON s.id=p.shop_id WHERE p.compare_key=? AND p.active=1`).all(product.compare_key);
      const listings = rows.map((r) => {
        const shop = db.prepare('SELECT * FROM nb_shops WHERE id=?').get(r.shop_id);
        const card = productCard(r, { location, shop });
        return {
          ...card, shopVerified: Boolean(shop.verified), shopRating: shop.rating, shopOpen: Boolean(shop.is_open),
          serviceable: location ? shopCard(shop, location).serviceable : true,
          deliveryFee: shop.delivery_fee_paise, pickupFee: shop.pickup_fee_paise,
          freeDeliveryOver: shop.free_delivery_over_paise,
          deliveryTime: shop.prep_minutes + 18, pickupTime: shop.prep_minutes
        };
      }).sort((a, b) => (Number(b.available) - Number(a.available)) || a.price - b.price);
      const availableListings = listings.filter((l) => l.available);
      const lowest = availableListings.length ? Math.min(...availableListings.map((l) => l.price)) : null;
      send(res, 200, {
        product: productCard(product, { location }), listings,
        lowestPrice: lowest, savings: lowest != null && product.mrp_paise ? product.mrp_paise - lowest : 0,
        equivalentNote: 'Listings are matched on the same brand, product name, pack size and variant. Check the pack size before choosing a seller.',
        location
      });
      return true;
    }

    if (method === 'GET' && custRoute.match(/^\/products\/([a-zA-Z0-9_-]+)$/)) {
      const id = route.split('/')[2];
      const row = db.prepare('SELECT * FROM nb_products WHERE id=?').get(id);
      /* Admin moderation hides a listing from the storefront without deleting it. */
      if (!row || !row.active) fail(404, 'Product not found');
      const shop = db.prepare('SELECT * FROM nb_shops WHERE id=?').get(row.shop_id);
      if (!shop) fail(404, 'Product not found');
      const location = locationFromQuery(q);
      const images = db.prepare('SELECT url FROM nb_product_images WHERE product_id=? ORDER BY sort').all(id).map((i) => i.url);
      const reviews = db.prepare(`SELECT r.*, u.name AS customer_name FROM nb_reviews r JOIN nb_users u ON u.id=r.customer_id
        WHERE r.product_id=? AND r.status='published' ORDER BY r.created_at DESC LIMIT 10`).all(id).map((r) => ({
        id: r.id, rating: r.product_rating, title: r.title, body: r.body, images: JSON.parse(r.images_json || '[]'),
        customerName: r.customer_name.split(' ')[0] + ' ' + (r.customer_name.split(' ')[1] || '').slice(0, 1) + '.',
        verified: Boolean(r.verified_purchase), at: r.created_at
      }));
      const compareRows = db.prepare('SELECT p.* FROM nb_products p JOIN nb_shops s ON s.id=p.shop_id WHERE p.compare_key=? AND p.active=1').all(row.compare_key);
      const wishlisted = session && session.role === 'customer'
        ? Boolean(db.prepare('SELECT 1 FROM nb_wishlist WHERE user_id=? AND product_id=?').get(session.user_id, id)) : false;
      const related = db.prepare('SELECT * FROM nb_products WHERE category_slug=? AND id<>? AND active=1 ORDER BY RANDOM() LIMIT 6').all(row.category_slug, id)
        .map((p) => productCard(p, { location }));
      send(res, 200, {
        product: {
          ...productCard(row, { location, shop }),
          description: row.description,
          highlights: JSON.parse(row.highlights || '[]'),
          specs: JSON.parse(row.specs || '[]'),
          images: images.length ? images : row.image_url ? [row.image_url] : [],
          lowStockAt: row.low_stock
        },
        shop: shopCard(shop, location),
        reviews, related, wishlisted, location,
        compare: (() => {
          const availableRows = compareRows.filter((r) => r.stock - r.reserved > 0);
          return { count: compareRows.length, lowest: availableRows.length ? Math.min(...availableRows.map((r) => r.price_paise)) : null };
        })()
      });
      return true;
    }

    if (method === 'GET' && custRoute === '/search/suggest') {
      const term = String(q.get('q') || '').trim();
      if (term.length < 2) { send(res, 200, { products: [], shops: [], categories: [] }); return true; }
      const like = `%${term.toLowerCase()}%`;
      const location = locationFromQuery(q);
      const products = db.prepare(`SELECT p.* FROM nb_products p JOIN nb_shops s ON s.id=p.shop_id
        WHERE p.active=1 AND (LOWER(p.name) LIKE ? OR LOWER(p.brand) LIKE ? OR LOWER(p.category_slug) LIKE ?) LIMIT 6`)
        .all(like, like, like).map((p) => productCard(p, { location }));
      const shops = db.prepare(`SELECT * FROM nb_shops WHERE LOWER(name) LIKE ? OR LOWER(tagline) LIKE ? OR LOWER(category_slug) LIKE ? LIMIT 4`)
        .all(like, like, like).map((s) => shopCard(s, location));
      const categories = categoryList().filter((c) => c.name.toLowerCase().includes(term.toLowerCase())).slice(0, 4);
      send(res, 200, { products, shops, categories, query: term });
      return true;
    }

    if (method === 'GET' && custRoute === '/offers') {
      const location = locationFromQuery(q);
      const offers = activeOffers(location);
      const eligibleProducts = db.prepare('SELECT p.* FROM nb_products p JOIN nb_shops s ON s.id=p.shop_id WHERE p.active=1 AND p.mrp_paise>p.price_paise ORDER BY ((p.mrp_paise-p.price_paise)*100/p.mrp_paise) DESC LIMIT 8')
        .all().map((p) => productCard(p, { location }));
      send(res, 200, { offers, products: eligibleProducts, location });
      return true;
    }

    if (method === 'GET' && custRoute === '/faqs') {
      send(res, 200, { faqs: db.prepare('SELECT * FROM nb_faqs ORDER BY sort').all() });
      return true;
    }

    if (method === 'GET' && custRoute === '/reviews') {
      const productId = q.get('productId');
      const shopSlug = q.get('shop');
      let rows;
      if (productId) {
        rows = db.prepare(`SELECT r.*, u.name AS customer_name FROM nb_reviews r JOIN nb_users u ON u.id=r.customer_id
          WHERE r.product_id=? AND r.status='published' ORDER BY r.created_at DESC LIMIT 50`).all(productId);
      } else if (shopSlug) {
        const shop = db.prepare('SELECT id FROM nb_shops WHERE slug=?').get(shopSlug);
        rows = shop ? db.prepare(`SELECT r.*, u.name AS customer_name FROM nb_reviews r JOIN nb_users u ON u.id=r.customer_id
          WHERE r.shop_id=? AND r.status='published' ORDER BY r.created_at DESC LIMIT 50`).all(shop.id) : [];
      } else {
        rows = db.prepare(`SELECT r.*, u.name AS customer_name FROM nb_reviews r JOIN nb_users u ON u.id=r.customer_id
          WHERE r.status='published' ORDER BY r.created_at DESC LIMIT 50`).all();
      }
      send(res, 200, { reviews: rows.map((r) => ({
        id: r.id, rating: r.product_rating || r.shop_rating, shopRating: r.shop_rating, productRating: r.product_rating,
        title: r.title, body: r.body, images: JSON.parse(r.images_json || '[]'), verified: Boolean(r.verified_purchase),
        customerName: r.customer_name, at: r.created_at, productId: r.product_id, shopId: r.shop_id
      })) });
      return true;
    }

    if (method === 'POST' && custRoute === '/enquiry') {
      rateLimit(`enquiry:${clientIp(req)}`, 6, 3600e3);
      if (!str(payload.name, 2, 80)) fail(400, 'Please tell us your name.');
      if (!str(payload.contact, 5, 120)) fail(400, 'Add an email address or mobile number so we can reply.');
      if (!str(payload.topic, 2, 60)) fail(400, 'Choose a topic.');
      if (!str(payload.message, 10, 2000)) fail(400, 'Please add a message of at least 10 characters.');
      const code = 'ENQ-' + String(Math.floor(100000 + Math.random() * 900000));
      db.prepare('INSERT INTO nb_enquiries(id,code,name,contact,topic,message,status,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(uid(), code, payload.name.trim(), payload.contact.trim(), payload.topic.trim(), payload.message.trim(), 'open', now());
      audit('guest', null, 'enquiry', 'enquiry', code, `Contact form: ${payload.topic}`);
      send(res, 201, { code, message: `Thanks — your enquiry is logged as ${code}. This demo records the message in NearBuy; no email provider is configured, so nothing is sent.` });
      return true;
    }

    /* ---------------------- seller registration -------------------- */
    if (method === 'POST' && custRoute === '/seller/register') {
      rateLimit(`seller-register:${clientIp(req)}`, 6, 3600e3);
      const name = String(payload.name || '').trim();
      const email = String(payload.email || '').trim().toLowerCase();
      const phone = normalPhone(payload.mobile || payload.phone);
      const businessName = String(payload.businessName || payload.shopName || '').trim();
      const category = String(payload.category || '').trim();
      const shopType = String(payload.shopType || 'retail').trim();
      if (!str(name, 2, 80)) fail(400, 'Enter the owner’s full name.');
      if (!emailOk(email)) fail(400, 'Enter a valid email address.');
      if (!phoneOk(phone)) fail(400, 'Enter a valid 10-digit mobile number.');
      if (typeof payload.password !== 'string' || payload.password.length < 8) fail(400, 'Password must be at least 8 characters.');
      if (payload.password !== payload.confirmPassword) fail(400, 'Passwords do not match.');
      if (!str(businessName, 2, 120)) fail(400, 'Enter your business name.');
      if (!db.prepare('SELECT 1 FROM nb_categories WHERE slug=?').get(category)) fail(400, 'Choose a valid business category.');
      if (payload.terms !== true) fail(400, 'Accept the terms and conditions to continue.');
      if (db.prepare('SELECT id FROM nb_users WHERE email=?').get(email)) fail(409, 'An account with this email already exists. Sign in instead.');
      if (db.prepare('SELECT id FROM nb_users WHERE phone=?').get(phone)) fail(409, 'An account with this mobile number already exists.');
      const userId = uid();
      const shopId = uid();
      const slugBase = NB_SLUG(businessName) || 'shop';
      let slug = slugBase;
      let n = 1;
      while (db.prepare('SELECT id FROM nb_shops WHERE slug=?').get(slug)) { slug = `${slugBase}-${++n}`; }
      transaction(() => {
        db.prepare(`INSERT INTO nb_users(id,role,name,email,phone,password_hash,email_verified,phone_verified,avatar,status,is_demo,created_at)
          VALUES(?,?,?,?,?,?,0,0,'🧑‍💼','pending_verification',0,?)`).run(userId, 'seller', name, email, phone, makePassword(payload.password), now());
        db.prepare(`INSERT INTO nb_shops(id,slug,owner_user_id,name,category_slug,tagline,description,emoji,tone,phone,address,locality,city,pincode,lat,lng,rating,review_count,verified,is_open,opens_at,closes_at,prep_minutes,delivery_enabled,pickup_enabled,delivery_fee_paise,free_delivery_over_paise,pickup_fee_paise,min_order_paise,radius_km,service_pincodes,badge,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          shopId, slug, userId, businessName, category, null, null, '🏪', 'blue', phone, 'Address pending KYC', 'Pending', 'New Delhi', '110016', 28.5494, 77.2001,
          0, 0, 0, 0, '09:00', '21:00', 15, 1, 1, 0, null, 0, 0, 5, '', null, now()
        );
        db.prepare(`INSERT INTO nb_seller_verifications(id,user_id,shop_id,status,legal_name,business_category,shop_type,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(uid(), userId, shopId, 'documents_pending', businessName, category, shopType, now(), now());
        db.prepare(`INSERT INTO nb_seller_notification_prefs(user_id,updated_at) VALUES(?,?)`).run(userId, now());
      });
      audit('guest', null, 'seller_registered', 'seller', userId, `${businessName} · ${email}`);
      send(res, 201, {
        message: 'Account created. Complete Step 2 (business information) and Step 3 (KYC documents) — selling activates only after admin approval.',
        sellerId: `NB-SELLER-${slug.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 12)}`,
        shopId: `NB-SHOP-${slug.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 12)}`,
        status: 'documents_pending',
        next: 'Submit business information and KYC documents, then sign in to the Seller Hub to track verification.'
      });
      return true;
    }

    if (method === 'POST' && custRoute === '/seller/kyc') {
      rateLimit(`seller-kyc:${clientIp(req)}`, 10, 3600e3);
      const email = String(payload.email || '').trim().toLowerCase();
      const user = db.prepare("SELECT * FROM nb_users WHERE email=? AND role='seller'").get(email);
      if (!user) fail(404, 'No seller account found for this email. Complete Step 1 first.');
      if (!checkPassword(payload.password || '', user.password_hash)) fail(401, 'Password does not match this seller account.');
      const shop = db.prepare('SELECT * FROM nb_shops WHERE owner_user_id=?').get(user.id);
      if (!shop) fail(404, 'No shop is linked to this seller account.');
      const verification = db.prepare('SELECT * FROM nb_seller_verifications WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(user.id);
      if (!verification) fail(404, 'Verification record not found.');
      if (verification.status === 'approved') fail(409, 'This shop is already approved.');
      const legalName = String(payload.legalName || payload.businessName || shop.name).trim();
      const address = String(payload.address || '').trim();
      const pincode = String(payload.pincode || '').trim();
      const city = String(payload.city || '').trim();
      if (!str(legalName, 2, 120)) fail(400, 'Enter the legal business name.');
      if (!str(address, 5, 300)) fail(400, 'Enter the full shop address.');
      if (!pincodeOk(pincode)) fail(400, 'Enter a valid 6-digit PIN code.');
      if (!str(city, 2, 60)) fail(400, 'Enter the city.');
      const docs = Array.isArray(payload.documents) ? payload.documents.filter((d) => d && d.fileName).slice(0, 10) : [];
      if (!docs.length) fail(400, 'Upload at least one KYC document (PAN, GST, registration or ID proof).');
      const lat = Number(payload.lat);
      const lng = Number(payload.lng);
      transaction(() => {
        db.prepare(`UPDATE nb_seller_verifications SET status='submitted',legal_name=?,business_category=?,shop_type=?,description=?,address=?,pincode=?,city=?,state=?,country=?,lat=?,lng=?,contact_number=?,business_email=?,ownership_type=?,pan_number=?,gst_number=?,submitted_at=?,updated_at=? WHERE id=?`)
          .run(legalName, String(payload.businessCategory || shop.category_slug), String(payload.shopType || 'retail'),
            String(payload.description || '').slice(0, 2000) || null, address, pincode, city,
            String(payload.state || 'Delhi').slice(0, 60), String(payload.country || 'India').slice(0, 60),
            Number.isFinite(lat) ? lat : shop.lat, Number.isFinite(lng) ? lng : shop.lng,
            normalPhone(payload.contactNumber || user.phone) || user.phone, String(payload.businessEmail || email).trim().toLowerCase(),
            String(payload.ownershipType || 'sole_proprietorship').slice(0, 60),
            String(payload.pan || '').trim().toUpperCase().slice(0, 20) || null,
            String(payload.gst || '').trim().toUpperCase().slice(0, 20) || null,
            now(), now(), verification.id);
        db.prepare('UPDATE nb_shops SET name=?,address=?,pincode=?,city=?,lat=?,lng=?,phone=?,business_email=?,legal_name=?,ownership_type=?,description=? WHERE id=?')
          .run(legalName, address, pincode, city, Number.isFinite(lat) ? lat : shop.lat, Number.isFinite(lng) ? lng : shop.lng,
            normalPhone(payload.contactNumber || user.phone) || user.phone, String(payload.businessEmail || email).trim().toLowerCase(),
            legalName, String(payload.ownershipType || 'sole_proprietorship').slice(0, 60), String(payload.description || '').slice(0, 2000) || null, shop.id);
        for (const d of docs) {
          db.prepare('INSERT INTO nb_seller_documents(id,verification_id,user_id,shop_id,doc_type,file_name,file_type,file_size,storage_ref,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(uid(), verification.id, user.id, shop.id, String(d.type || 'other').slice(0, 40), String(d.fileName).slice(0, 200),
              String(d.fileType || '').slice(0, 80) || null, clampInt(d.fileSize || 0, 0, 10000000), String(d.storageRef || 'metadata-only').slice(0, 200), now());
        }
      });
      audit('seller', user.id, 'kyc_submitted', 'verification', verification.id, `${legalName} · ${docs.length} document(s)`);
      send(res, 201, { message: 'KYC submitted. Your application is now under review — you will see the decision in the Seller Hub.', status: 'submitted' });
      return true;
    }

    /* -------------------------- addresses -------------------------- */
    if (method === 'GET' && custRoute === '/addresses') {
      const s = requireCustomer(req);
      send(res, 200, { addresses: addressList(s.user_id), areas: db.prepare('SELECT pincode, locality, city FROM nb_service_areas WHERE active=1 ORDER BY locality').all() });
      return true;
    }

    if (method === 'POST' && custRoute === '/addresses') {
      const s = requireCustomer(req);
      const count = db.prepare('SELECT COUNT(*) AS n FROM nb_addresses WHERE user_id=?').get(s.user_id);
      if (Number(count.n) >= 10) fail(409, 'You can save up to 10 addresses. Remove one first.');
      const label = ['Home', 'Work', 'Other'].includes(payload.label) ? payload.label : 'Home';
      const receiver = String(payload.receiver || '').trim();
      const phone = normalPhone(payload.phone);
      const line1 = String(payload.line1 || '').trim();
      const line2 = String(payload.line2 || '').trim().slice(0, 120);
      const locality = String(payload.locality || '').trim();
      const city = String(payload.city || 'New Delhi').trim().slice(0, 60);
      const pincode = String(payload.pincode || '').trim();
      const landmark = String(payload.landmark || '').trim().slice(0, 120);
      const instructions = String(payload.instructions || '').trim().slice(0, 240);
      if (!str(receiver, 2, 80)) fail(400, 'Enter the name of the person receiving the order.');
      if (!phoneOk(phone)) fail(400, 'Enter a valid 10-digit contact number for this address.');
      if (!str(line1, 3, 120)) fail(400, 'Enter the house/flat and street address.');
      if (!str(locality, 2, 80)) fail(400, 'Enter your locality.');
      if (!pincodeOk(pincode)) fail(400, 'Enter a valid 6-digit pincode.');
      const area = pincodeArea(pincode);
      if (!area) fail(400, 'We do not recognise this pincode yet. Try 110016, 110017, 110024, 110048 or 110070.');
      const lat = Number.isFinite(Number(payload.lat)) ? Number(payload.lat) : area.lat;
      const lng = Number.isFinite(Number(payload.lng)) ? Number(payload.lng) : area.lng;
      const id = uid();
      const makeDefault = payload.isDefault === true || Number(count.n) === 0;
      transaction(() => {
        if (makeDefault) db.prepare('UPDATE nb_addresses SET is_default=0 WHERE user_id=?').run(s.user_id);
        db.prepare(`INSERT INTO nb_addresses(id,user_id,label,receiver,phone,line1,line2,locality,city,pincode,landmark,instructions,lat,lng,is_default,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, s.user_id, label, receiver, phone, line1, line2 || null, locality, city, pincode,
          landmark || null, instructions || null, lat, lng, makeDefault ? 1 : 0, now());
      });
      const address = db.prepare('SELECT * FROM nb_addresses WHERE id=?').get(id);
      send(res, 201, { address: addressDetail(address), message: `${label} address saved.` });
      return true;
    }

    if (method === 'PATCH' && custRoute.match(/^\/addresses\/[a-zA-Z0-9-]+$/)) {
      const s = requireCustomer(req);
      const id = route.split('/')[2];
      const existing = db.prepare('SELECT * FROM nb_addresses WHERE id=? AND user_id=?').get(id, s.user_id);
      if (!existing) fail(404, 'Address not found');
      const next = { ...existing };
      for (const key of ['receiver', 'line1', 'line2', 'locality', 'city', 'landmark', 'instructions']) {
        if (payload[key] !== undefined) next[key] = String(payload[key] || '').trim().slice(0, 240);
      }
      if (payload.label !== undefined) next.label = ['Home', 'Work', 'Other'].includes(payload.label) ? payload.label : next.label;
      if (payload.phone !== undefined) {
        if (!phoneOk(payload.phone)) fail(400, 'Enter a valid 10-digit contact number.');
        next.phone = normalPhone(payload.phone);
      }
      if (payload.pincode !== undefined) {
        if (!pincodeOk(payload.pincode) || !pincodeArea(payload.pincode)) fail(400, 'Enter a serviceable 6-digit pincode.');
        next.pincode = String(payload.pincode);
      }
      if (!next.receiver || !next.line1 || !next.locality) fail(400, 'Name, address and locality are required.');
      transaction(() => {
        db.prepare(`UPDATE nb_addresses SET label=?,receiver=?,phone=?,line1=?,line2=?,locality=?,city=?,pincode=?,landmark=?,instructions=? WHERE id=? AND user_id=?`)
          .run(next.label, next.receiver, next.phone, next.line1, next.line2 || null, next.locality, next.city, next.pincode,
            next.landmark || null, next.instructions || null, id, s.user_id);
        if (payload.isDefault === true) {
          db.prepare('UPDATE nb_addresses SET is_default=0 WHERE user_id=?').run(s.user_id);
          db.prepare('UPDATE nb_addresses SET is_default=1 WHERE id=?').run(id);
        }
      });
      send(res, 200, { address: addressDetail(db.prepare('SELECT * FROM nb_addresses WHERE id=?').get(id)), message: 'Address updated.' });
      return true;
    }

    if (method === 'DELETE' && custRoute.match(/^\/addresses\/[a-zA-Z0-9-]+$/)) {
      const s = requireCustomer(req);
      const id = route.split('/')[2];
      const existing = db.prepare('SELECT * FROM nb_addresses WHERE id=? AND user_id=?').get(id, s.user_id);
      if (!existing) fail(404, 'Address not found');
      const active = db.prepare("SELECT COUNT(*) AS n FROM nb_orders WHERE customer_id=? AND status NOT IN ('completed','cancelled','delivered')").get(s.user_id);
      if (Number(active.n) > 0 && existing.is_default) fail(409, 'This is your default address for an active order. Choose another default first.');
      db.prepare('DELETE FROM nb_addresses WHERE id=? AND user_id=?').run(id, s.user_id);
      if (existing.is_default) {
        const next = db.prepare('SELECT id FROM nb_addresses WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(s.user_id);
        if (next) db.prepare('UPDATE nb_addresses SET is_default=1 WHERE id=?').run(next.id);
      }
      send(res, 200, { message: 'Address removed.' });
      return true;
    }

    if (method === 'POST' && custRoute.match(/^\/addresses\/[a-zA-Z0-9-]+\/default$/)) {
      const s = requireCustomer(req);
      const id = route.split('/')[2];
      if (!db.prepare('SELECT 1 FROM nb_addresses WHERE id=? AND user_id=?').get(id, s.user_id)) fail(404, 'Address not found');
      transaction(() => {
        db.prepare('UPDATE nb_addresses SET is_default=0 WHERE user_id=?').run(s.user_id);
        db.prepare('UPDATE nb_addresses SET is_default=1 WHERE id=?').run(id);
      });
      send(res, 200, { message: 'Default address updated.' });
      return true;
    }

    /* ----------------------------- cart ---------------------------- */
    if (method === 'GET' && custRoute === '/cart') {
      const s = requireCustomer(req);
      send(res, 200, { cart: priceCart(s.user_id), addresses: addressList(s.user_id) });
      return true;
    }

    if (method === 'POST' && custRoute === '/cart/items') {
      const s = requireCustomer(req);
      const productId = String(payload.productId || '');
      const addQty = clampInt(payload.qty || 1, 1, 20);
      const product = db.prepare('SELECT * FROM nb_products WHERE id=? AND active=1').get(productId);
      if (!product) fail(404, 'This product is no longer listed.');
      const shop = db.prepare('SELECT * FROM nb_shops WHERE id=?').get(product.shop_id);
      if (!shop.is_open) fail(409, `${shop.name} is currently closed. You can keep browsing, but this item cannot be added until the shop opens.`);
      const lineCount = db.prepare('SELECT COUNT(*) AS n FROM nb_cart_items WHERE user_id=?').get(s.user_id);
      const existing = db.prepare('SELECT * FROM nb_cart_items WHERE user_id=? AND product_id=?').get(s.user_id, productId);
      if (!existing && Number(lineCount.n) >= 40) fail(409, 'Your basket has the maximum number of different items. Remove something first.');
      const nextQty = (existing ? existing.qty : 0) + addQty;
      const available = Math.max(0, product.stock - product.reserved);
      if (available <= 0) fail(409, `${product.name} is out of stock at ${shop.name}.`);
      if (nextQty > available) fail(409, `Only ${available} ${available === 1 ? 'unit is' : 'units are'} available at ${shop.name}.`);
      if (nextQty > 20) fail(409, 'You can buy up to 20 units of one item per order.');
      getCartRow(s.user_id, true);
      if (existing) {
        db.prepare('UPDATE nb_cart_items SET qty=? WHERE user_id=? AND product_id=?').run(nextQty, s.user_id, productId);
      } else {
        db.prepare('INSERT INTO nb_cart_items(user_id,product_id,qty,created_at) VALUES(?,?,?,?)').run(s.user_id, productId, addQty, now());
      }
      db.prepare('UPDATE nb_carts SET updated_at=? WHERE user_id=?').run(now(), s.user_id);
      const cart = priceCart(s.user_id);
      send(res, 200, { cart, message: `${product.name} added to your basket.` });
      return true;
    }

    if (method === 'PATCH' && custRoute.match(/^\/cart\/items\/[a-zA-Z0-9_-]+$/)) {
      const s = requireCustomer(req);
      const productId = route.split('/')[3];
      const item = db.prepare('SELECT ci.*, p.name, p.stock, p.reserved FROM nb_cart_items ci JOIN nb_products p ON p.id=ci.product_id WHERE ci.user_id=? AND ci.product_id=?').get(s.user_id, productId);
      if (!item) fail(404, 'That item is not in your basket.');
      const qty = clampInt(payload.qty, 0, 20);
      if (qty === 0) {
        db.prepare('DELETE FROM nb_cart_items WHERE user_id=? AND product_id=?').run(s.user_id, productId);
      } else {
        const available = Math.max(0, item.stock - item.reserved);
        if (qty > available) fail(409, `Only ${available} available at this shop.`);
        db.prepare('UPDATE nb_cart_items SET qty=? WHERE user_id=? AND product_id=?').run(qty, s.user_id, productId);
      }
      db.prepare('UPDATE nb_carts SET updated_at=? WHERE user_id=?').run(now(), s.user_id);
      send(res, 200, { cart: priceCart(s.user_id) });
      return true;
    }

    if (method === 'DELETE' && custRoute === '/cart/items') {
      const s = requireCustomer(req);
      db.prepare('DELETE FROM nb_cart_items WHERE user_id=?').run(s.user_id);
      db.prepare('UPDATE nb_carts SET coupon_code=NULL,updated_at=? WHERE user_id=?').run(now(), s.user_id);
      send(res, 200, { cart: priceCart(s.user_id), message: 'Basket emptied.' });
      return true;
    }

    if (method === 'DELETE' && custRoute.match(/^\/cart\/items\/[a-zA-Z0-9_-]+$/)) {
      const s = requireCustomer(req);
      const productId = route.split('/')[3];
      db.prepare('DELETE FROM nb_cart_items WHERE user_id=? AND product_id=?').run(s.user_id, productId);
      send(res, 200, { cart: priceCart(s.user_id), message: 'Item removed.' });
      return true;
    }

    if (method === 'POST' && custRoute === '/cart/merge') {
      const s = requireCustomer(req);
      const items = Array.isArray(payload.items) ? payload.items.slice(0, 40) : [];
      let added = 0;
      for (const it of items) {
        const productId = typeof it?.productId === 'string' ? it.productId : '';
        const product = db.prepare('SELECT * FROM nb_products WHERE id=? AND active=1').get(productId);
        if (!product) continue;
        const available = Math.max(0, product.stock - product.reserved);
        if (available <= 0) continue;
        const qty = clampInt(it.qty || 1, 1, Math.min(20, available));
        const existing = db.prepare('SELECT * FROM nb_cart_items WHERE user_id=? AND product_id=?').get(s.user_id, productId);
        if (existing) {
          const next = Math.min(available, 20, existing.qty + qty);
          db.prepare('UPDATE nb_cart_items SET qty=? WHERE user_id=? AND product_id=?').run(next, s.user_id, productId);
        } else {
          db.prepare('INSERT INTO nb_cart_items(user_id,product_id,qty,created_at) VALUES(?,?,?,?)').run(s.user_id, productId, qty, now());
        }
        added += 1;
      }
      send(res, 200, { cart: priceCart(s.user_id), merged: added, message: added ? `${added} item${added === 1 ? '' : 's'} moved into your basket.` : 'Your basket is up to date.' });
      return true;
    }

    if (method === 'POST' && custRoute === '/cart/coupon') {
      const s = requireCustomer(req);
      const code = String(payload.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9-]{3,24}$/.test(code)) fail(400, 'Enter a valid coupon code.');
      const rows = cartLines(s.user_id);
      if (!rows.length) fail(409, 'Add something to your basket before applying a coupon.');
      const coupon = db.prepare('SELECT * FROM nb_coupons WHERE code=?').get(code);
      const check = couponUsable(coupon, s.user_id, rows, rows.reduce((t, r) => t + r.price_paise * r.qty, 0));
      if (!check.ok) fail(400, check.message);
      db.prepare('UPDATE nb_carts SET coupon_code=?,updated_at=? WHERE user_id=?').run(code, now(), s.user_id);
      send(res, 200, { cart: priceCart(s.user_id), message: `${code} applied.` });
      return true;
    }

    if (method === 'DELETE' && custRoute === '/cart/coupon') {
      const s = requireCustomer(req);
      getCartRow(s.user_id, true);
      db.prepare('UPDATE nb_carts SET coupon_code=NULL,updated_at=? WHERE user_id=?').run(now(), s.user_id);
      send(res, 200, { cart: priceCart(s.user_id), message: 'Coupon removed.' });
      return true;
    }

    if (method === 'POST' && custRoute === '/checkout/quote') {
      const s = requireCustomer(req);
      const quote = quoteFor(s.user_id, payload);
      send(res, 200, { quote });
      return true;
    }

    /* ---------------------------- orders --------------------------- */
    if (method === 'POST' && custRoute === '/orders') {
      const s = requireCustomer(req);
      rateLimit(`checkout:${s.user_id}`, 12, 300e3);
      const idempotencyKey = typeof payload.idempotencyKey === 'string' && payload.idempotencyKey.length >= 8 && payload.idempotencyKey.length <= 80
        ? payload.idempotencyKey : uid();
      const prior = db.prepare('SELECT * FROM nb_orders WHERE customer_id=? AND idempotency_key=?').get(s.user_id, idempotencyKey);
      if (prior) {
        send(res, 200, { order: orderDetail(prior, { includeCodes: true }), duplicate: true });
        return true;
      }
      const paymentMethod = ['cod', 'pay_at_store', 'online'].includes(payload.paymentMethod) ? payload.paymentMethod : 'cod';
      const quote = quoteFor(s.user_id, payload);
      if (quote.rejectedCoupon) fail(400, quote.rejectedCoupon.message);
      if (quote.issues.length) fail(409, quote.issues[0], { issues: quote.issues });
      if (paymentMethod === 'pay_at_store' && !quote.groups.every((g) => g.fulfillment === 'pickup')) {
        fail(400, 'Pay at store is only available when every shop in this order is set to store pickup.');
      }
      if (paymentMethod === 'online' && !GATEWAY.configured) {
        fail(503, 'Online payment is not configured on this server. Choose cash on delivery or pay at store, or ask the operator to add the gateway keys.');
      }
      const user = db.prepare('SELECT * FROM nb_users WHERE id=?').get(s.user_id);
      const address = quote.address;
      const orderId = uid();
      const orderCode = newOrderCode();
      const created = now();
      const couponRow = quote.coupon ? db.prepare('SELECT * FROM nb_coupons WHERE code=?').get(quote.coupon.code) : null;
      let result;
      transaction(() => {
        const lines = cartLines(s.user_id);
        if (!lines.length) fail(409, 'Your basket is empty.');
        // Conditional reservation prevents overselling under concurrency.
        for (const line of lines) {
          const upd = db.prepare('UPDATE nb_products SET reserved=reserved+? WHERE id=? AND active=1 AND stock-reserved>=?')
            .run(line.qty, line.id, line.qty);
          if (Number(upd.changes) !== 1) fail(409, `${line.name} just went out of stock at ${line.shop_name}. Remove it and try again.`);
        }
        db.prepare(`INSERT INTO nb_orders
          (id,code,customer_id,status,payment_method,payment_status,address_json,subtotal_paise,discount_paise,delivery_fee_paise,tax_paise,total_paise,coupon_code,note,idempotency_key,is_demo,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          orderId, orderCode, s.user_id, 'placed', paymentMethod, 'pending', JSON.stringify(address),
          quote.subtotal, quote.discount, quote.deliveryFee, quote.tax, quote.total,
          quote.coupon?.code || null, String(payload.note || '').trim().slice(0, 300) || null,
          idempotencyKey, user.is_demo ? 1 : 0, created, created
        );
        addEvent(orderId, null, 'placed', 'Order placed', `${quote.groups.length} shop${quote.groups.length === 1 ? '' : 's'} · ${paymentMethod === 'cod' ? 'Cash on delivery' : paymentMethod === 'pay_at_store' ? 'Pay at store' : 'Online payment pending'}`, 'customer');
        const createdSellerOrders = [];
        for (const group of quote.groups) {
          const sellerOrderId = uid();
          const sellerCode = newSellerCode();
          db.prepare(`INSERT INTO nb_seller_orders
            (id,code,order_id,shop_id,status,fulfillment,subtotal_paise,discount_paise,delivery_fee_paise,tax_paise,total_paise,prep_minutes,ready_at,accepted_at,rejected_reason,cancelled_at,delivered_at,completed_at,runner_id,delivery_otp_expires,delivery_attempts,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,0,?,?)`).run(
            sellerOrderId, sellerCode, orderId, group.shop.id, 'placed', group.fulfillment,
            group.subtotal, group.discount, group.deliveryFee, group.tax, group.total, group.shop.prepMinutes,
            new Date(Date.now() + 72 * 3600e3).toISOString(), created, created
          );
          createdSellerOrders.push({ id: sellerOrderId, shop_id: group.shop.id, total_paise: group.total, created_at: created });
          for (const item of group.items) {
            const product = db.prepare('SELECT * FROM nb_products WHERE id=?').get(item.productId);
            db.prepare(`INSERT INTO nb_order_items
              (id,order_id,seller_order_id,product_id,shop_id,name,brand,unit,qty,price_paise,mrp_paise,tax_rate,line_total_paise,image_url,emoji,compare_key)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
              uid(), orderId, sellerOrderId, item.productId, group.shop.id, product.name, product.brand, product.unit,
              item.qty, item.price, item.mrp, product.tax_rate, item.lineTotal, product.image_url, product.emoji, product.compare_key
            );
          }
          addEvent(orderId, sellerOrderId, 'placed', 'Seller notified', `${group.shop.name} received this part of the order.`, 'system');
          const owner = db.prepare('SELECT owner_user_id FROM nb_shops WHERE id=?').get(group.shop.id)?.owner_user_id;
          if (owner) notify(owner, 'New order received', `${sellerCode} · ${group.items.reduce((t, i) => t + i.qty, 0)} item(s) · ₹${Math.round(group.total / 100)}. Accept or reject it in your Seller Hub.`, 'seller', '#/orders');
        }
        const initialPaymentId = uid();
        db.prepare(`INSERT INTO nb_payment_records(id,order_id,seller_order_id,provider,method,amount_paise,status,reference,created_at,updated_at)
          VALUES(?,?,NULL,?,?,?,?,?,?,?)`).run(
          initialPaymentId, orderId, paymentMethod === 'cod' ? 'cash' : paymentMethod === 'pay_at_store' ? 'store' : 'razorpay',
          paymentMethod, quote.total, 'pending', null, created, created
        );
        syncPaymentAllocations(initialPaymentId, orderId, createdSellerOrders, quote.total, created);
        if (couponRow) {
          db.prepare('INSERT INTO nb_coupon_redemptions(id,coupon_code,user_id,order_id,amount_paise,created_at) VALUES(?,?,?,?,?,?)')
            .run(uid(), couponRow.code, s.user_id, orderId, quote.discount, created);
          db.prepare('UPDATE nb_coupons SET used_count=used_count+1 WHERE code=?').run(couponRow.code);
        }
        db.prepare('DELETE FROM nb_cart_items WHERE user_id=?').run(s.user_id);
        db.prepare('UPDATE nb_carts SET coupon_code=NULL,updated_at=? WHERE user_id=?').run(now(), s.user_id);
        notify(s.user_id, 'Order placed', `${orderCode} · ₹${Math.round(quote.total / 100)}. We have notified ${quote.groups.length === 1 ? quote.groups[0].shop.name : quote.groups.length + ' shops'}.`, 'order', `#/orders/${orderCode}`);
        audit('customer', s.user_id, 'order_created', 'order', orderId, `${orderCode} · ${paymentMethod} · ${quote.total}`);
        result = orderDetail(db.prepare('SELECT * FROM nb_orders WHERE id=?').get(orderId), { includeCodes: true });
      });
      send(res, 201, { order: result, message: 'Order placed. The seller has been notified.' });
      return true;
    }

    if (method === 'GET' && custRoute === '/orders') {
      const s = requireCustomer(req);
      const filter = String(q.get('filter') || 'all');
      const search = String(q.get('q') || '').toLowerCase();
      let rows = db.prepare('SELECT * FROM nb_orders WHERE customer_id=? ORDER BY created_at DESC').all(s.user_id);
      let summaries = rows.map((o) => orderSummary(o));
      if (filter === 'in_progress') summaries = summaries.filter((o) => ['placed', 'accepted', 'preparing', 'ready', 'runner_requested', 'runner_assigned', 'out_for_delivery', 'partially_cancelled'].includes(o.status));
      else if (filter === 'delivered') summaries = summaries.filter((o) => ['delivered', 'completed'].includes(o.status));
      else if (filter === 'cancelled') summaries = summaries.filter((o) => o.status === 'cancelled');
      else if (filter === 'returned' || filter === 'refunded') {
        const codes = new Set(db.prepare("SELECT o.code FROM nb_orders o JOIN nb_returns r ON r.order_id=o.id WHERE r.customer_id=? AND r.status IN ('requested','under_review','approved','processing','completed')").all(s.user_id).map((r) => r.code));
        summaries = summaries.filter((o) => codes.has(o.code));
      }
      if (search) summaries = summaries.filter((o) => o.code.toLowerCase().includes(search) || o.shops.some((s2) => s2.shop?.name.toLowerCase().includes(search)));
      const total = summaries.length;
      const start = (page - 1) * limit;
      send(res, 200, {
        orders: summaries.slice(start, start + limit), total, page, pages: Math.max(1, Math.ceil(total / limit)),
        counts: {
          all: rows.length,
          in_progress: rows.map((o) => orderSummary(o)).filter((o) => ['placed', 'accepted', 'preparing', 'ready', 'runner_requested', 'runner_assigned', 'out_for_delivery', 'partially_cancelled'].includes(o.status)).length,
          delivered: rows.map((o) => orderSummary(o)).filter((o) => ['delivered', 'completed'].includes(o.status)).length,
          cancelled: rows.map((o) => orderSummary(o)).filter((o) => o.status === 'cancelled').length
        }
      });
      return true;
    }

    if (method === 'GET' && custRoute.match(/^\/orders\/[A-Za-z0-9-]+\/receipt$/)) {
      const s = requireCustomer(req);
      const code = decodeURIComponent(route.split('/')[2]);
      const order = orderByCode(code, s.user_id);
      const sellerCode = q.get('sellerOrder');
      const so = sellerCode
        ? db.prepare('SELECT * FROM nb_seller_orders WHERE order_id=? AND code=?').get(order.id, sellerCode)
        : db.prepare('SELECT * FROM nb_seller_orders WHERE order_id=? ORDER BY created_at LIMIT 1').get(order.id);
      if (!so) fail(404, 'Receipt not found');
      const shop = db.prepare('SELECT * FROM nb_shops WHERE id=?').get(so.shop_id);
      const customer = db.prepare('SELECT * FROM nb_users WHERE id=?').get(order.customer_id);
      sendHtml(res, 200, receiptHtml(order, so, shop, customer, 'customer'));
      return true;
    }

    if (method === 'GET' && custRoute.match(/^\/orders\/[A-Za-z0-9-]+$/)) {
      const s = requireCustomer(req);
      const code = decodeURIComponent(route.split('/')[2]);
      const order = orderByCode(code, s.user_id);
      send(res, 200, { order: orderDetail(order, { includeCodes: true }) });
      return true;
    }

    if (method === 'POST' && custRoute.match(/^\/orders\/[A-Za-z0-9-]+\/cancel$/)) {
      const s = requireCustomer(req);
      const code = decodeURIComponent(route.split('/')[2]);
      const order = orderByCode(code, s.user_id);
      const reason = String(payload.reason || '').trim();
      if (!str(reason, 3, 200)) fail(400, 'Tell us why you want to cancel (at least 3 characters).');
      const target = payload.sellerOrderId
        ? [db.prepare('SELECT * FROM nb_seller_orders WHERE order_id=? AND code=?').get(order.id, String(payload.sellerOrderId))]
        : db.prepare('SELECT * FROM nb_seller_orders WHERE order_id=?').all(order.id);
      if (!target[0]) fail(404, 'Shop order not found');
      for (const so of target) {
        if (!['placed', 'accepted'].includes(so.status)) {
          fail(409, `${so.code} can no longer be cancelled online because the shop has already started preparing it. Contact support for help.`);
        }
      }
      transaction(() => {
        for (const so of target) cancelSellerOrder(so, reason, 'customer');
        audit('customer', s.user_id, 'order_cancelled', 'order', order.id, reason);
      });
      send(res, 200, { order: orderDetail(db.prepare('SELECT * FROM nb_orders WHERE id=?').get(order.id), { includeCodes: true }), message: 'Order cancelled. Any reserved stock has been released.' });
      return true;
    }

    /* ---------------------------- returns -------------------------- */
    const validImages = (images) => {
      if (!Array.isArray(images)) return [];
      return images.slice(0, 3).filter((v) => typeof v === 'string' && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length < 180000);
    };

    if (method === 'POST' && custRoute.match(/^\/orders\/[A-Za-z0-9-]+\/returns$/)) {
      const s = requireCustomer(req);
      const code = decodeURIComponent(route.split('/')[2]);
      const order = orderByCode(code, s.user_id);
      const so = db.prepare('SELECT * FROM nb_seller_orders WHERE order_id=? AND id=?').get(order.id, String(payload.sellerOrderId || ''));
      if (!so) fail(404, 'Shop order not found.');
      if (!['delivered', 'completed'].includes(so.status)) fail(409, 'You can request a return only after the order is delivered.');
      const item = db.prepare('SELECT * FROM nb_order_items WHERE id=? AND seller_order_id=?').get(String(payload.itemId || ''), so.id);
      if (!item) fail(400, 'Choose an item from this order.');
      const product = db.prepare('SELECT * FROM nb_products WHERE id=?').get(item.product_id);
      const days = product?.return_days || 0;
      if (!days) fail(409, `${item.name} is not returnable. Perishable items can only be reported as damaged through support.`);
      const deliveredAt = so.delivered_at || so.completed_at || so.updated_at;
      if (Date.now() - new Date(deliveredAt).getTime() > days * 864e5) fail(409, `The ${days}-day return window for this item has closed.`);
      const reason = String(payload.reason || '').trim();
      if (!str(reason, 3, 160)) fail(400, 'Choose a return reason.');
      const images = validImages(payload.images);
      const duplicate = db.prepare("SELECT 1 FROM nb_returns WHERE item_id=? AND status NOT IN ('rejected','cancelled','completed')").get(item.id);
      if (duplicate) fail(409, 'A return request for this item is already open.');
      const returnId = uid();
      let returnCode;
      for (let i = 0; i < 6; i++) {
        returnCode = 'RTN-' + String(Math.floor(100000 + Math.random() * 900000));
        if (!db.prepare('SELECT 1 FROM nb_returns WHERE code=?').get(returnCode)) break;
      }
      transaction(() => {
        const ts = now();
        db.prepare(`INSERT INTO nb_returns(id,code,customer_id,order_id,seller_order_id,item_id,reason,comment,images_json,status,refund_amount_paise,decision_note,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`).run(returnId, returnCode, s.user_id, order.id, so.id, item.id, reason,
          String(payload.comment || '').trim().slice(0, 800) || null, JSON.stringify(images), 'requested', item.line_total_paise, ts, ts);
        db.prepare('INSERT INTO nb_refunds(id,return_id,order_id,seller_order_id,reason,amount_paise,status,reference,created_at,updated_at) VALUES(?,?,?,?,?,?,?,NULL,?,?)')
          .run(uid(), returnId, order.id, so.id, 'return', item.line_total_paise, 'requested', ts, ts);
        addEvent(order.id, so.id, 'return_requested', 'Return requested', `${item.name} · ${reason}`, 'customer');
        notify(s.user_id, 'Return request received', `${returnCode} for ${item.name}. The shop will review it and you can follow the refund status in My Account.`, 'return', '#/account/returns');
      });
      audit('customer', s.user_id, 'return_requested', 'return', returnId, `${returnCode} · ${item.name}`);
      send(res, 201, { return: { code: returnCode, status: 'requested' }, message: `Return ${returnCode} submitted. The shop will review it.` });
      return true;
    }

    if (method === 'GET' && custRoute === '/returns') {
      const s = requireCustomer(req);
      const rows = db.prepare(`SELECT r.*, o.code AS order_code, so.code AS seller_order_code, s.name AS shop_name, s.slug AS shop_slug,
          i.name AS item_name, i.emoji AS item_emoji, i.qty AS item_qty
        FROM nb_returns r JOIN nb_orders o ON o.id=r.order_id JOIN nb_seller_orders so ON so.id=r.seller_order_id
        LEFT JOIN nb_shops s ON s.id=so.shop_id LEFT JOIN nb_order_items i ON i.id=r.item_id
        WHERE r.customer_id=? ORDER BY r.created_at DESC`).all(s.user_id);
      const refunds = db.prepare(`SELECT r.*, o.code AS order_code, so.code AS seller_order_code, s.name AS shop_name
        FROM nb_refunds r
        JOIN nb_orders o ON o.id=r.order_id
        LEFT JOIN nb_returns ret ON ret.id=r.return_id
        LEFT JOIN nb_seller_orders so ON so.id=COALESCE(r.seller_order_id, ret.seller_order_id)
        LEFT JOIN nb_shops s ON s.id=so.shop_id
        WHERE o.customer_id=? ORDER BY r.created_at DESC`).all(s.user_id);
      send(res, 200, {
        returns: rows.map((r) => ({
          code: r.code, status: r.status, reason: r.reason, comment: r.comment, images: JSON.parse(r.images_json || '[]'),
          amount: r.refund_amount_paise, createdAt: r.created_at, updatedAt: r.updated_at, decisionNote: r.decision_note,
          orderCode: r.order_code, sellerOrderCode: r.seller_order_code, shop: { name: r.shop_name, slug: r.shop_slug },
          item: { name: r.item_name, emoji: r.item_emoji, qty: r.item_qty }
        })),
        refunds: refunds.map((r) => ({
          id: r.id, orderCode: r.order_code, sellerOrderCode: r.seller_order_code || null, shopName: r.shop_name || null,
          amount: r.amount_paise, status: r.status, reference: r.reference, at: r.created_at, updatedAt: r.updated_at
        }))
      });
      return true;
    }

    /* ---------------------------- reviews -------------------------- */
    if (method === 'POST' && custRoute === '/reviews') {
      const s = requireCustomer(req);
      const order = orderByCode(String(payload.orderCode || ''), s.user_id);
      const so = db.prepare('SELECT * FROM nb_seller_orders WHERE order_id=? AND id=?').get(order.id, String(payload.sellerOrderId || ''));
      if (!so) fail(404, 'Order not found.');
      if (!['delivered', 'completed'].includes(so.status)) fail(409, 'You can review this order after it is delivered.');
      const productId = String(payload.productId || '');
      if (productId && !db.prepare('SELECT 1 FROM nb_order_items WHERE seller_order_id=? AND product_id=?').get(so.id, productId)) {
        fail(403, 'Only a product you actually bought can be reviewed.');
      }
      const shopRating = clampInt(payload.shopRating || payload.rating, 1, 5);
      const productRating = productId ? clampInt(payload.productRating || payload.rating, 1, 5) : null;
      const body = String(payload.body || '').trim();
      if (!str(body, 10, 1200)) fail(400, 'Please write at least 10 characters about your experience.');
      const images = validImages(payload.images);
      if (db.prepare('SELECT 1 FROM nb_reviews WHERE customer_id=? AND seller_order_id=? AND IFNULL(product_id,\'\')=?').get(s.user_id, so.id, productId)) {
        fail(409, 'You have already reviewed this item for this order.');
      }
      const id = uid();
      transaction(() => {
        db.prepare(`INSERT INTO nb_reviews(id,customer_id,shop_id,product_id,seller_order_id,order_id,shop_rating,product_rating,title,body,images_json,verified_purchase,status,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,1,'published',?)`).run(id, s.user_id, so.shop_id, productId || null, so.id, order.id,
          shopRating, productRating, String(payload.title || '').trim().slice(0, 90) || null, body, JSON.stringify(images), now());
        const shopAgg = db.prepare("SELECT AVG(shop_rating) AS avg, COUNT(*) AS n FROM nb_reviews WHERE shop_id=? AND status='published'").get(so.shop_id);
        db.prepare('UPDATE nb_shops SET rating=?,review_count=? WHERE id=?').run(round2(shopAgg.avg || 0), Number(shopAgg.n || 0), so.shop_id);
        if (productId) {
          const pAgg = db.prepare("SELECT AVG(product_rating) AS avg, COUNT(*) AS n FROM nb_reviews WHERE product_id=? AND status='published'").get(productId);
          db.prepare('UPDATE nb_products SET rating=?,review_count=? WHERE id=?').run(round2(pAgg.avg || 0), Number(pAgg.n || 0), productId);
        }
      });
      notify(s.user_id, 'Thanks for your review', 'Your verified review is now published. It helps neighbours choose local shops with confidence.', 'review', '#/account/reviews');
      send(res, 201, { message: 'Review published. Thank you for supporting local shops.' });
      return true;
    }

    if (method === 'GET' && custRoute === '/reviews/mine') {
      const s = requireCustomer(req);
      const rows = db.prepare(`SELECT r.*, s.name AS shop_name, s.slug AS shop_slug, p.name AS product_name, p.emoji AS product_emoji
        FROM nb_reviews r LEFT JOIN nb_shops s ON s.id=r.shop_id LEFT JOIN nb_products p ON p.id=r.product_id
        WHERE r.customer_id=? ORDER BY r.created_at DESC`).all(s.user_id);
      send(res, 200, { reviews: rows.map((r) => ({
        id: r.id, shop: { name: r.shop_name, slug: r.shop_slug }, product: r.product_name ? { name: r.product_name, emoji: r.product_emoji } : null,
        shopRating: r.shop_rating, productRating: r.product_rating, rating: r.product_rating || r.shop_rating,
        title: r.title, body: r.body, images: JSON.parse(r.images_json || '[]'), status: r.status,
        verified: Boolean(r.verified_purchase), at: r.created_at
      })) });
      return true;
    }

    if (method === 'POST' && custRoute.match(/^\/reviews\/[a-zA-Z0-9-]+\/report$/)) {
      const s = requireCustomer(req);
      const id = route.split('/')[2];
      const review = db.prepare('SELECT * FROM nb_reviews WHERE id=?').get(id);
      if (!review) fail(404, 'Review not found');
      if (review.customer_id === s.user_id) fail(400, 'You cannot report your own review.');
      const reason = String(payload.reason || '').trim().slice(0, 300);
      audit('customer', s.user_id, 'review_reported', 'review', id, reason || 'Reported from the storefront');
      send(res, 200, { message: 'Thanks — the review has been sent to moderation. It stays visible until a moderator decides.' });
      return true;
    }

    /* ---------------------------- wishlist ------------------------- */
    if (method === 'GET' && custRoute === '/wishlist') {
      const s = requireCustomer(req);
      const location = locationFromQuery(q);
      const rows = db.prepare(`SELECT p.* FROM nb_wishlist w JOIN nb_products p ON p.id=w.product_id
        JOIN nb_shops sh ON sh.id=p.shop_id WHERE w.user_id=? AND p.active=1 ORDER BY w.created_at DESC`).all(s.user_id);
      send(res, 200, { products: rows.map((p) => productCard(p, { location })), count: rows.length });
      return true;
    }

    if (method === 'POST' && custRoute.match(/^\/wishlist\/[a-zA-Z0-9_-]+$/)) {
      const s = requireCustomer(req);
      const productId = route.split('/')[2];
      if (!db.prepare('SELECT 1 FROM nb_products WHERE id=? AND active=1').get(productId)) fail(404, 'Product not found');
      db.prepare('INSERT OR IGNORE INTO nb_wishlist(user_id,product_id,created_at) VALUES(?,?,?)').run(s.user_id, productId, now());
      send(res, 200, { saved: true, message: 'Saved to your wishlist.' });
      return true;
    }

    if (method === 'DELETE' && custRoute.match(/^\/wishlist\/[a-zA-Z0-9_-]+$/)) {
      const s = requireCustomer(req);
      const productId = route.split('/')[2];
      db.prepare('DELETE FROM nb_wishlist WHERE user_id=? AND product_id=?').run(s.user_id, productId);
      send(res, 200, { saved: false, message: 'Removed from your wishlist.' });
      return true;
    }

    /* --------------------------- account --------------------------- */
    if (method === 'GET' && custRoute === '/account') {
      const s = requireCustomer(req);
      const userId = s.user_id;
      const orders = db.prepare('SELECT * FROM nb_orders WHERE customer_id=? ORDER BY created_at DESC').all(userId).map((o) => orderSummary(o));
      const counts = {
        orders: orders.length,
        pending: orders.filter((o) => ['placed', 'accepted', 'preparing', 'ready', 'runner_requested', 'runner_assigned', 'out_for_delivery'].includes(o.status)).length,
        completed: orders.filter((o) => ['delivered', 'completed'].includes(o.status)).length,
        cancelled: orders.filter((o) => o.status === 'cancelled').length,
        addresses: Number(db.prepare('SELECT COUNT(*) AS n FROM nb_addresses WHERE user_id=?').get(userId).n),
        wishlist: Number(db.prepare('SELECT COUNT(*) AS n FROM nb_wishlist WHERE user_id=?').get(userId).n),
        reviews: Number(db.prepare('SELECT COUNT(*) AS n FROM nb_reviews WHERE customer_id=?').get(userId).n),
        returns: Number(db.prepare('SELECT COUNT(*) AS n FROM nb_returns WHERE customer_id=?').get(userId).n),
        tickets: Number(db.prepare("SELECT COUNT(*) AS n FROM nb_tickets WHERE customer_id=? AND status NOT IN ('resolved','closed')").get(userId).n),
        unread: Number(db.prepare('SELECT COUNT(*) AS n FROM nb_notifications WHERE user_id=? AND is_read=0').get(userId).n)
      };
      send(res, 200, {
        user: userPayload(s), addresses: addressList(userId), counts,
        recentOrders: orders.slice(0, 3),
        addressesPreview: addressList(userId).slice(0, 2)
      });
      return true;
    }

    if (method === 'PATCH' && custRoute === '/account') {
      const s = requireCustomer(req);
      const user = db.prepare('SELECT * FROM nb_users WHERE id=?').get(s.user_id);
      const name = payload.name !== undefined ? String(payload.name).trim() : user.name;
      if (!str(name, 2, 80)) fail(400, 'Name must be 2–80 characters.');
      const avatar = payload.avatar !== undefined ? String(payload.avatar).slice(0, 8) : user.avatar;
      db.prepare('UPDATE nb_users SET name=?,avatar=? WHERE id=?').run(name, avatar || '👤', s.user_id);
      if (payload.marketingOptIn !== undefined || payload.orderUpdates !== undefined) {
        db.prepare('UPDATE nb_customer_profiles SET marketing_opt_in=?,order_updates=? WHERE user_id=?')
          .run(payload.marketingOptIn === false ? 0 : 1, payload.orderUpdates === false ? 0 : 1, s.user_id);
      }
      send(res, 200, { user: userPayload(sessionFor(req)), message: 'Profile updated.' });
      return true;
    }

    if (method === 'POST' && custRoute === '/account/password') {
      const s = requireCustomer(req);
      const user = db.prepare('SELECT * FROM nb_users WHERE id=?').get(s.user_id);
      if (!checkPassword(payload.current || '', user.password_hash)) fail(400, 'Your current password is not correct.');
      if (typeof payload.password !== 'string' || payload.password.length < 8 || !/[A-Za-z]/.test(payload.password) || !/\d/.test(payload.password)) {
        fail(400, 'Choose a new password of at least 8 characters with a letter and a number.');
      }
      if (payload.confirm !== undefined && payload.confirm !== payload.password) fail(400, 'The new passwords do not match.');
      db.prepare('UPDATE nb_users SET password_hash=? WHERE id=?').run(makePassword(payload.password), s.user_id);
      db.prepare('DELETE FROM nb_sessions WHERE user_id=? AND token_hash<>?').run(s.user_id, sha(s.token));
      audit('customer', s.user_id, 'password_changed', 'user', s.user_id, 'Password changed from account settings');
      send(res, 200, { message: 'Password changed. Other devices have been signed out.' });
      return true;
    }

    if (method === 'POST' && (custRoute === '/account/email/request' || custRoute === '/account/phone/request')) {
      const s = requireCustomer(req);
      rateLimit(`contact-change:${s.user_id}`, 6, 600e3);
      const isEmail = route.includes('/email/');
      const target = isEmail ? String(payload.email || '').trim().toLowerCase() : normalPhone(payload.phone);
      if (isEmail && !emailOk(target)) fail(400, 'Enter a valid email address.');
      if (!isEmail && !phoneOk(target)) fail(400, 'Enter a valid 10-digit mobile number.');
      if (db.prepare(`SELECT 1 FROM nb_users WHERE ${isEmail ? 'email' : 'phone'}=? AND id<>?`).get(target, s.user_id)) fail(409, 'That contact detail is already used by another account.');
      rateLimit(`contact-code:${s.user_id}`, 6, 600e3);
      const code = String(Math.floor(100000 + Math.random() * 900000));
      db.prepare('INSERT INTO nb_otp_codes(id,user_id,channel,purpose,target,code_hash,expires_at,attempts,created_at) VALUES(?,?,?,?,?,?,?,0,?)')
        .run(uid(), s.user_id, isEmail ? 'email' : 'phone', 'change_contact', target, sha(code), new Date(Date.now() + 10 * 60000).toISOString(), now());
      send(res, 200, {
        target, sent: false, providerConfigured: false,
        message: `No ${isEmail ? 'email' : 'SMS'} provider is configured, so the code is shown here in development.`,
        ...(DEV_CODES ? { devCode: code } : {})
      });
      return true;
    }

    if (method === 'POST' && (custRoute === '/account/email/confirm' || custRoute === '/account/phone/confirm')) {
      const s = requireCustomer(req);
      const isEmail = route.includes('/email/');
      const channel = isEmail ? 'email' : 'phone';
      const row = db.prepare("SELECT * FROM nb_otp_codes WHERE user_id=? AND channel=? AND purpose='change_contact' AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1").get(s.user_id, channel);
      if (!row) fail(400, 'Request a new verification code first.');
      if (new Date(row.expires_at).getTime() < Date.now()) fail(400, 'That code has expired.');
      if (row.attempts >= 5) fail(429, 'Too many incorrect codes. Request a new one.');
      if (!safeEqual(sha(String(payload.code || '')), row.code_hash)) {
        db.prepare('UPDATE nb_otp_codes SET attempts=attempts+1 WHERE id=?').run(row.id);
        fail(400, 'That code is not correct.');
      }
      db.prepare('UPDATE nb_otp_codes SET consumed_at=? WHERE id=?').run(now(), row.id);
      db.prepare(`UPDATE nb_users SET ${channel}=?, ${channel}_verified=1 WHERE id=?`).run(row.target, s.user_id);
      audit('customer', s.user_id, 'contact_changed', 'user', s.user_id, `${channel} updated`);
      send(res, 200, { message: `${isEmail ? 'Email' : 'Mobile number'} updated and verified.`, user: userPayload(sessionFor(req)) });
      return true;
    }

    if (method === 'GET' && custRoute === '/account/sessions') {
      const s = requireCustomer(req);
      const rows = db.prepare('SELECT token_hash,created_at,expires_at,user_agent FROM nb_sessions WHERE user_id=? ORDER BY created_at DESC').all(s.user_id);
      send(res, 200, { sessions: rows.map((r) => ({
        id: r.token_hash.slice(0, 16), createdAt: r.created_at, expiresAt: r.expires_at,
        device: r.user_agent || 'Unknown device', current: r.token_hash === sha(s.token)
      })) });
      return true;
    }

    if (method === 'POST' && custRoute === '/account/sessions/revoke') {
      const s = requireCustomer(req);
      if (payload.all === true) {
        db.prepare('DELETE FROM nb_sessions WHERE user_id=?').run(s.user_id);
      } else if (payload.id) {
        const row = db.prepare('SELECT token_hash FROM nb_sessions WHERE user_id=? AND token_hash LIKE ?').get(s.user_id, `${String(payload.id)}%`);
        if (!row) fail(404, 'Session not found');
        if (row.token_hash === sha(s.token)) fail(400, 'Use Sign out to end this session.');
        db.prepare('DELETE FROM nb_sessions WHERE token_hash=?').run(row.token_hash);
      } else fail(400, 'Choose a session to revoke.');
      send(res, 200, { message: 'Session ended.' });
      return true;
    }

    /* ------------------------- notifications ----------------------- */
    if (method === 'GET' && custRoute === '/notifications') {
      const s = requireCustomer(req);
      const rows = db.prepare('SELECT * FROM nb_notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(s.user_id);
      send(res, 200, {
        notifications: rows.map((n) => ({ id: n.id, title: n.title, body: n.body, type: n.type, link: n.link, read: Boolean(n.is_read), at: n.created_at })),
        unread: rows.filter((n) => !n.is_read).length
      });
      return true;
    }

    if (method === 'POST' && custRoute === '/notifications/read') {
      const s = requireCustomer(req);
      if (payload.all === true) db.prepare('UPDATE nb_notifications SET is_read=1 WHERE user_id=?').run(s.user_id);
      else if (Array.isArray(payload.ids)) {
        const ids = payload.ids.map((n) => Number(n)).filter(Number.isSafeInteger).slice(0, 100);
        const stmt = db.prepare('UPDATE nb_notifications SET is_read=1 WHERE id=? AND user_id=?');
        for (const id of ids) stmt.run(id, s.user_id);
      } else fail(400, 'Choose notifications to mark as read.');
      send(res, 200, { ok: true });
      return true;
    }

    /* --------------------------- support --------------------------- */
    const TICKET_CATEGORIES = ['order', 'payment', 'delivery', 'missing', 'damaged', 'wrong', 'return', 'shop', 'account', 'other'];

    if (method === 'GET' && custRoute === '/tickets') {
      const s = requireCustomer(req);
      const rows = db.prepare('SELECT * FROM nb_tickets WHERE customer_id=? ORDER BY created_at DESC').all(s.user_id);
      send(res, 200, { tickets: rows.map((t) => ({
        code: t.code, category: t.category, subject: t.subject, status: t.status, priority: t.priority,
        createdAt: t.created_at, updatedAt: t.updated_at
      })) });
      return true;
    }

    if (method === 'POST' && custRoute === '/tickets') {
      const s = requireCustomer(req);
      rateLimit(`ticket:${s.user_id}`, 8, 3600e3);
      const category = TICKET_CATEGORIES.includes(payload.category) ? payload.category : null;
      if (!category) fail(400, 'Choose a complaint category.');
      if (!str(payload.subject, 5, 120)) fail(400, 'Add a subject of 5–120 characters.');
      if (!str(payload.description, 20, 2000)) fail(400, 'Describe the issue in at least 20 characters.');
      let orderId = null;
      if (payload.orderCode) {
        const order = orderByCode(String(payload.orderCode).trim().toUpperCase(), s.user_id);
        orderId = order.id;
      }
      const code = 'TKT-' + String(Math.floor(100000 + Math.random() * 900000));
      const id = uid();
      const attachment = typeof payload.attachment === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(payload.attachment) && payload.attachment.length < 180000 ? payload.attachment : null;
      transaction(() => {
        db.prepare(`INSERT INTO nb_tickets(id,code,customer_id,order_id,category,subject,description,attachment,status,priority,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?, 'open','normal',?,?)`).run(id, code, s.user_id, orderId, category, payload.subject.trim(), payload.description.trim(), attachment, now(), now());
        db.prepare('INSERT INTO nb_ticket_messages(id,ticket_id,author_role,author_name,body,created_at) VALUES(?,?,?,?,?,?)')
          .run(uid(), id, 'customer', db.prepare('SELECT name FROM nb_users WHERE id=?').get(s.user_id).name, payload.description.trim(), now());
      });
      notify(s.user_id, 'Support ticket created', `${code}: ${payload.subject.trim()}. You can follow replies in Help → My tickets.`, 'support', `#/help/tickets/${code}`);
      send(res, 201, { ticket: { code, status: 'open' }, message: `Ticket ${code} created. A support agent will review it.` });
      return true;
    }

    if (method === 'GET' && custRoute.match(/^\/tickets\/[A-Za-z0-9-]+$/)) {
      const s = requireCustomer(req);
      const code = decodeURIComponent(route.split('/')[2]);
      const ticket = db.prepare('SELECT * FROM nb_tickets WHERE code=? AND customer_id=?').get(code, s.user_id);
      if (!ticket) fail(404, 'Ticket not found');
      const messages = db.prepare('SELECT * FROM nb_ticket_messages WHERE ticket_id=? ORDER BY created_at').all(ticket.id);
      const order = ticket.order_id ? db.prepare('SELECT code FROM nb_orders WHERE id=?').get(ticket.order_id) : null;
      send(res, 200, { ticket: {
        code: ticket.code, category: ticket.category, subject: ticket.subject, description: ticket.description,
        status: ticket.status, priority: ticket.priority, createdAt: ticket.created_at, updatedAt: ticket.updated_at,
        orderCode: order?.code || null, attachment: ticket.attachment,
        messages: messages.map((m) => ({ authorRole: m.author_role, authorName: m.author_name, body: m.body, at: m.created_at }))
      } });
      return true;
    }

    if (method === 'POST' && custRoute.match(/^\/tickets\/[A-Za-z0-9-]+\/messages$/)) {
      const s = requireCustomer(req);
      const code = decodeURIComponent(route.split('/')[2]);
      const ticket = db.prepare('SELECT * FROM nb_tickets WHERE code=? AND customer_id=?').get(code, s.user_id);
      if (!ticket) fail(404, 'Ticket not found');
      if (['closed'].includes(ticket.status)) fail(409, 'This ticket is closed. Create a new ticket if you still need help.');
      if (!str(payload.body, 2, 2000)) fail(400, 'Write a message of at least 2 characters.');
      const name = db.prepare('SELECT name FROM nb_users WHERE id=?').get(s.user_id).name;
      transaction(() => {
        db.prepare('INSERT INTO nb_ticket_messages(id,ticket_id,author_role,author_name,body,created_at) VALUES(?,?,?,?,?,?)')
          .run(uid(), ticket.id, 'customer', name, payload.body.trim(), now());
        db.prepare("UPDATE nb_tickets SET status=?,updated_at=? WHERE id=?").run(ticket.status === 'awaiting_customer' ? 'in_progress' : ticket.status, now(), ticket.id);
      });
      send(res, 200, { message: 'Reply added.' });
      return true;
    }

    if (method === 'POST' && custRoute.match(/^\/tickets\/[A-Za-z0-9-]+\/close$/)) {
      const s = requireCustomer(req);
      const code = decodeURIComponent(route.split('/')[2]);
      const ticket = db.prepare('SELECT * FROM nb_tickets WHERE code=? AND customer_id=?').get(code, s.user_id);
      if (!ticket) fail(404, 'Ticket not found');
      db.prepare("UPDATE nb_tickets SET status='closed',updated_at=? WHERE id=?").run(now(), ticket.id);
      send(res, 200, { message: 'Ticket closed.' });
      return true;
    }

    /* ================================================================== */
    /* Partner console — Seller Hub workflow (same database, same orders)  */
    /* ================================================================== */

    if (method === 'POST' && route === '/login' && base === '/api/partner') {
      rateLimit(`partner-login:${clientIp(req)}`, 20, 900e3);
      const email = String(payload.email || '').trim().toLowerCase();
      if (!emailOk(email) || typeof payload.password !== 'string') fail(400, 'Enter your partner email and password.');
      const user = db.prepare("SELECT * FROM nb_users WHERE email=? AND role IN ('seller','runner')").get(email);
      const ok = user ? checkPassword(payload.password, user.password_hash) : checkPassword(payload.password, makePassword('invalid-password'));
      if (!user || !ok) fail(401, 'Those partner details do not match an account.');
      if (payload.role !== undefined && (!['seller', 'runner'].includes(payload.role) || payload.role !== user.role)) fail(403, 'This account does not belong to this portal. Use the correct account for this workspace.');
      if (user.status === 'suspended') fail(403, 'This partner account is suspended. Contact NearBuy support.');
      if (!['active', 'pending_verification'].includes(user.status)) fail(403, 'This partner account is not active.');
      const sess = startSession(req, user, PARTNER_COOKIE);
      const shop = user.role === 'seller' ? (db.prepare('SELECT * FROM nb_shops WHERE owner_user_id=?').get(user.id)
        || db.prepare('SELECT s.* FROM nb_shop_staff st JOIN nb_shops s ON s.id=st.shop_id WHERE st.user_id=? AND st.status=\'active\'').get(user.id)) : null;
      const runner = user.role === 'runner' ? db.prepare('SELECT * FROM nb_runners WHERE user_id=?').get(user.id) : null;
      const verification = shop ? db.prepare('SELECT * FROM nb_seller_verifications WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(user.id) : null;
      audit(user.role, user.id, 'partner_login', 'user', user.id, `${user.role} signed in`);
      send(res, 200, {
        user: { id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone, avatar: user.avatar, csrf: sess.csrf, status: user.status },
        shop: shop ? { id: shop.id, slug: shop.slug, name: shop.name, emoji: shop.emoji, locality: shop.locality, isOpen: Boolean(shop.is_open), openAt: shop.opens_at, closeAt: shop.closes_at, verified: Boolean(shop.verified), verificationStatus: verification?.status || (shop.verified ? 'approved' : 'documents_pending') } : null,
        runner: runner ? { vehicle: runner.vehicle, status: runner.status, rating: runner.rating, completed: runner.completed } : null
      }, { 'Set-Cookie': sess.cookie });
      return true;
    }

    if (base === '/api/partner' && route === '/me' && method === 'GET') {
      const s = sessionFor(req, PARTNER_COOKIE);
      if (!s || !['seller', 'runner'].includes(s.role)) { send(res, 200, { user: null }); return true; }
      const shop = s.role === 'seller' ? (db.prepare('SELECT * FROM nb_shops WHERE owner_user_id=?').get(s.user_id)
        || db.prepare('SELECT s.* FROM nb_shop_staff st JOIN nb_shops s ON s.id=st.shop_id WHERE st.user_id=? AND st.status=\'active\'').get(s.user_id)) : null;
      const runner = s.role === 'runner' ? db.prepare('SELECT * FROM nb_runners WHERE user_id=?').get(s.user_id) : null;
      const verification = shop ? db.prepare('SELECT * FROM nb_seller_verifications WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(s.user_id) : null;
      const userRow = db.prepare('SELECT status FROM nb_users WHERE id=?').get(s.user_id);
      send(res, 200, {
        user: { id: s.user_id, name: s.name, email: s.email, phone: s.phone, avatar: s.avatar, role: s.role, csrf: s.csrf, status: userRow?.status || 'active' },
        shop: shop ? { id: shop.id, slug: shop.slug, name: shop.name, emoji: shop.emoji, locality: shop.locality, isOpen: Boolean(shop.is_open), openAt: shop.opens_at, closeAt: shop.closes_at, verified: Boolean(shop.verified), verificationStatus: verification?.status || (shop.verified ? 'approved' : 'documents_pending') } : null,
        runner: runner ? { vehicle: runner.vehicle, status: runner.status, rating: runner.rating, completed: runner.completed } : null
      });
      return true;
    }

    if (base === '/api/partner' && route === '/logout' && method === 'POST') {
      const s = sessionFor(req, PARTNER_COOKIE);
      if (s) db.prepare('DELETE FROM nb_sessions WHERE token_hash=?').run(sha(s.token));
      send(res, 200, { ok: true }, { 'Set-Cookie': `${PARTNER_COOKIE}=; ${cookieAttrs(req)}; Max-Age=0` });
      return true;
    }

    function requirePartner(roles) {
      const s = sessionFor(req, PARTNER_COOKIE);
      if (!s) fail(401, 'Partner sign-in required');
      if (!roles.includes(s.role)) fail(403, 'This partner area is not available for your role');
      return s;
    }
    const STAFF_ROLE_PERMS = {
      owner: ['view_dashboard', 'manage_products', 'manage_inventory', 'accept_orders', 'prepare_orders', 'manage_settlements', 'manage_staff', 'manage_settings', 'manage_promotions', 'view_analytics', 'manage_scanner', 'view_customers', 'manage_returns', 'manage_support', 'view_revenue'],
      manager: ['view_dashboard', 'manage_products', 'manage_inventory', 'accept_orders', 'prepare_orders', 'manage_promotions', 'view_analytics', 'manage_scanner', 'view_customers', 'manage_returns', 'manage_support', 'view_revenue'],
      order_manager: ['view_dashboard', 'accept_orders', 'prepare_orders', 'view_customers', 'manage_support'],
      inventory_manager: ['view_dashboard', 'manage_inventory', 'manage_scanner'],
      sales_staff: ['view_dashboard', 'view_analytics', 'view_customers'],
      packing_staff: ['view_dashboard', 'prepare_orders'],
      delivery_staff: ['view_dashboard', 'prepare_orders', 'manage_support']
    };
    function sellerStaffRow(s, shop) {
      if (!s || !shop) return null;
      if (shop.owner_user_id === s.user_id) return { role: 'owner', permissions: STAFF_ROLE_PERMS.owner, isOwner: true, status: 'active' };
      const row = db.prepare('SELECT * FROM nb_shop_staff WHERE user_id=? AND shop_id=?').get(s.user_id, shop.id);
      if (!row || row.status !== 'active') return null;
      let perms = [];
      try { perms = JSON.parse(row.permissions_json || '[]'); } catch { perms = []; }
      if (!Array.isArray(perms) || !perms.length) perms = STAFF_ROLE_PERMS[row.role] || [];
      return { role: row.role, permissions: perms, isOwner: false, status: row.status, id: row.id };
    }
    function sellerCan(s, shop, perm) {
      const staff = sellerStaffRow(s, shop);
      return Boolean(staff && staff.permissions.includes(perm));
    }
    function requireSellerPerm(s, shop, perm, label) {
      if (!sellerCan(s, shop, perm)) fail(403, `${label || 'This action'} needs the ${perm.replace(/_/g, ' ')} permission. Ask the shop owner.`);
    }
    function sellerShopContext(s, opts = {}) {
      let shop = db.prepare('SELECT * FROM nb_shops WHERE owner_user_id=?').get(s.user_id);
      if (!shop) {
        const staff = db.prepare('SELECT s.* FROM nb_shop_staff st JOIN nb_shops s ON s.id=st.shop_id WHERE st.user_id=? AND st.status=\'active\'').get(s.user_id);
        shop = staff || null;
      }
      if (!shop) fail(403, 'No shop is linked to this seller account. Ask operations to link it.');
      if (!opts.allowPending && !shop.verified) {
        fail(403, 'Your shop verification is still pending. Complete KYC and wait for admin approval before selling.', { code: 'verification_pending' });
      }
      return shop;
    }
    function sellerCodes(shop, userId) {
      const slugPart = String(shop.slug || 'shop').toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 12);
      return {
        sellerId: shop.seller_code || `NB-SELLER-${slugPart}`,
        shopId: shop.shop_code || `NB-SHOP-${slugPart}`,
        userId: userId || shop.owner_user_id || null
      };
    }
    function recordInventory(shop, product, type, previousQty, newQty, delta, reason, actor) {
      db.prepare('INSERT INTO nb_inventory_transactions(id,shop_id,product_id,actor_user_id,actor_name,type,previous_qty,new_qty,delta,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(uid(), shop.id, product.id, actor?.user_id || actor?.id || null, actor?.name || 'system', type, previousQty, newQty, delta, reason || null, now());
      const available = Math.max(0, newQty - Number(product.reserved || 0));
      if (available <= Number(product.low_stock || 0) && shop.owner_user_id) {
        notify(shop.owner_user_id, 'Low stock alert', `${product.name} has ${available} left (reorder at ${product.low_stock}).`, 'stock', '#/inventory');
      }
    }
    // Callers use a few friendly spellings for the same movement; normalise them once.
    const INVENTORY_ACTION_ALIASES = {
      returned_stock: 'returned', return_stock: 'returned', return: 'returned', restock_return: 'returned',
      restock_purchase: 'add', purchase: 'add', restock: 'add', received: 'add',
      damaged_stock: 'damaged', expired_stock: 'expired', write_off: 'damaged',
      correction: 'set', count: 'set', stock_count: 'set', recount: 'set'
    };
    function normaliseInventoryAction(action) {
      const key = String(action || 'add').trim().toLowerCase();
      return INVENTORY_ACTION_ALIASES[key] || key;
    }
    function applyInventoryChange(shop, product, action, quantity, reason, actor) {
      action = normaliseInventoryAction(action);
      const prev = Number(product.stock || 0);
      const reserved = Number(product.reserved || 0);
      let next = prev;
      let type = action;
      if (action === 'add') next = prev + quantity;
      else if (action === 'reduce' || action === 'damaged' || action === 'expired') {
        if (prev - quantity < reserved) fail(400, `Only ${Math.max(0, prev - reserved)} unit(s) are available to ${action === 'reduce' ? 'reduce' : 'write off'}; the rest are reserved by open orders.`);
        next = prev - quantity;
      } else if (action === 'returned') next = prev + quantity;
      else if (action === 'set') {
        if (quantity < reserved) fail(400, `Stock cannot be set below ${reserved} reserved unit(s).`);
        next = quantity;
      } else if (action === 'opening') next = quantity;
      else fail(400, 'Unknown inventory action.');
      if (next < 0 || next > 1000000) fail(400, 'Stock quantity is out of range.');
      const upd = db.prepare('UPDATE nb_products SET stock=? WHERE id=? AND shop_id=?').run(next, product.id, shop.id);
      if (Number(upd.changes) !== 1) fail(404, 'Product not found in your catalogue');
      recordInventory(shop, { ...product, stock: next }, type, prev, next, next - prev, reason, actor);
      return { previousQty: prev, newQty: next, delta: next - prev };
    }
    function ensurePackingRows(so) {
      const items = db.prepare('SELECT * FROM nb_order_items WHERE seller_order_id=? ORDER BY id').all(so.id);
      for (const item of items) {
        db.prepare('INSERT OR IGNORE INTO nb_packing_items(id,seller_order_id,order_item_id,product_id,ordered_qty,packed_qty,missing_qty,status,updated_at) VALUES(?,?,?,?,?,?,?, ?,?)')
          .run(uid(), so.id, item.id, item.product_id, item.qty, item.packed_qty || 0, item.missing_qty || 0, item.packed_status || 'pending', now());
      }
      return db.prepare('SELECT pi.*, oi.name, oi.unit, oi.emoji FROM nb_packing_items pi JOIN nb_order_items oi ON oi.id=pi.order_item_id WHERE pi.seller_order_id=? ORDER BY oi.id').all(so.id);
    }
    function packingSummary(so) {
      const rows = ensurePackingRows(so);
      const ordered = rows.reduce((t, r) => t + Number(r.ordered_qty || 0), 0);
      const packed = rows.reduce((t, r) => t + Number(r.packed_qty || 0), 0);
      const missing = rows.reduce((t, r) => t + Number(r.missing_qty || 0), 0);
      return { rows, ordered, packed, missing, complete: rows.length > 0 && rows.every((r) => Number(r.packed_qty || 0) + Number(r.missing_qty || 0) >= Number(r.ordered_qty || 0)) };
    }
    function sellerOrderOwned(code, shop) {
      const so = db.prepare('SELECT * FROM nb_seller_orders WHERE code=? AND shop_id=?').get(String(code), shop.id);
      if (!so) fail(404, 'Order not found for your shop');
      return so;
    }
    function syncParentPayment(orderId) {
      const order = db.prepare('SELECT * FROM nb_orders WHERE id=?').get(orderId);
      const siblings = db.prepare('SELECT * FROM nb_seller_orders WHERE order_id=?').all(orderId);
      const active = siblings.filter((s) => !['cancelled', 'rejected'].includes(s.status));
      const allActiveDelivered = active.length > 0 && active.every((s) => ['delivered', 'completed'].includes(s.status));
      if (allActiveDelivered && order.payment_status !== 'paid') {
        const activeTotal = active.reduce((sum, s) => sum + Number(s.total_paise || 0), 0);
        db.prepare("UPDATE nb_orders SET payment_status='paid',updated_at=? WHERE id=?").run(now(), orderId);
        recordOfflinePaymentPaid(order);
        notify(order.customer_id, 'Payment recorded', `₹${Math.round(activeTotal / 100)} was collected for ${order.code}.`, 'payment', `#/orders/${order.code}`);
      }
      if (siblings.every((s) => ['delivered', 'completed', 'cancelled', 'rejected'].includes(s.status))) {
        const nextStatus = active.length
          ? (active.every((s) => s.status === 'completed') ? 'completed' : 'delivered')
          : 'cancelled';
        db.prepare('UPDATE nb_orders SET status=?,updated_at=? WHERE id=?').run(nextStatus, now(), orderId);
      }
    }

    if (base === '/api/partner' && route === '/seller/overview' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const orders = db.prepare('SELECT * FROM nb_seller_orders WHERE shop_id=? ORDER BY created_at DESC').all(shop.id);
      const counts = {
        new: orders.filter((o) => o.status === 'placed').length,
        preparing: orders.filter((o) => ['accepted', 'preparing'].includes(o.status)).length,
        ready: orders.filter((o) => ['ready', 'runner_requested'].includes(o.status)).length,
        onTheWay: orders.filter((o) => ['runner_assigned', 'picked_up', 'out_for_delivery'].includes(o.status)).length,
        completed: orders.filter((o) => ['delivered', 'completed'].includes(o.status)).length,
        total: orders.length,
        accepted: orders.filter((o) => o.status === 'accepted').length,
        cancelled: orders.filter((o) => ['cancelled', 'rejected'].includes(o.status)).length
      };
      const revenue = orders.filter((o) => ['delivered', 'completed'].includes(o.status)).reduce((t, o) => t + o.total_paise, 0);
      const grossSales = orders.filter((o) => !['cancelled', 'rejected'].includes(o.status)).reduce((t, o) => t + o.total_paise, 0);
      const refundTotal = completedRefundTotalForShop(shop.id);
      const productStats = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN stock-reserved>0 THEN 1 ELSE 0 END) AS inStock, SUM(CASE WHEN stock-reserved<=0 THEN 1 ELSE 0 END) AS outStock, SUM(CASE WHEN stock-reserved>0 AND stock-reserved<=low_stock THEN 1 ELSE 0 END) AS lowStock FROM nb_products WHERE shop_id=? AND active=1 AND COALESCE(archived,0)=0').get(shop.id);
      const lowStock = db.prepare('SELECT id,name,stock,reserved,low_stock,emoji FROM nb_products WHERE shop_id=? AND active=1 AND COALESCE(archived,0)=0 AND stock-reserved<=low_stock ORDER BY stock-reserved LIMIT 6').all(shop.id);
      const outStock = db.prepare('SELECT id,name,stock,reserved,emoji FROM nb_products WHERE shop_id=? AND active=1 AND COALESCE(archived,0)=0 AND stock-reserved<=0 ORDER BY name LIMIT 6').all(shop.id);
      const recent = orders.slice(0, 8).map((so) => {
        const order = db.prepare('SELECT * FROM nb_orders WHERE id=?').get(so.order_id);
        const customer = db.prepare('SELECT name FROM nb_users WHERE id=?').get(order.customer_id);
        const itemCount = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM nb_order_items WHERE seller_order_id=?').get(so.id);
        return { code: so.code, parentCode: order.code, customer: customer?.name, status: so.status, statusLabel: STATUS_LABELS[so.status] || so.status, total: so.total_paise, fulfillment: so.fulfillment, paymentMethod: order.payment_method, itemCount: Number(itemCount?.n || 0), createdAt: so.created_at };
      });
      const unread = db.prepare('SELECT COUNT(*) AS n FROM nb_notifications WHERE user_id=? AND is_read=0').get(s.user_id);
      const codes = sellerCodes(shop, s.user_id);
      send(res, 200, {
        shop: { id: shop.id, name: shop.name, emoji: shop.emoji, slug: shop.slug, isOpen: Boolean(shop.is_open), opensAt: shop.opens_at, closesAt: shop.closes_at, verified: Boolean(shop.verified), rating: shop.rating, sellerId: codes.sellerId, shopId: codes.shopId, locality: shop.locality },
        counts, revenue, grossSales, refunds: refundTotal, netSales: Math.max(0, grossSales - refundTotal),
        orders: orders.length,
        products: { total: Number(productStats?.total || 0), inStock: Number(productStats?.inStock || 0), lowStock: Number(productStats?.lowStock || 0), outStock: Number(productStats?.outStock || 0) },
        lowStock: lowStock.map((p) => ({ id: p.id, name: p.name, stock: Math.max(0, p.stock - p.reserved), lowAt: p.low_stock, emoji: p.emoji })),
        outStock: outStock.map((p) => ({ id: p.id, name: p.name, stock: 0, emoji: p.emoji })),
        unread: Number(unread?.n || 0),
        recent,
        runnerOffers: db.prepare(`SELECT a.*, so.code, u.name FROM nb_delivery_assignments a
          JOIN nb_seller_orders so ON so.id=a.seller_order_id JOIN nb_users u ON u.id=a.runner_id
          WHERE a.shop_id=? AND a.status='offered' AND a.expires_at>? ORDER BY a.created_at DESC`).all(shop.id, now()).map((a) => ({
          id: a.id, orderCode: a.code, runner: a.name, expiresAt: a.expires_at
        }))
      });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/orders' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const filter = String(q.get('status') || 'all');
      let orders = db.prepare('SELECT * FROM nb_seller_orders WHERE shop_id=? ORDER BY created_at DESC LIMIT 100').all(shop.id);
      if (filter !== 'all') {
        const sets = {
          new: ['placed'], active: ['accepted', 'preparing', 'ready', 'runner_requested', 'runner_assigned', 'picked_up', 'out_for_delivery'],
          completed: ['delivered', 'completed'], cancelled: ['cancelled', 'rejected'],
          handed_over: ['picked_up', 'out_for_delivery']
        };
        // Grouped buckets above; any single lifecycle status also filters directly.
        const wanted = sets[filter] || (/^[a-z_]+$/.test(filter) ? [filter] : []);
        orders = orders.filter((o) => wanted.includes(o.status));
      }
      const payloadOrders = orders.map((so) => {
        const order = db.prepare('SELECT * FROM nb_orders WHERE id=?').get(so.order_id);
        const customer = db.prepare('SELECT name,phone FROM nb_users WHERE id=?').get(order.customer_id);
        const items = db.prepare('SELECT * FROM nb_order_items WHERE seller_order_id=?').all(so.id);
        const address = JSON.parse(order.address_json);
        const pack = packingSummary(so);
        const assignment = db.prepare('SELECT * FROM nb_delivery_assignments WHERE seller_order_id=? ORDER BY created_at DESC LIMIT 1').get(so.id);
        const runnerRow = so.runner_id ? db.prepare('SELECT u.name, u.phone, r.vehicle, r.rating FROM nb_users u LEFT JOIN nb_runners r ON r.user_id=u.id WHERE u.id=?').get(so.runner_id) : null;
        return {
          id: so.id, code: so.code, parentCode: order.code, status: so.status, statusLabel: STATUS_LABELS[so.status] || so.status,
          fulfillment: so.fulfillment, total: so.total_paise, subtotal: so.subtotal_paise, discount: so.discount_paise,
          deliveryFee: so.delivery_fee_paise, tax: so.tax_paise, createdAt: so.created_at, acceptedAt: so.accepted_at,
          readyAt: so.ready_at, deliveredAt: so.delivered_at, paymentMethod: order.payment_method, paymentStatus: order.payment_status,
          customer: { name: customer?.name || 'Customer', phone: customer?.phone || null, maskedPhone: maskedPhone(customer?.phone) },
          address: so.fulfillment === 'delivery' ? address : null,
          items: items.map((i) => ({ id: i.id, productId: i.product_id, name: i.name, qty: i.qty, price: i.price_paise, emoji: i.emoji, unit: i.unit, packedQty: i.packed_qty || 0, missingQty: i.missing_qty || 0, packedStatus: i.packed_status || 'pending' })),
          itemCount: items.reduce((t, i) => t + i.qty, 0),
          packing: { ordered: pack.ordered, packed: pack.packed, missing: pack.missing, complete: pack.complete, partial: Boolean(so.partial_fulfillment), partialNote: so.partial_note || null },
          fulfillmentDetail: {
            weightGrams: so.weight_grams, packages: so.packages_count || 1, requestedTiming: so.requested_timing,
            runnerCharges: so.runner_charges_paise, deliveryStaffId: so.delivery_staff_id, deliveryStaffName: so.delivery_staff_name,
            handoverConfirmedAt: so.handover_confirmed_at, handoverConfirmedBy: so.handover_confirmed_by,
            assignment: assignment ? { id: assignment.id, status: assignment.status, payout: assignment.payout_paise, distanceKm: assignment.distance_km, expiresAt: assignment.expires_at, runnerId: assignment.runner_id } : null
          },
          handoverPin: ['ready', 'runner_requested', 'runner_assigned'].includes(so.status) ? deriveCode('handover', so.id, 4) : null,
          pickupCodeHint: so.fulfillment === 'pickup' ? 'Ask the customer for their 6-digit collection code.' : null,
          runner: runnerRow ? { name: runnerRow.name, phone: runnerRow.phone, vehicle: runnerRow.vehicle, rating: runnerRow.rating } : null,
          receiptUrl: `/api/partner/seller/receipt/${so.code}`
        };
      });
      send(res, 200, { orders: payloadOrders, shop: { name: shop.name, emoji: shop.emoji } });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/orders\/[A-Za-z0-9-]+\/action$/) && method === 'POST') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const code = decodeURIComponent(route.split('/')[3]);
      const so = sellerOrderOwned(code, shop);
      const order = db.prepare('SELECT * FROM nb_orders WHERE id=?').get(so.order_id);
      const action = String(payload.action || '');
      const reason = String(payload.reason || '').trim();
      let message = '';
      transaction(() => {
        if (action === 'accept') {
          if (so.status !== 'placed') fail(409, 'This order is no longer waiting for acceptance.');
          for (const item of db.prepare('SELECT * FROM nb_order_items WHERE seller_order_id=?').all(so.id)) {
            const product = db.prepare('SELECT * FROM nb_products WHERE id=?').get(item.product_id);
            const upd = db.prepare('UPDATE nb_products SET stock=stock-?,reserved=MAX(0,reserved-?) WHERE id=? AND stock>=?').run(item.qty, item.qty, item.product_id, item.qty);
            if (Number(upd.changes) !== 1) fail(409, `Stock for ${item.name} changed. Reject the order or ask support to adjust it.`);
            if (product) recordInventory(shop, { ...product, stock: product.stock - item.qty }, 'order_accept', product.stock, product.stock - item.qty, -item.qty, `Order ${so.code} accepted`, s);
          }
          db.prepare('UPDATE nb_seller_orders SET status=?,accepted_at=?,updated_at=? WHERE id=?').run('accepted', now(), now(), so.id);
          addEvent(so.order_id, so.id, 'accepted', 'Seller accepted', `${shop.name} accepted your order.`, 'seller');
          notify(order.customer_id, `${shop.name} accepted your order`, `${so.code} is being prepared. You can still cancel until preparation starts.`, 'order', `#/orders/${order.code}`);
          message = 'Order accepted. Stock has been deducted from your inventory.';
        } else if (action === 'reject') {
          if (!['placed', 'accepted'].includes(so.status)) fail(409, 'Only a new or accepted order can be rejected.');
          if (!str(reason, 3, 200)) fail(400, 'Give the customer a reason for rejecting this order.');
          const ts = now();
          releaseStockForSellerOrder(so);
          db.prepare('UPDATE nb_seller_orders SET status=?,rejected_reason=?,updated_at=? WHERE id=?').run('rejected', reason, ts, so.id);
          addEvent(so.order_id, so.id, 'rejected', 'Seller rejected the order', reason, 'seller');
          notify(order.customer_id, `${shop.name} could not accept your order`, `${so.code}: ${reason}. Any payment will be refunded separately.`, 'order', `#/orders/${order.code}`);
          if (order.payment_status === 'paid') {
            const refundAmount = sellerOrderRefundableAmount(so);
            if (refundAmount > 0) {
              db.prepare('INSERT INTO nb_refunds(id,return_id,order_id,seller_order_id,reason,amount_paise,status,reference,created_at,updated_at) VALUES(?,NULL,?,?,?,?,?,NULL,?,?)')
                .run(uid(), order.id, so.id, 'rejection', refundAmount, 'processing', ts, ts);
            }
          }
          const siblings = db.prepare('SELECT * FROM nb_seller_orders WHERE order_id=?').all(order.id);
          if (siblings.every((sib) => ['cancelled', 'rejected'].includes(sib.status))) {
            db.prepare('UPDATE nb_orders SET status=?,updated_at=? WHERE id=?').run('cancelled', ts, order.id);
            cancelOpenPaymentRecords(order.id);
          } else if (order.payment_status !== 'paid') {
            syncPendingOfflinePayment(order.id);
          }
          message = 'Order rejected and reserved stock released.';
        } else if (action === 'prepare') {
          if (so.status !== 'accepted') fail(409, 'Accept the order before marking it as preparing.');
          db.prepare('UPDATE nb_seller_orders SET status=?,updated_at=? WHERE id=?').run('preparing', now(), so.id);
          ensurePackingRows(so);
          addEvent(so.order_id, so.id, 'preparing', 'Preparing order', `${shop.name} started packing your items.`, 'seller');
          notify(order.customer_id, 'Your order is being prepared', `${so.code}: ${shop.name} started packing. Online cancellation is no longer available; use support if something is wrong.`, 'order', `#/orders/${order.code}`);
          message = 'Order moved to preparing.';
        } else if (action === 'ready') {
          if (so.status !== 'preparing') fail(409, 'Mark the order as preparing first.');
          const summary = packingSummary(so);
          const packingDetail = { packing: { ordered: summary.ordered, packed: summary.packed, missing: summary.missing } };
          if (!summary.complete) {
            fail(409, `Packing is incomplete (${summary.packed}/${summary.ordered} packed). Mark every item packed, or report what is missing, before marking ready.`, packingDetail);
          }
          // Every unit is accounted for — but a shortfall still needs the customer told why.
          const shortfall = summary.rows.filter((r) => Number(r.packed_qty || 0) < Number(r.ordered_qty || 0));
          if (shortfall.length) {
            if (!so.partial_fulfillment) fail(409, 'Some items are short. Declare partial fulfilment so the customer knows this order is not complete.', packingDetail);
            if (!String(so.partial_note || '').trim()) fail(409, 'Add a partial-fulfilment note so the customer knows what is short and why.', packingDetail);
          }
          db.prepare('UPDATE nb_seller_orders SET status=?,ready_at=?,packing_complete=?,partial_fulfillment=?,updated_at=? WHERE id=?')
            .run('ready', now(), shortfall.length ? 0 : 1, shortfall.length ? 1 : 0, now(), so.id);
          addEvent(so.order_id, so.id, 'ready', so.fulfillment === 'pickup' ? 'Ready for pickup' : 'Ready for dispatch', so.fulfillment === 'pickup' ? 'Show your collection code at the counter.' : 'Choose delivery by your own rider or request a NearBuy runner.', 'seller');
          notify(order.customer_id, so.fulfillment === 'pickup' ? 'Ready for pickup' : 'Your order is packed', so.fulfillment === 'pickup' ? `${so.code} is ready at ${shop.name}. Your collection code is on the order page.` : `${so.code} is packed and waiting for dispatch.`, 'order', `#/orders/${order.code}`);
          message = 'Order marked ready.';
        } else if (action === 'request_runner') {
          if (so.status !== 'ready') fail(409, 'The order must be packed and ready first.');
          if (so.fulfillment !== 'delivery') fail(409, 'This order is set to store pickup.');
          const address = JSON.parse(order.address_json);
          const runnerRows = db.prepare(`SELECT r.*, u.name FROM nb_runners r JOIN nb_users u ON u.id=r.user_id
            WHERE r.status='online' AND r.active=1 AND r.lat IS NOT NULL AND r.lng IS NOT NULL`).all();
          const busy = new Set(db.prepare(`SELECT a.runner_id FROM nb_delivery_assignments a JOIN nb_seller_orders x ON x.id=a.seller_order_id
            WHERE a.status='accepted' AND x.status NOT IN ('delivered','completed','cancelled','rejected')`).all().map((r) => r.runner_id));
          const declined = new Set(db.prepare("SELECT runner_id FROM nb_delivery_assignments WHERE seller_order_id=? AND status='declined'").all(so.id).map((r) => r.runner_id));
          const prefMax = new Map(db.prepare('SELECT user_id,max_distance_km FROM nb_runner_preferences').all().map((p) => [p.user_id, Number(p.max_distance_km) || 10]));
          const eligible = runnerRows.filter((r) => !busy.has(r.user_id) && !declined.has(r.user_id))
            .map((r) => ({ ...r, distance: haversineKm(shop.lat, shop.lng, r.lat, r.lng) || 0 }))
            .filter((r) => r.distance <= Math.min(10, prefMax.get(r.user_id) || 10))
            .sort((a, b) => a.distance - b.distance);
          if (!eligible.length) {
            fail(409, 'No NearBuy runner is free right now. You can deliver this order with your own rider, or try again in a few minutes.', {
              alternatives: ['Use my own rider (deliver myself)', 'Try requesting a runner again later']
            });
          }
          const offerSeconds = Number(process.env.DELIVERY_OFFER_SECONDS || 180);
          for (const runner of eligible.slice(0, 3)) {
            const payout = Math.max(3500, Math.min(15000, 3000 + Math.round(runner.distance * 900)));
            db.prepare(`INSERT INTO nb_delivery_assignments(id,seller_order_id,shop_id,runner_id,status,payout_paise,distance_km,created_at,expires_at,responded_at,picked_up_at,delivered_at)
              VALUES(?,?,?,?, 'offered', ?,?,?,?,NULL,NULL,NULL)`).run(uid(), so.id, shop.id, runner.user_id, payout,
              Math.round(runner.distance * 100) / 100, now(), new Date(Date.now() + offerSeconds * 1000).toISOString());
            notify(runner.user_id, 'New delivery offer', `${so.code} · ${shop.name} · ₹${Math.round(payout / 100)} payout. Open the delivery console to accept.`, 'runner', '#/delivery');
          }
          const weightGrams = payload.weightGrams != null ? clampInt(payload.weightGrams, 0, 500000) : (so.weight_grams || null);
          const packagesCount = payload.packages != null ? clampInt(payload.packages, 1, 20) : (so.packages_count || 1);
          const timing = payload.timing != null ? String(payload.timing).slice(0, 120) : (so.requested_timing || null);
          const estCharge = eligible.length ? Math.max(3500, Math.min(15000, 3000 + Math.round((eligible[0].distance || 0) * 900))) : null;
          db.prepare('UPDATE nb_seller_orders SET status=?,weight_grams=?,packages_count=?,requested_timing=?,runner_charges_paise=?,updated_at=? WHERE id=?')
            .run('runner_requested', weightGrams, packagesCount, timing, estCharge, now(), so.id);
          addEvent(so.order_id, so.id, 'runner_requested', 'Finding a delivery partner', `${eligible.length} nearby runner(s) offered this delivery.`, 'seller');
          notify(order.customer_id, 'Finding a delivery partner', `${so.code}: ${shop.name} has requested a NearBuy runner.`, 'order', `#/orders/${order.code}`);
          message = `Runner request sent to ${Math.min(3, eligible.length)} nearby partner(s). Offers expire in ${Math.round(offerSeconds / 60)} minute(s).`;
        } else if (action === 'self_deliver') {
          if (so.status !== 'ready' || so.fulfillment !== 'delivery') fail(409, 'Only a ready delivery order can be dispatched.');
          const staffId = payload.staffId ? String(payload.staffId) : null;
          let staffName = payload.staffName ? String(payload.staffName).slice(0, 80) : null;
          if (staffId) {
            const staff = db.prepare('SELECT u.name FROM nb_shop_staff st JOIN nb_users u ON u.id=st.user_id WHERE st.id=? AND st.shop_id=? AND st.status=\'active\'').get(staffId, shop.id);
            if (!staff) fail(400, 'Choose an active delivery staff member from your shop.');
            staffName = staff.name;
          }
          db.prepare('UPDATE nb_seller_orders SET status=?,delivery_staff_id=?,delivery_staff_name=?,updated_at=? WHERE id=?').run('out_for_delivery', staffId, staffName, now(), so.id);
          addEvent(so.order_id, so.id, 'out_for_delivery', 'Out for delivery', `${shop.name} is delivering this order with its own rider${staffName ? ` (${staffName})` : ''}.`, 'seller');
          notify(order.customer_id, 'Out for delivery', `${so.code} left ${shop.name} with the shop’s own rider. Share your delivery OTP only after you receive the items.`, 'order', `#/orders/${order.code}`);
          message = 'Order dispatched with your own rider. Ask the customer for their delivery OTP on arrival.';
        } else if (action === 'confirm_handover') {
          if (!['runner_assigned', 'ready'].includes(so.status)) fail(409, 'Handover can only be confirmed once a runner is assigned or the order is ready.');
          db.prepare('UPDATE nb_seller_orders SET handover_confirmed_at=?,handover_confirmed_by=?,updated_at=? WHERE id=?').run(now(), s.name, now(), so.id);
          addEvent(so.order_id, so.id, 'handover_confirmed', 'Package handed over', `${s.name} confirmed the package handover at ${shop.name}.`, 'seller');
          message = 'Package handover confirmed. The runner still needs your handover PIN at pickup.';
        } else if (action === 'cancel_runner') {
          if (so.status !== 'runner_requested') fail(409, 'Only an unaccepted runner request can be cancelled.');
          db.prepare("UPDATE nb_delivery_assignments SET status='expired' WHERE seller_order_id=? AND status='offered'").run(so.id);
          db.prepare('UPDATE nb_seller_orders SET status=?,updated_at=? WHERE id=?').run('ready', now(), so.id);
          addEvent(so.order_id, so.id, 'runner_cancelled', 'Runner request cancelled', 'The seller cancelled the runner request and kept the order ready for dispatch.', 'seller');
          message = 'Runner request cancelled. The order is ready for self-delivery or a new runner request.';
        } else if (action === 'deliver') {
          if (so.fulfillment !== 'delivery') fail(409, 'Use complete_pickup for a store pickup order.');
          if (so.status !== 'out_for_delivery') fail(409, 'The order must be out for delivery before handover.');
          if (so.runner_id) fail(409, 'A NearBuy runner is assigned; only that partner can complete this delivery.');
          if (!safeEqual(deriveCode('delivery', so.id, 6), String(payload.otp || ''))) {
            db.prepare('UPDATE nb_seller_orders SET delivery_attempts=delivery_attempts+1 WHERE id=?').run(so.id);
            fail(400, 'That delivery OTP is not correct. Ask the customer to read it from their order page.');
          }
          db.prepare('UPDATE nb_seller_orders SET status=?,delivered_at=?,updated_at=? WHERE id=?').run('delivered', now(), now(), so.id);
          addEvent(so.order_id, so.id, 'delivered', 'Delivered', 'Delivery OTP verified at the doorstep.', 'seller');
          notify(order.customer_id, 'Order delivered', `${so.code} was handed over after OTP verification. Rate your experience in Orders.`, 'order', `#/orders/${order.code}`);
          syncParentPayment(order.id);
          message = 'Delivery completed after OTP verification.';
        } else if (action === 'complete_pickup') {
          if (so.fulfillment !== 'pickup' || so.status !== 'ready') fail(409, 'This order is not ready for collection.');
          if (!safeEqual(deriveCode('pickup', so.id, 6), String(payload.otp || ''))) {
            fail(400, 'That collection code is not correct. Ask the customer to read it from their order page.');
          }
          db.prepare('UPDATE nb_seller_orders SET status=?,delivered_at=?,completed_at=?,updated_at=? WHERE id=?').run('completed', now(), now(), now(), so.id);
          addEvent(so.order_id, so.id, 'completed', 'Collected from store', 'Collection code verified at the counter.', 'seller');
          notify(order.customer_id, 'Order collected', `${so.code} was collected from ${shop.name}. Thanks for shopping local!`, 'order', `#/orders/${order.code}`);
          syncParentPayment(order.id);
          message = 'Pickup completed after collection-code verification.';
        } else if (action === 'mark_paid') {
          if (!['delivered', 'completed'].includes(so.status)) fail(409, 'Payment can only be recorded after handover.');
          const ts = now();
          if (order.payment_status === 'paid') {
            message = 'Payment already recorded.';
          } else {
            const activeSiblings = db.prepare(
              "SELECT * FROM nb_seller_orders WHERE order_id=? AND status NOT IN ('cancelled','rejected') ORDER BY created_at, id"
            ).all(order.id);
            if (activeSiblings.length <= 1 || activeSiblings.every((sib) => ['delivered', 'completed'].includes(sib.status))) {
              recordOfflinePaymentPaid(order);
              db.prepare("UPDATE nb_orders SET payment_status='paid',updated_at=? WHERE id=?").run(ts, order.id);
              notify(order.customer_id, 'Payment recorded', `Cash payment for ${order.code} has been recorded by ${shop.name}.`, 'payment', `#/orders/${order.code}`);
            } else {
              const alreadyPaidForSo = allocatedPaidPaiseForSellerOrder(so) > 0;
              if (!alreadyPaidForSo) {
                const method = order.payment_method === 'pay_at_store' ? 'pay_at_store' : 'cod';
                const provider = method === 'pay_at_store' ? 'store' : 'cash';
                const payId = uid();
                db.prepare(`INSERT INTO nb_payment_records(id,order_id,seller_order_id,provider,method,amount_paise,status,reference,created_at,updated_at)
                  VALUES(?,?,?,?,?,?,'paid',NULL,?,?)`).run(payId, order.id, so.id, provider, method, so.total_paise, ts, ts);
                syncPaymentAllocations(payId, order.id, [so], so.total_paise, ts);
                syncPendingOfflinePayment(order.id);
                const allActivePaid = activeSiblings.every((sib) => allocatedPaidPaiseForSellerOrder(sib) > 0);
                if (allActivePaid) {
                  db.prepare("UPDATE nb_orders SET payment_status='paid',updated_at=? WHERE id=?").run(ts, order.id);
                }
                notify(order.customer_id, 'Payment recorded', `Cash payment for ${so.code} has been recorded by ${shop.name}.`, 'payment', `#/orders/${order.code}`);
              }
            }
            message = 'Cash payment recorded.';
          }
        } else if (action === 'cancel') {
          if (!['placed', 'accepted'].includes(so.status)) fail(409, 'This order can no longer be cancelled by the seller.');
          if (!str(reason, 3, 200)) fail(400, 'Give a reason for cancelling.');
          cancelSellerOrder(so, reason, 'seller');
          message = 'Order cancelled.';
        } else {
          fail(400, 'Unknown seller action.');
        }
        audit('seller', s.user_id, `seller_${action}`, 'seller_order', so.id, `${so.code}${reason ? ' · ' + reason : ''}`);
      });
      const updated = db.prepare('SELECT * FROM nb_seller_orders WHERE id=?').get(so.id);
      send(res, 200, { message, status: updated.status, statusLabel: STATUS_LABELS[updated.status] || updated.status });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/products' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      let prodSql = 'SELECT * FROM nb_products WHERE shop_id=?';
      const args = [shop.id];
      const qTerm = String(q.get('q') || '').trim();
      if (qTerm) {
        prodSql += ' AND (name LIKE ? OR COALESCE(sku,"") LIKE ? OR COALESCE(barcode,"") LIKE ? OR COALESCE(brand,"") LIKE ?)';
        const like = `%${qTerm}%`;
        args.push(like, like, like, like);
      }
      const barcode = String(q.get('barcode') || '').trim();
      if (barcode) { prodSql += ' AND barcode=?'; args.push(barcode); }
      prodSql += ' ORDER BY category_slug, name LIMIT 500';
      const products = db.prepare(prodSql).all(...args).map((p) => ({
        id: p.id, name: p.name, brand: p.brand, category: p.category_slug, subcategory: p.subcategory || null,
        emoji: p.emoji, price: p.price_paise, mrp: p.mrp_paise, stock: p.stock, reserved: p.reserved,
        available: Math.max(0, p.stock - p.reserved), lowAt: p.low_stock, maxStock: p.max_stock,
        active: Boolean(p.active), archived: Boolean(p.archived), unit: p.unit, packSize: p.pack_size,
        variant: p.variant, parentProductId: p.parent_product_id, sku: p.sku, barcode: p.barcode,
        weightGrams: p.weight_grams, dimensions: p.dimensions, taxRate: p.tax_rate,
        returnDays: p.return_days, rating: p.rating, reviewCount: p.review_count,
        imageUrl: p.image_url, description: p.description,
        images: db.prepare('SELECT url FROM nb_product_images WHERE product_id=? ORDER BY sort').all(p.id).map((r) => r.url)
      }));
      const categories = db.prepare('SELECT slug, name FROM nb_categories WHERE active=1 ORDER BY sort, name').all();
      send(res, 200, { products, categories, shop: { name: shop.name, emoji: shop.emoji } });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/products\/[a-zA-Z0-9_-]+$/) && method === 'PATCH') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const product = db.prepare('SELECT * FROM nb_products WHERE id=? AND shop_id=?').get(route.split('/')[3], shop.id);
      if (!product) fail(404, 'Product not found in your catalogue');
      const nextStock = payload.stock !== undefined ? clampInt(payload.stock, 0, 100000) : product.stock;
      const nextPrice = payload.price !== undefined ? Math.round(Number(payload.price)) : product.price_paise;
      if (payload.price !== undefined && (!Number.isFinite(nextPrice) || nextPrice < 100 || nextPrice > 1000000)) fail(400, 'Price must be between ₹1 and ₹10,000.');
      if (nextPrice > (payload.mrp !== undefined ? Math.round(Number(payload.mrp)) : product.mrp_paise || Infinity)) fail(400, 'Selling price cannot be above MRP.');
      const active = payload.active !== undefined ? (payload.active ? 1 : 0) : product.active;
      const archived = payload.archived !== undefined ? (payload.archived ? 1 : 0) : (product.archived || 0);
      const lowStock = payload.lowStock !== undefined ? clampInt(payload.lowStock, 0, 100000) : product.low_stock;
      const maxStock = payload.maxStock !== undefined ? clampInt(payload.maxStock, 0, 1000000) : (product.max_stock || null);
      const sku = payload.sku !== undefined ? String(payload.sku).trim().slice(0, 60) || null : product.sku;
      const barcode = payload.barcode !== undefined ? String(payload.barcode).trim().slice(0, 60) || null : product.barcode;
      if (barcode && db.prepare('SELECT id FROM nb_products WHERE shop_id=? AND barcode=? AND id<>?').get(shop.id, barcode, product.id)) fail(409, 'Another product in your shop already uses this barcode.');
      if (sku && db.prepare('SELECT id FROM nb_products WHERE shop_id=? AND sku=? AND id<>?').get(shop.id, sku, product.id)) fail(409, 'Another product in your shop already uses this SKU.');
      requireSellerPerm(s, shop, 'manage_products', 'Editing products');
      transaction(() => {
        db.prepare('UPDATE nb_products SET stock=?,price_paise=?,mrp_paise=?,active=?,archived=?,low_stock=?,max_stock=?,sku=?,barcode=? WHERE id=? AND shop_id=?')
          .run(nextStock, nextPrice, payload.mrp !== undefined ? Math.round(Number(payload.mrp)) : product.mrp_paise, active, archived, lowStock, maxStock, sku, barcode, product.id, shop.id);
        if (nextStock !== product.stock) recordInventory(shop, { ...product, stock: nextStock }, 'adjust', product.stock, nextStock, nextStock - product.stock, payload.reason || 'Catalogue stock update', s);
      });
      audit('seller', s.user_id, 'product_updated', 'product', product.id, `${product.name}: stock ${product.stock}→${nextStock}, price ${product.price_paise}→${nextPrice}, active ${active}`);
      send(res, 200, { message: 'Catalogue updated. The customer storefront reads this immediately.' });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/products\/[a-zA-Z0-9_-]+$/) && method === 'DELETE') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_products', 'Archiving products');
      const product = db.prepare('SELECT * FROM nb_products WHERE id=? AND shop_id=?').get(route.split('/')[3], shop.id);
      if (!product) fail(404, 'Product not found in your catalogue');
      db.prepare('UPDATE nb_products SET archived=1,active=0 WHERE id=? AND shop_id=?').run(product.id, shop.id);
      audit('seller', s.user_id, 'product_archived', 'product', product.id, product.name);
      send(res, 200, { message: `${product.name} archived. Historical orders are preserved.` });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/products\/[a-zA-Z0-9_-]+\/duplicate$/) && method === 'POST') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_products', 'Duplicating products');
      const product = db.prepare('SELECT * FROM nb_products WHERE id=? AND shop_id=?').get(route.split('/')[3], shop.id);
      if (!product) fail(404, 'Product not found in your catalogue');
      const copySuffix = randomBytes(3).toString('hex');
      const id = `${shop.slug}-${NB_SLUG(product.name).slice(0, 28)}-copy-${copySuffix}`;
      const compareKeyBase = `${product.compare_key || NB_SLUG(product.name)}-${copySuffix}`;
      insertRow('nb_products',
        ['id', 'shop_id', 'category_slug', 'compare_key', 'name', 'brand', 'variant', 'description', 'highlights', 'specs', 'unit', 'pack_size', 'emoji', 'image_url',
          'price_paise', 'mrp_paise', 'tax_rate', 'stock', 'reserved', 'low_stock', 'return_days', 'rating', 'review_count', 'active', 'is_demo', 'created_at',
          'sku', 'barcode', 'parent_product_id', 'subcategory', 'weight_grams', 'dimensions', 'max_stock'],
        [id, shop.id, product.category_slug, `${compareKeyBase}-copy`, `${product.name} (copy)`, product.brand, product.variant,
          product.description, product.highlights, product.specs, product.unit, product.pack_size, product.emoji, product.image_url,
          product.price_paise, product.mrp_paise, product.tax_rate, product.stock, 0, product.low_stock, product.return_days, 0, 0, 0, 0, now(),
          product.sku ? `${product.sku}-COPY` : null, null, product.parent_product_id, product.subcategory, product.weight_grams, product.dimensions, product.max_stock]);
      audit('seller', s.user_id, 'product_duplicated', 'product', id, product.name);
      send(res, 201, { message: 'Product duplicated as a draft. Edit its SKU and barcode before publishing.', productId: id });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/receipt\/[A-Za-z0-9-]+$/) && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const so = sellerOrderOwned(decodeURIComponent(route.split('/')[3]), shop);
      const order = db.prepare('SELECT * FROM nb_orders WHERE id=?').get(so.order_id);
      const customer = db.prepare('SELECT * FROM nb_users WHERE id=?').get(order.customer_id);
      const existingReceipt = db.prepare('SELECT * FROM nb_order_receipts WHERE seller_order_id=?').get(so.id);
      if (!existingReceipt) {
        db.prepare('INSERT INTO nb_order_receipts(id,seller_order_id,order_id,shop_id,receipt_number,doc_type,issued_at) VALUES(?,?,?,?,?,?,?)')
          .run(uid(), so.id, order.id, shop.id, `RCP-${so.code}`, 'order_receipt', now());
      }
      sendHtml(res, 200, receiptHtml(order, so, shop, customer, 'seller'));
      return true;
    }

    if (base === '/api/partner' && route === '/seller/returns' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const rows = db.prepare(`SELECT r.*, o.code AS order_code, so.code AS seller_order_code, i.name AS item_name, i.emoji AS item_emoji, i.qty AS item_qty
        FROM nb_returns r JOIN nb_orders o ON o.id=r.order_id JOIN nb_seller_orders so ON so.id=r.seller_order_id
        JOIN nb_order_items i ON i.id=r.item_id WHERE so.shop_id=? ORDER BY r.created_at DESC`).all(shop.id);
      send(res, 200, { returns: rows.map((r) => ({
        code: r.code, status: r.status, reason: r.reason, comment: r.comment, amount: r.refund_amount_paise,
        images: JSON.parse(r.images_json || '[]'), createdAt: r.created_at, orderCode: r.order_code,
        sellerOrderCode: r.seller_order_code, item: { name: r.item_name, emoji: r.item_emoji, qty: r.item_qty }
      })) });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/returns\/[A-Za-z0-9-]+\/action$/) && method === 'POST') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const code = decodeURIComponent(route.split('/')[3]);
      const ret = db.prepare(`SELECT r.*, so.shop_id, i.product_id, i.qty FROM nb_returns r JOIN nb_seller_orders so ON so.id=r.seller_order_id
        JOIN nb_order_items i ON i.id=r.item_id WHERE r.code=? AND so.shop_id=?`).get(code, shop.id);
      if (!ret) fail(404, 'Return request not found for your shop');
      const action = String(payload.action || '');
      const note = String(payload.note || '').trim().slice(0, 300);
      const map = { approve: 'approved', reject: 'rejected', complete: 'completed', review: 'under_review', process: 'processing' };
      if (!map[action]) fail(400, 'Unknown return action');
      if (['completed', 'rejected'].includes(ret.status)) fail(409, 'This return is already closed.');
      transaction(() => {
        db.prepare('UPDATE nb_returns SET status=?,decision_note=?,updated_at=? WHERE id=?').run(map[action], note || ret.decision_note, now(), ret.id);
        const refundStatus = action === 'approve' ? 'processing' : action === 'complete' ? 'completed' : action === 'reject' ? 'rejected' : action === 'review' ? 'under_review' : 'processing';
        db.prepare('UPDATE nb_refunds SET status=?,updated_at=? WHERE return_id=?').run(refundStatus, now(), ret.id);
        if (action === 'complete') {
          db.prepare('UPDATE nb_products SET stock=stock+? WHERE id=?').run(ret.qty, ret.product_id);
        }
        const order = db.prepare('SELECT * FROM nb_orders WHERE id=?').get(ret.order_id);
        addEvent(ret.order_id, ret.seller_order_id, `return_${map[action]}`, `Return ${map[action]}`, note || null, 'seller');
        notify(order.customer_id, `Return ${map[action]}`, `${ret.code}: ${shop.name} marked your return as ${map[action].replace('_', ' ')}.${note ? ' ' + note : ''}`, 'return', '#/account/returns');
      });
      audit('seller', s.user_id, `return_${action}`, 'return', ret.id, note);
      send(res, 200, { message: `Return ${map[action].replace('_', ' ')}.`, status: map[action] });
      return true;
    }

    /* ================================================================== */
    /* Runner console                                                     */
    /* ================================================================== */

    if (base === '/api/partner' && route === '/runner/overview' && method === 'GET') {
      const s = requirePartner(['runner']);
      const runner = db.prepare('SELECT * FROM nb_runners WHERE user_id=?').get(s.user_id);
      if (!runner) fail(403, 'No delivery profile is linked to this account.');
      const offers = db.prepare(`SELECT a.* FROM nb_delivery_assignments a JOIN nb_seller_orders so ON so.id=a.seller_order_id
        WHERE a.runner_id=? AND a.status='offered' AND a.expires_at>? AND so.status='runner_requested' ORDER BY a.created_at DESC`)
        .all(s.user_id, now()).map((a) => {
          const so = db.prepare('SELECT * FROM nb_seller_orders WHERE id=?').get(a.seller_order_id);
          const shop = db.prepare('SELECT * FROM nb_shops WHERE id=?').get(a.shop_id);
          const count = db.prepare('SELECT SUM(qty) AS n FROM nb_order_items WHERE seller_order_id=?').get(so.id);
          return {
            id: a.id, orderCode: so.code, shop: {	name: shop.name, emoji: shop.emoji, locality: shop.locality },
            payout: a.payout_paise, distanceKm: a.distance_km, expiresAt: a.expires_at, itemCount: Number(count?.n || 0),
            deliveryArea: 'Customer address is shared after you accept.'
          };
        });
      const jobs = db.prepare(`SELECT a.* FROM nb_delivery_assignments a JOIN nb_seller_orders so ON so.id=a.seller_order_id
        WHERE a.runner_id=? AND a.status IN ('accepted','picked_up','delivered') ORDER BY a.created_at DESC LIMIT 20`).all(s.user_id);
      const active = jobs.filter((j) => j.status === 'accepted' || (j.status === 'picked_up')).map((j) => {
        const so = db.prepare('SELECT * FROM nb_seller_orders WHERE id=?').get(j.seller_order_id);
        const order = db.prepare('SELECT * FROM nb_orders WHERE id=?').get(so.order_id);
        const shop = db.prepare('SELECT * FROM nb_shops WHERE id=?').get(j.shop_id);
        const customer = db.prepare('SELECT name, phone FROM nb_users WHERE id=?').get(order.customer_id);
        const address = JSON.parse(order.address_json);
        const items = db.prepare('SELECT name,qty FROM nb_order_items WHERE seller_order_id=?').all(so.id);
        return {
          assignmentId: j.id, orderCode: so.code, status: so.status, shop: { name: shop.name, emoji: shop.emoji, address: shop.address, locality: shop.locality, phone: shop.phone },
          payout: j.payout_paise, customer: { name: customer.name, phoneMasked: maskedPhone(customer.phone) },
          address, items: items.map((i) => ({ name: i.name, qty: i.qty })),
          canPickup: so.status === 'runner_assigned', canDeliver: so.status === 'picked_up'
        };
      });
      const delivered = jobs.filter((j) => j.status === 'delivered');
      const earnings = delivered.reduce((t, j) => t + j.payout_paise, 0);
      send(res, 200, {
        runner: { status: runner.status, vehicle: runner.vehicle, rating: runner.rating, completed: runner.completed, lat: runner.lat, lng: runner.lng },
        offers, active, history: delivered.slice(0, 6).map((j) => ({ payout: j.payout_paise, at: j.delivered_at, distanceKm: j.distance_km })),
        earnings, activeJobCount: active.length
      });
      return true;
    }

    if (base === '/api/partner' && route === '/runner/status' && method === 'POST') {
      const s = requirePartner(['runner']);
      const status = payload.status === 'online' ? 'online' : 'offline';
      const lat = Number.isFinite(Number(payload.lat)) ? Number(payload.lat) : null;
      const lng = Number.isFinite(Number(payload.lng)) ? Number(payload.lng) : null;
      db.prepare('UPDATE nb_runners SET status=?,lat=COALESCE(?,lat),lng=COALESCE(?,lng) WHERE user_id=?').run(status, lat, lng, s.user_id);
      send(res, 200, { message: `You are now ${status}.`, status });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/runner\/offers\/[a-zA-Z0-9-]+\/(accept|decline)$/) && method === 'POST') {
      const s = requirePartner(['runner']);
      const [, , , id, action] = route.split('/');
      const offer = db.prepare("SELECT * FROM nb_delivery_assignments WHERE id=? AND runner_id=? AND status='offered'").get(id, s.user_id);
      if (!offer) fail(404, 'This offer is no longer available.');
      if (new Date(offer.expires_at).getTime() < Date.now()) fail(409, 'This offer has expired. The seller can request a runner again.');
      const so = db.prepare('SELECT * FROM nb_seller_orders WHERE id=?').get(offer.seller_order_id);
      if (!so || so.status !== 'runner_requested') fail(409, 'This delivery is no longer waiting for a runner.');
      if (action === 'decline') {
        db.prepare("UPDATE nb_delivery_assignments SET status='declined',responded_at=? WHERE id=?").run(now(), offer.id);
        send(res, 200, { message: 'Offer declined. It stays open for other partners.' });
        return true;
      }
      const active = db.prepare(`SELECT 1 FROM nb_delivery_assignments a JOIN nb_seller_orders x ON x.id=a.seller_order_id
        WHERE a.runner_id=? AND a.status='accepted' AND x.status NOT IN ('delivered','completed','cancelled','rejected')`).get(s.user_id);
      if (active) fail(409, 'Finish your current delivery before accepting another one.');
      transaction(() => {
        db.prepare("UPDATE nb_delivery_assignments SET status='accepted',responded_at=? WHERE id=? AND status='offered'").run(now(), offer.id);
        db.prepare("UPDATE nb_delivery_assignments SET status='expired' WHERE seller_order_id=? AND id<>? AND status='offered'").run(offer.id, offer.id);
        db.prepare('UPDATE nb_seller_orders SET status=?,runner_id=?,updated_at=? WHERE id=?').run('runner_assigned', s.user_id, now(), so.id);
        addEvent(so.order_id, so.id, 'runner_assigned', 'Delivery partner assigned', `${s.name} will collect your order from the shop.`, 'runner');
        const order = db.prepare('SELECT * FROM nb_orders WHERE id=?').get(so.order_id);
        notify(order.customer_id, 'Delivery partner assigned', `${s.name} is collecting ${so.code} from the shop. Your delivery OTP is on the order page.`, 'order', `#/orders/${order.code}`);
      });
      send(res, 200, { message: 'Delivery accepted. Collect the order from the shop and use the seller’s handover PIN.' });
      return true;
    }

    if (base === '/api/partner' && route === '/runner/jobs' && method === 'GET') {
      const s = requirePartner(['runner']);
      const rows = db.prepare("SELECT * FROM nb_delivery_assignments WHERE runner_id=? AND status IN ('accepted','picked_up','delivered') ORDER BY created_at DESC LIMIT 30").all(s.user_id);
      send(res, 200, { jobs: rows.map((a) => ({ id: a.id, status: a.status, payout: a.payout_paise, distanceKm: a.distance_km, createdAt: a.created_at, deliveredAt: a.delivered_at })) });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/runner\/jobs\/[a-zA-Z0-9-]+\/action$/) && method === 'POST') {
      const s = requirePartner(['runner']);
      const id = route.split('/')[3];
      const assignment = db.prepare("SELECT * FROM nb_delivery_assignments WHERE id=? AND runner_id=? AND status IN ('accepted','picked_up')").get(id, s.user_id);
      if (!assignment) fail(404, 'Active delivery not found.');
      const so = db.prepare('SELECT * FROM nb_seller_orders WHERE id=?').get(assignment.seller_order_id);
      if (!so || !['runner_assigned', 'picked_up', 'out_for_delivery'].includes(so.status)) fail(409, 'This delivery is no longer active.');
      const order = db.prepare('SELECT * FROM nb_orders WHERE id=?').get(so.order_id);
      const action = String(payload.action || '');
      let message = '';
      transaction(() => {
        if (action === 'arrived') {
          addEvent(so.order_id, so.id, 'runner_arrived', 'Delivery partner at the shop', `${s.name} reached ${db.prepare('SELECT name FROM nb_shops WHERE id=?').get(so.shop_id)?.name}.`, 'runner');
          message = 'Shop arrival recorded.';
        } else if (action === 'picked_up') {
          if (so.status !== 'runner_assigned') fail(409, 'This order has already been picked up.');
          if (!safeEqual(deriveCode('handover', so.id, 4), String(payload.pickupPin || ''))) fail(400, 'The seller’s handover PIN is not correct.');
          db.prepare("UPDATE nb_delivery_assignments SET status='picked_up',picked_up_at=? WHERE id=?").run(now(), assignment.id);
          db.prepare('UPDATE nb_seller_orders SET status=?,updated_at=? WHERE id=?').run('picked_up', now(), so.id);
          db.prepare('INSERT INTO nb_delivery_tracking(seller_order_id,status,note,lat,lng,actor,created_at) VALUES(?,?,?,?,?,?,?)')
            .run(so.id, 'picked_up', 'Collected from shop after handover PIN verification', Number(payload.lat) || null, Number(payload.lng) || null, 'runner', now());
          addEvent(so.order_id, so.id, 'picked_up', 'Order picked up', 'Handover PIN verified at the shop.', 'runner');
          notify(order.customer_id, 'Order picked up', `${s.name} collected ${so.code} and is on the way to you.`, 'order', `#/orders/${order.code}`);
          message = 'Pickup confirmed with the seller’s handover PIN.';
        } else if (action === 'out_for_delivery') {
          if (so.status !== 'picked_up') fail(409, 'Pick up the order first.');
          db.prepare('UPDATE nb_seller_orders SET status=?,updated_at=? WHERE id=?').run('out_for_delivery', now(), so.id);
          addEvent(so.order_id, so.id, 'out_for_delivery', 'Out for delivery', `${s.name} is on the way with your order.`, 'runner');
          notify(order.customer_id, 'Out for delivery', `${s.name} is on the way with ${so.code}. Keep your delivery OTP ready.`, 'order', `#/orders/${order.code}`);
          message = 'Marked out for delivery.';
        } else if (action === 'delivered') {
          if (so.status !== 'out_for_delivery') fail(409, 'Mark the order out for delivery before completing it.');
          if (!safeEqual(deriveCode('delivery', so.id, 6), String(payload.otp || ''))) {
            db.prepare('UPDATE nb_seller_orders SET delivery_attempts=delivery_attempts+1 WHERE id=?').run(so.id);
            fail(400, 'That delivery OTP is not correct. Ask the customer to read it from their order page.');
          }
          db.prepare("UPDATE nb_delivery_assignments SET status='delivered',delivered_at=? WHERE id=?").run(now(), assignment.id);
          db.prepare("UPDATE nb_seller_orders SET status='delivered',delivered_at=?,updated_at=? WHERE id=?").run(now(), now(), so.id);
          db.prepare('UPDATE nb_runners SET completed=completed+1 WHERE user_id=?').run(s.user_id);
          addEvent(so.order_id, so.id, 'delivered', 'Delivered', 'Delivery OTP verified by the customer at the doorstep.', 'runner');
          notify(order.customer_id, 'Order delivered', `${so.code} was delivered by ${s.name}. Rate your experience in Orders.`, 'order', `#/orders/${order.code}`);
          syncParentPayment(order.id);
          message = 'Delivery completed after OTP verification.';
        } else {
          fail(400, 'Unknown delivery action.');
        }
        audit('runner', s.user_id, `runner_${action}`, 'delivery', assignment.id, so.code);
      });
      send(res, 200, { message });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/runner\/jobs\/[a-zA-Z0-9-]+\/location$/) && method === 'POST') {
      const s = requirePartner(['runner']);
      const id = route.split('/')[3];
      const assignment = db.prepare("SELECT * FROM nb_delivery_assignments WHERE id=? AND runner_id=? AND status IN ('accepted','picked_up')").get(id, s.user_id);
      if (!assignment) fail(404, 'Active delivery not found.');
      const lat = Number(payload.lat);
      const lng = Number(payload.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail(400, 'A valid location is required.');
      db.prepare('UPDATE nb_runners SET lat=?,lng=? WHERE user_id=?').run(lat, lng, s.user_id);
      db.prepare('INSERT INTO nb_delivery_tracking(seller_order_id,status,note,lat,lng,actor,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(assignment.seller_order_id, 'location', 'Runner shared a location', lat, lng, 'runner', now());
      send(res, 200, { message: 'Location shared with the customer.' });
      return true;
    }

    /* Runner: earnings, payouts, preferences, notifications, safety      */
    /* Rate card (server-side, transparent): base ₹30 + ₹9 per km of the   */
    /* runner-to-shop distance, clamped to ₹35–₹150. This matches the     */
    /* payout stored on each assignment at offer time.                    */
    const RUNNER_RATE_CARD = { basePaise: 3000, perKmPaise: 900, minPaise: 3500, maxPaise: 15000 };
    function runnerEarningsBreakdown(assignment) {
      const payout = Number(assignment.payout_paise || 0);
      const base = Math.min(RUNNER_RATE_CARD.basePaise, payout);
      const distanceComponent = Math.max(0, payout - base);
      return { base, distanceComponent, total: payout, distanceKm: assignment.distance_km ?? null };
    }
    function runnerDelivered(userId) {
      return db.prepare(`SELECT a.*, so.code AS order_code, s.name AS shop_name
        FROM nb_delivery_assignments a JOIN nb_seller_orders so ON so.id=a.seller_order_id
        JOIN nb_shops s ON s.id=a.shop_id
        WHERE a.runner_id=? AND a.status='delivered' ORDER BY a.delivered_at DESC`).all(userId);
    }

    if (base === '/api/partner' && route === '/runner/earnings' && method === 'GET') {
      const s = requirePartner(['runner']);
      const rows = runnerDelivered(s.user_id);
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      const weekStart = new Date(dayStart.getTime() - 6 * 86400e3);
      const monthStart = new Date(dayStart.getFullYear(), dayStart.getMonth(), 1);
      const sumSince = (d) => rows.filter((r) => new Date(r.delivered_at).getTime() >= d.getTime()).reduce((t, r) => t + Number(r.payout_paise), 0);
      const byDay = {};
      for (const r of rows) {
        const key = String(r.delivered_at).slice(0, 10);
        byDay[key] = (byDay[key] || 0) + Number(r.payout_paise);
      }
      send(res, 200, {
        rateCard: { basePaise: RUNNER_RATE_CARD.basePaise, perKmPaise: RUNNER_RATE_CARD.perKmPaise, minPaise: RUNNER_RATE_CARD.minPaise, maxPaise: RUNNER_RATE_CARD.maxPaise, note: 'Base ₹30 per delivery plus ₹9 per km of runner-to-shop distance, clamped between ₹35 and ₹150. The Admin Portal controls the live rate card.' },
        totals: {
          today: sumSince(dayStart), week: sumSince(weekStart), month: sumSince(monthStart),
          allTime: rows.reduce((t, r) => t + Number(r.payout_paise), 0),
          deliveries: rows.length,
          avgPerDelivery: rows.length ? Math.round(rows.reduce((t, r) => t + Number(r.payout_paise), 0) / rows.length) : 0,
          distanceKm: Math.round(rows.reduce((t, r) => t + Number(r.distance_km || 0), 0) * 100) / 100
        },
        byDay,
        deliveries: rows.slice(0, 50).map((r) => ({
          id: r.id, orderCode: r.order_code, shop: r.shop_name, deliveredAt: r.delivered_at,
          breakdown: runnerEarningsBreakdown(r)
        }))
      });
      return true;
    }

    if (base === '/api/partner' && route === '/runner/payouts' && method === 'GET') {
      const s = requirePartner(['runner']);
      const rows = db.prepare('SELECT * FROM nb_runner_payouts WHERE runner_id=? ORDER BY created_at DESC').all(s.user_id);
      const sum = (status) => rows.filter((r) => r.status === status).reduce((t, r) => t + Number(r.net_paise), 0);
      send(res, 200, {
        summary: { pending: sum('pending'), processing: sum('processing'), completed: sum('completed'), failed: sum('failed'), onHold: sum('on_hold') },
        payouts: rows.map((r) => ({ id: r.id, period: r.period_label, gross: r.gross_paise, adjustments: r.adjustments_paise, net: r.net_paise, status: r.status, reference: r.reference, createdAt: r.created_at, updatedAt: r.updated_at }))
      });
      return true;
    }

    if (base === '/api/partner' && route === '/runner/payouts/request' && method === 'POST') {
      const s = requirePartner(['runner']);
      const delivered = runnerDelivered(s.user_id);
      const covered = new Set(db.prepare("SELECT id FROM nb_runner_payouts WHERE runner_id=? AND status NOT IN ('failed')").all(s.user_id).map(() => null));
      const existing = db.prepare("SELECT * FROM nb_runner_payouts WHERE runner_id=? AND status IN ('pending','processing')").all(s.user_id);
      if (existing.length) fail(409, 'You already have a payout in progress. It will appear here when operations process it.');
      const gross = delivered.reduce((t, r) => t + Number(r.payout_paise), 0);
      const paidOut = db.prepare("SELECT COALESCE(SUM(net_paise),0) AS n FROM nb_runner_payouts WHERE runner_id=? AND status='completed'").get(s.user_id).n;
      const net = gross - Number(paidOut);
      if (net <= 0) fail(400, 'There is no unpaid delivery earning to request yet. Complete a delivery first.');
      const id = uid();
      const period = new Date().toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
      db.prepare('INSERT INTO nb_runner_payouts(id,runner_id,period_label,gross_paise,adjustments_paise,net_paise,status,reference,created_at,updated_at) VALUES(?,?,?,?,?,?,?,NULL,?,?)')
        .run(id, s.user_id, period, gross, 0, net, 'pending', now(), now());
      audit('runner', s.user_id, 'payout_requested', 'payout', id, `₹${Math.round(net / 100)} · ${period}`);
      send(res, 201, { message: 'Payout requested. Operations will process it and update the status here.', payout: { id, net, status: 'pending' } });
      return true;
    }

    if (base === '/api/partner' && route === '/runner/service-areas' && method === 'GET') {
      requirePartner(['runner']);
      const rows = db.prepare('SELECT * FROM nb_service_areas WHERE active=1 ORDER BY pincode').all();
      send(res, 200, { areas: rows.map((a) => ({ pincode: a.pincode, locality: a.locality, city: a.city, active: Boolean(a.active) })) });
      return true;
    }

    if (base === '/api/partner' && route === '/runner/preferences' && method === 'GET') {
      const s = requirePartner(['runner']);
      const row = db.prepare('SELECT * FROM nb_runner_preferences WHERE user_id=?').get(s.user_id);
      send(res, 200, { preferences: row ? { areas: row.areas, pincodes: row.pincodes, hours: row.hours, maxDistanceKm: row.max_distance_km, categories: row.categories, updatedAt: row.updated_at } : { areas: '', pincodes: '', hours: '', maxDistanceKm: 10, categories: '', updatedAt: null } });
      return true;
    }

    if (base === '/api/partner' && route === '/runner/preferences' && method === 'PATCH') {
      const s = requirePartner(['runner']);
      const areas = String(payload.areas || '').trim().slice(0, 500);
      const pincodes = String(payload.pincodes || '').trim().slice(0, 200);
      const hours = String(payload.hours || '').trim().slice(0, 200);
      const categories = String(payload.categories || '').trim().slice(0, 300);
      const maxDistanceKm = Number(payload.maxDistanceKm);
      if (!Number.isFinite(maxDistanceKm) || maxDistanceKm < 1 || maxDistanceKm > 25) fail(400, 'Maximum delivery distance must be between 1 and 25 km.');
      if (pincodes && pincodes.split(',').some((p) => !/^\d{6}$/.test(p.trim()))) fail(400, 'PIN codes must be 6 digits, separated by commas.');
      db.prepare(`INSERT INTO nb_runner_preferences(user_id,areas,pincodes,hours,max_distance_km,categories,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET areas=excluded.areas,pincodes=excluded.pincodes,hours=excluded.hours,max_distance_km=excluded.max_distance_km,categories=excluded.categories,updated_at=excluded.updated_at`)
        .run(s.user_id, areas, pincodes, hours, maxDistanceKm, categories, now());
      audit('runner', s.user_id, 'preferences_updated', 'runner', s.user_id, `max ${maxDistanceKm}km · ${areas || 'all areas'}`);
      send(res, 200, { message: 'Work preferences saved. New offers will respect your maximum distance.' });
      return true;
    }

    if (base === '/api/partner' && route === '/runner/notifications' && method === 'GET') {
      const s = requirePartner(['runner']);
      const rows = db.prepare('SELECT * FROM nb_notifications WHERE user_id=? ORDER BY id DESC LIMIT 100').all(s.user_id);
      send(res, 200, { notifications: rows.map((n) => ({ id: n.id, title: n.title, body: n.body, type: n.type, link: n.link, read: Boolean(n.is_read), at: n.created_at })), unread: rows.filter((n) => !n.is_read).length });
      return true;
    }

    if (base === '/api/partner' && route === '/runner/notifications/read' && method === 'POST') {
      const s = requirePartner(['runner']);
      db.prepare('UPDATE nb_notifications SET is_read=1 WHERE user_id=?').run(s.user_id);
      send(res, 200, { message: 'All notifications marked as read.' });
      return true;
    }

    if (base === '/api/partner' && route === '/runner/profile' && method === 'PATCH') {
      const s = requirePartner(['runner']);
      const name = String(payload.name || '').trim();
      const phone = String(payload.phone || '').trim();
      const vehicle = String(payload.vehicle || '').trim().slice(0, 40);
      if (name && name.length < 2) fail(400, 'Name must be at least 2 characters.');
      if (phone && !/^\+?[\d\s-]{10,15}$/.test(phone)) fail(400, 'Enter a valid mobile number.');
      if (vehicle && !['Scooter', 'Motorcycle', 'Bicycle', 'On foot', 'Car'].includes(vehicle)) fail(400, 'Choose a supported vehicle type.');
      transaction(() => {
        if (name) db.prepare('UPDATE nb_users SET name=? WHERE id=?').run(name, s.user_id);
        if (phone) db.prepare('UPDATE nb_users SET phone=? WHERE id=?').run(phone, s.user_id);
        if (vehicle) db.prepare('UPDATE nb_runners SET vehicle=? WHERE user_id=?').run(vehicle.toLowerCase(), s.user_id);
      });
      audit('runner', s.user_id, 'profile_updated', 'runner', s.user_id, [name ? 'name' : null, phone ? 'phone' : null, vehicle ? 'vehicle' : null].filter(Boolean).join(', '));
      send(res, 200, { message: 'Profile updated.' });
      return true;
    }

    if (base === '/api/partner' && route === '/runner/safety/tickets' && method === 'GET') {
      const s = requirePartner(['runner']);
      const rows = db.prepare('SELECT * FROM nb_runner_tickets WHERE user_id=? ORDER BY created_at DESC').all(s.user_id);
      send(res, 200, { tickets: rows.map((t) => ({ code: t.code, category: t.category, subject: t.subject, status: t.status, assignedAgent: t.assigned_agent, createdAt: t.created_at, updatedAt: t.updated_at })) });
      return true;
    }

    if (base === '/api/partner' && route === '/runner/safety/tickets' && method === 'POST') {
      const s = requirePartner(['runner']);
      const category = String(payload.category || 'general').slice(0, 60);
      const subject = String(payload.subject || '').trim();
      const description = String(payload.description || '').trim();
      if (!str(subject, 3, 120)) fail(400, 'Give the report a short subject.');
      if (!str(description, 10, 2000)) fail(400, 'Describe what happened in at least 10 characters.');
      const id = uid();
      const code = `SAFE-${String(Math.floor(100000 + Math.random() * 900000))}`;
      transaction(() => {
        db.prepare('INSERT INTO nb_runner_tickets(id,code,user_id,category,subject,description,attachment,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(id, code, s.user_id, category, subject, description, payload.attachment ? String(payload.attachment).slice(0, 300) : null, 'open', now(), now());
        db.prepare('INSERT INTO nb_runner_ticket_messages(id,ticket_id,author_role,author_name,body,created_at) VALUES(?,?,?,?,?,?)')
          .run(uid(), id, 'runner', s.name, description, now());
      });
      audit('runner', s.user_id, 'safety_report_created', 'ticket', id, `${code} · ${category}`);
      send(res, 201, { ticket: { code, status: 'open' }, message: `Safety report ${code} created. Support will reply in this thread.` });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/runner\/safety\/tickets\/[A-Za-z0-9-]+$/) && method === 'GET') {
      const s = requirePartner(['runner']);
      const ticket = db.prepare('SELECT * FROM nb_runner_tickets WHERE code=? AND user_id=?').get(decodeURIComponent(route.split('/')[4]), s.user_id);
      if (!ticket) fail(404, 'Ticket not found.');
      const messages = db.prepare('SELECT * FROM nb_runner_ticket_messages WHERE ticket_id=? ORDER BY created_at').all(ticket.id);
      send(res, 200, { ticket: { code: ticket.code, category: ticket.category, subject: ticket.subject, description: ticket.description, status: ticket.status, assignedAgent: ticket.assigned_agent, attachment: ticket.attachment, createdAt: ticket.created_at, updatedAt: ticket.updated_at, messages: messages.map((m) => ({ authorRole: m.author_role, authorName: m.author_name, body: m.body, at: m.created_at })) } });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/runner\/safety\/tickets\/[A-Za-z0-9-]+\/(reply|close)$/) && method === 'POST') {
      const s = requirePartner(['runner']);
      const parts = route.split('/');
      const ticket = db.prepare('SELECT * FROM nb_runner_tickets WHERE code=? AND user_id=?').get(decodeURIComponent(parts[4]), s.user_id);
      if (!ticket) fail(404, 'Ticket not found.');
      if (parts[5] === 'close') {
        db.prepare("UPDATE nb_runner_tickets SET status='closed',updated_at=? WHERE id=?").run(now(), ticket.id);
        send(res, 200, { message: 'Ticket closed.' });
        return true;
      }
      if (ticket.status === 'closed') fail(409, 'This ticket is closed. Create a new report if you still need help.');
      if (!str(payload.body, 2, 2000)) fail(400, 'Write a message of at least 2 characters.');
      transaction(() => {
        db.prepare('INSERT INTO nb_runner_ticket_messages(id,ticket_id,author_role,author_name,body,created_at) VALUES(?,?,?,?,?,?)').run(uid(), ticket.id, 'runner', s.name, payload.body.trim(), now());
        db.prepare("UPDATE nb_runner_tickets SET status=?,updated_at=? WHERE id=?").run(ticket.status === 'awaiting_runner' ? 'in_progress' : ticket.status, now(), ticket.id);
      });
      send(res, 200, { message: 'Reply added.' });
      return true;
    }

    /* ================================================================== */
    /* Payments                                                            */
    /* ================================================================== */

    if (method === 'POST' && custRoute === '/payments/intent') {
      const s = requireCustomer(req);
      if (s.is_demo) fail(403, 'Demo orders cannot start real payments. Use cash on delivery or pay at pickup; no money is collected in this sandbox.');
      if (!GATEWAY.configured) fail(503, 'Online payment is not configured. This deployment has no Razorpay keys, so no payment can be started.');
      const order = orderByCode(String(payload.orderCode || ''), s.user_id);
      const eligibility = validatePaymentEligibility(order);

      const existingInFlight = inFlightPaymentIntents.get(order.id);
      if (existingInFlight) {
        const result = await existingInFlight;
        const freshOrder = db.prepare('SELECT * FROM nb_orders WHERE id=?').get(order.id);
        const freshEligibility = validatePaymentEligibility(freshOrder);
        const activeRecord = findActivePaymentIntent(order.id) || result.record;
        if (!activeRecord || !activeRecord.reference || !['created', 'pending'].includes(activeRecord.status)) {
          fail(409, 'This payment intent is no longer active. Please try again.');
        }
        if (Number(activeRecord.amount_paise) !== freshEligibility.payableAmount) {
          fail(409, 'The payable amount for this order changed while starting payment. Please try again.');
        }
        send(res, 200, paymentIntentResponse(freshOrder, activeRecord, true));
        return true;
      }

      const existingActive = findActivePaymentIntent(order.id);
      if (existingActive && Number(existingActive.amount_paise) === eligibility.payableAmount) {
        if (order.payment_method !== 'online') {
          db.prepare("UPDATE nb_orders SET payment_method='online',updated_at=? WHERE id=?").run(now(), order.id);
        }
        send(res, 200, paymentIntentResponse(order, existingActive, true));
        return true;
      }

      const attemptNumber = Number(
        db.prepare("SELECT COUNT(*) AS n FROM nb_payment_records WHERE order_id=? AND provider='razorpay' AND reference IS NOT NULL").get(order.id)?.n || 0
      ) + 1;
      const attemptId = uid();
      const receipt = (attemptNumber === 1 ? order.code : `${order.code}-${attemptNumber}`).slice(0, 40);

      const createPromise = (async () => {
        const auth = Buffer.from(`${GATEWAY.keyId}:${GATEWAY.keySecret}`).toString('base64');
        let gatewayOrder;
        try {
          const resGateway = await fetch(`${GATEWAY.apiBase}/v1/orders`, {
            method: 'POST',
            headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              amount: eligibility.payableAmount,
              currency: 'INR',
              receipt,
              notes: { nearbuyOrder: order.id, paymentAttempt: attemptId, attempt: attemptNumber }
            }),
            signal: AbortSignal.timeout(12000)
          });
          gatewayOrder = await resGateway.json();
          const gatewayOrderId = typeof gatewayOrder?.id === 'string' ? gatewayOrder.id.trim() : '';
          if (!resGateway.ok || !gatewayOrderId) throw new Error(gatewayOrder?.error?.description || 'Gateway refused the order');
          gatewayOrder.id = gatewayOrderId;
        } catch (err) {
          fail(502, `The payment gateway could not be reached: ${err.message}`);
        }

        let persisted = null;
        let reused = false;
        let postError = null;

        transaction(() => {
          const ts = now();
          const freshOrder = db.prepare('SELECT * FROM nb_orders WHERE id=?').get(order.id);
          const existingRef = db.prepare("SELECT * FROM nb_payment_records WHERE provider='razorpay' AND reference=?").get(gatewayOrder.id);

          let freshEligibility;
          try {
            freshEligibility = validatePaymentEligibility(freshOrder);
          } catch (err) {
            if (!existingRef) {
              const terminalStatus = freshOrder && freshOrder.payment_status === 'paid' ? 'superseded' : 'cancelled';
              db.prepare(`INSERT INTO nb_payment_records(id,order_id,seller_order_id,provider,method,amount_paise,status,reference,created_at,updated_at)
                VALUES(?,?,NULL,'razorpay','online',?,?,?,?,?)`)
                .run(attemptId, order.id, eligibility.payableAmount, terminalStatus, gatewayOrder.id, ts, ts);
              syncPaymentAllocations(attemptId, order.id, eligibility.activeSellerOrders, eligibility.payableAmount, ts);
            }
            postError = err;
            return;
          }

          if (existingRef) {
            if (existingRef.order_id !== order.id) {
              postError = new HttpError(502, 'The payment gateway returned a reference already linked to another order.');
              return;
            }
            persisted = existingRef;
            reused = true;
            return;
          }

          const concurrentActive = findActivePaymentIntent(order.id);
          if (concurrentActive && Number(concurrentActive.amount_paise) === freshEligibility.payableAmount) {
            db.prepare(`INSERT INTO nb_payment_records(id,order_id,seller_order_id,provider,method,amount_paise,status,reference,created_at,updated_at)
              VALUES(?,?,NULL,'razorpay','online',?,'superseded',?,?,?)`)
              .run(attemptId, order.id, eligibility.payableAmount, gatewayOrder.id, ts, ts);
            syncPaymentAllocations(attemptId, order.id, eligibility.activeSellerOrders, eligibility.payableAmount, ts);
            persisted = concurrentActive;
            reused = true;
            return;
          }

          if (freshEligibility.payableAmount !== eligibility.payableAmount) {
            db.prepare(`INSERT INTO nb_payment_records(id,order_id,seller_order_id,provider,method,amount_paise,status,reference,created_at,updated_at)
              VALUES(?,?,NULL,'razorpay','online',?,'superseded',?,?,?)`)
              .run(attemptId, order.id, eligibility.payableAmount, gatewayOrder.id, ts, ts);
            syncPaymentAllocations(attemptId, order.id, eligibility.activeSellerOrders, eligibility.payableAmount, ts);
            postError = new HttpError(409, 'The payable amount for this order changed while starting payment. Please try again.');
            return;
          }

          if (concurrentActive) {
            db.prepare("UPDATE nb_payment_records SET status='superseded',updated_at=? WHERE id=?").run(ts, concurrentActive.id);
          }

          const placeholder = db.prepare(`SELECT id FROM nb_payment_records
            WHERE order_id=? AND provider='razorpay' AND method='online' AND status='pending' AND reference IS NULL
            ORDER BY created_at ASC, rowid ASC LIMIT 1`).get(order.id);

          db.prepare(`UPDATE nb_payment_records SET status='superseded',updated_at=?
            WHERE order_id=? AND status='pending' AND reference IS NULL AND id<>?`)
            .run(ts, order.id, placeholder ? placeholder.id : '');

          if (placeholder) {
            db.prepare("UPDATE nb_payment_records SET amount_paise=?,status='created',reference=?,updated_at=? WHERE id=? AND reference IS NULL")
              .run(freshEligibility.payableAmount, gatewayOrder.id, ts, placeholder.id);
            syncPaymentAllocations(placeholder.id, order.id, freshEligibility.activeSellerOrders, freshEligibility.payableAmount, ts);
            persisted = db.prepare('SELECT * FROM nb_payment_records WHERE id=?').get(placeholder.id);
          } else {
            db.prepare(`INSERT INTO nb_payment_records(id,order_id,seller_order_id,provider,method,amount_paise,status,reference,created_at,updated_at)
              VALUES(?,?,NULL,'razorpay','online',?,'created',?,?,?)`)
              .run(attemptId, order.id, freshEligibility.payableAmount, gatewayOrder.id, ts, ts);
            syncPaymentAllocations(attemptId, order.id, freshEligibility.activeSellerOrders, freshEligibility.payableAmount, ts);
            persisted = db.prepare('SELECT * FROM nb_payment_records WHERE id=?').get(attemptId);
          }

          db.prepare("UPDATE nb_orders SET payment_method='online',updated_at=? WHERE id=?").run(ts, order.id);
          audit('customer', s.user_id, 'payment_intent_created', 'order', order.id, `${gatewayOrder.id} · ₹${Math.round(freshEligibility.payableAmount / 100)}`);
        });

        if (postError) throw postError;
        return { record: persisted, reused };
      })();

      inFlightPaymentIntents.set(order.id, createPromise);
      try {
        const result = await createPromise;
        const freshOrder = db.prepare('SELECT * FROM nb_orders WHERE id=?').get(order.id);
        send(res, result.reused ? 200 : 201, paymentIntentResponse(freshOrder, result.record, result.reused));
        return true;
      } finally {
        if (inFlightPaymentIntents.get(order.id) === createPromise) {
          inFlightPaymentIntents.delete(order.id);
        }
      }
    }

    /* ================================================================== */
    /* Admin console API                                                   */
    /* ================================================================== */

    if (base === '/api/admin' && route === '/login' && method === 'POST') {
      rateLimit(`admin-login:${clientIp(req)}`, 10, 900e3);
      const email = String(payload.email || '').trim().toLowerCase();
      const user = db.prepare("SELECT * FROM nb_users WHERE email=? AND role='admin'").get(email);
      const ok = user ? checkPassword(payload.password || '', user.password_hash) : checkPassword(payload.password || '', makePassword('invalid-password'));
      if (!user || !ok) fail(401, 'Those administrator details are not valid.');
      const sess = startSession(req, user, ADMIN_COOKIE);
      audit('admin', user.id, 'admin_login', 'user', user.id, 'Administrator signed in');
      send(res, 200, { user: { id: user.id, name: user.name, email: user.email, role: user.role, csrf: sess.csrf } }, { 'Set-Cookie': sess.cookie });
      return true;
    }

    if (base === '/api/admin' && route === '/logout' && method === 'POST') {
      const s = sessionFor(req, ADMIN_COOKIE);
      if (s) db.prepare('DELETE FROM nb_sessions WHERE token_hash=?').run(sha(s.token));
      send(res, 200, { ok: true }, { 'Set-Cookie': `${ADMIN_COOKIE}=; ${cookieAttrs(req)}; Max-Age=0` });
      return true;
    }

    const requireAdmin = () => requireUser(req, ['admin'], ADMIN_COOKIE);

    if (base === '/api/admin' && route === '/me' && method === 'GET') {
      const s = sessionFor(req, ADMIN_COOKIE);
      send(res, 200, { user: s && s.role === 'admin' ? { id: s.user_id, name: s.name, email: s.email, csrf: s.csrf, role: 'admin' } : null });
      return true;
    }

    if (base === '/api/admin' && route === '/overview' && method === 'GET') {
      requireAdmin();
      const count = (sql, ...p) => Number(db.prepare(sql).get(...p).n || 0);
      send(res, 200, {
        counts: {
          customers: count("SELECT COUNT(*) AS n FROM nb_users WHERE role='customer'"),
          shops: count('SELECT COUNT(*) AS n FROM nb_shops'),
          products: count('SELECT COUNT(*) AS n FROM nb_products'),
          orders: count('SELECT COUNT(*) AS n FROM nb_orders'),
          openTickets: count("SELECT COUNT(*) AS n FROM nb_tickets WHERE status NOT IN ('resolved','closed')"),
          pendingRefunds: count("SELECT COUNT(*) AS n FROM nb_refunds WHERE status NOT IN ('completed','rejected')"),
          pendingReturns: count("SELECT COUNT(*) AS n FROM nb_returns WHERE status NOT IN ('completed','rejected')"),
          reviews: count('SELECT COUNT(*) AS n FROM nb_reviews')
        },
        revenue: Number(db.prepare("SELECT COALESCE(SUM(total_paise),0) AS n FROM nb_orders WHERE payment_status='paid'").get().n),
        gmv: Number(db.prepare("SELECT COALESCE(SUM(total_paise),0) AS n FROM nb_orders WHERE status NOT IN ('cancelled')").get().n),
        recentOrders: db.prepare('SELECT * FROM nb_orders ORDER BY created_at DESC LIMIT 10').all().map((o) => orderSummary(o)),
        recentEnquiries: db.prepare('SELECT * FROM nb_enquiries ORDER BY created_at DESC LIMIT 10').all()
      });
      return true;
    }

    if (base === '/api/admin' && route === '/customers' && method === 'GET') {
      requireAdmin();
      const rows = db.prepare("SELECT u.id,u.name,u.email,u.phone,u.status,u.is_demo,u.created_at, (SELECT COUNT(*) FROM nb_orders o WHERE o.customer_id=u.id) AS orders FROM nb_users u WHERE u.role='customer' ORDER BY u.created_at DESC LIMIT 200").all();
      send(res, 200, { customers: rows });
      return true;
    }

    if (base === '/api/admin' && route === '/shops' && method === 'GET') {
      requireAdmin();
      const rows = db.prepare(`SELECT s.*, u.email AS owner_email,
        (SELECT COUNT(*) FROM nb_products p WHERE p.shop_id=s.id) AS products,
        (SELECT COUNT(*) FROM nb_seller_orders so WHERE so.shop_id=s.id) AS orders
        FROM nb_shops s LEFT JOIN nb_users u ON u.id=s.owner_user_id ORDER BY s.name`).all();
      send(res, 200, { shops: rows.map((s) => ({ ...shopCard(s, null), ownerEmail: s.owner_email, orders: Number(s.orders || 0) })) });
      return true;
    }

    if (base === '/api/admin' && route === '/orders' && method === 'GET') {
      requireAdmin();
      const rows = db.prepare('SELECT * FROM nb_orders ORDER BY created_at DESC LIMIT 100').all();
      send(res, 200, { orders: rows.map((o) => orderSummary(o)) });
      return true;
    }

    if (base === '/api/admin' && route === '/returns' && method === 'GET') {
      requireAdmin();
      const rows = db.prepare(`SELECT r.*, o.code AS order_code, s.name AS shop_name, i.name AS item_name
        FROM nb_returns r JOIN nb_orders o ON o.id=r.order_id JOIN nb_seller_orders so ON so.id=r.seller_order_id
        JOIN nb_shops s ON s.id=so.shop_id JOIN nb_order_items i ON i.id=r.item_id ORDER BY r.created_at DESC LIMIT 100`).all();
      const refunds = db.prepare(`SELECT r.*, o.code AS order_code, so.code AS seller_order_code, s.name AS shop_name
        FROM nb_refunds r
        LEFT JOIN nb_orders o ON o.id=r.order_id
        LEFT JOIN nb_returns ret ON ret.id=r.return_id
        LEFT JOIN nb_seller_orders so ON so.id=COALESCE(r.seller_order_id, ret.seller_order_id)
        LEFT JOIN nb_shops s ON s.id=so.shop_id
        ORDER BY r.created_at DESC LIMIT 100`).all();
      send(res, 200, { returns: rows, refunds });
      return true;
    }

    if (base === '/api/admin' && route.match(/^\/refunds\/[a-zA-Z0-9-]+\/status$/) && method === 'POST') {
      const admin = requireAdmin();
      const id = route.split('/')[2];
      const refund = db.prepare('SELECT * FROM nb_refunds WHERE id=?').get(id);
      if (!refund) fail(404, 'Refund not found');
      const allowed = ['requested', 'under_review', 'approved', 'processing', 'completed', 'rejected'];
      if (!allowed.includes(payload.status)) fail(400, 'Choose a valid refund status.');
      if (payload.status === 'completed' && refund.status !== 'processing' && refund.status !== 'approved') {
        fail(409, 'A refund can only be completed from approved or processing.');
      }
      db.prepare('UPDATE nb_refunds SET status=?,reference=?,updated_at=? WHERE id=?')
        .run(payload.status, payload.reference ? String(payload.reference).slice(0, 120) : refund.reference, now(), id);
      if (refund.return_id) db.prepare('UPDATE nb_returns SET status=?,updated_at=? WHERE id=?').run(payload.status === 'completed' ? 'completed' : payload.status === 'rejected' ? 'rejected' : 'processing', now(), refund.return_id);
      const order = db.prepare('SELECT * FROM nb_orders WHERE id=?').get(refund.order_id);
      if (order) notify(order.customer_id, `Refund ${payload.status.replace('_', ' ')}`, `₹${Math.round(refund.amount_paise / 100)} for ${order.code} is now ${payload.status.replace('_', ' ')}.`, 'refund', '#/account/returns');
      audit('admin', admin.user_id, 'refund_status', 'refund', id, `${refund.status} → ${payload.status}`);
      send(res, 200, { message: `Refund marked ${payload.status}.` });
      return true;
    }

    if (base === '/api/admin' && route === '/reviews' && method === 'GET') {
      requireAdmin();
      const rows = db.prepare(`SELECT r.*, u.name AS customer_name, s.name AS shop_name, p.name AS product_name
        FROM nb_reviews r JOIN nb_users u ON u.id=r.customer_id LEFT JOIN nb_shops s ON s.id=r.shop_id LEFT JOIN nb_products p ON p.id=r.product_id
        ORDER BY r.created_at DESC LIMIT 200`).all();
      send(res, 200, { reviews: rows.map((r) => ({ ...r, customer_name: r.customer_name, shop_name: r.shop_name, product_name: r.product_name })) });
      return true;
    }

    if (base === '/api/admin' && route.match(/^\/reviews\/[a-zA-Z0-9-]+\/status$/) && method === 'POST') {
      const admin = requireAdmin();
      const id = route.split('/')[2];
      const review = db.prepare('SELECT * FROM nb_reviews WHERE id=?').get(id);
      if (!review) fail(404, 'Review not found');
      if (!['published', 'hidden', 'reported'].includes(payload.status)) fail(400, 'Choose published, hidden or reported.');
      db.prepare('UPDATE nb_reviews SET status=? WHERE id=?').run(payload.status, id);
      audit('admin', admin.user_id, 'review_moderated', 'review', id, `${review.status} → ${payload.status}`);
      send(res, 200, { message: `Review marked ${payload.status}.` });
      return true;
    }

    if (base === '/api/admin' && route === '/tickets' && method === 'GET') {
      requireAdmin();
      const rows = db.prepare(`SELECT t.*, u.name AS customer_name, u.email AS customer_email FROM nb_tickets t
        JOIN nb_users u ON u.id=t.customer_id ORDER BY t.created_at DESC LIMIT 100`).all();
      send(res, 200, { tickets: rows });
      return true;
    }

    if (base === '/api/admin' && route.match(/^\/tickets\/[A-Za-z0-9-]+\/(reply|status)$/) && method === 'POST') {
      const admin = requireAdmin();
      const code = decodeURIComponent(route.split('/')[2]);
      const ticket = db.prepare('SELECT * FROM nb_tickets WHERE code=?').get(code);
      if (!ticket) fail(404, 'Ticket not found');
      if (route.endsWith('/reply')) {
        if (!str(payload.body, 2, 3000)) fail(400, 'Write a reply.');
        transaction(() => {
          db.prepare('INSERT INTO nb_ticket_messages(id,ticket_id,author_role,author_name,body,created_at) VALUES(?,?,?,?,?,?)')
            .run(uid(), ticket.id, 'agent', admin.name, payload.body.trim(), now());
          db.prepare("UPDATE nb_tickets SET status='awaiting_customer',updated_at=? WHERE id=?").run(now(), ticket.id);
          notify(ticket.customer_id, 'Support replied to your ticket', `${code}: ${admin.name} replied. Open Help → My tickets to read it.`, 'support', `#/help/tickets/${code}`);
        });
        send(res, 200, { message: 'Reply sent and the customer was notified.' });
      } else {
        if (!['open', 'assigned', 'in_progress', 'awaiting_customer', 'resolved', 'closed'].includes(payload.status)) fail(400, 'Invalid ticket status.');
        db.prepare('UPDATE nb_tickets SET status=?,updated_at=? WHERE id=?').run(payload.status, now(), ticket.id);
        send(res, 200, { message: `Ticket ${payload.status}.` });
      }
      return true;
    }

    if (base === '/api/admin' && route === '/coupons' && method === 'GET') {
      requireAdmin();
      send(res, 200, { coupons: db.prepare('SELECT * FROM nb_coupons ORDER BY ends_at DESC').all(), offers: activeOffers(null) });
      return true;
    }

    if (base === '/api/admin' && route === '/coupons' && method === 'POST') {
      const admin = requireAdmin();
      const code = String(payload.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9-]{3,24}$/.test(code)) fail(400, 'Coupon code must be 3–24 letters, numbers or dashes.');
      if (db.prepare('SELECT 1 FROM nb_coupons WHERE code=?').get(code)) fail(409, 'That coupon code already exists.');
      const type = ['percent', 'fixed', 'free_delivery'].includes(payload.type) ? payload.type : 'percent';
      const value = type === 'fixed' ? Math.round(Number(payload.value || 0)) : clampInt(payload.value || 0, 0, 100);
      const minOrder = Math.round(Number(payload.minOrderPaise || 0));
      const endsAt = new Date(Date.now() + clampInt(payload.days || 30, 1, 365) * 864e5).toISOString();
      const shop = payload.shopSlug ? db.prepare('SELECT id FROM nb_shops WHERE slug=?').get(payload.shopSlug) : null;
      db.prepare(`INSERT INTO nb_coupons(code,title,description,type,value,min_order_paise,max_discount_paise,shop_id,starts_at,ends_at,usage_limit,used_count,per_customer_limit,active)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,0,1,1)`).run(code, String(payload.title || code).slice(0, 120), String(payload.description || '').slice(0, 300),
        type, value, minOrder, payload.maxDiscountPaise ? Math.round(Number(payload.maxDiscountPaise)) : null, shop?.id || null, now(), endsAt,
        payload.usageLimit ? clampInt(payload.usageLimit, 1, 100000) : null);
      audit('admin', admin.user_id, 'coupon_created', 'coupon', code, `${type} ${value}`);
      send(res, 201, { message: `Coupon ${code} created and live from now.` });
      return true;
    }

    if (base === '/api/admin' && route === '/banners' && method === 'GET') {
      requireAdmin();
      send(res, 200, { banners: db.prepare('SELECT * FROM nb_banners ORDER BY sort').all() });
      return true;
    }

    if (base === '/api/admin' && route === '/banners' && method === 'POST') {
      const admin = requireAdmin();
      if (!str(payload.title, 3, 120)) fail(400, 'A banner title is required.');
      db.prepare(`INSERT INTO nb_banners(id,title,subtitle,eyebrow,cta_label,cta_link,image_url,theme,active,sort)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(uid(), payload.title.trim(), String(payload.subtitle || '').slice(0, 300),
        String(payload.eyebrow || '').slice(0, 80), String(payload.ctaLabel || 'Shop now').slice(0, 40),
        String(payload.ctaLink || '#/shops').slice(0, 200), String(payload.imageUrl || '').slice(0, 300) || null,
        ['blue', 'green', 'cyan', 'amber'].includes(payload.theme) ? payload.theme : 'blue', payload.active === false ? 0 : 1,
        clampInt(payload.sort || 10, 0, 100));
      audit('admin', admin.user_id, 'banner_created', 'banner', null, payload.title);
      send(res, 201, { message: 'Banner created.' });
      return true;
    }

    if (base === '/api/admin' && route === '/enquiries' && method === 'GET') {
      requireAdmin();
      send(res, 200, { enquiries: db.prepare('SELECT * FROM nb_enquiries ORDER BY created_at DESC LIMIT 100').all() });
      return true;
    }

    if (base === '/api/admin' && method === 'PATCH' && /^\/enquiries\/[A-Za-z0-9-]+$/.test(route)) {
      const admin = requireAdmin();
      const code = route.split('/')[2];
      const status = String(payload.status || '');
      if (!['open', 'in_review', 'closed'].includes(status)) fail(400, 'Unknown enquiry status.');
      const row = db.prepare('SELECT * FROM nb_enquiries WHERE code = ?').get(code);
      if (!row) fail(404, 'Enquiry not found.');
      db.prepare('UPDATE nb_enquiries SET status = ? WHERE code = ?').run(status, code);
      audit('admin', admin.user_id, 'enquiry_status', 'enquiry', code, `Enquiry ${code} → ${status}`);
      send(res, 200, { message: `Enquiry ${code} marked ${status.replace('_', ' ')}.` });
      return true;
    }

    if (base === '/api/admin' && route === '/audit' && method === 'GET') {
      requireAdmin();
      send(res, 200, { logs: db.prepare('SELECT * FROM nb_audit_logs ORDER BY id DESC LIMIT 200').all() });
      return true;
    }

    /* ================================================================== */
    /* Seller shop profile + catalogue management                          */
    /* ================================================================== */

    if (base === '/api/partner' && route === '/seller/shop' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      send(res, 200, { shop: shopRow(shop) });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/shop' && method === 'PATCH') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const next = {
        is_open: payload.isOpen === undefined ? shop.is_open : payload.isOpen ? 1 : 0,
        delivery_enabled: payload.deliveryEnabled === undefined ? shop.delivery_enabled : payload.deliveryEnabled ? 1 : 0,
        pickup_enabled: payload.pickupEnabled === undefined ? shop.pickup_enabled : payload.pickupEnabled ? 1 : 0,
        prep_minutes: payload.prepMinutes === undefined ? shop.prep_minutes : clampInt(payload.prepMinutes, 1, 240),
        delivery_fee_paise: payload.deliveryFee === undefined ? shop.delivery_fee_paise : clampInt(payload.deliveryFee, 0, 200000),
        pickup_fee_paise: payload.pickupFee === undefined ? shop.pickup_fee_paise : clampInt(payload.pickupFee, 0, 200000),
        min_order_paise: payload.minOrder === undefined ? shop.min_order_paise : clampInt(payload.minOrder, 0, 1000000),
        radius_km: payload.radiusKm === undefined ? shop.radius_km : round2(Math.min(50, Math.max(0.5, Number(payload.radiusKm) || shop.radius_km))),
        opens_at: str(payload.opensAt, 4, 5) ? payload.opensAt.trim() : shop.opens_at,
        closes_at: str(payload.closesAt, 4, 5) ? payload.closesAt.trim() : shop.closes_at,
        phone: str(payload.phone, 6, 20) ? normalPhone(payload.phone) : shop.phone
      };
      if (!next.delivery_enabled && !next.pickup_enabled) fail(400, 'Keep at least one fulfilment option enabled: home delivery or store pickup.');
      if (!/^\d{1,2}:\d{2}$/.test(next.opens_at) || !/^\d{1,2}:\d{2}$/.test(next.closes_at)) fail(400, 'Opening and closing times must look like 09:00.');
      db.prepare(`UPDATE nb_shops SET is_open=?,delivery_enabled=?,pickup_enabled=?,prep_minutes=?,delivery_fee_paise=?,
        pickup_fee_paise=?,min_order_paise=?,radius_km=?,opens_at=?,closes_at=?,phone=? WHERE id=?`).run(
        next.is_open, next.delivery_enabled, next.pickup_enabled, next.prep_minutes, next.delivery_fee_paise,
        next.pickup_fee_paise, next.min_order_paise, next.radius_km, next.opens_at, next.closes_at, next.phone, shop.id
      );
      audit('seller', s.user_id, 'shop_updated', 'shop', shop.id, JSON.stringify(next).slice(0, 300));
      const updated = db.prepare('SELECT * FROM nb_shops WHERE id=?').get(shop.id);
      send(res, 200, { message: 'Shop settings saved. Customers see the change immediately.', shop: shopRow(updated) });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/products' && method === 'POST') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_products', 'Adding products');
      const name = String(payload.name || '').trim();
      if (!str(name, 2, 120)) fail(400, 'Give the product a name of 2–120 characters.');
      const categorySlug = String(payload.category || shop.category_slug);
      if (!db.prepare('SELECT 1 FROM nb_categories WHERE slug=?').get(categorySlug)) fail(400, 'Choose a valid category.');
      const price = Math.round(Number(payload.price));
      const mrp = payload.mrp === undefined || payload.mrp === null || payload.mrp === '' ? price : Math.round(Number(payload.mrp));
      if (!Number.isFinite(price) || price < 100 || price > 1000000) fail(400, 'Price must be between ₹1 and ₹10,000.');
      if (!Number.isFinite(mrp) || mrp < price) fail(400, 'MRP cannot be lower than the selling price.');
      const stock = clampInt(payload.stock, 0, 100000);
      const sku = payload.sku ? String(payload.sku).trim().slice(0, 60) : null;
      const barcode = payload.barcode ? String(payload.barcode).trim().slice(0, 60) : null;
      if (sku && db.prepare('SELECT id FROM nb_products WHERE shop_id=? AND sku=?').get(shop.id, sku)) fail(409, 'Another product in your shop already uses this SKU.');
      if (barcode && db.prepare('SELECT id FROM nb_products WHERE shop_id=? AND barcode=?').get(shop.id, barcode)) fail(409, 'Another product in your shop already uses this barcode.');
      const parentId = payload.parentProductId ? String(payload.parentProductId) : null;
      if (parentId && !db.prepare('SELECT id FROM nb_products WHERE id=? AND shop_id=?').get(parentId, shop.id)) fail(400, 'Parent product not found in your shop.');
      const compareKey = payload.compareKey ? String(payload.compareKey).trim().slice(0, 60)
        : `${NB_SLUG(name)}-${String(payload.unit || '1 pc').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const id = `${shop.slug}-${NB_SLUG(name).slice(0, 32)}-${randomBytes(3).toString('hex')}`;
      const active = payload.active === false ? 0 : 1;
      insertRow('nb_products',
        ['id', 'shop_id', 'category_slug', 'compare_key', 'name', 'brand', 'variant', 'description', 'highlights', 'specs', 'unit', 'pack_size', 'emoji', 'image_url',
          'price_paise', 'mrp_paise', 'tax_rate', 'stock', 'reserved', 'low_stock', 'return_days', 'rating', 'review_count', 'active', 'is_demo', 'created_at',
          'sku', 'barcode', 'parent_product_id', 'subcategory', 'weight_grams', 'dimensions', 'max_stock'],
        [id, shop.id, categorySlug, compareKey, name, String(payload.brand || '').trim() || null,
          String(payload.variant || '').trim() || null, String(payload.description || '').slice(0, 2000) || null,
          '[]', '[]', String(payload.unit || '1 pc').slice(0, 40), String(payload.packSize || '').slice(0, 40) || null,
          String(payload.emoji || '🛍️').slice(0, 8), String(payload.imageUrl || '').slice(0, 300) || null,
          price, mrp, Math.min(28, Math.max(0, Number(payload.taxRate) || 0)), stock, 0, clampInt(payload.lowStock ?? 5, 0, 100000),
          clampInt(payload.returnDays ?? 0, 0, 30), 0, 0, active, 0, now(), sku, barcode, parentId,
          String(payload.subcategory || '').trim().slice(0, 80) || null,
          payload.weightGrams != null ? clampInt(payload.weightGrams, 0, 500000) : null,
          String(payload.dimensions || '').trim().slice(0, 80) || null,
          payload.maxStock != null ? clampInt(payload.maxStock, 0, 1000000) : null]);
      const images = Array.isArray(payload.images) ? payload.images.filter((u) => typeof u === 'string' && u.startsWith('/')).slice(0, 8) : [];
      images.forEach((url, i) => db.prepare('INSERT INTO nb_product_images(product_id,url,sort) VALUES(?,?,?)').run(id, url.slice(0, 300), i));
      if (stock > 0) recordInventory(shop, { id, stock, reserved: 0, low_stock: clampInt(payload.lowStock ?? 5, 0, 100000), name }, 'opening', 0, stock, stock, 'Opening stock', s);
      audit('seller', s.user_id, 'product_created', 'product', id, `${name} · ${price}`);
      send(res, 201, { message: active ? `${name} is live in your catalogue.` : `${name} saved as a draft.`, productId: id, product: { id, name, price, mrp, stock, active: Boolean(active), sku, barcode } });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/products/bulk' && method === 'POST') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_products', 'Bulk product import');
      const rows = Array.isArray(payload.rows) ? payload.rows.slice(0, 200) : [];
      if (!rows.length) fail(400, 'Send at least one product row.');
      const created = [];
      const errors = [];
      transaction(() => {
        rows.forEach((row, idx) => {
          const line = idx + 2;
          const name = String(row.name || '').trim();
          const price = Math.round(Number(row.price));
          const stock = clampInt(row.stock ?? 0, 0, 100000);
          if (!str(name, 2, 120)) { errors.push({ line, message: 'Name must be 2–120 characters.' }); return; }
          const categorySlug = String(row.category || shop.category_slug);
          if (!db.prepare('SELECT 1 FROM nb_categories WHERE slug=?').get(categorySlug)) { errors.push({ line, message: `Unknown category ${categorySlug}.` }); return; }
          if (!Number.isFinite(price) || price < 100) { errors.push({ line, message: 'Price must be at least ₹1.' }); return; }
          const sku = row.sku ? String(row.sku).trim().slice(0, 60) : null;
          const barcode = row.barcode ? String(row.barcode).trim().slice(0, 60) : null;
          if (sku && db.prepare('SELECT id FROM nb_products WHERE shop_id=? AND sku=?').get(shop.id, sku)) { errors.push({ line, message: `SKU ${sku} already exists.` }); return; }
          if (barcode && db.prepare('SELECT id FROM nb_products WHERE shop_id=? AND barcode=?').get(shop.id, barcode)) { errors.push({ line, message: `Barcode ${barcode} already exists.` }); return; }
          const id = `${shop.slug}-${NB_SLUG(name).slice(0, 28)}-${randomBytes(3).toString('hex')}`;
          const compareKey = `${NB_SLUG(name)}-${String(row.unit || '1 pc').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
          insertRow('nb_products',
            ['id', 'shop_id', 'category_slug', 'compare_key', 'name', 'brand', 'unit', 'emoji', 'price_paise', 'mrp_paise', 'tax_rate', 'stock', 'reserved',
              'low_stock', 'return_days', 'rating', 'review_count', 'active', 'is_demo', 'created_at', 'sku', 'barcode'],
            [id, shop.id, categorySlug, compareKey, name, String(row.brand || '').trim() || null,
              String(row.unit || '1 pc').slice(0, 40), String(row.emoji || '🛍️').slice(0, 8),
              price, Math.max(price, Math.round(Number(row.mrp) || price)), 0, stock, 0,
              clampInt(row.lowStock ?? 5, 0, 100000), 0, 0, 0, 1, 0, now(), sku, barcode]);
          if (stock > 0) recordInventory(shop, { id, stock, reserved: 0, low_stock: clampInt(row.lowStock ?? 5, 0, 100000), name }, 'opening', 0, stock, stock, 'Bulk import opening stock', s);
          created.push(id);
        });
      });
      audit('seller', s.user_id, 'products_bulk_import', 'product', null, `${created.length} created, ${errors.length} errors`);
      send(res, 201, { message: `Imported ${created.length} product(s). ${errors.length ? `${errors.length} row(s) need attention.` : ''}`, created: created.length, errors });
      return true;
    }

    /* ================================================================== */
    /* ================================================================== */
    /* Seller Hub — extended business modules (same DB, shop-scoped)       */
    /* ================================================================== */

    function csvCell(v) {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }
    function sendCsv(res, filename, rows) {
      const body = rows.map((r) => r.map(csvCell).join(',')).join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store'
      });
      res.end(body);
    }
    function shopHoursPayload(shop) {
      const rows = db.prepare('SELECT * FROM nb_shop_hours WHERE shop_id=? ORDER BY day_of_week, holiday_date').all(shop.id);
      const days = [0, 1, 2, 3, 4, 5, 6].map((d) => {
        const r = rows.find((x) => x.day_of_week === d && !x.holiday_date);
        return {
          day: d, open: r?.open_time || shop.opens_at || '09:00', close: r?.close_time || shop.closes_at || '21:00',
          breakStart: r?.break_start || '', breakEnd: r?.break_end || '',
          shifts: (() => { try { return JSON.parse(r?.shifts_json || '[]'); } catch { return []; } })(),
          closed: Boolean(r?.closed)
        };
      });
      const holidays = rows.filter((r) => r.holiday_date).map((r) => ({ day: r.day_of_week, date: r.holiday_date, label: r.holiday_label || 'Holiday' }));
      return { days, holidays, isOpen: Boolean(shop.is_open), temporaryClosureUntil: shop.temporary_closure_until || null, holidayDate: shop.holiday_date || null, holidayLabel: shop.holiday_label || null };
    }
    function nextOpening(shop) {
      const hours = shopHoursPayload(shop);
      const nowDate = new Date();
      for (let add = 0; add < 8; add++) {
        const d = new Date(nowDate.getTime() + add * 864e5);
        const dow = d.getDay();
        const day = hours.days.find((x) => x.day === dow);
        const isHoliday = hours.holidays.some((h) => h.date === d.toISOString().slice(0, 10));
        if (!day || day.closed || isHoliday) continue;
        const [hh, mm] = String(day.open).split(':').map(Number);
        const openAt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh || 9, mm || 0);
        if (openAt > nowDate) return openAt.toISOString();
      }
      return null;
    }

    if (base === '/api/partner' && route === '/seller/verification' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s, { allowPending: true });
      const verification = db.prepare('SELECT * FROM nb_seller_verifications WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(s.user_id);
      const docs = verification ? db.prepare('SELECT * FROM nb_seller_documents WHERE verification_id=? ORDER BY created_at').all(verification.id) : [];
      const codes = sellerCodes(shop, s.user_id);
      send(res, 200, {
        shop: { id: shop.id, name: shop.name, verified: Boolean(shop.verified), sellerId: codes.sellerId, shopId: codes.shopId },
        verification: verification ? {
          status: verification.status, legalName: verification.legal_name, businessCategory: verification.business_category,
          shopType: verification.shop_type, description: verification.description, address: verification.address,
          pincode: verification.pincode, city: verification.city, state: verification.state, country: verification.country,
          lat: verification.lat, lng: verification.lng, contactNumber: verification.contact_number,
          businessEmail: verification.business_email, ownershipType: verification.ownership_type,
          pan: verification.pan_number, gst: verification.gst_number, reason: verification.reason,
          submittedAt: verification.submitted_at, reviewedAt: verification.reviewed_at
        } : null,
        documents: docs.map((d) => ({ id: d.id, type: d.doc_type, fileName: d.file_name, fileType: d.file_type, fileSize: d.file_size, at: d.created_at }))
      });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/verification/submit' && method === 'POST') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s, { allowPending: true });
      const verification = db.prepare('SELECT * FROM nb_seller_verifications WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(s.user_id);
      if (!verification) fail(404, 'Verification record not found. Complete registration first.');
      if (verification.status === 'approved') fail(409, 'This shop is already approved.');
      const docs = Array.isArray(payload.documents) ? payload.documents.filter((d) => d && d.fileName).slice(0, 10) : [];
      if (!docs.length) fail(400, 'Upload at least one KYC document.');
      transaction(() => {
        db.prepare(`UPDATE nb_seller_verifications SET status='submitted',legal_name=?,business_category=?,shop_type=?,description=?,address=?,pincode=?,city=?,state=?,country=?,lat=?,lng=?,contact_number=?,business_email=?,ownership_type=?,pan_number=?,gst_number=?,submitted_at=?,updated_at=? WHERE id=?`)
          .run(String(payload.legalName || shop.name).trim().slice(0, 120), String(payload.businessCategory || shop.category_slug),
            String(payload.shopType || 'retail').slice(0, 40), String(payload.description || '').slice(0, 2000) || null,
            String(payload.address || shop.address).slice(0, 300), String(payload.pincode || shop.pincode).slice(0, 10),
            String(payload.city || shop.city).slice(0, 60), String(payload.state || 'Delhi').slice(0, 60), String(payload.country || 'India').slice(0, 60),
            Number.isFinite(Number(payload.lat)) ? Number(payload.lat) : shop.lat, Number.isFinite(Number(payload.lng)) ? Number(payload.lng) : shop.lng,
            normalPhone(payload.contactNumber || s.phone) || s.phone, String(payload.businessEmail || s.email).trim().toLowerCase(),
            String(payload.ownershipType || 'sole_proprietorship').slice(0, 60),
            String(payload.pan || '').trim().toUpperCase().slice(0, 20) || null, String(payload.gst || '').trim().toUpperCase().slice(0, 20) || null,
            now(), now(), verification.id);
        for (const d of docs) {
          db.prepare('INSERT INTO nb_seller_documents(id,verification_id,user_id,shop_id,doc_type,file_name,file_type,file_size,storage_ref,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(uid(), verification.id, s.user_id, shop.id, String(d.type || 'other').slice(0, 40), String(d.fileName).slice(0, 200), String(d.fileType || '').slice(0, 80) || null, clampInt(d.fileSize || 0, 0, 10000000), 'metadata-only', now());
        }
      });
      audit('seller', s.user_id, 'kyc_resubmitted', 'verification', verification.id, `${docs.length} document(s)`);
      send(res, 201, { message: 'KYC submitted for review. Selling activates after admin approval.', status: 'submitted' });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/profile' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s, { allowPending: true });
      const codes = sellerCodes(shop, s.user_id);
      const verification = db.prepare('SELECT * FROM nb_seller_verifications WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(s.user_id);
      send(res, 200, {
        shop: {
          ...shopRow(shop), sellerId: codes.sellerId, shopId: codes.shopId,
          verificationStatus: verification?.status || (shop.verified ? 'approved' : 'documents_pending'),
          verificationReason: verification?.reason || null
        }
      });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/profile' && method === 'PATCH') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s, { allowPending: true });
      requireSellerPerm(s, shop, 'manage_settings', 'Editing the shop profile');
      const name = payload.name !== undefined ? String(payload.name).trim() : shop.name;
      if (!str(name, 2, 120)) fail(400, 'Shop name must be 2–120 characters.');
      const categorySlug = payload.category !== undefined ? String(payload.category) : shop.category_slug;
      if (!db.prepare('SELECT 1 FROM nb_categories WHERE slug=?').get(categorySlug)) fail(400, 'Choose a valid category.');
      const pincode = payload.pincode !== undefined ? String(payload.pincode).trim() : shop.pincode;
      if (!pincodeOk(pincode)) fail(400, 'Enter a valid 6-digit PIN code.');
      const lat = payload.lat !== undefined ? Number(payload.lat) : shop.lat;
      const lng = payload.lng !== undefined ? Number(payload.lng) : shop.lng;
      if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) fail(400, 'Enter valid latitude and longitude.');
      const legalChanged = payload.legalName !== undefined && String(payload.legalName).trim() !== (shop.legal_name || shop.name);
      /* The proprietor name is what the Customer Portal prints next to the shop's map
       * pin, so it is editable from the same form as the rest of the public profile. */
      if (payload.ownerName !== undefined) {
        const ownerName = String(payload.ownerName).trim();
        if (ownerName && !str(ownerName, 2, 80)) fail(400, 'Owner name must be 2–80 characters.');
      }
      transaction(() => {
        db.prepare(`UPDATE nb_shops SET name=?,category_slug=?,tagline=?,description=?,about_text=?,address=?,locality=?,city=?,pincode=?,lat=?,lng=?,phone=?,business_email=?,support_contact=?,logo_url=?,cover_url=?,return_policy=?,pickup_instructions=?,delivery_info=?,legal_name=?,ownership_type=?,proprietor_name=? WHERE id=?`)
          .run(name, categorySlug, payload.tagline !== undefined ? String(payload.tagline).slice(0, 160) : shop.tagline,
            payload.description !== undefined ? String(payload.description).slice(0, 2000) : shop.description,
            payload.about !== undefined ? String(payload.about).slice(0, 2000) : shop.about_text,
            payload.address !== undefined ? String(payload.address).slice(0, 300) : shop.address,
            payload.locality !== undefined ? String(payload.locality).slice(0, 80) : shop.locality,
            payload.city !== undefined ? String(payload.city).slice(0, 60) : shop.city,
            pincode, lat, lng,
            /* Keep the stored formatting when the digits are unchanged, so saving an
             * unrelated field does not turn "011-42541798" into "01142541798". */
            payload.phone !== undefined
              ? (normalPhone(payload.phone) === String(shop.phone || '').replace(/\D/g, '') ? shop.phone : normalPhone(payload.phone))
              : shop.phone,
            payload.businessEmail !== undefined ? String(payload.businessEmail).trim().toLowerCase() : shop.business_email,
            payload.supportContact !== undefined ? String(payload.supportContact).slice(0, 120) : shop.support_contact,
            payload.logoUrl !== undefined ? String(payload.logoUrl).slice(0, 300) : shop.logo_url,
            payload.coverUrl !== undefined ? String(payload.coverUrl).slice(0, 300) : shop.cover_url,
            payload.returnPolicy !== undefined ? String(payload.returnPolicy).slice(0, 1000) : shop.return_policy,
            payload.pickupInstructions !== undefined ? String(payload.pickupInstructions).slice(0, 1000) : shop.pickup_instructions,
            payload.deliveryInfo !== undefined ? String(payload.deliveryInfo).slice(0, 1000) : shop.delivery_info,
            payload.legalName !== undefined ? String(payload.legalName).trim().slice(0, 120) : shop.legal_name,
            payload.ownershipType !== undefined ? String(payload.ownershipType).slice(0, 60) : shop.ownership_type,
            payload.ownerName !== undefined ? (String(payload.ownerName).trim().slice(0, 80) || null) : shop.proprietor_name,
            shop.id);
        if (legalChanged) {
          db.prepare("UPDATE nb_seller_verifications SET status='additional_info_required',reason=?,updated_at=? WHERE user_id=? AND status='approved'")
            .run('Legal identity changed — please re-submit KYC for review.', now(), s.user_id);
          db.prepare('UPDATE nb_shops SET verified=0 WHERE id=?').run(shop.id);
        }
      });
      audit('seller', s.user_id, 'profile_updated', 'shop', shop.id, name);
      const updated = db.prepare('SELECT * FROM nb_shops WHERE id=?').get(shop.id);
      send(res, 200, { message: legalChanged ? 'Profile saved. Legal identity changes need re-verification before selling resumes.' : 'Shop profile saved. Public details sync to the Customer Portal.', shop: shopRow(updated) });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/hours' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s, { allowPending: true });
      send(res, 200, { hours: shopHoursPayload(shop), nextOpening: nextOpening(shop) });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/hours' && method === 'PATCH') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s, { allowPending: true });
      requireSellerPerm(s, shop, 'manage_settings', 'Editing business hours');
      const days = Array.isArray(payload.days) ? payload.days : [];
      transaction(() => {
        for (const d of days) {
          const day = clampInt(d.day, 0, 6);
          const open = String(d.open || '09:00').slice(0, 5);
          const close = String(d.close || '21:00').slice(0, 5);
          if (!/^\d{1,2}:\d{2}$/.test(open) || !/^\d{1,2}:\d{2}$/.test(close)) fail(400, 'Opening and closing times must look like 09:00.');
          db.prepare(`INSERT INTO nb_shop_hours(shop_id,day_of_week,open_time,close_time,break_start,break_end,shifts_json,closed,holiday_date,holiday_label)
            VALUES(?,?,?,?,?,?,?,?,NULL,NULL)
            ON CONFLICT(shop_id,day_of_week,holiday_date) DO UPDATE SET open_time=excluded.open_time,close_time=excluded.close_time,break_start=excluded.break_start,break_end=excluded.break_end,shifts_json=excluded.shifts_json,closed=excluded.closed`)
            .run(shop.id, day, open, close, d.breakStart ? String(d.breakStart).slice(0, 5) : null, d.breakEnd ? String(d.breakEnd).slice(0, 5) : null, JSON.stringify(Array.isArray(d.shifts) ? d.shifts.slice(0, 4) : []), d.closed ? 1 : 0);
        }
        if (Array.isArray(payload.holidays)) {
          for (const h of payload.holidays) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(h.date || ''))) fail(400, 'Holiday dates must be YYYY-MM-DD.');
            const dow = new Date(`${h.date}T00:00:00`).getDay();
            db.prepare(`INSERT INTO nb_shop_hours(shop_id,day_of_week,open_time,close_time,closed,holiday_date,holiday_label)
              VALUES(?,?,?,?,1,?,?)
              ON CONFLICT(shop_id,day_of_week,holiday_date) DO UPDATE SET holiday_label=excluded.holiday_label`)
              .run(shop.id, dow, '09:00', '21:00', String(h.date), String(h.label || 'Holiday').slice(0, 80));
          }
        }
        const isOpen = payload.isOpen !== undefined ? (payload.isOpen ? 1 : 0) : shop.is_open;
        const tempUntil = payload.temporaryClosureUntil !== undefined ? (payload.temporaryClosureUntil || null) : shop.temporary_closure_until;
        const holDate = payload.holidayDate !== undefined ? (payload.holidayDate || null) : shop.holiday_date;
        const holLabel = payload.holidayLabel !== undefined ? (payload.holidayLabel || null) : shop.holiday_label;
        const firstDay = days.find((d) => !d.closed) || days[0];
        db.prepare('UPDATE nb_shops SET is_open=?,temporary_closure_until=?,holiday_date=?,holiday_label=?,opens_at=?,closes_at=? WHERE id=?')
          .run(isOpen, tempUntil, holDate, holLabel, firstDay ? String(firstDay.open).slice(0, 5) : shop.opens_at, firstDay ? String(firstDay.close).slice(0, 5) : shop.closes_at, shop.id);
      });
      audit('seller', s.user_id, 'hours_updated', 'shop', shop.id, `open=${payload.isOpen}`);
      const updated = db.prepare('SELECT * FROM nb_shops WHERE id=?').get(shop.id);
      send(res, 200, { message: 'Business hours saved. Existing accepted orders are preserved.', hours: shopHoursPayload(updated), nextOpening: nextOpening(updated) });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/service-areas' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s, { allowPending: true });
      const areas = db.prepare('SELECT * FROM nb_shop_service_areas WHERE shop_id=? ORDER BY pincode').all(shop.id);
      send(res, 200, {
        shop: { radiusKm: shop.radius_km, deliveryFee: shop.delivery_fee_paise, freeDeliveryOver: shop.free_delivery_over_paise, minOrder: shop.min_order_paise, prepMinutes: shop.prep_minutes, deliveryEnabled: Boolean(shop.delivery_enabled), pickupEnabled: Boolean(shop.pickup_enabled), selfDeliveryEnabled: shop.self_delivery_enabled !== 0, runnerEnabled: shop.runner_enabled !== 0, lat: shop.lat, lng: shop.lng, locality: shop.locality, pincode: shop.pincode },
        areas: areas.length ? areas.map((a) => ({ pincode: a.pincode, locality: a.locality, city: a.city, lat: a.lat, lng: a.lng, radiusKm: a.radius_km, active: Boolean(a.active) })) : String(shop.service_pincodes || '').split(',').map((p) => p.trim()).filter(Boolean).map((pincode) => ({ pincode, locality: null, city: null, lat: null, lng: null, radiusKm: shop.radius_km, active: true }))
      });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/service-areas' && method === 'PATCH') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s, { allowPending: true });
      requireSellerPerm(s, shop, 'manage_settings', 'Editing delivery areas');
      const pincodes = Array.isArray(payload.pincodes) ? payload.pincodes.map((p) => String(p).trim()).filter((p) => pincodeOk(p)) : String(payload.pincodes || '').split(',').map((p) => p.trim()).filter((p) => pincodeOk(p));
      if (!pincodes.length) fail(400, 'Add at least one valid 6-digit service PIN code.');
      const radius = payload.radiusKm !== undefined ? round2(Math.min(50, Math.max(0.5, Number(payload.radiusKm) || shop.radius_km))) : shop.radius_km;
      transaction(() => {
        db.prepare(`UPDATE nb_shops SET radius_km=?,service_pincodes=?,delivery_fee_paise=?,free_delivery_over_paise=?,min_order_paise=?,prep_minutes=?,delivery_enabled=?,pickup_enabled=?,self_delivery_enabled=?,runner_enabled=? WHERE id=?`)
          .run(radius, pincodes.join(','), payload.deliveryFee !== undefined ? clampInt(payload.deliveryFee, 0, 200000) : shop.delivery_fee_paise,
            payload.freeDeliveryOver !== undefined ? (payload.freeDeliveryOver == null ? null : clampInt(payload.freeDeliveryOver, 0, 1000000)) : shop.free_delivery_over_paise,
            payload.minOrder !== undefined ? clampInt(payload.minOrder, 0, 1000000) : shop.min_order_paise,
            payload.prepMinutes !== undefined ? clampInt(payload.prepMinutes, 1, 240) : shop.prep_minutes,
            payload.deliveryEnabled !== undefined ? (payload.deliveryEnabled ? 1 : 0) : shop.delivery_enabled,
            payload.pickupEnabled !== undefined ? (payload.pickupEnabled ? 1 : 0) : shop.pickup_enabled,
            payload.selfDeliveryEnabled !== undefined ? (payload.selfDeliveryEnabled ? 1 : 0) : (shop.self_delivery_enabled ?? 1),
            payload.runnerEnabled !== undefined ? (payload.runnerEnabled ? 1 : 0) : (shop.runner_enabled ?? 1),
            shop.id);
        db.prepare('DELETE FROM nb_shop_service_areas WHERE shop_id=?').run(shop.id);
        for (const pin of pincodes) {
          const area = pincodeArea(pin);
          db.prepare('INSERT INTO nb_shop_service_areas(shop_id,pincode,locality,city,lat,lng,radius_km,active) VALUES(?,?,?,?,?,?,?,1)')
            .run(shop.id, pin, area?.locality || null, area?.city || null, area?.lat ?? null, area?.lng ?? null, radius);
        }
      });
      audit('seller', s.user_id, 'service_areas_updated', 'shop', shop.id, `${pincodes.join(',')} · ${radius}km`);
      send(res, 200, { message: 'Delivery area saved. Checkout now only promises delivery inside this area.' });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/inventory' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const products = db.prepare('SELECT * FROM nb_products WHERE shop_id=? AND COALESCE(archived,0)=0 ORDER BY name').all(shop.id);
      const movements = db.prepare('SELECT * FROM nb_inventory_transactions WHERE shop_id=? ORDER BY created_at DESC LIMIT 100').all(shop.id);
      const totalUnits = products.reduce((t, p) => t + Math.max(0, p.stock - p.reserved), 0);
      send(res, 200, {
        summary: {
          totalProducts: products.length,
          totalUnits,
          lowStock: products.filter((p) => p.stock - p.reserved > 0 && p.stock - p.reserved <= p.low_stock).length,
          outStock: products.filter((p) => p.stock - p.reserved <= 0).length
        },
        products: products.map((p) => ({ id: p.id, name: p.name, sku: p.sku, barcode: p.barcode, stock: p.stock, reserved: p.reserved, available: Math.max(0, p.stock - p.reserved), lowAt: p.low_stock, maxStock: p.max_stock, active: Boolean(p.active), unit: p.unit })),
        movements: movements.map((m) => ({ id: m.id, productId: m.product_id, type: m.type, previousQty: m.previous_qty, newQty: m.new_qty, delta: m.delta, reason: m.reason, actor: m.actor_name, at: m.created_at }))
      });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/inventory/adjust' && method === 'POST') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_inventory', 'Adjusting inventory');
      const product = db.prepare('SELECT * FROM nb_products WHERE id=? AND shop_id=?').get(String(payload.productId || ''), shop.id);
      if (!product) fail(404, 'Product not found in your catalogue');
      const action = normaliseInventoryAction(payload.action || 'add');
      const quantity = action === 'set' || action === 'opening' ? clampInt(payload.quantity ?? payload.stock, 0, 1000000) : clampInt(payload.quantity, 1, 1000000);
      if (payload.quantity === undefined && payload.stock === undefined) fail(400, 'Send a quantity.');
      const reason = String(payload.reason || '').trim().slice(0, 300);
      if (!reason) fail(400, 'Give a reason for this stock change — it is written to the audit log.');
      let result;
      transaction(() => { result = applyInventoryChange(shop, product, action, quantity, reason, s); });
      audit('seller', s.user_id, 'inventory_adjusted', 'product', product.id, `${product.name}: ${action} ${quantity} (${reason})`);
      send(res, 200, { message: `Stock updated: ${result.previousQty} → ${result.newQty}.`, ...result });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/scanner/devices' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const devices = db.prepare('SELECT * FROM nb_scanner_devices WHERE shop_id=? ORDER BY created_at DESC').all(shop.id);
      send(res, 200, { devices: devices.map((d) => ({ id: d.id, deviceId: d.device_serial || d.id, name: d.name, type: d.device_type, status: d.status, shopId: shop.id, lastActiveAt: d.last_active_at, createdAt: d.created_at })) });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/scanner/devices' && method === 'POST') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_scanner', 'Registering scanners');
      const name = String(payload.name || '').trim();
      if (!str(name, 2, 80)) fail(400, 'Give the scanner a name.');
      const type = ['usb_keyboard', 'camera_qr', 'qr_camera', 'handheld_api', 'web_api'].includes(payload.type) ? payload.type : 'usb_keyboard';
      const deviceId = String(payload.deviceId || '').trim().slice(0, 80) || null;
      const id = `NB-SCAN-${randomBytes(3).toString('hex').toUpperCase()}`;
      db.prepare('INSERT INTO nb_scanner_devices(id,shop_id,name,device_type,device_serial,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, shop.id, name, type, deviceId, 'registered', now(), now());
      audit('seller', s.user_id, 'scanner_registered', 'scanner', id, `${name} · ${type}`);
      send(res, 201, { message: `Scanner ${name} registered to your shop. Connect it and scan a barcode to identify a product.`, device: { id, name, type, status: 'registered' } });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/scanner/scan' && method === 'POST') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_scanner', 'Using the scanner');
      const code = String(payload.code || '').trim();
      if (!code) fail(400, 'Scan a barcode or QR code first.');
      const eventId = String(payload.eventId || payload.event_id || '').trim() || `EVT-${randomBytes(6).toString('hex')}`;
      const existing = db.prepare('SELECT * FROM nb_scanner_events WHERE event_id=?').get(eventId);
      if (existing) {
        const product = existing.product_id ? db.prepare('SELECT * FROM nb_products WHERE id=?').get(existing.product_id) : null;
        send(res, 200, { duplicate: true, event: { id: existing.id, eventId: existing.event_id, status: existing.status, action: existing.action }, product: product ? { id: product.id, name: product.name, sku: product.sku, barcode: product.barcode, stock: product.stock, available: Math.max(0, product.stock - product.reserved), unit: product.unit } : null, message: 'This scan was already recorded. No duplicate stock change was made.' });
        return true;
      }
      const product = db.prepare('SELECT * FROM nb_products WHERE shop_id=? AND (barcode=? OR sku=? OR id=? OR compare_key=?) LIMIT 1').get(shop.id, code, code, code, code);
      if (!product) fail(404, 'No product in your shop matches this code. Check the barcode or add the product first.');
      const deviceId = payload.deviceId ? String(payload.deviceId) : null;
      if (deviceId) {
        const device = db.prepare('SELECT * FROM nb_scanner_devices WHERE id=? AND shop_id=?').get(deviceId, shop.id);
        if (!device) fail(400, 'Scanner device is not registered to your shop.');
        db.prepare('UPDATE nb_scanner_devices SET last_active_at=?,updated_at=? WHERE id=?').run(now(), now(), deviceId);
      }
      const orderCode = payload.orderCode ? String(payload.orderCode) : null;
      if (orderCode) {
        const so = db.prepare('SELECT * FROM nb_seller_orders WHERE code=? AND shop_id=?').get(orderCode, shop.id);
        if (!so) fail(404, 'Order not found for your shop.');
        const inOrder = db.prepare('SELECT * FROM nb_order_items WHERE seller_order_id=? AND product_id=?').get(so.id, product.id);
        if (!inOrder) fail(400, 'This product is not part of that order.');
      }
      const id = uid();
      db.prepare('INSERT INTO nb_scanner_events(id,event_id,shop_id,device_id,code,product_id,order_code,action,status,actor_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, eventId, shop.id, deviceId, code, product.id, orderCode, String(payload.action || 'add').slice(0, 20), 'pending', s.user_id, now());
      send(res, 201, {
        event: { id, eventId, status: 'pending', action: payload.action || 'add' },
        product: { id: product.id, name: product.name, sku: product.sku, barcode: product.barcode, stock: product.stock, reserved: product.reserved, available: Math.max(0, product.stock - product.reserved), unit: product.unit, price: product.price_paise },
        message: 'Product identified. Confirm the stock action to commit it — scanning alone never changes stock.'
      });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/scanner\/events\/[A-Za-z0-9-]+\/(confirm|reject)$/) && method === 'POST') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_scanner', 'Confirming scans');
      const parts = route.split('/');
      const eventId = decodeURIComponent(parts[4]);
      const verb = parts[5];
      const event = db.prepare('SELECT * FROM nb_scanner_events WHERE event_id=? AND shop_id=?').get(eventId, shop.id);
      if (!event) fail(404, 'Scan event not found.');
      if (event.status === 'confirmed') { send(res, 200, { message: 'This scan was already confirmed. No duplicate change was made.', status: 'confirmed' }); return true; }
      if (verb === 'reject') {
        db.prepare("UPDATE nb_scanner_events SET status='rejected' WHERE id=?").run(event.id);
        send(res, 200, { message: 'Scan discarded. Stock was not changed.', status: 'rejected' });
        return true;
      }
      const product = db.prepare('SELECT * FROM nb_products WHERE id=? AND shop_id=?').get(event.product_id, shop.id);
      if (!product) fail(404, 'Product no longer exists.');
      const action = normaliseInventoryAction(payload.action || event.action || 'add');
      const quantity = clampInt(payload.quantity ?? 1, 1, 100000);
      const orderCode = String(payload.orderCode || event.order_code || '').trim();
      if (action === 'pack' && !orderCode) fail(400, 'Enter the order code this scan should pack for.');
      const reason = String(payload.reason || `Scanner ${action.replace(/_/g, ' ')}`).slice(0, 300);
      transaction(() => {
        if (action === 'pack') {
          const so = db.prepare('SELECT * FROM nb_seller_orders WHERE code=? AND shop_id=?').get(orderCode, shop.id);
          if (!so) fail(404, 'Order not found for your shop.');
          const item = db.prepare('SELECT * FROM nb_order_items WHERE seller_order_id=? AND product_id=?').get(so.id, product.id);
          if (!item) fail(400, 'This product is not part of that order.');
          const packed = Math.min(item.qty, (item.packed_qty || 0) + quantity);
          db.prepare('UPDATE nb_order_items SET packed_qty=?,packed_status=? WHERE id=?').run(packed, packed >= item.qty ? 'packed' : 'packing', item.id);
          db.prepare('UPDATE nb_packing_items SET packed_qty=?,status=?,updated_at=? WHERE seller_order_id=? AND order_item_id=?').run(packed, packed >= item.qty ? 'packed' : 'packing', now(), so.id, item.id);
        } else if (action === 'price_check' || action === 'price') {
          // A price check looks the product up and must never move stock.
        } else {
          applyInventoryChange(shop, product, action, quantity, reason, s);
        }
        db.prepare("UPDATE nb_scanner_events SET status='confirmed',action=?,quantity=?,reason=?,order_code=?,confirmed_at=? WHERE id=?").run(action, quantity, reason, orderCode || event.order_code || null, now(), event.id);
      });
      audit('seller', s.user_id, 'scanner_confirmed', 'scanner_event', event.id, `${product.name}: ${action} ${quantity}`);
      const message = action === 'pack' ? `Item marked packed for order ${orderCode}.`
          : action === 'price_check' || action === 'price' ? `${product.name} is ₹${(Number(product.price_paise) / 100).toFixed(2)}${product.stock != null ? ` · ${product.stock} on the shelf` : ''}. No stock change was made.`
          : `Stock updated for ${product.name}.`;
      send(res, 200, { message, status: 'confirmed' });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/scanner/events' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const rows = db.prepare('SELECT e.*, p.name AS product_name FROM nb_scanner_events e LEFT JOIN nb_products p ON p.id=e.product_id WHERE e.shop_id=? ORDER BY e.created_at DESC LIMIT 50').all(shop.id);
      send(res, 200, { events: rows.map((e) => ({ id: e.id, eventId: e.event_id, code: e.code, product: e.product_name, orderCode: e.order_code, action: e.action, status: e.status, quantity: e.quantity, at: e.created_at })) });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/orders\/[A-Za-z0-9-]+\/packing$/) && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const so = sellerOrderOwned(decodeURIComponent(route.split('/')[3]), shop);
      const summary = packingSummary(so);
      send(res, 200, {
        order: { code: so.code, status: so.status, fulfillment: so.fulfillment, partial: Boolean(so.partial_fulfillment), partialNote: so.partial_note || null },
        summary: { ordered: summary.ordered, packed: summary.packed, missing: summary.missing, complete: summary.complete },
        items: summary.rows.map((r) => ({ id: r.id, orderItemId: r.order_item_id, productId: r.product_id, name: r.name, unit: r.unit, emoji: r.emoji, orderedQty: r.ordered_qty, packedQty: r.packed_qty, missingQty: r.missing_qty, status: r.status, note: r.note }))
      });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/orders\/[A-Za-z0-9-]+\/packing$/) && method === 'POST') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'prepare_orders', 'Packing orders');
      const so = sellerOrderOwned(decodeURIComponent(route.split('/')[3]), shop);
      if (!['accepted', 'preparing', 'ready'].includes(so.status)) fail(409, 'Packing is available once the order is accepted.');
      const itemId = String(payload.itemId || payload.orderItemId || '');
      const row = db.prepare('SELECT * FROM nb_packing_items WHERE seller_order_id=? AND order_item_id=?').get(so.id, itemId);
      if (!row) fail(404, 'Packing item not found. Open the packing checklist first.');
      const packedQty = clampInt(payload.packedQty ?? row.packed_qty, 0, row.ordered_qty);
      // Missing units must be reported explicitly — silent short-packs must never auto-resolve an order.
      const missingQty = payload.missingQty !== undefined ? clampInt(payload.missingQty, 0, row.ordered_qty) : Number(row.missing_qty || 0);
      if (packedQty + missingQty > row.ordered_qty) fail(400, 'Packed plus missing cannot exceed the ordered quantity.');
      const status = payload.status ? String(payload.status).slice(0, 20) : (missingQty > 0 ? 'missing' : packedQty >= row.ordered_qty ? 'packed' : 'packing');
      const note = payload.note !== undefined ? String(payload.note).slice(0, 300) : row.note;
      transaction(() => {
        db.prepare('UPDATE nb_packing_items SET packed_qty=?,missing_qty=?,status=?,note=?,updated_at=? WHERE id=?').run(packedQty, missingQty, status, note, now(), row.id);
        db.prepare('UPDATE nb_order_items SET packed_qty=?,missing_qty=?,packed_status=? WHERE id=?').run(packedQty, missingQty, status, row.order_item_id);
        if (payload.partial !== undefined || payload.partialNote !== undefined) {
          db.prepare('UPDATE nb_seller_orders SET partial_fulfillment=?,partial_note=?,updated_at=? WHERE id=?').run(payload.partial ? 1 : 0, payload.partialNote ? String(payload.partialNote).slice(0, 500) : so.partial_note, now(), so.id);
        }
      });
      audit('seller', s.user_id, 'packing_updated', 'seller_order', so.id, `${so.code}: packed ${packedQty}/${row.ordered_qty}`);
      const summary = packingSummary(so);
      send(res, 200, { message: 'Packing updated.', summary: { ordered: summary.ordered, packed: summary.packed, missing: summary.missing, complete: summary.complete } });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/delivery' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const orders = db.prepare('SELECT * FROM nb_seller_orders WHERE shop_id=? ORDER BY created_at DESC LIMIT 100').all(shop.id);
      const by = (statuses) => orders.filter((o) => statuses.includes(o.status));
      const staff = db.prepare(`SELECT st.id, st.role, u.name, u.phone FROM nb_shop_staff st JOIN nb_users u ON u.id=st.user_id WHERE st.shop_id=? AND st.status='active' AND st.role='delivery_staff' ORDER BY u.name`).all(shop.id);
      send(res, 200, {
        summary: {
          pendingDispatch: by(['ready']).length,
          runnerRequested: by(['runner_requested']).length,
          runnerAssigned: by(['runner_assigned']).length,
          readyForPickup: orders.filter((o) => o.status === 'ready' && o.fulfillment === 'pickup').length,
          selfDelivery: by(['out_for_delivery']).filter((o) => !o.runner_id).length,
          delivered: by(['delivered', 'completed']).length,
          failed: by(['cancelled', 'rejected']).length,
          deliveryCharges: orders.reduce((t, o) => t + o.delivery_fee_paise, 0)
        },
        staff: staff.map((x) => ({ id: x.id, name: x.name, phone: x.phone })),
        orders: orders.map((so) => {
          const assignment = db.prepare('SELECT * FROM nb_delivery_assignments WHERE seller_order_id=? ORDER BY created_at DESC LIMIT 1').get(so.id);
          const runner = so.runner_id ? db.prepare('SELECT name FROM nb_users WHERE id=?').get(so.runner_id) : null;
          return { code: so.code, parentCode: db.prepare('SELECT code FROM nb_orders WHERE id=?').get(so.order_id)?.code, status: so.status, fulfillment: so.fulfillment, total: so.total_paise, createdAt: so.created_at, runner: runner?.name || null, assignmentStatus: assignment?.status || null, deliveryStaff: so.delivery_staff_name || null, weightGrams: so.weight_grams, packages: so.packages_count || 1, runnerCharges: so.runner_charges_paise, handoverConfirmedAt: so.handover_confirmed_at };
        })
      });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/analytics' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'view_analytics', 'Viewing analytics');
      const range = String(q.get('range') || '30d');
      const nowDate = new Date();
      const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
      let from = new Date(nowDate.getTime() - 29 * 864e5);
      let to = nowDate;
      if (range === 'today') { from = startOfDay(nowDate); to = endOfDay(nowDate); }
      else if (range === 'yesterday') { const y = new Date(nowDate.getTime() - 864e5); from = startOfDay(y); to = endOfDay(y); }
      else if (range === '7d') { from = startOfDay(new Date(nowDate.getTime() - 6 * 864e5)); to = endOfDay(nowDate); }
      else if (range === '30d') { from = startOfDay(new Date(nowDate.getTime() - 29 * 864e5)); to = endOfDay(nowDate); }
      else if (range === '90d') { from = startOfDay(new Date(nowDate.getTime() - 89 * 864e5)); to = endOfDay(nowDate); }
      else if (range === 'month') { from = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1); to = endOfDay(nowDate); }
      else if (range === 'last_month') { from = new Date(nowDate.getFullYear(), nowDate.getMonth() - 1, 1); to = endOfDay(new Date(nowDate.getFullYear(), nowDate.getMonth(), 0)); }
      else if (range === 'year') { from = startOfDay(new Date(nowDate.getTime() - 364 * 864e5)); to = endOfDay(nowDate); }
      else if (range === 'this_year') { from = new Date(nowDate.getFullYear(), 0, 1); to = endOfDay(nowDate); }
      else if (range === 'last_year') { from = new Date(nowDate.getFullYear() - 1, 0, 1); to = endOfDay(new Date(nowDate.getFullYear() - 1, 11, 31)); }
      else if (range === 'custom' && q.get('from') && q.get('to')) {
        const cf = new Date(q.get('from')); const ct = new Date(q.get('to'));
        if (Number.isNaN(cf.getTime()) || Number.isNaN(ct.getTime())) fail(400, 'Send a valid custom from/to date pair.');
        from = startOfDay(cf); to = endOfDay(ct.getTime() < cf.getTime() ? cf : ct);
      }
      if (to.getTime() - from.getTime() > 731 * 864e5) fail(400, 'Analytics ranges are capped at two years.');
      const fromIso = from.toISOString();
      const toIso = to.toISOString();
      const rows = db.prepare('SELECT so.*, o.customer_id, o.is_demo FROM nb_seller_orders so JOIN nb_orders o ON o.id=so.order_id WHERE so.shop_id=? AND so.created_at>=? AND so.created_at<=? ORDER BY so.created_at').all(shop.id, fromIso, toIso);
      const valid = rows.filter((o) => !['cancelled', 'rejected'].includes(o.status));
      const completed = rows.filter((o) => ['delivered', 'completed'].includes(o.status));
      const gross = valid.reduce((t, o) => t + o.total_paise, 0);
      const refundTotal = completedRefundTotalForShop(shop.id, { fromIso, toIso });
      const discounts = valid.reduce((t, o) => t + o.discount_paise, 0);
      const deliveryCharges = valid.reduce((t, o) => t + o.delivery_fee_paise, 0);
      const tax = valid.reduce((t, o) => t + o.tax_paise, 0);
      const seriesMap = new Map();
      for (const o of valid) {
        const day = o.created_at.slice(0, 10);
        const cur = seriesMap.get(day) || { date: day, sales: 0, orders: 0 };
        cur.sales += o.total_paise; cur.orders += 1;
        seriesMap.set(day, cur);
      }
      // Every calendar day in the range is represented; a zero day is real data, not an invention.
      const series = [];
      for (let d = startOfDay(from); d.getTime() <= to.getTime() && series.length < 731; d = new Date(d.getTime() + 864e5)) {
        const key = d.toISOString().slice(0, 10);
        const cur = seriesMap.get(key);
        series.push(cur ? { date: key, sales: cur.sales, orders: cur.orders } : { date: key, sales: 0, orders: 0 });
      }
      const productRows = db.prepare(`SELECT oi.product_id, oi.name, SUM(oi.qty) AS qty, SUM(oi.line_total_paise) AS revenue FROM nb_order_items oi JOIN nb_seller_orders so ON so.id=oi.seller_order_id WHERE so.shop_id=? AND so.created_at>=? AND so.created_at<=? AND so.status NOT IN ('cancelled','rejected') GROUP BY oi.product_id, oi.name ORDER BY revenue DESC`).all(shop.id, fromIso, toIso);
      const categoryRows = db.prepare(`SELECT p.category_slug, SUM(oi.line_total_paise) AS revenue, SUM(oi.qty) AS qty FROM nb_order_items oi JOIN nb_seller_orders so ON so.id=oi.seller_order_id JOIN nb_products p ON p.id=oi.product_id WHERE so.shop_id=? AND so.created_at>=? AND so.created_at<=? AND so.status NOT IN ('cancelled','rejected') GROUP BY p.category_slug ORDER BY revenue DESC`).all(shop.id, fromIso, toIso);
      const customers = new Map();
      for (const o of valid) {
        const c = customers.get(o.customer_id) || { id: o.customer_id, orders: 0, spent: 0 };
        c.orders += 1; c.spent += o.total_paise;
        customers.set(o.customer_id, c);
      }
      const repeat = [...customers.values()].filter((c) => c.orders > 1).length;
      const isDemo = rows.some((o) => o.is_demo);
      const couponOrders = valid.filter((o) => Number(o.discount_paise || 0) > 0).length;
      const unitsSold = productRows.reduce((n, r) => n + Number(r.qty || 0), 0);
      send(res, 200, {
        range, from: fromIso, to: toIso, isDemo,
        metrics: {
          grossSales: gross, netSales: Math.max(0, gross - refundTotal), orderCount: valid.length,
          completedOrders: completed.length, cancelledOrders: rows.filter((o) => o.status === 'cancelled').length,
          rejectedOrders: rows.filter((o) => o.status === 'rejected').length, refunds: refundTotal,
          discounts, couponOrders, deliveryCharges, tax, unitsSold,
          averageOrderValue: valid.length ? Math.round(gross / valid.length) : 0
        },
        series,
        products: productRows.map((p) => ({ id: p.product_id, name: p.name, qty: Number(p.qty), revenue: Number(p.revenue) })),
        bestSellers: productRows.slice(0, 5).map((p) => ({ name: p.name, qty: Number(p.qty), revenue: Number(p.revenue) })),
        leastSellers: [...productRows].sort((a, b) => a.revenue - b.revenue).slice(0, 5).map((p) => ({ name: p.name, qty: Number(p.qty), revenue: Number(p.revenue) })),
        categories: categoryRows.map((c) => ({ slug: c.category_slug, revenue: Number(c.revenue), qty: Number(c.qty) })),
        customers: { total: customers.size, repeat, repeatRate: customers.size ? Math.round((repeat / customers.size) * 100) : 0 }
      });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/revenue' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'view_revenue', 'Viewing revenue');
      const commissionRate = Number(shop.commission_rate || 0);
      const allPayments = sellerPaymentRowsForShop(shop.id);
      const byStatus = (st) => allPayments.filter((p) => p.status === st).reduce((t, p) => t + p.allocated_paise, 0);
      const cod = allPayments.filter((p) => p.method === 'cod' && !['cancelled', 'superseded', 'failed'].includes(p.status)).reduce((t, p) => t + p.allocated_paise, 0);
      const payAtStore = allPayments.filter((p) => p.method === 'pay_at_store' && !['cancelled', 'superseded', 'failed'].includes(p.status)).reduce((t, p) => t + p.allocated_paise, 0);
      const refundTotal = completedRefundTotalForShop(shop.id);
      const paidPayments = allPayments.filter((p) => p.status === 'paid');
      const grossCollected = paidPayments.reduce((t, p) => t + p.allocated_paise, 0);
      const commission = paidPayments.reduce((t, p) => t + Math.round(p.allocated_paise * commissionRate / 100), 0);
      send(res, 200, {
        dashboard: {
          successful: grossCollected,
          pending: byStatus('pending') + byStatus('created'),
          failed: byStatus('failed'),
          cod,
          payAtStore,
          refunds: refundTotal,
          commission,
          commissionRate,
          payableBalance: Math.max(0, grossCollected - commission - refundTotal)
        },
        transactions: allPayments.slice(0, 200).map((p) => {
          const isVoid = ['failed', 'cancelled', 'superseded'].includes(p.status);
          const gross = p.allocated_paise;
          const refund = p.status === 'paid' ? completedRefundTotalForSellerOrder(p.seller_order_id) : 0;
          const comm = isVoid ? 0 : Math.round(gross * commissionRate / 100);
          const settlement = db.prepare('SELECT st.status FROM nb_settlement_items si JOIN nb_settlements st ON st.id=si.settlement_id WHERE si.seller_order_id=? LIMIT 1').get(p.seller_order_id);
          return {
            id: p.id, orderCode: p.order_code, sellerOrderCode: p.seller_code, method: p.method, provider: p.provider,
            gross, discount: p.seller_discount_paise || 0, refund, commission: comm,
            netPayable: isVoid ? 0 : Math.max(0, gross - comm - refund),
            paymentStatus: p.status, settlementStatus: settlement?.status || 'not_settled',
            reference: p.reference, at: p.created_at
          };
        })
      });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/settlements' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'view_revenue', 'Viewing settlements');
      const rows = db.prepare('SELECT * FROM nb_settlements WHERE shop_id=? ORDER BY created_at DESC').all(shop.id);
      const sum = (st) => rows.filter((r) => r.status === st).reduce((t, r) => t + r.net_paise, 0);
      send(res, 200, {
        summary: { totalEarnings: rows.reduce((t, r) => t + r.net_paise, 0), pending: sum('pending'), processing: sum('processing'), settled: sum('completed'), failed: sum('failed'), onHold: sum('on_hold'), refundDeductions: rows.reduce((t, r) => t + r.refunds_paise, 0) },
        settlements: rows.map((r) => ({ id: r.id, code: r.code, periodStart: r.period_start, periodEnd: r.period_end, gross: r.gross_paise, refunds: r.refunds_paise, commission: r.commission_paise, adjustments: r.adjustments_paise, net: r.net_paise, status: r.status, bankReference: r.bank_reference, payoutDate: r.payout_date, createdAt: r.created_at }))
      });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/settlements/generate' && method === 'POST') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_settlements', 'Generating settlements');
      const periodStart = String(payload.periodStart || '').slice(0, 10);
      const periodEnd = String(payload.periodEnd || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) || periodStart > periodEnd) fail(400, 'Choose a valid settlement period.');
      const commissionRate = Number(shop.commission_rate || 0);
      const id = uid();
      const code = `STL-${String(Math.floor(100000 + Math.random() * 900000))}`;
      let orderCount = 0;
      transaction(() => {
        const orders = db.prepare(`SELECT so.* FROM nb_seller_orders so WHERE so.shop_id=? AND so.status IN ('delivered','completed') AND date(so.created_at)>=? AND date(so.created_at)<=?
          AND so.id NOT IN (SELECT seller_order_id FROM nb_settlement_items) ORDER BY so.created_at`).all(shop.id, periodStart, periodEnd);
        if (!orders.length) fail(409, 'No unsettled completed orders in this period.');
        orderCount = orders.length;
        let gross = 0, refunds = 0, commission = 0;
        const lines = [];
        for (const so of orders) {
          const r = completedRefundTotalForSellerOrder(so.id);
          const c = Math.round(so.total_paise * commissionRate / 100);
          gross += so.total_paise; refunds += r; commission += c;
          lines.push([uid(), id, so.id, so.total_paise, r, c, Math.max(0, so.total_paise - r - c)]);
        }
        const ts = now();
        // Parent settlement first — settlement items carry a foreign key to it.
        db.prepare('INSERT INTO nb_settlements(id,code,shop_id,period_start,period_end,gross_paise,refunds_paise,commission_paise,adjustments_paise,net_paise,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, code, shop.id, periodStart, periodEnd, gross, refunds, commission, 0, Math.max(0, gross - refunds - commission), 'pending', ts, ts);
        for (const line of lines) {
          db.prepare('INSERT INTO nb_settlement_items(id,settlement_id,seller_order_id,gross_paise,refund_paise,commission_paise,net_paise) VALUES(?,?,?,?,?,?,?)').run(...line);
        }
      });
      audit('seller', s.user_id, 'settlement_generated', 'settlement', id, `${code} · ${orderCount} order(s)`);
      send(res, 201, { message: `Settlement ${code} created as pending. It becomes settled only after the payout is confirmed.`, code, status: 'pending' });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/settlements\/[A-Za-z0-9-]+$/) && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const row = db.prepare('SELECT * FROM nb_settlements WHERE code=? AND shop_id=?').get(decodeURIComponent(route.split('/')[3]), shop.id);
      if (!row) fail(404, 'Settlement not found.');
      const items = db.prepare('SELECT si.*, so.code AS order_code, so.created_at AS order_created_at FROM nb_settlement_items si JOIN nb_seller_orders so ON so.id=si.seller_order_id WHERE si.settlement_id=? ORDER BY so.created_at').all(row.id);
      send(res, 200, { settlement: { id: row.id, code: row.code, periodStart: row.period_start, periodEnd: row.period_end, gross: row.gross_paise, refunds: row.refunds_paise, commission: row.commission_paise, adjustments: row.adjustments_paise, net: row.net_paise, status: row.status, bankReference: row.bank_reference, payoutDate: row.payout_date }, items: items.map((i) => ({ orderCode: i.order_code, sellerOrderId: i.seller_order_id, createdAt: i.order_created_at, gross: i.gross_paise, refund: i.refund_paise, commission: i.commission_paise, net: i.net_paise })) });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/settlements\/[A-Za-z0-9-]+\/statement\.csv$/) && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const row = db.prepare('SELECT * FROM nb_settlements WHERE code=? AND shop_id=?').get(decodeURIComponent(route.split('/')[3]), shop.id);
      if (!row) fail(404, 'Settlement not found.');
      const items = db.prepare('SELECT si.*, so.code AS order_code FROM nb_settlement_items si JOIN nb_seller_orders so ON so.id=si.seller_order_id WHERE si.settlement_id=? ORDER BY so.created_at').all(row.id);
      sendCsv(res, `settlement-${row.code}.csv`, [
        ['NearBuy Seller Settlement Statement', row.code, shop.name, `Period ${row.period_start} to ${row.period_end}`, `Status ${row.status}`],
        ['Order', 'Gross (₹)', 'Refund (₹)', 'Commission (₹)', 'Net (₹)'],
        ...items.map((i) => [i.order_code, (i.gross_paise / 100).toFixed(2), (i.refund_paise / 100).toFixed(2), (i.commission_paise / 100).toFixed(2), (i.net_paise / 100).toFixed(2)]),
        ['Total', (row.gross_paise / 100).toFixed(2), (row.refunds_paise / 100).toFixed(2), (row.commission_paise / 100).toFixed(2), (row.net_paise / 100).toFixed(2)]
      ]);
      return true;
    }

    if (base === '/api/partner' && route === '/seller/promotions' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const rows = db.prepare('SELECT * FROM nb_coupons WHERE shop_id=? ORDER BY ends_at DESC').all(shop.id);
      send(res, 200, { promotions: rows.map((c) => ({ code: c.code, title: c.title, description: c.description, type: c.type, promoType: c.promo_type || c.type, value: c.value, minOrder: c.min_order_paise, maxDiscount: c.max_discount_paise, productIds: parseJsonArray(c.product_ids), categorySlugs: parseJsonArray(c.category_slugs), buyQty: c.buy_qty, getQty: c.get_qty, eligibility: c.eligibility, startsAt: c.starts_at, endsAt: c.ends_at, usageLimit: c.usage_limit, usedCount: c.used_count, perCustomerLimit: c.per_customer_limit, active: Boolean(c.active) })) });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/promotions' && method === 'POST') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_promotions', 'Creating promotions');
      const code = String(payload.code || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
      if (!/^[A-Z0-9-]{3,20}$/.test(code)) fail(400, 'Coupon code must be 3–20 letters, numbers or dashes.');
      if (db.prepare('SELECT code FROM nb_coupons WHERE code=?').get(code)) fail(409, 'That coupon code already exists.');
      const promoType = ['percentage', 'fixed', 'product', 'category', 'bogo', 'bulk', 'seasonal', 'limited_time', 'min_order'].includes(payload.promoType) ? payload.promoType : 'percentage';
      // nb_coupons.type is constrained to percent/fixed/free_delivery; a BOGO deal is carried by promo_type + buy_qty/get_qty.
      const isBogo = promoType === 'bogo';
      const type = isBogo ? 'percent' : (payload.type === 'fixed' || promoType === 'fixed' ? 'fixed' : payload.type === 'free_delivery' ? 'free_delivery' : 'percent');
      const value = isBogo ? 0 : clampInt(payload.value, 0, 1000000);
      if (!isBogo && type === 'percent' && (value < 1 || value > 90)) fail(400, 'Percentage discount must be 1–90.');
      if (!isBogo && type === 'fixed' && value < 100) fail(400, 'Fixed discount must be at least ₹1.');
      if (isBogo && (clampInt(payload.buyQty ?? 1, 1, 100) < 1 || clampInt(payload.getQty ?? 1, 1, 100) < 1)) fail(400, 'Buy One Get One needs buy and get quantities of at least 1.');
      const startsAt = payload.startsAt ? new Date(payload.startsAt).toISOString() : now();
      const endsAt = payload.endsAt ? new Date(payload.endsAt).toISOString() : new Date(Date.now() + 30 * 864e5).toISOString();
      if (Number.isNaN(new Date(startsAt).getTime()) || Number.isNaN(new Date(endsAt).getTime()) || endsAt <= startsAt) fail(400, 'Choose a valid start and end date.');
      const productIds = Array.isArray(payload.productIds) ? payload.productIds.filter((id) => db.prepare('SELECT id FROM nb_products WHERE id=? AND shop_id=?').get(String(id), shop.id)).map(String) : [];
      const categorySlugs = Array.isArray(payload.categorySlugs) ? payload.categorySlugs.filter((slug) => db.prepare('SELECT slug FROM nb_categories WHERE slug=?').get(String(slug))).map(String) : [];
      if ((promoType === 'product' || promoType === 'bogo') && !productIds.length && !categorySlugs.length) fail(400, 'Select eligible products or categories for this offer.');
      db.prepare(`INSERT INTO nb_coupons(code,title,description,type,value,min_order_paise,max_discount_paise,shop_id,starts_at,ends_at,usage_limit,used_count,per_customer_limit,active,promo_type,product_ids,category_slugs,buy_qty,get_qty,eligibility)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)`).run(
        code, String(payload.title || code).trim().slice(0, 120), String(payload.description || '').slice(0, 500) || null, type, value,
        clampInt(payload.minOrder ?? 0, 0, 1000000), payload.maxDiscount != null ? clampInt(payload.maxDiscount, 0, 1000000) : null,
        shop.id, startsAt, endsAt, payload.usageLimit != null ? clampInt(payload.usageLimit, 1, 1000000) : null,
        clampInt(payload.perCustomerLimit ?? 1, 1, 100), payload.active === false ? 0 : 1, promoType,
        productIds.length ? JSON.stringify(productIds) : null, categorySlugs.length ? JSON.stringify(categorySlugs) : null,
        payload.buyQty != null ? clampInt(payload.buyQty, 1, 100) : null, payload.getQty != null ? clampInt(payload.getQty, 1, 100) : null,
        String(payload.eligibility || 'all_customers').slice(0, 40)
      );
      audit('seller', s.user_id, 'promotion_created', 'coupon', code, `${promoType} · ${value}`);
      send(res, 201, { message: `Offer ${code} created for your shop only. It is validated at checkout.`, code });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/promotions\/[A-Za-z0-9-]+$/) && method === 'PATCH') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_promotions', 'Editing promotions');
      const code = decodeURIComponent(route.split('/')[3]).toUpperCase();
      const coupon = db.prepare('SELECT * FROM nb_coupons WHERE code=? AND shop_id=?').get(code, shop.id);
      if (!coupon) fail(404, 'Promotion not found for your shop.');
      db.prepare('UPDATE nb_coupons SET active=?,ends_at=?,usage_limit=? WHERE code=?').run(
        payload.active !== undefined ? (payload.active ? 1 : 0) : coupon.active,
        payload.endsAt ? new Date(payload.endsAt).toISOString() : coupon.ends_at,
        payload.usageLimit !== undefined ? (payload.usageLimit == null ? null : clampInt(payload.usageLimit, 1, 1000000)) : coupon.usage_limit,
        code
      );
      audit('seller', s.user_id, 'promotion_updated', 'coupon', code, `active=${payload.active}`);
      send(res, 200, { message: `Offer ${code} updated.` });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/promotions\/[A-Za-z0-9-]+$/) && method === 'DELETE') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_promotions', 'Deleting promotions');
      const code = decodeURIComponent(route.split('/')[3]).toUpperCase();
      const coupon = db.prepare('SELECT * FROM nb_coupons WHERE code=? AND shop_id=?').get(code, shop.id);
      if (!coupon) fail(404, 'Promotion not found for your shop.');
      // Redeemed offers stay in the ledger so past orders keep explaining their discount.
      if (Number(coupon.used_count || 0) > 0) {
        db.prepare('UPDATE nb_coupons SET active=0,ends_at=? WHERE code=?').run(coupon.ends_at || now(), code);
        audit('seller', s.user_id, 'promotion_retired', 'coupon', code, `${coupon.used_count} redemption(s) kept on record`);
        send(res, 200, { message: `Offer ${code} was used ${coupon.used_count} time(s), so it has been retired instead of deleted. Past orders keep their discount record.` });
        return true;
      }
      db.prepare('DELETE FROM nb_coupons WHERE code=? AND shop_id=?').run(code, shop.id);
      audit('seller', s.user_id, 'promotion_deleted', 'coupon', code, coupon.title || code);
      send(res, 200, { message: `Offer ${code} deleted.` });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/staff' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_staff', 'Viewing staff');
      const rows = db.prepare(`SELECT st.*, u.name, u.email, u.phone, u.status AS user_status FROM nb_shop_staff st JOIN nb_users u ON u.id=st.user_id WHERE st.shop_id=? ORDER BY u.name`).all(shop.id);
      send(res, 200, {
        roles: Object.keys(STAFF_ROLE_PERMS).filter((r) => r !== 'owner').map((r) => ({ id: r, label: r.replace(/_/g, ' '), permissions: STAFF_ROLE_PERMS[r] })),
        allPermissions: [...new Set(Object.values(STAFF_ROLE_PERMS).flat())],
        staff: rows.map((r) => { let perms = null; try { perms = JSON.parse(r.permissions_json ?? 'null'); } catch { perms = null; } return { id: r.id, userId: r.user_id, name: r.name, email: r.email, phone: r.phone, role: r.role, permissions: Array.isArray(perms) ? perms : (STAFF_ROLE_PERMS[r.role] || []), status: r.status, userStatus: r.user_status, createdAt: r.created_at }; })
      });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/staff' && method === 'POST') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_staff', 'Adding staff');
      const name = String(payload.name || '').trim();
      const email = String(payload.email || '').trim().toLowerCase();
      const phone = normalPhone(payload.phone);
      const role = String(payload.role || 'sales_staff');
      if (!str(name, 2, 80)) fail(400, 'Enter the staff member’s name.');
      if (!emailOk(email)) fail(400, 'Enter a valid email address.');
      if (!phoneOk(phone)) fail(400, 'Enter a valid 10-digit mobile number.');
      if (typeof payload.password !== 'string' || payload.password.length < 8) fail(400, 'Staff password must be at least 8 characters.');
      if (!STAFF_ROLE_PERMS[role] || role === 'owner') fail(400, 'Choose a staff role. Owner rights cannot be granted here.');
      if (db.prepare('SELECT id FROM nb_users WHERE email=?').get(email)) fail(409, 'An account with this email already exists.');
      const perms = Array.isArray(payload.permissions) ? payload.permissions.filter((p) => STAFF_ROLE_PERMS.owner.includes(p)) : STAFF_ROLE_PERMS[role];
      const userId = uid();
      transaction(() => {
        db.prepare(`INSERT INTO nb_users(id,role,name,email,phone,password_hash,email_verified,phone_verified,avatar,status,is_demo,created_at) VALUES(?,?,?,?,?,?,1,1,'🧑‍💼','active',0,?)`)
          .run(userId, 'seller', name, email, phone, makePassword(payload.password), now());
        db.prepare('INSERT INTO nb_shop_staff(id,shop_id,user_id,role,permissions_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(uid(), shop.id, userId, role, JSON.stringify(perms), 'active', now(), now());
      });
      audit('seller', s.user_id, 'staff_created', 'staff', userId, `${name} · ${role}`);
      send(res, 201, { message: `${name} added as ${role.replace(/_/g, ' ')}. They never receive owner admin rights automatically.` });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/staff\/[A-Za-z0-9-]+$/) && method === 'PATCH') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_staff', 'Editing staff');
      const row = db.prepare('SELECT * FROM nb_shop_staff WHERE id=? AND shop_id=?').get(decodeURIComponent(route.split('/')[3]), shop.id);
      if (!row) fail(404, 'Staff member not found.');
      const role = payload.role !== undefined ? String(payload.role) : row.role;
      if (!STAFF_ROLE_PERMS[role] || role === 'owner') fail(400, 'Choose a staff role.');
      if (payload.permissions !== undefined && !Array.isArray(payload.permissions)) fail(400, 'Permissions must be a list.');
      const perms = Array.isArray(payload.permissions) ? payload.permissions.filter((p) => STAFF_ROLE_PERMS.owner.includes(p)) : null;
      const status = payload.status !== undefined ? (payload.status === 'suspended' ? 'suspended' : 'active') : row.status;
      transaction(() => {
        db.prepare('UPDATE nb_shop_staff SET role=?,permissions_json=?,status=?,updated_at=? WHERE id=?').run(role, perms ? JSON.stringify(perms) : row.permissions_json, status, now(), row.id);
        db.prepare('UPDATE nb_users SET status=? WHERE id=?').run(status === 'suspended' ? 'suspended' : 'active', row.user_id);
        if (status === 'suspended') db.prepare('DELETE FROM nb_sessions WHERE user_id=?').run(row.user_id);
      });
      audit('seller', s.user_id, 'staff_updated', 'staff', row.id, `${role} · ${status}`);
      send(res, 200, { message: 'Staff updated.' });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/staff\/[A-Za-z0-9-]+$/) && method === 'DELETE') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_staff', 'Removing staff');
      const row = db.prepare('SELECT st.*, u.name, u.email FROM nb_shop_staff st JOIN nb_users u ON u.id=st.user_id WHERE st.id=? AND st.shop_id=?').get(decodeURIComponent(route.split('/')[3]), shop.id);
      if (!row) fail(404, 'Staff member not found.');
      if (row.user_id === s.user_id) fail(400, 'You cannot remove your own owner account here.');
      transaction(() => {
        // The user row stays so past orders, stock movements and audit entries keep their name.
        db.prepare('DELETE FROM nb_shop_staff WHERE id=?').run(row.id);
        db.prepare('DELETE FROM nb_sessions WHERE user_id=?').run(row.user_id);
        db.prepare("UPDATE nb_users SET status='inactive' WHERE id=?").run(row.user_id);
      });
      audit('seller', s.user_id, 'staff_removed', 'staff', row.user_id, `${row.name} · ${row.email}`);
      send(res, 200, { message: `${row.name} no longer has access to your Seller Hub. Their history on past orders is preserved.` });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/staff/activity' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_staff', 'Viewing staff activity');
      const ids = [shop.owner_user_id, ...db.prepare('SELECT user_id FROM nb_shop_staff WHERE shop_id=?').all(shop.id).map((r) => r.user_id)].filter(Boolean);
      const rows = ids.length ? db.prepare(`SELECT * FROM nb_audit_logs WHERE actor_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 100`).all(...ids) : [];
      send(res, 200, { activity: rows.map((r) => ({ action: r.action, entity: r.entity, detail: r.detail, at: r.created_at })) });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/notifications' && method === 'GET') {
      const s = requirePartner(['seller']);
      sellerShopContext(s, { allowPending: true });
      const rows = db.prepare('SELECT * FROM nb_notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(s.user_id);
      send(res, 200, { unread: rows.filter((r) => !r.is_read).length, notifications: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, type: r.type, link: r.link, read: Boolean(r.is_read), at: r.created_at })) });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/notifications/read' && method === 'POST') {
      const s = requirePartner(['seller']);
      if (payload.all === true) db.prepare('UPDATE nb_notifications SET is_read=1 WHERE user_id=?').run(s.user_id);
      else if (payload.id) db.prepare('UPDATE nb_notifications SET is_read=1 WHERE id=? AND user_id=?').run(payload.id, s.user_id);
      else fail(400, 'Send a notification id or all: true.');
      send(res, 200, { message: 'Marked as read.' });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/notifications/preferences' && method === 'GET') {
      const s = requirePartner(['seller']);
      let prefs = db.prepare('SELECT * FROM nb_seller_notification_prefs WHERE user_id=?').get(s.user_id);
      if (!prefs) { db.prepare('INSERT INTO nb_seller_notification_prefs(user_id,updated_at) VALUES(?,?)').run(s.user_id, now()); prefs = db.prepare('SELECT * FROM nb_seller_notification_prefs WHERE user_id=?').get(s.user_id); }
      send(res, 200, { preferences: { inApp: Boolean(prefs.in_app), email: Boolean(prefs.email), sms: Boolean(prefs.sms), whatsapp: Boolean(prefs.whatsapp), orderAlerts: Boolean(prefs.order_alerts), stockAlerts: Boolean(prefs.stock_alerts), paymentAlerts: Boolean(prefs.payment_alerts), runnerAlerts: Boolean(prefs.runner_alerts), marketing: Boolean(prefs.marketing) }, providers: { email: false, sms: false, whatsapp: false, note: 'In-app notifications are live database records. Email, SMS and WhatsApp providers are not configured on this deployment, so those channels are stored as preferences only.' } });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/notifications/preferences' && method === 'PATCH') {
      const s = requirePartner(['seller']);
      const b = (v, d) => v === undefined ? d : (v ? 1 : 0);
      const cur = db.prepare('SELECT * FROM nb_seller_notification_prefs WHERE user_id=?').get(s.user_id);
      if (!cur) db.prepare('INSERT INTO nb_seller_notification_prefs(user_id,updated_at) VALUES(?,?)').run(s.user_id, now());
      db.prepare('UPDATE nb_seller_notification_prefs SET in_app=?,email=?,sms=?,whatsapp=?,order_alerts=?,stock_alerts=?,payment_alerts=?,runner_alerts=?,marketing=?,updated_at=? WHERE user_id=?')
        .run(b(payload.inApp, 1), b(payload.email, 0), b(payload.sms, 0), b(payload.whatsapp, 0), b(payload.orderAlerts, 1), b(payload.stockAlerts, 1), b(payload.paymentAlerts, 1), b(payload.runnerAlerts, 1), b(payload.marketing, 0), now(), s.user_id);
      send(res, 200, { message: 'Notification preferences saved.' });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/customers' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'view_customers', 'Viewing customers');
      const rows = db.prepare(`SELECT u.id, u.name, u.phone, COUNT(DISTINCT so.id) AS orders, COALESCE(SUM(so.total_paise),0) AS spent, MAX(so.created_at) AS last_order
        FROM nb_seller_orders so JOIN nb_orders o ON o.id=so.order_id JOIN nb_users u ON u.id=o.customer_id
        WHERE so.shop_id=? GROUP BY u.id ORDER BY spent DESC LIMIT 100`).all(shop.id);
      send(res, 200, { customers: rows.map((r) => ({ id: r.id, name: r.name, phoneMasked: maskedPhone(r.phone), orders: Number(r.orders), spent: Number(r.spent), lastOrder: r.last_order })) });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/reviews' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const rows = db.prepare(`SELECT r.*, u.name AS customer_name, p.name AS product_name FROM nb_reviews r JOIN nb_users u ON u.id=r.customer_id LEFT JOIN nb_products p ON p.id=r.product_id WHERE r.shop_id=? ORDER BY r.created_at DESC LIMIT 100`).all(shop.id);
      send(res, 200, { reviews: rows.map((r) => ({ id: r.id, customer: r.customer_name, product: r.product_name, shopRating: r.shop_rating, productRating: r.product_rating, title: r.title, body: r.body, verified: Boolean(r.verified_purchase), status: r.status, sellerReply: r.seller_reply, sellerReplyAt: r.seller_reply_at, reported: Boolean(r.reported_at), at: r.created_at })) });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/reviews\/[A-Za-z0-9-]+\/(reply|report)$/) && method === 'POST') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const parts = route.split('/');
      const review = db.prepare('SELECT * FROM nb_reviews WHERE id=? AND shop_id=?').get(decodeURIComponent(parts[3]), shop.id);
      if (!review) fail(404, 'Review not found for your shop.');
      if (parts[4] === 'reply') {
        if (!str(payload.reply, 2, 1000)) fail(400, 'Write a reply of at least 2 characters.');
        db.prepare('UPDATE nb_reviews SET seller_reply=?,seller_reply_at=? WHERE id=?').run(payload.reply.trim(), now(), review.id);
        audit('seller', s.user_id, 'review_replied', 'review', review.id, payload.reply.trim().slice(0, 200));
        send(res, 200, { message: 'Reply published on the review.' });
      } else {
        const reason = String(payload.reason || '').trim().slice(0, 300);
        db.prepare('UPDATE nb_reviews SET reported_at=?,reported_reason=? WHERE id=?').run(now(), reason || null, review.id);
        audit('seller', s.user_id, 'review_reported', 'review', review.id, reason);
        send(res, 200, { message: 'Review sent to moderation. It stays visible until a moderator decides.' });
      }
      return true;
    }

    if (base === '/api/partner' && route === '/seller/reports' && method === 'GET') {
      const s = requirePartner(['seller']);
      sellerShopContext(s);
      send(res, 200, { reports: [
        { id: 'sales', label: 'Daily / monthly sales', file: 'sales.csv' },
        { id: 'orders', label: 'Order report', file: 'orders.csv' },
        { id: 'products', label: 'Product performance', file: 'products.csv' },
        { id: 'stock', label: 'Stock report', file: 'stock.csv' },
        { id: 'low_stock', label: 'Low-stock report', file: 'low-stock.csv' },
        { id: 'movements', label: 'Inventory movement report', file: 'movements.csv' },
        { id: 'payments', label: 'Payment report', file: 'payments.csv' },
        { id: 'refunds', label: 'Refund report', file: 'refunds.csv' },
        { id: 'settlements', label: 'Settlement statement', file: 'settlements.csv' },
        { id: 'promotions', label: 'Promotion performance', file: 'promotions.csv' }
      ] });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/reports\/[a-z_]+\.csv$/) && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const type = route.split('/')[3].replace('.csv', '');
      if (type === 'sales') {
        const rows = db.prepare(`SELECT date(created_at) AS day, COUNT(*) AS orders, COALESCE(SUM(total_paise),0) AS gross FROM nb_seller_orders WHERE shop_id=? AND status NOT IN ('cancelled','rejected') GROUP BY day ORDER BY day`).all(shop.id);
        sendCsv(res, 'sales.csv', [['Date', 'Orders', 'Gross (₹)'], ...rows.map((r) => [r.day, r.orders, (r.gross / 100).toFixed(2)])]);
      } else if (type === 'orders') {
        const rows = db.prepare('SELECT so.code, o.code AS parent, so.status, so.fulfillment, so.total_paise, so.created_at FROM nb_seller_orders so JOIN nb_orders o ON o.id=so.order_id WHERE so.shop_id=? ORDER BY so.created_at DESC LIMIT 500').all(shop.id);
        sendCsv(res, 'orders.csv', [['Seller order', 'Parent order', 'Status', 'Fulfilment', 'Total (₹)', 'Created'], ...rows.map((r) => [r.code, r.parent, r.status, r.fulfillment, (r.total_paise / 100).toFixed(2), r.created_at])]);
      } else if (type === 'products') {
        const rows = db.prepare(`SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.line_total_paise) AS revenue FROM nb_order_items oi JOIN nb_seller_orders so ON so.id=oi.seller_order_id WHERE so.shop_id=? AND so.status NOT IN ('cancelled','rejected') GROUP BY oi.name ORDER BY revenue DESC`).all(shop.id);
        sendCsv(res, 'products.csv', [['Product', 'Qty sold', 'Revenue (₹)'], ...rows.map((r) => [r.name, r.qty, (r.revenue / 100).toFixed(2)])]);
      } else if (type === 'stock') {
        const rows = db.prepare('SELECT name, sku, barcode, stock, reserved, low_stock FROM nb_products WHERE shop_id=? ORDER BY name').all(shop.id);
        sendCsv(res, 'stock.csv', [['Product', 'SKU', 'Barcode', 'Stock', 'Reserved', 'Available', 'Low at'], ...rows.map((r) => [r.name, r.sku || '', r.barcode || '', r.stock, r.reserved, Math.max(0, r.stock - r.reserved), r.low_stock])]);
      } else if (type === 'low_stock') {
        const rows = db.prepare('SELECT name, sku, stock, reserved, low_stock FROM nb_products WHERE shop_id=? AND stock-reserved<=low_stock ORDER BY name').all(shop.id);
        sendCsv(res, 'low-stock.csv', [['Product', 'SKU', 'Available', 'Low at'], ...rows.map((r) => [r.name, r.sku || '', Math.max(0, r.stock - r.reserved), r.low_stock])]);
      } else if (type === 'movements') {
        const rows = db.prepare('SELECT product_id, type, previous_qty, new_qty, delta, reason, actor_name, created_at FROM nb_inventory_transactions WHERE shop_id=? ORDER BY created_at DESC LIMIT 500').all(shop.id);
        sendCsv(res, 'movements.csv', [['Product', 'Type', 'Previous', 'New', 'Delta', 'Reason', 'By', 'At'], ...rows.map((r) => [r.product_id, r.type, r.previous_qty, r.new_qty, r.delta, r.reason || '', r.actor_name || '', r.created_at])]);
      } else if (type === 'payments') {
        const rows = sellerPaymentRowsForShop(shop.id, 500);
        sendCsv(res, 'payments.csv', [
          ['Transaction', 'Order', 'Seller order', 'Method', 'Amount (₹)', 'Status', 'At'],
          ...rows.map((r) => [r.id, r.order_code, r.seller_code, r.method, (r.allocated_paise / 100).toFixed(2), r.status, r.created_at])
        ]);
      } else if (type === 'refunds') {
        const rows = sellerRefundRowsForShop(shop.id, 500);
        sendCsv(res, 'refunds.csv', [
          ['Refund', 'Order', 'Seller order', 'Amount (₹)', 'Status', 'At'],
          ...rows.map((r) => [r.id, r.order_code, r.seller_order_code, (r.amount_paise / 100).toFixed(2), r.status, r.created_at])
        ]);
      } else if (type === 'settlements') {
        const rows = db.prepare('SELECT code, period_start, period_end, gross_paise, refunds_paise, commission_paise, net_paise, status FROM nb_settlements WHERE shop_id=? ORDER BY created_at DESC').all(shop.id);
        sendCsv(res, 'settlements.csv', [['Settlement', 'Period', 'Gross (₹)', 'Refunds (₹)', 'Commission (₹)', 'Net (₹)', 'Status'], ...rows.map((r) => [r.code, `${r.period_start} to ${r.period_end}`, (r.gross_paise / 100).toFixed(2), (r.refunds_paise / 100).toFixed(2), (r.commission_paise / 100).toFixed(2), (r.net_paise / 100).toFixed(2), r.status])]);
      } else if (type === 'promotions') {
        const rows = db.prepare('SELECT code, title, used_count, usage_limit, active FROM nb_coupons WHERE shop_id=? ORDER BY code').all(shop.id);
        sendCsv(res, 'promotions.csv', [['Code', 'Title', 'Used', 'Limit', 'Active'], ...rows.map((r) => [r.code, r.title, r.used_count, r.usage_limit || '', r.active ? 'yes' : 'no'])]);
      } else fail(404, 'Unknown report.');
      return true;
    }

    if (base === '/api/partner' && route === '/seller/support/faqs' && method === 'GET') {
      const s = requirePartner(['seller']);
      sellerShopContext(s, { allowPending: true });
      const rows = db.prepare('SELECT * FROM nb_faqs ORDER BY category, sort').all();
      send(res, 200, { faqs: rows.map((f) => ({ category: f.category, question: f.question, answer: f.answer })) });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/support/tickets' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s, { allowPending: true });
      const rows = db.prepare('SELECT * FROM nb_seller_tickets WHERE user_id=? ORDER BY created_at DESC').all(s.user_id);
      send(res, 200, { tickets: rows.map((t) => ({ code: t.code, category: t.category, subject: t.subject, status: t.status, orderCode: t.order_code, assignedAgent: t.assigned_agent, createdAt: t.created_at, updatedAt: t.updated_at })) });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/support/tickets' && method === 'POST') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s, { allowPending: true });
      const category = String(payload.category || 'general').slice(0, 60);
      const subject = String(payload.subject || '').trim();
      const description = String(payload.description || '').trim();
      if (!str(subject, 3, 120)) fail(400, 'Give the ticket a short subject.');
      if (!str(description, 10, 2000)) fail(400, 'Describe the issue in at least 10 characters.');
      const orderCode = payload.orderCode ? String(payload.orderCode).slice(0, 20) : null;
      if (orderCode && !db.prepare('SELECT id FROM nb_seller_orders WHERE code=? AND shop_id=?').get(orderCode, shop.id)) fail(400, 'That order does not belong to your shop.');
      const id = uid();
      const code = `SUP-${String(Math.floor(100000 + Math.random() * 900000))}`;
      transaction(() => {
        db.prepare('INSERT INTO nb_seller_tickets(id,code,user_id,shop_id,order_code,category,subject,description,attachment,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, code, s.user_id, shop.id, orderCode, category, subject, description, payload.attachment ? String(payload.attachment).slice(0, 300) : null, 'open', now(), now());
        db.prepare('INSERT INTO nb_seller_ticket_messages(id,ticket_id,author_role,author_name,body,created_at) VALUES(?,?,?,?,?,?)')
          .run(uid(), id, 'seller', s.name, description, now());
      });
      audit('seller', s.user_id, 'support_ticket_created', 'ticket', id, `${code} · ${category}`);
      send(res, 201, { ticket: { code, status: 'open' }, message: `Ticket ${code} created. Support will reply in this thread.` });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/support\/tickets\/[A-Za-z0-9-]+$/) && method === 'GET') {
      const s = requirePartner(['seller']);
      const ticket = db.prepare('SELECT * FROM nb_seller_tickets WHERE code=? AND user_id=?').get(decodeURIComponent(route.split('/')[4]), s.user_id);
      if (!ticket) fail(404, 'Ticket not found.');
      const messages = db.prepare('SELECT * FROM nb_seller_ticket_messages WHERE ticket_id=? ORDER BY created_at').all(ticket.id);
      send(res, 200, { ticket: { code: ticket.code, category: ticket.category, subject: ticket.subject, description: ticket.description, status: ticket.status, orderCode: ticket.order_code, assignedAgent: ticket.assigned_agent, attachment: ticket.attachment, createdAt: ticket.created_at, updatedAt: ticket.updated_at, messages: messages.map((m) => ({ authorRole: m.author_role, authorName: m.author_name, body: m.body, at: m.created_at })) } });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/support\/tickets\/[A-Za-z0-9-]+\/(reply|close)$/) && method === 'POST') {
      const s = requirePartner(['seller']);
      const parts = route.split('/');
      const ticket = db.prepare('SELECT * FROM nb_seller_tickets WHERE code=? AND user_id=?').get(decodeURIComponent(parts[4]), s.user_id);
      if (!ticket) fail(404, 'Ticket not found.');
      if (parts[5] === 'close') {
        db.prepare("UPDATE nb_seller_tickets SET status='closed',updated_at=? WHERE id=?").run(now(), ticket.id);
        send(res, 200, { message: 'Ticket closed.' });
        return true;
      }
      if (ticket.status === 'closed') fail(409, 'This ticket is closed. Create a new ticket if you still need help.');
      if (!str(payload.body, 2, 2000)) fail(400, 'Write a message of at least 2 characters.');
      transaction(() => {
        db.prepare('INSERT INTO nb_seller_ticket_messages(id,ticket_id,author_role,author_name,body,created_at) VALUES(?,?,?,?,?,?)').run(uid(), ticket.id, 'seller', s.name, payload.body.trim(), now());
        db.prepare("UPDATE nb_seller_tickets SET status=?,updated_at=? WHERE id=?").run(ticket.status === 'awaiting_seller' ? 'in_progress' : ticket.status, now(), ticket.id);
      });
      send(res, 200, { message: 'Reply added.' });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/settings' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s, { allowPending: true });
      const user = db.prepare('SELECT * FROM nb_users WHERE id=?').get(s.user_id);
      const sessions = db.prepare('SELECT token_hash, created_at, expires_at, user_agent, ip FROM nb_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 10').all(s.user_id);
      const logins = db.prepare("SELECT * FROM nb_audit_logs WHERE actor_id=? AND action='partner_login' ORDER BY created_at DESC LIMIT 10").all(s.user_id);
      const financial = db.prepare('SELECT * FROM nb_shop_financial_settings WHERE shop_id=?').get(shop.id);
      send(res, 200, {
        account: { name: user.name, email: user.email, phone: user.phone, twoFactor: Boolean(user.two_factor_enabled), status: user.status },
        business: { name: shop.name, category: shop.category_slug, address: shop.address, city: shop.city, pincode: shop.pincode, phone: shop.phone, businessEmail: shop.business_email },
        financial: financial ? { commissionRate: financial.commission_rate, bankName: financial.bank_name, bankLast4: financial.bank_account_last4, bankIfsc: financial.bank_ifsc, bankStatus: financial.bank_status, settlementPreference: financial.settlement_preference } : { commissionRate: Number(shop.commission_rate || 0), bankName: shop.bank_name, bankLast4: shop.bank_account_last4, bankIfsc: shop.bank_ifsc, bankStatus: shop.bank_status || 'not_submitted', settlementPreference: 'weekly' },
        sessions: sessions.map((x) => ({ tokenHash: x.token_hash.slice(0, 12) + '…', createdAt: x.created_at, expiresAt: x.expires_at, userAgent: x.user_agent, ip: x.ip })),
        loginHistory: logins.map((l) => ({ at: l.created_at, detail: l.detail }))
      });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/settings/account' && method === 'PATCH') {
      const s = requirePartner(['seller']);
      const user = db.prepare('SELECT * FROM nb_users WHERE id=?').get(s.user_id);
      if (payload.password) {
        if (!checkPassword(payload.currentPassword || '', user.password_hash)) fail(401, 'Current password is incorrect.');
        if (String(payload.password).length < 8) fail(400, 'New password must be at least 8 characters.');
        db.prepare('UPDATE nb_users SET password_hash=? WHERE id=?').run(makePassword(payload.password), s.user_id);
        db.prepare('DELETE FROM nb_sessions WHERE user_id=? AND token_hash<>?').run(s.user_id, sha(s.token));
      }
      const name = payload.name !== undefined ? String(payload.name).trim() : user.name;
      if (!str(name, 2, 80)) fail(400, 'Name must be 2–80 characters.');
      const email = payload.email !== undefined ? String(payload.email).trim().toLowerCase() : user.email;
      if (!emailOk(email)) fail(400, 'Enter a valid email address.');
      if (email !== user.email && db.prepare('SELECT id FROM nb_users WHERE email=?').get(email)) fail(409, 'Another account already uses this email.');
      const phone = payload.phone !== undefined ? normalPhone(payload.phone) : user.phone;
      if (!phoneOk(phone)) fail(400, 'Enter a valid 10-digit mobile number.');
      db.prepare('UPDATE nb_users SET name=?,email=?,phone=? WHERE id=?').run(name, email, phone, s.user_id);
      audit('seller', s.user_id, 'account_updated', 'user', s.user_id, name);
      send(res, 200, { message: payload.password ? 'Password changed. Other sessions were signed out.' : 'Account saved.' });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/settings/2fa' && method === 'POST') {
      const s = requirePartner(['seller']);
      const enabled = payload.enabled ? 1 : 0;
      db.prepare('UPDATE nb_users SET two_factor_enabled=? WHERE id=?').run(enabled, s.user_id);
      send(res, 200, { message: enabled ? 'Two-factor authentication enabled. A verification code will be required at sign-in once an OTP provider is configured.' : 'Two-factor authentication disabled.', enabled: Boolean(enabled) });
      return true;
    }

    if (base === '/api/partner' && route.match(/^\/seller\/settings\/sessions\/[A-Za-z0-9]+$/) && method === 'DELETE') {
      const s = requirePartner(['seller']);
      const prefix = decodeURIComponent(route.split('/')[4]);
      const rows = db.prepare('SELECT token_hash FROM nb_sessions WHERE user_id=?').all(s.user_id);
      const match = rows.find((r) => r.token_hash.startsWith(prefix.replace('…', '')));
      if (!match) fail(404, 'Session not found.');
      db.prepare('DELETE FROM nb_sessions WHERE token_hash=?').run(match.token_hash);
      send(res, 200, { message: 'Session revoked.' });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/settings/financial' && method === 'PATCH') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      requireSellerPerm(s, shop, 'manage_settlements', 'Editing financial settings');
      const bankName = payload.bankName !== undefined ? String(payload.bankName).slice(0, 80) : shop.bank_name;
      const bankLast4 = payload.bankAccount !== undefined ? String(payload.bankAccount).replace(/\D/g, '').slice(-4) : shop.bank_account_last4;
      const bankIfsc = payload.bankIfsc !== undefined ? String(payload.bankIfsc).trim().toUpperCase().slice(0, 20) : shop.bank_ifsc;
      const bankChanged = bankName !== shop.bank_name || bankLast4 !== shop.bank_account_last4 || bankIfsc !== shop.bank_ifsc;
      const status = bankChanged ? 'verification_pending' : (shop.bank_status || 'not_submitted');
      transaction(() => {
        db.prepare('UPDATE nb_shops SET bank_name=?,bank_account_last4=?,bank_ifsc=?,bank_status=? WHERE id=?').run(bankName, bankLast4, bankIfsc, status, shop.id);
        db.prepare(`INSERT INTO nb_shop_financial_settings(shop_id,commission_rate,bank_name,bank_account_last4,bank_ifsc,bank_status,settlement_preference,updated_at)
          VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(shop_id) DO UPDATE SET bank_name=excluded.bank_name,bank_account_last4=excluded.bank_account_last4,bank_ifsc=excluded.bank_ifsc,bank_status=excluded.bank_status,settlement_preference=excluded.settlement_preference,updated_at=excluded.updated_at`)
          .run(shop.id, Number(shop.commission_rate || 0), bankName, bankLast4, bankIfsc, status, String(payload.settlementPreference || 'weekly').slice(0, 20), now());
      });
      audit('seller', s.user_id, 'bank_updated', 'shop', shop.id, bankChanged ? 'Bank change submitted for verification' : 'Financial settings saved');
      send(res, 200, { message: bankChanged ? 'Bank details submitted. Payouts stay on hold until admin verifies the change.' : 'Financial settings saved.', bankStatus: status });
      return true;
    }

    if (base === '/api/partner' && route === '/seller/categories' && method === 'GET') {
      const s = requirePartner(['seller']);
      const shop = sellerShopContext(s);
      const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM nb_products p WHERE p.category_slug=c.slug AND p.shop_id=? AND COALESCE(p.archived,0)=0) AS products FROM nb_categories c WHERE c.active=1 ORDER BY c.sort, c.name`).all(shop.id);
      send(res, 200, { categories: rows.map((c) => ({ slug: c.slug, name: c.name, icon: c.icon, parentSlug: c.parent_slug, products: Number(c.products || 0) })) });
      return true;
    }


    /* Admin: catalogue, service areas, shops, deliveries, broadcast        */
    /* ================================================================== */

    if (base === '/api/admin' && route === '/categories' && method === 'GET') {
      requireAdmin();
      const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM nb_shops s WHERE s.category_slug=c.slug) AS shops,
        (SELECT COUNT(*) FROM nb_products p WHERE p.category_slug=c.slug) AS products
        FROM nb_categories c ORDER BY c.parent_slug IS NOT NULL, c.sort, c.name`).all();
      send(res, 200, {
        categories: rows.map((c) => ({
          slug: c.slug, name: c.name, icon: c.icon, tone: c.tone, parentSlug: c.parent_slug,
          sort: c.sort, active: Boolean(c.active), shops: Number(c.shops || 0), products: Number(c.products || 0)
        }))
      });
      return true;
    }

    if (base === '/api/admin' && route === '/categories' && method === 'POST') {
      const admin = requireAdmin();
      const name = String(payload.name || '').trim();
      if (!str(name, 2, 60)) fail(400, 'Give the category a name of 2–60 characters.');
      const slug = String(payload.slug || NB_SLUG(name)).toLowerCase();
      if (!/^[a-z0-9-]{2,60}$/.test(slug)) fail(400, 'Slug may only contain letters, numbers and dashes.');
      const parentSlug = payload.parentSlug ? String(payload.parentSlug).trim() : null;
      if (parentSlug && !db.prepare('SELECT 1 FROM nb_categories WHERE slug=?').get(parentSlug)) fail(400, 'The parent category does not exist.');
      if (parentSlug === slug) fail(400, 'A category cannot be its own parent.');
      const existing = db.prepare('SELECT * FROM nb_categories WHERE slug=?').get(slug);
      if (existing) {
        db.prepare('UPDATE nb_categories SET name=?,icon=?,tone=?,parent_slug=?,sort=?,active=? WHERE slug=?').run(
          name, String(payload.icon || existing.icon || '🏷️').slice(0, 8), String(payload.tone || existing.tone || 'blue').slice(0, 12),
          parentSlug, clampInt(payload.sort ?? existing.sort, 0, 999), payload.active === undefined ? existing.active : payload.active ? 1 : 0, slug
        );
        audit('admin', admin.user_id, 'category_updated', 'category', slug, name);
        send(res, 200, { message: `Category ${name} updated.`, slug });
        return true;
      }
      db.prepare('INSERT INTO nb_categories(slug,name,icon,tone,parent_slug,sort,active) VALUES(?,?,?,?,?,?,?)').run(
        slug, name, String(payload.icon || '🏷️').slice(0, 8), String(payload.tone || 'blue').slice(0, 12),
        parentSlug, clampInt(payload.sort ?? 50, 0, 999), payload.active === false ? 0 : 1
      );
      audit('admin', admin.user_id, 'category_created', 'category', slug, name);
      send(res, 201, { message: `Category ${name} created.`, slug });
      return true;
    }

    if (base === '/api/admin' && route === '/service-areas' && method === 'GET') {
      requireAdmin();
      const rows = db.prepare('SELECT * FROM nb_service_areas ORDER BY pincode, locality').all();
      send(res, 200, {
        areas: rows.map((a) => ({ id: a.id, pincode: a.pincode, locality: a.locality, city: a.city, lat: a.lat, lng: a.lng, active: Boolean(a.active) }))
      });
      return true;
    }

    if (base === '/api/admin' && route === '/service-areas' && method === 'POST') {
      const admin = requireAdmin();
      if (!pincodeOk(payload.pincode)) fail(400, 'Enter a valid 6-digit PIN code.');
      if (!str(payload.locality, 2, 80)) fail(400, 'Enter the locality name.');
      const lat = Number(payload.lat);
      const lng = Number(payload.lng);
      if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) fail(400, 'Valid coordinates are required to place the area on the map.');
      const existing = db.prepare('SELECT * FROM nb_service_areas WHERE pincode=? AND locality=?').get(String(payload.pincode), payload.locality.trim());
      if (existing) {
        db.prepare('UPDATE nb_service_areas SET city=?,lat=?,lng=?,active=? WHERE id=?').run(
          String(payload.city || 'New Delhi').slice(0, 60), lat, lng, payload.active === false ? 0 : 1, existing.id
        );
        audit('admin', admin.user_id, 'service_area_updated', 'service_area', String(existing.id), payload.locality);
        send(res, 200, { message: 'Service area updated.' });
        return true;
      }
      db.prepare('INSERT INTO nb_service_areas(pincode,locality,city,lat,lng,active) VALUES(?,?,?,?,?,1)')
        .run(String(payload.pincode), payload.locality.trim(), String(payload.city || 'New Delhi').slice(0, 60), lat, lng);
      audit('admin', admin.user_id, 'service_area_created', 'service_area', null, `${payload.pincode} ${payload.locality}`);
      send(res, 201, { message: `${payload.locality} is now serviceable.` });
      return true;
    }

    if (base === '/api/admin' && route.match(/^\/shops\/[a-z0-9-]+$/) && method === 'PATCH') {
      const admin = requireAdmin();
      const shop = db.prepare('SELECT * FROM nb_shops WHERE slug=?').get(route.split('/')[2]);
      if (!shop) fail(404, 'Shop not found');
      const verified = payload.verified === undefined ? shop.verified : payload.verified ? 1 : 0;
      const openState = payload.isOpen === undefined ? shop.is_open : payload.isOpen ? 1 : 0;
      const radius = payload.radiusKm === undefined ? shop.radius_km : round2(Math.min(50, Math.max(0.5, Number(payload.radiusKm) || shop.radius_km)));
      const pincodes = payload.servicePincodes === undefined ? shop.service_pincodes
        : (Array.isArray(payload.servicePincodes) ? payload.servicePincodes : String(payload.servicePincodes).split(','))
          .map((p) => String(p).trim()).filter((p) => pincodeOk(p)).join(',');
      if (payload.servicePincodes !== undefined && shop.service_pincodes && !pincodes) {
        fail(400, 'Enter at least one valid 6-digit PIN code.');
      }
      db.prepare('UPDATE nb_shops SET verified=?,is_open=?,radius_km=?,service_pincodes=? WHERE id=?')
        .run(verified, openState, radius, pincodes, shop.id);
      audit('admin', admin.user_id, 'shop_updated', 'shop', shop.id, `verified ${shop.verified}→${verified}, open ${shop.is_open}→${openState}, radius ${shop.radius_km}→${radius}`);
      const updated = db.prepare('SELECT * FROM nb_shops WHERE id=?').get(shop.id);
      send(res, 200, { message: `${updated.name} updated.`, shop: shopCard(updated, null) });
      return true;
    }

    if (base === '/api/admin' && route.match(/^\/customers\/[a-zA-Z0-9-]+$/) && method === 'PATCH') {
      const admin = requireAdmin();
      const customer = db.prepare("SELECT * FROM nb_users WHERE id=? AND role='customer'").get(route.split('/')[2]);
      if (!customer) fail(404, 'Customer not found');
      if (!['active', 'suspended'].includes(payload.status)) fail(400, 'Choose active or suspended.');
      db.prepare('UPDATE nb_users SET status=? WHERE id=?').run(payload.status, customer.id);
      if (payload.status === 'suspended') {
        db.prepare('DELETE FROM nb_sessions WHERE user_id=?').run(customer.id);
        notify(customer.id, 'Account suspended', 'Your NearBuy account has been suspended. Contact support if you think this is a mistake.', 'account', '#/help');
      }
      audit('admin', admin.user_id, 'customer_status', 'user', customer.id, `${customer.status} → ${payload.status}`);
      send(res, 200, { message: `${customer.name} is now ${payload.status}.` });
      return true;
    }

    if (base === '/api/admin' && route === '/products' && method === 'GET') {
      requireAdmin();
      const rows = db.prepare(`SELECT p.id,p.name,p.brand,p.category_slug,p.price_paise,p.mrp_paise,p.stock,p.reserved,p.active,p.is_demo,
        s.name AS shop_name, s.slug AS shop_slug FROM nb_products p JOIN nb_shops s ON s.id=p.shop_id
        ORDER BY p.active, s.name, p.name LIMIT 400`).all();
      send(res, 200, {
        products: rows.map((p) => ({
          id: p.id, name: p.name, brand: p.brand, category: p.category_slug, price: p.price_paise, mrp: p.mrp_paise,
          stock: p.stock, reserved: p.reserved, available: Math.max(0, p.stock - p.reserved), active: Boolean(p.active),
          shop: { name: p.shop_name, slug: p.shop_slug }
        }))
      });
      return true;
    }

    if (base === '/api/admin' && route.match(/^\/products\/[a-zA-Z0-9_-]+$/) && method === 'PATCH') {
      const admin = requireAdmin();
      const product = db.prepare('SELECT * FROM nb_products WHERE id=?').get(route.split('/')[2]);
      if (!product) fail(404, 'Product not found');
      if (payload.active === undefined) fail(400, 'Send active: true or false to moderate a listing.');
      db.prepare('UPDATE nb_products SET active=? WHERE id=?').run(payload.active ? 1 : 0, product.id);
      audit('admin', admin.user_id, 'product_moderated', 'product', product.id, `${product.active} → ${payload.active ? 1 : 0}`);
      const shop = db.prepare('SELECT owner_user_id,name FROM nb_shops WHERE id=?').get(product.shop_id);
      if (shop?.owner_user_id) notify(shop.owner_user_id, `Listing ${payload.active ? 'restored' : 'hidden'}`, `${product.name} was ${payload.active ? 'restored to' : 'removed from'} the customer storefront by platform operations.`, 'seller', '#/catalogue');
      send(res, 200, { message: `${product.name} is now ${payload.active ? 'live' : 'hidden'}.` });
      return true;
    }

    if (base === '/api/admin' && route === '/deliveries' && method === 'GET') {
      requireAdmin();
      const rows = db.prepare(`SELECT a.*, so.code AS order_code, so.status AS order_status, s.name AS shop_name, u.name AS runner_name
        FROM nb_delivery_assignments a JOIN nb_seller_orders so ON so.id=a.seller_order_id
        JOIN nb_shops s ON s.id=a.shop_id LEFT JOIN nb_users u ON u.id=a.runner_id
        ORDER BY a.created_at DESC LIMIT 100`).all();
      send(res, 200, {
        deliveries: rows.map((a) => ({
          id: a.id, orderCode: a.order_code, orderStatus: a.order_status, shop: a.shop_name, runner: a.runner_name,
          status: a.status, payout: a.payout_paise, distanceKm: a.distance_km, createdAt: a.created_at,
          expiresAt: a.expires_at, pickedUpAt: a.picked_up_at, deliveredAt: a.delivered_at
        }))
      });
      return true;
    }

    if (base === '/api/admin' && route === '/notifications' && method === 'POST') {
      const admin = requireAdmin();
      if (!str(payload.title, 3, 120)) fail(400, 'A notification title is required.');
      if (!str(payload.body, 3, 400)) fail(400, 'Write the notification message.');
      const audience = payload.audience === 'shop_customers' ? 'shop_customers' : payload.audience === 'sellers' ? 'sellers' : 'customers';
      let users;
      if (audience === 'sellers') users = db.prepare("SELECT id FROM nb_users WHERE role='seller' AND status='active'").all();
      else if (audience === 'shop_customers' && payload.shopSlug) {
        users = db.prepare(`SELECT DISTINCT o.customer_id AS id FROM nb_orders o JOIN nb_seller_orders so ON so.order_id=o.id
          JOIN nb_shops s ON s.id=so.shop_id WHERE s.slug=?`).all(String(payload.shopSlug));
      } else users = db.prepare("SELECT id FROM nb_users WHERE role='customer' AND status='active'").all();
      transaction(() => {
        for (const u of users) notify(u.id, payload.title.trim(), payload.body.trim(), 'platform', String(payload.link || '#/notifications').slice(0, 200));
        audit('admin', admin.user_id, 'broadcast', 'notification', null, `${audience}: ${payload.title}`);
      });
      send(res, 201, {
        message: `Notification stored for ${users.length} ${audience.replace('_', ' ')}. In-app delivery is immediate; no SMS or email provider is configured.`,
        recipients: users.length
      });
      return true;
    }

    /* ================================================================== */
    /* Admin: seller applications, settlements, seller tickets, bank        */
    /* ================================================================== */

    if (base === '/api/admin' && route === '/seller-applications' && method === 'GET') {
      requireAdmin();
      const rows = db.prepare(`SELECT v.*, u.name AS owner_name, u.email AS owner_email, u.phone AS owner_phone, u.status AS user_status, s.name AS shop_name, s.slug AS shop_slug
        FROM nb_seller_verifications v JOIN nb_users u ON u.id=v.user_id LEFT JOIN nb_shops s ON s.id=v.shop_id
        ORDER BY v.created_at DESC LIMIT 100`).all();
      send(res, 200, { applications: rows.map((v) => {
        const docs = db.prepare('SELECT * FROM nb_seller_documents WHERE verification_id=? ORDER BY created_at').all(v.id);
        return { id: v.id, userId: v.user_id, shopId: v.shop_id, status: v.status, legalName: v.legal_name, businessCategory: v.business_category, shopType: v.shop_type, address: v.address, pincode: v.pincode, city: v.city, state: v.state, country: v.country, contactNumber: v.contact_number, businessEmail: v.business_email, ownershipType: v.ownership_type, pan: v.pan_number, gst: v.gst_number, reason: v.reason, submittedAt: v.submitted_at, reviewedAt: v.reviewed_at, owner: { name: v.owner_name, email: v.owner_email, phone: v.owner_phone, status: v.user_status }, shop: v.shop_name ? { name: v.shop_name, slug: v.shop_slug } : null, documents: docs.map((d) => ({ type: d.doc_type, fileName: d.file_name, fileType: d.file_type, fileSize: d.file_size })) };
      }) });
      return true;
    }

    if (base === '/api/admin' && route.match(/^\/seller-applications\/[A-Za-z0-9-]+$/) && method === 'PATCH') {
      const admin = requireAdmin();
      const id = decodeURIComponent(route.split('/')[2]);
      const verification = db.prepare('SELECT * FROM nb_seller_verifications WHERE id=?').get(id);
      if (!verification) fail(404, 'Application not found.');
      const status = String(payload.status || '');
      if (!['under_review', 'approved', 'rejected', 'additional_info_required', 'suspended'].includes(status)) fail(400, 'Choose under_review, approved, rejected, additional_info_required or suspended.');
      const reason = String(payload.reason || '').trim().slice(0, 500);
      if ((status === 'rejected' || status === 'additional_info_required') && !reason) fail(400, 'Give the seller a reason for this decision.');
      transaction(() => {
        db.prepare('UPDATE nb_seller_verifications SET status=?,reason=?,reviewed_at=?,reviewer_id=?,updated_at=? WHERE id=?').run(status, reason || null, now(), admin.user_id, now(), id);
        if (status === 'approved') {
          db.prepare('UPDATE nb_users SET status=\'active\' WHERE id=?').run(verification.user_id);
          if (verification.shop_id) {
            const shop = db.prepare('SELECT * FROM nb_shops WHERE id=?').get(verification.shop_id);
            const slugPart = String(shop.slug || 'shop').toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 12);
            db.prepare('UPDATE nb_shops SET verified=1,is_open=1,seller_code=?,shop_code=? WHERE id=?').run(`NB-SELLER-${slugPart}`, `NB-SHOP-${slugPart}`, shop.id);
            // Seed the storefront profile + serviceability from the verified application so customers can order immediately.
            const hasPins = String(shop.service_pincodes || '').split(',').some((p) => /^\d{6}$/.test(p.trim()));
            const updates = [];
            const args = [];
            if (verification.address && !String(shop.address || '').trim()) { updates.push('address=?'); args.push(verification.address); }
            if (verification.city && !String(shop.city || '').trim()) { updates.push('city=?'); args.push(verification.city); }
            if (verification.pincode && !pincodeOk(String(shop.pincode || ''))) { updates.push('pincode=?'); args.push(verification.pincode); }
            if (Number.isFinite(Number(verification.lat)) && Number(verification.lat) !== 0) { updates.push('lat=?'); args.push(Number(verification.lat)); }
            if (Number.isFinite(Number(verification.lng)) && Number(verification.lng) !== 0) { updates.push('lng=?'); args.push(Number(verification.lng)); }
            if (!hasPins && pincodeOk(String(verification.pincode || ''))) { updates.push('service_pincodes=?'); args.push(String(verification.pincode)); }
            if (updates.length) { args.push(shop.id); db.prepare(`UPDATE nb_shops SET ${updates.join(',')} WHERE id=?`).run(...args); }
          }
        } else if (status === 'suspended') {
          db.prepare('UPDATE nb_users SET status=\'suspended\' WHERE id=?').run(verification.user_id);
          db.prepare('DELETE FROM nb_sessions WHERE user_id=?').run(verification.user_id);
          if (verification.shop_id) db.prepare('UPDATE nb_shops SET verified=0,is_open=0 WHERE id=?').run(verification.shop_id);
        } else if (status === 'rejected') {
          db.prepare('UPDATE nb_users SET status=\'pending_verification\' WHERE id=?').run(verification.user_id);
        }
        notify(verification.user_id, 'Seller verification update', `Your NearBuy seller application is now ${status.replace(/_/g, ' ')}.${reason ? ` ${reason}` : ''}`, 'seller', '#/verification');
      });
      audit('admin', admin.user_id, 'seller_application_reviewed', 'verification', id, `${status}${reason ? ' · ' + reason : ''}`);
      send(res, 200, { message: `Application ${status.replace(/_/g, ' ')}. The seller sees this decision in the Seller Hub.` });
      return true;
    }

    if (base === '/api/admin' && route === '/settlements' && method === 'GET') {
      requireAdmin();
      const rows = db.prepare('SELECT st.*, s.name AS shop_name FROM nb_settlements st JOIN nb_shops s ON s.id=st.shop_id ORDER BY st.created_at DESC LIMIT 100').all();
      send(res, 200, { settlements: rows.map((r) => ({ id: r.id, code: r.code, shop: r.shop_name, periodStart: r.period_start, periodEnd: r.period_end, gross: r.gross_paise, refunds: r.refunds_paise, commission: r.commission_paise, net: r.net_paise, status: r.status, bankReference: r.bank_reference, payoutDate: r.payout_date })) });
      return true;
    }

    if (base === '/api/admin' && route.match(/^\/settlements\/[A-Za-z0-9-]+\/status$/) && method === 'POST') {
      const admin = requireAdmin();
      const code = decodeURIComponent(route.split('/')[2]);
      const row = db.prepare('SELECT * FROM nb_settlements WHERE code=?').get(code);
      if (!row) fail(404, 'Settlement not found.');
      const status = String(payload.status || '');
      if (!['pending', 'processing', 'completed', 'failed', 'on_hold', 'reconciliation_required'].includes(status)) fail(400, 'Choose a valid settlement status.');
      const bankReference = payload.bankReference !== undefined ? String(payload.bankReference).slice(0, 120) : row.bank_reference;
      if (status === 'completed' && !bankReference) fail(400, 'A confirmed payout needs a bank reference.');
      db.prepare('UPDATE nb_settlements SET status=?,bank_reference=?,payout_date=?,updated_at=? WHERE id=?').run(status, bankReference, status === 'completed' ? now() : row.payout_date, now(), row.id);
      const shop = db.prepare('SELECT owner_user_id, name FROM nb_shops WHERE id=?').get(row.shop_id);
      if (shop?.owner_user_id) notify(shop.owner_user_id, 'Settlement update', `${row.code} is now ${status.replace(/_/g, ' ')}.${bankReference ? ` Reference ${bankReference}.` : ''}`, 'settlement', '#/settlements');
      audit('admin', admin.user_id, 'settlement_status', 'settlement', row.id, `${row.code} → ${status}`);
      send(res, 200, { message: `Settlement ${row.code} is now ${status.replace(/_/g, ' ')}.` });
      return true;
    }

    if (base === '/api/admin' && route === '/seller-tickets' && method === 'GET') {
      requireAdmin();
      const rows = db.prepare(`SELECT t.*, s.name AS shop_name, u.name AS seller_name FROM nb_seller_tickets t JOIN nb_shops s ON s.id=t.shop_id JOIN nb_users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 100`).all();
      send(res, 200, { tickets: rows.map((t) => ({ code: t.code, shop: t.shop_name, seller: t.seller_name, category: t.category, subject: t.subject, status: t.status, orderCode: t.order_code, assignedAgent: t.assigned_agent, createdAt: t.created_at, updatedAt: t.updated_at })) });
      return true;
    }

    if (base === '/api/admin' && route.match(/^\/seller-tickets\/[A-Za-z0-9-]+$/) && method === 'GET') {
      requireAdmin();
      const ticket = db.prepare('SELECT * FROM nb_seller_tickets WHERE code=?').get(decodeURIComponent(route.split('/')[2]));
      if (!ticket) fail(404, 'Ticket not found.');
      const messages = db.prepare('SELECT * FROM nb_seller_ticket_messages WHERE ticket_id=? ORDER BY created_at').all(ticket.id);
      send(res, 200, { ticket: { code: ticket.code, category: ticket.category, subject: ticket.subject, description: ticket.description, status: ticket.status, orderCode: ticket.order_code, assignedAgent: ticket.assigned_agent, attachment: ticket.attachment, createdAt: ticket.created_at, messages: messages.map((m) => ({ authorRole: m.author_role, authorName: m.author_name, body: m.body, at: m.created_at })) } });
      return true;
    }

    if (base === '/api/admin' && route.match(/^\/seller-tickets\/[A-Za-z0-9-]+\/(reply|status)$/) && method === 'POST') {
      const admin = requireAdmin();
      const parts = route.split('/');
      const ticket = db.prepare('SELECT * FROM nb_seller_tickets WHERE code=?').get(decodeURIComponent(parts[2]));
      if (!ticket) fail(404, 'Ticket not found.');
      if (parts[3] === 'reply') {
        if (!str(payload.body, 2, 2000)) fail(400, 'Write a reply of at least 2 characters.');
        transaction(() => {
          db.prepare('INSERT INTO nb_seller_ticket_messages(id,ticket_id,author_role,author_name,body,created_at) VALUES(?,?,?,?,?,?)').run(uid(), ticket.id, 'support', admin.name, payload.body.trim(), now());
          db.prepare("UPDATE nb_seller_tickets SET status='awaiting_seller',updated_at=? WHERE id=?").run(now(), ticket.id);
        });
        notify(ticket.user_id, 'Support replied', `${ticket.code}: ${payload.body.trim().slice(0, 120)}`, 'support', `#/support/tickets/${ticket.code}`);
        send(res, 200, { message: 'Reply sent to the seller.' });
        return true;
      }
      const status = String(payload.status || '');
      if (!['open', 'assigned', 'in_progress', 'awaiting_seller', 'resolved', 'closed'].includes(status)) fail(400, 'Choose a valid ticket status.');
      db.prepare('UPDATE nb_seller_tickets SET status=?,assigned_agent=?,updated_at=? WHERE id=?').run(status, payload.agent ? String(payload.agent).slice(0, 80) : ticket.assigned_agent, now(), ticket.id);
      notify(ticket.user_id, 'Ticket update', `${ticket.code} is now ${status.replace(/_/g, ' ')}.`, 'support', `#/support/tickets/${ticket.code}`);
      audit('admin', admin.user_id, 'seller_ticket_status', 'ticket', ticket.id, `${ticket.code} → ${status}`);
      send(res, 200, { message: `Ticket ${status.replace(/_/g, ' ')}.` });
      return true;
    }

    if (base === '/api/admin' && route.match(/^\/shops\/[a-z0-9-]+\/bank$/) && method === 'POST') {
      const admin = requireAdmin();
      const shop = db.prepare('SELECT * FROM nb_shops WHERE slug=?').get(route.split('/')[2]);
      if (!shop) fail(404, 'Shop not found.');
      const verified = payload.verified ? 'verified' : 'rejected';
      db.prepare('UPDATE nb_shops SET bank_status=? WHERE id=?').run(verified, shop.id);
      db.prepare('UPDATE nb_shop_financial_settings SET bank_status=?,updated_at=? WHERE shop_id=?').run(verified, now(), shop.id);
      if (shop.owner_user_id) notify(shop.owner_user_id, 'Bank details verified', `Your payout bank details for ${shop.name} were ${verified}.`, 'settlement', '#/settings');
      audit('admin', admin.user_id, 'bank_verified', 'shop', shop.id, verified);
      send(res, 200, { message: `Bank details ${verified} for ${shop.name}.` });
      return true;
    }


    /* Admin: runner management, runner safety tickets, runner payouts    */
    if (base === '/api/admin' && route === '/runners' && method === 'GET') {
      requireAdmin();
      const rows = db.prepare(`SELECT r.*, u.name, u.email, u.phone, u.status AS account_status, u.created_at AS joined_at,
        (SELECT COUNT(*) FROM nb_delivery_assignments a WHERE a.runner_id=r.user_id AND a.status='delivered') AS deliveries,
        (SELECT COALESCE(SUM(payout_paise),0) FROM nb_delivery_assignments a WHERE a.runner_id=r.user_id AND a.status='delivered') AS earned
        FROM nb_runners r JOIN nb_users u ON u.id=r.user_id ORDER BY u.created_at DESC LIMIT 200`).all();
      send(res, 200, { runners: rows.map((r) => ({ userId: r.user_id, name: r.name, email: r.email, phone: r.phone, vehicle: r.vehicle, status: r.status, active: Boolean(r.active), accountStatus: r.account_status, rating: r.rating, completed: r.completed, deliveries: r.deliveries, earned: r.earned, joinedAt: r.joined_at })) });
      return true;
    }

    if (base === '/api/admin' && route.match(/^\/runners\/[a-zA-Z0-9-]+$/) && method === 'PATCH') {
      const admin = requireAdmin();
      const id = route.split('/')[2];
      const runner = db.prepare('SELECT * FROM nb_runners WHERE user_id=?').get(id);
      if (!runner) fail(404, 'Runner not found.');
      const active = payload.active === false ? 0 : 1;
      db.prepare('UPDATE nb_runners SET active=?,status=? WHERE user_id=?').run(active, active ? runner.status : 'offline', id);
      db.prepare('UPDATE nb_users SET status=? WHERE id=?').run(active ? 'active' : 'suspended', id);
      if (!active) db.prepare('DELETE FROM nb_sessions WHERE user_id=?').run(id);
      audit('admin', admin.user_id, active ? 'runner_reactivated' : 'runner_suspended', 'runner', id, active ? 'reactivated' : 'suspended');
      send(res, 200, { message: active ? 'Runner reactivated. They can go online again.' : 'Runner suspended. Live sessions were ended and no new offers will be sent.' });
      return true;
    }

    if (base === '/api/admin' && route === '/runner-tickets' && method === 'GET') {
      requireAdmin();
      const rows = db.prepare(`SELECT t.*, u.name AS runner_name FROM nb_runner_tickets t JOIN nb_users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 200`).all();
      send(res, 200, { tickets: rows.map((t) => ({ code: t.code, runner: t.runner_name, category: t.category, subject: t.subject, status: t.status, assignedAgent: t.assigned_agent, createdAt: t.created_at, updatedAt: t.updated_at })) });
      return true;
    }

    if (base === '/api/admin' && route.match(/^\/runner-tickets\/[A-Za-z0-9-]+$/) && method === 'GET') {
      requireAdmin();
      const ticket = db.prepare('SELECT * FROM nb_runner_tickets WHERE code=?').get(decodeURIComponent(route.split('/')[2]));
      if (!ticket) fail(404, 'Ticket not found.');
      const messages = db.prepare('SELECT * FROM nb_runner_ticket_messages WHERE ticket_id=? ORDER BY created_at').all(ticket.id);
      send(res, 200, { ticket: { code: ticket.code, category: ticket.category, subject: ticket.subject, description: ticket.description, status: ticket.status, assignedAgent: ticket.assigned_agent, attachment: ticket.attachment, createdAt: ticket.created_at, updatedAt: ticket.updated_at, messages: messages.map((m) => ({ authorRole: m.author_role, authorName: m.author_name, body: m.body, at: m.created_at })) } });
      return true;
    }

    if (base === '/api/admin' && route.match(/^\/runner-tickets\/[A-Za-z0-9-]+\/(reply|status)$/) && method === 'POST') {
      const admin = requireAdmin();
      const parts = route.split('/');
      const ticket = db.prepare('SELECT * FROM nb_runner_tickets WHERE code=?').get(decodeURIComponent(parts[2]));
      if (!ticket) fail(404, 'Ticket not found.');
      if (parts[3] === 'status') {
        const status = String(payload.status || '');
        if (!['open', 'assigned', 'in_progress', 'awaiting_runner', 'resolved', 'closed'].includes(status)) fail(400, 'Unknown ticket status.');
        db.prepare('UPDATE nb_runner_tickets SET status=?,assigned_agent=COALESCE(?,assigned_agent),updated_at=? WHERE id=?').run(status, payload.agent ? String(payload.agent).slice(0, 80) : null, now(), ticket.id);
        audit('admin', admin.user_id, 'runner_ticket_status', 'ticket', ticket.id, status);
        send(res, 200, { message: `Ticket ${ticket.code} is now ${status}.` });
        return true;
      }
      if (!str(payload.body, 2, 2000)) fail(400, 'Write a reply of at least 2 characters.');
      transaction(() => {
        db.prepare('INSERT INTO nb_runner_ticket_messages(id,ticket_id,author_role,author_name,body,created_at) VALUES(?,?,?,?,?,?)').run(uid(), ticket.id, 'admin', admin.name, payload.body.trim(), now());
        db.prepare("UPDATE nb_runner_tickets SET status='awaiting_runner',updated_at=? WHERE id=? AND status NOT IN ('resolved','closed')").run(now(), ticket.id);
      });
      notify(ticket.user_id, 'Support replied to your safety report', `${ticket.code}: ${payload.body.trim().slice(0, 120)}`, 'support', '#/safety');
      audit('admin', admin.user_id, 'runner_ticket_reply', 'ticket', ticket.id, ticket.code);
      send(res, 200, { message: 'Reply sent to the runner.' });
      return true;
    }

    if (base === '/api/admin' && route === '/payouts' && method === 'GET') {
      requireAdmin();
      const rows = db.prepare(`SELECT p.*, u.name AS runner_name FROM nb_runner_payouts p JOIN nb_users u ON u.id=p.runner_id ORDER BY p.created_at DESC LIMIT 200`).all();
      send(res, 200, { payouts: rows.map((p) => ({ id: p.id, runner: p.runner_name, runnerId: p.runner_id, period: p.period_label, gross: p.gross_paise, adjustments: p.adjustments_paise, net: p.net_paise, status: p.status, reference: p.reference, createdAt: p.created_at, updatedAt: p.updated_at })) });
      return true;
    }

    if (base === '/api/admin' && route.match(/^\/payouts\/[a-zA-Z0-9-]+\/status$/) && method === 'POST') {
      const admin = requireAdmin();
      const id = route.split('/')[2];
      const payout = db.prepare('SELECT * FROM nb_runner_payouts WHERE id=?').get(id);
      if (!payout) fail(404, 'Payout not found.');
      const status = String(payload.status || '');
      if (!['pending', 'processing', 'completed', 'failed', 'on_hold'].includes(status)) fail(400, 'Unknown payout status.');
      const reference = payload.reference ? String(payload.reference).trim().slice(0, 80) : payout.reference;
      if (status === 'completed' && !reference) fail(400, 'A completed payout needs the bank/UPI reference.');
      db.prepare('UPDATE nb_runner_payouts SET status=?,reference=?,updated_at=? WHERE id=?').run(status, reference, now(), id);
      notify(payout.runner_id, 'Payout update', `Your payout for ${payout.period_label} (${'₹' + Math.round(payout.net_paise / 100)}) is now ${status}${reference ? ` · ref ${reference}` : ''}.`, 'payout', '#/payouts');
      audit('admin', admin.user_id, 'payout_status', 'payout', id, `${status}${reference ? ' · ' + reference : ''}`);
      send(res, 200, { message: `Payout marked ${status}.` });
      return true;
    }

    fail(404, 'API endpoint not found');
    return true;
  } catch (err) {
    if (!(err instanceof HttpError)) {
      console.error('[nearbuy] customer API error:', err);
    }
    if (!res.headersSent && !res.destroyed) {
      const status = err instanceof HttpError ? err.status : 500;
      send(res, status, {
        error: err instanceof HttpError ? err.message : 'Something went wrong on our side. Please try again.',
        ...(err instanceof HttpError && err.extra ? err.extra : {})
      });
    }
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Public config + payment webhook                                     */
/* ------------------------------------------------------------------ */

function publicConfig() {
  return {
    demo: DEMO,
    devCodes: DEV_CODES,
    payments: {
      gateway: GATEWAY.provider,
      onlineEnabled: GATEWAY.configured,
      cod: true,
      payAtStore: true,
      message: GATEWAY.configured
        ? 'Online payments are processed by Razorpay and confirmed by webhook.'
        : 'Online payments are not configured on this deployment. Cash on delivery and pay at store are available; add RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET to enable UPI and cards.'
    },
    integrations: {
      maps: false,
      mapsMessage: 'No map-tile provider is configured. Distances are straight-line estimates × 1.35 from the shop and locality coordinates, and the map view is a schematic of those coordinates.',
      sms: false,
      email: false,
      notificationsMessage: 'In-app notifications are real database records. SMS, email and WhatsApp providers are not configured, so nothing is sent externally.'
    },
    delivery: { otpRequired: true, handoverPinRequired: true, offerSeconds: Number(process.env.DELIVERY_OFFER_SECONDS || 180) }
  };
}

const WEBHOOK_EVENT_TARGET = Object.freeze({
  'payment.authorized': { target: 'pending', allowedEntityStatuses: new Set(['authorized', 'created']) },
  'payment.captured': { target: 'paid', allowedEntityStatuses: new Set(['captured']) },
  'payment.failed': { target: 'failed', allowedEntityStatuses: new Set(['failed']) }
});

const PAYMENT_TRANSITIONS = Object.freeze({
  created: new Set(['pending', 'failed', 'paid']),
  pending: new Set(['failed', 'paid']),
  failed: new Set(['paid']),
  cancelled: new Set(['paid']),
  superseded: new Set(['paid']),
  paid: new Set()
});

function deriveWebhookEventKey(req, event, raw, payment) {
  const headerId = String(req.headers['x-razorpay-event-id'] || '').trim();
  if (headerId) return `header:${headerId.slice(0, 160)}`;
  const bodyId = typeof event?.id === 'string' ? event.id.trim() : '';
  if (bodyId) return `event:${bodyId.slice(0, 160)}`;
  const eventName = typeof event?.event === 'string' ? event.event.trim() : 'unknown';
  const paymentId = typeof payment?.id === 'string' ? payment.id.trim() : '';
  const orderRef = typeof payment?.order_id === 'string' ? payment.order_id.trim() : '';
  const paymentStatus = typeof payment?.status === 'string' ? payment.status.trim().toLowerCase() : '';
  if (paymentId && orderRef) {
    return `payment:${eventName}:${orderRef}:${paymentId}:${paymentStatus}`;
  }
  return `hash:${sha(raw)}`;
}

async function paymentWebhook(req, res) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
  if (!secret) { send(res, 503, { error: 'Webhook not configured (RAZORPAY_WEBHOOK_SECRET is missing).' }); return; }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 131072) { send(res, 413, { error: 'Payload too large' }); return; }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  const provided = String(req.headers['x-razorpay-signature'] || '');
  if (!safeEqual(expected, provided)) { send(res, 401, { error: 'Invalid signature' }); return; }
  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Expected JSON object');
  } catch {
    send(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const eventName = typeof event.event === 'string' ? event.event.trim() : '';
  const eventSpec = Object.hasOwn(WEBHOOK_EVENT_TARGET, eventName) ? WEBHOOK_EVENT_TARGET[eventName] : null;
  if (!eventSpec) {
    send(res, 200, { ok: true, ignored: true, reason: 'unsupported_event' });
    return;
  }

  const payment = event?.payload?.payment?.entity;
  const gatewayOrderId = typeof payment?.order_id === 'string' ? payment.order_id.trim() : '';
  if (!payment || typeof payment !== 'object' || !gatewayOrderId) {
    send(res, 200, { ok: true, ignored: true, reason: 'missing_order_reference' });
    return;
  }

  const eventKey = deriveWebhookEventKey(req, event, raw, payment);
  const payloadHash = sha(raw);
  const gatewayPaymentId = typeof payment.id === 'string' ? payment.id.trim() : null;

  let outcome;
  transaction(() => {
    const ts = now();

    const existingEvent = db.prepare(
      "SELECT id, outcome FROM nb_payment_webhook_events WHERE provider='razorpay' AND event_key=?"
    ).get(eventKey);
    if (existingEvent) {
      outcome = { status: 200, body: { ok: true, duplicate: true } };
      return;
    }

    const record = db.prepare(
      "SELECT * FROM nb_payment_records WHERE provider='razorpay' AND reference=?"
    ).get(gatewayOrderId);
    if (!record) {
      outcome = { status: 200, body: { ok: true, ignored: true, reason: 'unknown_reference' } };
      return;
    }

    const order = db.prepare('SELECT * FROM nb_orders WHERE id=?').get(record.order_id);
    if (!order) {
      outcome = { status: 200, body: { ok: true, ignored: true, reason: 'unknown_order' } };
      return;
    }

    if (payment.status !== undefined && payment.status !== null) {
      const entityStatus = String(payment.status).trim().toLowerCase();
      if (!eventSpec.allowedEntityStatuses.has(entityStatus)) {
        audit('gateway', null, 'payment_webhook_rejected', 'order', order.id,
          `status_mismatch event=${eventName} status=${entityStatus} ref=${gatewayOrderId}`);
        outcome = { status: 400, body: { error: 'Payment status does not match webhook event.', code: 'status_mismatch' } };
        return;
      }
    }

    const currency = typeof payment.currency === 'string' ? payment.currency.trim().toUpperCase() : '';
    if (currency !== 'INR') {
      audit('gateway', null, 'payment_webhook_rejected', 'order', order.id,
        `currency_mismatch expected=INR got=${currency || 'missing'} ref=${gatewayOrderId}`);
      outcome = { status: 400, body: { error: 'Payment currency must be INR.', code: 'currency_mismatch' } };
      return;
    }

    const expectedAmount = Number(record.amount_paise);
    if (typeof payment.amount !== 'number' || !Number.isSafeInteger(payment.amount) || payment.amount <= 0 || payment.amount !== expectedAmount) {
      audit('gateway', null, 'payment_webhook_rejected', 'order', order.id,
        `amount_mismatch expected=${expectedAmount} got=${String(payment.amount)} ref=${gatewayOrderId}`);
      outcome = { status: 400, body: { error: 'Payment amount does not match the order total.', code: 'amount_mismatch' } };
      return;
    }

    const target = eventSpec.target;
    const currentStatus = record.status;

    const recordWebhookEvent = (eventOutcome) => {
      db.prepare(`INSERT INTO nb_payment_webhook_events
        (id,provider,event_key,event_name,payment_id,reference,payload_hash,outcome,created_at)
        VALUES(?,'razorpay',?,?,?,?,?,?,?)`).run(
        uid(), eventKey, eventName, gatewayPaymentId, gatewayOrderId, payloadHash, eventOutcome, ts
      );
    };

    if (currentStatus === target) {
      recordWebhookEvent('duplicate');
      outcome = { status: 200, body: { ok: true, duplicate: true } };
      return;
    }

    const allowedTargets = PAYMENT_TRANSITIONS[currentStatus] || new Set();
    const orderAlreadyPaid = order.payment_status === 'paid';
    if (!allowedTargets.has(target) || (orderAlreadyPaid && target !== 'paid')) {
      recordWebhookEvent('ignored_transition');
      audit('gateway', null, 'payment_transition_ignored', 'order', order.id,
        `${currentStatus} -> ${target} (${eventName}) ref=${gatewayOrderId}`);
      outcome = { status: 200, body: { ok: true, ignored: true, reason: 'invalid_transition' } };
      return;
    }

    if (target === 'paid') {
      db.prepare("UPDATE nb_payment_records SET status='paid',updated_at=? WHERE id=?").run(ts, record.id);
      db.prepare("UPDATE nb_payment_records SET status='superseded',updated_at=? WHERE order_id=? AND id<>? AND status IN ('pending','created')")
        .run(ts, record.order_id, record.id);
      if (!orderAlreadyPaid) {
        db.prepare("UPDATE nb_orders SET payment_status='paid',updated_at=? WHERE id=?").run(ts, record.order_id);
        notify(order.customer_id, 'Payment successful', `We received ₹${Math.round(record.amount_paise / 100)} for ${order.code}.`, 'payment', `#/orders/${order.code}`);
        const sellerOrders = db.prepare('SELECT * FROM nb_seller_orders WHERE order_id=? ORDER BY created_at, id').all(order.id);
        const derived = sellerOrders.length ? deriveStatus(sellerOrders) : order.status;
        const isFullyCancelled = ['cancelled', 'rejected'].includes(order.status) || derived === 'cancelled';
        const allocations = paymentAllocationsForRecord(record, sellerOrders);
        let totalRefunded = 0;
        if (sellerOrders.length) {
          const allocBySo = new Map(allocations.map((a) => [a.sellerOrderId, a.amountPaise]));
          for (const so of sellerOrders) {
            if (!['cancelled', 'rejected'].includes(so.status)) continue;
            const share = allocBySo.get(so.id) || 0;
            if (share <= 0) continue;
            const existingRefund = db.prepare(
              "SELECT id FROM nb_refunds WHERE seller_order_id=? AND return_id IS NULL AND status <> 'rejected' LIMIT 1"
            ).get(so.id);
            if (!existingRefund) {
              db.prepare(`INSERT INTO nb_refunds(id,return_id,order_id,seller_order_id,reason,amount_paise,status,reference,created_at,updated_at)
                VALUES(?,NULL,?,?,?,?,?,NULL,?,?)`)
                .run(uid(), order.id, so.id, so.status === 'rejected' ? 'rejection' : 'cancellation', share, 'processing', ts, ts);
              totalRefunded += share;
            }
          }
        } else if (isFullyCancelled && Number(record.amount_paise) > 0) {
          const existingRefund = db.prepare(
            "SELECT id FROM nb_refunds WHERE order_id=? AND return_id IS NULL AND status <> 'rejected' LIMIT 1"
          ).get(order.id);
          if (!existingRefund) {
            db.prepare(`INSERT INTO nb_refunds(id,return_id,order_id,seller_order_id,reason,amount_paise,status,reference,created_at,updated_at)
              VALUES(?,NULL,?,NULL,'cancellation',?,?,NULL,?,?)`)
              .run(uid(), order.id, record.amount_paise, 'processing', ts, ts);
            totalRefunded += Number(record.amount_paise);
          }
        }
        if (totalRefunded > 0) {
          notify(order.customer_id, 'Refund initiated', `₹${Math.round(totalRefunded / 100)} for ${isFullyCancelled ? 'cancelled order ' : ''}${order.code} is being returned to the original payment method.`, 'refund', '#/orders');
        }
      } else {
        const sellerOrders = db.prepare('SELECT * FROM nb_seller_orders WHERE order_id=? ORDER BY created_at, id').all(order.id);
        syncPaymentAllocations(record.id, order.id, sellerOrders, 0, ts);
        db.prepare(`INSERT INTO nb_refunds(id,return_id,order_id,seller_order_id,reason,amount_paise,status,reference,created_at,updated_at)
          VALUES(?,NULL,?,NULL,'duplicate_payment',?,?,NULL,?,?)`)
          .run(uid(), order.id, record.amount_paise, 'processing', ts, ts);
        notify(order.customer_id, 'Duplicate payment refund initiated', `₹${Math.round(record.amount_paise / 100)} from a duplicate payment for ${order.code} is being refunded.`, 'refund', '#/orders');
      }
      recordWebhookEvent('processed');
      audit('gateway', null, orderAlreadyPaid ? 'duplicate_payment_captured' : 'payment_captured', 'order', order.id, gatewayPaymentId || gatewayOrderId);
    } else if (target === 'failed') {
      db.prepare("UPDATE nb_payment_records SET status='failed',updated_at=? WHERE id=?").run(ts, record.id);
      notify(order.customer_id, 'Payment failed', `The gateway did not complete the payment for ${order.code}. No money was taken. You can try again.`, 'payment', `#/orders/${order.code}`);
      recordWebhookEvent('processed');
      audit('gateway', null, 'payment_failed', 'order', order.id, gatewayPaymentId || gatewayOrderId);
    } else if (target === 'pending') {
      db.prepare("UPDATE nb_payment_records SET status='pending',updated_at=? WHERE id=?").run(ts, record.id);
      recordWebhookEvent('processed');
      audit('gateway', null, 'payment_authorized', 'order', order.id, gatewayPaymentId || gatewayOrderId);
    }

    outcome = { status: 200, body: { ok: true } };
  });
  send(res, outcome.status, outcome.body);
}

module.exports = { handle };
