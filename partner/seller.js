/* NearBuy Seller Hub — Manage Your Business. Grow Your Sales.
 * The complete business management console for verified local shops: orders,
 * packing, inventory, barcode/QR scanning, delivery & runner fulfilment,
 * promotions, analytics, settlements, staff, KYC, hours, reports, support
 * and settings. Every read and write goes to /api/partner/seller/* on the
 * shared platform backend, so the customer storefront sees the same stock,
 * prices, shop status and orders in real time.
 */
(function () {
  'use strict';
  const PA = window.PA;
  const esc = PA.esc;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ------------------------------------------------------------- navigation */
  const GROUPS = [
    { label: 'Workspace', items: [
      { href: '#/overview', label: 'Dashboard', icon: 'grid' },
      { href: '#/orders', label: 'Orders', icon: 'orders', count: 'newOrders' },
      { href: '#/returns', label: 'Returns & Refunds', icon: 'rotate' },
      { href: '#/products', label: 'Products', icon: 'box' },
      { href: '#/inventory', label: 'Inventory Management', icon: 'layers' },
      { href: '#/scanner', label: 'Barcode / QR Scanner', icon: 'scan' }
    ] },
    { label: 'Grow your shop', items: [
      { href: '#/categories', label: 'Categories', icon: 'tag' },
      { href: '#/customers', label: 'Customers', icon: 'users' },
      { href: '#/delivery', label: 'Delivery & Pickup', icon: 'truck' },
      { href: '#/runner', label: 'NearBuy Runner', icon: 'bike' },
      { href: '#/promotions', label: 'Promotions & Offers', icon: 'percent' },
      { href: '#/analytics', label: 'Sales Analytics', icon: 'chart' },
      { href: '#/revenue', label: 'Revenue & Payments', icon: 'wallet' },
      { href: '#/settlements', label: 'Settlements', icon: 'rupee' }
    ] },
    { label: 'Your business', items: [
      { href: '#/staff', label: 'Staff Management', icon: 'team' },
      { href: '#/profile', label: 'Shop Profile & KYC', icon: 'store' },
      { href: '#/hours', label: 'Business Hours', icon: 'clock' },
      { href: '#/reports', label: 'Reports & Invoices', icon: 'file' },
      { href: '#/notifications', label: 'Notifications', icon: 'bell', count: 'unread' },
      { href: '#/support', label: 'Support Centre', icon: 'help' },
      { href: '#/settings', label: 'Settings', icon: 'settings' }
    ] }
  ];

  const cache = { products: [], categories: [] };

  /* --------------------------------------------------------------- helpers */
  function gateBanner() {
    const user = PA.state.user || {};
    const vStatus = String(user.status === 'pending_verification' ? 'submitted' : '');
    if (user.status !== 'pending_verification') return '';
    return `<div class="banner-note warn"><b>${PA.icon('shield')} Verification in progress</b> — ${esc(vStatus === 'submitted' ? 'Your KYC application is with the NearBuy admin team.' : 'Your account awaits approval.')} You can explore the Seller Hub and prepare your catalogue, but orders and selling features unlock once your shop is approved.</div>`;
  }

  function pageHead(title, sub, actionsHtml) {
    return `<div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<p class="muted small">${sub}</p>` : ''}</div>${actionsHtml ? `<div class="row">${actionsHtml}</div>` : ''}</div>${gateBanner()}`;
  }

  function money(paise) { return PA.money(paise); }

  function lineChart(points, { height = 150, stroke = '#0866D9', fill = 'rgba(8,102,217,.12)', labelFmt = (v) => v } = {}) {
    if (!points.length) return '<p class="muted small">No data yet.</p>';
    const w = 640, h = height, padX = 6, padY = 14;
    const max = Math.max(...points.map((p) => p.value), 1);
    const stepX = points.length > 1 ? (w - padX * 2) / (points.length - 1) : 0;
    const coords = points.map((p, i) => [padX + i * stepX, h - padY - (p.value / max) * (h - padY * 2)]);
    const path = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = `${path} L${coords[coords.length - 1][0].toFixed(1)},${h - padY} L${coords[0][0].toFixed(1)},${h - padY} Z`;
    const dots = coords.filter((c, i) => points.length <= 31 || i % Math.ceil(points.length / 31) === 0)
      .map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4" fill="${stroke}"/>`).join('');
    return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Trend chart">
      <path d="${area}" fill="${fill}" stroke="none"/>
      <path d="${path}" fill="none" stroke="${stroke}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
    </svg>
    <div class="row" style="justify-content:space-between"><span class="small muted">${esc(points[0].label || '')}</span>
      <span class="small muted">Peak ${esc(labelFmt(max))}</span>
      <span class="small muted">${esc(points[points.length - 1].label || '')}</span></div>`;
  }

  function barRows(items, { valueFmt = (v) => v, color = '#168BEE' } = {}) {
    if (!items.length) return '<p class="muted small">No data yet.</p>';
    const max = Math.max(...items.map((i) => i.value), 1);
    return `<div class="stack" style="gap:9px">${items.map((i) => `
      <div class="row tight"><span class="small" style="width:150px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(i.label)}">${esc(i.label)}</span>
        <div class="progress grow" style="height:12px"><span style="width:${Math.max(3, (i.value / max) * 100).toFixed(1)}%;background:${color}"></span></div>
        <b class="small" style="flex:none;min-width:64px;text-align:right">${esc(valueFmt(i.value))}</b></div>`).join('')}</div>`;
  }

  function donut(items, size = 170) {
    const total = items.reduce((t, i) => t + i.value, 0);
    if (!total) return '<p class="muted small">No data yet.</p>';
    const colors = ['#063B78', '#0866D9', '#168BEE', '#13BDE5', '#19A957', '#F59E0B', '#E5484D', '#62758B'];
    const r = 60, c = 2 * Math.PI * r;
    let offset = 0;
    const slices = items.map((i, idx) => {
      const frac = i.value / total;
      const seg = `<circle cx="80" cy="80" r="${r}" fill="none" stroke="${colors[idx % colors.length]}" stroke-width="22"
        stroke-dasharray="${(frac * c).toFixed(2)} ${(c - frac * c).toFixed(2)}" stroke-dashoffset="${(-offset * c).toFixed(2)}" transform="rotate(-90 80 80)"/>`;
      offset += frac;
      return seg;
    }).join('');
    return `<div class="row" style="gap:20px;align-items:center;flex-wrap:wrap">
      <svg viewBox="0 0 160 160" width="${size}" height="${size}" role="img" aria-label="Category share">${slices}
        <text x="80" y="86" text-anchor="middle" font-size="15" font-weight="800" fill="#142D4B">${money(total)}</text></svg>
      <div class="legend" style="flex-direction:column;align-items:flex-start;gap:6px">${items.map((i, idx) => `
        <span><i style="background:${colors[idx % colors.length]}"></i>${esc(i.label)} · ${((i.value / total) * 100).toFixed(0)}%</span>`).join('')}</div></div>`;
  }

  async function promptText(title, help, opts = {}) {
    return new Promise((resolve) => {
      let value = '';
      PA.modal({
        title,
        body: `<p class="muted small">${esc(help || '')}</p>
          <div class="field"><label for="prompt-value">${esc(title)}</label>
          <input class="input" id="prompt-value" autocomplete="off" ${opts.numeric ? 'inputmode="numeric"' : ''} ${opts.maxLength ? `maxlength="${opts.maxLength}"` : ''} /></div>`,
        actions: [
          { label: 'Cancel', onClick: () => resolve('') },
          { label: opts.confirmLabel || 'Submit', primary: true, onClick: (back) => { value = back.querySelector('#prompt-value').value.trim(); resolve(value); } }
        ],
        onMount: (back) => back.querySelector('#prompt-value').focus()
      });
    });
  }

  function csvDownload(name, rows) {
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ------------------------------------------------------------- dashboard */
  const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['month', 'This month'], ['last_month', 'Last month'], ['this_year', 'This year'], ['last_year', 'Last year'], ['year', 'Rolling year']];

  async function overview(match, ctx) {
    const [data, analytics] = await Promise.all([
      PA.api('GET', '/seller/overview'),
      PA.api('GET', '/seller/analytics?range=30d').catch(() => null)
    ]);
    if (!ctx.isCurrent()) return;
    const shop = data.shop || {};
    const c = data.counts || {};
    const prodStats = data.products || {};
    const recent = data.recent || [];
    /* `/seller/analytics` returns { metrics, series }; never assume either is present. */
    const anMetrics = analytics && analytics.metrics ? analytics.metrics : null;
    const anSeries = analytics && Array.isArray(analytics.series) ? analytics.series : [];
    PA.set(`
      ${pageHead(`${shop.name || 'Your shop'} — Dashboard`,
        `${shop.verified ? '✓ Verified seller' : 'Verification pending'} · Seller ID ${esc(shop.sellerId || '—')} · Shop ID ${esc(shop.shopId || '—')} · ${shop.isOpen ? 'Open now' : 'Closed'} · ${shop.opensAt || ''}–${shop.closesAt || ''}`,
        `<a class="btn" href="#/products/new">${PA.icon('plus')} Add product</a><a class="btn btn-primary" href="#/orders?status=new">View new orders</a>`)}

      <div class="kpi-grid">
        <div class="kpi accent"><span class="label">Total orders</span><span class="value">${c.total ?? 0}</span><span class="hint">${c.new ?? 0} new · waiting on you</span></div>
        <div class="kpi accent"><span class="label">New orders</span><span class="value">${c.new ?? 0}</span><span class="hint">Accept or reject promptly</span></div>
        <div class="kpi"><span class="label">Accepted</span><span class="value">${c.accepted ?? 0}</span><span class="hint">In your kitchen / counter queue</span></div>
        <div class="kpi green"><span class="label">Completed</span><span class="value">${c.completed ?? 0}</span><span class="hint">Delivered and picked up</span></div>
        <div class="kpi green"><span class="label">Gross sales</span><span class="value">${money(data.grossSales || 0)}</span><span class="hint">Refunds −${money(data.refunds || 0)}</span></div>
        <div class="kpi green"><span class="label">Net revenue</span><span class="value">${money(data.revenue || 0)}</span><span class="hint">${c.completed || 0} completed order(s)</span></div>
        <div class="kpi"><span class="label">Products live</span><span class="value">${prodStats.inStock ?? 0}</span><span class="hint">${prodStats.total ?? 0} active listings</span></div>
        <div class="kpi ${prodStats.lowStock ? 'amber' : ''}"><span class="label">Low stock</span><span class="value">${prodStats.lowStock ?? 0}</span><span class="hint">At or below reorder level</span></div>
        <div class="kpi ${(prodStats.outStock || 0) ? 'red' : ''}"><span class="label">Out of stock</span><span class="value">${prodStats.outStock ?? 0}</span><span class="hint">Blocked at checkout automatically</span></div>
      </div>

      <div class="grid g2">
        <div class="card chart-card flush">
          <div class="card-head"><h2>Sales — last 30 days</h2><span class="spacer"></span><a class="small" href="#/analytics">Full analytics</a></div>
          <div class="card-body">
            ${(anMetrics && anSeries.length)
              ? lineChart(anSeries.map((d) => ({ label: d.date.slice(5), value: d.sales })), { labelFmt: money })
              : '<p class="muted small">Sales will appear here once orders start coming in.</p>'}
          </div>
          <div class="card-foot row" style="justify-content:space-between">
            <span class="small muted">Order volume ${anMetrics ? anMetrics.orderCount : 0} · AOV ${money(anMetrics ? anMetrics.averageOrderValue : 0)}</span>
            <span class="small muted">Refunds ${money(anMetrics ? anMetrics.refunds : 0)}</span>
          </div>
        </div>

        <div class="stack">
          <div class="card flush">
            <div class="card-head"><h3>Needs you now</h3><span class="spacer"></span><a class="small" href="#/orders">All orders</a></div>
            <div class="card-body">
              ${recent.length ? `<div class="list">${recent.map((o) => `
                <div class="item">
                  <span class="emoji">${o.fulfillment === 'pickup' ? '🏬' : o.status === 'placed' ? '🔔' : '📦'}</span>
                  <div class="grow"><b>${esc(o.code)} · ${money(o.total)}</b>
                    <span>${esc(o.customer || 'Customer')} · ${esc(o.fulfillment || '')} · ${PA.ago(o.createdAt)}</span></div>
                  ${PA.status(o.status)}
                  <a class="btn btn-sm" href="#/orders/${encodeURIComponent(o.code)}">Open</a>
                </div>`).join('')}</div>`
          : PA.empty('📦', 'No orders yet', 'New customer orders appear here with an alert as soon as they are placed.')}
            </div>
          </div>
          <div class="card flush">
            <div class="card-head"><h3>Low stock</h3><span class="spacer"></span><a class="small" href="#/inventory">Inventory</a></div>
            <div class="card-body">
              ${(data.lowStock || []).length ? `<div class="list">${data.lowStock.map((p) => `
                <div class="item"><span class="emoji">${esc(p.emoji || '📦')}</span>
                  <div class="grow"><b>${esc(p.name)}</b><span>${p.available ?? p.stock} left · reorder at ${p.lowAt}</span></div>
                  <a class="btn btn-sm" href="#/inventory">Restock</a></div>`).join('')}</div>`
          : PA.empty('✅', 'Stock levels are healthy', 'Products at or below their low-stock threshold show up here.')}
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>Quick actions</h3>
        <div class="row" style="margin-top:12px;flex-wrap:wrap">
          <a class="btn" href="#/products/new">${PA.icon('plus')} Add new product</a>
          <a class="btn" href="#/scanner">${PA.icon('scan')} Scan product</a>
          <a class="btn" href="#/inventory">Manage inventory</a>
          <a class="btn" href="#/orders?status=new">${PA.icon('bell')} View new orders</a>
          <a class="btn" href="#/promotions/new">${PA.icon('percent')} Create offer</a>
          <a class="btn" href="#/runner">Request runner</a>
          <a class="btn" href="#/settlements">View settlements</a>
        </div>
      </div>
    `);
    PA.badges({ newOrders: c.new || 0, unread: data.unread || 0 });
  }

  /* ---------------------------------------------------------------- orders */
  const FILTERS = [
    ['all', 'All'], ['new', 'New'], ['accepted', 'Accepted'], ['preparing', 'Preparing'],
    ['ready', 'Ready'], ['runner_requested', 'Runner requested'], ['runner_assigned', 'Runner assigned'],
    ['out_for_delivery', 'Out for delivery'], ['delivered', 'Delivered'], ['completed', 'Completed'],
    ['cancelled', 'Cancelled'], ['rejected', 'Rejected']
  ];

  async function orders(match, ctx) {
    const filter = new URLSearchParams(location.hash.split('?')[1] || '').get('status') || 'all';
    const data = await PA.api('GET', `/seller/orders?status=${encodeURIComponent(filter)}`);
    cache.orders = data.orders;
    if (!ctx.isCurrent()) return;
    PA.set(`
      ${pageHead('Orders', `${esc(data.shop.name)} — every customer order from the storefront, scoped to your shop only.`)}
      <div class="tabs" role="tablist" style="margin:4px 0 16px">${FILTERS.map(([key, label]) => `<a href="#/orders?status=${key}" ${key === filter ? 'aria-current="page"' : ''}>${esc(label)}</a>`).join('')}</div>
      ${data.orders.length ? `<div class="stack">${data.orders.map(orderCard).join('')}</div>`
        : `<div class="card">${PA.empty('🧾', 'Nothing here', filter === 'new' ? 'No new orders are waiting for you.' : `No orders match “${filter}”.`)}</div>`}
    `);
    wireOrders();
    PA.badges({ newOrders: cache.orders.filter((o) => o.status === 'placed').length });
  }

  const NEXT = {
    placed: [['accept', 'Accept order', 'btn-success'], ['reject', 'Reject', 'btn-danger']],
    accepted: [['prepare', 'Start preparing', 'btn-primary'], ['cancel', 'Cancel', 'btn-danger']],
    preparing: [['ready', 'Mark packed & ready', 'btn-primary']],
    ready: [['request_runner', PA.icon('bike') + ' Find a NearBuy runner', 'btn-primary'], ['self_deliver', 'Deliver myself', '']],
    runner_requested: [['cancel_runner', 'Cancel request', ''], ['confirm_handover', 'Confirm handover', 'btn-primary']],
    runner_assigned: [['confirm_handover', 'Confirm package handover', 'btn-primary'], ['cancel_runner', 'Cancel assignment', '']]
  };

  function orderCard(o) {
    const actions = [];
    if (o.status === 'ready' && o.fulfillment === 'pickup') actions.push(['complete_pickup', 'Verify collection code', 'btn-success']);
    else if (NEXT[o.status]) actions.push(...NEXT[o.status]);
    if (o.status === 'out_for_delivery' && !o.runner) actions.push(['deliver', 'Complete with delivery OTP', 'btn-success']);
    const address = o.address;
    const packing = o.packing || null;
    const fd = o.fulfillmentDetail || {};
    const runnerName = o.runner ? (typeof o.runner === 'object' ? o.runner.name : o.runner) : null;
    const assignmentStatus = fd.assignment ? fd.assignment.status : null;
    return `
      <article class="card" data-order="${esc(o.code)}">
        <div class="space-between">
          <div>
            <div class="row tight"><b class="mono">${esc(o.code)}</b>${PA.status(o.status, o.statusLabel)}
              ${PA.badge(o.fulfillment === 'pickup' ? 'Store pickup' : 'Home delivery', o.fulfillment === 'pickup' ? 'blue' : 'grey')}
              ${o.paymentMethod === 'cod' ? PA.badge('Cash on delivery', 'amber') : o.paymentMethod === 'pay_at_store' ? PA.badge('Pay at store', 'amber') : PA.badge('Online paid', 'green')}
              ${packing && packing.partial ? PA.badge('Partial fulfilment', 'amber') : ''}
            </div>
            <div class="muted small">${PA.dateTime(o.createdAt)} · parent order <span class="mono">${esc(o.parentCode || '—')}</span> · ${o.itemCount} item(s)${fd.deliveryStaffName ? ' · staff ' + esc(fd.deliveryStaffName) : ''}</div>
          </div>
          <div class="right"><b style="font-size:19px;color:var(--deep)">${money(o.total)}</b>
            <div class="muted small">${o.paymentStatus === 'paid' ? 'Paid' : 'Payment pending'}</div></div>
        </div>

        <div class="grid g2" style="margin-top:14px">
          <div>
            <b class="small">Items</b>
            <div class="list" style="margin-top:6px">
              ${o.items.map((i) => `<div class="item"><span class="emoji">${esc(i.emoji || '📦')}</span>
                <div class="grow"><b>${esc(i.name)}</b><span>${esc([i.variant, i.unit].filter(Boolean).join(' · '))} · ${i.qty} × ${money(i.price)}</span></div>
                <b>${money(i.price * i.qty)}</b></div>`).join('')}
            </div>
            ${packing ? `<div class="banner-note ${packing.complete ? 'ok' : ''}" style="margin-top:10px"><b>Packing</b> — ${packing.packed}/${packing.ordered} packed${packing.missing ? `, ${packing.missing} reported missing` : ''}${packing.complete ? ' ✓ complete' : ''}${packing.partialNote ? `<div class="small">Note to customer: ${esc(packing.partialNote)}</div>` : ''}</div>` : ''}
            ${(runnerName || assignmentStatus) ? `<div class="banner-note info" style="margin-top:10px"><b>NearBuy runner</b> — ${runnerName ? esc(runnerName) + ' is your rider' : 'assignment in progress'}${assignmentStatus ? ` (${esc(String(assignmentStatus).replace(/_/g, ' '))})` : ''}${fd.runnerCharges ? ` · charges ${money(fd.runnerCharges)}` : ''}</div>` : ''}
          </div>
          <div class="stack" style="gap:8px">
            ${PA.kv([
              ['Customer', o.customer.name + (o.customer.maskedPhone ? ' · ' + o.customer.maskedPhone : '')],
              o.fulfillment === 'pickup' ? ['Collect from', 'Your counter · bring the order code'] : ['Deliver to', [address?.line1, address?.locality, address?.pincode].filter(Boolean).join(', ')],
              address?.instructions ? ['Instructions', address.instructions] : null,
              ['Subtotal', money(o.subtotal)],
              o.discount ? ['Discount', '−' + money(o.discount)] : null,
              ['Delivery / pickup fee', money(o.deliveryFee)],
              ['Tax', money(o.tax)]
            ])}
            ${o.handoverPin ? `<div class="banner-note warn"><b>Handover PIN ${esc(o.handoverPin)}</b> — share this only with the accepting NearBuy runner at pickup.</div>` : ''}
            ${o.receiptUrl ? `<a class="btn btn-sm" href="${o.receiptUrl}" target="_blank" rel="noopener">${PA.icon('print')} Print seller receipt</a>` : ''}
          </div>
        </div>

        <div class="card-foot" style="margin:14px -18px -18px;border-radius:0 0 16px 16px">
          <div class="row">
            ${actions.map(([action, label, cls]) => `<button class="btn ${cls || ''}" data-act="${action}" data-code="${esc(o.code)}">${label}</button>`).join('')}
            <span class="spacer"></span>
            <a class="btn btn-sm" href="#/orders/${encodeURIComponent(o.code)}">Open order workspace</a>
          </div>
        </div>
      </article>`;
  }

  function wireOrders() {
    PA.onAll('[data-act]', 'click', async (e) => {
      const btn = e.currentTarget;
      const action = btn.dataset.act;
      const code = btn.dataset.code;
      try {
        if (action === 'reject' || action === 'cancel') {
          const reason = await promptText(action === 'reject' ? 'Why are you rejecting this order?' : 'Why are you cancelling?',
            'The customer sees this reason on their order page.');
          if (!reason) return;
          btn.disabled = true;
          await PA.api('POST', `/seller/orders/${encodeURIComponent(code)}/action`, { action, reason });
          PA.toast(`Order ${action === 'reject' ? 'rejected' : 'cancelled'} and reserved stock released.`);
          return PA.render();
        }
        if (action === 'deliver' || action === 'complete_pickup') {
          const otp = await promptText(action === 'deliver' ? 'Customer delivery OTP' : 'Customer collection code',
            'Ask the customer to read the 6-digit code from their order page. It is verified on the server.', { numeric: true, maxLength: 6 });
          if (!otp) return;
          btn.disabled = true;
          await PA.api('POST', `/seller/orders/${encodeURIComponent(code)}/action`, { action, otp: String(otp).trim() });
          PA.toast(action === 'deliver' ? 'Delivery verified with OTP.' : 'Collection verified — order completed.');
          return PA.render();
        }
        if (action === 'request_runner') {
          return openRunnerRequestModal(code, btn);
        }
        if (action === 'cancel_runner') {
          const ok = await PA.confirm('Cancel runner request?', 'Any offer or assignment will be withdrawn. You can request again or switch to self-delivery.');
          if (!ok) return;
          btn.disabled = true;
          await PA.api('POST', `/seller/orders/${encodeURIComponent(code)}/action`, { action });
          PA.toast('Runner request cancelled.');
          return PA.render();
        }
        if (action === 'confirm_handover') {
          const pin = await promptText('Handover PIN confirmation', 'Read back the 4-digit PIN shown by the runner and confirm the package was handed over.', { numeric: true, maxLength: 4, confirmLabel: 'Confirm handover' });
          if (!pin) return;
          btn.disabled = true;
          await PA.api('POST', `/seller/orders/${encodeURIComponent(code)}/action`, { action, pin: String(pin).trim() });
          PA.toast('Package handover confirmed.');
          return PA.render();
        }
        if (action === 'self_deliver') {
          let body = { action };
          try {
            const del = await PA.api('GET', '/seller/delivery');
            if ((del.staff || []).length) {
              const who = await pickFromList('Who is delivering this order?', del.staff.map((s) => ({ id: s.id, label: `${s.name}${s.phone ? ' · ' + s.phone : ''}` })));
              if (who) body = { ...body, staffId: who };
            }
          } catch { /* staff list is optional */ }
          btn.disabled = true;
          await PA.api('POST', `/seller/orders/${encodeURIComponent(code)}/action`, body);
          PA.toast('Self-delivery started. Complete it with the customer’s OTP at the door.');
          return PA.render();
        }
        btn.disabled = true;
        const res = await PA.api('POST', `/seller/orders/${encodeURIComponent(code)}/action`, { action });
        PA.toast(res.message || 'Order updated.');
        PA.render();
      } catch (err) {
        btn.disabled = false;
        if (err.data && err.data.alternatives) {
          PA.modal({
            title: 'No runner available right now',
            body: `<p>${esc(err.message)}</p><ul class="small muted">${err.data.alternatives.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`,
            actions: [{ label: 'Close' }]
          });
          return;
        }
        if (err.data && err.data.packing) {
          PA.toast(`${err.message}`, 'err');
          PA.go('#/orders/' + encodeURIComponent(code));
          return;
        }
        PA.toast(err.message, 'err');
      }
    });
  }

  function pickFromList(title, options) {
    return new Promise((resolve) => {
      PA.modal({
        title,
        body: `<div class="stack" style="gap:8px">${options.map((o) => `<button class="btn" data-pick="${esc(o.id)}" style="justify-content:flex-start">${esc(o.label)}</button>`).join('')}
          <button class="btn" data-pick="" style="justify-content:flex-start">Just me / unassigned</button></div>`,
        actions: [],
        onMount: (back) => back.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { resolve(b.dataset.pick || null); back.remove(); }))
      });
    });
  }

  function openRunnerRequestModal(code, btn) {
    PA.modal({
      title: 'Find a NearBuy runner',
      wide: true,
      body: `<p class="muted small">Nearby runners get this request one at a time. You stay in control until a runner accepts — nothing is auto-assigned.</p>
        <div class="grid g2">
          ${PA.field('rr-weight', 'Total order weight (grams)', '', { type: 'number', min: 0, help: 'Approximate packed weight, if known.' })}
          ${PA.field('rr-packages', 'Number of packages', '1', { type: 'number', min: 1, max: 20 })}
        </div>
        <div class="field"><label for="rr-timing">Requested timing</label>
          <select class="input" id="rr-timing"><option value="asap">As soon as possible</option><option value="within_1h">Within 1 hour</option><option value="evening">This evening</option></select></div>
        <div class="banner-note info">Runner charges are calculated by the platform from distance and weight and are added to the delivery record once a runner accepts.</div>`,
      actions: [
        { label: 'Not now' },
        { label: 'Send request to nearby runners', primary: true, onClick: async (back) => {
            btn.disabled = true;
            const res = await PA.api('POST', `/seller/orders/${encodeURIComponent(code)}/action`, {
              action: 'request_runner',
              weightGrams: Number(back.querySelector('#rr-weight').value) || undefined,
              packages: Number(back.querySelector('#rr-packages').value) || 1,
              timing: back.querySelector('#rr-timing').value
            });
            PA.toast(res.message || 'Runners notified.');
            PA.render();
          } }
      ]
    });
  }

  /* -------------------------------------------------- order detail + packing */
  async function orderDetail(match, ctx) {
    const code = decodeURIComponent(match[1]);
    const [data, packData] = await Promise.all([
      PA.api('GET', '/seller/orders?status=all'),
      PA.api('GET', `/seller/orders/${encodeURIComponent(code)}/packing`).catch(() => null)
    ]);
    cache.orders = data.orders;
    const o = data.orders.find((x) => x.code === code);
    if (!ctx.isCurrent()) return;
    if (!o) {
      PA.set(`<div class="card">${PA.empty('🔍', 'Order not found', 'This order does not belong to your shop.', '<a class="btn" href="#/orders">Back to orders</a>')}</div>`);
      return;
    }
    const canPack = ['accepted', 'preparing', 'ready'].includes(o.status) && packData;
    PA.set(`
      <div class="row"><a class="btn" href="#/orders">← All orders</a><span class="spacer"></span>
        ${o.receiptUrl ? `<a class="btn" href="${o.receiptUrl}" target="_blank" rel="noopener">${PA.icon('print')} Receipt</a>` : ''}</div>
      ${orderCard(o)}
      ${canPack ? packingWorkspace(packData) : ''}
      ${o.status === 'completed' || o.status === 'delivered' ? `<div class="card"><h3>Fulfilment summary</h3><p class="muted small">This order is finished. Stock, payments and settlement records reflect its final totals.</p></div>` : ''}
    `);
    wireOrders();
    if (canPack) wirePacking(code, packData);
  }

  function packingWorkspace(p) {
    const items = p.items || [];
    return `
      <div class="card flush" id="pack-card">
        <div class="card-head"><h2>Packing checklist</h2><span class="spacer"></span>
          <span class="badge ${p.summary.complete ? 'green' : 'amber'}">${p.summary.packed}/${p.summary.ordered} packed</span></div>
        <div class="card-body">
          <div class="progress" style="margin-bottom:12px"><span style="width:${p.summary.ordered ? Math.min(100, Math.round((p.summary.packed / p.summary.ordered) * 100)) : 0}%"></span></div>
          <div class="pack-row" style="border-bottom:2px solid #dce8f5"><b class="small">Product</b><b class="small">Ordered</b><b class="small">Packed qty</b><b class="small">Status</b></div>
          ${items.map((i) => `
            <div class="pack-row" data-pack-item="${esc(i.orderItemId)}">
              <div><span class="emoji">${esc(i.emoji || '📦')}</span> <b>${esc(i.name)}</b><span class="muted small">${esc(i.unit || '')}</span></div>
              <span>× ${i.orderedQty}</span>
              <input class="input num-input" data-packed inputmode="numeric" min="0" max="${i.orderedQty}" value="${i.packedQty ?? 0}" />
              <span>${PA.status(i.status || 'pending')}${i.missingQty ? `<div class="small muted">${i.missingQty} missing</div>` : ''}</span>
            </div>`).join('')}
          <div class="field" style="margin-top:14px"><label class="row tight"><input type="checkbox" id="partial-flag" ${p.order.partial ? 'checked' : ''} /> Partial fulfilment note</label>
            <input class="input" id="partial-note" placeholder="Explain what is short and why (shown to the customer)" value="${esc(p.order.partialNote || '')}" /></div>
        </div>
        <div class="card-foot row">
          <button class="btn" id="save-packing">Save packing progress</button>
          <button class="btn btn-primary" id="mark-complete">Complete packing & mark ready</button>
          <span class="spacer"></span>
          <span class="muted small">An order cannot become Ready until everything is packed or a partial-fulfilment note resolves every shortfall.</span>
        </div>
      </div>`;
  }

  function wirePacking(code, packData) {
    async function saveEach(markReady) {
      const rows = $$('#pack-card [data-pack-item]');
      const note = $('#partial-note').value.trim();
      const partial = $('#partial-flag').checked;
      for (const row of rows) {
        const orderItemId = row.getAttribute('data-pack-item');
        const qty = Math.max(0, Math.min(Number(row.querySelector('[data-packed]').value) || 0, 100000));
        const item = packData.items.find((i) => String(i.orderItemId) === String(orderItemId));
        const ordered = item ? item.orderedQty : qty;
        const short = Math.max(0, ordered - qty);
        // A shortfall only clears the ready gate when partial fulfilment is declared and explained.
        const declaredMissing = partial ? short : 0;
        const status = declaredMissing > 0 ? 'missing' : (short === 0 ? 'packed' : 'packing');
        await PA.api('POST', `/seller/orders/${encodeURIComponent(code)}/packing`, { orderItemId, packedQty: Math.min(qty, ordered), missingQty: declaredMissing, status, partial, partialNote: note });
      }
      return true;
    }
    PA.on('#save-packing', 'click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try { await saveEach(false); PA.toast('Packing progress saved.'); PA.render(); }
      catch (err) { PA.toast(err.message, 'err'); btn.disabled = false; }
    });
    PA.on('#mark-complete', 'click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await saveEach(true);
        const res = await PA.api('POST', `/seller/orders/${encodeURIComponent(code)}/action`, { action: 'ready' });
        PA.toast(res.message || 'Packing complete — order is ready.');
        PA.render();
      } catch (err) { PA.toast(err.message, 'err'); btn.disabled = false; }
    });
  }

  /* --------------------------------------------------------------- products */
  let productFilter = '';
  let searchTimer = null;

  async function products(match, ctx) {
    const data = await PA.api('GET', '/seller/products');
    cache.products = data.products;
    cache.categories = data.categories || [];
    if (!ctx.isCurrent()) return;
    const q = (productFilter || '').toLowerCase();
    const rows = data.products.filter((p) => !q || `${p.name} ${p.sku || ''} ${p.barcode || ''} ${p.brand || ''} ${p.category}`.toLowerCase().includes(q));
    const live = rows.filter((p) => p.active && !p.archived);
    PA.set(`
      ${pageHead('Products & catalogue', 'Edits here change the customer storefront immediately — there is no second copy of the catalogue.',
        `<button class="btn" id="bulk-import">${PA.icon('download')} Bulk import</button><a class="btn btn-primary" href="#/products/new">${PA.icon('plus')} Add product</a>`)}

      <div class="kpi-grid">
        <div class="kpi accent"><span class="label">Listings</span><span class="value">${rows.length}</span><span class="hint">${live.length} active on the storefront</span></div>
        <div class="kpi amber"><span class="label">Low stock</span><span class="value">${rows.filter((p) => p.available > 0 && p.lowAt && p.available <= p.lowAt).length}</span><span class="hint">At or below reorder level</span></div>
        <div class="kpi red"><span class="label">Out of stock</span><span class="value">${rows.filter((p) => p.available <= 0).length}</span><span class="hint">Blocked at checkout</span></div>
      </div>

      <div class="card flush">
        <div class="card-head">
          <h2>All products</h2><span class="spacer"></span>
          <input class="input" id="prod-search" placeholder="Search name, SKU, barcode, brand…" value="${esc(productFilter)}" style="max-width:300px" />
        </div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Product</th><th>SKU / Barcode</th><th>Category</th><th class="right">Price</th><th class="right">Stock</th><th>Sales</th><th>Status</th><th class="right">Actions</th></tr></thead>
          <tbody>${rows.length ? rows.map(productRow).join('') : `<tr><td colspan="8" class="muted small" style="text-align:center;padding:26px">No products match your search.</td></tr>`}</tbody>
        </table></div>
      </div>`);

    PA.on('#prod-search', 'input', (e) => {
      productFilter = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { if (ctx.isCurrent()) products(null, ctx); }, 250);
    });
    PA.on('#bulk-import', 'click', () => bulkImportModal());
    wireProductActions();
  }

  function productRow(p) {
    const available = Math.max(0, p.available ?? (p.stock - (p.reserved || 0)));
    const statusBadge = !p.active ? PA.badge('Inactive listing', 'grey')
      : p.archived ? PA.badge('Archived', 'grey')
      : available <= 0 ? PA.badge('Out of stock', 'red')
      : p.lowAt && available <= p.lowAt ? PA.badge('Low stock', 'amber')
      : PA.badge('Live', 'green');
    return `<tr>
      <td><div class="row tight"><span class="emoji">${esc(p.emoji || '📦')}</span>
        <div><b>${esc(p.name)}</b>${p.variant ? `<span class="small muted"> · ${esc(p.variant)}</span>` : ''}
          <div class="small muted">${esc(p.unit || '')}${p.packSize ? ' · ' + esc(p.packSize) : ''}</div></div></div></td>
      <td class="mono small">${esc(p.sku || '—')}<div class="small muted">${esc(p.barcode || '')}</div></td>
      <td>${esc(p.category)}</td>
      <td class="right"><b>${money(p.price)}</b>${p.mrp && p.mrp > p.price ? `<div class="small muted"><s>${money(p.mrp)}</s></div>` : ''}</td>
      <td class="right"><b>${available}</b>${p.reserved ? `<div class="small muted">${p.reserved} reserved</div>` : ''}</td>
      <td class="small muted">${p.reviewCount ? `${p.reviewCount} review(s)` : '—'}</td>
      <td>${statusBadge}</td>
      <td class="right row" style="justify-content:flex-end;gap:6px">
        <a class="btn btn-sm" href="#/products/${encodeURIComponent(p.id)}/edit">${PA.icon('edit')} Edit</a>
        <button class="btn btn-sm" data-prod-act="duplicate" data-id="${esc(p.id)}">${PA.icon('copy')} Duplicate</button>
        <button class="btn btn-sm" data-prod-act="${p.active ? 'deactivate' : 'activate'}" data-id="${esc(p.id)}">${p.active ? 'Deactivate' : 'Activate'}</button>
        ${p.archived ? '<span class="badge grey">Archived</span>' : `<button class="btn btn-sm btn-danger" data-prod-act="archive" data-id="${esc(p.id)}">Archive</button>`}
      </td>
    </tr>`;
  }

  function wireProductActions() {
    PA.onAll('[data-prod-act]', 'click', async (e) => {
      const btn = e.currentTarget;
      const act = btn.dataset.prodAct;
      const id = btn.dataset.id;
      try {
        if (act === 'duplicate') {
          const res = await PA.api('POST', `/seller/products/${encodeURIComponent(id)}/duplicate`, {});
          PA.toast(`Duplicated as “${res.product.name}” — review its price and stock.`);
          return PA.render();
        }
        if (act === 'archive') {
          const ok = await PA.confirm('Archive this product?', 'Archived products disappear from the storefront but keep their history for reports.');
          if (!ok) return;
          await PA.api('DELETE', `/seller/products/${encodeURIComponent(id)}`);
          PA.toast('Product archived.');
          return PA.render();
        }
        btn.disabled = true;
        await PA.api('PATCH', `/seller/products/${encodeURIComponent(id)}`, { active: act === 'activate' });
        PA.toast(act === 'activate' ? 'Listing activated — customers can buy it now.' : 'Listing deactivated.');
        PA.render();
      } catch (err) { btn.disabled = false; PA.toast(err.message, 'err'); }
    });
  }

  function categoryOptions(selected) {
    return cache.categories.map((c) => `<option value="${esc(c.slug)}" ${c.slug === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  }

  function productForm(p, categories) {
    const v = (key, dflt = '') => (p ? (p[key] == null ? dflt : p[key]) : dflt);
    return `
      <div class="grid g2">
        ${PA.field('pf-name', 'Product name *', v('name'), { required: true, placeholder: 'Amul Gold Milk' })}
        <div class="field"><label for="pf-category">Category *</label><select class="input" id="pf-category">${categoryOptions(v('category'))}</select></div>
        ${PA.field('pf-brand', 'Brand', v('brand'), { placeholder: 'Amul' })}
        ${PA.field('pf-subcategory', 'Subcategory', v('subcategory'), { placeholder: 'Dairy drinks' })}
        ${PA.field('pf-sku', 'SKU', v('sku'), { placeholder: 'DAI-MILK-1L' })}
        ${PA.field('pf-barcode', 'Barcode', v('barcode'), { placeholder: '8901030895449' })}
        ${PA.field('pf-unit', 'Unit', v('unit', '1 pc'))}
        ${PA.field('pf-packSize', 'Pack size', v('packSize'), { placeholder: 'Carton of 6' })}
        ${PA.field('pf-variant', 'Variant label', v('variant'), { help: 'Size / colour / weight shown with the name, e.g. “1 litre”.' })}
        ${PA.field('pf-parent', 'Parent product ID (for variants)', v('parentProductId'), { help: 'Link to the base product when this is a variant with its own stock.' })}
        ${PA.field('pf-price', 'Selling price (₹) *', p ? (v('price') / 100) : '', { type: 'number', step: '0.01', min: 1, required: true })}
        ${PA.field('pf-mrp', 'MRP (₹)', p && p.mrp ? (p.mrp / 100) : '', { type: 'number', step: '0.01', min: 1 })}
        ${PA.field('pf-stock', 'Available quantity *', p ? v('stock') : 0, { type: 'number', min: 0, required: true })}
        ${PA.field('pf-low', 'Minimum stock level (low-stock alert)', p ? v('lowAt') : 5, { type: 'number', min: 0 })}
        ${PA.field('pf-max', 'Maximum stock level', p && p.maxStock ? p.maxStock : '', { type: 'number', min: 0 })}
        ${PA.field('pf-weight', 'Weight (grams)', p && p.weightGrams ? p.weightGrams : '', { type: 'number', min: 0, help: 'Used for runner delivery charges.' })}
        ${PA.field('pf-tax', 'Tax rate (%)', p && p.taxRate ? p.taxRate : 0, { type: 'number', step: '0.1', min: 0, max: 30 })}
        ${PA.field('pf-returnDays', 'Return window (days)', p ? v('returnDays') : 0, { type: 'number', min: 0, help: '0 means non-returnable.' })}
        ${PA.field('pf-emoji', 'Emoji icon', v('emoji', '📦'))}
        ${PA.field('pf-image', 'Image URL', v('imageUrl'), { placeholder: 'https://…/photo.jpg' })}
      </div>
      <div class="field"><label for="pf-images">Extra image URLs (comma separated)</label>
        <input class="input" id="pf-images" value="${esc(p && p.images ? p.images.join(', ') : '')}" placeholder="https://…/2.jpg, https://…/3.jpg" /></div>
      <div class="field"><label for="pf-desc">Description</label>
        <textarea class="input" id="pf-desc" rows="3">${esc(v('description'))}</textarea></div>
      <div class="field"><label class="row tight"><input type="checkbox" id="pf-active" ${!p || p.active ? 'checked' : ''}/> Active listing — visible on the Customer Portal</label></div>`;
  }

  function collectProductForm(back, { existing } = {}) {
    const num = (id) => { const v = back.querySelector('#' + id).value.trim(); return v === '' ? undefined : Number(v); };
    const rupeeToPaise = (id) => { const v = num(id); return v === undefined ? undefined : Math.round(v * 100); };
    const imagesRaw = back.querySelector('#pf-images').value.split(',').map((x) => x.trim()).filter(Boolean);
    return {
      name: back.querySelector('#pf-name').value.trim(),
      category: back.querySelector('#pf-category').value,
      brand: back.querySelector('#pf-brand').value.trim() || undefined,
      subcategory: back.querySelector('#pf-subcategory').value.trim() || undefined,
      sku: back.querySelector('#pf-sku').value.trim() || undefined,
      barcode: back.querySelector('#pf-barcode').value.trim() || undefined,
      unit: back.querySelector('#pf-unit').value.trim() || '1 pc',
      packSize: back.querySelector('#pf-packSize').value.trim() || undefined,
      variant: back.querySelector('#pf-variant').value.trim() || undefined,
      parentProductId: back.querySelector('#pf-parent').value.trim() || undefined,
      price: rupeeToPaise('pf-price'),
      mrp: rupeeToPaise('pf-mrp'),
      stock: existing ? undefined : (num('pf-stock') ?? 0),
      lowStock: num('pf-low'),
      maxStock: num('pf-max'),
      weightGrams: num('pf-weight'),
      taxRate: num('pf-tax'),
      returnDays: num('pf-returnDays'),
      emoji: back.querySelector('#pf-emoji').value.trim() || '📦',
      imageUrl: back.querySelector('#pf-image').value.trim() || undefined,
      images: imagesRaw,
      description: back.querySelector('#pf-desc').value.trim() || undefined,
      active: back.querySelector('#pf-active').checked
    };
  }

  async function newProduct(match, ctx) {
    await PA.api('GET', '/seller/products').then((d) => { cache.products = d.products; cache.categories = d.categories || []; });
    if (!ctx.isCurrent()) return;
    PA.set(`${pageHead('Add new product', 'Active listings appear on the Customer Portal instantly, in search and in every nearby cart.')}
      <form class="card" id="new-product-form">
        ${productForm(null)}
        <div class="card-foot row"><a class="btn" href="#/products">Cancel</a><button class="btn btn-primary" type="submit">${PA.icon('plus')} Create product</button></div>
      </form>`);
    $('#new-product-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = collectProductForm(e.target.closest('form'));
      try {
        const res = await PA.api('POST', '/seller/products', body);
        PA.toast(`“${res.product.name}” added to your catalogue.`);
        PA.go('#/products');
      } catch (err) { PA.toast(err.message, 'err'); }
    });
  }

  async function editProduct(match, ctx) {
    const id = decodeURIComponent(match[1]);
    const data = await PA.api('GET', '/seller/products');
    cache.products = data.products; cache.categories = data.categories || [];
    const p = data.products.find((x) => x.id === id);
    if (!ctx.isCurrent()) return;
    if (!p) { PA.set(`<div class="card">${PA.empty('🔍', 'Product not found', 'It may belong to another shop or was removed.', '<a class="btn" href="#/products">Back to products</a>')}</div>`); return; }
    PA.set(`${pageHead(`Edit — ${p.name}`, `SKU ${p.sku || '—'} · barcode ${p.barcode || '—'} · changes sync to the storefront immediately.`)}
      <form class="card" id="edit-product-form">
        ${productForm(p)}
        <div class="row" style="margin-top:12px">
          ${PA.field('ef-stockAdj', 'Adjust stock by (+/−)', '', { type: 'number', help: 'Apply a quick add/reduce adjustment alongside your edits. Leave blank for none.' })}
          <div class="field"><label for="ef-adjReason">Adjustment reason</label>
            <select class="input" id="ef-adjReason"><option value="Restock / purchase">Restock / purchase</option><option value="Damaged stock">Damaged stock</option><option value="Expired stock">Expired stock</option><option value="Returned stock">Returned stock</option><option value="Count correction">Count correction</option></select></div>
        </div>
        <div class="card-foot row"><a class="btn" href="#/products">← Back</a><button class="btn btn-primary" type="submit">Save changes</button></div>
      </form>`);
    $('#edit-product-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const back = e.target.closest('form');
      const body = collectProductForm(back, { existing: true });
      const adj = Number(back.querySelector('#ef-stockAdj').value);
      try {
        await PA.api('PATCH', `/seller/products/${encodeURIComponent(p.id)}`, body);
        if (Number.isFinite(adj) && adj !== 0) {
          await PA.api('POST', '/seller/inventory/adjust', { productId: p.id, action: adj > 0 ? 'add' : 'reduce', quantity: Math.abs(adj), reason: back.querySelector('#ef-adjReason').value });
        }
        PA.toast('Product saved and synced to the storefront.');
        PA.go('#/products');
      } catch (err) { PA.toast(err.message, 'err'); }
    });
  }

  function bulkImportModal() {
    const template = ['name,category,brand,sku,barcode,unit,price_rs,mrp_rs,stock,low_stock,emoji',
      'Amul Gold Milk 1L,groceries,Amul,DAI-AMUL-1L,8901030895449,1 litre,66,68,24,6,🥛'].join('\n');
    PA.modal({
      title: 'Bulk product import',
      wide: true,
      body: `<p class="muted small">Paste CSV rows or upload a .csv file. The first line must be a header. We validate every row before importing anything.</p>
        <div class="row"><button class="btn btn-sm" id="csv-template">${PA.icon('download')} Download template</button></div>
        <div class="field"><label for="csv-file">CSV file</label><input class="input" type="file" id="csv-file" accept=".csv,text/csv" /></div>
        <div class="field"><label for="csv-text">…or paste CSV here</label><textarea class="input mono" id="csv-text" rows="8" placeholder="${esc(template)}"></textarea></div>
        <div id="csv-errors"></div>`,
      actions: [
        { label: 'Cancel' },
        { label: 'Validate & import', primary: true, onClick: async (back) => {
            const text = back.querySelector('#csv-text').value.trim();
            if (!text) throw new Error('Paste CSV rows or choose a file first.');
            const rows = parseCsv(text);
            if (rows.length < 2) throw new Error('Include a header line plus at least one data row.');
            const [header, ...dataRows] = rows;
            const idx = Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), i]));
            const get = (r, key) => (idx[key] === undefined ? '' : String(r[idx[key]] || '').trim());
            const csvRows = dataRows.filter((r) => r.some((cell) => String(cell).trim())).map((r) => ({
              name: get(r, 'name'), category: get(r, 'category'), brand: get(r, 'brand') || undefined,
              sku: get(r, 'sku') || undefined, barcode: get(r, 'barcode') || undefined,
              unit: get(r, 'unit') || '1 pc',
              price: Math.round(Number(get(r, 'price_rs')) * 100) || undefined,
              mrp: get(r, 'mrp_rs') ? Math.round(Number(get(r, 'mrp_rs')) * 100) : undefined,
              stock: Number(get(r, 'stock')) || 0, lowStock: Number(get(r, 'low_stock')) || 5,
              emoji: get(r, 'emoji') || '📦'
            }));
            const errBox = back.querySelector('#csv-errors');
            const res = await PA.api('POST', '/seller/products/bulk', { rows: csvRows });
            errBox.innerHTML = `<div class="banner-note ${(res.errors || []).length ? 'warn' : 'ok'}"><b>Imported ${res.created}/${csvRows.length} products</b>${(res.errors || []).length ? `<ul class="small">${res.errors.map((e) => `<li>Line ${e.line}: ${esc(e.message)}</li>`).join('')}</ul>` : ' — all rows were valid.'}</div>`;
            if (res.created) PA.toast(`${res.created} product(s) imported.`);
            return true; // keep modal open so errors can be reviewed
          } }
      ],
      onMount: (back) => {
        back.querySelector('#csv-template').addEventListener('click', () => csvDownload('nearbuy-products-template.csv', template.split('\n')));
        back.querySelector('#csv-file').addEventListener('change', async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          back.querySelector('#csv-text').value = await file.text();
        });
      }
    });
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i += 1;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /* -------------------------------------------------------------- inventory */
  async function inventory(match, ctx) {
    const data = await PA.api('GET', '/seller/inventory');
    if (!ctx.isCurrent()) return;
    const s = data.summary || {};
    cache.inventoryProducts = data.products || [];
    PA.set(`
      ${pageHead('Inventory Management', 'Real-time stock, shared with the storefront. Every change is recorded with who did it and why.',
        `<a class="btn" href="#/scanner">${PA.icon('scan')} Scan to adjust</a>`)}

      <div class="kpi-grid">
        <div class="kpi accent"><span class="label">Listed products</span><span class="value">${s.totalProducts ?? 0}</span><span class="hint">Active catalogue entries</span></div>
        <div class="kpi"><span class="label">Stock units</span><span class="value">${s.totalUnits ?? 0}</span><span class="hint">Available across all SKUs</span></div>
        <div class="kpi amber"><span class="label">Low stock</span><span class="value">${s.lowStock ?? 0}</span><span class="hint">At or below threshold — reorder soon</span></div>
        <div class="kpi red"><span class="label">Out of stock</span><span class="value">${s.outStock ?? 0}</span><span class="hint">Unavailable on the storefront</span></div>
      </div>

      <div class="card flush">
        <div class="card-head"><h2>Stock levels</h2><span class="spacer"></span><span class="muted small">Reserved units are held in customer carts and confirmed orders.</span></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Product</th><th>SKU / Barcode</th><th class="right">Available</th><th class="right">Reserved</th><th>Threshold</th><th>Status</th><th class="right">Adjust</th></tr></thead>
          <tbody>${(data.products || []).map((p) => `
            <tr>
              <td><b>${esc(p.name)}</b></td>
              <td class="mono small">${esc(p.sku || '—')}<div class="small muted">${esc(p.barcode || '')}</div></td>
              <td class="right"><b>${p.available}</b></td>
              <td class="right">${p.reserved || 0}</td>
              <td>${p.lowAt ?? '—'}${p.maxStock ? ` · max ${p.maxStock}` : ''}</td>
              <td>${p.available <= 0 ? PA.badge('Out of stock', 'red') : p.lowAt && p.available <= p.lowAt ? PA.badge('Low stock', 'amber') : PA.badge('In stock', 'green')}</td>
              <td class="right"><button class="btn btn-sm" data-inv-adj="${esc(p.id)}">Adjust stock</button></td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div>

      <div class="card flush">
        <div class="card-head"><h2>Stock movement history</h2><span class="spacer"></span><span class="muted small">Most recent first · transactional — no overselling</span></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>When</th><th>Type</th><th>Change</th><th class="right">Previous → New</th><th>Reason</th><th>By</th></tr></thead>
          <tbody>${(data.movements || []).length ? data.movements.map((m) => `
            <tr>
              <td class="small">${PA.dateTime(m.at)}</td>
              <td>${PA.badge(String(m.type || '').replace(/_/g, ' '), m.delta >= 0 ? 'green' : 'red')}</td>
              <td><b style="color:${m.delta >= 0 ? '#19A957' : '#E5484D'}">${m.delta >= 0 ? '+' : ''}${m.delta}</b></td>
              <td class="right mono small">${m.previousQty} → ${m.newQty}</td>
              <td class="small">${esc(m.reason || '—')}</td>
              <td class="small">${esc(m.actor || 'system')}</td>
            </tr>`).join('') : '<tr><td colspan="6" class="muted small" style="text-align:center;padding:22px">No movements yet — adjustments, order deductions and scanner confirmations land here.</td></tr>'}</tbody>
        </table></div>
      </div>`);

    PA.onAll('[data-inv-adj]', 'click', (e) => adjustModal(e.currentTarget.dataset.invAdj));
  }

  function adjustModal(productId) {
    const p = (cache.inventoryProducts || cache.products || []).find((x) => x.id === productId);
    PA.modal({
      title: `Adjust stock — ${p ? p.name : ''}`,
      body: `${p ? `<p class="muted small">Currently ${p.available} available (${p.stock - (p.reserved || 0)} on hand${p.reserved ? `, ${p.reserved} reserved` : ''}).</p>` : ''}
        <div class="field"><label for="adj-action">Action</label>
          <select class="input" id="adj-action">
            <option value="add">Add stock (purchase / restock)</option>
            <option value="reduce">Reduce stock</option>
            <option value="damaged">Record damaged stock</option>
            <option value="expired">Record expired stock</option>
            <option value="returned">Record returned stock</option>
            <option value="set">Set exact quantity</option>
          </select></div>
        ${PA.field('adj-qty', 'Quantity', '', { type: 'number', min: 0 })}
        <div class="field"><label for="adj-reason">Reason / note</label><input class="input" id="adj-reason" placeholder="e.g. Invoice #2231 from distributor" /></div>`,
      actions: [
        { label: 'Cancel' },
        { label: 'Apply adjustment', primary: true, onClick: async (back) => {
            const action = back.querySelector('#adj-action').value;
            const quantity = Number(back.querySelector('#adj-qty').value);
            if (!Number.isFinite(quantity) || quantity < 0) throw new Error('Enter a valid quantity.');
            const reasonMap = { add: 'Restock purchase', reduce: 'Stock reduction', damaged: 'Damaged stock', expired: 'Expired stock', returned: 'Returned stock', set: 'Count correction' };
            await PA.api('POST', '/seller/inventory/adjust', { productId, action, quantity, reason: back.querySelector('#adj-reason').value.trim() || reasonMap[action] });
            PA.toast('Inventory updated and synced to the storefront.');
            PA.render();
          } }
      ]
    });
  }

  /* ---------------------------------------------------------------- scanner */
  let scanListener = null;

  async function scanner(match, ctx) {
    const [devices, events] = await Promise.all([
      PA.api('GET', '/seller/scanner/devices'),
      PA.api('GET', '/seller/scanner/events')
    ]);
    if (!ctx.isCurrent()) return;
    PA.set(`
      ${pageHead('Barcode / QR Scanner', 'Pair an authorised scanning device to this shop, then scan to identify products. Scanning alone never changes stock — you confirm every operation.',
        `<button class="btn btn-primary" id="register-device">${PA.icon('link')} Register scanner device</button>`)}

      <div class="grid g2">
        <div class="stack">
          <div class="card">
            <h3>Live scan mode</h3>
            <div class="scan-box" style="margin-top:10px">
              <span class="badge blue">${PA.icon('scan')} Listening for scanner input…</span>
              <p class="muted small">USB barcode scanners act like keyboards — click anywhere in this box and scan. Camera-based QR codes can be typed or pasted below. Duplicate scans are blocked by unique event IDs.</p>
              <form id="scan-form" class="row tight">
                <input class="input grow" id="scan-input" autocomplete="off" spellcheck="false" placeholder="Scan or type a barcode / SKU / QR code, then Enter" aria-label="Scanner input" />
                <button class="btn btn-primary" type="submit">Identify</button>
              </form>
              <div id="scan-result"></div>
            </div>
          </div>
          <div class="card flush">
            <div class="card-head"><h3>Registered devices</h3></div>
            <div class="card-body">${(devices.devices || []).length ? `<div class="list">${devices.devices.map((d) => `
              <div class="item"><span class="emoji">${d.type === 'qr_camera' ? '📷' : d.type === 'usb_keyboard' ? '⌨️' : '🔌'}</span>
                <div class="grow"><b>${esc(d.name)}</b><span>${esc(String(d.type || '').replace(/_/g, ' '))} · Device ${esc(d.deviceId || d.id)} · last active ${d.lastActiveAt ? PA.ago(d.lastActiveAt) : 'never'}</span></div>
                ${PA.status(d.status || 'active')}</div>`).join('')}</div>`
            : PA.empty('🔌', 'No scanner registered', 'Register your USB barcode scanner or QR camera so its scans are attributed to this shop.')}</div>
          </div>
        </div>

        <div class="card flush">
          <div class="card-head"><h3>Recent scan events</h3><span class="spacer"></span><span class="muted small">Pending scans wait for confirmation</span></div>
          <div class="card-body">${(events.events || []).length ? `<div class="table-wrap"><table class="data">
            <thead><tr><th>Code</th><th>Product</th><th>Action</th><th>Status</th><th></th></tr></thead>
            <tbody>${events.events.map((ev) => `
              <tr>
                <td class="mono small">${esc(ev.code)}</td>
                <td>${esc(ev.product || '—')}${ev.orderCode ? `<div class="small muted">order ${esc(ev.orderCode)}</div>` : ''}</td>
                <td class="small">${esc(ev.action || '')} ${ev.quantity ? '×' + ev.quantity : ''}</td>
                <td>${PA.status(ev.status)}</td>
                <td class="right row" style="justify-content:flex-end;gap:6px">${ev.status === 'pending' ? `
                  <button class="btn btn-sm btn-success" data-scan-confirm="${esc(ev.eventId)}">Confirm</button>
                  <button class="btn btn-sm btn-danger" data-scan-reject="${esc(ev.eventId)}">Reject</button>` : ''}</td>
              </tr>`).join('')}</tbody>
          </table></div>` : PA.empty('🧾', 'No scans yet', 'Confirmed and rejected scan events appear here as an audit trail.')}</div>
        </div>
      </div>`);

    PA.on('#register-device', 'click', registerDeviceModal);
    PA.on('#scan-form', 'submit', (e) => { e.preventDefault(); runScan($('#scan-input').value.trim(), $('#scan-input')); });
    PA.onAll('[data-scan-confirm]', 'click', (e) => confirmScanModal(e.currentTarget.dataset.scanConfirm));
    PA.onAll('[data-scan-reject]', 'click', async (e) => {
      try {
        await PA.api('POST', `/seller/scanner/events/${encodeURIComponent(e.currentTarget.dataset.scanReject)}/reject`, {});
        PA.toast('Scan discarded — stock was not changed.');
        PA.render();
      } catch (err) { PA.toast(err.message, 'err'); }
    });

    // Keyboard-wedge capture: scanners fire rapid keystrokes ending with Enter.
    if (scanListener) document.removeEventListener('keydown', scanListener);
    let buffer = '';
    let lastKey = 0;
    scanListener = (e) => {
      if (!$('#scan-result')) { document.removeEventListener('keydown', scanListener); scanListener = null; return; }
      if (e.target.closest('#scan-input') || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') { lastKey = Date.now(); buffer = ''; return; }
      const nowT = Date.now();
      if (nowT - lastKey > 80) buffer = '';
      lastKey = nowT;
      if (e.key === 'Enter' && buffer.length >= 4) { e.preventDefault(); runScan(buffer, null); buffer = ''; }
      else if (e.key.length === 1) buffer += e.key;
    };
    document.addEventListener('keydown', scanListener);
  }

  function registerDeviceModal() {
    PA.modal({
      title: 'Register a scanner device',
      body: `${PA.field('dev-name', 'Device name', 'Counter scanner 1', { required: true })}
        <div class="field"><label for="dev-type">Scanner type</label>
          <select class="input" id="dev-type">
            <option value="usb_keyboard">USB barcode scanner (keyboard input)</option>
            <option value="qr_camera">QR camera / web device</option>
            <option value="handheld_api">Handheld terminal via API agent</option>
          </select></div>
        ${PA.field('dev-id', 'Device serial / ID (optional)', '', { help: 'Printed on the device — used to attribute scan events.' })}
        <div class="banner-note info">Only devices registered to your Shop ID may post scans. Events carry unique IDs so one physical scan can never adjust stock twice.</div>`,
      actions: [
        { label: 'Cancel' },
        { label: 'Register device', primary: true, onClick: async (back) => {
            await PA.api('POST', '/seller/scanner/devices', {
              name: back.querySelector('#dev-name').value.trim(),
              type: back.querySelector('#dev-type').value,
              deviceId: back.querySelector('#dev-id').value.trim() || undefined
            });
            PA.toast('Scanner registered to this shop.');
            PA.render();
          } }
      ]
    });
  }

  async function runScan(code, inputEl) {
    if (!code) return;
    const out = $('#scan-result');
    if (!out) return; // the seller navigated away from the scanner view
    if (inputEl) inputEl.value = '';
    if (out) out.innerHTML = '<p class="muted small">Identifying…</p>';
    const eventId = `EVT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const res = await PA.api('POST', '/seller/scanner/scan', { code, eventId });
      const p = res.product || {};
      const ev = res.event || {};
      if (res.duplicate) {
        out.innerHTML = `<div class="banner-note warn"><b>Duplicate scan blocked.</b> ${esc(res.message)}</div>`;
        return;
      }
      out.innerHTML = `
        <div class="card" style="box-shadow:none;border-color:#bfe9d0;background:#f4fbf7;margin:0">
          <div class="space-between"><b>${esc(p.name || 'Product')}</b>${PA.badge('identified', 'green')}</div>
          <p class="muted small" style="margin:6px 0">SKU ${esc(p.sku || '—')} · barcode ${esc(p.barcode || code)} · ${p.available ?? 0} available · event <span class="mono">${esc(ev.eventId || eventId)}</span></p>
          <div class="row tight">
            <select class="input" id="scan-action" style="max-width:230px">
              <option value="add">Add stock (+)</option>
              <option value="reduce">Reduce stock (−)</option>
              <option value="price_check">Price check only (no stock change)</option>
              <option value="pack">Pack for order (scan-at-counter fulfilment)</option>
            </select>
            <input class="input num-input" id="scan-qty" type="number" min="1" value="1" style="max-width:90px" aria-label="Quantity" />
            <button class="btn btn-success" id="scan-commit">Confirm & commit</button>
          </div>
          ${PA.field('scan-order', 'Order code (for pack action)', '', { help: 'Required when packing for a specific customer order.' })}
          <p class="muted small" style="margin-bottom:0">${esc(res.message || '')}</p>
        </div>`;
      $('#scan-commit').addEventListener('click', async () => {
        try {
          await PA.api('POST', `/seller/scanner/events/${encodeURIComponent(ev.eventId || eventId)}/confirm`, {
            action: $('#scan-action').value,
            quantity: Math.max(1, Number($('#scan-qty').value) || 1),
            orderCode: $('#scan-order').value.trim() || undefined
          });
          PA.toast('Scan committed — inventory updated.');
          PA.render();
        } catch (err) { PA.toast(err.message, 'err'); }
      });
    } catch (err) {
      out.innerHTML = `<div class="banner-note warn"><b>No match.</b> ${esc(err.message)}</div>`;
    }
  }

  function confirmScanModal(eventId) {
    PA.modal({
      title: 'Confirm scan event',
      body: `<p class="muted small">Choose what this scan should do before any stock moves.</p>
        <div class="field"><label for="cev-action">Operation</label>
          <select class="input" id="cev-action">
            <option value="add">Add stock</option><option value="reduce">Reduce stock</option>
            <option value="damaged">Damaged stock</option><option value="expired">Expired stock</option>
            <option value="price_check">Price check only</option><option value="pack">Pack for order</option>
          </select></div>
        ${PA.field('cev-qty', 'Quantity', '1', { type: 'number', min: 1 })}
        ${PA.field('cev-order', 'Order code (pack action only)', '')}`,
      actions: [
        { label: 'Cancel' },
        { label: 'Confirm scan', primary: true, onClick: async (back) => {
            await PA.api('POST', `/seller/scanner/events/${encodeURIComponent(eventId)}/confirm`, {
              action: back.querySelector('#cev-action').value,
              quantity: Math.max(1, Number(back.querySelector('#cev-qty').value) || 1),
              orderCode: back.querySelector('#cev-order').value.trim() || undefined
            });
            PA.toast('Scan confirmed and committed.');
            PA.render();
          } }
      ]
    });
  }

  /* ------------------------------------------------------------- categories */
  async function categories(match, ctx) {
    const data = await PA.api('GET', '/seller/categories');
    const mine = await PA.api('GET', '/seller/products');
    if (!ctx.isCurrent()) return;
    const counts = {};
    (mine.products || []).forEach((p) => { counts[p.category] = (counts[p.category] || 0) + 1; });
    PA.set(`
      ${pageHead('Categories', 'The marketplace taxonomy your listings belong to. Admins curate these; your products sort under them automatically.')}
      <div class="kpi-grid">${(data.categories || []).map((c) => `
        <div class="kpi ${counts[c.slug] ? 'accent' : ''}"><span class="label">${esc(c.name)}</span>
          <span class="value">${counts[c.slug] || 0}</span><span class="hint">product(s) in this category · ${esc(c.slug)}</span></div>`).join('')}
      </div>
      <div class="card"><h3>Selling a new kind of product?</h3>
        <p class="muted small">Categories are curated at the platform level so customers always find things in the same place. If your business needs a new category, raise it through the <a href="#/support">Support Centre</a>.</p></div>`);
  }

  /* ----------------------------------------------------- customers & reviews */
  async function customers(match, ctx) {
    const [data, reviews] = await Promise.all([
      PA.api('GET', '/seller/customers'),
      PA.api('GET', '/seller/reviews')
    ]);
    if (!ctx.isCurrent()) return;
    PA.set(`
      ${pageHead('Customers', 'Only people who have bought from your shop — contact details stay masked until the order workflow needs them.')}

      <div class="card flush">
        <div class="card-head"><h2>Your customers</h2><span class="spacer"></span><span class="muted small">${(data.customers || []).length} shopper(s)</span></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Customer</th><th class="right">Orders</th><th class="right">Total spent</th><th>Last order</th><th>Type</th></tr></thead>
          <tbody>${(data.customers || []).length ? data.customers.map((c) => `
            <tr>
              <td><b>${esc(c.name)}</b><div class="small muted">${esc(c.phoneMasked || '')}</div></td>
              <td class="right">${c.orders}</td>
              <td class="right"><b>${money(c.spent)}</b></td>
              <td class="small">${c.lastOrder ? PA.ago(c.lastOrder) : '—'}</td>
              <td>${PA.badge(c.orders > 1 ? 'Repeat customer' : 'New customer', c.orders > 1 ? 'green' : 'blue')}</td>
            </tr>`).join('') : '<tr><td colspan="5" class="muted small" style="text-align:center;padding:22px">No customers yet — they appear after their first completed order.</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="card flush">
        <div class="card-head"><h2>Verified product & shop reviews</h2><span class="spacer"></span><span class="muted small">Reply publicly or report abuse — never edit a customer’s words</span></div>
        <div class="card-body">${(reviews.reviews || []).length ? `<div class="stack">${reviews.reviews.map((r) => `
          <div class="card" style="box-shadow:none;border-color:#eaf2fb" data-review="${esc(r.id)}">
            <div class="space-between"><div><b>${esc(r.customer)}</b> ${r.verified ? PA.badge('Verified purchase', 'green') : PA.badge('Unverified', 'grey')}
              ${r.reported ? PA.badge('Reported', 'red') : ''}</div>
              <span class="small muted">${PA.ago(r.at)}</span></div>
            <p class="small" style="margin:6px 0 2px">${'★'.repeat(r.shopRating || r.productRating || 0)}${'☆'.repeat(Math.max(0, 5 - (r.shopRating || r.productRating || 0)))} · ${esc(r.product || 'Shop review')}</p>
            ${r.title ? `<b class="small">${esc(r.title)}</b>` : ''}<p class="small muted" style="margin:4px 0">${esc(r.body || '')}</p>
            ${r.sellerReply ? `<div class="banner-note ok"><b>Your reply</b> (${r.sellerReplyAt ? PA.ago(r.sellerReplyAt) : ''}) — ${esc(r.sellerReply)}</div>`
              : `<div class="row tight"><input class="input grow" placeholder="Write a public reply…" data-reply-for="${esc(r.id)}" />
                <button class="btn btn-sm btn-primary" data-send-reply="${esc(r.id)}">Reply</button></div>`}
            ${!r.reported ? `<button class="btn btn-sm" data-report-review="${esc(r.id)}" style="margin-top:8px">Report inappropriate content</button>` : ''}
          </div>`).join('')}</div>`
        : PA.empty('⭐', 'No reviews yet', 'Verified-purchase reviews from your customers will land here.')}</div>
      </div>`);

    PA.onAll('[data-send-reply]', 'click', async (e) => {
      const id = e.currentTarget.dataset.sendReply;
      const input = $(`[data-reply-for="${CSS.escape(id)}"]`);
      const text = (input?.value || '').trim();
      if (!text) { PA.toast('Write a reply first.', 'err'); return; }
      try { await PA.api('POST', `/seller/reviews/${encodeURIComponent(id)}/reply`, { reply: text }); PA.toast('Reply published.'); PA.render(); }
      catch (err) { PA.toast(err.message, 'err'); }
    });
    PA.onAll('[data-report-review]', 'click', async (e) => {
      const id = e.currentTarget.dataset.reportReview;
      const reason = await promptText('Why are you reporting this review?', 'The admin team will review it against platform rules.');
      if (!reason) return;
      try { await PA.api('POST', `/seller/reviews/${encodeURIComponent(id)}/report`, { reason }); PA.toast('Review reported to moderators.'); PA.render(); }
      catch (err) { PA.toast(err.message, 'err'); }
    });
  }

  /* ------------------------------------------------------ delivery & pickup */
  function serviceAreaMap(areas) {
    const pins = (areas.pincodes || []).slice(0, 9);
    const placed = pins.map((p, i) => {
      const angle = (i / Math.max(1, pins.length)) * Math.PI * 2;
      return { x: 190 + Math.cos(angle) * 78, y: 120 + Math.sin(angle) * 58, label: p };
    });
    return `<svg viewBox="0 0 380 240" role="img" aria-label="Service area preview">
      <defs><radialGradient id="radius-grad"><stop offset="0%" stop-color="#168BEE" stop-opacity=".22"/><stop offset="100%" stop-color="#13BDE5" stop-opacity=".05"/></radialGradient></defs>
      <circle cx="190" cy="120" r="100" fill="url(#radius-grad)" stroke="#168BEE" stroke-dasharray="5 6" stroke-width="1.6"/>
      ${placed.map((pin) => `<g><circle cx="${pin.x.toFixed(1)}" cy="${pin.y.toFixed(1)}" r="10" fill="#EFF7FF" stroke="#0866D9"/><text x="${pin.x.toFixed(1)}" y="${(pin.y + 3.5).toFixed(1)}" text-anchor="middle" font-size="7.5" font-weight="700" fill="#063B78">${esc(pin.label.slice(-3))}</text></g>`).join('')}
      <g><rect x="176" y="106" width="28" height="28" rx="8" fill="#063B78"/><text x="190" y="125" text-anchor="middle" font-size="15">🏪</text></g>
      <text x="190" y="232" text-anchor="middle" font-size="10" fill="#62758B">Your shop · dashed circle ≈ ${esc(String(areas.radiusKm ?? '—'))} km radius · ${(areas.pincodes || []).length} service PIN code(s)</text>
    </svg>`;
  }

  async function delivery(match, ctx) {
    const [data, areas] = await Promise.all([
      PA.api('GET', '/seller/delivery'),
      PA.api('GET', '/seller/service-areas').catch(() => null)
    ]);
    if (!ctx.isCurrent()) return;
    const s = data.summary || {};
    const a = areas ? { ...(areas.shop || {}), pincodes: (areas.areas || []).map((x) => x.pincode), localities: [...new Set((areas.areas || []).map((x) => x.locality).filter(Boolean))] } : {};
    const groups = [
      ['Pending dispatch', (data.orders || []).filter((o) => o.status === 'ready')],
      ['Runner requested / assigned', (data.orders || []).filter((o) => ['runner_requested', 'runner_assigned'].includes(o.status))],
      ['Out for delivery', (data.orders || []).filter((o) => ['picked_up', 'out_for_delivery'].includes(o.status))],
      ['Ready for pickup', (data.orders || []).filter((o) => o.status === 'ready' && o.fulfillment === 'pickup')]
    ];
    PA.set(`
      ${pageHead('Delivery & Pickup', 'Control how each eligible order reaches the customer — self-delivery, NearBuy runners, or store pickup.',
        `<a class="btn" href="#/runner">${PA.icon('bike')} Runner delivery tracking</a>`)}

      <div class="kpi-grid">
        <div class="kpi amber"><span class="label">Pending dispatch</span><span class="value">${s.pendingDispatch ?? 0}</span><span class="hint">Packed and waiting</span></div>
        <div class="kpi"><span class="label">Runner in progress</span><span class="value">${(s.runnerRequested ?? 0) + (s.runnerAssigned ?? 0)}</span><span class="hint">Requested + assigned</span></div>
        <div class="kpi accent"><span class="label">Ready for pickup</span><span class="value">${s.readyForPickup ?? 0}</span><span class="hint">Customers en route to you</span></div>
        <div class="kpi green"><span class="label">Delivered</span><span class="value">${s.delivered ?? 0}</span><span class="hint">OTP-verified completions</span></div>
        <div class="kpi red"><span class="label">Failed / cancelled</span><span class="value">${s.failed ?? 0}</span><span class="hint">Includes rejections</span></div>
        <div class="kpi"><span class="label">Delivery charges</span><span class="value">${money(s.deliveryCharges ?? 0)}</span><span class="hint">Collected across orders</span></div>
      </div>

      <div class="grid g2">
        <div class="card flush">
          <div class="card-head"><h2>Fulfilment queues</h2></div>
          <div class="card-body stack">${groups.map(([title, rows]) => `
            <div><b class="small">${esc(title)} — ${rows.length}</b>
              ${rows.length ? `<div class="list" style="margin-top:6px">${rows.slice(0, 6).map((o) => `
                <div class="item"><span class="emoji">${o.fulfillment === 'pickup' ? '🏬' : '🛵'}</span>
                  <div class="grow"><b>${esc(o.code)}</b><span>${money(o.total)} · ${esc(o.fulfillment)}${o.runner ? ' · ' + esc(o.runner) : ''}${o.deliveryStaffName ? ' · ' + esc(o.deliveryStaffName) : ''}</span></div>
                  <a class="btn btn-sm" href="#/orders/${encodeURIComponent(o.code)}">Open</a></div>`).join('')}</div>`
                : '<p class="muted small" style="margin:4px 0 0">Nothing queued.</p>'}
            </div>`).join('')}
          </div>
          <div class="card-foot"><b class="small">Self-delivery personnel</b>
            ${(data.staff || []).length ? `<div class="list" style="margin-top:6px">${data.staff.map((x) => `<div class="item"><span class="emoji">🧑‍💼</span><div class="grow"><b>${esc(x.name)}</b><span>${esc(x.phone || '')}</span></div>${PA.badge('delivery staff', 'blue')}</div>`).join('')}</div>
              <p class="small muted">Add more under <a href="#/staff">Staff Management</a> with the Delivery Staff role.</p>`
            : `<p class="small muted">No delivery staff configured. Add teammates under <a href="#/staff">Staff Management</a> — unassigned self-deliveries default to you.</p>`}
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <h2>Service area</h2>
            <div class="map-box" style="margin-top:10px">${serviceAreaMap(a)}</div>
            ${PA.kv([
              ['Radius', `${a.radiusKm ?? '—'} km`],
              ['Serviceable PIN codes', (a.pincodes || []).join(', ') || '—'],
              ['Localities', (a.localities || []).join(', ') || '—'],
              ['Delivery fee', money(a.deliveryFee ?? 0)],
              ['Free delivery over', a.freeDeliveryOver != null ? money(a.freeDeliveryOver) : 'not set'],
              ['Minimum order', money(a.minOrder ?? 0)],
              ['Prep time', `${a.prepMinutes ?? '—'} min`]
            ])}
            <div class="row" style="margin-top:10px"><button class="btn btn-primary" id="edit-service-area">${PA.icon('edit')} Edit service area</button></div>
          </div>
          <div class="card">
            <h3>Fulfilment channels</h3>
            <p class="muted small">Turning a channel off stops new promises of that type on the Customer Portal. Orders already accepted keep flowing.</p>
            <div class="switch-row"><div><b class="small">Store pickup</b><div class="desc">Customers collect at your counter with a collection code.</div></div>
              <input type="checkbox" class="switch" id="ch-pickup" ${a.pickupEnabled !== false ? 'checked' : ''} /></div>
            <div class="switch-row"><div><b class="small">Home delivery</b><div class="desc">Any delivery method within the service area.</div></div>
              <input type="checkbox" class="switch" id="ch-delivery" ${a.deliveryEnabled !== false ? 'checked' : ''} /></div>
            <div class="switch-row"><div><b class="small">Self-delivery</b><div class="desc">You or your staff deliver personally.</div></div>
              <input type="checkbox" class="switch" id="ch-self" ${a.selfDeliveryEnabled !== false ? 'checked' : ''} /></div>
            <div class="switch-row"><div><b class="small">NearBuy Runner delivery</b><div class="desc">Neighbourhood runners accept your requests one at a time.</div></div>
              <input type="checkbox" class="switch" id="ch-runner" ${a.runnerEnabled !== false ? 'checked' : ''} /></div>
          </div>
        </div>
      </div>`);

    PA.on('#edit-service-area', 'click', () => editServiceAreaModal(a));
    const saveChannels = async () => {
      try {
        await PA.api('PATCH', '/seller/service-areas', {
          pincodes: a.pincodes || ['110016'], radiusKm: a.radiusKm || 3,
          pickupEnabled: $('#ch-pickup').checked, deliveryEnabled: $('#ch-delivery').checked,
          selfDeliveryEnabled: $('#ch-self').checked, runnerEnabled: $('#ch-runner').checked
        });
        PA.toast('Fulfilment channels updated on the storefront.');
      } catch (err) { PA.toast(err.message, 'err'); PA.render(); }
    };
    ['#ch-pickup', '#ch-delivery', '#ch-self', '#ch-runner'].forEach((sel) => PA.on(sel, 'change', saveChannels));
  }

  function editServiceAreaModal(a) {
    PA.modal({
      title: 'Edit delivery area',
      wide: true,
      body: `<p class="muted small">Changes recalculate eligibility on the Customer Portal immediately — no delivery promises are shown where you cannot serve.</p>
        <div class="grid g2">
          ${PA.field('sa-radius', 'Maximum delivery radius (km)', a.radiusKm ?? 3, { type: 'number', step: '0.5', min: 0.5, max: 50 })}
          ${PA.field('sa-prep', 'Estimated preparation time (minutes)', a.prepMinutes ?? 15, { type: 'number', min: 0 })}
          ${PA.field('sa-fee', 'Delivery fee (₹)', (a.deliveryFee ?? 0) / 100, { type: 'number', step: '0.01', min: 0 })}
          ${PA.field('sa-free', 'Free delivery above (₹, blank = none)', a.freeDeliveryOver != null ? a.freeDeliveryOver / 100 : '', { type: 'number', step: '0.01', min: 0 })}
          ${PA.field('sa-min', 'Minimum order value (₹)', (a.minOrder ?? 0) / 100, { type: 'number', step: '0.01', min: 0 })}
        </div>
        <div class="field"><label for="sa-pins">Serviceable PIN codes (comma separated)</label>
          <input class="input" id="sa-pins" value="${esc((a.pincodes || []).join(', '))}" placeholder="110016, 110017, 110049" /></div>
        <div class="field"><label for="sa-localities">Supported localities (comma separated)</label>
          <input class="input" id="sa-localities" value="${esc((a.localities || []).join(', '))}" placeholder="Hauz Khas, Green Park" /></div>`,
      actions: [
        { label: 'Cancel' },
        { label: 'Save service area', primary: true, onClick: async (back) => {
            const pins = back.querySelector('#sa-pins').value.split(',').map((x) => x.trim()).filter(Boolean);
            await PA.api('PATCH', '/seller/service-areas', {
              radiusKm: Number(back.querySelector('#sa-radius').value) || 3,
              prepMinutes: Number(back.querySelector('#sa-prep').value) || 0,
              deliveryFee: Math.round(Number(back.querySelector('#sa-fee').value || 0) * 100),
              freeDeliveryOver: back.querySelector('#sa-free').value === '' ? null : Math.round(Number(back.querySelector('#sa-free').value) * 100),
              minOrder: Math.round(Number(back.querySelector('#sa-min').value || 0) * 100),
              pincodes: pins,
              localities: back.querySelector('#sa-localities').value.split(',').map((x) => x.trim()).filter(Boolean)
            });
            PA.toast('Service area saved and synced to the storefront.');
            PA.render();
          } }
      ]
    });
  }

  /* ------------------------------------------------------------ runner board */
  async function runnerBoard(match, ctx) {
    const data = await PA.api('GET', '/seller/delivery');
    if (!ctx.isCurrent()) return;
    const relevant = (data.orders || []).filter((o) => ['runner_requested', 'runner_assigned', 'picked_up', 'out_for_delivery', 'delivered'].includes(o.status) || o.runner);
    cache.deliveryOrders = relevant;
    PA.set(`
      ${pageHead('NearBuy Runner', 'Shared fulfilment network — the same backend and assignment records the Runner Portal uses. Nothing is faked: if nobody is available, you see the real status.',
        `<a class="btn" href="#/delivery">${PA.icon('truck')} Delivery dashboard</a>`)}

      <div class="card"><h3>How runner delivery works</h3>
        <div class="stepper" style="margin-top:12px">
          <div class="step done"><b>1 · Pack</b>Accept, then mark every item packed. The “Find a runner” button appears on ready orders.</div>
          <div class="step active"><b>2 · Request</b>Nearby eligible runners get your request one at a time, with weight, packages and timing.</div>
          <div class="step"><b>3 · Handover</b>An accepting runner gets a per-order 4-digit PIN. Confirm the handover when they quote it.</div>
          <div class="step"><b>4 · OTP delivery</b>The customer’s 6-digit OTP closes the delivery — runners cannot fake completion, and neither can you.</div>
        </div>
      </div>

      <div class="card flush">
        <div class="card-head"><h2>Runner jobs</h2><span class="spacer"></span><span class="muted small">Live assignment state from the shared fulfilment database</span></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Order</th><th>Status</th><th>Runner</th><th>Assignment</th><th class="right">Amount</th><th class="right">Actions</th></tr></thead>
          <tbody>${relevant.length ? relevant.map((o) => `
            <tr>
              <td><a href="#/orders/${encodeURIComponent(o.code)}" class="mono">${esc(o.code)}</a><div class="small muted">${esc(o.parentCode || '')} · ${PA.ago(o.createdAt)}</div></td>
              <td>${PA.status(o.status)}</td>
              <td>${o.runner ? `<b>${esc(o.runner)}</b>` : '<span class="muted small">searching…</span>'}</td>
              <td>${o.assignmentStatus ? PA.status(o.assignmentStatus, String(o.assignmentStatus).replace(/_/g, ' ')) : '—'}</td>
              <td class="right">${money(o.total)}</td>
              <td class="right row" style="justify-content:flex-end;gap:6px">
                ${o.status === 'ready' ? `<button class="btn btn-sm btn-primary" data-act="request_runner" data-code="${esc(o.code)}">${PA.icon('bike')} Find a runner</button>` : ''}
                ${['runner_requested', 'runner_assigned'].includes(o.status) ? `<button class="btn btn-sm" data-act="confirm_handover" data-code="${esc(o.code)}">Confirm handover</button>
                  <button class="btn btn-sm btn-danger" data-act="cancel_runner" data-code="${esc(o.code)}">Cancel</button>` : ''}
              </td>
            </tr>`).join('')
          : `<tr><td colspan="6" class="muted small" style="text-align:center;padding:26px">No runner jobs right now. Request a runner from any order marked Ready.</td></tr>`}</tbody>
        </table></div>
        <div class="card-foot"><span class="muted small">Runner permissions: you may request, view assignments, confirm handover and cancel unaccepted offers. Payments, falsified pickups and skipping the OTP are enforced server-side and impossible from this console.</span></div>
      </div>`);
    wireOrders();
  }

  /* ------------------------------------------------------------- promotions */
  function promoScope(p) {
    const parts = [];
    if ((p.productIds || []).length) parts.push(`${p.productIds.length} product(s)`);
    if ((p.categorySlugs || []).length) parts.push(p.categorySlugs.join(', '));
    return parts.length ? `<div class="small muted">${esc(parts.join(' · '))}</div>` : '';
  }

  const PROMO_TYPES = [
    ['percentage', 'Percentage off'], ['fixed', 'Fixed amount off'], ['product', 'Product-specific'],
    ['category', 'Category-specific'], ['bogo', 'Buy one get one'], ['bulk', 'Bulk purchase'],
    ['seasonal', 'Seasonal offer'], ['limited_time', 'Limited-time deal'], ['min_order', 'Minimum order discount']
  ];

  async function promotions(match, ctx) {
    const data = await PA.api('GET', '/seller/promotions');
    if (!ctx.isCurrent()) return;
    const promos = data.promotions || [];
    PA.set(`
      ${pageHead('Promotions & Offers', 'Coupons appear on the Customer Portal only while valid, and every redemption is validated server-side at checkout.',
        `<a class="btn btn-primary" href="#/promotions/new">${PA.icon('percent')} Create promotion</a>`)}
      <div class="card flush">
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Code</th><th>Type</th><th>Value</th><th>Limits</th><th>Window</th><th>Usage</th><th>Status</th><th class="right">Actions</th></tr></thead>
          <tbody>${promos.length ? promos.map((p) => `
            <tr>
              <td><b class="mono">${esc(p.code)}</b><div class="small muted">${esc(p.title || '')}</div></td>
              <td>${esc(PROMO_TYPES.find(([k]) => k === (p.promoType || ''))?.[1] || p.type || '')}${promoScope(p)}</td>
              <td><b>${p.type === 'percent' || p.promoType === 'percentage' ? p.value + '%' : p.type === 'free_delivery' ? 'Free delivery' : money(p.value)}</b>${p.maxDiscount ? `<div class="small muted">cap ${money(p.maxDiscount)}</div>` : ''}</td>
              <td class="small">${p.minOrder ? 'min ' + money(p.minOrder) : 'no minimum'}${p.buyQty && p.getQty ? `<div class="muted small">buy ${p.buyQty} get ${p.getQty}</div>` : ''}</td>
              <td class="small">${p.startsAt ? PA.dateOnly(p.startsAt) : 'now'} → ${p.endsAt ? PA.dateOnly(p.endsAt) : '—'}</td>
              <td>${p.usedCount ?? 0}${p.usageLimit ? ` / ${p.usageLimit}` : ''}</td>
              <td>${p.active ? PA.badge('Active', 'green') : PA.badge('Inactive', 'grey')}</td>
              <td class="right row" style="justify-content:flex-end;gap:6px">
                <button class="btn btn-sm" data-promo-toggle="${esc(p.code)}" data-active="${p.active ? 1 : 0}">${p.active ? 'Deactivate' : 'Activate'}</button>
                <button class="btn btn-sm btn-danger" data-promo-del="${esc(p.code)}">Delete</button>
              </td>
            </tr>`).join('')
          : `<tr><td colspan="8" class="muted small" style="text-align:center;padding:26px">No promotions yet — create your first offer to drive repeat orders.</td></tr>`}</tbody>
        </table></div>
        <div class="card-foot"><span class="muted small">Seller coupons apply only to your shop’s eligible subtotal. Platform-wide promotions are admin-only.</span></div>
      </div>`);

    PA.onAll('[data-promo-toggle]', 'click', async (e) => {
      try {
        await PA.api('PATCH', `/seller/promotions/${encodeURIComponent(e.currentTarget.dataset.promoToggle)}`, { active: e.currentTarget.dataset.active !== '1' });
        PA.toast('Promotion updated.'); PA.render();
      } catch (err) { PA.toast(err.message, 'err'); }
    });
    PA.onAll('[data-promo-del]', 'click', async (e) => {
      const ok = await PA.confirm('Delete this promotion?', 'Past redemptions stay on record; the code stops working immediately.');
      if (!ok) return;
      try { await PA.api('DELETE', `/seller/promotions/${encodeURIComponent(e.currentTarget.dataset.promoDel)}`); PA.toast('Promotion deleted.'); PA.render(); }
      catch (err) { PA.toast(err.message, 'err'); }
    });
  }

  async function newPromotion(match, ctx) {
    await PA.api('GET', '/seller/products').then((d) => { cache.products = d.products; cache.categories = d.categories || []; }).catch(() => {});
    if (!ctx.isCurrent()) return;
    PA.set(`${pageHead('Create promotion', 'The storefront validates every rule below at checkout — what you set here is what customers can redeem.')}
      <form class="card" id="promo-form">
        <div class="grid g2">
          ${PA.field('pm-name', 'Promotion name *', '', { required: true, placeholder: 'Monsoon week sale' })}
          ${PA.field('pm-code', 'Coupon code *', '', { required: true, placeholder: 'FRESH10' })}
          <div class="field"><label for="pm-type">Discount type *</label>
            <select class="input" id="pm-type">${PROMO_TYPES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
          <div class="field"><label for="pm-value-type">Discount unit</label>
            <select class="input" id="pm-value-type"><option value="percent">Percent (%)</option><option value="fixed">Fixed amount (₹)</option></select></div>
          ${PA.field('pm-value', 'Discount value *', '', { type: 'number', min: 1, required: true, help: 'Percent (1–90) or rupees. Ignored for Buy One Get One — set the buy/get quantities instead.' })}
          ${PA.field('pm-max', 'Maximum discount (₹, optional)', '', { type: 'number', step: '0.01', min: 0 })}
          ${PA.field('pm-min', 'Minimum order value (₹)', '', { type: 'number', step: '0.01', min: 0 })}
          ${PA.field('pm-limit', 'Total usage limit', '', { type: 'number', min: 0 })}
          ${PA.field('pm-starts', 'Starts (date/time)', '', { type: 'datetime-local' })}
          ${PA.field('pm-ends', 'Ends (date/time)', '', { type: 'datetime-local' })}
          ${PA.field('pm-buy', 'BOGO buy quantity', '1', { type: 'number', min: 1, help: 'Used with Buy One Get One.' })}
          ${PA.field('pm-get', 'BOGO get quantity', '1', { type: 'number', min: 1 })}
        </div>
        <div class="field"><label for="pm-products">Eligible products (comma-separated product IDs, blank = all)</label>
          <input class="input mono" id="pm-products" placeholder="${esc(cache.products.slice(0, 2).map((p) => p.id).join(', '))}" /></div>
        <div class="field"><label for="pm-categories">Eligible categories</label>
          <select class="input" id="pm-categories" multiple size="4">${cache.categories.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('')}</select>
          <span class="help">Hold Ctrl/Cmd to choose several. Blank means every category in your shop.</span></div>
        ${PA.field('pm-desc', 'Description', '', { placeholder: 'Shown at checkout as the offer label' })}
        <div class="field"><label class="row tight"><input type="checkbox" id="pm-active" checked /> Active immediately</label></div>
        <div class="card-foot row"><a class="btn" href="#/promotions">Cancel</a><button class="btn btn-primary" type="submit">Publish promotion</button></div>
      </form>`);
    $('#promo-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const back = e.target.closest('form');
      const promoType = back.querySelector('#pm-type').value;
      const valueType = back.querySelector('#pm-value-type').value;
      const rawValue = Number(back.querySelector('#pm-value').value);
      const maxRaw = back.querySelector('#pm-max').value;
      const cats = $$('#pm-categories option:checked').map((o) => o.value);
      try {
        const productIds = back.querySelector('#pm-products').value.split(',').map((x) => x.trim()).filter(Boolean);
        // Product-scoped and BOGO offers must name what they apply to.
        if (['product', 'bogo'].includes(promoType) && !productIds.length && !cats.length) {
          throw new Error('Product-specific and Buy-One-Get-One offers need at least one eligible product or category.');
        }
        await PA.api('POST', '/seller/promotions', {
          title: back.querySelector('#pm-name').value.trim(),
          description: back.querySelector('#pm-desc').value.trim() || undefined,
          code: back.querySelector('#pm-code').value.trim().toUpperCase(),
          promoType,
          type: promoType === 'bogo' ? 'bogo' : valueType,
          value: promoType === 'bogo' ? 0 : (valueType === 'percent' || promoType === 'percentage' ? rawValue : Math.round(rawValue * 100)),
          maxDiscount: maxRaw === '' ? undefined : Math.round(Number(maxRaw) * 100),
          minOrder: Math.round(Number(back.querySelector('#pm-min').value || 0) * 100),
          perCustomerLimit: 1,
          usageLimit: back.querySelector('#pm-limit').value === '' ? undefined : Number(back.querySelector('#pm-limit').value),
          startsAt: back.querySelector('#pm-starts').value || undefined,
          endsAt: back.querySelector('#pm-ends').value || undefined,
          buyQty: promoType === 'bogo' ? Number(back.querySelector('#pm-buy').value) || 1 : undefined,
          getQty: promoType === 'bogo' ? Number(back.querySelector('#pm-get').value) || 1 : undefined,
          productIds,
          categorySlugs: cats,
          eligibility: 'all_customers',
          active: back.querySelector('#pm-active').checked
        });
        PA.toast('Promotion published and visible at checkout.');
        PA.go('#/promotions');
      } catch (err) { PA.toast(err.message, 'err'); }
    });
  }

  /* -------------------------------------------------------------- analytics */
  async function analytics(match, ctx) {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const range = params.get('range') || '30d';
    const fromQ = params.get('from') || '';
    const toQ = params.get('to') || '';
    const qs = range === 'custom' && fromQ && toQ
      ? `range=custom&from=${encodeURIComponent(fromQ)}&to=${encodeURIComponent(toQ)}`
      : `range=${encodeURIComponent(range)}`;
    const [data, cat] = await Promise.all([
      PA.api('GET', `/seller/analytics?${qs}`),
      PA.api('GET', '/seller/products').catch(() => ({ products: [], categories: [] }))
    ]);
    if (!ctx.isCurrent()) return;
    const m = data.metrics || {};
    const series = data.series || [];
    const best = data.bestSellers || [];
    const worst = data.leastSellers || [];
    const catNames = Object.fromEntries((cat.categories || []).map((c) => [c.slug, c.name]));
    const byCat = (data.categories || []).map((c) => ({ label: catNames[c.slug] || String(c.slug || 'Uncategorised').replace(/-/g, ' '), value: c.revenue, qty: c.qty }));
    const cust = data.customers || {};
    const window = `${PA.dateOnly(data.from)} → ${PA.dateOnly(data.to)}`;
    const applyCustom = () => {
      const f = $('#an-from').value; const t = $('#an-to').value;
      if (!f || !t) { PA.toast('Pick both a start and an end date.', 'err'); return; }
      if (t < f) { PA.toast('The end date cannot be before the start date.', 'err'); return; }
      PA.go(`#/analytics?range=custom&from=${f}&to=${t}`);
    };
    PA.set(`
      ${pageHead('Sales Analytics', `Everything below is computed from your real orders for ${window}. Gross counts every non-cancelled order; net subtracts completed refunds.${data.isDemo ? ' Demo orders are included and labelled by the platform.' : ''}`,
        `<div class="tabs">${RANGES.map(([k, l]) => `<a href="#/analytics?range=${k}" ${k === range ? 'aria-current="page"' : ''}>${esc(l)}</a>`).join('')}</div>`)}

      <div class="kpi-grid">
        <div class="kpi accent"><span class="label">Gross sales</span><span class="value">${money(m.grossSales || 0)}</span><span class="hint">All non-cancelled orders</span></div>
        <div class="kpi green"><span class="label">Net sales</span><span class="value">${money(m.netSales || 0)}</span><span class="hint">After ${money(m.refunds || 0)} refunds</span></div>
        <div class="kpi"><span class="label">Orders</span><span class="value">${m.orderCount || 0}</span><span class="hint">${m.completedOrders || 0} completed · ${(m.cancelledOrders || 0) + (m.rejectedOrders || 0)} cancelled/rejected</span></div>
        <div class="kpi"><span class="label">Average order value</span><span class="value">${money(m.averageOrderValue || 0)}</span><span class="hint">Gross ÷ ${m.orderCount || 0} valid order(s)</span></div>
        <div class="kpi amber"><span class="label">Discounts given</span><span class="value">${money(m.discounts || 0)}</span><span class="hint">Across ${m.couponOrders || 0} discounted order(s)</span></div>
        <div class="kpi"><span class="label">Units sold</span><span class="value">${m.unitsSold || 0}</span><span class="hint">Delivery collected ${money(m.deliveryCharges || 0)}</span></div>
      </div>

      <div class="card flush" style="margin-bottom:14px">
        <div class="card-head"><h2>Custom range</h2><span class="spacer"></span><span class="muted small">Daily to yearly presets above, any window here</span></div>
        <div class="card-body row tight" style="flex-wrap:wrap">
          ${PA.field('an-from', 'From', range === 'custom' ? fromQ : '', { type: 'date' })}
          ${PA.field('an-to', 'To', range === 'custom' ? toQ : '', { type: 'date' })}
          <button class="btn btn-primary" id="an-apply">Apply range</button>
          <span class="muted small">Showing ${series.length} day(s).</span>
        </div>
      </div>

      <div class="grid g2">
        <div class="card chart-card flush">
          <div class="card-head"><h2>Daily gross sales</h2></div>
          <div class="card-body">${series.length ? lineChart(series.map((d) => ({ label: d.date.slice(5), value: d.sales })), { labelFmt: money }) : PA.empty('📈', 'No orders in this range', 'Widen the range above to see the trend.')}</div>
        </div>
        <div class="card chart-card flush">
          <div class="card-head"><h2>Orders per day</h2></div>
          <div class="card-body">${series.length ? lineChart(series.map((d) => ({ label: d.date.slice(5), value: d.orders })), { stroke: '#19A957', fill: 'rgba(25,169,87,.12)', labelFmt: (v) => `${Math.round(v)} orders` }) : PA.empty('📈', 'No orders in this range', 'Widen the range above to see the trend.')}</div>
        </div>
        <div class="card flush">
          <div class="card-head"><h2>Revenue by category</h2></div>
          <div class="card-body">${byCat.length ? donut(byCat) : PA.empty('🧺', 'No category revenue yet', 'It appears after your first sale in this window.')}</div>
        </div>
        <div class="card flush">
          <div class="card-head"><h2>Best-selling products</h2><span class="spacer"></span><a class="small" href="#/products">Catalogue</a></div>
          <div class="card-body">${best.length ? barRows(best.slice(0, 8).map((b) => ({ label: b.name, value: b.qty })), { valueFmt: (v) => `${v} units`, color: '#0866D9' }) : PA.empty('🏷️', 'No product sales', 'Best sellers appear once orders land in this window.')}</div>
        </div>
      </div>

      <div class="grid g2">
        <div class="card flush">
          <div class="card-head"><h2>Product ranking</h2><span class="spacer"></span><span class="muted small">Top ${Math.min(8, (data.products || []).length)} by revenue</span></div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>#</th><th>Product</th><th class="right">Units</th><th class="right">Revenue</th><th style="width:180px">Share</th></tr></thead>
            <tbody>${(data.products || []).slice(0, 8).map((b, i) => `
              <tr><td class="muted">${i + 1}</td><td><b>${esc(b.name)}</b></td><td class="right">${b.qty}</td><td class="right">${money(b.revenue)}
                <div class="progress" style="margin-top:4px"><span style="width:${Math.max(4, (b.revenue / Math.max(1, (data.products || [])[0].revenue)) * 100)}%"></span></div></td>
                <td class="muted small">${m.grossSales ? Math.round((b.revenue / m.grossSales) * 100) : 0}% of gross</td></tr>`).join('')
              || `<tr><td colspan="5" class="muted small" style="text-align:center;padding:22px">Sell your first order to build rankings.</td></tr>`}</tbody>
          </table></div>
        </div>
        <div class="card flush">
          <div class="card-head"><h2>Slow movers & customers</h2></div>
          <div class="card-body">
            <p class="muted small" style="margin-top:0">Lowest revenue in this window — consider bundling, discounting or archiving.</p>
            ${worst.length ? barRows(worst.slice(0, 5).map((b) => ({ label: b.name, value: b.qty })), { valueFmt: (v) => `${v} units`, color: '#F59E0B' }) : PA.empty('🐢', 'Nothing sold here', 'Slow movers appear once orders land in this window.')}
            <div class="row" style="gap:0;flex-wrap:wrap;border-top:1px solid var(--border);margin-top:14px;padding-top:6px">
              <div class="stat"><span class="label">Buyers</span><span class="value">${cust.total || 0}</span><span class="hint">Distinct customers</span></div>
              <div class="stat"><span class="label">Repeat buyers</span><span class="value">${cust.repeat || 0}</span><span class="hint">More than one order</span></div>
              <div class="stat"><span class="label">Repeat rate</span><span class="value">${cust.repeatRate || 0}%</span><span class="hint">Loyalty in this window</span></div>
              <div class="stat"><a class="btn" href="#/customers">Open customer list</a></div>
            </div>
          </div>
        </div>
      </div>`);
    $('#an-apply').addEventListener('click', applyCustom);
  }

  /* ---------------------------------------------------------------- revenue */
  async function revenue(match, ctx) {
    const data = await PA.api('GET', '/seller/revenue');
    if (!ctx.isCurrent()) return;
    const raw = data.dashboard || {};
    const txs = data.transactions || [];
    const byMethodAgg = {};
    txs.forEach((x) => { const m = String(x.method || 'other'); byMethodAgg[m] = (byMethodAgg[m] || 0) + (x.gross || 0); });
    const byMethod = Object.entries(byMethodAgg).map(([method, amount]) => ({ method, amount }));
    const s = {
      successful: raw.successful || 0, successfulCount: txs.filter((x) => x.paymentStatus === 'paid').length,
      pending: raw.pending || 0, refunded: raw.refunds || 0, cod: (raw.cod || 0) + (raw.payAtStore || 0),
      commission: raw.commission || 0, commissionRate: raw.commissionRate ?? 0, payable: raw.payableBalance || 0
    };
    PA.set(`
      ${pageHead('Revenue & Payments', 'Customer collections are separate from what the platform owes you. Net payable excludes refunds and commission.',
        `<a class="btn" href="#/settlements">${PA.icon('rupee')} Settlements</a>`)}

      <div class="kpi-grid">
        <div class="kpi green"><span class="label">Successful payments</span><span class="value">${money(s.successful || 0)}</span><span class="hint">${s.successfulCount || 0} paid order(s)</span></div>
        <div class="kpi amber"><span class="label">Pending collection</span><span class="value">${money(s.pending || 0)}</span><span class="hint">COD + pay-at-store outstanding</span></div>
        <div class="kpi red"><span class="label">Refunded</span><span class="value">${money(s.refunded || 0)}</span><span class="hint">Completed refunds</span></div>
        <div class="kpi"><span class="label">Cash collected</span><span class="value">${money(s.cod || 0)}</span><span class="hint">Handed over at delivery/pickup</span></div>
        <div class="kpi"><span class="label">Platform commission</span><span class="value">${money(s.commission || 0)}</span><span class="hint">${s.commissionRate ?? 0}% configured rate</span></div>
        <div class="kpi accent"><span class="label">Seller payable</span><span class="value">${money(s.payable || 0)}</span><span class="hint">Net after refunds + commission</span></div>
      </div>

      <div class="grid g2">
        <div class="card flush">
          <div class="card-head"><h2>By payment method</h2></div>
          <div class="card-body">${donut(byMethod.map((m) => ({ label: String(m.method || '').replace(/_/g, ' '), value: m.amount })))}</div>
        </div>
        <div class="card">
          <h3>How settlement works</h3>
          <div class="stepper" style="margin-top:12px">
            <div class="step done"><b>Collect</b>Customers pay online, COD or at your counter. Every transaction lands below.</div>
            <div class="step active"><b>Settle</b>Generate a statement for delivered orders; commission and refunds are deducted automatically.</div>
            <div class="step"><b>Payout</b>The admin team confirms bank transfers — settlements only become “completed” on confirmed payout.</div>
          </div>
          <p class="muted small" style="margin-top:12px">Bank account changes require re-verification and admin approval under Settings → Financial.</p>
        </div>
      </div>

      <div class="card flush">
        <div class="card-head"><h2>Transactions</h2><span class="spacer"></span><span class="muted small">Most recent first · amounts authoritative from the payments ledger</span></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>When</th><th>Order</th><th>Method</th><th class="right">Gross</th><th class="right">Refund</th><th class="right">Commission</th><th class="right">Net payable</th><th>Status</th></tr></thead>
          <tbody>${txs.length ? txs.map((tx) => `
            <tr>
              <td class="small">${PA.dateTime(tx.at)}</td>
              <td class="mono small"><a href="#/orders/${encodeURIComponent(tx.sellerOrderCode || '')}">${esc(tx.sellerOrderCode || tx.orderCode || '—')}</a></td>
              <td>${esc(String(tx.method || '').replace(/_/g, ' '))}</td>
              <td class="right">${money(tx.gross)}</td>
              <td class="right">${tx.refund ? '−' + money(tx.refund) : '—'}</td>
              <td class="right">${tx.commission ? '−' + money(tx.commission) : '—'}</td>
              <td class="right"><b>${money(tx.netPayable ?? 0)}</b></td>
              <td>${PA.status(tx.paymentStatus || tx.status)}${tx.settlementStatus && tx.settlementStatus !== 'not_settled' ? `<div class="small muted">settlement ${esc(tx.settlementStatus)}</div>` : ''}</td>
            </tr>`).join('')
          : `<tr><td colspan="8" class="muted small" style="text-align:center;padding:22px">Transactions appear as orders complete.</td></tr>`}</tbody>
        </table></div>
      </div>`);
  }

  /* ------------------------------------------------------------- settlements */
  async function settlements(match, ctx) {
    const data = await PA.api('GET', '/seller/settlements');
    if (!ctx.isCurrent()) return;
    const s = data.summary || {};
    PA.set(`
      ${pageHead('Settlements', 'What the platform owes you for delivered orders — refunds and commission already deducted.',
        `<button class="btn btn-primary" id="gen-settlement">${PA.icon('file')} Generate settlement</button>`)}

      <div class="kpi-grid">
        <div class="kpi green"><span class="label">Total earnings</span><span class="value">${money(s.totalEarnings || 0)}</span><span class="hint">Every generated statement</span></div>
        <div class="kpi amber"><span class="label">Pending</span><span class="value">${money(s.pending || 0)}</span><span class="hint">Statement raised, not yet processing</span></div>
        <div class="kpi"><span class="label">Processing</span><span class="value">${money(s.processing || 0)}</span><span class="hint">Transfer initiated</span></div>
        <div class="kpi accent"><span class="label">Settled</span><span class="value">${money(s.settled || 0)}</span><span class="hint">Confirmed payouts only</span></div>
        <div class="kpi red"><span class="label">Refund deductions</span><span class="value">${money(s.refundDeductions || 0)}</span><span class="hint">Taken back from settlements</span></div>
        <div class="kpi ${(s.onHold || 0) || (s.failed || 0) ? 'red' : ''}"><span class="label">On hold / failed</span><span class="value">${money((s.onHold || 0) + (s.failed || 0))}</span><span class="hint">Needs reconciliation</span></div>
      </div>

      <div class="card flush">
        <div class="card-head"><h2>Settlement history</h2></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Statement</th><th>Period</th><th class="right">Gross</th><th class="right">Refunds</th><th class="right">Commission</th><th class="right">Net payable</th><th>Status</th><th class="right">Actions</th></tr></thead>
          <tbody>${(data.settlements || []).length ? data.settlements.map((st) => `
            <tr>
              <td><b class="mono">${esc(st.code)}</b><div class="small muted">${st.bankReference ? 'ref ' + esc(st.bankReference) : 'generated ' + PA.ago(st.createdAt)}</div></td>
              <td class="small">${esc(st.periodStart)} → ${esc(st.periodEnd)}</td>
              <td class="right">${money(st.gross)}</td>
              <td class="right">−${money(st.refunds)}</td>
              <td class="right">−${money(st.commission)}</td>
              <td class="right"><b>${money(st.net)}</b></td>
              <td>${PA.status(st.status)}</td>
              <td class="right row" style="justify-content:flex-end;gap:6px">
                <button class="btn btn-sm" data-st-detail="${esc(st.code)}">${PA.icon('eye')} Detail</button>
                <a class="btn btn-sm" href="/api/partner/seller/settlements/${encodeURIComponent(st.code)}/statement.csv" target="_blank" rel="noopener">${PA.icon('download')} CSV</a>
              </td>
            </tr>`).join('')
          : `<tr><td colspan="8" class="muted small" style="text-align:center;padding:26px">No statements yet — generate one once you have delivered orders.</td></tr>`}</tbody>
        </table></div>
        <div class="card-foot"><span class="muted small">Settlements never show “completed” before the admin team confirms an actual payout. Bank account changes are verified separately.</span></div>
      </div>`);

    PA.on('#gen-settlement', 'click', () => generateSettlementModal());
    PA.onAll('[data-st-detail]', 'click', async (e) => {
      try {
        const st = await PA.api('GET', `/seller/settlements/${encodeURIComponent(e.currentTarget.dataset.stDetail)}`);
        const rows = st.items || [];
        PA.modal({
          title: `${st.settlement.code} — statement detail`,
          wide: true,
          body: `${PA.kv([
              ['Period', `${st.settlement.periodStart} → ${st.settlement.periodEnd}`],
              ['Gross order value', money(st.settlement.gross)],
              ['Refunds deducted', '−' + money(st.settlement.refunds)],
              ['Commission', '−' + money(st.settlement.commission)],
              ['Adjustments', money(st.settlement.adjustments || 0)],
              ['Net payable', money(st.settlement.net)],
              ['Status', String(st.settlement.status).replace(/_/g, ' ')],
              ['Bank reference', st.settlement.bankReference || 'pending']
            ])}
            <div class="table-wrap" style="margin-top:12px"><table class="data">
              <thead><tr><th>Order</th><th>Date</th><th class="right">Gross</th><th class="right">Refund</th></tr></thead>
              <tbody>${rows.length ? rows.map((r) => `<tr><td class="mono small">${esc(r.orderCode || r.sellerOrderId)}</td><td class="small">${PA.dateOnly(r.createdAt || '')}</td><td class="right">${money(r.gross)}</td><td class="right">${r.refund ? '−' + money(r.refund) : '—'}</td></tr>`).join('')
              : '<tr><td colspan="4" class="muted small" style="padding:14px;text-align:center">No line items.</td></tr>'}</tbody></table></div>`,
          actions: [{ label: 'Close' }]
        });
      } catch (err) { PA.toast(err.message, 'err'); }
    });
  }

  function generateSettlementModal() {
    const today = new Date();
    const monthAgo = new Date(Date.now() - 30 * 864e5);
    const fmt = (d) => d.toISOString().slice(0, 10);
    PA.modal({
      title: 'Generate settlement statement',
      body: `<p class="muted small">Includes delivered/completed orders in the period that have not been settled before.</p>
        <div class="grid g2">
          ${PA.field('st-from', 'Period start', fmt(monthAgo), { type: 'date' })}
          ${PA.field('st-to', 'Period end', fmt(today), { type: 'date' })}
        </div>`,
      actions: [
        { label: 'Cancel' },
        { label: 'Generate statement', primary: true, onClick: async (back) => {
            const res = await PA.api('POST', '/seller/settlements/generate', {
              periodStart: back.querySelector('#st-from').value,
              periodEnd: back.querySelector('#st-to').value
            });
            PA.toast(`Statement ${res.settlement.code} created — ${money(res.settlement.net)} net payable.`);
            PA.render();
          } }
      ]
    });
  }

  /* ----------------------------------------------------------------- staff */
  async function staff(match, ctx) {
    const data = await PA.api('GET', '/seller/staff');
    if (!ctx.isCurrent()) return;
    cache.staffData = data;
    const perms = data.allPermissions || [];
    PA.set(`
      ${pageHead('Staff Management', 'Give teammates scoped accounts. Staff never inherit owner privileges — every permission is explicit and logged.',
        `<button class="btn btn-primary" id="add-staff">${PA.icon('plus')} Add staff member</button>`)}

      <div class="card flush">
        <div class="card-head"><h2>Team</h2></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Name</th><th>Contact</th><th>Role</th><th>Permissions</th><th>Status</th><th>Added</th><th class="right">Actions</th></tr></thead>
          <tbody>${(data.staff || []).length ? data.staff.map((m) => `
            <tr>
              <td><b>${esc(m.name)}</b></td>
              <td class="small">${esc(m.email)}<div class="muted small">${esc(m.phone || '')}</div></td>
              <td>${PA.badge(String(m.role).replace(/_/g, ' '), m.role === 'store_manager' ? 'blue' : 'grey')}</td>
              <td class="small muted">${(m.permissions || []).length} permission(s)</td>
              <td>${PA.status(m.status)}</td>
              <td class="small">${m.createdAt ? PA.dateOnly(m.createdAt) : '—'}</td>
              <td class="right row" style="justify-content:flex-end;gap:6px">
                <button class="btn btn-sm" data-staff-edit="${esc(m.id)}">${PA.icon('edit')} Permissions</button>
                ${m.status === 'active' ? `<button class="btn btn-sm btn-danger" data-staff-suspend="${esc(m.id)}">Suspend</button>`
                  : `<button class="btn btn-sm btn-success" data-staff-restore="${esc(m.id)}">Restore</button>`}
                <button class="btn btn-sm btn-danger" data-staff-remove="${esc(m.id)}">Remove</button>
              </td>
            </tr>`).join('')
          : `<tr><td colspan="7" class="muted small" style="text-align:center;padding:26px">You run the shop alone right now. Add staff to share orders, packing and inventory work.</td></tr>`}</tbody>
        </table></div>
      </div>

      <div class="card flush">
        <div class="card-head"><h2>Roles & default permissions</h2></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Permission</th>${(data.roles || []).map((r) => `<th class="center">${esc(r.label)}</th>`).join('')}<th class="center">Owner (you)</th></tr></thead>
          <tbody>${perms.map((perm) => `<tr><td class="small">${esc(String(perm).replace(/_/g, ' '))}</td>
            ${(data.roles || []).map((r) => `<td class="center">${(r.permissions || []).includes(perm) ? '<b style="color:#19A957">✓</b>' : '<span class="muted">—</span>'}</td>`).join('')}
            <td class="center"><b style="color:#19A957">✓</b></td></tr>`).join('')}</tbody>
        </table></div>
        <div class="card-foot"><span class="muted small">Owners keep every permission. Managers get a configurable subset. Packing and delivery staff stay inside their lane.</span></div>
      </div>

      <div class="card flush">
        <div class="card-head"><h2>Recent staff activity</h2></div>
        <div class="card-body" id="staff-activity"><p class="muted small">Loading…</p></div>
      </div>`);

    PA.on('#add-staff', 'click', () => addStaffModal(data));
    PA.onAll('[data-staff-edit]', 'click', (e) => editStaffModal(e.currentTarget.dataset.staffEdit, data));
    PA.onAll('[data-staff-suspend], [data-staff-restore]', 'click', async (e) => {
      const id = e.currentTarget.dataset.staffSuspend || e.currentTarget.dataset.staffRestore;
      const active = Boolean(e.currentTarget.dataset.staffSuspend);
      try {
        await PA.api('PATCH', `/seller/staff/${encodeURIComponent(id)}`, { status: active ? 'suspended' : 'active' });
        PA.toast(active ? 'Staff suspended — their sign-in is blocked.' : 'Staff restored.');
        PA.render();
      } catch (err) { PA.toast(err.message, 'err'); }
    });
    PA.onAll('[data-staff-remove]', 'click', async (e) => {
      const ok = await PA.confirm('Remove this staff member?', 'Their account stays in the platform but loses all access to your shop.');
      if (!ok) return;
      try { await PA.api('DELETE', `/seller/staff/${encodeURIComponent(e.currentTarget.dataset.staffRemove)}`); PA.toast('Staff removed.'); PA.render(); }
      catch (err) { PA.toast(err.message, 'err'); }
    });

    PA.api('GET', '/seller/staff/activity').then((log) => {
      const el = $('#staff-activity');
      if (!el) return;
      el.innerHTML = (log.events || log.activity || []).length
        ? `<div class="list">${(log.events || log.activity || []).slice(0, 20).map((ev) => `<div class="item"><span class="emoji">🧾</span><div class="grow"><b>${esc(ev.actor || ev.name || 'Someone')}</b> <span class="small">${esc(ev.detail || ev.action || '')}</span><div class="small muted">${PA.dateTime(ev.at)}</div></div></div>`).join('')}</div>`
        : PA.empty('🕓', 'No activity recorded yet', 'Important staff operations — logins, stock edits, order actions — appear here as an audit trail.');
    }).catch(() => {});
  }

  function addStaffModal(data) {
    PA.modal({
      title: 'Add a staff member',
      wide: true,
      body: `<p class="muted small">Creates a partner sign-in for your shop with the chosen role’s permissions.</p>
        <div class="grid g2">
          ${PA.field('sf-name', 'Full name *', '', { required: true })}
          ${PA.field('sf-email', 'Email *', '', { type: 'email', required: true })}
          ${PA.field('sf-phone', 'Mobile number *', '', { placeholder: '10-digit mobile', required: true })}
          ${PA.field('sf-password', 'Temporary password *', '', { type: 'password', help: 'At least 8 characters — they can change it later.' })}
          <div class="field"><label for="sf-role">Role *</label>
            <select class="input" id="sf-role">${(data.roles || []).map((r) => `<option value="${r.id}">${esc(r.label)}</option>`).join('')}</select>
            <span class="help" id="sf-role-help"></span></div>
        </div>
        <div class="field"><label>Custom permissions (optional override)</label>
          <div class="row" style="flex-wrap:wrap;gap:4px 14px" id="sf-perms">${(data.allPermissions || []).map((p) => `<label class="row tight small"><input type="checkbox" value="${esc(p)}" data-perm /> ${esc(String(p).replace(/_/g, ' '))}</label>`).join('')}</div></div>`,
      actions: [
        { label: 'Cancel' },
        { label: 'Create staff account', primary: true, onClick: async (back) => {
            const custom = $$('#sf-perms [data-perm]:checked', back).map((c) => c.value);
            await PA.api('POST', '/seller/staff', {
              name: back.querySelector('#sf-name').value.trim(),
              email: back.querySelector('#sf-email').value.trim(),
              phone: back.querySelector('#sf-phone').value.trim(),
              password: back.querySelector('#sf-password').value,
              role: back.querySelector('#sf-role').value,
              permissions: custom.length ? custom : undefined
            });
            PA.toast('Staff account created — they can sign in at the Seller Hub gate.');
            PA.render();
          } }
      ],
      onMount: (back) => {
        const help = back.querySelector('#sf-role-help');
        const sync = () => {
          const role = (data.roles || []).find((r) => r.id === back.querySelector('#sf-role').value);
          help.textContent = role ? `Defaults: ${(role.permissions || []).map((p) => String(p).replace(/_/g, ' ')).join(', ')}` : '';
          $$('#sf-perms [data-perm]', back).forEach((c) => { c.checked = role ? (role.permissions || []).includes(c.value) : false; });
        };
        back.querySelector('#sf-role').addEventListener('change', sync);
        sync();
      }
    });
  }

  function editStaffModal(id, data) {
    const m = (data.staff || []).find((x) => x.id === id);
    if (!m) return;
    PA.modal({
      title: `Permissions — ${m.name}`,
      body: `<p class="muted small">Role ${esc(String(m.role).replace(/_/g, ' '))}. Unchecked permissions are revoked immediately.</p>
        <div class="stack" style="gap:6px">${(data.allPermissions || []).map((p) => `<label class="row tight small"><input type="checkbox" value="${esc(p)}" data-perm ${(m.permissions || []).includes(p) ? 'checked' : ''}/> ${esc(String(p).replace(/_/g, ' '))}</label>`).join('')}</div>`,
      actions: [
        { label: 'Cancel' },
        { label: 'Save permissions', primary: true, onClick: async (back) => {
            const perms = $$('[data-perm]:checked', back).map((c) => c.value);
            await PA.api('PATCH', `/seller/staff/${encodeURIComponent(id)}`, { permissions: perms });
            PA.toast('Permissions updated.');
            PA.render();
          } }
      ]
    });
  }

  /* ------------------------------------------------------ profile + KYC panel */
  const VER_STEPS = ['registration_started', 'documents_pending', 'submitted', 'under_review', 'approved'];
  const VER_LABEL = { registration_started: 'Registration started', documents_pending: 'Documents pending', submitted: 'Verification submitted', under_review: 'Under review', approved: 'Approved', rejected: 'Rejected', info_required: 'Additional information required', suspended: 'Suspended' };

  async function profile(match, ctx) {
    const [prof, ver] = await Promise.all([
      PA.api('GET', '/seller/profile'),
      PA.api('GET', '/seller/verification').catch(() => null)
    ]);
    if (!ctx.isCurrent()) return;
    const shop = prof.shop || {};
    const v = ver && ver.verification ? ver.verification : null;
    const docs = ver && ver.documents ? ver.documents : [];
    const stepIdx = v ? VER_STEPS.indexOf(v.status) : -1;
    PA.set(`
      ${pageHead('Shop Profile & KYC', `Seller ID ${esc(shop.sellerId || '—')} · Shop ID ${esc(shop.shopId || '—')} — everything public here syncs with the Customer Portal.`)}

      <div class="card">
        <h2>Business verification</h2>
        <div class="stepper" style="margin-top:12px">${VER_STEPS.map((s, i) => `
          <div class="step ${v && (v.status === 'approved' || i < Math.max(stepIdx, 0)) ? 'done' : ''} ${v && s === v.status ? 'active' : ''}"><b>${i + 1} · ${VER_LABEL[s]}</b></div>`).join('')}</div>
        ${v ? `<div class="banner-note ${v.status === 'approved' ? 'ok' : v.status === 'rejected' ? 'warn' : 'info'}" style="margin-top:12px">
            <b>Status: ${esc(VER_LABEL[v.status] || v.status)}</b>${v.reason ? ` — ${esc(v.reason)}` : ''}${v.submittedAt ? `<div class="small muted">Submitted ${PA.dateTime(v.submittedAt)}${v.reviewedAt ? ' · reviewed ' + PA.dateTime(v.reviewedAt) : ''}</div>` : ''}
          </div>
          ${PA.kv([['Legal business name', v.legalName], ['Business category', v.businessCategory], ['Shop type', v.shopType], ['Ownership', v.ownershipType], ['PAN', v.pan], ['GST', v.gst], ['Contact', v.contactNumber], ['Business email', v.businessEmail]])}`
        : '<p class="muted small">No verification record found — complete registration from the seller registration page.</p>'}
        <div class="row" style="margin-top:10px">${!v || !['approved'].includes(v.status) ? `<button class="btn btn-primary" id="kyc-submit">${PA.icon('shield')} Submit KYC details</button>` : ''}
          ${docs.length ? `<span class="muted small">${docs.length} document(s) on file: ${docs.map((d) => esc(d.type + ' — ' + d.fileName)).join('; ')}</span>` : ''}</div>
      </div>

      <form class="card" id="profile-form">
        <h2>Shop identity</h2>
        <div class="grid g2">
          ${PA.field('sp-name', 'Display shop name *', shop.name, { required: true })}
          <div class="field"><label for="sp-category">Business category</label><select class="input" id="sp-category">${categoryOptions(shop.category_slug || shop.categorySlug)}</select></div>
          ${PA.field('sp-tagline', 'Tagline', shop.tagline || '', { placeholder: 'Fresh groceries, delivered local' })}
          ${PA.field('sp-logo', 'Logo URL', shop.logo_url || '', { placeholder: 'https://…/logo.png' })}
          ${PA.field('sp-cover', 'Cover image URL', shop.cover_url || '')}
          ${PA.field('sp-emoji', 'Emoji badge', shop.emoji || '🏪')}
          ${PA.field('sp-owner', 'Owner / proprietor name', shop.proprietor_name || shop.ownerName || '', { placeholder: 'Shown on the customer map', help: 'Printed next to your shop pin so customers know who runs it.' })}
        </div>
        <div class="field"><label for="sp-about">About the shop</label><textarea class="input" id="sp-about" rows="3">${esc(shop.about_text || shop.description || '')}</textarea></div>

        <h2 style="margin-top:18px">Address & location</h2>
        <div class="grid g2">
          ${PA.field('sp-address', 'Full address', shop.address || '')}
          ${PA.field('sp-locality', 'Locality / street', shop.locality || '')}
          ${PA.field('sp-city', 'City', shop.city || '')}
          ${PA.field('sp-pincode', 'PIN code', shop.pincode || '', { pattern: '\\d{6}' })}
          ${PA.field('sp-lat', 'Latitude', shop.lat, { type: 'number', step: '0.000001', help: 'Authorised location changes only.' })}
          ${PA.field('sp-lng', 'Longitude', shop.lng, { type: 'number', step: '0.000001' })}
        </div>

        <h2 style="margin-top:18px">Contact & policies</h2>
        <div class="grid g2">
          ${PA.field('sp-phone', 'Shop phone', shop.phone || '')}
          ${PA.field('sp-bemail', 'Business email', shop.business_email || '', { type: 'email' })}
          ${PA.field('sp-support', 'Support contact', shop.support_contact || '')}
        </div>
        <div class="field"><label for="sp-return-policy">Return policy</label><textarea class="input" id="sp-return-policy" rows="2">${esc(shop.return_policy || '')}</textarea></div>
        <div class="field"><label for="sp-pickup">Pickup instructions</label><textarea class="input" id="sp-pickup" rows="2">${esc(shop.pickup_instructions || '')}</textarea></div>
        <div class="field"><label for="sp-delivery-info">Delivery information</label><textarea class="input" id="sp-delivery-info" rows="2">${esc(shop.delivery_info || '')}</textarea></div>

        <div class="card-foot row"><span class="spacer"></span><button class="btn btn-primary" type="submit">Save shop profile</button></div>
      </form>`);

    if ($('#sp-category') && !(cache.categories || []).length) {
      PA.api('GET', '/seller/products').then((d) => { cache.categories = d.categories || []; PA.render(); }).catch(() => {});
    }

    $('#profile-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await PA.api('PATCH', '/seller/profile', {
          name: $('#sp-name').value.trim(), category: $('#sp-category').value, tagline: $('#sp-tagline').value.trim(),
          logoUrl: $('#sp-logo').value.trim() || null, coverUrl: $('#sp-cover').value.trim() || null,
          about: $('#sp-about').value.trim(), description: $('#sp-about').value.trim(),
          address: $('#sp-address').value.trim(), locality: $('#sp-locality').value.trim(), city: $('#sp-city').value.trim(),
          pincode: $('#sp-pincode').value.trim(), lat: Number($('#sp-lat').value), lng: Number($('#sp-lng').value),
          ownerName: $('#sp-owner').value.trim(),
          phone: $('#sp-phone').value.trim(), businessEmail: $('#sp-bemail').value.trim(), supportContact: $('#sp-support').value.trim(),
          returnPolicy: $('#sp-return-policy').value.trim(), pickupInstructions: $('#sp-pickup').value.trim(), deliveryInfo: $('#sp-delivery-info').value.trim()
        });
        PA.toast('Shop profile saved — the Customer Portal now shows these details.');
        PA.render();
      } catch (err) { PA.toast(err.message, 'err'); }
    });

    PA.on('#kyc-submit', 'click', () => kycModal(v || {}, docs));
  }

  function kycModal(v, docs) {
    const DOC_TYPES = [['pan', 'PAN card'], ['gst', 'GST certificate'], ['business_registration', 'Business registration'], ['address_proof', 'Shop address proof'], ['owner_id', 'Owner identity proof']];
    PA.modal({
      title: 'Submit KYC & business verification',
      wide: true,
      body: `<p class="muted small">Collected only for the applicable verification process. The admin team reviews every submission before selling unlocks.</p>
        <div class="grid g2">
          ${PA.field('ky-legal', 'Legal business name', v.legalName || '')}
          <div class="field"><label for="ky-category">Business category</label><select class="input" id="ky-category">${categoryOptions(v.businessCategory)}</select></div>
          <div class="field"><label for="ky-shoptype">Shop type</label><select class="input" id="ky-shoptype">
            <option value="retail">Retail store</option><option value="wholesale">Wholesale</option><option value="service">Service provider</option><option value="food">Food & beverage</option><option value="pharmacy">Pharmacy</option></select></div>
          <div class="field"><label for="ky-ownership">Ownership type</label><select class="input" id="ky-ownership">
            <option value="proprietorship">Proprietorship</option><option value="partnership">Partnership</option><option value="llp">LLP</option><option value="private_limited">Private limited</option></select></div>
          ${PA.field('ky-pan', 'PAN number', v.pan || '', { placeholder: 'ABCDE1234F' })}
          ${PA.field('ky-gst', 'GST number (if applicable)', v.gst || '')}
          ${PA.field('ky-contact', 'Business contact number', v.contactNumber || '')}
          ${PA.field('ky-email', 'Business email', v.businessEmail || '', { type: 'email' })}
        </div>
        <div class="field"><label for="ky-desc">Business description</label><textarea class="input" id="ky-desc" rows="2">${esc(v.description || '')}</textarea></div>
        <h3 style="margin-top:14px">Documents</h3>
        <p class="muted small">Files are validated and stored securely; this demo records metadata after validation.</p>
        <div id="ky-docs" class="stack" style="gap:8px">${(docs.length ? docs.map((d) => docRowReadonly(d)) : DOC_TYPES.map(([id, label]) => docRowInput(id, label)).join(''))}</div>
        <button class="btn btn-sm" type="button" id="ky-add-doc" style="margin-top:8px">${PA.icon('plus')} Add another document</button>`,
      actions: [
        { label: 'Cancel' },
        { label: 'Submit for verification', primary: true, onClick: async (back) => {
            const docRows = $$('[data-doc-type]', back).map((sel) => ({
              type: sel.querySelector('[data-doc-type]').value,
              fileName: sel.querySelector('[data-doc-file]').files[0]?.name || sel.querySelector('[data-doc-name]')?.value || '',
              fileType: sel.querySelector('[data-doc-file]').files[0]?.type || 'application/pdf',
              fileSize: sel.querySelector('[data-doc-file]').files[0]?.size || 0
            })).filter((d) => d.fileName);
            if (!docRows.length) throw new Error('Attach at least one KYC document.');
            await PA.api('POST', '/seller/verification/submit', {
              legalName: back.querySelector('#ky-legal').value.trim(),
              businessCategory: back.querySelector('#ky-category').value,
              shopType: back.querySelector('#ky-shoptype').value,
              ownershipType: back.querySelector('#ky-ownership').value,
              pan: back.querySelector('#ky-pan').value.trim(),
              gst: back.querySelector('#ky-gst').value.trim(),
              contactNumber: back.querySelector('#ky-contact').value.trim(),
              businessEmail: back.querySelector('#ky-email').value.trim(),
              description: back.querySelector('#ky-desc').value.trim(),
              documents: docRows
            });
            PA.toast('KYC submitted — the admin team will review it. You’ll get a notification either way.');
            PA.render();
          } }
      ],
      onMount: (back) => {
        back.querySelector('#ky-add-doc').addEventListener('click', () => {
          back.querySelector('#ky-docs').insertAdjacentHTML('beforeend', docRowInput('other', 'Other document'));
        });
      }
    });
  }

  function docRowInput(type, label) {
    return `<div class="row tight" data-doc-row>
      <select class="input" data-doc-type style="max-width:220px">
        ${[['pan', 'PAN card'], ['gst', 'GST certificate'], ['business_registration', 'Business registration'], ['address_proof', 'Address proof'], ['owner_id', 'Owner ID proof'], ['other', 'Other']].map(([id, l]) => `<option value="${id}" ${id === type ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <input class="input grow" type="file" data-doc-file accept=".pdf,.jpg,.jpeg,.png" aria-label="${esc(label)} file" />
    </div>`;
  }

  function docRowReadonly(d) {
    return `<div class="row tight" data-doc-row>
      <select class="input" data-doc-type style="max-width:220px"><option value="${esc(d.type)}" selected>${esc(d.type.replace(/_/g, ' '))}</option></select>
      <input class="input grow" data-doc-name value="${esc(d.fileName)}" readonly />
      <input type="file" data-doc-file hidden />
      ${PA.badge('on file', 'green')}
    </div>`;
  }

  /* ------------------------------------------------------------ business hours */
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  async function hours(match, ctx) {
    const data = await PA.api('GET', '/seller/hours');
    const prof = await PA.api('GET', '/seller/profile').catch(() => ({ shop: {} }));
    if (!ctx.isCurrent()) return;
    /* The API returns a grouped payload ({ days, holidays, isOpen, ... }).
     * Older builds returned a flat row array — accept both so the page never throws. */
    const payloadHours = data.hours || {};
    const flatRows = Array.isArray(payloadHours) ? payloadHours : null;
    const dayRows = flatRows
      ? flatRows.filter((r) => !r.holidayDate)
      : (Array.isArray(payloadHours.days) ? payloadHours.days : []);
    const holidayRows = flatRows
      ? flatRows.filter((r) => r.holidayDate).map((r) => ({ holidayDate: r.holidayDate, holidayLabel: r.holidayLabel }))
      : (Array.isArray(payloadHours.holidays) ? payloadHours.holidays.map((h) => ({ holidayDate: h.holidayDate || h.date, holidayLabel: h.holidayLabel || h.label })) : []);
    const byDay = Object.fromEntries(dayRows.map((r) => [r.day, r]));
    const holidays = holidayRows;
    const shop = prof.shop || {};
    /* `/seller/profile` exposes snake_case (`is_open`); the hours payload exposes `isOpen`. */
    const shopIsOpen = flatRows
      ? (shop.isOpen === undefined ? shop.is_open : shop.isOpen)
      : (payloadHours.isOpen === undefined ? shop.is_open : payloadHours.isOpen);
    const next = data.nextOpening;
    PA.set(`
      ${pageHead('Business Hours', 'Outside these hours the storefront shows you closed and blocks unsupported fulfilment promises. Accepted orders always continue.',
        `<button class="btn" id="hours-open-toggle">${shopIsOpen === false ? 'Open now' : 'Close temporarily'}</button>`)}

      ${next ? `<div class="banner-note info"><b>Next opening:</b> ${esc(next.label || next.at)}</div>` : ''}

      <div class="card flush">
        <div class="card-head"><h2>Weekly schedule</h2><span class="spacer"></span><span class="muted small">Two shifts per day supported · break hours optional</span></div>
        <div class="card-body stack" id="hours-grid">${DAYS.map((name, d) => {
          const r = byDay[d] || {};
          const shifts = Array.isArray(r.shifts) && r.shifts.length ? r.shifts : [[r.open || '09:00', r.close || '21:00']];
          return `<div class="pack-row" style="grid-template-columns:120px 1fr auto" data-day="${d}">
            <b class="small">${name}</b>
            <div class="row tight" style="flex-wrap:wrap">
              <label class="row tight small"><input type="checkbox" class="day-closed" ${r.closed ? 'checked' : ''}/> Closed</label>
              ${shifts.slice(0, 2).map((sh, si) => `
                <span class="row tight">
                  <input class="input shift-open" type="time" value="${esc(sh[0] || '09:00')}" style="width:118px" aria-label="${name} shift ${si + 1} open" ${r.closed ? 'disabled' : ''}/>
                  <span class="muted">→</span>
                  <input class="input shift-close" type="time" value="${esc(sh[1] || '21:00')}" style="width:118px" aria-label="${name} shift ${si + 1} close" ${r.closed ? 'disabled' : ''}/>
                </span>`).join('')}
              <span class="row tight"><span class="muted small">Break</span>
                <input class="input break-start" type="time" value="${esc(r.breakStart || '')}" style="width:118px" aria-label="break start"/>
                <input class="input break-end" type="time" value="${esc(r.breakEnd || '')}" style="width:118px" aria-label="break end"/></span>
            </div>
            <span class="small muted">${r.closed ? 'Holiday/closed day' : 'Operating'}</span>
          </div>`;
        }).join('')}</div>
        <div class="card-foot row"><button class="btn btn-primary" id="save-hours">Save weekly schedule</button><span class="spacer"></span><span class="muted small">Individual products can still be deactivated anytime from the catalogue.</span></div>
      </div>

      <div class="grid g2">
        <div class="card">
          <h3>Holidays & temporary closures</h3>
          <div class="row tight" style="margin-top:10px;flex-wrap:wrap">
            ${PA.field('hol-date', 'Holiday date', '', { type: 'date' })}
            ${PA.field('hol-label', 'Label', 'Public holiday')}
            <button class="btn" id="set-holiday" style="align-self:flex-end">Set holiday</button>
          </div>
          ${(holidays || []).length ? `<div class="list" style="margin-top:10px">${holidays.map((h) => `<div class="item"><span class="emoji">🎉</span><div class="grow"><b>${esc(h.holidayLabel || 'Holiday')}</b><span>${esc(h.holidayDate)}</span></div>${PA.badge('closed', 'amber')}</div>`).join('')}</div>` : ''}
          <div class="field" style="margin-top:12px"><label for="temp-until">Schedule temporary closure until</label>
            <input class="input" type="datetime-local" id="temp-until" /></div>
          <button class="btn btn-danger" id="temp-close">Close temporarily</button>
        </div>
        <div class="card">
          <h3>Quick controls</h3>
          <p class="muted small">These flip the live shop status customers see, without touching your schedule.</p>
          <div class="switch-row"><div><b class="small">Shop open flag</b><div class="desc">Turn off to hide “open now” on the storefront.</div></div>
            <input type="checkbox" class="switch" id="open-flag" ${shopIsOpen !== false ? 'checked' : ''}/></div>
          <div class="banner-note warn" style="margin-top:10px">Closing preserves existing accepted orders — only new commitments stop.</div>
        </div>
      </div>`);

    PA.onAll('.day-closed', 'change', (e) => {
      const rowEl = e.target.closest('[data-day]');
      rowEl.querySelectorAll('input[type=time]').forEach((t) => { t.disabled = e.target.checked; });
    });

    const payloadFromForm = (extra = {}) => ({
      days: DAYS.map((_, d) => {
        const rowEl = $(`[data-day="${d}"]`);
        const opens = $$('.shift-open', rowEl).map((i) => i.value).filter(Boolean);
        const closes = $$('.shift-close', rowEl).map((i) => i.value).filter(Boolean);
        const closed = rowEl.querySelector('.day-closed').checked;
        const shifts = opens.map((o, si) => [o, closes[si] || '21:00']);
        return {
          day: d, closed,
          open: shifts[0] ? shifts[0][0] : '09:00', close: shifts[0] ? shifts[0][1] : '21:00',
          breaks: [],
          breakStart: rowEl.querySelector('.break-start').value || null,
          breakEnd: rowEl.querySelector('.break-end').value || null,
          shifts: shifts.length > 1 ? shifts : []
        };
      }),
      ...extra
    });

    PA.on('#save-hours', 'click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try { await PA.api('PATCH', '/seller/hours', payloadFromForm()); PA.toast('Weekly hours saved and synced to the storefront.'); PA.render(); }
      catch (err) { PA.toast(err.message, 'err'); btn.disabled = false; }
    });
    PA.on('#set-holiday', 'click', async () => {
      const date = $('#hol-date').value, label = $('#hol-label').value.trim() || 'Holiday';
      if (!date) { PA.toast('Choose a holiday date.', 'err'); return; }
      try { await PA.api('PATCH', '/seller/hours', payloadFromForm({ holidays: [{ date, label }] })); PA.toast('Holiday added — the shop shows closed that day.'); PA.render(); }
      catch (err) { PA.toast(err.message, 'err'); }
    });
    PA.on('#temp-close', 'click', async () => {
      const until = $('#temp-until').value;
      try { await PA.api('PATCH', '/seller/hours', payloadFromForm({ isOpen: false, temporaryClosureUntil: until || null })); PA.toast(until ? `Closed until ${until}.` : 'Shop closed temporarily.'); PA.render(); }
      catch (err) { PA.toast(err.message, 'err'); }
    });
    PA.on('#open-flag', 'change', async (e) => {
      try { await PA.api('PATCH', '/seller/hours', payloadFromForm({ isOpen: e.target.checked })); PA.toast(e.target.checked ? 'Shop marked open.' : 'Shop marked closed on the storefront.'); }
      catch (err) { PA.toast(err.message, 'err'); PA.render(); }
    });
    PA.on('#hours-open-toggle', 'click', async (e) => {
      const btn = e.currentTarget;
      const closing = shopIsOpen !== false;
      btn.disabled = true;
      try { await PA.api('PATCH', '/seller/hours', payloadFromForm({ isOpen: !closing })); PA.toast(!closing ? 'Shop re-opened.' : 'Shop closed temporarily.'); PA.render(); }
      catch (err) { PA.toast(err.message, 'err'); btn.disabled = false; }
    });
  }

  /* ---------------------------------------------------------------- returns */
  async function returns(match, ctx) {
    const data = await PA.api('GET', '/seller/returns');
    if (!ctx.isCurrent()) return;
    const rows = data.returns || [];
    const open = rows.filter((r) => !['completed', 'rejected'].includes(r.status));
    PA.set(`
      ${pageHead('Returns & Refunds', `${open.length} open request(s). Approving starts the refund; completing it restocks the returned item.`,
        `<a class="btn" href="#/orders">${PA.icon('orders')} Orders</a>`)}

      <div class="kpi-grid">
        <div class="kpi amber"><span class="label">Open requests</span><span class="value">${open.length}</span><span class="hint">Awaiting your decision</span></div>
        <div class="kpi green"><span class="label">Completed</span><span class="value">${rows.filter((r) => r.status === 'completed').length}</span><span class="hint">Refunded and restocked</span></div>
        <div class="kpi red"><span class="label">Rejected</span><span class="value">${rows.filter((r) => r.status === 'rejected').length}</span><span class="hint">Reason shared with the customer</span></div>
        <div class="kpi"><span class="label">Refund value</span><span class="value">${money(rows.reduce((sum, r) => sum + (r.amount || 0), 0))}</span><span class="hint">Requested across all returns</span></div>
      </div>

      <div class="card flush">
        <div class="card-head"><h2>Return requests</h2><span class="spacer"></span><span class="muted small">Decisions notify the customer and drive the refund ledger</span></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Return</th><th>Item</th><th>Reason</th><th class="right">Refund</th><th>Status</th><th>Raised</th><th class="right">Actions</th></tr></thead>
          <tbody>${rows.length ? rows.map((r) => `
            <tr>
              <td><b class="mono">${esc(r.code)}</b><div class="small muted">order ${esc(r.sellerOrderCode || r.orderCode || '')}</div></td>
              <td><span class="emoji">${esc(r.item?.emoji || '📦')}</span> ${esc(r.item?.name || '')}<div class="small muted">qty ${r.item?.qty ?? 0}</div></td>
              <td class="small">${esc(String(r.reason || '').replace(/_/g, ' '))}${r.comment ? `<div class="muted small">${esc(r.comment)}</div>` : ''}</td>
              <td class="right"><b>${money(r.amount || 0)}</b></td>
              <td>${PA.status(r.status)}</td>
              <td class="small">${PA.dateTime(r.createdAt)}</td>
              <td class="right row" style="justify-content:flex-end;gap:6px">
                ${['requested', 'under_review'].includes(r.status) ? `
                  <button class="btn btn-sm btn-success" data-ret-act="approve" data-code="${esc(r.code)}">Approve</button>
                  <button class="btn btn-sm" data-ret-act="review" data-code="${esc(r.code)}">Inspect</button>
                  <button class="btn btn-sm btn-danger" data-ret-act="reject" data-code="${esc(r.code)}">Reject</button>` : ''}
                ${['approved', 'processing'].includes(r.status) ? `
                  <button class="btn btn-sm btn-primary" data-ret-act="complete" data-code="${esc(r.code)}">Complete & restock</button>` : ''}
                ${['completed', 'rejected'].includes(r.status) ? '<span class="small muted">closed</span>' : ''}
              </td>
            </tr>`).join('')
          : `<tr><td colspan="7" class="muted small" style="text-align:center;padding:26px">No return requests — your customers are happy.</td></tr>`}</tbody>
        </table></div>
        <div class="card-foot"><span class="muted small">Completing a return puts the units back on the shelf and marks the refund completed; rejecting keeps the money with you and tells the customer why.</span></div>
      </div>`);

    PA.onAll('[data-ret-act]', 'click', async (e) => {
      const btn = e.currentTarget;
      const action = btn.dataset.retAct;
      const code = btn.dataset.code;
      const needsNote = action === 'reject' || action === 'review';
      let note = '';
      if (needsNote) {
        note = await promptText(action === 'reject' ? 'Why are you rejecting this return?' : 'What are you checking?',
          'The customer sees this note on their return request.');
        if (!note) return;
      }
      btn.disabled = true;
      try {
        const res = await PA.api('POST', `/seller/returns/${encodeURIComponent(code)}/action`, { action, note: note || undefined });
        PA.toast(res.message || 'Return updated.');
        PA.render();
      } catch (err) { btn.disabled = false; PA.toast(err.message, 'err'); }
    });
  }

  /* ---------------------------------------------------------------- reports */
  async function reports(match, ctx) {
    const data = await PA.api('GET', '/seller/reports');
    if (!ctx.isCurrent()) return;
    const ICONS = { sales: 'chart', orders: 'orders', products: 'box', stock: 'layers', low_stock: 'alert', movements: 'refresh', payments: 'wallet', refunds: 'rotate', settlements: 'rupee', promotions: 'percent' };
    PA.set(`
      ${pageHead('Reports & Invoices', 'Generated from your authorised seller data only — CSV for spreadsheet work, receipts for printing.')}
      <div class="kpi-grid">${(data.reports || []).map((r) => `
        <a class="kpi accent" style="text-decoration:none;color:inherit" href="/api/partner/seller/reports/${encodeURIComponent(r.file)}" target="_blank" rel="noopener">
          <span class="label">${PA.icon(ICONS[r.id] || 'file')} ${esc(r.label)}</span>
          <span class="value" style="font-size:15px">Download CSV</span>
          <span class="hint">${esc(r.file)} · server-generated now</span></a>`).join('')}
      </div>
      <div class="card"><h3>Seller receipts & tax invoices</h3>
        <p class="muted small">Order receipts print from every order page and are backed by authoritative payment data. A formal GST tax invoice is generated only when your business verification includes GST details — otherwise documents are labelled “order receipt”, never misrepresented as tax invoices.</p></div>`);
  }

  /* ---------------------------------------------------------- notifications */
  async function notifications(match, ctx) {
    const [data, prefs] = await Promise.all([
      PA.api('GET', '/seller/notifications'),
      PA.api('GET', '/seller/notifications/preferences')
    ]);
    if (!ctx.isCurrent()) return;
    const p = prefs.preferences || {};
    PA.set(`
      ${pageHead('Notifications', `${data.unread} unread — new orders, runner updates, payments, stock alerts and KYC results all land here.`,
        `<button class="btn" id="mark-all-read">Mark all read</button>`)}

      <div class="grid g2">
        <div class="card flush">
          <div class="card-head"><h2>Recent</h2></div>
          <div class="card-body">${(data.notifications || []).length ? `<div class="list">${data.notifications.map((n) => `
            <div class="item" style="${n.read ? '' : 'background:#f5faff'}">
              <span class="emoji">${ICON_FOR_TYPE[n.type] || '🔔'}</span>
              <div class="grow"><b>${esc(n.title)}</b><span>${esc(n.body || '')}</span><span class="small muted">${PA.ago(n.at)}</span></div>
              ${n.read ? '' : '<span class="badge blue">new</span>'}
              ${n.read ? '' : `<button class="btn btn-sm" data-read="${esc(n.id)}">Mark read</button>`}
              ${n.link ? `<a class="btn btn-sm" href="${esc(n.link)}">Open</a>` : ''}
            </div>`).join('')}</div>`
          : PA.empty('🔕', 'You’re all caught up', 'Nothing to read right now.')}</div>
        </div>

        <div class="card">
          <h2>Preferences</h2>
          <p class="muted small">In-app always stays on; the rest respect your browser permissions and configured providers.</p>
          ${prefSwitch('pf-inapp', 'In-app alerts', 'Badge counts plus this centre', p.inApp !== false)}
          ${prefSwitch('pf-email', 'Email notifications', 'Orders, settlements and KYC by email', Boolean(p.email))}
          ${prefSwitch('pf-sms', 'SMS notifications', 'Critical alerts by text message', Boolean(p.sms))}
          ${prefSwitch('pf-wa', 'WhatsApp notifications', 'Via configured provider, where available', Boolean(p.whatsapp))}
          <hr style="border:none;border-top:1px solid #eaf2fb;margin:10px 0"/>
          ${prefSwitch('pf-orders', 'New order alerts', 'Sound + badge for incoming orders', p.orderAlerts !== false)}
          ${prefSwitch('pf-stock', 'Stock alerts', 'Low-stock and out-of-stock warnings', p.stockAlerts !== false)}
          ${prefSwitch('pf-payments', 'Payment & settlement alerts', 'Refunds, payouts and failures', p.paymentAlerts !== false)}
          ${prefSwitch('pf-runner', 'Runner alerts', 'Requests, assignments and handovers', p.runnerAlerts !== false)}
          ${prefSwitch('pf-marketing', 'Tips & offers', 'Occasional platform growth tips', Boolean(p.marketing))}
          <div class="row" style="margin-top:12px"><button class="btn btn-primary" id="save-prefs">Save preferences</button></div>
        </div>
      </div>`);

    PA.on('#mark-all-read', 'click', async () => {
      try { await PA.api('POST', '/seller/notifications/read', { all: true }); PA.toast('All marked as read.'); PA.render(); }
      catch (err) { PA.toast(err.message, 'err'); }
    });
    PA.onAll('[data-read]', 'click', async (e) => {
      try { await PA.api('POST', '/seller/notifications/read', { id: e.currentTarget.dataset.read }); PA.render(); }
      catch (err) { PA.toast(err.message, 'err'); }
    });
    PA.on('#save-prefs', 'click', async () => {
      try {
        await PA.api('PATCH', '/seller/notifications/preferences', {
          inApp: $('#pf-inapp').checked, email: $('#pf-email').checked, sms: $('#pf-sms').checked, whatsapp: $('#pf-wa').checked,
          orderAlerts: $('#pf-orders').checked, stockAlerts: $('#pf-stock').checked, paymentAlerts: $('#pf-payments').checked,
          runnerAlerts: $('#pf-runner').checked, marketing: $('#pf-marketing').checked
        });
        PA.toast('Notification preferences saved.');
      } catch (err) { PA.toast(err.message, 'err'); }
    });
  }

  const ICON_FOR_TYPE = { order_new: '🛎️', order: '📦', runner: '🛵', payment: '💰', settlement: '🏦', stock: '📉', kyc: '🪪', review: '⭐', support: '💬', system: '⚙️' };

  function prefSwitch(id, label, desc, checked) {
    return `<div class="switch-row"><div><b class="small">${esc(label)}</b><div class="desc">${esc(desc)}</div></div>
      <input type="checkbox" class="switch" id="${id}" ${checked ? 'checked' : ''} /></div>`;
  }

  /* ----------------------------------------------------------------- support */
  async function support(match, ctx) {
    const [faqs, tickets] = await Promise.all([
      PA.api('GET', '/seller/support/faqs'),
      PA.api('GET', '/seller/support/tickets')
    ]);
    if (!ctx.isCurrent()) return;
    const cats = [...new Set((faqs.faqs || []).map((f) => f.category))];
    PA.set(`
      ${pageHead('Support Centre', 'Answers first, humans second — raise a ticket when an FAQ does not cover it.',
        `<button class="btn btn-primary" id="new-ticket">${PA.icon('plus')} Raise a ticket</button>`)}

      <div class="card flush">
        <div class="card-head"><h2>Your tickets</h2></div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Ticket</th><th>Category</th><th>Subject</th><th>Status</th><th>Assigned to</th><th>Updated</th><th class="right"></th></tr></thead>
          <tbody>${(tickets.tickets || []).length ? tickets.tickets.map((t) => `
            <tr>
              <td class="mono small">${esc(t.code)}</td>
              <td>${esc(String(t.category).replace(/_/g, ' '))}</td>
              <td>${esc(t.subject)}</td>
              <td>${PA.status(t.status)}</td>
              <td class="small">${esc(t.assignedAgent || '—')}</td>
              <td class="small">${PA.ago(t.updatedAt)}</td>
              <td class="right"><button class="btn btn-sm" data-ticket-open="${esc(t.code)}">Open thread</button></td>
            </tr>`).join('')
          : `<tr><td colspan="7" class="muted small" style="text-align:center;padding:22px">No tickets — that’s usually good news.</td></tr>`}</tbody>
        </table></div>
      </div>

      ${cats.map((c) => `
        <div class="card flush">
          <div class="card-head"><h3>${esc(c.replace(/_/g, ' '))}</h3></div>
          <div class="card-body stack">${faqs.faqs.filter((f) => f.category === c).map((f, i) => `
            <details class="faq-item"><summary><b class="small">${esc(f.question)}</b></summary><p class="small muted" style="margin:8px 0 2px">${esc(f.answer)}</p></details>`).join('')}</div>
        </div>`).join('')}`);

    PA.on('#new-ticket', 'click', () => ticketModal());
    PA.onAll('[data-ticket-open]', 'click', (e) => openTicketThread(e.currentTarget.dataset.ticketOpen));
  }

  function ticketModal() {
    const CATS = [['account_login', 'Account & login'], ['kyc', 'KYC & verification'], ['listing', 'Product listing'], ['inventory', 'Inventory'], ['order', 'Order problem'], ['runner', 'Runner complaint'], ['payment', 'Payment problem'], ['settlement', 'Settlement problem'], ['technical', 'Technical issue'], ['general', 'Something else']];
    PA.modal({
      title: 'Raise a support ticket',
      wide: true,
      body: `<div class="grid g2">
          <div class="field"><label for="tk-cat">Issue category *</label><select class="input" id="tk-cat">${CATS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
          ${PA.field('tk-order', 'Related order code (optional)', '', { placeholder: 'SO-XXXXXX' })}
        </div>
        ${PA.field('tk-subject', 'Subject *', '', { required: true })}
        <div class="field"><label for="tk-desc">Description *</label><textarea class="input" id="tk-desc" rows="4" required></textarea></div>
        <div class="field"><label for="tk-attach">Attachment filename (optional)</label><input class="input" id="tk-attach" placeholder="screenshot.png" /></div>`,
      actions: [
        { label: 'Cancel' },
        { label: 'Submit ticket', primary: true, onClick: async (back) => {
            const res = await PA.api('POST', '/seller/support/tickets', {
              category: back.querySelector('#tk-cat').value,
              subject: back.querySelector('#tk-subject').value.trim(),
              description: back.querySelector('#tk-desc').value.trim(),
              orderCode: back.querySelector('#tk-order').value.trim() || undefined,
              attachment: back.querySelector('#tk-attach').value.trim() || undefined
            });
            PA.toast(`Ticket ${res.ticket.code} raised — we’ll reply inside this console.`);
            PA.render();
          } }
      ]
    });
  }

  async function openTicketThread(code) {
    const data = await PA.api('GET', `/seller/support/tickets/${encodeURIComponent(code)}`);
    const t = data.ticket;
    PA.modal({
      title: `${t.code} — ${t.subject}`,
      wide: true,
      body: `<div class="row tight">${PA.status(t.status)} ${t.assignedAgent ? `<span class="small muted">· agent ${esc(t.assignedAgent)}</span>` : ''}<span class="spacer"></span><span class="small muted">${esc(t.category)}</span></div>
        <div class="stack" style="margin-top:12px;max-height:340px;overflow:auto">${(t.messages || []).length ? t.messages.map((m) => `
          <div class="banner-note ${m.authorRole === 'seller' ? '' : 'info'}"><b>${esc(m.authorName || m.authorRole)}</b> <span class="small muted">${PA.dateTime(m.at)}</span><p class="small" style="margin:6px 0 0">${esc(m.body)}</p></div>`).join('')
        : `<p class="muted small">Original message: ${esc(t.description || '')}</p>`}</div>
        ${t.status !== 'closed' ? `<div class="field" style="margin-top:10px"><label for="tk-reply">Reply</label><textarea class="input" id="tk-reply" rows="3"></textarea></div>` : '<p class="muted small">This ticket is closed.</p>'}`,
      actions: t.status === 'closed' ? [{ label: 'Close' }] : [
        { label: 'Close ticket', danger: true, onClick: async () => { await PA.api('POST', `/seller/support/tickets/${encodeURIComponent(code)}/close`, {}); PA.toast('Ticket closed.'); PA.render(); } },
        { label: 'Send reply', primary: true, onClick: async (back) => {
            const body = back.querySelector('#tk-reply').value.trim();
            if (!body) throw new Error('Write a reply first.');
            await PA.api('POST', `/seller/support/tickets/${encodeURIComponent(code)}/reply`, { body });
            PA.toast('Reply sent.');
            PA.render();
          } }
      ]
    });
  }

  /* ---------------------------------------------------------------- settings */
  async function settings(match, ctx) {
    const data = await PA.api('GET', '/seller/settings');
    if (!ctx.isCurrent()) return;
    const acc = data.account || {}, fin = data.financial || {};
    PA.set(`
      ${pageHead('Settings', 'Account security, sessions and financial configuration for your seller account.')}

      <div class="grid g2">
        <form class="card" id="account-form">
          <h2>Account</h2>
          ${PA.kv([['Email', acc.email], ['Phone', acc.phone], ['Status', acc.status]])}
          ${PA.field('ac-name', 'Owner name', acc.name, { required: true })}
          ${PA.field('ac-current', 'Current password', '', { type: 'password', help: 'Only needed to change your password.' })}
          ${PA.field('ac-new', 'New password', '', { type: 'password', help: 'Blank keeps your current password. Minimum 8 characters.' })}
          <div class="switch-row"><div><b class="small">Two-factor authentication</b><div class="desc">${acc.twoFactor ? 'Enabled — codes required at sign-in once an OTP provider is connected.' : 'Adds a second step at sign-in.'}</div></div>
            <input type="checkbox" class="switch" id="ac-2fa" ${acc.twoFactor ? 'checked' : ''}/></div>
          <div class="card-foot row"><span class="spacer"></span><button class="btn btn-primary" type="submit">Save account</button></div>
        </form>

        <form class="card" id="fin-form">
          <h2>Financial settings</h2>
          <div class="banner-note ${fin.bankStatus === 'verified' ? 'ok' : fin.bankStatus === 'verification_pending' ? 'warn' : ''}">Bank status: <b>${esc(String(fin.bankStatus || 'not_submitted').replace(/_/g, ' '))}</b>. Changes need re-verification and admin approval before payouts use them.</div>
          ${PA.field('fn-bank', 'Bank name', fin.bankName || '')}
          ${PA.field('fn-account', 'Account number (last 4 stored)', '', { placeholder: fin.bankLast4 ? '•••• ' + fin.bankLast4 : 'Full account number' })}
          ${PA.field('fn-ifsc', 'IFSC code', fin.bankIfsc || '')}
          <div class="field"><label for="fn-freq">Settlement preference</label>
            <select class="input" id="fn-freq">
              <option value="daily" ${fin.settlementPreference === 'daily' ? 'selected' : ''}>Daily</option>
              <option value="weekly" ${fin.settlementPreference === 'weekly' || !fin.settlementPreference ? 'selected' : ''}>Weekly</option>
              <option value="monthly" ${fin.settlementPreference === 'monthly' ? 'selected' : ''}>Monthly</option>
            </select></div>
          ${PA.field('fn-tax', 'GSTIN / tax ID reference', '', { help: 'Stored with your verification record for tax invoices.' })}
          <div class="card-foot row"><span class="spacer"></span><button class="btn btn-primary" type="submit">Save financial settings</button></div>
        </form>
      </div>

      <div class="grid g2">
        <div class="card flush">
          <div class="card-head"><h2>Active sessions</h2><span class="spacer"></span><span class="muted small">Changing your password ends other sessions automatically</span></div>
          <div class="card-body">${(data.sessions || []).length ? `<div class="list">${data.sessions.map((s) => `
            <div class="item"><span class="emoji">🖥️</span>
              <div class="grow"><b class="mono small">${esc(s.tokenHash)}</b><span>${esc(s.userAgent || 'Unknown device')} · ${esc(s.ip || '')}</span>
                <span class="small muted">Started ${PA.dateTime(s.createdAt)}</span></div>
              <button class="btn btn-sm btn-danger" data-revoke="${esc(s.tokenHash)}">Revoke</button></div>`).join('')}</div>`
          : PA.empty('🔒', 'No sessions listed', 'Sign-ins appear here with device and IP.')}</div>
        </div>

        <div class="card flush">
          <div class="card-head"><h2>Login history</h2></div>
          <div class="card-body">${(data.loginHistory || []).length ? `<div class="list">${data.loginHistory.map((l) => `
            <div class="item"><span class="emoji">🔑</span><div class="grow"><span class="small">${esc(l.detail || 'Signed in')}</span><span class="small muted">${PA.dateTime(l.at)}</span></div></div>`).join('')}</div>`
          : PA.empty('🕓', 'No recent logins recorded', '')}</div>
        </div>
      </div>`);

    $('#account-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const body = { name: $('#ac-name').value.trim() };
        if ($('#ac-new').value) { body.currentPassword = $('#ac-current').value; body.password = $('#ac-new').value; }
        await PA.api('PATCH', '/seller/settings/account', body);
        PA.toast('Account saved.');
        PA.render();
      } catch (err) { PA.toast(err.message, 'err'); }
    });
    PA.on('#ac-2fa', 'change', async (e) => {
      try {
        const res = await PA.api('POST', '/seller/settings/2fa', { enabled: e.target.checked });
        PA.toast(res.message);
      } catch (err) { PA.toast(err.message, 'err'); PA.render(); }
    });
    $('#fin-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await PA.api('PATCH', '/seller/settings/financial', {
          bankName: $('#fn-bank').value.trim(),
          bankAccount: $('#fn-account').value.trim() || undefined,
          bankIfsc: $('#fn-ifsc').value.trim().toUpperCase(),
          settlementPreference: $('#fn-freq').value
        });
        PA.toast('Financial settings saved — bank changes go through verification.');
        PA.render();
      } catch (err) { PA.toast(err.message, 'err'); }
    });
    PA.onAll('[data-revoke]', 'click', async (e) => {
      const hash = e.currentTarget.dataset.revoke.replace('…', '');
      try { await PA.api('DELETE', `/seller/settings/sessions/${encodeURIComponent(hash)}`); PA.toast('Session revoked.'); PA.render(); }
      catch (err) { PA.toast(err.message, 'err'); }
    });
  }

  /* ------------------------------------------------------------------- boot */
  const NAV = GROUPS.flatMap((g) => g.items);

  // Grouped sidebar rendering (core renders a flat nav list, so decorate it).
  const origStart = PA.start.bind(PA);
  PA.start = function (config) {
    origStart(config);
    let attempts = 0;
    const decorate = setInterval(() => {
      attempts += 1;
      const nav = document.querySelector('.nav');
      if (!nav && attempts < 30) return;
      clearInterval(decorate);
      if (!nav) return;
      let html = '';
      for (const group of GROUPS) {
        html += `<div class="nav-group" style="padding:12px 18px 4px;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#7da3cd;font-weight:800">${group.label}</div>`;
        html += group.items.map((n) => `<a href="${n.href}">${PA.icon(n.icon)}<span>${esc(n.label)}</span>${n.count ? `<span class="nav-count hidden" data-count="${n.count}">0</span>` : ''}</a>`).join('');
      }
      nav.innerHTML = html;
      const path = (location.hash.replace(/^#/, '') || '/overview');
      nav.querySelectorAll('a').forEach((a) => {
        const target = (a.getAttribute('href') || '').replace(/^#/, '');
        if (path === target || (target !== '/' && path.startsWith(target + '/'))) a.setAttribute('aria-current', 'page');
      });
    }, 150);
  };

  PA.start({
    mode: 'seller',
    title: 'NearBuy Seller Hub',
    home: '#/overview',
    nav: NAV,
    routes: [
      [/^\/overview$/, overview],
      [/^\/orders$/, orders],
      [/^\/orders\/([^/]+)$/, orderDetail],
      [/^\/returns$/, returns],
      [/^\/products$/, products],
      [/^\/products\/new$/, newProduct],
      [/^\/products\/([^/]+)\/edit$/, editProduct],
      [/^\/inventory$/, inventory],
      [/^\/scanner$/, scanner],
      [/^\/categories$/, categories],
      [/^\/customers$/, customers],
      [/^\/delivery$/, delivery],
      [/^\/runner$/, runnerBoard],
      [/^\/promotions$/, promotions],
      [/^\/promotions\/new$/, newPromotion],
      [/^\/analytics$/, analytics],
      [/^\/revenue$/, revenue],
      [/^\/settlements$/, settlements],
      [/^\/staff$/, staff],
      [/^\/profile$/, profile],
      [/^\/hours$/, hours],
      [/^\/reports$/, reports],
      [/^\/notifications$/, notifications],
      [/^\/support$/, support],
      [/^\/settings$/, settings]
    ]
  });
})();
