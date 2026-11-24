/* NearBuy Runner Portal — nearby delivery offers, pickup with the shop's
 * handover PIN, out-for-delivery and completion with the customer's OTP.
 * All state lives in the shared platform database through /api/partner/runner/*.
 */
(function () {
  'use strict';
  const PA = window.PA;
  const esc = PA.esc;
  let overviewData = null;

  const NAV = [
    { href: '#/overview', label: 'Today', icon: 'bike', count: 'offers' },
    { href: '#/history', label: 'Delivery history', icon: 'route' },
    { href: '#/earnings', label: 'Earnings', icon: 'route' },
    { href: '#/payouts', label: 'Payouts', icon: 'settlement' },
    { href: '#/preferences', label: 'Work preferences', icon: 'settings' },
    { href: '#/safety', label: 'Safety & support', icon: 'support' },
    { href: '#/notifications', label: 'Notifications', icon: 'bell' },
    { href: '#/profile', label: 'Partner profile', icon: 'settings' }
  ];

  async function overview(match, ctx) {
    const data = await PA.api('GET', '/runner/overview');
    overviewData = data;
    if (!ctx.isCurrent()) return;
    PA.badges({ offers: data.offers.length });
    const online = data.runner.status === 'online';
    const chip = document.getElementById('conn-chip');
    if (chip) chip.classList.toggle('off', !online);

    PA.set(`
      <div class="space-between">
        <div><h1>Today</h1>
        <p class="muted small">${online ? 'You are online and receiving offers.' : 'You are offline — go online to receive delivery offers.'}</p></div>
        <div class="row">
          <span class="badge ${online ? 'green' : 'grey'}">${online ? 'Online' : 'Offline'}</span>
          <button class="btn ${online ? '' : 'btn-success'}" id="toggle-online">${online ? 'Go offline' : 'Go online'}</button>
        </div>
      </div>

      <div class="grid g4">
        <div class="card stat"><span class="label">Open offers</span><span class="value">${data.offers.length}</span><span class="hint">One delivery at a time</span></div>
        <div class="card stat"><span class="label">Active delivery</span><span class="value">${data.activeJobCount}</span><span class="hint">Accepted, not yet delivered</span></div>
        <div class="card stat"><span class="label">Paid earnings</span><span class="value">${PA.money(data.earnings)}</span><span class="hint">Delivered assignments</span></div>
        <div class="card stat"><span class="label">Rating</span><span class="value">${data.runner.rating.toFixed(1)}</span><span class="hint">${data.runner.completed} lifetime deliveries</span></div>
      </div>

      ${data.active.length ? `<div class="stack">
        <h2>On the road now</h2>
        ${data.active.map(activeJob).join('')}
      </div>` : ''}

      <div class="stack">
        <h2>Next offer for you</h2>
        ${data.offers.length ? data.offers.map(offerCard).join('')
          : `<div class="card">${PA.empty('📡', data.activeJobCount ? 'Finish your current delivery first' : 'No offers right now',
            data.activeJobCount ? 'NearBuy sends one delivery at a time so you never juggle two customers.' : 'Stay online — sellers request a runner when an order is packed and ready.')}</div>`}
      </div>

      <div class="card">
        <h3>How handover works</h3>
        <div class="grid g3" style="margin-top:12px">
          <div><b class="small">Pick up</b><p class="muted small">The shop shows you a 4-digit handover PIN. Enter it to confirm you collected the right parcel.</p></div>
          <div><b class="small">Deliver</b><p class="muted small">The customer reads you their 6-digit delivery OTP. The order can only close after the server verifies it.</p></div>
          <div><b class="small">Privacy</b><p class="muted small">Customer phone numbers stay masked and the shop phone is only shown for the order you accepted.</p></div>
        </div>
      </div>
    `);

    PA.on('#toggle-online', 'click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const next = online ? 'offline' : 'online';
        const body = { status: next };
        if (next === 'online' && navigator.geolocation) {
          navigator.geolocation.getCurrentPosition((pos) => {
            PA.api('POST', '/runner/status', { status: 'online', lat: pos.coords.latitude, lng: pos.coords.longitude })
              .then(() => PA.render()).catch((err) => PA.toast(err.message, 'err'));
          }, () => {
            PA.api('POST', '/runner/status', { status: 'online' }).then(() => PA.render()).catch((err) => PA.toast(err.message, 'err'));
          }, { timeout: 6000 });
          PA.toast('Asking your browser for a location so nearby offers are accurate.', 'warn');
          return;
        }
        await PA.api('POST', '/runner/status', body);
        PA.toast(next === 'online' ? 'You are online.' : 'You are offline. No new offers will arrive.');
        PA.render();
      } catch (err) { btn.disabled = false; PA.toast(err.message, 'err'); }
    });

    wireJobActions();
  }

  function offerCard(o) {
    const minutes = Math.max(0, Math.round((new Date(o.expiresAt).getTime() - Date.now()) / 60000));
    return `<article class="card">
      <div class="space-between">
        <div>
          <div class="row tight"><b class="mono">${esc(o.orderCode)}</b>${PA.badge('New offer', 'amber')}</div>
          <div class="muted small">${esc(o.shop.emoji || '🏪')} ${esc(o.shop.name)} · ${esc(o.shop.locality)} · ${o.itemCount} item(s)</div>
        </div>
        <div class="right"><b style="font-size:19px;color:var(--deep)">${PA.money(o.payout)}</b>
          <div class="muted small">${o.distanceKm} km to shop</div></div>
      </div>
      <p class="muted small" style="margin-top:10px">${esc(o.deliveryArea)} Offer expires in ${minutes} minute(s).</p>
      <div class="row" style="margin-top:8px">
        <button class="btn btn-success" data-offer="accept" data-id="${esc(o.id)}">Accept delivery</button>
        <button class="btn btn-danger" data-offer="decline" data-id="${esc(o.id)}">Decline</button>
      </div>
    </article>`;
  }

  function activeJob(job) {
    const step = job.status === 'runner_assigned' ? 1 : job.status === 'picked_up' ? 2 : job.status === 'out_for_delivery' ? 3 : 0;
    return `<article class="card">
      <div class="space-between">
        <div>
          <div class="row tight"><b class="mono">${esc(job.orderCode)}</b>${PA.status(job.status)}</div>
          <div class="muted small">${PA.money(job.payout)} payout · collect from ${esc(job.shop.name)}</div>
        </div>
        <a class="btn btn-sm" href="#/jobs/${esc(job.assignmentId)}">Delivery detail</a>
      </div>
      <div class="timeline" style="margin-top:12px">
        ${['Collect from shop', 'Picked up', 'Out for delivery', 'Delivered with OTP'].map((label, i) => `
          <div class="step ${i < step ? 'done' : i === step ? 'current' : ''}"><span class="dot">${i + 1}</span>
            <div><b>${label}</b></div></div>`).join('')}
      </div>
      <div class="row">
        ${job.canPickup ? `<button class="btn btn-primary" data-job="${esc(job.assignmentId)}" data-action="picked_up">Confirm pickup with handover PIN</button>` : ''}
        ${job.status === 'picked_up' ? `<button class="btn btn-primary" data-job="${esc(job.assignmentId)}" data-action="out_for_delivery">Start delivery</button>` : ''}
        ${job.status === 'out_for_delivery' ? `<button class="btn btn-success" data-job="${esc(job.assignmentId)}" data-action="delivered">Complete with customer OTP</button>` : ''}
        <button class="btn btn-sm" data-job="${esc(job.assignmentId)}" data-action="arrived">I have reached the shop</button>
        <button class="btn btn-sm" data-job="${esc(job.assignmentId)}" data-action="share_location">Share my location</button>
      </div>
    </article>`;
  }

  async function jobDetail(match, ctx) {
    const id = match[1];
    const data = overviewData && overviewData.activeJobCount ? overviewData : await PA.api('GET', '/runner/overview');
    overviewData = data;
    if (!ctx.isCurrent()) return;
    const job = data.active.find((j) => j.assignmentId === id);
    if (!job) {
      PA.set(`<div class="card">${PA.empty('🛵', 'No active delivery', 'This delivery is finished, cancelled or not assigned to you.', '<a class="btn" href="#/overview">Back to today</a>')}</div>`);
      return;
    }
    const a = job.address || {};
    PA.set(`
      <div class="space-between"><div><h1>Delivery ${esc(job.orderCode)}</h1>
        <p class="muted small">${PA.status(job.status)} · payout ${PA.money(job.payout)}</p></div>
        <a class="btn" href="#/overview">← Back</a></div>
      <div class="grid g2">
        <div class="card">
          <h3>Collect from</h3>
          ${PA.kv([['Shop', job.shop.name], ['Address', [job.shop.address, job.shop.locality].filter(Boolean).join(', ')], ['Phone', job.shop.phone || 'Not provided']])}
          <div class="row" style="margin-top:12px">
            ${job.canPickup ? `<button class="btn btn-primary" data-job="${esc(job.assignmentId)}" data-action="picked_up">Pick up with handover PIN</button>` : ''}
            ${job.status === 'picked_up' ? `<button class="btn btn-primary" data-job="${esc(job.assignmentId)}" data-action="out_for_delivery">Start delivery</button>` : ''}
            ${job.status === 'out_for_delivery' ? `<button class="btn btn-success" data-job="${esc(job.assignmentId)}" data-action="delivered">Complete with OTP</button>` : ''}
          </div>
        </div>
        <div class="card">
          <h3>Deliver to</h3>
          ${PA.kv([
            ['Customer', job.customer.name],
            ['Phone', job.customer.phoneMasked || 'masked'],
            ['Address', [a.line1, a.line2, a.locality, a.city, a.pincode].filter(Boolean).join(', ')],
            a.landmark ? ['Landmark', a.landmark] : null,
            a.instructions ? ['Instructions', a.instructions] : null
          ])}
          <div class="banner-note" style="margin-top:10px">Photo and exact flat details are shared only for this delivery. Never share the customer’s number.</div>
        </div>
      </div>
      <div class="card">
        <h3>Parcel contents (${job.items.length})</h3>
        <div class="list" style="margin-top:10px">
          ${job.items.map((i) => `<div class="item"><span class="emoji">📦</span><div class="grow"><b>${esc(i.name)}</b></div><b>×${i.qty}</b></div>`).join('')}
        </div>
      </div>
    `);
    wireJobActions();
  }

  function wireJobActions() {
    PA.onAll('[data-offer]', 'click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const res = await PA.api('POST', `/runner/offers/${encodeURIComponent(btn.dataset.id)}/${btn.dataset.offer}`, {});
        PA.toast(res.message || 'Offer updated.', btn.dataset.offer === 'accept' ? 'ok' : 'warn');
        PA.render();
      } catch (err) { btn.disabled = false; PA.toast(err.message, 'err'); }
    });

    PA.onAll('[data-job]', 'click', async (e) => {
      const btn = e.currentTarget;
      const action = btn.dataset.action;
      const id = btn.dataset.job;
      try {
        if (action === 'picked_up') {
          const pin = await ask('Shop handover PIN', 'Ask the shopkeeper for the 4-digit PIN shown on their Seller Hub order card.', 'numeric', 4);
          if (!pin) return;
          btn.disabled = true;
          const res = await PA.api('POST', `/runner/jobs/${encodeURIComponent(id)}/action`, { action, pickupPin: pin });
          PA.toast(res.message || 'Pickup confirmed.');
          return PA.render();
        }
        if (action === 'delivered') {
          const otp = await ask('Customer delivery OTP', 'Only enter the 6-digit code the customer reads to you after receiving the items.', 'numeric', 6);
          if (!otp) return;
          btn.disabled = true;
          const res = await PA.api('POST', `/runner/jobs/${encodeURIComponent(id)}/action`, { action, otp });
          PA.toast(res.message || 'Delivery completed.');
          return PA.render();
        }
        if (action === 'share_location') {
          if (!navigator.geolocation) return PA.toast('This browser cannot share a location.', 'err');
          navigator.geolocation.getCurrentPosition(async (pos) => {
            try {
              const res = await PA.api('POST', `/runner/jobs/${encodeURIComponent(id)}/location`, { lat: pos.coords.latitude, lng: pos.coords.longitude });
              PA.toast(res.message || 'Location shared.');
            } catch (err) { PA.toast(err.message, 'err'); }
          }, () => PA.toast('Location permission was refused, so nothing was shared.', 'err'));
          return;
        }
        btn.disabled = true;
        const res = await PA.api('POST', `/runner/jobs/${encodeURIComponent(id)}/action`, { action });
        PA.toast(res.message || 'Updated.');
        PA.render();
      } catch (err) { btn.disabled = false; PA.toast(err.message, 'err'); }
    });
  }

  function ask(title, help, mode, maxLength) {
    return new Promise((resolve) => {
      PA.modal({
        title,
        body: `<p class="muted small">${esc(help)}</p>
          <div class="field"><label for="ask-input">${esc(title)}</label>
          <input class="input" id="ask-input" ${mode === 'numeric' ? `inputmode="numeric" maxlength="${maxLength}"` : ''} autocomplete="off" /></div>`,
        actions: [
          { label: 'Cancel', onClick: () => resolve('') },
          { label: 'Verify', primary: true, onClick: (back) => resolve(back.querySelector('#ask-input').value.trim()) }
        ],
        onMount: (back) => back.querySelector('#ask-input').focus()
      });
    });
  }

  async function history(match, ctx) {
    const data = await PA.api('GET', '/runner/overview');
    const jobs = await PA.api('GET', '/runner/jobs');
    if (!ctx.isCurrent()) return;
    PA.set(`
      <div class="space-between"><div><h1>Delivery history</h1>
        <p class="muted small">Payouts recorded for deliveries you completed on the platform.</p></div>
        <div class="badge green">${PA.money(data.earnings)} earned</div></div>
      ${jobs.jobs.length ? `<div class="card flush"><div class="table-wrap"><table class="data">
        <thead><tr><th>Assignment</th><th>Status</th><th class="num">Distance</th><th class="num">Payout</th><th>Created</th><th>Delivered</th></tr></thead>
        <tbody>${jobs.jobs.map((j) => `<tr>
          <td class="mono small">${esc(j.id.slice(0, 8))}</td>
          <td>${PA.status(j.status)}</td>
          <td class="num">${j.distanceKm ?? '—'} km</td>
          <td class="num">${PA.money(j.payout)}</td>
          <td class="small">${PA.dateTime(j.createdAt)}</td>
          <td class="small">${j.deliveredAt ? PA.dateTime(j.deliveredAt) : '—'}</td>
        </tr>`).join('')}</tbody></table></div></div>`
        : `<div class="card">${PA.empty('🧭', 'No deliveries yet', 'Accept an offer from Today and it will appear here after completion.')}</div>`}
    `);
  }

  async function profile(match, ctx) {
    const data = await PA.api('GET', '/me');
    if (!ctx.isCurrent()) return;
    const r = data.runner || {};
    PA.set(`
      <div class="space-between"><div><h1>Partner profile</h1>
        <p class="muted small">Your delivery account on the shared platform.</p></div></div>
      <div class="grid g2">
        <div class="card">
          <h3>Account</h3>
          ${PA.kv([['Name', state().name], ['Email', state().email], ['Phone', state().phone], ['Role', 'Delivery partner']])}
        </div>
        <div class="card">
          <h3>Delivery profile</h3>
          ${PA.kv([['Status', r.status || 'offline'], ['Vehicle', r.vehicle || '—'], ['Rating', r.rating != null ? r.rating.toFixed(1) : '—'], ['Completed', r.completed ?? 0]])}
          <a class="btn btn-sm" style="margin-top:12px" href="#/overview">Manage availability</a>
        </div>
      </div>
      <div class="card">
        <h3>Privacy and safety</h3>
        <p class="muted small" style="margin-top:8px">Customer phone numbers stay masked in your console and the full delivery address is only available for an active assignment. Delivery OTPs are generated per order and verified by the server; a wrong code is rejected and counted against the order.</p>
      </div>
    `);
    function state() { return PA.state.user || {}; }
  }

  /* ------------------------------------------------------------------ */
  /* Earnings dashboard — real delivery/payout records only.            */
  /* ------------------------------------------------------------------ */
  async function earnings(match, ctx) {
    const data = await PA.api('GET', '/runner/earnings');
    if (!ctx.isCurrent()) return;
    const t = data.totals;
    const days = Object.keys(data.byDay).sort();
    const maxDay = Math.max(1, ...Object.values(data.byDay));
    PA.set(`
      <div class="space-between"><div><h1>Earnings</h1>
        <p class="muted small">Every figure comes from deliveries you completed on the shared platform.</p></div>
        <a class="btn" href="#/payouts">Payout history →</a></div>
      <div class="grid g4">
        <div class="card stat"><span class="label">Today</span><span class="value">${PA.money(t.today)}</span><span class="hint">Delivered today</span></div>
        <div class="card stat"><span class="label">Last 7 days</span><span class="value">${PA.money(t.week)}</span><span class="hint">Rolling week</span></div>
        <div class="card stat"><span class="label">This month</span><span class="value">${PA.money(t.month)}</span><span class="hint">Since the 1st</span></div>
        <div class="card stat"><span class="label">All time</span><span class="value">${PA.money(t.allTime)}</span><span class="hint">${t.deliveries} deliveries · ${t.distanceKm} km</span></div>
      </div>
      <div class="grid g2">
        <div class="card">
          <h3>Daily earnings</h3>
          ${days.length ? `<div class="bars" style="margin-top:12px">${days.slice(-14).map((d) => `
            <div class="bar-row"><span class="muted small mono">${esc(d.slice(5))}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.round((data.byDay[d] / maxDay) * 100)}%"></div></div>
              <b class="small">${PA.money(data.byDay[d])}</b></div>`).join('')}</div>`
            : `<div class="empty"><div class="emoji">📊</div><b>No earnings yet</b><span>Complete a delivery and the graph will fill in.</span></div>`}
        </div>
        <div class="card">
          <h3>How your earnings are calculated</h3>
          ${PA.kv([
            ['Base delivery', PA.money(data.rateCard.basePaise)],
            ['Distance component', `${PA.money(data.rateCard.perKmPaise)} per km (runner → shop)`],
            ['Minimum / maximum', `${PA.money(data.rateCard.minPaise)} – ${PA.money(data.rateCard.maxPaise)}`],
            ['Average per delivery', PA.money(t.avgPerDelivery)]
          ])}
          <p class="muted small" style="margin-top:10px">${esc(data.rateCard.note)} You see the exact payout before you accept an offer.</p>
        </div>
      </div>
      <div class="card">
        <h3>Delivery earnings breakdown</h3>
        ${data.deliveries.length ? `<div class="table-wrap"><table class="data">
          <thead><tr><th>Order</th><th>Shop</th><th>Delivered</th><th class="num">Distance</th><th class="num">Base</th><th class="num">Distance pay</th><th class="num">Total</th></tr></thead>
          <tbody>${data.deliveries.map((d) => `<tr>
            <td class="mono small">${esc(d.orderCode)}</td>
            <td class="small">${esc(d.shop)}</td>
            <td class="small">${PA.dateTime(d.deliveredAt)}</td>
            <td class="num">${d.breakdown.distanceKm ?? '—'} km</td>
            <td class="num">${PA.money(d.breakdown.base)}</td>
            <td class="num">${PA.money(d.breakdown.distanceComponent)}</td>
            <td class="num"><b>${PA.money(d.breakdown.total)}</b></td>
          </tr>`).join('')}</tbody></table></div>`
          : PA.empty('🛵', 'No completed deliveries yet', 'Earnings are recorded the moment a delivery closes with the customer OTP.')}
      </div>
    `);
  }

  /* ------------------------------------------------------------------ */
  /* Payout history                                                     */
  /* ------------------------------------------------------------------ */
  async function payouts(match, ctx) {
    const data = await PA.api('GET', '/runner/payouts');
    if (!ctx.isCurrent()) return;
    const s = data.summary;
    PA.set(`
      <div class="space-between"><div><h1>Payouts</h1>
        <p class="muted small">Payouts are processed by operations on a periodic schedule. Status only changes when a real payout is confirmed.</p></div>
        <button class="btn btn-primary" id="request-payout">Request payout</button></div>
      <div class="grid g4">
        <div class="card stat"><span class="label">Pending</span><span class="value">${PA.money(s.pending)}</span><span class="hint">Requested, not yet processed</span></div>
        <div class="card stat"><span class="label">Processing</span><span class="value">${PA.money(s.processing)}</span><span class="hint">Being paid out</span></div>
        <div class="card stat"><span class="label">Completed</span><span class="value">${PA.money(s.completed)}</span><span class="hint">Paid to your account</span></div>
        <div class="card stat"><span class="label">On hold / failed</span><span class="value">${PA.money(s.onHold + s.failed)}</span><span class="hint">Contact support if stuck</span></div>
      </div>
      ${data.payouts.length ? `<div class="card flush"><div class="table-wrap"><table class="data">
        <thead><tr><th>Period</th><th class="num">Gross</th><th class="num">Adjustments</th><th class="num">Net</th><th>Reference</th><th>Status</th><th>Requested</th></tr></thead>
        <tbody>${data.payouts.map((p) => `<tr>
          <td><b>${esc(p.period)}</b></td>
          <td class="num">${PA.money(p.gross)}</td>
          <td class="num">${PA.money(p.adjustments)}</td>
          <td class="num"><b>${PA.money(p.net)}</b></td>
          <td class="small mono">${p.reference ? esc(p.reference) : '—'}</td>
          <td>${PA.badge(p.status.replace('_', ' '), p.status === 'completed' ? 'green' : p.status === 'failed' ? 'red' : 'amber')}</td>
          <td class="small">${PA.dateTime(p.createdAt)}</td>
        </tr>`).join('')}</tbody></table></div></div>`
        : `<div class="card">${PA.empty('💰', 'No payout requests yet', 'Once you complete deliveries, request a payout and operations will process it here.')}</div>`}
    `);
    PA.on('#request-payout', 'click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const res = await PA.api('POST', '/runner/payouts/request', {});
        PA.toast(res.message || 'Payout requested.');
        PA.render();
      } catch (err) { btn.disabled = false; PA.toast(err.message, 'err'); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Work preferences                                                   */
  /* ------------------------------------------------------------------ */
  async function preferences(match, ctx) {
    const data = await PA.api('GET', '/runner/preferences');
    const areas = await PA.api('GET', '/runner/service-areas').catch(() => ({ areas: [] }));
    if (!ctx.isCurrent()) return;
    const p = data.preferences;
    const hourOptions = ['Morning (6am – 12pm)', 'Afternoon (12pm – 5pm)', 'Evening (5pm – 10pm)', 'Custom'];
    const catOptions = ['Groceries', 'General store', 'Food & beverages', 'Stationery & books', 'Electronics & accessories', 'Clothing & footwear', 'Medical & pharmacy'];
    PA.set(`
      <div class="space-between"><div><h1>Work preferences</h1>
        <p class="muted small">Offers outside your maximum distance or preferred hours are never sent to you.</p></div></div>
      <form class="card" id="prefs-form">
        <h3>Delivery areas</h3>
        <div class="field" style="margin-top:10px"><label for="pf-areas">Preferred localities</label>
          <input class="input" id="pf-areas" value="${esc(p.areas)}" placeholder="Lajpat Nagar, Defence Colony" />
          <span class="help">Comma separated. Leave empty to accept offers anywhere in the serviceable city.</span></div>
        <div class="field"><label for="pf-pins">Preferred PIN codes</label>
          <input class="input" id="pf-pins" value="${esc(p.pincodes)}" placeholder="110024, 110049" />
          <span class="help">6-digit PIN codes, comma separated.${areas.areas && areas.areas.length ? ` Serviceable today: ${esc(areas.areas.map((a) => a.pincode).join(', '))}.` : ''}</span></div>
        <div class="field"><label for="pf-dist">Maximum delivery distance (km)</label>
          <input class="input" id="pf-dist" type="number" min="1" max="25" step="0.5" value="${esc(String(p.maxDistanceKm))}" />
          <span class="help">Runner requests beyond this distance will not be offered to you (platform cap: 10 km).</span></div>
        <h3 style="margin-top:18px">Working hours</h3>
        <div class="field" style="margin-top:10px"><label for="pf-hours">Preferred shifts</label>
          <input class="input" id="pf-hours" value="${esc(p.hours)}" placeholder="${esc(hourOptions.join(', '))}" />
          <span class="help">E.g. Morning (6am – 12pm), Evening (5pm – 10pm).</span></div>
        <h3 style="margin-top:18px">Preferred order types</h3>
        <div class="field" style="margin-top:10px"><label for="pf-cats">Categories</label>
          <input class="input" id="pf-cats" value="${esc(p.categories)}" placeholder="${esc(catOptions.join(', '))}" />
          <span class="help">Comma separated. Preferences are advisory — safety and eligibility rules always win.</span></div>
        <div class="row" style="margin-top:16px"><button class="btn btn-primary" type="submit">Save preferences</button></div>
      </form>
    `);
    PA.on('#prefs-form', 'submit', async (e) => {
      e.preventDefault();
      const btn = e.currentTarget.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const res = await PA.api('PATCH', '/runner/preferences', {
          areas: document.getElementById('pf-areas').value,
          pincodes: document.getElementById('pf-pins').value,
          hours: document.getElementById('pf-hours').value,
          categories: document.getElementById('pf-cats').value,
          maxDistanceKm: Number(document.getElementById('pf-dist').value)
        });
        PA.toast(res.message || 'Preferences saved.');
        PA.render();
      } catch (err) { btn.disabled = false; PA.toast(err.message, 'err'); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Safety & support                                                   */
  /* ------------------------------------------------------------------ */
  async function safety(match, ctx) {
    const data = await PA.api('GET', '/runner/safety/tickets');
    if (!ctx.isCurrent()) return;
    const statusTone = (s) => s === 'resolved' || s === 'closed' ? 'green' : s === 'open' ? 'amber' : 'grey';
    PA.set(`
      <div class="space-between"><div><h1>Safety & support</h1>
        <p class="muted small">Report unsafe situations, accidents or delivery problems. Safety reports are handled with priority.</p></div>
        <button class="btn btn-danger" id="new-report">Report an incident</button></div>
      <div class="grid g3">
        <div class="card"><h3>🚨 Emergency</h3>
          <p class="muted small" style="margin-top:8px">In an emergency, contact local emergency services first (112 in India), then report the incident here so support can act on the delivery.</p></div>
        <div class="card"><h3>🛡️ Unsafe delivery</h3>
          <p class="muted small" style="margin-top:8px">Never risk your safety to meet an estimate. Report unsafe routes, aggressive customers or unsafe handovers — support can suspend the delivery.</p></div>
        <div class="card"><h3>📦 Delivery problems</h3>
          <p class="muted small" style="margin-top:8px">Damaged parcels, wrong addresses or shop issues go through the same report form and reach the right support team.</p></div>
      </div>
      <div class="card">
        <h3>My reports</h3>
        ${data.tickets.length ? `<div class="list" style="margin-top:10px">${data.tickets.map((t) => `
          <div class="item">
            <span class="emoji">${t.category === 'safety' ? '🚨' : t.category === 'accident' ? '⚠️' : '📩'}</span>
            <div class="grow"><b>${esc(t.subject)}</b>
              <div class="muted small mono">${esc(t.code)} · ${esc(t.category)} · ${PA.dateTime(t.createdAt)}</div></div>
            ${PA.badge(t.status.replace('_', ' '), statusTone(t.status))}
            <button class="btn btn-sm" data-ticket="${esc(t.code)}">Open</button>
          </div>`).join('')}</div>`
          : PA.empty('🛡️', 'No reports filed', 'Everything is fine so far. File a report any time you need help.')}
      </div>
    `);

    PA.on('#new-report', 'click', () => {
      PA.modal({
        title: 'Report an incident',
        body: `
          <div class="field"><label for="sr-cat">Category</label>
            <select class="input" id="sr-cat">
              <option value="safety">Unsafe situation</option>
              <option value="accident">Accident or incident</option>
              <option value="customer">Customer-related problem</option>
              <option value="seller">Seller/shop problem</option>
              <option value="delivery">Damaged or wrong parcel</option>
              <option value="general">Other</option>
            </select></div>
          <div class="field"><label for="sr-subject">Subject</label>
            <input class="input" id="sr-subject" placeholder="Short summary" /></div>
          <div class="field"><label for="sr-desc">What happened?</label>
            <textarea class="input" id="sr-desc" rows="4" placeholder="Describe the situation — include the order code if it relates to a delivery."></textarea></div>`,
        actions: [
          { label: 'Cancel' },
          {
            label: 'Send report', primary: true, onClick: async (back) => {
              try {
                const res = await PA.api('POST', '/runner/safety/tickets', {
                  category: back.querySelector('#sr-cat').value,
                  subject: back.querySelector('#sr-subject').value,
                  description: back.querySelector('#sr-desc').value
                });
                PA.toast(res.message || 'Report sent.');
                PA.render();
              } catch (err) { PA.toast(err.message, 'err'); return true; }
            }
          }
        ]
      });
    });

    PA.onAll('[data-ticket]', 'click', async (e) => {
      const code = e.currentTarget.dataset.ticket;
      try {
        const data = await PA.api('GET', `/runner/safety/tickets/${encodeURIComponent(code)}`);
        const t = data.ticket;
        PA.modal({
          title: `${t.code} · ${t.subject}`,
          body: `<div class="list">${t.messages.map((m) => `
            <div class="item"><span class="emoji">${m.authorRole === 'runner' ? '🛵' : '🎧'}</span>
              <div class="grow"><b>${esc(m.authorName)} ${m.authorRole === 'runner' ? '(you)' : '(support)'}</b>
                <div class="small">${esc(m.body)}</div>
                <div class="muted small">${PA.dateTime(m.at)}</div></div></div>`).join('')}</div>
            ${t.status !== 'closed' ? `<div class="field" style="margin-top:12px"><label for="tr-reply">Add a reply</label>
              <textarea class="input" id="tr-reply" rows="3"></textarea></div>` : '<p class="muted small">This ticket is closed.</p>'}`,
          actions: [
            { label: 'Close' },
            ...(t.status !== 'closed' ? [{
              label: 'Send reply', primary: true, onClick: async (back) => {
                const body = back.querySelector('#tr-reply').value.trim();
                if (!body) { PA.toast('Write a reply first.', 'warn'); return true; }
                try {
                  await PA.api('POST', `/runner/safety/tickets/${encodeURIComponent(code)}/reply`, { body });
                  PA.toast('Reply sent.');
                  PA.render();
                } catch (err) { PA.toast(err.message, 'err'); return true; }
              }
            }] : [])
          ]
        });
      } catch (err) { PA.toast(err.message, 'err'); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Notifications                                                      */
  /* ------------------------------------------------------------------ */
  async function notifications(match, ctx) {
    const data = await PA.api('GET', '/runner/notifications');
    if (!ctx.isCurrent()) return;
    PA.badges({ notifications: data.unread });
    PA.set(`
      <div class="space-between"><div><h1>Notifications</h1>
        <p class="muted small">${data.unread} unread. Delivery offers, payout updates and support replies arrive here.</p></div>
        ${data.unread ? '<button class="btn" id="mark-read">Mark all as read</button>' : ''}</div>
      ${data.notifications.length ? `<div class="card flush"><div class="list">${data.notifications.map((n) => `
        <div class="item" style="${n.read ? 'opacity:.72' : ''}">
          <span class="emoji">${n.type === 'runner' ? '🛵' : n.type === 'payout' ? '💰' : n.type === 'support' ? '🎧' : '🔔'}</span>
          <div class="grow"><b>${esc(n.title)}</b>
            <div class="muted small">${esc(n.body)}</div>
            <div class="muted small">${PA.dateTime(n.at)}</div></div>
          ${n.read ? '' : PA.badge('New', 'amber')}
        </div>`).join('')}</div></div>`
        : `<div class="card">${PA.empty('🔔', 'No notifications yet', 'Offers, payout updates and support replies will show up here.')}</div>`}
    `);
    PA.on('#mark-read', 'click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await PA.api('POST', '/runner/notifications/read', {});
        PA.toast('All notifications marked as read.');
        PA.render();
      } catch (err) { btn.disabled = false; PA.toast(err.message, 'err'); }
    });
  }

  PA.start({
    mode: 'runner',
    title: 'Runner Portal',
    home: '#/overview',
    nav: NAV,
    routes: [
      [/^\/overview$/, overview],
      [/^\/jobs\/([A-Za-z0-9-]+)$/, jobDetail],
      [/^\/history$/, history],
      [/^\/earnings$/, earnings],
      [/^\/payouts$/, payouts],
      [/^\/preferences$/, preferences],
      [/^\/safety$/, safety],
      [/^\/notifications$/, notifications],
      [/^\/profile$/, profile]
    ]
  });
})();
