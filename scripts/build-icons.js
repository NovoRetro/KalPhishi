// App icons, drawn in code and encoded to PNG with nothing but Node's stdlib.
//
// The app had no logo and no image of any kind — its entire visual identity was emoji, a
// wordmark in system-ui, and the light rig. So the icon IS the light rig: a fan of beams
// off a truss, on the same near-black the hall uses. It is the one mark that already means
// "this app" to anyone who has opened it, it is geometry rather than illustration (which
// is why it can be drawn precisely at any size), and it reads at 48px on a home screen
// where a bathtub or a donut would turn to mush.
//
// Generated rather than committed, for the same reason the script stamps are computed
// rather than typed: a binary in git is a thing that can silently disagree with the source
// it came from. `npm run build:icons` is deterministic — same code, same bytes — so CI
// rebuilds them on every deploy and they cannot drift.
//
// The PNG encoder below is ~40 lines because a PNG is a signature, three chunks, and a
// CRC. zlib does the only hard part and it ships with Node.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'web', 'icons');

// ---- PNG encoding -------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

function encodePng(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type 6 = RGBA
  // Each scanline carries a leading filter byte; 0 means "no filter", which costs a
  // little compression and removes an entire class of bug from a one-off encoder.
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- the mark -----------------------------------------------------------------

// The house rig palette, straight off :root in web/index.html. Weighted violet the way
// the real rig is, with cyan and mint as the counterpoints.
const BEAMS = [
  { deg: -46, c: [109, 79, 214] },   // --beam-3
  { deg: -30, c: [139, 92, 246] },   // --beam-1
  { deg: -15, c: [168, 85, 247] },   // --beam-2
  { deg: 0, c: [221, 208, 255] },    // --beam-6, the bright centre shaft
  { deg: 15, c: [56, 189, 248] },    // --beam-5
  { deg: 30, c: [46, 230, 168] },    // --beam-4
  { deg: 46, c: [139, 92, 246] },    // --beam-1 again, mirrored
];

const clamp = v => (v < 0 ? 0 : v > 255 ? 255 : v);

// `inset` shrinks the beams toward the centre without shrinking the ground, which is what
// a maskable icon needs: the OS may crop to a circle of 80% diameter, so the mark has to
// live inside that while the background still bleeds to every edge.
function render(size, inset = 1) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  // Fixture point: above the top edge, so the beams are already fanning when they enter
  // the frame rather than converging to a visible dot.
  const apexY = -0.06 * size;
  const HALF = (10.5 * Math.PI) / 180; // angular half-width of one beam

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // Ground: the hall's radial, brightest just under the truss.
      const gx = (x - cx) / size;
      const gy = (y - 0) / size;
      const gd = Math.sqrt(gx * gx * 1.6 + gy * gy);
      const g = Math.max(0, 1 - gd * 1.35);
      let r = 12 + 30 * g;
      let gg = 10 + 22 * g;
      let b = 20 + 58 * g;

      // Art-space coordinates: identical to real space at inset 1, pulled toward the
      // centre below it.
      const ax = (x - cx) / inset + cx;
      const ay = (y - cy) / inset + cy;

      const dx = ax - cx;
      const dy = ay - apexY;
      const dist = Math.sqrt(dx * dx + dy * dy) / size;

      // Beams only exist below the truss — a shaft pointing up is a different fixture.
      if (dy > 0) {
        const ang = Math.atan2(dx, dy);           // 0 = straight down
        for (const beam of BEAMS) {
          const d = Math.abs(ang - (beam.deg * Math.PI) / 180);
          if (d >= HALF) continue;
          // Soft edges across the shaft, and a fade along it — a real beam is brightest
          // at the head and dissolves into the haze.
          const across = 1 - d / HALF;
          const along = Math.max(0, 1 - dist * 0.86);
          const v = Math.pow(across, 1.6) * along * 340;
          // Screen-ish accumulation, so crossing beams brighten instead of clipping.
          r = clamp(r + (beam.c[0] / 255) * v);
          gg = clamp(gg + (beam.c[1] / 255) * v);
          b = clamp(b + (beam.c[2] / 255) * v);
        }
      }

      // The bloom is OUTSIDE that gate on purpose. A light source glows in every
      // direction, and gating it with the beams clipped it to a half-disc — which drew a
      // hard horizontal bar straight across the apex. Invisible on the full-bleed icons,
      // where the apex sits above the frame; obvious on the maskable one, where the inset
      // pulls the apex into view.
      const bloom = Math.max(0, 1 - dist * 2.6);
      const bl = bloom * bloom * 190;
      r = clamp(r + bl * 0.72);
      gg = clamp(gg + bl * 0.55);
      b = clamp(b + bl * 0.95);

      buf[i] = r;
      buf[i + 1] = gg;
      buf[i + 2] = b;
      buf[i + 3] = 255;
    }
  }
  return encodePng(size, size, buf);
}

const ICONS = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  // Maskable: mark inside the 80% safe circle, ground full-bleed.
  ['icon-maskable-512.png', 512, 0.62],
  // iOS does not mask, so it gets the full-bleed mark at Apple's preferred size.
  ['apple-touch-icon.png', 180, 1],
];

fs.mkdirSync(OUT, { recursive: true });
let total = 0;
for (const [name, size, inset] of ICONS) {
  const png = render(size, inset);
  fs.writeFileSync(path.join(OUT, name), png);
  total += png.length;
}
console.log(`icons ready — ${ICONS.length} files, ${(total / 1024).toFixed(0)} KB`);
