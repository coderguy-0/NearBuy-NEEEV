'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('orders are scoped to participants and transitions and assignments are validated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearbuy-test-'));
  const port = 4201;
  const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NEARBUY_DB: path.join(dir, 'test.sqlite') }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const request = async (url, token, data) => { const r = await fetch(base + url, { method: data ? 'POST' : 'GET', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined }); return [r.status, await r.json()]; };
  try {
    for (let i=0; i<100; i++) { try { await fetch(base); break; } catch { await new Promise(r => setTimeout(r, 40)); } }
    async function create(role, name) {
      const details = { role, name, email: `${name}@example.com`, password: 'a long password!' };
      assert.equal((await request('/api/register', null, details))[0], 201);
      const [status, session] = await request('/api/login', null, details); assert.equal(status, 200); return session;
    }
    const buyer = await create('buyer','buyer'), seller = await create('seller','seller'), other = await create('seller','other'), runner = await create('runner','runner');
    let [status, order] = await request('/api/orders', buyer.token, { sellerId: seller.id, address:'123 Main Street', method:'delivery', items:[{name:'Rice',quantity:2}] });
    assert.equal(status, 201); assert.equal(order.status, 'Order Received');
    assert.equal((await request('/api/orders', other.token))[1].length, 0);
    assert.equal((await request(`/api/orders/${order.id}/transition`, other.token, {status:'Order Accepted'}))[0], 403);
    assert.equal((await request(`/api/orders/${order.id}/transition`, seller.token, {status:'Ready for Pickup'}))[0], 409);
    for (const next of ['Order Accepted','Order Processing','Ready for Pickup']) assert.equal((await request(`/api/orders/${order.id}/transition`, seller.token, {status:next}))[0], 200);
    assert.equal((await request(`/api/orders/${order.id}/transition`, seller.token, {status:'Delivery Method Selected',deliveryMethod:'runner'}))[0], 200);
    assert.equal((await request(`/api/orders/${order.id}/transition`, seller.token, {status:'Runner Requested'}))[0], 200);
    assert.equal((await request(`/api/orders/${order.id}/assign`, seller.token, {runnerId:runner.id}))[0], 200);
    assert.equal((await request(`/api/orders/${order.id}/assign`, seller.token, {runnerId:runner.id}))[0], 409);
    assert.equal((await request('/api/orders', runner.token))[1][0].id, order.id);
    assert.ok((await request('/api/notifications', buyer.token))[1].some(n => n.message === 'Runner Assigned'));
    assert.equal((await fetch(base + '/data/orders.sqlite')).status, 400);

    // Malformed / non-object / wrong-type inputs return 400 rather than crashing SQLite (500)
    for (const raw of ['null', '[]', '"hello"', '42', '{bad']) {
      const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
      assert.equal(r.status, 400, `expected 400 for body ${raw}`);
    }
    assert.equal((await request('/api/orders', buyer.token, { sellerId: { bad: 1 }, address: '123 Main', method: 'pickup', items: [{ name: 'Tea', quantity: 1 }] }))[0], 400);
    assert.equal((await request('/api/orders', buyer.token, { sellerId: seller.id, address: '123 Main', method: 'pickup', items: ['not-an-object'] }))[0], 400);

    let [s2, o2] = await request('/api/orders', buyer.token, {
      sellerId: seller.id,
      address: 'हौज़ ख़ास मार्केट · ₹150 lane',
      method: 'delivery',
      items: [{ name: 'मसाला चाय · Masala Chai', quantity: 2 }]
    });
    assert.equal(s2, 201);
    assert.equal(o2.address, 'हौज़ ख़ास मार्केट · ₹150 lane');
    assert.equal(o2.items[0].name, 'मसाला चाय · Masala Chai');
    for (const next of ['Order Accepted', 'Order Processing', 'Ready for Pickup']) {
      assert.equal((await request(`/api/orders/${o2.id}/transition`, seller.token, { status: next }))[0], 200);
    }
    assert.equal((await request(`/api/orders/${o2.id}/transition`, seller.token, { status: 'Delivery Method Selected', deliveryMethod: 'runner' }))[0], 200);
    assert.equal((await request(`/api/orders/${o2.id}/transition`, seller.token, { status: 'Runner Requested' }))[0], 200);
    assert.equal((await request(`/api/orders/${o2.id}/assign`, seller.token, { runnerId: { bad: true } }))[0], 400);

    // Payloads larger than 64 KiB receive a clean HTTP 413 response
    const huge = JSON.stringify({ pad: 'x'.repeat(70000) });
    const tooLarge = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: huge });
    assert.equal(tooLarge.status, 413);
  } finally { child.kill(); fs.rmSync(dir, {recursive:true, force:true}); }
});
