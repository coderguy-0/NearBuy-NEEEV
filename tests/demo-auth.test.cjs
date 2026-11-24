'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-demo-'));
const env = { ...process.env, PORT: '4227', NODE_ENV: 'development', SEED_DEMO: '1', DEMO_SANDBOX: '1', NEARBUY_DB: path.join(dir, 'demo.sqlite') };
let server;
const cookies = new Map();
async function req(route, body, csrf) {
  const res = await fetch('http://127.0.0.1:4227' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: [...cookies.values()].join('; '), 'Content-Type': 'application/json', 'X-NearBuy-Request': '1', ...(csrf ? { 'X-NearBuy-CSRF': csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  for (const cookie of res.headers.getSetCookie()) { const pair = cookie.split(';')[0]; cookies.set(pair.split('=')[0], pair); }
  return { status: res.status, data: await res.json() };
}
before(async () => {
  server = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout')), 15000);
    server.stdout.on('data', data => { if (String(data).includes('http://')) { clearTimeout(timer); resolve(); } });
    server.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code)); });
  });
});
after(() => { server?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
test('four real demo sessions restore, switch and mutate with coexisting browser cookies', async () => {
  assert.equal((await req('/api/customer/auth/demo')).data.enabled, true);
  const definitions = [
    ['customer', '/api/customer/auth/me', '/api/customer/auth/logout'],
    ['seller', '/api/partner/me', '/api/partner/logout'],
    ['runner', '/api/partner/me', '/api/partner/logout'],
    ['admin', '/api/admin/me', '/api/admin/logout']
  ];
  for (const [role, me] of definitions) {
    const login = await req('/api/customer/auth/demo', { role });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    assert.equal(login.data.portal, '/' + role + '/');
    const restored = await req(me);
    assert.equal(restored.data.user.role, role);
    assert.equal((await req(me)).data.user.id, restored.data.user.id);
  }
  // Customer + partner + admin cookies coexist, as in a real browser.
  const admin = (await req('/api/admin/me')).data.user;
  assert.equal((await req('/api/admin/logout', {}, 'incorrect-token')).status, 403);
  assert.equal((await req('/api/admin/logout', {}, admin.csrf)).status, 200);
  assert.equal((await req('/api/admin/me')).data.user, null);
  const partner = (await req('/api/partner/me')).data.user;
  assert.equal((await req('/api/partner/logout', {}, partner.csrf)).status, 200);
  const customer = (await req('/api/customer/auth/me')).data.user;
  assert.equal((await req('/api/customer/auth/logout', {}, customer.csrf)).status, 200);
  for (const [role, me, logout] of definitions) {
    assert.equal((await req('/api/customer/auth/demo', { role })).status, 200);
    const user = (await req(me)).data.user;
    assert.equal((await req(logout, {}, user.csrf)).status, 200);
  }
  assert.equal((await req('/api/customer/auth/demo', { role: 'superadmin' })).status, 400);
});
test('administrative seed is repeatable without duplicating accounts or orders', () => {
  for (let i = 0; i < 2; i++) {
    const run = spawnSync(process.execPath, ['tools/seed-demo.cjs'], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /verified\/repaired/);
  }
  const run = spawnSync(process.execPath, ['-e', `const {db}=require('./server/customer/db'); console.log(db.prepare("SELECT count(*) n FROM nb_users WHERE email='admin@nearbuy.demo'").get().n)`], { env, encoding: 'utf8' });
  assert.equal(run.stdout.trim(), '1');
});
test('seller and runner login forms reject accounts belonging to the other portal', async () => {
  assert.equal((await req('/api/partner/login', { email: 'rohan@nearbuy.demo', password: 'Runner123!', role: 'seller' })).status, 403);
  assert.equal((await req('/api/partner/login', { email: 'owner@nearbuy.demo', password: 'Seller123!', role: 'runner' })).status, 403);
  for (const [role, email, password] of [['seller', 'owner@nearbuy.demo', 'Seller123!'], ['runner', 'rohan@nearbuy.demo', 'Runner123!']]) {
    const login = await req('/api/partner/login', { role, email, password });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.role, role);
  }
});
test('demo admin cannot read a mixed real/demo database', async () => {
  assert.equal((await req('/api/customer/auth/demo', { role: 'admin' })).status, 200);
  const insert = spawnSync(process.execPath, ['-e', `const {db,uid,now,makePassword}=require('./server/customer/db'); db.prepare("INSERT INTO nb_users(id,role,name,email,password_hash,is_demo,created_at) VALUES(?,'customer','Real account','real@example.test',?,0,?)").run(uid(),makePassword('Testing123!'),now());`], { env, encoding: 'utf8' });
  assert.equal(insert.status, 0, insert.stderr);
  assert.equal((await req('/api/customer/auth/demo')).data.enabled, false);
  assert.equal((await req('/api/customer/auth/demo', { role: 'admin' })).status, 403);
  assert.equal((await req('/api/admin/overview')).status, 403);
  const seed = spawnSync(process.execPath, ['tools/seed-demo.cjs'], { env, encoding: 'utf8' });
  assert.notEqual(seed.status, 0);
});
