'use strict';
// Administrative command only. Never point this at a live/customer database.
if (process.env.SEED_DEMO !== '1') throw new Error('Set SEED_DEMO=1 and NEARBUY_DB to a dedicated sandbox database.');
const { db, uid, now, makePassword, transaction } = require('../server/customer/db');
if (db.prepare('SELECT 1 FROM nb_users WHERE is_demo=0 LIMIT 1').get() || db.prepare('SELECT 1 FROM nb_orders WHERE is_demo=0 LIMIT 1').get()) throw new Error('Refusing to seed a database containing real users.');
const result = require('../server/customer/seed')();
transaction(() => {
  for (const [role, name, email, password] of [
    ['customer', 'Priya Sharma', 'customer@nearbuy.demo', 'Customer123!'],
    ['seller', 'Riya Sharma', 'owner@nearbuy.demo', 'Seller123!'],
    ['runner', 'Rohan Kumar', 'rohan@nearbuy.demo', 'Runner123!'],
    ['admin', 'Ops Desk', 'admin@nearbuy.demo', 'Admin123!']
  ]) {
    let user = db.prepare('SELECT * FROM nb_users WHERE email=?').get(email);
    if (user && (!user.is_demo || user.role !== role)) throw new Error(`Unsafe role/identity conflict for ${email}; review manually.`);
    if (!user) {
      const id = uid();
      db.prepare("INSERT INTO nb_users(id,role,name,email,password_hash,email_verified,phone_verified,status,is_demo,created_at) VALUES(?,?,?,?,?,1,1,'active',1,?)").run(id, role, name, email, makePassword(password), now());
      user = { id };
    }
    // Repair credentials only with an explicit operator choice; do not silently
    // reactivate suspended accounts or reset changed passwords at every startup.
    if (process.env.RESET_DEMO_PASSWORDS === '1') db.prepare('UPDATE nb_users SET password_hash=? WHERE id=?').run(makePassword(password), user.id);
    if (role === 'customer') db.prepare('INSERT OR IGNORE INTO nb_customer_profiles(user_id,created_at) VALUES(?,?)').run(user.id, now());
    if (role === 'runner') db.prepare("INSERT OR IGNORE INTO nb_runners(user_id,vehicle,status,active) VALUES(?,'scooter','online',1)").run(user.id);
    if (role === 'seller') {
      const shop = db.prepare("SELECT * FROM nb_shops WHERE slug='fresh-mart'").get();
      if (!shop) throw new Error('Fresh Mart is missing. Restore the sandbox catalogue from backup; no existing data was overwritten.');
      if (shop.owner_user_id && shop.owner_user_id !== user.id) throw new Error('Fresh Mart already has another owner; refusing to reassign it.');
      db.prepare('UPDATE nb_shops SET owner_user_id=? WHERE id=?').run(user.id, shop.id);
    }
  }
});
console.log(JSON.stringify({ ...result, accounts: 'Four demo identities verified/repaired. Existing catalogue and orders preserved.' }));
