/* Shops, catalogues and product detail with price comparison. */
(function () {
  'use strict';
  const NB = window.NB;

  /* ------------------------------------------------------------------ */
  /* Nearby shops                                                        */
  /* ------------------------------------------------------------------ */
  NB.view(/^\/shops$/, async (m, query) => {
    const state = {
      q: query.get('q') || '',
      category: query.get('category') || '',
      sort: query.get('sort') || 'distance',
      open: query.get('open') === '1',
      delivery: query.get('delivery') === '1',
      pickup: query.get('pickup') === '1',
      verified: query.get('verified') === '1',
      minRating: query.get('minRating') || '',
      all: query.get('all') === '1',
      view: query.get('view') === 'map' ? 'map' : 'list',
      page: 1
    };
    const categories = NB.state.categories;
    const location = NB.state.location;
    const html = `
      <div class="page-hero">
        <div class="wrap">
          <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<span>Nearby shops</span></nav>
          <div class="page-hero__row">
            <div><span class="eyebrow">Nearby shops</span><h1>${location ? `Shops serving ${NB.esc(location.locality || location.pincode)}` : 'Discover shops around you'}</h1>
              <p>${location ? 'Distances are estimated from your selected locality.' : 'Set your location to see only the shops that actually serve your area.'}</p></div>
            <button class="btn btn--outline" data-action="location">${NB.icon('location')} ${location ? 'Change location' : 'Set location'}</button>
          </div>
        </div>
      </div>
      <div class="wrap shop-page">
        <aside class="filters" aria-label="Shop filters">
          <div class="filters__head"><b>${NB.icon('filter')} Filters</b><button class="link-btn" id="clearShopFilters">Clear all</button></div>
          <form id="shopFilterForm">
            <div class="field"><label for="shopQ">Search shops</label><div class="input-icon">${NB.icon('search')}<input id="shopQ" name="q" value="${NB.esc(state.q)}" placeholder="Shop name or locality"/></div></div>
            <div class="field"><label for="shopCat">Category</label><select id="shopCat" name="category"><option value="">All categories</option>${categories.map((c) => `<option value="${c.slug}" ${state.category === c.slug ? 'selected' : ''}>${NB.esc(c.name)}</option>`).join('')}</select></div>
            <div class="field"><label>Availability</label>
              <label class="check"><input type="checkbox" name="open" ${state.open ? 'checked' : ''}/><span>Open now</span></label>
              <label class="check"><input type="checkbox" name="delivery" ${state.delivery ? 'checked' : ''}/><span>Home delivery</span></label>
              <label class="check"><input type="checkbox" name="pickup" ${state.pickup ? 'checked' : ''}/><span>Store pickup</span></label>
              <label class="check"><input type="checkbox" name="verified" ${state.verified ? 'checked' : ''}/><span>Verified shops only</span></label>
              <label class="check"><input type="checkbox" name="all" ${state.all ? 'checked' : ''}/><span>Include shops outside my area</span></label>
            </div>
            <div class="field"><label for="shopRating">Minimum rating</label><select id="shopRating" name="minRating"><option value="">Any rating</option>${[4.5, 4, 3.5, 3].map((r) => `<option value="${r}" ${String(r) === state.minRating ? 'selected' : ''}>${r}★ and above</option>`).join('')}</select></div>
            <button class="btn btn--primary btn--block" type="submit">Apply filters</button>
          </form>
          <div class="filters__note">${NB.icon('info')} Distances are straight-line, from your saved location. Open the <b>Map</b> view to see every shop to scale with its phone number and owner.</div>
        </aside>
        <div class="shop-results">
          <div class="results-bar">
            <div class="results-count" id="shopCount">Finding shops…</div>
            <div class="results-tools">
              <button class="btn btn--ghost btn--sm filters-mobile-toggle" id="shopFiltersToggle" type="button">${NB.icon('filter')} Filters</button>
              <div class="segmented" role="group" aria-label="View">
                <button class="segmented__btn ${state.view === 'list' ? 'is-active' : ''}" data-view="list">${NB.icon('list')} List</button>
                <button class="segmented__btn ${state.view === 'map' ? 'is-active' : ''}" data-view="map">${NB.icon('map')} Map</button>
              </div>
              <label class="sort-select"><span>Sort</span><select id="shopSort">
                ${[['distance', 'Nearest first'], ['rating', 'Highest rated'], ['prep', 'Fastest prep'], ['name', 'A–Z']].map(([v, l]) => `<option value="${v}" ${state.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select></label>
            </div>
          </div>
          <div id="shopResults" class="shop-grid shop-grid--results">${NB.skeleton('home')}</div>
          <div id="shopMap" class="shop-map" hidden></div>
          <div id="shopPager" class="pager"></div>
        </div>
      </div>`;

    return {
      title: 'Nearby shops',
      html,
      after(root) {
        const results = NB.$('#shopResults', root);
        const map = NB.$('#shopMap', root);
        const count = NB.$('#shopCount', root);
        const pager = NB.$('#shopPager', root);
        let data = null;

        async function load() {
          results.innerHTML = `<div class="skl-grid skl-grid--3">${Array.from({ length: 6 }).map(() => `<div class="skl-card"><div class="skl skl--photo-sm"></div><div class="skl skl--line"></div><div class="skl skl--line skl--short"></div></div>`).join('')}</div>`;
          const params = {
            q: state.q, category: state.category, sort: state.sort,
            open: state.open ? '1' : '', delivery: state.delivery ? '1' : '', pickup: state.pickup ? '1' : '',
            verified: state.verified ? '1' : '', minRating: state.minRating, all: state.all ? '1' : '',
            page: state.page, limit: 12
          };
          try {
            data = await NB.api(`/shops?${NB.qs(params)}&${NB.locationQuery()}`);
            count.innerHTML = `<b>${data.total}</b> ${data.total === 1 ? 'shop' : 'shops'}${state.q ? ` for “${NB.esc(state.q)}”` : ''}`;
            if (!data.shops.length) {
              results.innerHTML = NB.empty({ icon: 'store', title: 'No shops match these filters', body: 'Try clearing a filter or including shops outside your area.', cta: '#/shops', ctaLabel: 'Reset filters' });
              map.hidden = true; results.hidden = false; pager.innerHTML = '';
              return;
            }
            results.innerHTML = data.shops.map(NB.shopCard).join('');
            /* Decide which pane is visible *before* building the map: the projection
             * measures the canvas, and a display:none element reports zero size. */
            results.hidden = state.view === 'map';
            map.hidden = state.view !== 'map';
            renderMap(data.shops);
            pager.innerHTML = data.pages > 1 ? `<button class="btn btn--ghost btn--sm" id="prevPage" ${state.page <= 1 ? 'disabled' : ''}>${NB.icon('arrowLeft')} Previous</button><span>Page ${data.page} of ${data.pages}</span><button class="btn btn--ghost btn--sm" id="nextPage" ${state.page >= data.pages ? 'disabled' : ''}>Next ${NB.icon('arrowRight')}</button>` : '';
            const prev = NB.$('#prevPage', pager); const next = NB.$('#nextPage', pager);
            if (prev) prev.addEventListener('click', () => { state.page -= 1; load(); });
            if (next) next.addEventListener('click', () => { state.page += 1; load(); });
          } catch (err) {
            results.innerHTML = NB.errorView(err);
            const retry = NB.$('#retryView', results); if (retry) retry.addEventListener('click', load);
          }
        }

        let mapCtl = null;
        function renderMap(shops) {
          map.innerHTML = NB.shopMap(shops, {
            title: 'Shops near you',
            subtitle: NB.state.location
              ? `From ${NB.state.location.locality || NB.state.location.pincode} · to scale`
              : 'Set your location to see distances'
          });
          mapCtl = NB.wireShopMap(map, shops);
        }

        function syncForm() {
          state.q = NB.$('#shopQ', root).value.trim();
          state.category = NB.$('#shopCat', root).value;
          state.minRating = NB.$('#shopRating', root).value;
          state.open = NB.$('input[name="open"]', root).checked;
          state.delivery = NB.$('input[name="delivery"]', root).checked;
          state.pickup = NB.$('input[name="pickup"]', root).checked;
          state.verified = NB.$('input[name="verified"]', root).checked;
          state.all = NB.$('input[name="all"]', root).checked;
          state.page = 1;
        }

        NB.$('#shopFiltersToggle', root)?.addEventListener('click', () => NB.$('.filters', root)?.classList.toggle('is-open'));
        NB.$('#shopFilterForm', root).addEventListener('submit', (e) => { e.preventDefault(); syncForm(); load(); });
        NB.$('#shopSort', root).addEventListener('change', (e) => { state.sort = e.target.value; state.page = 1; load(); });
        NB.$('#shopQ', root).addEventListener('input', NB.debounce(() => { syncForm(); load(); }, 350));
        NB.$('#clearShopFilters', root).addEventListener('click', () => {
          Object.assign(state, { q: '', category: '', open: false, delivery: false, pickup: false, verified: false, minRating: '', all: false, page: 1 });
          NB.$('#shopQ', root).value = ''; NB.$('#shopCat', root).value = ''; NB.$('#shopRating', root).value = '';
          NB.$$('input[type="checkbox"]', root).forEach((c) => { c.checked = false; });
          load();
        });
        NB.$$('[data-view]', root).forEach((b) => b.addEventListener('click', () => {
          state.view = b.dataset.view;
          NB.$$('[data-view]', root).forEach((x) => x.classList.toggle('is-active', x === b));
          results.hidden = state.view === 'map';
          map.hidden = state.view !== 'map';
          /* the canvas was display:none a moment ago, so its measured size changed */
          if (mapCtl) mapCtl.redraw();
        }));
        load();
      }
    };
  });

  /* ------------------------------------------------------------------ */
  /* Single shop                                                         */
  /* ------------------------------------------------------------------ */
  NB.view(/^\/shop\/([a-z0-9-]+)$/, async (m) => {
    const slug = m[1];
    const data = await NB.api(`/shops/${encodeURIComponent(slug)}?${NB.locationQuery()}`);
    const s = data.shop;
    const categories = data.categories;
    const html = `
      <div class="shop-hero tone-${s.tone}">
        <div class="wrap shop-hero__inner">
          <nav class="crumbs crumbs--light" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<a href="#/shops">Nearby shops</a>${NB.icon('chevronRight')}<span>${NB.esc(s.name)}</span></nav>
          <div class="shop-hero__main">
            <div class="shop-hero__logo">${NB.esc(s.emoji || '🏪')}</div>
            <div class="shop-hero__copy">
              <div class="shop-hero__badges">
                ${s.verified ? `<span class="badge badge--verified">${NB.icon('verified')} Verified seller</span>` : '<span class="badge badge--neutral">New on NearBuy</span>'}
                <span class="badge ${s.isOpen ? 'badge--open' : 'badge--closed'}">${s.isOpen ? 'Open now' : `Closed · opens ${s.opensAt}`}</span>
                ${!s.serviceable ? `<span class="badge badge--warn">${NB.icon('alert')} Outside your area</span>` : ''}
              </div>
              <h1>${NB.esc(s.name)}</h1>
              <p class="shop-hero__tagline">${NB.esc(s.tagline || s.category)}</p>
              <div class="shop-hero__facts">
                <span>${NB.icon('star')} <b>${Number(s.rating).toFixed(1)}</b> (${s.reviewCount} reviews)</span>
                <span>${NB.icon('location')} ${NB.esc(s.locality)}${s.distanceKm != null ? ` · ${s.distanceKm} km` : ''}</span>
                <span>${NB.icon('clock')} ${s.opensAt}–${s.closesAt}</span>
                <span>${NB.icon('package')} ${s.prepMinutes} min prep</span>
              </div>
            </div>
            <div class="shop-hero__actions">
              <a class="btn btn--light" href="#/products?shop=${encodeURIComponent(s.slug)}">${NB.icon('search')} Search in shop</a>
              <a class="btn btn--outline-light" href="tel:${NB.esc(s.phone || '')}">${NB.icon('phone')} Call shop</a>
            </div>
          </div>
        </div>
      </div>
      ${!s.isOpen ? `<div class="wrap"><div class="notice notice--warn">${NB.icon('clock')} <b>${NB.esc(s.name)} is closed right now.</b> Opening hours are ${s.opensAt}–${s.closesAt}. You can browse, but ordering will be enabled when the shop opens.</div></div>` : ''}
      ${!s.serviceable ? `<div class="wrap"><div class="notice notice--warn">${NB.icon('alert')} This shop does not deliver to your saved area.${s.pickupEnabled ? ' Store pickup is available if you want to collect.' : ''}</div></div>` : ''}
      <div class="wrap shop-detail">
        <div class="shop-detail__main">
          <div class="catalogue-bar">
            <div class="catalogue-bar__tabs" id="shopCats">
              <button class="chip is-active" data-cat="all">All products <small>${data.products.length}</small></button>
              ${categories.map((c) => `<button class="chip" data-cat="${c.slug}">${NB.esc(c.name)} <small>${c.products.length}</small></button>`).join('')}
            </div>
            <div class="catalogue-bar__search">${NB.icon('search')}<input id="shopSearch" placeholder="Find in this shop…" aria-label="Search in this shop"/></div>
          </div>
          <div class="product-grid product-grid--shop" id="shopProducts">
            ${data.products.map((p) => NB.productCard(p)).join('')}
          </div>
          <div class="empty" id="shopNoProducts" hidden><span class="empty__ic">${NB.icon('search')}</span><h3>Nothing matches in this shop</h3><p>Try a broader search or another category.</p></div>

          ${data.offers.length ? `<section class="shop-section"><div class="section-head section-head--sm"><div><span class="eyebrow">Shop offers</span><h2>Deals from ${NB.esc(s.name)}</h2></div></div>
            <div class="offer-grid">${data.offers.map(NB.offerCard).join('')}</div></section>` : ''}

          <section class="shop-section">
            <div class="section-head section-head--sm"><div><span class="eyebrow">Reviews</span><h2>What neighbours say</h2><p>${s.reviewCount} verified ratings · ${Number(s.rating).toFixed(1)} average</p></div></div>
            ${data.reviews.length ? `<div class="review-list">${data.reviews.map((r) => `
              <article class="review"><div class="review__head"><span class="avatar avatar--sm">${NB.esc(r.customerName.charAt(0))}</span><div><b>${NB.esc(r.customerName)}</b><small>${r.verified ? 'Verified purchase · ' : ''}${NB.date(r.at)}</small></div><span class="stars stars--sm" aria-label="${r.rating} out of 5">${Array.from({ length: 5 }).map((_, i) => `<i class="${i < r.rating ? 'on' : ''}">${NB.icon('star')}</i>`).join('')}</span></div>
              <h4>${NB.esc(r.title || 'A neighbourhood review')}</h4><p>${NB.esc(r.body)}</p></article>`).join('')}</div>`
              : `<div class="empty empty--sm"><span class="empty__ic">${NB.icon('star')}</span><h3>No reviews yet</h3><p>Be the first to review ${NB.esc(s.name)} after your order is delivered.</p></div>`}
          </section>
        </div>
        <aside class="shop-detail__side">
          <div class="side-card side-card--flush">
            <h3>${NB.icon('map')} Find this shop</h3>
            ${NB.shopMap([s], {
              selected: s.slug,
              title: s.name,
              subtitle: s.distanceKm != null ? `${s.distanceKm} km from you` : (NB.state.location ? 'To scale' : 'Set your location for a distance')
            })}
          </div>
          <div class="side-card">
            <h3>Shop information</h3>
            <dl class="info-list">
              <div><dt>Owner</dt><dd>${s.ownerName ? NB.esc(s.ownerName) : 'Not listed'}</dd></div>
              <div><dt>Timings</dt><dd>${s.opensAt}–${s.closesAt} daily</dd></div>
              <div><dt>Delivery</dt><dd>${data.policies.delivery}</dd></div>
              <div><dt>Pickup</dt><dd>${data.policies.pickup}</dd></div>
              <div><dt>Minimum order</dt><dd>${s.minOrder ? NB.money(s.minOrder) : 'No minimum'}</dd></div>
              <div><dt>Returns</dt><dd>${data.policies.returns}</dd></div>
            </dl>
          </div>
          <div class="side-card side-card--soft">
            <h3>${NB.icon('shield')} Shop with confidence</h3>
            <ul class="tick-list">
              <li>${NB.icon('check')} Live stock counts from this shop</li>
              <li>${NB.icon('check')} Prices set by the seller</li>
              <li>${NB.icon('check')} Delivery OTP before handover</li>
              <li>${NB.icon('check')} Support tickets answered in Help</li>
            </ul>
          </div>
        </aside>
      </div>`;

    return {
      title: s.name,
      html,
      after(root) {
        NB.wireShopMap(root, [s]);
        let activeCat = 'all';
        const search = NB.$('#shopSearch', root);
        const grid = NB.$('#shopProducts', root);
        const empty = NB.$('#shopNoProducts', root);
        const apply = () => {
          const term = search.value.trim().toLowerCase();
          let shown = 0;
          NB.$$('.product-card', grid).forEach((card) => {
            const text = card.textContent.toLowerCase();
            const catOk = activeCat === 'all' || card.querySelector('.product-card__shop') ? true : true;
            const visible = (!term || text.includes(term)) && catOk;
            card.hidden = !visible;
            if (visible) shown += 1;
          });
          empty.hidden = shown > 0;
        };
        NB.$$('#shopCats .chip', root).forEach((btn) => btn.addEventListener('click', () => {
          NB.$$('#shopCats .chip', root).forEach((b) => b.classList.toggle('is-active', b === btn));
          activeCat = btn.dataset.cat;
          if (activeCat === 'all') {
            grid.innerHTML = data.products.map((p) => NB.productCard(p)).join('');
          } else {
            const cat = data.categories.find((c) => c.slug === activeCat);
            grid.innerHTML = (cat ? cat.products : []).map((p) => NB.productCard(p)).join('');
          }
          apply();
        }));
        search.addEventListener('input', apply);
      }
    };
  });

  /* ------------------------------------------------------------------ */
  /* Product listing / category / search                                 */
  /* ------------------------------------------------------------------ */
  function listingView({ title, eyebrow, description, fixed = {}, categoryMode = false }) {
    return async (m, query) => {
      const state = {
        q: fixed.q || query.get('q') || '',
        category: categoryMode ? m[1] : (fixed.category || query.get('category') || ''),
        shop: fixed.shop || query.get('shop') || '',
        brand: query.get('brand') || '',
        minPrice: query.get('minPrice') || '',
        maxPrice: query.get('maxPrice') || '',
        rating: query.get('rating') || '',
        available: query.get('available') === '1',
        delivery: query.get('delivery') === '1',
        pickup: query.get('pickup') === '1',
        sort: query.get('sort') || 'relevance',
        page: 1
      };
      const cats = NB.state.categories;
      const activeCategory = cats.find((c) => c.slug === state.category);
      const heading = categoryMode ? (activeCategory?.name || 'Category') : (state.q ? `Results for “${state.q}”` : title);
      const desc = categoryMode ? `Every ${String(activeCategory?.name || '').toLowerCase()} listing from shops near you, with live prices and stock.` : description;
      const html = `
        <div class="page-hero ${categoryMode ? 'page-hero--category' : ''}">
          <div class="wrap">
            <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<a href="#/categories">Categories</a>${NB.icon('chevronRight')}<span>${NB.esc(heading)}</span></nav>
            <div class="page-hero__row"><div><span class="eyebrow">${NB.esc(eyebrow)}</span><h1>${NB.esc(heading)}</h1><p>${NB.esc(desc)}</p></div>
              ${categoryMode && activeCategory ? `<span class="cat-hero-ic tone-${activeCategory.tone}">${NB.icon(NB.categoryIcon(activeCategory.slug))}</span>` : ''}</div>
            <form class="big-search big-search--page" id="listingSearch">${NB.icon('search')}<input name="q" value="${NB.esc(state.q)}" placeholder="Search within these results…" aria-label="Search products"/><button class="btn btn--primary" type="submit">Search</button></form>
          </div>
        </div>
        ${categoryMode ? `<div class="wrap"><div class="subcat-row">${cats.map((c) => `<a class="chip ${c.slug === state.category ? 'is-active' : ''}" href="#/categories/${c.slug}">${NB.icon(NB.categoryIcon(c.slug))} ${NB.esc(c.name)}</a>`).join('')}</div></div>` : ''}
        <div class="wrap listing-page">
          <aside class="filters" aria-label="Product filters">
            <div class="filters__head"><b>${NB.icon('filter')} Filters</b><button class="link-btn" id="clearFilters">Clear all</button></div>
            <form id="filterForm">
              <div class="field"><label for="fCategory">Category</label><select id="fCategory" name="category"><option value="">All categories</option>${cats.map((c) => `<option value="${c.slug}" ${state.category === c.slug ? 'selected' : ''}>${NB.esc(c.name)}</option>`).join('')}</select></div>
              <div class="field"><label>Price range (₹)</label><div class="range-row"><input name="minPrice" type="number" min="0" placeholder="Min" value="${NB.esc(state.minPrice)}" aria-label="Minimum price"/><span>–</span><input name="maxPrice" type="number" min="0" placeholder="Max" value="${NB.esc(state.maxPrice)}" aria-label="Maximum price"/></div></div>
              <div class="field"><label for="fBrand">Brand</label><select id="fBrand" name="brand"><option value="">All brands</option><option value="amul">Amul</option><option value="tata">Tata</option><option value="maggi">Maggi</option><option value="classmate">Classmate</option><option value="colgate">Colgate</option><option value="dove">Dove</option><option value="boat">boAt</option><option value="sanDisk">SanDisk</option></select></div>
              <div class="field"><label for="fRating">Customer rating</label><select id="fRating" name="rating"><option value="">Any rating</option>${[4.5, 4, 3.5, 3].map((r) => `<option value="${r}" ${String(r) === state.rating ? 'selected' : ''}>${r}★ and above</option>`).join('')}</select></div>
              <div class="field"><label>Availability</label>
                <label class="check"><input type="checkbox" name="available" ${state.available ? 'checked' : ''}/><span>In stock only</span></label>
                <label class="check"><input type="checkbox" name="delivery" ${state.delivery ? 'checked' : ''}/><span>Home delivery</span></label>
                <label class="check"><input type="checkbox" name="pickup" ${state.pickup ? 'checked' : ''}/><span>Store pickup</span></label>
              </div>
              <div class="field"><label for="fShop">Shop</label><select id="fShop" name="shop"><option value="">All shops</option>${['fresh-mart', 'green-basket', 'scribble-stationery', 'mediplus-pharmacy', 'daily-needs-kirana', 'sunrise-bakery', 'tech-corner', 'glow-beauty', 'petal-and-pot', 'fitzone-sports'].map((s) => `<option value="${s}" ${state.shop === s ? 'selected' : ''}>${s.replace(/-/g, ' ')}</option>`).join('')}</select></div>
              <button class="btn btn--primary btn--block" type="submit">Apply filters</button>
            </form>
            <div class="filters__note">${NB.icon('info')} We filter by the shops that serve your selected area.</div>
          </aside>
          <div class="listing-results">
            <div class="results-bar">
              <div class="results-count" id="listingCount">Loading products…</div>
              <button class="btn btn--ghost btn--sm filters-mobile-toggle" id="listingFiltersToggle" type="button">${NB.icon('filter')} Filters</button>
              <label class="sort-select"><span>Sort by</span><select id="listingSort">
                ${[['relevance', 'Relevance'], ['price_low', 'Lowest price'], ['price_high', 'Highest price'], ['rating', 'Highest rated'], ['distance', 'Nearest shop'], ['discount', 'Biggest discount']].map(([v, l]) => `<option value="${v}" ${state.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select></label>
            </div>
            <div class="active-filters" id="activeFilters"></div>
            <div class="product-grid product-grid--listing" id="listingGrid">${NB.skeleton('home')}</div>
            <div id="listingEmpty"></div>
            <div id="listingPager" class="pager"></div>
          </div>
        </div>`;

      return {
        title: heading,
        html,
        after(root) {
          const grid = NB.$('#listingGrid', root);
          const count = NB.$('#listingCount', root);
          const pager = NB.$('#listingPager', root);
          const active = NB.$('#activeFilters', root);
          const empty = NB.$('#listingEmpty', root);
          let data = null;
          let filterOptionsFilled = false;

          const chips = () => {
            const entries = [];
            if (state.q) entries.push(['q', `“${state.q}”`]);
            if (state.category) entries.push(['category', cats.find((c) => c.slug === state.category)?.name || state.category]);
            if (state.brand) entries.push(['brand', state.brand]);
            if (state.minPrice || state.maxPrice) entries.push(['price', `₹${state.minPrice || 0}–₹${state.maxPrice || 'any'}`]);
            if (state.rating) entries.push(['rating', `${state.rating}★+`]);
            if (state.available) entries.push(['available', 'In stock']);
            if (state.delivery) entries.push(['delivery', 'Home delivery']);
            if (state.pickup) entries.push(['pickup', 'Store pickup']);
            if (state.shop) entries.push(['shop', state.shop.replace(/-/g, ' ')]);
            active.innerHTML = entries.map(([key, label]) => `<button class="filter-chip" data-clear="${key}">${NB.esc(label)} ${NB.icon('close')}</button>`).join('');
            NB.$$('[data-clear]', active).forEach((b) => b.addEventListener('click', () => {
              const key = b.dataset.clear;
              if (key === 'price') { state.minPrice = ''; state.maxPrice = ''; }
              else if (key === 'available') state.available = false;
              else if (key === 'delivery') state.delivery = false;
              else if (key === 'pickup') state.pickup = false;
              else state[key] = '';
              state.page = 1;
              NB.$('#filterForm', root).reset();
              load();
            }));
          };

          async function load() {
            grid.innerHTML = `<div class="skl-grid skl-grid--3">${Array.from({ length: 6 }).map(() => `<div class="skl-card"><div class="skl skl--photo-sm"></div><div class="skl skl--line"></div><div class="skl skl--line skl--short"></div></div>`).join('')}</div>`;
            empty.innerHTML = '';
            const params = {
              q: state.q, category: state.category, shop: state.shop, brand: state.brand,
              minPrice: state.minPrice, maxPrice: state.maxPrice, rating: state.rating,
              available: state.available ? '1' : '', delivery: state.delivery ? '1' : '', pickup: state.pickup ? '1' : '',
              sort: state.sort, page: state.page, limit: 24
            };
            try {
              data = await NB.api(`/products?${NB.qs(params)}&${NB.locationQuery()}`);
              if (!filterOptionsFilled && Array.isArray(data.brands)) {
                const brandSelect = NB.$('#fBrand', root);
                brandSelect.innerHTML = '<option value="">All brands</option>' + data.brands
                  .map((b) => `<option value="${NB.esc(String(b).toLowerCase())}">${NB.esc(b)}</option>`).join('');
                brandSelect.value = state.brand;
                const shopSelect = NB.$('#fShop', root);
                shopSelect.innerHTML = '<option value="">All shops</option>' + (data.shops || [])
                  .map((s) => `<option value="${NB.esc(s.slug)}">${NB.esc(s.emoji ? s.emoji + ' ' : '')}${NB.esc(s.name)}</option>`).join('');
                shopSelect.value = state.shop;
                filterOptionsFilled = true;
              }
              count.innerHTML = `<b>${data.total}</b> ${data.total === 1 ? 'product' : 'products'} from ${new Set(data.products.map((p) => p.shop.id)).size || 0} nearby shops`;
              grid.innerHTML = data.products.map((p) => NB.productCard(p)).join('');
              if (!data.products.length) {
                empty.innerHTML = NB.empty({ icon: 'search', title: 'No products match', body: 'Try a different category or clear the filters. We only show shops that serve your area.', cta: '#/shops', ctaLabel: 'Browse shops' });
              }
              pager.innerHTML = data.pages > 1 ? `<button class="btn btn--ghost btn--sm" id="prevPage" ${state.page <= 1 ? 'disabled' : ''}>${NB.icon('arrowLeft')} Previous</button><span>Page ${data.page} of ${data.pages}</span><button class="btn btn--ghost btn--sm" id="nextPage" ${state.page >= data.pages ? 'disabled' : ''}>Next ${NB.icon('arrowRight')}</button>` : '';
              const prev = NB.$('#prevPage', pager); const next = NB.$('#nextPage', pager);
              if (prev) prev.addEventListener('click', () => { state.page -= 1; load(); });
              if (next) next.addEventListener('click', () => { state.page += 1; load(); });
              chips();
            } catch (err) {
              grid.innerHTML = '';
              empty.innerHTML = NB.errorView(err);
              const retry = NB.$('#retryView', empty); if (retry) retry.addEventListener('click', load);
            }
          }

          const form = NB.$('#filterForm', root);
          form.addEventListener('submit', (e) => {
            e.preventDefault();
            state.category = form.category.value;
            state.brand = form.brand.value;
            state.shop = form.shop.value;
            state.minPrice = form.minPrice.value;
            state.maxPrice = form.maxPrice.value;
            state.rating = form.rating.value;
            state.available = form.available.checked;
            state.delivery = form.delivery.checked;
            state.pickup = form.pickup.checked;
            state.page = 1;
            load();
          });
          NB.$('#listingSort', root).addEventListener('change', (e) => { state.sort = e.target.value; state.page = 1; load(); });
          NB.$('#listingFiltersToggle', root)?.addEventListener('click', () => NB.$('.filters', root)?.classList.toggle('is-open'));
          NB.$('#clearFilters', root).addEventListener('click', () => {
            Object.assign(state, { category: '', brand: '', shop: '', minPrice: '', maxPrice: '', rating: '', available: false, delivery: false, pickup: false, page: 1 });
            form.reset();
            load();
          });
          const ls = NB.$('#listingSearch', root);
          if (ls) ls.addEventListener('submit', (e) => {
            e.preventDefault();
            state.q = e.target.q.value.trim();
            state.page = 1;
            load();
          });
          load();
        }
      };
    };
  }

  NB.view(/^\/categories\/([a-z0-9-]+)$/, listingView({
    title: 'Category', eyebrow: 'Shop by category', description: 'Local listings with live prices and stock.', categoryMode: true
  }));
  NB.view(/^\/products$/, listingView({
    title: 'All products', eyebrow: 'Browse everything', description: 'Every product from the shops that deliver to your area.'
  }));

  /* ------------------------------------------------------------------ */
  /* Product detail + price comparison                                   */
  /* ------------------------------------------------------------------ */
  NB.view(/^\/product\/([a-zA-Z0-9_-]+)$/, async (m) => {
    const id = m[1];
    const [data, compare] = await Promise.all([
      NB.api(`/products/${encodeURIComponent(id)}?${NB.locationQuery()}`),
      NB.api(`/products/${encodeURIComponent(id)}/compare?${NB.locationQuery()}`)
    ]);
    const p = data.product;
    const s = data.shop;
    const discount = p.mrp > p.price ? Math.round(((p.mrp - p.price) / p.mrp) * 100) : 0;
    const savings = p.mrp > p.price ? p.mrp - p.price : 0;
    const better = compare.listings.filter((l) => l.available && l.price < p.price);
    const html = `
      <div class="wrap product-page">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<a href="#/categories/${p.categorySlug}">${NB.esc(p.category)}</a>${NB.icon('chevronRight')}<span>${NB.esc(p.name)}</span></nav>
        <div class="product-detail">
          <div class="product-gallery">
            <div class="product-gallery__main" id="galleryMain">${NB.productArt(p)}</div>
            <div class="product-gallery__thumbs">
              ${(p.images.length ? p.images : [p.imageUrl]).filter(Boolean).map((url, i) => `<button class="gallery-thumb ${i === 0 ? 'is-active' : ''}" data-src="${NB.esc(url)}"><img src="${NB.esc(url)}" alt="View ${i + 1}"/></button>`).join('')}
              <button class="gallery-thumb ${p.images.length ? '' : 'is-active'}" data-emoji="1"><span>${NB.esc(p.emoji || '🛍️')}</span></button>
            </div>
            <div class="product-gallery__trust">
              <span>${NB.icon('shield')} Local seller</span><span>${NB.icon('returnArrow')} ${p.returnDays ? `${p.returnDays}-day returns` : 'Non-returnable'}</span><span>${NB.icon('package')} Live stock</span>
            </div>
          </div>
          <div class="product-info">
            <div class="product-info__shop"><a href="#/shop/${encodeURIComponent(s.slug)}">${NB.esc(s.emoji)} ${NB.esc(s.name)}</a>
              ${s.distanceKm != null ? `<span>${NB.icon('location')} ${s.distanceKm} km away</span>` : ''}
              <span class="rating">${NB.icon('star')} ${Number(p.rating).toFixed(1)} <small>(${p.reviewCount})</small></span></div>
            <h1>${NB.esc(p.name)}</h1>
            <div class="product-info__meta"><span class="brand-tag">${NB.esc(p.brand || 'NearBuy')}</span><span>${NB.esc(p.unit)}</span>${p.taxRate ? `<span>${p.taxRate}% GST</span>` : ''}</div>
            <div class="product-info__price">
              <div class="price price--lg"><b>${NB.money(p.price)}</b>${p.mrp > p.price ? `<s>${NB.money(p.mrp)}</s>` : ''}${discount ? `<span class="save">${discount}% off</span>` : ''}</div>
              ${savings ? `<small>You save ${NB.money(savings)} · inclusive of applicable taxes</small>` : '<small>Inclusive of applicable taxes</small>'}
            </div>
            <div class="stockline ${p.available ? (p.lowStock ? 'stockline--low' : 'stockline--ok') : 'stockline--out'}">
              ${NB.icon(p.available ? 'checkCircle' : 'alert')}
              ${p.available ? (p.lowStock ? `Hurry — only ${p.stock} left at this shop` : `In stock · ${p.stock} available`) : 'Out of stock at this shop'}
            </div>
            <div class="product-buy">
              <div class="qty-label">Quantity <small>max ${Math.min(20, p.stock || 20)}</small></div>
              ${NB.qtyStepper(1, { max: Math.min(20, Math.max(1, p.stock)) })}
              <button class="btn btn--primary btn--lg" id="addProduct" ${p.available ? '' : 'disabled'}>${NB.icon('cart')} Add to cart</button>
              <button class="btn btn--outline btn--lg" id="buyNow" ${p.available ? '' : 'disabled'}>Buy now</button>
              <button class="icon-btn wish-btn wish-btn--lg ${data.wishlisted ? 'is-on' : ''}" data-wish="${NB.esc(p.id)}" aria-label="${data.wishlisted ? 'Remove from' : 'Add to'} wishlist">${NB.icon('heart')}</button>
            </div>
            ${better.length ? `<button class="price-alert" data-scroll="compareSection">${NB.icon('tag')} <b>${better.length} nearby ${better.length === 1 ? 'shop has' : 'shops have'} this cheaper</b> — from ${NB.money(Math.min(...better.map((b) => b.price)))}. Compare prices ${NB.icon('arrowRight')}</button>` : ''}
            <div class="fulfil-grid">
              <div><span>${NB.icon('truck')}</span><div><b>Home delivery</b><small>${s.deliveryEnabled ? `${s.prepMinutes + 18}–${s.prepMinutes + 35} min · ${s.deliveryFee ? NB.money(s.deliveryFee) : 'Free'}${s.freeDeliveryOver ? `, free over ${NB.money(s.freeDeliveryOver)}` : ''}` : 'Not offered by this shop'}</small></div></div>
              <div><span>${NB.icon('store')}</span><div><b>Store pickup</b><small>${s.pickupEnabled ? `Ready in ${s.prepMinutes} min · ${s.pickupFee ? NB.money(s.pickupFee) : 'Free'}` : 'Not offered by this shop'}</small></div></div>
              <div><span>${NB.icon('returnArrow')}</span><div><b>Returns</b><small>${p.returnDays ? `${p.returnDays} days after delivery` : 'Perishable / non-returnable'}</small></div></div>
            </div>
            <div class="product-info__service">${NB.icon('location')} Delivering to <b>${NB.esc(NB.state.location?.locality || 'your selected location')}</b> · ${s.serviceable ? 'This shop serves your area' : 'This shop does not deliver to your area'}</div>
          </div>
        </div>

        <section class="detail-section" id="compareSection">
          <div class="section-head section-head--sm"><div><span class="eyebrow">Price comparison</span><h2>Compare prices near you</h2><p>${NB.esc(compare.equivalentNote)}</p></div>
            <span class="compare-count">${compare.listings.length} listings matched</span></div>
          <div class="compare-wrap">
            <table class="compare-table">
              <thead><tr><th>Shop</th><th>Price</th><th>Availability</th><th>Distance</th><th>Delivery</th><th>Pickup</th><th>Rating</th><th></th></tr></thead>
              <tbody>
                ${compare.listings.map((l) => {
                  const lowest = compare.lowestPrice != null && l.price === compare.lowestPrice && l.available;
                  return `<tr class="${l.id === p.id ? 'is-current' : ''} ${!l.available ? 'is-unavailable' : ''}">
                    <td><a class="compare-shop" href="#/shop/${encodeURIComponent(l.shop.slug)}"><span class="mini-art tone-${l.shop.tone}">${NB.esc(l.shop.emoji)}</span><span><b>${NB.esc(l.shop.name)}</b><small>${l.shopVerified ? 'Verified · ' : ''}${NB.esc(l.unit)}</small></span></a>${l.id === p.id ? '<em class="current-tag">This listing</em>' : ''}</td>
                    <td><b>${NB.money(l.price)}</b>${lowest ? '<span class="lowest-tag">Lowest price</span>' : ''}${l.mrp > l.price ? `<s>${NB.money(l.mrp)}</s>` : ''}</td>
                    <td>${l.available ? `<span class="text-success">In stock${l.stock <= 5 ? ` (${l.stock})` : ''}</span>` : '<span class="text-danger">Out of stock</span>'}</td>
                    <td>${l.distanceKm != null ? l.distanceKm + ' km' : '—'}</td>
                    <td>${l.deliveryEnabled ? `${NB.icon('check')} ${NB.money(l.deliveryFee || 0)}` : `${NB.icon('close')} No`}</td>
                    <td>${l.pickupEnabled ? `${NB.icon('check')} Yes` : `${NB.icon('close')} No`}</td>
                    <td><span class="rating">${NB.icon('star')} ${Number(l.shopRating).toFixed(1)}</span></td>
                    <td>${l.available ? `<button class="btn btn--outline btn--xs" data-add="${NB.esc(l.id)}">Add</button>` : ''}<a class="link-btn" href="#/shop/${encodeURIComponent(l.shop.slug)}">Visit</a></td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
          <p class="compare-note">${NB.icon('info')} We only compare listings with the same brand, pack size and variant. Availability and prices are read live from each seller’s catalogue.</p>
        </section>

        <section class="detail-section detail-cols">
          <div class="detail-copy">
            <h2>About this product</h2>
            <p>${NB.esc(p.description || '')}</p>
            ${p.highlights.length ? `<ul class="tick-list">${p.highlights.map((h) => `<li>${NB.icon('check')} ${NB.esc(h)}</li>`).join('')}</ul>` : ''}
            <div class="spec-table"><h3>Product details</h3><dl>
              <div><dt>Brand</dt><dd>${NB.esc(p.brand || '—')}</dd></div>
              <div><dt>Unit / pack</dt><dd>${NB.esc(p.unit)}</dd></div>
              <div><dt>Category</dt><dd><a href="#/categories/${p.categorySlug}">${NB.esc(p.category)}</a></dd></div>
              <div><dt>Sold by</dt><dd><a href="#/shop/${encodeURIComponent(s.slug)}">${NB.esc(s.name)}</a></dd></div>
              <div><dt>Tax</dt><dd>${p.taxRate ? p.taxRate + '% GST included' : 'Exempt / included'}</dd></div>
              <div><dt>Return window</dt><dd>${p.returnDays ? `${p.returnDays} days` : 'Not returnable'}</dd></div>
              ${p.specs.map((x) => `<div><dt>${NB.esc(x.label || x.name || 'Detail')}</dt><dd>${NB.esc(x.value || '')}</dd></div>`).join('')}
            </dl></div>
          </div>
          <aside class="detail-side">
            <div class="side-card">
              <div class="side-shop"><span class="side-shop__ic tone-${s.tone}">${NB.esc(s.emoji)}</span><div><b>${NB.esc(s.name)}</b><small>${NB.esc(s.tagline)}</small></div></div>
              <div class="side-rating"><span class="rating">${NB.icon('star')} ${Number(s.rating).toFixed(1)}</span><small>${s.reviewCount} reviews</small></div>
              <div class="side-actions"><a class="btn btn--outline btn--block" href="#/shop/${encodeURIComponent(s.slug)}">Visit shop</a><a class="btn btn--ghost btn--block" href="#/products?shop=${encodeURIComponent(s.slug)}">All products</a></div>
              <p class="fineprint">${NB.icon('clock')} ${s.opensAt}–${s.closesAt} · ${s.locality}</p>
            </div>
          </aside>
        </section>

        <section class="detail-section">
          <div class="section-head section-head--sm"><div><span class="eyebrow">Reviews</span><h2>Ratings &amp; reviews</h2><p>Only verified buyers can review this product.</p></div>
            <a class="link-arrow" href="#/orders">Review a delivered order ${NB.icon('arrowRight')}</a></div>
          ${data.reviews.length ? `<div class="review-list">${data.reviews.map((r) => `<article class="review"><div class="review__head"><span class="avatar avatar--sm">${NB.esc(r.customerName.charAt(0))}</span><div><b>${NB.esc(r.customerName)}</b><small>${r.verified ? 'Verified purchase · ' : ''}${NB.date(r.at)}</small></div><span class="stars stars--sm">${Array.from({ length: 5 }).map((_, i) => `<i class="${i < r.rating ? 'on' : ''}">${NB.icon('star')}</i>`).join('')}</span></div>
            <h4>${NB.esc(r.title || 'Verified review')}</h4><p>${NB.esc(r.body)}</p></article>`).join('')}</div>` : `<div class="empty empty--sm"><span class="empty__ic">${NB.icon('star')}</span><h3>No reviews for this product yet</h3><p>Delivered orders can be reviewed from the order page.</p></div>`}
        </section>

        ${data.related.length ? `<section class="detail-section"><div class="section-head section-head--sm"><div><span class="eyebrow">You may also like</span><h2>More nearby picks</h2></div></div>
          <div class="product-grid product-grid--related">${data.related.map((x) => NB.productCard(x)).join('')}</div></section>` : ''}
      </div>`;

    return {
      title: p.name,
      html,
      after(root) {
        let qty = 1;
        NB.bindQty(root, (v) => { qty = v; });
        const add = NB.$('#addProduct', root);
        if (add) add.addEventListener('click', () => NB.addToCart(p.id, qty, add));
        const buy = NB.$('#buyNow', root);
        if (buy) buy.addEventListener('click', async () => {
          buy.disabled = true;
          await NB.addToCart(p.id, qty);
          buy.disabled = false;
          if (NB.state.user) NB.hash('/checkout');
          else NB.hash(`/login?next=${encodeURIComponent('#/checkout')}`);
        });
        NB.$$('[data-scroll]', root).forEach((b) => b.addEventListener('click', () => {
          const el = NB.$('#' + b.dataset.scroll, root);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }));
        NB.$$('.gallery-thumb', root).forEach((t) => t.addEventListener('click', () => {
          NB.$$('.gallery-thumb', root).forEach((x) => x.classList.toggle('is-active', x === t));
          const main = NB.$('#galleryMain', root);
          if (t.dataset.src) main.innerHTML = `<img class="product-art" src="${NB.esc(t.dataset.src)}" alt="${NB.esc(p.name)}"/>`;
          else main.innerHTML = NB.productArt({ ...p, imageUrl: null });
        }));
      }
    };
  });

  /* ------------------------------------------------------------------ */
  /* Offers                                                              */
  /* ------------------------------------------------------------------ */
  NB.view(/^\/offers$/, async () => {
    const data = await NB.api(`/offers?${NB.locationQuery()}`);
    const html = `
      <div class="page-hero page-hero--offers">
        <div class="wrap"><nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<span>Offers</span></nav>
          <div class="page-hero__row"><div><span class="eyebrow">Today’s deals</span><h1>Offers from your neighbourhood</h1><p>Real, in-date coupons from local shops and NearBuy. Expired offers are never listed.</p></div>
            <div class="offer-hero-ic">${NB.icon('percent')}</div></div>
        </div>
      </div>
      <section class="section"><div class="wrap">
        ${data.offers.length ? `<div class="offer-grid offer-grid--wide">${data.offers.map(NB.offerCard).join('')}</div>` : NB.empty({ icon: 'tag', title: 'No live offers right now', body: 'New offers from nearby shops appear here as soon as they are published.', cta: '#/shops', ctaLabel: 'Browse shops' })}
        <div class="coupon-how">
          <div class="coupon-how__step"><span>1</span><b>Pick an offer</b><p>Tap the coupon code to copy it.</p></div>
          <div class="coupon-how__step"><span>2</span><b>Add items</b><p>Build your basket from nearby shops.</p></div>
          <div class="coupon-how__step"><span>3</span><b>Apply at cart</b><p>The server checks minimums, expiry and limits.</p></div>
          <div class="coupon-how__step"><span>4</span><b>See the saving</b><p>Your final amount updates before payment.</p></div>
        </div>
      </div></section>
      <section class="section section--soft"><div class="wrap">
        <div class="section-head"><div><span class="eyebrow">Also on offer</span><h2>Products with the deepest discounts</h2><p>Discounted against MRP by the seller.</p></div><a class="link-arrow" href="#/products?sort=discount">All discounts ${NB.icon('arrowRight')}</a></div>
        <div class="product-grid">${data.products.map((p) => NB.productCard(p)).join('')}</div>
      </div></section>`;
    return { title: 'Offers & coupons', html };
  });
})();
