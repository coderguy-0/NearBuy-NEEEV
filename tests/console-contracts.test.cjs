/*
 * NearBuy — console contract regression tests (zero dependencies).
 *
 *   node --test tests/*.test.cjs      (or simply `npm test`)
 *
 * The three consoles (Seller Hub, Runner Portal, Admin Portal) are thin clients
 * over the partner/admin API. When the server changes a response shape, the page
 * does not fail loudly — it renders the error view instead of the dashboard. These
 * tests pin the shapes the consoles read, and statically guard two client-side
 * rules that only show up in a browser:
 *
 *   1. the CSRF token must be restored together with a restored session,
 *   2. `e.currentTarget` is null once an `await` yields, so it must be captured
 *      synchronously at the top of every async handler that uses it.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 4213;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nearbuy-contracts-'));

let child;

function client() {
  let cookie = '';
  let csrf = '';
  return {
    async req(pathname, { method, body } = {}) {
      const h = { 'X-NearBuy-Request': '1', Origin: BASE };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (cookie) h.Cookie = cookie;
      if (csrf) h['X-NearBuy-CSRF'] = csrf;
      const res = await fetch(BASE + pathname, {
        method: method || (body !== undefined ? 'POST' : 'GET'),
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual'
      });
      for (const raw of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const pair = raw.split(';')[0];
        if (/^nb_(session|partner_session|admin_session)=/.test(pair)) cookie = pair.endsWith('=') ? '' : pair;
      }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (json && json.user && json.user.csrf) csrf = json.user.csrf;
      return { status: res.status, json, text };
    }
  };
}

async function must(promise, status, label) {
  const res = await promise;
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} — ${res.text?.slice(0, 260) || ''}`);
  return res.json;
}

before(async () => {
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NEARBUY_DB: path.join(DATA_DIR, 'db.sqlite') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start in time')), 20000);
    child.stdout.on('data', (d) => { if (String(d).includes(`http://localhost:${PORT}`)) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', (d) => { if (String(d).includes('EADDRINUSE')) { clearTimeout(t); reject(new Error('port busy')); } });
  });
});

after(async () => {
  if (child) child.kill('SIGTERM');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* API shape contracts the consoles read                               */
/* ------------------------------------------------------------------ */

test('seller hours endpoint returns the grouped payload the Business Hours page reads', async () => {
  const c = client();
  await must(c.req('/api/customer/auth/demo', { body: { role: 'seller' } }), 200, 'demo seller sign-in');
  const data = await must(c.req('/api/partner/seller/hours'), 200, 'GET /seller/hours');

  assert.ok(data.hours && typeof data.hours === 'object', 'hours is an object');
  assert.ok(Array.isArray(data.hours.days), 'hours.days is an array');
  assert.equal(data.hours.days.length, 7, 'one row per weekday');
  assert.ok(Array.isArray(data.hours.holidays), 'hours.holidays is an array');
  for (const d of data.hours.days) {
    assert.ok(Number.isInteger(d.day) && d.day >= 0 && d.day <= 6, 'day is 0–6');
    assert.match(String(d.open), /^\d{1,2}:\d{2}$/, `${d.day} open is HH:MM`);
    assert.match(String(d.close), /^\d{1,2}:\d{2}$/, `${d.day} close is HH:MM`);
    assert.equal(typeof d.closed, 'boolean', `${d.day} closed is boolean`);
  }
  assert.equal(typeof data.hours.isOpen, 'boolean', 'hours.isOpen is a boolean');
  assert.ok(data.nextOpening === null || typeof data.nextOpening === 'string', 'nextOpening is null or a string');
});

test('seller analytics endpoint returns metrics + series, not the legacy totals + daily shape', async () => {
  const c = client();
  await must(c.req('/api/customer/auth/demo', { body: { role: 'seller' } }), 200, 'demo seller sign-in');
  const data = await must(c.req('/api/partner/seller/analytics?range=30d'), 200, 'GET /seller/analytics');

  assert.ok(data.metrics && typeof data.metrics === 'object', 'metrics is present');
  assert.ok(Array.isArray(data.series), 'series is an array');
  assert.equal(typeof data.metrics.orderCount, 'number', 'metrics.orderCount');
  assert.equal(typeof data.metrics.refunds, 'number', 'metrics.refunds');
  assert.equal(typeof data.metrics.grossSales, 'number', 'metrics.grossSales');
  for (const row of data.series) {
    assert.match(String(row.date), /^\d{4}-\d{2}-\d{2}$/, 'series rows are keyed by date');
    assert.equal(typeof row.sales, 'number', 'series row sales');
  }
  // The dashboard used to read these two legacy keys and throw on the undefined lookup.
  assert.equal(data.totals, undefined, 'legacy analytics.totals is gone');
  assert.equal(data.daily, undefined, 'legacy analytics.daily is gone');
});

test('seller overview returns the counts / products / recent blocks the dashboard reads', async () => {
  const c = client();
  await must(c.req('/api/customer/auth/demo', { body: { role: 'seller' } }), 200, 'demo seller sign-in');
  const data = await must(c.req('/api/partner/seller/overview'), 200, 'GET /seller/overview');

  assert.ok(data.counts && typeof data.counts === 'object', 'counts is present');
  assert.ok(Array.isArray(data.recent), 'recent is an array');
  assert.ok(Array.isArray(data.lowStock), 'lowStock is an array');
  assert.equal(typeof data.products.total, 'number', 'products.total');
  assert.equal(typeof data.grossSales, 'number', 'grossSales');
  assert.equal(typeof data.revenue, 'number', 'revenue');
  assert.equal(typeof data.refunds, 'number', 'refunds');
});

test('every partner and admin session endpoint ships the CSRF token the console must send back', async () => {
  for (const [role, base, cookieName] of [
    ['seller', '/api/partner', 'nb_partner_session'],
    ['runner', '/api/partner', 'nb_partner_session'],
    ['admin', '/api/admin', 'nb_admin_session']
  ]) {
    const c = client();
    const signIn = await c.req('/api/customer/auth/demo', { body: { role } });
    assert.equal(signIn.status, 200, `${role} demo sign-in`);

    const me = await must(c.req(`${base}/me`), 200, `GET ${base}/me (${role})`);
    assert.ok(me.user, `${role}: /me returns a user`);
    assert.match(String(me.user.csrf), /^[0-9a-f]{16,}$/, `${role}: /me returns the session CSRF token`);

    // A mutation must succeed with only that token — no page reload, no re-login.
    const probe = await c.req(`${base}/me`, { method: 'POST', body: {} });
    assert.notEqual(probe.status, 403, `${role}: mutation with the restored CSRF token is not refused`);
    assert.ok(cookieName, 'cookie name is known');
  }
});

/* ------------------------------------------------------------------ */
/* Client rules that only fail in a browser                            */
/* ------------------------------------------------------------------ */

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* Find the byte range of the body opened by the `{` at `openIdx`, skipping strings,
 * template literals and comments so `${...}` braces cannot unbalance the count. */
function bodyRange(source, openIdx) {
  let i = openIdx + 1;
  let depth = 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (ch === '/' && source[i + 1] === '*') { i += 2; while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++; i += 2; continue; }
    if (ch === "'" || ch === '"') {
      i++;
      while (i < source.length && source[i] !== ch) { if (source[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (ch === '`') {
      i++;
      let tpl = 0;
      while (i < source.length) {
        const c = source[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '`' && tpl === 0) { i++; break; }
        if (c === '$' && source[i + 1] === '{') { tpl++; i += 2; continue; }
        if (c === '{') { tpl++; i++; continue; }
        if (c === '}') { tpl--; i++; continue; }
        i++;
      }
      continue;
    }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth--; i++; if (depth === 0) return { start: openIdx + 1, end: i - 1 }; continue; }
    i++;
  }
  return { start: openIdx + 1, end: source.length };
}

/* Body of an arrow function whose body is an expression (`(e) => doThing(e.x)`),
 * which therefore has no braces to find. Returns null when the body is a block. */
function exprArrowRange(source, afterArrowIdx) {
  let i = afterArrowIdx;
  while (i < source.length && /\s/.test(source[i])) i++;
  if (source[i] === '{') return null;
  const start = i;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === "'" || ch === '"') {
      i++;
      while (i < source.length && source[i] !== ch) { if (source[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (ch === '`') {
      i++;
      let tpl = 0;
      while (i < source.length) {
        const c = source[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '`' && tpl === 0) { i++; break; }
        if (c === '$' && source[i + 1] === '{') { tpl++; i += 2; continue; }
        if (c === '{') { tpl++; i++; continue; }
        if (c === '}') { tpl--; i++; continue; }
        i++;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth--; i++; continue; }
    if (depth === 0 && (ch === ',' || ch === ';')) break;
    i++;
  }
  return { start, end: i };
}

/* Every function body in the file, with the index of its opening brace and whether
 * the function is `async`. Covers `function f() {}`, `(a) => {}`, `(a) => expr`
 * and `async m() {}`. */
function functionRanges(source) {
  const ranges = [];
  const blockPatterns = [
    /\basync\s+function\s+\w*\s*\([^)]*\)\s*\{/g,
    /\bfunction\s+\w*\s*\([^)]*\)\s*\{/g,
    /\basync\s+\w+\s*\([^)]*\)\s*\{/g
  ];
  for (const re of blockPatterns) {
    let m;
    while ((m = re.exec(source))) {
      const openIdx = m.index + m[0].length - 1;
      const isAsync = /^\s*async\b/.test(m[0]) || /\basync\s*$/.test(source.slice(0, m.index));
      ranges.push({ openIdx, isAsync, ...bodyRange(source, openIdx) });
    }
  }
  /* `[^()]*` keeps the match on the innermost parameter list, so an outer call like
   * `PA.on('#id', 'click', async (e) => {` is not matched from its own opening paren. */
  const arrowRe = /\(([^()]*)\)\s*=>/g;
  let m;
  while ((m = arrowRe.exec(source))) {
    const isAsync = /\basync\s*$/.test(source.slice(0, m.index));
    const afterArrow = m.index + m[0].length;
    let brace = afterArrow;
    while (brace < source.length && /\s/.test(source[brace])) brace++;
    if (source[brace] === '{') {
      ranges.push({ openIdx: brace, isAsync, ...bodyRange(source, brace) });
    } else {
      const expr = exprArrowRange(source, afterArrow);
      if (expr) ranges.push({ openIdx: -1, isAsync, ...expr });
    }
  }
  return ranges.sort((a, b) => (a.start - b.start) || (b.end - a.end));
}

/* End index of the expression that follows an `await`. Arguments of the awaited call
 * are evaluated before the function suspends, so an access inside this range is safe. */
function awaitedExprEnd(source, awaitIdx) {
  let i = awaitIdx + 5;
  while (i < source.length && /\s/.test(source[i])) i++;
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === "'" || ch === '"') {
      i++;
      while (i < source.length && source[i] !== ch) { if (source[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (ch === '`') {
      i++;
      let tpl = 0;
      while (i < source.length) {
        const c = source[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '`' && tpl === 0) { i++; break; }
        if (c === '$' && source[i + 1] === '{') { tpl++; i += 2; continue; }
        if (c === '{') { tpl++; i++; continue; }
        if (c === '}') { tpl--; i++; continue; }
        i++;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth--; i++; continue; }
    if (depth === 0 && (ch === ';' || ch === ',')) break;
    if (depth === 0 && ch === '\n' && /[;,)}/\]]/.test(source.slice(Math.max(0, i - 30), i).replace(/'.*'|".*"|`.*`/g, ''))) break;
    i++;
  }
  return i;
}

test('no console handler reads e.currentTarget after awaiting', () => {
  // `currentTarget` is only set while the event is being dispatched; after the first
  // `await` the browser has already reset it to null, so `e.currentTarget.x` throws.
  // Reading it while *building* the awaited call is fine — those arguments run first.
  for (const file of ['partner/seller.js', 'partner/runner.js', 'partner/admin.js', 'partner/core.js']) {
    const source = read(file);
    const ranges = functionRanges(source);
    const re = /e\.currentTarget/g;
    let m;
    while ((m = re.exec(source))) {
      const at = m.index;
      // Innermost function that contains this access.
      const enclosing = ranges.filter((r) => r.start <= at && at <= r.end).pop();
      if (!enclosing || !enclosing.isAsync) continue;

      const before = source.slice(enclosing.start, at);
      const awaits = [...before.matchAll(/\bawait\b/g)];
      if (!awaits.length) continue;
      const lastAwait = enclosing.start + awaits[awaits.length - 1].index;
      const evaluatedBefore = awaitedExprEnd(source, lastAwait);
      if (at >= evaluatedBefore) {
        const line = source.slice(0, at).split('\n').length;
        assert.fail(`${file}:${line} reads e.currentTarget after an await — the browser has already set it to null`);
      }
    }
  }
});

test('the console restores the CSRF token together with a restored session', () => {
  const source = read('partner/core.js');
  const bootAt = source.indexOf('async function boot(');
  assert.notEqual(bootAt, -1, 'boot() exists');
  const body = bodyRange(source, source.indexOf('{', bootAt));
  const bootBody = source.slice(body.start, body.end);
  assert.match(bootBody, /state\.csrf\s*=\s*\(me\.user\s*&&\s*me\.user\.csrf\)/,
    'boot() must copy me.user.csrf into state.csrf, otherwise every mutation after a reload is refused');
});
