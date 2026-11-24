'use strict';
/*
 * NearBuy Customer Portal — shared platform database.
 *
 * One Node process, one SQLite file (NEARBUY_DB), one set of customer, seller,
 * runner, catalogue, order and payment records. The legacy `server/orders.js`
 * foundation keeps its own legacy tables in the same file; every table created
 * here is prefixed `nb_` so the two can never overwrite each other.
 *
 * Zero npm dependencies: node:sqlite (Node 22.5+) and node:crypto only.
 */
const { DatabaseSync } = require('node:sqlite');
const { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dbPath = process.env.NEARBUY_DB || path.join(__dirname, '..', '..', 'data', 'orders.sqlite');
const dataDir = path.dirname(dbPath);
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(dbPath);

db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS nb_users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('customer','seller','runner','admin')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  avatar TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nb_customer_profiles (
  user_id TEXT PRIMARY KEY REFERENCES nb_users(id) ON DELETE CASCADE,
  marketing_opt_in INTEGER NOT NULL DEFAULT 1,
  order_updates INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nb_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES nb_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS nb_addresses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES nb_users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  receiver TEXT NOT NULL,
  phone TEXT NOT NULL,
  line1 TEXT NOT NULL,
  line2 TEXT,
  locality TEXT NOT NULL,
  city TEXT NOT NULL,
  pincode TEXT NOT NULL,
  landmark TEXT,
  instructions TEXT,
  lat REAL,
  lng REAL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_addr_user ON nb_addresses(user_id);

CREATE TABLE IF NOT EXISTS nb_service_areas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pincode TEXT NOT NULL,
  locality TEXT NOT NULL,
  city TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_area_pin ON nb_service_areas(pincode);

CREATE TABLE IF NOT EXISTS nb_categories (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT 'blue',
  parent_slug TEXT REFERENCES nb_categories(slug),
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS nb_shops (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  owner_user_id TEXT REFERENCES nb_users(id),
  name TEXT NOT NULL,
  category_slug TEXT NOT NULL REFERENCES nb_categories(slug),
  tagline TEXT,
  description TEXT,
  emoji TEXT,
  tone TEXT NOT NULL DEFAULT 'blue',
  phone TEXT,
  address TEXT NOT NULL,
  locality TEXT NOT NULL,
  city TEXT NOT NULL,
  pincode TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  rating REAL NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  is_open INTEGER NOT NULL DEFAULT 1,
  opens_at TEXT NOT NULL DEFAULT '08:00',
  closes_at TEXT NOT NULL DEFAULT '22:00',
  prep_minutes INTEGER NOT NULL DEFAULT 15,
  delivery_enabled INTEGER NOT NULL DEFAULT 1,
  pickup_enabled INTEGER NOT NULL DEFAULT 1,
  delivery_fee_paise INTEGER NOT NULL DEFAULT 0,
  free_delivery_over_paise INTEGER,
  pickup_fee_paise INTEGER NOT NULL DEFAULT 0,
  min_order_paise INTEGER NOT NULL DEFAULT 0,
  radius_km REAL NOT NULL DEFAULT 5,
  service_pincodes TEXT NOT NULL DEFAULT '',
  badge TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_cat ON nb_shops(category_slug);

CREATE TABLE IF NOT EXISTS nb_products (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES nb_shops(id) ON DELETE CASCADE,
  category_slug TEXT NOT NULL REFERENCES nb_categories(slug),
  compare_key TEXT NOT NULL,
  name TEXT NOT NULL,
  brand TEXT,
  variant TEXT,
  description TEXT,
  highlights TEXT NOT NULL DEFAULT '[]',
  specs TEXT NOT NULL DEFAULT '[]',
  unit TEXT NOT NULL DEFAULT '1 pc',
  pack_size TEXT,
  emoji TEXT,
  image_url TEXT,
  price_paise INTEGER NOT NULL,
  mrp_paise INTEGER,
  tax_rate REAL NOT NULL DEFAULT 5,
  stock INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  low_stock INTEGER NOT NULL DEFAULT 5,
  return_days INTEGER NOT NULL DEFAULT 0,
  rating REAL NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prod_shop ON nb_products(shop_id);
CREATE INDEX IF NOT EXISTS idx_prod_cat ON nb_products(category_slug);
CREATE INDEX IF NOT EXISTS idx_prod_compare ON nb_products(compare_key);
CREATE INDEX IF NOT EXISTS idx_prod_name ON nb_products(name);

CREATE TABLE IF NOT EXISTS nb_product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES nb_products(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nb_carts (
  user_id TEXT PRIMARY KEY REFERENCES nb_users(id) ON DELETE CASCADE,
  coupon_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nb_cart_items (
  user_id TEXT NOT NULL REFERENCES nb_users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES nb_products(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS nb_coupons (
  code TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('percent','fixed','free_delivery')),
  value INTEGER NOT NULL DEFAULT 0,
  min_order_paise INTEGER NOT NULL DEFAULT 0,
  max_discount_paise INTEGER,
  shop_id TEXT REFERENCES nb_shops(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  usage_limit INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  per_customer_limit INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS nb_coupon_redemptions (
  id TEXT PRIMARY KEY,
  coupon_code TEXT NOT NULL REFERENCES nb_coupons(code),
  user_id TEXT NOT NULL REFERENCES nb_users(id),
  order_id TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nb_orders (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES nb_users(id),
  status TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  address_json TEXT NOT NULL,
  subtotal_paise INTEGER NOT NULL,
  discount_paise INTEGER NOT NULL DEFAULT 0,
  delivery_fee_paise INTEGER NOT NULL DEFAULT 0,
  tax_paise INTEGER NOT NULL DEFAULT 0,
  total_paise INTEGER NOT NULL,
  coupon_code TEXT,
  note TEXT,
  idempotency_key TEXT UNIQUE,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_customer ON nb_orders(customer_id, created_at);

CREATE TABLE IF NOT EXISTS nb_seller_orders (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  order_id TEXT NOT NULL REFERENCES nb_orders(id) ON DELETE CASCADE,
  shop_id TEXT NOT NULL REFERENCES nb_shops(id),
  status TEXT NOT NULL,
  fulfillment TEXT NOT NULL CHECK (fulfillment IN ('delivery','pickup')),
  subtotal_paise INTEGER NOT NULL,
  discount_paise INTEGER NOT NULL DEFAULT 0,
  delivery_fee_paise INTEGER NOT NULL DEFAULT 0,
  tax_paise INTEGER NOT NULL DEFAULT 0,
  total_paise INTEGER NOT NULL,
  prep_minutes INTEGER NOT NULL DEFAULT 15,
  ready_at TEXT,
  accepted_at TEXT,
  rejected_reason TEXT,
  cancelled_at TEXT,
  delivered_at TEXT,
  completed_at TEXT,
  runner_id TEXT REFERENCES nb_users(id),
  delivery_otp_expires TEXT,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_so_order ON nb_seller_orders(order_id);
CREATE INDEX IF NOT EXISTS idx_so_shop ON nb_seller_orders(shop_id, created_at);

CREATE TABLE IF NOT EXISTS nb_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES nb_orders(id) ON DELETE CASCADE,
  seller_order_id TEXT NOT NULL REFERENCES nb_seller_orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  name TEXT NOT NULL,
  brand TEXT,
  unit TEXT,
  qty INTEGER NOT NULL,
  price_paise INTEGER NOT NULL,
  mrp_paise INTEGER,
  tax_rate REAL NOT NULL DEFAULT 0,
  line_total_paise INTEGER NOT NULL,
  image_url TEXT,
  emoji TEXT,
  compare_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_item_order ON nb_order_items(order_id);

CREATE TABLE IF NOT EXISTS nb_order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  seller_order_id TEXT,
  status TEXT NOT NULL,
  label TEXT NOT NULL,
  detail TEXT,
  actor TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_order ON nb_order_events(order_id);

CREATE TABLE IF NOT EXISTS nb_payment_records (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES nb_orders(id) ON DELETE CASCADE,
  seller_order_id TEXT,
  provider TEXT NOT NULL,
  method TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  status TEXT NOT NULL,
  reference TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_order ON nb_payment_records(order_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_provider_ref ON nb_payment_records(provider, reference) WHERE reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_active_intent ON nb_payment_records(order_id, provider) WHERE provider='razorpay' AND reference IS NOT NULL AND status IN ('created','pending');

CREATE TABLE IF NOT EXISTS nb_payment_allocations (
  id TEXT PRIMARY KEY,
  payment_record_id TEXT NOT NULL REFERENCES nb_payment_records(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES nb_orders(id) ON DELETE CASCADE,
  seller_order_id TEXT NOT NULL REFERENCES nb_seller_orders(id) ON DELETE CASCADE,
  shop_id TEXT NOT NULL REFERENCES nb_shops(id),
  amount_paise INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (payment_record_id, seller_order_id)
);
CREATE INDEX IF NOT EXISTS idx_pay_alloc_shop ON nb_payment_allocations(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pay_alloc_so ON nb_payment_allocations(seller_order_id);
CREATE INDEX IF NOT EXISTS idx_pay_alloc_pr ON nb_payment_allocations(payment_record_id);

CREATE TABLE IF NOT EXISTS nb_payment_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_name TEXT NOT NULL,
  payment_id TEXT,
  reference TEXT,
  payload_hash TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, event_key)
);
CREATE INDEX IF NOT EXISTS idx_webhook_ref ON nb_payment_webhook_events(provider, reference, created_at);

CREATE TABLE IF NOT EXISTS nb_delivery_assignments (
  id TEXT PRIMARY KEY,
  seller_order_id TEXT NOT NULL REFERENCES nb_seller_orders(id) ON DELETE CASCADE,
  shop_id TEXT NOT NULL,
  runner_id TEXT NOT NULL REFERENCES nb_users(id),
  status TEXT NOT NULL,
  payout_paise INTEGER NOT NULL DEFAULT 0,
  distance_km REAL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  responded_at TEXT,
  picked_up_at TEXT,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_assign_runner ON nb_delivery_assignments(runner_id, status);

CREATE TABLE IF NOT EXISTS nb_delivery_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  lat REAL,
  lng REAL,
  actor TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nb_returns (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  seller_order_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  comment TEXT,
  images_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  refund_amount_paise INTEGER NOT NULL DEFAULT 0,
  decision_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_returns_cust ON nb_returns(customer_id, created_at);

CREATE TABLE IF NOT EXISTS nb_refunds (
  id TEXT PRIMARY KEY,
  return_id TEXT,
  order_id TEXT NOT NULL,
  seller_order_id TEXT REFERENCES nb_seller_orders(id) ON DELETE SET NULL,
  reason TEXT,
  amount_paise INTEGER NOT NULL,
  status TEXT NOT NULL,
  reference TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nb_reviews (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  product_id TEXT,
  seller_order_id TEXT,
  order_id TEXT,
  shop_rating INTEGER,
  product_rating INTEGER,
  title TEXT,
  body TEXT,
  images_json TEXT NOT NULL DEFAULT '[]',
  verified_purchase INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL,
  UNIQUE (customer_id, product_id, seller_order_id)
);
CREATE INDEX IF NOT EXISTS idx_review_product ON nb_reviews(product_id);

CREATE TABLE IF NOT EXISTS nb_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES nb_users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'order',
  link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON nb_notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS nb_tickets (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL,
  order_id TEXT,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  attachment TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nb_ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES nb_tickets(id) ON DELETE CASCADE,
  author_role TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nb_wishlist (
  user_id TEXT NOT NULL REFERENCES nb_users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES nb_products(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS nb_banners (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT,
  eyebrow TEXT,
  cta_label TEXT,
  cta_link TEXT,
  image_url TEXT,
  theme TEXT NOT NULL DEFAULT 'blue',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nb_faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nb_otp_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES nb_users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  purpose TEXT NOT NULL,
  target TEXT,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nb_password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES nb_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS nb_enquiries (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  topic TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nb_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nb_runners (
  user_id TEXT PRIMARY KEY REFERENCES nb_users(id) ON DELETE CASCADE,
  vehicle TEXT NOT NULL DEFAULT 'scooter',
  status TEXT NOT NULL DEFAULT 'offline',
  lat REAL,
  lng REAL,
  rating REAL NOT NULL DEFAULT 4.8,
  completed INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

/* ------------------------------------------------------------------ */
/* Seller Hub extension tables (shared DB, seller/shop scoped)         */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS nb_seller_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES nb_users(id) ON DELETE CASCADE,
  shop_id TEXT REFERENCES nb_shops(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'documents_pending',
  legal_name TEXT,
  business_category TEXT,
  shop_type TEXT,
  description TEXT,
  address TEXT,
  pincode TEXT,
  city TEXT,
  state TEXT,
  country TEXT DEFAULT 'India',
  lat REAL,
  lng REAL,
  contact_number TEXT,
  business_email TEXT,
  ownership_type TEXT,
  pan_number TEXT,
  gst_number TEXT,
  reason TEXT,
  submitted_at TEXT,
  reviewed_at TEXT,
  reviewer_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verif_user ON nb_seller_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_verif_status ON nb_seller_verifications(status);

CREATE TABLE IF NOT EXISTS nb_seller_documents (
  id TEXT PRIMARY KEY,
  verification_id TEXT NOT NULL REFERENCES nb_seller_verifications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  shop_id TEXT,
  doc_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT,
  file_size INTEGER,
  storage_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_docs_verif ON nb_seller_documents(verification_id);

CREATE TABLE IF NOT EXISTS nb_shop_hours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL REFERENCES nb_shops(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL,
  open_time TEXT NOT NULL DEFAULT '09:00',
  close_time TEXT NOT NULL DEFAULT '21:00',
  break_start TEXT,
  break_end TEXT,
  shifts_json TEXT NOT NULL DEFAULT '[]',
  closed INTEGER NOT NULL DEFAULT 0,
  holiday_date TEXT,
  holiday_label TEXT,
  UNIQUE (shop_id, day_of_week, holiday_date)
);
CREATE INDEX IF NOT EXISTS idx_hours_shop ON nb_shop_hours(shop_id);

CREATE TABLE IF NOT EXISTS nb_shop_service_areas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL REFERENCES nb_shops(id) ON DELETE CASCADE,
  pincode TEXT NOT NULL,
  locality TEXT,
  city TEXT,
  lat REAL,
  lng REAL,
  radius_km REAL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (shop_id, pincode)
);

CREATE TABLE IF NOT EXISTS nb_inventory_transactions (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  actor_user_id TEXT,
  actor_name TEXT,
  type TEXT NOT NULL,
  previous_qty INTEGER NOT NULL,
  new_qty INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inv_shop ON nb_inventory_transactions(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inv_product ON nb_inventory_transactions(product_id, created_at);

CREATE TABLE IF NOT EXISTS nb_scanner_devices (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES nb_shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  device_type TEXT NOT NULL DEFAULT 'usb_keyboard',
  status TEXT NOT NULL DEFAULT 'registered',
  last_active_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scanner_shop ON nb_scanner_devices(shop_id);

CREATE TABLE IF NOT EXISTS nb_scanner_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL,
  device_id TEXT,
  code TEXT NOT NULL,
  product_id TEXT,
  order_code TEXT,
  action TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  actor_user_id TEXT,
  quantity INTEGER,
  reason TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_scan_shop ON nb_scanner_events(shop_id, created_at);

CREATE TABLE IF NOT EXISTS nb_packing_items (
  id TEXT PRIMARY KEY,
  seller_order_id TEXT NOT NULL REFERENCES nb_seller_orders(id) ON DELETE CASCADE,
  order_item_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  ordered_qty INTEGER NOT NULL,
  packed_qty INTEGER NOT NULL DEFAULT 0,
  missing_qty INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (seller_order_id, order_item_id)
);

CREATE TABLE IF NOT EXISTS nb_settlements (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL REFERENCES nb_shops(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  gross_paise INTEGER NOT NULL DEFAULT 0,
  refunds_paise INTEGER NOT NULL DEFAULT 0,
  commission_paise INTEGER NOT NULL DEFAULT 0,
  adjustments_paise INTEGER NOT NULL DEFAULT 0,
  net_paise INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  bank_reference TEXT,
  payout_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settle_shop ON nb_settlements(shop_id, created_at);

CREATE TABLE IF NOT EXISTS nb_settlement_items (
  id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES nb_settlements(id) ON DELETE CASCADE,
  seller_order_id TEXT NOT NULL,
  gross_paise INTEGER NOT NULL DEFAULT 0,
  refund_paise INTEGER NOT NULL DEFAULT 0,
  commission_paise INTEGER NOT NULL DEFAULT 0,
  net_paise INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nb_shop_staff (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES nb_shops(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL UNIQUE REFERENCES nb_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'sales_staff',
  permissions_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_staff_shop ON nb_shop_staff(shop_id);

CREATE TABLE IF NOT EXISTS nb_seller_tickets (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES nb_users(id) ON DELETE CASCADE,
  shop_id TEXT NOT NULL REFERENCES nb_shops(id) ON DELETE CASCADE,
  order_code TEXT,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  attachment TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  assigned_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sticket_user ON nb_seller_tickets(user_id, created_at);

CREATE TABLE IF NOT EXISTS nb_seller_ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES nb_seller_tickets(id) ON DELETE CASCADE,
  author_role TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nb_order_receipts (
  id TEXT PRIMARY KEY,
  seller_order_id TEXT NOT NULL UNIQUE REFERENCES nb_seller_orders(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  receipt_number TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'order_receipt',
  issued_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nb_seller_notification_prefs (
  user_id TEXT PRIMARY KEY REFERENCES nb_users(id) ON DELETE CASCADE,
  in_app INTEGER NOT NULL DEFAULT 1,
  email INTEGER NOT NULL DEFAULT 0,
  sms INTEGER NOT NULL DEFAULT 0,
  whatsapp INTEGER NOT NULL DEFAULT 0,
  order_alerts INTEGER NOT NULL DEFAULT 1,
  stock_alerts INTEGER NOT NULL DEFAULT 1,
  payment_alerts INTEGER NOT NULL DEFAULT 1,
  runner_alerts INTEGER NOT NULL DEFAULT 1,
  marketing INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nb_shop_financial_settings (
  shop_id TEXT PRIMARY KEY REFERENCES nb_shops(id) ON DELETE CASCADE,
  commission_rate REAL NOT NULL DEFAULT 0,
  bank_name TEXT,
  bank_account_last4 TEXT,
  bank_ifsc TEXT,
  bank_status TEXT NOT NULL DEFAULT 'not_submitted',
  settlement_preference TEXT NOT NULL DEFAULT 'weekly',
  tax_config_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

/* Runner Portal extension tables (shared DB, runner scoped) */
CREATE TABLE IF NOT EXISTS nb_runner_preferences (
  user_id TEXT PRIMARY KEY REFERENCES nb_users(id) ON DELETE CASCADE,
  areas TEXT NOT NULL DEFAULT '',
  pincodes TEXT NOT NULL DEFAULT '',
  hours TEXT NOT NULL DEFAULT '',
  max_distance_km REAL NOT NULL DEFAULT 10,
  categories TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nb_runner_payouts (
  id TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL REFERENCES nb_users(id),
  period_label TEXT NOT NULL,
  gross_paise INTEGER NOT NULL DEFAULT 0,
  adjustments_paise INTEGER NOT NULL DEFAULT 0,
  net_paise INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  reference TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runner_payouts ON nb_runner_payouts(runner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS nb_runner_tickets (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES nb_users(id),
  category TEXT NOT NULL DEFAULT 'general',
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  attachment TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  assigned_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runner_tickets ON nb_runner_tickets(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS nb_runner_ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES nb_runner_tickets(id) ON DELETE CASCADE,
  author_role TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

/* Idempotent column migrations for existing databases. */
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumn('nb_products', 'sku', 'TEXT');
addColumn('nb_products', 'barcode', 'TEXT');
addColumn('nb_products', 'parent_product_id', 'TEXT');
addColumn('nb_products', 'subcategory', 'TEXT');
addColumn('nb_products', 'weight_grams', 'INTEGER');
addColumn('nb_products', 'dimensions', 'TEXT');
addColumn('nb_products', 'max_stock', 'INTEGER');
addColumn('nb_products', 'archived', 'INTEGER NOT NULL DEFAULT 0');
addColumn('nb_shops', 'logo_url', 'TEXT');
addColumn('nb_shops', 'cover_url', 'TEXT');
addColumn('nb_shops', 'about_text', 'TEXT');
addColumn('nb_shops', 'return_policy', 'TEXT');
addColumn('nb_shops', 'pickup_instructions', 'TEXT');
addColumn('nb_shops', 'delivery_info', 'TEXT');
addColumn('nb_shops', 'support_contact', 'TEXT');
addColumn('nb_shops', 'business_email', 'TEXT');
addColumn('nb_shops', 'legal_name', 'TEXT');
addColumn('nb_shops', 'ownership_type', 'TEXT');
addColumn('nb_shops', 'seller_code', 'TEXT');
addColumn('nb_shops', 'shop_code', 'TEXT');
addColumn('nb_shops', 'commission_rate', 'REAL NOT NULL DEFAULT 0');
addColumn('nb_shops', 'bank_name', 'TEXT');
addColumn('nb_shops', 'bank_account_last4', 'TEXT');
addColumn('nb_shops', 'bank_ifsc', 'TEXT');
addColumn('nb_shops', 'bank_status', 'TEXT NOT NULL DEFAULT \'not_submitted\'');
addColumn('nb_shops', 'temporary_closure_until', 'TEXT');
addColumn('nb_shops', 'holiday_date', 'TEXT');
addColumn('nb_shops', 'holiday_label', 'TEXT');
addColumn('nb_shops', 'self_delivery_enabled', 'INTEGER NOT NULL DEFAULT 1');
addColumn('nb_shops', 'runner_enabled', 'INTEGER NOT NULL DEFAULT 1');
/* Public proprietor name shown on the storefront next to the shop's map pin. Separate
 * from owner_user_id, which is only set when the seller also holds a NearBuy account. */
addColumn('nb_shops', 'proprietor_name', 'TEXT');
addColumn('nb_coupons', 'promo_type', 'TEXT');
addColumn('nb_coupons', 'product_ids', 'TEXT');
addColumn('nb_coupons', 'category_slugs', 'TEXT');
addColumn('nb_coupons', 'buy_qty', 'INTEGER');
addColumn('nb_coupons', 'get_qty', 'INTEGER');
addColumn('nb_coupons', 'eligibility', 'TEXT');
addColumn('nb_reviews', 'seller_reply', 'TEXT');
addColumn('nb_reviews', 'seller_reply_at', 'TEXT');
addColumn('nb_scanner_devices', 'device_serial', 'TEXT');
addColumn('nb_reviews', 'reported_at', 'TEXT');
addColumn('nb_reviews', 'reported_reason', 'TEXT');
addColumn('nb_seller_orders', 'delivery_staff_id', 'TEXT');
addColumn('nb_seller_orders', 'delivery_staff_name', 'TEXT');
addColumn('nb_seller_orders', 'packages_count', 'INTEGER NOT NULL DEFAULT 1');
addColumn('nb_seller_orders', 'weight_grams', 'INTEGER');
addColumn('nb_seller_orders', 'requested_timing', 'TEXT');
addColumn('nb_seller_orders', 'runner_charges_paise', 'INTEGER');
addColumn('nb_seller_orders', 'handover_confirmed_at', 'TEXT');
addColumn('nb_seller_orders', 'handover_confirmed_by', 'TEXT');
addColumn('nb_seller_orders', 'packing_complete', 'INTEGER NOT NULL DEFAULT 0');
addColumn('nb_seller_orders', 'partial_fulfillment', 'INTEGER NOT NULL DEFAULT 0');
addColumn('nb_seller_orders', 'partial_note', 'TEXT');
addColumn('nb_order_items', 'packed_qty', 'INTEGER NOT NULL DEFAULT 0');
addColumn('nb_order_items', 'missing_qty', 'INTEGER NOT NULL DEFAULT 0');
addColumn('nb_order_items', 'packed_status', 'TEXT NOT NULL DEFAULT \'pending\'');
addColumn('nb_users', 'two_factor_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('nb_sessions', 'ip', 'TEXT');
addColumn('nb_refunds', 'seller_order_id', 'TEXT');
addColumn('nb_refunds', 'reason', 'TEXT');
db.exec(`
CREATE INDEX IF NOT EXISTS idx_refunds_order ON nb_refunds(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_refunds_seller_order ON nb_refunds(seller_order_id, status, created_at);
`);

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const now = () => new Date().toISOString();
const iso = (d) => new Date(d).toISOString();
const uid = () => randomUUID();
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

/**
 * Deterministically split `totalAmountPaise` across `sellerOrders` using
 * each seller order's `total_paise` weight and largest-remainder rounding so
 * the allocated parts always conserve the exact paise total.
 */
function allocateAmountAcrossSellerOrders(totalAmountPaise, sellerOrders) {
  const total = Math.max(0, Math.round(Number(totalAmountPaise) || 0));
  if (!Array.isArray(sellerOrders) || !sellerOrders.length) return [];
  const ordered = [...sellerOrders].sort((a, b) => {
    const cmp = String(a.created_at || '').localeCompare(String(b.created_at || ''));
    return cmp !== 0 ? cmp : String(a.id || '').localeCompare(String(b.id || ''));
  });
  if (total === 0) {
    return ordered.map((so) => ({ sellerOrderId: so.id, shopId: so.shop_id, amountPaise: 0 }));
  }
  const weights = ordered.map((so) => Math.max(0, Math.round(Number(so.total_paise) || 0)));
  const weightSum = weights.reduce((acc, w) => acc + w, 0);
  if (weightSum === total) {
    return ordered.map((so, i) => ({ sellerOrderId: so.id, shopId: so.shop_id, amountPaise: weights[i] }));
  }
  const denom = weightSum > 0 ? weightSum : ordered.length;
  const parts = ordered.map((so, i) => {
    const w = weightSum > 0 ? weights[i] : 1;
    const exact = (total * w) / denom;
    const floor = Math.floor(exact);
    return { so, index: i, floor, frac: exact - floor };
  });
  const remainder = total - parts.reduce((acc, p) => acc + p.floor, 0);
  const byFrac = [...parts].sort((a, b) => (b.frac - a.frac) || (a.index - b.index));
  for (let i = 0; i < remainder; i++) {
    byFrac[i % byFrac.length].floor += 1;
  }
  return parts.map((p) => ({ sellerOrderId: p.so.id, shopId: p.so.shop_id, amountPaise: p.floor }));
}

function syncPaymentAllocations(paymentRecordId, orderId, sellerOrders, amountPaise, timestamp = now()) {
  db.prepare('DELETE FROM nb_payment_allocations WHERE payment_record_id=?').run(paymentRecordId);
  const allocations = allocateAmountAcrossSellerOrders(amountPaise, sellerOrders);
  const stmt = db.prepare(`INSERT INTO nb_payment_allocations
    (id,payment_record_id,order_id,seller_order_id,shop_id,amount_paise,created_at)
    VALUES(?,?,?,?,?,?,?)`);
  for (const alloc of allocations) {
    stmt.run(uid(), paymentRecordId, orderId, alloc.sellerOrderId, alloc.shopId, alloc.amountPaise, timestamp);
  }
  return allocations;
}

function resolveSellerOrdersForPaymentRecord(record) {
  if (record.seller_order_id) {
    const so = db.prepare('SELECT * FROM nb_seller_orders WHERE id=?').get(record.seller_order_id);
    return so ? [so] : [];
  }
  const all = db.prepare('SELECT * FROM nb_seller_orders WHERE order_id=? ORDER BY created_at, id').all(record.order_id);
  if (all.length <= 1) return all;
  const active = all.filter((so) => !['cancelled', 'rejected'].includes(so.status));
  const activeTotal = active.reduce((sum, so) => sum + Math.max(0, Math.round(Number(so.total_paise) || 0)), 0);
  if (active.length > 0 && activeTotal === Math.round(Number(record.amount_paise) || 0)) {
    return active;
  }
  return all;
}

/* Idempotent backfill for legacy rows created before seller-order attribution. */
(function backfillFinancialAttribution() {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      UPDATE nb_refunds
      SET seller_order_id = (SELECT r.seller_order_id FROM nb_returns r WHERE r.id = nb_refunds.return_id),
          reason = COALESCE(reason, 'return')
      WHERE return_id IS NOT NULL AND seller_order_id IS NULL;

      UPDATE nb_refunds
      SET seller_order_id = (SELECT so.id FROM nb_seller_orders so WHERE so.order_id = nb_refunds.order_id LIMIT 1)
      WHERE seller_order_id IS NULL
        AND return_id IS NULL
        AND COALESCE(reason, '') <> 'duplicate_payment'
        AND (SELECT COUNT(*) FROM nb_seller_orders so WHERE so.order_id = nb_refunds.order_id) = 1;
    `);
    const unallocated = db.prepare(`SELECT pr.*
      FROM nb_payment_records pr
      WHERE NOT EXISTS (SELECT 1 FROM nb_payment_allocations pa WHERE pa.payment_record_id = pr.id)`).all();
    for (const pr of unallocated) {
      const targetSellerOrders = resolveSellerOrdersForPaymentRecord(pr);
      if (targetSellerOrders.length) {
        syncPaymentAllocations(pr.id, pr.order_id, targetSellerOrders, pr.amount_paise, pr.created_at || now());
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
})();

function makePassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(String(password), salt, 64).toString('hex')}`;
}
function checkPassword(password, stored) {
  try {
    const [salt, digest] = String(stored || '').split(':');
    if (!salt || !digest) return false;
    const actual = scryptSync(String(password), salt, 64);
    const expected = Buffer.from(digest, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* A process-local key file keeps OTP derivation stable across restarts
 * without storing any code in plain text. The file is inside data/ (ignored). */
let secret = process.env.NEARBUY_OTP_SECRET || '';
if (!secret) {
  const keyFile = path.join(dataDir, '.nearbuy-otp-key');
  try {
    secret = fs.readFileSync(keyFile, 'utf8').trim();
  } catch {
    secret = randomBytes(32).toString('hex');
    fs.writeFileSync(keyFile, secret, { mode: 0o600 });
  }
}

/** Derive a code that is never stored: HMAC(secret, purpose:id:epoch). */
function deriveCode(purpose, id, digits = 6) {
  const digest = createHmac('sha256', secret).update(`${purpose}:${id}`).digest();
  const n = digest.readUInt32BE(0) % 10 ** digits;
  return String(n).padStart(digits, '0');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

function audit(actorType, actorId, action, entity, entityId, detail) {
  db.prepare(
    'INSERT INTO nb_audit_logs(actor_type,actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)'
  ).run(actorType, actorId || null, action, entity || null, entityId || null, detail ? String(detail).slice(0, 500) : null, now());
}

const money = (paise) => Math.round(Number(paise) || 0);
const rupees = (n) => Math.round(Number(n) * 100);

function pincodeArea(pincode) {
  return db.prepare('SELECT * FROM nb_service_areas WHERE pincode=? AND active=1 ORDER BY id LIMIT 1').get(String(pincode));
}

function haversineKm(aLat, aLng, bLat, bLng) {
  if ([aLat, aLng, bLat, bLng].some((v) => typeof v !== 'number' || Number.isNaN(v))) return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 100) / 100;
}

module.exports = {
  db,
  dbPath,
  now,
  iso,
  uid,
  sha,
  makePassword,
  checkPassword,
  deriveCode,
  safeEqual,
  transaction,
  audit,
  money,
  rupees,
  pincodeArea,
  haversineKm,
  allocateAmountAcrossSellerOrders,
  syncPaymentAllocations,
  resolveSellerOrdersForPaymentRecord
};
