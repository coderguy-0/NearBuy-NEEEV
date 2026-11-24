#!/usr/bin/env node
/*
 * tools/build-public-pages.mjs — emits the three static public pages that sit on
 * the homepage design system: /about/, /help/ and /roadmap/.
 *
 * They reuse home.css + home.js and the same icon sprite as index.html, so the
 * chrome, motion handling and reveal behaviour match the homepage exactly.
 *
 * Run:  node tools/build-public-pages.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/* Pull the icon sprite out of index.html so sub-pages share one source of truth. */
const indexHtml = readFileSync('index.html', 'utf8');
const spriteMatch = indexHtml.match(/<svg class="sprite"[\s\S]*?<\/svg>/);
if (!spriteMatch) throw new Error('could not locate the icon sprite in index.html');
const SPRITE = spriteMatch[0];

const MARK = `<img src="/public/assets/nearbuy-logo.png" width="42" height="42" alt="" decoding="async" />`;

function head(title, desc) {
  return `<meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#081428" />
  <meta name="description" content="${desc}" />
  <title>${title}</title>
  <link rel="icon" href="/public/assets/nearbuy-logo.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Manrope:wght@500;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/home.css" />
  <script>
    (function () {
      var d = document.documentElement;
      d.classList.add('js-ready');
      try {
        var pref = localStorage.getItem('nearbuy.motion');
        if (pref === 'reduced' || (!pref && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
          d.setAttribute('data-motion', 'reduced');
        }
      } catch (e) {}
      setTimeout(function () {
        if (!window.__nbHomeReady) d.classList.remove('js-ready');
      }, 2500);
    })();
  </script>`;
}

function nav(active) {
  const link = (href, label, key) =>
    `<a href="${href}"${key === active ? ' aria-current="page"' : ''}>${label}</a>`;
  return `  <header class="nav" id="nav">
    <div class="nav__inner">
      <a class="brand" href="/" aria-label="NearBuy home">
        <span class="brand__mark" aria-hidden="true">${MARK}</span>
        <span class="brand__word">Near<em>Buy</em></span>
      </a>
      <nav class="nav__links" aria-label="Primary">
        ${link('/', 'Home', 'home')}
        ${link('/portal.html#/shop/explore', 'Explore shops', 'explore')}
        ${link('/about/', 'About', 'about')}
        ${link('/roadmap/', 'Checklist', 'roadmap')}
        ${link('/help/', 'Help', 'help')}
        ${link('/help/#support', 'Contact', 'contact')}
      </nav>
      <div class="nav__actions">
        <a class="btn btn--ghost btn--sm nav__portal-btn" href="/portal.html">
          <svg class="ic"><use href="#i-layers"/></svg>
          NearBuy One
        </a>
        <a class="btn btn--primary btn--sm" href="/customer/login/">Sign in</a>
        <button class="nav__toggle" id="navToggle" aria-label="Open menu" aria-expanded="false" aria-controls="nav">
          <svg class="ic"><use href="#i-menu"/></svg>
        </button>
      </div>
    </div>
  </header>`;
}

function footer() {
  return `  <footer class="footer">
    <div class="wrap footer__inner">
      <div class="footer__brand">
        <a class="brand" href="/" aria-label="NearBuy home">
          <span class="brand__mark" aria-hidden="true">
            <img src="/public/assets/nearbuy-logo.png" width="48" height="48" alt="" loading="lazy" decoding="async" />
          </span>
          <span class="brand__word">Near<em>Buy</em></span>
        </a>
        <p class="footer__tagline">Your neighbourhood.<br />Everything you need.</p>
        <p class="footer__meta">Hauz Khas · New Delhi<br />hello@nearbuy.in</p>
        <div class="footer__social" role="group" aria-label="NearBuy channels">
          <a href="/help/#support" aria-label="Support"><svg class="ic"><use href="#i-mail"/></svg></a>
          <a href="/help/#support" aria-label="Call support"><svg class="ic"><use href="#i-phone"/></svg></a>
          <a href="/about/#trust" aria-label="Trust and safety"><svg class="ic"><use href="#i-shield"/></svg></a>
        </div>
      </div>
      <div class="footer__cols">
        <div>
          <h4>Explore</h4>
          <a href="/">Home</a>
          <a href="/portal.html#/shop/explore">Browse everything</a>
          <a href="/portal.html#/shop/shops">Nearby shops</a>
          <a href="/roadmap/">Feature checklist</a>
        </div>
        <div>
          <h4>Portals</h4>
          <a href="/customer/">Customer</a>
          <a href="/seller/">Seller</a>
          <a href="/runner/">Delivery partner</a>
          <a href="/portal.html">NearBuy One</a>
        </div>
        <div>
          <h4>Support</h4>
          <a href="/help/">Help centre</a>
          <a href="/portal.html#/shop/help">In-app help</a>
          <a href="/help/#support">Send an enquiry</a>
          <a href="/help/#faq">FAQs</a>
        </div>
        <div>
          <h4>Legal</h4>
          <a href="/about/#trust">Privacy policy</a>
          <a href="/about/#trust">Terms &amp; conditions</a>
          <a href="/about/#trust">Refund policy</a>
          <button class="footer__motion" id="motionToggle" type="button" aria-pressed="false">
            <span class="footer__motion-dot" aria-hidden="true"></span> <span id="motionLabel">Reduce motion</span>
          </button>
        </div>
      </div>
    </div>
    <div class="wrap footer__bottom">
      <span>© <span id="year">2026</span> NearBuy. All rights reserved.</span>
      <span class="footer__disclaimer">Prototype demo · sample data only · no real payments, dispatch or KYC.</span>
      <a href="/control-tower/" class="footer__admin">Operations console ↗</a>
    </div>
  </footer>`;
}

function shell(title, desc, active, body) {
  return `<!doctype html>
<html lang="en">
<head>
  ${head(title, desc)}
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  ${SPRITE}
${nav(active)}
  <main id="main">
${body}
  </main>
${footer()}
  <script src="/home.js"></script>
</body>
</html>
`;
}

/* --------------------------------- about ---------------------------------- */
const aboutBody = `    <section class="page-hero">
      <div class="wrap page-hero__inner">
        <span class="page-hero__crumb"><a href="/">Home</a> / About</span>
        <span class="eyebrow eyebrow--live">About NearBuy</span>
        <h1>Your neighbourhood, organised.</h1>
        <p>NearBuy connects the shops on your street with the people who live around them — and with the neighbours who deliver between the two. One shared data model sits behind a customer storefront, a seller hub, a delivery partner app, fleet coordination and an operations console.</p>
        <div class="page-hero__actions">
          <a class="btn btn--primary" href="/customer/">Open the storefront <svg class="ic ic--arrow"><use href="#i-arrow"/></svg></a>
          <a class="btn btn--ghost" href="/portal.html">See NearBuy One</a>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap split-2">
        <div class="prose" data-reveal>
          <span class="eyebrow">The idea</span>
          <h2>Commerce that stays on your street.</h2>
          <p>Marketplaces optimise for the cheapest seller anywhere. NearBuy optimises for the <strong>nearest</strong> seller: the grocer who knows your order, the bakery that sells out by ten, the stationer two lanes over. Distance is the feature, not a constraint.</p>
          <p>Every shop keeps its own catalogue, stock, timings and fulfilment preference. NearBuy adds the parts a single shop cannot afford alone — discovery, ordering, payments records, delivery coordination and a control tower for the network.</p>
          <p>Nothing here replaces the shopkeeper. It gives them a counter on the internet that behaves like the one they already run.</p>
        </div>
        <div class="stat-stack" data-reveal>
          <div><b>5</b><small>workspaces on one shared data model</small></div>
          <div><b>3</b><small>separate front doors with independent sign-in</small></div>
          <div><b>84</b><small>features tracked on the public checklist</small></div>
          <div><b>0</b><small>real payments, dispatch or KYC in this demo</small></div>
        </div>
      </div>
    </section>

    <section class="section section--cream">
      <div class="wrap">
        <div class="section__head" data-reveal>
          <span class="eyebrow">How it works</span>
          <h2>One order, several neighbours.</h2>
        </div>
        <div class="steps">
          <div class="step" data-reveal>
            <span class="step__num">1</span>
            <span class="step__icon"><svg class="ic"><use href="#i-search"/></svg></span>
            <h3>Discover</h3>
            <p>Pick your neighbourhood and see only the shops that can actually serve you, with distance, timings and what they sell.</p>
          </div>
          <div class="step" data-reveal>
            <span class="step__num">2</span>
            <span class="step__icon"><svg class="ic"><use href="#i-bag"/></svg></span>
            <h3>Order</h3>
            <p>Fill one basket across several shops, then choose home delivery or free pickup at checkout.</p>
          </div>
          <div class="step" data-reveal>
            <span class="step__num">3</span>
            <span class="step__icon"><svg class="ic"><use href="#i-truck"/></svg></span>
            <h3>Fulfil</h3>
            <p>The shop accepts and packs; a nearby partner picks up with a pickup PIN and delivers with proof of delivery.</p>
          </div>
          <div class="step" data-reveal>
            <span class="step__num">4</span>
            <span class="step__icon"><svg class="ic"><use href="#i-chart"/></svg></span>
            <h3>Settle</h3>
            <p>Delivery posts to a ledger, fees and GST are calculated per order, and the shop sees a settlement statement.</p>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <div class="section__head section__head--split" data-reveal>
          <div>
            <span class="eyebrow">One backend</span>
            <h2>Three front doors.</h2>
          </div>
          <p>Each portal signs in on its own and opens only its own tools. Landing on another portal shows that portal&rsquo;s sign-in — a customer session never unlocks seller, partner or operations screens.</p>
        </div>
        <div class="portal-grid">
          <article class="portal-card portal-card--customer" data-reveal style="--i:0">
            <div class="portal-card__art">
              <img src="/public/assets/portal-customer.jpg" width="760" height="1140" alt="3D illustration of a grocery bag, a phone and everyday essentials" loading="lazy" />
              <span class="portal-card__tag">For neighbours</span>
            </div>
            <div class="portal-card__body">
              <div class="portal-card__title">
                <span class="portal-card__icon"><svg class="ic"><use href="#i-bag"/></svg></span>
                <h3>Customer</h3>
              </div>
              <p>Shop from the shops you already love — and the ones you are about to.</p>
              <div class="portal-card__cta"><a class="btn btn--primary btn--sm" href="/customer/">Open <svg class="ic ic--arrow"><use href="#i-arrow"/></svg></a></div>
            </div>
          </article>
          <article class="portal-card portal-card--seller" data-reveal style="--i:1">
            <div class="portal-card__art">
              <img src="/public/assets/portal-seller.jpg" width="820" height="820" alt="3D illustration of a local shop with inventory boxes and a sales chart" loading="lazy" />
              <span class="portal-card__tag portal-card__tag--green">For shopkeepers</span>
            </div>
            <div class="portal-card__body">
              <div class="portal-card__title">
                <span class="portal-card__icon"><svg class="ic"><use href="#i-store"/></svg></span>
                <h3>Seller</h3>
              </div>
              <p>Run your shop: orders, catalogue, stock, payouts and growth in one hub.</p>
              <div class="portal-card__cta"><a class="btn btn--primary btn--sm" href="/seller/">Open <svg class="ic ic--arrow"><use href="#i-arrow"/></svg></a></div>
            </div>
          </article>
          <article class="portal-card portal-card--runner" data-reveal style="--i:2">
            <div class="portal-card__art">
              <img src="/public/assets/portal-runner.jpg" width="820" height="820" alt="3D illustration of a delivery scooter with an orange insulated parcel box and helmet" loading="lazy" />
              <span class="portal-card__tag portal-card__tag--blue">For couriers</span>
            </div>
            <div class="portal-card__body">
              <div class="portal-card__title">
                <span class="portal-card__icon"><svg class="ic"><use href="#i-truck"/></svg></span>
                <h3>Delivery partner</h3>
              </div>
              <p>Take nearby deliveries on your own terms — distance, categories and hours are yours.</p>
              <div class="portal-card__cta"><a class="btn btn--primary btn--sm" href="/runner/">Open <svg class="ic ic--arrow"><use href="#i-arrow"/></svg></a></div>
            </div>
          </article>
        </div>
      </div>
    </section>

    <section class="section section--paper" id="trust">
      <div class="wrap">
        <div class="section__head" data-reveal>
          <span class="eyebrow">Trust &amp; safety</span>
          <h2>The rules we hold ourselves to.</h2>
        </div>
        <div class="trust__grid">
          <div class="trust-item" data-reveal><span class="portal-card__icon"><svg class="ic"><use href="#i-lock"/></svg></span><h3>Sessions stay put</h3><p>Each portal keeps its own session in the current tab and clears it on sign-out, so one login never opens another workspace.</p></div>
          <div class="trust-item" data-reveal><span class="portal-card__icon"><svg class="ic"><use href="#i-shield"/></svg></span><h3>Verification, not buttons</h3><p>Age gates, document checks and pickup PINs are modelled as real steps — the demo simulates them rather than skipping them.</p></div>
          <div class="trust-item" data-reveal><span class="portal-card__icon"><svg class="ic"><use href="#i-inbox"/></svg></span><h3>Nothing leaves your browser</h3><p>Enquiries, orders and applications in this prototype are stored locally and labelled DEMO DATA. No email is sent and no one is paged.</p></div>
          <div class="trust-item" data-reveal><span class="portal-card__icon"><svg class="ic"><use href="#i-check"/></svg></span><h3>Humans decide</h3><p>Approvals, refunds and sensitive actions are described as staff decisions with reason codes and appeals — automation must never make irreversible calls.</p></div>
        </div>
        <p class="trust__note" data-reveal><strong>Prototype notice.</strong> This is a simulated demo. Checkout charges nothing, no shop is contacted, no runner is dispatched, no OTP is sent, no application is really verified, no payout or bank account exists, and no personal or sensitive information should be entered. Maps, distances and pricing are schematic.</p>
      </div>
    </section>`;

/* ---------------------------------- help ----------------------------------- */
const FAQS = [
  ['What is NearBuy?', 'NearBuy is a neighbourhood commerce platform that connects customers with local shops and short-distance delivery partners. It brings nearby stores, everyday products and Runner delivery together in one place.'],
  ['How do I find shops that deliver to me?', 'Open the customer storefront and choose your neighbourhood. Only shops that are serviceable to your address are shown, with distance, opening hours and what they sell.'],
  ['Can I order from more than one shop at once?', 'Yes. Your basket holds items from several shops and splits into one order per shop at checkout, each with its own fulfilment method and tracking.'],
  ['How do I register my shop?', 'Use the seller registration route to work through a seven-step application: account, business, store details, location, operations, payout and review. In this demo verification is simulated and you can explore the Seller Hub immediately.'],
  ['How do I become a delivery partner?', 'Start the partner application, pass the 18+ age gate, add documents and an emergency contact, read the safety briefing, then go online. You control your distance, parcel categories and availability at any time.'],
  ['What does delivery cost?', 'Delivery fees follow the pricing bands set for your service area and are shown before you confirm. Shops may offer free delivery above a basket value — the storefront labels those offers.'],
  ['How do refunds and returns work?', 'Raise an issue on an order from your account. The shop reviews it, can restock items and issue a refund; the ledger and settlement statement reflect the adjustment.'],
  ['Is my data shared between portals?', 'No. Customer, seller, partner, fleet and operations sessions are separate and isolated. Signing in to one portal never grants access to another.'],
];

const helpBody = `    <section class="page-hero">
      <div class="wrap page-hero__inner">
        <span class="page-hero__crumb"><a href="/">Home</a> / Help</span>
        <span class="eyebrow eyebrow--live">Help centre</span>
        <h1>Help &amp; Support.</h1>
        <p>Quick routes into every support surface, the questions people ask most, and a direct line to the team. In the product, each workspace also carries its own help: the storefront, the Seller Hub and the partner app all have a help centre with context-specific answers.</p>
        <div class="page-hero__actions">
          <a class="btn btn--primary" href="#support">Send an enquiry <svg class="ic ic--arrow"><use href="#i-arrow"/></svg></a>
          <a class="btn btn--ghost" href="/portal.html#/shop/help">Open in-app help</a>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <div class="section__head" data-reveal>
          <span class="eyebrow">Quick links</span>
          <h2>Jump straight to the right place.</h2>
        </div>
        <div class="help-links">
          <a class="help-link" href="/portal.html#/shop/orders" data-reveal><svg class="ic"><use href="#i-box"/></svg><b>Track an order</b><small>Live status, courier and proof of delivery for every order you have placed.</small></a>
          <a class="help-link" href="/portal.html#/sell/support" data-reveal><svg class="ic"><use href="#i-store"/></svg><b>Seller support</b><small>Tickets, FAQs and the seller academy for running your shop.</small></a>
          <a class="help-link" href="/portal.html#/deliver/safety" data-reveal><svg class="ic"><use href="#i-shield"/></svg><b>Partner safety</b><small>Safety centre, incident reporting and operational limits for couriers.</small></a>
          <a class="help-link" href="#support" data-reveal><svg class="ic"><use href="#i-mail"/></svg><b>Report an issue</b><small>Send the team a query — four fields, reviewed in this demo the same day.</small></a>
        </div>
      </div>
    </section>

    <section class="section section--cream" id="faq">
      <div class="wrap faq-wrap">
        <div class="faq-head" data-reveal>
          <span class="eyebrow eyebrow--dark">Questions</span>
          <h2>Eight things people ask.</h2>
          <p>Need more? The in-app help centre goes deeper per workspace, or send us a question below.</p>
        </div>
        <div class="faq" data-reveal>
${FAQS.map(
  ([q, a], i) =>
    `          <details class="faq__item" name="helpfaq"${i === 0 ? ' open' : ''}>\n            <summary>${q}<span class="faq__plus" aria-hidden="true"></span></summary>\n            <p>${a}</p>\n          </details>`
).join('\n')}
        </div>
      </div>
    </section>

    <section class="section" id="support">
      <div class="wrap">
        <div class="section__head section__head--split" data-reveal>
          <div>
            <span class="eyebrow">Support routes</span>
            <h2>Every way to reach us.</h2>
          </div>
          <p>The enquiry form lives on the homepage so it is always one tap from the front door. Queries land in the operations console under <strong>Enquiries</strong>; in this prototype they are stored in your browser only.</p>
        </div>
        <div class="help-links">
          <a class="help-link" href="/#support" data-reveal><svg class="ic"><use href="#i-mail"/></svg><b>Enquiry form</b><small>Name, contact, topic and message — the fastest way to reach the team.</small></a>
          <a class="help-link" href="/portal.html#/shop/help" data-reveal><svg class="ic"><use href="#i-bag"/></svg><b>Storefront help</b><small>Order, refund and delivery answers in the customer workspace.</small></a>
          <a class="help-link" href="/portal.html#/ops/enquiries" data-reveal><svg class="ic"><use href="#i-inbox"/></svg><b>Operations inbox</b><small>Where submitted enquiries are triaged by staff (access code required).</small></a>
          <a class="help-link" href="/about/#trust" data-reveal><svg class="ic"><use href="#i-lock"/></svg><b>Trust &amp; privacy</b><small>How sessions, demo data and verification are handled in this prototype.</small></a>
        </div>
      </div>
    </section>`;

/* --------------------------------- roadmap --------------------------------- */
const CHECKLIST = [
  [
    'Customer storefront',
    'shop',
    [
      'Discover shops serviceable to your neighbourhood',
      'Browse the full catalogue with category filters',
      'Search products across every nearby shop',
      'Product detail with price, stock and shop info',
      'Save items to a wishlist',
      'One basket across several shops',
      'Quantity steppers with live line totals',
      'Choose home delivery or store pickup per shop',
      'Checkout with address and slot selection',
      'Order confirmation with a reference code',
      'Track order status through the lifecycle',
      'Cancel an order before the shop accepts',
      'Order history with invoices',
      'Reorder from a past order',
      'Account profile and saved addresses',
      'Saved payment preferences (demo)',
      'Help centre with FAQs and order help',
      'Report an issue on an order',
    ],
  ],
  [
    'Seller hub',
    'sell',
    [
      'Role-based seller sign-in',
      'Seven-step seller registration wizard',
      'Overview dashboard with KPIs',
      'Order queue with accept and dispatch flow',
      'Catalogue with categories, variants and images',
      'Draft, submit and automated quality check',
      'Bulk CSV catalogue upload',
      'Per-SKU inventory with reservations',
      'Low-stock thresholds and alerts',
      'Stock movement history and warehouses',
      'Delivery preparation with pickup PIN handover',
      'Returns review, restock and refund',
      'Payments ledger with fees and GST',
      'Settlement statements with PDF and CSV export',
      'Promotions with calculated price previews',
      'Advertising campaign records',
      'Business insights with CSV exports',
      'Manage profile: business, locations and bank',
      'Team and access with five enforced roles',
      'Seller support tickets and academy',
    ],
  ],
  [
    'Delivery partner',
    'deliver',
    [
      'Partner registration with an 18+ age gate',
      'Document checks with masking',
      'Emergency contact and safety briefing',
      'Go online and offline at will',
      'Delivery offers with distance and payout',
      'Accept or decline offers',
      'Active delivery with pickup and drop steps',
      'Pickup PIN verification at the shop',
      'Proof of delivery capture',
      'Delivery history',
      'Earnings summary and breakdown',
      'Preferences: radius, categories, availability',
      'Safety centre with incident reporting',
      'Partner help and support',
      'Operational limits for distance, weight and hours',
      'Status updates that tolerate a dropped connection (demo)',
    ],
  ],
  [
    'Fleet coordination',
    'fleet',
    [
      'Fleet overview with a live roster',
      'Delivery team management',
      'Work allocation across partners',
      'Shift and availability planning',
      'Performance reports',
      'Account and safety settings',
      'Zone coverage per fleet',
      'Escalation of unassigned tasks',
      'Onboarding partners into the fleet',
      'Per-partner payout summary (demo)',
      'Incident review within the fleet',
      'Fleet-level support route',
    ],
  ],
  [
    'Operations, trust & platform',
    'ops',
    [
      'Operations gate behind an access code',
      'Live overview of the neighbourhood network',
      'Verifications queue for seller and partner applications',
      'Profile change approvals',
      'Enquiries inbox fed by the homepage form',
      'Dispatch board for delivery tasks',
      'Partner directory and status',
      'Service areas and zones',
      'Pricing bands configuration',
      'Safety and incidents register',
      'Audit log of staff actions',
      'One shared data model behind five workspaces',
      'Per-portal sign-in with isolated sessions',
      'Reduced-motion support across the site',
      'Responsive layouts down to small phones',
      'Keyboard and shortcut support',
      'Demo data labelling and reset',
      'Prototype disclaimer surfaced on every portal',
    ],
  ],
];

const roadmapItems = CHECKLIST.map(
  ([title, key, items], si) => `    <section class="section${si % 2 ? ' section--cream' : ''}" id="sec-${key}">
      <div class="wrap">
        <div class="section__head section__head--split">
          <div>
            <span class="eyebrow">Section ${si + 1} of ${CHECKLIST.length}</span>
            <h2>${title}</h2>
          </div>
          <p class="rl-count" data-count-for="${key}">0 / ${items.length} reviewed</p>
        </div>
        <ul class="rl-list">
${items
  .map(
    (label, ii) =>
      `          <li class="rl-item"><label><input type="checkbox" id="rl-${key}-${ii}" /> <span>${label}</span></label></li>`
  )
  .join('\n')}
        </ul>
      </div>
    </section>`
).join('\n');

const totalItems = CHECKLIST.reduce((n, [, , items]) => n + items.length, 0);

const roadmapBody = `    <section class="page-hero">
      <div class="wrap page-hero__inner">
        <span class="page-hero__crumb"><a href="/">Home</a> / Feature checklist</span>
        <span class="eyebrow eyebrow--live">Planning aid</span>
        <h1>The ${totalItems}-item feature checklist.</h1>
        <p>The NearBuy blueprint, split into five reviewable sections. Every item starts unchecked; your selections persist in this browser only and can be reset at any time. This is a manual review aid — not a live implementation status or a production-readiness tracker.</p>
        <div class="page-hero__actions">
          <button class="btn btn--primary" id="rlReset" type="button">Reset selections</button>
          <a class="btn btn--ghost" href="/about/">About the platform</a>
        </div>
      </div>
    </section>

    <div class="rl-bar" role="status" aria-live="polite">
      <div class="wrap rl-bar__inner">
        <span><b id="rlDone">0</b> of ${totalItems} reviewed</span>
        <span class="rl-track" aria-hidden="true"><span class="rl-fill" id="rlFill"></span></span>
      </div>
    </div>

${roadmapItems}

    <style>
      .rl-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      @media (max-width: 720px) { .rl-list { grid-template-columns: 1fr; } }
      .rl-item label {
        display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px; cursor: pointer;
        background: var(--paper); border: 1px solid var(--line-soft); border-radius: 14px;
        font-size: 13.5px; line-height: 1.5; color: var(--text);
        transition: border-color .2s var(--ease), background .2s var(--ease);
      }
      .rl-item label:hover { border-color: #e5d8c4; }
      .rl-item input { margin: 2px 0 0; width: 16px; height: 16px; accent-color: var(--orange); flex: none; }
      .rl-item input:checked + span { color: var(--muted); text-decoration: line-through; text-decoration-color: rgba(244,119,24,.5); }
      .rl-count { font: 700 13px/1 var(--display); color: var(--orange-deep); }
      .rl-bar { position: sticky; top: 0; z-index: 40; background: rgba(8,20,40,.94); backdrop-filter: blur(8px); color: var(--on-dark); }
      .rl-bar__inner { display: flex; align-items: center; gap: 16px; padding: 10px 0; font-size: 12.5px; }
      .rl-track { flex: 1; height: 6px; border-radius: 6px; background: rgba(255,255,255,.14); overflow: hidden; }
      .rl-fill { display: block; height: 100%; width: 0%; border-radius: 6px; background: linear-gradient(90deg, #ff9a3d, #f47718); transition: width .3s var(--ease); }
    </style>
    <script>
      (function () {
        var KEY = 'nearbuy.roadmap.v1';
        var boxes = Array.prototype.slice.call(document.querySelectorAll('.rl-item input'));
        var state = {};
        try { state = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { state = {}; }
        function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
        function update() {
          var done = boxes.filter(function (b) { return b.checked; }).length;
          document.getElementById('rlDone').textContent = done;
          document.getElementById('rlFill').style.width = (done / boxes.length) * 100 + '%';
          ${CHECKLIST.map(
            ([, key, items]) =>
              `var k_${key} = boxes.filter(function (b) { return b.id.indexOf('rl-${key}-') === 0 && b.checked; }).length;
          var el_${key} = document.querySelector('[data-count-for="${key}"]');
          if (el_${key}) el_${key}.textContent = k_${key} + ' / ${items.length} reviewed';`
          ).join('\n          ')}
        }
        boxes.forEach(function (b) {
          b.checked = !!state[b.id];
          b.addEventListener('change', function () { state[b.id] = b.checked; save(); update(); });
        });
        document.getElementById('rlReset').addEventListener('click', function () {
          state = {};
          boxes.forEach(function (b) { b.checked = false; });
          save(); update();
        });
        update();
      })();
    </script>`;

/* ---------------------------------- emit ----------------------------------- */
const PAGES = [
  {
    file: 'about/index.html',
    title: 'About NearBuy — the neighbourhood model',
    desc: 'What NearBuy is, how the neighbourhood model works, the three portals on one backend, and the trust and prototype rules we hold ourselves to.',
    active: 'about',
    body: aboutBody
  },
  {
    file: 'help/index.html',
    title: 'Help & Support — NearBuy',
    desc: 'Quick routes into every NearBuy support surface, the eight most-asked questions, and the enquiry form for reaching the team.',
    active: 'help',
    body: helpBody
  },
  {
    file: 'roadmap/index.html',
    title: `Feature checklist — NearBuy`,
    desc: `The ${totalItems}-item NearBuy blueprint as five reviewable sections. Selections persist in this browser only.`,
    active: 'roadmap',
    body: roadmapBody
  }
];

for (const p of PAGES) {
  mkdirSync(dirname(p.file), { recursive: true });
  writeFileSync(p.file, shell(p.title, p.desc, p.active, p.body));
  process.stdout.write(`wrote ${p.file}\n`);
}
process.stdout.write(`checklist items: ${totalItems}\n`);
