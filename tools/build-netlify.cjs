'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const output = path.join(root, 'dist');
const backend = process.env.NEARBUY_API_ORIGIN;
if (!backend) throw new Error('Set NEARBUY_API_ORIGIN to your persistent HTTPS Node backend origin. Netlify cannot run this SQLite server as a static site.');
const url = new URL(backend);
if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('NEARBUY_API_ORIGIN must be a bare HTTPS origin without credentials or path.');
fs.mkdirSync(output, { recursive: true });
// Allowlist only public surfaces. Never publish repository root, DBs or server code.
for (const item of fs.readdirSync(root, { withFileTypes: true })) {
  if ((item.isFile() && /\.(html|css|js)$/.test(item.name)) || (item.isDirectory() && ['about','admin','control-tower','customer','delivery','demo','fleet','help','partner','public','roadmap','runner','seller'].includes(item.name))) {
    fs.cpSync(path.join(root, item.name), path.join(output, item.name), { recursive: true });
  }
}
fs.writeFileSync(path.join(output, '_redirects'), `/api/* ${url.origin}/api/:splat 200!\n`);
console.log('Public assets staged; API requests proxy to the configured persistent backend.');
