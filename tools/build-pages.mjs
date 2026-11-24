#!/usr/bin/env node
/*
 * tools/build-pages.mjs — emits the portal front-door pages.
 *
 * Each door is a small, self-contained splash that states which workspace it
 * opens, shows that workspace's demo sign-in, and hands off into the matching
 * hash route of portal.html (NearBuy One). They exist so the clean URLs that the
 * homepage and README link to (/customer/, /seller/, /runner/, /fleet/, /admin/,
 * /control-tower/, /seller/register/, /runner/register/, /customer/login/)
 * resolve instead of 404ing.
 *
 * Run:  node tools/build-pages.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MARK = `<img src="/public/assets/nearbuy-logo.png" width="88" height="88" alt="NearBuy" decoding="async" />`;

/* One entry per clean URL that must exist. */
const DOORS = [
  {
    dir: 'customer',
    accent: '#f47718',
    kicker: 'Customer storefront',
    title: 'Opening the shop front',
    blurb: 'Real neighbourhood shops, everyday essentials, one basket across stores, delivery or pickup at checkout.',
    target: '/portal.html#/shop/home?login=1',
    cta: 'Open the customer storefront',
    creds: { email: 'riya@nearbuy.demo', pass: 'NearBuy123!' },
    handoff: 'Opening the storefront'
  },
  {
    dir: 'customer/login',
    accent: '#f47718',
    kicker: 'Customer sign-in',
    title: 'Sign in to your account',
    blurb: 'Your orders, saved items and addresses live in the customer storefront.',
    target: '/portal.html#/shop/home?login=1',
    cta: 'Go to sign-in',
    creds: { email: 'riya@nearbuy.demo', pass: 'NearBuy123!' },
    handoff: 'Taking you to sign-in'
  },
  {
    dir: 'seller',
    accent: '#2b8a66',
    kicker: 'Sell workspace',
    title: 'Opening the Seller Hub',
    blurb: 'Orders, catalogue, inventory, payouts, promotions and business insights for your shop.',
    target: '/portal.html#/sell/overview',
    cta: 'Open the Seller Hub',
    creds: { email: 'owner@nearbuy.demo', pass: 'Seller123!' },
    handoff: 'Opening the Seller Hub'
  },
  {
    dir: 'seller/register',
    accent: '#2b8a66',
    kicker: 'Sell on NearBuy',
    title: 'Register your shop',
    blurb: 'A guided seven-step application: business, store, location, operations and payout details.',
    target: '/portal.html#/sell/register',
    cta: 'Start the seller application',
    creds: null,
    publicNote: 'Registration is public — you do not need an account to apply.',
    handoff: 'Opening the seller application'
  },
  {
    dir: 'runner',
    accent: '#2f6bd8',
    kicker: 'Deliver workspace',
    title: 'Opening the partner app',
    blurb: 'Go online, accept nearby offers, pick up, deliver and track earnings on your own terms.',
    target: '/portal.html#/deliver/overview',
    cta: 'Open the partner app',
    creds: { email: 'rohan@nearbuy.demo', pass: 'Runner123!' },
    handoff: 'Opening the partner app'
  },
  {
    dir: 'runner/register',
    accent: '#2f6bd8',
    kicker: 'Deliver with NearBuy',
    title: 'Apply as a delivery partner',
    blurb: 'Seven steps including an age gate, document checks, an emergency contact and a safety briefing.',
    target: '/portal.html#/deliver/register',
    cta: 'Start the partner application',
    creds: null,
    publicNote: 'Registration is public — you do not need an account to apply.',
    handoff: 'Opening the partner application'
  },
  {
    dir: 'fleet',
    accent: '#7048e8',
    kicker: 'Fleet workspace',
    title: 'Opening fleet coordination',
    blurb: 'Coordinate a neighbourhood delivery team: roster, work allocation, reports and safety.',
    target: '/portal.html#/fleet/overview',
    cta: 'Open the fleet workspace',
    creds: { email: 'arjun@nearbuy.demo', pass: 'Fleet123!' },
    handoff: 'Opening the fleet workspace'
  },
  {
    dir: 'admin',
    accent: '#0ca678',
    kicker: 'Internal · not indexed',
    title: 'Operations console',
    blurb: 'The gated internal control tower. A session plus the operations access code is required.',
    target: '/portal.html#/ops/overview',
    cta: 'Go to the operations gate',
    creds: { code: 'NB-OPS-2026' },
    noindex: true,
    handoff: 'Taking you to the operations gate'
  },
  {
    dir: 'control-tower',
    accent: '#0ca678',
    kicker: 'Internal · not indexed',
    title: 'Control tower',
    blurb: 'Live deliveries, dispatch, verifications, service areas, pricing bands and the audit log.',
    target: '/portal.html#/ops/overview',
    cta: 'Open the control tower',
    creds: { code: 'NB-OPS-2026' },
    noindex: true,
    handoff: 'Opening the control tower'
  }
];

const page = (d) => `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${d.noindex ? '<meta name="robots" content="noindex" />\n' : ''}<meta name="theme-color" content="#081428" />
<title>${d.title} · NearBuy</title>
<link rel="icon" href="/public/assets/nearbuy-logo.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&family=Manrope:wght@600;700;800&display=swap" rel="stylesheet" />
<style>
  :root { --accent: ${d.accent}; color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 28px;
    background:
      radial-gradient(1100px 520px at 12% -10%, rgba(244,119,24,.14), transparent 60%),
      radial-gradient(900px 480px at 92% 8%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 62%),
      #fbf7f0;
    color: #223350;
    font: 400 16px/1.6 'DM Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  main {
    width: min(520px, 100%); background: #fffdfa; border: 1px solid #e9e2d5; border-radius: 26px;
    padding: 40px 36px; text-align: center;
    box-shadow: 0 30px 70px rgba(12, 26, 51, .14);
  }
  .mark { width: 88px; height: 88px; margin: 0 auto 16px; display: block; filter: drop-shadow(0 10px 22px rgba(12, 26, 51, .14)); }
  .mark img, .mark svg { width: 100%; height: 100%; display: block; object-fit: contain; }
  .kicker {
    display: inline-flex; align-items: center; gap: 8px; margin-bottom: 14px;
    font: 700 11px/1 'Manrope', system-ui, sans-serif; letter-spacing: .14em; text-transform: uppercase;
    color: var(--accent);
  }
  .kicker i { width: 18px; height: 2px; border-radius: 2px; background: var(--accent); display: inline-block; }
  h1 { font: 800 32px/1.15 'Manrope', system-ui, sans-serif; color: #0c1a33; margin: 0 0 10px; }
  p.lead { margin: 0 auto 24px; max-width: 40ch; color: #6f7b8f; }
  a.cta {
    display: inline-block; padding: 13px 26px; border-radius: 999px; text-decoration: none;
    background: var(--accent); color: #fff; font: 700 15px/1 'Manrope', system-ui, sans-serif;
    box-shadow: 0 12px 26px color-mix(in srgb, var(--accent) 34%, transparent);
  }
  a.cta:hover { filter: brightness(.94); }
  .creds {
    margin: 24px auto 0; padding: 14px 16px; max-width: 340px;
    background: #f7f3ea; border: 1px dashed #e0d7c4; border-radius: 14px;
    font-size: 13.5px; color: #4b5a72; text-align: left;
  }
  .creds b { display: block; margin-bottom: 6px; font: 700 11px/1 'Manrope', system-ui, sans-serif;
    letter-spacing: .1em; text-transform: uppercase; color: #6f7b8f; }
  .creds code { display: block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #0c1a33; }
  .handoff { margin: 22px 0 0; font-size: 13px; color: #939cae; }
  .handoff b { color: #4b5a72; font-weight: 600; }
  .handoff button {
    border: 0; background: none; padding: 0; margin-left: 6px; cursor: pointer;
    color: var(--accent); font: inherit; text-decoration: underline;
  }
  .home { display: inline-block; margin-top: 18px; font-size: 13px; color: #6f7b8f; text-decoration: none; }
  .home:hover { color: #0c1a33; }
  .bar { height: 3px; width: 0%; margin: 14px auto 0; border-radius: 3px; background: var(--accent);
    transition: width .2s linear; }
</style>
</head>
<body>
<main>
  <span class="mark">${MARK}</span>
  <span class="kicker"><i></i>${d.kicker}</span>
  <h1>${d.title}</h1>
  <p class="lead">${d.blurb}</p>
  <a class="cta" href="${d.target}">${d.cta}</a>
  ${d.creds && d.creds.email ? `<div class="creds"><b>Demo sign-in</b><code>${d.creds.email}</code><code>${d.creds.pass}</code></div>` : ''}
  ${d.creds && d.creds.code ? `<div class="creds"><b>Operations access code</b><code>${d.creds.code}</code></div>` : ''}
  ${d.publicNote ? `<div class="creds"><b>Public route</b>${d.publicNote}</div>` : ''}
  <p class="handoff">${d.handoff} in <b id="t">6</b>s<button id="stop" type="button">stay here</button></p>
  <div class="bar" id="bar" role="presentation"></div>
  <a class="home" href="/">&larr; Back to NearBuy home</a>
  <noscript><p class="handoff">JavaScript is off, so use the button above to continue.</p></noscript>
</main>
<script>
  (function () {
    var target = ${JSON.stringify(d.target)};
    var total = 6000;
    var left = total;
    var t = document.getElementById('t');
    var bar = document.getElementById('bar');
    var timer = setInterval(function () {
      left -= 100;
      t.textContent = Math.max(0, Math.ceil(left / 1000));
      bar.style.width = ((total - left) / total) * 100 + '%';
      if (left <= 0) { clearInterval(timer); location.replace(target); }
    }, 100);
    document.getElementById('stop').addEventListener('click', function () {
      clearInterval(timer);
      this.closest('p').innerHTML = 'Automatic hand-off stopped.';
    });
  })();
</script>
</body>
</html>
`;

for (const d of DOORS) {
  const file = join(d.dir, 'index.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, page(d));
  process.stdout.write(`wrote ${file}\n`);
}
