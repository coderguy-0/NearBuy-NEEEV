/* NearBuy Admin Portal — platform operations on the shared backend:
 * customers, shops, catalogue, service areas, orders, deliveries, returns and
 * refunds, support tickets, reviews, coupons, banners, broadcasts and audit.
 */
(function () {
  'use strict';
  const PA = window.PA;
  const esc = PA.esc;

  const NAV = [
    { href: '#/overview', label: 'Overview', icon: 'grid' },
    { href: '#/orders', label: 'Orders', icon: 'orders' },
    { href: '#/customers', label: 'Customers', icon: 'users' },
    { href: '#/shops', label: 'Shops', icon: 'shop' },
    { href: '#/catalogue', label: 'Catalogue', icon: 'box' },
    { href: '#/deliveries', label: 'Deliveries', icon: 'bike' },
    { href: '#/runners', label: 'Runners & payouts', icon: 'route' },
    { href: '#/returns', label: 'Returns & refunds', icon: 'rotate' },
    { href: '#/support', label: 'Support & reviews', icon: 'ticket' },
    { href: '#/marketing', label: 'Marketing', icon: 'tag' },
    { href: '#/platform', label: 'Service areas & audit', icon: 'map' }
  ];

  const pinsText = (value) => Array.isArray(value) ? value.join(', ') : String(value || '');

  const table = (headers, rows, empty) => `
    ${rows.length ? `<div class="table-wrap"><table class="data"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>` : empty || ''}`;

  /* ------------------------------------------------------------- overview */
  async function overview(match, ctx) {
    const data = await PA.api('GET', '/overview');
    if (!ctx.isCurrent()) return;
    const c = data.counts;
    PA.set(`
      <div class="space-between"><div><h1>Platform overview</h1>
        <p class="muted small">Live figures from the shared SQLite database — the same records the storefront and seller consoles use.</p></div>
        <div class="row"><a class="btn" href="#/platform">Audit log</a><a class="btn btn-primary" href="#/marketing">Publish an update</a></div></div>

      <div class="grid g4">
        <div class="card stat"><span class="label">Customers</span><span class="value">${c.customers}</span><span class="hint">${c.shops} shops · ${c.products} products</span></div>
        <div class="card stat"><span class="label">Orders</span><span class="value">${c.orders}</span><span class="hint">${PA.money(data.gmv)} lifetime GMV</span></div>
        <div class="card stat"><span class="label">Collected</span><span class="value">${PA.money(data.revenue)}</span><span class="hint">Orders marked paid</span></div>
        <div class="card stat"><span class="label">Open queues</span><span class="value">${c.openTickets + c.pendingReturns + c.pendingRefunds}</span>
          <span class="hint">${c.openTickets} tickets · ${c.pendingReturns} returns · ${c.pendingRefunds} refunds</span></div>
      </div>

      <div class="grid g2">
        <div class="card flush">
          <div class="card-head"><h2>Recent orders</h2><span class="spacer"></span><a class="small" href="#/orders">All orders</a></div>
          ${table(['Order', 'Customer status', 'Total'], data.recentOrders.map((o) => `<tr>
            <td><b class="mono">${esc(o.code)}</b><div class="muted small">${PA.dateTime(o.createdAt)} · ${o.shops.length} shop(s)</div></td>
            <td>${PA.status(o.status, o.statusLabel)}</td>
            <td class="num"><b>${PA.money(o.total)}</b><div class="muted small">${esc(o.paymentMethod)}</div></td>
          </tr>`))}
        </div>
        <div class="card flush">
          <div class="card-head"><h2>Contact enquiries</h2><span class="spacer"></span><a class="small" href="#/support">Support queue</a></div>
          ${table(['From', 'Subject'], (data.recentEnquiries || []).map((e) => `<tr>
            <td><b>${esc(e.name || 'Guest')}</b><div class="muted small">${esc(e.email || e.phone || '')}</div></td>
            <td class="small">${esc(e.subject || e.message || '').slice(0, 120)}</td>
          </tr>`), '<div class="card-body muted small">No enquiries yet.</div>')}
        </div>
      </div>

      <div class="card">
        <h3>What this console can change</h3>
        <div class="tiles" style="margin-top:12px">
          <a class="tile" href="#/shops"><span class="emoji">🏪</span><b>Verify shops</b><span>Radius, open state, service PINs</span></a>
          <a class="tile" href="#/catalogue"><span class="emoji">📦</span><b>Moderate catalogue</b><span>Hide listings, add categories</span></a>
          <a class="tile" href="#/returns"><span class="emoji">💸</span><b>Work refunds</b><span>Review, approve, complete</span></a>
          <a class="tile" href="#/marketing"><span class="emoji">🏷️</span><b>Publish offers</b><span>Coupons, banners, broadcasts</span></a>
        </div>
      </div>
    `);
  }

  /* --------------------------------------------------------------- orders */
  async function orders(match, ctx) {
    const data = await PA.api('GET', '/orders');
    if (!ctx.isCurrent()) return;
    PA.set(`
      <div class="space-between"><div><h1>Orders</h1>
        <p class="muted small">Parent orders with their per-shop fulfilment state. Status histories come from real order events only.</p></div></div>
      <div class="card flush">${table(['Order', 'Shops', 'Status', 'Payment', 'Total'], data.orders.map((o) => `<tr>
        <td><b class="mono">${esc(o.code)}</b><div class="muted small">${PA.dateTime(o.createdAt)} · ${o.itemCount} item(s)</div></td>
        <td class="small">${o.shops.map((s) => `${esc(s.shop?.name || 'Shop')} <span class="badge ${PA.tone(s.status)}">${esc(s.statusLabel)}</span>`).join('<br>')}</td>
        <td>${PA.status(o.status, o.statusLabel)}</td>
        <td class="small">${esc(o.paymentMethod)} · ${PA.status(o.paymentStatus)}</td>
        <td class="num"><b>${PA.money(o.total)}</b><div class="muted small">${o.discount ? '−' + PA.money(o.discount) : ''}</div></td>
      </tr>`))}</div>
    `);
  }

  /* ------------------------------------------------------------ customers */
  async function customers(match, ctx) {
    const data = await PA.api('GET', '/customers');
    if (!ctx.isCurrent()) return;
    PA.set(`
      <div class="space-between"><div><h1>Customers</h1>
        <p class="muted small">Suspending an account ends its sessions immediately. Demo accounts stay active so review sign-ins keep working.</p></div></div>
      <div class="card flush">${table(['Customer', 'Contact', 'Orders', 'Status', ''], data.customers.map((u) => `<tr>
        <td><b>${esc(u.name)}</b><div class="muted small">${esc(u.email)}${u.is_demo ? ' · demo' : ''}</div></td>
        <td class="small">${esc(u.phone || '—')}<div class="muted small">Joined ${PA.date(u.created_at)}</div></td>
        <td class="num">${u.orders}</td>
        <td>${PA.status(u.status)}</td>
        <td class="right"><button class="btn btn-sm ${u.status === 'active' ? 'btn-danger' : 'btn-success'}" data-customer="${esc(u.id)}" data-status="${u.status === 'active' ? 'suspended' : 'active'}">
          ${u.status === 'active' ? 'Suspend' : 'Reactivate'}</button></td>
      </tr>`))}</div>
    `);
    PA.onAll('[data-customer]', 'click', async (e) => {
      const btn = e.currentTarget;
      if (btn.dataset.status === 'suspended' && !(await PA.confirm('Suspend account?', 'The customer will be signed out and cannot place orders until reactivated.', 'Suspend'))) return;
      btn.disabled = true;
      try {
        const res = await PA.api('PATCH', `/customers/${encodeURIComponent(btn.dataset.customer)}`, { status: btn.dataset.status });
        PA.toast(res.message || 'Customer updated.');
        PA.render();
      } catch (err) { btn.disabled = false; PA.toast(err.message, 'err'); }
    });
  }

  /* ---------------------------------------------------------------- shops */
  async function shops(match, ctx) {
    const data = await PA.api('GET', '/shops');
    if (!ctx.isCurrent()) return;
    PA.set(`
      <div class="space-between"><div><h1>Shops</h1>
        <p class="muted small">Verification, radius and service PINs decide which customers can order home delivery.</p></div></div>
      <div class="stack">
        ${data.shops.map((s) => `<article class="card">
          <div class="space-between">
            <div><div class="row tight"><b>${esc(s.emoji || '🏪')} ${esc(s.name)}</b>
              ${s.verified ? PA.badge('Verified', 'green') : PA.badge('Unverified', 'amber')}
              ${s.isOpen ? PA.status('online', 'Open') : PA.status('offline', 'Closed')}</div>
              <div class="muted small">${esc(s.category)} · ${esc(s.locality)} ${esc(s.pincode)} · ${esc(s.ownerEmail || 'no owner linked')}</div></div>
            <div class="right muted small">${s.productCount || 0} products · ${s.orders || 0} orders<div>★ ${s.rating}</div></div>
          </div>
          <div class="grid g3" style="margin-top:12px">
            ${PA.field('radius-' + s.slug, 'Delivery radius (km)', s.radiusKm, { type: 'number', min: 0.5, max: 50, step: 0.5 })}
            <div class="field"><label for="pins-${esc(s.slug)}">Service PIN codes</label>
              <input class="input" id="pins-${esc(s.slug)}" value="${esc(pinsText(s.servicePincodes))}" placeholder="110016, 110024" />
              <span class="help">Comma separated. Empty means every serviceable area inside the radius.</span></div>
            <div class="field"><label>Actions</label>
              <div class="row">
                <button class="btn btn-sm" data-shop="${esc(s.slug)}" data-verified="${s.verified ? '0' : '1'}">${s.verified ? 'Remove verification' : 'Verify shop'}</button>
                <button class="btn btn-sm" data-shop="${esc(s.slug)}" data-open="${s.isOpen ? '0' : '1'}">${s.isOpen ? 'Force close' : 'Force open'}</button>
                <button class="btn btn-sm btn-primary" data-save-shop="${esc(s.slug)}">Save</button>
              </div>
            </div>
          </div>
        </article>`).join('')}
      </div>
    `);
    PA.onAll('[data-shop]', 'click', async (e) => {
      const btn = e.currentTarget;
      const slug = btn.dataset.shop;
      const body = {};
      if (btn.dataset.verified !== undefined) body.verified = btn.dataset.verified === '1';
      if (btn.dataset.open !== undefined) body.isOpen = btn.dataset.open === '1';
      btn.disabled = true;
      try {
        const res = await PA.api('PATCH', `/shops/${encodeURIComponent(slug)}`, body);
        PA.toast(res.message || 'Shop updated.');
        PA.render();
      } catch (err) { btn.disabled = false; PA.toast(err.message, 'err'); }
    });
    PA.onAll('[data-save-shop]', 'click', async (e) => {
      const btn = e.currentTarget;
      const slug = btn.dataset.saveShop;
      const radius = Number(document.getElementById('radius-' + slug).value);
      const pins = document.getElementById('pins-' + slug).value;
      btn.disabled = true;
      try {
        const res = await PA.api('PATCH', `/shops/${encodeURIComponent(slug)}`, { radiusKm: radius, servicePincodes: pins });
        PA.toast(res.message || 'Shop updated.');
        PA.render();
      } catch (err) { btn.disabled = false; PA.toast(err.message, 'err'); }
    });
  }

  /* ------------------------------------------------------------ catalogue */
  async function catalogue(match, ctx) {
    const [products, categories] = await Promise.all([PA.api('GET', '/products'), PA.api('GET', '/categories')]);
    if (!ctx.isCurrent()) return;
    const parents = categories.categories.filter((c) => !c.parentSlug);
    PA.set(`
      <div class="space-between"><div><h1>Catalogue</h1>
        <p class="muted small">Hiding a listing removes it from the storefront without deleting its sales history.</p></div></div>

      <div class="card flush">
        <div class="card-head"><h2>Listings</h2><span class="spacer"></span><span class="muted small">${products.products.length} products</span></div>
        ${table(['Product', 'Shop', 'Price', 'Stock', 'Status', ''], products.products.map((p) => `<tr>
          <td><b>${esc(p.name)}</b><div class="muted small">${esc(p.brand || '')} · ${esc(p.category)}</div></td>
          <td class="small">${esc(p.shop.name)}</td>
          <td class="num">${PA.money(p.price)}<div class="muted small">${p.mrp ? 'MRP ' + PA.money(p.mrp) : ''}</div></td>
          <td class="num">${p.available}<div class="muted small">${p.reserved} reserved</div></td>
          <td>${p.active ? PA.status('published', 'Live') : PA.status('hidden', 'Hidden')}</td>
          <td class="right"><button class="btn btn-sm ${p.active ? 'btn-danger' : 'btn-success'}" data-product="${esc(p.id)}" data-active="${p.active ? '0' : '1'}">
            ${p.active ? 'Hide' : 'Publish'}</button></td>
        </tr>`))}
      </div>

      <div class="grid g2">
        <div class="card flush">
          <div class="card-head"><h2>Categories</h2></div>
          ${table(['Category', 'Slug', 'Shops', 'Products'], categories.categories.map((c) => `<tr>
            <td><b>${esc(c.icon || '🏷️')} ${esc(c.name)}</b>${c.parentSlug ? `<div class="muted small">under ${esc(c.parentSlug)}</div>` : ''}</td>
            <td class="mono small">${esc(c.slug)}</td>
            <td class="num">${c.shops}</td>
            <td class="num">${c.products}</td>
          </tr>`))}
        </div>
        <form class="card stack" id="new-category">
          <h2>Add or update a category</h2>
          <p class="muted small">Subcategories are configured by choosing a parent. Reusing an existing slug updates that category.</p>
          ${PA.field('cat-name', 'Name', '', { required: true, placeholder: 'Pet Supplies' })}
          ${PA.field('cat-slug', 'Slug', '', { placeholder: 'pet-supplies', help: 'Leave blank to derive it from the name.' })}
          <div class="grid g2">
            ${PA.field('cat-icon', 'Icon', '🏷️')}
            <div class="field"><label for="cat-parent">Parent category</label>
              <select class="select" id="cat-parent"><option value="">— none (top level) —</option>
                ${parents.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('')}</select></div>
          </div>
          <div class="form-error hidden" id="cat-error"></div>
          <div class="row"><button class="btn btn-primary" type="submit">Save category</button></div>
        </form>
      </div>
    `);
    PA.onAll('[data-product]', 'click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const res = await PA.api('PATCH', `/products/${encodeURIComponent(btn.dataset.product)}`, { active: btn.dataset.active === '1' });
        PA.toast(res.message || 'Listing updated.');
        PA.render();
      } catch (err) { btn.disabled = false; PA.toast(err.message, 'err'); }
    });
    PA.on('#new-category', 'submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('cat-error');
      err.classList.add('hidden');
      try {
        const res = await PA.api('POST', '/categories', {
          name: document.getElementById('cat-name').value.trim(),
          slug: document.getElementById('cat-slug').value.trim() || undefined,
          icon: document.getElementById('cat-icon').value.trim(),
          parentSlug: document.getElementById('cat-parent').value || undefined
        });
        PA.toast(res.message || 'Category saved.');
        PA.render();
      } catch (e2) { err.textContent = e2.message; err.classList.remove('hidden'); }
    });
  }

  /* ----------------------------------------------------------- deliveries */
  async function deliveries(match, ctx) {
    const data = await PA.api('GET', '/deliveries');
    if (!ctx.isCurrent()) return;
    PA.set(`
      <div class="space-between"><div><h1>Deliveries</h1>
        <p class="muted small">Every runner offer and assignment. Offers expire automatically; only an accepted assignment moves an order.</p></div></div>
      <div class="card flush">${table(['Order', 'Shop', 'Runner', 'Status', 'Payout', 'Timing'], data.deliveries.map((d) => `<tr>
        <td class="mono small">${esc(d.orderCode)}</td>
        <td class="small">${esc(d.shop)}</td>
        <td class="small">${esc(d.runner || '—')}</td>
        <td>${PA.status(d.status)}<div class="muted small">${esc(d.orderStatus || '')}</div></td>
        <td class="num">${PA.money(d.payout)}<div class="muted small">${d.distanceKm ?? '—'} km</div></td>
        <td class="small">Offered ${PA.clock(d.createdAt)}<div class="muted small">${d.deliveredAt ? 'Delivered ' + PA.clock(d.deliveredAt) : d.expiresAt ? 'Expires ' + PA.clock(d.expiresAt) : ''}</div></td>
      </tr>`), '<div class="card-body muted small">No delivery offers yet.</div>')}</div>
    `);
  }

  /* --------------------------------------------------------------- returns */
  async function returns(match, ctx) {
    const data = await PA.api('GET', '/returns');
    if (!ctx.isCurrent()) return;
    PA.set(`
      <div class="space-between"><div><h1>Returns & refunds</h1>
        <p class="muted small">A refund only completes when the money is confirmed returned. Nothing here fakes a captured payment.</p></div></div>
      <div class="card flush">
        <div class="card-head"><h2>Return requests</h2></div>
        ${table(['Return', 'Order', 'Item', 'Status', 'Amount'], data.returns.map((r) => `<tr>
          <td class="mono small">${esc(r.code)}<div class="muted small">${PA.date(r.created_at)}</div></td>
          <td class="small">${esc(r.order_code)}<div class="muted small">${esc(r.shop_name)}</div></td>
          <td class="small">${esc(r.item_name)}<div class="muted small">${esc(r.reason)}</div></td>
          <td>${PA.status(r.status)}</td>
          <td class="num">${PA.money(r.refund_amount_paise)}</td>
        </tr>`), '<div class="card-body muted small">No return requests.</div>')}
      </div>
      <div class="card flush">
        <div class="card-head"><h2>Refund ledger</h2></div>
        ${table(['Refund', 'Order', 'Amount', 'Status', ''], data.refunds.map((r) => `<tr>
          <td class="mono small">${esc(r.id.slice(0, 8))}<div class="muted small">${PA.date(r.created_at)}</div></td>
          <td class="small">${esc((data.returns.find((x) => x.order_id === r.order_id) || {}).order_code || r.order_id.slice(0, 8))}</td>
          <td class="num">${PA.money(r.amount_paise)}</td>
          <td>${PA.status(r.status)}${r.reference ? `<div class="muted small">${esc(r.reference)}</div>` : ''}</td>
          <td class="right">
            ${r.status !== 'completed' ? `<button class="btn btn-sm" data-refund="${esc(r.id)}" data-status="processing">Processing</button>
            <button class="btn btn-sm btn-success" data-refund="${esc(r.id)}" data-status="completed">Completed</button>` : '<span class="muted small">Settled</span>'}
            ${!['completed', 'rejected'].includes(r.status) ? `<button class="btn btn-sm btn-danger" data-refund="${esc(r.id)}" data-status="rejected">Reject</button>` : ''}
          </td>
        </tr>`), '<div class="card-body muted small">No refunds recorded.</div>')}
      </div>
    `);
    PA.onAll('[data-refund]', 'click', async (e) => {
      const btn = e.currentTarget;
      let reference;
      if (btn.dataset.status === 'completed') {
        reference = await ask('Refund reference', 'Payment-provider reference or UTR confirming the money went back to the customer.');
        if (!reference) return;
      }
      btn.disabled = true;
      try {
        const res = await PA.api('POST', `/refunds/${encodeURIComponent(btn.dataset.refund)}/status`, { status: btn.dataset.status, reference });
        PA.toast(res.message || 'Refund updated.');
        PA.render();
      } catch (err) { btn.disabled = false; PA.toast(err.message, 'err'); }
    });
  }

  /* --------------------------------------------------------------- support */
  async function support(match, ctx) {
    const [tickets, reviews, apps] = await Promise.all([PA.api('GET', '/tickets'), PA.api('GET', '/reviews'), PA.api('GET', '/enquiries')]);
    const enquiries = apps.enquiries || [];
    if (!ctx.isCurrent()) return;
    PA.set(`
      <div class="space-between"><div><h1>Support & reviews</h1>
        <p class="muted small">Replies notify the customer in-app. Review moderation keeps unverified abuse off the storefront.</p></div></div>
      <div class="card flush">
        <div class="card-head"><h2>Tickets</h2><span class="spacer"></span><span class="muted small">${tickets.tickets.length}</span></div>
        ${table(['Ticket', 'Customer', 'Subject', 'Status', ''], tickets.tickets.map((t) => `<tr>
          <td class="mono small">${esc(t.code)}<div class="muted small">${PA.dateTime(t.created_at)}</div></td>
          <td class="small">${esc(t.customer_name)}<div class="muted small">${esc(t.customer_email)}</div></td>
          <td class="small"><b>${esc(t.subject)}</b><div class="muted small">${esc(t.category)} · ${esc((t.description || '').slice(0, 90))}</div></td>
          <td>${PA.status(t.status)}</td>
          <td class="right"><button class="btn btn-sm" data-ticket="${esc(t.code)}" data-mode="reply">Reply</button>
            <button class="btn btn-sm" data-ticket="${esc(t.code)}" data-mode="status">Change status</button></td>
        </tr>`), '<div class="card-body muted small">No support tickets.</div>')}
      </div>
      <div class="card flush">
        <div class="card-head"><h2>Reviews</h2></div>
        ${table(['Review', 'Customer', 'Shop / product', 'Status', ''], reviews.reviews.map((r) => `<tr>
          <td class="small"><b>${esc(r.title || 'Review')}</b><div class="muted small">${esc((r.body || '').slice(0, 100))}</div></td>
          <td class="small">${esc(r.customer_name)}<div class="muted small">${r.verified_purchase ? 'Verified purchase' : 'Unverified'}</div></td>
          <td class="small">${esc(r.shop_name || '—')}<div class="muted small">${esc(r.product_name || '')}</div></td>
          <td>${PA.status(r.status)}</td>
          <td class="right">
            ${r.status !== 'published' ? `<button class="btn btn-sm btn-success" data-review="${esc(r.id)}" data-status="published">Publish</button>` : ''}
            ${r.status !== 'hidden' ? `<button class="btn btn-sm btn-danger" data-review="${esc(r.id)}" data-status="hidden">Hide</button>` : ''}
          </td>
        </tr>`), '<div class="card-body muted small">No reviews yet.</div>')}
      </div>
      <div class="card flush">
        <div class="card-head"><h2>Applications &amp; contact enquiries</h2><span class="spacer"></span><span class="muted small">' + enquiries.length + '</span></div>
        ${table(['Reference', 'From', 'Topic', 'Status', ''], enquiries.map((en) => '<tr>' +
          '<td class="mono small">' + esc(en.code) + '<div class="muted small">' + PA.dateTime(en.created_at) + '</div></td>' +
          '<td class="small"><b>' + esc(en.name) + '</b><div class="muted small">' + esc(en.contact) + '</div></td>' +
          '<td class="small"><b>' + esc(en.topic) + '</b><div class="muted small">' + esc((en.message || '').split('\n').join(' · ').slice(0, 120)) + '</div></td>' +
          '<td>' + PA.status(en.status) + '</td>' +
          '<td class="right"><button class="btn btn-sm" data-enquiry="' + esc(en.code) + '">Set status</button></td>' +
          '</tr>'), '<div class="card-body muted small">No applications or enquiries yet.</div>')}
      </div>
    `);
    PA.onAll('[data-ticket]', 'click', (e) => {
      const code = e.currentTarget.dataset.ticket;
      if (e.currentTarget.dataset.mode === 'reply') {
        PA.modal({
          title: `Reply to ${code}`,
          body: `<div class="field"><label for="reply-body">Message to the customer</label>
            <textarea class="textarea" id="reply-body" placeholder="Explain what you found and what happens next."></textarea></div>`,
          actions: [{ label: 'Cancel' }, {
            label: 'Send reply', primary: true, onClick: async (back) => {
              const body = back.querySelector('#reply-body').value.trim();
              if (body.length < 2) { PA.toast('Write a reply first.', 'err'); return true; }
              const res = await PA.api('POST', `/tickets/${encodeURIComponent(code)}/reply`, { body });
              PA.toast(res.message || 'Reply sent.');
              PA.render();
            }
          }]
        });
      } else {
        PA.modal({
          title: `Status for ${code}`,
          body: `<div class="field"><label for="ticket-status">New status</label>
            <select class="select" id="ticket-status">
              ${['open', 'assigned', 'in_progress', 'awaiting_customer', 'resolved', 'closed'].map((s) => `<option value="${s}">${s.replace(/_/g, ' ')}</option>`).join('')}
            </select></div>`,
          actions: [{ label: 'Cancel' }, {
            label: 'Save', primary: true, onClick: async (back) => {
              const res = await PA.api('POST', `/tickets/${encodeURIComponent(code)}/status`, { status: back.querySelector('#ticket-status').value });
              PA.toast(res.message || 'Status updated.');
              PA.render();
            }
          }]
        });
      }
    });
    PA.onAll('[data-enquiry]', 'click', (e) => {
      const code = e.currentTarget.dataset.enquiry;
      const row = enquiries.find((en) => en.code === code) || { status: 'open' };
      PA.modal({
        title: 'Enquiry ' + code,
        body: '<div class="field"><label for="enquiry-status">Review status</label>' +
          '<select class="select" id="enquiry-status">' +
          ['open', 'in_review', 'closed'].map((st) => '<option value="' + st + '"' + (st === row.status ? ' selected' : '') + '>' + st.replace('_', ' ') + '</option>').join('') +
          '</select></div>' +
          '<p class="muted small">Seller and delivery-partner applications arrive here. Approving a shop still happens in Shops, where the radius and service PINs are set.</p>',
        actions: [{ label: 'Cancel' }, {
          label: 'Save', primary: true, onClick: async (back) => {
            const res = await PA.api('PATCH', '/enquiries/' + encodeURIComponent(code), { status: back.querySelector('#enquiry-status').value });
            PA.toast(res.message || 'Enquiry updated.');
            PA.render();
          }
        }]
      });
    });
    PA.onAll('[data-review]', 'click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const res = await PA.api('POST', `/reviews/${encodeURIComponent(btn.dataset.review)}/status`, { status: btn.dataset.status });
        PA.toast(res.message || 'Review updated.');
        PA.render();
      } catch (err) { btn.disabled = false; PA.toast(err.message, 'err'); }
    });
  }

  /* ------------------------------------------------------------- marketing */
  async function marketing(match, ctx) {
    const [coupons, banners] = await Promise.all([PA.api('GET', '/coupons'), PA.api('GET', '/banners')]);
    const shops = await PA.api('GET', '/shops');
    if (!ctx.isCurrent()) return;
    const now = Date.now();
    PA.set(`
      <div class="space-between"><div><h1>Marketing</h1>
        <p class="muted small">Active, in-date coupons and banners are what the storefront shows. Expired offers stay in the ledger but never render as live.</p></div></div>

      <div class="grid g2">
        <div class="card flush">
          <div class="card-head"><h2>Coupons</h2></div>
          ${table(['Code', 'Offer', 'Window', 'State'], coupons.coupons.map((c) => {
            const live = c.active && new Date(c.ends_at).getTime() > now && new Date(c.starts_at).getTime() <= now;
            return `<tr><td class="mono"><b>${esc(c.code)}</b>${c.shop_id ? '<div class="muted small">shop specific</div>' : ''}</td>
              <td class="small">${esc(c.title)}<div class="muted small">${c.type === 'percent' ? c.value + '% off' : c.type === 'fixed' ? PA.money(c.value) + ' off' : 'Free delivery'} · min ${PA.money(c.min_order_paise)}</div></td>
              <td class="small">ends ${PA.date(c.ends_at)}<div class="muted small">${c.used_count}/${c.usage_limit || '∞'} used</div></td>
              <td>${live ? PA.badge('Active', 'green') : PA.badge(!c.active ? 'Disabled' : 'Expired', 'grey')}</td></tr>`;
          }))}
        </div>
        <form class="card stack" id="new-coupon">
          <h2>Create a coupon</h2>
          ${PA.field('c-code', 'Code', '', { required: true, placeholder: 'LOCAL15' })}
          ${PA.field('c-title', 'Customer-facing title', '', { required: true, placeholder: '15% off your next basket' })}
          <div class="grid g2">
            <div class="field"><label for="c-type">Type</label>
              <select class="select" id="c-type"><option value="percent">Percent off</option><option value="fixed">Fixed amount off</option><option value="free_delivery">Free delivery</option></select></div>
            ${PA.field('c-value', 'Value', 10, { type: 'number', min: 0 })}
          </div>
          <div class="grid g2">
            ${PA.field('c-min', 'Minimum order (₹)', 0, { type: 'number', min: 0 })}
            ${PA.field('c-days', 'Runs for (days)', 30, { type: 'number', min: 1, max: 365 })}
          </div>
          <div class="field"><label for="c-shop">Limit to a shop (optional)</label>
            <select class="select" id="c-shop"><option value="">All shops</option>
              ${shops.shops.map((s) => `<option value="${esc(s.slug)}">${esc(s.name)}</option>`).join('')}</select></div>
          <div class="form-error hidden" id="c-error"></div>
          <div class="row"><button class="btn btn-primary" type="submit">Create coupon</button></div>
        </form>
      </div>

      <div class="grid g2">
        <div class="card flush">
          <div class="card-head"><h2>Homepage banners</h2></div>
          ${table(['Banner', 'CTA', 'State'], banners.banners.map((b) => `<tr>
            <td class="small"><b>${esc(b.title)}</b><div class="muted small">${esc((b.subtitle || '').slice(0, 80))}</div></td>
            <td class="small">${esc(b.cta_label || '')}<div class="muted small mono">${esc(b.cta_link || '')}</div></td>
            <td>${b.active ? PA.badge('Live', 'green') : PA.badge('Hidden', 'grey')}</td>
          </tr>`))}
        </div>
        <div class="card stack">
          <h2>Broadcast a notification</h2>
          <p class="muted small">Stored as real in-app notifications. No SMS or email provider is configured, so nothing is sent externally and nothing here claims otherwise.</p>
          ${PA.field('n-title', 'Title', '', { required: true, placeholder: 'Fresh Friday is live' })}
          <div class="field"><label for="n-body">Message</label><textarea class="textarea" id="n-body" placeholder="Tell customers what changed and where to look."></textarea></div>
          <div class="field"><label for="n-audience">Audience</label>
            <select class="select" id="n-audience"><option value="customers">All customers</option><option value="sellers">All sellers</option><option value="shop_customers">Customers of one shop</option></select></div>
          <div class="field hidden" id="n-shop-wrap"><label for="n-shop">Shop</label>
            <select class="select" id="n-shop">${shops.shops.map((s) => `<option value="${esc(s.slug)}">${esc(s.name)}</option>`).join('')}</select></div>
          <div class="row"><button class="btn btn-primary" id="send-broadcast">Send notification</button></div>
        </div>
      </div>
    `);
    PA.on('#c-type', 'change', (e) => {
      const free = e.target.value === 'free_delivery';
      document.getElementById('c-value').disabled = free;
      if (free) document.getElementById('c-value').value = 0;
    });
    PA.on('#n-audience', 'change', (e) => {
      document.getElementById('n-shop-wrap').classList.toggle('hidden', e.target.value !== 'shop_customers');
    });
    PA.on('#new-coupon', 'submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('c-error');
      err.classList.add('hidden');
      try {
        const res = await PA.api('POST', '/coupons', {
          code: document.getElementById('c-code').value.trim(),
          title: document.getElementById('c-title').value.trim(),
          type: document.getElementById('c-type').value,
          value: Number(document.getElementById('c-value').value),
          minOrderPaise: Math.round(Number(document.getElementById('c-min').value) * 100),
          days: Number(document.getElementById('c-days').value),
          shopSlug: document.getElementById('c-shop').value || undefined
        });
        PA.toast(res.message || 'Coupon created.');
        PA.render();
      } catch (e2) { err.textContent = e2.message; err.classList.remove('hidden'); }
    });
    PA.on('#send-broadcast', 'click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const res = await PA.api('POST', '/notifications', {
          title: document.getElementById('n-title').value.trim(),
          body: document.getElementById('n-body').value.trim(),
          audience: document.getElementById('n-audience').value,
          shopSlug: document.getElementById('n-audience').value === 'shop_customers' ? document.getElementById('n-shop').value : undefined
        });
        PA.toast(res.message || 'Notification stored.');
        document.getElementById('n-title').value = '';
        document.getElementById('n-body').value = '';
      } catch (err) { PA.toast(err.message, 'err'); }
      btn.disabled = false;
    });
  }

  /* -------------------------------------------------------------- platform */
  async function platform(match, ctx) {
    const [areas, audit] = await Promise.all([PA.api('GET', '/service-areas'), PA.api('GET', '/audit')]);
    if (!ctx.isCurrent()) return;
    PA.set(`
      <div class="space-between"><div><h1>Service areas & audit</h1>
        <p class="muted small">Service areas decide which localities can check out. The audit log records every privileged action.</p></div></div>
      <div class="grid g2">
        <div class="card flush">
          <div class="card-head"><h2>Serviceable localities</h2><span class="spacer"></span><span class="muted small">${areas.areas.length}</span></div>
          ${table(['PIN', 'Locality', 'Coordinates', 'State'], areas.areas.map((a) => `<tr>
            <td class="mono">${esc(a.pincode)}</td>
            <td><b>${esc(a.locality)}</b><div class="muted small">${esc(a.city)}</div></td>
            <td class="small">${a.lat.toFixed(4)}, ${a.lng.toFixed(4)}</td>
            <td>${a.active ? PA.badge('Active', 'green') : PA.badge('Paused', 'grey')}</td>
          </tr>`))}
        </div>
        <form class="card stack" id="new-area">
          <h2>Add a serviceable area</h2>
          <p class="muted small">An existing PIN + locality pair is updated instead of duplicated.</p>
          <div class="grid g2">
            ${PA.field('a-pin', 'PIN code', '', { required: true, placeholder: '110016' })}
            ${PA.field('a-locality', 'Locality', '', { required: true, placeholder: 'Hauz Khas' })}
            ${PA.field('a-city', 'City', 'New Delhi')}
            ${PA.field('a-lat', 'Latitude', 28.5494, { type: 'number', step: 0.0001, min: -90, max: 90 })}
            ${PA.field('a-lng', 'Longitude', 77.2001, { type: 'number', step: 0.0001, min: -180, max: 180 })}
          </div>
          <div class="form-error hidden" id="a-error"></div>
          <div class="row"><button class="btn btn-primary" type="submit">Add area</button></div>
        </form>
      </div>
      <div class="card flush">
        <div class="card-head"><h2>Audit log</h2><span class="spacer"></span><span class="muted small">latest ${audit.logs.length}</span></div>
        ${table(['When', 'Actor', 'Action', 'Entity', 'Detail'], audit.logs.slice(0, 120).map((l) => `<tr>
          <td class="small nowrap">${PA.dateTime(l.created_at)}</td>
          <td class="small">${esc(l.actor_type)}${l.actor_id ? `<div class="muted small mono">${esc(String(l.actor_id).slice(0, 8))}</div>` : ''}</td>
          <td class="mono small">${esc(l.action)}</td>
          <td class="small">${esc(l.entity || '')}</td>
          <td class="small muted">${esc(l.detail || '')}</td>
        </tr>`))}
      </div>
    `);
    PA.on('#new-area', 'submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('a-error');
      err.classList.add('hidden');
      try {
        const res = await PA.api('POST', '/service-areas', {
          pincode: document.getElementById('a-pin').value.trim(),
          locality: document.getElementById('a-locality').value.trim(),
          city: document.getElementById('a-city').value.trim(),
          lat: Number(document.getElementById('a-lat').value),
          lng: Number(document.getElementById('a-lng').value)
        });
        PA.toast(res.message || 'Service area saved.');
        PA.render();
      } catch (e2) { err.textContent = e2.message; err.classList.remove('hidden'); }
    });
  }

  /* ------------------------------------------------- runners & payouts */
  async function runners(match, ctx) {
    const [runnerData, ticketData, payoutData] = await Promise.all([
      PA.api('GET', '/runners'),
      PA.api('GET', '/runner-tickets'),
      PA.api('GET', '/payouts')
    ]);
    if (!ctx.isCurrent()) return;
    const statusTone = (s) => s === 'completed' || s === 'resolved' || s === 'closed' ? 'green' : s === 'failed' || s === 'suspended' ? 'red' : s === 'open' || s === 'pending' ? 'amber' : 'grey';
    PA.set(`
      <div class="space-between"><div><h1>Runners & payouts</h1>
        <p class="muted small">Delivery partner accounts, safety reports and payout processing on the shared platform.</p></div></div>

      <div class="card flush">
        <div class="card-head"><h2>Delivery partners</h2></div>
        ${table(['Partner', 'Status', 'Deliveries', 'Earned', 'Rating', 'Actions'], runnerData.runners.map((r) => `<tr>
          <td><b>${esc(r.name)}</b><div class="muted small">${esc(r.email)} · ${esc(r.vehicle || '—')} · joined ${PA.dateTime(r.joinedAt)}</div></td>
          <td>${PA.badge(r.accountStatus === 'suspended' ? 'suspended' : r.status, statusTone(r.accountStatus === 'suspended' ? 'suspended' : r.status))}</td>
          <td class="num">${r.deliveries}</td>
          <td class="num">${PA.money(r.earned)}</td>
          <td class="num">${r.rating != null ? r.rating.toFixed(1) : '—'}</td>
          <td>${r.accountStatus === 'suspended'
            ? `<button class="btn btn-sm btn-success" data-runner="${esc(r.userId)}" data-act="reactivate">Reactivate</button>`
            : `<button class="btn btn-sm btn-danger" data-runner="${esc(r.userId)}" data-act="suspend">Suspend</button>`}</td>
        </tr>`), '<div class="card-body muted small">No delivery partners registered yet.</div>')}
      </div>

      <div class="card flush">
        <div class="card-head"><h2>Runner safety & support reports</h2></div>
        ${table(['Ticket', 'Runner', 'Category', 'Status', 'Updated', 'Actions'], ticketData.tickets.map((t) => `<tr>
          <td><b>${esc(t.subject)}</b><div class="muted small mono">${esc(t.code)}</div></td>
          <td class="small">${esc(t.runner)}</td>
          <td class="small">${esc(t.category)}</td>
          <td>${PA.badge(t.status.replace('_', ' '), statusTone(t.status))}</td>
          <td class="small">${PA.dateTime(t.updatedAt)}</td>
          <td><button class="btn btn-sm" data-rticket="${esc(t.code)}">Open</button></td>
        </tr>`), '<div class="card-body muted small">No runner reports.</div>')}
      </div>

      <div class="card flush">
        <div class="card-head"><h2>Runner payouts</h2><span class="muted small" style="margin-left:10px">Never mark a payout completed without the real bank/UPI reference.</span></div>
        ${table(['Runner', 'Period', 'Net', 'Status', 'Reference', 'Requested', 'Actions'], payoutData.payouts.map((p) => `<tr>
          <td><b>${esc(p.runner)}</b></td>
          <td class="small">${esc(p.period)}</td>
          <td class="num"><b>${PA.money(p.net)}</b></td>
          <td>${PA.badge(p.status.replace('_', ' '), statusTone(p.status))}</td>
          <td class="small mono">${p.reference ? esc(p.reference) : '—'}</td>
          <td class="small">${PA.dateTime(p.createdAt)}</td>
          <td>${p.status === 'completed' ? '—' : `
            <div class="row tight">
              <button class="btn btn-sm" data-payout="${esc(p.id)}" data-status="processing">Processing</button>
              <button class="btn btn-sm btn-success" data-payout="${esc(p.id)}" data-status="completed">Complete</button>
              <button class="btn btn-sm btn-danger" data-payout="${esc(p.id)}" data-status="failed">Fail</button>
            </div>`}</td>
        </tr>`), '<div class="card-body muted small">No payout requests yet.</div>')}
      </div>
    `);

    PA.onAll('[data-runner]', 'click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const res = await PA.api('PATCH', `/runners/${encodeURIComponent(btn.dataset.runner)}`, { active: btn.dataset.act === 'reactivate' });
        PA.toast(res.message || 'Updated.');
        PA.render();
      } catch (err) { btn.disabled = false; PA.toast(err.message, 'err'); }
    });

    PA.onAll('[data-rticket]', 'click', async (e) => {
      const code = e.currentTarget.dataset.rticket;
      try {
        const data = await PA.api('GET', `/runner-tickets/${encodeURIComponent(code)}`);
        const t = data.ticket;
        PA.modal({
          title: `${t.code} · ${t.subject}`,
          wide: true,
          body: `<div class="list">${t.messages.map((m) => `
            <div class="item"><span class="emoji">${m.authorRole === 'runner' ? '🛵' : '🎧'}</span>
              <div class="grow"><b>${esc(m.authorName)} (${esc(m.authorRole)})</b>
                <div class="small">${esc(m.body)}</div>
                <div class="muted small">${PA.dateTime(m.at)}</div></div></div>`).join('')}</div>
            <div class="field"><label for="at-reply">Reply to runner</label><textarea class="input" id="at-reply" rows="3"></textarea></div>
            <div class="field"><label for="at-status">Ticket status</label>
              <select class="input" id="at-status">
                ${['open', 'assigned', 'in_progress', 'awaiting_runner', 'resolved', 'closed'].map((s) => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
              </select></div>`,
          actions: [
            { label: 'Close' },
            {
              label: 'Save', primary: true, onClick: async (back) => {
                try {
                  const body = back.querySelector('#at-reply').value.trim();
                  const status = back.querySelector('#at-status').value;
                  if (body) await PA.api('POST', `/runner-tickets/${encodeURIComponent(code)}/reply`, { body });
                  if (status !== t.status) await PA.api('POST', `/runner-tickets/${encodeURIComponent(code)}/status`, { status, agent: 'Platform support' });
                  PA.toast('Ticket updated.');
                  PA.render();
                } catch (err) { PA.toast(err.message, 'err'); return true; }
              }
            }
          ]
        });
      } catch (err) { PA.toast(err.message, 'err'); }
    });

    PA.onAll('[data-payout]', 'click', async (e) => {
      const btn = e.currentTarget;
      const status = btn.dataset.status;
      let reference = '';
      if (status === 'completed') {
        reference = await ask('Bank / UPI reference', 'Enter the real payout reference from the bank transfer or UPI run. A payout cannot be completed without it.');
        if (!reference) return;
      }
      btn.disabled = true;
      try {
        const res = await PA.api('POST', `/payouts/${encodeURIComponent(btn.dataset.payout)}/status`, { status, reference });
        PA.toast(res.message || 'Payout updated.');
        PA.render();
      } catch (err) { btn.disabled = false; PA.toast(err.message, 'err'); }
    });
  }

  function ask(title, help) {
    return new Promise((resolve) => {
      PA.modal({
        title,
        body: `<p class="muted small">${esc(help)}</p>
          <div class="field"><label for="ask-input">${esc(title)}</label><input class="input" id="ask-input" autocomplete="off" /></div>`,
        actions: [
          { label: 'Cancel', onClick: () => resolve('') },
          { label: 'Save', primary: true, onClick: (back) => resolve(back.querySelector('#ask-input').value.trim()) }
        ],
        onMount: (back) => back.querySelector('#ask-input').focus()
      });
    });
  }

  PA.start({
    mode: 'admin',
    title: 'Admin Portal',
    home: '#/overview',
    nav: NAV,
    routes: [
      [/^\/overview$/, overview],
      [/^\/orders$/, orders],
      [/^\/customers$/, customers],
      [/^\/shops$/, shops],
      [/^\/catalogue$/, catalogue],
      [/^\/deliveries$/, deliveries],
      [/^\/runners$/, runners],
      [/^\/returns$/, returns],
      [/^\/support$/, support],
      [/^\/marketing$/, marketing],
      [/^\/platform$/, platform]
    ]
  });
})();
