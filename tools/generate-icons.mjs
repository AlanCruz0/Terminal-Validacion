// Genera los íconos PNG de la PWA sin dependencias externas.
// Uso: node tools/generate-icons.mjs
// Dibuja figuras simples (círculos y trazos) con supermuestreo 4x4 y las codifica como PNG RGBA.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

// ---------- Codificador PNG mínimo ----------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Geometría ----------
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const TOP = hex('#16233f');
const BOTTOM = hex('#0a1020');
const SKY = hex('#38bdf8');
const GREEN = hex('#22c55e');
const RED = hex('#f87171');
const WHITE = hex('#ffffff');

const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function insideRoundedSquare(x, y, r) {
  const qx = Math.abs(x - 0.5) - (0.5 - r);
  const qy = Math.abs(y - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r <= 0;
}

function inside(shape, x, y) {
  if (shape.type === 'circle') return Math.hypot(x - shape.cx, y - shape.cy) <= shape.r;
  if (shape.type === 'line') {
    for (let i = 0; i < shape.pts.length - 1; i++) {
      const [ax, ay] = shape.pts[i];
      const [bx, by] = shape.pts[i + 1];
      if (segDist(x, y, ax, ay, bx, by) <= shape.w / 2) return true;
    }
  }
  return false;
}

// Esquinas tipo "visor de escáner"
function brackets(color) {
  const a = 0.2, b = 0.8, L = 0.17, w = 0.05;
  return [
    { type: 'line', pts: [[a, a + L], [a, a], [a + L, a]], w, color },
    { type: 'line', pts: [[b - L, a], [b, a], [b, a + L]], w, color },
    { type: 'line', pts: [[a, b - L], [a, b], [a + L, b]], w, color },
    { type: 'line', pts: [[b - L, b], [b, b], [b, b - L]], w, color },
  ];
}

const GLYPHS = {
  validar: [
    ...brackets(SKY),
    { type: 'circle', cx: 0.5, cy: 0.5, r: 0.19, color: GREEN },
    { type: 'line', pts: [[0.415, 0.505], [0.475, 0.565], [0.59, 0.445]], w: 0.045, color: WHITE },
  ],
  simular: [
    ...brackets(SKY),
    ...[[0.34, 0.03], [0.4, 0.015], [0.445, 0.04], [0.505, 0.015], [0.55, 0.03], [0.605, 0.015], [0.655, 0.035]].map(
      ([x, w]) => ({ type: 'line', pts: [[x, 0.36], [x, 0.64]], w, color: WHITE }),
    ),
    { type: 'line', pts: [[0.29, 0.5], [0.71, 0.5]], w: 0.035, color: RED },
  ],
  bitacora: [
    ...[0.34, 0.5, 0.66].flatMap((y, i) => [
      { type: 'circle', cx: 0.3, cy: y, r: 0.045, color: i === 1 ? RED : GREEN },
      { type: 'line', pts: [[0.42, y], [0.72, y]], w: 0.055, color: WHITE },
    ]),
  ],
};

function render(size, { glyph, maskable = false, radius = 0.2, scale }) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  const shapes = GLYPHS[glyph];
  const s = scale ?? (maskable ? 0.8 : 1);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, covered = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          if (!maskable && !insideRoundedSquare(x, y, radius)) continue;
          let col = lerp(TOP, BOTTOM, y);
          const ux = (x - 0.5) / s + 0.5;
          const uy = (y - 0.5) / s + 0.5;
          for (const sh of shapes) if (inside(sh, ux, uy)) col = sh.color;
          r += col[0]; g += col[1]; b += col[2]; covered++;
        }
      }
      const i = (py * size + px) * 4;
      if (covered) {
        buf[i] = Math.round(r / covered);
        buf[i + 1] = Math.round(g / covered);
        buf[i + 2] = Math.round(b / covered);
      }
      buf[i + 3] = Math.round((covered / (ss * ss)) * 255);
    }
  }
  return encodePNG(size, size, buf);
}

const targets = [
  ['icon-192.png', 192, { glyph: 'validar' }],
  ['icon-512.png', 512, { glyph: 'validar' }],
  ['maskable-192.png', 192, { glyph: 'validar', maskable: true }],
  ['maskable-512.png', 512, { glyph: 'validar', maskable: true }],
  ['apple-touch-icon.png', 180, { glyph: 'validar', maskable: true, scale: 0.86 }],
  ['shortcut-validar.png', 96, { glyph: 'validar' }],
  ['shortcut-simular.png', 96, { glyph: 'simular' }],
  ['shortcut-bitacora.png', 96, { glyph: 'bitacora' }],
];

for (const [name, size, opts] of targets) {
  writeFileSync(join(OUT, name), render(size, opts));
  console.log(`✔ icons/${name} (${size}x${size})`);
}

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16233f"/><stop offset="1" stop-color="#0a1020"/></linearGradient></defs>
  <rect width="100" height="100" rx="20" fill="url(#g)"/>
  <path d="M20 37V20h17M63 20h17v17M20 63v17h17M63 80h17V63" fill="none" stroke="#38bdf8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="50" cy="50" r="19" fill="#22c55e"/>
  <path d="M41.5 50.5l6 6 11.5-12" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
writeFileSync(join(OUT, 'favicon.svg'), favicon);
console.log('✔ icons/favicon.svg');
