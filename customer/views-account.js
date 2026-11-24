/* Account, authentication, wishlist, notifications, support and policies. */
(function () {
  'use strict';
  const NB = window.NB;

  const AVATARS = ['👤', '👩', '🧑', '👨', '👩‍🦱', '🧑‍🦰', '👩‍🦳', '🐱', '🦊', '🌻'];
  const nextFrom = (query) => {
    const raw = query.get('next');
    if (!raw) return '/';
    try {
      let v = decodeURIComponent(raw);
      if (v.startsWith('#')) v = v.slice(1);
      return v.startsWith('/') ? v : '/';
    } catch { return '/'; }
  };

  /* ---------------------------------------------------------------- */
  /* Authentication                                                   */
  /* ---------------------------------------------------------------- */
  const authAside = (variant) => `
    <aside class="auth-aside">
      <a class="auth-aside__brand" href="#/">
        <span class="brand__mark">${NB.LOGO.match(/<svg[\s\S]*<\/svg>/)[0]}</span>
        <span class="brand__text">Near<span>Buy</span></span>
      </a>
      <div class="auth-aside__copy">
        <span class="eyebrow eyebrow--light">Shop Local. Live Better.</span>
        <h2>${variant === 'register' ? 'Your neighbourhood, one account away.' : 'Welcome back to the neighbourhood.'}</h2>
        <p>Compare prices at local shops, choose delivery or pickup per shop, and follow every order from acceptance to your doorstep.</p>
        <ul class="auth-benefits">
          <li>${NB.icon('checkCircle')} Real shops, live stock and seller-set prices</li>
          <li>${NB.icon('checkCircle')} One basket across multiple shops</li>
          <li>${NB.icon('checkCircle')} OTP-verified delivery handover</li>
          <li>${NB.icon('checkCircle')} Receipts, returns and support in one place</li>
        </ul>
      </div>
      <div class="auth-quote">
        <p>“I can see the same milk price at three shops before I leave my building. That is the point of shopping local.”</p>
        <span>Priya S. · Hauz Khas</span>
      </div>
    </aside>`;

  function demoBox() {
    const d = NB.state.demoAccounts;
    if (!d) return '';
    return `<div class="demo-box"><div class="demo-box__head">${NB.icon('info')} Demo environment</div>
      <p>Use a sample customer account, or create your own. Every demo record is labelled.</p>
      <button type="button" class="btn btn--outline btn--sm" id="fillDemo">Fill demo customer sign-in</button>
      <small>${NB.esc(d.customer.email)} / ${NB.esc(d.customer.password)}</small></div>`;
  }

  NB.view(/^\/login$/, async (m, query) => {
    if (NB.state.user) { NB.hash(nextFrom(query)); return { title: 'Signed in', html: '' }; }
    const next = nextFrom(query);
    const html = `<div class="auth-page">
      ${authAside('login')}
      <main class="auth-main">
        <div class="auth-form-wrap">
          <span class="eyebrow">Customer sign in</span>
          <h1>Sign in to NearBuy</h1>
          <p class="auth-lead">Your cart, wishlist and order history are waiting.</p>
          <form id="loginForm" class="auth-form" novalidate>
            <div class="field"><label for="loginId">Email or mobile number</label><div class="input-icon">${NB.icon('user')}<input id="loginId" name="identifier" autocomplete="username" placeholder="you@example.com or 98XXXXXXXX" required/></div></div>
            <div class="field"><label for="loginPw">Password</label><div class="input-icon input-icon--btn">${NB.icon('lock')}<input id="loginPw" name="password" type="password" autocomplete="current-password" placeholder="Your password" required/><button type="button" class="input-eye" data-toggle-pw="loginPw" aria-label="Show password">${NB.icon('eye')}</button></div></div>
            <div class="auth-row"><label class="check"><input type="checkbox" name="remember" checked/><span>Stay signed in for 7 days</span></label><a class="link-btn" href="#/forgot">Forgot password?</a></div>
            <div class="form-error" id="loginError" hidden></div>
            <button class="btn btn--primary btn--lg btn--block" type="submit" id="loginBtn">Sign in</button>
          </form>
          <div class="auth-or" role="separator">or</div>
          <button class="btn btn--block" type="button" id="googleBtn">Continue with Google</button>
          <div class="fineprint" id="googleNote" hidden>${NB.icon('info')} Google sign-in is not configured on this deployment, so no third-party account is created. Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> and register <code>/api/customer/auth/google/callback</code> to switch it on. Email or mobile sign-in works now.</div>
          ${demoBox()}
          <div class="auth-alt">New to NearBuy? <a href="#/register?next=${encodeURIComponent(next)}">Create an account</a></div>
          <p class="fineprint">${NB.icon('lock')} Passwords are hashed with scrypt. Your session is an HttpOnly cookie and every request is checked on the server.</p>
        </div>
      </main>
    </div>`;
    return {
      title: 'Sign in',
      html,
      after(root) {
        const form = NB.$('#loginForm', root);
        const fill = NB.$('#fillDemo', root);
        if (fill) fill.addEventListener('click', () => { form.identifier.value = NB.state.demoAccounts.customer.email; form.password.value = NB.state.demoAccounts.customer.password; form.identifier.focus(); });
        const googleBtn = NB.$('#googleBtn', root);
        if (googleBtn) googleBtn.addEventListener('click', () => {
          const note = NB.$('#googleNote', root);
          note.hidden = !note.hidden;
          googleBtn.setAttribute('aria-expanded', String(!note.hidden));
        });
        NB.$$('[data-toggle-pw]', root).forEach((b) => b.addEventListener('click', () => {
          const input = NB.$('#' + b.dataset.togglePw, root);
          input.type = input.type === 'password' ? 'text' : 'password';
        }));
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const err = NB.$('#loginError', root);
          const btn = NB.$('#loginBtn', root);
          err.hidden = true;
          if (!form.identifier.value.trim() || !form.password.value) { err.textContent = 'Enter your email or mobile number and password.'; err.hidden = false; return; }
          btn.disabled = true; btn.innerHTML = `${NB.spinner()} Signing in…`;
          try {
            const res = await NB.api('/auth/login', { body: { identifier: form.identifier.value.trim(), password: form.password.value, remember: NB.$('input[name="remember"]', root).checked } });
            await NB.refreshBootstrap();
            NB.toast(res.message, 'success');
            NB.hash(next);
          } catch (e2) {
            err.textContent = e2.message; err.hidden = false;
            btn.disabled = false; btn.textContent = 'Sign in';
          }
        });
      }
    };
  });

  NB.view(/^\/register$/, async (m, query) => {
    if (NB.state.user) { NB.hash(nextFrom(query)); return { title: 'Signed in', html: '' }; }
    const next = nextFrom(query);
    const html = `<div class="auth-page">
      ${authAside('register')}
      <main class="auth-main">
        <div class="auth-form-wrap auth-form-wrap--wide">
          <span class="eyebrow">Create your account</span>
          <h1>Join the neighbourhood</h1>
          <p class="auth-lead">Browse without signing in — an account is only needed for checkout, wishlists and reviews.</p>
          <form id="registerForm" class="auth-form" novalidate>
            <div class="field"><label for="regName">Full name *</label><input id="regName" name="name" autocomplete="name" required placeholder="Your full name"/></div>
            <div class="grid-2">
              <div class="field"><label for="regPhone">Mobile number *</label><input id="regPhone" name="phone" inputmode="numeric" autocomplete="tel" required placeholder="10-digit mobile"/></div>
              <div class="field"><label for="regEmail">Email address *</label><input id="regEmail" name="email" type="email" autocomplete="email" required placeholder="you@example.com"/></div>
            </div>
            <div class="grid-2">
              <div class="field"><label for="regPw">Password *</label><div class="input-icon input-icon--btn">${NB.icon('lock')}<input id="regPw" name="password" type="password" autocomplete="new-password" required placeholder="8+ characters"/><button type="button" class="input-eye" data-toggle-pw="regPw">${NB.icon('eye')}</button></div>
                <div class="pw-meter"><i></i><i></i><i></i><i></i></div><small class="field-hint">At least 8 characters with a letter and a number.</small></div>
              <div class="field"><label for="regPw2">Confirm password *</label><div class="input-icon">${NB.icon('lock')}<input id="regPw2" name="confirmPassword" type="password" autocomplete="new-password" required placeholder="Repeat password"/></div></div>
            </div>
            <label class="check"><input type="checkbox" name="terms"/><span>I agree to the <a href="#/page/terms" target="_blank">Terms of Use</a> and <a href="#/page/privacy" target="_blank">Privacy Policy</a>.</span></label>
            <label class="check"><input type="checkbox" name="marketing" checked/><span>Send me local offers and shop news (optional).</span></label>
            <div class="form-error" id="regError" hidden></div>
            <button class="btn btn--primary btn--lg btn--block" type="submit" id="regBtn">Create account</button>
          </form>
          <div class="auth-alt">Already have an account? <a href="#/login?next=${encodeURIComponent(next)}">Sign in</a></div>
          <p class="fineprint">${NB.icon('info')} Email and SMS providers are not configured in this deployment. Verification codes are shown on screen in development so the flow is still testable.</p>
        </div>
      </main>
    </div>`;
    return {
      title: 'Create account',
      html,
      after(root) {
        const form = NB.$('#registerForm', root);
        const pw = NB.$('#regPw', root);
        const meter = NB.$('.pw-meter', root);
        pw.addEventListener('input', () => {
          const v = pw.value;
          const score = [v.length >= 8, /[A-Z]/.test(v), /\d/.test(v), /[^A-Za-z0-9]/.test(v)].filter(Boolean).length;
          NB.$$('i', meter).forEach((bar, i) => bar.classList.toggle('on', i < score));
        });
        NB.$$('[data-toggle-pw]', root).forEach((b) => b.addEventListener('click', () => { const i = NB.$('#' + b.dataset.togglePw, root); i.type = i.type === 'password' ? 'text' : 'password'; }));
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const err = NB.$('#regError', root);
          const btn = NB.$('#regBtn', root);
          err.hidden = true;
          if (form.password.value !== form.confirmPassword.value) { err.textContent = 'The two passwords do not match.'; err.hidden = false; return; }
          if (!form.terms.checked) { err.textContent = 'Please accept the Terms of Use and Privacy Policy.'; err.hidden = false; return; }
          btn.disabled = true; btn.innerHTML = `${NB.spinner()} Creating your account…`;
          try {
            const res = await NB.api('/auth/register', {
              body: { name: NB.$('#regName', root).value.trim(), phone: form.phone.value.trim(), email: form.email.value.trim(), password: form.password.value, confirmPassword: form.confirmPassword.value, terms: form.terms.checked, marketing: form.marketing.checked }
            });
            await NB.refreshBootstrap();
            NB.toast(res.message, 'success');
            NB.hash(next);
          } catch (e2) {
            err.textContent = e2.message; err.hidden = false;
            btn.disabled = false; btn.textContent = 'Create account';
          }
        });
      }
    };
  });

  NB.view(/^\/forgot$/, async () => {
    const html = `<div class="auth-page auth-page--single">
      <main class="auth-main"><div class="auth-form-wrap">
        <a class="back-link" href="#/login">${NB.icon('arrowLeft')} Back to sign in</a>
        <span class="eyebrow">Password help</span>
        <h1>Reset your password</h1>
        <p class="auth-lead">Enter the email on your account. If it exists, we will create a reset link.</p>
        <form id="forgotForm" class="auth-form">
          <div class="field"><label for="forgotEmail">Email address</label><input id="forgotEmail" name="email" type="email" required placeholder="you@example.com"/></div>
          <div class="form-error" id="forgotError" hidden></div>
          <button class="btn btn--primary btn--block" type="submit">Send reset link</button>
        </form>
        <div class="form-success" id="forgotSuccess" hidden></div>
      </div></main></div>`;
    return {
      title: 'Reset password',
      html,
      after(root) {
        const form = NB.$('#forgotForm', root);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const err = NB.$('#forgotError', root);
          const ok = NB.$('#forgotSuccess', root);
          err.hidden = true; ok.hidden = true;
          form.querySelector('button').disabled = true;
          try {
            const res = await NB.api('/auth/forgot', { body: { email: form.email.value.trim() } });
            ok.hidden = false;
            ok.innerHTML = `<p>${NB.icon('mail')} ${NB.esc(res.message)}</p>${res.resetUrl ? `<a class="btn btn--primary btn--sm" href="${NB.esc(res.resetUrl)}">Open development reset link</a><small>Email delivery is not configured. In production this link is only sent by email.</small>` : ''}`;
            form.reset();
          } catch (e2) { err.textContent = e2.message; err.hidden = false; }
          form.querySelector('button').disabled = false;
        });
      }
    };
  });

  NB.view(/^\/reset$/, async (m, query) => {
    const token = query.get('token') || '';
    const html = `<div class="auth-page auth-page--single">
      <main class="auth-main"><div class="auth-form-wrap">
        <span class="eyebrow">Choose a new password</span>
        <h1>Set a new password</h1>
        <p class="auth-lead">Reset links expire after one hour and can be used once.</p>
        <form id="resetForm" class="auth-form">
          <div class="field"><label for="resetPw">New password</label><input id="resetPw" name="password" type="password" required minlength="8" autocomplete="new-password" placeholder="8+ characters with a number"/></div>
          <div class="field"><label for="resetPw2">Confirm new password</label><input id="resetPw2" name="confirmPassword" type="password" required placeholder="Repeat password"/></div>
          <div class="form-error" id="resetError" hidden></div>
          <button class="btn btn--primary btn--block" type="submit">Change password</button>
        </form>
      </div></main></div>`;
    return {
      title: 'New password',
      html,
      after(root) {
        const form = NB.$('#resetForm', root);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const err = NB.$('#resetError', root);
          err.hidden = true;
          if (form.password.value !== form.confirmPassword.value) { err.textContent = 'The two passwords do not match.'; err.hidden = false; return; }
          try {
            const res = await NB.api('/auth/reset', { body: { token, password: form.password.value, confirmPassword: form.confirmPassword.value } });
            NB.toast(res.message, 'success');
            NB.hash('/login');
          } catch (e2) { err.textContent = e2.message; err.hidden = false; }
        });
      }
    };
  });

  /* ---------------------------------------------------------------- */
  /* Account                                                          */
  /* ---------------------------------------------------------------- */
  const accountNav = (active) => [
    ['', 'Overview', 'grid'], ['/profile', 'Profile', 'user'], ['/addresses', 'Addresses', 'location'],
    ['/security', 'Security', 'lock'], ['/reviews', 'My reviews', 'star'], ['/returns', 'Returns & refunds', 'returnArrow']
  ].map(([path, label, icon]) => `<a class="account-nav__link ${active === path ? 'is-active' : ''}" href="#/account${path}">${NB.icon(icon)} <span>${label}</span>${NB.icon('chevronRight')}</a>`).join('') +
    `<div class="account-nav__sep">Shortcuts</div>
     <a class="account-nav__link" href="#/orders">${NB.icon('package')} <span>Orders</span>${NB.icon('chevronRight')}</a>
     <a class="account-nav__link" href="#/wishlist">${NB.icon('heart')} <span>Wishlist</span>${NB.icon('chevronRight')}</a>
     <a class="account-nav__link" href="#/notifications">${NB.icon('bell')} <span>Notifications</span>${NB.icon('chevronRight')}</a>
     <a class="account-nav__link" href="#/help/tickets">${NB.icon('headset')} <span>Support tickets</span>${NB.icon('chevronRight')}</a>
     <button class="account-nav__link account-nav__out" data-action="logout">${NB.icon('logout')} <span>Sign out</span></button>`;

  NB.view(/^\/account(?:\/([a-z-]+))?$/, async (m) => {
    if (!NB.state.user) return { title: 'My account', html: NB.authGate('Sign in to your account', 'Your profile, addresses, reviews, returns and security settings are private to you.') };
    const tab = m[1] || '';
    const data = await NB.api('/account');
    let content = '';
    let title = 'My account';

    if (tab === '' || tab === 'overview') {
      content = `
        <div class="account-welcome">
          <div><span class="eyebrow">Hello, ${NB.esc(data.user.name.split(' ')[0])}</span><h1>Your NearBuy dashboard</h1><p>Everything about your neighbourhood shopping, in one place.</p></div>
          <a class="btn btn--primary" href="#/shops">${NB.icon('bag')} Shop nearby</a>
        </div>
        ${!data.user.emailVerified || !data.user.phoneVerified ? `<div class="notice notice--warn">${NB.icon('alert')} Your ${!data.user.emailVerified ? 'email' : 'mobile number'} is not verified. <a href="#/account/security">Verify now</a> so order updates can reach you.</div>` : ''}
        <div class="stat-grid">
          <a class="stat-card" href="#/orders"><span class="stat-card__ic">${NB.icon('package')}</span><b>${data.counts.orders}</b><span>Total orders</span><small>${data.counts.pending} in progress</small></a>
          <a class="stat-card" href="#/orders?filter=delivered"><span class="stat-card__ic">${NB.icon('checkCircle')}</span><b>${data.counts.completed}</b><span>Completed</span><small>${data.counts.cancelled} cancelled</small></a>
          <a class="stat-card" href="#/wishlist"><span class="stat-card__ic">${NB.icon('heart')}</span><b>${data.counts.wishlist}</b><span>Saved products</span><small>Wishlist</small></a>
          <a class="stat-card" href="#/account/returns"><span class="stat-card__ic">${NB.icon('returnArrow')}</span><b>${data.counts.returns}</b><span>Returns</span><small>${data.counts.reviews} reviews written</small></a>
        </div>
        <div class="account-columns">
          <section class="panel">
            <div class="panel__head"><h2>Recent orders</h2><a class="link-arrow" href="#/orders">All orders ${NB.icon('arrowRight')}</a></div>
            ${data.recentOrders.length ? data.recentOrders.map((o) => `<a class="mini-order" href="#/orders/${encodeURIComponent(o.code)}"><div><b>${NB.esc(o.code)}</b><small>${NB.dateTime(o.createdAt)} · ${o.shops.map((s) => s.shop?.name).filter(Boolean).join(', ')}</small></div><div class="mini-order__right">${NB.statusPill(o.status, o.statusLabel)}<b>${NB.money(o.total)}</b></div></a>`).join('') : `<div class="empty empty--sm"><p>No orders yet. Your local shops are ready when you are.</p><a class="btn btn--outline btn--sm" href="#/shops">Browse shops</a></div>`}
          </section>
          <section class="panel">
            <div class="panel__head"><h2>Saved addresses</h2><a class="link-arrow" href="#/account/addresses">Manage ${NB.icon('arrowRight')}</a></div>
            ${data.addressesPreview.length ? data.addressesPreview.map((a) => `<div class="mini-address"><span class="mini-art tone-blue">${NB.icon('location')}</span><div><b>${NB.esc(a.label)}${a.isDefault ? ' · Default' : ''}</b><small>${NB.esc([a.line1, a.locality, a.pincode].join(', '))}</small></div></div>`).join('') : `<div class="empty empty--sm"><p>No saved address yet.</p><button class="btn btn--outline btn--sm" id="overviewAddAddress">Add address</button></div>`}
            <div class="panel__links"><a href="#/account/security">${NB.icon('lock')} Security &amp; sessions</a><a href="#/help/tickets">${NB.icon('headset')} Support tickets${data.counts.tickets ? ` (${data.counts.tickets})` : ''}</a></div>
          </section>
        </div>`;
      title = 'My account';
    }

    if (tab === 'profile') {
      content = `<div class="account-welcome"><div><span class="eyebrow">Profile</span><h1>Personal details</h1><p>How you appear on NearBuy, and how shops can reach you about an order.</p></div></div>
        <div class="account-columns account-columns--even">
          <section class="panel">
            <div class="panel__head"><h2>Your details</h2></div>
            <form id="profileForm" class="stack">
              <div class="field"><label>Profile picture</label><div class="avatar-picker" id="avatarPicker">${AVATARS.map((a) => `<button type="button" class="avatar-opt ${data.user.avatar === a ? 'is-active' : ''}" data-avatar="${a}">${a}</button>`).join('')}</div></div>
              <div class="field"><label for="pName">Full name</label><input id="pName" name="name" value="${NB.esc(data.user.name)}" required/></div>
              <div class="field"><label>Email address</label><div class="locked-field">${NB.icon('mail')}<span>${NB.esc(data.user.email)}</span>${data.user.emailVerified ? '<em class="ok">Verified</em>' : '<em class="warn">Not verified</em>'}<button type="button" class="link-btn" data-change-contact="email">Change</button></div></div>
              <div class="field"><label>Mobile number</label><div class="locked-field">${NB.icon('phone')}<span>${NB.esc(data.user.phone)}</span>${data.user.phoneVerified ? '<em class="ok">Verified</em>' : '<em class="warn">Not verified</em>'}<button type="button" class="link-btn" data-change-contact="phone">Change</button></div></div>
              <div class="form-error" id="profileError" hidden></div>
              <button class="btn btn--primary" type="submit">Save changes</button>
            </form>
          </section>
          <section class="panel">
            <div class="panel__head"><h2>Communication preferences</h2></div>
            <label class="switch-row"><span><b>Order updates</b><small>Status changes, delivery OTP and support replies.</small></span><input type="checkbox" id="prefOrders" ${data.user.orderUpdates ? 'checked' : ''}/></label>
            <label class="switch-row"><span><b>Local offers</b><small>Occasional deals from nearby shops. No spam.</small></span><input type="checkbox" id="prefMarketing" ${data.user.marketingOptIn ? 'checked' : ''}/></label>
            <div class="notice notice--info notice--tight">${NB.icon('info')} No SMS or email provider is configured in this deployment. Notifications are stored in your in-app notification centre; external delivery would need a provider.</div>
            <div class="panel__links"><a href="#/account/security">${NB.icon('lock')} Password &amp; sessions</a><a href="#/page/privacy">${NB.icon('shield')} Privacy policy</a></div>
          </section>
        </div>`;
      title = 'Profile';
    }

    if (tab === 'addresses') {
      content = `<div class="account-welcome"><div><span class="eyebrow">Addresses</span><h1>Saved addresses</h1><p>Delivery addresses for home, work and everywhere else.</p></div><button class="btn btn--primary" id="addAddress">${NB.icon('plus')} Add address</button></div>
        <div class="address-grid" id="addressGrid">${data.addresses.length ? data.addresses.map((a) => `
          <div class="saved-address ${a.isDefault ? 'is-default' : ''}">
            <div class="saved-address__head"><span class="mini-art tone-blue">${NB.icon(a.label === 'Work' ? 'store' : 'home')}</span><div><b>${NB.esc(a.label)}</b>${a.isDefault ? '<em>Default</em>' : ''}</div></div>
            <p><b>${NB.esc(a.receiver)}</b><br>${NB.esc([a.line1, a.line2, a.locality, a.city, a.pincode].filter(Boolean).join(', '))}<br>${NB.esc(a.phone)}</p>
            ${a.landmark ? `<small>${NB.icon('location')} ${NB.esc(a.landmark)}</small>` : ''}
            ${a.instructions ? `<small>${NB.icon('info')} ${NB.esc(a.instructions)}</small>` : ''}
            <div class="saved-address__actions">
              <button class="link-btn" data-edit="${a.id}">${NB.icon('pen')} Edit</button>
              ${!a.isDefault ? `<button class="link-btn" data-default="${a.id}">Make default</button>` : ''}
              <button class="link-btn link-btn--danger" data-delete-address="${a.id}">Delete</button>
            </div>
          </div>`).join('') : `<div class="empty"><span class="empty__ic">${NB.icon('location')}</span><h3>No saved addresses</h3><p>Add one to see which shops deliver to you and speed up checkout.</p><button class="btn btn--primary" id="addAddressEmpty">Add your first address</button></div>`}</div>`;
      title = 'Addresses';
    }

    if (tab === 'security') {
      const sessions = await NB.api('/account/sessions');
      content = `<div class="account-welcome"><div><span class="eyebrow">Security</span><h1>Password &amp; sessions</h1><p>Control how your account is protected and where it is signed in.</p></div></div>
        <div class="account-columns account-columns--even">
          <section class="panel">
            <div class="panel__head"><h2>Change password</h2></div>
            <form id="passwordForm" class="stack">
              <div class="field"><label for="curPw">Current password</label><input id="curPw" name="current" type="password" autocomplete="current-password" required/></div>
              <div class="field"><label for="newPw">New password</label><input id="newPw" name="password" type="password" autocomplete="new-password" required minlength="8"/><small class="field-hint">At least 8 characters, including a letter and a number.</small></div>
              <div class="field"><label for="newPw2">Confirm new password</label><input id="newPw2" name="confirm" type="password" required/></div>
              <div class="form-error" id="pwError" hidden></div>
              <button class="btn btn--primary" type="submit">Update password</button>
            </form>
          </section>
          <section class="panel">
            <div class="panel__head"><h2>Verification</h2></div>
            <div class="verify-row"><div><b>Email</b><small>${NB.esc(data.user.email)}</small></div>${data.user.emailVerified ? '<span class="pill pill--success"><i></i>Verified</span>' : '<button class="btn btn--outline btn--sm" data-verify="email">Verify</button>'}</div>
            <div class="verify-row"><div><b>Mobile</b><small>${NB.esc(data.user.phone)}</small></div>${data.user.phoneVerified ? '<span class="pill pill--success"><i></i>Verified</span>' : '<button class="btn btn--outline btn--sm" data-verify="phone">Verify</button>'}</div>
            <div class="notice notice--info notice--tight">${NB.icon('info')} No SMS or email provider is configured. In development, the one-time code is displayed here after you request it; it is stored only as a hash on the server.</div>
          </section>
        </div>
        <section class="panel" style="margin-top:20px">
          <div class="panel__head"><h2>Signed-in sessions</h2><button class="link-btn link-btn--danger" id="revokeAll">Sign out all other devices</button></div>
          <div class="session-list">${sessions.sessions.map((s) => `<div class="session-row"><span class="mini-art">${NB.icon('user')}</span><div><b>${s.current ? 'This device' : 'Other device'}</b><small>${NB.esc(s.device.slice(0, 90))} · signed in ${NB.dateTime(s.createdAt)}</small></div>${s.current ? '<span class="pill pill--success">Current</span>' : `<button class="link-btn" data-revoke="${s.id}">Sign out</button>`}</div>`).join('')}</div>
        </section>`;
      title = 'Security';
    }

    if (tab === 'reviews') {
      const reviews = await NB.api('/reviews/mine');
      content = `<div class="account-welcome"><div><span class="eyebrow">My reviews</span><h1>Reviews you have written</h1><p>Verified reviews help neighbours choose local shops with confidence.</p></div></div>
        ${reviews.reviews.length ? `<div class="review-grid">${reviews.reviews.map((r) => `<article class="review review--card">
          <div class="review__head"><span class="mini-art tone-blue">${NB.esc(r.product?.emoji || r.shop.name.charAt(0))}</span><div><b>${NB.esc(r.product?.name || r.shop.name)}</b><small>${NB.esc(r.shop.name)} · ${NB.date(r.at)}</small></div><span class="stars stars--sm">${Array.from({ length: 5 }).map((_, i) => `<i class="${i < r.rating ? 'on' : ''}">${NB.icon('star')}</i>`).join('')}</span></div>
          <h4>${NB.esc(r.title || 'Verified review')}</h4><p>${NB.esc(r.body)}</p>
          <div class="review__foot"><span class="pill pill--${r.status === 'published' ? 'success' : 'warn'}">${NB.esc(r.status)}</span>${r.verified ? '<span class="verified-tag">Verified purchase</span>' : ''}</div></article>`).join('')}</div>`
          : `<div class="empty"><span class="empty__ic">${NB.icon('star')}</span><h3>No reviews yet</h3><p>Reviews open after an order is delivered. Rate the shop and the products you actually bought.</p><a class="btn btn--primary" href="#/orders">Go to my orders</a></div>`}`;
      title = 'My reviews';
    }

    if (tab === 'returns') {
      const ret = await NB.api('/returns');
      content = `<div class="account-welcome"><div><span class="eyebrow">Returns &amp; refunds</span><h1>Returns and refunds</h1><p>Every request, decision and refund status is recorded.</p></div><a class="btn btn--ghost" href="#/page/returns">Return policy</a></div>
        ${ret.returns.length ? `<div class="returns-list">${ret.returns.map((r) => `<article class="return-card">
          <div class="return-card__head"><div><b>${NB.esc(r.code)}</b><small>${NB.dateTime(r.createdAt)} · ${NB.esc(r.orderCode)} · ${NB.esc(r.shop?.name || '')}</small></div>${NB.statusPill(r.status === 'completed' ? 'returned' : 'return_requested', r.status.replace(/_/g, ' '))}</div>
          <div class="return-card__body"><span class="mini-art">${NB.esc(r.item.emoji || '📦')}</span><div><b>${NB.esc(r.item.name)} × ${r.item.qty}</b><small>${NB.esc(r.reason)}${r.comment ? ' · ' + NB.esc(r.comment) : ''}</small></div><b>${NB.money(r.amount)}</b></div>
          <div class="return-progress">${['requested', 'under_review', 'approved', 'processing', 'completed'].map((s, i) => `<span class="${['requested', 'under_review', 'approved', 'processing', 'completed'].indexOf(r.status) >= i ? 'is-done' : ''}">${s.replace(/_/g, ' ')}</span>`).join('')}</div>
          ${r.decisionNote ? `<p class="fineprint">${NB.icon('info')} ${NB.esc(r.decisionNote)}</p>` : ''}
        </article>`).join('')}</div>` : `<div class="empty"><span class="empty__ic">${NB.icon('returnArrow')}</span><h3>No returns requested</h3><p>If something arrives damaged or wrong, open the delivered order and choose “Return an item”.</p><a class="btn btn--primary" href="#/orders?filter=delivered">View delivered orders</a></div>`}
        ${ret.refunds.length ? `<section class="panel" style="margin-top:22px"><div class="panel__head"><h2>Refund records</h2></div>
          <table class="data-table"><thead><tr><th>Raised</th><th>Amount</th><th>Status</th><th>Reference</th></tr></thead><tbody>${ret.refunds.map((f) => `<tr><td>${NB.dateTime(f.at)}</td><td><b>${NB.money(f.amount)}</b></td><td><span class="pill pill--${f.status === 'completed' ? 'success' : f.status === 'rejected' ? 'danger' : 'warn'}">${NB.esc(f.status.replace(/_/g, ' '))}</span></td><td>${NB.esc(f.reference || 'Pending from provider')}</td></tr>`).join('')}</tbody></table></section>` : ''}`;
      title = 'Returns & refunds';
    }

    const html = `
      <div class="page-hero page-hero--compact"><div class="wrap">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<span>My account</span></nav>
        <div class="page-hero__row"><div><span class="eyebrow">My account</span><h1>${NB.esc(data.user.name)}</h1><p>${NB.esc(data.user.email)} · ${NB.esc(data.user.phone)}</p></div>
          <div class="account-head-badges"><span class="avatar avatar--lg">${NB.esc(data.user.avatar || '👤')}</span><span class="pill pill--${data.user.emailVerified && data.user.phoneVerified ? 'success' : 'warn'}">${data.user.emailVerified && data.user.phoneVerified ? 'Verified customer' : 'Verification pending'}</span></div></div>
      </div></div>
      <div class="wrap account-page">
        <aside class="account-nav">${accountNav(tab ? '/' + tab : '')}</aside>
        <div class="account-content">${content}</div>
      </div>`;

    return {
      title,
      html,
      after(root) {
        const add = NB.$('#addAddress', root) || NB.$('#addAddressEmpty', root) || NB.$('#overviewAddAddress', root);
        if (add) add.addEventListener('click', () => NB.addressModal({ onSaved() { NB.render(); } }));
        NB.$$('[data-edit]', root).forEach((b) => b.addEventListener('click', () => {
          const a = data.addresses.find((x) => x.id === b.dataset.edit);
          NB.addressModal({ address: a, onSaved() { NB.render(); } });
        }));
        NB.$$('[data-default]', root).forEach((b) => b.addEventListener('click', async () => {
          try { const res = await NB.api(`/addresses/${b.dataset.default}/default`, { method: 'POST' }); NB.toast(res.message, 'success'); NB.render(); } catch (e) { NB.toast(e.message, 'error'); }
        }));
        NB.$$('[data-delete-address]', root).forEach((b) => b.addEventListener('click', () => NB.confirm({
          title: 'Delete this address?', message: 'You can add it again later. Active orders keep their own copy of the address.', confirmLabel: 'Delete address', danger: true,
          async onConfirm() {
            try { const res = await NB.api(`/addresses/${b.dataset.deleteAddress}`, { method: 'DELETE' }); NB.toast(res.message, 'success'); NB.render(); } catch (e) { NB.toast(e.message, 'error'); }
          }
        })));
        // avatar picker
        const picker = NB.$('#avatarPicker', root);
        if (picker) NB.$$('[data-avatar]', picker).forEach((b) => b.addEventListener('click', () => {
          NB.$$('[data-avatar]', picker).forEach((x) => x.classList.toggle('is-active', x === b));
        }));
        const profile = NB.$('#profileForm', root);
        if (profile) profile.addEventListener('submit', async (e) => {
          e.preventDefault();
          const err = NB.$('#profileError', root);
          err.hidden = true;
          try {
            const avatar = NB.$('.avatar-opt.is-active', picker)?.dataset.avatar || data.user.avatar;
            const res = await NB.api('/account', { method: 'PATCH', body: { name: NB.$('#pName', root).value.trim(), avatar } });
            NB.state.user = { ...NB.state.user, ...res.user };
            NB.toast(res.message, 'success');
            NB.render();
          } catch (e2) { err.textContent = e2.message; err.hidden = false; }
        });
        const prefO = NB.$('#prefOrders', root); const prefM = NB.$('#prefMarketing', root);
        [prefO, prefM].filter(Boolean).forEach((el) => el.addEventListener('change', async () => {
          try {
            await NB.api('/account', { method: 'PATCH', body: { orderUpdates: prefO ? prefO.checked : true, marketingOptIn: prefM ? prefM.checked : false } });
            NB.toast('Communication preferences saved.', 'success');
          } catch (e) { NB.toast(e.message, 'error'); }
        }));
        NB.$$('[data-change-contact]', root).forEach((b) => b.addEventListener('click', () => openContactModal(b.dataset.changeContact, data.user)));
        NB.$$('[data-verify]', root).forEach((b) => b.addEventListener('click', () => openVerifyModal(b.dataset.verify)));
        // password
        const pwForm = NB.$('#passwordForm', root);
        if (pwForm) pwForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const err = NB.$('#pwError', root);
          err.hidden = true;
          if (pwForm.password.value !== pwForm.confirm.value) { err.textContent = 'The new passwords do not match.'; err.hidden = false; return; }
          try {
            const res = await NB.api('/account/password', { body: { current: pwForm.current.value, password: pwForm.password.value, confirm: pwForm.confirm.value } });
            NB.toast(res.message, 'success'); pwForm.reset();
          } catch (e2) { err.textContent = e2.message; err.hidden = false; }
        });
        NB.$$('[data-revoke]', root).forEach((b) => b.addEventListener('click', async () => {
          try { await NB.api('/account/sessions/revoke', { body: { id: b.dataset.revoke } }); NB.toast('Session ended.', 'success'); NB.render(); } catch (e) { NB.toast(e.message, 'error'); }
        }));
        const revokeAll = NB.$('#revokeAll', root);
        if (revokeAll) revokeAll.addEventListener('click', () => NB.confirm({
          title: 'Sign out other devices?', message: 'Your current session stays signed in. Every other device must sign in again.', confirmLabel: 'Sign out others', danger: true,
          async onConfirm() {
            await NB.api('/account/sessions/revoke', { body: { all: true } });
            NB.toast('Other sessions ended.', 'success');
            NB.refreshBootstrap();
          }
        }));
      }
    };
  });

  function openVerifyModal(channel) {
    const m = NB.modal({
      title: `Verify your ${channel === 'phone' ? 'mobile number' : 'email'}`,
      body: `<p class="muted">Request a one-time code. No ${channel === 'phone' ? 'SMS' : 'email'} provider is configured, but the secure code flow still runs on the server.</p>
        <div id="verifyStart"><button class="btn btn--primary btn--block" id="sendCode">Send code</button></div>
        <div id="verifyStep" hidden>
          <div class="notice notice--info notice--tight" id="devCode"></div>
          <div class="field"><label for="otpCode">6-digit code</label><input id="otpCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"/></div>
          <div class="form-error" id="verifyError" hidden></div>
          <button class="btn btn--primary btn--block" id="confirmCode">Verify</button>
        </div>`,
      footer: false,
      onMount(root, close) {
        NB.$('#sendCode', root).addEventListener('click', async () => {
          try {
            const res = await NB.api('/auth/verify/request', { body: { channel } });
            NB.$('#verifyStart', root).hidden = true;
            NB.$('#verifyStep', root).hidden = false;
            NB.$('#devCode', root).innerHTML = `${NB.icon('info')} ${NB.esc(res.message)}${res.devCode ? `<br><b>Development code: ${res.devCode}</b>` : ''}`;
          } catch (e) { NB.toast(e.message, 'error'); }
        });
        NB.$('#confirmCode', root).addEventListener('click', async () => {
          const err = NB.$('#verifyError', root);
          err.hidden = true;
          try {
            const res = await NB.api('/auth/verify/confirm', { body: { channel, code: NB.$('#otpCode', root).value.trim() } });
            await NB.refreshBootstrap();
            close();
            NB.toast(res.message, 'success');
            NB.render();
          } catch (e) { err.textContent = e.message; err.hidden = false; }
        });
      }
    });
    return m;
  }

  function openContactModal(channel, user) {
    const label = channel === 'phone' ? 'mobile number' : 'email address';
    const m = NB.modal({
      title: `Change your ${label}`,
      body: `<form id="contactForm" class="stack">
        <div class="field"><label for="newContact">New ${label}</label><input id="newContact" name="value" required placeholder="${channel === 'phone' ? '10-digit mobile' : 'you@example.com'}"/></div>
        <div class="notice notice--info notice--tight">${NB.icon('shield')} The new ${label} is only applied after the one-time code is verified.</div>
        <div class="form-error" id="contactError" hidden></div>
        <button class="btn btn--primary btn--block" type="submit">Send verification code</button>
      </form>
      <div id="contactCode" hidden>
        <div class="notice notice--info notice--tight" id="contactDev"></div>
        <div class="field"><label for="contactOtp">6-digit code</label><input id="contactOtp" inputmode="numeric" maxlength="6" placeholder="000000"/></div>
        <div class="form-error" id="contactError2" hidden></div>
        <button class="btn btn--primary btn--block" id="confirmContact">Confirm change</button>
      </div>`,
      footer: false,
      onMount(root, close) {
        const form = NB.$('#contactForm', root);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const err = NB.$('#contactError', root);
          err.hidden = true;
          try {
            const body = channel === 'phone' ? { phone: form.value.value.trim() } : { email: form.value.value.trim() };
            const res = await NB.api(`/account/${channel}/request`, { body });
            form.hidden = true;
            NB.$('#contactCode', root).hidden = false;
            NB.$('#contactDev', root).innerHTML = `${NB.icon('info')} ${NB.esc(res.message)}${res.devCode ? `<br><b>Development code: ${res.devCode}</b>` : ''}`;
          } catch (e2) { err.textContent = e2.message; err.hidden = false; }
        });
        NB.$('#confirmContact', root).addEventListener('click', async () => {
          const err = NB.$('#contactError2', root);
          err.hidden = true;
          try {
            const res = await NB.api(`/account/${channel}/confirm`, { body: { code: NB.$('#contactOtp', root).value.trim() } });
            await NB.refreshBootstrap();
            close();
            NB.toast(res.message, 'success');
            NB.render();
          } catch (e) { err.textContent = e.message; err.hidden = false; }
        });
      }
    });
    return m;
  }

  /* ---------------------------------------------------------------- */
  /* Wishlist                                                          */
  /* ---------------------------------------------------------------- */
  NB.view(/^\/wishlist$/, async () => {
    if (!NB.state.user) return { title: 'Wishlist', html: NB.authGate('Sign in to see your wishlist', 'Save products from any nearby shop and come back to them later.') };
    const data = await NB.api(`/wishlist?${NB.locationQuery()}`);
    const html = `
      <div class="page-hero page-hero--compact"><div class="wrap">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<span>Wishlist</span></nav>
        <div class="page-hero__row"><div><span class="eyebrow">Saved for later</span><h1>My wishlist</h1><p>${data.count ? `${NB.plural(data.count, 'product')} saved from nearby shops.` : 'Products you save will appear here.'}</p></div>
          ${data.products.length ? `<button class="btn btn--primary" id="addAllWish">${NB.icon('cart')} Add all to basket</button>` : ''}</div>
      </div></div>
      <div class="wrap section">
        ${data.products.length ? `<div class="product-grid">${data.products.map((p) => NB.productCard(p, { wished: true })).join('')}</div>` : NB.empty({ icon: 'heart', title: 'Your wishlist is empty', body: 'Tap the heart on any product to save it here — prices and stock stay live.', cta: '#/shops', ctaLabel: 'Discover products' })}
      </div>`;
    return {
      title: 'Wishlist',
      html,
      after(root) {
        const all = NB.$('#addAllWish', root);
        if (all) all.addEventListener('click', async () => {
          all.disabled = true;
          for (const p of data.products) { if (p.available) await NB.addToCart(p.id, 1); }
          all.disabled = false;
        });
      }
    };
  });

  /* ---------------------------------------------------------------- */
  /* Notifications                                                     */
  /* ---------------------------------------------------------------- */
  NB.view(/^\/notifications$/, async () => {
    if (!NB.state.user) return { title: 'Notifications', html: NB.authGate('Sign in for notifications', 'Order updates, refunds and support replies stay in your notification centre.') };
    const data = await NB.api('/notifications');
    const iconFor = (type) => ({ order: 'package', payment: 'wallet', refund: 'returnArrow', offer: 'tag', support: 'headset', review: 'star', runner: 'truck', account: 'user', seller: 'store' }[type] || 'bell');
    const html = `
      <div class="page-hero page-hero--compact"><div class="wrap">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<span>Notifications</span></nav>
        <div class="page-hero__row"><div><span class="eyebrow">Notification centre</span><h1>Updates</h1><p>${data.unread ? `${data.unread} unread update${data.unread === 1 ? '' : 's'}.` : 'You are all caught up.'}</p></div>
          ${data.notifications.length ? `<button class="btn btn--ghost" id="markAllRead">${NB.icon('check')} Mark all as read</button>` : ''}</div>
      </div></div>
      <div class="wrap section">
        ${data.notifications.length ? `<div class="notif-list">${data.notifications.map((n) => `
          <a class="notif ${n.read ? '' : 'is-unread'}" href="${n.link || '#/orders'}" data-notif="${n.id}">
            <span class="notif__ic">${NB.icon(iconFor(n.type))}</span>
            <div><b>${NB.esc(n.title)}</b><p>${NB.esc(n.body)}</p><small>${NB.timeAgo(n.at)}${n.read ? '' : ' · New'}</small></div>
            ${NB.icon('chevronRight')}
          </a>`).join('')}</div>` : NB.empty({ icon: 'bell', title: 'No notifications yet', body: 'Order status changes, refunds and support replies will appear here.', cta: '#/orders', ctaLabel: 'View my orders' })}
        <p class="fineprint">${NB.icon('info')} In-app notifications are database records. SMS, email and WhatsApp delivery require a configured provider and are never claimed as sent.</p>
      </div>`;
    return {
      title: 'Notifications',
      html,
      after(root) {
        const mark = NB.$('#markAllRead', root);
        if (mark) mark.addEventListener('click', async () => {
          try { await NB.api('/notifications/read', { body: { all: true } }); NB.setCounts({ unread: 0 }); NB.toast('All notifications marked as read.', 'success'); NB.render(); } catch (e) { NB.toast(e.message, 'error'); }
        });
        NB.$$('[data-notif]', root).forEach((a) => a.addEventListener('click', () => {
          NB.api('/notifications/read', { body: { ids: [Number(a.dataset.notif)] } }).catch(() => {});
          NB.setCounts({ unread: Math.max(0, (NB.state.counts.unread || 1) - 1) });
        }));
      }
    };
  });

  /* ---------------------------------------------------------------- */
  /* Help & support                                                    */
  /* ---------------------------------------------------------------- */
  const SUPPORT_CATEGORIES = [
    ['order', 'Order issue', 'package'], ['payment', 'Payment problem', 'wallet'], ['delivery', 'Delayed delivery', 'truck'],
    ['missing', 'Missing items', 'basket'], ['damaged', 'Damaged product', 'alert'], ['wrong', 'Wrong product', 'refresh'],
    ['return', 'Returns & refunds', 'returnArrow'], ['shop', 'Shop complaint', 'store'], ['account', 'Account issue', 'user'], ['other', 'Something else', 'chat']
  ];

  NB.view(/^\/help$/, async (m, query) => {
    const orderCode = query.get('order') || '';
    const { faqs } = await NB.api('/faqs');
    const faqCats = [...new Set(faqs.map((f) => f.category))];
    const html = `
      <div class="help-hero"><div class="wrap">
        <nav class="crumbs crumbs--light" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<span>Help &amp; support</span></nav>
        <span class="eyebrow eyebrow--light">Help &amp; support</span>
        <h1>How can we help?</h1>
        <p>Search the answers, raise a ticket, or read exactly how returns, refunds and delivery verification work.</p>
        <div class="help-search">${NB.icon('search')}<input id="faqSearch" placeholder="Search help — “refund”, “OTP”, “cancel”…" aria-label="Search FAQs"/></div>
        <div class="help-quick">
          <a href="#/help/tickets">${NB.icon('receipt')}<span>My tickets</span></a>
          <a href="#/orders">${NB.icon('package')}<span>Track an order</span></a>
          <a href="#/account/returns">${NB.icon('returnArrow')}<span>Returns &amp; refunds</span></a>
          <a href="#/page/cancellation">${NB.icon('close')}<span>Cancellation policy</span></a>
        </div>
      </div></div>
      <div class="wrap help-page">
        <section>
          <div class="cat-grid cat-grid--help">
            ${SUPPORT_CATEGORIES.slice(0, 8).map(([key, label, icon]) => `<button class="help-cat" data-help-cat="${key}"><span class="cat-ic tone-blue">${NB.icon(icon)}</span><b>${NB.esc(label)}</b></button>`).join('')}
          </div>
          <div class="section-head section-head--sm" style="margin-top:34px"><div><span class="eyebrow">Answers</span><h2>Frequently asked questions</h2></div>
            <div class="faq-filters">${['All', ...faqCats].map((c, i) => `<button class="chip ${i === 0 ? 'is-active' : ''}" data-faq-cat="${c}">${NB.esc(c)}</button>`).join('')}</div></div>
          <div class="faq-list" id="faqList">
            ${faqs.map((f) => `<details class="faq" data-cat="${NB.esc(f.category)}"><summary>${NB.esc(f.question)} ${NB.icon('chevronDown')}</summary><p>${NB.esc(f.answer)}</p></details>`).join('')}
          </div>
          <div class="empty" id="faqEmpty" hidden><span class="empty__ic">${NB.icon('search')}</span><h3>No answer matches</h3><p>Raise a ticket below and a support agent can look at your specific order.</p></div>
        </section>

        <aside class="help-side">
          <section class="panel" id="ticketPanel">
            <div class="panel__head"><h2>Raise a support ticket</h2><span class="pill pill--info">${NB.icon('chat')} Written trail</span></div>
            ${NB.state.user ? `<form id="ticketForm" class="stack">
              <div class="field"><label for="ticketCat">Category *</label><select id="ticketCat" name="category" required>${SUPPORT_CATEGORIES.map(([k, l]) => `<option value="${k}">${NB.esc(l)}</option>`).join('')}</select></div>
              <div class="field"><label for="ticketOrder">Order code (optional)</label><input id="ticketOrder" name="orderCode" value="${NB.esc(orderCode)}" placeholder="NB-261119-1234"/></div>
              <div class="field"><label for="ticketSubject">Subject *</label><input id="ticketSubject" name="subject" required minlength="5" maxlength="120" placeholder="Short summary"/></div>
              <div class="field"><label for="ticketDesc">Description *</label><textarea id="ticketDesc" name="description" rows="5" required minlength="20" maxlength="2000" placeholder="What happened? Include items and timings if relevant."></textarea></div>
              <div class="field"><label>Photo (optional)</label><input type="file" id="ticketFile" accept="image/png,image/jpeg,image/webp"/><small class="field-hint">Small images only (under 140 KB).</small></div>
              <div class="form-error" id="ticketError" hidden></div>
              <button class="btn btn--primary btn--block" type="submit" id="ticketBtn">Create ticket</button>
            </form>` : `<div class="empty empty--sm"><span class="empty__ic">${NB.icon('lock')}</span><h3>Sign in to raise a ticket</h3><p>Tickets are tied to your account so you can follow replies.</p><a class="btn btn--primary btn--sm" href="#/login?next=${encodeURIComponent('#/help')}">Sign in</a></div>`}
            <div class="ticket-created" id="ticketCreated" hidden></div>
          </section>
          <section class="panel panel--soft">
            <h3>${NB.icon('headset')} Contact NearBuy</h3>
            <p class="fineprint">Support hours 9:00–21:00 IST. No phone line is connected in this prototype; use the written ticket flow so nothing is lost.</p>
            <div class="contact-lines"><span>${NB.icon('mail')} support@nearbuy.example</span><span>${NB.icon('phone')} 011-4000 0000 (demo)</span><span>${NB.icon('location')} Hauz Khas, New Delhi</span></div>
          </section>
          <section class="panel panel--soft">
            <h3>Guest enquiry</h3>
            <p class="fineprint">Not signed in? Leave a message and we will log it as an enquiry.</p>
            <form id="enquiryForm" class="stack">
              <div class="field"><label for="enqName">Name</label><input id="enqName" name="name" required placeholder="Your name"/></div>
              <div class="field"><label for="enqContact">Email or mobile</label><input id="enqContact" name="contact" required placeholder="How can we reply?"/></div>
              <div class="field"><label for="enqTopic">Topic</label><input id="enqTopic" name="topic" value="General assistance" required/></div>
              <div class="field"><label for="enqMessage">Message</label><textarea id="enqMessage" name="message" rows="3" required minlength="10" placeholder="How can we help?"></textarea></div>
              <div class="form-error" id="enqError" hidden></div>
              <button class="btn btn--outline btn--block" type="submit">Send enquiry</button>
            </form>
            <div class="form-success" id="enqSuccess" hidden></div>
          </section>
        </aside>
      </div>`;

    return {
      title: 'Help & support',
      html,
      after(root) {
        const search = NB.$('#faqSearch', root);
        const faqList = NB.$('#faqList', root);
        const empty = NB.$('#faqEmpty', root);
        let cat = 'All';
        const filter = () => {
          const term = search.value.trim().toLowerCase();
          let shown = 0;
          NB.$$('.faq', faqList).forEach((f) => {
            const matchTerm = !term || f.textContent.toLowerCase().includes(term);
            const matchCat = cat === 'All' || f.dataset.cat === cat;
            f.hidden = !(matchTerm && matchCat);
            if (!f.hidden) shown += 1;
          });
          empty.hidden = shown > 0;
        };
        search.addEventListener('input', filter);
        NB.$$('[data-faq-cat]', root).forEach((b) => b.addEventListener('click', () => {
          NB.$$('[data-faq-cat]', root).forEach((x) => x.classList.toggle('is-active', x === b));
          cat = b.dataset.faqCat;
          filter();
        }));
        NB.$$('[data-help-cat]', root).forEach((b) => b.addEventListener('click', () => {
          const select = NB.$('#ticketCat', root);
          if (select) { select.value = b.dataset.helpCat; NB.$('#ticketPanel', root).scrollIntoView({ behavior: 'smooth', block: 'start' }); }
          else NB.toast('Sign in to raise a ticket about this issue.', 'info');
        }));

        const ticketForm = NB.$('#ticketForm', root);
        if (ticketForm) ticketForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const err = NB.$('#ticketError', root);
          err.hidden = true;
          const btn = NB.$('#ticketBtn', root);
          btn.disabled = true;
          let attachment;
          const file = NB.$('#ticketFile', root).files?.[0];
          if (file) {
            if (file.size > 140000) { err.textContent = 'Please attach an image smaller than 140 KB.'; err.hidden = false; btn.disabled = false; return; }
            attachment = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
          }
          try {
            const res = await NB.api('/tickets', { body: {
              category: ticketForm.category.value, orderCode: ticketForm.orderCode.value.trim() || undefined,
              subject: ticketForm.subject.value.trim(), description: ticketForm.description.value.trim(), attachment
            } });
            ticketForm.hidden = true;
            const box = NB.$('#ticketCreated', root);
            box.hidden = false;
            box.innerHTML = `<span class="success-check success-check--sm">${NB.icon('check')}</span><h3>Ticket created</h3><p>${NB.esc(res.message)}</p><a class="btn btn--primary btn--sm" href="#/help/tickets/${encodeURIComponent(res.ticket.code)}">Open ticket ${NB.esc(res.ticket.code)}</a>`;
            NB.toast(res.message, 'success');
          } catch (e2) { err.textContent = e2.message; err.hidden = false; btn.disabled = false; }
        });

        const enq = NB.$('#enquiryForm', root);
        enq.addEventListener('submit', async (e) => {
          e.preventDefault();
          const err = NB.$('#enqError', root);
          err.hidden = true;
          try {
            const res = await NB.api('/enquiry', { body: {
              name: NB.$('#enqName', root).value.trim(), contact: enq.contact.value.trim(), topic: enq.topic.value.trim(), message: enq.message.value.trim()
            } });
            enq.hidden = true;
            const ok = NB.$('#enqSuccess', root);
            ok.hidden = false;
            ok.innerHTML = `<p>${NB.icon('checkCircle')} ${NB.esc(res.message)}</p><b>${NB.esc(res.code)}</b>`;
          } catch (e2) { err.textContent = e2.message; err.hidden = false; }
        });
      }
    };
  });

  NB.view(/^\/help\/tickets$/, async () => {
    if (!NB.state.user) return { title: 'Support tickets', html: NB.authGate('Sign in to see your tickets', 'Every support conversation and reply is saved to your account.') };
    const data = await NB.api('/tickets');
    const html = `
      <div class="page-hero page-hero--compact"><div class="wrap">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<a href="#/help">Help</a>${NB.icon('chevronRight')}<span>My tickets</span></nav>
        <div class="page-hero__row"><div><span class="eyebrow">Support</span><h1>My tickets</h1><p>Follow every reply and keep a written record.</p></div><a class="btn btn--primary" href="#/help">${NB.icon('plus')} New ticket</a></div>
      </div></div>
      <div class="wrap section">
        ${data.tickets.length ? `<div class="ticket-list">${data.tickets.map((t) => `<a class="ticket-row" href="#/help/tickets/${encodeURIComponent(t.code)}">
          <span class="ticket-row__ic">${NB.icon('chat')}</span><div><b>${NB.esc(t.subject)}</b><small>${NB.esc(t.code)} · ${NB.esc(t.category)} · opened ${NB.dateTime(t.createdAt)}</small></div>
          <span class="pill pill--${['resolved', 'closed'].includes(t.status) ? 'success' : t.status === 'awaiting_customer' ? 'warn' : 'info'}">${NB.esc(t.status.replace(/_/g, ' '))}</span>${NB.icon('chevronRight')}</a>`).join('')}</div>`
          : NB.empty({ icon: 'headset', title: 'No support tickets', body: 'If an order goes wrong, raise a ticket from Help & Support or from the order itself.', cta: '#/help', ctaLabel: 'Go to help' })}
      </div>`;
    return { title: 'My tickets', html };
  });

  NB.view(/^\/help\/tickets\/([A-Za-z0-9-]+)$/, async (m) => {
    if (!NB.state.user) return { title: 'Ticket', html: NB.authGate('Sign in to view this ticket', 'Support tickets are private to the account that opened them.') };
    const code = m[1];
    const { ticket } = await NB.api(`/tickets/${encodeURIComponent(code)}`);
    const html = `
      <div class="wrap section ticket-page">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<a href="#/help">Help</a>${NB.icon('chevronRight')}<a href="#/help/tickets">Tickets</a>${NB.icon('chevronRight')}<span>${NB.esc(ticket.code)}</span></nav>
        <div class="ticket-detail">
          <div class="ticket-detail__head">
            <div><span class="eyebrow">${NB.esc(ticket.category)}</span><h1>${NB.esc(ticket.subject)}</h1><small>${NB.esc(ticket.code)} · opened ${NB.dateTime(ticket.createdAt)}${ticket.orderCode ? ` · order ${NB.esc(ticket.orderCode)}` : ''}</small></div>
            <span class="pill pill--${['resolved', 'closed'].includes(ticket.status) ? 'success' : 'info'}">${NB.esc(ticket.status.replace(/_/g, ' '))}</span>
          </div>
          <div class="ticket-thread">
            ${ticket.messages.map((msg) => `<div class="ticket-msg ${msg.authorRole === 'agent' ? 'is-agent' : ''}">
              <div class="ticket-msg__head"><span class="avatar avatar--sm">${msg.authorRole === 'agent' ? '🎧' : NB.esc((msg.authorName || 'You').charAt(0))}</span><div><b>${NB.esc(msg.authorName)}${msg.authorRole === 'agent' ? ' · NearBuy Support' : ''}</b><small>${NB.dateTime(msg.at)}</small></div></div>
              <p>${NB.esc(msg.body)}</p></div>`).join('')}
          </div>
          ${ticket.attachment ? `<div class="ticket-attachment"><b>Attachment</b><img src="${ticket.attachment}" alt="Support attachment"/></div>` : ''}
          ${!['closed'].includes(ticket.status) ? `<form id="replyForm" class="ticket-reply">
            <label for="replyBody">Add a reply</label><textarea id="replyBody" rows="3" required placeholder="Add more detail or answer support…"></textarea>
            <div class="ticket-reply__actions"><button class="btn btn--primary" type="submit">Send reply</button><button class="btn btn--ghost" type="button" id="closeTicket">Close ticket</button></div>
          </form>` : `<div class="notice notice--info">${NB.icon('checkCircle')} This ticket is closed. You can open a new one if you need more help.</div>`}
        </div>
      </div>`;
    return {
      title: ticket.subject,
      html,
      after(root) {
        const form = NB.$('#replyForm', root);
        if (form) form.addEventListener('submit', async (e) => {
          e.preventDefault();
          try {
            await NB.api(`/tickets/${encodeURIComponent(code)}/messages`, { body: { body: form.querySelector('textarea').value.trim() } });
            NB.toast('Reply sent.', 'success');
            NB.render();
          } catch (e2) { NB.toast(e2.message, 'error'); }
        });
        const closeBtn = NB.$('#closeTicket', root);
        if (closeBtn) closeBtn.addEventListener('click', async () => {
          try { await NB.api(`/tickets/${encodeURIComponent(code)}/close`, { method: 'POST' }); NB.toast('Ticket closed.', 'success'); NB.render(); } catch (e) { NB.toast(e.message, 'error'); }
        });
      }
    };
  });

  /* ---------------------------------------------------------------- */
  /* Policy and information pages                                     */
  /* ---------------------------------------------------------------- */
  const PAGES = {
    about: {
      eyebrow: 'About NearBuy', title: 'The neighbourhood, online — without losing the neighbourhood.',
      intro: 'NearBuy is a hyperlocal marketplace that helps you discover, compare and buy from shops on your own street.',
      sections: [
        ['Shop Local. Live Better.', 'Every order is fulfilled by a local seller. NearBuy gives shopkeepers a digital shopfront, live inventory and fulfilment tools — and gives customers a reason to walk to the shop that knows their name.'],
        ['One basket, many shops', 'Your basket is split into honest shop-level orders. Each shop receives only its items, sets its own prices, stock and fulfilment options, and never sees another seller’s order.'],
        ['What is real in this build', 'Accounts, addresses, serviceability, catalogues, stock, carts, orders, seller and runner actions, OTP checks, receipts, returns, refunds, reviews, support tickets and audit logs are all database-backed. Sample shops, products and sample orders are clearly labelled DEMO DATA.'],
        ['What still needs a provider', 'No payment gateway keys, map tiles, SMS, email or WhatsApp provider are configured here. Those integrations are built to be enabled with environment variables, and the interface says clearly when they are unavailable rather than pretending.'],
        ['Built for the phone in your hand', 'Every primary page works from a 360 px Android phone to a wide desktop. The design system uses a professional blue palette, rounded cards and a mobile bottom navigation so the shopping journey stays quick.']
      ]
    },
    contact: {
      eyebrow: 'Contact us', title: 'Talk to a human.',
      intro: 'For order-specific help, the ticket flow is fastest because it keeps a written trail.',
      sections: [
        ['Support hours', 'Monday to Sunday, 9:00–21:00 IST. Order tracking and self-service cancellation stay available all night.'],
        ['Channels', 'Support: support@nearbuy.example · Demo phone: 011-4000 0000 · Address: Hauz Khas, New Delhi 110016. No external email or phone provider is connected in this deployment; use Help → Raise a ticket for a logged request.'],
        ['Sellers and delivery partners', 'Shop owners can register through Seller Registration. Riders can apply through the Delivery Partner Registration page. Applications are reviewed by operations before going live.'],
        ['Data requests', 'Account deletion, data export and privacy questions can be raised as an “Account issue” ticket. Identity is verified before any change is made.']
      ]
    },
    faq: {
      eyebrow: 'FAQs', title: 'Questions, answered.',
      intro: 'The help centre has the full searchable list. These are the questions we hear most.',
      sections: [
        ['How are delivery charges decided?', 'Each shop sets its own delivery fee, free-delivery threshold, pickup fee and minimum order. The cart and checkout always show the server-calculated amount per shop before you pay.'],
        ['Can I mix pickup and delivery?', 'Yes. Choose fulfilment per shop at checkout. “Pay at store” is only enabled when every shop in the basket is pickup.'],
        ['What if a product goes out of stock?', 'Stock is reserved inside a single transaction when the order is placed. If another customer bought the last unit first, checkout stops and tells you exactly which item changed.'],
        ['When can I cancel?', 'Until the shop starts preparing your order. After that, contact support or request a return once it is delivered.'],
        ['How do refunds work?', 'A refund starts as a recorded request, moves through review and processing, and is only marked completed when the payment provider or shop confirms it.'],
        ['Is my payment information stored?', 'No card or UPI credentials touch the NearBuy database. When a gateway is configured, payment confirmation comes from a signed webhook.']
      ]
    },
    returns: {
      eyebrow: 'Returns & refunds', title: 'Return policy',
      intro: 'Clear rules, checked by the server, with a recorded reason and status for every request.',
      sections: [
        ['Eligibility', 'Each product page shows its return window. Fresh produce, milk, eggs, cut fruit and other perishables are not returnable unless they arrive damaged or spoiled. Packaged goods, stationery, household items and electronics typically carry a 7-day window.'],
        ['How to request a return', 'Open Orders → the delivered order → Return an item. Choose the item, reason and description, and attach up to three small photos. The server re-checks the delivery date and return window.'],
        ['What happens next', 'The request moves through Requested → Under review → Approved → Processing → Completed, or Rejected with a note. You can follow each change in My Account → Returns.'],
        ['Refunds', 'Cash-on-delivery refunds are recorded for a bank transfer or store credit arranged by the shop. Online refunds return to the original payment method only after the provider confirms. NearBuy never labels a refund complete early.'],
        ['Damaged or missing items', 'For perishables or missing units, raise a support ticket with the order code and a photo. The shop can approve a partial refund without a physical return.']
      ]
    },
    cancellation: {
      eyebrow: 'Cancellation policy', title: 'Cancel while the shop is still getting ready.',
      intro: 'You can cancel online before preparation begins. After that, support can intervene.',
      sections: [
        ['Eligible window', 'Orders can be cancelled while the status is “Order placed” or “Seller accepted”. Once the shop starts preparing, the online cancel button disappears and the server refuses late cancellations.'],
        ['What happens to stock', 'Reserved units are released immediately. If the shop had already accepted and deducted stock, those units are returned to its inventory in the same transaction.'],
        ['Payments', 'Cash-on-delivery orders have nothing to refund. A paid online order creates a refund record in Processing; it is never shown as completed until the gateway confirms.'],
        ['Seller cancellations', 'A seller may reject or cancel with a reason — for example, stock discrepancy or an unserviceable address. You are notified and any payment is refunded separately.'],
        ['Late problems', 'If preparation has started, raise a ticket. Support can coordinate with the shop, and the delivery OTP protects you from accepting an order you did not want.']
      ]
    },
    delivery: {
      eyebrow: 'Delivery information', title: 'How delivery actually works.',
      intro: 'Real shops, real riders, a real handover code — no invented live locations.',
      sections: [
        ['Serviceability', 'NearBuy checks your pincode and the shop’s delivery radius before showing or accepting an order. Shops outside your area are marked, not silently shown as available. Distances are straight-line estimates; no map-tile or routing provider is connected.'],
        ['Preparation and estimates', 'Each shop sets a preparation time. Delivery estimates add a typical travel window. After acceptance, the timeline shows actual status changes rather than a guessed countdown.'],
        ['Seller or runner delivery', 'A shop can deliver with its own rider or ask for a NearBuy runner. Eligible nearby runners receive an offer; only one accepts. The customer sees the assigned partner’s name, vehicle and masked contact.'],
        ['Delivery OTP', 'A 6-digit code appears on your order page once a partner is assigned. The partner must submit it through the authorised workflow; the backend verifies it before the order can become Delivered. The code is derived securely and never stored in plain text.'],
        ['Live location', 'A runner may share a location while on the job. It appears only when actually shared. NearBuy does not fabricate live tracking.'],
        ['Pickup', 'For store pickup, the shop shows a collection code on your order page. The shop verifies it at the counter and only then completes the order.']
      ]
    },
    privacy: {
      eyebrow: 'Privacy', title: 'Privacy policy',
      intro: 'Collect less, scope it tightly, and tell you what is actually stored.',
      sections: [
        ['What we store', 'Account name, email, mobile, hashed password, addresses, cart, orders, reviews, support tickets, notification records and audit entries. Passwords are scrypt-hashed; session tokens are stored hashed in an HttpOnly cookie.'],
        ['Who sees an order', 'Only you, the specific seller fulfilling each part of the order, an assigned delivery partner after acceptance, and authorised operations staff. Sellers never see other shops’ orders or your full order across shops.'],
        ['Payment data', 'No card numbers, UPI PINs or bank credentials are stored. If a gateway is configured, payment references come from the provider and webhook signatures are verified.'],
        ['Retention and audit', 'Order, payment, refund and audit records are retained for accounting and dispute resolution. Support attachments are stored as small data URLs with the ticket.'],
        ['Your choices', 'You can edit your profile, remove addresses, change communication preferences and raise an account-data ticket. SMS/email marketing is off unless you opt in.']
      ]
    },
    terms: {
      eyebrow: 'Terms & conditions', title: 'Terms of use',
      intro: 'A prototype marketplace with real product behaviour — please read these boundaries.',
      sections: [
        ['The service', 'NearBuy connects customers with independent local sellers. Sellers are responsible for their catalogue, pricing, stock, licensing and fulfilment. NearBuy provides the marketplace, order record and support workflow.'],
        ['Accounts', 'Keep your password private and your contact details current. Do not impersonate another person or abuse the order, review or refund systems. Accounts may be suspended for fraud or abuse.'],
        ['Orders and pricing', 'Prices, stock, fees, taxes and coupon eligibility are recalculated on the server at checkout. A listing may change before you place an order; checkout will stop if availability changes.'],
        ['Reviews', 'Only verified purchases can review a product. Reviews must be honest and lawful. Reported reviews go to moderation and are not removed simply because someone disagrees.'],
        ['Demo environment', 'Sample shops, products and orders are labelled. No payment is captured in this deployment unless a gateway is configured and confirms it. Do not seed fake payments, deliveries or real personal data into production.']
      ]
    },
    'seller-registration': {
      eyebrow: 'Sell on NearBuy', title: 'Bring your shop online.',
      intro: 'List your catalogue, receive only your own orders and choose how you fulfil them.',
      sections: [
        ['What you get', 'A branded shopfront, live catalogue and stock, customer orders in one queue, self-delivery or NearBuy runner requests, printable receipts, returns and a support channel.'],
        ['How to apply', 'Use the Seller Registration journey. Provide business details, shop location, service pincodes, delivery or pickup settings and payout information. Applications are reviewed by operations.'],
        ['Fulfilment choice', 'Every delivery order lets you deliver with your own rider or request a nearby NearBuy runner. Pickup orders are verified at the counter with the customer’s collection code.'],
        ['Start the application', 'Open Seller Registration. Demo review may be automatic outside production; production requires a staff review before going live.']
      ],

    },
    'partner-registration': {
      eyebrow: 'Deliver with NearBuy', title: 'Earn on deliveries around your neighbourhood.',
      intro: 'One delivery at a time, transparent payouts and verified handovers.',
      sections: [
        ['How it works', 'Go online, receive one offer at a time, accept it, collect from the shop with the seller’s handover PIN, and deliver with the customer’s OTP.'],
        ['What you need', 'A smartphone, a vehicle, valid identity documents and an adult age check. Applications are reviewed before offers are sent.'],
        ['Earnings and safety', 'Each assignment records a payout. Payouts are records; money movement requires a configured payout provider. Share location only while on a job, and never ask a customer for their OTP in advance.'],
        ['Start the application', 'Open the Delivery Partner Registration journey. Do not upload real identity documents to this prototype.']
      ],

    }
  };

  NB.view(/^\/page\/([a-z-]+)$/, async (m) => {
    const slug = m[1];
    const page = PAGES[slug];
    if (!page) return { title: 'Page not found', html: `<div class="wrap section">${NB.empty({ icon: 'info', title: 'This page is not available', body: 'The policy or information page may have moved.', cta: '#/help', ctaLabel: 'Go to Help' })}</div>` };
    const html = `
      <div class="page-hero page-hero--compact"><div class="wrap">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a>${NB.icon('chevronRight')}<span>${NB.esc(page.title)}</span></nav>
        <div class="policy-head"><span class="eyebrow">${NB.esc(page.eyebrow)}</span><h1>${NB.esc(page.title)}</h1><p>${NB.esc(page.intro)}</p></div>
      </div></div>
      <div class="wrap policy-page">
        <article class="policy-body">
          ${page.sections.map(([h, p]) => `<section><h2>${NB.esc(h)}</h2><p>${NB.esc(p)}</p></section>`).join('')}
          ${page.cta ? `<a class="btn btn--primary btn--lg" href="${page.cta.href}">${NB.esc(page.cta.label)} ${NB.icon('arrowRight')}</a>` : ''}
        </article>
        <aside class="policy-side">
          <div class="side-card"><h3>Quick links</h3><div class="policy-links">
            <a href="#/page/returns">Return &amp; refund policy</a><a href="#/page/cancellation">Cancellation policy</a><a href="#/page/delivery">Delivery information</a><a href="#/page/privacy">Privacy policy</a><a href="#/page/terms">Terms &amp; conditions</a><a href="#/help">Help &amp; support</a>
          </div></div>
          <div class="side-card side-card--soft"><h3>${NB.icon('info')} Demo boundary</h3><p class="fineprint">This build uses demo shops and cash-on-delivery orders. No external payment, map, SMS or email provider is connected; the interface states this wherever it matters.</p></div>
        </aside>
      </div>`;
    return { title: page.title, html };
  });
})();
