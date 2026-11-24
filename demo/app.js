'use strict';
const status = document.querySelector('#status');
const buttons = [...document.querySelectorAll('[data-role]')];
async function request(method, body) {
  const res = await fetch('/api/customer/auth/demo', { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-NearBuy-Request': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let data;
  try { data = await res.json(); } catch { throw new Error('The NearBuy backend is unavailable. This site needs its Node API server, not static hosting alone.'); }
  if (!res.ok) throw new Error(data.error || data.message || 'Demo sign-in failed. Please try again.');
  return data;
}
request('GET').then(data => {
  status.textContent = data.enabled ? 'Choose a portal to begin. Your session stays signed in after refresh.' : 'Demo access is disabled or this database contains non-demo records. Use your normal portal sign-in.';
  buttons.forEach(button => { button.disabled = !data.enabled; });
}).catch(error => { status.textContent = error.message; });
buttons.forEach(button => button.addEventListener('click', async () => {
  buttons.forEach(b => { b.disabled = true; });
  status.textContent = 'Signing in securely…';
  try { const data = await request('POST', { role: button.dataset.role }); window.location.assign(data.portal); }
  catch (error) { status.textContent = error.message; buttons.forEach(b => { b.disabled = false; }); }
}));
