#!/usr/bin/env node
/*
 * tools/render-logo.mjs — processes and syncs the universal NearBuy badge logo
 * across `public/assets/nearbuy-logo.png` and `delivery/logo.svg`.
 *
 * Dependency-free (node:zlib + node:fs):
 *   - Decodes 8-bit RGB / RGBA PNGs (scanline filters 0..4)
 *   - Flood-fills opaque exterior background/shadow outside the circular badge
 *     when given a flat RGB badge source, with smooth anti-aliased edge matting
 *   - Centers and Lanczos-2 resamples in premultiplied alpha space
 *   - Writes `public/assets/nearbuy-logo.png` and `delivery/logo.svg`
 *
 * Usage:
 *   node tools/render-logo.mjs [--in <source.png>] [--size 512] [--out public/assets/nearbuy-logo.png]
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/* ---------------------------------- cli ----------------------------------- */
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const OUT = resolve(arg('out', 'public/assets/nearbuy-logo.png'));
const IN = resolve(arg('in', OUT));
const SIZE = Number(arg('size', 512));
const SVG_OUT = resolve(arg('svg-out', 'delivery/logo.svg'));
const SVG_SIZE = Number(arg('svg-size', 256));
const WRITE_SVG = !hasFlag('no-svg');

/* ------------------------------ png decode -------------------------------- */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  if (buf.subarray(0, 8).compare(PNG_SIG) !== 0) {
    throw new Error('Input is not a valid PNG file');
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}`);
  }

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idatChunks));
  const recon = new Uint8Array(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const srcOff = y * (stride + 1) + 1;
    const dstOff = y * stride;
    const prevOff = (y - 1) * stride;

    for (let i = 0; i < stride; i++) {
      const x = raw[srcOff + i];
      const a = i >= bpp ? recon[dstOff + i - bpp] : 0;
      const b = y > 0 ? recon[prevOff + i] : 0;
      const c = y > 0 && i >= bpp ? recon[prevOff + i - bpp] : 0;
      let val = x;
      if (filter === 1) val = (x + a) & 0xff;
      else if (filter === 2) val = (x + b) & 0xff;
      else if (filter === 3) val = (x + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) val = (x + paethPredictor(a, b, c)) & 0xff;
      recon[dstOff + i] = val;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  if (colorType === 6) {
    rgba.set(recon);
  } else {
    for (let p = 0; p < width * height; p++) {
      rgba[p * 4] = recon[p * 3];
      rgba[p * 4 + 1] = recon[p * 3 + 1];
      rgba[p * 4 + 2] = recon[p * 3 + 2];
      rgba[p * 4 + 3] = 255;
    }
  }
  return { width, height, colorType, rgba };
}

/* ------------------------ exterior badge extraction ----------------------- */
function extractCircularBadge(img) {
  const { width: w, height: h, rgba: src } = img;
  // If corners are already transparent, preserve existing alpha as-is.
  const cornersOpaqueLight = [0, w - 1, (h - 1) * w, (h - 1) * w + (w - 1)].every((idx) => {
    const a = src[idx * 4 + 3];
    const mn = Math.min(src[idx * 4], src[idx * 4 + 1], src[idx * 4 + 2]);
    return a === 255 && mn >= 200;
  });
  if (!cornersOpaqueLight) return img;

  const total = w * h;
  const ext = new Uint8Array(total);
  const queue = new Int32Array(total);
  let qHead = 0;
  let qTail = 0;

  for (const [sx, sy] of [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ]) {
    const idx = sy * w + sx;
    ext[idx] = 1;
    queue[qTail++] = idx;
  }

  const dirs4 = [-1, 1, -w, w];
  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % w;
    const y = (idx - x) / w;
    for (let k = 0; k < 4; k++) {
      const nx = k === 0 ? x - 1 : k === 1 ? x + 1 : x;
      const ny = k === 2 ? y - 1 : k === 3 ? y + 1 : y;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const nidx = ny * w + nx;
      if (ext[nidx]) continue;
      const i4 = nidx * 4;
      const r = src[i4];
      const g = src[i4 + 1];
      const b = src[i4 + 2];
      const mn = Math.min(r, g, b);
      const mx = Math.max(r, g, b);
      if (mn >= 180 && mx - mn <= 30) {
        ext[nidx] = 1;
        queue[qTail++] = nidx;
      }
    }
  }

  const dist = new Uint8Array(total);
  dist.fill(99);
  qHead = 0;
  qTail = 0;

  for (let idx = 0; idx < total; idx++) {
    if (!ext[idx]) continue;
    dist[idx] = 0;
    const x = idx % w;
    const y = (idx - x) / w;
    if (
      (x > 0 && !ext[idx - 1]) ||
      (x + 1 < w && !ext[idx + 1]) ||
      (y > 0 && !ext[idx - w]) ||
      (y + 1 < h && !ext[idx + w])
    ) {
      queue[qTail++] = idx;
    }
  }

  while (qHead < qTail) {
    const idx = queue[qHead++];
    const d = dist[idx];
    if (d >= 4) continue;
    const x = idx % w;
    const y = (idx - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        const nidx = ny * w + nx;
        if (dist[nidx] > d + 1) {
          dist[nidx] = d + 1;
          queue[qTail++] = nidx;
        }
      }
    }
  }

  const out = new Uint8Array(total * 4);
  let minX = w;
  let maxX = 0;
  let minY = h;
  let maxY = 0;

  for (let idx = 0; idx < total; idx++) {
    const d = dist[idx];
    if (d === 0) continue;
    const i4 = idx * 4;
    const r = src[i4];
    const g = src[i4 + 1];
    const b = src[i4 + 2];
    const x = idx % w;
    const y = (idx - x) / w;

    if (d <= 2) {
      let bestD2 = 999;
      let fr = r;
      let fg = g;
      let fb = b;
      for (let dy = -4; dy <= 4; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -4; dx <= 4; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const nidx = ny * w + nx;
          if (dist[nidx] >= 3) {
            const dd2 = dx * dx + dy * dy;
            if (dd2 < bestD2) {
              bestD2 = dd2;
              fr = src[nidx * 4];
              fg = src[nidx * 4 + 1];
              fb = src[nidx * 4 + 2];
            }
          }
        }
      }
      const wr = 255 - r;
      const wg = 255 - g;
      const wb = 255 - b;
      const vr = 255 - fr;
      const vg = 255 - fg;
      const vb = 255 - fb;
      const denom = vr * vr + vg * vg + vb * vb;
      let alpha = denom < 100 ? 0 : (wr * vr + wg * vg + wb * vb) / denom;
      alpha = Math.max(0, Math.min(1, (alpha - 0.08) / 0.92));
      const fa = Math.round(alpha * 255);
      if (fa > 0) {
        out[i4] = fr;
        out[i4 + 1] = fg;
        out[i4 + 2] = fb;
        out[i4 + 3] = fa;
        if (fa > 16) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    } else {
      out[i4] = r;
      out[i4 + 1] = g;
      out[i4 + 2] = b;
      out[i4 + 3] = 255;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const side = Math.max(bw, bh) + 12;
  const ox = Math.round(side / 2 - (minX + maxX) / 2);
  const oy = Math.round(side / 2 - (minY + maxY) / 2);
  const sq = new Uint8Array(side * side * 4);

  for (let y = minY; y <= maxY; y++) {
    const dy = y + oy;
    if (dy < 0 || dy >= side) continue;
    for (let x = minX; x <= maxX; x++) {
      const dx = x + ox;
      if (dx < 0 || dx >= side) continue;
      const si = (y * w + x) * 4;
      const di = (dy * side + dx) * 4;
      sq[di] = out[si];
      sq[di + 1] = out[si + 1];
      sq[di + 2] = out[si + 2];
      sq[di + 3] = out[si + 3];
    }
  }

  return { width: side, height: side, colorType: 6, rgba: sq };
}

/* --------------------- premultiplied lanczos-2 resize --------------------- */
function lanczos2(x) {
  if (x === 0) return 1;
  if (Math.abs(x) >= 2) return 0;
  const px = Math.PI * x;
  return (Math.sin(px) / px) * (Math.sin(px / 2) / (px / 2));
}

function resizeRgba(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return new Uint8Array(src);
  const scaleX = sw / dw;
  const scaleY = sh / dh;
  const supX = 2 * Math.max(1, scaleX);
  const supY = 2 * Math.max(1, scaleY);

  const hWeights = Array.from({ length: dw }, (_, dx) => {
    const cx = (dx + 0.5) * scaleX - 0.5;
    const left = Math.max(0, Math.floor(cx - supX));
    const right = Math.min(sw - 1, Math.ceil(cx + supX));
    const wts = [];
    let sum = 0;
    for (let sx = left; sx <= right; sx++) {
      const wt = lanczos2((sx - cx) / Math.max(1, scaleX));
      wts.push([sx * 4, wt]);
      sum += wt;
    }
    return wts.map(([off, wt]) => [off, wt / sum]);
  });

  const tmp = new Float32Array(sh * dw * 4);
  for (let sy = 0; sy < sh; sy++) {
    const rowOff = sy * sw * 4;
    const outRow = sy * dw * 4;
    for (let dx = 0; dx < dw; dx++) {
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      for (const [off, wt] of hWeights[dx]) {
        const i = rowOff + off;
        const a = src[i + 3] / 255;
        if (a > 0) {
          pr += src[i] * a * wt;
          pg += src[i + 1] * a * wt;
          pb += src[i + 2] * a * wt;
          pa += a * wt;
        }
      }
      const o = outRow + dx * 4;
      tmp[o] = pr;
      tmp[o + 1] = pg;
      tmp[o + 2] = pb;
      tmp[o + 3] = pa;
    }
  }

  const vWeights = Array.from({ length: dh }, (_, dy) => {
    const cy = (dy + 0.5) * scaleY - 0.5;
    const top = Math.max(0, Math.floor(cy - supY));
    const bot = Math.min(sh - 1, Math.ceil(cy + supY));
    const wts = [];
    let sum = 0;
    for (let sy = top; sy <= bot; sy++) {
      const wt = lanczos2((sy - cy) / Math.max(1, scaleY));
      wts.push([sy * dw * 4, wt]);
      sum += wt;
    }
    return wts.map(([off, wt]) => [off, wt / sum]);
  });

  const out = new Uint8Array(dw * dh * 4);
  for (let dy = 0; dy < dh; dy++) {
    const outRow = dy * dw * 4;
    for (let dx = 0; dx < dw; dx++) {
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      const col = dx * 4;
      for (const [roff, wt] of vWeights[dy]) {
        const i = roff + col;
        pr += tmp[i] * wt;
        pg += tmp[i + 1] * wt;
        pb += tmp[i + 2] * wt;
        pa += tmp[i + 3] * wt;
      }
      const o = outRow + col;
      pa = Math.max(0, Math.min(1, pa));
      if (pa >= 1 / 255) {
        out[o] = Math.round(Math.max(0, Math.min(255, pr / pa)));
        out[o + 1] = Math.round(Math.max(0, Math.min(255, pg / pa)));
        out[o + 2] = Math.round(Math.max(0, Math.min(255, pb / pa)));
        out[o + 3] = Math.round(pa * 255);
      }
    }
  }
  return out;
}

/* ----------------------------- png encoding ------------------------------- */
const crcTable = (() => {
  const tbl = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tbl[n] = c;
  }
  return tbl;
})();

const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const rowOff = y * stride;
    const dstOff = y * (stride + 1);
    raw[dstOff] = 1; // Sub filter
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? rgba[rowOff + i - 4] : 0;
      raw[dstOff + 1 + i] = (rgba[rowOff + i] - left) & 0xff;
    }
  }
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------- run ----------------------------------- */
const decoded = decodePng(readFileSync(IN));
const badge = extractCircularBadge(decoded);
const resized = resizeRgba(badge.rgba, badge.width, badge.height, SIZE, SIZE);
const pngBytes = encodePng(SIZE, SIZE, resized);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, pngBytes);
process.stdout.write(`wrote ${OUT} (${SIZE}x${SIZE}, ${pngBytes.length} bytes)\n`);

if (WRITE_SVG) {
  const svgRgba = resizeRgba(badge.rgba, badge.width, badge.height, SVG_SIZE, SVG_SIZE);
  const svgPng = encodePng(SVG_SIZE, SVG_SIZE, svgRgba);
  const b64 = svgPng.toString('base64');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_SIZE} ${SVG_SIZE}" width="44" height="44" role="img" aria-label="NearBuy">
  <image width="${SVG_SIZE}" height="${SVG_SIZE}" href="data:image/png;base64,${b64}"/>
</svg>
`;
  mkdirSync(dirname(SVG_OUT), { recursive: true });
  writeFileSync(SVG_OUT, svg);
  process.stdout.write(`wrote ${SVG_OUT} (${SVG_SIZE}x${SVG_SIZE} embedded, ${svg.length} bytes)\n`);
}
