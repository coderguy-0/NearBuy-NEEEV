'use strict';
// Server-side order foundation. No payment or identity-verification provider is implied.
const { DatabaseSync } = require('node:sqlite');
const { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dbPath = process.env.NEARBUY_DB || path.join(__dirname, '..', 'data', 'orders.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, buyer_id TEXT NOT NULL REFERENCES users(id), seller_id TEXT NOT NULL REFERENCES users(id), runner_id TEXT REFERENCES users(id), status TEXT NOT NULL, method TEXT NOT NULL, address TEXT NOT NULL, items TEXT NOT NULL, payment TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id), status TEXT NOT NULL, detail TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id), order_id TEXT NOT NULL, message TEXT NOT NULL, created TEXT NOT NULL);
`);
const hash = s => createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const send = (res, code, body) => {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (code === 413) headers.Connection = 'close';
  res.writeHead(code, headers);
  res.end(JSON.stringify(body));
};
const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
const text = (v, max = 200) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', c => {
      if (settled) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      total += buf.length;
      if (total > 32768) {
        settled = true;
        req.resume();
        reject(Object.assign(new Error('Request too large'), { code: 413 }));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(raw || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('JSON object required'), { code: 400 }));
          return;
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { code: 400 }));
      }
    });
    req.on('error', err => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}
function account(req) {
  const token = (req.headers.authorization || '').match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) fail(401, 'Authentication required');
  const user = db.prepare('SELECT users.id, users.role, users.name FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=? AND sessions.expires>?').get(hash(token), Date.now());
  if (!user) fail(401, 'Session expired or invalid');
  return user;
}
function event(order, status, detail = '') {
  const date = now();
  db.prepare('INSERT INTO events(order_id,status,detail,created) VALUES(?,?,?,?)').run(order.id, status, detail, date);
  const ids = new Set([order.buyer_id, order.seller_id, order.runner_id].filter(Boolean));
  for (const id of ids) db.prepare('INSERT INTO notifications(user_id,order_id,message,created) VALUES(?,?,?,?)').run(id, order.id, `${status}${detail ? ': ' + detail : ''}`, date);
}
function publicOrder(o) { return { ...o, items: JSON.parse(o.items), history: db.prepare('SELECT status,detail,created FROM events WHERE order_id=? ORDER BY id').all(o.id) }; }
function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } }
const steps = {
  seller: { 'Order Received': ['Order Accepted', 'Order Rejected'], 'Order Accepted': ['Order Processing'], 'Order Processing': ['Ready for Pickup'], 'Ready for Pickup': ['Delivery Method Selected'], 'Delivery Method Selected': ['Runner Requested', 'Out for Delivery'] },
  runner: { 'Runner Assigned': ['Runner Accepted', 'Runner Rejected'], 'Runner Accepted': ['Reached Pickup Location'], 'Reached Pickup Location': ['Order Picked Up'], 'Order Picked Up': ['Out for Delivery'], 'Out for Delivery': ['Arriving Soon'] }
};
async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost'); const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) return false;
    if (req.method === 'POST' && pathname === '/api/register') {
      const b = await body(req);
      if (!text(b.name, 100) || !text(b.email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) || typeof b.password !== 'string' || b.password.length < 12 || b.password.length > 200 || !['buyer','seller','runner'].includes(b.role)) fail(400, 'Valid name, email, role and password of at least 12 characters required');
      const salt = randomBytes(16).toString('hex'); const password = salt + ':' + scryptSync(b.password, salt, 64).toString('hex'); const id = randomUUID();
      try { db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id, b.email.trim().toLowerCase(), password, b.role, b.name.trim()); } catch (e) { if (e.message.includes('UNIQUE')) fail(409, 'Email already registered'); throw e; }
      send(res, 201, { id, role: b.role }); return true;
    }
    if (req.method === 'POST' && pathname === '/api/login') {
      const b = await body(req); if (typeof b.email !== 'string' || typeof b.password !== 'string' || b.password.length > 200) fail(400, 'Email and password required');
      const u = db.prepare('SELECT * FROM users WHERE email=?').get(b.email.trim().toLowerCase());
      const [salt, digest] = (u?.password || '00000000000000000000000000000000:' + '0'.repeat(128)).split(':');
      const actual = scryptSync(b.password, salt, 64); if (!u || !timingSafeEqual(actual, Buffer.from(digest, 'hex'))) fail(401, 'Invalid credentials');
      const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), u.id, Date.now() + 86400000);
      send(res, 200, { token, id: u.id, role: u.role, name: u.name, expiresIn: 86400 }); return true;
    }
    const user = account(req);
    if (req.method === 'GET' && pathname === '/api/orders') {
      const col = {buyer:'buyer_id', seller:'seller_id', runner:'runner_id'}[user.role];
      send(res, 200, db.prepare(`SELECT * FROM orders WHERE ${col}=? ORDER BY created DESC`).all(user.id).map(publicOrder)); return true;
    }
    if (req.method === 'GET' && pathname === '/api/notifications') { send(res, 200, db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 200').all(user.id)); return true; }
    if (req.method === 'GET' && pathname === '/api/sellers') { send(res, 200, db.prepare("SELECT id,name FROM users WHERE role='seller' ORDER BY name").all()); return true; }
    if (req.method === 'GET' && pathname === '/api/runners') { if (user.role !== 'seller') fail(403, 'Seller access required'); send(res, 200, db.prepare("SELECT id,name FROM users WHERE role='runner' AND id NOT IN (SELECT runner_id FROM orders WHERE runner_id IS NOT NULL AND status NOT IN ('Delivered','Cancelled','Order Rejected','Runner Rejected')) ORDER BY name").all()); return true; }
    if (req.method === 'POST' && pathname === '/api/orders') {
      if (user.role !== 'buyer') fail(403, 'Buyer access required'); const b = await body(req);
      if (typeof b.sellerId !== 'string' || !db.prepare("SELECT id FROM users WHERE id=? AND role='seller'").get(b.sellerId) || !text(b.address, 500) || !['delivery','pickup'].includes(b.method) || !Array.isArray(b.items) || !b.items.length || b.items.length > 100 || b.items.some(i => !i || typeof i !== 'object' || !text(i.name, 200) || !Number.isSafeInteger(i.quantity) || i.quantity < 1 || i.quantity > 1000)) fail(400, 'Valid seller, address, method and items required');
      const order = { id: randomUUID(), buyer_id:user.id, seller_id:b.sellerId, runner_id:null, status:'Order Received', method:b.method, address:b.address.trim(), items:JSON.stringify(b.items.map(i => ({name:i.name.trim(), quantity:i.quantity}))), payment:'Not processed', created:now() };
      transaction(() => { db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?,?)').run(...Object.values(order)); event(order, 'Order Placed'); event(order, 'Order Received'); });
      send(res, 201, publicOrder(order)); return true;
    }
    const match = pathname.match(/^\/api\/orders\/([0-9a-f-]+)\/(transition|assign)$/);
    if (req.method === 'POST' && match) {
      const b = await body(req);
      const result = transaction(() => {
        const o = db.prepare('SELECT * FROM orders WHERE id=?').get(match[1]); if (!o) fail(404, 'Order not found');
        if (match[2] === 'assign') {
          if (user.role !== 'seller' || o.seller_id !== user.id) fail(403, 'Not your order');
          if (o.status !== 'Runner Requested' || o.runner_id) fail(409, 'Order is not awaiting assignment');
          const r = typeof b.runnerId === 'string' ? db.prepare("SELECT id FROM users WHERE id=? AND role='runner'").get(b.runnerId) : null; if (!r) fail(400, 'Runner not found');
          if (db.prepare("SELECT id FROM orders WHERE runner_id=? AND status NOT IN ('Delivered','Cancelled','Order Rejected','Runner Rejected')").get(r.id)) fail(409, 'Runner is busy');
          o.runner_id = r.id; o.status = 'Runner Assigned'; db.prepare('UPDATE orders SET runner_id=?,status=? WHERE id=?').run(o.runner_id,o.status,o.id); event(o,o.status); return publicOrder(o);
        }
        if ((user.role === 'seller' && o.seller_id !== user.id) || (user.role === 'runner' && o.runner_id !== user.id) || user.role === 'buyer') fail(403, 'Not authorised');
        if (!steps[user.role]?.[o.status]?.includes(b.status)) fail(409, 'Invalid status transition');
        // Do not record an unverified collection as a completed handover.
        if (b.status === 'Order Picked Up') fail(501, 'Pickup verification is not configured');
        if (b.status === 'Order Rejected' && !text(b.detail, 500)) fail(400, 'Rejection reason required');
        if (b.status === 'Delivery Method Selected' && (o.method !== 'delivery' || !['self','runner'].includes(b.deliveryMethod))) fail(400, 'Choose self or runner delivery');
        if (b.status === 'Delivery Method Selected') o.method = b.deliveryMethod;
        if (b.status === 'Runner Requested' && o.method !== 'runner') fail(409, 'Runner delivery not selected');
        if (b.status === 'Out for Delivery' && user.role === 'seller' && o.method !== 'self') fail(409, 'Self delivery not selected');
        o.status = b.status; db.prepare('UPDATE orders SET status=?,method=? WHERE id=?').run(o.status,o.method,o.id); event(o,o.status, text(b.detail,500) ? b.detail.trim() : '');
        if (o.status === 'Runner Rejected') { o.runner_id = null; o.status = 'Runner Requested'; db.prepare('UPDATE orders SET status=?,runner_id=NULL WHERE id=?').run(o.status,o.id); event(o,o.status, 'Runner declined; choose another runner'); }
        return publicOrder(o);
      }); send(res, 200, result); return true;
    }
    fail(404, 'API endpoint not found');
  } catch (e) { if (!res.headersSent && !res.destroyed) send(res, e.code || 500, { error: e.code ? e.message : 'Internal server error' }); return true; }
}
module.exports = { handle };
