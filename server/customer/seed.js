'use strict';
/*
 * Demo seed for the NearBuy Customer Portal.
 *
 * Everything created here is labelled DEMO DATA in the interface. Seeding is
 * skipped in production unless SEED_DEMO=1. No payment is marked captured
 * unless a real gateway confirmed it; the sample orders are cash-on-delivery.
 */
const { db, now, uid, makePassword, rupees, transaction, audit } = require('./db');

const isProduction = process.env.NODE_ENV === 'production';
const seedEnabled = process.env.SEED_DEMO === '1' || !isProduction;

const CATEGORIES = [
  ['groceries', 'Groceries', 'basket', 'blue', 1],
  ['fruits-vegetables', 'Fruits & Vegetables', 'leaf', 'green', 2],
  ['dairy-products', 'Dairy Products', 'milk', 'sky', 3],
  ['food-beverages', 'Food & Beverages', 'cup', 'orange', 4],
  ['general-store', 'General Store', 'store', 'indigo', 5],
  ['stationery', 'Stationery', 'pen', 'violet', 6],
  ['books', 'Books', 'book', 'amber', 7],
  ['electronics', 'Electronics', 'plug', 'cyan', 8],
  ['mobile-accessories', 'Mobile Accessories', 'phone', 'blue', 9],
  ['clothing', 'Clothing', 'shirt', 'rose', 10],
  ['footwear', 'Footwear', 'shoe', 'teal', 11],
  ['cosmetics', 'Cosmetics', 'sparkle', 'pink', 12],
  ['beauty-personal-care', 'Beauty & Personal Care', 'heart', 'violet', 13],
  ['home-kitchen', 'Home & Kitchen', 'home', 'sky', 14],
  ['hardware', 'Hardware', 'tool', 'slate', 15],
  ['pharmacy', 'Medical & Pharmacy', 'cross', 'green', 16],
  ['sports-fitness', 'Sports & Fitness', 'dumbbell', 'blue', 17],
  ['toys-gifts', 'Toys & Gifts', 'gift', 'orange', 18],
  ['bakery', 'Bakery', 'bread', 'amber', 19],
  ['local-services', 'Other Local Services', 'service', 'teal', 20]
];

const AREAS = [
  ['110016', 'Hauz Khas', 'New Delhi', 28.5494, 77.2001],
  ['110016', 'Green Park', 'New Delhi', 28.5587, 77.2067],
  ['110016', 'SDA Market', 'New Delhi', 28.5438, 77.1973],
  ['110017', 'Malviya Nagar', 'New Delhi', 28.5312, 77.2102],
  ['110017', 'Saket', 'New Delhi', 28.5245, 77.2066],
  ['110017', 'Pushp Vihar', 'New Delhi', 28.5173, 77.2177],
  ['110024', 'Lajpat Nagar', 'New Delhi', 28.5677, 77.2433],
  ['110024', 'Defence Colony', 'New Delhi', 28.5733, 77.2273],
  ['110048', 'Greater Kailash', 'New Delhi', 28.5494, 77.2426],
  ['110070', 'Vasant Kunj', 'New Delhi', 28.5215, 77.1596],
  ['110049', 'Gulmohar Park', 'New Delhi', 28.5587, 77.2086],
  ['110029', 'Safdarjung Enclave', 'New Delhi', 28.5640, 77.1974]
];

const SHOPS = [
  {
    slug: 'fresh-mart', name: 'Fresh Mart', owner: 'owner@nearbuy.demo', ownerName: 'Riya Sharma',
    category: 'groceries', tagline: 'Groceries & daily essentials', emoji: '🛒', tone: 'blue',
    address: '14, Hauz Khas Village Road', locality: 'Hauz Khas', pincode: '110016', lat: 28.5494, lng: 77.2001,
    rating: 4.6, reviews: 214, verified: 1, open: 1, opens: '07:00', closes: '23:00', prep: 12,
    delivery: 1, pickup: 1, deliveryFee: 25, freeOver: 499, pickupFee: 0, minOrder: 199, radius: 6,
    pins: '110016,110017,110024,110048,110049', badge: 'Neighbourhood favourite',
    description: 'A family-run neighbourhood supermarket since 1998. Fresh produce every morning, everyday essentials, and a team that knows your name.'
  },
  {
    slug: 'green-basket', name: 'Green Basket Market', owner: null, ownerName: 'Anil Verma',
    category: 'groceries', tagline: 'Organic & farm-fresh groceries', emoji: '🥬', tone: 'green',
    address: 'B-32, Green Park Main Market', locality: 'Green Park', pincode: '110016', lat: 28.5587, lng: 77.2067,
    rating: 4.5, reviews: 168, verified: 1, open: 1, opens: '08:00', closes: '21:30', prep: 15,
    delivery: 1, pickup: 1, deliveryFee: 30, freeOver: 599, pickupFee: 0, minOrder: 149, radius: 5,
    pins: '110016,110017,110029,110049', badge: 'Organic picks',
    description: 'Seasonal produce from farms around Delhi, organic staples and a zero-plastic packaging policy at checkout.'
  },
  {
    slug: 'scribble-stationery', name: 'Scribble Stationery', owner: 'stationery@nearbuy.demo', ownerName: 'Dev Mehta',
    category: 'stationery', tagline: 'Stationery, school & office supplies', emoji: '✏️', tone: 'violet',
    address: 'Shop 7, Malviya Nagar Market', locality: 'Malviya Nagar', pincode: '110017', lat: 28.5312, lng: 77.2102,
    rating: 4.7, reviews: 96, verified: 1, open: 1, opens: '09:00', closes: '20:30', prep: 10,
    delivery: 1, pickup: 1, deliveryFee: 20, freeOver: 399, pickupFee: 0, minOrder: 0, radius: 8,
    pins: '110016,110017,110024,110048', badge: 'School season ready',
    description: 'Notebooks, pens, art supplies and office essentials. Student discounts on bundles, gift wrapping on request.'
  },
  {
    slug: 'mediplus-pharmacy', name: 'MediPlus Pharmacy', owner: 'pharmacy@nearbuy.demo', ownerName: 'Sana Khan',
    category: 'pharmacy', tagline: 'Medicines & wellness, 24 hours', emoji: '💊', tone: 'green',
    address: 'C-5, Saket District Centre', locality: 'Saket', pincode: '110017', lat: 28.5245, lng: 77.2066,
    rating: 4.8, reviews: 342, verified: 1, open: 1, opens: '00:00', closes: '23:59', prep: 8,
    delivery: 1, pickup: 1, deliveryFee: 15, freeOver: 299, pickupFee: 0, minOrder: 0, radius: 7,
    pins: '110017,110016,110029,110024', badge: 'Open 24 hours',
    description: 'A licensed pharmacy with a pharmacist on call. Prescription medicines are dispensed only against a valid prescription at the counter.'
  },
  {
    slug: 'daily-needs-kirana', name: 'Daily Needs Kirana', owner: null, ownerName: 'Rakesh Gupta',
    category: 'general-store', tagline: 'Everyday kirana at honest prices', emoji: '🏪', tone: 'orange',
    address: '22, Lajpat Nagar II, Central Market', locality: 'Lajpat Nagar', pincode: '110024', lat: 28.5677, lng: 77.2433,
    rating: 4.3, reviews: 121, verified: 0, open: 1, opens: '07:30', closes: '22:00', prep: 14,
    delivery: 1, pickup: 1, deliveryFee: 20, freeOver: 399, pickupFee: 0, minOrder: 99, radius: 5,
    pins: '110024,110048,110016', badge: null,
    description: 'Your corner kirana store, now online. Pulses, spices, snacks and household basics delivered from the same street.'
  },
  {
    slug: 'sunrise-bakery', name: 'Sunrise Bakery', owner: null, ownerName: 'Maria D’Souza',
    category: 'bakery', tagline: 'Freshly baked every morning', emoji: '🥐', tone: 'amber',
    address: '3, SDA Market, Hauz Khas', locality: 'SDA Market', pincode: '110016', lat: 28.5438, lng: 77.1973,
    rating: 4.4, reviews: 187, verified: 1, open: 1, opens: '07:00', closes: '22:30', prep: 20,
    delivery: 1, pickup: 1, deliveryFee: 30, freeOver: 499, pickupFee: 0, minOrder: 0, radius: 4,
    pins: '110016,110017', badge: 'Baked today',
    description: 'Sourdough, croissants and celebration cakes from a small neighbourhood bakery. Order cakes 24 hours ahead.'
  },
  {
    slug: 'tech-corner', name: 'Tech Corner', owner: null, ownerName: 'Vikram Singh',
    category: 'electronics', tagline: 'Gadgets, accessories & repairs', emoji: '🎧', tone: 'cyan',
    address: 'M-18, Greater Kailash I', locality: 'Greater Kailash', pincode: '110048', lat: 28.5494, lng: 77.2426,
    rating: 4.2, reviews: 88, verified: 1, open: 1, opens: '10:30', closes: '20:30', prep: 25,
    delivery: 1, pickup: 1, deliveryFee: 40, freeOver: 999, pickupFee: 20, minOrder: 0, radius: 4,
    pins: '110048,110016,110017', badge: null,
    description: 'Headphones, chargers, storage and honest repair advice. Demo products only — no warranties are issued by this prototype.'
  },
  {
    slug: 'glow-beauty', name: 'Glow Beauty Studio', owner: null, ownerName: 'Neha Kapoor',
    category: 'beauty-personal-care', tagline: 'Skin, hair & everyday beauty', emoji: '💄', tone: 'rose',
    address: 'A-41, Defence Colony Market', locality: 'Defence Colony', pincode: '110024', lat: 28.5733, lng: 77.2273,
    rating: 4.5, reviews: 143, verified: 1, open: 1, opens: '10:00', closes: '21:00', prep: 18,
    delivery: 1, pickup: 1, deliveryFee: 35, freeOver: 699, pickupFee: 0, minOrder: 199, radius: 5,
    pins: '110024,110048,110016', badge: 'Beauty advisor available',
    description: 'Dermatologist-tested everyday skincare and makeup, with free shade matching at the store.'
  },
  {
    slug: 'petal-and-pot', name: 'Petal & Pot', owner: null, ownerName: 'Ira Bose',
    category: 'home-kitchen', tagline: 'Plants, gifts & home finds', emoji: '🪴', tone: 'teal',
    address: '12, Vasant Kunj, Sector C', locality: 'Vasant Kunj', pincode: '110070', lat: 28.5215, lng: 77.1596,
    rating: 4.6, reviews: 74, verified: 1, open: 1, opens: '09:30', closes: '20:00', prep: 22,
    delivery: 1, pickup: 1, deliveryFee: 45, freeOver: 799, pickupFee: 10, minOrder: 249, radius: 6,
    pins: '110070,110016,110017', badge: null,
    description: 'Low-maintenance indoor plants, ceramics, candles and thoughtful gifts, wrapped by hand.'
  },
  {
    slug: 'fitzone-sports', name: 'FitZone Sports', owner: null, ownerName: 'Arjun Rana',
    category: 'sports-fitness', tagline: 'Fitness gear for the neighbourhood', emoji: '🏸', tone: 'blue',
    address: '5, Green Park Extension', locality: 'Green Park', pincode: '110016', lat: 28.5587, lng: 77.2067,
    rating: 4.1, reviews: 52, verified: 0, open: 0, opens: '10:00', closes: '20:00', prep: 20,
    delivery: 1, pickup: 1, deliveryFee: 25, freeOver: 499, pickupFee: 0, minOrder: 0, radius: 5,
    pins: '110016,110017', badge: null,
    description: 'Yoga mats, rackets and home workout gear. Currently closed — opens at 10:00.'
  }
];

/* product: [name, brand, compareKey, category, emoji, price, mrp, stock, opts] */
const CATALOGUE = {
  'fresh-mart': [
    ['Amul Taaza Toned Milk 1 L', 'Amul', 'amul-taaza-1l', 'dairy-products', '🥛', 58, 62, 46, { image: '/public/assets/showcase-milk.jpg', unit: '1 L pouch', returnDays: 0, tax: 0, desc: 'Pasteurised toned milk in a 1 litre pouch. Keep refrigerated at 4°C and consume within two days of opening.' }],
    ['Farm Fresh Brown Eggs · 6', 'Fresho', 'eggs-6', 'dairy-products', '🥚', 72, 80, 28, { image: '/public/assets/showcase-eggs.jpg', unit: '6 eggs', returnDays: 1, desc: 'Free-range brown eggs, collected daily from farms in Sonipat. Rich in protein and omega-3.' }],
    ['Sunrise Bananas · 6 pcs', 'Fresho', 'bananas-6', 'fruits-vegetables', '🍌', 42, 48, 35, { image: '/public/assets/showcase-bananas.jpg', unit: '6 pcs · approx. 700 g', returnDays: 1, desc: 'Naturally ripened robusta bananas. Best eaten within three days; store away from direct sunlight.' }],
    ['Whole Wheat Atta 5 kg', 'Aashirvaad', 'atta-5kg', 'groceries', '🌾', 255, 285, 22, { unit: '5 kg pack', tax: 0, desc: 'Stone-ground whole wheat flour for soft rotis. Source: Madhya Pradesh wheat.' }],
    ['India Gate Basmati Rice 1 kg', 'India Gate', 'basmati-1kg', 'groceries', '🍚', 118, 140, 30, { unit: '1 kg pack', tax: 0, desc: 'Aged long-grain basmati rice with a delicate aroma. Ideal for biryani and pulao.' }],
    ['Tata Salt 1 kg', 'Tata', 'salt-1kg', 'groceries', '🧂', 28, 30, 60, { unit: '1 kg pack', tax: 0, desc: 'Iodised vacuum-evaporated salt.' }],
    ['Fortune Sunflower Oil 1 L', 'Fortune', 'sunflower-oil-1l', 'groceries', '🫒', 148, 160, 18, { unit: '1 L pouch', desc: 'Refined sunflower oil, light and suitable for everyday Indian cooking.' }],
    ['Maggi 2-Minute Noodles · 4 pack', 'Maggi', 'maggi-4', 'food-beverages', '🍜', 56, 60, 44, { unit: '4 × 70 g', desc: 'Masala noodles, the after-school classic. Four single-serve packs.' }],
    ['Britannia Good Day Cashew 200 g', 'Britannia', 'goodday-200', 'food-beverages', '🍪', 45, 50, 0, { unit: '200 g', desc: 'Butter cookies with cashew pieces. Currently out of stock at this shop.' }],
    ['Red Apples · 4 pcs', 'Fresho', 'apples-4', 'fruits-vegetables', '🍎', 119, 140, 14, { unit: '4 pcs · approx. 600 g', returnDays: 2, desc: 'Crisp Shimla apples, hand-picked. Wash before use.' }],
    ['Baby Spinach · 1 bunch', 'Local farms', 'spinach-1', 'fruits-vegetables', '🥬', 28, 32, 20, { unit: '1 bunch · approx. 250 g', returnDays: 1, desc: 'Tender baby spinach leaves, harvested this morning.' }],
    ['Sourdough Country Loaf', 'Sunrise Bakehouse', 'bread-sourdough', 'bakery', '🍞', 95, 110, 9, { image: '/public/assets/showcase-bread.jpg', unit: '450 g loaf', returnDays: 1, desc: 'Slow-fermented sourdough with a crackling crust. Baked at 5 am every day.' }],
    ['Amul Butter 500 g', 'Amul', 'butter-500', 'dairy-products', '🧈', 285, 300, 11, { unit: '500 g', returnDays: 0, desc: 'Salted table butter made from fresh cream.' }],
    ['Colgate Strong Teeth 200 g', 'Colgate', 'toothpaste-200', 'beauty-personal-care', '🪥', 98, 110, 25, { unit: '200 g tube', desc: 'Fluoride toothpaste for cavity protection and stronger teeth.' }],
    ['Dove Intense Repair Shampoo 340 ml', 'Dove', 'shampoo-340', 'beauty-personal-care', '🧴', 329, 375, 8, { unit: '340 ml bottle', desc: 'Repairing shampoo for damaged hair with keratin actives.' }],
    ['Dettol Liquid Handwash 750 ml', 'Dettol', 'handwash-750', 'beauty-personal-care', '🧼', 189, 210, 16, { unit: '750 ml pump', desc: 'Antibacterial handwash refill pump with a fresh pine fragrance.' }],
    ['Surf Excel Easy Wash 1 kg', 'Surf Excel', 'detergent-1kg', 'general-store', '🧺', 145, 160, 19, { unit: '1 kg', desc: 'Detergent powder for buckets and machines.' }]
  ],
  'green-basket': [
    ['Amul Taaza Toned Milk 1 L', 'Amul', 'amul-taaza-1l', 'dairy-products', '🥛', 60, 62, 24, { image: '/public/assets/showcase-milk.jpg', unit: '1 L pouch', tax: 0 }],
    ['Free Range Brown Eggs · 6', 'Green Basket Farms', 'eggs-6', 'dairy-products', '🥚', 78, 84, 17, { image: '/public/assets/showcase-eggs.jpg', unit: '6 eggs', returnDays: 1 }],
    ['Robusta Bananas · 6 pcs', 'Fresho', 'bananas-6', 'fruits-vegetables', '🍌', 45, 48, 21, { image: '/public/assets/showcase-bananas.jpg', unit: '6 pcs', returnDays: 1 }],
    ['Organic Whole Wheat Atta 5 kg', '24 Mantra Organic', 'atta-5kg', 'groceries', '🌾', 299, 340, 9, { unit: '5 kg', tax: 0 }],
    ['India Gate Basmati Rice 1 kg', 'India Gate', 'basmati-1kg', 'groceries', '🍚', 125, 140, 12, { unit: '1 kg', tax: 0 }],
    ['Sourdough Country Loaf', 'Green Basket Bakehouse', 'bread-sourdough', 'bakery', '🍞', 99, 110, 5, { image: '/public/assets/showcase-bread.jpg', unit: '450 g', returnDays: 1 }],
    ['Shimla Apples · 4 pcs', 'Fresho', 'apples-4', 'fruits-vegetables', '🍎', 109, 140, 6, { unit: '4 pcs', returnDays: 2 }],
    ['Baby Spinach · 1 bunch', 'Local farms', 'spinach-1', 'fruits-vegetables', '🥬', 25, 32, 11, { unit: '250 g', returnDays: 1 }],
    ['Cold Pressed Sunflower Oil 1 L', 'Anveshan', 'sunflower-oil-1l', 'groceries', '🫒', 179, 220, 7, { unit: '1 L glass bottle' }],
    ['Wild Forest Honey 250 g', 'Organic India', 'honey-250', 'food-beverages', '🍯', 189, 220, 10, { unit: '250 g jar' }],
    ['Amul Butter 500 g', 'Amul', 'butter-500', 'dairy-products', '🧈', 290, 300, 4, { unit: '500 g', returnDays: 0 }],
    ['Tata Salt 1 kg', 'Tata', 'salt-1kg', 'groceries', '🧂', 27, 30, 32, { unit: '1 kg', tax: 0 }]
  ],
  'scribble-stationery': [
    ['Classmate Notebook 200 pages', 'Classmate', 'notebook-200', 'stationery', '📓', 52, 60, 80, { unit: '1 notebook · single line', returnDays: 7, desc: 'A4 ruled notebook with 200 pages and a strong stitched binding.' }],
    ['Reynolds 045 Ball Pen · Blue', 'Reynolds', 'pen-blue', 'stationery', '🖊️', 10, 10, 240, { unit: '1 pen', returnDays: 0, desc: 'Smooth-writing 0.7 mm ball pen in blue.' }],
    ['Apsara Pencils · Pack of 10', 'Apsara', 'pencils-10', 'stationery', '✏️', 50, 60, 60, { unit: '10 pencils', returnDays: 7, desc: 'Extra-dark graphite pencils for school and sketching.' }],
    ['Faber-Castell Sketch Pens · 12', 'Faber-Castell', 'sketchpens-12', 'stationery', '🎨', 185, 220, 18, { unit: '12 colours', returnDays: 7, desc: 'Washable sketch pens with a fine tip. Suitable for ages 3+.' }],
    ['A4 Copier Paper · 500 sheets', 'JK Copier', 'a4-ream', 'stationery', '📄', 310, 350, 24, { unit: '1 ream · 75 gsm', returnDays: 7, desc: 'Bright white A4 paper for printing and copying.' }],
    ['Geometry Box · 9 pieces', 'Camlin', 'geometry-box', 'stationery', '📐', 145, 175, 15, { unit: '9-piece set', returnDays: 7, desc: 'Compass, divider, scale, protractor and set squares in a metal box.' }],
    ['Highlighter Set · 5 colours', 'Camlin', 'highlighters-5', 'stationery', '🖍️', 99, 120, 22, { unit: '5 pens', returnDays: 7, desc: 'Chisel-tip highlighters in five fluorescent colours.' }],
    ['Stapler with 1000 Pins', 'Kangaro', 'stapler', 'stationery', '📎', 85, 100, 30, { unit: '1 stapler + pins', returnDays: 7, desc: 'Compact metal stapler for home and office use.' }],
    ['Wildcraft Backpack 25 L', 'Wildcraft', 'backpack-25', 'stationery', '🎒', 699, 999, 6, { unit: '25 L · navy', returnDays: 7, desc: 'Water-resistant school backpack with padded straps and a laptop sleeve.' }],
    ['Classmate Notebook 200 pages', 'Classmate', 'notebook-200', 'stationery', '📓', 52, 60, 40, { unit: '1 notebook · four line', returnDays: 7 }]
  ],
  'mediplus-pharmacy': [
    ['Paracetamol 650 mg · Strip of 15', 'Cipla', 'paracetamol-650', 'pharmacy', '💊', 35, 40, 90, { unit: '15 tablets', returnDays: 0, tax: 5, desc: 'For fever and mild pain. Do not exceed the dose on the pack. Keep out of reach of children.' }],
    ['Dettol Antiseptic Liquid 125 ml', 'Dettol', 'antiseptic-125', 'pharmacy', '🧴', 72, 85, 35, { unit: '125 ml', desc: 'Antiseptic disinfectant for first aid and surface cleaning.' }],
    ['Cetirizine 10 mg · Strip of 10', 'Cipla', 'cetirizine-10', 'pharmacy', '💊', 28, 32, 48, { unit: '10 tablets', returnDays: 0, desc: 'Antihistamine for allergy symptoms. May cause drowsiness.' }],
    ['Vitamin C Chewable · 60 tablets', 'HealthKart', 'vitc-60', 'pharmacy', '🍊', 249, 299, 20, { unit: '60 tablets · orange', desc: 'Vitamin C 500 mg chewable tablets. Not a substitute for a balanced diet.' }],
    ['Digital Thermometer', 'Dr. Trust', 'thermometer', 'pharmacy', '🌡️', 249, 349, 12, { unit: '1 unit', returnDays: 7, desc: 'Flexible-tip digital thermometer with a 10-second reading.' }],
    ['N95 Mask · Pack of 5', 'Venus', 'mask-n95-5', 'pharmacy', '😷', 99, 150, 60, { unit: '5 masks', returnDays: 0, desc: 'Five-layer N95 respirator masks with adjustable nose clips.' }],
    ['ORS Sachets · Pack of 5', 'Electral', 'ors-5', 'pharmacy', '🥤', 45, 50, 40, { unit: '5 sachets', desc: 'Oral rehydration salts for dehydration. Mix one sachet in 200 ml water.' }],
    ['Pain Relief Spray 60 g', 'Volini', 'painspray-60', 'pharmacy', '🧴', 189, 225, 18, { unit: '60 g', desc: 'Topical spray for muscle and joint pain. External use only.' }],
    ['Hand Sanitizer 500 ml', 'Dettol', 'sanitizer-500', 'pharmacy', '🧼', 149, 199, 22, { unit: '500 ml pump', desc: '70% alcohol hand sanitizer with moisturiser.' }],
    ['Baby Diapers M · 20 pants', 'Pampers', 'diapers-m-20', 'pharmacy', '🧷', 399, 449, 15, { unit: '20 pants · medium', returnDays: 7, desc: 'Soft cotton-like diapers with 12-hour dryness.' }],
    ['Colgate Strong Teeth 200 g', 'Colgate', 'toothpaste-200', 'beauty-personal-care', '🪥', 96, 110, 30, { unit: '200 g', desc: 'Fluoride toothpaste for daily cavity protection.' }]
  ],
  'daily-needs-kirana': [
    ['Amul Taaza Toned Milk 1 L', 'Amul', 'amul-taaza-1l', 'dairy-products', '🥛', 56, 62, 18, { image: '/public/assets/showcase-milk.jpg', unit: '1 L', tax: 0 }],
    ['Whole Wheat Atta 5 kg', 'Pillsbury', 'atta-5kg', 'groceries', '🌾', 249, 275, 14, { unit: '5 kg', tax: 0 }],
    ['India Gate Basmati Rice 1 kg', 'India Gate', 'basmati-1kg', 'groceries', '🍚', 110, 140, 20, { unit: '1 kg', tax: 0 }],
    ['Tata Salt 1 kg', 'Tata', 'salt-1kg', 'groceries', '🧂', 26, 30, 40, { unit: '1 kg', tax: 0 }],
    ['Notebook 200 pages', 'Classmate', 'notebook-200', 'stationery', '📓', 45, 60, 35, { unit: '1 notebook', returnDays: 7 }],
    ['Ball Pen · Blue', 'Linc', 'pen-blue', 'stationery', '🖊️', 8, 10, 120, { unit: '1 pen' }],
    ['Maggi 2-Minute Noodles · 4 pack', 'Maggi', 'maggi-4', 'food-beverages', '🍜', 54, 60, 30, { unit: '4 × 70 g' }],
    ['Britannia Good Day Cashew 200 g', 'Britannia', 'goodday-200', 'food-beverages', '🍪', 42, 50, 21, { unit: '200 g' }],
    ['Surf Excel Easy Wash 1 kg', 'Surf Excel', 'detergent-1kg', 'general-store', '🧺', 139, 160, 16, { unit: '1 kg' }],
    ['Vim Dishwash Bar · 3 pack', 'Vim', 'dishwash-3', 'general-store', '🧽', 45, 50, 28, { unit: '3 × 200 g' }],
    ['Amul Butter 500 g', 'Amul', 'butter-500', 'dairy-products', '🧈', 280, 300, 6, { unit: '500 g', returnDays: 0 }]
  ],
  'sunrise-bakery': [
    ['Sourdough Country Loaf', 'Sunrise Bakehouse', 'bread-sourdough', 'bakery', '🍞', 110, 120, 7, { image: '/public/assets/showcase-bread.jpg', unit: '450 g loaf', returnDays: 1 }],
    ['Chocolate Brownie · 2 pcs', 'Sunrise Bakehouse', 'brownie-2', 'bakery', '🍫', 120, 140, 12, { unit: '2 pieces', returnDays: 1 }],
    ['Butter Croissant', 'Sunrise Bakehouse', 'croissant', 'bakery', '🥐', 65, 75, 10, { unit: '1 piece', returnDays: 1 }],
    ['Whole Wheat Bread 400 g', 'Sunrise Bakehouse', 'bread-wheat', 'bakery', '🍞', 45, 50, 14, { unit: '400 g loaf', returnDays: 1 }],
    ['Red Velvet Pastry', 'Sunrise Bakehouse', 'redvelvet-pastry', 'bakery', '🍰', 95, 110, 8, { unit: '1 slice', returnDays: 1 }],
    ['Chocolate Birthday Cake 500 g', 'Sunrise Bakehouse', 'cake-500', 'bakery', '🎂', 550, 650, 3, { unit: '500 g · eggless', returnDays: 0, desc: 'Eggless chocolate truffle cake. Order at least 24 hours in advance; the seller will confirm the message on the cake.' }]
  ],
  'tech-corner': [
    ['boAt Rockerz 255 Neckband', 'boAt', 'boat-255', 'electronics', '🎧', 1299, 2999, 8, { unit: '1 unit · black', returnDays: 7, desc: 'Wireless neckband with up to 8 hours playback. Demo listing — warranty is not processed by this prototype.' }],
    ['USB-C Fast Charger 33 W', 'Mi', 'charger-33w', 'mobile-accessories', '🔌', 899, 1499, 12, { unit: '1 adapter', returnDays: 7, desc: '33 W USB-C fast charger with a type-C cable.' }],
    ['SanDisk microSD 64 GB', 'SanDisk', 'microsd-64', 'mobile-accessories', '💾', 599, 899, 15, { unit: '64 GB · class 10', returnDays: 7, desc: 'Class 10 microSD card for phones and cameras.' }],
    ['Logitech Wireless Mouse', 'Logitech', 'mouse-wireless', 'electronics', '🖱️', 699, 995, 9, { unit: '1 mouse', returnDays: 7, desc: '2.4 GHz wireless mouse with a 12-month battery.' }],
    ['HDMI Cable 2 m', 'Ambrane', 'hdmi-2m', 'electronics', '🔗', 249, 399, 20, { unit: '2 m', returnDays: 7, desc: '4K HDMI 2.0 cable for TVs, laptops and consoles.' }],
    ['Smart LED Bulb 9 W', 'Wipro', 'bulb-9w', 'electronics', '💡', 449, 699, 4, { unit: '9 W · 16 million colours', returnDays: 7, desc: 'Wi-Fi smart bulb with app and voice control.' }]
  ],
  'glow-beauty': [
    ['Dove Intense Repair Shampoo 340 ml', 'Dove', 'shampoo-340', 'beauty-personal-care', '🧴', 349, 375, 10, { unit: '340 ml' }],
    ['Lakmé Face Wash 100 g', 'Lakmé', 'facewash-100', 'beauty-personal-care', '🧖', 199, 250, 14, { unit: '100 g' }],
    ['Nivea Body Lotion 400 ml', 'Nivea', 'lotion-400', 'beauty-personal-care', '🧴', 399, 475, 9, { unit: '400 ml' }],
    ['Maybelline Colossal Kajal', 'Maybelline', 'kajal', 'cosmetics', '👁️', 149, 199, 22, { unit: '0.35 g', returnDays: 0 }],
    ['Sunscreen SPF 50 · 50 g', 'Dot & Key', 'sunscreen-50', 'cosmetics', '☀️', 449, 599, 6, { unit: '50 g gel', returnDays: 0 }],
    ['Colgate Strong Teeth 200 g', 'Colgate', 'toothpaste-200', 'beauty-personal-care', '🪥', 105, 110, 20, { unit: '200 g' }]
  ],
  'petal-and-pot': [
    ['Ceramic Planter · Set of 3', 'Petal & Pot', 'planter-3', 'home-kitchen', '🪴', 649, 899, 5, { unit: '3 planters · 4 inch', returnDays: 7 }],
    ['Money Plant with Pot', 'Petal & Pot', 'money-plant', 'home-kitchen', '🌿', 249, 349, 8, { unit: '1 live plant · 6 inch pot', returnDays: 3, desc: 'An easy-care money plant in a hand-glazed pot. Water twice a week.' }],
    ['Scented Candle · Set of 3', 'Petal & Pot', 'candle-3', 'toys-gifts', '🕯️', 399, 499, 12, { unit: '3 × 100 g', returnDays: 7 }],
    ['Cotton Bedsheet · Queen', 'Spaces', 'bedsheet-queen', 'home-kitchen', '🛏️', 799, 1299, 4, { unit: '90 × 100 inch · 2 pillow covers', returnDays: 7 }],
    ['Steel Water Bottle 1 L', 'Milton', 'bottle-1l', 'home-kitchen', '🍶', 349, 499, 10, { unit: '1 L · brushed steel', returnDays: 7 }],
    ['Birthday Gift Hamper', 'Petal & Pot', 'gift-hamper', 'toys-gifts', '🎁', 899, 1199, 3, { unit: '1 hamper', returnDays: 0, desc: 'A candle, a mini plant and a box of chocolates in a reusable basket.' }]
  ],
  'fitzone-sports': [
    ['Yoga Mat 6 mm', 'Boldfit', 'yogamat-6', 'sports-fitness', '🧘', 599, 999, 7, { unit: '6 mm · anti-slip', returnDays: 7 }],
    ['Adjustable Dumbbell 5 kg', 'Kore', 'dumbbell-5', 'sports-fitness', '🏋️', 1299, 1999, 4, { unit: '5 kg · single', returnDays: 7 }],
    ['Cricket Tennis Ball · 3 pack', 'Cosco', 'tennis-ball-3', 'sports-fitness', '🎾', 180, 240, 12, { unit: '3 balls' }],
    ['Badminton Racket', 'Yonex', 'badminton-racket', 'sports-fitness', '🏸', 899, 1299, 6, { unit: '1 racket · aluminium', returnDays: 7 }],
    ['Sports Water Bottle 750 ml', 'Nivia', 'sports-bottle-750', 'sports-fitness', '🥤', 299, 399, 15, { unit: '750 ml' }]
  ]
};

function hoursLabel(shop) {
  return `${shop.opens} – ${shop.closes}`;
}

function seedAddresses(customerId) {
  const stmt = db.prepare(`INSERT INTO nb_addresses
    (id,user_id,label,receiver,phone,line1,line2,locality,city,pincode,landmark,instructions,lat,lng,is_default,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const addr = [
    ['Home', 'Priya Sharma', '98110 22334', 'B-12, 2nd floor', 'Hauz Khas Enclave', 'Hauz Khas', 'New Delhi', '110016', 'Near Deer Park gate', 'Ring the bell twice; leave with the guard if unavailable.', 28.5494, 77.2001, 1],
    ['Work', 'Priya Sharma', '98110 22334', 'WeWork, 4th floor', 'Neb Sarai', 'Saket', 'New Delhi', '110017', 'Opposite Select Citywalk', 'Reception desk, ask for Priya.', 28.5245, 77.2066, 0]
  ];
  for (const a of addr) {
    stmt.run(uid(), customerId, ...a, now());
  }
}

function directOrder({ customerId, shopId, items, fulfillment, status, priceOf, paymentStatus, daysAgo, isDemo = 1, note }) {
  const shop = db.prepare('SELECT * FROM nb_shops WHERE id=?').get(shopId);
  if (!shop || !items.length) return;
  const at = new Date(Date.now() - daysAgo * 864e5);
  const created = at.toISOString();
  const orderId = uid();
  const code = 'NB-' + created.slice(2, 10).replace(/-/g, '') + '-' + String(Math.floor(Math.random() * 9000) + 1000);
  const sellerOrderId = uid();
  const sellerCode = 'ORD-' + String(Math.floor(Math.random() * 900000) + 100000);
  let subtotal = 0;
  const lines = items.map(([productId, qty]) => {
    const p = db.prepare('SELECT * FROM nb_products WHERE id=?').get(productId);
    if (!p) throw new Error('seed product missing ' + productId);
    const line = p.price_paise * qty;
    subtotal += line;
    return { p, qty, line };
  });
  const tax = Math.round(lines.reduce((t, l) => t + (l.line * l.p.tax_rate) / 100, 0));
  const deliveryFee = fulfillment === 'delivery' ? shop.delivery_fee_paise : shop.pickup_fee_paise;
  const total = subtotal + deliveryFee + tax;
  const address = db.prepare('SELECT * FROM nb_addresses WHERE user_id=? ORDER BY is_default DESC LIMIT 1').get(customerId);
  const addressJson = JSON.stringify(address ? {
    id: address.id, label: address.label, receiver: address.receiver, phone: address.phone,
    line1: address.line1, line2: address.line2, locality: address.locality, city: address.city,
    pincode: address.pincode, landmark: address.landmark, instructions: address.instructions,
    lat: address.lat, lng: address.lng
  } : { label: 'Home', receiver: 'Priya Sharma', line1: 'B-12', locality: 'Hauz Khas', city: 'New Delhi', pincode: '110016' });

  db.prepare(`INSERT INTO nb_orders
    (id,code,customer_id,status,payment_method,payment_status,address_json,subtotal_paise,discount_paise,delivery_fee_paise,tax_paise,total_paise,coupon_code,note,idempotency_key,is_demo,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,0,?,?,?,NULL,?,NULL,?,?,?)`).run(
    orderId, code, customerId, status === 'completed' ? 'completed' : 'in_progress', 'cod', paymentStatus,
    addressJson, subtotal, deliveryFee, tax, total, note || null, isDemo, created, created
  );
  db.prepare(`INSERT INTO nb_seller_orders
    (id,code,order_id,shop_id,status,fulfillment,subtotal_paise,discount_paise,delivery_fee_paise,tax_paise,total_paise,prep_minutes,ready_at,accepted_at,rejected_reason,cancelled_at,delivered_at,completed_at,runner_id,delivery_otp_expires,delivery_attempts,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,NULL,NULL,?,?,NULL,?,0,?,?)`).run(
    sellerOrderId, sellerCode, orderId, shopId, status === 'completed' ? 'completed' : 'placed', fulfillment,
    subtotal, deliveryFee, tax, total, shop.prep_minutes,
    status === 'ready' ? created : null, status === 'completed' ? created : null,
    status === 'completed' ? created : null, status === 'completed' ? created : null,
    fulfillment === 'delivery' ? new Date(at.getTime() + 864e5).toISOString() : null, created, created
  );
  const insertItem = db.prepare(`INSERT INTO nb_order_items
    (id,order_id,seller_order_id,product_id,shop_id,name,brand,unit,qty,price_paise,mrp_paise,tax_rate,line_total_paise,image_url,emoji,compare_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const l of lines) {
    insertItem.run(uid(), orderId, sellerOrderId, l.p.id, shopId, l.p.name, l.p.brand, l.p.unit, l.qty,
      l.p.price_paise, l.p.mrp_paise, l.p.tax_rate, l.line, l.p.image_url, l.p.emoji, l.p.compare_key);
  }
  const events = [];
  if (status === 'completed') {
    events.push(['placed', 'Order placed', 'Payment method: cash on delivery'], ['accepted', 'Seller accepted', shop.name + ' confirmed your order'], ['preparing', 'Preparing order', 'Your items are being packed'], ['ready', 'Ready', fulfillment === 'delivery' ? 'Waiting for a delivery partner' : 'Ready for collection'], ['delivered', 'Delivered', 'Order completed. Thanks for shopping local!']);
  } else if (status === 'ready') {
    events.push(['placed', 'Order placed', 'Waiting for the seller to accept'], ['accepted', 'Seller accepted', shop.name + ' confirmed your order'], ['preparing', 'Preparing order', 'Your items are being packed'], ['ready', 'Ready for collection', 'Show your collection code at the counter']);
  } else {
    events.push(['placed', 'Order placed', 'Waiting for the seller to accept']);
  }
  let t = at.getTime();
  for (const [s, label, detail] of events) {
    t += 12 * 60000;
    db.prepare('INSERT INTO nb_order_events(order_id,seller_order_id,status,label,detail,actor,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(orderId, sellerOrderId, s, label, detail, 'system', new Date(t).toISOString());
  }
  return { orderId, sellerOrderId, code, sellerCode, lines, subtotal, deliveryFee, tax, total, created };
}

module.exports = function seed() {
  if (!seedEnabled) return { seeded: false, reason: 'disabled' };
  const existing = db.prepare('SELECT COUNT(*) AS c FROM nb_shops').get();
  if (existing && Number(existing.c) > 0) return { seeded: false, reason: 'already seeded' };

  const runSeed = () => {
    for (const [slug, name, icon, tone, sort] of CATEGORIES) {
      db.prepare('INSERT INTO nb_categories(slug,name,icon,tone,sort,active) VALUES(?,?,?,?,?,1)').run(slug, name, icon, tone, sort);
    }
    for (const [pincode, locality, city, lat, lng] of AREAS) {
      db.prepare('INSERT INTO nb_service_areas(pincode,locality,city,lat,lng,active) VALUES(?,?,?,?,?,1)').run(pincode, locality, city, lat, lng);
    }

    const createUser = (role, name, email, phone, password, demo = 1) => {
      const id = uid();
      db.prepare(`INSERT INTO nb_users(id,role,name,email,phone,password_hash,email_verified,phone_verified,avatar,status,is_demo,created_at)
        VALUES(?,?,?,?,?,?,1,1,?, 'active',?,?)`).run(id, role, name, email, phone, makePassword(password), role === 'customer' ? '👩' : role === 'seller' ? '🧑‍💼' : '🛵', demo, now());
      if (role === 'customer') {
        db.prepare('INSERT INTO nb_customer_profiles(user_id,marketing_opt_in,order_updates,created_at) VALUES(?,1,1,?)').run(id, now());
      }
      return id;
    };

    const customerId = createUser('customer', 'Priya Sharma', 'customer@nearbuy.demo', '9811022334', 'Customer123!');
    const riyaId = createUser('customer', 'Riya Sharma', 'riya@nearbuy.demo', '9811122233', 'NearBuy123!');
    const nishaId = createUser('customer', 'Nisha Dutta', 'nisha@nearbuy.demo', '9811199887', 'Customer123!');
    seedAddresses(customerId);
    seedAddresses(riyaId);
    db.prepare(`INSERT INTO nb_addresses(id,user_id,label,receiver,phone,line1,line2,locality,city,pincode,landmark,instructions,lat,lng,is_default,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(uid(), nishaId, 'Home', 'Nisha Dutta', '9811199887', 'H-4', 'Greater Kailash II', 'Greater Kailash', 'New Delhi', '110048', 'Near the market', null, 28.5494, 77.2426, 1, now());

    const sellerOwner = createUser('seller', 'Riya Sharma', 'owner@nearbuy.demo', '9876543210', 'Seller123!');
    const stationeryOwner = createUser('seller', 'Dev Mehta', 'stationery@nearbuy.demo', '9876543211', 'Seller123!');
    const pharmacyOwner = createUser('seller', 'Sana Khan', 'pharmacy@nearbuy.demo', '9876543212', 'Seller123!');
    createUser('admin', 'Ops Desk', 'admin@nearbuy.demo', '9876500000', 'Admin123!');

    const runner1 = createUser('runner', 'Rohan Kumar', 'rohan@nearbuy.demo', '9911002200', 'Runner123!');
    const runner2 = createUser('runner', 'Meera Joshi', 'meera@nearbuy.demo', '9911002201', 'Runner123!');
    const runner3 = createUser('runner', 'Sameer Ali', 'sameer@nearbuy.demo', '9911002202', 'Runner123!');
    db.prepare('INSERT INTO nb_runners(user_id,vehicle,status,lat,lng,rating,completed,active) VALUES(?,?,?,?,?,?,?,1)').run(runner1, 'scooter', 'online', 28.5490, 77.2010, 4.9, 412);
    db.prepare('INSERT INTO nb_runners(user_id,vehicle,status,lat,lng,rating,completed,active) VALUES(?,?,?,?,?,?,?,1)').run(runner2, 'bike', 'online', 28.5510, 77.2050, 4.8, 286);
    db.prepare('INSERT INTO nb_runners(user_id,vehicle,status,lat,lng,rating,completed,active) VALUES(?,?,?,?,?,?,?,1)').run(runner3, 'bicycle', 'offline', 28.5300, 77.2100, 4.7, 91);

    const owners = {
      'owner@nearbuy.demo': sellerOwner,
      'stationery@nearbuy.demo': stationeryOwner,
      'pharmacy@nearbuy.demo': pharmacyOwner
    };

    const shopIds = {};
    for (const s of SHOPS) {
      const id = uid();
      shopIds[s.slug] = id;
      db.prepare(`INSERT INTO nb_shops
        (id,slug,owner_user_id,name,category_slug,tagline,description,emoji,tone,phone,address,locality,city,pincode,lat,lng,rating,review_count,verified,is_open,opens_at,closes_at,prep_minutes,delivery_enabled,pickup_enabled,delivery_fee_paise,free_delivery_over_paise,pickup_fee_paise,min_order_paise,radius_km,service_pincodes,badge,created_at,proprietor_name)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, s.slug, s.owner ? owners[s.owner] : null, s.name, s.category, s.tagline, s.description, s.emoji, s.tone,
        '011-' + Math.floor(40000000 + Math.random() * 9000000), s.address, s.locality, 'New Delhi', s.pincode, s.lat, s.lng,
        s.rating, s.reviews, s.verified, s.open, s.opens, s.closes, s.prep, s.delivery, s.pickup,
        rupees(s.deliveryFee), rupees(s.freeOver), rupees(s.pickupFee), rupees(s.minOrder), s.radius, s.pins, s.badge, now(),
        s.ownerName || null
      );

      const rows = CATALOGUE[s.slug] || [];
      rows.forEach((row, index) => {
        const [name, brand, compareKey, category, emoji, price, mrp, stock, opts = {}] = row;
        const pid = `${s.slug}-${compareKey}${index >= 0 ? '' : ''}`;
        const uniqueId = rows.findIndex((r) => r[2] === compareKey) === index ? pid : `${pid}-${index}`;
        db.prepare(`INSERT INTO nb_products
          (id,shop_id,category_slug,compare_key,name,brand,variant,description,highlights,specs,unit,pack_size,emoji,image_url,price_paise,mrp_paise,tax_rate,stock,reserved,low_stock,return_days,rating,review_count,active,is_demo,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,1,1,?)`).run(
          uniqueId, id, category, compareKey, name, brand, null,
          opts.desc || `Everyday ${name.toLowerCase()} from ${s.name}, delivered from your neighbourhood.`,
          JSON.stringify(opts.highlights || []), JSON.stringify(opts.specs || []),
          opts.unit || '1 pc', opts.pack || null, emoji, opts.image || null,
          rupees(price), rupees(mrp), opts.tax ?? 5, stock, Math.max(2, Math.round(stock / 5)),
          opts.returnDays ?? 0, 4.2 + ((index % 5) * 0.15), 6 + ((index * 7) % 40), now()
        );
        if (opts.image) {
          db.prepare('INSERT INTO nb_product_images(product_id,url,sort) VALUES(?,?,0)').run(uniqueId, opts.image);
        }
      });
    }

    const products = (slug) => db.prepare('SELECT p.* FROM nb_products p JOIN nb_shops s ON s.id=p.shop_id WHERE s.slug=?').all(slug);
    const find = (slug, key) => products(slug).find((p) => p.compare_key === key);

    // Coupons
    const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString();
    const addCoupon = (code, title, desc, type, value, min, max, shopId, days, limit, active = 1) => {
      db.prepare(`INSERT INTO nb_coupons(code,title,description,type,value,min_order_paise,max_discount_paise,shop_id,starts_at,ends_at,usage_limit,used_count,per_customer_limit,active)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,0,1,?)`).run(code, title, desc, type, value, min, max, shopId || null, new Date(Date.now() - 864e5).toISOString(), inDays(days), limit || null, active);
    };
    addCoupon('WELCOME10', '10% off your first basket', 'Up to ₹100 off on orders above ₹299, all participating shops.', 'percent', 10, rupees(299), rupees(100), null, 60, 5000);
    addCoupon('FRESH50', '₹50 off at Fresh Mart', 'On Fresh Mart orders above ₹499. One use per customer.', 'fixed', rupees(50), rupees(499), null, shopIds['fresh-mart'], 30, 500);
    addCoupon('FREEDEL', 'Free delivery', 'Free delivery on orders above ₹199.', 'free_delivery', 0, rupees(199), null, null, 45, 1000);
    addCoupon('SAVE15', '15% off orders above ₹799', 'Maximum discount ₹150. Participating shops only.', 'percent', 15, rupees(799), rupees(150), null, 30, 1000);
    addCoupon('BOOKWORM20', '20% off stationery', '20% off at Scribble Stationery, up to ₹80.', 'percent', 20, rupees(199), rupees(80), shopIds['scribble-stationery'], 20, 300);
    addCoupon('EXPIRED10', 'Expired offer', 'This coupon has expired and must never be shown as active.', 'percent', 10, rupees(199), rupees(100), null, -5, 100, 1);

    // Banners (manageable from the admin API)
    db.prepare(`INSERT INTO nb_banners(id,title,subtitle,eyebrow,cta_label,cta_link,image_url,theme,active,sort) VALUES(?,?,?,?,?,?,?,?,1,1)`)
      .run(uid(), 'Shop Local. Support Local.', 'Discover the best deals from shops around you — fresh produce, everyday essentials and neighbourhood favourites, delivered in minutes.', 'Your neighbourhood marketplace', 'Start Shopping', '#/shops', '/public/assets/discover-local-market.jpg', 'blue');
    db.prepare(`INSERT INTO nb_banners(id,title,subtitle,eyebrow,cta_label,cta_link,image_url,theme,active,sort) VALUES(?,?,?,?,?,?,?,?,1,2)`)
      .run(uid(), 'Fresh Fridays', 'Up to 25% off fruit, vegetables and bakery favourites. Use code FREEDEL for free delivery over ₹199.', 'This week at nearby shops', 'Browse fresh picks', '#/categories/fruits-vegetables', '/public/assets/discover-bananas.jpg', 'green');
    db.prepare(`INSERT INTO nb_banners(id,title,subtitle,eyebrow,cta_label,cta_link,image_url,theme,active,sort) VALUES(?,?,?,?,?,?,?,?,1,3)`)
      .run(uid(), 'Medicines at your door', 'MediPlus Pharmacy is open 24 hours. Essentials delivered in under 30 minutes.', 'Pharmacy nearby', 'Shop pharmacy', '#/categories/pharmacy', '/public/assets/discover-eggs.jpg', 'cyan');

    // FAQs
    const faqs = [
      ['Orders', 'How does delivery work?', 'Each shop fulfils its own part of your basket. Choose home delivery or store pickup per shop at checkout. Delivery fees, minimum order values and estimated times are set by each seller and shown before you pay.'],
      ['Orders', 'Can I order from more than one shop?', 'Yes. Your basket is grouped by shop and becomes one parent order with a separate order for each shop. Sellers only ever see their own items and only ever receive their own share of the payment.'],
      ['Delivery', 'How do I know my order is nearby?', 'Open Orders → your order. Once a seller accepts and prepares it, the status timeline updates as the order is picked up and sent out for delivery. If a NearBuy runner is assigned, their name and status appear on the order page.'],
      ['Delivery', 'What is the delivery OTP for?', 'For home delivery, the runner must enter the 6-digit code shown on your order page before the order can be marked delivered. Never share the code before you have the items.'],
      ['Pickup', 'How does store pickup work?', 'Choose Store pickup at checkout for a shop that offers it. You will get a collection code on your order page. Show it at the counter; the shop marks the order complete once it is handed over.'],
      ['Payments', 'Which payment methods can I use?', 'Cash on delivery and pay at store work today. UPI, cards, net banking and wallets are enabled as soon as a payment gateway is configured for the deployment — the checkout says clearly when online payment is unavailable.'],
    ['Refunds', 'When will I get my refund?', 'Cancelled and approved return amounts are refunded to the original payment method. Cash-on-delivery refunds are recorded for a bank transfer or store credit arranged by the shop. A refund is only marked completed after the payment provider confirms it.'],
      ['Refunds', 'Can I cancel after ordering?', 'Yes, until the seller starts preparing the order. After that, contact support or request a return once the order is delivered. The cancel button on the order page only appears when cancellation is still possible.'],
      ['Returns', 'What can I return?', 'Perishables such as milk, eggs and cut fruit are not returnable unless they arrive damaged. Packaged goods, stationery and household items can be returned within the return window shown on the product page.'],
      ['Account', 'Do I need an account to browse?', 'No. You can browse shops, products and offers without signing in. An account is needed to save a wishlist, write reviews, or place and track an order.'],
      ['Account', 'How do I change my mobile number?', 'Open My Account → Profile. The new number must be verified with a one-time code before it replaces the old one.'],
      ['Support', 'How do I raise a complaint?', 'Open Help & Support, choose a category, and add your order number if relevant. You will get a ticket reference and can follow every reply in Help → My tickets.']
    ];
    faqs.forEach(([category, question, answer], i) => {
      db.prepare('INSERT INTO nb_faqs(category,question,answer,sort) VALUES(?,?,?,?)').run(category, question, answer, i);
    });

    // Demo orders for the demo customer
    try {
      const freshMilk = find('fresh-mart', 'amul-taaza-1l');
      const freshEggs = find('fresh-mart', 'eggs-6');
      const freshBanana = find('fresh-mart', 'bananas-6');
      const freshBread = find('fresh-mart', 'bread-sourdough');
      const greenApples = find('green-basket', 'apples-4');
      const greenSpinach = find('green-basket', 'spinach-1');
      directOrder({
        customerId, shopId: shopIds['fresh-mart'],
        items: [[freshMilk.id, 2], [freshEggs.id, 1], [freshBanana.id, 1], [freshBread.id, 1]],
        fulfillment: 'delivery', status: 'completed', priceOf: null, paymentStatus: 'paid', daysAgo: 5,
        note: 'Demo delivered order — cash paid on delivery.'
      });
      directOrder({
        customerId, shopId: shopIds['green-basket'],
        items: [[greenApples.id, 1], [greenSpinach.id, 2]],
        fulfillment: 'pickup', status: 'ready', priceOf: null, paymentStatus: 'pending', daysAgo: 1,
        note: 'Demo pickup order — pay at the counter.'
      });
      directOrder({
        customerId, shopId: shopIds['fresh-mart'],
        items: [[freshMilk.id, 1], [freshBread.id, 1]],
        fulfillment: 'delivery', status: 'placed', priceOf: null, paymentStatus: 'pending', daysAgo: 0,
        note: 'Demo order placed today — waiting for the seller.'
      });

      // Verified review from the delivered order
      const delivered = db.prepare("SELECT * FROM nb_seller_orders WHERE shop_id=? ORDER BY created_at ASC LIMIT 1").get(shopIds['fresh-mart']);
      if (delivered) {
        const milk = db.prepare('SELECT * FROM nb_products WHERE compare_key=? LIMIT 1').get('amul-taaza-1l');
        const reviewId = uid();
        db.prepare(`INSERT INTO nb_reviews(id,customer_id,shop_id,product_id,seller_order_id,order_id,shop_rating,product_rating,title,body,images_json,verified_purchase,status,created_at)
          VALUES(?,?,?,?,?,?,5,5,?,?, '[]',1,'published',?)`).run(
          reviewId, customerId, shopIds['fresh-mart'], milk.id, delivered.id, delivered.order_id,
          'Fresh and well packed', 'The milk and eggs arrived cold and the bread was still warm. The shop called to check if I needed anything else — this is why I shop local.', new Date(Date.now() - 3 * 864e5).toISOString()
        );
        db.prepare('UPDATE nb_products SET review_count=review_count+1 WHERE id=?').run(milk.id);
      }

      // Notifications for demo customer
      const notify = (title, body, type, link, read, hoursAgo) => db.prepare(
        'INSERT INTO nb_notifications(user_id,title,body,type,link,is_read,created_at) VALUES(?,?,?,?,?,?,?)'
      ).run(customerId, title, body, type, link, read, new Date(Date.now() - hoursAgo * 36e5).toISOString());
      notify('Your Fresh Mart order was delivered', 'Order delivered. Rate your products and shop to help your neighbours.', 'order', '#/orders', 0, 3);
      notify('Green Basket is ready for pickup', 'Your collection code is on the order page. The shop is open until 21:30.', 'order', '#/orders', 0, 16);
      notify('Fresh Mart received your order', 'The seller has been notified and will accept it shortly.', 'order', '#/orders', 1, 20);
      notify('A new offer near you', 'Use WELCOME10 for 10% off your next basket above ₹299.', 'offer', '#/offers', 1, 40);
    } catch (err) {
      // Sample orders must never prevent the catalogue from starting.
      // eslint-disable-next-line no-console
      console.error('[nearbuy] demo order seed skipped:', err.message);
    }

    audit('system', null, 'seed', 'platform', null, 'Demo catalogue, accounts and sample orders created');
    return { seeded: true };
  };

  transaction(runSeed);
  return { seeded: true };
};
