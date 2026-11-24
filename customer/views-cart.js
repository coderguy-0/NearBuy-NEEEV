/* Cart, checkout, payment and order confirmation. */
(function () {
  'use strict';
  const NB = window.NB;

  /* ---------------------------------------------------------------- */
  /* Shared address form                                              */
  /* ---------------------------------------------------------------- */
  NB.addressModal = ({ onSaved, address }) => {
    const a = address || {};
    const m = NB.modal({
      title: address ? 'Edit address' : 'Add a delivery address',
      className: 'modal--form',
      body: `<form id="addrForm" class="stack" novalidate>
        <div class="seg-field"><span class="field-label">Save as</span>
          <div class="segmented segmented--labels">${['Home', 'Work', 'Other'].map((l) => `<label class="segmented__opt"><input type="radio" name="label" value="${l}" ${(a.label || 'Home') === l ? 'checked' : ''}/><span>${l}</span></label>`).join('')}</div>
        </div>
        <div class="grid-2">
          <div class="field"><label for="aName">Full name *</label><input id="aName" name="receiver" required value="${NB.esc(a.receiver || '')}" placeholder="Who receives the order?" autocomplete="name"/></div>
          <div class="field"><label for="aPhone">Mobile number *</label><input id="aPhone" name="phone" inputmode="numeric" required value="${NB.esc(a.phone || '')}" placeholder="10-digit mobile" autocomplete="tel"/></div>
        </div>
        <div class="field"><label for="aLine1">House / flat and street *</label><input id="aLine1" name="line1" required value="${NB.esc(a.line1 || '')}" placeholder="e.g. B-12, 2nd floor, Hauz Khas Enclave" autocomplete="address-line1"/></div>
        <div class="field"><label for="aLine2">Area / apartment (optional)</label><input id="aLine2" name="line2" value="${NB.esc(a.line2 || '')}" placeholder="Building, block or apartment" autocomplete="address-line2"/></div>
        <div class="grid-2">
          <div class="field"><label for="aPin">Pincode *</label><input id="aPin" name="pincode" inputmode="numeric" maxlength="6" required value="${NB.esc(a.pincode || '')}" placeholder="110016" autocomplete="postal-code"/><small class="field-hint" id="pinHint">We currently serve 110016, 110017, 110024, 110048 and 110070.</small></div>
          <div class="field"><label for="aCity">City *</label><input id="aCity" name="city" value="${NB.esc(a.city || 'New Delhi')}" required autocomplete="address-level2"/></div>
        </div>
        <div class="field"><label for="aLocality">Locality *</label><input id="aLocality" name="locality" required value="${NB.esc(a.locality || '')}" placeholder="e.g. Hauz Khas" autocomplete="address-level3"/></div>
        <div class="grid-2">
          <div class="field"><label for="aLandmark">Landmark (optional)</label><input id="aLandmark" name="landmark" value="${NB.esc(a.landmark || '')}" placeholder="e.g. Near Deer Park gate"/></div>
          <div class="field"><label for="aInstructions">Delivery instructions (optional)</label><input id="aInstructions" name="instructions" value="${NB.esc(a.instructions || '')}" placeholder="e.g. Ring the bell twice"/></div>
        </div>
        <label class="check"><input type="checkbox" name="isDefault" ${a.isDefault ? 'checked' : ''}/><span>Make this my default address</span></label>
        <div class="form-error" id="addrError" hidden></div>
        <p class="fineprint">${NB.icon('lock')} Addresses are saved to your account and only shown to the shop fulfilling your order.</p>
      </form>`,
      footer: `<button class="btn btn--ghost" data-close="1">Cancel</button><button class="btn btn--primary" id="saveAddr">Save address</button>`,
      onMount(root, close) {
        const form = NB.$('#addrForm', root);
        const pin = NB.$('#aPin', root);
        pin.addEventListener('blur', async () => {
          if (!/^\d{6}$/.test(pin.value)) return;
          try {
            const res = await NB.api(`/serviceability?pincode=${pin.value}`);
            const hint = NB.$('#pinHint', root);
            if (res.area) {
              NB.$('#aLocality', root).value = res.area.locality;
              hint.textContent = res.serviceable ? `${res.area.locality} is serviceable — ${res.shopCount} shops deliver here.` : `${res.area.locality} is not serviceable yet.`;
              hint.className = `field-hint ${res.serviceable ? 'is-ok' : 'is-warn'}`;
            } else {
              hint.textContent = 'We do not recognise this pincode yet.';
              hint.className = 'field-hint is-warn';
            }
          } catch { /* ignore */ }
        });
        const saveAddress = async () => {
          const errBox = NB.$('#addrError', root);
          errBox.hidden = true;
          const data = Object.fromEntries(new FormData(form).entries());
          data.isDefault = Boolean(NB.$('input[name="isDefault"]', root).checked);
          try {
            const res = address
              ? await NB.api(`/addresses/${encodeURIComponent(address.id)}`, { method: 'PATCH', body: data })
              : await NB.api('/addresses', { body: data });
            NB.toast(res.message, 'success');
            close();
            if (onSaved) onSaved(res.address);
          } catch (err) {
            errBox.textContent = err.message;
            errBox.hidden = false;
          }
        };
        form.addEventListener('submit', (e) => { e.preventDefault(); saveAddress(); });
        NB.$('#saveAddr', root).addEventListener('click', saveAddress);
      }
    });
    return m;
  };

  const addressCard = (a, selected, opts = {}) => `
    <label class="address-card ${selected ? 'is-selected' : ''}">
      <input type="radio" name="${opts.name || 'address'}" value="${a.id}" ${selected ? 'checked' : ''}/>
      <span class="address-card__body">
        <span class="address-card__top"><b>${NB.esc(a.label)}</b>${a.isDefault ? '<em>Default</em>' : ''}</span>
        <span class="address-card__name">${NB.esc(a.receiver)} · ${NB.esc(a.phone)}</span>
        <span class="address-card__line">${NB.esc([a.line1, a.line2, a.locality, a.city, a.pincode].filter(Boolean).join(', '))}</span>
        ${a.instructions ? `<span class="address-card__note">${NB.icon('info')} ${NB.esc(a.instructions)}</span>` : ''}
      </span>
      ${opts.editable ? `<button type="button" class="link-btn" data-edit-address="${a.id}">Edit</button>` : ''}
    </label>`;

  NB.addressCard = addressCard;

  /* ---------------------------------------------------------------- */
  /* Cart                                                             */
  /* ---------------------------------------------------------------- */
  function guestCartData() {
    const lines = NB.state.guestCart;
    const byShop = new Map();
    for (const l of lines) {
      if (!byShop.has(l.shopSlug)) byShop.set(l.shopSlug, []);
      byShop.get(l.shopSlug).push(l);
    }
    const groups = [];
    for (const [shopSlug, items] of byShop) {
      const subtotal = items.reduce((t, i) => t + i.price * i.qty, 0);
      groups.push({
        shop: { id: shopSlug, name: items[0].shop || shopSlug.replace(/-/g, ' '), slug: shopSlug, emoji: '🏪', tone: 'blue', isOpen: null, deliveryEnabled: true, pickupEnabled: true, deliveryFee: 0, pickupFee: 0, freeDeliveryOver: null, minOrder: 0 },
        fulfillment: 'delivery', fulfillmentOptions: ['delivery', 'pickup'], subtotal, discount: 0, deliveryFee: 0, tax: 0, total: subtotal,
        items: items.map((i) => ({ productId: i.productId, name: i.name, brand: '', emoji: i.emoji, imageUrl: i.imageUrl, unit: i.unit, price: i.price, mrp: i.mrp, qty: i.qty, stock: 99, available: true, lineTotal: i.price * i.qty, taxRate: 0 }))
      });
    }
    const subtotal = groups.reduce((t, g) => t + g.subtotal, 0);
    return { items: lines.length, itemCount: lines.reduce((t, l) => t + l.qty, 0), subtotal, discount: 0, deliveryFee: 0, tax: 0, total: subtotal, groups, issues: [], coupon: null, guest: true };
  }

  const fulfillmentState = () => NB.storage.get('nb.fulfillment', {});
  const saveFulfillment = (map) => NB.storage.set('nb.fulfillment', map);

  function recalcClient(cart) {
    const map = fulfillmentState();
    for (const g of cart.groups) {
      if (map[g.shop.id] && g.fulfillmentOptions.includes(map[g.shop.id])) g.fulfillment = map[g.shop.id];
      let fee = g.fulfillment === 'delivery' ? (g.shop.deliveryFee || 0) : (g.shop.pickupFee || 0);
      if (g.fulfillment === 'delivery' && g.shop.freeDeliveryOver && (g.subtotal - g.discount) >= g.shop.freeDeliveryOver) fee = 0;
      g.deliveryFee = fee;
      g.total = Math.max(0, g.subtotal - g.discount + fee + g.tax);
      g.etaMinutes = (g.shop.prepMinutes || 15) + (g.fulfillment === 'delivery' ? 18 : 0);
    }
    cart.deliveryFee = cart.groups.reduce((t, g) => t + g.deliveryFee, 0);
    cart.total = cart.groups.reduce((t, g) => t + g.total, 0);
    return cart;
  }

  NB.view(/^\/cart$/, async () => {
    const user = NB.state.user;
    const cart = recalcClient(user ? (await NB.api('/cart')).cart : guestCartData());
    const html = `
      <div class="page-hero page-hero--compact"><div class="wrap">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<span>Shopping cart</span></nav>
        <div class="page-hero__row"><div><span class="eyebrow">Your basket</span><h1>Shopping cart</h1><p>${cart.itemCount ? `${NB.plural(cart.itemCount, 'item')} from ${NB.plural(cart.groups.length, 'shop')}. Choose delivery or pickup per shop.` : 'Your basket is ready for its first neighbourhood find.'}</p></div>
          ${cart.itemCount ? `<button class="btn btn--ghost btn--sm" id="clearCart">${NB.icon('trash')} Empty basket</button>` : ''}</div>
      </div></div>
      <div class="wrap cart-page">
        ${!cart.itemCount ? NB.empty({ icon: 'cart', title: 'Your basket is empty', body: 'Start with the shops around you — fresh produce, pharmacy, stationery and more.', cta: '#/shops', ctaLabel: 'Browse nearby shops' }) : `
        <div class="cart-layout">
          <div class="cart-main">
            ${cart.groups.map((g) => `
              <section class="cart-shop">
                <div class="cart-shop__head">
                  <div class="cart-shop__title"><span class="mini-art tone-${g.shop.tone}">${NB.esc(g.shop.emoji)}</span>
                    <div><h2><a href="#/shop/${encodeURIComponent(g.shop.slug)}">${NB.esc(g.shop.name)}</a></h2><small>${g.shop.isOpen === false ? 'Closed' : g.shop.isOpen === true ? 'Open now' : 'Live availability confirmed at checkout'}${g.shop.locality ? ' · ' + NB.esc(g.shop.locality) : ''}</small></div>
                  </div>
                  <div class="fulfil-toggle" role="radiogroup" aria-label="Fulfilment for ${NB.esc(g.shop.name)}">
                    ${g.fulfillmentOptions.map((f) => `<button class="fulfil-opt ${g.fulfillment === f ? 'is-active' : ''}" data-shop="${g.shop.id}" data-fulfil="${f}" ${g.fulfillmentOptions.length < 2 ? 'disabled' : ''}>
                      ${NB.icon(f === 'delivery' ? 'truck' : 'store')} ${f === 'delivery' ? 'Delivery' : 'Pickup'}
                      <small>${f === 'delivery' ? ((g.shop.freeDeliveryOver && g.subtotal >= g.shop.freeDeliveryOver) || !g.shop.deliveryFee ? 'Free' : NB.money(g.shop.deliveryFee)) : (!g.shop.pickupFee ? 'Free' : NB.money(g.shop.pickupFee))}</small>
                    </button>`).join('')}
                  </div>
                </div>
                ${g.fulfillment === 'delivery' && g.shop.freeDeliveryOver ? `<div class="cart-shop__hint">${NB.icon('truck')} ${g.subtotal >= g.shop.freeDeliveryOver ? 'Free delivery unlocked for this shop.' : `Add ${NB.money(g.shop.freeDeliveryOver - g.subtotal)} more from this shop for free delivery.`}</div>` : ''}
                ${g.fulfillment === 'pickup' ? `<div class="cart-shop__hint">${NB.icon('store')} Collect from ${NB.esc(g.shop.name)} · ready in about ${g.shop.prepMinutes || 15} min after acceptance.</div>` : ''}
                ${g.items.map((it) => `
                  <div class="cart-line">
                    <a href="#/product/${encodeURIComponent(it.productId)}" class="cart-line__art">${it.imageUrl ? `<img src="${NB.esc(it.imageUrl)}" alt=""/>` : `<span>${NB.esc(it.emoji || '🛍️')}</span>`}</a>
                    <div class="cart-line__info"><a href="#/product/${encodeURIComponent(it.productId)}"><b>${NB.esc(it.name)}</b></a><small>${NB.esc(it.brand || '')}${it.unit ? ' · ' + NB.esc(it.unit) : ''}</small>
                      <div class="cart-line__price">${NB.money(it.price)}${it.mrp > it.price ? `<s>${NB.money(it.mrp)}</s>` : ''}</div>
                      ${!it.available ? `<div class="text-danger cart-line__warn">${NB.icon('alert')} Only ${it.stock} available now</div>` : ''}
                    </div>
                    <div class="cart-line__qty">${NB.qtyStepper(it.qty, { max: Math.min(20, it.stock || 20), small: true })}</div>
                    <div class="cart-line__total"><b>${NB.money(it.lineTotal)}</b><button class="link-btn link-btn--danger" data-remove="${encodeURIComponent(it.productId)}">Remove</button></div>
                  </div>`).join('')}
                <div class="cart-shop__foot">
                  <span>Shop subtotal <b>${NB.money(g.subtotal)}</b></span>
                  <span>${g.fulfillment === 'pickup' ? 'Pickup charge' : 'Delivery'} <b>${g.deliveryFee ? NB.money(g.deliveryFee) : 'Free'}</b></span>
                  <span class="cart-shop__total">Shop total <b>${NB.money(g.total)}</b></span>
                </div>
                ${g.minOrder > g.subtotal ? `<div class="notice notice--warn notice--tight">${NB.icon('alert')} ${NB.esc(g.shop.name)} has a minimum order of ${NB.money(g.minOrder)}. Add ${NB.money(g.minOrder - g.subtotal)} more.</div>` : ''}
              </section>`).join('')}
            <div class="cart-continue"><a class="link-arrow" href="#/shops">${NB.icon('arrowLeft')} Continue shopping</a>
              ${!user ? `<span class="cart-guest-note">${NB.icon('info')} You are browsing as a guest. Sign in at checkout to place this order.</span>` : ''}</div>
          </div>
          <aside class="cart-side">
            <div class="summary-card">
              <h2>Order summary</h2>
              <div class="summary-row"><span>Subtotal (${NB.plural(cart.itemCount, 'item')})</span><span>${NB.money(cart.subtotal)}</span></div>
              ${cart.discount ? `<div class="summary-row summary-row--save"><span>Coupon discount</span><span>−${NB.money(cart.discount)}</span></div>` : ''}
              <div class="summary-row"><span>Delivery / pickup</span><span>${cart.deliveryFee ? NB.money(cart.deliveryFee) : 'Free'}</span></div>
              <div class="summary-row"><span>Taxes</span><span>${cart.tax ? NB.money(cart.tax) : 'Included'}</span></div>
              <div class="summary-total"><span>Payable</span><b>${NB.money(cart.total)}</b></div>
              ${user ? `
                <div class="coupon-box">
                  <label for="couponInput">Have a coupon?</label>
                  ${cart.coupon ? `<div class="coupon-applied">${NB.icon('tag')} <b>${NB.esc(cart.coupon.code)}</b><span>${NB.esc(cart.coupon.title)}</span><button class="link-btn" id="removeCoupon">Remove</button></div>`
                    : `<div class="coupon-input"><input id="couponInput" placeholder="Coupon code" autocomplete="off"/><button class="btn btn--outline btn--sm" id="applyCoupon">Apply</button></div>`}
                  ${cart.rejectedCoupon ? `<div class="text-danger coupon-msg">${NB.icon('alert')} ${NB.esc(cart.rejectedCoupon.message)}</div>` : ''}
                  <div class="coupon-suggest" id="couponSuggest"></div>
                </div>` : ''}
              ${cart.issues.length ? `<div class="notice notice--warn notice--tight">${NB.icon('alert')} ${NB.esc(cart.issues[0])}</div>` : ''}
              <button class="btn btn--primary btn--lg btn--block" id="checkoutBtn">${user ? `Proceed to checkout ${NB.icon('arrowRight')}` : 'Sign in to checkout'}</button>
              <div class="summary-trust"><span>${NB.icon('shield')} Secure checkout</span><span>${NB.icon('truck')} OTP delivery</span><span>${NB.icon('returnArrow')} Easy returns</span></div>
            </div>
            <div class="side-card side-card--soft">
              <h3>${NB.icon('info')} How your basket works</h3>
              <p class="fineprint">Each shop fulfils its own items. You can choose home delivery for one shop and store pickup for another. Delivery fees, minimum orders and estimated times are set by each seller.</p>
            </div>
          </aside>
        </div>`}
      </div>`;

    return {
      title: 'Shopping cart',
      html,
      after(root) {
        const userNow = NB.state.user;
        if (root.querySelector('#clearCart')) {
          NB.$('#clearCart', root).addEventListener('click', () => NB.confirm({
            title: 'Empty your basket?', message: 'This removes every item from your cart. You can add them again from the shops.', confirmLabel: 'Empty basket', danger: true,
            async onConfirm() {
              if (userNow) { await NB.api('/cart/items', { method: 'DELETE' }); }
              else { NB.state.guestCart = []; NB.saveGuestCart(); }
              NB.setCounts({ cart: 0 });
              NB.toast('Basket emptied.', 'success');
              NB.render();
            }
          }));
        }
        NB.$$('[data-fulfil]', root).forEach((btn) => btn.addEventListener('click', () => {
          const map = fulfillmentState();
          map[btn.dataset.shop] = btn.dataset.fulfil;
          saveFulfillment(map);
          NB.render();
        }));
        if (!userNow) {
          NB.$$('.cart-line', root).forEach((line) => {
            const w = NB.$('.qty', line);
            const id = decodeURIComponent(NB.$('[data-remove]', line).dataset.remove);
            NB.bindQty(w, (qty) => {
              const cartLine = NB.state.guestCart.find((l) => l.productId === id);
              if (!cartLine) return;
              cartLine.qty = qty;
              NB.saveGuestCart();
              NB.render();
            });
          });
        } else {
          NB.$$('.cart-line', root).forEach((line) => {
            const w = NB.$('.qty', line);
            const id = decodeURIComponent(NB.$('[data-remove]', line).dataset.remove);
            NB.bindQty(w, async (qty) => {
              try {
                const res = await NB.api(`/cart/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: { qty } });
                NB.state.cart = res.cart;
                NB.setCounts({ cart: res.cart.itemCount });
                NB.render();
              } catch (err) { NB.toast(err.message, 'error'); NB.render(); }
            });
          });
        }
        NB.$$('[data-remove]', root).forEach((b) => b.addEventListener('click', async () => {
          const id = decodeURIComponent(b.dataset.remove);
          try {
            if (userNow) {
              const res = await NB.api(`/cart/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
              NB.setCounts({ cart: res.cart.itemCount });
              NB.toast(res.message, 'success');
            } else {
              NB.state.guestCart = NB.state.guestCart.filter((l) => l.productId !== id);
              NB.saveGuestCart();
              NB.toast('Item removed.', 'success');
            }
            NB.render();
          } catch (err) { NB.toast(err.message, 'error'); }
        }));
        const apply = NB.$('#applyCoupon', root);
        if (apply) {
          const doApply = async () => {
            const code = NB.$('#couponInput', root).value.trim();
            if (!code) { NB.toast('Enter a coupon code.', 'warn'); return; }
            apply.disabled = true;
            try {
              const res = await NB.api('/cart/coupon', { body: { code } });
              NB.toast(res.message, 'success');
              NB.render();
            } catch (err) { NB.toast(err.message, 'error'); apply.disabled = false; }
          };
          apply.addEventListener('click', doApply);
          NB.$('#couponInput', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') doApply(); });
        }
        const remove = NB.$('#removeCoupon', root);
        if (remove) remove.addEventListener('click', async () => {
          try { await NB.api('/cart/coupon', { method: 'DELETE' }); NB.toast('Coupon removed.', 'success'); NB.render(); } catch (err) { NB.toast(err.message, 'error'); }
        });
        const checkout = NB.$('#checkoutBtn', root);
        if (checkout) checkout.addEventListener('click', () => {
          if (!NB.state.user) {
            NB.hash(`/login?next=${encodeURIComponent('#/checkout')}`);
            return;
          }
          if (cart.issues.length || cart.groups.some((g) => g.minOrder > g.subtotal)) {
            NB.toast(cart.issues[0] || 'Fix the highlighted shop requirements first.', 'warn');
            return;
          }
          NB.hash('/checkout');
        });
        // Suggest live coupons
        if (userNow && NB.$('#couponSuggest', root) && !cart.coupon) {
          NB.api(`/offers?${NB.locationQuery()}`).then((off) => {
            const box = NB.$('#couponSuggest', root);
            if (!box) return;
            box.innerHTML = off.offers.slice(0, 2).map((o) => `<button class="coupon-suggest__item" data-code="${NB.esc(o.code)}">${NB.icon('tag')} <b>${NB.esc(o.code)}</b><span>${NB.esc(o.savingsLabel)}</span></button>`).join('');
            NB.$$('[data-code]', box).forEach((b) => b.addEventListener('click', async () => {
              try { await NB.api('/cart/coupon', { body: { code: b.dataset.code } }); NB.toast(`${b.dataset.code} applied.`, 'success'); NB.render(); } catch (err) { NB.toast(err.message, 'error'); }
            }));
          }).catch(() => {});
        }
      }
    };
  });

  /* ---------------------------------------------------------------- */
  /* Checkout                                                          */
  /* ---------------------------------------------------------------- */
  NB.view(/^\/checkout$/, async (m, query) => {
    if (!NB.state.user) return { title: 'Checkout', html: NB.authGate('Sign in to checkout', 'Your basket is saved. Sign in to choose an address, fulfilment and payment.') };
    const [cartRes, addrRes] = await Promise.all([NB.api('/cart'), NB.api('/addresses')]);
    const cart = recalcClient(cartRes.cart);
    if (!cart.items) {
      return { title: 'Checkout', html: `<div class="wrap section">${NB.empty({ icon: 'cart', title: 'Your basket is empty', body: 'Add items from nearby shops before checking out.', cta: '#/shops', ctaLabel: 'Browse shops' })}</div>` };
    }
    const addresses = addrRes.addresses;
    let selectedAddress = query.get('address') || addresses.find((a) => a.isDefault)?.id || addresses[0]?.id || null;
    let payment = 'cod';
    let note = '';
    let quote = null;
    let idempotencyKey = sessionStorage.getItem('nb.checkout.key') || (crypto.randomUUID ? crypto.randomUUID() : `chk-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    sessionStorage.setItem('nb.checkout.key', idempotencyKey);
    let placing = false;

    const initialFulfil = {};
    cart.groups.forEach((g) => { initialFulfil[g.shop.id] = g.fulfillment; });

    const html = `
      <div class="page-hero page-hero--compact"><div class="wrap">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<a href="#/cart">Cart</a>${NB.icon('chevronRight')}<span>Checkout</span></nav>
        <div class="page-hero__row"><div><span class="eyebrow">Checkout</span><h1>Almost there</h1><p>${NB.plural(cart.itemCount, 'item')} from ${NB.plural(cart.groups.length, 'shop')}. Every amount is recalculated by the server before your order is created.</p></div>
          <div class="checkout-steps"><span class="is-active">1 Address</span><span>2 Fulfilment</span><span>3 Payment</span><span>4 Place order</span></div></div>
      </div></div>
      <div class="wrap checkout-page">
        <div class="checkout-main">
          <section class="checkout-card" id="addrSection">
            <div class="checkout-card__head"><span class="step-badge">1</span><div><h2>Delivery address</h2><p>Where should this order go?</p></div></div>
            <div class="address-list" id="addressList">
              ${addresses.length ? addresses.map((a) => addressCard(a, a.id === selectedAddress)).join('') : `<div class="notice notice--warn">${NB.icon('alert')} Add a delivery address to continue.</div>`}
              <button class="add-address" id="addAddressBtn">${NB.icon('plus')} Add a new address</button>
            </div>
          </section>

          <section class="checkout-card">
            <div class="checkout-card__head"><span class="step-badge">2</span><div><h2>Fulfilment</h2><p>Choose delivery or pickup for each shop. The seller’s settings decide what is available.</p></div></div>
            <div class="checkout-shops">
              ${cart.groups.map((g) => `
                <div class="checkout-shop">
                  <div class="checkout-shop__head"><span class="mini-art tone-${g.shop.tone}">${NB.esc(g.shop.emoji)}</span><div><b>${NB.esc(g.shop.name)}</b><small>${NB.plural(g.items.reduce((t, i) => t + i.qty, 0), 'item')} · ${NB.money(g.subtotal)}</small></div></div>
                  <div class="fulfil-cards">
                    ${(g.fulfillmentOptions || []).map((f) => `<label class="fulfil-card ${g.fulfillment === f ? 'is-selected' : ''}">
                      <input type="radio" name="fulfil-${g.shop.id}" value="${f}" ${g.fulfillment === f ? 'checked' : ''}/>
                      <span class="fulfil-card__icon">${NB.icon(f === 'delivery' ? 'truck' : 'store')}</span>
                      <span class="fulfil-card__body"><b>${f === 'delivery' ? 'Home delivery' : 'Store pickup'}</b>
                        <small>${f === 'delivery' ? `${g.shop.prepMinutes + 18}–${g.shop.prepMinutes + 35} min · ${g.deliveryFee ? NB.money(g.deliveryFee) : 'Free'}` : `Ready in ${g.shop.prepMinutes} min · ${g.shop.pickupFee ? NB.money(g.shop.pickupFee) : 'Free'}`}</small>
                        <em>${f === 'delivery' ? 'Delivered by the shop or a NearBuy runner.' : 'Collect from the shop counter with your collection code.'}</em></span>
                    </label>`).join('')}
                  </div>
                  ${g.fulfillment === 'pickup' ? `<div class="pickup-info">${NB.icon('location')} ${NB.esc(g.shop.name)} · ${NB.esc(g.shop.locality || '')} · opens ${g.shop.opensAt || '—'}</div>` : ''}
                </div>`).join('')}
            </div>
            <div class="field" style="margin-top:16px"><label for="orderNote">Delivery / pickup instructions (optional)</label><textarea id="orderNote" rows="2" maxlength="300" placeholder="e.g. Call on arrival, leave with the security desk…"></textarea></div>
          </section>

          <section class="checkout-card">
            <div class="checkout-card__head"><span class="step-badge">3</span><div><h2>Payment method</h2><p>Only methods this deployment can actually process are enabled.</p></div></div>
            <div class="pay-list" id="payList">
              <label class="pay-option is-selected"><input type="radio" name="payment" value="cod" checked/>
                <span class="pay-option__ic">${NB.icon('wallet')}</span><span class="pay-option__body"><b>Cash on delivery</b><small>Pay the shop or runner in cash when your order arrives.</small></span><span class="pay-option__tag">Available</span></label>
              <label class="pay-option"><input type="radio" name="payment" value="pay_at_store" id="payAtStore"/>
                <span class="pay-option__ic">${NB.icon('store')}</span><span class="pay-option__body"><b>Pay at store</b><small>Only available when every shop in the basket is set to store pickup.</small></span><span class="pay-option__tag" id="payStoreTag">Pickup only</span></label>
              <label class="pay-option is-disabled"><input type="radio" name="payment" value="online" disabled/>
                <span class="pay-option__ic">${NB.icon('upi')}</span><span class="pay-option__body"><b>UPI, cards, net banking &amp; wallets</b><small>${NB.esc(NB.state.config.payments.message)}</small></span><span class="pay-option__tag">Not configured</span></label>
            </div>
            <div class="notice notice--info notice--tight">${NB.icon('lock')} No payment is simulated. Cash orders stay “pending” until the seller records collection; online payments would be confirmed only by a signed gateway webhook.</div>
          </section>
        </div>
        <aside class="checkout-side">
          <div class="summary-card" id="quoteCard">${NB.spinner()} Calculating totals…</div>
          <div class="side-card side-card--soft"><h3>${NB.icon('shield')} What happens next</h3>
            <ul class="tick-list"><li>${NB.icon('check')} The correct shop receives only its items.</li><li>${NB.icon('check')} Stock is reserved inside one transaction.</li><li>${NB.icon('check')} You get an order code and live tracking.</li><li>${NB.icon('check')} Delivery completes only with your OTP.</li></ul>
          </div>
        </aside>
      </div>`;

    return {
      title: 'Checkout',
      html,
      after(root) {
        const quoteCard = NB.$('#quoteCard', root);
        const addressList = NB.$('#addressList', root);
        const fulfil = { ...initialFulfil };

        function renderAddressList() {
          addressList.innerHTML = `${addresses.map((a) => addressCard(a, a.id === selectedAddress)).join('')}
            <button class="add-address" id="addAddressBtn">${NB.icon('plus')} Add a new address</button>`;
          bindAddress();
        }

        function bindAddress() {
          NB.$$('input[name="address"]', addressList).forEach((r) => r.addEventListener('change', () => {
            selectedAddress = r.value;
            NB.$$('.address-card', addressList).forEach((c) => c.classList.toggle('is-selected', c.contains(r) && r.checked));
            loadQuote();
          }));
          const add = NB.$('#addAddressBtn', root);
          if (add) add.addEventListener('click', () => NB.addressModal({
            onSaved(a) {
              addresses.push(a);
              selectedAddress = a.id;
              renderAddressList();
              loadQuote();
            }
          }));
        }
        bindAddress();

        // Payment radio visuals
        NB.$$('input[name="payment"]', root).forEach((r) => r.addEventListener('change', () => {
          payment = r.value;
          NB.$$('.pay-option', root).forEach((p) => p.classList.toggle('is-selected', p.contains(r) && r.checked));
        }));

        NB.$$('input[name^="fulfil-"]', root).forEach((r) => r.addEventListener('change', () => {
          const shopId = r.name.replace('fulfil-', '');
          fulfil[shopId] = r.value;
          const map = fulfillmentState(); map[shopId] = r.value; saveFulfillment(map);
          NB.$$('.fulfil-card', root).forEach((card) => card.classList.toggle('is-selected', card.contains(r) && r.checked));
          const group = cart.groups.find((g) => g.shop.id === shopId);
          if (group) group.fulfillment = r.value;
          // pickup-only payment check
          const allPickup = cart.groups.every((g) => fulfil[g.shop.id] === 'pickup');
          const payStore = NB.$('#payAtStore', root);
          payStore.disabled = !allPickup;
          NB.$('#payStoreTag', root).textContent = allPickup ? 'Available' : 'Pickup only';
          if (!allPickup && payment === 'pay_at_store') {
            payment = 'cod';
            NB.$('input[value="cod"]', root).checked = true;
            NB.$$('.pay-option', root).forEach((p) => p.classList.toggle('is-selected', p.contains(NB.$('input[value="cod"]', root))));
            NB.toast('Pay at store needs every shop set to pickup. Switched to cash on delivery.', 'warn');
          }
          loadQuote();
        }));

        NB.$('#orderNote', root).addEventListener('input', (e) => { note = e.target.value; });

        async function loadQuote() {
          quoteCard.innerHTML = `<div class="inline-loading">${NB.spinner()} Recalculating with the server…</div>`;
          try {
            const res = await NB.api('/checkout/quote', { body: { addressId: selectedAddress, fulfillment: fulfil, couponCode: undefined } });
            quote = res.quote;
            renderQuote();
          } catch (err) {
            quote = null;
            quoteCard.innerHTML = `<div class="notice notice--warn">${NB.icon('alert')} ${NB.esc(err.message)}</div><button class="btn btn--ghost btn--block" id="retryQuote">Try again</button>`;
            const btn = NB.$('#retryQuote', quoteCard); if (btn) btn.addEventListener('click', loadQuote);
          }
        }

        function renderQuote() {
          if (!quote) return;
          const allPickup = quote.groups.every((g) => g.fulfillment === 'pickup');
          const payStore = NB.$('#payAtStore', root);
          if (payStore) {
            payStore.disabled = !allPickup;
            NB.$('#payStoreTag', root).textContent = allPickup ? 'Available' : 'Pickup only';
          }
          quoteCard.innerHTML = `
            <h2>Order summary</h2>
            <div class="quote-groups">${quote.groups.map((g) => `
              <div class="quote-group"><div class="quote-group__head"><b>${NB.esc(g.shop.name)}</b><span>${g.fulfillment === 'pickup' ? 'Pickup' : 'Delivery'}</span></div>
                ${g.items.map((i) => `<div class="quote-line"><span>${NB.esc(i.name)} × ${i.qty}</span><span>${NB.money(i.lineTotal)}</span></div>`).join('')}
                <div class="quote-line quote-line--sub"><span>Shop total</span><b>${NB.money(g.total)}</b></div>
              </div>`).join('')}</div>
            <div class="summary-row"><span>Subtotal</span><span>${NB.money(quote.subtotal)}</span></div>
            ${quote.discount ? `<div class="summary-row summary-row--save"><span>Coupon ${quote.coupon ? `(${NB.esc(quote.coupon.code)})` : ''}</span><span>−${NB.money(quote.discount)}</span></div>` : ''}
            <div class="summary-row"><span>Delivery / pickup</span><span>${quote.deliveryFee ? NB.money(quote.deliveryFee) : 'Free'}</span></div>
            <div class="summary-row"><span>Taxes</span><span>${quote.tax ? NB.money(quote.tax) : 'Included'}</span></div>
            <div class="summary-total"><span>Total payable</span><b>${NB.money(quote.total)}</b></div>
            ${quote.issues.length ? `<div class="notice notice--warn notice--tight">${NB.icon('alert')} ${NB.esc(quote.issues[0])}</div>` : ''}
            <button class="btn btn--primary btn--lg btn--block" id="placeOrder" ${quote.issues.length ? 'disabled' : ''}>${NB.icon('shield')} Place order · ${NB.money(quote.total)}</button>
            <div class="summary-trust"><span>${NB.icon('lock')} Server-verified total</span><span>${NB.icon('receipt')} Receipt after order</span></div>
            <p class="fineprint">Placing the order reserves stock for each shop. You can cancel before the shop starts preparing.</p>`;
          NB.$('#placeOrder', quoteCard).addEventListener('click', placeOrder);
        }

        async function placeOrder() {
          if (placing || !quote) return;
          placing = true;
          const btn = NB.$('#placeOrder');
          btn.disabled = true;
          btn.innerHTML = `${NB.spinner()} Placing your order…`;
          try {
            const res = await NB.api('/orders', {
              body: {
                addressId: selectedAddress,
                fulfillment: quote.groups.reduce((acc, g) => { acc[g.shop.id] = g.fulfillment; return acc; }, {}),
                paymentMethod: payment,
                note,
                idempotencyKey
              }
            });
            sessionStorage.removeItem('nb.checkout.key');
            NB.setCounts({ cart: 0 });
            // Online payment is only started when the gateway is actually configured.
            if (payment === 'online' && NB.state.config.payments.onlineEnabled) {
              try {
                const intent = await NB.api('/payments/intent', { body: { orderCode: res.order.code } });
                NB.toast('Opening the secure payment gateway…', 'info');
                openRazorpay(intent, res.order.code);
                return;
              } catch (err) {
                NB.toast(`Order created, but the gateway could not start: ${err.message}. Your order is pending payment.`, 'error');
              }
            }
            NB.hash(`/order-success/${encodeURIComponent(res.order.code)}`);
          } catch (err) {
            placing = false;
            btn.disabled = false;
            btn.innerHTML = `${NB.icon('shield')} Place order · ${NB.money(quote.total)}`;
            if (err.data && err.data.issues) {
              NB.toast(err.data.issues[0], 'error');
              loadQuote();
            } else {
              NB.toast(err.message, 'error');
            }
          }
        }

        loadQuote();
      }
    };
  });

  function openRazorpay(intent, orderCode) {
    const open = () => {
      const rzp = new window.Razorpay({
        key: intent.keyId, amount: intent.amount, currency: intent.currency, name: 'NearBuy',
        description: `Order ${orderCode}`, order_id: intent.gatewayOrderId,
        handler() {
          NB.toast('Payment submitted. We will update the order when the gateway webhook confirms it.', 'info');
          NB.hash(`/orders/${encodeURIComponent(orderCode)}`);
        },
        theme: { color: '#0866D9' }
      });
      rzp.on('payment.failed', () => NB.toast('The gateway reported a failed payment. No money was captured by NearBuy.', 'error'));
      rzp.open();
    };
    if (window.Razorpay) return open();
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = open;
    script.onerror = () => NB.toast('Could not load the payment gateway script. Your order is pending payment.', 'error');
    document.head.appendChild(script);
  }

  /* ---------------------------------------------------------------- */
  /* Order confirmation                                               */
  /* ---------------------------------------------------------------- */
  NB.view(/^\/order-success\/([A-Za-z0-9-]+)$/, async (m) => {
    if (!NB.state.user) return { title: 'Order placed', html: NB.authGate('Sign in to view your order', 'Your order confirmation is available in your account.') };
    const { order } = await NB.api(`/orders/${encodeURIComponent(m[1])}`);
    const html = `
      <div class="wrap success-page">
        <div class="success-card">
          <span class="success-check">${NB.icon('check')}</span>
          <span class="eyebrow">Order placed</span>
          <h1>Thank you — your neighbourhood is on it.</h1>
          <p>We have notified ${order.sellerOrders.length === 1 ? order.sellerOrders[0].shop.name : `${order.sellerOrders.length} shops`} about your order. You will see every status change in real time.</p>
          <div class="success-code"><small>Order number</small><b>${NB.esc(order.code)}</b><button class="link-btn" data-copy="${NB.esc(order.code)}">Copy</button></div>
          <div class="success-meta">
            <div><span>Total</span><b>${NB.money(order.total)}</b></div>
            <div><span>Payment</span><b>${order.paymentMethod === 'cod' ? 'Cash on delivery' : order.paymentMethod === 'pay_at_store' ? 'Pay at store' : 'Online'}</b><small>${NB.esc(order.paymentStatus)}</small></div>
            <div><span>Shop prep time</span><b>~${Math.max(...order.sellerOrders.map((s) => s.prepMinutes))} min</b><small>Starts after seller acceptance</small></div>
          </div>
          <div class="success-shops">${order.sellerOrders.map((s) => `<div class="success-shop"><span class="mini-art tone-${s.shop.tone}">${NB.esc(s.shop.emoji)}</span><div><b>${NB.esc(s.shop.name)}</b><small>${s.items.reduce((t, i) => t + i.qty, 0)} items · ${s.fulfillment === 'pickup' ? 'Pickup' : 'Delivery'} · ${NB.esc(s.statusLabel)}</small></div><b>${NB.money(s.total)}</b></div>`).join('')}</div>
          <div class="success-actions">
            <a class="btn btn--primary btn--lg" href="#/orders/${encodeURIComponent(order.code)}">${NB.icon('package')} Track your order</a>
            <a class="btn btn--ghost btn--lg" href="${order.receiptUrl}" target="_blank" rel="noopener">${NB.icon('receipt')} View receipt</a>
          </div>
          <p class="fineprint">${NB.icon('info')} ${order.isDemo ? 'This sample order is part of the demo dataset. No payment was captured.' : `Payment status: ${NB.esc(order.paymentStatus)}. ${order.paymentMethod === 'online' ? 'An online payment is only confirmed by the gateway.' : 'No payment is captured until handover.'}`} You can cancel before the shop starts preparing.</p>
          <a class="link-arrow" href="#/shops">Continue shopping ${NB.icon('arrowRight')}</a>
        </div>
        <div class="success-next">
          <h2>What happens next</h2>
          <ol class="timeline timeline--preview">
            <li class="is-done"><span></span><div><b>Order placed</b><small>Stock reserved for every shop.</small></div></li>
            <li class="is-done"><span></span><div><b>Sellers notified</b><small>Each shop sees only its own items.</small></div></li>
            <li><span></span><div><b>Seller accepts &amp; prepares</b><small>You can cancel until preparation starts.</small></div></li>
            <li><span></span><div><b>Delivery or pickup</b><small>Delivery needs your 6-digit OTP.</small></div></li>
            <li><span></span><div><b>Delivered &amp; review</b><small>Rate the shop and the products.</small></div></li>
          </ol>
        </div>
      </div>`;
    return { title: `Order ${order.code}`, html };
  });
})();
