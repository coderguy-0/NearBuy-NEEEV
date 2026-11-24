/* Orders, tracking, cancellation, returns and verified reviews. */
(function () {
  'use strict';
  const NB = window.NB;

  const CANCEL_REASONS = ['Ordered by mistake', 'Found a better price nearby', 'Delivery is taking too long', 'Need to change the address', 'Changed my mind', 'Other'];
  const RETURN_REASONS = ['Item arrived damaged', 'Item is expired or near expiry', 'Wrong item delivered', 'Quality not as described', 'Missing parts or accessories', 'Received fewer units than ordered', 'Other'];

  const filterTabs = (counts, active) => [
    ['all', 'All orders'], ['in_progress', 'In progress'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled'], ['returned', 'Returns & refunds']
  ].map(([key, label]) => `<a class="tab ${active === key ? 'is-active' : ''}" href="#/orders?filter=${key}">${label}${counts && counts[key] ? `<small>${counts[key]}</small>` : ''}</a>`).join('');

  const orderCard = (o) => `
    <article class="order-card">
      <div class="order-card__head">
        <div><b>${NB.esc(o.code)}</b><small>${NB.dateTime(o.createdAt)} · ${NB.plural(o.itemCount, 'item')} · ${NB.plural(o.shops.length, 'shop')}</small></div>
        <div class="order-card__status">${NB.statusPill(o.status, o.statusLabel)}<b>${NB.money(o.total)}</b></div>
      </div>
      <div class="order-card__body">
        ${o.shops.map((s) => `<div class="order-shop-row">
          <span class="mini-art tone-${s.shop?.tone || 'blue'}">${NB.esc(s.shop?.emoji || '🏪')}</span>
          <div class="order-shop-row__info"><b>${NB.esc(s.shop?.name || 'Shop')}</b><small>${s.items.map((i) => `${i.name} × ${i.qty}`).join(', ')}</small></div>
          <span class="order-shop-row__status">${NB.statusPill(s.status, s.statusLabel)}</span>
          <b class="order-shop-row__total">${NB.money(s.total)}</b>
        </div>`).join('')}
      </div>
      <div class="order-card__foot">
        <span class="order-card__meta">${NB.icon(o.paymentStatus === 'paid' ? 'checkCircle' : 'clock')} ${o.paymentMethod === 'cod' ? 'Cash on delivery' : o.paymentMethod === 'pay_at_store' ? 'Pay at store' : 'Online'} · ${NB.esc(o.paymentStatus)}${o.isDemo ? ' · <em>Demo data</em>' : ''}</span>
        <div class="order-card__actions">
          <a class="btn btn--primary btn--sm" href="#/orders/${encodeURIComponent(o.code)}">Track order</a>
          <button class="btn btn--ghost btn--sm" data-receipt="${encodeURIComponent(o.code)}">${NB.icon('receipt')} Receipt</button>
          <button class="btn btn--ghost btn--sm" data-reorder="${encodeURIComponent(o.code)}">${NB.icon('refresh')} Reorder</button>
          ${o.canCancelAny ? `<button class="btn btn--ghost btn--sm btn--danger-text" data-cancel-order="${encodeURIComponent(o.code)}">Cancel</button>` : ''}
        </div>
      </div>
    </article>`;

  /* ---------------------------------------------------------------- */
  /* Orders list                                                      */
  /* ---------------------------------------------------------------- */
  NB.view(/^\/orders$/, async (m, query) => {
    if (!NB.state.user) return { title: 'My orders', html: NB.authGate('Sign in to see your orders', 'Every order, receipt and status update lives in your NearBuy account.') };
    const filter = query.get('filter') || 'all';
    const q = query.get('q') || '';
    const data = await NB.api(`/orders?filter=${encodeURIComponent(filter)}&q=${encodeURIComponent(q)}&limit=20`);
    const html = `
      <div class="page-hero page-hero--compact"><div class="wrap">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<span>Orders</span></nav>
        <div class="page-hero__row"><div><span class="eyebrow">Orders &amp; tracking</span><h1>My orders</h1><p>Live status, receipts, cancellations and returns — all from your own account.</p></div>
          <form class="mini-search" id="orderSearch">${NB.icon('search')}<input name="q" value="${NB.esc(q)}" placeholder="Order code or shop" aria-label="Search orders"/></form></div>
      </div></div>
      <div class="wrap orders-page">
        <div class="tabbar">${filterTabs(data.counts, filter)}</div>
        <div class="orders-list" id="ordersList">
          ${data.orders.length ? data.orders.map(orderCard).join('') : NB.empty({ icon: 'package', title: q ? 'No orders match that search' : 'No orders here yet', body: q ? 'Try the full order code, e.g. NB-261119-1234, or a shop name.' : 'When you place your first order from a nearby shop, it will appear here with live tracking.', cta: '#/shops', ctaLabel: 'Start shopping' })}
        </div>
        ${data.pages > 1 ? `<div class="pager"><span>Page ${data.page} of ${data.pages}</span></div>` : ''}
        <div class="orders-help"><span>${NB.icon('headset')} Something wrong with an order?</span><a class="link-arrow" href="#/help">Contact support ${NB.icon('arrowRight')}</a></div>
      </div>`;

    return {
      title: 'My orders',
      html,
      after(root) {
        NB.$('#orderSearch', root).addEventListener('submit', (e) => {
          e.preventDefault();
          NB.hash(`/orders?filter=${filter}&q=${encodeURIComponent(e.target.q.value.trim())}`);
        });
        NB.$$('[data-receipt]', root).forEach((b) => b.addEventListener('click', () => {
          window.open(`/api/customer/orders/${encodeURIComponent(b.dataset.receipt)}/receipt`, '_blank', 'noopener');
        }));
        NB.$$('[data-cancel-order]', root).forEach((b) => b.addEventListener('click', () => openCancelModal(b.dataset.cancelOrder)));
        NB.$$('[data-reorder]', root).forEach((b) => b.addEventListener('click', async () => {
          b.disabled = true;
          await reorder(b.dataset.reorder, b);
        }));
      }
    };
  });

  async function reorder(code, btn) {
    try {
      const { order } = await NB.api(`/orders/${encodeURIComponent(code)}`);
      const items = order.sellerOrders.flatMap((s) => s.items.map((i) => ({ productId: i.productId, qty: i.qty })));
      let added = 0;
      for (const item of items) {
        try { await NB.api('/cart/items', { body: item }); added += 1; } catch { /* unavailable now */ }
      }
      const boot = await NB.api('/bootstrap');
      NB.setCounts(boot.counts);
      if (!added) NB.toast('None of those items are available right now.', 'warn');
      else { NB.toast(`${NB.plural(added, 'item')} added back to your basket.`, 'success'); NB.hash('/cart'); }
    } catch (err) { NB.toast(err.message, 'error'); }
    if (btn) btn.disabled = false;
  }

  function openCancelModal(code, sellerOrderId) {
    const m = NB.modal({
      title: 'Cancel this order?',
      body: `<p class="muted">Cancellation is only possible before the shop starts preparing. Stock is released immediately and any payment is refunded separately.</p>
        <form id="cancelForm" class="stack">
          <div class="field"><label for="cancelReason">Why are you cancelling? *</label><select id="cancelReason" name="reason" required>${CANCEL_REASONS.map((r) => `<option value="${NB.esc(r)}">${NB.esc(r)}</option>`).join('')}</select></div>
          <div class="field"><label for="cancelComment">Anything else? (optional)</label><textarea id="cancelComment" name="comment" rows="3" maxlength="300" placeholder="Tell the shop what happened"></textarea></div>
          <div class="notice notice--warn notice--tight">${NB.icon('info')} If the shop has already started preparing, the server will refuse the cancellation and ask you to contact support.</div>
          <div class="form-error" id="cancelError" hidden></div>
        </form>`,
      footer: `<button class="btn btn--ghost" data-close="1">Keep order</button><button class="btn btn--danger" id="doCancel">Request cancellation</button>`,
      onMount(root, close) {
        const doCancel = async () => {
          const form = NB.$('#cancelForm', root);
          const reason = NB.$('#cancelReason', root).value;
          const comment = NB.$('#cancelComment', root).value.trim();
          const err = NB.$('#cancelError', root);
          err.hidden = true;
          try {
            const res = await NB.api(`/orders/${encodeURIComponent(code)}/cancel`, { body: { reason: comment ? `${reason} — ${comment}` : reason, sellerOrderId } });
            close();
            NB.toast(res.message, 'success');
            NB.render();
          } catch (e) { err.textContent = e.message; err.hidden = false; }
        };
        NB.$('#cancelForm', root).addEventListener('submit', (e) => { e.preventDefault(); doCancel(); });
        NB.$('#doCancel', root).addEventListener('click', doCancel);
      }
    });
    return m;
  }

  /* ---------------------------------------------------------------- */
  /* Order detail                                                     */
  /* ---------------------------------------------------------------- */
  const FLOW = {
    delivery: ['placed', 'accepted', 'preparing', 'ready', 'runner_assigned', 'picked_up', 'out_for_delivery', 'delivered'],
    pickup: ['placed', 'accepted', 'preparing', 'ready', 'completed']
  };
  const FLOW_LABEL = {
    placed: 'Order placed', accepted: 'Seller accepted', preparing: 'Preparing', ready: 'Ready', runner_assigned: 'Partner assigned',
    picked_up: 'Picked up', out_for_delivery: 'Out for delivery', delivered: 'Delivered', completed: 'Completed'
  };

  function timeline(so) {
    const steps = FLOW[so.fulfillment] || FLOW.delivery;
    if (['cancelled', 'rejected'].includes(so.status)) {
      return `<ol class="timeline timeline--events">${so.events.map((e) => `<li class="is-done"><span></span><div><b>${NB.esc(e.label)}</b><small>${NB.dateTime(e.at)}${e.detail ? ' · ' + NB.esc(e.detail) : ''}</small></div></li>`).join('')}</ol>`;
    }
    let effective = so.status;
    if (effective === 'runner_requested') effective = 'ready';
    if (effective === 'ready' && so.fulfillment === 'delivery') effective = 'ready';
    const currentIndex = Math.max(0, steps.indexOf(effective));
    return `<ol class="timeline">${steps.map((step, i) => {
      const done = i < currentIndex || (i === currentIndex && ['delivered', 'completed'].includes(so.status));
      const active = i === currentIndex && !done;
      const event = so.events.find((e) => e.status === step);
      return `<li class="${done ? 'is-done' : ''} ${active ? 'is-active' : ''}">
        <span class="timeline__dot">${done ? NB.icon('check') : ''}</span>
        <div><b>${NB.esc(step === 'ready' && so.fulfillment === 'delivery' ? 'Ready for dispatch' : FLOW_LABEL[step])}</b>
        <small>${event ? NB.dateTime(event.at) : active ? 'In progress…' : 'Pending'}</small>
        ${event && event.detail ? `<em>${NB.esc(event.detail)}</em>` : ''}</div></li>`;
    }).join('')}</ol>
    ${so.status === 'runner_requested' ? `<div class="inline-note">${NB.icon('clock')} The shop is looking for a delivery partner. If none is available, the shop can deliver with its own rider.</div>` : ''}`;
  }

  NB.view(/^\/orders\/([A-Za-z0-9-]+)$/, async (m) => {
    if (!NB.state.user) return { title: 'Order tracking', html: NB.authGate('Sign in to track this order', 'Order updates and your delivery OTP are private to the account that placed the order.') };
    const code = m[1];
    const { order } = await NB.api(`/orders/${encodeURIComponent(code)}`);
    const active = ['placed', 'accepted', 'preparing', 'ready', 'runner_requested', 'runner_assigned', 'picked_up', 'out_for_delivery'].includes(order.status);
    const html = `
      <div class="page-hero page-hero--compact"><div class="wrap">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<a href="#/orders">Orders</a>${NB.icon('chevronRight')}<span>${NB.esc(order.code)}</span></nav>
        <div class="page-hero__row"><div><span class="eyebrow">Order tracking</span><h1>${NB.esc(order.code)} <span class="h1-demo">placed ${NB.dateTime(order.createdAt)}</span></h1>
          <div class="order-head-pills">${NB.statusPill(order.status, order.statusLabel)}<span class="pill pill--neutral">${NB.esc(order.paymentMethod === 'cod' ? 'Cash on delivery' : order.paymentMethod === 'pay_at_store' ? 'Pay at store' : 'Online')} · ${NB.esc(order.paymentStatus)}</span>${order.isDemo ? '<span class="pill pill--warn">Demo data</span>' : ''}</div>
          </div>
          <div class="order-head-actions"><button class="btn btn--ghost btn--sm" data-receipt="${encodeURIComponent(order.code)}">${NB.icon('receipt')} Receipt</button><button class="btn btn--ghost btn--sm" data-reorder="${encodeURIComponent(order.code)}">${NB.icon('refresh')} Reorder</button><a class="btn btn--ghost btn--sm" href="#/help?order=${encodeURIComponent(order.code)}">${NB.icon('headset')} Support</a></div>
        </div>
      </div></div>
      <div class="wrap order-detail" data-order-status="${NB.esc(order.status)}">
        <div class="order-detail__main">
          ${active ? `<div class="live-banner">${NB.icon('refresh')} <span>Live status · this page refreshes automatically every 20 seconds.</span><small>Last checked ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</small></div>` : ''}
          ${order.sellerOrders.map((so) => `
            <section class="track-card">
              <div class="track-card__head">
                <div class="track-card__shop"><span class="mini-art tone-${so.shop.tone}">${NB.esc(so.shop.emoji)}</span><div><h2><a href="#/shop/${encodeURIComponent(so.shop.slug)}">${NB.esc(so.shop.name)}</a></h2><small>${NB.esc(so.code)} · ${so.fulfillment === 'pickup' ? 'Store pickup' : 'Home delivery'}</small></div></div>
                <div class="track-card__right">${NB.statusPill(so.status, so.statusLabel)}<b>${NB.money(so.total)}</b></div>
              </div>
              <div class="track-card__body">
                <div class="track-timeline">${timeline(so)}</div>
                ${so.deliveryOtp ? `<div class="otp-card"><div><span class="otp-card__label">${NB.icon('shield')} Delivery OTP</span><div class="otp-digits">${String(so.deliveryOtp).split('').map((d) => `<b>${d}</b>`).join('')}</div><small>Share this only when the runner or rider hands over your items. The server checks it before marking the order delivered.</small></div><button class="btn btn--outline btn--sm" data-copy="${so.deliveryOtp}">Copy code</button></div>` : ''}
                ${so.pickupCode ? `<div class="otp-card otp-card--pickup"><div><span class="otp-card__label">${NB.icon('store')} Collection code</span><div class="otp-digits">${String(so.pickupCode).split('').map((d) => `<b>${d}</b>`).join('')}</div><small>Show this at ${NB.esc(so.shop.name)}. The shop verifies it before completing your order.</small></div><button class="btn btn--outline btn--sm" data-copy="${so.pickupCode}">Copy code</button></div>` : ''}
                ${so.runner ? `<div class="runner-card"><span class="runner-card__avatar">${NB.esc(so.runner.avatar || '🛵')}</span>
                  <div><b>${NB.esc(so.runner.name)}</b><small>${NB.esc(so.runner.vehicle || 'Delivery partner')} · ${so.runner.rating ? so.runner.rating + '★' : ''} ${so.runner.phoneMasked ? '· ' + NB.esc(so.runner.phoneMasked) : ''}</small>
                    ${so.runner.lastLocation ? `<em>${NB.icon('location')} Last shared location ${NB.timeAgo(so.runner.lastLocation.at)}</em>` : '<em>No location shared yet. Live tracking is only shown when the partner shares it.</em>'}</div>
                  <a class="btn btn--ghost btn--sm" href="#/help?order=${encodeURIComponent(order.code)}">${NB.icon('chat')} Contact</a></div>` : ''}
                <div class="track-items">
                  ${so.items.map((i) => `<div class="track-item"><span class="mini-art">${i.imageUrl ? `<img src="${NB.esc(i.imageUrl)}" alt=""/>` : NB.esc(i.emoji || '🛍️')}</span><div><b>${NB.esc(i.name)}</b><small>${NB.esc(i.brand || '')} · ${NB.esc(i.unit || '')}</small></div><span>${NB.money(i.price)} × ${i.qty}</span><b>${NB.money(i.lineTotal)}</b></div>`).join('')}
                </div>
                <div class="track-totals">
                  <span>Subtotal <b>${NB.money(so.subtotal)}</b></span>
                  ${so.discount ? `<span>Discount <b>−${NB.money(so.discount)}</b></span>` : ''}
                  <span>${so.fulfillment === 'pickup' ? 'Pickup' : 'Delivery'} <b>${so.deliveryFee ? NB.money(so.deliveryFee) : 'Free'}</b></span>
                  <span>Tax <b>${NB.money(so.tax)}</b></span>
                  <span class="track-totals__grand">Total <b>${NB.money(so.total)}</b></span>
                </div>
                <div class="track-actions">
                  ${so.canCancel ? `<button class="btn btn--ghost btn--sm btn--danger-text" data-cancel-shop="${encodeURIComponent(order.code)}" data-seller-order="${so.code}">${NB.icon('close')} Cancel this part</button>` : ''}
                  ${so.canReturn ? `<button class="btn btn--ghost btn--sm" data-return="${so.id}">${NB.icon('returnArrow')} Return an item</button>` : ''}
                  ${['delivered', 'completed'].includes(so.status) ? `<button class="btn btn--ghost btn--sm" data-review="${so.id}">${NB.icon('star')} Rate this order</button>` : ''}
                  <a class="btn btn--ghost btn--sm" href="${so.code ? `/api/customer/orders/${encodeURIComponent(order.code)}/receipt?sellerOrder=${encodeURIComponent(so.code)}` : '#'}" target="_blank" rel="noopener">${NB.icon('download')} Download receipt</a>
                  <a class="btn btn--ghost btn--sm" href="#/help?order=${encodeURIComponent(order.code)}">${NB.icon('headset')} Get help</a>
                </div>
              </div>
            </section>`).join('')}

          <section class="detail-section detail-section--tight">
            <div class="section-head section-head--sm"><div><span class="eyebrow">Full timeline</span><h2>Every status update</h2></div></div>
            <ol class="events-log">${order.events.map((e) => `<li><span class="events-log__dot"></span><div><b>${NB.esc(e.label)}</b><small>${NB.dateTime(e.at)}${e.actor ? ' · ' + NB.esc(e.actor) : ''}</small>${e.detail ? `<p>${NB.esc(e.detail)}</p>` : ''}</div></li>`).join('')}</ol>
          </section>
        </div>
        <aside class="order-detail__side">
          <div class="summary-card summary-card--flush">
            <h2>Order summary</h2>
            <div class="summary-row"><span>Subtotal</span><span>${NB.money(order.subtotal)}</span></div>
            ${order.discount ? `<div class="summary-row summary-row--save"><span>Coupon ${order.couponCode ? `(${NB.esc(order.couponCode)})` : ''}</span><span>−${NB.money(order.discount)}</span></div>` : ''}
            <div class="summary-row"><span>Delivery / pickup</span><span>${order.deliveryFee ? NB.money(order.deliveryFee) : 'Free'}</span></div>
            <div class="summary-row"><span>Taxes</span><span>${order.tax ? NB.money(order.tax) : 'Included'}</span></div>
            <div class="summary-total"><span>Total</span><b>${NB.money(order.total)}</b></div>
            <div class="pay-status">${NB.icon(order.paymentStatus === 'paid' ? 'checkCircle' : 'clock')} Payment ${NB.esc(order.paymentStatus)} · ${order.payments.map((p) => `${NB.esc(p.method)} (${NB.esc(p.status)})`).join(', ') || 'record pending'}</div>
          </div>
          <div class="side-card">
            <h3>${order.sellerOrders.every((s) => s.fulfillment === 'pickup') ? 'Pickup details' : 'Delivery address'}</h3>
            <p class="addr-block"><b>${NB.esc(order.address.receiver)}</b><br>${NB.esc([order.address.line1, order.address.line2, order.address.locality, order.address.city, order.address.pincode].filter(Boolean).join(', '))}<br>${NB.esc(order.address.phone || '')}</p>
            ${order.address.instructions ? `<p class="fineprint">${NB.icon('info')} ${NB.esc(order.address.instructions)}</p>` : ''}
            ${order.note ? `<p class="fineprint">${NB.icon('chat')} “${NB.esc(order.note)}”</p>` : ''}
            <div class="side-actions"><a class="btn btn--outline btn--block" href="#/account/addresses">Manage addresses</a></div>
          </div>
          <div class="side-card side-card--soft">
            <h3>${NB.icon('shield')} Need help?</h3>
            <p class="fineprint">Raise a ticket and keep a written trail. Include ${NB.esc(order.code)} so support can find this order.</p>
            <a class="btn btn--primary btn--block" href="#/help?order=${encodeURIComponent(order.code)}">${NB.icon('headset')} Contact support</a>
          </div>
        </aside>
      </div>`;

    return {
      title: `Order ${order.code}`,
      html,
      after(root) {
        NB.$$('[data-cancel-shop]', root).forEach((b) => b.addEventListener('click', () => openCancelModal(b.dataset.cancelShop, b.dataset.sellerOrder)));
        NB.$$('[data-return]', root).forEach((b) => b.addEventListener('click', () => {
          const so = order.sellerOrders.find((s) => s.id === b.dataset.return);
          openReturnModal(order, so);
        }));
        NB.$$('[data-review]', root).forEach((b) => b.addEventListener('click', () => {
          const so = order.sellerOrders.find((s) => s.id === b.dataset.review);
          openReviewModal(order, so);
        }));
        const receiptBtn = NB.$('[data-receipt]', root);
        if (receiptBtn) receiptBtn.addEventListener('click', () => window.open(`/api/customer/orders/${encodeURIComponent(order.code)}/receipt`, '_blank', 'noopener'));
        const reorderBtn = NB.$('[data-reorder]', root);
        if (reorderBtn) reorderBtn.addEventListener('click', () => reorder(order.code, reorderBtn));

        if (active) {
          const poll = setInterval(async () => {
            if (!location.hash.startsWith('#/orders/')) { clearInterval(poll); return; }
            try {
              const fresh = await NB.api(`/orders/${encodeURIComponent(order.code)}`);
              if (fresh.order.status !== order.status) {
                clearInterval(poll);
                NB.toast(`Order update: ${fresh.order.statusLabel}`, 'info');
                NB.render();
              }
            } catch { /* keep trying quietly */ }
          }, 20000);
        }
      }
    };
  });

  /* ---------------------------------------------------------------- */
  /* Return request                                                   */
  /* ---------------------------------------------------------------- */
  function openReturnModal(order, so) {
    if (!so) return;
    const eligible = so.items.filter((i) => so.returnableItemIds?.includes(i.id));
    const items = eligible.length ? eligible : so.items;
    const m = NB.modal({
      title: 'Request a return',
      className: 'modal--form',
      body: `<p class="muted">Choose the item and tell the shop what went wrong. Return windows are checked again by the server.</p>
        <form id="returnForm" class="stack">
          <div class="field"><label for="returnItem">Item *</label><select id="returnItem" name="itemId">${items.map((i) => `<option value="${i.id}">${NB.esc(i.name)} · ${NB.money(i.lineTotal)}${so.returnableItemIds?.includes(i.id) ? '' : ' (outside return window)'}</option>`).join('')}</select></div>
          <div class="field"><label for="returnReason">Reason *</label><select id="returnReason" name="reason">${RETURN_REASONS.map((r) => `<option>${NB.esc(r)}</option>`).join('')}</select></div>
          <div class="field"><label for="returnComment">Describe the issue *</label><textarea id="returnComment" name="comment" rows="3" required minlength="10" maxlength="800" placeholder="What was wrong with the item?"></textarea></div>
          <div class="field"><label>Photos (optional, up to 3)</label><input type="file" id="returnFiles" accept="image/png,image/jpeg,image/webp" multiple/><div class="upload-preview" id="uploadPreview"></div><small class="field-hint">Stored as small data URLs with the request; 180 KB per image.</small></div>
          <div class="notice notice--info notice--tight">${NB.icon('info')} A refund is only marked complete after the shop and payment provider confirm it. Demo mode uses records, not real money movement.</div>
          <div class="form-error" id="returnError" hidden></div>
        </form>`,
      footer: `<button class="btn btn--ghost" data-close="1">Cancel</button><button class="btn btn--primary" id="submitReturn">Submit return request</button>`,
      onMount(root, close) {
        const files = [];
        NB.$('#returnFiles', root).addEventListener('change', async (e) => {
          const preview = NB.$('#uploadPreview', root);
          for (const file of Array.from(e.target.files || []).slice(0, 3)) {
            if (file.size > 140000) { NB.toast(`${file.name} is larger than 140 KB.`, 'warn'); continue; }
            const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
            files.push(data);
            const img = document.createElement('img');
            img.src = data; img.alt = file.name;
            preview.appendChild(img);
          }
        });
        const submitReturn = async () => {
          const err = NB.$('#returnError', root);
          err.hidden = true;
          const comment = NB.$('#returnComment', root).value.trim();
          if (comment.length < 10) { err.textContent = 'Please describe the issue in at least 10 characters.'; err.hidden = false; return; }
          try {
            const res = await NB.api(`/orders/${encodeURIComponent(order.code)}/returns`, {
              body: { sellerOrderId: so.id, itemId: NB.$('#returnItem', root).value, reason: NB.$('#returnReason', root).value, comment, images: files }
            });
            close();
            NB.toast(res.message, 'success');
            NB.render();
          } catch (e) { err.textContent = e.message; err.hidden = false; }
        };
        NB.$('#returnForm', root).addEventListener('submit', (e) => { e.preventDefault(); submitReturn(); });
        NB.$('#submitReturn', root).addEventListener('click', submitReturn);
      }
    });
    return m;
  }

  /* ---------------------------------------------------------------- */
  /* Verified review                                                  */
  /* ---------------------------------------------------------------- */
  function openReviewModal(order, so) {
    if (!so) return;
    const m = NB.modal({
      title: 'Rate this order',
      className: 'modal--form',
      body: `<p class="muted">Only customers with a delivered order can review. Your review is marked as a verified purchase.</p>
        <form id="reviewForm" class="stack">
          <div class="field"><label>How was ${NB.esc(so.shop.name)}? *</label>${starsInput('shopRating')}</div>
          <div class="field"><label for="reviewProduct">Rate a product (optional)</label>
            <select id="reviewProduct" name="productId"><option value="">Skip product rating</option>${so.items.map((i) => `<option value="${NB.esc(i.productId)}">${NB.esc(i.name)}</option>`).join('')}</select>
            <div id="productStars" hidden style="margin-top:10px">${starsInput('productRating')}</div>
          </div>
          <div class="field"><label for="reviewTitle">Title</label><input id="reviewTitle" name="title" maxlength="90" placeholder="e.g. Fresh and well packed"/></div>
          <div class="field"><label for="reviewBody">Your review *</label><textarea id="reviewBody" name="body" rows="4" required minlength="10" maxlength="1200" placeholder="What did you buy and how was the experience?"></textarea></div>
          <div class="form-error" id="reviewError" hidden></div>
        </form>`,
      footer: `<button class="btn btn--ghost" data-close="1">Later</button><button class="btn btn--primary" id="submitReview">Publish review</button>`,
      onMount(root, close) {
        bindStars(root);
        const select = NB.$('#reviewProduct', root);
        select.addEventListener('change', () => { NB.$('#productStars', root).hidden = !select.value; });
        const submitReview = async () => {
          const err = NB.$('#reviewError', root);
          err.hidden = true;
          const shopRating = Number(root.querySelector('input[name="shopRating"]:checked')?.value || 0);
          const productRating = Number(root.querySelector('input[name="productRating"]:checked')?.value || shopRating);
          const body = NB.$('#reviewBody', root).value.trim();
          if (!shopRating) { err.textContent = 'Choose a star rating for the shop.'; err.hidden = false; return; }
          if (body.length < 10) { err.textContent = 'Please write at least 10 characters about your experience.'; err.hidden = false; return; }
          try {
            const res = await NB.api('/reviews', {
              body: {
                orderCode: order.code, sellerOrderId: so.id, productId: select.value || undefined,
                shopRating, productRating: select.value ? productRating : undefined,
                title: NB.$('#reviewTitle', root).value.trim(), body
              }
            });
            close();
            NB.toast(res.message, 'success');
          } catch (e) { err.textContent = e.message; err.hidden = false; }
        };
        NB.$('#reviewForm', root).addEventListener('submit', (e) => { e.preventDefault(); submitReview(); });
        NB.$('#submitReview', root).addEventListener('click', submitReview);
      }
    });
    return m;
  }

  function starsInput(name, value = 0) {
    return `<div class="star-input" role="radiogroup" aria-label="Star rating">${[5, 4, 3, 2, 1].map((n) => `
      <input type="radio" id="${name}-${n}" name="${name}" value="${n}" ${value === n ? 'checked' : ''}/>
      <label for="${name}-${n}" title="${n} star${n > 1 ? 's' : ''}">${NB.icon('star')}</label>`).join('')}</div>`;
  }
  function bindStars(root) {
    NB.$$('.star-input', root).forEach((box) => {
      const sync = () => {
        const checked = box.querySelector('input:checked');
        const val = checked ? Number(checked.value) : 0;
        NB.$$('label', box).forEach((l) => l.classList.toggle('is-on', Number(l.getAttribute('for').split('-').pop()) <= val));
      };
      NB.$$('input', box).forEach((r) => r.addEventListener('change', sync));
      sync();
    });
  }
  NB.starsInput = starsInput;
})();
