/* NearBuy Customer Portal — Search Results Page (SRP).
 *
 * Flipkart-blueprint layout adapted to the NearBuy design system:
 *   Home › Search › “query” breadcrumb + result meta, sticky faceted rail,
 *   sort ribbon, horizontal list cards with spec bullets, rating pill,
 *   wishlist + add-to-cart + compare (up to 4), a sponsored in-feed strip
 *   powered by live offers, numbered pagination, skeleton loading while
 *   fetching, URL-serialized filters (shareable / back-button friendly),
 *   and a relevance feedback widget that files into the support loop.
 */
(function () {
  'use strict';

  const COMPARE_KEY = 'nb.compare';
  const MAX_COMPARE = 4;
  const PAGE_SIZE = 24;
  const SORTS = [
    ['relevance', 'Relevance'],
    ['popularity', 'Popularity'],
    ['price_low', 'Price: Low to High'],
    ['price_high', 'Price: High to Low'],
    ['rating', 'Highest rated'],
    ['discount', 'Biggest discount']
  ];

  /* ------------------------- compare store -------------------------- */
  const compareList = () => {
    const list = NB.storage.get(COMPARE_KEY, []);
    return Array.isArray(list) ? list.filter((p) => p && p.id).slice(0, MAX_COMPARE) : [];
  };
  const saveCompare = (list) => NB.storage.set(COMPARE_KEY, list.slice(0, MAX_COMPARE));
  const inCompare = (id) => compareList().some((p) => p.id === id);
  const compareSnapshot = (p) => ({
    id: p.id, name: p.name, brand: p.brand || '', unit: p.unit || '', packSize: p.packSize || '',
    price: p.price, mrp: p.mrp, discount: p.discount || 0, rating: p.rating, reviewCount: p.reviewCount,
    emoji: p.emoji, imageUrl: p.imageUrl, category: p.category,
    shop: p.shop ? { name: p.shop.name, slug: p.shop.slug } : null,
    distanceKm: p.distanceKm, deliveryEnabled: Boolean(p.deliveryEnabled), pickupEnabled: Boolean(p.pickupEnabled),
    returnDays: p.returnDays || 0, available: Boolean(p.available), stock: p.stock || 0
  });

  const fmtN = (n) => Number(n || 0).toLocaleString('en-IN');

  /* --------------------------- the view ----------------------------- */
  NB.view(/^\/search$/, async (m, query) => {
    const state = {
      q: (query.get('q') || '').trim(),
      category: query.get('category') || '',
      shop: query.get('shop') || '',
      brand: (query.get('brand') || '').toLowerCase(),
      minPrice: query.get('minPrice') || '',
      maxPrice: query.get('maxPrice') || '',
      rating: query.get('rating') || '',
      available: query.get('available') === '1',
      delivery: query.get('delivery') === '1',
      pickup: query.get('pickup') === '1',
      sort: query.get('sort') || 'relevance',
      page: Math.max(1, parseInt(query.get('page') || '1', 10) || 1)
    };
    if (!SORTS.some(([v]) => v === state.sort)) state.sort = 'relevance';

    const cats = NB.state.categories;
    const loc = NB.state.location;
    const heading = state.q ? `Results for “${state.q}”` : 'All products';

    const syncUrl = () => {
      const qs = NB.qs({
        q: state.q, category: state.category, shop: state.shop, brand: state.brand,
        minPrice: state.minPrice, maxPrice: state.maxPrice, rating: state.rating,
        available: state.available ? '1' : '', delivery: state.delivery ? '1' : '', pickup: state.pickup ? '1' : '',
        sort: state.sort === 'relevance' ? '' : state.sort,
        page: state.page > 1 ? String(state.page) : ''
      });
      try { history.replaceState(null, '', '#/search' + (qs ? '?' + qs : '')); } catch { /* no-op */ }
    };

    const crumbQuery = state.q ? `<span>“${NB.esc(state.q)}”</span>` : '<span>All products</span>';
    const html = `
      <section class="srp-context">
        <div class="wrap">
          <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<a href="#/search">Search</a>${NB.icon('chevronRight')}${crumbQuery}</nav>
          <div class="srp-context__row">
            <div class="srp-context__lede">
              <h1 class="srp-context__title">${NB.esc(heading)}</h1>
              <p class="srp-context__meta" id="srpMeta">Searching nearby shops…</p>
            </div>
            <div class="srp-context__tools">
              ${loc ? `<span class="srp-loc" title="Results are served by shops that deliver to this area">${NB.icon('location')} ${NB.esc(loc.pincode || '')}${loc.locality ? ' · ' + NB.esc(loc.locality) : ''}</span>` : ''}
              <button class="btn btn--ghost btn--sm" id="srpCopyLink" type="button">${NB.icon('link')} Copy link</button>
            </div>
          </div>
        </div>
      </section>

      <div class="wrap srp-page" id="srpTop">
        <aside class="srp-rail" id="srpRail" aria-label="Product filters">
          <form id="srpFilterForm" autocomplete="off">
            <div class="srp-rail__head"><b>${NB.icon('filter')} Filters</b><button class="link-btn" id="srpClearAll" type="button">Clear all</button></div>
            <div class="srp-chips" id="srpActiveChips" aria-live="polite"></div>

            <fieldset class="srp-group">
              <legend>Price range (₹)</legend>
              <div class="range-row">
                <input name="minPrice" type="number" min="0" inputmode="numeric" placeholder="Min" value="${NB.esc(state.minPrice)}" aria-label="Minimum price in rupees"/>
                <span aria-hidden="true">–</span>
                <input name="maxPrice" type="number" min="0" inputmode="numeric" placeholder="Max" value="${NB.esc(state.maxPrice)}" aria-label="Maximum price in rupees"/>
              </div>
              <div class="srp-quick-ranges">
                ${[[0, 100, 'Under ₹100'], [100, 500, '₹100–500'], [500, 2000, '₹500–2,000'], [2000, '', 'Above ₹2,000']].map(([a, b, l]) => `<button type="button" class="srp-range-chip" data-min="${a}" data-max="${b}">${l}</button>`).join('')}
              </div>
            </fieldset>

            <fieldset class="srp-group">
              <legend>Category</legend>
              <select name="category" aria-label="Category"><option value="">All categories</option>${cats.map((c) => `<option value="${NB.esc(c.slug)}" ${state.category === c.slug ? 'selected' : ''}>${NB.esc(c.name)}</option>`).join('')}</select>
            </fieldset>

            <fieldset class="srp-group">
              <legend>Brand</legend>
              <select name="brand" id="srpBrand" aria-label="Brand"><option value="">All brands</option></select>
            </fieldset>

            <fieldset class="srp-group">
              <legend>Customer rating</legend>
              ${[['', 'Any rating'], ['4.5', '4.5★ & above'], ['4', '4★ & above'], ['3.5', '3.5★ & above'], ['3', '3★ & above']].map(([v, l]) => `<label class="srp-radio"><input type="radio" name="rating" value="${v}" ${String(state.rating) === v ? 'checked' : ''}/><span class="srp-radio__dot" aria-hidden="true"></span><span>${l}</span></label>`).join('')}
            </fieldset>

            <fieldset class="srp-group">
              <legend>Availability</legend>
              <label class="check"><input type="checkbox" name="available" ${state.available ? 'checked' : ''}/><span>In stock only</span></label>
              <label class="check"><input type="checkbox" name="delivery" ${state.delivery ? 'checked' : ''}/><span>Home delivery</span></label>
              <label class="check"><input type="checkbox" name="pickup" ${state.pickup ? 'checked' : ''}/><span>Store pickup</span></label>
            </fieldset>

            <fieldset class="srp-group">
              <legend>Shop</legend>
              <select name="shop" id="srpShop" aria-label="Shop"><option value="">All nearby shops</option></select>
            </fieldset>

            <button class="btn btn--primary btn--block" type="submit">${NB.icon('filter')} Apply filters</button>
            <div class="filters__note">${NB.icon('info')} Filters compare every shop that serves your selected area. Prices update live.</div>
          </form>
        </aside>

        <div class="srp-feed">
          <div class="srp-sortbar">
            <div class="srp-sort" id="srpSort" role="group" aria-label="Sort results">
              <span class="srp-sort__label">Sort by</span>
              ${SORTS.map(([v, l]) => `<button type="button" class="srp-sort__btn ${state.sort === v ? 'is-active' : ''}" data-sort="${v}" aria-pressed="${state.sort === v}">${l}</button>`).join('')}
            </div>
            <button class="btn btn--ghost btn--sm filters-mobile-toggle" id="srpFiltersToggle" type="button">${NB.icon('filter')} Filters</button>
          </div>
          <div class="srp-countline">
            <p class="srp-count" id="srpCount">Loading products…</p>
            <span class="srp-demo-tag" title="Sample assortment for the NearBuy prototype">Demo catalogue</span>
          </div>
          <div class="srp-rows" id="srpRows" aria-live="polite">
            <div class="srp-skl-list">${Array.from({ length: 6 }).map(() => '<div class="srp-skl-row"><div class="skl srp-skl-row__img"></div><div class="srp-skl-row__lines"><div class="skl skl--line"></div><div class="skl skl--line"></div><div class="skl skl--line skl--short"></div></div></div>').join('')}</div>
          </div>
          <div id="srpEmpty"></div>
          <nav class="srp-pager" id="srpPager" aria-label="Result pages"></nav>

          <div class="srp-feedback" id="srpFeedback">
            <span class="srp-feedback__ic">${NB.icon('chat')}</span>
            <div class="srp-feedback__text">
              <b>Did you find what you were looking for?</b>
              <small>Your answer trains NearBuy’s search ranking for nearby shops.</small>
            </div>
            <div class="srp-feedback__btns">
              <button class="btn btn--ghost btn--sm" type="button" data-fb="yes">${NB.icon('check')} Yes</button>
              <button class="btn btn--ghost btn--sm" type="button" data-fb="no">No</button>
            </div>
          </div>
          <form class="srp-feedback__form" id="srpFeedbackForm" hidden>
            <label for="srpFeedbackText"><b>Tell us what was missing</b><small>We file this as a support note for the search team — e.g. “missed the 110016 serviceability filter” or “wanted ‘Himalaya’ brand”.</small></label>
            <textarea id="srpFeedbackText" required minlength="10" rows="2" placeholder="What were you trying to find? (min 10 characters)"></textarea>
            <div class="srp-feedback__form-foot">
              <button class="btn btn--ghost btn--sm" type="button" id="srpFeedbackCancel">Cancel</button>
              <button class="btn btn--primary btn--sm" type="submit">${NB.icon('chat')} Send feedback</button>
            </div>
          </form>
        </div>
      </div>

      <div class="srp-compare-tray" id="srpCompareTray" hidden aria-label="Compare tray">
        <div class="srp-compare-tray__thumbs" id="srpCompareThumbs"></div>
        <div class="srp-compare-tray__meta"><b>Compare</b><small><span id="srpCompareN">0</span>/${MAX_COMPARE} selected</small></div>
        <button class="btn btn--ghost btn--sm" id="srpCompareClear" type="button">Clear</button>
        <button class="btn btn--primary btn--sm" id="srpCompareOpen" type="button" disabled>Compare ${NB.icon('arrowRight')}</button>
      </div>`;

    return {
      title: heading,
      html,
      after(root) {
        if (state.q) { const input = NB.$('#searchInput'); if (input) input.value = state.q; }

        const grid = NB.$('#srpRows', root);
        const count = NB.$('#srpCount', root);
        const meta = NB.$('#srpMeta', root);
        const pager = NB.$('#srpPager', root);
        const empty = NB.$('#srpEmpty', root);
        const chipsHost = NB.$('#srpActiveChips', root);
        const form = NB.$('#srpFilterForm', root);
        const tray = NB.$('#srpCompareTray', root);
        const thumbsHost = NB.$('#srpCompareThumbs', root);
        const compareN = NB.$('#srpCompareN', root);
        const compareOpen = NB.$('#srpCompareOpen', root);
        let data = null;
        let filterOptionsFilled = false;
        let adHtml = ''; // sponsored strip HTML, filled lazily from /offers

        /* ---------------------- URL serialization -------------------- */
        const hasActiveFilters = () => Boolean(
          state.category || state.brand || state.minPrice || state.maxPrice ||
          state.rating || state.available || state.delivery || state.pickup || state.shop
        );

        /* -------------------------- chips ---------------------------- */
        function renderChips() {
          const entries = [];
          if (state.q) entries.push(['q', `“${state.q}”`]);
          if (state.category) entries.push(['category', cats.find((c) => c.slug === state.category)?.name || state.category]);
          if (state.brand) entries.push(['brand', state.brand]);
          if (state.minPrice || state.maxPrice) entries.push(['price', `₹${state.minPrice || 0} – ₹${state.maxPrice || 'any'}`]);
          if (state.rating) entries.push(['rating', `${state.rating}★ & above`]);
          if (state.available) entries.push(['available', 'In stock']);
          if (state.delivery) entries.push(['delivery', 'Home delivery']);
          if (state.pickup) entries.push(['pickup', 'Store pickup']);
          if (state.shop) entries.push(['shop', state.shop.replace(/-/g, ' ')]);
          chipsHost.innerHTML = entries.map(([key, label]) => `<button type="button" class="filter-chip" data-clear="${key}">${NB.esc(label)} ${NB.icon('close')}</button>`).join('');
        }

        function clearFilter(key) {
          if (key === 'price') { state.minPrice = ''; state.maxPrice = ''; }
          else if (key === 'available') state.available = false;
          else if (key === 'delivery') state.delivery = false;
          else if (key === 'pickup') state.pickup = false;
          else if (key in state) state[key] = '';
          state.page = 1;
          syncFormFromState();
          load();
        }

        /* form.reset() would restore the checked/selected attributes from
         * page load, so mirror the state explicitly instead. */
        const field = (name) => form.elements.namedItem(name);
        function syncFormFromState() {
          field('category').value = state.category;
          field('brand').value = state.brand;
          field('shop').value = state.shop;
          field('minPrice').value = state.minPrice;
          field('maxPrice').value = state.maxPrice;
          form.querySelectorAll('input[name=rating]').forEach((r) => { r.checked = r.value === state.rating; });
          field('available').checked = state.available;
          field('delivery').checked = state.delivery;
          field('pickup').checked = state.pickup;
        }

        /* ------------------------ skeleton --------------------------- */
        const showSkeleton = () => {
          grid.innerHTML = `<div class="srp-skl-list">${Array.from({ length: 6 }).map(() => '<div class="srp-skl-row"><div class="skl srp-skl-row__img"></div><div class="srp-skl-row__lines"><div class="skl skl--line"></div><div class="skl skl--line"></div><div class="skl skl--line skl--short"></div></div></div>').join('')}</div>`;
          empty.innerHTML = '';
          pager.innerHTML = '';
        };

        /* --------------------- sponsored strip ----------------------- */
        async function loadAd() {
          try {
            const offers = await NB.api('/offers');
            const offer = (offers.offers || []).find((o) => o.type === 'percent' || o.type === 'fixed') || (offers.offers || [])[0];
            if (!offer) return;
            adHtml = `<aside class="srp-ad" role="complementary" aria-label="Sponsored offer">
              <span class="srp-ad__tag">Sponsored</span>
              <div class="srp-ad__body">
                <b>${offer.shop ? NB.esc(offer.shop.name) : 'NearBuy partners'} — ${NB.esc(offer.title)}</b>
                <small>${NB.esc(offer.savingsLabel || offer.description || '')}${offer.shop ? '' : ' · all participating shops'} · code <code>${NB.esc(offer.code)}</code></small>
              </div>
              <a class="btn btn--ghost btn--sm" href="#/offers">View offer ${NB.icon('arrowRight')}</a>
            </aside>`;
            if (state.page === 1) paintAd();
          } catch { adHtml = ''; }
        }
        function paintAd() {
          if (!adHtml || state.page !== 1) return;
          const rows = NB.$$('.srp-row', grid);
          if (!rows.length) return;
          const host = document.createElement('div');
          host.innerHTML = adHtml;
          const ad = host.firstElementChild;
          if (rows.length > 4) rows[3].insertAdjacentElement('afterend', ad);
          else rows[rows.length - 1].insertAdjacentElement('afterend', ad);
        }

        /* ---------------------- card rendering ----------------------- */
        function specBullets(p) {
          const raw = [...(p.specs || []), ...(p.highlights || [])];
          const seen = new Set();
          const bullets = [];
          for (const item of raw) {
            const s = String(item || '').trim();
            if (!s || seen.has(s.toLowerCase())) continue;
            seen.add(s.toLowerCase());
            bullets.push(s);
            if (bullets.length >= 3) break;
          }
          if (!bullets.length && (p.packSize || p.unit)) bullets.push(p.packSize || p.unit);
          return bullets;
        }

        function card(p) {
          const discount = p.discount || 0;
          const bullets = specBullets(p);
          const assured = Boolean(p.shop && p.shop.verified);
          const hot = discount >= 40;
          const stockCls = !p.available ? 'srp-stock--out' : p.lowStock ? 'srp-stock--low' : 'srp-stock--ok';
          const stockTxt = !p.available ? 'Out of stock' : p.lowStock ? `Only ${fmtN(p.stock)} left — order soon` : 'In stock';
          const checked = inCompare(p.id) ? 'checked' : '';
          const priceBlock = `<b>${NB.money(p.price)}</b>${p.mrp > p.price ? `<s>${NB.money(p.mrp)}</s>` : ''}${discount ? `<span class="srp-off">${discount}% off</span>` : ''}`;
          return `<article class="srp-row ${p.available ? '' : 'is-soldout'}" data-srp-card="${NB.esc(p.id)}">
            <div class="srp-row__media">
              <a href="#/product/${encodeURIComponent(p.id)}" class="srp-row__imglink" tabindex="-1" aria-hidden="true">${NB.productArt(p, 'srp-art')}</a>
              <button class="wish-btn srp-wish" data-wish="${encodeURIComponent(p.id)}" aria-label="Toggle wishlist for ${NB.esc(p.name)}" aria-pressed="false">${NB.icon('heart')}</button>
              ${discount >= 15 ? `<span class="srp-row__ribbon">${discount}% OFF</span>` : ''}
            </div>
            <div class="srp-row__body">
              <div class="srp-row__brandline">
                <span class="srp-brand">${NB.esc(p.brand || 'NearBuy')}</span>
                ${p.unit ? `<span class="srp-unit">${NB.esc(p.unit)}</span>` : ''}
                ${assured ? `<span class="srp-assured" title="Shop verified by NearBuy — GST and quality checks">${NB.icon('verified')} NearBuy Assured</span>` : ''}
                ${hot ? '<span class="badge badge--warn">Hot deal</span>' : ''}
              </div>
              <a class="srp-row__title" href="#/product/${encodeURIComponent(p.id)}">${NB.esc(p.name)}</a>
              <div class="srp-row__rating"><span class="srp-rate">${NB.icon('star')} ${Number(p.rating || 0).toFixed(1)}</span><span class="srp-ratecount">(${fmtN(p.reviewCount)} ratings)</span></div>
              ${bullets.length ? `<ul class="srp-specs">${bullets.map((b) => `<li>${NB.esc(b)}</li>`).join('')}</ul>` : ''}
              <div class="srp-row__shop">
                ${p.shop ? `<a href="#/shop/${encodeURIComponent(p.shop.slug)}">${NB.esc(p.shop.emoji || '')} ${NB.esc(p.shop.name)}</a>` : ''}
                ${p.distanceKm != null ? `<span class="srp-dist">${NB.icon('location')} ${p.distanceKm} km away</span>` : ''}
                ${p.shop ? (p.shop.isOpen === false ? '<span class="srp-closed">Closed now</span>' : '<span class="srp-open">Open</span>') : ''}
              </div>
              <div class="srp-row__fulfil">
                ${p.deliveryEnabled ? `<span>${NB.icon('truck')} Delivery</span>` : ''}
                ${p.pickupEnabled ? `<span>${NB.icon('store')} Pickup</span>` : ''}
                ${p.returnDays ? `<span>${NB.icon('returnArrow')} ${p.returnDays}-day returns</span>` : '<span class="srp-muted">Non-returnable</span>'}
              </div>
              <label class="srp-compare"><input type="checkbox" data-compare="${NB.esc(p.id)}" ${checked}/><span class="srp-compare__box" aria-hidden="true">${NB.icon('check')}</span> Add to Compare</label>
            </div>
            <div class="srp-row__buy">
              <div class="srp-price">${priceBlock}</div>
              <small class="srp-tax">inclusive of all taxes</small>
              ${p.mrp > p.price ? `<span class="srp-save">You save ${NB.money(p.mrp - p.price)}</span>` : ''}
              <span class="srp-stock ${stockCls}">${stockTxt}</span>
              ${p.available
                ? `<button class="add-btn" data-add="${encodeURIComponent(p.id)}" aria-label="Add ${NB.esc(p.name)} to cart">${NB.icon('plus')}<span>Add</span></button>`
                : `<button class="add-btn add-btn--wait" data-notify="${encodeURIComponent(p.id)}">Notify me</button>`}
            </div>
          </article>`;
        }

        /* ------------------------- pager ----------------------------- */
        function pagerRange(current, total) {
          if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
          const pages = new Set([1, total, current - 1, current, current + 1]);
          const sorted = [...pages].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
          const out = [];
          let prev = 0;
          for (const n of sorted) { if (n - prev > 1) out.push('…'); out.push(n); prev = n; }
          return out;
        }
        function renderPager(pages) {
          if (pages <= 1) { pager.innerHTML = ''; return; }
          const btn = (n, label, opts = {}) => `<button type="button" class="srp-pager__btn ${opts.active ? 'is-active' : ''}" data-page="${n}" ${opts.disabled ? 'disabled' : ''} ${opts.active ? 'aria-current="page"' : ''} aria-label="${opts.aria || 'Page ' + n}">${label}</button>`;
          pager.innerHTML =
            btn(Math.max(1, state.page - 1), `${NB.icon('chevronLeft')} Prev`, { disabled: state.page <= 1, aria: 'Previous page' }) +
            pagerRange(state.page, pages).map((n) => n === '…' ? '<span class="srp-pager__gap" aria-hidden="true">…</span>' : btn(n, String(n), { active: n === state.page })).join('') +
            btn(Math.min(pages, state.page + 1), `Next ${NB.icon('chevronRight')}`, { disabled: state.page >= pages, aria: 'Next page' });
        }

        /* ----------------------- loader ------------------------------ */
        async function load() {
          showSkeleton();
          syncUrl();
          const params = {
            q: state.q, category: state.category, shop: state.shop, brand: state.brand,
            minPrice: state.minPrice, maxPrice: state.maxPrice, rating: state.rating,
            available: state.available ? '1' : '', delivery: state.delivery ? '1' : '', pickup: state.pickup ? '1' : '',
            sort: state.sort, page: state.page, limit: PAGE_SIZE
          };
          try {
            data = await NB.api(`/products?${NB.qs(params)}&${NB.locationQuery()}`);
            if (data.pages && state.page > data.pages) { state.page = data.pages; return load(); }
            if (!filterOptionsFilled && Array.isArray(data.brands)) {
              const brandSelect = NB.$('#srpBrand', root);
              brandSelect.innerHTML = '<option value="">All brands</option>' + data.brands
                .map((b) => `<option value="${NB.esc(String(b).toLowerCase())}">${NB.esc(b)}</option>`).join('');
              brandSelect.value = state.brand;
              const shopSelect = NB.$('#srpShop', root);
              shopSelect.innerHTML = '<option value="">All nearby shops</option>' + (data.shops || [])
                .map((s) => `<option value="${NB.esc(s.slug)}">${NB.esc((s.emoji ? s.emoji + ' ' : '') + s.name)}</option>`).join('');
              shopSelect.value = state.shop;
              filterOptionsFilled = true;
            }
            const total = Number(data.total || 0);
            const from = total ? (state.page - 1) * PAGE_SIZE + 1 : 0;
            const to = Math.min(total, state.page * PAGE_SIZE);
            meta.textContent = total
              ? `Showing ${fmtN(from)}–${fmtN(to)} of ${fmtN(total)} result${total === 1 ? '' : 's'}${state.q ? ` for “${state.q}”` : ''} · priced live from nearby shops`
              : `No results${state.q ? ` for “${state.q}”` : ''}`;
            count.innerHTML = total
              ? `<b>${fmtN(total)}</b> ${total === 1 ? 'product' : 'products'} from ${fmtN(new Set(data.products.map((p) => p.shop && p.shop.id)).size)} nearby shop${new Set(data.products.map((p) => p.shop && p.shop.id)).size === 1 ? '' : 's'}`
              : 'Nothing matched';
            grid.innerHTML = data.products.map(card).join('');
            paintAd();
            renderChips();
            renderPager(Number(data.pages || 1));
            if (!data.products.length) {
              empty.innerHTML = `<div class="srp-empty">
                <span class="srp-empty__ic">${NB.icon('search')}</span>
                <h2>${state.q ? `No matches for “${NB.esc(state.q)}”` : 'No products match those filters'}</h2>
                <p>Try a broader term, check the spelling, or drop a filter or two. We only show shops that deliver to your area.</p>
                ${hasActiveFilters() ? '<button class="btn btn--primary" id="srpEmptyClear" type="button">Clear all filters</button>' : ''}
                <div class="srp-empty__cats">${cats.slice(0, 8).map((c) => `<a class="chip" href="#/search?category=${encodeURIComponent(c.slug)}">${NB.icon(NB.categoryIcon(c.slug))} ${NB.esc(c.name)}</a>`).join('')}</div>
              </div>`;
              const clearBtn = NB.$('#srpEmptyClear', empty);
              if (clearBtn) clearBtn.addEventListener('click', () => NB.$('#srpClearAll', root).click());
            }
          } catch (err) {
            grid.innerHTML = '';
            count.textContent = 'Could not load results';
            meta.textContent = 'Search failed';
            empty.innerHTML = NB.errorView(err);
            const retry = NB.$('#retryView', empty); if (retry) retry.addEventListener('click', load);
          }
        }

        /* ------------------- compare tray + modal ------------------- */
        function renderTray() {
          const list = compareList();
          tray.hidden = list.length === 0;
          thumbsHost.innerHTML = list.map((p) => `<span class="srp-compare-thumb" title="${NB.esc(p.name)}">${p.imageUrl ? `<img src="${NB.esc(p.imageUrl)}" alt="${NB.esc(p.name)}"/>` : `<span aria-hidden="true">${NB.esc(p.emoji || '🛍️')}</span>`}<button type="button" data-compare-remove="${NB.esc(p.id)}" aria-label="Remove ${NB.esc(p.name)} from compare">${NB.icon('close')}</button></span>`).join('');
          compareN.textContent = String(list.length);
          compareOpen.disabled = list.length < 2;
        }
        function toggleCompare(p, checked) {
          let list = compareList();
          if (checked) {
            if (list.length >= MAX_COMPARE) {
              NB.toast(`You can compare up to ${MAX_COMPARE} products. Remove one to add another.`, 'warn');
              return false;
            }
            if (!list.some((x) => x.id === p.id)) list = [...list, compareSnapshot(p)];
            NB.toast('Added to compare tray', 'success');
          } else {
            list = list.filter((x) => x.id !== p.id);
          }
          saveCompare(list);
          renderTray();
          return true;
        }
        function openCompareModal() {
          const list = compareList();
          if (list.length < 2) return;
          const best = {
            price: Math.min(...list.filter((p) => p.available).map((p) => p.price).concat([Infinity])),
            discount: Math.max(...list.map((p) => p.discount || 0)),
            rating: Math.max(...list.map((p) => Number(p.rating) || 0))
          };
          const deliveryLabel = (p) => [p.deliveryEnabled ? 'Delivery' : '', p.pickupEnabled ? 'Pickup' : ''].filter(Boolean).join(' + ') || 'Not available';
          const row = (label, fn, cls = '') => `<tr class="${cls}"><th scope="row">${label}</th>${list.map((p) => `<td>${fn(p)}</td>`).join('')}</tr>`;
          const body = `<div class="compare-table-wrap"><table class="compare-table srp-compare-table">
            <thead><tr><th scope="col">Spec</th>${list.map((p) => `<th scope="col">
                <div class="srp-cmp-prod">
                  <button class="icon-btn srp-cmp-remove" data-compare-remove="${NB.esc(p.id)}" aria-label="Remove ${NB.esc(p.name)} from compare">${NB.icon('close')}</button>
                  <a href="#/product/${encodeURIComponent(p.id)}">${p.imageUrl ? `<img src="${NB.esc(p.imageUrl)}" alt="${NB.esc(p.name)}"/>` : `<span class="srp-cmp-emoji">${NB.esc(p.emoji || '🛍️')}</span>`}</a>
                  <a class="srp-cmp-name" href="#/product/${encodeURIComponent(p.id)}">${NB.esc(p.name)}</a>
                  <small>${NB.esc(p.brand || '')}</small>
                </div></th>`).join('')}</tr></thead>
            <tbody>
              ${row('Price', (p) => `<b>${NB.money(p.price)}</b> ${p.mrp > p.price ? `<s class="srp-muted">${NB.money(p.mrp)}</s>` : ''}${p.price === best.price && p.available ? '<span class="srp-best">Lowest price</span>' : ''}`, 'srp-cmp-price')}
              ${row('Discount', (p) => p.discount ? `${p.discount}% off${p.discount === best.discount ? ' <span class="srp-best">Best</span>' : ''}` : '—')}
              ${row('Rating', (p) => `${NB.icon('star')} ${Number(p.rating || 0).toFixed(1)} · ${fmtN(p.reviewCount)} ratings${Number(p.rating) === best.rating ? ' <span class="srp-best">Top rated</span>' : ''}`)}
              ${row('Shop', (p) => p.shop ? `<a href="#/shop/${encodeURIComponent(p.shop.slug)}">${NB.esc(p.shop.name)}</a>` : '—')}
              ${row('Distance', (p) => p.distanceKm != null ? `${p.distanceKm} km` : '—')}
              ${row('Fulfilment', deliveryLabel)}
              ${row('Returns', (p) => p.returnDays ? `${p.returnDays}-day returns` : 'Non-returnable')}
              ${row('Stock', (p) => p.available ? (p.stock > 0 ? `In stock (${fmtN(p.stock)})` : 'In stock') : 'Out of stock')}
              ${row('Pack size', (p) => NB.esc(p.packSize || p.unit || '—'))}
            </tbody></table></div>
            <p class="srp-cmp-note">${NB.icon('info')} Prices and stock are live from each shop. “Lowest price” only considers items in stock.</p>`;
          NB.modal({
            title: `Compare ${list.length} products`,
            body,
            footer: `<button class="btn btn--ghost" id="srpCmpClear" type="button">Clear tray</button><button class="btn btn--primary" data-close="1" type="button">Done</button>`,
            className: 'modal--wide',
            onMount(rootEl, close) {
              NB.$$('[data-compare-remove]', rootEl).forEach((btn) => btn.addEventListener('click', () => {
                saveCompare(compareList().filter((x) => x.id !== btn.dataset.compareRemove));
                renderTray();
                syncCompareCheckboxes();
                NB.toast('Removed from compare', 'info');
                close();
              }));
              const clear = NB.$('#srpCmpClear', rootEl);
              if (clear) clear.addEventListener('click', () => { saveCompare([]); renderTray(); syncCompareCheckboxes(); close(); });
            }
          });
        }
        function syncCompareCheckboxes() {
          NB.$$('input[data-compare]', root).forEach((input) => { input.checked = inCompare(input.dataset.compare); });
        }

        /* ------------------- event wiring --------------------------- */
        root.addEventListener('click', (e) => {
          const clear = e.target.closest('[data-clear]');
          if (clear) { e.preventDefault(); clearFilter(clear.dataset.clear); return; }
          const sortBtn = e.target.closest('[data-sort]');
          if (sortBtn) {
            if (state.sort !== sortBtn.dataset.sort) {
              state.sort = sortBtn.dataset.sort; state.page = 1;
              NB.$$('.srp-sort__btn', root).forEach((b) => {
                const on = b.dataset.sort === state.sort;
                b.classList.toggle('is-active', on);
                b.setAttribute('aria-pressed', String(on));
              });
              load();
            }
            return;
          }
          const pageBtn = e.target.closest('[data-page]');
          if (pageBtn && !pageBtn.disabled) {
            const target = Number(pageBtn.dataset.page);
            if (Number.isFinite(target) && target !== state.page) {
              state.page = target;
              load();
              NB.$('#srpTop', root)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            return;
          }
          const removeBtn = e.target.closest('[data-compare-remove]');
          if (removeBtn && tray.contains(removeBtn)) {
            saveCompare(compareList().filter((x) => x.id !== removeBtn.dataset.compareRemove));
            renderTray(); syncCompareCheckboxes(); return;
          }
          const rangeChip = e.target.closest('.srp-range-chip');
          if (rangeChip) {
            state.minPrice = rangeChip.dataset.min || '';
            state.maxPrice = rangeChip.dataset.max || '';
            field('minPrice').value = state.minPrice;
            field('maxPrice').value = state.maxPrice;
            state.page = 1;
            load();
            return;
          }
          const fb = e.target.closest('[data-fb]');
          if (fb) {
            e.preventDefault();
            const box = NB.$('#srpFeedback', root);
            if (fb.dataset.fb === 'yes') {
              box.innerHTML = `<span class="srp-feedback__ic srp-feedback__ic--ok">${NB.icon('checkCircle')}</span><div class="srp-feedback__text"><b>Glad we could help.</b><small>Thanks — this is filed against “${NB.esc(state.q || 'all products')}”.</small></div>`;
            } else {
              box.hidden = true;
              const f = NB.$('#srpFeedbackForm', root);
              f.hidden = false;
              NB.$('#srpFeedbackText', root).focus();
            }
            return;
          }
        });

        root.addEventListener('change', (e) => {
          const input = e.target.closest('input[data-compare]');
          if (!input || !data) return;
          const p = data.products.find((x) => x.id === input.dataset.compare);
          if (!p) { input.checked = inCompare(input.dataset.compare); return; }
          const ok = toggleCompare(p, input.checked);
          if (!ok) input.checked = false;
        });

        form.addEventListener('submit', (e) => {
          e.preventDefault();
          state.category = field('category').value;
          state.brand = field('brand').value;
          state.shop = field('shop').value;
          state.minPrice = field('minPrice').value;
          state.maxPrice = field('maxPrice').value;
          state.rating = (new FormData(form).get('rating')) || '';
          state.available = field('available').checked;
          state.delivery = field('delivery').checked;
          state.pickup = field('pickup').checked;
          state.page = 1;
          load();
        });

        NB.$('#srpClearAll', root).addEventListener('click', () => {
          Object.assign(state, { category: '', brand: '', shop: '', minPrice: '', maxPrice: '', rating: '', available: false, delivery: false, pickup: false, page: 1 });
          syncFormFromState();
          load();
        });
        NB.$('#srpFiltersToggle', root)?.addEventListener('click', () => NB.$('#srpRail', root)?.classList.toggle('is-open'));

        NB.$('#srpCopyLink', root)?.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(window.location.href); NB.toast('Search link copied to clipboard', 'success'); }
          catch { NB.toast('Copy this address from the browser bar to share the search.', 'info'); }
        });

        NB.$('#srpFeedbackCancel', root)?.addEventListener('click', () => {
          NB.$('#srpFeedbackForm', root).hidden = true;
          NB.$('#srpFeedback', root).hidden = false;
        });

        NB.$('#srpFeedbackForm', root)?.addEventListener('submit', async (e) => {
          e.preventDefault();
          const ta = NB.$('#srpFeedbackText', root);
          const details = ta.value.trim();
          if (details.length < 10) { NB.toast('Add a little more detail (min 10 characters).', 'warn'); return; }
          const btn = e.submitter;
          if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
          const user = NB.state.user;
          try {
            await NB.api('/enquiry', {
              body: {
                name: (user && user.name) || 'Guest shopper',
                contact: (user && user.email) || 'not-provided',
                topic: `Search feedback: ${state.q || 'all products'}`.slice(0, 60),
                message: `Search feedback for “${state.q || 'all products'}” (page ${state.page}, sort ${state.sort}).\n\n${details}`.slice(0, 2000)
              }
            });
            NB.$('#srpFeedbackForm', root).hidden = true;
            const box = NB.$('#srpFeedback', root);
            box.hidden = false;
            box.innerHTML = `<span class="srp-feedback__ic srp-feedback__ic--ok">${NB.icon('checkCircle')}</span><div class="srp-feedback__text"><b>Thanks — feedback logged.</b><small>The search team reviews these notes weekly.</small></div>`;
          } catch (err) {
            NB.toast(err.message || 'Could not send feedback right now.', 'error');
            if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
          }
        });

        tray?.addEventListener('click', (e) => {
          if (e.target.closest('#srpCompareClear')) { saveCompare([]); renderTray(); syncCompareCheckboxes(); return; }
          if (e.target.closest('#srpCompareOpen')) { openCompareModal(); }
        });

        renderTray();
        loadAd();
        load();
      }
    };
  });
})();
