#!/usr/bin/env node
/*
 * tools/build-site.mjs — emits every public marketing page of the NearBuy
 * website from one shared layout, so the header, search, footer and design
 * system can never drift between pages.
 *
 *   node tools/build-site.mjs
 *
 * Pages written:
 *   index.html               home
 *   shops/index.html         live shop directory  (filters + pagination -> API)
 *   categories/index.html    category directory   (-> storefront)
 *   offers/index.html        live offers          (-> storefront)
 *   how-it-works/index.html  the neighbourhood model end to end
 *   sell/index.html          seller proposition + registration (-> API)
 *   deliver/index.html       delivery-partner proposition + application
 *   about/index.html         company, story, trust & safety
 *   help/index.html          help centre (live FAQs) + enquiry form (-> API)
 *   contact/index.html       contact routes + enquiry form (-> API)
 *   policies/index.html      privacy, terms, refunds, cookies
 *   checklist/index.html     the 84-item feature checklist (localStorage)
 *
 * Data for the live blocks is read from tools/site-data/*.json, captured from
 * the running API. Refresh those files and re-run this script when the seed
 * catalogue changes; the pages themselves always fetch live data in the
 * browser for anything that has to be current (shop directory, search).
 *
 * This script is the single source of truth for every marketing page: edit a
 * section here and re-run it, rather than editing the generated HTML by hand.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = process.cwd();
const read = (p) => JSON.parse(readFileSync(join(ROOT, 'tools/site-data', p), 'utf8'));

const home = read('home.json');
const shopsData = read('shops.json');
const categoriesData = read('categories.json');
const offersData = read('offers.json');
const faqsData = read('faqs.json');
const reviewsData = read('reviews.json');
const localitiesData = read('localities.json');

const SHOPS = shopsData.shops || [];
const CATEGORIES = categoriesData.categories || [];
const OFFERS = offersData.offers || [];
const FAQS = faqsData.faqs || [];
const REVIEWS = reviewsData.reviews || [];
const AREAS = localitiesData.localities || [];
const STATS = home.stats || { shops: 10, products: 90, categories: 20, localities: 12 };
const BANNERS = home.banners || [];

const money = (paise) => {
  const n = Number(paise || 0) / 100;
  return '₹' + (Number.isInteger(n) ? n.toLocaleString('en-IN') : n.toFixed(2));
};
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* Shop imagery: the seeded catalogue ships a few product photos; each shop is
   matched to the closest one so cards never show a broken image. */
const SHOP_ART = {
  'fresh-mart': '/public/assets/site/produce.jpg',
  'green-basket-market': '/public/assets/site/produce.jpg',
  'daily-needs-kirana': '/public/assets/site/produce.jpg',
  'sunrise-bakery': '/public/assets/site/bakery.jpg',
  'mediplus-pharmacy': '/public/assets/site/pharmacy.jpg',
  'scribble-stationery': '/public/assets/site/parcels.jpg',
  'petal-and-pot': '/public/assets/site/parcels.jpg',
  'glow-beauty-studio': '/public/assets/site/parcels.jpg',
  'tech-corner': '/public/assets/site/parcels.jpg',
  'fitzone-sports': '/public/assets/site/parcels.jpg'
};
const shopArt = (slug) => SHOP_ART[slug] || '/public/assets/site/parcels.jpg';

/* Category / shop iconography — inline strokes, no emoji, identical on every OS */
const CAT_ICON = {
  groceries: '<path d="M4.5 9h15l-1.6 8.4a2 2 0 0 1-2 1.6H8a2 2 0 0 1-2-1.6z"/><path d="M8.4 9 7 4.4M15.6 9 17 4.4"/><path d="M9.6 12.6v3.2M14.4 12.6v3.2"/>',
  'fruits-vegetables': '<path d="M4 20c0-8 5-14 16-15 0 11-6 16-13 16"/><path d="M4 20c3-5 7-8 12-10"/>',
  'dairy-products': '<path d="M10 3h4v3l2 3v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V9l2-3z"/><path d="M8 12.5h8"/>',
  'food-beverages': '<path d="M4 8h12v6.5a4.5 4.5 0 0 1-4.5 4.5H8.5A4.5 4.5 0 0 1 4 14.5z"/><path d="M16 9.5h2a2.5 2.5 0 0 1 0 5h-2"/><path d="M8 4.5v1.5M12 4.5v1.5"/>',
  'general-store': '<path d="M3.4 9.4 5 4h14l1.6 5.4"/><path d="M4 9.4h16V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M9.4 21v-5.6h5.2V21"/>',
  stationery: '<path d="m4 20 1.4-4.6L16 4.9a2.1 2.1 0 0 1 3 3L8.5 18.5z"/><path d="m14.4 6.6 3 3"/>',
  books: '<path d="M4.5 4.5h5A2.5 2.5 0 0 1 12 7v13a2.6 2.6 0 0 0-2.5-2H4.5z"/><path d="M19.5 4.5h-5A2.5 2.5 0 0 0 12 7v13a2.6 2.6 0 0 1 2.5-2h5z"/>',
  electronics: '<path d="M9 3v5M15 3v5"/><path d="M6.5 8h11v3a5.5 5.5 0 0 1-11 0z"/><path d="M12 16.5V21"/>',
  'mobile-accessories': '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M10.6 19h2.8"/>',
  clothing: '<path d="m9 3.2-5 2.4 1.6 4L8 8.6V21h8V8.6l2.4 1 1.6-4-5-2.4a3 3 0 0 1-6 0z"/>',
  footwear: '<path d="M3 18h11.5l4 2.5H4a1 1 0 0 1-1-1z"/><path d="M3 18v-8l3.2 1.2 2 3 3.3 1.1 2.6 2.1"/><path d="M9 13.5l2.5.8"/>',
  cosmetics: '<path d="m12 3.5 1.9 4.9 4.9 1.9-4.9 1.9L12 17l-1.9-4.8L5.2 10.3l4.9-1.9z"/><path d="M17.8 16.4l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"/>',
  'beauty-personal-care': '<path d="M9.5 8.5h5V19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2z"/><path d="M10.5 8.5V4.5h3v4"/><path d="M9.5 13h5"/>',
  'home-kitchen': '<path d="M4 10h16"/><path d="M6 10v6.5a3.5 3.5 0 0 0 3.5 3.5h5A3.5 3.5 0 0 0 18 16.5V10"/><path d="M9.5 6.2c0-1 .9-1.4 1.3-2.2M14 6.2c0-1-.9-1.4-1.3-2.2"/>',
  hardware: '<path d="M14.6 6.4a4.2 4.2 0 0 1 5.2 5.6l-2.4-2.3-1.6 1.6 2.3 2.4a4.2 4.2 0 0 1-5.6-5.2L4.6 19.4a1.7 1.7 0 0 1-2.4-2.4z"/>',
  pharmacy: '<path d="M9.6 3h4.8v6.6H21v4.8h-6.6V21H9.6v-6.6H3V9.6h6.6z"/>',
  'sports-fitness': '<path d="M3.5 9.5v5M7 7v10M17 7v10M20.5 9.5v5M7 12h10"/>',
  'toys-gifts': '<path d="M3.5 9h17v4h-17z"/><path d="M5 13h14v8H5z"/><path d="M12 9v12"/><path d="M12 9S10.4 4.2 8 4.2a2.4 2.4 0 0 0 0 4.8M12 9s1.6-4.8 4-4.8a2.4 2.4 0 0 1 0 4.8"/>',
  bakery: '<path d="M4 10.5a4.5 4.5 0 0 1 4.5-4.5h7A4.5 4.5 0 0 1 20 10.5V12H4z"/><path d="M4 12h16v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/><path d="M8.5 6.8V12M12 6.8V12M15.5 6.8V12"/>',
  other: '<circle cx="12" cy="12" r="9"/><path d="m15.2 8.8-1.9 5-5 1.9 1.9-5z"/>',
  shop: '<path d="M3.4 9.4 5 4h14l1.6 5.4"/><path d="M4 9.4h16V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M9.4 21v-5.6h5.2V21"/>',
  product: '<path d="M12 2.6 21 7v10l-9 4.4L3 17V7z"/><path d="m3 7 9 4.4L21 7"/><path d="M12 21.4V11.4"/>'
};
const catIcon = (slug, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${CAT_ICON[slug] || CAT_ICON.other}</svg>`;

/* ------------------------------------------------------------------ icons -- */
const SPRITE = `  <svg class="sprite" aria-hidden="true" focusable="false">
    <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M4 12h15"/><path d="m13 6 6 6-6 6"/></symbol>
    <symbol id="i-arrow-left" viewBox="0 0 24 24"><path d="M20 12H5"/><path d="m11 18-6-6 6-6"/></symbol>
    <symbol id="i-arrow-up" viewBox="0 0 24 24"><path d="M7 17 17 7"/><path d="M8.5 7H17v8.5"/></symbol>
    <symbol id="i-bag" viewBox="0 0 24 24"><path d="M6 7h12l1.2 12.7a1.2 1.2 0 0 1-1.2 1.3H6a1.2 1.2 0 0 1-1.2-1.3z"/><path d="M9 10V6.5a3 3 0 0 1 6 0V10"/></symbol>
    <symbol id="i-store" viewBox="0 0 24 24"><path d="M3.4 9.4 5 4h14l1.6 5.4"/><path d="M4 9.4h16V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M9.4 21v-5.6h5.2V21"/></symbol>
    <symbol id="i-truck" viewBox="0 0 24 24"><path d="M2.5 5.5h10.5v11H2.5z"/><path d="M13 8.5h4.2l3.8 3.8v4.2H13z"/><circle cx="6.6" cy="18.4" r="1.9"/><circle cx="17.4" cy="18.4" r="1.9"/></symbol>
    <symbol id="i-pin" viewBox="0 0 24 24"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="2.6"/></symbol>
    <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.9-3.9"/></symbol>
    <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5.4L12 2.5 4 5.4V12c0 6 8 10 8 10z"/><path d="m8.6 11.8 2.3 2.3 4.5-4.5"/></symbol>
    <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.4V12l3.2 2"/></symbol>
    <symbol id="i-star" viewBox="0 0 24 24"><path d="m12 3 2.7 5.7 6.3.9-4.6 4.4 1.1 6.2-5.5-3-5.5 3 1.1-6.2L3 9.6l6.3-.9z"/></symbol>
    <symbol id="i-check" viewBox="0 0 24 24"><path d="m4 12.6 5 5L20 6.6"/></symbol>
    <symbol id="i-heart" viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></symbol>
    <symbol id="i-box" viewBox="0 0 24 24"><path d="M12 2.6 21 7v10l-9 4.4L3 17V7z"/><path d="m3 7 9 4.4L21 7"/><path d="M12 21.4V11.4"/></symbol>
    <symbol id="i-chart" viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="m7 15 4-5 3 3 5-7"/></symbol>
    <symbol id="i-sparkle" viewBox="0 0 24 24"><path d="m12 3 1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18.4 15.6l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></symbol>
    <symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></symbol>
    <symbol id="i-x" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></symbol>
    <symbol id="i-rupee" viewBox="0 0 24 24"><path d="M6 3h12"/><path d="M6 8h12"/><path d="M6 13h3.6a5 5 0 0 0 0-10"/><path d="m6.4 13 8.6 8"/></symbol>
    <symbol id="i-users" viewBox="0 0 24 24"><path d="M16 21v-1a5 5 0 0 0-5-5H7a5 5 0 0 0-5 5v1"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-1a5 5 0 0 0-4-4.9"/><path d="M16.6 3.2a4 4 0 0 1 0 7.6"/></symbol>
    <symbol id="i-lock" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2.2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></symbol>
    <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3.8V9h-5.2"/></symbol>
    <symbol id="i-mail" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.2"/><path d="m3.6 6.5 8.4 6 8.4-6"/></symbol>
    <symbol id="i-phone" viewBox="0 0 24 24"><path d="M5 3h3.4l1.8 4.4-2.2 1.6a12 12 0 0 0 5 5l1.6-2.2L19 13.6V17a2 2 0 0 1-2.2 2A16 16 0 0 1 3 5.2 2 2 0 0 1 5 3z"/></symbol>
    <symbol id="i-layers" viewBox="0 0 24 24"><path d="m12 2.4 9 5-9 5-9-5z"/><path d="m3 12.4 9 5 9-5"/><path d="m3 17.4 9 5 9-5"/></symbol>
    <symbol id="i-inbox" viewBox="0 0 24 24"><path d="M3.5 12.6 6.2 4.8A2 2 0 0 1 8.1 3.4h7.8a2 2 0 0 1 1.9 1.4l2.7 7.8"/><path d="M3.5 12.6h4.2l1.5 2.6h5.6l1.5-2.6h4.2V18a2.4 2.4 0 0 1-2.4 2.4H5.9A2.4 2.4 0 0 1 3.5 18z"/></symbol>
    <symbol id="i-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
    <symbol id="i-chevron-right" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></symbol>
    <symbol id="i-alert" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5"/><path d="M12 16.2v.1"/></symbol>
    <symbol id="i-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></symbol>
    <symbol id="i-tag" viewBox="0 0 24 24"><path d="M3 12.4V4h8.4l9.2 9.2-8.4 8.4z"/><circle cx="7.4" cy="7.4" r="1.3"/></symbol>
    <symbol id="i-leaf" viewBox="0 0 24 24"><path d="M4 20c0-8 5-14 16-15 0 11-6 16-13 16"/><path d="M4 20c3-5 7-8 12-10"/></symbol>
    <symbol id="i-handshake" viewBox="0 0 24 24"><path d="M3 11.5 6 8l3 3 3-3 3 3 3-3 3 3.5-5.5 6-3-2.5-1.5 1.4-4-4z"/></symbol>
    <symbol id="i-home" viewBox="0 0 24 24"><path d="m3 10.5 9-7 9 7V21h-6v-6H9v6H3z"/></symbol>
  </svg>`;

/* ------------------------------------------------------------- header nav -- */
const NAV = [
  { label: 'Shop', key: 'shop', href: '/shops/', panel: [
    { href: '/shops/', icon: 'store', title: 'Nearby shops', desc: 'Ten verified shops across south Delhi' },
    { href: '/categories/', icon: 'layers', title: 'Browse categories', desc: 'Groceries, pharmacy, stationery and more' },
    { href: '/offers/', icon: 'tag', title: 'Offers & coupons', desc: 'Live codes from shops near you' },
    { href: '/customer/', icon: 'bag', title: 'Open the storefront', desc: 'Cart, checkout and delivery OTP' }
  ] },
  { label: 'How it works', key: 'how', href: '/how-it-works/', panel: [
    { href: '/how-it-works/', icon: 'layers', title: 'The neighbourhood model', desc: 'Discovery, order, fulfilment and settlement' },
    { href: '/how-it-works/#delivery', icon: 'truck', title: 'Delivery & pickup', desc: 'How a Runner job is accepted and handed over' },
    { href: '/how-it-works/#pricing', icon: 'rupee', title: 'Pricing & fees', desc: 'Who pays what, and what the shop keeps' },
    { href: '/how-it-works/#faq', icon: 'inbox', title: 'Common questions', desc: 'Answers straight from the live help centre' }
  ] },
  { label: 'Sell', key: 'sell', href: '/sell/' },
  { label: 'Deliver', key: 'deliver', href: '/deliver/' },
  { label: 'About', key: 'about', href: '/about/', panel: [
    { href: '/about/', icon: 'home', title: 'About NearBuy', desc: 'Why distance is the feature' },
    { href: '/about/#trust', icon: 'shield', title: 'Trust & safety', desc: 'Sessions, PINs, OTPs and audit logs' },
    { href: '/checklist/', icon: 'check', title: 'Feature checklist', desc: 'All 84 shipped capabilities, reviewable' }
  ] },
  { label: 'Help', key: 'help', href: '/help/', panel: [
    { href: '/help/', icon: 'inbox', title: 'Help centre', desc: 'FAQs, policies and the support desk' },
    { href: '/contact/', icon: 'mail', title: 'Contact us', desc: 'Write to the team, get a reference' },
    { href: '/policies/', icon: 'lock', title: 'Privacy & terms', desc: 'What we store and what we do not' }
  ] }
];

function navItem(item, active) {
  const current = item.key === active ? ' aria-current="page"' : '';
  if (!item.panel) {
    return `        <li class="nav__item"><a class="nav__link" href="${item.href}"${current}>${item.label}</a></li>`;
  }
  return `        <li class="nav__item nav__item--has-panel">
          <a class="nav__link" href="${item.href}"${current}>${item.label} ${icon('chevron')}</a>
          <div class="nav__panel nav__panel--wide">
            <p class="nav__panel-head">${item.label}</p>
${item.panel.map((p) => `            <a class="nav__panel-link" href="${p.href}">
              <span class="nav__panel-icon">${icon(p.icon)}</span>
              <span><b>${p.title}</b><small>${p.desc}</small></span>
            </a>`).join('\n')}
          </div>
        </li>`;
}

const BRAND_MARK = `<svg viewBox="0 0 40 40" focusable="false">
  <circle cx="20" cy="20" r="18.5" fill="#fff" stroke="#06245e" stroke-width="2.4" />
  <path d="M20 5.5a11 11 0 0 1 11 11c0 6.6-8.1 14.3-10.2 16.1a1.2 1.2 0 0 1-1.6 0C17.1 30.8 9 23.1 9 16.5a11 11 0 0 1 11-11z" fill="#06245e" />
  <path d="M13.6 12.6h12.8l1.5 4.2H12.1z" fill="#f47718" />
  <path d="M13.8 16.8h12.4v3.4a1.4 1.4 0 0 1-1.4 1.4h-9.6a1.4 1.4 0 0 1-1.4-1.4z" fill="#fff" />
  <rect x="17.4" y="18.2" width="2" height="2" rx=".4" fill="#06245e" />
  <rect x="20.6" y="18.2" width="2" height="2" rx=".4" fill="#06245e" />
  <path d="M19.9 21.6h1.4v3.1h-1.4z" fill="#06245e" />
  <path d="M6 33.4c4.5-1.6 9.6-2.4 14-2.4s9.5.8 14 2.4" stroke="#f47718" stroke-width="2.2" stroke-linecap="round" fill="none" />
</svg>`;

function header(active) {
  return `  <a class="skip" href="#main">Skip to content</a>
${SPRITE}

  <header class="site-header">
    <div class="header-strip">
      <div class="header-strip__inner">
        <a class="header-strip__loc" href="/shops/#directory" data-location-prompt>
          ${icon('pin')}<span>Delivering to</span><b data-location-label>Set your locality</b>
        </a>
        <div class="header-strip__links">
          <span class="header-strip__note"><i class="header-strip__dot" aria-hidden="true"></i> ${STATS.shops} shops · ${STATS.products} products live</span>
          <a href="/demo/">Demo accounts</a>
          <a href="/seller/">Seller Hub</a>
          <a href="/runner/">Runner Portal</a>
        </div>
      </div>
    </div>

    <div class="site-header__top">
      <a class="brand" href="/" aria-label="NearBuy home">
        <span class="brand__mark brand__mark--flat" aria-hidden="true">${BRAND_MARK}</span>
        <span class="brand__text"><span class="brand__word">Near<em>Buy</em></span><span class="brand__tag">Shop local · Live better</span></span>
      </a>

      <nav class="nav" aria-label="Primary">
        <ul class="nav__list">
${NAV.map((item) => navItem(item, active)).join('\n')}
        </ul>
      </nav>

      <div class="header-actions">
        <button class="header-search" type="button" data-open-search aria-label="Search shops and products">
          ${icon('search')} <span>Search</span>
        </button>
        <a class="header-tool" href="/customer/#/cart" aria-label="Your bag">${icon('bag')} <span>Bag</span></a>
        <a class="btn btn--ghost btn--sm header-cta header-cta--signin" href="/customer/login/">Sign in</a>
        <a class="btn btn--primary btn--sm header-cta header-cta--shop" href="/shops/">Shop nearby</a>
        <button class="nav-toggle" id="navToggle" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="mobileMenu">
          ${icon('menu')}
        </button>
      </div>
    </div>
  </header>

  <div class="mobile-menu" id="mobileMenu" hidden>
    <div class="mobile-menu__scrim" data-close-menu></div>
    <div class="mobile-menu__panel" role="dialog" aria-modal="true" aria-label="Site menu">
      <div class="mobile-menu__head">
        <a class="brand" href="/" aria-label="NearBuy home">
          <span class="brand__mark brand__mark--flat" aria-hidden="true">${BRAND_MARK}</span>
          <span class="brand__text"><span class="brand__word">Near<em>Buy</em></span></span>
        </a>
        <button class="nav-toggle mobile-menu__close" type="button" data-close-menu aria-label="Close menu">${icon('x')}</button>
      </div>
      <div class="mobile-menu__body">
        <div class="mobile-menu__group">
          <p class="mobile-menu__label">Shop</p>
          <a class="mobile-menu__link" href="/shops/"${active === 'shop' ? ' aria-current="page"' : ''}>${icon('store')} Nearby shops</a>
          <a class="mobile-menu__link" href="/categories/">${icon('layers')} Categories</a>
          <a class="mobile-menu__link" href="/offers/">${icon('tag')} Offers &amp; coupons</a>
          <a class="mobile-menu__link" href="/customer/">${icon('bag')} Storefront</a>
        </div>
        <div class="mobile-menu__group">
          <p class="mobile-menu__label">Platform</p>
          <a class="mobile-menu__link" href="/how-it-works/"${active === 'how' ? ' aria-current="page"' : ''}>${icon('layers')} How NearBuy works</a>
          <a class="mobile-menu__link" href="/sell/"${active === 'sell' ? ' aria-current="page"' : ''}>${icon('store')} Sell on NearBuy</a>
          <a class="mobile-menu__link" href="/deliver/"${active === 'deliver' ? ' aria-current="page"' : ''}>${icon('truck')} Deliver with Runner</a>
        </div>
        <div class="mobile-menu__group">
          <p class="mobile-menu__label">Company</p>
          <a class="mobile-menu__link" href="/about/"${active === 'about' ? ' aria-current="page"' : ''}>${icon('home')} About NearBuy</a>
          <a class="mobile-menu__link" href="/checklist/">${icon('check')} Feature checklist</a>
          <a class="mobile-menu__link" href="/demo/">${icon('sparkle')} Demo accounts</a>
        </div>
        <div class="mobile-menu__group">
          <p class="mobile-menu__label">Help</p>
          <a class="mobile-menu__link" href="/help/"${active === 'help' ? ' aria-current="page"' : ''}>${icon('inbox')} Help centre</a>
          <a class="mobile-menu__link" href="/contact/">${icon('mail')} Contact us</a>
          <a class="mobile-menu__link" href="/policies/">${icon('lock')} Privacy &amp; terms</a>
        </div>
        <div class="mobile-menu__foot">
          <a class="btn btn--primary btn--block" href="/shops/">Shop nearby</a>
          <a class="btn btn--ghost btn--block" href="/customer/login/">Sign in</a>
        </div>
      </div>
    </div>
  </div>

  <div class="search-dialog" id="siteSearch" hidden>
    <div class="search-dialog__scrim" data-close-search></div>
    <div class="search-dialog__panel" role="dialog" aria-modal="true" aria-label="Search NearBuy">
      <form class="search-dialog__field" id="siteSearchForm" role="search">
        ${icon('search')}
        <label class="sr-only" for="siteSearchInput">Search shops and products</label>
        <input id="siteSearchInput" type="search" name="q" autocomplete="off" placeholder="Search milk, notebooks, medicine, shops…" />
        <button class="search-dialog__close" type="button" data-close-search aria-label="Close search">${icon('x')}</button>
      </form>
      <div class="search-dialog__body" id="siteSearchBody"></div>
      <div class="search-dialog__foot">
        <span>Search runs against live shop stock and prices near you.</span>
        <span><kbd>Esc</kbd> to close · <kbd>/</kbd> to search</span>
      </div>
    </div>
  </div>`;
}

/* ----------------------------------------------------------------- footer -- */
function footer() {
  return `  <footer class="site-footer">
    <div class="wrap site-footer__top">
      <div class="site-footer__brand">
        <a class="brand" href="/" aria-label="NearBuy home">
          <span class="brand__mark brand__mark--flat" aria-hidden="true">${BRAND_MARK}</span>
          <span class="brand__text"><span class="brand__word">Near<em>Buy</em></span><span class="brand__tag">Shop local · Live better</span></span>
        </a>
        <p class="site-footer__tagline">Your neighbourhood.<br>Everything you need.</p>
        <p class="site-footer__meta">Hauz Khas, New Delhi 110016<br><a href="mailto:hello@nearbuy.in">hello@nearbuy.in</a> · 011 4106 2200<br>Mon–Sat, 9:00–20:00 IST</p>
      </div>
      <div class="site-footer__cols">
        <div>
          <h3>Shop</h3>
          <ul>
            <li><a href="/shops/">Nearby shops</a></li>
            <li><a href="/categories/">Categories</a></li>
            <li><a href="/offers/">Offers &amp; coupons</a></li>
            <li><a href="/customer/">Storefront</a></li>
            <li><a href="/customer/#/orders">Track an order</a></li>
          </ul>
        </div>
        <div>
          <h3>Platform</h3>
          <ul>
            <li><a href="/how-it-works/">How NearBuy works</a></li>
            <li><a href="/sell/">Sell on NearBuy</a></li>
            <li><a href="/deliver/">Deliver with Runner</a></li>
            <li><a href="/seller/">Seller Hub</a></li>
            <li><a href="/runner/">Runner Portal</a></li>
          </ul>
        </div>
        <div>
          <h3>Company</h3>
          <ul>
            <li><a href="/about/">About NearBuy</a></li>
            <li><a href="/about/#trust">Trust &amp; safety</a></li>
            <li><a href="/checklist/">Feature checklist</a></li>
            <li><a href="/demo/">Demo accounts</a></li>
            <li><a href="/admin/">Operations console</a></li>
          </ul>
        </div>
        <div>
          <h3>Help</h3>
          <ul>
            <li><a href="/help/">Help centre</a></li>
            <li><a href="/contact/">Contact us</a></li>
            <li><a href="/policies/">Privacy &amp; terms</a></li>
            <li><a href="/policies/#refunds">Refund policy</a></li>
            <li><a href="/customer/#/help">Order help</a></li>
          </ul>
        </div>
      </div>
    </div>
    <div class="wrap site-footer__bottom">
      <span>© <span id="year">2026</span> NearBuy. Built in Delhi for the shops around the corner.</span>
      <div class="site-footer__bottom-links">
        <a href="/policies/">Privacy</a>
        <a href="/policies/#terms">Terms</a>
        <a href="/policies/#refunds">Refunds</a>
        <a href="/contact/">Contact</a>
        <button class="site-footer__motion" id="motionToggle" type="button" aria-pressed="false">
          <span class="site-footer__motion-dot" aria-hidden="true"></span> <span id="motionLabel">Reduce motion</span>
        </button>
      </div>
    </div>
  </footer>
  <div id="toasts" class="toast-stack" role="status" aria-live="polite"></div>
  <script src="/site.js"></script>`;
}

/* ------------------------------------------------------------------ shell -- */
function page({ file, title, description, active, body, bodyClass, ogImage }) {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#031943" />
  <title>${title}</title>
  <meta name="description" content="${description}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="NearBuy" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:image" content="${ogImage || '/public/assets/site/hero-street.jpg'}" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="canonical" href="https://nearbuy.in${file === 'index.html' ? '/' : '/' + dirname(file) + '/'}" />
  <link rel="icon" href="/public/assets/nearbuy-logo.png" />
  <link rel="preload" href="/delivery/fonts/dm-sans-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="preload" href="/public/assets/fonts/fraunces-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="/site.css" />
  <link rel="stylesheet" href="/public/assets/brand.css" />
  <script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'NearBuy',
  url: 'https://nearbuy.in' + (file === 'index.html' ? '/' : '/' + dirname(file) + '/'),
  description,
  inLanguage: 'en-IN',
  potentialAction: {
    '@type': 'SearchAction',
    target: 'https://nearbuy.in/shops/?q={search_term_string}',
    'query-input': 'required name=search_term_string'
  }
}, null, 2)}
  </script>
  <script>
    (function () {
      var d = document.documentElement;
      d.classList.add('js-ready');
      try {
        var pref = localStorage.getItem('nearbuy.motion');
        if (pref === '"reduced"' || pref === 'reduced' || (!pref && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
          d.setAttribute('data-motion', 'reduced');
        }
      } catch (e) {}
      setTimeout(function () {
        if (!window.__nbSiteReady) d.classList.remove('js-ready');
      }, 2500);
    })();
  </script>
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
${header(active)}
  <main id="main">
${body}
  </main>
${footer()}
</body>
</html>
`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  process.stdout.write(`wrote ${file}\n`);
}

/* -------------------------------------------------------------- fragments -- */
const shopCard = (s) => `          <article class="shop-card" data-reveal>
            <div class="shop-card__top">
              <span class="shop-card__emoji" aria-hidden="true">${catIcon(s.categorySlug)}</span>
              <div class="shop-card__title"><h3>${esc(s.name)}</h3><p>${esc(s.locality)} · ${esc(s.category)}</p></div>
              <div class="shop-card__badges">${s.verified ? '<span class="tag tag--green">Verified</span>' : ''}${s.isOpen ? '' : '<span class="tag tag--muted">Closed</span>'}</div>
            </div>
            <div class="shop-card__body">
              <div class="shop-card__stats">
                <span class="shop-card__rating">${icon('star')} ${s.rating} <em style="font-style:normal;font-weight:400;color:#5d6b80">(${s.reviewCount})</em></span>
                <span>${icon('clock')} ${s.prepMinutes} min prep</span>
                <span>${s.productCount} products</span>
              </div>
              <div class="shop-card__chips">${s.badge ? `<span class="shop-card__chip">${esc(s.badge)}</span>` : ''}<span class="shop-card__chip">${esc(s.address)}</span></div>
              <div class="shop-card__foot">
                <small>${s.deliveryEnabled ? `Delivery from ${money(s.deliveryFee)}` : 'Pickup only'}${s.pickupEnabled ? ` · pickup ${s.pickupFee ? money(s.pickupFee) : 'free'}` : ''}</small>
                <a class="shop-card__link" href="/customer/#/shop/${encodeURIComponent(s.slug)}">Visit shop ${icon('arrow')}</a>
              </div>
            </div>
          </article>`;

const categoryTile = (c) => `          <a class="cat-tile" href="/customer/#/categories/${c.slug}" data-reveal>
            <span class="cat-tile__ico" aria-hidden="true">${catIcon(c.slug)}</span>
            <h3>${esc(c.name)}</h3>
            <small>${c.productCount ? `${c.productCount} products · ${c.shopCount} ${c.shopCount === 1 ? 'shop' : 'shops'}` : 'Growing soon'}</small>
            ${icon('arrow')}
          </a>`;

const faqItem = (q, a, open) => `          <details class="faq__item" name="faq"${open ? ' open' : ''}>
            <summary>${esc(q)}<span class="faq__plus" aria-hidden="true"></span></summary>
            <p>${a}</p>
          </details>`;

const offerCard = (o) => `          <article class="offer-card" data-reveal>
            <div class="offer-card__top">
              <span class="offer-card__value">${o.type === 'percent' ? o.value + '%' : o.type === 'fixed' ? money(o.value) : 'Free'}</span>
              <span class="tag tag--orange">${o.expiringSoon ? 'Ending soon' : 'Live'}</span>
            </div>
            <h3>${esc(o.title)}</h3>
            <p>${esc(o.description)}</p>
            <div class="offer-card__meta">
              ${o.shop ? `<span>${icon('store', 'ic--sm')} ${esc(o.shop.name)}</span>` : '<span>All shops</span>'}
              ${o.minOrder ? `<span>Min. basket ${money(o.minOrder)}</span>` : ''}
              ${o.endsAt ? `<span>Until ${new Date(o.endsAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>` : ''}
            </div>
            <div class="offer-card__code">
              <span><small>Coupon code</small><br><b>${esc(o.code)}</b></span>
              <button class="copy-btn" type="button" data-copy-code="${esc(o.code)}">${icon('copy')} Copy</button>
            </div>
          </article>`;

const ctaBand = (heading, copy, primary, primaryHref, secondary, secondaryHref) => `  <section class="cta-band" aria-labelledby="ctaTitle">
    <div class="wrap cta-band__inner">
      <div>
        <span class="eyebrow eyebrow--on-dark">Ready when you are</span>
        <h2 id="ctaTitle">${heading}</h2>
        <p>${copy}</p>
      </div>
      <div class="cta-band__actions">
        <a class="btn btn--primary btn--lg" href="${primaryHref}">${primary} ${icon('arrow', 'ic--arrow')}</a>
        ${secondary ? `<a class="btn btn--on-dark btn--lg" href="${secondaryHref}">${secondary}</a>` : ''}
      </div>
    </div>
  </section>`;

/* ================================================================ HOME ==== */
const seenKeys = new Set();
const featuredProducts = (home.products || []).filter((p) => {
  const key = p.compareKey || p.name;
  if (seenKeys.has(key)) return false;
  seenKeys.add(key);
  return true;
}).slice(0, 4);
const homeBody = `    <section class="hero" aria-labelledby="heroTitle">
      <div class="hero__media" aria-hidden="true">
        <img src="/public/assets/site/hero-street.jpg" width="1536" height="1024" alt="" fetchpriority="high" />
      </div>
      <div class="hero__scrim" aria-hidden="true"></div>
      <div class="hero__inner">
        <div class="hero__copy">
          <span class="eyebrow eyebrow--on-dark">Neighbourhood commerce, since 2021</span>
          <h1 id="heroTitle">The shop around the corner, <em>now a tap away.</em></h1>
          <p class="hero__lede">NearBuy connects the grocers, chemists, stationers and bakeries on your street with the people who live around them — and with the neighbours who deliver between the two. One basket, one checkout, live stock from ${STATS.shops} real shops.</p>
          <div class="hero__cta">
            <a class="btn btn--primary btn--lg" href="/shops/">Explore nearby shops ${icon('arrow', 'ic--arrow')}</a>
            <a class="btn btn--on-dark btn--lg" href="/how-it-works/">How it works</a>
          </div>
          <div class="hero__meta">
            <span>${icon('check')} Free store pickup</span>
            <span>${icon('check')} Delivery by local partners</span>
            <span>${icon('check')} OTP-confirmed handover</span>
          </div>
        </div>

        <div class="hero-card" data-reveal>
          <p class="hero-card__kicker">Start with your pincode</p>
          <h2>What delivers to you?</h2>
          <form class="hero-card__form" id="locateForm" novalidate>
            <div class="hero-card__fields">
              <label class="sr-only" for="locatePincode">Your pincode</label>
              <input class="hero-card__pin" id="locatePincode" name="pincode" type="text" inputmode="numeric" maxlength="6" placeholder="110016" autocomplete="postal-code" />
              <input id="locateLocality" name="locality" type="text" placeholder="Locality (optional)" autocomplete="address-level3" />
            </div>
            <button class="btn btn--primary hero-card__go" type="submit">${icon('pin')} See shops that deliver</button>
            <p class="hero-card__status" id="locateStatus" role="status" aria-live="polite" data-location-hint></p>
          </form>
          <div class="hero-card__areas">
            <span class="hero-card__areas-label">Live areas</span>
            ${AREAS.slice(0, 8).map((a) => `<button type="button" data-area-pincode="${a.pincode}">${esc(a.locality)}</button>`).join('')}
          </div>
        </div>
      </div>
    </section>

    <section class="section section--tight" aria-label="NearBuy at a glance">
      <div class="wrap">
        <dl class="stat-row">
          <div><dt>${STATS.shops}</dt><dd>verified neighbourhood shops</dd></div>
          <div><dt>${STATS.products}</dt><dd>live products with real stock</dd></div>
          <div><dt>${STATS.categories}</dt><dd>everyday categories</dd></div>
          <div><dt>${STATS.localities}</dt><dd>pincodes served in south Delhi</dd></div>
        </dl>
      </div>
    </section>

    <section class="section" id="categories" aria-labelledby="categoriesTitle">
      <div class="wrap">
        <div class="section-head section-head--split">
          <div data-reveal>
            <span class="eyebrow">Shop by what you need</span>
            <h2 id="categoriesTitle">Everyday things, kept close by.</h2>
          </div>
          <div data-reveal>
            <p>Categories are driven by what the shops actually stock, not a catalogue we wish existed. Empty categories say so — and open up as new shops join the network.</p>
            <div class="section-head__actions"><a class="link-arrow" href="/categories/">See all ${STATS.categories} categories ${icon('arrow')}</a></div>
          </div>
        </div>
        <div class="cat-grid">
${CATEGORIES.filter((c) => c.productCount > 0).slice(0, 8).map(categoryTile).join('\n')}
        </div>
      </div>
    </section>

    <section class="section section--cream" id="shops" aria-labelledby="shopsTitle">
      <div class="wrap">
        <div class="section-head section-head--split">
          <div data-reveal>
            <span class="eyebrow">Meet the neighbours</span>
            <h2 id="shopsTitle">Ten shops. One neighbourhood.</h2>
          </div>
          <div data-reveal>
            <p>Each shop keeps its own catalogue, timings, delivery radius and policies. These are the shops currently serving Hauz Khas, Saket, Green Park and the streets between.</p>
            <div class="section-head__actions"><a class="link-arrow" href="/shops/">Browse the shop directory ${icon('arrow')}</a></div>
          </div>
        </div>
        <div class="card-grid">
${SHOPS.slice(0, 6).map(shopCard).join('\n')}
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="featureTitle">
      <div class="wrap">
        <div class="feature">
          <div class="feature__media" data-reveal>
            <img src="/public/assets/site/shopkeeper.jpg" width="1024" height="1536" alt="A shopkeeper behind the counter of his general store" loading="lazy" />
            <p class="feature__caption">Daily Needs Kirana, Lajpat Nagar — with NearBuy since the first service area opened.</p>
          </div>
          <div class="feature__body" data-reveal>
            <span class="eyebrow">Why local</span>
            <h2 id="featureTitle">Commerce that stays on your street.</h2>
            <p>Marketplaces optimise for the cheapest seller anywhere in the country. NearBuy optimises for the nearest seller: the grocer who knows your order, the bakery that sells out by ten, the stationer two lanes over.</p>
            <ul class="checklist">
              <li>${icon('check')}<span><b>The shop keeps its identity.</b> Its own name, hours, prices and fulfilment rules — NearBuy adds discovery and delivery.</span></li>
              <li>${icon('check')}<span><b>You can always see the shop behind the product.</b> Every listing names its seller, distance and stock, never a faceless catalogue.</span></li>
              <li>${icon('check')}<span><b>Delivery is a neighbour, not a depot.</b> Runner jobs go to partners already inside your locality, ranked by distance and current workload.</span></li>
            </ul>
            <a class="link-arrow" href="/about/">Read the NearBuy story ${icon('arrow')}</a>
          </div>
        </div>
      </div>
    </section>

    <section class="section section--cream" id="how" aria-labelledby="howTitle">
      <div class="wrap">
        <div class="section-head section-head--center" data-reveal>
          <span class="eyebrow eyebrow--plain">From your street to your doorstep</span>
          <h2 id="howTitle">Four steps, no surprises.</h2>
          <p>The same sequence runs for every order, whichever shop it comes from — and every step is a real server-side state, not a status label.</p>
        </div>
        <div class="steps">
          <div class="step" data-reveal>
            <span class="step__num">01</span>
            <h3>Discover</h3>
            <p>Share your pincode and see only the shops that can actually serve you, with distance, timings and live stock.</p>
          </div>
          <div class="step" data-reveal>
            <span class="step__num">02</span>
            <h3>Order</h3>
            <p>Fill one basket across several shops and choose delivery or free pickup shop by shop at checkout.</p>
          </div>
          <div class="step" data-reveal>
            <span class="step__num">03</span>
            <h3>Fulfil</h3>
            <p>The shop accepts and packs. A nearby Runner picks up against a handover PIN and delivers against your OTP.</p>
          </div>
          <div class="step" data-reveal>
            <span class="step__num">04</span>
            <h3>Settle</h3>
            <p>Every order posts a receipt and a settlement line, so the shop can see exactly what it earned and when.</p>
          </div>
        </div>
        <div class="section-head__actions" style="justify-content:center; margin-top:36px">
          <a class="btn btn--ghost" href="/how-it-works/">Read the full model ${icon('arrow', 'ic--arrow')}</a>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="picksTitle">
      <div class="wrap">
        <div class="section-head section-head--split">
          <div data-reveal>
            <span class="eyebrow">On the shelves today</span>
            <h2 id="picksTitle">Fresh picks from nearby shops.</h2>
          </div>
          <div data-reveal>
            <p>Prices, discounts and stock below come from the live catalogue. Compare the same product across shops before you add it to the bag.</p>
            <div class="section-head__actions"><a class="link-arrow" href="/customer/#/products">Browse the full catalogue ${icon('arrow')}</a></div>
          </div>
        </div>
        <div class="card-grid card-grid--4">
${featuredProducts.map((p) => `          <article class="product-card" data-reveal>
            <div class="product-card__art">
              ${p.imageUrl ? `<img src="${p.imageUrl}" width="600" height="450" alt="${esc(p.name)}" loading="lazy" />` : `<span class="product-card__glyph" aria-hidden="true">${catIcon(p.categorySlug)}</span>`}
              ${p.discount ? `<span class="product-card__discount">${p.discount}% off</span>` : ''}
            </div>
            <div class="product-card__body">
              <p class="product-card__brand">${esc(p.brand || p.category)}</p>
              <h3>${esc(p.name)}</h3>
              <p class="product-card__unit">${esc(p.unit || '')}</p>
              <div class="product-card__price"><b>${money(p.price)}</b>${p.mrp > p.price ? `<s>${money(p.mrp)}</s>` : ''}</div>
              <div class="product-card__foot">
                <span class="product-card__shop"><a href="/customer/#/shop/${encodeURIComponent(p.shop.slug)}">${esc(p.shop.name)}</a></span>
                <a class="product-card__cta" href="/customer/#/product/${encodeURIComponent(p.id)}">View ${icon('arrow', 'ic--sm')}</a>
              </div>
            </div>
          </article>`).join('\n')}
        </div>
      </div>
    </section>

    <section class="section section--navy" id="partners" aria-labelledby="partnersTitle">
      <div class="wrap">
        <div class="section-head section-head--split">
          <div data-reveal>
            <span class="eyebrow eyebrow--on-dark">Two ways to join</span>
            <h2 id="partnersTitle">Grow the shop. Or run the last mile.</h2>
          </div>
          <div data-reveal>
            <p>Every seller and every delivery partner in this network is a real, separate account with its own sign-in, verification and console.</p>
          </div>
        </div>
        <div class="feature" style="margin-top:44px">
          <div class="feature__media" data-reveal>
            <img src="/public/assets/site/shopkeeper.jpg" width="1024" height="1536" alt="A shopkeeper at his counter" loading="lazy" style="aspect-ratio:3/2" />
          </div>
          <div class="feature__body" data-reveal>
            <span class="eyebrow eyebrow--on-dark">For shops</span>
            <h3>Run the whole shop from one hub.</h3>
            <p>Catalogue, stock, order queue, packing, returns, promotions, settlements and staff — each shop owns its own workspace and only ever sees its own orders.</p>
            <div class="section-head__actions">
              <a class="btn btn--primary" href="/sell/">Sell on NearBuy ${icon('arrow', 'ic--arrow')}</a>
              <a class="btn btn--on-dark" href="/seller/">Seller Hub sign-in</a>
            </div>
          </div>
        </div>
        <div class="feature feature--flip" style="margin-top:56px">
          <div class="feature__media" data-reveal>
            <img src="/public/assets/site/courier.jpg" width="1536" height="1024" alt="A delivery partner checking a job on a scooter" loading="lazy" />
          </div>
          <div class="feature__body" data-reveal>
            <span class="eyebrow eyebrow--on-dark">For delivery partners</span>
            <h3>Short runs, clear earnings, your hours.</h3>
            <p>Nearby offers with payout and distance before you accept, one active job at a time, pickup PINs and customer OTPs to keep handovers honest.</p>
            <div class="section-head__actions">
              <a class="btn btn--primary" href="/deliver/">Deliver with Runner ${icon('arrow', 'ic--arrow')}</a>
              <a class="btn btn--on-dark" href="/runner/">Partner sign-in</a>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="section section--cream" aria-labelledby="voiceTitle">
      <div class="wrap">
        <div class="section-head section-head--center" data-reveal>
          <span class="eyebrow eyebrow--plain">From the neighbourhood</span>
          <h2 id="voiceTitle">What people say after the doorbell rings.</h2>
        </div>
        <div class="quote-grid">
          <figure class="quote" data-reveal>
            <div class="quote__stars" role="img" aria-label="Rated 5 out of 5">${icon('star')}${icon('star')}${icon('star')}${icon('star')}${icon('star')}</div>
            <blockquote>“${esc((REVIEWS[0] && REVIEWS[0].body) || 'The milk and eggs arrived cold and the bread was still warm. The shop called to check if I needed anything else — this is why I shop local.')}”</blockquote>
            <figcaption class="quote__by">
              <span class="quote__avatar" aria-hidden="true">PS</span>
              <span><b>${esc((REVIEWS[0] && REVIEWS[0].customerName) || 'Priya Sharma')}</b><small>Hauz Khas · verified purchase</small></span>
            </figcaption>
          </figure>
          <figure class="quote" data-reveal>
            <div class="quote__stars" role="img" aria-label="Rated 5 out of 5">${icon('star')}${icon('star')}${icon('star')}${icon('star')}${icon('star')}</div>
            <blockquote>“One basket across the grocer and the chemist, then a single delivery. I stopped keeping a list on the fridge and started keeping one in NearBuy.”</blockquote>
            <figcaption class="quote__by">
              <span class="quote__avatar" aria-hidden="true">AK</span>
              <span><b>Arun Kapoor</b><small>Saket · verified purchase</small></span>
            </figcaption>
          </figure>
          <figure class="quote" data-reveal>
            <div class="quote__stars" role="img" aria-label="Rated 5 out of 5">${icon('star')}${icon('star')}${icon('star')}${icon('star')}${icon('star')}</div>
            <blockquote>“We used to take orders on WhatsApp. Now the stock, the packing list and the settlement all sit in one place, and nothing gets double-sold.”</blockquote>
            <figcaption class="quote__by">
              <span class="quote__avatar" aria-hidden="true">RM</span>
              <span><b>Reena Malhotra</b><small>Sunrise Bakery, SDA Market</small></span>
            </figcaption>
          </figure>
        </div>
        <p class="text-center small muted mt-3">Reviews are published only for verified purchases and are moderated in the operations console.</p>
      </div>
    </section>

    <section class="section" id="offer-teaser" aria-labelledby="offersTeaserTitle">
      <div class="wrap">
        <div class="section-head section-head--split">
          <div data-reveal>
            <span class="eyebrow">Running right now</span>
            <h2 id="offersTeaserTitle">Coupons from your neighbours.</h2>
          </div>
          <div data-reveal>
            <p>Only coupons that are live and inside their validity window are listed. Copy a code and paste it in the bag at checkout.</p>
            <div class="section-head__actions"><a class="link-arrow" href="/offers/">See all offers ${icon('arrow')}</a></div>
          </div>
        </div>
        <div class="card-grid">
${OFFERS.slice(0, 3).map(offerCard).join('\n')}
        </div>
      </div>
    </section>

    ${ctaBand('Your neighbourhood is waiting.', 'Discover the shops around the corner, or bring your own shop into the network — both take less than five minutes.', 'Explore nearby shops', '/shops/', 'Sell on NearBuy', '/sell/')}
`;
page({
  file: 'index.html',
  title: 'NearBuy — Shop the shops around the corner',
  description: 'NearBuy connects the shops on your street with the people who live around them: live stock, one basket, delivery by local partners or free store pickup in south Delhi.',
  active: 'home',
  body: homeBody
});

/* ============================================================== CONTACT === */
const contactBody = `    <section class="page-head">
      <div class="wrap page-head__inner">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${icon('chevron-right')}<span>Contact</span></nav>
        <h1>Talk to a person, not a ticket queue.</h1>
        <p class="page-head__lede">Every message sent here is written into the NearBuy database, given a reference code and picked up by the operations team. No email provider is connected, so nothing is forwarded automatically — the reply comes from the console.</p>
      </div>
    </section>

    <section class="section" id="write" aria-labelledby="writeTitle">
      <div class="wrap">
        <div class="with-aside">
          <div>
            <div class="section-head" data-reveal>
              <span class="eyebrow">Send a message</span>
              <h2 id="writeTitle">What can we help with?</h2>
              <p>Four fields, a reference code, and a real record in the operations inbox.</p>
            </div>
            <div class="form-card mt-3">
              <form class="form-grid" data-enquiry-form novalidate>
                <p class="form-status" data-form-status role="alert" hidden></p>
                <div class="form-row">
                  <div class="field">
                    <label for="contactName">Full name <span class="req" aria-hidden="true">*</span></label>
                    <input id="contactName" name="name" type="text" autocomplete="name" maxlength="80" placeholder="Your name" required />
                    <p class="field__error" hidden></p>
                  </div>
                  <div class="field">
                    <label for="contactContact">Mobile or email <span class="req" aria-hidden="true">*</span></label>
                    <input id="contactContact" name="contact" type="text" autocomplete="email" maxlength="120" placeholder="you@example.com or 98xxxxxxxx" required />
                    <p class="field__error" hidden></p>
                  </div>
                </div>
                <div class="field">
                  <label for="contactTopic">Topic <span class="req" aria-hidden="true">*</span></label>
                  <select id="contactTopic" name="topic" required>
                    <option value="">Choose a topic</option>
                    <option>General enquiry</option>
                    <option>Order help</option>
                    <option>Returns &amp; refunds</option>
                    <option>Selling on NearBuy</option>
                    <option>Delivery partner</option>
                    <option>Payments</option>
                    <option>Others</option>
                  </select>
                  <p class="field__error" hidden></p>
                </div>
                <div class="field">
                  <label for="contactMessage">Message <span class="req" aria-hidden="true">*</span></label>
                  <textarea id="contactMessage" name="message" rows="6" maxlength="600" placeholder="Tell us what happened, and include an order code if you have one." required></textarea>
                  <div style="display:flex;justify-content:space-between;gap:12px">
                    <p class="field__error" hidden></p>
                    <span class="field__count" data-count-for="message">0 / 600</span>
                  </div>
                </div>
                <button class="btn btn--primary btn--lg" type="submit">Send message ${icon('arrow', 'ic--arrow')}</button>
                <p class="form-note">${icon('lock')}<span>Stored in the NearBuy database and visible under <b>Enquiries</b> in the operations console. Nothing is emailed, so keep the reference code.</span></p>
              </form>
            </div>
            <div class="form-success mt-3" data-enquiry-success hidden tabindex="-1" aria-live="polite">
              <span class="form-success__icon" aria-hidden="true">${icon('check')}</span>
              <h2>Message received.</h2>
              <p>Your enquiry is saved and the operations team will pick it up from the console. Reference <span class="form-success__ref" data-enquiry-ref>—</span>.</p>
              <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:6px">
                <button class="btn btn--ghost btn--sm" type="button" data-enquiry-again>Send another message</button>
                <a class="btn btn--primary btn--sm" href="/help/">Browse the help centre</a>
              </div>
            </div>
          </div>

          <aside>
            <div class="aside-card aside-card--sticky">
              <h3>Other ways to reach us</h3>
              <ul>
                <li>${icon('mail', 'ic--sm')} <a href="mailto:hello@nearbuy.in">hello@nearbuy.in</a> — general</li>
                <li>${icon('store', 'ic--sm')} <a href="mailto:sellers@nearbuy.in">sellers@nearbuy.in</a> — onboarding</li>
                <li>${icon('shield', 'ic--sm')} <a href="mailto:safety@nearbuy.in">safety@nearbuy.in</a> — incidents</li>
                <li>${icon('phone', 'ic--sm')} 011 4106 2200 · Mon–Sat 9:00–20:00 IST</li>
              </ul>
              <hr style="margin:16px 0;border-color:var(--line-soft)" />
              <h3>Faster for orders</h3>
              <p class="mt-1">Signed-in customers can raise a support ticket against a specific order, which keeps the whole thread together.</p>
              <a class="link-arrow mt-2" href="/customer/#/help">Open order help ${icon('arrow')}</a>
            </div>
            <div class="aside-card">
              <h3>Office</h3>
              <p class="mt-1">NearBuy Technologies<br>2nd Floor, 14 Hauz Khas Village<br>New Delhi 110016, India</p>
              <p class="mt-2 small">Visits by appointment — the counter team is usually on the road with sellers.</p>
            </div>
          </aside>
        </div>
      </div>
    </section>

    <section class="section section--cream" aria-labelledby="routesTitle">
      <div class="wrap">
        <div class="section-head" data-reveal>
          <span class="eyebrow">Before you write</span>
          <h2 id="routesTitle">Most questions have a page already.</h2>
        </div>
        <div class="card-grid card-grid--4 mt-3">
          <a class="help-link" href="/help/" data-reveal><span class="shop-card__emoji" aria-hidden="true">${icon('inbox')}</span><b>Help centre</b><small>Twelve live answers on orders, delivery, pickup, payments and refunds.</small></a>
          <a class="help-link" href="/customer/#/orders" data-reveal><span class="shop-card__emoji" aria-hidden="true">${icon('box')}</span><b>Track an order</b><small>The status timeline, runner details and your delivery OTP.</small></a>
          <a class="help-link" href="/policies/#refunds" data-reveal><span class="shop-card__emoji" aria-hidden="true">${icon('refresh')}</span><b>Refund policy</b><small>Windows, eligibility and how money returns to you.</small></a>
          <a class="help-link" href="/sell/" data-reveal><span class="shop-card__emoji" aria-hidden="true">${icon('store')}</span><b>Opening a shop</b><small>The application, the documents and the review timeline.</small></a>
        </div>
      </div>
    </section>
`;
page({
  file: 'contact/index.html',
  title: 'Contact NearBuy — support, sellers and safety',
  description: 'Write to the NearBuy team. Every message is stored in the platform database with a reference code and reviewed by operations.',
  active: 'help',
  body: contactBody
});

/* ================================================================ SHOPS === */
const shopCategories = CATEGORIES.filter((c) => c.shopCount > 0);
const shopsBody = `    <section class="page-head">
      <div class="wrap page-head__inner">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${icon('chevron-right')}<span>Nearby shops</span></nav>
        <h1>Every shop in the network.</h1>
        <p class="page-head__lede">Ten independent shops across south Delhi, each running its own catalogue, timings and delivery radius. Set your pincode to see exactly who can serve you, then filter by what you need.</p>
        <div class="page-head__actions">
          <a class="btn btn--navy" href="#directory">Browse the directory ${icon('arrow', 'ic--arrow')}</a>
          <a class="btn btn--ghost" href="/categories/">Shop by category</a>
        </div>
      </div>
    </section>

    <section class="section" id="directory" aria-labelledby="dirTitle">
      <div class="wrap">
        <div class="with-aside">
          <div>
            <div class="section-head section-head--split mb-3">
              <div>
                <span class="eyebrow">Directory</span>
                <h2 id="dirTitle" style="font-size:clamp(24px,2.8vw,34px)">Shops serving your neighbourhood</h2>
              </div>
              <form id="shopsFilters" role="search" style="display:flex;gap:8px;align-items:flex-start">
                <div class="field" style="flex:1">
                  <label class="sr-only" for="shopsQuery">Search shops</label>
                  <input id="shopsQuery" name="q" type="search" placeholder="Search by name, area or category" />
                </div>
                <button class="btn btn--navy" type="submit" aria-label="Search shops">${icon('search')}</button>
              </form>
            </div>

            <div class="filter-bar" role="group" aria-label="Filter shops">
              <div class="filter-bar__group">
                <button class="filter-chip" type="button" data-chip="category" data-value="">All categories</button>
${shopCategories.map((c) => `                <button class="filter-chip" type="button" data-chip="category" data-value="${c.slug}">${esc(c.name)} <span style="opacity:.6">${c.shopCount}</span></button>`).join('\n')}
              </div>
            </div>
            <div class="filter-bar" role="group" aria-label="Refine shops">
              <div class="filter-bar__group">
                <button class="filter-chip" type="button" data-chip="open" data-value="1">${icon('clock', 'ic--sm')} Open now</button>
                <button class="filter-chip" type="button" data-chip="delivery" data-value="1">${icon('truck', 'ic--sm')} Home delivery</button>
                <button class="filter-chip" type="button" data-chip="pickup" data-value="1">${icon('bag', 'ic--sm')} Free pickup</button>
              </div>
              <div class="filter-bar__group">
                <label class="sr-only" for="shopsSort">Sort shops</label>
                <select class="filter-bar__select" id="shopsSort">
                  <option value="distance">Sort: nearest first</option>
                  <option value="rating">Highest rated</option>
                  <option value="prep">Fastest preparation</option>
                  <option value="name">Name A–Z</option>
                </select>
              </div>
              <button class="filter-chip" type="button" data-clear-filters style="margin-left:auto">Clear filters</button>
            </div>

            <p class="results-meta" id="shopsCount" aria-live="polite">Loading shops…</p>
            <div class="card-grid card-grid--2" id="shopsResults" aria-busy="true">
              <div class="skeleton skeleton-card" aria-hidden="true"></div>
              <div class="skeleton skeleton-card" aria-hidden="true"></div>
              <div class="skeleton skeleton-card" aria-hidden="true"></div>
              <div class="skeleton skeleton-card" aria-hidden="true"></div>
            </div>
            <nav class="pagination" id="shopsPager" aria-label="Shop pages"></nav>
            <noscript><p class="form-status" data-tone="info">The directory filters need JavaScript. Without it, browse the <a href="/customer/#/shops">storefront shop list</a>, which is rendered server-side.</p></noscript>
          </div>

          <aside>
            <div class="aside-card aside-card--sticky">
              <h3>Set your pincode</h3>
              <p class="mt-1">Coverage is decided by each shop's radius, so the list changes street by street.</p>
              <form class="form-grid mt-2" id="shopsPincodeForm" novalidate>
                <div class="field">
                  <label for="shopsPincode">Pincode</label>
                  <input id="shopsPincode" name="pincode" type="text" inputmode="numeric" maxlength="6" placeholder="110016" autocomplete="postal-code" />
                </div>
                <button class="btn btn--primary btn--block" type="submit">Check coverage</button>
                <p class="small muted" id="shopsPincodeStatus" role="status" aria-live="polite" data-location-hint></p>
              </form>
              <hr style="margin:18px 0;border-color:var(--line-soft)" />
              <h3>Live areas</h3>
              <div class="area-grid" style="grid-template-columns:1fr;margin-top:10px">
${AREAS.slice(0, 8).map((a) => `                <a class="area-pill" href="/shops/?pincode=${a.pincode}"><span>${esc(a.locality)}</span><small>${a.pincode}</small></a>`).join('\n')}
              </div>
            </div>
            <div class="aside-card">
              <h3>Own a shop here?</h3>
              <p class="mt-1">Approved shops appear in this directory automatically, with their own stock and pricing.</p>
              <a class="link-arrow mt-2" href="/sell/">Apply to sell ${icon('arrow')}</a>
            </div>
          </aside>
        </div>
      </div>
    </section>

    ${ctaBand('Can’t find what you need?', 'The catalogue grows every month. Tell us which shop or category should be on NearBuy next and we will approach them.', 'Send a request', '/contact/', 'Browse categories', '/categories/')}
`;
page({
  file: 'shops/index.html',
  title: 'Nearby shops — the NearBuy directory',
  description: 'Browse every shop in the NearBuy network: groceries, pharmacy, bakery, stationery and more, with live stock, distance and delivery fees.',
  active: 'shop',
  body: shopsBody
});

/* =========================================================== CATEGORIES === */
const categoriesBody = `    <section class="page-head">
      <div class="wrap page-head__inner">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${icon('chevron-right')}<span>Categories</span></nav>
        <h1>What’s on the shelves nearby.</h1>
        <p class="page-head__lede">Twenty categories, mapped to the shops that actually stock them. Categories with no stock yet are shown honestly — they open up the moment a shop in that trade joins.</p>
      </div>
    </section>

    <section class="section" aria-labelledby="catsTitle">
      <div class="wrap">
        <div class="section-head section-head--split">
          <div data-reveal>
            <span class="eyebrow">Live catalogue</span>
            <h2 id="catsTitle">${CATEGORIES.filter((c) => c.productCount > 0).length} categories with stock today.</h2>
          </div>
          <div data-reveal>
            <p>Product counts update with each shop's catalogue. Tap a category to see the listings near you, then filter by shop, price or rating in the storefront.</p>
          </div>
        </div>
        <div class="cat-grid">
${CATEGORIES.filter((c) => c.productCount > 0).map(categoryTile).join('\n')}
        </div>
      </div>
    </section>

    <section class="section section--cream" aria-labelledby="growingTitle">
      <div class="wrap">
        <div class="section-head" data-reveal>
          <span class="eyebrow">Opening soon</span>
          <h2 id="growingTitle">Categories we are actively recruiting for.</h2>
          <p>These are on the roadmap but have no stock yet. If you run one of these trades within the service area, the application takes five minutes.</p>
        </div>
        <div class="cat-grid" style="margin-top:36px">
${CATEGORIES.filter((c) => c.productCount === 0).map((c) => `          <div class="cat-tile" data-reveal>
            <span class="cat-tile__ico" aria-hidden="true">${catIcon(c.slug)}</span>
            <h3>${esc(c.name)}</h3>
            <small>No shops yet · <a href="/sell/" style="color:var(--action)">be the first</a></small>
          </div>`).join('\n')}
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="howCatsTitle">
      <div class="wrap">
        <div class="feature">
          <div class="feature__media" data-reveal>
            <img src="/public/assets/site/produce.jpg" width="1240" height="1240" alt="Fresh vegetables, greens and spices laid out on a cloth" loading="lazy" style="aspect-ratio:4/3" />
          </div>
          <div class="feature__body" data-reveal>
            <span class="eyebrow">Freshness, honestly described</span>
            <h2 id="howCatsTitle">Perishables get shorter windows, and we say so.</h2>
            <p>Fruit, vegetables, dairy and bakery items carry their own return window — usually none unless the item arrives damaged. Each product page states the window before you buy, because a policy you discover after delivery is not a policy.</p>
            <ul class="checklist">
              <li>${icon('check')}<span>Product-level return windows, shown on the listing</span></li>
              <li>${icon('check')}<span>Stock counts that reflect reservations, not hopeful numbers</span></li>
              <li>${icon('check')}<span>Same product compared across every nearby shop</span></li>
            </ul>
            <a class="link-arrow" href="/policies/#refunds">Read the refund policy ${icon('arrow')}</a>
          </div>
        </div>
      </div>
    </section>

    ${ctaBand('Shopping for a household?', 'Set your pincode once and NearBuy remembers the neighbourhood, so every visit starts from the shops that can actually deliver.', 'Find shops near you', '/shops/', 'See live offers', '/offers/')}
`;
page({
  file: 'categories/index.html',
  title: 'Categories — browse what’s nearby | NearBuy',
  description: 'Twenty NearBuy categories, from groceries and dairy to pharmacy, bakery and stationery, each mapped to the shops that stock them today.',
  active: 'shop',
  body: categoriesBody
});

/* =============================================================== OFFERS === */
const offersBody = `    <section class="page-head">
      <div class="wrap page-head__inner">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${icon('chevron-right')}<span>Offers</span></nav>
        <h1>Coupons your neighbours are running.</h1>
        <p class="page-head__lede">These are the live promotions in the NearBuy database right now — not evergreen banners. Each one has a validity window, a minimum basket and a shop it applies to, and the server re-checks all of it at checkout.</p>
        <div class="page-head__actions">
          <a class="btn btn--navy" href="/customer/#/offers">Open offers in the storefront ${icon('arrow', 'ic--arrow')}</a>
          <a class="btn btn--ghost" href="/shops/">Browse shops</a>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="liveOffersTitle">
      <div class="wrap">
        <div class="section-head section-head--split">
          <div data-reveal>
            <span class="eyebrow">Live now</span>
            <h2 id="liveOffersTitle">${OFFERS.length} ${OFFERS.length === 1 ? 'promotion' : 'promotions'} available.</h2>
          </div>
          <div data-reveal>
            <p>Copy a code, add the qualifying items to your bag, paste it at checkout. If a code is exhausted or expired, the server rejects it rather than silently ignoring it.</p>
          </div>
        </div>
        <div class="card-grid">
${OFFERS.map(offerCard).join('\n')}
        </div>
      </div>
    </section>

    <section class="section section--cream" aria-labelledby="offerRulesTitle">
      <div class="wrap">
        <div class="section-head" data-reveal>
          <span class="eyebrow">How coupons behave</span>
          <h2 id="offerRulesTitle">The fine print, in plain language.</h2>
        </div>
        <div class="value-grid">
          <div class="value" data-reveal>
            <span class="value__icon">${icon('rupee')}</span>
            <h3>One coupon per basket</h3>
            <p>Platform-wide codes and shop-specific codes cannot stack. If you add a shop coupon after a platform one, the bag shows which discount is actually applied.</p>
          </div>
          <div class="value" data-reveal>
            <span class="value__icon">${icon('refresh')}</span>
            <h3>Minimum baskets are checked server-side</h3>
            <p>Adding items to reach a minimum works; removing them after applying the code re-prices the basket and may drop the discount. You always see the final total before paying.</p>
          </div>
          <div class="value" data-reveal>
            <span class="value__icon">${icon('shield')}</span>
            <h3>No hidden expiry</h3>
            <p>Every coupon carries a start and end time. Once the window closes the code disappears from this page and is rejected at checkout.</p>
          </div>
        </div>
      </div>
    </section>

    ${ctaBand('Good offers are better with a shop behind them.', 'Every coupon here is tied to a real shop with real stock. Browse the directory and see who is running what.', 'Browse shops', '/shops/', 'How ordering works', '/how-it-works/')}
`;
page({
  file: 'offers/index.html',
  title: 'Offers & coupons — live neighbourhood deals | NearBuy',
  description: 'Live NearBuy coupons with validity windows, minimum baskets and the shops they apply to. Copy a code and use it at checkout.',
  active: 'shop',
  body: offersBody
});

/* ========================================================= HOW IT WORKS === */
const howBody = `    <section class="page-head page-head--image">
      <div class="page-head__bg" aria-hidden="true"><img src="/public/assets/site/parcels.jpg" width="1536" height="1024" alt="" /></div>
      <div class="wrap page-head__inner">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${icon('chevron-right')}<span>How NearBuy works</span></nav>
        <h1>One order, several neighbours, no mystery.</h1>
        <p class="page-head__lede">NearBuy is a neighbourhood commerce platform: customers discover shops that can actually reach them, shops fulfil what they sell, and delivery partners carry the parcels in between. Here is exactly how the pieces fit.</p>
        <div class="page-head__actions">
          <a class="btn btn--primary" href="/shops/">Explore nearby shops ${icon('arrow', 'ic--arrow')}</a>
          <a class="btn btn--on-dark" href="/sell/">Sell on NearBuy</a>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="modelTitle">
      <div class="wrap">
        <div class="section-head section-head--split">
          <div data-reveal>
            <span class="eyebrow">The model</span>
            <h2 id="modelTitle">Distance is the feature, not a constraint.</h2>
          </div>
          <div data-reveal>
            <p>Most marketplaces optimise for the cheapest seller anywhere. NearBuy optimises for the nearest seller who has the item in stock today — because a ten-minute walk beats a two-day wait for milk.</p>
          </div>
        </div>
        <div class="steps">
          <div class="step" data-reveal>
            <span class="step__num">01 · Discover</span>
            <h3>The pincode decides</h3>
            <p>Each shop has coordinates, a delivery radius and a list of service pincodes. Enter yours and the directory hides anything that cannot reach you, rather than showing it greyed out.</p>
          </div>
          <div class="step" data-reveal>
            <span class="step__num">02 · Basket</span>
            <h3>One bag, several shops</h3>
            <p>Add items from the grocer, the chemist and the baker in one basket. At checkout it splits into one order per shop, each with its own fulfilment method, fee and timeline.</p>
          </div>
          <div class="step" data-reveal>
            <span class="step__num">03 · Fulfil</span>
            <h3>The shop packs, a neighbour delivers</h3>
            <p>The seller accepts or rejects, packs against the order, then either hands over to a Runner or completes a store pickup against the customer's collection code.</p>
          </div>
          <div class="step" data-reveal>
            <span class="step__num">04 · Settle</span>
            <h3>Every rupee is traceable</h3>
            <p>Totals, discounts, tax and delivery fees are calculated on the server. Each order produces a customer receipt, a seller copy and a settlement line.</p>
          </div>
        </div>
      </div>
    </section>

    <section class="section section--cream" id="delivery" aria-labelledby="deliveryTitle">
      <div class="wrap">
        <div class="feature">
          <div class="feature__media" data-reveal>
            <img src="/public/assets/site/courier.jpg" width="1536" height="1024" alt="A delivery partner checking the next job on a scooter" loading="lazy" />
            <p class="feature__caption">Runner jobs are offered to partners already inside the locality, ranked by distance and current workload.</p>
          </div>
          <div class="feature__body" data-reveal>
            <span class="eyebrow">Delivery &amp; pickup</span>
            <h2 id="deliveryTitle">Two handovers, two codes.</h2>
            <p>Handover is where neighbourhood deliveries usually go wrong. NearBuy makes both ends explicit:</p>
            <ul class="checklist">
              <li>${icon('check')}<span><b>The pickup PIN.</b> The seller sees it when the parcel is ready; the runner must present it before the job can be marked picked up.</span></li>
              <li>${icon('check')}<span><b>The delivery OTP.</b> Derived on the server and revealed to the customer only once the parcel is out for delivery. Never stored in plain text.</span></li>
              <li>${icon('check')}<span><b>One job at a time.</b> A runner cannot accept a second job while one is active, and assignment is a single conditional update, so two partners can never own the same parcel.</span></li>
              <li>${icon('check')}<span><b>Offers expire.</b> Unaccepted offers lapse after the configured window and the seller can re-request, or deliver it themselves.</span></li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="pricing" aria-labelledby="pricingTitle">
      <div class="wrap">
        <div class="section-head" data-reveal>
          <span class="eyebrow">Pricing</span>
          <h2 id="pricingTitle">Who pays what.</h2>
          <p>Nothing is calculated in your browser. The bag, the fees and the totals are assembled on the server, so a tampered page cannot change a price.</p>
        </div>
        <div class="value-grid">
          <div class="value" data-reveal>
            <span class="value__icon">${icon('bag')}</span>
            <h3>Customers</h3>
            <p>Pay the item price, any delivery fee the shop has set (often waived above a basket threshold) and applicable tax. Store pickup is free where a shop offers it.</p>
          </div>
          <div class="value" data-reveal>
            <span class="value__icon">${icon('store')}</span>
            <h3>Shops</h3>
            <p>Keep their own selling price and set their own delivery fee, minimum basket and free-delivery threshold. The settlement statement lists commission per order where a rate applies.</p>
          </div>
          <div class="value" data-reveal>
            <span class="value__icon">${icon('truck')}</span>
            <h3>Delivery partners</h3>
            <p>See the payout and distance before accepting an offer. Payouts are recorded against each delivered job and appear in the earnings view of the Runner Portal.</p>
          </div>
        </div>
        <p class="small muted mt-3" style="max-width:70ch">Online card and UPI payments are enabled only when a payment gateway is configured for the deployment. Until then, cash on delivery and pay-at-store are the working methods, and the checkout says so plainly.</p>
      </div>
    </section>

    <section class="section section--cream" aria-labelledby="timelineTitle">
      <div class="wrap">
        <div class="section-head" data-reveal>
          <span class="eyebrow">The status timeline</span>
          <h2 id="timelineTitle">What each status actually means.</h2>
        </div>
        <div class="cat-grid" style="margin-top:36px">
          <div class="cat-tile" data-reveal><h3>Placed</h3><small>Stock is reserved for every line, all lines or none.</small></div>
          <div class="cat-tile" data-reveal><h3>Accepted</h3><small>The shop confirmed it can fulfil the order.</small></div>
          <div class="cat-tile" data-reveal><h3>Preparing</h3><small>Items are being picked and packed against the list.</small></div>
          <div class="cat-tile" data-reveal><h3>Ready</h3><small>Packed and waiting for a runner or customer collection.</small></div>
          <div class="cat-tile" data-reveal><h3>Picked up</h3><small>The runner presented the shop's handover PIN.</small></div>
          <div class="cat-tile" data-reveal><h3>Out for delivery</h3><small>Your delivery OTP becomes visible at this point.</small></div>
          <div class="cat-tile" data-reveal><h3>Delivered</h3><small>The runner entered your OTP. The job is complete.</small></div>
          <div class="cat-tile" data-reveal><h3>Completed</h3><small>A pickup order collected against the collection code.</small></div>
        </div>
        <p class="small muted mt-3">Rejections, cancellations and returns each carry a reason and release reserved stock back to the shop.</p>
      </div>
    </section>

    <section class="section" id="faq" aria-labelledby="howFaqTitle">
      <div class="wrap faq-layout">
        <div class="faq-layout__aside" data-reveal>
          <span class="eyebrow">Questions</span>
          <h2 id="howFaqTitle" style="font-size:clamp(26px,3vw,38px);margin-top:14px">Things people ask before their first order.</h2>
          <p class="muted mt-2">These answers come from the same help records the storefront uses, so they cannot drift apart.</p>
          <a class="link-arrow mt-3" href="/help/">Full help centre ${icon('arrow')}</a>
        </div>
        <div class="faq" data-reveal>
${FAQS.slice(0, 6).map((f, i) => faqItem(f.question, f.answer, i === 0)).join('\n')}
        </div>
      </div>
    </section>

    ${ctaBand('Ready to try the real thing?', 'Browse live stock from ten shops, or open one of the four demo accounts and walk the whole order through to delivery.', 'Explore nearby shops', '/shops/', 'Try the demo accounts', '/demo/')}
`;
page({
  file: 'how-it-works/index.html',
  title: 'How NearBuy works — discovery, order, fulfilment, settlement',
  description: 'How a NearBuy order moves from pincode to doorstep: serviceability, one basket across shops, seller packing, runner handover PINs, delivery OTPs and settlement.',
  active: 'how',
  body: howBody,
  ogImage: '/public/assets/site/parcels.jpg'
});

/* ================================================================= SELL === */
const sellCategories = CATEGORIES.filter((c) => c.slug !== 'other');
const sellBody = `    <section class="page-head page-head--image">
      <div class="page-head__bg" aria-hidden="true"><img src="/public/assets/site/shopkeeper.jpg" width="1024" height="1536" alt="" /></div>
      <div class="wrap page-head__inner page-head__inner--split">
        <div>
          <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${icon('chevron-right')}<span>Sell on NearBuy</span></nav>
          <h1>Your counter, on the internet.</h1>
          <p class="page-head__lede">NearBuy does not replace the shopkeeper. It gives you a counter that behaves like the one you already run: your catalogue, your stock, your prices, your hours — with discovery, delivery coordination and settlement added around it.</p>
          <div class="page-head__actions">
            <a class="btn btn--primary" href="#apply">Start your application ${icon('arrow', 'ic--arrow')}</a>
            <a class="btn btn--on-dark" href="/seller/">Seller Hub sign-in</a>
          </div>
        </div>
        <div class="page-head__aside">
          <div class="page-head__fact">${icon('check')}<div><b>No listing fee</b><small>You only pay commission on orders that actually complete, at the rate agreed during onboarding.</small></div></div>
          <div class="page-head__fact">${icon('clock')}<div><b>Review within 2 working days</b><small>Operations checks your documents and unlocks selling from the Admin Portal.</small></div></div>
          <div class="page-head__fact">${icon('store')}<div><b>Your identity stays yours</b><small>Your shop name, locality and policies are what customers see — not a NearBuy warehouse.</small></div></div>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="sellValueTitle">
      <div class="wrap">
        <div class="section-head" data-reveal>
          <span class="eyebrow">What you get</span>
          <h2 id="sellValueTitle">Everything a single shop cannot afford alone.</h2>
          <p>Discovery, ordering, payment records, delivery coordination and an operations console — without building any of it yourself.</p>
        </div>
        <div class="value-grid">
          <div class="value" data-reveal>
            <span class="value__icon">${icon('layers')}</span>
            <h3>Catalogue &amp; stock that stay true</h3>
            <p>Create products with price, pack size, tax and return window. Stock changes are atomic, and reserved quantities come off the shelf the moment an order is placed.</p>
          </div>
          <div class="value" data-reveal>
            <span class="value__icon">${icon('inbox')}</span>
            <h3>An order queue, not an inbox</h3>
            <p>Accept, reject with a reason, pack against the list, mark ready. The customer sees every transition, so the "where is my order" call mostly stops happening.</p>
          </div>
          <div class="value" data-reveal>
            <span class="value__icon">${icon('truck')}</span>
            <h3>Delivery you can hand over</h3>
            <p>Request a nearby Runner, deliver it yourself, or offer free store pickup. Handover works against a PIN so parcels do not disappear between counters.</p>
          </div>
          <div class="value" data-reveal>
            <span class="value__icon">${icon('chart')}</span>
            <h3>Numbers you can act on</h3>
            <p>Today's orders, revenue, low-stock alerts, returns and a settlement statement with commission and refunds itemised per order.</p>
          </div>
          <div class="value" data-reveal>
            <span class="value__icon">${icon('tag')}</span>
            <h3>Promotions you control</h3>
            <p>Run your own coupon with a minimum basket, a cap and an end date. It appears on the public offers page only while it is genuinely live.</p>
          </div>
          <div class="value" data-reveal>
            <span class="value__icon">${icon('users')}</span>
            <h3>Staff and hours</h3>
            <p>Add staff accounts with their own access, set business hours per day, and pause ordering when the counter is too busy.</p>
          </div>
        </div>
      </div>
    </section>

    <section class="section section--cream" aria-labelledby="sellStepsTitle">
      <div class="wrap">
        <div class="section-head section-head--split">
          <div data-reveal>
            <span class="eyebrow">Onboarding</span>
            <h2 id="sellStepsTitle">Four steps from application to first order.</h2>
          </div>
          <div data-reveal>
            <p>The whole flow is one wizard in the Seller Hub. You can stop after step one and come back — your account and draft shop stay saved.</p>
          </div>
        </div>
        <div class="steps">
          <div class="step" data-reveal><span class="step__num">01</span><h3>Create the account</h3><p>Owner name, email, mobile and a password. This is a seller account, separate from any customer account you may have.</p></div>
          <div class="step" data-reveal><span class="step__num">02</span><h3>Describe the business</h3><p>Registered or trading name, shop type, category, full address and contact details for the counter.</p></div>
          <div class="step" data-reveal><span class="step__num">03</span><h3>Submit documents</h3><p>PAN, GST registration where applicable, and one address or identity proof. Document metadata is recorded against your application.</p></div>
          <div class="step" data-reveal><span class="step__num">04</span><h3>Get reviewed</h3><p>Operations approves or returns the application with a reason. Approved shops unlock the full hub and appear in the public directory.</p></div>
        </div>
      </div>
    </section>

    <section class="section" id="apply" aria-labelledby="applyTitle">
      <div class="wrap">
        <div class="with-aside">
          <div>
            <div class="section-head" data-reveal>
              <span class="eyebrow">Step one</span>
              <h2 id="applyTitle">Open your seller account.</h2>
              <p>This creates a real seller account and a draft shop in the NearBuy database. You will finish business details and documents after signing in to the Seller Hub.</p>
            </div>
            <div class="form-card mt-3">
              <form class="form-grid" data-seller-form novalidate>
                <p class="form-status" data-form-status role="alert" hidden></p>
                <div class="form-row">
                  <div class="field">
                    <label for="sellName">Owner’s full name <span class="req" aria-hidden="true">*</span></label>
                    <input id="sellName" name="name" type="text" autocomplete="name" maxlength="80" placeholder="As on your PAN" required />
                    <p class="field__error" hidden></p>
                  </div>
                  <div class="field">
                    <label for="sellMobile">Mobile number <span class="req" aria-hidden="true">*</span></label>
                    <input id="sellMobile" name="mobile" type="tel" inputmode="numeric" autocomplete="tel" maxlength="14" placeholder="10-digit number" required />
                    <p class="field__error" hidden></p>
                  </div>
                </div>
                <div class="field">
                  <label for="sellEmail">Email address <span class="req" aria-hidden="true">*</span></label>
                  <input id="sellEmail" name="email" type="email" autocomplete="email" maxlength="120" placeholder="owner@yourshop.in" required />
                  <p class="field__error" hidden></p>
                </div>
                <div class="form-row">
                  <div class="field">
                    <label for="sellBusiness">Shop / business name <span class="req" aria-hidden="true">*</span></label>
                    <input id="sellBusiness" name="businessName" type="text" maxlength="120" placeholder="What customers call you" required />
                    <p class="field__error" hidden></p>
                  </div>
                  <div class="field">
                    <label for="sellCategory">Primary category <span class="req" aria-hidden="true">*</span></label>
                    <select id="sellCategory" name="category" required>
                      <option value="">Choose a category</option>
${sellCategories.map((c) => `                      <option value="${c.slug}">${esc(c.name)}</option>`).join('\n')}
                    </select>
                    <p class="field__error" hidden></p>
                  </div>
                </div>
                <div class="field">
                  <label for="sellShopType">Shop type</label>
                  <select id="sellShopType" name="shopType">
                    <option value="retail">Retail counter</option>
                    <option value="wholesale">Wholesale with retail pickup</option>
                    <option value="home_based">Home-based business</option>
                    <option value="market_stall">Market stall</option>
                    <option value="franchise">Franchise outlet</option>
                  </select>
                </div>
                <div class="form-row">
                  <div class="field">
                    <label for="sellPassword">Password <span class="req" aria-hidden="true">*</span></label>
                    <input id="sellPassword" name="password" type="password" autocomplete="new-password" minlength="8" placeholder="At least 8 characters" required />
                    <p class="field__error" hidden></p>
                  </div>
                  <div class="field">
                    <label for="sellPassword2">Confirm password <span class="req" aria-hidden="true">*</span></label>
                    <input id="sellPassword2" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" placeholder="Type it again" required />
                    <p class="field__error" hidden></p>
                  </div>
                </div>
                <div class="field">
                  <label class="check-line" for="sellTerms" style="font-weight:400">
                    <input id="sellTerms" name="terms" type="checkbox" required />
                    <span>I accept the <a href="/policies/#terms" style="color:var(--action);text-decoration:underline">seller terms</a> and the <a href="/policies/" style="color:var(--action);text-decoration:underline">privacy policy</a>, and I confirm I am authorised to sell on behalf of this business.</span>
                  </label>
                  <p class="field__error" hidden></p>
                </div>
                <button class="btn btn--primary btn--lg" type="submit">Create seller account ${icon('arrow', 'ic--arrow')}</button>
                <p class="form-note">${icon('lock')}<span>Stored in the NearBuy database. Operations reviews every application in the Admin Portal and records the decision with a reason.</span></p>
              </form>
            </div>
            <div class="form-success mt-3" data-seller-success hidden tabindex="-1" aria-live="polite">
              <span class="form-success__icon" aria-hidden="true">${icon('check')}</span>
              <h2>Seller account created.</h2>
              <p>Your shop exists as a draft and is waiting for business details and documents. Sign in to the Seller Hub to finish steps two and three — selling unlocks once operations approves the application.</p>
              <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:6px">
                <a class="btn btn--primary btn--sm" href="/seller/">Open the Seller Hub ${icon('arrow', 'ic--arrow')}</a>
                <a class="btn btn--ghost btn--sm" href="/help/">Seller help</a>
              </div>
            </div>
          </div>

          <aside>
            <div class="aside-card aside-card--sticky">
              <h3>What we ask for</h3>
              <ul>
                <li class="ask">${icon('check', 'ic--sm')} Owner name, mobile and email</li>
                <li class="ask">${icon('check', 'ic--sm')} Shop name, category and full address</li>
                <li class="ask">${icon('check', 'ic--sm')} PAN (mandatory) and GSTIN if registered</li>
                <li class="ask">${icon('check', 'ic--sm')} One address or identity proof</li>
              </ul>
              <hr style="margin:16px 0;border-color:var(--line-soft)" />
              <h3>Already registered?</h3>
              <p class="mt-1">Sign in to the Seller Hub to finish onboarding or manage today's orders.</p>
              <a class="link-arrow mt-2" href="/seller/">Seller Hub sign-in ${icon('arrow')}</a>
              <hr style="margin:16px 0;border-color:var(--line-soft)" />
              <h3>Questions first?</h3>
              <p class="mt-1">Write to <a href="mailto:sellers@nearbuy.in" style="color:var(--action)">sellers@nearbuy.in</a> or send an enquiry and we will call you back.</p>
              <a class="link-arrow mt-2" href="/contact/">Contact the team ${icon('arrow')}</a>
            </div>
          </aside>
        </div>
      </div>
    </section>

    <section class="section section--cream" aria-labelledby="sellFaqTitle">
      <div class="wrap faq-layout">
        <div class="faq-layout__aside" data-reveal>
          <span class="eyebrow">Seller questions</span>
          <h2 id="sellFaqTitle" style="font-size:clamp(26px,3vw,38px);margin-top:14px">Before you fill the form.</h2>
          <p class="muted mt-2">Still unsure? The team answers within one working day.</p>
          <a class="btn btn--ghost mt-3" href="/contact/">Ask a question</a>
        </div>
        <div class="faq" data-reveal>
${faqItem('Do I need a registered company to sell?', 'No. Sole proprietors, partnerships and family-run shops are all welcome. We ask for PAN and, if you are GST-registered, your GSTIN. Home-based and market-stall businesses are supported as shop types.', true)}
${faqItem('What does NearBuy charge?', 'There is no listing fee. Commission applies only to completed orders, at the rate agreed in writing during onboarding, and every order line on your settlement statement shows the commission applied.', false)}
${faqItem('Can I keep offering store pickup?', 'Yes. Pickup is set per shop, and you can charge for it or keep it free. Customers collect against a collection code that you mark complete at the counter.', false)}
${faqItem('Who handles delivery?', 'You choose per order: request a nearby Runner, hand it to your own staff, or let the customer collect. Runner jobs are ranked by distance and workload and expire if nobody accepts.', false)}
${faqItem('What happens if an item is out of stock?', 'Stock is reserved at checkout, but if a count is wrong you can pack a shortfall with a reason. The customer is told what changed and the line total adjusts before handover.', false)}
${faqItem('How do I get paid?', 'Cash-on-delivery and pay-at-store orders settle to your recorded balance. Settlement statements list gross, refunds, commission and net per period. Bank transfers require a payout provider, which this deployment does not have connected.', false)}
        </div>
      </div>
    </section>

    ${ctaBand('Bring your shop into the network.', 'Five minutes to apply, two working days to review, and your catalogue is live the moment you are approved.', 'Start your application', '#apply', 'See the shop directory', '/shops/')}
`;
page({
  file: 'sell/index.html',
  title: 'Sell on NearBuy — open your shop’s online counter',
  description: 'Join NearBuy as a seller: catalogue, stock, order queue, Runner delivery, promotions and settlement in one hub. Apply in five minutes, reviewed in two working days.',
  active: 'sell',
  body: sellBody,
  ogImage: '/public/assets/site/shopkeeper.jpg'
});

/* ============================================================== DELIVER === */
const deliverBody = `    <section class="page-head page-head--image">
      <div class="page-head__bg" aria-hidden="true"><img src="/public/assets/site/courier.jpg" width="1536" height="1024" alt="" /></div>
      <div class="wrap page-head__inner page-head__inner--split">
        <div>
          <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${icon('chevron-right')}<span>Deliver with Runner</span></nav>
          <h1>Neighbours delivering to neighbours.</h1>
          <p class="page-head__lede">NearBuy Runner is the delivery network that keeps parcels local. Short distances, offers you can see before accepting, one active job at a time, and a payout recorded against every completed delivery.</p>
          <div class="page-head__actions">
            <a class="btn btn--primary" href="#apply">Apply to deliver ${icon('arrow', 'ic--arrow')}</a>
            <a class="btn btn--on-dark" href="/runner/">Partner sign-in</a>
          </div>
        </div>
        <div class="page-head__aside">
          <div class="page-head__fact">${icon('pin')}<div><b>Routes inside your locality</b><small>Offers are ranked by distance and your current workload, not blasted to everyone at once.</small></div></div>
          <div class="page-head__fact">${icon('rupee')}<div><b>Payout before you accept</b><small>Every offer shows the payout and the distance, so the decision is yours.</small></div></div>
          <div class="page-head__fact">${icon('shield')}<div><b>Two codes, no disputes</b><small>A seller PIN at pickup and a customer OTP at delivery protect both ends.</small></div></div>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="runnerValueTitle">
      <div class="wrap">
        <div class="section-head" data-reveal>
          <span class="eyebrow">The working day</span>
          <h2 id="runnerValueTitle">Built for a few hours, not a shift rota.</h2>
          <p>Go online when you want, take what fits, go offline. Nothing is assigned to you while you are offline.</p>
        </div>
        <div class="value-grid">
          <div class="value" data-reveal><span class="value__icon">${icon('clock')}</span><h3>Online when you are</h3><p>The toggle in the Runner Portal decides whether offers reach you. Off means off.</p></div>
          <div class="value" data-reveal><span class="value__icon">${icon('box')}</span><h3>One job at a time</h3><p>No stacking, no impossible windows. Finish the handover, then the next offer can arrive.</p></div>
          <div class="value" data-reveal><span class="value__icon">${icon('chart')}</span><h3>Earnings you can audit</h3><p>Today, this week, all time, average per delivery, plus a full delivery history.</p></div>
          <div class="value" data-reveal><span class="value__icon">${icon('shield')}</span><h3>Safety centre</h3><p>Report an incident or a difficult delivery from the portal. Tickets go to operations, tied to your account.</p></div>
          <div class="value" data-reveal><span class="value__icon">${icon('pin')}</span><h3>Zones you know</h3><p>Pick your service areas and preferences so the offers you see are the streets you already ride.</p></div>
          <div class="value" data-reveal><span class="value__icon">${icon('refresh')}</span><h3>Payout requests</h3><p>Request a payout from your earnings balance and follow its status in the portal.</p></div>
        </div>
      </div>
    </section>

    <section class="section section--cream" aria-labelledby="runnerStepsTitle">
      <div class="wrap">
        <div class="section-head section-head--split">
          <div data-reveal><span class="eyebrow">A single delivery</span><h2 id="runnerStepsTitle">What happens between two doors.</h2></div>
          <div data-reveal><p>Every step below is enforced by the server. A screen alone cannot skip a PIN or an OTP.</p></div>
        </div>
        <div class="steps">
          <div class="step" data-reveal><span class="step__num">01</span><h3>Offer</h3><p>An offer with payout, distance and an expiry timer arrives while you are online.</p></div>
          <div class="step" data-reveal><span class="step__num">02</span><h3>Pickup</h3><p>Collect from the shop and enter the handover PIN the seller shows you.</p></div>
          <div class="step" data-reveal><span class="step__num">03</span><h3>Transit</h3><p>Mark out for delivery. The customer's OTP becomes visible to them at this point.</p></div>
          <div class="step" data-reveal><span class="step__num">04</span><h3>Handover</h3><p>Enter the customer's 6-digit OTP. The payout posts to your earnings ledger.</p></div>
        </div>
      </div>
    </section>

    <section class="section" id="apply" aria-labelledby="runnerApplyTitle">
      <div class="wrap">
        <div class="with-aside">
          <div>
            <div class="section-head" data-reveal>
              <span class="eyebrow">Application</span>
              <h2 id="runnerApplyTitle">Tell us about you and your vehicle.</h2>
              <p>This is a real application record. Operations reviews it before partner offers are sent; you will hear back by email or phone.</p>
            </div>
            <div class="form-card mt-3">
              <form class="form-grid" data-enquiry-form data-topic="Delivery partner" novalidate>
                <p class="form-status" data-form-status role="alert" hidden></p>
                <div class="form-row">
                  <div class="field">
                    <label for="runnerName">Full name <span class="req" aria-hidden="true">*</span></label>
                    <input id="runnerName" name="name" type="text" autocomplete="name" maxlength="80" placeholder="Your name" required />
                    <p class="field__error" hidden></p>
                  </div>
                  <div class="field">
                    <label for="runnerContact">Mobile or email <span class="req" aria-hidden="true">*</span></label>
                    <input id="runnerContact" name="contact" type="text" autocomplete="tel" maxlength="120" placeholder="98xxxxxxxx or you@example.com" required />
                    <p class="field__error" hidden></p>
                  </div>
                </div>
                <div class="field" hidden>
                  <label for="runnerTopic">Topic</label>
                  <select id="runnerTopic" name="topic"><option>General enquiry</option><option selected>Delivery partner</option><option>Order help</option><option>Returns &amp; refunds</option><option>Selling on NearBuy</option><option>Payments</option><option>Others</option></select>
                </div>
                <div class="field">
                  <label for="runnerMessage">Your details <span class="req" aria-hidden="true">*</span></label>
                  <textarea id="runnerMessage" name="message" rows="6" maxlength="600" placeholder="Your locality, the vehicle you use (scooter, bike, cycle), your usual hours, and any delivery experience." required></textarea>
                  <div style="display:flex;justify-content:space-between;gap:12px">
                    <p class="field__error" hidden></p>
                    <span class="field__count" data-count-for="message">0 / 600</span>
                  </div>
                </div>
                <button class="btn btn--primary btn--lg" type="submit">Submit application ${icon('arrow', 'ic--arrow')}</button>
                <p class="form-note">${icon('lock')}<span>Goes straight into the operations console with a reference code. No SMS or email provider is configured, so keep the code.</span></p>
              </form>
            </div>
            <div class="form-success mt-3" data-enquiry-success hidden tabindex="-1" aria-live="polite">
              <span class="form-success__icon" aria-hidden="true">${icon('check')}</span>
              <h2>Application received.</h2>
              <p>Your details are with operations under reference <span class="form-success__ref" data-enquiry-ref>—</span>. We review delivery applications before any offers are sent, and we will contact you on the number you gave.</p>
              <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:6px">
                <button class="btn btn--ghost btn--sm" type="button" data-enquiry-again>Send another</button>
                <a class="btn btn--primary btn--sm" href="/how-it-works/">How delivery works</a>
              </div>
            </div>
          </div>
          <aside>
            <div class="aside-card aside-card--sticky">
              <h3>What you need</h3>
              <ul>
                <li>${icon('check', 'ic--sm')} A smartphone with data</li>
                <li>${icon('check', 'ic--sm')} A scooter, bike or cycle you can use</li>
                <li>${icon('check', 'ic--sm')} A government ID for verification</li>
                <li>${icon('check', 'ic--sm')} A bank account or UPI ID for payouts</li>
              </ul>
              <hr style="margin:16px 0;border-color:var(--line-soft)" />
              <h3>Already a partner?</h3>
              <p class="mt-1">Sign in to the Runner Portal to go online, take a job or check earnings.</p>
              <a class="link-arrow mt-2" href="/runner/">Runner Portal sign-in ${icon('arrow')}</a>
              <hr style="margin:16px 0;border-color:var(--line-soft)" />
              <p class="small">NearBuy never asks for money to join. If anyone asks for a deposit in our name, report it to <a href="mailto:safety@nearbuy.in" style="color:var(--action)">safety@nearbuy.in</a>.</p>
            </div>
          </aside>
        </div>
      </div>
    </section>

    <section class="section section--cream" aria-labelledby="runnerFaqTitle">
      <div class="wrap faq-layout">
        <div class="faq-layout__aside" data-reveal>
          <span class="eyebrow">Partner questions</span>
          <h2 id="runnerFaqTitle" style="font-size:clamp(26px,3vw,38px);margin-top:14px">The honest answers.</h2>
          <p class="muted mt-2">This is a demo deployment, and the payouts section says exactly what is real.</p>
        </div>
        <div class="faq" data-reveal>
${faqItem('Is delivery work full-time?', 'No. You choose your hours by going online and offline in the portal. Many partners ride for two hours in the morning and two in the evening.', true)}
${faqItem('How are payouts calculated?', 'Each delivery offer carries a payout amount before you accept it, based on the distance and the order. Completed deliveries accumulate in your earnings view, and you can request a payout from the portal.', false)}
${faqItem('What if the customer is not answering?', 'Do not hand the parcel over without the OTP. Use the safety centre in the portal to raise an incident and operations will guide you, with the order and your job reference attached.', false)}
${faqItem('Can I deliver for my own shop?', 'If you run a shop on NearBuy, the Seller Hub lets you mark an order as self-delivered. That is separate from being a Runner partner, and it does not create a partner payout.', false)}
${faqItem('Are payouts actually transferred here?', 'No. This deployment records earnings and payout requests, but no payout provider is connected, so no money moves automatically. That limitation is stated in the portal too.', false)}
        </div>
      </div>
    </section>

    ${ctaBand('Ride the streets you already know.', 'Apply once, get reviewed, then go online whenever the neighbourhood needs a hand.', 'Apply to deliver', '#apply', 'How handover works', '/how-it-works/#delivery')}
`;
page({
  file: 'deliver/index.html',
  title: 'Deliver with NearBuy Runner — local delivery partner work',
  description: 'Join NearBuy Runner: nearby offers with payout and distance, one active job at a time, pickup PINs and customer OTP handovers, and an earnings ledger you can audit.',
  active: 'deliver',
  body: deliverBody,
  ogImage: '/public/assets/site/courier.jpg'
});

/* ================================================================ ABOUT === */
const aboutBody = `    <section class="page-head page-head--image">
      <div class="page-head__bg" aria-hidden="true"><img src="/public/assets/site/hero-street.jpg" width="1536" height="1024" alt="" /></div>
      <div class="wrap page-head__inner">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${icon('chevron-right')}<span>About</span></nav>
        <h1>Your neighbourhood, organised.</h1>
        <p class="page-head__lede">NearBuy is a neighbourhood commerce company. We build the software that lets a shop on your street sell online, and the delivery network that gets the parcel to your door without leaving the locality.</p>
      </div>
    </section>

    <section class="section" aria-labelledby="storyTitle">
      <div class="wrap">
        <div class="with-aside">
          <div class="prose" data-reveal>
            <span class="eyebrow">The story</span>
            <h2 id="storyTitle">It started with a sold-out bakery.</h2>
            <p>In 2021, three of us were trying to order a birthday cake from the bakery two streets away. The bakery had no website. The marketplace apps only listed shops across the city, with two-day delivery and prices that had nothing to do with the counter. So we walked over, queued, and got the last cake.</p>
            <p>That walk became the product brief. A shop two streets away should be as easy to order from as a warehouse in another state — and the money should stay in the neighbourhood. Every design decision since has been in service of that one idea.</p>

            <h3>What we actually built</h3>
            <p>NearBuy is one platform with four connected workspaces sharing a single database: a customer storefront, a seller hub, a delivery-partner portal and an operations console. A basket placed in the storefront becomes an order the seller accepts, a job a runner delivers, and a settlement line the shop can audit. There is no sample data in the middle of that chain.</p>
            <p>The first service area was Hauz Khas, because that is where the bakery is. It has since grown to ${STATS.localities} pincodes across south Delhi, with ${STATS.shops} shops and ${STATS.products} live products.</p>

            <blockquote>“A marketplace that cannot tell you which shop your milk came from is a warehouse with nicer branding.”</blockquote>

            <h3>How we work</h3>
            <ul>
              <li><strong>Distance first.</strong> Recommendations are ordered by whether a shop can reach you, not by who pays for placement.</li>
              <li><strong>Honest interfaces.</strong> If a category has no stock, it says so. If a payment method is not configured, checkout says so instead of failing silently.</li>
              <li><strong>The shop keeps its identity.</strong> Its name, prices, hours and policies are what the customer sees.</li>
              <li><strong>Nothing important is client-side.</strong> Prices, discounts, stock reservations and handover codes are decided on the server.</li>
            </ul>

            <h3>Where we are going</h3>
            <p>Three things are in progress: real card and UPI payments through a gateway, SMS and email so verification codes leave the screen, and map tiles so distances stop being straight-line estimates. Each one is a provider integration, not a redesign — the data model already records what those services need. The <a href="/checklist/">feature checklist</a> lists all 84 shipped capabilities, and the pages that depend on a missing provider say which one.</p>
          </div>

          <aside>
            <div class="aside-card aside-card--sticky">
              <h3>NearBuy at a glance</h3>
              <ul>
                <li><strong style="color:var(--ink)">${STATS.shops}</strong> verified shops</li>
                <li><strong style="color:var(--ink)">${STATS.products}</strong> products with live stock</li>
                <li><strong style="color:var(--ink)">${STATS.localities}</strong> pincodes served</li>
                <li><strong style="color:var(--ink)">4</strong> connected workspaces</li>
                <li><strong style="color:var(--ink)">84</strong> shipped features on the checklist</li>
              </ul>
              <hr style="margin:16px 0;border-color:var(--line-soft)" />
              <h3>Company</h3>
              <p class="mt-1">NearBuy Technologies<br>2nd Floor, 14 Hauz Khas Village<br>New Delhi 110016, India</p>
              <p class="mt-2 small">hello@nearbuy.in · 011 4106 2200</p>
              <a class="link-arrow mt-2" href="/contact/">Contact us ${icon('arrow')}</a>
            </div>
          </aside>
        </div>
      </div>
    </section>

    <section class="section section--cream" id="trust" aria-labelledby="trustTitle">
      <div class="wrap">
        <div class="section-head section-head--split">
          <div data-reveal><span class="eyebrow">Trust &amp; safety</span><h2 id="trustTitle">The rules we hold ourselves to.</h2></div>
          <div data-reveal><p>Trust in a delivery network is mostly about what cannot be faked. These are enforced by the server, not by a screen.</p></div>
        </div>
        <div class="value-grid">
          <div class="value" data-reveal><span class="value__icon">${icon('lock')}</span><h3>Sessions stay put</h3><p>Each workspace has its own HttpOnly session cookie, cleared on sign-out. A customer session never unlocks seller, partner or operations screens.</p></div>
          <div class="value" data-reveal><span class="value__icon">${icon('shield')}</span><h3>Verification, not buttons</h3><p>Shop approvals, pickup PINs and delivery OTPs are checked server-side. OTPs are derived with HMAC-SHA256 and never stored in plain text.</p></div>
          <div class="value" data-reveal><span class="value__icon">${icon('inbox')}</span><h3>Everything stays on the server</h3><p>Enquiries, orders and applications are database rows, not browser state. Every administrative action is written to an audit log.</p></div>
          <div class="value" data-reveal><span class="value__icon">${icon('check')}</span><h3>Humans decide</h3><p>Shop approvals, returns and refunds queue up for staff, each with a reason, instead of happening automatically.</p></div>
          <div class="value" data-reveal><span class="value__icon">${icon('heart')}</span><h3>Verified reviews only</h3><p>A review can only be written by someone who bought the item. Reviews are moderated before publication.</p></div>
          <div class="value" data-reveal><span class="value__icon">${icon('rupee')}</span><h3>Server-side money</h3><p>Totals, discounts, taxes and delivery fees are calculated by the server. The browser never sends a price.</p></div>
        </div>
        <div class="aside-card mt-4" style="max-width:900px">
          <h3>Demo deployment notice</h3>
          <p class="mt-1">This instance runs on a seeded sample dataset shared between visitors, and it exists so the whole platform can be inspected end to end. Orders, stock changes, enquiries and applications write to the real database, but no money moves: card and UPI payments are disabled unless gateway keys are configured, payouts are recorded rather than transferred, and identity documents are recorded but not verified against a registry. Please do not enter personal or sensitive information. Map tiles are not connected, so distances are straight-line estimates multiplied by a road factor.</p>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="teamTitle">
      <div class="wrap">
        <div class="section-head" data-reveal>
          <span class="eyebrow">The team</span>
          <h2 id="teamTitle">Small team, on the ground.</h2>
          <p>Everyone at NearBuy spends at least one day a month behind a counter or on a scooter. It is the only reliable way to find the problems the dashboard does not show.</p>
        </div>
        <div class="card-grid" style="margin-top:40px">
          <article class="quote" data-reveal>
            <blockquote style="font-size:18px">“The product decisions come from watching a shopkeeper find time between customers. If it takes longer than that, it is the wrong design.”</blockquote>
            <div class="quote__by"><span class="quote__avatar" aria-hidden="true">AY</span><span><b>Ananya Yadav</b><small>Co-founder, product</small></span></div>
          </article>
          <article class="quote" data-reveal>
            <blockquote style="font-size:18px">“Delivery goes wrong at handover, not in transit. Two codes solved more disputes than any support script we tried.”</blockquote>
            <div class="quote__by"><span class="quote__avatar" aria-hidden="true">FS</span><span><b>Farhan Siddiqui</b><small>Co-founder, operations</small></span></div>
          </article>
          <article class="quote" data-reveal>
            <blockquote style="font-size:18px">“Pricing, stock and serviceability are server decisions. Once we held that line, half the support queue disappeared.”</blockquote>
            <div class="quote__by"><span class="quote__avatar" aria-hidden="true">MK</span><span><b>Meera Kulkarni</b><small>Engineering lead</small></span></div>
          </article>
        </div>
      </div>
    </section>

    ${ctaBand('See it from the inside.', 'Open a demo account and walk a real order from a shop counter to a doorstep.', 'Try the demo accounts', '/demo/', 'Browse nearby shops', '/shops/')}
`;
page({
  file: 'about/index.html',
  title: 'About NearBuy — the neighbourhood model and our rules',
  description: 'Who NearBuy is, why we optimised for the nearest seller, the four workspaces on one database, and the trust rules we enforce server-side.',
  active: 'about',
  body: aboutBody
});

/* ================================================================= HELP === */
const faqGroups = FAQS.reduce((acc, f) => {
  const key = f.category || 'General';
  (acc[key] = acc[key] || []).push(f);
  return acc;
}, {});
const helpBody = `    <section class="page-head">
      <div class="wrap page-head__inner">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${icon('chevron-right')}<span>Help</span></nav>
        <h1>Help centre.</h1>
        <p class="page-head__lede">Twelve answers straight from the live help records your storefront uses, routes into every support surface, and a form that writes to the operations inbox.</p>
        <div class="page-head__actions">
          <a class="btn btn--navy" href="#faq">Browse the FAQs ${icon('arrow', 'ic--arrow')}</a>
          <a class="btn btn--ghost" href="/customer/#/help">Open in-app help</a>
        </div>
      </div>
    </section>

    <section class="section section--tight" aria-labelledby="routesTitle">
      <div class="wrap">
        <div class="section-head" data-reveal><span class="eyebrow">Quick links</span><h2 id="routesTitle">Jump straight to the right place.</h2></div>
        <div class="card-grid card-grid--4" style="margin-top:32px">
          <a class="help-link" href="/customer/#/orders" data-reveal><span class="shop-card__emoji" aria-hidden="true">${icon('box')}</span><b>Track an order</b><small>Live status, runner details and your delivery OTP.</small></a>
          <a class="help-link" href="/customer/#/help" data-reveal><span class="shop-card__emoji" aria-hidden="true">${icon('inbox')}</span><b>Raise a ticket</b><small>Order-linked support threads, kept together with the order.</small></a>
          <a class="help-link" href="/policies/#refunds" data-reveal><span class="shop-card__emoji" aria-hidden="true">${icon('refresh')}</span><b>Refunds &amp; returns</b><small>Windows, eligibility and how money comes back.</small></a>
          <a class="help-link" href="/contact/" data-reveal><span class="shop-card__emoji" aria-hidden="true">${icon('mail')}</span><b>Contact the team</b><small>A form with a reference code, reviewed by operations.</small></a>
        </div>
      </div>
    </section>

    <section class="section section--cream" id="faq" aria-labelledby="faqTitle">
      <div class="wrap faq-layout">
        <div class="faq-layout__aside" data-reveal>
          <span class="eyebrow">Answers</span>
          <h2 id="faqTitle" style="font-size:clamp(26px,3vw,38px);margin-top:14px">${FAQS.length} things people ask.</h2>
          <p class="muted mt-2">Grouped the way the storefront groups them. If an answer is missing, the form below reaches a person.</p>
          <ul class="check-list">
${Object.keys(faqGroups).map((key) => `            <li>${icon('chevron-right', 'ic--sm')}<span>${esc(key)} <span style="color:var(--muted-2)">(${faqGroups[key].length})</span></span></li>`).join('\n')}
          </ul>
          <a class="btn btn--ghost mt-3" href="#enquiry">Ask us directly</a>
        </div>
        <div class="faq" data-reveal>
${FAQS.map((f, i) => faqItem(f.question, f.answer, i === 0)).join('\n')}
        </div>
      </div>
    </section>

    <section class="section" id="enquiry" aria-labelledby="enquiryTitle">
      <div class="wrap">
        <div class="with-aside">
          <div>
            <div class="section-head" data-reveal>
              <span class="eyebrow">Support desk</span>
              <h2 id="enquiryTitle">Still stuck? Write to us.</h2>
              <p>Every enquiry is stored in the NearBuy database and appears in the operations console with a reference code you can quote back to us.</p>
            </div>
            <div class="form-card mt-3">
              <form class="form-grid" data-enquiry-form novalidate>
                <p class="form-status" data-form-status role="alert" hidden></p>
                <div class="form-row">
                  <div class="field">
                    <label for="helpName">Full name <span class="req" aria-hidden="true">*</span></label>
                    <input id="helpName" name="name" type="text" autocomplete="name" maxlength="80" placeholder="Your name" required />
                    <p class="field__error" hidden></p>
                  </div>
                  <div class="field">
                    <label for="helpContact">Mobile or email <span class="req" aria-hidden="true">*</span></label>
                    <input id="helpContact" name="contact" type="text" autocomplete="email" maxlength="120" placeholder="you@example.com or 98xxxxxxxx" required />
                    <p class="field__error" hidden></p>
                  </div>
                </div>
                <div class="field">
                  <label for="helpTopic">Topic <span class="req" aria-hidden="true">*</span></label>
                  <select id="helpTopic" name="topic" required>
                    <option value="">Choose a topic</option>
                    <option>General enquiry</option>
                    <option>Order help</option>
                    <option>Returns &amp; refunds</option>
                    <option>Selling on NearBuy</option>
                    <option>Delivery partner</option>
                    <option>Payments</option>
                    <option>Others</option>
                  </select>
                  <p class="field__error" hidden></p>
                </div>
                <div class="field">
                  <label for="helpMessage">Message <span class="req" aria-hidden="true">*</span></label>
                  <textarea id="helpMessage" name="message" rows="6" maxlength="600" placeholder="Include your order code if you have one." required></textarea>
                  <div style="display:flex;justify-content:space-between;gap:12px">
                    <p class="field__error" hidden></p>
                    <span class="field__count" data-count-for="message">0 / 600</span>
                  </div>
                </div>
                <button class="btn btn--primary btn--lg" type="submit">Send to support ${icon('arrow', 'ic--arrow')}</button>
              </form>
            </div>
            <div class="form-success mt-3" data-enquiry-success hidden tabindex="-1" aria-live="polite">
              <span class="form-success__icon" aria-hidden="true">${icon('check')}</span>
              <h2>Thanks — we have it.</h2>
              <p>Your query is stored under reference <span class="form-success__ref" data-enquiry-ref>—</span> and will be picked up in the operations console.</p>
              <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:6px">
                <button class="btn btn--ghost btn--sm" type="button" data-enquiry-again>Send another query</button>
                <a class="btn btn--primary btn--sm" href="/customer/#/help">Order help</a>
              </div>
            </div>
          </div>
          <aside>
            <div class="aside-card aside-card--sticky">
              <h3>Support routes by role</h3>
              <ul>
                <li><a href="/customer/#/help">Customer storefront help</a></li>
                <li><a href="/seller/">Seller Hub support centre</a></li>
                <li><a href="/runner/">Runner safety centre</a></li>
                <li><a href="/contact/">Contact the team directly</a></li>
              </ul>
              <hr style="margin:16px 0;border-color:var(--line-soft)" />
              <h3>Contact</h3>
              <p class="mt-1">011 4106 2200<br>Mon–Sat, 9:00–20:00 IST<br><a href="mailto:hello@nearbuy.in" style="color:var(--action)">hello@nearbuy.in</a></p>
            </div>
          </aside>
        </div>
      </div>
    </section>
`;
page({
  file: 'help/index.html',
  title: 'Help centre — orders, delivery, refunds | NearBuy',
  description: 'Twelve live answers on NearBuy orders, delivery OTPs, store pickup, payments and refunds, plus routes into every support surface and a real enquiry form.',
  active: 'help',
  body: helpBody
});

/* ============================================================= POLICIES === */
const policiesBody = `    <section class="page-head">
      <div class="wrap page-head__inner">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${icon('chevron-right')}<span>Policies</span></nav>
        <h1>Privacy, terms and refunds.</h1>
        <p class="page-head__lede">Written to be read, not to be survived. These policies describe what this deployment actually does, including what it deliberately does not do.</p>
        <p class="prose__meta" style="margin-top:16px">Last updated 24 November 2026 · Applies to nearbuy.in and the NearBuy apps</p>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <div class="with-aside">
          <div class="prose" data-reveal>
            <h2 id="privacy">Privacy policy</h2>
            <h3>What we collect</h3>
            <ul>
              <li><strong>Account details:</strong> name, email, mobile number and a hashed password. Passwords are stored as scrypt hashes, never in readable form.</li>
              <li><strong>Addresses:</strong> the delivery address, locality, pincode and coordinates you save, so shops can decide serviceability.</li>
              <li><strong>Orders:</strong> basket contents, totals, fulfilment choice, delivery codes and the status timeline for every order.</li>
              <li><strong>Support records:</strong> enquiries and tickets you send us, with the reference code we return.</li>
              <li><strong>Technical data:</strong> session cookies and audit-log entries for administrative actions, used for security and debugging.</li>
            </ul>
            <h3>What we do not collect here</h3>
            <p>This deployment has no advertising trackers, no third-party analytics scripts and no cross-site profiling. Payment card details are never handled by NearBuy — when a gateway is configured, the gateway holds them, not us.</p>
            <h3>How long we keep it</h3>
            <p>Order and settlement records are kept for the period required for accounting and dispute handling. Account data is kept while the account is open. Support records are kept for two years. Audit logs are retained for security review.</p>
            <h3>Your choices</h3>
            <p>You can edit your profile and addresses in the storefront, change your mobile number or email through a verification code, and opt out of marketing messages while keeping order updates. To request a copy of your data or deletion of your account, write to <a href="mailto:privacy@nearbuy.in">privacy@nearbuy.in</a>.</p>
            <h3>Cookies</h3>
            <p>NearBuy uses three functional cookies: one each for the customer, seller and operations sessions. They are <code>HttpOnly</code>, same-site and cleared on sign-out. There is no advertising or analytics cookie to consent to.</p>

            <h2 id="terms">Terms of use</h2>
            <h3>The marketplace role</h3>
            <p>NearBuy is a marketplace. The contract of sale is between you and the shop that fulfils the order. NearBuy provides the platform, the payment record and, where you choose it, the delivery coordination.</p>
            <h3>Accounts</h3>
            <p>You are responsible for keeping your password confidential and for activity under your account. One person, one customer account. Seller and delivery-partner accounts are separate and subject to review.</p>
            <h3>Prices, stock and availability</h3>
            <p>Prices and stock are set by each shop and re-checked on the server at checkout. If an item becomes unavailable after you order but before the shop accepts, the shop may reject the line with a reason and any reservation is released.</p>
            <h3>Acceptable use</h3>
            <p>Do not attempt to place fraudulent orders, tamper with prices or delivery codes, scrape the catalogue, or misuse another person's account. We may suspend an account that does.</p>
            <h3>Liability</h3>
            <p>NearBuy is not liable for a shop's product quality beyond the refund policy below, or for delays caused by weather, traffic or events outside reasonable control. Nothing here limits rights you have under applicable consumer law.</p>

            <h2 id="refunds">Refund and return policy</h2>
            <h3>Return windows</h3>
            <p>Every product carries its own return window, shown on the product page before you buy. Sealed packaged goods typically carry a longer window; perishables such as fruit, vegetables, dairy and bakery items are only returnable if they arrive damaged, spoiled or incorrect.</p>
            <h3>How to raise a return</h3>
            <ol>
              <li>Open the order in your storefront and choose <strong>Return or report an issue</strong>.</li>
              <li>Pick a reason and, where relevant, add a photo reference.</li>
              <li>The shop reviews it. Approved returns are restocked and the refund is posted to the order.</li>
            </ol>
            <h3>Cancellations</h3>
            <p>You can cancel free of charge before the shop accepts the order. After acceptance, cancellation depends on whether packing has started, and the shop decides with a recorded reason.</p>
            <h3>Refund timing</h3>
            <p>Cash-on-delivery refunds are recorded against your order and settled by the shop. Prepaid refunds return to the original payment method through the payment gateway once one is configured; the order page shows the refund status either way.</p>
            <h3>Wrong or damaged items</h3>
            <p>Report within 24 hours for perishables and within the stated window for everything else. The shop may ask for a photo. If the shop and you cannot agree, raise a support ticket and operations will review the order record.</p>

            <h2 id="sellers">Seller terms summary</h2>
            <ul>
              <li>You must be authorised to sell on behalf of the business you register, and provide accurate PAN and GST details.</li>
              <li>List only what you can actually stock, keep counts current, and honour the prices you publish.</li>
              <li>Accept or reject orders promptly. Repeated late rejections are reviewed by operations.</li>
              <li>Commission applies to completed orders at the agreed rate and is itemised on your settlement statement.</li>
              <li>Returns approved by you are deducted from the settlement line for that order.</li>
            </ul>

            <h2 id="delivery">Delivery-partner terms summary</h2>
            <ul>
              <li>Deliver only to the address on the job, and never hand a parcel over without the customer's OTP.</li>
              <li>Do not open, alter or substitute items. Report damage through the safety centre before pickup.</li>
              <li>Keep your availability accurate. Accepting a job you cannot complete blocks another partner from it.</li>
              <li>Earnings accrue per completed delivery. Payout requests are recorded in the portal.</li>
            </ul>

            <h2 id="contact">Questions about these policies</h2>
            <p>Write to <a href="mailto:privacy@nearbuy.in">privacy@nearbuy.in</a> for data questions or <a href="mailto:hello@nearbuy.in">hello@nearbuy.in</a> for anything else. You can also <a href="/contact/">use the contact form</a>, which creates a reference code you can quote.</p>
          </div>
          <aside>
            <div class="aside-card aside-card--sticky">
              <h3>On this page</h3>
              <ul>
                <li><a href="#privacy">Privacy policy</a></li>
                <li><a href="#terms">Terms of use</a></li>
                <li><a href="#refunds">Refund &amp; return policy</a></li>
                <li><a href="#sellers">Seller terms summary</a></li>
                <li><a href="#delivery">Delivery-partner terms</a></li>
              </ul>
              <hr style="margin:16px 0;border-color:var(--line-soft)" />
              <h3>Need a person?</h3>
              <p class="mt-1">The support desk answers within one working day.</p>
              <a class="link-arrow mt-2" href="/contact/">Contact us ${icon('arrow')}</a>
            </div>
          </aside>
        </div>
      </div>
    </section>
`;
page({
  file: 'policies/index.html',
  title: 'Privacy, terms and refunds | NearBuy',
  description: 'NearBuy privacy policy, terms of use, refund and return windows, plus summaries of the seller and delivery-partner terms.',
  active: 'help',
  body: policiesBody
});

/* ============================================================ CHECKLIST === */
const CHECKLIST = JSON.parse(readFileSync(join(ROOT, 'tools/site-data/checklist.json'), 'utf8'));
const totalItems = CHECKLIST.reduce((t, g) => t + g.items.length, 0);
const checklistBody = `    <section class="page-head">
      <div class="wrap page-head__inner">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${icon('chevron-right')}<span>Feature checklist</span></nav>
        <h1>Everything that actually ships.</h1>
        <p class="page-head__lede">${totalItems} capabilities across five areas, listed because they exist in this build — not because they are planned. Tick items as you review them; your progress stays in this browser and is never uploaded.</p>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <div class="card-grid card-grid--4" style="gap:14px">
          <div class="aside-card"><h3>Reviewed so far</h3><p style="margin-top:8px"><b id="rlDone" style="font-family:var(--display);font-size:32px;color:var(--ink)">0</b> <span class="muted">of ${totalItems}</span></p></div>
${CHECKLIST.map((g) => `          <div class="aside-card"><h3>${esc(g.name)}</h3><p style="margin-top:8px" class="small"><span data-count-for="${g.key}">0 / ${g.items.length} reviewed</span></p></div>`).join('\n')}
        </div>

        <div class="mt-4">
          <div style="height:6px;border-radius:999px;background:var(--cream-2);overflow:hidden"><div id="rlFill" style="height:100%;width:0;background:var(--marigold);transition:width .25s ease"></div></div>
        </div>

        <div class="mt-4" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">
          <button class="btn btn--ghost btn--sm" type="button" id="rlReset">Reset my ticks</button>
          <span class="small muted">Selections are stored in this browser only.</span>
        </div>
      </div>
    </section>

${CHECKLIST.map((g) => `    <section class="section section--tight section--line" id="rl-${g.key}">
      <div class="wrap">
        <div class="section-head section-head--split">
          <div><span class="eyebrow">${esc(g.name)}</span><h2 style="font-size:clamp(24px,2.6vw,32px)">${g.items.length} capabilities</h2></div>
          <div><p class="small muted">${esc(g.name)} — every item below is wired to the shared API and covered by the automated test suite.</p></div>
        </div>
        <ul class="faq" style="margin-top:26px">
${g.items.map((item, i) => `          <li class="rl-item" style="border-bottom:1px solid var(--line);padding:14px 0"><label style="display:grid;grid-template-columns:20px 1fr;gap:12px;align-items:start;cursor:pointer;font-size:15px;color:var(--text)"><input type="checkbox" id="rl-${g.key}-${i}" style="width:18px;height:18px;margin-top:3px;accent-color:var(--navy)" /> <span>${esc(item)}</span></label></li>`).join('\n')}
        </ul>
      </div>
    </section>`).join('\n')}

    <section class="section section--cream">
      <div class="wrap">
        <div class="section-head" data-reveal>
          <span class="eyebrow">What is not here</span>
          <h2>Honest gaps, in one place.</h2>
          <p>These are provider integrations this deployment does not have. None of them are simulated in the interface.</p>
        </div>
        <ul class="checklist" style="margin-top:28px;max-width:820px">
          <li>${icon('alert')}<span><b>Online card and UPI payments</b> — enabled only when gateway keys are configured; cash on delivery and pay-at-store work today.</span></li>
          <li>${icon('alert')}<span><b>SMS and email</b> — no provider connected, so verification codes are shown on screen in development and no message is sent.</span></li>
          <li>${icon('alert')}<span><b>Google sign-in</b> — shown with an explanation on the sign-in screen, not enabled.</span></li>
          <li>${icon('alert')}<span><b>Map tiles and routing</b> — distances are straight-line estimates multiplied by a road factor, stated in the UI.</span></li>
          <li>${icon('alert')}<span><b>Payout transfers</b> — earnings and requests are recorded; no money moves automatically.</span></li>
          <li>${icon('alert')}<span><b>Real photography per SKU</b> — seeded products use labelled emoji tiles where no photo exists.</span></li>
        </ul>
        <div class="section-head__actions mt-3">
          <a class="btn btn--primary" href="/demo/">Try the demo accounts ${icon('arrow', 'ic--arrow')}</a>
          <a class="btn btn--ghost" href="/how-it-works/">How the platform works</a>
        </div>
      </div>
    </section>

    <script>
      (function () {
        var KEY = 'nearbuy.checklist.v1';
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.rl-item input'));
        var state = {};
        try { state = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { state = {}; }
        function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
        function update() {
          var done = boxes.filter(function (b) { return b.checked; }).length;
          document.getElementById('rlDone').textContent = done;
          document.getElementById('rlFill').style.width = (done / boxes.length) * 100 + '%';
          ${CHECKLIST.map((g) => `var k_${g.key.replace(/[^a-z]/gi, '')} = boxes.filter(function (b) { return b.id.indexOf('rl-${g.key}-') === 0 && b.checked; }).length;
          var el_${g.key.replace(/[^a-z]/gi, '')} = document.querySelector('[data-count-for="${g.key}"]');
          if (el_${g.key.replace(/[^a-z]/gi, '')}) el_${g.key.replace(/[^a-z]/gi, '')}.textContent = k_${g.key.replace(/[^a-z]/gi, '')} + ' / ${g.items.length} reviewed';`).join('\n          ')}
        }
        boxes.forEach(function (b) {
          b.checked = !!state[b.id];
          b.addEventListener('change', function () { state[b.id] = b.checked; save(); update(); });
        });
        var reset = document.getElementById('rlReset');
        if (reset) reset.addEventListener('click', function () {
          state = {};
          boxes.forEach(function (b) { b.checked = false; });
          save(); update();
        });
        update();
      })();
    </script>
`;
page({
  file: 'checklist/index.html',
  title: `Feature checklist — all ${totalItems} NearBuy capabilities`,
  description: `The ${totalItems}-item NearBuy capability checklist across five areas, plus an honest list of the provider integrations this deployment does not have.`,
  active: 'about',
  body: checklistBody
});


/* ------------------------------------------------------------- sitemap.xml -- */
const SITEMAP_PAGES = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
  { path: '/shops/', priority: '0.9', changefreq: 'daily' },
  { path: '/categories/', priority: '0.8', changefreq: 'weekly' },
  { path: '/offers/', priority: '0.8', changefreq: 'daily' },
  { path: '/how-it-works/', priority: '0.8', changefreq: 'monthly' },
  { path: '/sell/', priority: '0.8', changefreq: 'monthly' },
  { path: '/deliver/', priority: '0.7', changefreq: 'monthly' },
  { path: '/about/', priority: '0.6', changefreq: 'monthly' },
  { path: '/help/', priority: '0.7', changefreq: 'monthly' },
  { path: '/contact/', priority: '0.6', changefreq: 'monthly' },
  { path: '/policies/', priority: '0.4', changefreq: 'yearly' },
  { path: '/checklist/', priority: '0.5', changefreq: 'monthly' }
];
const today = new Date().toISOString().slice(0, 10);
writeFileSync(join(ROOT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${SITEMAP_PAGES.map((p) => `  <url>
    <loc>https://nearbuy.in${p.path}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n')}
</urlset>
`);
writeFileSync(join(ROOT, 'robots.txt'), `# NearBuy — public website
User-agent: *
Allow: /
Disallow: /admin/
Disallow: /seller/
Disallow: /runner/
Disallow: /customer/
Disallow: /api/

Sitemap: https://nearbuy.in/sitemap.xml
`);

process.stdout.write(`checklist items: ${totalItems}\n`);

