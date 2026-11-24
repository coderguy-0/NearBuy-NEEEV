/* NearBuy partner consoles — shared shell, session gate, router and helpers.
 *
 *   Seller Hub   /seller/    -> /api/partner/seller/*
 *   Runner Portal /runner/   -> /api/partner/runner/*
 *   Admin Portal  /admin/    -> /api/admin/*
 *
 * The same backend and SQLite database as the customer storefront, so an order
 * placed in /customer/ appears here immediately and every status change made
 * here is visible to the customer.
 */
(function () {
  'use strict';

  const PA = (window.PA = {});
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  PA.$ = $;
  PA.$$ = $$;

  /* ------------------------------------------------------------- helpers */
  PA.esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  PA.money = (paise) => {
    const n = Number(paise || 0) / 100;
    return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: n % 1 ? 2 : 0 });
  };
  PA.date = (iso) => iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  PA.dateTime = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
  PA.dateOnly = (iso) => iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  PA.clock = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '';
  PA.ago = (iso) => {
    const diff = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(diff)) return '';
    if (diff < 0) return 'in ' + PA.ago(new Date(Date.now() + (Date.now() - new Date(iso).getTime())).toISOString());
    if (diff < 60e3) return 'just now';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' min ago';
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' hr ago';
    if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' d ago';
    return PA.date(iso);
  };
  PA.debounce = (fn, wait) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; };
  PA.slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  const ICONS = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    orders: '<path d="M6 2h9l4 4v16H6z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    box: '<path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z"/><path d="m3 7 9 5 9-5M12 12v10"/>',
    tag: '<path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
    rotate: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
    bike: '<circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M15 6h3l1.5 8M9 17.5l3-8h3l1.5 4"/>',
    route: '<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H14a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h5.5"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 21a6.5 6.5 0 0 1 13 0"/><path d="M16 5.5a3.5 3.5 0 0 1 0 7M18 21a6.4 6.4 0 0 0-2-4.6"/>',
    shop: '<path d="M4 9h16l-1 11H5L4 9Z"/><path d="M8 9V6a4 4 0 0 1 8 0v3"/>',
    map: '<path d="m9 18-6 3V6l6-3 6 3 6-3v15l-6 3-6-3Z"/><path d="M9 3v15M15 6v15"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    ticket: '<path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H5a2 2 0 0 1-2-2 2 2 0 0 0 0-4Z"/><path d="M12 6v12"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
    scroll: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    logout: '<path d="M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5M15 12H3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 17h10v4H7z"/>',
    rupee: '<path d="M7 4h10M7 9h10M16 4c0 5-4 5-9 5l9 11"/>',
    home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v11h14V10"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
    scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M7 12h10"/>',
    wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v2"/><path d="M3 7v11a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2Z"/><circle cx="16.5" cy="14.5" r="1"/>',
    percent: '<path d="M19 5 5 19"/><circle cx="7.5" cy="7.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/>',
    file: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.3a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2-2.5 3.6"/><circle cx="12" cy="17.2" r=".6"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    shield: '<path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6l7-3Z"/><path d="m9 12 2 2 4-4"/>',
    download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
    eye: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    edit: '<path d="M17 3a2.8 2.8 0 1 1 4 4L8 20l-5 1 1-5L17 3Z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a12 12 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>'
  };
  PA.icon = (name) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.grid}</svg>`;

  /* ------------------------------------------------------------ API layer */
  const state = { csrf: '', user: null, mode: 'seller', base: '/api/partner', config: {} };

  PA.state = state;

  PA.api = async function (method, path, body) {
    const headers = { 'X-NearBuy-Request': '1' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.csrf) headers['X-NearBuy-CSRF'] = state.csrf;
    let res;
    try {
      res = await fetch(state.base + path, {
        method, headers, credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new Error('Cannot reach the NearBuy API. Check that the server is running on this address.');
    }
    if (res.status === 401) {
      state.user = null;
      renderGate();
      throw new Error('Your session expired. Sign in again.');
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const err = new Error((json && json.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = json;
      throw err;
    }
    return json;
  };

  /* --------------------------------------------------------------- toasts */
  PA.toast = function (message, kind = 'ok') {
    let host = $('#toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toasts';
      host.className = 'toasts';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.innerHTML = `<span>${kind === 'ok' ? '✓' : kind === 'err' ? '⚠' : 'ℹ'}</span><span>${PA.esc(message)}</span>`;
    host.appendChild(el);
    setTimeout(() => el.remove(), kind === 'err' ? 7000 : 4200);
  };

  /* ---------------------------------------------------------------- modal */
  PA.modal = function ({ title, body, actions = [], wide = false, onMount }) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${PA.esc(title || 'Dialog')}">
      <div class="space-between"><h2>${PA.esc(title || '')}</h2><button class="btn btn-sm" data-close aria-label="Close">✕</button></div>
      <div class="stack" style="margin-top:12px">${body || ''}</div>
      <div class="modal-foot">${actions.map((a, i) => `<button class="btn ${a.primary ? 'btn-primary' : a.danger ? 'btn-danger' : ''}" data-action="${i}">${PA.esc(a.label)}</button>`).join('')}</div>
    </div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    back.querySelector('[data-close]').addEventListener('click', close);
    back.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = actions[Number(btn.dataset.action)];
        if (!action) return;
        if (action.onClick) {
          btn.disabled = true;
          try { const keep = await action.onClick(back); if (!keep) close(); } catch (err) { PA.toast(err.message, 'err'); } finally { btn.disabled = false; }
        } else close();
      });
    });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
    if (onMount) onMount(back);
    const focusable = back.querySelector('input, select, textarea, button');
    if (focusable) focusable.focus();
    return { close, el: back };
  };

  PA.confirm = function (title, message, confirmLabel = 'Confirm') {
    return new Promise((resolve) => {
      PA.modal({
        title,
        body: `<p>${PA.esc(message)}</p>`,
        actions: [
          { label: 'Cancel', onClick: () => { resolve(false); } },
          { label: confirmLabel, primary: true, onClick: () => { resolve(true); } }
        ]
      });
    });
  };

  /* ------------------------------------------------------------- rendering */
  PA.set = function (html) {
    const host = $('#view');
    if (host) host.innerHTML = html;
  };
  PA.skeleton = function (rows = 3) {
    return `<div class="stack">${`<div class="card"><div class="skeleton line" style="width:40%"></div><div class="skeleton line" style="width:70%"></div><div class="skeleton line" style="width:55%"></div></div>`.repeat(rows)}</div>`;
  };
  PA.empty = function (emoji, title, text, action) {
    return `<div class="empty"><div class="emoji">${emoji}</div><b>${PA.esc(title)}</b><span>${PA.esc(text || '')}</span>${action || ''}</div>`;
  };
  PA.on = (sel, event, fn) => { const el = $(sel); if (el) el.addEventListener(event, fn); };
  PA.onAll = (sel, event, fn) => { $$(sel).forEach((el) => el.addEventListener(event, fn)); };

  const STATUS_TONE = {
    placed: 'amber', accepted: 'blue', preparing: 'blue', ready: 'green', runner_requested: 'amber',
    runner_assigned: 'blue', picked_up: 'blue', out_for_delivery: 'blue', delivered: 'green', completed: 'green',
    cancelled: 'grey', rejected: 'red', offered: 'amber', declined: 'grey', expired: 'grey',
    open: 'amber', assigned: 'blue', in_progress: 'blue', awaiting_customer: 'amber', resolved: 'green', closed: 'grey',
    requested: 'amber', under_review: 'amber', approved: 'blue', processing: 'blue', refunded: 'green',
    published: 'green', hidden: 'grey', reported: 'red', paid: 'green', pending: 'amber', failed: 'red',
    active: 'green', suspended: 'red', online: 'green', offline: 'grey', delivered_ok: 'green',
    packed: 'green', packing: 'blue', missing: 'amber', reported: 'amber', registered: 'blue',
    confirmed: 'green', submitted: 'amber', documents_pending: 'amber',
    additional_info_required: 'amber', info_required: 'amber', not_settled: 'grey',
    reconciliation_required: 'amber', on_hold: 'amber', verification_pending: 'amber',
    partial_fulfillment: 'amber', awaiting_seller: 'amber', in_stock: 'green', low_stock: 'amber', out_of_stock: 'red'
  };
  PA.tone = (status) => STATUS_TONE[String(status || '').toLowerCase()] || 'grey';
  PA.badge = (label, tone = 'grey') => `<span class="badge ${tone}">${PA.esc(label)}</span>`;
  PA.status = function (status, label) {
    const text = label || String(status || '').replace(/_/g, ' ');
    return `<span class="badge ${PA.tone(status)}">${PA.esc(text)}</span>`;
  };

  /* -------------------------------------------------------------- routing */
  const routes = [];
  PA.route = (pattern, handler) => routes.push({ pattern, handler });
  PA.home = '#/overview';
  PA.go = (hash) => {
    if (location.hash === hash) render();
    else location.hash = hash;
  };

  function currentPath() {
    const raw = location.hash.replace(/^#/, '') || '/';
    return raw.startsWith('/') ? raw : '/' + raw;
  }

  let renderSeq = 0;
  async function render() {
    if (!state.user) return;
    const path = currentPath().split('?')[0];
    const seq = ++renderSeq;
    const found = routes.find((r) => r.pattern.test(path));
    markNav(path);
    if (!found) {
      PA.set(`<div class="card">${PA.empty('🧭', 'Page not found', `No console page matches ${path}.`, '<a class="btn btn-primary" href="#/overview">Back to overview</a>')}</div>`);
      return;
    }
    try {
      PA.set(PA.skeleton(2));
      await found.handler(path.match(found.pattern), { path, seq, isCurrent: () => seq === renderSeq });
    } catch (err) {
      if (seq !== renderSeq) return;
      if (/verification is still pending/i.test(err.message || '')) {
        PA.set(`<div class="card"><div class="empty"><div class="emoji">🪪</div><b>Verification in progress</b>
          <span>Your KYC application is with the NearBuy admin team. Shop profile, business hours, service areas, notifications and support stay open meanwhile — orders, catalogue edits and payouts unlock once you are approved.</span>
          <div class="row" style="margin-top:14px;justify-content:center">
            <a class="btn btn-primary" href="#/profile">Track verification & KYC</a>
            <a class="btn" href="#/support">Contact support</a></div></div></div>`);
        return;
      }
      PA.set(`<div class="card"><div class="form-error">${PA.esc(err.message)}</div>
        <div class="row" style="margin-top:12px"><button class="btn" onclick="location.reload()">Reload</button>
        <a class="btn" href="#/overview">Back to overview</a></div></div>`);
    }
  }
  PA.render = render;
  PA.isCurrent = () => true;

  function markNav(path) {
    $$('.nav a').forEach((a) => {
      const href = a.getAttribute('href') || '';
      const target = href.replace(/^#/, '');
      const active = path === target || (target !== '/' && path.startsWith(target + '/'));
      if (active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  PA.badges = function (counts = {}) {
    Object.entries(counts).forEach(([key, value]) => {
      const el = $(`[data-count="${key}"]`);
      if (!el) return;
      const n = Number(value) || 0;
      el.textContent = n > 99 ? '99+' : String(n);
      el.classList.toggle('hidden', n === 0);
    });
  };

  /* ----------------------------------------------------------------- gate */
  const ROLE_COPY = {
    seller: {
      eyebrow: 'Seller Hub', title: 'Run your shop, one order at a time.',
      lead: 'Accept orders, pack them, keep stock honest and hand deliveries to a NearBuy runner — all on the same backend the customer storefront reads from.',
      bullets: ['New-order alerts with accept or reject', 'Live inventory and price sync to the storefront', 'Printable receipts and self-delivery or runner handover', 'Returns and refund requests from your customers'],
      demo: { email: 'owner@nearbuy.demo', password: 'Seller123!' }
    },
    runner: {
      eyebrow: 'Runner Portal', title: 'Deliver locally. Get paid fairly.',
      lead: 'Nearby offers come to you one at a time. Accept, collect with the shop’s handover PIN, and complete the delivery with the customer’s OTP.',
      bullets: ['One delivery at a time, no stacking', 'Handover PIN at pickup, delivery OTP at the door', 'Live earnings and delivery history', 'Customer contact stays masked until you accept'],
      demo: { email: 'rohan@nearbuy.demo', password: 'Runner123!' }
    },
    admin: {
      eyebrow: 'Admin Portal', title: 'Operations for the whole neighbourhood.',
      lead: 'Customers, shops, catalogue, service areas, coupons, refunds, complaints and audit trails — role-protected on the shared platform database.',
      bullets: ['Verify shops and moderate listings', 'Publish coupons, banners and service areas', 'Work refunds, returns and support queues', 'Every action written to the audit log'],
      demo: { email: 'admin@nearbuy.demo', password: 'Admin123!' }
    }
  };

  function renderGate(message) {
    const copy = ROLE_COPY[state.mode] || ROLE_COPY.seller;
    document.body.classList.remove('nav-open');
    document.body.innerHTML = `
      <div class="gate">
        <div class="pitch">
          <div class="row"><img class="logo" src="/public/assets/nearbuy-logo.png" alt="NearBuy" width="52" height="52" />
            <div><b style="color:#fff;font-size:20px">NearBuy</b><div class="small" style="color:#9dc0e6">Shop Local. Live Better.</div></div></div>
          <div>
            <div class="small" style="letter-spacing:.14em;text-transform:uppercase;color:#9dc0e6;font-weight:700">${PA.esc(copy.eyebrow)}</div>
            <h1 style="margin:8px 0 10px">${PA.esc(copy.title)}</h1>
            <p>${PA.esc(copy.lead)}</p>
          </div>
          <ul>${copy.bullets.map((b) => `<li>${PA.esc(b)}</li>`).join('')}</ul>
          <div class="foot" style="margin-top:auto;font-size:12.5px;color:#9dc0e6">
            Shared backend · one SQLite database · customer, seller, runner and admin all read the same orders.
          </div>
        </div>
        <div class="form-side">
          <form class="form-card" id="gate-form" novalidate>
            <div>
              <div class="small muted strong" style="letter-spacing:.12em;text-transform:uppercase">NearBuy ${PA.esc(copy.eyebrow)}</div>
              <h1 style="margin-top:6px">Sign in</h1>
              <p class="muted small">Sign in with your ${PA.esc(copy.eyebrow)} account. This workspace is only for your assigned role.</p>
            </div>
            ${message ? `<div class="form-error" role="alert">${PA.esc(message)}</div>` : ''}
            <div class="field">
              <label for="email">Email address</label>
              <input class="input" id="email" name="email" type="email" autocomplete="username" required placeholder="you@shop.in" />
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input class="input" id="password" name="password" type="password" autocomplete="current-password" required minlength="8" placeholder="Your password" />
            </div>
            <button class="btn btn-primary btn-block" type="submit" id="gate-submit">Sign in</button>
            ${state.config.demo !== false ? `<button class="btn btn-block" type="button" id="fill-demo">Fill in the demo sign-in</button>
              <div class="form-note"><b>Demo account</b> ${PA.esc(copy.demo.email)} · ${PA.esc(copy.demo.password)}${state.mode === 'admin' ? '' : ''}.
              Demo data is seeded only outside production.</div>` : ''}
            <div class="row small muted" style="justify-content:space-between">
              <a href="${state.mode === 'admin' ? '/admin/' : state.mode === 'runner' ? '/runner/' : '/seller/'}" style="color:var(--blue)">← Portal sign-in</a>
              <span>${state.mode === 'admin' ? 'Administrators only' : copy.eyebrow + ' accounts only'}</span>
            </div>
          </form>
        </div>
      </div>`;

    const form = $('#gate-form');
    const submit = $('#gate-submit');
    if ($('#fill-demo')) {
      $('#fill-demo').addEventListener('click', () => {
        $('#email').value = copy.demo.email;
        $('#password').value = copy.demo.password;
        $('#email').focus();
      });
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#email').value.trim();
      const password = $('#password').value;
      if (!email || !password) { PA.toast('Enter your email and password.', 'err'); return; }
      submit.disabled = true;
      submit.textContent = 'Signing in…';
      try {
        const data = await PA.api('POST', '/login', { email, password, role: state.mode });
        state.user = data.user;
        state.csrf = data.user.csrf || '';
        state.shop = data.shop || null;
        state.runner = data.runner || null;
        await boot(true);
      } catch (err) {
        submit.disabled = false;
        submit.textContent = 'Sign in';
        const box = form.querySelector('.form-error');
        if (box) box.remove();
        const div = document.createElement('div');
        div.className = 'form-error';
        div.setAttribute('role', 'alert');
        div.textContent = err.message;
        form.insertBefore(div, form.children[1]);
      }
    });
    const first = $('#email');
    if (first) first.focus();
  }

  /* ----------------------------------------------------------------- shell */
  PA.nav = [];
  PA.title = 'Console';

  function renderShell() {
    const roleLabel = state.mode === 'seller' ? (state.shop ? state.shop.name : 'Seller Hub')
      : state.mode === 'runner' ? 'Runner Portal' : 'Admin Portal';
    const subLabel = state.mode === 'seller' ? 'Seller Hub' : state.mode === 'runner' ? 'Delivery partner' : 'Platform operations';
    const avatar = state.mode === 'runner' ? '🛵' : state.mode === 'admin' ? '🛡️' : '🏪';
    document.body.innerHTML = `
      <div class="shell">
        <aside class="side" id="side">
          <a class="brand" href="#/overview" aria-label="NearBuy ${PA.esc(subLabel)}">
            <img src="/public/assets/nearbuy-logo.png" alt="NearBuy" width="40" height="40" />
            <span><b>NearBuy</b><span>${PA.esc(subLabel)}</span></span>
          </a>
          <div class="who">
            <span class="avatar" aria-hidden="true">${avatar}</span>
            <div style="min-width:0">
              <b>${PA.esc(state.user.name)}</b>
              <span>${PA.esc(state.mode === 'seller' ? (state.shop ? state.shop.name + (state.shop.locality ? ' · ' + state.shop.locality : '') : 'No shop linked') : state.user.email)}</span>
            </div>
          </div>
          <nav class="nav" aria-label="Console navigation">
            ${PA.nav.map((n) => `<a href="${n.href}">${PA.icon(n.icon)}<span>${PA.esc(n.label)}</span>${n.count ? `<span class="nav-count hidden" data-count="${n.count}">0</span>` : ''}</a>`).join('')}
          </nav>
          <div class="foot">
            <button class="btn btn-sm" type="button" id="logout" style="background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.2);color:#fff">${PA.icon('logout')} Sign out</button>

          </div>
        </aside>
        <div class="main">
          <header class="topbar">
            <button class="btn btn-sm menu-btn" type="button" id="nav-toggle" aria-label="Open navigation">${PA.icon('menu')}</button>
            <span class="title">${PA.esc(PA.title)}</span>
            <span class="spacer"></span>
            <span class="chip" id="conn-chip"><span class="dot"></span> Live · shared database</span>
            <button class="btn btn-sm" type="button" id="refresh" aria-label="Refresh data">↻</button>
          </header>
          <main class="content" id="view" tabindex="-1" aria-live="polite"></main>
        </div>
      </div>
      <div class="toasts" id="toasts" role="status" aria-live="polite"></div>`;

    $('#nav-toggle').addEventListener('click', () => document.body.classList.toggle('nav-open'));
    $('#side').addEventListener('click', (e) => { if (e.target.closest('.nav a')) document.body.classList.remove('nav-open'); });
    $('#refresh').addEventListener('click', () => render());
    $('#logout').addEventListener('click', async () => {
      try { await PA.api('POST', '/logout', {}); } catch { /* session already gone */ }
      state.user = null;
      state.csrf = '';
      location.reload();
    });
  }

  /* ------------------------------------------------------------------ boot */
  async function boot(skipFetch) {
    if (!skipFetch) {
      try {
        const me = await PA.api('GET', '/me');
        state.user = me.user;
        /* The session CSRF token must be restored with the session, otherwise every
         * mutation after a page reload is refused with "security token is missing". */
        state.csrf = (me.user && me.user.csrf) || '';
        state.shop = me.shop || null;
        state.runner = me.runner || null;
        if (!state.user) {
          try {
            const res = await fetch('/api/customer/bootstrap', { headers: { 'X-NearBuy-Request': '1' } });
            const cfg = await res.json();
            state.config = (cfg && cfg.config) || {};
          } catch { state.config = {}; }
          renderGate();
          return;
        }
      } catch (err) {
        renderGate(err.message);
        return;
      }
    }
    if (!state.user) { renderGate(); return; }
    if (state.user.role !== state.mode) {
      state.user = null; state.csrf = '';
      renderGate('This account does not belong to this portal. Sign in with the correct account for this workspace.');
      return;
    }
    renderShell();
    if (!location.hash) location.hash = PA.home;
    render();
    setInterval(async () => {
      try {
        const me = await PA.api('GET', '/me');
        state.user = me.user;
        if (!state.csrf && me.user && me.user.csrf) state.csrf = me.user.csrf;
        state.shop = me.shop || null;
        state.runner = me.runner || null;
        if (!state.user || state.user.role !== state.mode) { state.user = null; state.csrf = ''; renderGate('Your session ended or this account belongs to a different workspace. Sign in with this portal’s account.'); }
      } catch { /* transient */ }
    }, 60000);
  }

  PA.start = function (config) {
    state.mode = config.mode || 'seller';
    state.base = config.mode === 'admin' ? '/api/admin' : '/api/partner';
    PA.nav = config.nav || [];
    PA.title = config.title || 'Console';
    PA.home = config.home || '#/overview';
    (config.routes || []).forEach(([pattern, handler]) => PA.route(pattern, handler));
    window.addEventListener('hashchange', render);
    boot(false);
  };

  /* Shared little view helpers used by the three consoles */
  PA.field = (id, label, value, { type = 'text', help = '', min, max, step, placeholder = '', required = false } = {}) => `
    <div class="field">
      <label for="${id}">${PA.esc(label)}</label>
      <input class="input" id="${id}" type="${type}" value="${PA.esc(value == null ? '' : value)}"
        ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''} ${step ? `step="${step}"` : ''}
        placeholder="${PA.esc(placeholder)}" ${required ? 'required' : ''} />
      ${help ? `<span class="help">${PA.esc(help)}</span>` : ''}
    </div>`;

  PA.kv = (pairs) => `<dl class="kv">${pairs.filter(Boolean).map(([k, v, raw]) => `<dt>${PA.esc(k)}</dt><dd>${raw ? v : PA.esc(v == null ? '—' : v)}</dd>`).join('')}</dl>`;

  PA.timeline = (events) => `<div class="timeline">${events.map((e, i) => `
    <div class="step ${i === events.length - 1 ? 'current' : 'done'}">
      <span class="dot">${i + 1}</span>
      <div><b>${PA.esc(e.label || e.status)}</b><span>${PA.esc(e.detail || '')}</span><span>${PA.dateTime(e.at)} · ${PA.esc(e.actor || 'system')}</span></div>
    </div>`).join('')}</div>`;

  PA.print = (html) => {
    const w = window.open('', '_blank', 'noopener,width=840,height=900');
    if (!w) { PA.toast('Allow pop-ups to print this receipt.', 'err'); return; }
    w.document.write(html);
    w.document.close();
  };
})();
