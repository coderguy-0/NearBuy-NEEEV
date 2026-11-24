/* ============================================================================
   NearBuy public website — shared behaviour
   Header dropdowns · mobile drawer · site search · location prompt · forms ·
   shop filters and pagination · reveal on scroll · motion preference.
   Everything talks to the same Node API the storefront uses. Nothing here
   simulates a result: a form only reports success when the server stored it.
   ========================================================================== */
(function () {
  'use strict';

  window.__nbSiteReady = true;
  var root = document.documentElement;
  var reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  var MOTION_KEY = 'nearbuy.motion';
  var LOCATION_KEY = 'nb.location';

  /* ------------------------------------------------------------- helpers -- */
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(paise) {
    var n = Number(paise || 0) / 100;
    return '₹' + (n % 1 === 0 ? n.toFixed(0) : n.toFixed(2));
  }
  function store(key, value) {
    try {
      if (value === undefined) return JSON.parse(window.localStorage.getItem(key) || 'null');
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch (err) { /* private mode */ }
    return null;
  }
  window.NBSite = { money: money, esc: esc, store: store };
var CAT_ICON = {
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

  /* success panels sit beside the card that holds a form, so walk outwards
     instead of assuming the panel is a direct sibling of the <form> */
  function nearestPanel(el, selector) {
    var scope = el ? el.parentElement : null;
    while (scope && scope !== document.body) {
      var found = scope.querySelector(selector);
      if (found) return found;
      scope = scope.parentElement;
    }
    return null;
  }

  function catIcon(slug) {
    return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + (CAT_ICON[slug] || CAT_ICON.other) + '</svg>';
  }


  function toast(message, tone) {
    var stack = $('#toasts');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toasts';
      stack.className = 'toast-stack';
      stack.setAttribute('role', 'status');
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    var el = document.createElement('div');
    el.className = 'toast';
    if (tone) el.setAttribute('data-tone', tone);
    el.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-' + (tone === 'error' ? 'alert' : 'check') + '"/></svg><span>' + esc(message) + '</span>';
    stack.appendChild(el);
    window.setTimeout(function () {
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      el.style.transition = 'all .25s ease';
      window.setTimeout(function () { el.remove(); }, 280);
    }, 4200);
  }
  window.NBSite.toast = toast;

  function api(path, options) {
    var opts = options || {};
    var headers = { 'Accept': 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.method && opts.method !== 'GET') headers['X-NearBuy-Request'] = '1';
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      credentials: 'same-origin',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var error = new Error(data.error || data.message || 'That request could not be completed (' + res.status + ').');
          error.status = res.status;
          error.data = data;
          throw error;
        }
        return data;
      });
    });
  }
  window.NBSite.api = api;

  /* ------------------------------------------------------ motion control -- */
  function applyMotion(reduced, persist) {
    root.setAttribute('data-motion', reduced ? 'reduced' : 'full');
    var btn = $('#motionToggle');
    var label = $('#motionLabel');
    if (btn) {
      btn.setAttribute('aria-pressed', reduced ? 'true' : 'false');
      btn.setAttribute('title', reduced ? 'Motion is off — turn it back on' : 'Turn off scroll and hover animation');
    }
    if (label) label.textContent = reduced ? 'Motion reduced' : 'Reduce motion';
    if (persist) store(MOTION_KEY, reduced ? 'reduced' : 'full');
    if (!reduced) startReveal();
  }
  var storedMotion = store(MOTION_KEY);
  applyMotion(storedMotion === 'reduced' || (storedMotion !== 'full' && reduceMQ.matches), false);
  var motionBtn = $('#motionToggle');
  if (motionBtn) {
    motionBtn.addEventListener('click', function () {
      applyMotion(root.getAttribute('data-motion') !== 'reduced', true);
    });
  }
  var onSystemMotion = function (event) { if (!store(MOTION_KEY)) applyMotion(event.matches, false); };
  if (reduceMQ.addEventListener) reduceMQ.addEventListener('change', onSystemMotion);
  function prefersReduced() { return root.getAttribute('data-motion') === 'reduced'; }

  /* -------------------------------------------------------------- header -- */
  var header = $('.site-header');
  if (header) {
    var syncStuck = function () { header.classList.toggle('is-stuck', window.scrollY > 8); };
    syncStuck();
    window.addEventListener('scroll', syncStuck, { passive: true });
  }

  /* dropdowns: click, keyboard and hover-friendly */
  var dropdowns = $$('.nav__item--has-panel');
  function closeDropdowns(except) {
    dropdowns.forEach(function (item) {
      if (item === except) return;
      item.classList.remove('is-open');
      var trigger = $('[aria-expanded]', item);
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
  }
  dropdowns.forEach(function (item) {
    var trigger = $('.nav__link', item);
    var panel = $('.nav__panel', item);
    if (!trigger || !panel) return;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.addEventListener('click', function (event) {
      event.preventDefault();
      var open = !item.classList.contains('is-open');
      closeDropdowns(item);
      item.classList.toggle('is-open', open);
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        var first = $('a, button', panel);
        if (first) window.setTimeout(function () { first.focus(); }, 20);
      }
    });
    item.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && item.classList.contains('is-open')) {
        closeDropdowns(null);
        trigger.focus();
      }
    });
    item.addEventListener('focusout', function (event) {
      if (!item.contains(event.relatedTarget)) {
        item.classList.remove('is-open');
        trigger.setAttribute('aria-expanded', 'false');
      }
    });
  });
  document.addEventListener('click', function (event) {
    if (!event.target.closest || !event.target.closest('.nav__item--has-panel')) closeDropdowns(null);
  });

  /* mobile drawer */
  var drawer = $('#mobileMenu');
  var drawerToggle = $('#navToggle');
  function setDrawer(open) {
    if (!drawer) return;
    drawer.hidden = !open;
    drawer.classList.toggle('is-open', open);
    if (drawerToggle) {
      drawerToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      var use = drawerToggle.querySelector('use');
      if (use) use.setAttribute('href', open ? '#i-x' : '#i-menu');
    }
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) {
      var close = $('.mobile-menu__close', drawer);
      if (close) close.focus();
    } else if (drawerToggle) {
      drawerToggle.focus();
    }
  }
  if (drawerToggle && drawer) {
    drawerToggle.addEventListener('click', function () { setDrawer(drawer.hidden); });
    $$('[data-close-menu]', drawer).forEach(function (el) {
      el.addEventListener('click', function () { setDrawer(false); });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !drawer.hidden) setDrawer(false);
    });
  }

  /* -------------------------------------------------------------- search -- */
  var dialog = $('#siteSearch');
  var searchInput = dialog ? $('#siteSearchInput', dialog) : null;
  var searchBody = dialog ? $('#siteSearchBody', dialog) : null;
  var searchTimer = null;
  var searchSeq = 0;
  var lastFocus = null;

  function openSearch(prefill) {
    if (!dialog) return;
    lastFocus = document.activeElement;
    dialog.hidden = false;
    /* lock the page but keep the gutter so the layout behind does not jump */
    var gutter = window.innerWidth - document.documentElement.clientWidth;
    document.documentElement.style.scrollbarGutter = 'stable';
    if (gutter > 0) document.documentElement.style.paddingRight = gutter + 'px';
    document.body.style.overflow = 'hidden';
    if (searchInput) {
      searchInput.value = prefill || '';
      searchInput.focus();
      searchInput.select();
    }
    if (prefill) runSearch(prefill);
    else renderSearchIdle();
    document.addEventListener('keydown', onSearchKey);
  }
  function closeSearch() {
    if (!dialog || dialog.hidden) return;
    dialog.hidden = true;
    document.body.style.overflow = '';
    document.documentElement.style.scrollbarGutter = '';
    document.documentElement.style.paddingRight = '';
    document.removeEventListener('keydown', onSearchKey);
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus({ preventScroll: true });
  }
  function onSearchKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); closeSearch(); }
  }
  function renderSearchIdle() {
    if (!searchBody) return;
    searchBody.innerHTML = '<div class="search-dialog__group"><p class="search-dialog__label">Popular right now</p></div>' +
      '<div class="search-dialog__group">' + ['milk', 'basmati rice', 'notebook', 'paracetamol', 'bread'].map(function (term) {
        return '<a class="search-result" href="/shops/?q=' + encodeURIComponent(term) + '">' +
          '<span class="search-result__ico" aria-hidden="true"><svg class="ic" aria-hidden="true"><use href="#i-search"/></svg></span><span><b>' + esc(term) + '</b><small>Search the neighbourhood catalogue</small></span><span class="search-result__price"></span></a>';
      }).join('') + '</div>';
  }
  function renderSearchResults(data, term) {
    if (!searchBody) return;
    var products = data.products || [];
    var shops = data.shops || [];
    var categories = data.categories || [];
    if (!products.length && !shops.length && !categories.length) {
      searchBody.innerHTML = '<div class="search-dialog__empty">Nothing nearby matches “' + esc(term) + '”.<br>Try “milk”, “notebook” or browse <a href="/categories/" style="color:#ad4700;text-decoration:underline">every category</a>.</div>';
      return;
    }
    var html = '';
    if (products.length) {
      html += '<div class="search-dialog__group"><p class="search-dialog__label">Products</p>' + products.map(function (p) {
        return '<a class="search-result" href="/customer/#/product/' + encodeURIComponent(p.id) + '">' +
          '<span class="search-result__ico" aria-hidden="true">' + catIcon(p.categorySlug) + '</span>' +
          '<span><b>' + esc(p.name) + '</b><small>' + esc(p.shop && p.shop.name || '') + ' · ' + esc(p.unit || '') + '</small></span>' +
          '<span class="search-result__price">' + money(p.price) + '</span></a>';
      }).join('') + '</div>';
    }
    if (shops.length) {
      html += '<div class="search-dialog__group"><p class="search-dialog__label">Shops</p>' + shops.map(function (s) {
        return '<a class="search-result" href="/customer/#/shop/' + encodeURIComponent(s.slug) + '">' +
          '<span class="search-result__ico" aria-hidden="true">' + catIcon(s.categorySlug) + '</span>' +
          '<span><b>' + esc(s.name) + '</b><small>' + esc(s.locality || '') + ' · ' + esc(s.category || '') + '</small></span>' +
          '<span class="search-result__price">' + (s.rating ? '<svg class="ic search-result__star" aria-hidden="true"><use href="#i-star"/></svg>' + s.rating : '') + '</span></a>';
      }).join('') + '</div>';
    }
    if (categories.length) {
      html += '<div class="search-dialog__group"><p class="search-dialog__label">Categories</p>' + categories.map(function (c) {
        return '<a class="search-result" href="/customer/#/categories/' + encodeURIComponent(c.slug) + '">' +
          '<span class="search-result__ico" aria-hidden="true">' + catIcon(c.slug) + '</span>' +
          '<span><b>' + esc(c.name) + '</b><small>' + (c.productCount || 0) + ' products nearby</small></span><span></span></a>';
      }).join('') + '</div>';
    }
    html += '<div class="search-dialog__group"><a class="search-result" href="/shops/?q=' + encodeURIComponent(term) + '">' +
      '<span class="search-result__ico" aria-hidden="true"><svg class="ic" aria-hidden="true"><use href="#i-arrow"/></svg></span><span><b>See all results for “' + esc(term) + '”</b><small>Filter shops and products across every nearby store</small></span><span></span></a></div>';
    searchBody.innerHTML = html;
  }
  function runSearch(term) {
    if (!searchBody) return;
    term = String(term || '').trim();
    if (term.length < 2) { renderSearchIdle(); return; }
    var seq = ++searchSeq;
    var loc = store(LOCATION_KEY);
    var qs = '?q=' + encodeURIComponent(term) + (loc && loc.pincode ? '&pincode=' + encodeURIComponent(loc.pincode) : '');
    searchBody.innerHTML = '<div class="search-dialog__empty">Searching the neighbourhood…</div>';
    api('/api/customer/search/suggest' + qs).then(function (data) {
      if (seq !== searchSeq) return;
      renderSearchResults(data, term);
    }).catch(function (error) {
      if (seq !== searchSeq) return;
      searchBody.innerHTML = '<div class="search-dialog__empty">' + esc(error.message) + '</div>';
    });
  }
  if (dialog) {
    $$('[data-open-search]').forEach(function (btn) {
      btn.addEventListener('click', function (event) { event.preventDefault(); openSearch(); });
    });
    $$('[data-close-search]', dialog).forEach(function (el) { el.addEventListener('click', closeSearch); });
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        window.clearTimeout(searchTimer);
        var value = searchInput.value;
        searchTimer = window.setTimeout(function () { runSearch(value); }, 220);
      });
      searchInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          var term = searchInput.value.trim();
          if (!term) return;
          window.location.assign('/shops/?q=' + encodeURIComponent(term));
        }
      });
    }
    var form = $('#siteSearchForm', dialog);
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var term = searchInput ? searchInput.value.trim() : '';
        if (term) window.location.assign('/shops/?q=' + encodeURIComponent(term));
      });
    }
    document.addEventListener('keydown', function (event) {
      var tag = (event.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || event.target.isContentEditable;
      if ((event.key === '/' && !typing) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) {
        event.preventDefault();
        openSearch();
      }
    });
  }

  /* ------------------------------------------------------------ location -- */
  function locationLabel(loc) {
    if (!loc) return null;
    return loc.locality ? loc.locality + ' · ' + loc.pincode : loc.pincode;
  }
  function renderLocation() {
    var loc = store(LOCATION_KEY);
    var label = locationLabel(loc);
    $$('[data-location-label]').forEach(function (el) {
      el.textContent = label || 'Set your locality';
    });
    $$('[data-location-hint]').forEach(function (el) {
      el.textContent = loc ? 'Showing shops that deliver to ' + (loc.locality || loc.pincode) : 'Add your pincode to see what actually delivers to you.';
    });
  }
  renderLocation();
  window.addEventListener('storage', function (event) { if (event.key === LOCATION_KEY) renderLocation(); });

  var locateForm = $('#locateForm');
  if (locateForm) {
    var pinInput = $('#locatePincode', locateForm);
    var status = $('#locateStatus', locateForm);
    var submit = locateForm.querySelector('button[type="submit"]');
    function setStatus(text, tone) {
      if (!status) return;
      status.textContent = text || '';
      if (tone) status.setAttribute('data-tone', tone);
      else status.removeAttribute('data-tone');
    }
    locateForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var pincode = String(pinInput && pinInput.value || '').replace(/\D/g, '').slice(0, 6);
      if (!/^[1-9]\d{5}$/.test(pincode)) {
        setStatus('Enter a 6-digit Indian pincode, for example 110016.', 'warn');
        if (pinInput) pinInput.focus();
        return;
      }
      var label = submit ? submit.innerHTML : '';
      if (submit) { submit.disabled = true; submit.innerHTML = 'Checking…'; }
      setStatus('Checking which shops deliver to ' + pincode + '…');
      api('/api/customer/serviceability?pincode=' + encodeURIComponent(pincode)).then(function (data) {
        if (!data.serviceable) {
          setStatus('We are not live in ' + pincode + ' yet. Try Hauz Khas (110016) or Saket (110017).', 'warn');
          return;
        }
        var area = data.area || {};
        store(LOCATION_KEY, {
          pincode: pincode, locality: area.locality || '', city: area.city || 'New Delhi',
          lat: area.lat || null, lng: area.lng || null
        });
        renderLocation();
        setStatus(data.message + ' Opening nearby shops…', 'ok');
        window.setTimeout(function () { window.location.assign('/shops/?pincode=' + encodeURIComponent(pincode)); }, 650);
      }).catch(function (error) {
        setStatus(error.message, 'warn');
      }).then(function () {
        if (submit) { submit.disabled = false; submit.innerHTML = label; }
      });
    });
    $$('[data-area-pincode]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (pinInput) pinInput.value = btn.getAttribute('data-area-pincode');
        locateForm.dispatchEvent(new Event('submit', { cancelable: true }));
      });
    });
  }

  /* -------------------------------------------------------------- reveal -- */
  var revealObserver = null;
  function startReveal() {
    var els = $$('[data-reveal]');
    if (!els.length) return;
    if (!('IntersectionObserver' in window) || prefersReduced()) {
      els.forEach(function (el) { el.classList.add('is-in'); });
      return;
    }
    if (!revealObserver) {
      revealObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-in');
          revealObserver.unobserve(entry.target);
        });
      }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
    }
    els.forEach(function (el) { if (!el.classList.contains('is-in')) revealObserver.observe(el); });
  }
  startReveal();

  /* --------------------------------------------------------------- forms -- */
  var CONTACT_TOPICS = ['General enquiry', 'Order help', 'Returns & refunds', 'Selling on NearBuy', 'Delivery partner', 'Payments', 'Others'];

  function fieldWrap(input) { return input.closest('.field'); }
  function setFieldError(input, message) {
    var wrap = fieldWrap(input);
    if (!wrap) return;
    var error = wrap.querySelector('.field__error');
    wrap.classList.toggle('is-invalid', Boolean(message));
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (error) {
      error.textContent = message || '';
      error.hidden = !message;
    }
  }
  function setFormStatus(form, message, tone) {
    var status = form.querySelector('[data-form-status]');
    if (!status) return;
    status.hidden = !message;
    status.textContent = message || '';
    if (tone) status.setAttribute('data-tone', tone);
  }

  /* contact / enquiry — stored in the platform database, reviewed in Admin */
  $$('[data-enquiry-form]').forEach(function (form) {
    var nameEl = form.querySelector('[name="name"]');
    var contactEl = form.querySelector('[name="contact"]');
    var topicEl = form.querySelector('[name="topic"]');
    if (topicEl && form.getAttribute('data-topic')) topicEl.value = form.getAttribute('data-topic');
    var messageEl = form.querySelector('[name="message"]');
    var counter = form.querySelector('[data-count-for="message"]');
    var submit = form.querySelector('button[type="submit"]');
    var done = nearestPanel(form, '[data-enquiry-success]');
    var EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

    function digits(value) {
      var d = String(value).replace(/\D/g, '');
      if (d.length === 12 && d.slice(0, 2) === '91') d = d.slice(2);
      if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
      return d;
    }
    if (messageEl && counter) {
      var sync = function () { counter.textContent = messageEl.value.length + ' / 600'; };
      messageEl.addEventListener('input', sync);
      sync();
    }
    [nameEl, contactEl, topicEl, messageEl].forEach(function (input) {
      if (!input) return;
      input.addEventListener('input', function () { if (validate(input)) setFieldError(input, ''); });
      input.addEventListener('change', function () { if (validate(input)) setFieldError(input, ''); });
    });
    function validate(input) {
      if (!input) return false;
      var value = String(input.value || '').trim();
      if (input === nameEl) return value.length >= 2;
      if (input === contactEl) {
        if (!value) return false;
        return value.indexOf('@') > -1 ? EMAIL.test(value) : /^[6-9]\d{9}$/.test(digits(value));
      }
      if (input === topicEl) return CONTACT_TOPICS.indexOf(value) > -1;
      if (input === messageEl) return value.length >= 10;
      return true;
    }
    var MESSAGES = [
      [nameEl, 'Please enter your full name (at least 2 characters).'],
      [contactEl, 'Enter a valid email address or a 10-digit Indian mobile number.'],
      [topicEl, 'Choose the topic that fits best.'],
      [messageEl, 'Add a little more detail — at least 10 characters.']
    ];
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (submit && submit.disabled) return;
      var invalid = [];
      MESSAGES.forEach(function (pair) {
        var ok = validate(pair[0]);
        setFieldError(pair[0], ok ? '' : pair[1]);
        if (!ok) invalid.push(pair[0]);
      });
      if (invalid.length) {
        setFormStatus(form, invalid.length === 1 ? 'One field needs your attention before this can be sent.' : invalid.length + ' fields need your attention before this can be sent.', 'error');
        invalid[0].focus();
        return;
      }
      setFormStatus(form, '');
      var label = submit ? submit.innerHTML : '';
      if (submit) { submit.disabled = true; submit.innerHTML = 'Sending…'; }
      api('/api/customer/enquiry', {
        method: 'POST',
        body: {
          name: nameEl.value.trim().replace(/\s+/g, ' '),
          contact: contactEl.value.trim(),
          topic: topicEl.value,
          message: messageEl.value.trim()
        }
      }).then(function (data) {
        if (done) {
          var ref = done.querySelector('[data-enquiry-ref]');
          if (ref) ref.textContent = data.code || 'received';
          form.hidden = true;
          done.hidden = false;
          done.focus({ preventScroll: true });
          done.scrollIntoView({ behavior: prefersReduced() ? 'auto' : 'smooth', block: 'center' });
        } else {
          toast(data.message || 'Enquiry received.', 'ok');
        }
        form.reset();
        if (counter) counter.textContent = '0 / 600';
        MESSAGES.forEach(function (pair) { setFieldError(pair[0], ''); });
      }).catch(function (error) {
        setFormStatus(form, error.message + ' Nothing was sent — please try again.', 'error');
      }).then(function () {
        if (submit) { submit.disabled = false; submit.innerHTML = label; }
      });
    });
    var reset = nearestPanel(form, '[data-enquiry-again]');
    if (reset && done) {
      reset.addEventListener('click', function () {
        done.hidden = true;
        form.hidden = false;
        form.reset();
        if (counter) counter.textContent = '0 / 600';
        form.scrollIntoView({ behavior: prefersReduced() ? 'auto' : 'smooth', block: 'center' });
        if (nameEl) nameEl.focus();
      });
    }
  });

  /* seller / partner applications post to the same public API the portals use */
  $$('[data-seller-form]').forEach(function (form) {
    var submit = form.querySelector('button[type="submit"]');
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (submit && submit.disabled) return;
      var payload = {
        name: (form.querySelector('[name="name"]') || {}).value || '',
        email: (form.querySelector('[name="email"]') || {}).value || '',
        mobile: (form.querySelector('[name="mobile"]') || {}).value || '',
        password: (form.querySelector('[name="password"]') || {}).value || '',
        confirmPassword: (form.querySelector('[name="confirmPassword"]') || {}).value || '',
        businessName: (form.querySelector('[name="businessName"]') || {}).value || '',
        category: (form.querySelector('[name="category"]') || {}).value || '',
        shopType: (form.querySelector('[name="shopType"]') || {}).value || 'retail',
        terms: Boolean((form.querySelector('[name="terms"]') || {}).checked)
      };
      var local = [];
      if (String(payload.name).trim().length < 2) local.push(['name', 'Enter your full name.']);
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(payload.email).trim())) local.push(['email', 'Enter a valid email address.']);
      if (!/^[6-9]\d{9}$/.test(String(payload.mobile).replace(/\D/g, '').slice(-10))) local.push(['mobile', 'Enter a valid 10-digit mobile number.']);
      if (String(payload.password).length < 8) local.push(['password', 'Use at least 8 characters.']);
      if (payload.password !== payload.confirmPassword) local.push(['confirmPassword', 'The two passwords do not match.']);
      if (String(payload.businessName).trim().length < 2) local.push(['businessName', 'Enter your shop or business name.']);
      if (!payload.category) local.push(['category', 'Choose the category your shop sells in.']);
      if (!payload.terms) local.push(['terms', 'Accept the seller terms to continue.']);
      $$('.field', form).forEach(function (wrap) { wrap.classList.remove('is-invalid'); });
      if (local.length) {
        local.forEach(function (pair) {
          var input = form.querySelector('[name="' + pair[0] + '"]');
          if (input) setFieldError(input, pair[1]);
        });
        setFormStatus(form, local.length + (local.length === 1 ? ' field needs' : ' fields need') + ' your attention.', 'error');
        var first = form.querySelector('.field.is-invalid input, .field.is-invalid select');
        if (first) first.focus();
        return;
      }
      setFormStatus(form, '');
      var label = submit ? submit.innerHTML : '';
      if (submit) { submit.disabled = true; submit.innerHTML = 'Creating your account…'; }
      api('/api/customer/seller/register', { method: 'POST', body: payload }).then(function () {
        var done = nearestPanel(form, '[data-seller-success]');
        form.hidden = true;
        if (done) {
          done.hidden = false;
          done.focus({ preventScroll: true });
          done.scrollIntoView({ behavior: prefersReduced() ? 'auto' : 'smooth', block: 'center' });
        } else {
          toast('Application received. Operations will review it.', 'ok');
        }
      }).catch(function (error) {
        setFormStatus(form, error.message, 'error');
        if (error.data && error.data.field) {
          var input = form.querySelector('[name="' + error.data.field + '"]');
          if (input) { setFieldError(input, error.message); input.focus(); }
        }
      }).then(function () {
        if (submit) { submit.disabled = false; submit.innerHTML = label; }
      });
    });
  });

  /* -------------------------------------------------------- copy coupons -- */
  $$('[data-copy-code]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var code = btn.getAttribute('data-copy-code');
      var finish = function () {
        var label = btn.innerHTML;
        btn.innerHTML = 'Copied';
        toast('Code ' + code + ' copied. Paste it in the bag at checkout.', 'ok');
        window.setTimeout(function () { btn.innerHTML = label; }, 2200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(finish, function () { toast('Copy is blocked in this browser — the code is ' + code, 'error'); });
      } else {
        toast('The code is ' + code + ' — select it and copy manually.', 'ok');
      }
    });
  });

  /* -------------------------------------------------- shops page: filters -- */
  var shopsList = $('#shopsResults');
  if (shopsList) {
    var state = {
      q: '', category: '', sort: 'distance', open: '', delivery: '', pickup: '',
      pincode: '', page: 1
    };
    var countEl = $('#shopsCount');
    var pagerEl = $('#shopsPager');
    var titleEl = $('#shopsTitle');
    var filterForm = $('#shopsFilters');
    var emptyTpl = '<div class="empty-state"><h3>No shops match these filters</h3><p>Clear a filter or widen your search — the neighbourhood catalogue changes with each area.</p><button class="btn btn--ghost btn--sm" type="button" data-reset-filters>Clear all filters</button></div>';

    var params = new URLSearchParams(window.location.search);
    state.q = params.get('q') || '';
    state.category = params.get('category') || '';
    state.sort = params.get('sort') || 'distance';
    state.pincode = params.get('pincode') || '';
    state.open = params.get('open') === '1' ? '1' : '';
    state.delivery = params.get('delivery') === '1' ? '1' : '';
    state.pickup = params.get('pickup') === '1' ? '1' : '';
    state.page = Math.max(1, parseInt(params.get('page') || '1', 10) || 1);
    if (!state.pincode) {
      var savedLoc = store(LOCATION_KEY);
      if (savedLoc && savedLoc.pincode) state.pincode = savedLoc.pincode;
    }
    var qInput = $('#shopsQuery', filterForm || document);
    if (qInput) qInput.value = state.q;
    $$('[data-chip]').forEach(function (chip) {
      var key = chip.getAttribute('data-chip');
      var value = chip.getAttribute('data-value') || '';
      chip.setAttribute('aria-pressed', String(state[key] === value || (value === '' && !state[key])));
    });
    var sortSelect = $('#shopsSort', filterForm || document);
    if (sortSelect) sortSelect.value = state.sort;

    function syncUrl() {
      var next = new URLSearchParams();
      ['q', 'category', 'sort', 'open', 'delivery', 'pickup', 'pincode'].forEach(function (key) {
        if (state[key] && !(key === 'sort' && state[key] === 'distance')) next.set(key, state[key]);
      });
      if (state.page > 1) next.set('page', String(state.page));
      var qs = next.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
    }

    function shopCard(s) {
      var chips = [s.category].filter(Boolean).map(function (label) {
        return '<span class="shop-card__chip">' + esc(label) + '</span>';
      }).join('');
      var badges = '';
      if (s.verified) badges += '<span class="tag tag--green">Verified</span>';
      if (!s.isOpen) badges += '<span class="tag tag--muted">Closed</span>';
      return '<article class="shop-card" data-reveal>' +
        '<div class="shop-card__top">' +
          '<span class="shop-card__emoji" aria-hidden="true">' + catIcon(s.categorySlug) + '</span>' +
          '<div class="shop-card__title"><h3>' + esc(s.name) + '</h3><p>' + esc(s.locality || '') + ' · ' + esc(s.category || '') + '</p></div>' +
          '<div class="shop-card__badges">' + badges + '</div>' +
        '</div>' +
        '<div class="shop-card__body">' +
          '<div class="shop-card__stats">' +
            '<span class="shop-card__rating"><svg class="ic" aria-hidden="true"><use href="#i-star"/></svg>' + (s.rating || '—') + ' <em style="font-style:normal;font-weight:400;color:#5d6b80">(' + (s.reviewCount || 0) + ')</em></span>' +
            (s.distanceKm != null ? '<span><svg class="ic" aria-hidden="true"><use href="#i-pin"/></svg>' + s.distanceKm + ' km</span>' : '') +
            (s.prepMinutes ? '<span><svg class="ic" aria-hidden="true"><use href="#i-clock"/></svg>' + s.prepMinutes + ' min prep</span>' : '') +
            '<span>' + (s.productCount || 0) + ' products</span>' +
          '</div>' +
          '<div class="shop-card__chips">' + chips + (s.badge ? '<span class="shop-card__chip">' + esc(s.badge) + '</span>' : '') + '</div>' +
          '<div class="shop-card__foot">' +
            '<small>' + (s.deliveryEnabled ? 'Delivery from ' + money(s.deliveryFee) : 'Pickup only') + (s.pickupEnabled ? ' · pickup ' + (s.pickupFee ? money(s.pickupFee) : 'free') : '') + '</small>' +
            '<a class="shop-card__link" href="/customer/#/shop/' + encodeURIComponent(s.slug) + '">Visit shop <svg class="ic" aria-hidden="true"><use href="#i-arrow"/></svg></a>' +
          '</div>' +
        '</div>' +
      '</article>';
    }

    function render(list) {
      shopsList.innerHTML = list.map(shopCard).join('');
      $$('[data-reveal]', shopsList).forEach(function (el) { el.classList.add('is-in'); });
    }

    function load() {
      shopsList.setAttribute('aria-busy', 'true');
      if (!shopsList.children.length) {
        shopsList.innerHTML = Array.from({ length: 6 }).map(function () {
          return '<div class="skeleton skeleton-card" aria-hidden="true"></div>';
        }).join('');
      }
      var qs = new URLSearchParams();
      ['q', 'category', 'sort', 'open', 'delivery', 'pickup', 'pincode'].forEach(function (key) {
        if (state[key]) qs.set(key, state[key]);
      });
      qs.set('page', String(state.page));
      qs.set('limit', '12');
      api('/api/customer/shops?' + qs.toString()).then(function (data) {
        var shops = data.shops || [];
        if (!shops.length) {
          shopsList.innerHTML = emptyTpl;
          var resetBtn = $('[data-reset-filters]', shopsList);
          if (resetBtn) resetBtn.addEventListener('click', resetFilters);
        } else {
          render(shops);
        }
        if (countEl) {
          countEl.innerHTML = '<b>' + (data.total || 0) + '</b> ' + (data.total === 1 ? 'shop' : 'shops') +
            (state.q ? ' matching “' + esc(state.q) + '”' : ' in the network') +
            (state.pincode ? ' · serviceable to <b>' + esc(state.pincode) + '</b>' : '');
        }
        if (titleEl) {
          var cat = (data.categories || []).filter(function (c) { return c.slug === state.category; })[0];
          titleEl.textContent = cat ? cat.name + ' shops nearby' : state.q ? 'Shops matching “' + state.q + '”' : 'Every shop in the network';
        }
        renderPager(data.page, data.pages);
        syncUrl();
      }).catch(function (error) {
        shopsList.innerHTML = '<div class="empty-state"><h3>The shop list could not load</h3><p>' + esc(error.message) + '</p><button class="btn btn--ghost btn--sm" type="button" data-retry>Try again</button></div>';
        var retry = $('[data-retry]', shopsList);
        if (retry) retry.addEventListener('click', load);
      }).then(function () {
        shopsList.removeAttribute('aria-busy');
      });
    }

    function renderPager(page, pages) {
      if (!pagerEl) return;
      pages = pages || 1;
      if (pages <= 1) { pagerEl.innerHTML = ''; return; }
      var buttons = [];
      buttons.push('<button type="button" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + ' aria-label="Previous page">Previous</button>');
      for (var i = 1; i <= pages; i += 1) {
        if (pages > 7 && i > 2 && i < pages - 1 && Math.abs(i - page) > 1) {
          if (i === 3) buttons.push('<span aria-hidden="true" style="padding:0 4px">…</span>');
          continue;
        }
        buttons.push('<button type="button" data-page="' + i + '"' + (i === page ? ' aria-current="page"' : '') + '>' + i + '</button>');
      }
      buttons.push('<button type="button" data-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + ' aria-label="Next page">Next</button>');
      pagerEl.innerHTML = buttons.join('');
      $$('[data-page]', pagerEl).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var next = parseInt(btn.getAttribute('data-page'), 10);
          if (!next || next === state.page) return;
          state.page = next;
          load();
          var anchor = $('#shopsResults');
          if (anchor) anchor.scrollIntoView({ behavior: prefersReduced() ? 'auto' : 'smooth', block: 'start' });
        });
      });
    }

    function resetFilters() {
      state = { q: '', category: '', sort: 'distance', open: '', delivery: '', pickup: '', pincode: state.pincode, page: 1 };
      if (qInput) qInput.value = '';
      if (sortSelect) sortSelect.value = 'distance';
      $$('[data-chip]').forEach(function (chip) {
        chip.setAttribute('aria-pressed', String(!chip.getAttribute('data-value')));
      });
      load();
    }

    $$('[data-chip]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var key = chip.getAttribute('data-chip');
        var value = chip.getAttribute('data-value') || '';
        if (key === 'sort') {
          state.sort = value || 'distance';
        } else if (key === 'category') {
          state.category = state.category === value ? '' : value;
          $$('[data-chip="category"]').forEach(function (other) {
            other.setAttribute('aria-pressed', String(other.getAttribute('data-value') === state.category));
          });
          state.page = 1;
          load();
          return;
        } else {
          state[key] = state[key] === value ? '' : value;
        }
        chip.setAttribute('aria-pressed', String(state[key] === value));
        state.page = 1;
        load();
      });
    });
    if (sortSelect) {
      sortSelect.addEventListener('change', function () { state.sort = sortSelect.value; state.page = 1; load(); });
    }
    if (filterForm) {
      filterForm.addEventListener('submit', function (event) {
        event.preventDefault();
        state.q = qInput ? qInput.value.trim() : '';
        state.page = 1;
        load();
      });
    }
    /* filter as you type, but wait for a pause so we do not fire a request per key */
    if (qInput) {
      var searchTimer = 0;
      qInput.addEventListener('input', function () {
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(function () {
          var next = qInput.value.trim();
          if (next === state.q) return;
          state.q = next;
          state.page = 1;
          load();
        }, 320);
      });
    }
    var clearSearch = $('#shopsClearQuery');
    if (clearSearch) {
      clearSearch.addEventListener('click', function () {
        state.q = '';
        if (qInput) qInput.value = '';
        state.page = 1;
        load();
      });
    }
    var clearAll = $('[data-clear-filters]');
    if (clearAll) clearAll.addEventListener('click', resetFilters);
    var pinForm = $('#shopsPincodeForm');
    if (pinForm) {
      pinForm.addEventListener('submit', function (event) {
        event.preventDefault();
        var pin = String((pinForm.querySelector('[name="pincode"]') || {}).value || '').replace(/\D/g, '');
        var hint = $('#shopsPincodeStatus');
        if (!/^[1-9]\d{5}$/.test(pin)) {
          if (hint) hint.textContent = 'Enter a valid 6-digit pincode.';
          return;
        }
        if (hint) hint.textContent = 'Checking coverage…';
        api('/api/customer/serviceability?pincode=' + encodeURIComponent(pin)).then(function (data) {
          if (!data.serviceable) {
            if (hint) hint.textContent = 'No shops deliver to ' + pin + ' yet. Try 110016 or 110017.';
            return;
          }
          state.pincode = pin;
          state.page = 1;
          if (hint) hint.textContent = data.message;
          load();
        }).catch(function (error) { if (hint) hint.textContent = error.message; });
      });
    }
    load();
  }
})();
