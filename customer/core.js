/* NearBuy Customer Portal — core shell, router, API client and shared UI. */
(function () {
  'use strict';

  const NB = (window.NB = {});
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ------------------------------ utils ------------------------------ */
  NB.$ = $;
  NB.$$ = $$;
  NB.esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  NB.money = (paise, withDecimals) => {
    const n = Number(paise || 0) / 100;
    return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: withDecimals || n % 1 ? 2 : 0, minimumFractionDigits: 0 });
  };
  NB.date = (iso, opts) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-IN', opts || { day: 'numeric', month: 'short', year: 'numeric' });
  };
  NB.dateTime = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  NB.timeAgo = (iso) => {
    const diff = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(diff)) return '';
    if (diff < 60e3) return 'Just now';
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)} min ago`;
    if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} hr ago`;
    if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)} d ago`;
    return NB.date(iso);
  };
  NB.plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
  NB.slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  NB.debounce = (fn, wait) => { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); }; };
  NB.hash = (path) => { const h = '#' + (path.startsWith('/') ? path : '/' + path); if (location.hash === h) NB.render(); else location.hash = h; };
  NB.back = () => history.length > 1 ? history.back() : NB.hash('/');
  NB.qs = (obj) => Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  /* ----------------------------- icons ------------------------------ */
  const ICONS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
    location: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronRight: '<path d="m9 6 6 6-6 6"/>',
    chevronLeft: '<path d="m15 6-6 6 6 6"/>',
    cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.7 12.2a1.5 1.5 0 0 0 1.5 1.2h8.3a1.5 1.5 0 0 0 1.5-1.2L21 7H6"/>',
    bag: '<path d="M6 7h12l1 13H5L6 7Z"/><path d="M9 9V6a3 3 0 0 1 6 0v3"/>',
    heart: '<path d="M20.8 4.7a5.4 5.4 0 0 0-7.7 0L12 5.8l-1.1-1.1a5.4 5.4 0 0 0-7.7 7.7L12 21l8.8-8.6a5.4 5.4 0 0 0 0-7.7Z"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    map: '<path d="m9 18-6 3V6l6-3 6 3 6-3v15l-6 3-6-3Z"/><path d="M9 3v15M15 6v15"/>',
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 11v6M14 11v6"/>',
    arrowRight: '<path d="M4 12h16M14 6l6 6-6 6"/>',
    arrowLeft: '<path d="M20 12H4M10 6l-6 6 6 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7 12.8 12.8 0 0 0 .7 2.8 2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4 12.8 12.8 0 0 0 2.8.7 2 2 0 0 1 1.7 2Z"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
    headset: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><path d="M4 14h2v4H4a2 2 0 0 1-2-2v-1a1 1 0 0 1 1-1ZM20 14h-2v4h2a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1Z"/><path d="M18 18v1a3 3 0 0 1-3 3h-2"/>',
    package: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m3 7 9 5 9-5M12 12v10"/>',
    truck: '<path d="M1 5h13v11H1zM14 9h4l3 3v4h-7"/><circle cx="5.5" cy="18.5" r="1.8"/><circle cx="17.5" cy="18.5" r="1.8"/>',
    tag: '<path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
    percent: '<path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
    shield: '<path d="m12 2 8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4Z"/><path d="m9 12 2 2 4-4"/>',
    leaf: '<path d="M20 4C11 4 4 9 4 17c0 1 .3 2 .8 3 1-4 4-7 9-9-3.5 3-5.4 6-6 10 5 1 12-2 12-11V4Z"/>',
    milk: '<path d="M9 2h6v3l2 3v12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V8l2-3V2Z"/><path d="M7 11h10"/>',
    cup: '<path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z"/><path d="M17 9h1.5a2.5 2.5 0 0 1 0 5H17M7 3v2M11 3v2"/>',
    pen: '<path d="m16 3 5 5L8 21H3v-5L16 3Z"/><path d="m13 6 5 5"/>',
    book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4V4ZM20 4h-4a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h5V4Z"/>',
    plug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v5"/>',
    shirt: '<path d="m8 3-5 3 2 4 3-1v12h8V9l3 1 2-4-5-3-2 3h-4L8 3Z"/>',
    shoe: '<path d="M3 17h18v3H3zM3 17c0-3 1-4 4-4 2 0 3 1 5 1s2-4 4-4 5 3 5 7"/>',
    sparkle: '<path d="m12 2 2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6Z"/><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z"/>',
    home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    tool: '<path d="M14.7 6.3a5 5 0 0 0-6.4 6.4L3 18l3 3 5.3-5.3a5 5 0 0 0 6.4-6.4l-3 3-2.3-2.3 3-3Z"/>',
    cross: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3Z"/>',
    dumbbell: '<path d="M6 7v10M3 9v6M18 7v10M21 9v6M6 12h12"/>',
    gift: '<rect x="3" y="8" width="18" height="13" rx="2"/><path d="M3 12h18M12 8v13"/><path d="M12 8c-4 0-5-5-2-5 2 0 2 3 2 5ZM12 8c4 0 5-5 2-5-2 0-2 3-2 5Z"/>',
    bread: '<path d="M4 10c0-3 2-5 5-5h6c3 0 5 2 5 5s-2 4-2 6-1 5-3 5H9c-2 0-3-3-3-5s-2-3-2-6Z"/><path d="M9 10v10M15 10v10"/>',
    service: '<path d="m14 6 4 4L7 21H3v-4L14 6Z"/><path d="m12 8 4 4"/><circle cx="17" cy="5" r="2"/>',
    basket: '<path d="M3 9h18l-2 11H5L3 9Z"/><path d="m7 9 5-7 5 7M9 13v4M15 13v4"/>',
    store: '<path d="M3 9 5 3h14l2 6"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 11v10h14V11M9 21v-6h6v6"/>',
    creditCard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    wallet: '<path d="M20 7H4a2 2 0 0 1 0-4h14v4"/><path d="M4 7v12a2 2 0 0 0 2 2h14V7H4Z"/><path d="M16 13h2"/>',
    bank: '<path d="m3 9 9-6 9 6M5 9v9M19 9v9M9 9v9M15 9v9M3 21h18"/>',
    upi: '<path d="m7 3 5 9-5 9M13 3l5 9-5 9"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="m3 3 18 18M10.5 5.2A9.6 9.6 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.8M6.3 6.4A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 4.2-.9"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
    receipt: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2V3Z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    link: '<path d="M10 13.5a5 5 0 0 0 7.1.4l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7"/><path d="M14 10.5a5 5 0 0 0-7.1-.4l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/>',
    returnArrow: '<path d="M3 10h11a5 5 0 0 1 0 10H9"/><path d="m7 6-4 4 4 4"/>',
    chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3l2-4a8.5 8.5 0 1 1 16-4.5Z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    alert: '<path d="M10.3 3.2 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H10a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V10a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    print: '<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/>',
    camera: '<path d="M4 7h3l2-3h6l2 3h3v13H4V7Z"/><circle cx="12" cy="13" r="3.5"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
    scan: '<path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4"/><path d="M7 12h10"/>',
    pin: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/>',
    verified: '<path d="m12 2 2.4 2.1 3.2-.3.9 3.1 2.8 1.6-1.3 2.9 1.3 2.9-2.8 1.6-.9 3.1-3.2-.3L12 22l-2.4-2.1-3.2.3-.9-3.1-2.8-1.6 1.3-2.9L2.7 9l2.8-1.6.9-3.1 3.2.3L12 2Z"/><path d="m8.5 12 2.3 2.3 4.7-4.6"/>',
    leaf2: '<path d="M4 20C4 10 10 4 20 4c0 10-6 16-16 16Z"/><path d="M4 20 14 10"/>',
    rupee: '<path d="M6 3h12M6 8h12M6 3c6 0 8 2 8 5s-2 5-8 5h-2l8 8"/>',
    spark: '<path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/>'
  };
  NB.icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`;

  const CATEGORY_ICON = {
    groceries: 'basket', 'fruits-vegetables': 'leaf', 'dairy-products': 'milk', 'food-beverages': 'cup',
    'general-store': 'store', stationery: 'pen', books: 'book', electronics: 'plug',
    'mobile-accessories': 'phone', clothing: 'shirt', footwear: 'shoe', cosmetics: 'sparkle',
    'beauty-personal-care': 'heart', 'home-kitchen': 'home', hardware: 'tool', pharmacy: 'cross',
    'sports-fitness': 'dumbbell', 'toys-gifts': 'gift', bakery: 'bread', 'local-services': 'service'
  };
  NB.categoryIcon = (slug) => CATEGORY_ICON[slug] || 'grid';

  /* ------------------------------ API ------------------------------- */
  NB.api = async (path, opts = {}) => {
    const headers = { 'X-NearBuy-Request': '1' };
    if (!(opts.body instanceof FormData) && opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (NB.state.user && NB.state.user.csrf) headers['X-NearBuy-CSRF'] = NB.state.user.csrf;
    const res = await fetch('/api/customer' + path, {
      method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
      headers: { ...headers, ...(opts.headers || {}) },
      credentials: 'same-origin',
      body: opts.body === undefined ? undefined : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  };

  NB.partnerApi = async (path, opts = {}) => {
    const headers = { 'X-NearBuy-Request': '1' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (NB.partner && NB.partner.csrf) headers['X-NearBuy-CSRF'] = NB.partner.csrf;
    const res = await fetch('/api/partner' + path, {
      method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
      headers: { ...headers, ...(opts.headers || {}) },
      credentials: 'same-origin',
      body: opts.body === undefined ? undefined : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) { const e = new Error((data && data.error) || `Request failed (${res.status})`); e.status = res.status; e.data = data; throw e; }
    return data;
  };

  /* ---------------------------- state ------------------------------ */
  NB.state = {
    user: null,
    config: null,
    categories: [],
    counts: { cart: 0, wishlist: 0, unread: 0 },
    cart: null,
    location: null,
    booted: false,
    loading: true,
    lastRoute: null,
    offers: [],
    guestCart: []
  };

  const LS = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ } },
    del(key) { try { localStorage.removeItem(key); } catch { /* storage blocked */ } }
  };
  NB.storage = LS;

  function restoreLocal() {
    NB.state.location = LS.get('nb.location', null);
    NB.state.guestCart = Array.isArray(LS.get('nb.guestCart', [])) ? LS.get('nb.guestCart', []) : [];
  }
  NB.saveGuestCart = () => { LS.set('nb.guestCart', NB.state.guestCart); NB.renderCartCount(); };
  NB.guestCount = () => NB.state.guestCart.reduce((t, l) => t + (Number(l.qty) || 0), 0);

  NB.setLocation = (loc, silent) => {
    NB.state.location = loc;
    LS.set('nb.location', loc);
    renderLocation();
    if (!silent) { NB.toast(loc ? `Now showing shops near ${loc.locality || loc.pincode}` : 'Location cleared', 'success'); NB.render(); }
  };

  NB.locationQuery = () => {
    const l = NB.state.location;
    if (!l) return '';
    return NB.qs({ pincode: l.pincode, lat: l.lat, lng: l.lng, locality: l.locality, city: l.city });
  };

  /* --------------------------- toast/modal -------------------------- */
  NB.toast = (message, type = 'info', title) => {
    const root = $('#toasts');
    if (!root) return;
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.innerHTML = `<span class="toast__icon">${NB.icon(type === 'error' ? 'alert' : type === 'success' ? 'checkCircle' : type === 'warn' ? 'alert' : 'info')}</span>
      <div class="toast__text">${title ? `<b>${NB.esc(title)}</b>` : ''}<span>${NB.esc(message)}</span></div>
      <button class="toast__close" aria-label="Dismiss">${NB.icon('close')}</button>`;
    root.appendChild(el);
    const kill = () => { el.classList.add('is-out'); setTimeout(() => el.remove(), 250); };
    el.querySelector('.toast__close').addEventListener('click', kill);
    setTimeout(kill, type === 'error' ? 6500 : 4200);
  };

  NB.modal = ({ title, body, footer, className = '', onMount, onClose }) => {
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-backdrop" data-close="1"></div>
      <div class="modal ${className}" role="dialog" aria-modal="true" aria-label="${NB.esc(title)}">
        <div class="modal__head"><h2>${NB.esc(title)}</h2><button class="icon-btn" data-close="1" aria-label="Close">${NB.icon('close')}</button></div>
        <div class="modal__body">${body}</div>
        ${footer === false ? '' : `<div class="modal__foot">${footer || `<button class="btn btn--ghost" data-close="1">Close</button>`}</div>`}
      </div>`;
    const previousFocus = document.activeElement;
    root.hidden = false;
    document.documentElement.classList.add('no-scroll');
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      root.hidden = true;
      root.innerHTML = '';
      document.documentElement.classList.remove('no-scroll');
      document.removeEventListener('keydown', onKey);
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus({ preventScroll: true });
      if (onClose) onClose();
    };
    root.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close));
    const focusables = () => [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    if (onMount) onMount(root, close);
    const focusable = root.querySelector('.modal__body input, .modal__body select, .modal__body textarea, .modal__body button, .modal__foot .btn--primary, .modal__foot .btn--danger');
    if (focusable) setTimeout(() => focusable.focus(), 60);
    return { root, close };
  };

  NB.confirm = ({ title, message, confirmLabel = 'Confirm', danger, onConfirm }) => {
    NB.modal({
      title,
      body: `<p class="muted" style="margin:0;line-height:1.6">${NB.esc(message)}</p>`,
      footer: `<button class="btn btn--ghost" data-close="1">Keep it</button>
        <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" id="confirmYes">${NB.esc(confirmLabel)}</button>`,
      onMount(root, close) {
        $('#confirmYes', root).addEventListener('click', async () => {
          close();
          await onConfirm();
        });
      }
    });
  };

  NB.spinner = (label = 'Loading') => `<span class="spinner" aria-label="${NB.esc(label)}"></span>`;

  NB.skeleton = (kind = 'home') => {
    if (kind === 'detail') {
      return `<div class="wrap section"><div class="skl skl--line skl--title"></div><div class="detail-grid"><div class="skl skl--photo"></div>
        <div><div class="skl skl--line"></div><div class="skl skl--line skl--short"></div><div class="skl skl--line"></div>
        <div class="skl skl--block"></div><div class="skl skl--line skl--short"></div></div></div></div>`;
    }
    return `<div class="wrap section"><div class="skl skl--hero"></div><div class="skl-grid">
      ${Array.from({ length: 6 }).map(() => `<div class="skl-card"><div class="skl skl--photo-sm"></div><div class="skl skl--line"></div><div class="skl skl--line skl--short"></div><div class="skl skl--line"></div></div>`).join('')}
    </div></div>`;
  };

  /* --------------------------- DOM shell ---------------------------- */
  const LOGO = `<span class="brand__mark" aria-hidden="true">
      <svg viewBox="0 0 44 44" fill="none"><rect width="44" height="44" rx="13" fill="url(#nbg)"/>
      <path d="M22 10c-5 0-9 3.7-9 8.5 0 6.2 7.4 13.2 8.5 14.2.3.2.7.2 1 0 1.1-1 8.5-8 8.5-14.2C31 13.7 27 10 22 10Z" fill="#fff" fill-opacity=".96"/>
      <path d="M17.5 18.6h9l-.9 8.1h-7.2l-.9-8.1Z" fill="#0866D9"/>
      <path d="M19.7 18.6v-1.4a2.3 2.3 0 0 1 4.6 0v1.4" stroke="#0866D9" stroke-width="1.7" stroke-linecap="round"/>
      <circle cx="22" cy="22.2" r="1.15" fill="#fff"/><defs><linearGradient id="nbg" x1="0" y1="0" x2="44" y2="44"><stop stop-color="#168BEE"/><stop offset="1" stop-color="#063B78"/></linearGradient></defs></svg>
    </span><span class="brand__text">Near<span>Buy</span></span>`;

  NB.LOGO = LOGO;

  function renderShell() {
    $('#app').innerHTML = `
      <a class="skip-link" href="#view">Skip to content</a>
      <div class="promo-strip">
        <div class="wrap promo-strip__inner">
          <span class="promo-strip__item">${NB.icon('location')} Delivering across South Delhi</span>
          ${NB.state.config?.demo
            ? `<span class="promo-strip__item promo-strip__demo">${NB.icon('info')} Demo environment · sample shops, products and orders</span>`
            : `<span class="promo-strip__item hide-sm">${NB.icon('truck')} Delivery or pickup — set by each shop</span>`}
          <nav class="promo-strip__links" aria-label="Secondary">
            <a href="#/help">Help &amp; Support</a>
            
            
          </nav>
        </div>
      </div>
      <header class="site-header" id="siteHeader">
        <div class="wrap header-main">
          <button class="icon-btn header-menu" data-action="mobile-nav" aria-label="Open menu">${NB.icon('menu')}</button>
          <a class="brand" href="#/" aria-label="NearBuy home">${LOGO}</a>
          <button class="location-btn" data-action="location" id="locationBtn" aria-label="Change delivery location">
            <span class="location-btn__icon">${NB.icon('location')}</span>
            <span class="location-btn__text"><small>Delivering to</small><b id="locationLabel">Select your location</b></span>
            ${NB.icon('chevronDown', 'location-btn__chev')}
          </button>
          <form class="search-box" id="searchForm" role="search" autocomplete="off">
            ${NB.icon('search', 'search-box__icon')}
            <input id="searchInput" name="q" type="search" placeholder="Search for shops, products, groceries, medicines, stationery and more..." aria-label="Search NearBuy" />
            <button type="submit" class="search-box__go">Search</button>
            <div class="suggest" id="suggest" hidden></div>
          </form>
          <div class="header-actions">
            <a class="header-action" href="#/offers" data-nav="offers"><span class="header-action__icon">${NB.icon('tag')}</span><span>Offers</span></a>
            <a class="header-action" href="#/orders" data-nav="orders"><span class="header-action__icon">${NB.icon('package')}</span><span>Orders</span></a>
            <a class="header-action" href="#/wishlist" data-nav="wishlist"><span class="header-action__icon">${NB.icon('heart')}<i class="count-dot" data-count="wishlist" hidden>0</i></span><span>Wishlist</span></a>
            <a class="header-action header-bell" href="#/notifications" data-nav="notifications" aria-label="Notifications"><span class="header-action__icon">${NB.icon('bell')}<i class="count-dot" data-count="unread" hidden>0</i></span><span class="hide-lg">Alerts</span></a>
            <div class="account-menu">
              <button class="header-action" data-action="account-menu" aria-haspopup="true" aria-expanded="false"><span class="header-action__icon">${NB.icon('user')}</span><span id="accountLabel">Sign in</span></button>
              <div class="account-pop" id="accountPop" hidden></div>
            </div>
            <a class="cart-btn" href="#/cart" data-nav="cart" aria-label="Shopping cart">
              ${NB.icon('cart')}<span class="cart-btn__label">Cart</span><i class="cart-btn__count" data-count="cart">0</i>
            </a>
          </div>
        </div>
        <div class="nav-row">
          <div class="wrap nav-row__inner">
            <div class="mega-wrap">
              <button class="nav-cat-btn" data-action="mega" aria-expanded="false">${NB.icon('grid')} All Categories ${NB.icon('chevronDown')}</button>
              <div class="mega" id="megaMenu" hidden>
                <div class="mega__head"><b>Shop by category</b><a href="#/categories">View all ${NB.state.categories.length} categories ${NB.icon('arrowRight')}</a></div>
                <div class="mega__grid" id="megaGrid"></div>
              </div>
            </div>
            <nav class="primary-nav" aria-label="Primary">
              <a href="#/" data-nav="home">Home</a>
              <a href="#/shops" data-nav="shops">Nearby Shops</a>
              <a href="#/categories/groceries" data-nav="groceries">Groceries</a>
              <a href="#/categories/pharmacy" data-nav="pharmacy">Pharmacy</a>
              <a href="#/categories/stationery" data-nav="stationery">Stationery</a>
              <a href="#/categories/electronics" data-nav="electronics">Electronics</a>
              <a href="#/offers" data-nav="offers" class="nav-offer">${NB.icon('percent')} Offers</a>
            </nav>
            <div class="nav-trust hide-md">${NB.icon('shield')} Verified local sellers</div>
          </div>
        </div>
      </header>
      <main id="view" class="view" tabindex="-1"></main>
      <footer class="site-footer">
        <div class="wrap">
          <div class="footer-top">
            <div class="footer-brand">
              <a class="brand brand--light" href="#/">${LOGO}</a>
              <p>Shop Local. Live Better. NearBuy connects you with trusted neighbourhood shops — compare prices, order easily and track every delivery.</p>
              <div class="footer-tagline">Smart Shopping. Right Nearby.</div>
              
            </div>




          </div>
          <div class="footer-bottom">
            <span>© ${new Date().getFullYear()} NearBuy. A neighbourhood commerce prototype. <b>Demo data</b> is labelled throughout.</span>
            <span class="footer-pay">${NB.icon('lock')} Secure sessions · ${NB.icon('shield')} Server-verified prices · ${NB.icon('receipt')} Printable receipts</span>
          </div>
        </div>
      </footer>
      <nav class="mobile-nav" aria-label="Mobile navigation">
        <a href="#/" data-nav="home">${NB.icon('home')}<span>Home</span></a>
        <a href="#/categories" data-nav="categories">${NB.icon('grid')}<span>Categories</span></a>
        <a href="#/shops" data-nav="shops">${NB.icon('store')}<span>Shops</span></a>
        <a href="#/orders" data-nav="orders">${NB.icon('package')}<span>Orders</span></a>
        <a href="#/cart" data-nav="cart" class="mobile-cart">${NB.icon('cart')}<span>Cart</span><i class="cart-btn__count" data-count="cart">0</i></a>
      </nav>
      <div id="toasts" class="toasts" role="status" aria-live="polite"></div>
      <div id="modalRoot" hidden></div>
      <div class="mobile-drawer" id="mobileDrawer" hidden>
        <div class="mobile-drawer__backdrop" data-action="close-mobile"></div>
        <aside class="mobile-drawer__panel" aria-label="Menu">
          <div class="mobile-drawer__head"><b>NearBuy</b><button class="icon-btn" data-action="close-mobile" aria-label="Close menu">${NB.icon('close')}</button></div>
          <button class="location-btn location-btn--wide" data-action="location">${NB.icon('location')}<span class="location-btn__text"><small>Delivering to</small><b id="locationLabelMobile">Select your location</b></span></button>
          <nav class="mobile-links">
            <a href="#/">Home</a><a href="#/categories">All categories</a><a href="#/shops">Nearby shops</a><a href="#/offers">Offers</a>
            <a href="#/orders">Orders</a><a href="#/wishlist">Wishlist</a><a href="#/notifications">Notifications</a><a href="#/account">My account</a>
            <a href="#/help">Help &amp; support</a>
          </nav>
        </aside>
      </div>`;

    $('#megaGrid').innerHTML = NB.state.categories.map((c) => `
      <a class="mega__item" href="#/categories/${c.slug}">
        <span class="cat-ic tone-${c.tone}">${NB.icon(NB.categoryIcon(c.slug))}</span>
        <span><b>${NB.esc(c.name)}</b><small>${c.productCount} products</small></span>
      </a>`).join('');
    bindShellEvents();
    renderLocation();
    renderUser();
    NB.renderCartCount();
  }

  function renderLocation() {
    const l = NB.state.location;
    const label = l ? (l.locality || l.pincode) : 'Select your location';
    const sub = l ? `Delivering to` : 'Delivering to';
    const small = $('#locationLabel');
    if (small) {
      small.textContent = label;
      const wrap = small.closest('.location-btn');
      if (wrap) {
        const s = wrap.querySelector('small');
        if (s) s.textContent = sub;
        wrap.classList.toggle('has-location', Boolean(l));
      }
    }
    const mob = $('#locationLabelMobile');
    if (mob) mob.textContent = l ? `${l.locality || l.pincode}${l.pincode ? ' · ' + l.pincode : ''}` : 'Select your location';
  }

  function renderUser() {
    const user = NB.state.user;
    const label = $('#accountLabel');
    if (label) label.textContent = user ? user.name.split(' ')[0] : 'Sign in';
    const pop = $('#accountPop');
    if (pop) {
      pop.innerHTML = user ? `
        <div class="account-pop__head"><span class="avatar">${NB.esc(user.avatar || '👤')}</span><div><b>${NB.esc(user.name)}</b><small>${NB.esc(user.email)}</small></div></div>
        <a href="#/account">${NB.icon('user')} My account</a>
        <a href="#/orders">${NB.icon('package')} Orders &amp; tracking</a>
        <a href="#/wishlist">${NB.icon('heart')} Wishlist</a>
        <a href="#/account/returns">${NB.icon('returnArrow')} Returns &amp; refunds</a>
        <a href="#/help/tickets">${NB.icon('headset')} Support tickets</a>
        <button class="account-pop__out" data-action="logout">${NB.icon('logout')} Sign out</button>` : `
        <div class="account-pop__head"><span class="avatar">👤</span><div><b>Welcome to NearBuy</b><small>Sign in for orders, wishlist and reviews.</small></div></div>
        <a href="#/login">${NB.icon('user')} Sign in</a>
        <a href="#/register">${NB.icon('plus')} Create an account</a>
        <a href="#/orders">${NB.icon('package')} Track an order</a>
        <a href="#/help">${NB.icon('headset')} Help &amp; support</a>`;
    }
  }

  NB.renderCartCount = () => {
    const n = NB.state.user ? Number(NB.state.counts.cart || 0) : NB.guestCount();
    $$('[data-count="cart"]').forEach((el) => { el.textContent = n > 99 ? '99+' : String(n); el.hidden = n === 0; });
    $$('[data-count="wishlist"]').forEach((el) => { el.textContent = NB.state.counts.wishlist || 0; el.hidden = !NB.state.counts.wishlist; });
    $$('[data-count="unread"]').forEach((el) => { el.textContent = NB.state.counts.unread || 0; el.hidden = !NB.state.counts.unread; });
  };

  NB.setCounts = (counts) => {
    NB.state.counts = { ...NB.state.counts, ...counts };
    NB.renderCartCount();
  };

  function closeMenus() {
    const mega = $('#megaMenu');
    if (mega) mega.hidden = true;
    const pop = $('#accountPop');
    if (pop) pop.hidden = true;
    const btn = $('[data-action="account-menu"]');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    const megaBtn = $('[data-action="mega"]');
    if (megaBtn) megaBtn.setAttribute('aria-expanded', 'false');
    const drawer = $('#mobileDrawer');
    if (drawer) { drawer.hidden = true; document.documentElement.classList.remove('no-scroll'); }
    const suggest = $('#suggest');
    if (suggest) suggest.hidden = true;
  }
  NB.closeMenus = closeMenus;

  function bindShellEvents() {
    $$('.primary-nav a, .mobile-nav a, .brand, [data-nav]').forEach((a) => {
      a.addEventListener('click', (e) => {
        if (a.getAttribute('data-nav')) $$('.primary-nav a, .mobile-nav a').forEach((x) => x.classList.toggle('is-active', x === a));
        if (a.closest('.mobile-drawer')) closeMenus();
        if (e.defaultPrevented) return;
      });
    });

    const form = $('#searchForm');
    const input = $('#searchInput');
    if (input) input.value = '';
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const term = input.value.trim();
        if (term.length < 2) { input.focus(); NB.toast('Type at least two characters to search.', 'warn'); return; }
        closeMenus();
        NB.hash(`/search?q=${encodeURIComponent(term)}`);
      });
      input.addEventListener('input', NB.debounce(async () => {
        const term = input.value.trim();
        const box = $('#suggest');
        if (!box) return;
        if (term.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
        try {
          const data = await NB.api(`/search/suggest?q=${encodeURIComponent(term)}&${NB.locationQuery()}`);
          if (input.value.trim() !== term) return;
          box.innerHTML = suggestHtml(data);
          box.hidden = false;
          box.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => { box.hidden = true; }));
        } catch { box.hidden = true; }
      }, 220));
      input.addEventListener('focus', () => { if (input.value.trim().length >= 2 && $('#suggest').innerHTML) $('#suggest').hidden = false; });
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-box')) { const box = $('#suggest'); if (box) box.hidden = true; }
        if (!e.target.closest('.mega-wrap')) { const m = $('#megaMenu'); if (m) m.hidden = true; }
        if (!e.target.closest('.account-menu')) { const p = $('#accountPop'); if (p) p.hidden = true; }
      });
    }
  }

  function suggestHtml(data) {
    const products = data.products || [];
    const shops = data.shops || [];
    const categories = data.categories || [];
    if (!products.length && !shops.length && !categories.length) {
      return `<div class="suggest__empty">No matches for “${NB.esc(data.query || '')}”. Try “milk”, “notebook” or “pharmacy”.</div>`;
    }
    return `${products.length ? `<div class="suggest__group"><b>Products</b>${products.map((p) => `
      <a href="#/product/${encodeURIComponent(p.id)}" class="suggest__row"><span class="mini-art">${p.imageUrl ? `<img src="${NB.esc(p.imageUrl)}" alt="">` : NB.esc(p.emoji || '🛍️')}</span>
      <span><strong>${NB.esc(p.name)}</strong><small>${NB.esc(p.shop.name)} · ${NB.money(p.price)}</small></span>${p.available ? '' : '<em>Out of stock</em>'}</a>`).join('')}</div>` : ''}
      ${shops.length ? `<div class="suggest__group"><b>Shops</b>${shops.map((s) => `
      <a href="#/shop/${encodeURIComponent(s.slug)}" class="suggest__row"><span class="mini-art tone-${s.tone}">${NB.esc(s.emoji || '🏪')}</span>
      <span><strong>${NB.esc(s.name)}</strong><small>${s.distanceKm != null ? s.distanceKm + ' km · ' : ''}${NB.esc(s.tagline || '')}</small></span></a>`).join('')}</div>` : ''}
      ${categories.length ? `<div class="suggest__group"><b>Categories</b>${categories.map((c) => `
      <a href="#/categories/${c.slug}" class="suggest__row"><span class="mini-art tone-${c.tone}">${NB.icon(NB.categoryIcon(c.slug))}</span>
      <span><strong>${NB.esc(c.name)}</strong><small>${c.productCount} products</small></span></a>`).join('')}</div>` : ''}
      <a class="suggest__all" href="#/search?q=${encodeURIComponent(data.query || '')}">See all results for “${NB.esc(data.query || '')}” ${NB.icon('arrowRight')}</a>`;
  }

  NB.bindShellEvents = bindShellEvents;

  /* -------------------------- global actions ------------------------ */
  NB.actions = {
    location() {
      closeMenus();
      openLocationModal();
    },
    'mobile-nav'() {
      const drawer = $('#mobileDrawer');
      if (!drawer) return;
      drawer.hidden = false;
      document.documentElement.classList.add('no-scroll');
    },
    'close-mobile'() { closeMenus(); },
    mega() {
      const menu = $('#megaMenu');
      const btn = $('[data-action="mega"]');
      const willOpen = menu.hidden;
      menu.hidden = !willOpen;
      btn.setAttribute('aria-expanded', String(willOpen));
    },
    'account-menu'() {
      const pop = $('#accountPop');
      const btn = $('[data-action="account-menu"]');
      pop.hidden = !pop.hidden;
      btn.setAttribute('aria-expanded', String(!pop.hidden));
    },
    async logout() {
      closeMenus();
      try {
        await NB.api('/auth/logout', { method: 'POST' });
        NB.state.user = null;
        NB.state.counts = { cart: NB.guestCount(), wishlist: 0, unread: 0 };
        NB.toast('Signed out. See you soon!', 'success');
        renderUser();
        NB.renderCartCount();
        NB.hash('/');
      } catch (err) { NB.toast(err.message, 'error'); }
    }
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.getAttribute('data-action');
    if (NB.actions[action]) {
      e.preventDefault();
      NB.actions[action](el, e);
    }
  });

  /* ------------------------- location modal ------------------------- */
  async function openLocationModal() {
    const current = NB.state.location;
    const m = NB.modal({
      title: 'Choose your delivery location',
      className: 'modal--location',
      body: `
        <p class="muted modal__lead">NearBuy shows only the shops that actually serve your locality. You can change this at any time.</p>
        <button class="btn btn--primary btn--block" id="detectLoc">${NB.icon('location')} Detect my location</button>
        <div class="geo-status" id="geoStatus" hidden></div>
        <div class="or-line"><span>or search by locality or pincode</span></div>
        <form id="locForm" class="loc-form">
          <div class="field"><label for="locQ">Locality or 6-digit pincode</label>
            <div class="input-row"><input id="locQ" name="q" placeholder="e.g. Hauz Khas or 110016" autocomplete="off" />
            <button class="btn btn--outline" type="submit">Check</button></div>
          </div>
        </form>
        <div class="loc-results" id="locResults"></div>
        ${current ? `<button class="btn btn--ghost btn--block" id="clearLoc" style="margin-top:14px">Clear location</button>` : ''}
        <p class="fineprint">${NB.icon('info')} Distances are straight-line estimates. No map provider is configured for this deployment.</p>`,
      footer: false
    });
    const input = $('#locQ', m.root);
    const results = $('#locResults', m.root);
    const status = $('#geoStatus', m.root);

    async function search(term) {
      results.innerHTML = `<div class="loc-loading">${NB.spinner()} Finding serviceable localities…</div>`;
      try {
        const data = await NB.api(`/localities?q=${encodeURIComponent(term || '')}`);
        results.innerHTML = data.localities.length ? data.localities.map((l) => `
          <button class="loc-result" data-pin="${l.pincode}" data-lat="${l.lat}" data-lng="${l.lng}" data-loc="${NB.esc(l.locality)}" data-city="${NB.esc(l.city)}">
            <span class="loc-result__ic">${NB.icon('location')}</span><span><b>${NB.esc(l.locality)}</b><small>${NB.esc(l.city)} · ${l.pincode}</small></span>${NB.icon('chevronRight')}
          </button>`).join('') : `<div class="empty empty--sm"><b>No locality found</b><span>We currently deliver to ${NB.esc((NB.state.areas || []).slice(0, 4).map((a) => a.locality).join(', ') || 'Hauz Khas, Saket and nearby areas')}.</span></div>`;
        results.querySelectorAll('.loc-result').forEach((b) => b.addEventListener('click', () => {
          NB.setLocation({ pincode: b.dataset.pin, locality: b.dataset.loc, city: b.dataset.city, lat: Number(b.dataset.lat), lng: Number(b.dataset.lng) });
          m.close();
        }));
      } catch (err) { results.innerHTML = `<div class="empty empty--sm"><b>Could not load localities</b><span>${NB.esc(err.message)}</span></div>`; }
    }

    input.addEventListener('input', NB.debounce(() => search(input.value.trim()), 240));
    $('#locForm', m.root).addEventListener('submit', (e) => {
      e.preventDefault();
      const term = input.value.trim();
      if (/^\d{6}$/.test(term)) return checkPincode(term);
      search(term);
    });
    async function checkPincode(pin) {
      results.innerHTML = `<div class="loc-loading">${NB.spinner()} Checking ${NB.esc(pin)}…</div>`;
      try {
        const data = await NB.api(`/serviceability?pincode=${encodeURIComponent(pin)}`);
        if (!data.area) { results.innerHTML = `<div class="empty empty--sm"><b>Pincode not recognised</b><span>Try 110016, 110017, 110024, 110048 or 110070.</span></div>`; return; }
        if (!data.serviceable) {
          results.innerHTML = `<div class="empty empty--sm"><b>Not serviceable yet</b><span>${NB.esc(data.message)}</span></div>`;
          return;
        }
        results.innerHTML = `<div class="loc-found"><span class="loc-found__ic">${NB.icon('checkCircle')}</span>
          <div><b>${NB.esc(data.area.locality)}, ${NB.esc(data.area.city)}</b><small>${NB.esc(data.message)}</small></div>
          <button class="btn btn--primary btn--sm" id="usePin">Use this location</button></div>`;
        $('#usePin', results).addEventListener('click', () => {
          NB.setLocation({ pincode: pin, locality: data.area.locality, city: data.area.city, lat: data.area.lat, lng: data.area.lng });
          m.close();
        });
      } catch (err) { results.innerHTML = `<div class="empty empty--sm"><b>Check failed</b><span>${NB.esc(err.message)}</span></div>`; }
    }

    $('#detectLoc', m.root).addEventListener('click', () => {
      if (!navigator.geolocation) { status.hidden = false; status.className = 'geo-status geo-status--warn'; status.textContent = 'This browser does not support location detection.'; return; }
      status.hidden = false; status.className = 'geo-status'; status.innerHTML = `${NB.spinner()} Asking your browser for permission…`;
      navigator.geolocation.getCurrentPosition(async (pos) => {
        const { latitude, longitude } = pos.coords;
        try {
          const data = await NB.api('/localities');
          const withDist = data.localities.map((l) => ({ ...l, d: Math.hypot(l.lat - latitude, l.lng - longitude) })).sort((a, b) => a.d - b.d);
          const nearest = withDist[0];
          if (!nearest) throw new Error('No service area found near you.');
          status.className = 'geo-status geo-status--ok';
          status.innerHTML = `<b>${NB.esc(nearest.locality)}</b> is the nearest serviceable locality. <button class="link-btn" id="useGeo">Use ${NB.esc(nearest.locality)}</button>`;
          $('#useGeo', status).addEventListener('click', () => {
            NB.setLocation({ pincode: nearest.pincode, locality: nearest.locality, city: nearest.city, lat: latitude, lng: longitude });
            m.close();
          });
        } catch (err) {
          status.className = 'geo-status geo-status--warn';
          status.textContent = `Could not match your position: ${err.message}`;
        }
      }, () => {
        status.className = 'geo-status geo-status--warn';
        status.textContent = 'Location permission was declined. Search by locality or pincode instead.';
      }, { enableHighAccuracy: true, timeout: 9000, maximumAge: 300000 });
    });

    const clear = $('#clearLoc', m.root);
    if (clear) clear.addEventListener('click', () => { NB.setLocation(null); m.close(); });

    if (current) {
      results.innerHTML = `<div class="loc-current"><span>${NB.icon('checkCircle')}</span><div><b>${NB.esc(current.locality || current.pincode)}</b><small>Current delivery location${current.pincode ? ' · ' + current.pincode : ''}</small></div></div>`;
    }
    search('');
  }

  /* ---------------------- product card widgets ---------------------- */
  NB.productArt = (p, cls = '') => {
    if (p.imageUrl) return `<img class="product-art ${cls}" src="${NB.esc(p.imageUrl)}" alt="${NB.esc(p.name)}" loading="lazy" />`;
    return `<span class="product-art product-art--emoji ${cls}" aria-hidden="true">${NB.esc(p.emoji || '🛍️')}</span>`;
  };

  NB.productCard = (p, opts = {}) => {
    const wished = Boolean(opts.wished);
    const discount = p.discount || (p.mrp > p.price ? Math.round(((p.mrp - p.price) / p.mrp) * 100) : 0);
    return `<article class="product-card ${!p.available ? 'is-soldout' : ''}">
      <div class="product-card__media">
        <a href="#/product/${encodeURIComponent(p.id)}" class="product-card__link" aria-label="${NB.esc(p.name)}">${NB.productArt(p)}</a>
        ${discount ? `<span class="badge badge--discount">${discount}% OFF</span>` : ''}
        ${!p.available ? '<span class="badge badge--soldout">Out of stock</span>' : (p.lowStock ? `<span class="badge badge--low">Only ${p.stock} left</span>` : '')}
        <button class="wish-btn ${wished ? 'is-on' : ''}" data-wish="${encodeURIComponent(p.id)}" aria-label="${wished ? 'Remove from' : 'Add to'} wishlist" aria-pressed="${wished}">${NB.icon('heart')}</button>
      </div>
      <div class="product-card__body">
        <a class="product-card__shop" href="#/shop/${encodeURIComponent(p.shop.slug)}">${NB.esc(p.shop.name)}${p.distanceKm != null ? ` · ${p.distanceKm} km` : ''}</a>
        <a class="product-card__name" href="#/product/${encodeURIComponent(p.id)}">${NB.esc(p.name)}</a>
        <div class="product-card__meta"><span>${NB.esc(p.brand || '')}</span><span>${NB.esc(p.unit || '')}</span></div>
        <div class="product-card__foot">
          <div class="price"><b>${NB.money(p.price)}</b>${p.mrp > p.price ? `<s>${NB.money(p.mrp)}</s>` : ''}</div>
          ${p.available
            ? `<button class="add-btn" data-add="${encodeURIComponent(p.id)}" aria-label="Add ${NB.esc(p.name)} to cart">${NB.icon('plus')}<span>Add</span></button>`
            : `<button class="add-btn add-btn--wait" data-notify="${encodeURIComponent(p.id)}">Notify me</button>`}
        </div>
        <div class="product-card__trust">${p.deliveryEnabled ? `${NB.icon('truck')} Delivery` : ''}${p.pickupEnabled ? `${NB.icon('store')} Pickup` : ''}${p.returnDays ? `${NB.icon('returnArrow')} ${p.returnDays}-day return` : ''}</div>
      </div>
    </article>`;
  };

  NB.shopCard = (s) => `
    <article class="shop-card ${s.isOpen ? '' : 'is-closed'}">
      <div class="shop-card__cover tone-${s.tone}">
        <span class="shop-card__emoji" aria-hidden="true">${NB.esc(s.emoji || '🏪')}</span>
        <div class="shop-card__badges">
          ${s.verified ? `<span class="badge badge--verified">${NB.icon('verified')} Verified</span>` : ''}
          <span class="badge ${s.isOpen ? 'badge--open' : 'badge--closed'}">${s.isOpen ? 'Open now' : 'Closed'}</span>
        </div>
        ${s.badge ? `<span class="shop-card__ribbon">${NB.esc(s.badge)}</span>` : ''}
      </div>
      <div class="shop-card__body">
        <div class="shop-card__title"><h3><a href="#/shop/${encodeURIComponent(s.slug)}">${NB.esc(s.name)}</a></h3>
          <span class="rating">${NB.icon('star')} ${Number(s.rating).toFixed(1)} <small>(${s.reviewCount})</small></span></div>
        <p class="shop-card__cat">${NB.esc(s.tagline || s.category)}</p>
        <div class="shop-card__facts">
          <span>${NB.icon('location')} ${s.distanceKm != null ? s.distanceKm + ' km' : s.locality}</span>
          <span>${NB.icon('clock')} ${s.isOpen ? `${s.prepMinutes} min prep` : `Opens ${s.opensAt}`}</span>
        </div>
        <div class="shop-card__options">
          ${s.deliveryEnabled ? `<span>${NB.icon('truck')} Delivery${s.deliveryFee ? ' · ' + NB.money(s.deliveryFee) : ' · Free'}</span>` : '<span class="muted">No delivery</span>'}
          ${s.pickupEnabled ? `<span>${NB.icon('store')} Pickup</span>` : ''}
        </div>
        ${!s.serviceable ? `<div class="notice notice--warn notice--tight">${NB.icon('alert')} Does not deliver to your saved area${s.pickupEnabled ? ' — pickup is available' : ''}.</div>` : ''}
        <div class="shop-card__actions">
          <a class="btn btn--primary btn--sm" href="#/shop/${encodeURIComponent(s.slug)}">Visit shop</a>
          <a class="btn btn--ghost btn--sm" href="#/products?shop=${encodeURIComponent(s.slug)}">View products</a>
        </div>
      </div>
    </article>`;

  /* --------------------------------------------------------------- shop map */
  /* A dependency-free map of nearby shops. Pins are placed with a true-scale
   * equirectangular projection (kilometres north/east from a centre point), so the
   * distance rings around "you are here" are real circles rather than decoration. */
  const KM_PER_DEG_LAT = 111.32;
  const kmPerDegLng = (lat) => 111.32 * Math.cos((Number(lat) * Math.PI) / 180);
  /* "<0.1 km" reads better than "0 km" when the shopper is standing in the shop. */
  NB.mapDistance = (km) => (km == null ? null : Number(km) < 0.1 ? '<0.1 km' : `${km} km`);
  const NB_TEL = (phone) => (phone ? String(phone).replace(/[^+\d]/g, '') : '');

  NB.mapLayout = (shops, { width, height, zoom = 1, centre = null, minSpanKm = 1.2 } = {}) => {
    const pts = (shops || []).filter((s) => s && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)));
    if (!pts.length) return null;
    const w = Math.max(1, Number(width) || 640);
    const h = Math.max(1, Number(height) || 380);
    const loc = NB.state.location;
    const user = loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng))
      ? { lat: Number(loc.lat), lng: Number(loc.lng), locality: loc.locality || loc.pincode || 'Your area' }
      : null;
    const all = pts.map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }));
    if (user) all.push(user);

    let lat0; let lng0;
    if (centre && Number.isFinite(Number(centre.lat)) && Number.isFinite(Number(centre.lng))) {
      lat0 = Number(centre.lat); lng0 = Number(centre.lng);
    } else {
      const lats = all.map((p) => p.lat);
      const lngs = all.map((p) => p.lng);
      lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
      lng0 = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    }

    const kmLat = KM_PER_DEG_LAT;
    const kmLng = kmPerDegLng(lat0);
    const pad = Math.min(w, h) * 0.16;
    let maxNorth = 0; let maxEast = 0;
    for (const p of all) {
      maxNorth = Math.max(maxNorth, Math.abs((p.lat - lat0) * kmLat));
      maxEast = Math.max(maxEast, Math.abs((p.lng - lng0) * kmLng));
    }
    /* Largest scale (px per km) that still fits every point inside the padding. */
    const fitScale = Math.min(
      (h / 2 - pad) / Math.max(maxNorth, 0.2),
      (w / 2 - pad) / Math.max(maxEast, 0.2)
    );
    const scale = Math.max(1e-6, Math.min(fitScale, h / minSpanKm)) / (Number(zoom) || 1);
    return {
      lat0, lng0, kmLat, kmLng, scale, spanKm: h / scale, user, width: w, height: h,
      x: (lng) => w / 2 + (Number(lng) - lng0) * kmLng * scale,
      y: (lat) => h / 2 - (Number(lat) - lat0) * kmLat * scale,
      px: (km) => km * scale
    };
  };

  NB.mapPanel = (s) => {
    if (!s) {
      return `<div class="nbmap__hint">${NB.icon('info')}
        <p>Pick a pin to see how far the shop is, who runs it, and how to call them.</p></div>`;
    }
    const tel = NB_TEL(s.phone);
    /* Address often repeats the locality — keep each part once. */
    const parts = [s.address, s.locality, s.city].map((p) => String(p || '').trim()).filter(Boolean);
    const where = parts
      .filter((p, i) => parts.indexOf(p) === i)
      /* skip a locality the street address already spells out */
      .filter((p, i) => i === 0 || p !== s.locality || !String(s.address || '').includes(p))
      .join(', ');
    const distance = s.distanceKm != null
      ? `${NB.mapDistance(s.distanceKm)} from you`
      : (s.locality ? `In ${s.locality}` : 'Distance unavailable');
    return `
      <div class="nbmap__shop">
        <span class="nbmap__emoji tone-${NB.esc(s.tone || 'blue')}">${NB.esc(s.emoji || '🏪')}</span>
        <div class="nbmap__shop-main">
          <h4><a href="#/shop/${encodeURIComponent(s.slug)}">${NB.esc(s.name)}</a></h4>
          <span class="nbmap__stars">${NB.icon('star')} ${Number(s.rating).toFixed(1)} <small>(${s.reviewCount})</small></span>
        </div>
        <span class="badge ${s.isOpen ? 'badge--open' : 'badge--closed'}">${s.isOpen ? 'Open now' : 'Closed'}</span>
      </div>
      <dl class="nbmap__facts">
        <div><dt>${NB.icon('location')} Distance</dt><dd><b>${NB.esc(distance)}</b></dd></div>
        <div><dt>${NB.icon('phone')} Phone</dt><dd>${s.phone
          ? `<a href="tel:${NB.esc(tel)}">${NB.esc(s.phone)}</a>` : '<span class="muted">Not listed</span>'}</dd></div>
        <div><dt>${NB.icon('user')} Owner</dt><dd>${s.ownerName ? NB.esc(s.ownerName) : '<span class="muted">Not listed</span>'}</dd></div>
        <div><dt>${NB.icon('store')} Location</dt><dd>${NB.esc(where || 'Not listed')}${s.pincode ? ` — ${NB.esc(s.pincode)}` : ''}</dd></div>
        <div><dt>${NB.icon('clock')} Hours</dt><dd>${NB.esc(s.opensAt || '—')}–${NB.esc(s.closesAt || '—')}</dd></div>
      </dl>
      <div class="nbmap__actions">
        ${s.phone ? `<a class="btn btn--primary btn--sm" href="tel:${NB.esc(tel)}">${NB.icon('phone')} Call</a>` : ''}
        ${s.directionsUrl ? `<a class="btn btn--ghost btn--sm" href="${NB.esc(s.directionsUrl)}" target="_blank" rel="noopener noreferrer">${NB.icon('map')} Directions</a>` : ''}
        <a class="btn btn--ghost btn--sm" href="#/shop/${encodeURIComponent(s.slug)}">Visit shop</a>
      </div>`;
  };

  NB.mapListItem = (s) => {
    const tel = NB_TEL(s.phone);
    return `
      <button type="button" class="nbmap__row" data-nbmap-pick="${NB.esc(s.slug)}">
        <span class="nbmap__row-emoji tone-${NB.esc(s.tone || 'blue')}">${NB.esc(s.emoji || '🏪')}</span>
        <span class="nbmap__row-body">
          <b>${NB.esc(s.name)}</b>
          <small>${NB.esc(s.ownerName || s.category || '')}${s.phone ? ` · <a href="tel:${NB.esc(tel)}" data-nbmap-stop>${NB.esc(s.phone)}</a>` : ''}</small>
        </span>
        <span class="nbmap__row-dist">${NB.mapDistance(s.distanceKm) || '—'}</span>
      </button>`;
  };

  NB.shopMap = (shops, { selected = null, title = 'Shop map', subtitle = '' } = {}) => {
    const list = (shops || []).filter(Boolean);
    const coords = list.filter((s) => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)));
    return `
      <div class="nbmap" data-nbmap data-nbmap-selected="${NB.esc(selected || '')}">
        <div class="nbmap__stage">
          <div class="nbmap__canvas" data-nbmap-canvas role="group"
            aria-label="Map of ${list.length} nearby shop${list.length === 1 ? '' : 's'}. Choose a pin for distance, phone number, owner and location.">
            <div class="nbmap__layer" data-nbmap-layer></div>
          </div>
          <div class="nbmap__controls">
            <button type="button" class="nbmap__ctl" data-nbmap-act="in" aria-label="Zoom in" title="Zoom in">${NB.icon('plus')}</button>
            <button type="button" class="nbmap__ctl" data-nbmap-act="out" aria-label="Zoom out" title="Zoom out">${NB.icon('minus')}</button>
            <button type="button" class="nbmap__ctl" data-nbmap-act="fit" aria-label="Fit every shop" title="Fit every shop">${NB.icon('map')}</button>
          </div>
          <div class="nbmap__scalebar" data-nbmap-scale aria-hidden="true"></div>
        </div>
        <aside class="nbmap__side">
          <div class="nbmap__head">
            <b>${NB.icon('map')} ${NB.esc(title)}</b>
            <span class="muted small">${NB.esc(subtitle || (coords.length
              ? 'Real coordinates · to scale'
              : 'No coordinates for these shops'))}</span>
          </div>
          <div class="nbmap__panel" data-nbmap-panel aria-live="polite">${NB.mapPanel(null)}</div>
          ${list.length > 1 ? `<div class="nbmap__list" data-nbmap-list>${list.map(NB.mapListItem).join('')}</div>` : ''}
        </aside>
      </div>`;
  };

  NB.wireShopMap = (root, shops) => {
    const host = root.querySelector('[data-nbmap]');
    if (!host) return;
    const canvas = host.querySelector('[data-nbmap-canvas]');
    const layer = host.querySelector('[data-nbmap-layer]');
    const panel = host.querySelector('[data-nbmap-panel]');
    const scalebar = host.querySelector('[data-nbmap-scale]');
    const listEl = host.querySelector('[data-nbmap-list]');
    const all = (shops || []).filter(Boolean);
    const pins = all.filter((s) => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)));
    if (!pins.length) {
      host.innerHTML = `<div class="nbmap__empty">${NB.icon('map')}<b>No map available</b><p>These shops have not published coordinates yet.</p></div>`;
      return;
    }
    let zoom = 1;
    let selected = host.dataset.nbmapSelected || null;

    const pick = (slug, scroll) => {
      selected = slug;
      const s = all.find((x) => x.slug === slug) || null;
      if (panel) panel.innerHTML = NB.mapPanel(s);
      NB.$$('[data-nbmap-pick]', host).forEach((el) => el.classList.toggle('is-active', el.dataset.nbmapPick === slug));
      if (s && scroll !== false) {
        const row = listEl && listEl.querySelector(`[data-nbmap-pick="${CSS.escape(slug)}"]`);
        if (row && listEl) listEl.scrollTop = Math.max(0, row.offsetTop - listEl.offsetTop - 8);
      }
      NB.$$('.nbmap-pin', layer).forEach((el) => el.classList.toggle('is-active', el.dataset.nbmapPick === slug));
    };

    const draw = () => {
      const box = canvas.getBoundingClientRect();
      const w = box.width || canvas.clientWidth || 640;
      const h = box.height || canvas.clientHeight || 380;
      const lay = NB.mapLayout(pins, { width: w, height: h, zoom });
      if (!lay) return;

      const bits = [];
      /* 3–4 evenly spaced rings: close enough together to read as a scale,
       * far enough apart that the labels do not collide in the middle. */
      const rings = [0.2, 0.5, 1, 2, 3, 5, 10, 20, 50]
        .filter((km) => lay.px(km) >= 40 && lay.px(km) <= Math.max(w, h) * 0.95)
        .slice(0, 4);
      if (lay.user) {
        const cx = lay.x(lay.user.lng);
        const cy = lay.y(lay.user.lat);
        for (const km of rings) {
          const r = lay.px(km);
          bits.push(`<span class="nbmap__ring" style="left:${cx - r}px;top:${cy - r}px;width:${r * 2}px;height:${r * 2}px"></span>`);
          bits.push(`<span class="nbmap__ring-label" style="left:${cx + r}px;top:${cy}px">${km} km</span>`);
        }
        bits.push(`<span class="nbmap__user" style="left:${cx}px;top:${cy}px" title="You are here">
          <i></i><span>${NB.icon('location')} ${NB.esc(lay.user.locality)}</span></span>`);
      }

      /* Pins that share coordinates (two shops in one complex) would sit exactly on
       * top of each other and hide one of them. Fan those out just far enough that
       * both stay clickable; everything else keeps its true projected position. */
      const minSep = 34;
      const placed = [];
      for (const s of pins) {
        const trueX = lay.x(s.lng);
        const trueY = lay.y(s.lat);
        let x = trueX;
        let y = trueY;
        for (let i = 0; i < 24 && placed.some((p) => Math.abs(p.x - x) < minSep && Math.abs(p.y - y) < minSep); i++) {
          const ang = (Math.PI * 2 * i) / 8 - Math.PI / 2;
          const rad = minSep * (0.75 + i * 0.2);
          x = trueX + Math.cos(ang) * rad;
          y = trueY + Math.sin(ang) * rad * 0.72;
        }
        placed.push({ x, y });
        const dist = NB.mapDistance(s.distanceKm) || s.locality || '';
        bits.push(`<button type="button" class="nbmap-pin tone-${NB.esc(s.tone || 'blue')}${s.slug === selected ? ' is-active' : ''}"
          data-nbmap-pick="${NB.esc(s.slug)}" style="left:${x}px;top:${y}px"
          aria-label="${NB.esc(s.name)}${dist ? ', ' + NB.esc(dist) : ''}. Show phone, owner and location.">
          <span class="nbmap-pin__dot">${NB.esc(s.emoji || '🏪')}</span>
          <span class="nbmap-pin__tag">${NB.esc(s.name)}${s.distanceKm != null ? `<small>${NB.mapDistance(s.distanceKm)}</small>` : ''}</span>
        </button>`);
      }
      layer.innerHTML = bits.join('');

      if (scalebar) {
        const km = [1, 0.5, 0.2, 5, 2].find((k) => lay.px(k) >= 48 && lay.px(k) <= w * 0.35);
        scalebar.innerHTML = km
          ? `<i style="width:${lay.px(km)}px"></i><span>${km} km</span>`
          : `<i style="width:${Math.round(lay.px(1))}px"></i><span>1 km</span>`;
      }
      if (selected) pick(selected, false);
    };

    host.addEventListener('click', (e) => {
      const tel = e.target.closest('[data-nbmap-stop]');
      if (tel) return;
      const act = e.target.closest('[data-nbmap-act]');
      if (act) {
        const a = act.dataset.nbmapAct;
        if (a === 'in') zoom = Math.min(6, zoom * 1.6);
        else if (a === 'out') zoom = Math.max(0.6, zoom / 1.6);
        else zoom = 1;
        draw();
        return;
      }
      const hit = e.target.closest('[data-nbmap-pick]');
      if (hit) { e.preventDefault(); pick(hit.dataset.nbmapPick); }
    });

    NB.$$('[data-nbmap-pick]', host).forEach((el) => el.classList.toggle('is-active', el.dataset.nbmapPick === selected));
    if (selected) {
      const s = all.find((x) => x.slug === selected);
      if (panel && s) panel.innerHTML = NB.mapPanel(s);
    }
    draw();

    /* Re-project when the viewport changes the canvas size. The map is rebuilt on
     * every filter/page change, so the previous observer must be released first or
     * each rebuild leaks one that still points at a detached canvas. */
    if (host._nbMapTeardown) host._nbMapTeardown();
    let teardown = () => {};
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => draw());
      ro.observe(canvas);
      teardown = () => ro.disconnect();
    } else {
      const onResize = () => draw();
      window.addEventListener('resize', onResize);
      teardown = () => window.removeEventListener('resize', onResize);
    }
    host._nbMapTeardown = teardown;
    return { redraw: draw, pick, teardown };
  };

  NB.offerCard = (o) => `
    <div class="offer-card">
      <div class="offer-card__cut"></div>
      <div class="offer-card__left"><span class="offer-card__pct">${o.type === 'free_delivery' ? NB.icon('truck') : o.type === 'percent' ? o.value + '%' : NB.money(o.value)}<small>${o.type === 'free_delivery' ? 'FREE' : 'OFF'}</small></span></div>
      <div class="offer-card__body">
        <div class="offer-card__shop">${o.shop ? NB.esc(o.shop.name) : 'All participating shops'}</div>
        <h3>${NB.esc(o.title)}</h3>
        <p>${NB.esc(o.description || '')}</p>
        <div class="offer-card__meta">
          <button type="button" class="coupon-code" data-copy="${NB.esc(o.code)}" aria-label="Copy coupon code ${NB.esc(o.code)}">${NB.esc(o.code)}${NB.icon('receipt')}</button>
          <span>${o.minOrder ? `Min ${NB.money(o.minOrder)}` : 'No minimum'}</span>
          <span>Ends ${NB.date(o.endsAt)}</span>
        </div>
      </div>
    </div>`;

  NB.copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      NB.toast(`Copied ${text}`, 'success');
    } catch {
      NB.toast(`Use code ${text} at checkout`, 'info');
    }
  };

  document.addEventListener('click', (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) { e.preventDefault(); NB.copy(copy.dataset.copy); return; }
    const add = e.target.closest('[data-add]');
    if (add) { e.preventDefault(); NB.addToCart(decodeURIComponent(add.dataset.add), 1, add); return; }
    const wish = e.target.closest('[data-wish]');
    if (wish) { e.preventDefault(); NB.toggleWishlist(decodeURIComponent(wish.dataset.wish), wish); return; }
    const notifyBtn = e.target.closest('[data-notify]');
    if (notifyBtn) {
      e.preventDefault();
      NB.toast('Stock alerts are not configured for this deployment. Check back soon or ask the shop.', 'info');
      return;
    }
  });

  NB.addToCart = async (productId, qty = 1, button) => {
    if (button) { button.disabled = true; button.classList.add('is-busy'); }
    try {
      if (!NB.state.user) {
        const cart = NB.state.guestCart;
        const found = cart.find((l) => l.productId === productId);
        if (found) found.qty = Math.min(20, found.qty + qty);
        else {
          const res = await NB.api(`/products/${encodeURIComponent(productId)}`);
          const p = res.product;
          cart.push({ productId: p.id, qty, name: p.name, price: p.price, mrp: p.mrp, emoji: p.emoji, imageUrl: p.imageUrl, unit: p.unit, shop: p.shop.name, shopSlug: p.shop.slug });
        }
        NB.saveGuestCart();
        NB.toast('Added to your basket. Sign in at checkout to place the order.', 'success');
      } else {
        const data = await NB.api('/cart/items', { body: { productId, qty } });
        NB.state.cart = data.cart;
        NB.setCounts({ cart: data.cart.itemCount });
        NB.toast(data.message || 'Added to cart', 'success');
      }
      if (button) { button.classList.add('is-added'); button.innerHTML = `${NB.icon('check')}<span>Added</span>`; setTimeout(() => { button.disabled = false; button.classList.remove('is-added', 'is-busy'); button.innerHTML = `${NB.icon('plus')}<span>Add</span>`; }, 1400); }
    } catch (err) {
      NB.toast(err.message, 'error');
      if (button) { button.disabled = false; button.classList.remove('is-busy'); }
    }
  };

  NB.toggleWishlist = async (productId, button) => {
    if (!NB.state.user) {
      NB.toast('Sign in to save products to your wishlist.', 'warn');
      setTimeout(() => NB.hash(`/login?next=${encodeURIComponent(location.hash.slice(1))}`), 600);
      return;
    }
    const on = button.classList.contains('is-on');
    try {
      const data = await NB.api(`/wishlist/${encodeURIComponent(productId)}`, { method: on ? 'DELETE' : 'POST' });
      button.classList.toggle('is-on', !on);
      button.setAttribute('aria-pressed', String(!on));
      NB.setCounts({ wishlist: Math.max(0, (NB.state.counts.wishlist || 0) + (on ? -1 : 1)) });
      NB.toast(data.message, 'success');
      if (location.hash.startsWith('#/wishlist')) setTimeout(() => NB.render(), 300);
    } catch (err) { NB.toast(err.message, 'error'); }
  };

  /* ---------------------------- qty stepper ------------------------- */
  NB.qtyStepper = (value, opts = {}) => `
    <div class="qty ${opts.small ? 'qty--sm' : ''}" data-qty-wrap>
      <button type="button" class="qty__btn" data-qty-minus aria-label="Decrease quantity" ${value <= 1 ? 'disabled' : ''}>${NB.icon('minus')}</button>
      <input type="number" class="qty__input" value="${value}" min="${opts.min || 1}" max="${opts.max || 20}" inputmode="numeric" aria-label="Quantity" ${opts.readonly ? 'readonly' : ''} />
      <button type="button" class="qty__btn" data-qty-plus aria-label="Increase quantity" ${value >= (opts.max || 20) ? 'disabled' : ''}>${NB.icon('plus')}</button>
    </div>`;

  NB.bindQty = (root, onChange) => {
    $$('[data-qty-wrap]', root).forEach((wrap) => {
      const input = $('.qty__input', wrap);
      const sync = (v) => {
        const min = Number(input.min) || 1;
        const max = Number(input.max) || 20;
        const val = Math.max(min, Math.min(max, Math.round(Number(v) || min)));
        input.value = val;
        $('[data-qty-minus]', wrap).disabled = val <= min;
        $('[data-qty-plus]', wrap).disabled = val >= max;
        return val;
      };
      $('[data-qty-minus]', wrap).addEventListener('click', () => onChange(sync(Number(input.value) - 1)));
      $('[data-qty-plus]', wrap).addEventListener('click', () => onChange(sync(Number(input.value) + 1)));
      input.addEventListener('change', () => onChange(sync(input.value)));
    });
  };

  /* ---------------------------- statuses ---------------------------- */
  NB.orderTone = (status) => ({
    placed: 'info', accepted: 'info', preparing: 'warn', ready: 'warn', runner_requested: 'warn',
    runner_assigned: 'info', picked_up: 'info', out_for_delivery: 'info', delivered: 'success',
    completed: 'success', cancelled: 'danger', rejected: 'danger', partially_cancelled: 'warn',
    in_progress: 'info', return_requested: 'warn', returned: 'success'
  }[status] || 'neutral');

  NB.statusPill = (status, label) => `<span class="pill pill--${NB.orderTone(status)}"><i></i>${NB.esc(label || status)}</span>`;

  NB.empty = ({ icon = 'package', title, body, cta, href, ctaLabel }) => `
    <div class="empty"><span class="empty__ic">${NB.icon(icon)}</span><h3>${NB.esc(title)}</h3><p>${NB.esc(body)}</p>
    ${cta ? `<a class="btn btn--primary" href="${cta}">${NB.esc(ctaLabel || 'Continue')}</a>` : ''}</div>`;

  NB.loading = (el, label = 'Loading') => { if (el) el.innerHTML = `<div class="inline-loading">${NB.spinner()} ${NB.esc(label)}</div>`; };

  NB.errorView = (err, retry) => `
    <div class="wrap section"><div class="empty empty--error"><span class="empty__ic">${NB.icon('alert')}</span>
      <h3>Something went sideways</h3><p>${NB.esc(err.message || 'We could not load this page.')}</p>
      <div class="empty__actions"><button class="btn btn--primary" id="retryView">${NB.icon('refresh')} Try again</button><a class="btn btn--ghost" href="#/">Back home</a></div>
    </div></div>`;

  /* ----------------------------- router ----------------------------- */
  NB.routes = [];
  NB.view = (pattern, view) => { NB.routes.push({ pattern, view }); };

  let renderToken = 0;
  NB.render = async () => {
    const raw = location.hash.slice(1) || '/';
    const [path, queryString] = raw.split('?');
    const query = new URLSearchParams(queryString || '');
    const route = NB.routes.find((r) => r.pattern.test(path));
    const viewEl = $('#view');
    if (!viewEl) return;
    const token = ++renderToken;
    closeMenus();
    viewEl.innerHTML = NB.skeleton(route && /product|shop\/|orders\/|cart/.test(path) ? 'detail' : 'home');
    if (!route) {
      viewEl.innerHTML = `<div class="wrap section"><div class="empty"><span class="empty__ic">${NB.icon('info')}</span><h3>That page is not on our map</h3><p>The link may be old. Head back to the neighbourhood.</p><a class="btn btn--primary" href="#/">Back to home</a></div></div>`;
      return;
    }
    try {
      const match = path.match(route.pattern);
      const out = await route.view(match, query);
      if (token !== renderToken) return;
      viewEl.innerHTML = out.html;
      document.title = out.title ? `${out.title} · NearBuy` : 'NearBuy — Shop Local. Live Better.';
      $$('.primary-nav a, .mobile-nav a').forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === ('#' + path)));
      if (out.after) out.after(viewEl);
      window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
      viewEl.focus({ preventScroll: true });
      NB.state.lastRoute = path;
    } catch (err) {
      if (token !== renderToken) return;
      console.error(err);
      viewEl.innerHTML = NB.errorView(err);
      const retry = $('#retryView');
      if (retry) retry.addEventListener('click', NB.render);
    }
  };

  NB.guard = (nextPath) => {
    if (NB.state.user) return true;
    return false;
  };

  NB.authGate = (title, body) => {
    const next = encodeURIComponent(location.hash.slice(1) || '/');
    return `<div class="wrap section"><div class="auth-gate">
      <span class="auth-gate__ic">${NB.icon('lock')}</span>
      <h1>${NB.esc(title)}</h1>
      <p>${NB.esc(body)}</p>
      <div class="auth-gate__actions"><a class="btn btn--primary" href="#/login?next=${next}">Sign in</a><a class="btn btn--ghost" href="#/register?next=${next}">Create an account</a></div>
      <small>You can keep browsing shops and products without an account.</small>
    </div></div>`;
  };

  window.addEventListener('hashchange', NB.render);

  /* ------------------------------ boot ------------------------------ */
  NB.boot = async () => {
    restoreLocal();
    try {
      const data = await NB.api('/bootstrap');
      NB.state.user = data.user;
      NB.state.config = data.config;
      NB.state.categories = data.categories || [];
      NB.state.demoAccounts = data.demoAccounts;
      NB.state.counts = { ...(data.counts || {}), cart: data.counts?.cart || 0 };
      if (data.user && NB.state.guestCart.length) await NB.mergeGuestCart();
      NB.state.booted = true;
    } catch (err) {
      console.error('bootstrap failed', err);
      NB.state.booted = true;
      NB.toast('We could not reach the NearBuy server. Some features may be unavailable.', 'error');
    }
    renderShell();
    await NB.render();
    setInterval(async () => {
      if (!NB.state.user) return;
      try {
        const n = await NB.api('/notifications');
        NB.setCounts({ unread: n.unread });
      } catch { /* offline */ }
    }, 60000);
  };

  NB.mergeGuestCart = async () => {
    if (!NB.state.guestCart.length) return;
    try {
      const res = await NB.api('/cart/merge', { body: { items: NB.state.guestCart.map((l) => ({ productId: l.productId, qty: l.qty })) } });
      NB.state.guestCart = [];
      LS.del('nb.guestCart');
      NB.setCounts({ cart: res.cart.itemCount });
      if (res.merged) NB.toast(res.message, 'success');
    } catch (err) { console.warn(err); }
  };

  NB.refreshBootstrap = async () => {
    try {
      const data = await NB.api('/bootstrap');
      NB.state.user = data.user;
      NB.state.config = data.config;
      NB.state.categories = data.categories || [];
      NB.state.counts = data.counts || NB.state.counts;
      renderUser();
      NB.renderCartCount();
      if (NB.state.user && NB.state.guestCart.length) await NB.mergeGuestCart();
      return data;
    } catch { return null; }
  };

  document.addEventListener('DOMContentLoaded', NB.boot);
  if (document.readyState !== 'loading') NB.boot();
})();
