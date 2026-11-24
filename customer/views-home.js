/* Homepage and category discovery. */
(function () {
  'use strict';
  const NB = window.NB;

  const catTile = (c, big) => `<a class="cat-tile ${big ? 'cat-tile--big' : ''} tone-${c.tone}" href="#/categories/${encodeURIComponent(c.slug)}">
    <span class="cat-tile__ic">${NB.icon(NB.categoryIcon(c.slug))}</span>
    <span class="cat-tile__text"><b>${NB.esc(c.name)}</b><small>${c.productCount} products · ${c.shopCount} shops</small></span>
  </a>`;

  const trustStrip = () => `
    <section class="trust-strip"><div class="wrap trust-strip__grid">
      <div class="trust-item">${NB.icon('verified')}<div><b>Verified local shops</b><span>Every seller is reviewed before going live.</span></div></div>
      <div class="trust-item">${NB.icon('package')}<div><b>Live stock &amp; prices</b><span>Straight from the shop’s own catalogue.</span></div></div>
      <div class="trust-item">${NB.icon('shield')}<div><b>OTP-secured delivery</b><span>Hand over only with your one-time code.</span></div></div>
      <div class="trust-item">${NB.icon('returnArrow')}<div><b>Simple returns</b><span>Clear return windows on eligible items.</span></div></div>
    </div></section>`;

  const howItWorks = (steps) => `
    <section class="section how-section">
      <div class="wrap">
        <div class="section-head"><div><span class="eyebrow">How NearBuy works</span><h2>From your street to your doorstep</h2><p>Six simple steps, with a real status update at every one.</p></div></div>
        <ol class="steps">
          ${(steps || []).map((s, i) => `<li class="step"><span class="step__num">${String(i + 1).padStart(2, '0')}</span>
            <div class="step__ic">${NB.icon(['location', 'search', 'tag', 'cart', 'truck', 'checkCircle'][i] || 'check')}</div>
            <b>${NB.esc(s.title)}</b><p>${NB.esc(s.body)}</p></li>`).join('')}
        </ol>
      </div>
    </section>`;

  const localBand = (stats = {}) => `
    <section class="local-band">
      <div class="wrap local-band__inner">
        <div class="local-band__copy">
          <span class="eyebrow eyebrow--light">Shop local. Grow local.</span>
          <h2>Every order keeps a neighbourhood business going.</h2>
          <p>NearBuy gives local shopkeepers a digital shopfront, live inventory and delivery tools — without taking their identity away. When you buy nearby, more of every rupee stays on your street.</p>
          <div class="local-band__actions">
            
            <a class="btn btn--outline-light" href="#/page/about">Why local matters</a>
          </div>
        </div>
        <div class="local-band__stats">
          <div><b>${stats.shops || 0}</b><span>neighbourhood shops</span></div>
          <div><b>${stats.products || 0}</b><span>live listings</span></div>
          <div><b>${stats.categories || 0}</b><span>categories</span></div>
          <div><b>${stats.localities || 0}</b><span>serviceable localities</span></div>
        </div>
      </div>
    </section>`;

  NB.view(/^\/$/, async (m, query) => {
    const data = await NB.api(`/home?${NB.locationQuery()}`);
    const hero = data.banners[0];
    const location = data.location;
    const user = NB.state.user;
    const first = user ? user.name.split(' ')[0] : null;
    const avgRating = data.shops.length
      ? (data.shops.reduce((sum, shop) => sum + Number(shop.rating || 0), 0) / data.shops.length).toFixed(1)
      : null;

    const html = `
      ${!NB.state.location ? `<div class="location-banner"><div class="wrap location-banner__inner">
        <span class="location-banner__ic">${NB.icon('location')}</span>
        <div><b>Where should we deliver?</b><span>Pick your locality or pincode to see shops that serve you.</span></div>
        <form class="location-banner__form" id="quickLoc"><input name="pin" inputmode="numeric" maxlength="6" placeholder="Enter 6-digit pincode" aria-label="Pincode"/><button class="btn btn--primary btn--sm" type="submit">Check</button><button class="btn btn--ghost btn--sm" type="button" id="pickLoc">Choose locality</button></form>
      </div></div>` : ''}
      <section class="hero">
        <div class="wrap hero__inner">
          <div class="hero__copy">
            <span class="eyebrow">${NB.esc(hero?.eyebrow || 'Your neighbourhood marketplace')}</span>
            <h1>${hero ? NB.esc(hero.title) : 'Shop Local. Support Local.'}</h1>
            <p>${hero ? NB.esc(hero.subtitle) : 'Discover the best deals from shops around you.'}</p>
            <div class="hero__actions">
              <a class="btn btn--primary btn--lg" href="#/shops">${NB.icon('bag')} Start shopping</a>
              <a class="btn btn--ghost btn--lg" href="#/shops">${NB.icon('store')} Explore nearby shops</a>
            </div>
            <div class="hero__assurance">
              <span>${NB.icon('checkCircle')} No app needed</span>
              <span>${NB.icon('checkCircle')} Live shop stock</span>
              <span>${NB.icon('checkCircle')} Delivery or pickup</span>
            </div>
            ${location ? `<div class="hero__location">${NB.icon('location')} Showing shops near <b>${NB.esc(location.locality || location.pincode)}</b>${first ? ` · Hi ${NB.esc(first)}!` : ''}</div>` : ''}
          </div>
          <div class="hero__visual">
            <div class="hero__photo"><img src="${NB.esc(hero?.imageUrl || '/public/assets/discover-local-market.jpg')}" alt="A local market street with fresh produce" fetchpriority="high" /></div>
            <div class="float-card float-card--delivery"><span class="float-card__ic">${NB.icon('truck')}</span><div><b>Delivery or pickup</b><small>Chosen per shop</small></div></div>
            <div class="float-card float-card--rating"><span class="float-card__ic float-card__ic--amber">${NB.icon('star')}</span><div><b>${avgRating ? `${avgRating} / 5` : 'Neighbour rated'}</b><small>${avgRating ? 'Average shop rating' : 'Verified sellers'}</small></div></div>
            <div class="float-card float-card--shops"><span class="float-card__ic float-card__ic--green">${NB.icon('store')}</span><div><b>${data.stats.shops} local shops</b><small>${data.stats.products} products nearby</small></div></div>
          </div>
        </div>
        <div class="wrap hero__stats">
          <div><b>${data.stats.shops}</b><span>Neighbourhood shops</span></div>
          <div><b>${data.stats.products}</b><span>Live products</span></div>
          <div><b>${data.stats.categories}</b><span>Categories</span></div>
          <div><b>${data.stats.localities}</b><span>Serviceable localities</span></div>
        </div>
      </section>

      <section class="section section--categories">
        <div class="wrap">
          <div class="section-head"><div><span class="eyebrow">Shop by category</span><h2>Everything your street sells</h2><p>From the morning’s milk to the notebook you forgot — all nearby.</p></div>
            <a class="link-arrow" href="#/categories">All categories ${NB.icon('arrowRight')}</a></div>
          <div class="cat-grid">${data.categories.slice(0, 7).map((c) => catTile(c)).join('')}
            <a class="cat-tile cat-tile--all" href="#/categories"><span class="cat-tile__ic">${NB.icon('grid')}</span><span class="cat-tile__text"><b>View all</b><small>${data.categories.length} categories nearby</small></span>${NB.icon('arrowRight')}</a></div>
        </div>
      </section>

      <section class="section section--soft">
        <div class="wrap">
          <div class="section-head"><div><span class="eyebrow">Nearby shops</span><h2>${location ? `Shops delivering to ${NB.esc(location.locality || location.pincode)}` : 'Shops in your neighbourhood'}</h2><p>Real shops, real stock and today’s prices.</p></div>
            <a class="link-arrow" href="#/shops">View all shops ${NB.icon('arrowRight')}</a></div>
          ${data.shops.length ? `<div class="shop-grid">${data.shops.slice(0, 6).map(NB.shopCard).join('')}</div>` : NB.empty({ icon: 'store', title: 'No shops in this area yet', body: 'Try a nearby locality such as Hauz Khas (110016) or Saket (110017).', cta: '#/shops', ctaLabel: 'Browse all shops' })}
        </div>
      </section>

      ${data.offers.length ? `<section class="section">
        <div class="wrap">
          <div class="section-head"><div><span class="eyebrow">Today’s deals</span><h2>Offers worth the walk</h2><p>Only live, verified coupons — expired offers never appear here.</p></div>
            <a class="link-arrow" href="#/offers">All offers ${NB.icon('arrowRight')}</a></div>
          <div class="offer-grid">${data.offers.map(NB.offerCard).join('')}</div>
        </div>
      </section>` : ''}

      <section class="section section--soft">
        <div class="wrap">
          <div class="section-head"><div><span class="eyebrow">Recommended near you</span><h2>Popular right now</h2><p>Priced and stocked by the seller — never guessed by us.</p></div>
            <a class="link-arrow" href="#/products">Browse everything ${NB.icon('arrowRight')}</a></div>
          <div class="product-grid">${data.products.map((p) => NB.productCard(p)).join('')}</div>
        </div>
      </section>

      ${howItWorks(data.howItWorks)}
      ${trustStrip()}
      ${localBand(data.stats)}
      <section class="section">
        <div class="wrap">
          <div class="support-band">
            <div><span class="eyebrow">Need a hand?</span><h2>We’re here for the whole journey.</h2><p>Questions about a delivery, a refund or a shop? Help &amp; Support has answers and a real ticket trail.</p></div>
            <div class="support-band__actions">
              <a class="btn btn--primary" href="#/help">${NB.icon('headset')} Help &amp; support</a>
              <a class="btn btn--ghost" href="#/page/faq">Read the FAQs</a>
            </div>
          </div>
        </div>
      </section>`;

    return {
      title: 'Shop Local. Live Better',
      html,
      after(root) {
        const quick = NB.$('#quickLoc', root);
        if (quick) {
          quick.addEventListener('submit', async (e) => {
            e.preventDefault();
            const pin = quick.pin.value.trim();
            if (!/^\d{6}$/.test(pin)) { NB.toast('Enter a 6-digit pincode.', 'warn'); return; }
            try {
              const res = await NB.api(`/serviceability?pincode=${pin}`);
              if (!res.area || !res.serviceable) { NB.toast(res.message || 'We do not serve this pincode yet.', 'warn'); return; }
              NB.setLocation({ pincode: pin, locality: res.area.locality, city: res.area.city, lat: res.area.lat, lng: res.area.lng });
            } catch (err) { NB.toast(err.message, 'error'); }
          });
          const pick = NB.$('#pickLoc', root);
          if (pick) pick.addEventListener('click', () => NB.actions.location());
        }
      }
    };
  });

  NB.view(/^\/categories$/, async () => {
    const { categories } = await NB.api('/categories');
    const html = `
      <div class="page-hero page-hero--compact">
        <div class="wrap">
          <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<span>All categories</span></nav>
          <div class="page-hero__row"><div><span class="eyebrow">Browse the neighbourhood</span><h1>All categories</h1><p>${categories.length} everyday categories, stocked by local shops that deliver to you.</p></div>
            <div class="cat-search"><label class="sr-only" for="catFilter">Filter categories</label>${NB.icon('search')}<input id="catFilter" placeholder="Find a category…" /></div>
          </div>
        </div>
      </div>
      <section class="section"><div class="wrap">
        <div class="cat-grid cat-grid--all" id="catGrid">${categories.map((c) => catTile(c, true)).join('')}</div>
        <div class="empty" id="catEmpty" hidden><span class="empty__ic">${NB.icon('search')}</span><h3>No category matches</h3><p>Try “grocery”, “medicine” or “stationery”.</p></div>
      </div></section>
      <section class="section section--soft"><div class="wrap">
        <div class="section-head"><div><span class="eyebrow">Can’t find it?</span><h2>Search across every nearby shop</h2><p>One search covers product names, brands, shops and categories.</p></div></div>
        <form class="big-search" id="bigSearch">${NB.icon('search')}<input name="q" placeholder="Search for shops, products, groceries, medicines, stationery and more..." aria-label="Search products"/><button class="btn btn--primary" type="submit">Search</button></form>
      </div></section>`;
    return {
      title: 'All categories',
      html,
      after(root) {
        const input = NB.$('#catFilter', root);
        input.addEventListener('input', () => {
          const term = input.value.trim().toLowerCase();
          let shown = 0;
          NB.$$('.cat-tile', root).forEach((tile) => {
            const match = tile.textContent.toLowerCase().includes(term);
            tile.hidden = !match;
            if (match) shown += 1;
          });
          NB.$('#catEmpty', root).hidden = shown > 0;
        });
        NB.$('#bigSearch', root).addEventListener('submit', (e) => {
          e.preventDefault();
          const term = e.target.q.value.trim();
          if (term.length >= 2) NB.hash(`/search?q=${encodeURIComponent(term)}`);
        });
      }
    };
  });
})();
